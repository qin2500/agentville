/**
 * Claude Code adapter (CLI transcripts + background-job scheduler). Read-only, bounded reads.
 * Ported and simplified from Bot Crossing server/harnesses/claude-code.mjs (MIT, Jarren Rocks).
 * How hierarchy is detected, and how reliable each signal is: docs/ARCHITECTURE.md.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { jsonLines, listDirs, listFiles, projectOf, readHead, readJson, readLinesFrom, readTail } from './fsutil.mjs'
import { readWaitEvidence, currentWait, jobWaitEvidence } from './waiting.mjs'
import { REST_MS, REASONS } from './classify.mjs'
import { PREP_MARKER } from './fleet.mjs'

/** AGENTVILLE_CLAUDE_HOME (tests/fixtures) > CLAUDE_CONFIG_DIR (the CLI's own) > ~/.claude. */
export const home = () => process.env.AGENTVILLE_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const HEAD_BYTES = 192 * 1024
const TAIL_BYTES = 64 * 1024
const ACTIVE_MS = 30 * 60 * 1000
const ID = (sid) => `claude-code:${sid}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const clean = (s) => String(s || '').replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ').replace(/\s+/g, ' ').trim()
function firstText(content) {
  if (typeof content === 'string') return content
  for (const p of Array.isArray(content) ? content : []) {
    if (typeof p === 'string') return p
    if (p?.type === 'text' && typeof p.text === 'string') return p.text
  }
  return ''
}

/** Per-file caches keyed on mtime+size, so an unchanged transcript costs one stat per poll. */
const headCache = new Map()
const tailCache = new Map()
const edgeCache = new Map()

async function headMeta(file, sid, stamp) {
  const hit = headCache.get(file)
  if (hit?.stamp === stamp) return hit.meta
  const meta = { customTitle: '', aiTitle: '', firstPrompt: '', cwd: '', firstUuid: '', rootSessionId: '', valid: false, unreadable: false }
  for (const r of jsonLines(await readHead(file, HEAD_BYTES).catch(() => { meta.unreadable = true; return '' }))) {
    meta.customTitle ||= r.customTitle || ''
    meta.aiTitle ||= r.aiTitle || ''
    meta.cwd ||= r.cwd || ''
    // A real transcript names its session or folder; a binary or truncated file names neither.
    meta.valid ||= UUID.test(r.sessionId || '') || typeof r.cwd === 'string'
    meta.firstUuid ||= r.uuid || ''
    // Records carried over into a continuation transcript keep the original session's id here.
    if (!meta.rootSessionId && UUID.test(r.session_id || '') && r.session_id !== sid) meta.rootSessionId = r.session_id
    // A compacted copy (the recompact tool) names the session it was assembled from: same lineage.
    const src = r.recompactSource?.sessionId
    if (!meta.rootSessionId && typeof src === 'string' && UUID.test(src) && src !== sid) meta.rootSessionId = src
    if (!meta.firstPrompt && r.type === 'user' && r.message) {
      const t = clean(firstText(r.message.content))
      if (t && !t.startsWith('<')) meta.firstPrompt = t.slice(0, 2000) // capped for display in build()
    }
  }
  headCache.set(file, { stamp, meta })
  return meta
}

/**
 * Records that are not the main thread doing work: sidechains, meta records, and local slash
 * commands (`/status`, `/cost`…), which the CLI writes as user records around their output.
 */
const LOCAL_COMMAND = /^\s*<(?:local-command-|command-name>|command-message>|command-args>)/
// A subagent's own transcript is all sidechain records, so `isSidechain` only counts as noise in a main one.
const bookkeeping = (r, main = true) => (main && r.isSidechain === true) || r.isMeta === true ||
  (r.type === 'user' && LOCAL_COMMAND.test(firstText(r.message?.content)))
/** Only the status code of an API error is ever kept: "API error (503)". */
/** "API Error: Your computer went to sleep…", "Can't reach the API server — check your internet…": a
 * local interruption to resume with "continue", not an API fault. '' for anything else. */
export function cutOffReason(text) {
  const t = String(text || '')
  if (/\bwent to sleep\b/i.test(t)) return REASONS.slept
  if (/can.t reach the API server|check your internet|\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN)\b/i.test(t)) return REASONS.offline
  return ''
}
export const apiErrorReason = (text) => {
  const code = /^API Error:?\s*(\d{3})\b/.exec(String(text || ''))?.[1]
  return code ? `API error (${code})` : 'API error'
}

/** Whose turn it is, plus explicit wait evidence. Never returns transcript text. */
async function tailFacts(file, stamp, main = true) {
  const hit = tailCache.get(file)
  if (hit?.stamp === stamp) return hit.facts
  const records = jsonLines(await readTail(file, TAIL_BYTES).catch(() => ''))
  const facts = { evidence: readWaitEvidence(records, 'claude-code'), turnEnded: false, interrupted: false, apiError: false, apiErrorReason: '', cutOff: '', transcriptAt: 0, pendingAt: 0, promptAt: 0, promptIsPrep: false, cwd: '' }
  for (const r of records) {
    if (typeof r.cwd === 'string' && r.cwd) facts.cwd = r.cwd // the latest folder (a head of big records may name none)
    // A compacted copy (the recompact tool) names its source in its closing records.
    if (typeof r.recompactSource?.sessionId === 'string' && UUID.test(r.recompactSource.sessionId)) facts.copyOf = r.recompactSource.sessionId
    // The latest prompt (typed, or delivered by another session) and whether it was a fleet prep.
    // Only a marker test; the text itself is never kept.
    const text = r.type === 'user' ? firstText(r.message?.content) : ''
    if (text && !(Array.isArray(r.message?.content) && r.message.content.some((b) => b?.type === 'tool_result'))) {
      facts.promptAt = Date.parse(r.timestamp) || facts.promptAt
      facts.promptIsPrep = PREP_MARKER.test(text.slice(0, 400))
    }
    // Stop-hook summaries, turn_duration, attachments, sidechains and local slash commands are not
    // new work (waiting-status.md): they must not supersede a scheduler record.
    if ((['assistant', 'user'].includes(r.type) && !bookkeeping(r, main)) || (r.type === 'system' && r.subtype === 'api_error')) {
      facts.transcriptAt = Math.max(facts.transcriptAt, Date.parse(r.timestamp) || 0)
    }
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.type === 'system' && r.subtype === 'api_error') { facts.apiError = true; facts.apiErrorReason = apiErrorReason(''); break }
    if (bookkeeping(r, main)) continue
    // The CLI writes a failed request as a synthetic assistant message carrying the error text.
    if (r.type === 'assistant' && r.isApiErrorMessage === true) {
      facts.cutOff = cutOffReason(firstText(r.message?.content))
      if (facts.cutOff) break
      facts.apiError = true
      facts.apiErrorReason = apiErrorReason(firstText(r.message?.content))
      break
    }
    if (r.type === 'user') {
      facts.interrupted = /^\[Request interrupted/.test(firstText(r.message?.content))
      break
    }
    if (r.type !== 'assistant') continue
    const c = r.message?.content
    const calling = Array.isArray(c) && c.some((b) => b?.type === 'tool_use')
    facts.turnEnded = !calling && r.message?.stop_reason !== 'tool_use'
    // A tool call with no result yet, and when it was made.
    if (calling) facts.pendingAt = Date.parse(r.timestamp) || 0
    break
  }
  tailCache.set(file, { stamp, facts })
  return facts
}

/** Scheduler PR children plus the PRs the CLI linked in the transcript, each URL once. */
const withLinked = (prs, linked) => [...prs, ...(linked || []).filter((l) => !prs.some((p) => p.href === l.href))]

const LAUNCH = /\bclaude\b[\s\S]*\s--bg\b/
const HINT = /claude (?:attach|logs|stop) |backgrounded ·/
const LAUNCHED = /(?:claude (?:attach|logs|stop)|backgrounded ·)\s+([0-9a-f]{8})\b/g
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d{1,9})$/
/** A title or name record: a short single line, never prompt text. */
const titleText = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '')

/**
 * One pass over each transcript, from where the last pass stopped (append-only files):
 * - background jobs it launched: a Bash call mentioning `claude … --bg` whose result names a job
 *   (`claude attach <id>`), as `[short, launchedAt]`; the caller drops jobs created before the
 *   call, which is what a relaunch (`--bg --resume`) of an existing job looks like;
 * - the PRs the CLI linked to it (`pr-link` records: URL and number only);
 * - its names (`custom-title`, `ai-title`, `agent-name` records), latest of each, for search.
 * Only records that start with those types are parsed, so a tool output quoting one never counts.
 * ponytail: the first scan reads every transcript once (~1 GB on a heavy machine, ~2 s).
 */
async function spawnEdges(file, size) {
  let c = edgeCache.get(file)
  if (!c || size < c.offset) c = { offset: 0, pending: new Map(), jobs: [], prs: [], names: {} }
  if (size > c.offset) {
    c.offset = await readLinesFrom(file, c.offset, (line) => {
      if (line.startsWith('{"type":"pr-link"') || line.startsWith('{"type":"custom-title"') || line.startsWith('{"type":"ai-title"') || line.startsWith('{"type":"agent-name"')) {
        let r
        try { r = JSON.parse(line) } catch { return }
        if (r.type === 'pr-link') {
          const m = typeof r.prUrl === 'string' && PR_URL.exec(r.prUrl)
          if (m && !c.prs.some((p) => p.href === r.prUrl)) c.prs.push({ id: m[1], href: r.prUrl })
          return
        }
        const k = { 'custom-title': 'customTitle', 'ai-title': 'aiTitle', 'agent-name': 'agentName' }[r.type]
        const v = titleText(r[k])
        if (v) c.names[k] = v
        return
      }
      if (!line.includes('--bg') && !HINT.test(line)) return
      let r
      try { r = JSON.parse(line) } catch { return }
      for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
        if (b.type === 'tool_use' && b.name === 'Bash' && LAUNCH.test(String(b.input?.command || ''))) {
          c.pending.set(b.id, Date.parse(r.timestamp) || 0)
        } else if (b.type === 'tool_result' && c.pending.has(b.tool_use_id)) {
          const at = c.pending.get(b.tool_use_id)
          c.pending.delete(b.tool_use_id)
          const out = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content : []).map((x) => x?.text || '').join('\n')
          for (const m of out.matchAll(LAUNCHED)) c.jobs.push([m[1], at])
        }
      }
    }).catch(() => c.offset)
  }
  edgeCache.set(file, c)
  return c
}

/**
 * Live sessions -> `{ status, inbox }`: the CLI's own status ('' when it reports none) and its
 * cross-session inbox `{ sock, proto }` if it advertises one. Key files are never read.
 */
async function liveSessions() {
  const live = new Map()
  for (const file of await listFiles(path.join(home(), 'sessions'), (n) => n.endsWith('.json'))) {
    const s = await readJson(file)
    if (!s?.sessionId || !s.pid) continue
    const entry = {
      status: typeof s.status === 'string' ? s.status : '',
      waitingFor: typeof s.waitingFor === 'string' ? s.waitingFor : '',
      cwd: typeof s.cwd === 'string' ? s.cwd : '', // a forked or compacted transcript can lack one
      inbox: typeof s.messagingSocketPath === 'string' ? { sock: s.messagingSocketPath, proto: s.peerProtocol } : null,
    }
    // Signal 0 only probes. EPERM means the process exists but belongs to someone else.
    try { process.kill(s.pid, 0); live.set(s.sessionId, entry) } catch (e) { if (e.code === 'EPERM') live.set(s.sessionId, entry) }
  }
  return live
}

// Seen: busy, idle, shell. The rest are defined by the CLI and accepted ahead of being seen here.
const ASKING = new Set(['waiting', 'needs_user', 'blocked', 'needs_trust'])

/**
 * What a live session's registry status proves. `busy` is work in progress whatever the
 * transcript's age. A tool call left pending while the session says `idle` is the shape of a
 * permission prompt. Unknown statuses prove nothing.
 */
function registryVerdict(status, f, now, waitingFor = '') {
  if (status === 'busy') return { running: true }
  // `waitingFor: "permission prompt"` (seen) names the dialog the session is sitting in.
  if (ASKING.has(status)) return { needsUser: true, needsUserSource: 'scheduler', prompt: promptOf(waitingFor) }
  if (status === 'idle' && f?.pendingAt && !f.evidence?.needsUser && !currentWait(f.evidence, now)) {
    return { needsUser: true, needsUserSource: 'scheduler', needsUserReason: REASONS.approval, prompt: 'permission' }
  }
  return {}
}

/** A registry `waitingFor` ("permission prompt", "dialog open" seen) -> a PROMPTS key, or null. */
export function promptOf(waitingFor) {
  const w = typeof waitingFor === 'string' ? waitingFor : ''
  return /permission/i.test(w) ? 'permission' : /\bplan\b/i.test(w) ? 'plan' : /question|option|choice|select/i.test(w) ? 'question' : /dialog/i.test(w) ? 'dialog' : null
}
/** A job's `needs` while a tool waits on permission: "approve Bash: …", "approve mcp__x__y: …". */
export const jobPrompt = (j) => (typeof j.needs === 'string' && /^approve [A-Za-z][\w.-]*(?:\([^)]*\))?:/.test(j.needs) ? 'permission' : null)

/** "Usage limit · resets Oct 28 at 7am" from a scheduler detail, or ''. Only the reset time is kept. */
export function usageLimitReason(detail) {
  const d = typeof detail === 'string' ? detail : ''
  if (!/\b(?:hit your|reached your|out of)\b.*\blimit\b|\busage limit\b/i.test(d)) return ''
  const resets = /\bresets ([A-Za-z]{3,9} \d{1,2}(?: at \d{1,2}(?::\d{2})?\s?(?:am|pm))?|(?:at )?\d{1,2}(?::\d{2})?\s?(?:am|pm))/i.exec(d)?.[1]
  return resets ? `Usage limit · resets ${resets}` : 'Usage limit reached'
}

/** Still mid-turn (registry `busy`): Claude Code is retrying the failed request on its own. */
const retrying = (reg, reason) => (reg.running ? `Retrying — ${reason}` : reason)

/**
 * What a job was told to run on, for the Models view: `--model` and `--effort` from its respawn
 * flags, and the model aliases in its provider env. Only keys ending in `_MODEL` are looked at:
 * the same object can hold the gateway URL and token, and those values are never read.
 */
export function jobModelConfig(j) {
  const flags = Array.isArray(j?.respawnFlags) ? j.respawnFlags.filter((f) => typeof f === 'string') : []
  const flag = (name) => {
    const i = flags.indexOf(name)
    return (i >= 0 ? flags[i + 1] : flags.find((f) => f.startsWith(`${name}=`))?.slice(name.length + 1)) || null
  }
  return { model: modelValue(flag('--model')), effort: modelValue(flag('--effort')), env: modelEnv(j?.providerEnv) }
}
/** `{ KEY_MODEL: value }` for the `_MODEL` keys only. */
export function modelEnv(env) {
  const out = {}
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out
  for (const k of Object.keys(env)) {
    if (!k.endsWith('_MODEL')) continue
    const v = modelValue(env[k])
    if (v) out[k] = v
  }
  return out
}
/** A model name or alias ("opus[1m]", "cc/claude-opus-5-5", "high"), never free text. */
const modelValue = (v) => (typeof v === 'string' && /^[\w.:/@\[\]-]{1,80}$/.test(v) ? v : null)

async function readJobs() {
  const jobs = []
  for (const dir of await listDirs(path.join(home(), 'jobs'))) {
    const s = await readJson(path.join(dir, 'state.json'))
    if (s && UUID.test(s.sessionId || '')) jobs.push({ short: path.basename(dir), ...s })
  }
  return jobs
}

async function listTranscripts() {
  const out = new Map()
  for (const dir of await listDirs(path.join(home(), 'projects'))) {
    for (const file of await listFiles(dir, (n) => n.endsWith('.jsonl'))) {
      const sid = path.basename(file, '.jsonl')
      const st = await fsp.stat(file).catch(() => null)
      if (st && UUID.test(sid)) out.set(sid, { sid, file, dir, size: st.size, mtime: st.mtimeMs, stamp: `${st.mtimeMs}:${st.size}` })
    }
  }
  return out
}

/** Subagents and in-process teammates: `<project>/<sessionId>/subagents/agent-<id>.jsonl` (+ .meta.json). */
async function subagentsOf(t, parent, parentLive, now) {
  const parentId = parent.id
  const out = []
  const dir = path.join(t.dir, t.sid, 'subagents')
  for (const file of await listFiles(dir, (n) => n.endsWith('.jsonl'))) {
    const st = await fsp.stat(file).catch(() => null)
    // ponytail: older subagents would only ever be resting; skip them rather than list hundreds.
    if (!st || now - st.mtimeMs > REST_MS) continue
    const sub = path.basename(file, '.jsonl').replace(/^agent-/, '')
    const meta = (await readJson(file.replace(/\.jsonl$/, '.meta.json'))) || {}
    const f = await tailFacts(file, `${st.mtimeMs}:${st.size}`, false)
    const teammate = Boolean(meta.teamName)
    const fresh = now - st.mtimeMs < ACTIVE_MS
    out.push({
      // Server-private (not in the API): its own transcript, and the model it asked for ("sonnet").
      transcriptFile: file,
      modelConfig: { requested: modelValue(meta.model) },
      id: `${parentId}:sub:${sub}`,
      harness: 'claude-code',
      kind: teammate ? 'teammate' : 'subagent',
      name: meta.name || meta.agentType || 'Subagent',
      title: clean(meta.description),
      // A sidechain works in its parent's tree unless it was given a worktree of its own.
      project: meta.worktreePath ? projectOf(meta.worktreePath) : parent.project,
      cwd: meta.worktreePath || parent.cwd,
      parentId,
      // In-process: a teammate lives as long as its lead's process; a subagent while it is writing.
      live: parentLive && (teammate || fresh),
      lastActivityAt: st.mtimeMs,
      sizeBytes: st.size,
      promptAt: f.promptAt,
      promptIsPrep: f.promptIsPrep,
      // Its own evidence only — never the parent's wait or needs-user.
      needsUser: parentLive && f.evidence?.needsUser === true,
      needsUserSource: 'tool',
      prompt: f.evidence?.prompt || null,
      waitingOn: parentLive ? f.evidence : null,
      lifecycle: meta.finished || meta.stoppedByUser ? 'done'
        // An idle teammate lives in its lead's process; without it, it is closed, not waiting.
        : f.turnEnded ? (teammate ? (parentLive ? 'idle' : 'closed') : 'done')
        : parentLive && fresh ? 'running' : 'closed',
    })
  }
  return out
}

export async function scan(now = Date.now()) {
  const [jobs, live, transcripts] = await Promise.all([readJobs(), liveSessions(), listTranscripts()])
  const jobBySession = new Map()
  for (const j of jobs) {
    jobBySession.set(j.sessionId, j)
    if (UUID.test(j.resumeSessionId || '')) jobBySession.set(j.resumeSessionId, j)
  }
  // Continuations of one job share their first record; trust that only when exactly one job does.
  const metas = new Map()
  const firstUuidJobs = new Map()
  for (const t of transcripts.values()) {
    const m = await headMeta(t.file, t.sid, t.stamp)
    metas.set(t.sid, m)
    const j = jobBySession.get(t.sid)
    if (j && m.firstUuid) firstUuidJobs.set(m.firstUuid, (firstUuidJobs.get(m.firstUuid) || new Set()).add(j))
  }
  const ownerJob = (sid) => {
    const m = metas.get(sid)
    const byUuid = m?.firstUuid && firstUuidJobs.get(m.firstUuid)
    return jobBySession.get(sid) || jobBySession.get(m?.rootSessionId) || (byUuid?.size === 1 ? [...byUuid][0] : null)
  }
  // Sessions with no job: continuations, forks and recompacted copies carry the original's
  // `session_id` or its first record. The newest is the agent; older copies that are not live
  // are superseded and folded into it.
  const lineage = (sid, depth = 0) => {
    const m = metas.get(sid)
    return m?.rootSessionId && metas.has(m.rootSessionId) && depth < 20 ? lineage(m.rootSessionId, depth + 1) : m?.firstUuid || sid
  }
  const newest = new Map()
  for (const t of transcripts.values()) {
    if (ownerJob(t.sid) || !metas.get(t.sid)?.valid) continue
    const k = lineage(t.sid)
    if (!newest.has(k) || t.mtime > newest.get(k).mtime) newest.set(k, t)
  }
  const supersededBy = (sid) => {
    const n = newest.get(lineage(sid))
    return n && n.sid !== sid && !live.has(sid) ? n.sid : null
  }
  const jobShort = new Map(jobs.map((j) => [j.short, j]))
  const agentIdOf = (sid) => { const j = ownerJob(sid); return ID(j ? j.sessionId : supersededBy(sid) || sid) }

  // Spawn edges -> parent per launched job. A job created before the call was relaunched, not spawned.
  const parentOfJob = new Map()
  for (const t of transcripts.values()) {
    for (const [short, at] of (await spawnEdges(t.file, t.size)).jobs) {
      const child = jobShort.get(short)
      const parent = agentIdOf(t.sid)
      const created = Date.parse(child?.createdAt) || 0
      if (child && parent !== ID(child.sessionId) && created >= at - 60_000 && !parentOfJob.has(child.sessionId)) parentOfJob.set(child.sessionId, parent)
    }
  }

  const facts = []
  const fromTranscript = async (t) => ({ meta: metas.get(t.sid) || {}, f: await tailFacts(t.file, t.stamp) })

  for (const j of jobs) {
    const current = transcripts.get(j.resumeSessionId) || transcripts.get(j.sessionId)
    const { meta, f } = current ? await fromTranscript(current) : { meta: {}, f: null }
    const liveEntry = live.get(j.resumeSessionId) ?? live.get(j.sessionId)
    const status = liveEntry?.status
    const isLive = liveEntry !== undefined
    const reg = isLive ? registryVerdict(status, f, now, liveEntry.waitingFor) : {}
    const updatedAt = Date.parse(j.updatedAt) || 0
    const lastActivityAt = Math.max(updatedAt, current?.mtime || 0)
    // A newer real transcript operation supersedes the scheduler snapshot; bookkeeping does not.
    const jobCurrent = !f || updatedAt >= f.transcriptAt
    const sched = jobCurrent ? jobWaitEvidence(j, now, { live: isLive }) : null
    const toolNeedsUser = isLive && f?.evidence?.needsUser === true
    // A new prompt starts a turn without clearing `state: blocked` from the last one: the scheduler
    // saying active, or the process busy, means the question was answered and it is working again.
    const parked = (j.state === 'blocked' || j.tempo === 'blocked') && j.tempo !== 'active' && !reg.running
    let lifecycle
    if (['done', 'stopped', 'failed'].includes(j.state)) lifecycle = j.state
    else if (parked && (isLive || jobCurrent)) lifecycle = 'idle'
    // Not live: a cleanly finished turn is nobody's to answer any more; mid-turn means it stopped.
    else if (!isLive) lifecycle = j.tempo === 'active' && now - lastActivityAt < ACTIVE_MS ? 'running'
      : (jobCurrent ? j.tempo === 'idle' : f?.turnEnded) ? 'closed' : 'dead'
    // Running needs liveness evidence: the scheduler saying active, or a live process mid-turn.
    else if (j.tempo === 'active' || (isLive && !jobCurrent && !f?.turnEnded)) lifecycle = 'running'
    else lifecycle = 'idle'
    if (reg.running && lifecycle !== 'failed') lifecycle = 'running'
    // A stopped job resumed in a terminal is a live session waiting for its next instruction. A job
    // that reports itself done has nothing left to do, even with its process still open: it rests
    // (a new prompt makes the process busy, and busy is running).
    else if (isLive && lifecycle === 'stopped') lifecycle = 'idle'
    // An API failure the scheduler parks as `blocked` is an error, not a question for the user.
    // A newer non-blocked scheduler state or newer real main-thread work clears it.
    const stuckState = ['blocked', 'failed'].includes(j.state) || j.tempo === 'blocked'
    const schedCut = jobCurrent && stuckState ? cutOffReason(j.detail) : ''
    const schedApiError = jobCurrent && stuckState && !schedCut && /^API Error\b/.test(j.detail || '')
    // "You've hit your weekly limit · resets Oct 28 at 7am": the account ran out, not a question.
    const limit = jobCurrent && stuckState ? usageLimitReason(j.detail) : ''
    const transcriptApiError = Boolean(f?.apiError) && (!jobCurrent || stuckState)
    const apiError = (schedApiError || transcriptApiError || Boolean(limit)) && !['done', 'stopped'].includes(j.state)
    if (apiError) lifecycle = 'failed'
    // Interrupted by sleep or a dropped connection, and not already retrying: it needs a "continue".
    const cutOff = !apiError && !reg.running && !['done', 'stopped'].includes(j.state) ? schedCut || ((!jobCurrent || stuckState) && f?.cutOff) || '' : ''
    if (cutOff && lifecycle === 'running') lifecycle = 'idle'
    // Failed before it ever ran (no transcript: e.g. "source session … not found" on a bad resume).
    // Nothing to see in a terminal, so say what happened; a newer launch of the same name replaces it.
    const neverRan = j.state === 'failed' && !current
    // A newer launch with the same name replaces an older copy that is no longer running (a lead
    // relaunched after a restart, a duplicate coordinator): the old copy's questions are moot.
    const newer = jobs.some((o) => o !== j && o.name && o.name === j.name && (Date.parse(o.createdAt) || 0) > (Date.parse(j.createdAt) || 0))
    if (newer && neverRan) lifecycle = 'replaced'
    else if (newer && !isLive && !['done', 'stopped'].includes(j.state)) lifecycle = 'superseded'
    // Blocked, unless the job's own status says it is waiting on CI or another agent.
    const schedNeedsUser = !apiError && jobCurrent && parked && !sched?.kind
    // A respawn (e.g. an account switch) mid-turn leaves the job idle on "send a prompt to start",
    // with the interrupted tool call still pending in its transcript: that is not a dialog.
    const restartedIdle = schedNeedsUser && /^send a prompt to start\b/i.test(j.needs || '')
    const id = ID(j.sessionId)
    const agent = {
      id,
      harness: 'claude-code',
      kind: 'job',
      jobId: j.short,
      name: j.name || '',
      title: meta.customTitle || meta.aiTitle || meta.firstPrompt || '',
      project: projectOf(j.originCwd || j.cwd || meta.cwd),
      cwd: j.worktreePath || j.cwd || meta.cwd || null,
      parentId: parentOfJob.get(j.sessionId) || null,
      live: isLive,
      lastActivityAt,
      sizeBytes: current?.size || 0,
      lifecycle,
      // Scheduler `blocked` is the job's current state, not a 30-minute report, so it is not TTL'd.
      needsUser: Boolean(cutOff) || schedNeedsUser || toolNeedsUser || reg.needsUser === true,
      needsUserSource: toolNeedsUser ? 'tool' : 'scheduler',
      needsUserReason: cutOff || (restartedIdle ? REASONS.restarted : schedNeedsUser || toolNeedsUser ? undefined : reg.needsUserReason),
      prompt: (cutOff || restartedIdle) && !toolNeedsUser ? null : (toolNeedsUser && f.evidence.prompt) || reg.prompt || (schedNeedsUser && jobPrompt(j)) || null,
      errorReason: apiError ? (limit || retrying(reg, schedApiError ? apiErrorReason(j.detail) : f.apiErrorReason))
        : neverRan ? `Couldn't start: ${String(j.detail || 'the job failed to launch').replace(/\b([0-9a-f]{8})-[0-9a-f-]{27}\b/g, '$1…').slice(0, 120)}` : undefined,
      waitingOn: (isLive && currentWait(f?.evidence, now)) || currentWait(sched, now),
      prs: withLinked((Array.isArray(j.children) ? j.children : [])
        .filter((c) => c?.kind === 'pr' && typeof c.href === 'string' && /^https:\/\/github\.com\//.test(c.href))
        .map((c) => ({ id: String(c.id ?? ''), href: c.href })), current && edgeCache.get(current.file)?.prs),
      // What it is asking for, and the scheduler's suggested reply: short machine-written strings.
      ask: typeof j.needs === 'string' && j.needs.trim() ? {
        needs: j.needs.replace(/\s+/g, ' ').trim().slice(0, 400),
        suggestedReply: typeof j.suggestedReply === 'string' ? j.suggestedReply.trim().slice(0, 4000) : '',
      } : null,
      resume: neverRan ? null : `claude attach ${j.short}`,
      // Server-private (not in the API): the conversation a fork would copy, and its folder.
      fork: current ? { sid: current.sid, cwd: meta.cwd || f?.cwd || j.cwd || null } : null,
      neverStarted: neverRan,
      // Server-private (not in the API): where a fleet message would go and where its receipt shows.
      inbox: liveEntry?.inbox || null,
      transcriptFile: current?.file || null,
      modelConfig: jobModelConfig(j),
      promptAt: f?.promptAt || 0,
      promptIsPrep: Boolean(f?.promptIsPrep),
      fanAgents: (Array.isArray(j.fan) ? j.fan : []).filter((x) => x?.kind === 'agent').length,
    }
    facts.push(agent)
    if (current) facts.push(...(await subagentsOf(current, agent, isLive, now)))
  }

  for (const t of transcripts.values()) {
    if (ownerJob(t.sid)) continue // a job's transcript, or an older continuation of one
    const { meta, f } = await fromTranscript(t)
    if (!meta.valid || supersededBy(t.sid)) continue
    const liveEntry = live.get(t.sid)
    const status = liveEntry?.status
    const isLive = liveEntry !== undefined
    const reg = isLive ? registryVerdict(status, f, now, liveEntry.waitingFor) : {}
    const fresh = now - t.mtime < ACTIVE_MS
    let lifecycle
    const cutOff = !reg.running ? f.cutOff : ''
    if (f.apiError) lifecycle = 'failed'
    else if (reg.running) lifecycle = 'running'
    else if (cutOff) lifecycle = 'idle'
    else if (f.turnEnded || f.interrupted) lifecycle = isLive ? 'idle' : 'closed'
    // A recent mtime is not liveness: without a live process a mid-turn transcript stopped.
    // A live process never "stopped unexpectedly"; quiet for 30 min mid-turn, it made no progress.
    // Never a real turn (e.g. an empty copy a compaction tool left behind): nothing stopped.
    else if (!isLive && !f.transcriptAt) lifecycle = 'closed'
    // A compacted copy that never took over: its source is running again, or was written to since.
    else if (!isLive && f.copyOf && f.copyOf !== t.sid && (live.has(f.copyOf) || (transcripts.get(f.copyOf)?.mtime || 0) > t.mtime)) lifecycle = 'superseded'
    else lifecycle = isLive ? (fresh ? 'running' : 'stuck') : 'dead'
    const toolNeedsUser = isLive && f.evidence?.needsUser === true
    const id = ID(t.sid)
    const agent = {
      id,
      harness: 'claude-code',
      kind: 'session',
      name: meta.customTitle || meta.aiTitle || '',
      title: meta.firstPrompt || '',
      project: projectOf(meta.cwd || f.cwd || liveEntry?.cwd),
      cwd: meta.cwd || f.cwd || liveEntry?.cwd || null,
      parentId: null,
      live: isLive,
      lastActivityAt: t.mtime,
      sizeBytes: t.size,
      lifecycle,
      needsUser: Boolean(cutOff) || toolNeedsUser || reg.needsUser === true,
      errorReason: f.apiError ? retrying(reg, f.apiErrorReason) : undefined,
      needsUserSource: toolNeedsUser ? 'tool' : 'scheduler',
      needsUserReason: cutOff || (toolNeedsUser ? undefined : reg.needsUserReason),
      prompt: cutOff && !toolNeedsUser ? null : (toolNeedsUser && f.evidence.prompt) || reg.prompt || null,
      waitingOn: isLive ? currentWait(f.evidence, now) : null,
      prs: withLinked([], edgeCache.get(t.file)?.prs),
      resume: `claude --resume ${t.sid}`,
      fork: { sid: t.sid, cwd: meta.cwd || f.cwd || liveEntry?.cwd || null },
      inbox: liveEntry?.inbox || null,
      transcriptFile: t.file,
      promptAt: f.promptAt,
      promptIsPrep: f.promptIsPrep,
    }
    facts.push(agent)
    if (now - t.mtime < REST_MS) facts.push(...(await subagentsOf(t, agent, isLive, now)))
  }
  // Counted, not listed: which files is nobody's business but the user's terminal.
  facts.unreadable = [...transcripts.values()].filter((t) => metas.get(t.sid)?.unreadable).length
  // Conversation search (names and titles only, never prompt text): every transcript, resting or
  // superseded ones included, pointing at the agent it is part of.
  facts.titles = [...transcripts.values()].map((t) => {
    const m = metas.get(t.sid) || {}
    const n = edgeCache.get(t.file)?.names || {}
    const j = ownerJob(t.sid)
    return {
      id: agentIdOf(t.sid), sid: t.sid, at: t.mtime, project: projectOf(m.cwd || j?.originCwd || j?.cwd),
      names: [...new Set([j?.name, n.agentName, n.customTitle, m.customTitle, n.aiTitle, m.aiTitle].map(titleText).filter(Boolean))],
    }
  }).filter((x) => x.names.length)
  return facts
}
