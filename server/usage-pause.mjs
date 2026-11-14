/**
 * Usage pause: when every Claude account is out (auto-switch is blocked, nowhere to go), pause the fleet
 * safely and wait for an account to come back.
 *
 *   running  -> paused    auto-switch says blocked (all accounts low). Each top-level live agent gets ONE
 *                         message: finish or checkpoint the current step, start nothing new, wait.
 *   paused   -> resuming  auto-switch is no longer blocked AND `canRequest()` says the active account
 *                         really has room (auto-switch has moved to it, or a window reset).
 *   resuming -> running   each recorded agent gets ONE "usage is back, continue" message, STAGGER_MS apart.
 *                         Sub-agents killed by the limit are then left to sub-limit.mjs (serve.mjs ticks it
 *                         right after this).
 *
 * While paused or resuming `holding()` is true, and every automated nudger (sub-limit resumes, the
 * auto-switch "continue" nudge and stale-login respawn, the task-name helper) checks it and does nothing.
 *
 * Rules: one pause message and one resume message per agent per pause, no retries (a failed delivery is
 * recorded, never re-sent); never a sub-agent, a hidden agent, Agentville's own session, Codex, or an agent
 * that isn't live. Ids, names and statuses only: never tokens or transcript text. State is persisted in
 * `<dataDir>/usage-pause.json`, written before each message goes out, so a restart mid-pause keeps it and
 * never repeats a message. Turning it off stops new pauses and releases the nudgers at once; a pause
 * already under way still sends its resume message when usage returns, so no agent waits forever.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeAtomic } from './accounts.mjs'

export const STAGGER_MS = 2000
const SUB_KINDS = new Set(['subagent', 'teammate', 'thread'])
const STATES = new Set(['running', 'paused', 'resuming'])

export const PAUSE_TEXT = 'Agentville: usage is out on every Claude account. Finish or checkpoint the step you are on ' +
  '(if you are mid-edit, commit your work in progress), then stop. Do not start new work and do not spawn sub-agents. ' +
  'Wait: you will get a message telling you to continue.'
export const RESUME_TEXT = 'Agentville: usage is back. Continue where you left off.'

/** True when auto-switch is blocked because every account is out (not "login entry too big"), and the block hasn't lapsed. */
export function shouldPause({ blocked, now = Date.now() } = {}) {
  if (!blocked || typeof blocked !== 'object' || blocked.reason) return false
  if (!blocked.why) return false
  return !(Number(blocked.until) > 0 && blocked.until <= now)
}

/** Why `a` is not an agent to pause or resume ('' = it is). */
function problem(a, selfId) {
  if (!a || typeof a.id !== 'string' || !a.id) return 'unknown'
  if (a.hidden) return 'hidden'
  if (a.role === 'sub' || SUB_KINDS.has(a.kind) || a.id.includes(':sub:')) return 'sub-agent'
  if (a.self || (selfId && a.id === selfId)) return 'self'
  if (a.harness && a.harness !== 'claude-code') return 'not Claude Code'
  if (!a.live) return 'not running'
  if (a.bucket === 'resting' || a.bucket === 'done' || a.done) return 'resting'
  return ''
}

/** Top-level live agents to tell to pause: `[{ id, name }]`. Pure. */
export function pauseTargets(agents, selfId = null) {
  const seen = new Set()
  const out = []
  for (const a of agents || []) {
    if (problem(a, selfId) || seen.has(a.id)) continue
    seen.add(a.id)
    out.push({ id: a.id, name: typeof a.name === 'string' ? a.name : '' })
  }
  return out
}

/**
 * The recorded agents to tell to continue now: `[{ id, name }]`. Skips ones already resumed this pause and
 * ones that are gone, hidden, no longer live, or otherwise not messageable now (resting ones are included:
 * a paused agent usually looks idle). Pure.
 */
export function resumeTargets(record, agents, selfId = null) {
  const byId = new Map((agents || []).filter((a) => a && a.id).map((a) => [a.id, a]))
  const done = new Set((record?.resumed || []).map((r) => r.id))
  const out = []
  for (const r of record?.agents || []) {
    if (!r?.id || done.has(r.id)) continue
    const a = byId.get(r.id)
    if (!a) continue
    const why = problem(a, selfId)
    if (why && why !== 'resting') continue
    done.add(r.id)
    out.push({ id: r.id, name: r.name || a.name || '' })
  }
  return out
}

const fresh = () => ({ state: 'running', since: null, until: null, reason: null, agents: [], resumed: [] })

/**
 * `agents()`: the current agents (the /api/agents shape); `blocked()`: auto-switch's `info().blocked` or null;
 * `deliverTo(id, text)`: resolves true when delivered (fleet inbox); `canRequest()`: resolves true when the
 * active account has room; `log(entry)`: one fleet-log line (object, ids and statuses only); `selfId`:
 * Agentville's own agent id; `sleep(ms)`: for the resume stagger (tests pass a fake).
 */
export function createUsagePause({ dataDir, agents, blocked, deliverTo, canRequest, log = () => {}, now = Date.now, selfId = null,
  staggerMs = STAGGER_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const file = path.join(dataDir, 'usage-pause.json')
  let state = loadSync()
  let running = null

  function loadSync() {
    let s = null
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { s = null }
    const out = { enabled: true, ...fresh() }
    if (!s || typeof s !== 'object' || Array.isArray(s)) return out
    if (typeof s.enabled === 'boolean') out.enabled = s.enabled
    if (!STATES.has(s.state)) return out
    out.state = s.state
    out.since = Number(s.since) || null
    out.until = Number(s.until) || null
    out.reason = typeof s.reason === 'string' ? s.reason : null
    const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string') : [])
    out.agents = list(s.agents).map((a) => ({ id: a.id, name: typeof a.name === 'string' ? a.name : '' }))
    out.resumed = list(s.resumed).map((r) => ({ id: r.id, status: typeof r.status === 'string' ? r.status : 'failed' }))
    return out
  }
  async function save() {
    await fsp.mkdir(dataDir, { recursive: true })
    await writeAtomic(file, JSON.stringify(state) + '\n', 0o600)
  }
  const safeLog = (entry) => { try { Promise.resolve(log(entry)).catch(() => {}) } catch { /* never let logging break a tick */ } }
  async function send(id, text) {
    try { return Boolean(await deliverTo(id, text)) } catch { return false }
  }
  async function list() {
    try { const l = await agents(); return Array.isArray(l) ? l : [] } catch { return [] }
  }

  /** Tell each new target to pause, once. Recorded (and saved) before it is sent, so it is never sent twice. */
  async function tellPause(targets) {
    const results = []
    for (const t of targets) {
      state.agents.push(t)
      await save()
      results.push({ id: t.id, status: (await send(t.id, PAUSE_TEXT)) ? 'sent' : 'failed' })
    }
    return results
  }

  async function enter(b, t) {
    Object.assign(state, fresh(), { state: 'paused', since: t, until: Number(b.until) || null, reason: String(b.why) })
    await save()
    const results = await tellPause(pauseTargets(await list(), selfId))
    safeLog({ at: t, action: 'usage-pause', source: 'usage-pause', why: state.reason, until: state.until, results })
  }

  /** Agents that came up during the pause: told once too (never the ones already recorded). */
  async function joiners(t) {
    const known = new Set(state.agents.map((a) => a.id))
    const extra = pauseTargets(await list(), selfId).filter((a) => !known.has(a.id))
    if (!extra.length) return
    const results = await tellPause(extra)
    safeLog({ at: t, action: 'usage-pause', source: 'usage-pause', joined: true, results })
  }

  async function resume() {
    const current = await list()
    const targets = resumeTargets(state, current, selfId)
    const results = []
    for (let i = 0; i < targets.length; i++) {
      if (i && staggerMs > 0) await sleep(staggerMs)
      // Recorded before the send: a restart in between skips it rather than sending it twice.
      const entry = { id: targets[i].id, status: 'sending' }
      state.resumed.push(entry)
      await save()
      entry.status = (await send(entry.id, RESUME_TEXT)) ? 'sent' : 'failed'
      await save()
      results.push({ ...entry })
    }
    const told = new Set(state.resumed.map((r) => r.id))
    for (const a of state.agents) if (!told.has(a.id)) { state.resumed.push({ id: a.id, status: 'skipped' }); results.push({ id: a.id, status: 'skipped' }) }
    for (const r of state.resumed) if (r.status === 'sending') r.status = 'sent-unconfirmed' // interrupted by a restart
    const at = now()
    Object.assign(state, { state: 'running', since: at, until: null, reason: null, agents: [] })
    await save()
    safeLog({ at, action: 'usage-resume', source: 'usage-pause', results })
  }

  async function tickOnce() {
    if (state.state === 'running' && !state.enabled) return info()
    const t = now()
    let b = null
    try { b = await blocked() } catch { b = null }
    const out = shouldPause({ blocked: b, now: t })
    if (state.state === 'running') {
      if (out) await enter(b, t)
    } else if (out) {
      if (state.state === 'resuming') { state.state = 'paused'; await save() } // blocked again mid-resume
      if (b?.until && Number(b.until) !== state.until) { state.until = Number(b.until) || null; await save() }
      await joiners(t)
    } else if (await canRequestSafe()) {
      if (state.state === 'paused') { state.state = 'resuming'; await save() }
      await resume()
    }
    return info()
  }
  async function canRequestSafe() {
    try { return Boolean(await canRequest()) } catch { return false }
  }

  /** One pass at a time; a failure is logged without detail and the next tick carries on. */
  const tick = () => (running ??= tickOnce().catch((e) => { safeLog({ at: now(), action: 'usage-pause-error', source: 'usage-pause', code: e?.code || 'failed' }); return info() })
    .finally(() => { running = null }))

  function info() {
    return {
      enabled: state.enabled, state: state.state, since: state.since, until: state.until, reason: state.reason,
      agents: state.agents.map((a) => ({ id: a.id, name: a.name })),
      resumed: state.resumed.map((r) => ({ id: r.id, status: r.status })),
    }
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false'), { status: 400 })
    state.enabled = enabled
    await save()
    return info()
  }
  /** True while the fleet is paused (or being resumed): automated nudgers must do nothing. */
  const holding = () => state.enabled && state.state !== 'running'

  return { tick, info, setEnabled, holding }
}
