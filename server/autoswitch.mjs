/**
 * The usage sampler and automatic account switching.
 *
 * Once a minute (AGENTVILLE_SAMPLE_MS), while the active profile is an account (never on the pool),
 * the sampler asks Anthropic for the usage of the login in Claude's store only (never refreshing
 * it) and records 5-hour and weekly samples for the projection (projection.mjs).
 *
 * Goal: use as much of every account as possible before it resets. Each account's weekly allowance
 * expires at its weekly reset; the 5-hour window only caps how fast it can be spent. So spend from
 * the one that expires soonest: when it runs out, go to the next-soonest; when its 5-hour window
 * resets, go back (rebalance: from cached readings, confirmed by a fresh read at most every 15 min,
 * only when its week resets REBALANCE_LEAD_MS sooner and it has room, so it doesn't flip back and forth).
 *
 * When the active saved account is out (a window at OUT_AT %, or running agents report a usage
 * limit since the last switch), it switches to the available saved account whose weekly window
 * resets soonest (then the 5-hour one); if none is available, to the pool. It uses the normal switch (backups, canary,
 * rollback, audit log, running jobs only). Guards: a persisted toggle (default on), one automatic
 * switch per COOLDOWN_MS, never during another switch, never from the pool back to an account.
 *
 * Quarantine accounts (network.mjs) can't be used on the work Wi-Fi; anywhere else they come
 * first. While a work network is marked, `enforce` checks every 10 s (cached usage only, so it
 * never adds usage calls):
 *   - on the work Wi-Fi on a quarantine account: switch to a regular one at once, even one with
 *     no usage left (toggle and cooldown notwithstanding: it's a rule, not a preference);
 *   - anywhere else on a regular account: switch to a quarantine account with usage left, if there
 *     is one (respecting the toggle and the cooldown, so jobs aren't restarted back and forth).
 * When an account runs out, quarantine accounts rank first off the work Wi-Fi and aren't
 * candidates on it.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeAtomic } from './accounts.mjs'
import { project, projectWeekly, weeklyPerFive, binding } from './projection.mjs'

export const OUT_AT = 99 // % used: the account is out
export const AVAILABLE_BELOW = 95 // % used, both windows: an account is worth switching to
export const COOLDOWN_MS = 15 * 60e3
export const KEEP_SAMPLES_MS = 6 * 3600e3
const LIMIT_REASON = /^Usage limit\b/
// Rebalance: move to an account whose weekly allowance expires sooner, before the active one runs out.
export const REBALANCE_LEAD_MS = 6 * 3600e3 // its week must reset at least this much sooner
export const REBALANCE_MIN_ROOM = 10 // weekly % it must have left
export const REBALANCE_MAX_FIVE = 80 // 5-hour % it may have used (no 5-hour limit always passes)
export const REBALANCE_CHECK_MS = 15 * 60e3 // how often the sampler re-reads the other accounts for it

/** A reading with every window whose reset has passed counted as unused (the cache can be older than a reset). */
export function fresh(u, now) {
  if (!u || u.error) return u
  const win = (x) => (x && !x.none && x.resetsAt != null && x.resetsAt <= now ? { ...x, used: 0, resetsAt: null } : x)
  return { ...u, fiveHour: win(u.fiveHour), weekly: win(u.weekly) }
}

/**
 * The decision, pure. `usage`: Map id -> { fiveHour, weekly, error? } (other saved accounts' latest).
 * `onWork`: on the work Wi-Fi; `quarantine`: Set of quarantine account ids; `prefer`: switch off a
 * regular account to a quarantine one with room (enforce, off the work Wi-Fi). Returns
 * `{ action: 'none', why }` or `{ action: 'switch', to, why }`, `why` in 'five_hour' | 'weekly' |
 * 'limit' | 'quarantine' | 'prefer' for a switch.
 */
export function decide({ enabled, active, saved, activeUsage, usage, limitHit, busy, lastAutoAt, poolAvailable, now, onWork = false, quarantine = new Set(), prefer = false, rebalance = false }) {
  if (active === 'pool') return { action: 'none', why: 'on the pool' }
  if (!saved.includes(active)) return { action: 'none', why: 'not a saved account' }
  const banned = onWork && quarantine.has(active)
  if (!enabled && !banned) return { action: 'none', why: 'off' }
  if (busy) return { action: 'none', why: 'a switch is running' }
  if (!banned && lastAutoAt && now - lastAutoAt < COOLDOWN_MS) return { action: 'none', why: 'cooldown' }
  const out = activeUsage?.fiveHour?.used >= OUT_AT ? 'five_hour' : activeUsage?.weekly?.used >= OUT_AT ? 'weekly' : limitHit ? 'limit' : ''
  const why = banned ? 'quarantine' : out || (prefer && !onWork && !quarantine.has(active) ? 'prefer' : '') || (rebalance ? 'rebalance' : '')
  if (!why) return { action: 'none', why: 'not out' }
  const ok = (u) => u && !u.error && u.fiveHour && u.weekly && u.fiveHour.used < AVAILABLE_BELOW && u.weekly.used < AVAILABLE_BELOW
  // Off the work Wi-Fi quarantine accounts rank first; on it they aren't candidates at all.
  // Then the account whose weekly allowance resets soonest (use it before it expires), then the 5-hour reset.
  const rank = (id) => (onWork ? 0 : quarantine.has(id) ? 0 : 1)
  const at = (id, k) => usage.get(id)[k].resetsAt ?? Infinity
  const week = (a, b) => { const d = at(a, 'weekly') - at(b, 'weekly'); return Math.abs(d) < 3600e3 ? 0 : d } // within the hour: a tie
  const best = saved.filter((id) => id !== active && ok(usage.get(id)) && !(onWork && quarantine.has(id)) && (why !== 'prefer' || quarantine.has(id)))
    .sort((a, b) => rank(a) - rank(b) || week(a, b) || at(a, 'fiveHour') - at(b, 'fiveHour'))[0]
  if (why === 'rebalance') { // only for an account whose allowance expires well before the active one's, with real room
    // The active account's week must be known: an unreadable one (rate-limited, expired) is not "never expires".
    const w = !activeUsage?.error && activeUsage?.weekly
    if (!w || (w.resetsAt == null && w.used > 0)) return { action: 'none', why: 'not out' }
    const b = best && usage.get(best), mine = w.resetsAt ?? Infinity
    const worth = b && rank(best) <= rank(active) && at(best, 'weekly') + REBALANCE_LEAD_MS <= mine && 100 - b.weekly.used >= REBALANCE_MIN_ROOM && (b.fiveHour.none || b.fiveHour.used < REBALANCE_MAX_FIVE)
    return worth ? { action: 'switch', to: best, why } : { action: 'none', why: 'not out' }
  }
  if (best) return { action: 'switch', to: best, why }
  if (why === 'prefer') return { action: 'none', why: 'no quarantine account available' }
  if (why === 'quarantine') { // off a quarantine account no matter what: the regular one that frees up soonest, used up or not
    const soon = (id) => usage.get(id)?.fiveHour?.resetsAt ?? Infinity
    const any = saved.filter((id) => id !== active && !quarantine.has(id)).sort((a, b) => soon(a) - soon(b))[0]
    if (any) return { action: 'switch', to: any, why }
  }
  if (poolAvailable) return { action: 'switch', to: 'pool', why }
  return { action: 'none', why: 'nowhere to go' }
}

/** `account`: createAccount(); `agents()`: the current scan's agents. */
export function createSampler({ dataDir, account, agents, network, now = Date.now }) {
  const file = path.join(dataDir, 'autoswitch.json')
  const samples = new Map() // account id ('personal' when unknown) -> [{ at, five, week }]
  let state = null // { enabled, lastAutoAt, last }
  let latest = null // the latest reading { id, saved, at, fiveHour, weekly, error? }
  let running = null

  async function load() {
    if (state) return state
    try { state = JSON.parse(await fsp.readFile(file, 'utf8')) } catch { state = {} }
    state.enabled ??= true
    return state
  }
  async function save() {
    await fsp.mkdir(dataDir, { recursive: true })
    await writeAtomic(file, JSON.stringify(state) + '\n', 0o600)
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false'), { status: 400 })
    await load()
    state.enabled = enabled
    await save()
    return { enabled }
  }

  async function tick() {
    await load()
    if ((await account.profile()) === 'pool') { latest = null; return { action: 'none', why: 'on the pool' } }
    const u = await account.accounts.activeUsage()
    if (!u) { latest = null; return { action: 'none', why: 'no login' } }
    const key = u.id || 'personal'
    const at = now()
    latest = { ...u, at }
    if (!u.error && !u.stale) { // a held-over reading (while rate-limited) is not a new sample
      const list = samples.get(key) || []
      list.push({ at, five: u.fiveHour, week: u.weekly })
      while (list.length && at - list[0].at > KEEP_SAMPLES_MS) list.shift()
      samples.set(key, list)
    }
    if (!u.saved) return { action: 'none', why: 'not a saved account' }
    // Agents that report a usage limit written after the account last changed (older ones are stale).
    const since = await account.lastChangeAt()
    const limitHit = (await agents()).some((a) => a.live && a.bucket !== 'resting' && LIMIT_REASON.test(a.reason || '') && (a.lastActivityAt || 0) > since)
    const list = await account.accounts.load(), saved = list.map((a) => a.id)
    const net = network ? (await network.status()).current : { id: null, work: false }
    const base = { enabled: state.enabled, active: u.id, saved, activeUsage: u, limitHit, busy: account.isBusy(), lastAutoAt: state.lastAutoAt, poolAvailable: account.poolAvailable(), now: at,
      onWork: net.work, quarantine: new Set(list.filter((a) => a.quarantine).map((a) => a.id)) }
    // Not out, or a guard says no: nothing else to check.
    const pre = decide({ ...base, usage: new Map(), poolAvailable: true })
    if (pre.action === 'none') {
      if (pre.why !== 'not out' || list.length < 2 || at - (state.lastRebalanceCheck || 0) < REBALANCE_CHECK_MS) return pre
      // An account picked by hand stays until it runs out: only rebalance away from one auto-switch chose.
      if (since > (state.lastAutoAt || 0) + 5 * 60e3) return pre
      state.lastRebalanceCheck = at // a fresh read of the others, at most every 15 min
      const all = await account.accounts.usage({ fresh: true })
      const d = decide({ ...base, usage: new Map(all.accounts.map((x) => [x.id, fresh(x, at)])), busy: account.isBusy(), rebalance: true })
      return d.action === 'switch' ? autoSwitch(d, u.id, at) : d
    }
    // Out: check every saved account now (this may refresh inactive ones; never the active one).
    const all = await account.accounts.usage({ fresh: true })
    const d = decide({ ...base, usage: new Map(all.accounts.map((x) => [x.id, fresh(x, at)])), busy: account.isBusy() })
    return d.action === 'switch' ? autoSwitch(d, u.id, at) : d
  }

  /** Carry out an automatic switch and record it (the banner and the menu show `state.last`). */
  async function autoSwitch(d, from, at) {
    state.lastAutoAt = at // the cooldown starts with the attempt, whatever its outcome
    const labels = new Map((await account.accounts.load()).map((a) => [a.id, a.label]))
    const names = { fromLabel: labels.get(from) || '', toLabel: d.to === 'pool' ? 'Pool' : labels.get(d.to) || '' }
    try {
      const out = await account.switchTo({ to: d.to }, await agents(), { auto: true })
      state.last = { at, from, to: d.to, ...names, why: d.why, restored: out.restored, respawned: out.results.filter((r) => r.status === 'respawned').length }
    } catch (e) {
      state.last = { at, from, to: d.to, ...names, why: d.why, error: e.status ? e.message : 'Switch failed' }
    }
    await save()
    return { ...d, result: state.last }
  }

  /**
   * The 10 s network rule (see the top of this file). Only while a work network is marked and the
   * network is known; usage comes from the 60 s cache, so this adds no usage checks of its own.
   */
  async function enforceTick() {
    await load()
    if (!network || (await account.profile()) === 'pool') return { action: 'none', why: 'no network rule here' }
    const st = await network.status({ fresh: true })
    if (!st.work.length) return { action: 'none', why: 'no work network marked' }
    if (!st.current.id) return { action: 'none', why: 'offline' }
    const list = await account.accounts.load(), quarantine = new Set(list.filter((a) => a.quarantine).map((a) => a.id))
    const active = (await account.accounts.list()).active
    if (!list.some((a) => a.id === active)) return { action: 'none', why: 'not a saved account' }
    if (st.current.work !== quarantine.has(active)) return { action: 'none', why: 'right kind of account' }
    if (!st.current.work && !list.some((a) => a.quarantine && a.id !== active)) return { action: 'none', why: 'no quarantine account' }
    const all = await account.accounts.usage()
    const at = now()
    const d = decide({ enabled: state.enabled, active, saved: list.map((a) => a.id), activeUsage: null, usage: new Map(all.accounts.map((x) => [x.id, x])), limitHit: false,
      busy: account.isBusy(), lastAutoAt: state.lastAutoAt, poolAvailable: false, now: at, onWork: st.current.work, quarantine, prefer: true })
    return d.action === 'switch' ? autoSwitch(d, active, at) : d
  }

  /** One tick (or network check) at a time. Errors are swallowed (logged without detail): the next one tries again. */
  const once = (fn, what) => (running ??= fn().catch((e) => { console.error(`${what}: ${e.status ? e.message : e.code || 'failed'}`); return { action: 'none', why: 'error' } }).finally(() => { running = null }))
  const sample = () => once(tick, 'usage sampler')
  const enforce = () => (running ? Promise.resolve({ action: 'none', why: 'busy' }) : once(enforceTick, 'network check'))

  /**
   * The projection for the active account: null on the pool or before any reading; `{ pending: true }`
   * right after the account changed (a fresh reading is started at once). `binding` is the window that
   * runs out first (projection.mjs); `next` is where auto-switch would move the agents, from cached
   * readings only (no usage calls), or null.
   */
  async function projection() {
    if ((await account.profile()) === 'pool') return null
    if (latest && (await account.lastChangeAt()) > latest.at) { sample(); return { pending: true } }
    if (!latest) return null
    const t = now(), list = samples.get(latest.id || 'personal') || []
    const series = (k) => list.filter((s) => s[k]).map((s) => ({ at: s.at, used: s[k].used, resetsAt: s[k].resetsAt }))
    const fiveHour = latest.fiveHour?.none ? { used: 0, resetsAt: null, none: true, state: 'none' } : latest.fiveHour && { used: latest.fiveHour.used, resetsAt: latest.fiveHour.resetsAt, ...project(series('five'), t) }
    const weekly = latest.weekly && { used: latest.weekly.used, ...projectWeekly({ week: latest.weekly, five: fiveHour, ratio: weeklyPerFive(list), samples: series('week'), now: t }) }
    const bind = binding(fiveHour, weekly)
    return { account: latest.id, saved: latest.saved, at: latest.at, error: latest.error, fiveHour, weekly, binding: bind, next: bind ? await nextAccount() : null }
  }
  /** `{ to, label }`: where an automatic switch would go if the active account ran out now. */
  async function nextAccount() {
    await load()
    if (!state.enabled || !latest?.saved || !account.accounts.cachedUsage) return null
    const list = await account.accounts.load()
    const net = network ? (await network.status()).current : { work: false }
    const d = decide({ enabled: true, active: latest.id, saved: list.map((a) => a.id), activeUsage: { fiveHour: { used: 100 } }, usage: new Map([...account.accounts.cachedUsage()].map(([id, x]) => [id, fresh(x, now())])),
      limitHit: false, busy: false, lastAutoAt: null, poolAvailable: account.poolAvailable(), now: now(), onWork: net.work, quarantine: new Set(list.filter((a) => a.quarantine).map((a) => a.id)) })
    if (d.action !== 'switch') return null
    return { to: d.to, label: d.to === 'pool' ? 'the pool' : list.find((a) => a.id === d.to)?.label || 'another saved account' }
  }
  async function info() {
    await load()
    return { enabled: state.enabled, last: state.last || null, cooldownUntil: state.lastAutoAt ? state.lastAutoAt + COOLDOWN_MS : null }
  }

  return { sample, tick, enforce, projection, info, setEnabled, samples }
}
