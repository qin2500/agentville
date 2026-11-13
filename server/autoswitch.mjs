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
 * It switches before agents hit the wall: when the active account's 5-hour window is projected to fill
 * within PROJECT_WITHIN_MS, or either window is at SWITCH_AT % or more, or running jobs' scheduler
 * records say the harness limit ("You've hit your … limit") since the last change. A reading older than
 * STALE_MS is extrapolated at the local pace, not trusted as current. An account picked by hand is left
 * only when it is really out (OUT_AT % or a limit hit). If the 5-hour window alone is the problem and it
 * resets within WAIT_RESET_MS, it stays (agents can wait). The target needs TARGET_MIN_ROOM % room in both
 * windows; among accounts whose week resets within SOON_WEEK_MS the soonest reset wins, otherwise the one
 * with the most weekly room. If none is available, the pool. It uses the normal switch (backups, canary,
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

export const OUT_AT = 99 // % used: the account is really out (the only thing that moves us off a manual pick)
export const SWITCH_AT = 95 // % used, either window: switch before the wall
export const PROJECT_WITHIN_MS = 5 * 60e3 // the 5-hour window is projected to fill within this: switch
export const STALE_MS = 2 * 60e3 // a reading older than this is extrapolated, not trusted
export const WAIT_RESET_MS = 15 * 60e3 // only the 5-hour window is the problem and it resets this soon: stay
export const TARGET_MIN_ROOM = 20 // % room needed in both windows on a target
export const SOON_WEEK_MS = 36 * 3600e3 // "soonest weekly reset first" only within this
export const BACKOFF_MS = [2, 4, 8, 15].map((m) => m * 60e3) // after the 1st, 2nd, 3rd, 4th+ failed attempt
export const COOLDOWN_MS = 15 * 60e3
export const KEEP_SAMPLES_MS = 6 * 3600e3
// Rebalance: move to an account whose weekly allowance expires sooner, before the active one runs out.
export const REBALANCE_LEAD_MS = 6 * 3600e3 // its week must reset at least this much sooner
export const REBALANCE_MIN_ROOM = TARGET_MIN_ROOM // weekly % it must have left (same as any target)
export const REBALANCE_MAX_FIVE = 80 // 5-hour % it may have used (no 5-hour limit always passes)
export const REBALANCE_CHECK_MS = 15 * 60e3 // how often the sampler re-reads the other accounts for it
export const STALE_LOGIN_MS = 10 * 60e3 // a limit stop this soon after a switch, with room left, means the job is still on the old login
export const MODEL_HOP_MS = 3600e3 // a model-specific limit ("hit your Opus limit") moves accounts at most once per hour
export const HEADROOM_WARN = 300 // chars of Keychain room left below which the account menu shows it

const PLAIN_LIMIT_WORDS = new Set(['weekly', 'session', 'daily', 'hourly', 'monthly', '5-hour', 'five-hour', 'usage', 'rate', 'message'])
/** The model a harness limit string names ("You've hit your Opus weekly limit" -> 'opus'), or '' for a plain limit. */
export function limitModel(text) {
  const m = /^You['\u2019]ve hit your ((?:[\w-]+ ){0,4})limit\b/.exec(typeof text === 'string' ? text.trim() : '')
  if (!m) return ''
  return m[1].trim().split(/\s+/).filter((w) => w && !PLAIN_LIMIT_WORDS.has(w.toLowerCase()))[0]?.toLowerCase() || ''
}

/** A reading with every window whose reset has passed counted as unused (the cache can be older than a reset). */
export function fresh(u, now) {
  if (!u || u.error) return u
  const win = (x) => (x && !x.none && x.resetsAt != null && x.resetsAt <= now ? { ...x, used: 0, resetsAt: null } : x)
  return { ...u, fiveHour: win(u.fiveHour), weekly: win(u.weekly) }
}

/**
 * A reading older than STALE_MS moved on to now at the local pace: `perHour` is the 5-hour pace (% of the
 * 5-hour window per hour), `ratio` the weekly % one 5-hour % costs. Never lowers a reading; caps at 100.
 */
export function extrapolate(u, { ageMs = 0, perHour = 0, ratio = 0 } = {}) {
  if (!u || u.error || !(ageMs > STALE_MS) || !(perHour > 0)) return u
  const h = ageMs / 3600e3
  const up = (x, by) => (x && !x.none ? { ...x, used: Math.min(100, x.used + by) } : x)
  return { ...u, fiveHour: up(u.fiveHour, perHour * h), weekly: up(u.weekly, perHour * ratio * h) }
}

/**
 * The decision, pure. `usage`: Map id -> { fiveHour, weekly, error? } (other saved accounts' latest).
 * `onWork`: on the work Wi-Fi; `quarantine`: Set of quarantine account ids; `prefer`: switch off a
 * regular account to a quarantine one with room (enforce, off the work Wi-Fi). Returns
 * `{ action: 'none', why }` or `{ action: 'switch', to, why }`, `why` in 'five_hour' | 'weekly' | 'projected' |
 * 'limit' | 'quarantine' | 'prefer' | 'rebalance' for a switch. `projectedMs`: time until the active 5-hour window is
 * projected to fill (null/absent: not projected); `manual`: the last change was a manual pick; `retryAt`: no
 * attempt before this time (backoff after a failed switch).
 */
export function decide({ enabled, active, saved, activeUsage, usage, limitHit, busy, lastAutoAt, poolAvailable, now, onWork = false, quarantine = new Set(), prefer = false, rebalance = false, projectedMs = null, manual = false, retryAt = 0 }) {
  if (active === 'pool') return { action: 'none', why: 'on the pool' }
  if (!saved.includes(active)) return { action: 'none', why: 'not a saved account' }
  const banned = onWork && quarantine.has(active)
  if (!enabled && !banned) return { action: 'none', why: 'off' }
  if (busy) return { action: 'none', why: 'a switch is running' }
  if (retryAt && now < retryAt) return { action: 'none', why: 'backoff' } // after a failed attempt, on every path
  if (!banned && lastAutoAt && now - lastAutoAt < COOLDOWN_MS) return { action: 'none', why: 'cooldown' }
  const five = activeUsage?.fiveHour?.used, week = activeUsage?.weekly?.used
  // Really out: the only thing that moves us off an account picked by hand.
  const hard = five >= OUT_AT ? 'five_hour' : week >= OUT_AT ? 'weekly' : limitHit ? 'limit' : ''
  const soft = manual ? '' : five >= SWITCH_AT ? 'five_hour' : week >= SWITCH_AT ? 'weekly' : projectedMs != null && projectedMs <= PROJECT_WITHIN_MS ? 'projected' : ''
  const out = hard || soft
  const why = banned ? 'quarantine' : out || (prefer && !onWork && !quarantine.has(active) ? 'prefer' : '') || (rebalance && !manual ? 'rebalance' : '')
  if (!why) return { action: 'none', why: 'not out' }
  // Only the 5-hour window is the problem and it resets very soon: agents can wait, so stay.
  if (out && !banned && !(week >= SWITCH_AT)) {
    const resets = activeUsage?.fiveHour?.resetsAt
    if (resets != null && resets - now <= WAIT_RESET_MS) return { action: 'none', why: 'waiting for the 5-hour reset', waitUntil: resets }
  }
  const ok = (u) => u && !u.error && u.fiveHour && u.weekly && (u.fiveHour.none || 100 - u.fiveHour.used >= TARGET_MIN_ROOM) && 100 - u.weekly.used >= TARGET_MIN_ROOM
  // Off the work Wi-Fi quarantine accounts rank first; on it they aren't candidates at all.
  // Then, among accounts whose week resets within SOON_WEEK_MS, the soonest weekly reset (use it before it
  // expires), then the 5-hour reset; any other account ranks after those, by most weekly room.
  const rank = (id) => (onWork ? 0 : quarantine.has(id) ? 0 : 1)
  const at = (id, k) => usage.get(id)[k].resetsAt ?? Infinity
  const soon = (id) => at(id, 'weekly') - now <= SOON_WEEK_MS
  const week_ = (a, b) => { const d = at(a, 'weekly') - at(b, 'weekly'); return Math.abs(d) < 3600e3 ? 0 : d } // within the hour: a tie
  const order = (a, b) => rank(a) - rank(b) || (soon(a) ? 0 : 1) - (soon(b) ? 0 : 1)
    || (soon(a) ? week_(a, b) : usage.get(a).weekly.used - usage.get(b).weekly.used) || at(a, 'fiveHour') - at(b, 'fiveHour')
  const best = saved.filter((id) => id !== active && ok(usage.get(id)) && !(onWork && quarantine.has(id)) && (why !== 'prefer' || quarantine.has(id)))
    .sort(order)[0]
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
    const frees = (id) => usage.get(id)?.fiveHour?.resetsAt ?? Infinity
    const any = saved.filter((id) => id !== active && !quarantine.has(id)).sort((a, b) => frees(a) - frees(b))[0]
    if (any) return { action: 'switch', to: any, why }
  }
  if (poolAvailable) return { action: 'switch', to: 'pool', why }
  return { action: 'none', why: 'nowhere to go' }
}

/** `account`: createAccount(); `agents()`: the current scan's agents; `nudge(ids)`: send "continue" to those jobs (serve.mjs). */
export function createSampler({ dataDir, account, agents, network, nudge = null, now = Date.now }) {
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

  /** The latest real change of Claude's account from the audit log: `{ at, auto }`, or null (none, or unreadable). */
  async function lastChange() {
    const log = await fsp.readFile(path.join(dataDir, 'account-log.jsonl'), 'utf8').catch(() => '')
    for (const line of log.trim().split('\n').reverse()) {
      try { const e = JSON.parse(line); if (e.action === 'undo' || (e.action === 'switch' && !e.restored)) return { at: e.at, auto: e.action === 'switch' && e.auto === true, viaPool: e.from === 'pool' || e.to === 'pool' } } catch { /* skip */ }
    }
    return null
  }

  /** The active account's pace from the samples: { fiveEtaMs (to a full 5-hour window, or null), perHour, ratio }. */
  function paceOf(key, u, at) {
    const list = samples.get(key) || []
    const series = list.filter((x) => x.five).map((x) => ({ at: x.at, used: x.five.used, resetsAt: x.five.resetsAt }))
    if (!u.fiveHour || u.fiveHour.none) return { fiveEtaMs: null, perHour: 0, ratio: 0 }
    // Project from the reading itself when it is the newest thing we know (series ends at or before it).
    const p = project(series, at)
    return { fiveEtaMs: p.state === 'runsOut' ? Math.max(0, p.at - at) : p.state === 'out' ? 0 : null, perHour: p.perHour ?? p.perHourAvg ?? 0, ratio: weeklyPerFive(list).ratio }
  }

  /** Keychain room left (chars) from accounts.headroom(), cached by the sampler; null when unknown or unsupported. */
  let headroom = null
  async function refreshHeadroom(at) {
    if (typeof account.accounts.headroom !== 'function') return
    try { const h = await account.accounts.headroom(); headroom = { size: h.size, max: h.max, left: h.left, at } } catch { /* keep the old one */ }
  }
  const headroomLeft = async () => { await refreshHeadroom(now()); return headroom ? headroom.left : 0 }

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
    const since = await account.lastChangeAt()
    const change = await lastChange()
    const manual = !change?.auto // an account picked by hand (or never switched here) stays until it is really out
    if (state.tooBig && (since > (state.tooBig.at || 0) || (await headroomLeft()) > 0)) { delete state.tooBig; await save() } // a manual switch or room again: try again
    if (state.waitUntil && since >= (state.waitSetAt || 0)) { delete state.waitUntil; delete state.waitSetAt } // the account changed: the wait is moot
    // Jobs whose scheduler record said the harness limit after the account last changed (older ones are stale),
    // and after a wait for the 5-hour reset (those only get a nudge once it passes, never a switch).
    const stops = (await agents()).filter((a) => a.live && a.bucket !== 'resting' && (a.limitStopAt || 0) > since)
    const floor = Math.max(since, state.waitUntil || 0)
    let limitAgents = stops.filter((a) => a.limitStopAt > floor)
    if (state.waitUntil && at >= state.waitUntil) {
      const older = stops.filter((a) => a.limitStopAt <= state.waitUntil).map((a) => a.id)
      delete state.waitUntil; delete state.waitSetAt
      if (older.length && nudge) { try { state.waitNudged = (await nudge(older)).length } catch { state.waitNudged = 0 } }
      await save()
    }
    const list = await account.accounts.load(), saved = list.map((a) => a.id)
    await refreshHeadroom(at)
    if (state.tooBig) return { action: 'none', why: 'login entry too big' }
    const net = network ? (await network.status()).current : { id: null, work: false }
    // A reading older than STALE_MS (a held-over one while rate-limited) is moved on to now at the local pace.
    const ageMs = u.stale && u.asOf ? Math.max(0, at - u.asOf) : 0
    const pace = paceOf(key, u, at)
    const eff = extrapolate(u, { ageMs, perHour: pace.perHour, ratio: pace.ratio })
    const projectedMs = pace.fiveEtaMs
    // A limit stop soon after an account-to-account switch, with room on the active account: the job is still on the old login.
    if (limitAgents.length && change && !change.viaPool && at - since <= STALE_LOGIN_MS && state.staleFor !== since
      && !(eff.fiveHour?.used >= SWITCH_AT) && !(eff.weekly?.used >= SWITCH_AT) && typeof account.respawnStale === 'function') {
      state.staleFor = since
      const ids = limitAgents.map((a) => a.id)
      try { await account.respawnStale(ids); state.last = { at, from: u.id, to: u.id, why: 'stale_login', respawned: ids.length, fromLabel: '', toLabel: '' } } catch { /* the next limit stop falls through to a switch */ }
      await save()
      limitAgents = []
    }
    // A model-specific limit ("hit your Opus limit") is not the account running out: hop at most once an hour for it.
    const models = limitAgents.map((a) => limitModel(a.limitText))
    const model = limitAgents.length && models.every(Boolean) ? models[0] : ''
    if (model && state.lastModelHopAt && at - state.lastModelHopAt < MODEL_HOP_MS) limitAgents = []
    const limitIds = limitAgents.map((a) => a.id)
    const base = { enabled: state.enabled, active: u.id, saved, activeUsage: eff, limitHit: limitIds.length > 0, busy: account.isBusy(), lastAutoAt: state.lastAutoAt, poolAvailable: account.poolAvailable(), now: at,
      onWork: net.work, quarantine: new Set(list.filter((a) => a.quarantine).map((a) => a.id)), projectedMs, manual, retryAt: state.retryAt || 0 }
    const info = { active: { id: u.id, fiveHour: eff.fiveHour?.used ?? null, weekly: eff.weekly?.used ?? null, ageMs }, limitHit: limitIds, model }
    // Not out, or a guard says no: nothing else to check.
    const pre = decide({ ...base, usage: new Map(), poolAvailable: true })
    if (pre.waitUntil && state.waitUntil !== pre.waitUntil) { state.waitUntil = pre.waitUntil; state.waitSetAt = at; await save() }
    if (pre.action === 'none') {
      if (pre.why !== 'not out' || list.length < 2 || at - (state.lastRebalanceCheck || 0) < REBALANCE_CHECK_MS) return pre
      // An account picked by hand stays until it runs out: only rebalance away from one auto-switch chose.
      if (manual) return pre
      state.lastRebalanceCheck = at // a fresh read of the others, at most every 15 min
      const all = await account.accounts.usage({ fresh: true })
      const d = decide({ ...base, usage: new Map(all.accounts.map((x) => [x.id, fresh(x, at)])), busy: account.isBusy(), rebalance: true })
      return d.action === 'switch' ? autoSwitch(d, u.id, at, info, all) : d
    }
    // Out: check every saved account now (this may refresh inactive ones; never the active one).
    const all = await account.accounts.usage({ fresh: true })
    const d = decide({ ...base, usage: new Map(all.accounts.map((x) => [x.id, fresh(x, at)])), busy: account.isBusy() })
    if (d.waitUntil && state.waitUntil !== d.waitUntil) { state.waitUntil = d.waitUntil; state.waitSetAt = at; await save() }
    return d.action === 'switch' ? autoSwitch(d, u.id, at, info, all) : d
  }

  /** Audit reason for the switch: 'projected' | 'out' | 'limit' | 'rebalance' (the 10 s network rule: 'quarantine' | 'prefer'). */
  const reasonOf = (why) => (why === 'five_hour' || why === 'weekly' ? 'out' : why)

  /**
   * Carry out an automatic switch and record it (the banner and the menu show `state.last`).
   * `info`: { active: { id, fiveHour, weekly, ageMs }, limitHit: [agent ids] } for the audit entry;
   * `all`: the usage list the decision was made on (for the target's numbers).
   */
  async function autoSwitch(d, from, at, info = { active: { id: from }, limitHit: [] }, all = null) {
    const labels = new Map((await account.accounts.load()).map((a) => [a.id, a.label]))
    const names = { fromLabel: labels.get(from) || '', toLabel: d.to === 'pool' ? 'Pool' : labels.get(d.to) || '' }
    const t = all?.accounts?.find((x) => x.id === d.to)
    const why = { reason: reasonOf(d.why), ...(info.model && d.why === 'limit' && { model: info.model }), active: info.active, limitHit: info.limitHit, target: { id: d.to, fiveHour: t?.fiveHour?.used ?? null, weekly: t?.weekly?.used ?? null } }
    let failed = false
    try {
      const out = await account.switchTo({ to: d.to }, await agents(), { auto: true, why })
      failed = Boolean(out.restored) // rolled back: the account did not change
      if (!failed) { state.lastAutoAt = at; if (info.model && d.why === 'limit') state.lastModelHopAt = at } // the cooldown starts with a switch that worked; retryAt governs failures
      state.last = { at, from, to: d.to, ...names, why: d.why, restored: out.restored, respawned: out.results.filter((r) => r.status === 'respawned').length }
      if (!failed && info.limitHit.length && nudge) { // jobs stopped on the limit: tell each to go on, once
        try { state.last.nudged = (await nudge([...new Set(info.limitHit)])).length } catch { state.last.nudged = 0 }
      }
    } catch (e) {
      failed = true
      state.last = { at, from, to: d.to, ...names, why: d.why, error: e.status ? e.message : 'Switch failed' }
      if (e.code === 'too_big') { // the Keychain item can't hold another login: stop retrying until there is room or the user switches
        state.tooBig = { at, size: e.size ?? null, max: e.max ?? null }
        state.last.error = e.message
      }
    }
    // A failed attempt on any path backs off: 2, 4, 8, then 15 min between tries.
    state.failures = failed ? (state.failures || 0) + 1 : 0
    state.retryAt = failed && !state.tooBig ? at + BACKOFF_MS[Math.min(state.failures, BACKOFF_MS.length) - 1] : 0
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
    if (state.tooBig) return { action: 'none', why: 'login entry too big' }
    const all = await account.accounts.usage()
    const at = now()
    const d = decide({ enabled: state.enabled, active, saved: list.map((a) => a.id), activeUsage: null, usage: new Map(all.accounts.map((x) => [x.id, x])), limitHit: false,
      busy: account.isBusy(), lastAutoAt: state.lastAutoAt, retryAt: state.retryAt || 0, poolAvailable: false, now: at, onWork: st.current.work, quarantine, prefer: true })
    const mine = all.accounts.find((x) => x.id === active)
    return d.action === 'switch' ? autoSwitch(d, active, at, { active: { id: active, fiveHour: mine?.fiveHour?.used ?? null, weekly: mine?.weekly?.used ?? null, ageMs: null }, limitHit: [] }, all) : d
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
    const d = decide({ enabled: true, active: latest.id, saved: list.map((a) => a.id), activeUsage: { fiveHour: { used: 100 } }, manual: false, usage: new Map([...account.accounts.cachedUsage()].map(([id, x]) => [id, fresh(x, now())])),
      limitHit: false, busy: false, lastAutoAt: null, poolAvailable: account.poolAvailable(), now: now(), onWork: net.work, quarantine: new Set(list.filter((a) => a.quarantine).map((a) => a.id)) })
    if (d.action !== 'switch') return null
    return { to: d.to, label: d.to === 'pool' ? 'the pool' : list.find((a) => a.id === d.to)?.label || 'another saved account' }
  }
  async function info() {
    await load()
    const tb = state.tooBig
    return { enabled: state.enabled, last: state.last || null, cooldownUntil: state.lastAutoAt ? state.lastAutoAt + COOLDOWN_MS : null,
      blocked: tb ? { reason: 'too_big', size: tb.size ?? headroom?.size ?? null, max: tb.max ?? headroom?.max ?? null } : null,
      headroom: headroom ? { size: headroom.size, max: headroom.max, left: headroom.left } : null }
  }

  return { sample, tick, enforce, projection, info, setEnabled, samples }
}
