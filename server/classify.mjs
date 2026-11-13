/**
 * Pure: adapter facts -> bucket/reason (the rules in docs/ARCHITECTURE.md) and the boss/lead/sub tree.
 * Every view reads the result; nothing here touches the filesystem.
 *
 * Adapter fact shape (one per agent):
 *   { id, harness, kind: 'session'|'job'|'thread'|'subagent'|'teammate', name, title, project, cwd,
 *     parentId, live, lastActivityAt, lifecycle, needsUser, needsUserSource, waitingOn, prs, resume, fanAgents }
 *   lifecycle: 'running' | 'idle' (turn finished) | 'dead' (ended mid-work, process gone) |
 *              'stuck' (live, mid-turn, no progress for 30 min) | 'failed' |
 *              'done' | 'stopped' | 'closed'
 */
import { currentWait } from './waiting.mjs'
import { PAUSED, PREP_MS } from './fleet.mjs'
import { COLOR_NAMES } from './overrides.mjs'

/** Rule 7's "old". One global threshold. */
export const REST_MS = 24 * 60 * 60 * 1000
/** Quiet this long (no transcript write, job update or registry status) and the agent is gone from the app. */
export const QUIET_REMOVE_DAYS = 10
export const QUIET_REMOVE_MS = QUIET_REMOVE_DAYS * 24 * 60 * 60 * 1000

/**
 * Drop agents quiet for over QUIET_REMOVE_DAYS before anything else looks at them. Live agents and
 * ones marked Important stay. Only a filter: nothing on disk is touched. Returns the kept facts and
 * the removed ids (a kept child whose parent was removed becomes top-level in `build`).
 */
export function dropQuiet(facts, overrides = {}, now = Date.now()) {
  const kept = []
  const removed = new Set()
  for (const a of facts) {
    if (a.live || overrides[a.id]?.important === true || now - (a.lastActivityAt || 0) <= QUIET_REMOVE_MS) kept.push(a)
    else removed.add(a.id)
  }
  return { kept, removed }
}

export const REASONS = {
  needsUser: 'Needs your input',
  approval: 'Needs your approval',
  stuck: 'No progress for 30 min',
  failed: 'Hit an error',
  turn: 'Turn finished — awaiting your reply',
  dead: 'Stopped unexpectedly',
  lead: 'Waiting on its lead',
  done: 'Done',
  stopped: 'Stopped',
  closed: 'Closed',
  quiet: 'Quiet for over a day',
  parked: 'Idle teammate',
  replaced: 'Failed to start; relaunched',
  superseded: 'Replaced by a newer session',
  restarted: 'Restarted mid-task: send "continue"',
  // Cut off by the machine, not the API: the Mac slept, or the network was down.
  slept: 'Interrupted when the Mac slept: send "continue"',
  offline: 'Lost the connection: send "continue"',
}
/** A dialog in the session waiting for the user to click: the `prompt` fact. */
export const PROMPTS = {
  permission: 'Needs a click: permission prompt',
  question: 'Needs a click: pick an option',
  plan: 'Needs a click: approve the plan',
  dialog: 'Needs a click: a dialog is open',
}
const PARKED_MS = 30 * 60 * 1000
const waitingOnAgents = (n) => `Waiting on ${n} agent${n === 1 ? '' : 's'}`

/** Trim to `max` chars at a word boundary, marking the cut with "…". */
export function cap(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '') + '…'
}
export const NAME_MAX = 80
export const TITLE_MAX = 160

const SUB_KINDS = new Set(['subagent', 'teammate', 'thread'])
const ROLES = new Set(['boss', 'lead', 'sub', 'solo'])

/** Rules 1-4, 6, 7 for one agent, ignoring children. Rule 5 is applied in `build`. */
export function classify(a, now = Date.now()) {
  const r = (bucket, reason, reasonSource, since) => ({ bucket, reason, reasonSource, since: since || a.lastActivityAt || 0 })
  // Age first: a week-old "blocked" or "failed" record is history, not something to chase.
  if (now - (a.lastActivityAt || 0) > REST_MS) return r('resting', REASONS.quiet, 'lifecycle')
  if (['done', 'stopped', 'closed', 'replaced', 'superseded'].includes(a.lifecycle)) return r('resting', REASONS[a.lifecycle], 'lifecycle')
  if (a.needsUser) return { ...r('stalled', PROMPTS[a.prompt] || a.needsUserReason || REASONS.needsUser, a.needsUserSource === 'scheduler' ? 'scheduler' : 'tool'), prompt: PROMPTS[a.prompt] ? a.prompt : null } // 1
  if (a.lifecycle === 'failed') return r('stalled', a.errorReason || REASONS.failed, 'lifecycle') // 2
  const w = currentWait(a.waitingOn, now) // 3
  if (w) return r('waiting', w.reason, w.source === 'outstanding-tool' ? 'tool' : 'scheduler', w.since)
  if (a.lifecycle === 'running') return { bucket: 'building', reason: '', reasonSource: '', since: a.lastActivityAt || 0 } // 4
  // An idle teammate answers to its lead, not to the user. Parked for a while, it is not one of
  // the lead's working agents (Claude's own agent count leaves it out too), so it rests.
  if (a.kind === 'teammate' && a.lifecycle === 'idle') {
    return now - (a.lastActivityAt || 0) > PARKED_MS ? r('resting', REASONS.parked, 'lifecycle') : r('waiting', REASONS.lead, 'lifecycle')
  }
  return r('stalled', a.lifecycle === 'idle' ? REASONS.turn : a.lifecycle === 'stuck' ? REASONS.stuck : REASONS.dead, 'lifecycle') // 6
}

/**
 * Facts + overrides -> the `GET /api/agents` agents (hidden ones flagged, not dropped).
 * `overrides` is `{ [id]: { role?, parentId?, name?, hidden?, important?, color? } }`; `parentId: ''` forces top-level.
 * `prep` is the pending fleet prep `{ kind, at, ids }` the user marked as sent, or null.
 */
export function build(facts, overrides = {}, now = Date.now(), prep = null) {
  const byId = new Map(facts.map((a) => [a.id, a]))
  const base = new Map(facts.map((a) => [a.id, classify(a, now)]))

  // Parent links. A detected parent that has gone to rest no longer owns a live child (e.g. the
  // terminal session that launched a boss three weeks ago). Overrides always win.
  const parentOf = new Map()
  for (const a of facts) {
    const o = overrides[a.id] || {}
    let p = a.parentId || null
    // A prepped parent stays a parent while paused (after a reboot nothing is live).
    if (p && (!byId.has(p) || (base.get(p).bucket === 'resting' && base.get(a.id).bucket !== 'resting' && !prep?.ids?.includes(p)))) p = null
    if (typeof o.parentId === 'string') p = o.parentId && o.parentId !== a.id && byId.has(o.parentId) ? o.parentId : null
    parentOf.set(a.id, p)
  }
  const children = new Map(facts.map((a) => [a.id, []]))
  for (const [id, p] of parentOf) if (p) children.get(p).push(id)

  // Fleet prep: a recipient, or anyone under one, whose turn ended cleanly after the prep is paused,
  // not stalled, until a resume is marked, a new non-prep prompt arrives, or PREP_MS passes.
  if (prep && PAUSED[prep.kind] && now - prep.at < PREP_MS) {
    const marked = new Set(prep.ids)
    const inScope = (id) => { for (let p = id, n = 0; p && n < 50; p = parentOf.get(p), n++) if (marked.has(p)) return true; return false }
    for (const a of facts) {
      const b = base.get(a.id)
      const cleanStop = [REASONS.turn, REASONS.closed, REASONS.lead].includes(b.reason)
      const newPrompt = (a.promptAt || 0) > prep.at && !a.promptIsPrep
      if (cleanStop && (a.lastActivityAt || 0) >= prep.at && !newPrompt && inScope(a.id)) {
        base.set(a.id, { bucket: 'waiting', reason: PAUSED[prep.kind], reasonSource: 'lifecycle', since: b.since })
      }
    }
  }

  // Rule 5, children first. `visiting` breaks cycles an override could create.
  const final = new Map()
  const visiting = new Set()
  const resolve = (id) => {
    if (final.has(id)) return final.get(id)
    const b = base.get(id)
    if (visiting.has(id)) return b
    visiting.add(id)
    const busy = children.get(id).filter((c) => ['building', 'waiting'].includes(resolve(c).bucket)).length
    visiting.delete(id)
    const out = busy && b.reason === REASONS.turn ? { bucket: 'waiting', reason: waitingOnAgents(busy), reasonSource: 'children', since: b.since } : b
    final.set(id, out)
    return out
  }
  facts.forEach((a) => resolve(a.id))

  const hasKids = (id) => children.get(id).length > 0 || (byId.get(id).fanAgents || 0) > 0
  const detected = new Map()
  const roleOf = (id, depth = 0) => {
    if (detected.has(id)) return detected.get(id)
    const a = byId.get(id)
    const kids = children.get(id)
    const jobKids = kids.filter((c) => byId.get(c).kind === 'job')
    const p = parentOf.get(id)
    let role = 'solo'
    if (SUB_KINDS.has(a.kind)) role = 'sub'
    else if (jobKids.length) role = jobKids.some(hasKids) ? 'boss' : 'lead'
    else if (p && depth < 50) role = roleOf(p, depth + 1) === 'boss' ? 'lead' : 'sub'
    else if (kids.some((c) => byId.get(c).kind === 'teammate')) role = 'lead'
    detected.set(id, role)
    return role
  }

  return facts.map((a) => {
    const o = overrides[a.id] || {}
    const c = final.get(a.id)
    const detectedRole = roleOf(a.id)
    const role = ROLES.has(o.role) ? o.role : detectedRole
    return {
      id: a.id,
      harness: a.harness,
      kind: a.kind,
      jobId: a.jobId || null,
      // Background jobs only: 'bypassPermissions', another mode, or '' (default). permmode.mjs.
      ...(a.kind === 'job' && typeof a.permissionMode === 'string' && { permissionMode: a.permissionMode }),
      name: cap((typeof o.name === 'string' && o.name) || a.name || a.title || 'Untitled', NAME_MAX),
      // The same name, unless it would come from the first prompt ('' then). Safe to store.
      safeName: cap((typeof o.name === 'string' && o.name) || a.name || a.titleName || '', NAME_MAX),
      title: cap(a.title, TITLE_MAX),
      project: a.project || 'unknown',
      cwd: a.cwd || null,
      role,
      roleSource: ROLES.has(o.role) ? 'override' : detectedRole === 'solo' && !parentOf.get(a.id) ? 'default' : 'detected',
      parentId: parentOf.get(a.id),
      childIds: children.get(a.id),
      bucket: c.bucket,
      reason: c.reason,
      reasonSource: c.reasonSource,
      // Within stalled: a failure or crash is an error; anything else wants the user's attention.
      severity: c.bucket !== 'stalled' ? null : [REASONS.failed, REASONS.dead].includes(c.reason) || /^(Retrying — )?API error\b|^Usage limit\b|^Couldn't start\b/.test(c.reason) ? 'error' : 'attention',
      // Stalled on a dialog it can't get past without a click: 'permission' | 'question' | 'plan'.
      prompt: c.bucket === 'stalled' && c.prompt ? c.prompt : null,
      since: Math.round(c.since || 0),
      lastActivityAt: Math.round(a.lastActivityAt || 0),
      sizeBytes: a.sizeBytes || 0,
      // Claude Code's `/color` name ('purple'…), or null (none set, Codex, subagents).
      color: COLOR_NAMES.includes(o.color) ? o.color : a.color || null,
      live: Boolean(a.live),
      prs: a.prs || [],
      // A job that needs you: what it asks for and the scheduler's suggested reply (short strings).
      ask: c.bucket === 'stalled' && a.ask?.needs ? a.ask : null,
      resume: a.resume || null,
      // A background job reopened in a terminal: the session id open there, or null.
      reopened: typeof a.reopened === 'string' && a.reopened ? a.reopened : null,
      // A launch that failed before it ran: no session exists, so there is nothing to open.
      neverStarted: a.neverStarted === true,
      hidden: o.hidden === true,
      important: o.important === true,
      overrides: Object.keys(o).length ? o : null,
    }
  })
}
