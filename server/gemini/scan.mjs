// Gemini CLI session discovery (docs/gemini-cli-notes.md §2). Sessions live in
// <home>/.gemini/tmp/<slug>/chats/session-*.jsonl, one <home> per managed account plus the default one.
// Liveness comes from the runner's state files (<data>/gemini-runs/<runId>/state.json), never from the transcript.
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { listDirs, listFiles, readJson, projectOf } from '../fsutil.mjs'
import { summarize } from './transcript.mjs'

const ACTIVE_MS = 90 * 1000      // an open turn this fresh counts as running when no runner vouches for it
const IDLE_MS = 6 * 3600 * 1000  // like Codex: a quiet finished session rests after 6 h
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

let config = { dataDir: null, homes: null }
/** `homes`: array of GEMINI_CLI_HOME dirs, or a function returning one (the managed account homes). */
export function configure(opts = {}) { config = { ...config, ...opts } }

export function defaultHome(env = process.env) { return env.GEMINI_CLI_HOME || os.homedir() }
export const home = defaultHome

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** Runner state files. Format: { runId, pid, cwd, sessionId?, name, startedAt, state, exitCode?, parentAgentId?, handoffId?, home? }. */
export async function readRuns(dataDir = config.dataDir) {
  if (!dataDir) return []
  const out = []
  for (const dir of await listDirs(path.join(dataDir, 'gemini-runs'))) {
    const s = await readJson(path.join(dir, 'state.json'))
    if (s && typeof s === 'object') out.push({ ...s, runId: s.runId || path.basename(dir) })
  }
  return out
}

async function accountHomes(opts, runs) {
  const given = typeof opts.homes === 'function' ? await opts.homes() : opts.homes
  const set = new Set([defaultHome(), ...(Array.isArray(given) ? given : [])])
  for (const r of runs) { const h = r.home || r.env?.GEMINI_CLI_HOME; if (h) set.add(h) }
  return [...set].filter(Boolean).map((h) => path.resolve(h))
}

async function slugCwds(geminiDir) {
  const map = new Map() // slug -> cwd
  const reg = await readJson(path.join(geminiDir, 'projects.json'))
  for (const [cwd, slug] of Object.entries(reg?.projects || {})) if (typeof slug === 'string') map.set(slug, cwd)
  return map
}

async function projectRoot(tmpDir, slug, registry) {
  try {
    const t = (await fsp.readFile(path.join(tmpDir, slug, '.project_root'), 'utf8')).trim()
    if (t) return t
  } catch { /* fall through to the registry */ }
  return registry.get(slug) || ''
}

function lifecycleOf({ run, runAlive, sum, now }) {
  const last = sum?.mtime || run?.startedAt || 0
  if (run) {
    if (runAlive) return 'running'
    if (run.state === 'failed' || (Number.isInteger(run.exitCode) && run.exitCode !== 0 && run.state !== 'stopped')) return 'failed'
    if (run.state === 'stopped') return 'stopped'
  }
  if (sum?.turnOpen && now - last < ACTIVE_MS) return 'running'
  return now - last < IDLE_MS ? 'idle' : 'closed'
}

export async function scan(now = Date.now(), opts = {}) {
  const runs = await (opts.runs ? opts.runs() : readRuns(opts.dataDir))
  const bySession = new Map(runs.filter((r) => r.sessionId).map((r) => [r.sessionId, r]))
  const seen = new Set()
  const out = []
  let unreadable = 0
  const titles = {}

  for (const h of await accountHomes({ ...config, ...opts }, runs)) {
    const geminiDir = path.join(h, '.gemini')
    const tmpDir = path.join(geminiDir, 'tmp')
    const registry = await slugCwds(geminiDir)
    for (const slugDir of await listDirs(tmpDir)) {
      const slug = path.basename(slugDir)
      const files = await listFiles(path.join(slugDir, 'chats'), (n) => n.startsWith('session-') && n.endsWith('.jsonl'))
      if (!files.length) continue
      const root = await projectRoot(tmpDir, slug, registry)
      for (const file of files) {
        let sum
        try { sum = await summarize(file) } catch { unreadable++; continue }
        const sessionId = sum.header.sessionId
        if (!sessionId || sum.header.kind === 'subagent') continue
        const run = bySession.get(sessionId)
        if (run) seen.add(run.runId)
        const cwd = root || run?.cwd || ''
        const runAlive = !!run && run.state === 'running' && alive(run.pid)
        const lifecycle = lifecycleOf({ run, runAlive, sum, now })
        const prompt = clean(sum.prompt)
        if (prompt) titles[`gemini:${sessionId}`] = prompt.slice(0, 120)
        out.push(fact({ id: `gemini:${sessionId}`, sessionId, run, runAlive, lifecycle, cwd, prompt, sum, file, home: h, now }))
      }
    }
  }

  // Runs Agentville started that have no session file (yet): still an agent.
  for (const run of runs) {
    if (seen.has(run.runId)) continue
    const runAlive = run.state === 'running' && alive(run.pid)
    const lifecycle = lifecycleOf({ run, runAlive, sum: null, now })
    out.push(fact({ id: `gemini:${run.runId}`, sessionId: run.sessionId || null, run, runAlive, lifecycle,
      cwd: run.cwd || '', prompt: '', sum: null, file: null, home: run.home || defaultHome(), now }))
  }
  out.unreadable = unreadable
  out.titles = titles
  return out
}

function fact({ id, sessionId, run, runAlive, lifecycle, cwd, prompt, sum, file, home: h }) {
  const lastActivityAt = Math.max(sum?.mtime || 0, run?.startedAt || 0)
  return {
    id,
    harness: 'gemini-cli',
    provider: 'gemini',
    kind: 'session',
    name: clean(run?.name),
    title: prompt,
    project: projectOf(cwd),
    cwd: cwd || null,
    parentId: run?.parentAgentId || null,
    live: runAlive,
    lastActivityAt,
    sizeBytes: sum?.size || 0,
    lifecycle,
    needsUser: false, // Gemini never records an approval wait in the file (notes §2.5)
    needsUserSource: 'tool',
    prompt: null,
    waitingOn: null,
    prs: [],
    resume: sessionId ? `gemini --resume ${sessionId}` : null,
    // Server-private
    transcriptFile: file,
    runId: run?.runId || null,
    handoffId: run?.handoffId || null,
    accountHome: h,
    ...(lifecycle === 'failed' && { errorReason: `Exited with code ${run?.exitCode}` }),
  }
}

export default { scan, configure, home, readRuns }
