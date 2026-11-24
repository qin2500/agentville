/**
 * Gemini CLI process supervisor. Gemini has no `--bg` daemon, so Agentville owns the process:
 * one detached `gemini -p` per turn, stdout (stream-json) to out.log, stderr to err.log, and a
 * state.json per run under `<data>/gemini-runs/<runId>/`. Follow-up turns use `-r <sessionId> -p`.
 * Facts: docs/gemini-cli-notes.md (0.71.1). All I/O is injectable so tests use a fake bin.
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execTarget } from '../platform.mjs'

export const APPROVAL_MODES = ['default', 'auto_edit', 'yolo']
export const MAX_LOG_BYTES = 4 * 1024 * 1024
export const QUOTA_EXIT_CODE = 173
const QUOTA_RE = /exhausted your|RESOURCE_EXHAUSTED|TerminalQuotaError|RetryableQuotaError|quota|\b429\b/i

/** True when a result.error message (or stderr text) is a quota / rate-limit failure. */
export const isQuotaText = (text) => QUOTA_RE.test(String(text ?? ''))

export const MODEL_RE = /^[A-Za-z0-9][\w.\-:]*$/
const SESSION_RE = /^[A-Za-z0-9][\w.\-]*$/

/**
 * argv for one turn. `resume` is a session id for a follow-up turn; otherwise `sessionId` is assigned.
 * Every value-bearing flag uses the `--flag=value` form so a value can never become another flag.
 * Throws on an invalid model/session id, and on mode `yolo` unless `allowYolo` is true.
 */
export function startArgs({ prompt, model, mode, sessionId, resume, allowYolo = false, skipTrust = true } = {}) {
  if (model && !MODEL_RE.test(String(model))) throw new Error('invalid model name')
  for (const id of [resume, sessionId]) if (id && !SESSION_RE.test(String(id))) throw new Error('invalid session id')
  if (mode === 'yolo' && allowYolo !== true) throw new Error('yolo mode requires explicit allowYolo')
  const args = [`--prompt=${String(prompt ?? '')}`, '-o', 'stream-json']
  if (skipTrust === true) args.push('--skip-trust')
  args.push(`--approval-mode=${APPROVAL_MODES.includes(mode) ? mode : 'default'}`)
  if (model) args.push(`--model=${model}`)
  if (resume) args.push(`--resume=${resume}`)
  else if (sessionId) args.push(`--session-id=${sessionId}`)
  return args
}

const ENV_ALLOW = /^(PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|SYSTEMROOT|windir|ComSpec|PATHEXT|LANG|LC_[A-Z_]+|TERM|TMP|TEMP|TMPDIR|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy|AGENTVILLE_[A-Z_]+)$/
const ENV_DENY = /^(GEMINI_API_KEY|GOOGLE_.*|GEMINI_CLI_HOME)$/

/**
 * Env for the child, built from an allowlist (no ambient secrets). GEMINI_CLI_NO_RELAUNCH keeps it to one
 * process so the pid is the real one. `accountEnv` (from envFor()) is merged whole, after everything else.
 */
export function runEnv({ base = process.env, home, agentId, accountEnv, port, handoffId } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(base)) if (ENV_ALLOW.test(k) && !ENV_DENY.test(k) && v != null) env[k] = String(v)
  env.GEMINI_CLI_NO_RELAUNCH = 'true'
  if (home) env.GEMINI_CLI_HOME = home
  if (agentId) env.AGENTVILLE_AGENT_ID = agentId
  if (port) env.AGENTVILLE_PORT = String(port)
  if (handoffId) env.AGENTVILLE_HANDOFF_ID = String(handoffId)
  if (accountEnv && typeof accountEnv === 'object') for (const [k, v] of Object.entries(accountEnv)) if (v != null) env[k] = String(v)
  return env
}

const TOKEN_RES = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\b(?:AIza|ya29\.|sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA|GOCSPX-)[A-Za-z0-9._-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /((?:api[_-]?key|token|secret|password|authorization|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
]
/** Cap to `max` chars and redact anything that looks like a token. */
export function scrub(text, max = 200) {
  let t = String(text ?? '')
  TOKEN_RES.forEach((re, i) => { t = t.replace(re, i === 3 ? '$1[redacted]' : '[redacted]') })
  return t.slice(0, max)
}

/** Fold stream-json lines into a summary. Unparseable lines are ignored. */
export function parseEvents(text) {
  const out = { sessionId: null, model: null, result: null, error: null, events: 0, lastAssistant: '' }
  for (const line of String(text).split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let e
    try { e = JSON.parse(s) } catch { continue }
    if (!e || typeof e !== 'object') continue
    out.events++
    if (e.type === 'init') { out.sessionId = e.session_id || out.sessionId; out.model = e.model || out.model }
    else if (e.type === 'message' && e.role === 'assistant' && typeof e.content === 'string') out.lastAssistant = (e.delta ? out.lastAssistant : '') + e.content
    else if (e.type === 'error' && e.severity === 'error') out.error = e.message || out.error
    else if (e.type === 'result') { out.result = e.status || 'success'; if (e.error) out.error = e.error.message || String(e.error.type || 'error'); out.stats = e.stats }
  }
  return out
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createRunner({
  dataDir,
  bin = 'gemini',
  spawn = nodeSpawn,
  platform = process.platform,
  env = process.env,
  now = Date.now,
  killGraceMs = 10_000,
  isAlive = alive,
  taskkill = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }),
  kill = (pid, sig) => process.kill(pid, sig),
  port = null,
} = {}) {
  const root = path.join(dataDir, 'gemini-runs')
  const dirOf = (id) => path.join(root, String(id).replace(/[^\w.-]/g, '_'))
  const statePath = (id) => path.join(dirOf(id), 'state.json')

  function read(id) { try { return JSON.parse(fs.readFileSync(statePath(id), 'utf8')) } catch { return null } }
  const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700) } catch { /* best effort */ } }
  function write(st) {
    ensureDir(root); ensureDir(dirOf(st.runId))
    const p = statePath(st.runId)
    fs.writeFileSync(p + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 })
    fs.renameSync(p + '.tmp', p)
  }
  const update = (id, patch) => { const st = read(id); if (!st) return null; const n = { ...st, ...patch }; write(n); return n }

  function rotate(file) {
    try { if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1') } catch { /* none yet */ }
  }

  /** Spawn one turn for a run. */
  function launchTurn(st, { prompt, model, mode, resume, allowYolo, accountEnv, skipTrust }) {
    const dir = dirOf(st.runId)
    const argv = startArgs({ prompt, model, mode, sessionId: st.sessionId, resume, allowYolo, skipTrust }) // validates before any side effect
    const outFile = path.join(dir, 'out.log'), errFile = path.join(dir, 'err.log')
    rotate(outFile); rotate(errFile)
    const turnOffset = (() => { try { return fs.statSync(outFile).size } catch { return 0 } })()
    const outFd = fs.openSync(outFile, 'a', 0o600), errFd = fs.openSync(errFile, 'a', 0o600)
    const t = execTarget(bin, argv, { platform, env })
    let child
    try {
      child = spawn(t.file, t.args, {
        ...t.opts, cwd: st.cwd, detached: true, windowsHide: true, stdio: ['ignore', outFd, errFd],
        env: runEnv({ base: env, home: st.home, agentId: st.agentId, accountEnv, port, handoffId: st.handoffId }),
      })
    } finally { fs.closeSync(outFd); fs.closeSync(errFd) }
    child.on?.('error', (e) => update(st.runId, { state: 'error', error: String(e.message || e), endedAt: now() }))
    child.on?.('exit', (code, signal) => {
      const cur = read(st.runId)
      if (!cur || cur.pid !== child.pid) return // a newer turn owns the run
      update(st.runId, { exitCode: code ?? null, signal: signal || null, endedAt: now() })
      refresh(st.runId)
    })
    child.unref?.()
    return update(st.runId, {
      pid: child.pid, state: 'running', turn: (st.turn || 0) + 1, turnOffset, turnStartedAt: now(),
      exitCode: null, signal: null, endedAt: null, error: null, title: st.title || String(prompt).replace(/\s+/g, ' ').trim().slice(0, 80), model: model || st.model || null,
    })
  }

  /** Start a new run: `{ cwd, prompt, model?, mode?, allowYolo?, accountEnv?, name?, account?, home?, parentAgentId?, handoffId? }`. */
  function start(o) {
    if (!o?.cwd || !o?.prompt) throw new Error('cwd and prompt are required')
    const runId = o.runId || crypto.randomUUID()
    const st = {
      runId, agentId: `gemini:${runId}`, pid: null, cwd: o.cwd, sessionId: crypto.randomUUID(), name: o.name || '',
      account: o.account || null, home: o.home || null, model: o.model || null, mode: o.mode || 'default',
      startedAt: now(), state: 'starting', turn: 0, parentAgentId: o.parentAgentId || null, handoffId: o.handoffId || null,
    }
    startArgs({ prompt: o.prompt, model: o.model, mode: st.mode, sessionId: st.sessionId, allowYolo: o.allowYolo }) // fail before writing state
    write(st)
    return launchTurn(st, { prompt: o.prompt, model: o.model, mode: st.mode, allowYolo: o.allowYolo, accountEnv: o.accountEnv, skipTrust: o.skipTrust })
  }

  /** Follow-up turn on a finished run (`-r <sessionId> -p`). */
  function resume(runId, prompt, o = {}) {
    const st = refresh(runId)
    if (!st) throw new Error('unknown run')
    if (st.state === 'running') throw new Error('run is still working')
    if (!st.sessionId) throw new Error('run has no session id')
    return launchTurn(st, { prompt, model: o.model || st.model, mode: o.mode || st.mode, resume: st.sessionId, allowYolo: o.allowYolo, accountEnv: o.accountEnv, skipTrust: o.skipTrust })
  }

  /** Re-read the run's log and process: state is running | idle | error | limit | stopped | exited. */
  function refresh(runId) {
    const st = read(runId)
    if (!st) return null
    let text = ''
    try {
      const fd = fs.openSync(path.join(dirOf(runId), 'out.log'), 'r')
      try { const size = fs.fstatSync(fd).size, off = Math.min(st.turnOffset || 0, size); const b = Buffer.alloc(size - off); fs.readSync(fd, b, 0, b.length, off); text = b.toString('utf8') } finally { fs.closeSync(fd) }
    } catch { /* no log yet */ }
    const ev = parseEvents(text)
    const patch = {}
    if (ev.sessionId && ev.sessionId !== st.sessionId) patch.sessionId = ev.sessionId // rotated on fallback
    if (ev.model) patch.model = ev.model
    if (ev.lastAssistant) patch.lastMessage = ev.lastAssistant.slice(-500)
    if (ev.stats) patch.stats = ev.stats
    const running = st.pid && st.state === 'running' && isAlive(st.pid) && ev.result == null
    if (!running && st.state === 'running') {
      let errText = ev.error
      if (!errText && st.exitCode && st.exitCode !== 0) { try { errText = fs.readFileSync(path.join(dirOf(runId), 'err.log'), 'utf8').slice(-2000) } catch { /* none */ } }
      const quota = st.exitCode === QUOTA_EXIT_CODE || (ev.result === 'error' || st.exitCode) && isQuotaText(errText)
      if (quota) { patch.state = 'limit'; patch.limitStop = { at: now(), resetsAt: null, kind: 'limit', text: scrub(errText) } }
      else if (ev.result === 'error' || (st.exitCode && st.exitCode !== 0)) { patch.state = 'error'; patch.error = scrub(errText || `exit ${st.exitCode}`) }
      else if (ev.result === 'success' || st.exitCode === 0) patch.state = 'idle'
      else { patch.state = 'exited'; patch.endedAt = st.endedAt || now() } // process vanished, no result
    }
    return Object.keys(patch).length ? update(runId, patch) : st
  }

  /** Stop the process: SIGTERM, then SIGKILL after the grace period; taskkill /T on Windows. */
  async function stop(runId) {
    const st = read(runId)
    if (!st?.pid) return st
    update(runId, { stopRequested: true })
    if (isAlive(st.pid)) {
      if (platform === 'win32') taskkill(st.pid)
      else {
        try { kill(st.pid, 'SIGTERM') } catch { /* gone */ }
        const t0 = now()
        while (isAlive(st.pid) && now() - t0 < killGraceMs) await sleep(Math.min(100, Math.max(1, killGraceMs / 10)))
        if (isAlive(st.pid)) { try { kill(st.pid, 'SIGKILL') } catch { /* gone */ } }
      }
    }
    return update(runId, { state: 'stopped', endedAt: now() })
  }

  function list() {
    let ids = []
    try { ids = fs.readdirSync(root) } catch { return [] }
    return ids.map((id) => refresh(id)).filter(Boolean)
  }

  /** Delete run folders (not running) untouched for more than `maxAgeDays`. Returns the removed run ids. */
  function prune(maxAgeDays = 14) {
    const cutoff = now() - maxAgeDays * 86_400_000
    const removed = []
    let ids = []
    try { ids = fs.readdirSync(root) } catch { return removed }
    for (const id of ids) {
      const dir = path.join(root, id)
      try {
        const st = read(id)
        if (st?.state === 'running' && st.pid && isAlive(st.pid)) continue
        if (fs.statSync(dir).mtimeMs > cutoff) continue
        fs.rmSync(dir, { recursive: true, force: true }); removed.push(id)
      } catch { /* skip */ }
    }
    return removed
  }

  return { start, resume, prune, stop, refresh, get: refresh, list, dirOf }
}
