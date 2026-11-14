/**
 * Sub-agents the API terminated (the usage limit, an API error) never resume on their own, and only
 * their parent can resume them (SendMessage). Once requests can work again — the account changed
 * (any switch, manual or automatic) or the limit's reset time passed — each parent session with such
 * children gets ONE message saying how many died and to resume them.
 *
 * Rules: at most one message per parent per incident (a parent is covered up to the latest stop it
 * was told about); re-checked at delivery (the children are still dead, the active account has
 * room); never a hidden parent, a sub-agent, Agentville's own session, Codex, or a parent that isn't
 * live. One log line per message, ids and counts only. State: `<dataDir>/sub-limit.json`.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeAtomic } from './accounts.mjs'

/** Stops older than this are history: never nudged about (e.g. right after a fresh install). */
export const MAX_AGE_MS = 12 * 3600e3
const SUB_KINDS = new Set(['subagent', 'teammate', 'thread'])
const MAX_IDS = 40

/** The agent id a parent's SendMessage takes: the part after `:sub:` (Claude's `agent-<id>` file). */
export const subIdOf = (id) => String(id || '').split(':sub:')[1] || ''

/** The message one parent gets. Counts and agent ids only. */
export function nudgeText(stops) {
  const n = stops.length
  const limits = stops.filter((s) => s.kind !== 'api').length
  const by = limits === n ? 'the usage limit' : limits ? 'the usage limit or an API error' : 'an API error'
  const ids = stops.map((s) => s.subId).filter(Boolean)
  const list = ids.length ? ` Their agent IDs: ${ids.slice(0, MAX_IDS).join(', ')}${ids.length > MAX_IDS ? `, and ${ids.length - MAX_IDS} more` : ''}.` : ''
  return `${n === 1 ? 'One of your sub-agents was' : `${n} of your sub-agents were`} stopped by ${by} and will not continue on their own. ` +
    `Requests work again now. Resume ${n === 1 ? 'it' : 'each one'} with SendMessage to its agent ID: "continue where you stopped".${list} ` +
    `If one is no longer needed, leave it stopped.`
}

/**
 * Parents with dead children that are ready to be told: `[{ parentId, stops, coverTo }]`.
 * `stops` are the ready ones; `coverTo` is the latest stop among all of its dead children (one message
 * covers the whole incident). Pure.
 */
export function pending(agents, { covered = {}, changedAt = 0, now = Date.now() } = {}) {
  const byParent = new Map()
  for (const a of agents || []) {
    const s = a?.limitStop
    if (!a.parentId || a.bucket !== 'stalled' || !s || !SUB_KINDS.has(a.kind) || !(s.at > 0)) continue
    if (now - s.at > MAX_AGE_MS) continue
    const list = byParent.get(a.parentId) || []
    list.push({ id: a.id, subId: subIdOf(a.id), at: s.at, resetsAt: s.resetsAt || null, kind: s.kind })
    byParent.set(a.parentId, list)
  }
  const out = []
  for (const [parentId, all] of byParent) {
    const fresh = all.filter((s) => s.at > (covered[parentId] || 0))
    const ready = fresh.filter((s) => changedAt > s.at || (s.resetsAt && now >= s.resetsAt))
    if (ready.length) out.push({ parentId, stops: ready, coverTo: Math.max(...all.map((s) => s.at)) })
  }
  return out
}

/** Why `parent` must not get a message ('' = it may). */
export function parentProblem(parent, selfId = null) {
  if (!parent) return 'gone'
  if (parent.hidden) return 'hidden'
  if (SUB_KINDS.has(parent.kind)) return 'a sub-agent'
  if (parent.harness !== 'claude-code') return 'not Claude Code'
  if (!parent.live) return 'not running'
  if (parent.self || parent.id === selfId) return 'Agentville itself'
  return ''
}

/**
 * `agents({ fresh })`: the snapshot's agents (fresh: a new scan); `changedAt()`: when Claude's account
 * last changed (ms); `canRequest()`: true when the active account has room; `deliverTo(parentId, text)`:
 * resolves true when delivered; `selfId`: Agentville's own agent id (never messaged).
 */
export function createSubLimitNudger({ dataDir, agents, changedAt, canRequest, deliverTo, selfId = null, log = (l) => console.log(l), now = Date.now }) {
  const file = path.join(dataDir, 'sub-limit.json')
  let state = null
  let running = null

  async function load() {
    if (state) return state
    try { state = JSON.parse(await fsp.readFile(file, 'utf8')) } catch { state = {} }
    if (typeof state.enabled !== 'boolean') state.enabled = true
    if (!state.covered || typeof state.covered !== 'object' || Array.isArray(state.covered)) state.covered = {}
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

  async function tickOnce() {
    await load()
    if (!state.enabled) return []
    const opts = async () => ({ covered: state.covered, changedAt: Number(await changedAt()) || 0, now: now() })
    const first = pending(await agents({ fresh: false }), await opts())
    if (!first.length) return []
    if (!(await canRequest())) return [] // still out: wait for the reset or a switch
    // Re-check at delivery against a fresh scan: still dead, parent still messageable.
    const list = await agents({ fresh: true })
    const byId = new Map(list.map((a) => [a.id, a]))
    const ready = pending(list, await opts())
    const sent = []
    for (const p of ready) {
      if (parentProblem(byId.get(p.parentId), selfId)) continue
      let ok = false
      try { ok = Boolean(await deliverTo(p.parentId, nudgeText(p.stops))) } catch { ok = false }
      if (!ok) continue // not covered: the next tick tries again
      state.covered[p.parentId] = Math.max(state.covered[p.parentId] || 0, p.coverTo)
      sent.push(p.parentId)
      log(`sub-limit nudge: ${p.parentId} told to resume ${p.stops.length} stopped sub-agent${p.stops.length === 1 ? '' : 's'}`)
    }
    // Forget parents whose incidents are long past.
    for (const [id, at] of Object.entries(state.covered)) if (now() - at > 2 * MAX_AGE_MS) delete state.covered[id]
    if (sent.length || ready.length) await save()
    return sent
  }

  /** One pass at a time; errors are logged without detail and the next tick tries again. */
  const tick = () => (running ??= tickOnce().catch((e) => { log(`sub-limit nudge: ${e.code || 'failed'}`); return [] }).finally(() => { running = null }))
  const info = async () => { await load(); return { enabled: state.enabled } }
  return { tick, setEnabled, info }
}
