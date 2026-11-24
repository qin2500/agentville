// Gemini provider discovery, Antigravity CLI (`agy`). docs/antigravity-cli-notes.md §2.
// Primary source: the runner's state files and out.log (stream-json) under <data>/gemini-runs/<runId>/, for runs
// Agentville started. Liveness always comes from the runner, never from a transcript.
// Secondary, display only: sessions the user ran by hand, from ~/.gemini/antigravity-cli/cache/last_conversations.json
// (workspace path -> latest conversation id) and brain/<id>/.system_generated/logs/transcript*.jsonl. That layout
// is undocumented; any failure there is dropped quietly.
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { listDirs, readJson, projectOf } from '../fsutil.mjs'
import { summarize } from './transcript.mjs'

const ACTIVE_MS = 90 * 1000      // a hand-run transcript written this recently counts as running
const IDLE_MS = 6 * 3600 * 1000  // like Codex: a quiet finished session rests after 6 h
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

let config = { dataDir: null }
export function configure(opts = {}) { config = { ...config, ...opts } }

/** The home whose `.gemini/antigravity-cli` is read (AGENTVILLE_AGY_HOME for tests). */
export function defaultHome(env = process.env) { return env.AGENTVILLE_AGY_HOME || os.homedir() }
export const home = defaultHome
export const agyDir = (h = defaultHome()) => path.join(h, '.gemini', 'antigravity-cli')

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** Runner state files. Format: { runId, pid, cwd, conversationId?, sessionId?, name, title?, startedAt, state, exitCode?, parentAgentId?, handoffId? }. */
export async function readRuns(dataDir = config.dataDir) {
  if (!dataDir) return []
  const out = []
  for (const dir of await listDirs(path.join(dataDir, 'gemini-runs'))) {
    const s = await readJson(path.join(dir, 'state.json'))
    if (s && typeof s === 'object') out.push({ ...s, runId: s.runId || path.basename(dir) })
  }
  return out
}

function runLifecycle(run, runAlive, now) {
  if (runAlive) return 'running'
  if (run.state === 'error' || run.state === 'limit' || run.state === 'failed') return 'failed'
  if (run.state === 'stopped') return 'stopped'
  const last = Math.max(run.endedAt || 0, run.turnStartedAt || 0, run.startedAt || 0)
  return now - last < IDLE_MS ? 'idle' : 'closed'
}

/** `{ cwd -> conversationId }` from last_conversations.json (values may be strings or objects). */
async function lastConversations(dir) {
  const j = await readJson(path.join(dir, 'cache', 'last_conversations.json'))
  const out = []
  if (!j || typeof j !== 'object') return out
  for (const [cwd, v] of Object.entries(j)) {
    const id = typeof v === 'string' ? v : v && typeof v === 'object' ? v.conversation_id || v.conversationId || v.id : null
    if (typeof id === 'string' && /^[\w.-]{1,200}$/.test(id) && path.isAbsolute(cwd)) out.push({ cwd, id })
  }
  return out
}

async function brainTranscript(dir, id) {
  const logs = path.join(dir, 'brain', id, '.system_generated', 'logs')
  for (const n of ['transcript.jsonl', 'transcript_full.jsonl']) {
    const f = path.join(logs, n)
    try { if ((await fsp.stat(f)).isFile()) return f } catch { /* next */ }
  }
  return null
}

export async function scan(now = Date.now(), opts = {}) {
  const dataDir = opts.dataDir || config.dataDir
  const runs = await (opts.runs ? opts.runs() : readRuns(dataDir))
  const out = []
  const titles = {}
  let unreadable = 0
  const owned = new Set()

  for (const run of runs) {
    const conv = run.conversationId || run.sessionId || null
    if (conv) owned.add(conv)
    const runAlive = run.state === 'running' && alive(run.pid)
    const outLog = dataDir ? path.join(dataDir, 'gemini-runs', String(run.runId).replace(/[^\w.-]/g, '_'), 'out.log') : null
    const title = clean(run.title)
    if (title) titles[`gemini:${run.runId}`] = title.slice(0, 120)
    out.push(fact({ id: `gemini:${run.runId}`, sessionId: conv, run, runAlive, lifecycle: runLifecycle(run, runAlive, now),
      cwd: run.cwd || '', title, file: outLog, lastActivityAt: Math.max(run.endedAt || 0, run.turnStartedAt || 0, run.startedAt || 0) }))
  }

  // Hand-run agy sessions (display only). Any failure: none.
  if (opts.hand !== false) {
    try {
      const dir = agyDir(opts.home || defaultHome())
      for (const { cwd, id } of await lastConversations(dir)) {
        if (owned.has(id)) continue
        const file = await brainTranscript(dir, id)
        if (!file) continue
        let sum
        try { sum = await summarize(file) } catch { unreadable++; continue }
        const fresh = now - sum.mtime < ACTIVE_MS
        const title = clean(sum.prompt)
        if (title) titles[`gemini:${id}`] = title.slice(0, 120)
        out.push(fact({ id: `gemini:${id}`, sessionId: id, run: null, runAlive: false,
          lifecycle: fresh ? 'running' : now - sum.mtime < IDLE_MS ? 'idle' : 'closed', cwd, title, file, lastActivityAt: sum.mtime, size: sum.size }))
      }
    } catch { /* undocumented layout: drop quietly */ }
  }

  out.unreadable = unreadable
  out.titles = titles
  return out
}

function fact({ id, sessionId, run, runAlive, lifecycle, cwd, title, file, lastActivityAt, size = 0 }) {
  return {
    id,
    harness: 'gemini-cli',
    provider: 'gemini',
    kind: 'session',
    name: clean(run?.name),
    title,
    project: projectOf(cwd),
    cwd: cwd || null,
    parentId: run?.parentAgentId || null,
    live: runAlive,
    lastActivityAt: lastActivityAt || 0,
    sizeBytes: size,
    lifecycle,
    needsUser: false, // headless agy soft-denies approvals instead of waiting
    needsUserSource: 'tool',
    prompt: null,
    waitingOn: null,
    prs: [],
    resume: sessionId ? `agy --conversation ${sessionId}` : null,
    // Server-private
    transcriptFile: file,
    runId: run?.runId || null,
    sessionId: sessionId || null,
    handoffId: run?.handoffId || null,
    ...(lifecycle === 'failed' && run && { errorReason: run.error ? `Hit an error: ${String(run.error).slice(0, 120)}` : `Exited with code ${run.exitCode}` }),
  }
}

export default { scan, configure, home, readRuns }
