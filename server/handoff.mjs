/**
 * Handoff engine (docs/providers-design.md §3.4–3.6): when a provider is out on every account, its top-level
 * agents are continued on another provider. One record per (agent, episode), persisted in
 * `<data>/handoffs.json` before every side effect, plus the full note in `<data>/handoffs/<hid>.md`.
 *
 *   planned -> waiting_idle -> noted -> starting -> started -> stopping -> done
 *   any pre-start state -> cancelled   (source recovered, no target has room, handoff turned off, dismissed)
 *   starting|started    -> failed      (start failed / the new agent never appeared; one auto retry after 2 min)
 *   started|done        -> undone      (Undo: stop the new agent, resume the old one; files are never reverted)
 *
 * Rules:
 * - `hid = sha256(agentId + episodeId).slice(0, 16)`: the same agent in the same episode is always one record,
 *   so a second create (a parent's flow, a manual handoff during an auto one) joins the existing record.
 * - The old agent is only stopped after the new one shows up in the scan and isn't `neverStarted`.
 * - On a restart, every non-terminal record resumes from its state. `starting` without a ref first looks for an
 *   agent carrying the hid before starting again, so there is never a double start.
 * - Children before parents; at most `concurrency` (2) records run at once, `staggerMs` (2 s) apart.
 * - Hops: at most `maxHops` handoffs per lineage per 6 h (automatic handoffs only; a manual one is the user's call).
 * - Logs carry ids, providers and states only, never prompt or note text.
 *
 * Dependencies are injected (adapters, note builder, launch ledger, provider state) so tests use fakes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeAtomic } from './accounts.mjs'

export const STATES = ['planned', 'waiting_idle', 'noted', 'starting', 'started', 'stopping', 'done', 'failed', 'undone', 'cancelled']
export const TERMINAL = new Set(['done', 'failed', 'undone', 'cancelled'])
const PRE_START = new Set(['planned', 'waiting_idle', 'noted'])
const SUB_KINDS = new Set(['subagent', 'teammate', 'thread'])
const HARNESS_PROVIDER = { 'claude-code': 'claude', 'gemini-cli': 'gemini', codex: 'codex' }

export const POLL_MS = 3000
export const IDLE_MAX_MS = Number(process.env.AGENTVILLE_HANDOFF_IDLE_MAX_MS) || 10 * 60 * 1000
export const APPEAR_MAX_MS = 2 * 60 * 1000
export const RETRY_MS = 2 * 60 * 1000
export const STAGGER_MS = 2000
export const CONCURRENCY = 2
export const HOP_WINDOW_MS = 6 * 3600 * 1000
export const LIMIT_GRACE_MS = 5 * 60 * 1000
export const KEEP_MS = 14 * 24 * 3600 * 1000
const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_PROMPT_MAX = 16000

export const UNDO_PROMPT = (label, notePath) => `While you were stopped, a ${label} agent worked on this task. Its handoff note is at ${notePath} ` +
  'and its changes are in the working tree; review them, then continue.'

/** The de-dupe key: the same agent in the same episode always gets the same id. */
export function handoffId(agentId, episodeId) {
  return crypto.createHash('sha256').update(String(agentId) + String(episodeId)).digest('hex').slice(0, 16)
}

/** Local copy of the §3.3 pure function; `createProviderSwitch`'s export is injected when available. */
export function fallbackTargetLocal(from, { defaultProvider, providerOrder } = {}, state = {}) {
  const order = [defaultProvider, ...(providerOrder || []).filter((p) => p !== defaultProvider)]
  return order.find((p) => p && p !== from && p !== 'codex' && state[p]?.usable) ?? null
}

export const providerOfAgentLocal = (a) => a?.provider || HARNESS_PROVIDER[a?.harness] || 'claude'

const isSub = (a) => a?.role === 'sub' || SUB_KINDS.has(a?.kind) || String(a?.id || '').includes(':sub:')
const err = (message, status) => Object.assign(new Error(message), { status })
const refOf = (r) => (r && typeof r === 'object' ? r.jobId || r.sessionId || r.runId || null : typeof r === 'string' ? r : null)

/** Why `a` can't be handed off automatically in this episode ('' = it can). Pure. */
export function problem(a, { provider, since, selfId, providerOf = providerOfAgentLocal } = {}) {
  if (!a || typeof a.id !== 'string' || !a.id) return 'unknown'
  if (providerOf(a) !== provider) return 'other provider'
  if (isSub(a)) return 'sub-agent'
  if (a.hidden) return 'hidden'
  if (a.self || (selfId && a.id === selfId)) return 'self'
  if (a.neverStarted) return 'never started'
  if (a.live) return ''
  const ls = a.limitStop
  if (ls && ls.kind !== 'api' && Number(ls.at) >= Number(since || 0) - LIMIT_GRACE_MS) return ''
  return 'not running'
}

/** Candidates sorted children first (deepest among the candidates first). Pure. */
export function orderChildrenFirst(list) {
  const byId = new Map(list.map((a) => [a.id, a]))
  const depth = (a) => {
    let d = 0; const seen = new Set([a.id]); let p = a.parentId
    while (p && byId.has(p) && !seen.has(p)) { seen.add(p); d++; p = byId.get(p).parentId }
    return d
  }
  return list.map((a, i) => ({ a, i, d: depth(a) })).sort((x, y) => y.d - x.d || x.i - y.i).map((x) => x.a)
}

/**
 * Options:
 * - `dataDir`; `getProvider(id)` -> adapter (§1.2); `settings.get()` -> providers.json shape (§2.3);
 * - `agents()` -> the classified agent list; `providerState()` -> `{ [id]: { usable, why, exhausted: {since, until}|null } }`;
 * - `buildNote(events, changes, meta)` / `notePrompt(note, max, { notePath })` (handoff-note.mjs);
 * - `readChanges(cwd)` (changes.mjs); `launches` (launches.mjs: `record`, `reparent`), optional;
 * - `fallbackTarget` (provider-switch.mjs), `providerOfAgent` (providers/index.mjs), optional;
 * - `projects()`: the known projects passed to `startPlan` (optional);
 * - `log(entry)`: account-log line (ids/providers/states only); `now`, `sleep`, `selfId`; timing overrides.
 */
export function createHandoffs({
  dataDir, getProvider, settings, agents, providerState, buildNote, notePrompt,
  readChanges = async () => null, launches = null, fallbackTarget = fallbackTargetLocal,
  providerOfAgent = providerOfAgentLocal, log = () => {}, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), selfId = null,
  pollMs = POLL_MS, idleMaxMs = IDLE_MAX_MS, appearMaxMs = APPEAR_MAX_MS, retryMs = RETRY_MS,
  staggerMs = STAGGER_MS, concurrency = CONCURRENCY, projects = async () => undefined,
}) {
  const file = path.join(dataDir, 'handoffs.json')
  const noteDir = path.join(dataDir, 'handoffs')
  let db = loadSync()
  const queue = []
  const active = new Map() // hid -> promise (never rejects)
  let pumping = null
  let lastStartAt = 0
  let ticking = null
  let saving = Promise.resolve()

  function loadSync() {
    let s = null
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { s = null }
    const out = { version: 1, episodes: {}, records: {} }
    if (!s || typeof s !== 'object') return out
    if (s.episodes && typeof s.episodes === 'object') for (const [p, e] of Object.entries(s.episodes)) if (e?.id) out.episodes[p] = e
    if (s.records && typeof s.records === 'object') {
      for (const [id, r] of Object.entries(s.records)) if (r && r.id === id && STATES.includes(r.state) && r.from?.agentId) out.records[id] = r
    }
    return out
  }
  /** Saves are chained so two writers never share the temp file and the last state always lands. */
  function save() {
    const run = saving.then(async () => {
      await fsp.mkdir(dataDir, { recursive: true })
      await writeAtomic(file, JSON.stringify(db) + '\n', 0o600)
    })
    saving = run.catch(() => {})
    return run
  }
  const safeLog = (e) => { try { Promise.resolve(log(e)).catch(() => {}) } catch { /* never break the flow */ } }
  const cfg = () => {
    let s = {}
    try { s = settings?.get?.() || {} } catch { s = {} }
    const h = s.handoff || {}
    return {
      defaultProvider: s.defaultProvider || 'claude', providerOrder: Array.isArray(s.providerOrder) ? s.providerOrder : ['claude'],
      mode: ['auto', 'ask', 'off'].includes(h.mode) ? h.mode : 'auto',
      maxHops: Number.isFinite(Number(h.maxHops)) ? Number(h.maxHops) : 2,
    }
  }
  async function list() {
    try { const l = await agents(); return Array.isArray(l) ? l : [] } catch { return [] }
  }
  async function stateNow() {
    let s = {}
    try { s = (await providerState()) || {} } catch { s = {} }
    let changed = false
    for (const [p, st] of Object.entries(s)) {
      const ex = st?.exhausted
      if (ex && Number(ex.since)) {
        const id = `${p}-${Number(ex.since)}`
        const cur = db.episodes[p]
        if (!cur || cur.id !== id || cur.until !== (ex.until ?? null)) { db.episodes[p] = { id, since: Number(ex.since), until: ex.until ?? null }; changed = true }
      } else if (db.episodes[p]) { delete db.episodes[p]; changed = true }
    }
    if (changed) await save()
    return s
  }
  async function projectsSafe() { try { return await projects() } catch { return undefined } }
  const adapter = (id) => { try { return getProvider(id) || null } catch { return null } }
  const terminalFor = (r) => TERMINAL.has(r.state)

  async function set(rec, patch) {
    const prev = rec.state
    Object.assign(rec, patch, { updatedAt: now() })
    await save()
    if (patch.state && patch.state !== prev && ['done', 'failed', 'undone'].includes(patch.state)) {
      safeLog({ at: rec.updatedAt, action: 'handoff', id: rec.id, episode: rec.episode, fromProvider: rec.from.provider,
        fromAgentId: rec.from.agentId, toProvider: rec.to.provider, toAgentId: rec.to.agentId || null, state: rec.state })
    }
  }
  const cancel = (rec, why) => set(rec, { state: 'cancelled', error: why })
  async function fail(rec, why) {
    await set(rec, { state: 'failed', error: why, attempts: (rec.attempts || 0) + 1, failedAt: now() })
  }

  /** Lineage: the record that created `agentId`, if any. */
  const parentRecordOf = (agentId) => Object.values(db.records)
    .filter((r) => r.to?.agentId === agentId && !['undone', 'cancelled', 'failed'].includes(r.state))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null
  function hopsOf(agentId) {
    let n = 0; const seen = new Set(); let r = parentRecordOf(agentId); const cut = now() - HOP_WINDOW_MS
    while (r && !seen.has(r.id)) { seen.add(r.id); if (r.createdAt >= cut) n++; r = parentRecordOf(r.from.agentId) }
    return n
  }

  function newRecord(a, episodeId, toProvider, extra = {}) {
    const id = handoffId(a.id, episodeId)
    const fromProvider = providerOfAgent(a)
    const parent = parentRecordOf(a.id)
    const t = now()
    return {
      id, episode: episodeId, chain: parent ? [...parent.chain, toProvider] : [fromProvider, toProvider],
      ...(parent ? { parentHid: parent.id } : {}),
      from: { agentId: a.id, provider: fromProvider, kind: a.kind || null, jobId: a.jobId || null, sid: a.sessionId || a.sid || null,
        cwd: a.cwd || null, name: a.name || a.title || '', parentAgentId: a.parentId || null,
        transcriptPath: a.transcriptPath || a.transcript || null },
      to: { provider: toProvider },
      state: 'planned', attempts: 0, createdAt: t, updatedAt: t, ...extra,
    }
  }

  // ---- scheduler: children first, `concurrency` at once, `staggerMs` apart ----
  const childrenOf = (rec) => Object.values(db.records).filter((r) => r.episode === rec.episode && r.id !== rec.id && r.from.parentAgentId === rec.from.agentId)
  const ready = (hid) => childrenOf(db.records[hid]).every((c) => !active.has(c.id) && !queue.includes(c.id))
  function enqueue(hid) {
    if (!active.has(hid) && !queue.includes(hid)) queue.push(hid)
    pump()
  }
  function pump() {
    pumping ??= (async () => {
      while (queue.length) {
        if (active.size >= concurrency) { await Promise.race(active.values()); continue }
        let i = queue.findIndex(ready)
        if (i < 0) {
          if (active.size) { await Promise.race(active.values()); continue }
          i = 0 // never wait on a cycle
        }
        const hid = queue.splice(i, 1)[0]
        if (!db.records[hid] || active.has(hid)) continue
        if (lastStartAt && staggerMs > 0) { const gap = lastStartAt + staggerMs - now(); if (gap > 0) await sleep(gap) }
        lastStartAt = now()
        const p = run(hid).finally(() => active.delete(hid))
        active.set(hid, p)
      }
    })().finally(() => { pumping = null; if (queue.length) pump() })
    return pumping
  }
  /** Resolves once nothing is queued or running (tests; graceful shutdown). */
  async function idle() {
    while (pumping || active.size) {
      await pumping
      await Promise.all([...active.values()])
    }
  }

  async function run(hid) {
    try { await step(hid) } catch (e) {
      const rec = db.records[hid]
      if (rec && !terminalFor(rec)) await fail(rec, `internal error (${e?.code || 'failed'})`).catch(() => {})
    }
  }

  async function findAgent(id) { return (await list()).find((a) => a.id === id) || null }
  const fromAgent = (rec, live) => live || { id: rec.from.agentId, provider: rec.from.provider, kind: rec.from.kind, jobId: rec.from.jobId,
    sessionId: rec.from.sid, cwd: rec.from.cwd, name: rec.from.name, transcriptPath: rec.from.transcriptPath }
  const matchesNew = (a, rec) => {
    if (!a || a.id === rec.from.agentId) return false
    if (a.handoffId === rec.id || a.env?.AGENTVILLE_HANDOFF_ID === rec.id) return true
    const ref = rec.to.ref
    if (!ref) return false
    return a.id === ref || a.id.endsWith(`:${ref}`) || [a.jobId, a.sessionId, a.runId].includes(ref)
  }
  /** The source recovered: its episode ended or a new one began. Manual handoffs don't depend on it. */
  const recovered = (rec) => !rec.manual && db.episodes[rec.from.provider]?.id !== rec.episode

  async function step(hid) {
    let resumed = true // the first pass may be a resume after a restart
    for (;;) {
      const rec = db.records[hid]
      if (!rec || terminalFor(rec) || (rec.state === 'planned' && rec.awaiting)) return
      if (PRE_START.has(rec.state)) {
        await stateNow()
        if (recovered(rec)) return cancel(rec, 'source recovered')
        if (!rec.manual && cfg().mode === 'off') return cancel(rec, 'handoff turned off')
      }
      if (rec.state === 'planned') { await set(rec, { state: 'waiting_idle', waitSince: now() }); resumed = false; continue }
      if (rec.state === 'waiting_idle') { await waitAndNote(rec); resumed = false; continue }
      if (rec.state === 'noted') { await startNew(rec); resumed = false; continue }
      if (rec.state === 'starting') {
        if (resumed || !rec.to.ref) {
          // Restart (or retry) with no confirmed start: look for an agent carrying this hid before starting again.
          const found = (await list()).find((a) => matchesNew(a, rec))
          if (found) { await set(rec, { state: 'started', to: { ...rec.to, ref: rec.to.ref || refOf(found.jobId || found.sessionId || found.runId) || found.id }, startedAt: rec.startedAt || now() }); continue }
          if (!rec.to.ref) { await doStart(rec); resumed = false; continue }
        }
        await set(rec, { state: 'started', startedAt: rec.startedAt || now() }); continue
      }
      if (rec.state === 'started') { await awaitNew(rec); resumed = false; continue }
      if (rec.state === 'stopping') { await stopOld(rec, resumed); return }
      return
    }
  }

  async function waitAndNote(rec) {
    const source = adapter(rec.from.provider)
    const since = Number(rec.waitSince) || now()
    let act = 'gone'; let live = null
    for (;;) {
      live = await findAgent(rec.from.agentId)
      try { act = live || rec.from.jobId ? await source?.activity?.(fromAgent(rec, live)) : 'gone' } catch { act = 'unknown' }
      if (['limit', 'idle', 'gone', 'dialog'].includes(act)) break
      if (now() - since >= idleMaxMs) { act = 'busy'; break }
      await sleep(pollMs)
      await stateNow()
      if (recovered(rec)) return cancel(rec, 'source recovered')
      if (db.records[rec.id] !== rec || terminalFor(rec)) return
    }
    const agent = fromAgent(rec, live)
    let events = []
    try { events = (await source?.readTranscript?.(agent, { maxBytes: TRANSCRIPT_MAX_BYTES })) || [] } catch { events = [] }
    if (!Array.isArray(events)) events = []
    let interrupted = null
    if (act === 'busy') {
      const open = [...events].reverse().find((e) => e?.tool && e.tool.done === false)
      interrupted = { tool: open?.tool?.name || 'tool' }
    }
    let changes = null
    try { changes = rec.from.cwd ? await readChanges(rec.from.cwd) : null } catch { changes = null }
    const all = await list()
    const subagents = all.filter((a) => a.parentId === rec.from.agentId && isSub(a) && a.live).map((a) => ({ description: a.name || a.title || a.id }))
    const children = childrenOf(rec).map((c) => ({ name: c.from.name, oldId: c.from.agentId, newId: c.to.agentId || null }))
    const lastSaid = [...events].reverse().find((e) => e?.role === 'assistant' && e.text)?.text
    const questions = act === 'dialog' ? [String(lastSaid || 'It was waiting on a question when it was handed off.').slice(0, 600)] : []
    const notePath = path.join(noteDir, `${rec.id}.md`)
    const meta = { name: rec.from.name, id: rec.from.agentId, provider: rec.from.provider, transcriptPath: rec.from.transcriptPath,
      ...(interrupted ? { interrupted } : {}), questions, subagents, children }
    const note = String(buildNote(events, changes, meta) ?? '')
    await fsp.mkdir(noteDir, { recursive: true })
    await writeAtomic(notePath, note.endsWith('\n') ? note : `${note}\n`, 0o600)
    await set(rec, { state: 'noted', notePath, activity: act, ...(interrupted ? { interrupted } : {}) })
  }

  async function startNew(rec) {
    // Re-check the target right before starting (§3.4 failure table, first row).
    const st = await stateNow()
    let to = rec.to.provider
    if (!st[to]?.usable) {
      to = rec.manual && rec.to.fixed ? null : fallbackTarget(rec.from.provider, cfg(), st)
      if (!to) return cancel(rec, 'no provider has room')
      rec.to = { ...rec.to, provider: to }
      rec.chain = [...rec.chain.slice(0, -1), to]
    }
    // A retry after an unconfirmed start: adopt the earlier agent if it showed up after all.
    if (rec.to.prevRef) {
      const prev = (await list()).find((a) => matchesNew(a, { ...rec, to: { ...rec.to, ref: rec.to.prevRef } }))
      if (prev) return set(rec, { state: 'started', to: { ...rec.to, ref: rec.to.prevRef }, startedAt: now() })
    }
    await set(rec, { state: 'starting', startAttemptAt: now() })
    await doStart(rec)
  }

  async function doStart(rec) {
    const source = adapter(rec.from.provider)
    const target = adapter(rec.to.provider)
    if (!target) return fail(rec, 'target provider missing')
    let max = DEFAULT_PROMPT_MAX
    try { max = Number(target.options?.()?.promptMax) || DEFAULT_PROMPT_MAX } catch { /* default */ }
    let notes = ''
    try { notes = await fsp.readFile(rec.notePath, 'utf8') } catch { notes = '' }
    const prompt = notePrompt(notes, max, { notePath: rec.notePath })
    const from = fromAgent(rec, null)
    const pick = (fn) => { try { return typeof fn === 'function' ? fn.call(target, from) || '' : '' } catch { return '' } }
    let plan
    try {
      plan = await target.startPlan({
        cwd: rec.from.cwd, prompt, name: `${rec.from.name || 'agent'} (from ${source?.label || rec.from.provider})`,
        model: pick(target.mapModel), permissionMode: pick(target.mapMode),
        env: { AGENTVILLE_AGENT_ID: rec.id, AGENTVILLE_HANDOFF_ID: rec.id },
      }, await projectsSafe())
    } catch (e) { return fail(rec, `start refused (${e?.status || e?.code || 'error'})`) }
    let res
    try { res = await target.run(plan) } catch { res = { ok: false, error: 'run threw' } }
    const ref = refOf(res?.ref)
    if (!res?.ok || !ref) return fail(rec, res?.ok ? 'start returned no id' : 'start failed')
    await set(rec, { state: 'started', to: { ...rec.to, ref, refs: res.ref }, startedAt: now() })
    try { launches?.record?.({ ref, parentAgentId: rec.from.parentAgentId, provider: rec.to.provider, via: 'handoff' }) } catch { /* ledger is best effort */ }
  }

  async function awaitNew(rec) {
    const since = Number(rec.startedAt) || now()
    for (;;) {
      const found = (await list()).find((a) => matchesNew(a, rec))
      if (found && !found.neverStarted) {
        try { launches?.reparent?.(rec.from.agentId, found.id) } catch { /* best effort */ }
        return set(rec, { state: 'stopping', to: { ...rec.to, agentId: found.id } })
      }
      if (now() - since >= appearMaxMs) {
        return fail(rec, found?.neverStarted ? 'the new agent never started' : 'the new agent never appeared')
      }
      await sleep(pollMs)
      if (db.records[rec.id] !== rec || rec.state !== 'started') return
    }
  }

  async function stopOld(rec, resumed) {
    const source = adapter(rec.from.provider)
    const live = await findAgent(rec.from.agentId)
    if (resumed && rec.stopAttemptAt) {
      // A restart after the stop was sent: never send it blindly again.
      return set(rec, live?.live ? { state: 'done', warning: 'old agent still running' } : { state: 'done' })
    }
    if (live && !live.live && live.bucket !== 'busy') return set(rec, { state: 'done' })
    if (rec.from.kind === 'session' && !rec.from.jobId) return set(rec, { state: 'done', note: 'close the old terminal' })
    await set(rec, { stopAttemptAt: now() })
    let ok = false
    try { ok = Boolean((await source.run(await source.stopPlan(fromAgent(rec, live))))?.ok) } catch { ok = false }
    return set(rec, ok ? { state: 'done' } : { state: 'done', warning: 'old agent still running' })
  }

  // ---- tick: episodes, new candidates, resumes, the one automatic retry ----
  async function tickOnce() {
    const st = await stateNow()
    const c = cfg()
    const t = now()
    // Episodes that ended cancel the records that hadn't started yet (the runners also check this).
    for (const r of Object.values(db.records)) {
      if (!r.manual && PRE_START.has(r.state) && !active.has(r.id) && db.episodes[r.from.provider]?.id !== r.episode) await cancel(r, 'source recovered')
    }
    if (c.mode !== 'off') {
      const all = await list()
      for (const [p, ep] of Object.entries(db.episodes)) {
        if (!st[p]?.exhausted) continue
        const cands = orderChildrenFirst(all.filter((a) => !problem(a, { provider: p, since: ep.since, selfId, providerOf: providerOfAgent })))
        for (const a of cands) {
          const hid = handoffId(a.id, ep.id)
          if (db.records[hid]) continue
          if (Object.values(db.records).some((r) => r.from.agentId === a.id && !TERMINAL.has(r.state))) continue
          if (hopsOf(a.id) >= c.maxHops) continue
          const to = fallbackTarget(p, c, st)
          if (!to) continue // usage-pause covers it (covers() is false)
          db.records[hid] = newRecord(a, ep.id, to, c.mode === 'ask' ? { awaiting: 'approval' } : {})
          await save()
        }
      }
    }
    // Resume anything in flight (after a restart too), and the one automatic retry.
    for (const r of Object.values(db.records)) {
      if (r.state === 'failed' && !r.dismissed && (r.attempts || 0) < 2 && t - (r.failedAt || 0) >= retryMs && (r.manual || db.episodes[r.from.provider]?.id === r.episode) && c.mode !== 'off') {
        await reopen(r)
      }
      if (!TERMINAL.has(r.state) && !(r.state === 'planned' && r.awaiting)) enqueue(r.id)
    }
    prune()
    return info()
  }
  function prune() {
    const cut = now() - KEEP_MS
    let n = 0
    for (const [id, r] of Object.entries(db.records)) if (TERMINAL.has(r.state) && r.updatedAt < cut) { delete db.records[id]; n++ }
    if (n) save().catch(() => {})
  }
  async function reopen(r) {
    const prevRef = r.to.ref || r.to.prevRef || null
    const to = { provider: r.to.provider, ...(r.to.fixed ? { fixed: true } : {}), ...(prevRef ? { prevRef } : {}) }
    await set(r, { state: r.notePath ? 'noted' : 'planned', to, error: null, awaiting: undefined, startAttemptAt: undefined, startedAt: undefined })
  }
  const tick = () => (ticking ??= tickOnce().catch((e) => { safeLog({ at: now(), action: 'handoff-error', code: e?.code || 'failed' }); return info() })
    .finally(() => { ticking = null }))

  // ---- user actions ----
  const need = (id) => { const r = db.records[id]; if (!r) throw err('no such handoff', 404); return r }

  /** Manual handoff (`POST /api/agents/:id/handoff { to }`). Joins the record of a running auto handoff. */
  async function start(agentId, { to } = {}) {
    const a = await findAgent(agentId)
    if (!a) throw err('no such agent', 404)
    if (isSub(a)) throw err('sub-agents are handed off with their lead', 409)
    if (a.hidden || a.self || (selfId && a.id === selfId)) throw err('this agent cannot be handed off', 409)
    if (a.neverStarted) throw err('this agent never started', 409)
    const provider = providerOfAgent(a)
    const st = await stateNow()
    const c = cfg()
    const target = to || fallbackTarget(provider, c, st)
    if (!target || target === provider || target === 'codex') throw err('no provider to hand this agent to', 409)
    if (!st[target]?.usable) throw err(`${target} has no room or is not available`, 409)
    const ep = db.episodes[provider]?.id || `manual-${provider}-${now()}`
    const hid = handoffId(a.id, ep)
    const existing = db.records[hid]
    if (existing) {
      if (existing.state === 'planned' && existing.awaiting) await set(existing, { awaiting: undefined })
      else if (['cancelled', 'failed'].includes(existing.state)) {
        await reopen(existing)
        await set(existing, { manual: true, to: { ...existing.to, provider: target, fixed: Boolean(to) } })
      }
      if (!TERMINAL.has(existing.state)) enqueue(hid)
      return view(existing)
    }
    const busy = Object.values(db.records).find((r) => r.from.agentId === a.id && !TERMINAL.has(r.state))
    if (busy) { enqueue(busy.id); return view(busy) }
    const rec = newRecord(a, ep, target, { manual: true })
    if (to) rec.to.fixed = true
    db.records[hid] = rec
    await save()
    enqueue(hid)
    return view(rec)
  }

  /** "Ask first": the user approved one planned record. */
  async function approve(id) {
    const r = need(id)
    if (r.state !== 'planned') throw err(`handoff is ${r.state}`, 409)
    await set(r, { awaiting: undefined })
    enqueue(id)
    return view(r)
  }
  async function retry(id) {
    const r = need(id)
    if (r.state !== 'failed') throw err(`handoff is ${r.state}`, 409)
    await reopen(r)
    await set(r, { manual: true, dismissed: undefined })
    enqueue(id)
    return view(r)
  }
  async function dismiss(id) {
    const r = need(id)
    if (r.state === 'failed') await set(r, { dismissed: true })
    else if (r.state === 'planned' && !active.has(id)) await cancel(r, 'dismissed')
    else throw err(`handoff is ${r.state}`, 409)
    return view(r)
  }

  /** Undo (only from `started` or `done`): stop the new agent, resume the old one. Files are never reverted. */
  async function undo(id) {
    let r = need(id)
    if (active.has(id)) await active.get(id)
    r = need(id)
    if (!['started', 'done'].includes(r.state)) throw err(`handoff is ${r.state}`, 409)
    const source = adapter(r.from.provider)
    const target = adapter(r.to.provider)
    if (!source?.capabilities?.resume || typeof source.resumePlan !== 'function') throw err(`${source?.label || r.from.provider} agents can't be resumed`, 409)
    const all = await list()
    if (r.to.agentId || r.to.ref) {
      const fresh = all.find((a) => a.id === r.to.agentId) || all.find((a) => matchesNew(a, r))
      if (!fresh || fresh.live !== false) {
        const newAgent = fresh || { id: r.to.agentId || `${r.to.provider}:${r.to.ref}`, provider: r.to.provider, jobId: r.to.refs?.jobId, runId: r.to.refs?.runId, sessionId: r.to.refs?.sessionId }
        let ok = false
        try { ok = Boolean((await target.run(await target.stopPlan(newAgent)))?.ok) } catch { ok = false }
        if (!ok) throw err('could not stop the new agent', 502)
      }
    }
    await set(r, { undoStoppedAt: now() })
    const old = all.find((a) => a.id === r.from.agentId)
    let res
    try { res = await source.run(await source.resumePlan(fromAgent(r, old), { prompt: UNDO_PROMPT(target?.label || r.to.provider, r.notePath) })) } catch { res = { ok: false } }
    if (!res?.ok) throw err('the new agent was stopped, but the old one could not be resumed', 502)
    await set(r, { state: 'undone' })
    return view(r)
  }

  // ---- reads ----
  function view(r) {
    return {
      id: r.id, episode: r.episode, chain: [...r.chain], parentHid: r.parentHid || null, from: { ...r.from }, to: { ...r.to },
      state: r.state, awaiting: r.awaiting || null, manual: Boolean(r.manual), interrupted: r.interrupted || null,
      error: r.error || null, warning: r.warning || null, note: r.note || null, notePath: r.notePath || null,
      dismissed: Boolean(r.dismissed), attempts: r.attempts || 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }
  }
  const listRecords = () => Object.values(db.records).sort((a, b) => b.createdAt - a.createdAt).map(view)
  const get = (id) => (db.records[id] ? view(db.records[id]) : null)
  /** usage-pause asks this: true while the handoff flow is handling the agent (it then must not pause it). */
  const covers = (agentId) => Object.values(db.records).some((r) => r.from.agentId === agentId && !['cancelled', 'failed', 'undone'].includes(r.state))
  /** sub-limit / stale-login nudges skip agents in a non-terminal handoff. */
  const inFlight = (agentId) => Object.values(db.records).some((r) => r.from.agentId === agentId && !TERMINAL.has(r.state))
  /** classify.mjs annotations (§2.4). */
  function annotate(agentId) {
    const latest = (rs) => rs.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null
    const out = latest(Object.values(db.records).filter((r) => r.from.agentId === agentId && r.state !== 'cancelled'))
    const inn = latest(Object.values(db.records).filter((r) => r.to.agentId === agentId))
    return {
      handoff: out ? { id: out.id, state: out.state, toProvider: out.to.provider, toAgentId: out.to.agentId || null, at: out.updatedAt } : null,
      handedOffFrom: inn ? { id: inn.id, fromProvider: inn.from.provider, fromAgentId: inn.from.agentId } : null,
    }
  }
  const info = () => ({ episodes: { ...db.episodes }, records: listRecords() })

  return { tick, idle, start, approve, retry, dismiss, undo, list: listRecords, get, covers, inFlight, annotate, info }
}
