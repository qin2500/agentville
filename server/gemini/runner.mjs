/**
 * Antigravity CLI (`agy`) process supervisor. `agy` has no background daemon, so Agentville owns the process:
 * one detached `agy -p <prompt> --output-format stream-json` per turn, stdout (stream-json) to out.log, stderr
 * to err.log, and a state.json per run under `<data>/gemini-runs/<runId>/`. The conversation id is minted by
 * agy and read from the first `init` event; follow-up turns pass `--conversation <id>`.
 * Facts: docs/antigravity-cli-notes.md (docs-only; re-check on a real install). All I/O is injectable so
 * tests use a fake bin. The stream parser is tolerant: unknown events and fields are ignored, never thrown on.
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execTarget } from '../platform.mjs'

/** Agentville mode -> agy `--mode`. '' (default) is accept-edits. There is no yolo path at all. */
export const AGY_MODES = { '': 'accept-edits', default: 'accept-edits', auto_edit: 'accept-edits', 'accept-edits': 'accept-edits', auto: 'auto', plan: 'plan' }
export const MAX_LOG_BYTES = 4 * 1024 * 1024
/** A cautious retry window after a quota stop: agy's reset time is not documented (UNCERTAIN). */
export const QUOTA_RETRY_MS = 5 * 3600e3
const QUOTA_RE = /quota|RESOURCE_EXHAUSTED|\b429\b|rate.?limit|Model quota reached|exhausted your capacity/i
// For a run that says SUCCESS: only these unmistakable texts in a short response count as a quota stop.
const QUOTA_STRONG_RE = /Model quota reached|exhausted your capacity|RESOURCE_EXHAUSTED|Individual quota reached/i
export const AUTH_RE = /authentication (?:required|failed)|not authenticated|unauthenticated|please (?:sign|log) ?in|login required|secret keyring is locked/i

/** True when a result.error message, response or stderr text is a quota / rate-limit failure. */
export const isQuotaText = (text) => QUOTA_RE.test(String(text ?? ''))
/** True when the text says agy has no usable sign-in. */
export const isAuthText = (text) => AUTH_RE.test(String(text ?? ''))

export const MODEL_RE = /^[A-Za-z0-9][\w.\-:]*$/
const CONV_RE = /^[A-Za-z0-9][\w.\-]*$/

/**
 * argv for one turn. `resume` is a conversation id for a follow-up turn. Every value is validated (model,
 * conversation id, mode from a fixed map), so no value can become another flag. A prompt that starts with
 * `-` gets a leading space so no parser reads it as a flag. `--dangerously-skip-permissions` is never passed.
 */
export function startArgs({ prompt, model, mode, resume } = {}) {
  if (model && !MODEL_RE.test(String(model))) throw new Error('invalid model name')
  if (resume && !CONV_RE.test(String(resume))) throw new Error('invalid conversation id')
  const m = mode == null ? '' : String(mode)
  if (!Object.hasOwn(AGY_MODES, m)) throw new Error(`unknown mode ${m}`)
  let p = String(prompt ?? '')
  if (p.startsWith('-')) p = ' ' + p
  const args = ['-p', p, '--output-format', 'stream-json', '--mode', AGY_MODES[m]]
  if (model) args.push('--model', String(model))
  if (resume) args.push('--conversation', String(resume))
  return args
}

const ENV_ALLOW = /^(PATH|Path|HOME|USER|LOGNAME|SHELL|USERPROFILE|USERNAME|APPDATA|LOCALAPPDATA|ProgramData|SystemRoot|SYSTEMROOT|SystemDrive|windir|ComSpec|PATHEXT|LANG|LC_[A-Z_]+|TERM|TMP|TEMP|TMPDIR|DBUS_SESSION_BUS_ADDRESS|XDG_[A-Z_]+|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy|AGENTVILLE_[A-Z_]+)$/
const ENV_DENY = /^(GEMINI_API_KEY|GOOGLE_.*|GEMINI_CLI_HOME|AGY_.*)$/

/**
 * Env for the child, built from an allowlist (no ambient secrets). DBUS/XDG pass so the Linux keyring is
 * reachable. AGY_CLI_DISABLE_AUTO_UPDATE keeps the version stable during a run. `accountEnv` is merged whole,
 * last (the per-launch agent token rides there).
 */
export function runEnv({ base = process.env, agentId, accountEnv, port, handoffId } = {}) {
  const env = {}
  for (const [k, v] of Object.entries(base)) if (ENV_ALLOW.test(k) && !ENV_DENY.test(k) && v != null) env[k] = String(v)
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
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

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null)
const str = (x) => (typeof x === 'string' ? x : '')
const errText = (e) => (typeof e === 'string' ? e : obj(e) ? str(e.message) || str(e.type) || '' : '')

/** Join a text delta onto what a step has so far: tolerant of incremental or cumulative deltas. */
export function joinDelta(have, d) {
  if (!d) return have
  if (have && d.startsWith(have)) return d // cumulative, or a DONE that repeats the full text
  return have + d
}

/**
 * Fold agy stream-json lines into a summary. Unparseable lines, unknown events and unknown fields are ignored.
 * -> { conversationId, model, status (result.status, upper case) | null, response, error, toolErrors[], usage,
 *      lastAssistant, events, sessionId (= conversationId) }
 */
export function parseEvents(text) {
  const out = { conversationId: null, model: null, status: null, response: '', error: null, toolErrors: [], usage: null, lastAssistant: '', events: 0 }
  const steps = new Map() // step key -> { index, text }
  let turn = 0
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let e
    try { e = JSON.parse(s) } catch { continue }
    if (!obj(e)) continue
    out.events++
    const kind = str(e.event) || str(e.type)
    if (kind === 'init') {
      turn++
      const init = obj(e.init) || {}
      out.conversationId = str(e.conversation_id) || str(init.conversation_id) || out.conversationId
      out.model = str(init.model) || str(e.model) || out.model
    } else if (kind === 'step_update') {
      const u = obj(e.step_update) || e
      out.conversationId = out.conversationId || str(u.conversation_id) || str(e.conversation_id) || null
      const type = str(u.step_type)
      const ti = obj(u.tool_info)
      if (ti?.error) { const m = errText(ti.error); if (m) out.toolErrors.push(m) }
      if (type === 'agent_response') {
        const idx = Number.isFinite(u.step_index) ? u.step_index : -1
        const key = `${turn}:${str(u.conversation_id)}:${idx}`
        const cur = steps.get(key) || { turn, index: idx, text: '' }
        cur.text = joinDelta(cur.text, str(u.text_delta))
        steps.set(key, cur)
      }
    } else if (kind === 'result') {
      const r = obj(e.result) || e
      out.status = str(r.status).toUpperCase() || 'SUCCESS'
      out.response = str(r.response)
      out.error = errText(r.error) || null
      out.usage = obj(r.usage) || out.usage
      out.conversationId = str(r.conversation_id) || str(e.conversation_id) || out.conversationId
    }
  }
  // The last non-empty agent_response of the latest turn that has one.
  const texts = [...steps.values()].filter((x) => x.text.trim()).sort((a, b) => a.turn - b.turn || a.index - b.index)
  out.lastAssistant = out.response.trim() || (texts.length ? texts[texts.length - 1].text : '')
  out.sessionId = out.conversationId
  // Compatibility with callers of the Gemini CLI shape: result in lower case.
  out.result = out.status ? out.status.toLowerCase() : null
  return out
}
/**
 * Windows launcher for a `.cmd` shim (npm-style shims; agy itself is likely a real .exe). A detached spawn sets DETACHED_PROCESS,
 * so cmd.exe has no console; the console program it then starts (node) gets a fresh console and that
 * console's std handles, not cmd's, so stdout/stderr never reach out.log/err.log. So the detached process
 * is this small node script instead: it inherits the log handles (libuv passes them explicitly), starts
 * cmd.exe attached to itself with those handles, and exits with cmd's exit code.
 */
const WIN_LAUNCHER = `const { spawn } = require('child_process')
const t = JSON.parse(process.argv[1])
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const c = spawn(t.file, t.args, { ...t.opts, stdio: 'inherit', windowsHide: true, env })
c.on('error', (e) => { process.stderr.write(String(e && e.message || e) + '\\n'); process.exit(127) })
c.on('exit', (code) => process.exit(code == null ? 1 : code))`

/** `{ file, args, opts }` to spawn detached for one turn; see WIN_LAUNCHER. */
export function launchTarget(bin, argv, { platform = process.platform, env = process.env, execPath = process.execPath, electron = !!process.versions.electron } = {}) {
  const t = execTarget(bin, argv, { platform, env })
  if (platform !== 'win32' || t.file === bin) return { ...t, env: {} }
  return { file: execPath, args: ['-e', WIN_LAUNCHER, '--', JSON.stringify(t)], opts: {}, env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


/** Read `file` from byte `offset` to the end ('' when missing). */
function readFrom(file, offset = 0) {
  try {
    const fd = fs.openSync(file, 'r')
    try { const size = fs.fstatSync(fd).size, off = Math.min(offset || 0, size); const b = Buffer.alloc(size - off); fs.readSync(fd, b, 0, b.length, off); return b.toString('utf8') } finally { fs.closeSync(fd) }
  } catch { return '' }
}

/**
 * How a finished turn ended, from its events, stderr and exit code:
 * { state: 'idle'|'limit'|'error'|'exited', error?, limitText?, auth? }.
 */
export function classifyTurn(ev, { stderr = '', exitCode = null } = {}) {
  const status = ev?.status || null
  const failed = status === 'ERROR' || status === 'INVALID' || (Number.isInteger(exitCode) && exitCode !== 0)
  // A failed run: any error text that names a quota. A run that says SUCCESS: only a short response that is
  // nothing but an unmistakable quota message (agy may render the stop as agent text). Tool errors alone never
  // count on a successful run (the agent's own commands can print 429s).
  const texts = failed ? [ev?.error, ...(ev?.toolErrors || []), stderr, ev?.response].filter(Boolean) : []
  const quotaHit = texts.find((t) => isQuotaText(t))
    || (!failed && status && (ev?.response || '').length < 400 && QUOTA_STRONG_RE.test(ev?.response || '') ? ev.response : null)
  if (quotaHit) return { state: 'limit', limitText: quotaHit }
  const authHit = [ev?.error, stderr, failed ? ev?.response : ''].find((t) => isAuthText(t))
  if (failed && authHit) return { state: 'error', auth: true, error: 'Antigravity sign-in needed: run agy once in a terminal and sign in' }
  if (failed) return { state: 'error', error: ev?.error || stderr.trim().slice(-2000) || `exit ${exitCode}` }
  if (status || exitCode === 0) return { state: 'idle' }
  return { state: 'exited' } // process vanished with no result
}

export function createRunner({
  dataDir,
  bin = 'agy',
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
  const sizeOf = (f) => { try { return fs.statSync(f).size } catch { return 0 } }

  function rotate(file) {
    try { if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1') } catch { /* none yet */ }
  }

  /** Spawn one turn for a run. */
  function launchTurn(st, { prompt, model, mode, resume, accountEnv }) {
    const dir = dirOf(st.runId)
    const argv = startArgs({ prompt, model, mode, resume }) // validates before any side effect
    const outFile = path.join(dir, 'out.log'), errFile = path.join(dir, 'err.log')
    rotate(outFile); rotate(errFile)
    const turnOffset = sizeOf(outFile), errOffset = sizeOf(errFile)
    const outFd = fs.openSync(outFile, 'a', 0o600), errFd = fs.openSync(errFile, 'a', 0o600)
    const t = launchTarget(bin, argv, { platform, env })
    let child
    try {
      child = spawn(t.file, t.args, {
        ...t.opts, cwd: st.cwd, detached: true, windowsHide: true, stdio: ['ignore', outFd, errFd],
        env: { ...runEnv({ base: env, agentId: st.agentId, accountEnv, port, handoffId: st.handoffId }), ...t.env },
      })
    } finally { fs.closeSync(outFd); fs.closeSync(errFd) }
    child.on?.('error', (e) => update(st.runId, { state: 'error', error: scrub(e.message || e), endedAt: now() }))
    child.on?.('exit', (code, signal) => {
      const cur = read(st.runId)
      if (!cur || cur.pid !== child.pid) return // a newer turn owns the run
      update(st.runId, { exitCode: code ?? null, signal: signal || null, endedAt: now() })
      refresh(st.runId)
    })
    child.unref?.()
    return update(st.runId, {
      pid: child.pid, state: 'running', turn: (st.turn || 0) + 1, turnOffset, errOffset, turnStartedAt: now(),
      exitCode: null, signal: null, endedAt: null, error: null, authNeeded: false,
      title: st.title || String(prompt).replace(/\s+/g, ' ').trim().slice(0, 80), model: model || st.model || null,
    })
  }

  /** Start a new run: `{ cwd, prompt, model?, mode?, accountEnv?, name?, parentAgentId?, handoffId? }`. */
  function start(o) {
    if (!o?.cwd || !o?.prompt) throw new Error('cwd and prompt are required')
    const runId = o.runId || crypto.randomUUID()
    const mode = o.mode || ''
    startArgs({ prompt: o.prompt, model: o.model, mode }) // fail before writing state
    const st = {
      runId, agentId: `gemini:${runId}`, pid: null, cwd: o.cwd, conversationId: null, sessionId: null, name: o.name || '',
      model: o.model || null, mode, startedAt: now(), state: 'starting', turn: 0,
      parentAgentId: o.parentAgentId || null, handoffId: o.handoffId || null,
    }
    write(st)
    return launchTurn(st, { prompt: o.prompt, model: o.model, mode, accountEnv: o.accountEnv })
  }

  /** Follow-up turn on a finished run (`--conversation <id>`). */
  function resume(runId, prompt, o = {}) {
    const st = refresh(runId)
    if (!st) throw new Error('unknown run')
    if (st.state === 'running') throw new Error('run is still working')
    const conv = st.conversationId || st.sessionId
    if (!conv) throw new Error('run has no conversation id yet')
    return launchTurn(st, { prompt, model: o.model || st.model, mode: o.mode ?? st.mode, resume: conv, accountEnv: o.accountEnv })
  }

  /** Re-read the run's log and process: state is running | idle | error | limit | stopped | exited. */
  function refresh(runId) {
    const st = read(runId)
    if (!st) return null
    const ev = parseEvents(readFrom(path.join(dirOf(runId), 'out.log'), st.turnOffset))
    const patch = {}
    if (ev.conversationId && ev.conversationId !== st.conversationId) { patch.conversationId = ev.conversationId; patch.sessionId = ev.conversationId }
    if (ev.model && ev.model !== st.model) patch.model = ev.model
    if (ev.lastAssistant) { const m = ev.lastAssistant.slice(-500); if (m !== st.lastMessage) patch.lastMessage = m }
    if (ev.usage && JSON.stringify(ev.usage) !== JSON.stringify(st.stats)) patch.stats = ev.usage
    const running = st.pid && st.state === 'running' && isAlive(st.pid) && ev.status == null
    if (!running && st.state === 'running') {
      const stderr = ev.status === 'SUCCESS' ? '' : readFrom(path.join(dirOf(runId), 'err.log'), st.errOffset).slice(-4000)
      const c = classifyTurn(ev, { stderr, exitCode: st.exitCode })
      patch.state = c.state
      if (c.state === 'limit') { const at = now(); patch.limitStop = { at, resetsAt: at + QUOTA_RETRY_MS, kind: 'limit', text: scrub(c.limitText) } }
      if (c.state === 'error') { patch.error = scrub(c.error); patch.authNeeded = c.auth === true }
      if (c.state === 'exited') patch.endedAt = st.endedAt || now()
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
