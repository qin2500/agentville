/**
 * Switch every agent between the shared "pool" gateway and the user's Claude accounts.
 *
 * The pool lives in `<claude home>/settings.json` → `env` (gateway URL, token, model aliases).
 * Switching to personal moves those keys into `<data>/pool-profile.json` (0600) and strips the
 * gateway-only `cc/` model alias from each background job's saved respawn flags and provider env;
 * switching back restores exactly what was stashed. Either way the running jobs must be restarted
 * to pick the new settings up, and each one is, but only at a turn boundary: a busy job is polled
 * until it is idle (up to 10 minutes), then left "restart pending" rather than killed mid tool call.
 *
 * Switching between saved accounts (server/accounts.mjs) swaps the login in Claude's credential
 * store and restarts nothing: a running job reads the swapped login on its next request. The swap
 * is checked directly (the live login read back and confirmed against the API) and rolled back if
 * it is another account or missing; a check that can't decide (expired token, no network) leaves
 * the switch in place, logged as unverified. Only a job that still carries leftover pool settings
 * is changed, and only that job is restarted (when idle).
 *
 * Every edit is preceded by a backup set (including Claude's credential; newest 10 kept). A
 * rollback or Undo puts back only what that switch changed, and for job files only the
 * `respawnFlags` and `providerEnv` fields. No env value, token, flag value or prompt is ever
 * returned or logged. Interactive sessions are never touched: they are listed for the user.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { findExecutable } from './terminal.mjs'
import { createAccounts, writeAtomic } from './accounts.mjs'

/** Settings env keys that make up the pool profile. */
export const POOL_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT',
]
const TERMINAL = ['done', 'stopped', 'failed']
const HOME = os.homedir()
const CLAUDE_DIRS = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), path.join(HOME, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const RESPAWN_MS = 120_000
/** How long a busy job is waited for before it is left "restart pending", and how often it is polled. */
const idleMaxMs = () => Number(process.env.AGENTVILLE_ACCOUNT_IDLE_MAX_MS) || 600_000
const pollMs = () => Number(process.env.AGENTVILLE_ACCOUNT_POLL_MS) || 3_000
/** Backup sets kept in `<data>/account-backups`. */
export const KEEP_BACKUPS = 10
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (status, message) => Object.assign(new Error(message), { status })
const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'

/** Why switching can't run here ('' = it can). Tests must name a fake home and a fake `claude`. */
export function switchingBlocked() {
  if (process.platform === 'win32') return 'Account switching is not supported on Windows'
  if (testing() && !(process.env.AGENTVILLE_CLAUDE_HOME && process.env.AGENTVILLE_CLAUDE_BIN)) return 'Account switching is disabled in tests'
  return ''
}

/** The real `claude` executable (never a shell function), or the test fake. */
export const claudeBin = async () => process.env.AGENTVILLE_CLAUDE_BIN || findExecutable('claude', CLAUDE_DIRS)

export function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 256 * 1024, env: process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: Boolean(err?.killed), stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** Rewrite JSON with the original's indentation and trailing newline, so an untouched round trip is byte-identical. */
export function serializeLike(original, value) {
  const indent = /^[{[]\r?\n([ \t]+)/.exec(original)?.[1]
  return JSON.stringify(value, null, indent) + (original.endsWith('\n') ? '\n' : '')
}

const modelOf = (flags) => {
  const i = (flags || []).indexOf('--model')
  return i >= 0 ? flags[i + 1] || '' : ((flags || []).find((f) => f.startsWith('--model='))?.slice(8) || '')
}
/** `--model cc/x` -> `--model x`; `--model=cc/x` -> `--model=x`. Everything else untouched. */
export const stripPoolModel = (flags) => (flags || []).map((f, i, all) =>
  all[i - 1] === '--model' && f.startsWith('cc/') ? f.slice(3) : f.startsWith('--model=cc/') ? `--model=${f.slice(11)}` : f)

/**
 * `flags` with its `--model` value (either form, its own form kept) set to the one in `saved`.
 * Every other argument is kept; flags without a model, or a `saved` without one, are left as they are.
 */
export function withModel(flags, saved) {
  const has = (saved || []).includes('--model') || (saved || []).some((f) => typeof f === 'string' && f.startsWith('--model='))
  if (!has) return flags
  const want = modelOf(saved)
  const out = [...flags]
  const i = out.indexOf('--model')
  if (i >= 0) { if (i + 1 < out.length) out[i + 1] = want; return out }
  const j = out.findIndex((f) => typeof f === 'string' && f.startsWith('--model='))
  if (j >= 0) out[j] = `--model=${want}`
  return out
}

/** A registry entry for job `short` (or its sessions) written after `since` whose process is alive. */
export async function liveSince(home, short, state, since) {
  const ids = new Set([state.sessionId, state.resumeSessionId].filter(Boolean))
  const dir = path.join(home, 'sessions')
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!f.endsWith('.json')) continue
    const file = path.join(dir, f)
    const st = await fsp.stat(file).catch(() => null)
    if (!st || st.mtimeMs < since) continue
    let s
    try { s = JSON.parse(await fsp.readFile(file, 'utf8')) } catch { continue }
    if (s.jobId !== short && !ids.has(s.sessionId)) continue
    try { process.kill(s.pid, 0); return true } catch (e) { if (e.code === 'EPERM') return true }
  }
  return false
}

/** Registry statuses that mean the session is mid turn or sitting in a dialog (claude-code.mjs). */
// 'shell': waiting on a background shell; the turn resumes when it finishes, so a respawn would cut it off.
const NOT_IDLE = new Set(['busy', 'waiting', 'needs_user', 'blocked', 'needs_trust', 'shell'])

/**
 * Is job `short` at a turn boundary? 'idle' | 'busy' | 'gone' (no live process, or no job file).
 * Busy when the scheduler says the job is active (`tempo: 'active'`) or a live registry entry for it
 * says busy or is in a dialog; a respawn then would cut a tool call off. Only those fields are read.
 */
export async function jobActivity(home, short) {
  let state
  try { state = JSON.parse(await fsp.readFile(path.join(home, 'jobs', short, 'state.json'), 'utf8')) } catch { return 'gone' }
  const ids = new Set([state?.sessionId, state?.resumeSessionId].filter(Boolean))
  let live = false
  let busy = state?.tempo === 'active'
  const dir = path.join(home, 'sessions')
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!f.endsWith('.json')) continue
    let s
    try { s = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) } catch { continue }
    if (!s?.pid || (s.jobId !== short && !ids.has(s.sessionId))) continue
    try { process.kill(s.pid, 0) } catch (e) { if (e.code !== 'EPERM') continue }
    live = true
    if (NOT_IDLE.has(s.status)) busy = true
  }
  if (!live) return 'gone'
  return busy ? 'busy' : 'idle'
}

/**
 * Poll `check()` ('idle' | 'busy' | 'gone') every `pollMs` until it isn't 'busy' or `maxMs` passes.
 * -> `{ state: 'idle' | 'gone' | 'timeout', waited }` (`waited`: it was busy at least once).
 */
export async function waitForIdle(check, { maxMs, pollMs: every, now = Date.now, sleep: nap = sleep }) {
  const until = now() + maxMs
  let waited = false
  for (;;) {
    const st = await check()
    if (st !== 'busy') return { state: st === 'gone' ? 'gone' : 'idle', waited }
    if (now() >= until) return { state: 'timeout', waited: true }
    waited = true
    await nap(every)
  }
}

/**
 * The first non-empty line of a command's stderr, safe to log: flag values, quoted text and
 * anything token-like (long runs of key characters) are replaced with "…", and it is kept short.
 */
export function stderrLine(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || ''
  return line
    .replace(/(["'`]).*?\1/g, '"…"')
    .replace(/(--?[A-Za-z][\w-]*)(=|\s+)(?!-)\S+/g, '$1 …')
    .replace(/[A-Za-z0-9_\-+/=.:]{24,}/g, '…')
    .replace(/\b(sk-|ant-|Bearer\s)\S*/gi, '…')
    .slice(0, 160)
}

/** Keep `why` (from autoswitch) to plain JSON, bounded, for the audit log. */
function plainWhy(why) {
  if (!why || typeof why !== 'object') return undefined
  try {
    const text = JSON.stringify(why)
    return text.length <= 4000 ? JSON.parse(text) : { truncated: true, reason: typeof why.reason === 'string' ? why.reason.slice(0, 200) : undefined }
  } catch { return undefined }
}

/**
 * `network`: createNetwork(), so a quarantine account is never switched to on the work Wi-Fi.
 * `permBusy()`: true while a permission-mode switch (permmode.mjs) runs; a switch or Undo is then
 * refused. `permBusyJob(short)`: true for the job that switch is working on; its queued restart waits.
 * Tests may inject `accounts` (a fake of createAccounts()), `run`, `bin`, `blocked`, `activity`
 * (short -> 'idle' | 'busy' | 'gone'), `now`, `sleep`, `idleMs` and `everyMs`.
 */
export function createAccount({
  dataDir, claudeHome, onReading, network,
  accounts: injectedAccounts, run: runCmd = run, bin: findBin = claudeBin, blocked: isBlocked = switchingBlocked,
  activity, now: clock = Date.now, sleep: nap = sleep, idleMs = idleMaxMs, everyMs = pollMs,
  permBusy = () => false, permBusyJob = () => false,
}) {
  const stashFile = path.join(dataDir, 'pool-profile.json')
  const backupRoot = path.join(dataDir, 'account-backups')
  const plans = new Map()
  const switches = []
  let busy = false

  const settingsFile = () => path.join(claudeHome(), 'settings.json')
  const jobsDir = () => path.join(claudeHome(), 'jobs')
  /** Account edits share the switch's lock: never two credential changes at once. */
  async function exclusive(fn) {
    if (busy) throw fail(409, 'A switch is already running')
    busy = true
    try { return await fn() } finally { busy = false }
  }
  const accounts = injectedAccounts || createAccounts({
    dataDir, claudeHome, exclusive, onReading,
    poolState: async () => ({ active: profileOf(await readSettings()) === 'pool', available: fs.existsSync(stashFile) }),
  })
  const jobState = activity || ((short) => jobActivity(claudeHome(), short))

  async function readSettings() {
    const text = await fsp.readFile(settingsFile(), 'utf8').catch(() => '{}\n')
    return { text, json: JSON.parse(text) }
  }

  /** Jobs to switch: every unfinished one, plus finished ones whose process is still running (`live`). */
  async function activeJobs(live = new Set()) {
    const out = []
    for (const e of await fsp.readdir(jobsDir(), { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !/^[0-9a-f]{8}$/.test(e.name)) continue
      const file = path.join(jobsDir(), e.name, 'state.json')
      const text = await fsp.readFile(file, 'utf8').catch(() => null)
      if (!text) continue
      let state
      try { state = JSON.parse(text) } catch { continue }
      if (!TERMINAL.includes(state.state) || live.has(e.name)) out.push({ short: e.name, file, text, state })
    }
    return out
  }

  /**
   * Jobs the user has reopened in a terminal (`claude --resume <id>`): a live registry entry of kind
   * 'interactive' for the job's session. `claude respawn` refuses them ("running in another
   * terminal"), so a switch leaves them to the user, like any interactive session.
   */
  async function openInTerminal(jobs) {
    const bySession = new Map()
    for (const j of jobs) for (const id of [j.state.sessionId, j.state.resumeSessionId]) if (id) bySession.set(id, j.short)
    const out = new Set()
    const dir = path.join(claudeHome(), 'sessions')
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.json')) continue
      let s
      try { s = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) } catch { continue }
      const short = s?.kind === 'interactive' && bySession.get(s.sessionId)
      if (!short) continue
      try { process.kill(s.pid, 0); out.add(short) } catch (e) { if (e.code === 'EPERM') out.add(short) }
    }
    return out
  }
  /** Live jobs a switch restarts, and live sessions (incl. reopened jobs) the user restarts by hand. */
  async function splitLive(agents, allJobs) {
    const liveIds = new Set(agents.filter((a) => a.jobId && a.live).map((a) => a.jobId))
    const live = allJobs.filter((j) => liveIds.has(j.short))
    const term = await openInTerminal(live)
    const sessions = agents.filter((a) => a.harness === 'claude-code' && a.live && (a.kind === 'session' || term.has(a.jobId)))
      .map((a) => ({ id: a.id, name: a.name, cwd: a.cwd, resume: a.resume, ...(term.has(a.jobId) && { note: 'Open in a terminal: restart it there' }) }))
    return { jobs: live.filter((j) => !term.has(j.short)), sessions }
  }

  const profileOf = (settings) => (settings.json?.env && Object.hasOwn(settings.json.env, 'ANTHROPIC_BASE_URL') ? 'pool' : 'personal')

  /**
   * Logged in to a personal (claude.ai) account? true | false | 'unknown'. Only `loggedIn` and
   * `authMethod` are read. While the pool env is active, auth status describes the gateway, so a
   * stored personal login can't be seen: anything but an explicit claude.ai login is 'unknown',
   * and the canary verification is what protects the switch.
   */
  async function personalReady(profile) {
    const bin = await findBin()
    if (!bin) return false
    const r = await runCmd(bin, ['auth', 'status', '--json'], 15_000)
    let s = {}
    try { s = JSON.parse(r.stdout) } catch { /* not JSON */ }
    if (r.code === 0 && s.loggedIn === true && s.authMethod === 'claude.ai') return true
    // On the pool, auth status reports the gateway's token; the personal login is still stored.
    if (await storedLogin()) return true
    return profile === 'pool' ? 'unknown' : false
  }

  /**
   * Is a claude.ai login stored for Claude Code? Existence only, the secret is never read: the
   * macOS Keychain item "Claude Code-credentials" (`security` without -w prints no password), or
   * `<claude home>/.credentials.json` elsewhere. Tests only ever see the fake home's file.
   */
  async function storedLogin() {
    if (fs.existsSync(path.join(claudeHome(), '.credentials.json'))) return true
    if (process.platform !== 'darwin' || testing()) return false
    const r = await runCmd('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], 5_000)
    return r.code === 0
  }

  /** What a switch would do. `agents` (from the scan) supply names, liveness and interactive sessions. */
  async function status(agents) {
    const blocked = isBlocked()
    const settings = await readSettings()
    const byJob = new Map(agents.filter((a) => a.jobId).map((a) => [a.jobId, a]))
    // Only jobs whose process is running now are restarted; dormant ones stay dormant.
    const liveIds = new Set(agents.filter((a) => a.jobId && a.live).map((a) => a.jobId))
    const { jobs, sessions } = await splitLive(agents, await activeJobs(liveIds))
    const profile = profileOf(settings)
    const plan = {
      jobs: jobs.map((j) => ({ id: j.short, name: byJob.get(j.short)?.name || j.state.name || j.short, live: Boolean(byJob.get(j.short)?.live), model: modelOf(j.state.respawnFlags) })),
      sessions,
    }
    const confirm = crypto.randomUUID()
    for (const [k, v] of plans) if (Date.now() > v.expires) plans.delete(k)
    plans.set(confirm, { jobs: plan.jobs.map((j) => j.id).sort().join(','), expires: Date.now() + 120_000 })
    return {
      profile,
      personalReady: blocked ? false : await personalReady(profile),
      poolStashed: fs.existsSync(stashFile),
      blocked,
      plan,
      confirm,
      // Jobs a switch is still waiting on to reach a turn boundary, or gave up on (restart by hand).
      restarts: [...restartQueue.values()].map((q) => ({ id: q.short, status: 'waiting' })).concat(pendingRestarts),
    }
  }

  /**
   * `cred`: Claude's live credential now `{ text, id }`, kept 0600 so a rollback or Undo restores it.
   * Returns the set's folder and `touch(name)`, which records in its meta that the switch is about
   * to change that file (a rollback or Undo puts back only those). Older sets beyond the newest
   * KEEP_BACKUPS are removed.
   */
  async function backup(jobs, reason, cred = {}) {
    const dir = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-'))
    await fsp.mkdir(path.join(dir, 'jobs'), { recursive: true, mode: 0o700 })
    await fsp.chmod(backupRoot, 0o700).catch(() => {})
    await fsp.chmod(dir, 0o700)
    const files = []
    const copy = async (from, to) => {
      const text = await fsp.readFile(from, 'utf8').catch(() => null)
      if (text === null) return
      await fsp.writeFile(to, text, { mode: 0o600 })
      files.push(path.relative(dir, to))
    }
    await copy(settingsFile(), path.join(dir, 'settings.json'))
    await copy(stashFile, path.join(dir, 'pool-profile.json'))
    for (const j of jobs) await copy(j.file, path.join(dir, 'jobs', `${j.short}.json`))
    if (cred.text) {
      await fsp.writeFile(path.join(dir, 'credential.json'), cred.text, { mode: 0o600 })
      await fsp.writeFile(path.join(dir, 'oauth-account.json'), JSON.stringify(await accounts.readOauthAccount()), { mode: 0o600 })
      files.push('credential.json', 'oauth-account.json')
    }
    const meta = { at: Date.now(), reason, files, changed: [], credentialAccount: cred.id || null }
    const writeMeta = () => fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta) + '\n', { mode: 0o600 })
    await writeMeta()
    await prune()
    /** Record (before writing it) that this switch changes `name` ('settings.json', 'jobs/<short>.json', …). */
    const touch = async (...names) => {
      const add = names.filter((n) => !meta.changed.includes(n))
      if (!add.length) return
      meta.changed.push(...add)
      await writeMeta()
    }
    return { dir, touch }
  }

  /** Does backup set `name` hold pool gateway settings (its settings.json env has ANTHROPIC_BASE_URL)? */
  async function holdsPool(name) {
    try {
      const env = JSON.parse(await fsp.readFile(path.join(backupRoot, name, 'settings.json'), 'utf8'))?.env
      return Boolean(env && typeof env === 'object' && Object.hasOwn(env, 'ANTHROPIC_BASE_URL'))
    } catch { return false }
  }

  /**
   * Keep the newest KEEP_BACKUPS sets. While there is no pool stash, the newest set holding the pool
   * gateway settings is never removed: it may be the only copy of them left.
   */
  async function prune() {
    const sets = (await fsp.readdir(backupRoot).catch(() => [])).sort()
    const old = sets.slice(0, Math.max(0, sets.length - KEEP_BACKUPS))
    if (!old.length) return
    let keep = null
    if (!fs.existsSync(stashFile)) {
      for (const name of [...sets].reverse()) if (await holdsPool(name)) { keep = name; break }
    }
    for (const name of old) {
      if (name === keep) continue
      await fsp.rm(path.join(backupRoot, name), { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Put back what a backup set's switch changed (`meta.changed`; a set from before that was
   * recorded puts back everything it holds). Settings, stash and credential are restored as they
   * were; a stash that didn't exist then is removed. A job file is never overwritten whole: Claude
   * rewrites it as the job runs, so only `respawnFlags` and `providerEnv` are put back into the
   * current file (read-modify-write).
   */
  async function restore(dir) {
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'))
    const scope = Array.isArray(meta.changed) ? meta.changed : [...meta.files, 'pool-profile.json']
    for (const f of scope) {
      const has = meta.files.includes(f)
      if (f === 'pool-profile.json') {
        if (has) await writeAtomic(stashFile, await fsp.readFile(path.join(dir, f), 'utf8'), 0o600)
        else await fsp.rm(stashFile, { force: true })
        continue
      }
      if (!has) continue
      const text = await fsp.readFile(path.join(dir, f), 'utf8')
      if (f === 'credential.json') { await accounts.restoreLive(text, meta.credentialAccount); continue }
      if (f === 'oauth-account.json') { await accounts.writeOauthAccount(JSON.parse(text)); continue }
      if (f === 'settings.json') { await writeAtomic(settingsFile(), text); continue }
      if (f.startsWith('jobs/')) await restoreJobFields(path.join(jobsDir(), path.basename(f, '.json'), 'state.json'), JSON.parse(text))
    }
    return meta
  }

  /**
   * Put back into the job file as it is now only what a switch changes there: the `--model` value
   * of `respawnFlags` and the pool keys of `providerEnv`, from `saved`. Anything else changed since
   * (a later bypass-permissions switch, another env key) is kept.
   */
  async function restoreJobFields(file, saved) {
    const text = await fsp.readFile(file, 'utf8').catch(() => null)
    if (text === null) return // the job is gone: nothing to put back
    const state = JSON.parse(text)
    if (Array.isArray(state.respawnFlags)) state.respawnFlags = withModel(state.respawnFlags, saved.respawnFlags)
    else if (Array.isArray(saved.respawnFlags)) state.respawnFlags = saved.respawnFlags
    const was = saved.providerEnv && typeof saved.providerEnv === 'object' ? saved.providerEnv : {}
    const cur = state.providerEnv && typeof state.providerEnv === 'object' ? state.providerEnv : null
    if (cur || POOL_KEYS.some((k) => Object.hasOwn(was, k))) {
      // The saved key order first (so an untouched round trip is byte-identical), then keys added since.
      const now = cur || {}
      const pool = (k) => POOL_KEYS.includes(k)
      const env = {}
      for (const k of Object.keys(was)) {
        if (pool(k)) env[k] = was[k]
        else if (Object.hasOwn(now, k)) env[k] = now[k]
      }
      for (const [k, v] of Object.entries(now)) if (!pool(k) && !Object.hasOwn(env, k)) env[k] = v
      state.providerEnv = env
    }
    const out = serializeLike(text, state)
    if (out !== text) await writeAtomic(file, out)
  }

  // When Claude's account last changed here (a switch that wasn't rolled back, or an Undo).
  let changedAt = null
  async function lastChangeAt() {
    if (changedAt === null) {
      changedAt = 0
      const log = await fsp.readFile(path.join(dataDir, 'account-log.jsonl'), 'utf8').catch(() => '')
      for (const line of log.trim().split('\n').reverse()) {
        try { const e = JSON.parse(line); if (e.action === 'undo' || (e.action === 'switch' && !e.restored)) { changedAt = e.at; break } } catch { /* skip */ }
      }
    }
    return changedAt
  }
  async function audit(entry) {
    if (entry.action === 'undo' || (entry.action === 'switch' && !entry.restored)) changedAt = Date.now()
    await fsp.mkdir(dataDir, { recursive: true })
    await fsp.appendFile(path.join(dataDir, 'account-log.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n', { mode: 0o600 })
  }

  /** Move the pool keys into the stash and strip pool settings from every job. -> jobs changed. */
  async function applyToPersonal(jobs, touch) {
    const settings = await readSettings() // re-read just before writing
    const env = settings.json.env || {}
    const stash = { savedAt: Date.now(), envOrder: Object.keys(env), env: {}, jobs: {} }
    for (const k of POOL_KEYS) if (Object.hasOwn(env, k)) { stash.env[k] = env[k]; delete env[k] }
    for (const j of jobs) {
      const fresh = JSON.parse(await fsp.readFile(j.file, 'utf8'))
      stash.jobs[j.short] = { respawnFlags: fresh.respawnFlags, providerEnv: fresh.providerEnv }
    }
    await fsp.mkdir(dataDir, { recursive: true })
    await touch('pool-profile.json', 'settings.json')
    await writeAtomic(stashFile, JSON.stringify(stash, null, 2) + '\n', 0o600)
    await writeAtomic(settingsFile(), serializeLike(settings.text, { ...settings.json, env }))
    return stripJobs(jobs, touch)
  }

  const hasPool = (s) => {
    const flags = Array.isArray(s.respawnFlags) ? s.respawnFlags : []
    return JSON.stringify(stripPoolModel(flags)) !== JSON.stringify(flags) || POOL_KEYS.some((k) => Object.hasOwn(s.providerEnv || {}, k))
  }

  /** Remove the pool model flag and pool env from each job's saved settings. -> the jobs that changed. */
  async function stripJobs(jobs, touch) {
    const changed = []
    for (const j of jobs) {
      const text = await fsp.readFile(j.file, 'utf8')
      const state = JSON.parse(text)
      if (!hasPool(state)) continue
      if (Array.isArray(state.respawnFlags)) state.respawnFlags = stripPoolModel(state.respawnFlags)
      if (state.providerEnv && typeof state.providerEnv === 'object') {
        for (const k of POOL_KEYS) delete state.providerEnv[k]
      }
      await touch(`jobs/${j.short}.json`)
      await writeAtomic(j.file, serializeLike(text, state))
      changed.push(j.short)
    }
    return changed
  }

  /**
   * Already on a personal login, switching to another: a job can still carry pool settings (it was
   * not running at the first switch, or was added since). Stash its originals next to the others so
   * going back to the pool restores them, then clean it like the rest. -> the jobs that changed.
   */
  async function catchUpToPersonal(jobs, touch) {
    const left = []
    for (const j of jobs) {
      const s = JSON.parse(await fsp.readFile(j.file, 'utf8'))
      if (hasPool(s)) left.push({ j, s })
    }
    if (!left.length) return []
    const stash = JSON.parse(await fsp.readFile(stashFile, 'utf8').catch(() => 'null'))
    if (stash) {
      stash.jobs ||= {}
      for (const { j, s } of left) stash.jobs[j.short] ??= { respawnFlags: s.respawnFlags, providerEnv: s.providerEnv }
      await touch('pool-profile.json')
      await writeAtomic(stashFile, JSON.stringify(stash, null, 2) + '\n', 0o600)
    }
    return stripJobs(left.map((x) => x.j), touch)
  }

  /** Put the stashed pool env and each job's stashed settings back. */
  async function applyToPool(jobs, touch) {
    const stash = JSON.parse(await fsp.readFile(stashFile, 'utf8'))
    const settings = await readSettings()
    const current = settings.json.env || {}
    // Original key order first, then anything added while on the personal account.
    const env = {}
    for (const k of stash.envOrder || []) {
      if (Object.hasOwn(stash.env, k)) env[k] = stash.env[k]
      else if (Object.hasOwn(current, k)) env[k] = current[k]
    }
    for (const [k, v] of Object.entries(current)) if (!Object.hasOwn(env, k)) env[k] = v
    for (const [k, v] of Object.entries(stash.env)) if (!Object.hasOwn(env, k)) env[k] = v
    await touch('settings.json', 'pool-profile.json')
    await writeAtomic(settingsFile(), serializeLike(settings.text, { ...settings.json, env }))
    for (const j of jobs) {
      const saved = stash.jobs?.[j.short]
      if (!saved) continue
      await touch(`jobs/${j.short}.json`)
      await restoreJobFields(j.file, saved)
    }
    await fsp.rm(stashFile, { force: true })
  }

  /**
   * The direct check after a credential swap: is Claude's live login `expectedId`? Uses
   * accounts.checkActive (reads the stored login back and asks the API whose it is; never throws,
   * never refreshes a token). -> `{ ok }` | `{ ok: false, wrong, reason }`. Only `wrong` (a
   * different account, or no login stored, or 'login rejected' while the stored token's `expiresAt`
   * is more than a minute away: revoked) means the swap failed. Anything else ('login rejected' on
   * an expired token Claude refreshes on its next request; no network; rate limited) leaves the
   * switch in place, unverified. Without
   * checkActive, the stored login is read back and identified.
   */
  async function checkLogin(expectedId) {
    const WRONG = new Set(['signed in to a different account', 'no login stored'])
    try {
      if (typeof accounts.checkActive === 'function') {
        const r = await accounts.checkActive(expectedId)
        if (r?.ok === true) return { ok: true }
        const reason = typeof r?.reason === 'string' ? r.reason.slice(0, 200) : 'unexpected response from Anthropic'
        // Rejected although its access token is not about to expire: revoked, not merely stale.
        if (reason === 'login rejected' && Number(r?.expiresAt) > Date.now() + 60_000) return { ok: false, wrong: true, reason: 'login rejected (revoked)' }
        return { ok: false, wrong: WRONG.has(reason), reason }
      }
      let text
      // An unreadable store (Keychain error) is unknown, never "no login stored".
      try { text = await accounts.readLive() } catch { return { ok: false, wrong: false, reason: 'could not read the login' } }
      if (!text) return { ok: false, wrong: true, reason: 'no login stored' }
      const id = await accounts.identify(text, { network: true })
      if (id === expectedId) return { ok: true }
      return id ? { ok: false, wrong: true, reason: 'signed in to a different account' } : { ok: false, wrong: false, reason: 'unexpected response from Anthropic' }
    } catch {
      return { ok: false, wrong: false, reason: 'could not reach Anthropic' }
    }
  }

  // Restarts waiting for their job to reach a turn boundary: short -> { short, deadline, why }.
  const restartQueue = new Map()
  // Jobs given up on (still busy at the deadline): restart by hand. Cleared when restarted or switched again.
  let pendingRestarts = []
  let draining = null

  /** Respawn one job now. -> a result `{ id, status, detail? }`; a failure never throws. */
  async function respawn(bin, short) {
    const r = await runCmd(bin, ['respawn', short], RESPAWN_MS)
    if (r.code === 0) return { id: short, status: 'respawned' }
    if (/another terminal/i.test(`${r.stderr}\n${r.stdout}`)) return { id: short, status: 'skipped', detail: 'Open in a terminal: restart it there' }
    const line = stderrLine(r.stderr)
    const detail = r.timedOut ? 'Respawn timed out' : `Respawn failed (exit ${r.code})${line ? `: ${line}` : ''}`
    console.warn(`[account] respawn ${short} failed: ${detail}`)
    return { id: short, status: 'failed', detail }
  }

  /**
   * One pass over the queue: restart each job that is idle now, drop the ones no longer running,
   * and give up on the ones past their deadline (left "restart pending"). -> results of this pass.
   */
  async function restartPass(bin, { inSwitch = false } = {}) {
    const out = []
    for (const q of [...restartQueue.values()]) {
      // From the background: stop at once if a switch or Undo started, or took this job off the queue.
      if ((!inSwitch && busy) || !restartQueue.has(q.short)) continue
      // A permission-mode switch is restarting this job itself: treat it as busy until that is done.
      const st = permBusyJob(q.short) ? 'busy' : await jobState(q.short)
      if (st === 'busy') {
        if (clock() < q.deadline) continue
        restartQueue.delete(q.short)
        const r = { id: q.short, status: 'pending', detail: `Still busy after ${Math.round(idleMs() / 60_000)} min: restart pending, restart it when it finishes` }
        pendingRestarts = pendingRestarts.filter((p) => p.id !== q.short).concat(r)
        out.push(r)
        continue
      }
      restartQueue.delete(q.short)
      if (st === 'gone') { out.push({ id: q.short, status: 'skipped', detail: 'No longer running: it picks the new settings up when it next starts' }); continue }
      out.push(await respawn(bin, q.short))
    }
    return out
  }

  /** Keep polling the queue in the background until it is empty; one restart log entry at the end. */
  function drain(bin) {
    if (draining || !restartQueue.size) return draining
    draining = (async () => {
      const results = []
      try {
        while (restartQueue.size) {
          await nap(everyMs())
          if (busy) continue // a switch is writing files: never restart in the middle of one
          results.push(...await restartPass(bin))
        }
      } catch (e) {
        console.warn(`[account] restart queue stopped: ${e?.message ? stderrLine(e.message) : 'error'}`)
        restartQueue.clear()
      } finally {
        draining = null
        if (results.length) await audit({ action: 'restart', results }).catch(() => {})
      }
      return results
    })()
    return draining
  }

  /** restore(dir) that never throws: `{ ok, extra }` (`extra` goes into the audit entry). */
  async function safeRestore(dir) {
    try { await restore(dir); return { ok: true, extra: {} } } catch (e) {
      const detail = e?.message ? stderrLine(e.message) : 'error'
      console.warn(`[account] restore failed: ${detail}`)
      return { ok: false, extra: { restoreFailed: detail } }
    }
  }

  // The last switch that went through: `{ at, kind: 'account' | 'profile', target, respawned, drift }`
  // (`target`: the account it landed on, null for the pool). Cleared by Undo.
  let lastSwitch = null
  let lastAgents = []
  const STALE_MS = 10 * 60_000

  /**
   * Claude's live login is `liveId`: if that isn't the account the last switch landed on, someone
   * or something changed it since (a `claude auth login`, a refresh gone wrong). Logged once per
   * switch and live account. -> true when it differs.
   */
  async function noteDrift(liveId) {
    if (!lastSwitch?.target || !liveId || liveId === lastSwitch.target) return false
    if (lastSwitch.drift === liveId) return true
    lastSwitch.drift = liveId
    await audit({ action: 'drift', expected: lastSwitch.target, live: liveId, switchAt: lastSwitch.at }).catch(() => {})
    return true
  }

  /**
   * Jobs that stopped on the usage limit soon after an account -> account switch, while the new
   * account still has room, most likely still hold the old login in memory. Call this (autoswitch's
   * sampler) with those agents' ids: each live background job among them is put on the idle-gated
   * restart queue (restarted at its next turn boundary, like any switch restart), once per switch.
   * Only within STALE_MS of an account -> account switch; a limit stop recorded (`limitStopAt`)
   * before the switch doesn't count. `agents`: the scan's agents (default: the ones the switch saw).
   * -> `{ queued: [short], reason? }`.
   */
  async function respawnStale(agentIds, agents = lastAgents) {
    if (isBlocked()) return { queued: [], reason: 'blocked' }
    if (!lastSwitch || lastSwitch.kind !== 'account' || clock() - lastSwitch.at > STALE_MS) return { queued: [], reason: 'no recent account switch' }
    if (busy || permBusy()) return { queued: [], reason: 'busy' }
    const want = new Set(Array.isArray(agentIds) ? agentIds : [])
    const picked = (agents || []).filter((a) => a && want.has(a.id) && a.jobId && a.live && !((a.limitStopAt || 0) && a.limitStopAt <= lastSwitch.at))
    if (!picked.length) return { queued: [] }
    const bin = await findBin()
    if (!bin) return { queued: [], reason: 'Claude Code CLI not found' }
    const sw = lastSwitch
    const { jobs } = await splitLive(picked, await activeJobs(new Set(picked.map((a) => a.jobId))))
    // A switch or Undo may have started while the files were read: it decides the restarts then.
    if (busy || permBusy() || lastSwitch !== sw) return { queued: [], reason: 'busy' }
    const queued = []
    for (const j of jobs) {
      if (lastSwitch.respawned.has(j.short) || restartQueue.has(j.short) || permBusyJob(j.short)) continue
      lastSwitch.respawned.add(j.short)
      pendingRestarts = pendingRestarts.filter((p) => p.id !== j.short)
      restartQueue.set(j.short, { short: j.short, deadline: clock() + idleMs() })
      queued.push(j.short)
    }
    if (!queued.length) return { queued }
    await audit({ action: 'stale-respawn', queued, switchAt: lastSwitch.at }).catch(() => {})
    drain(bin)
    return { queued }
  }

  /**
   * `{ to, confirm }` -> `{ to, results: [{id, status, detail?}], restored, sessions, reason? }`. `to`
   * is 'pool', 'personal' (whatever login Claude has stored) or a saved account id. Result statuses:
   * 'respawned', 'waiting' (busy now: restarted at its next turn boundary, see `settled()`),
   * 'unchanged' (an account switch that left the job alone: it picks the new login up itself),
   * 'skipped', 'failed' (its respawn failed; the switch went on). `meta`: `{ auto, why }` from
   * autoswitch, written to the audit log (`why`: reason, readings, limit-hit agent ids).
   */
  async function switchTo(body, agents, { auto = false, why } = {}) {
    const blocked = isBlocked()
    if (blocked) throw fail(501, blocked)
    const saved = await accounts.load()
    if (!body || !(['pool', 'personal'].includes(body.to) || saved.some((a) => a.id === body.to))) throw fail(400, 'to must be "pool", "personal" or a saved account id')
    const target = saved.find((a) => a.id === body.to)
    if (target?.quarantine && (await network?.onWork())) throw fail(409, `${target.label} is a quarantine account, and quarantine accounts can't be used on the work Wi-Fi.`)
    if (busy) throw fail(409, 'A switch is already running')
    if (permBusy()) throw fail(409, 'A permission-mode switch is running')
    const now = Date.now()
    while (switches.length && now - switches[0] > 60_000) switches.shift()
    if (switches.length >= 3) throw fail(429, 'Too many switches; wait a minute')
    busy = true
    const meta = { auto: auto === true, ...(plainWhy(why) && { why: plainWhy(why) }) }
    try {
      const settings = await readSettings()
      const from = profileOf(settings)
      const toProfile = body.to === 'pool' ? 'pool' : 'personal'
      // Which saved account Claude's stored login is (it may have rotated since it was saved).
      // readLive throws (503 'unreadable') when the store can't be read: that is not "no login".
      // Without the current login there is nothing to back up or roll back to, so no switch runs.
      let liveText
      try { liveText = await accounts.readLive() } catch (e) {
        if (auto) throw fail(409, 'Current login not recognised')
        throw Object.assign(fail(e?.status || 503, "Couldn't read Claude's current login; nothing was changed"), { code: e?.code || 'unreadable' })
      }
      const liveId = liveText ? await accounts.identify(liveText, { network: true }).catch(() => null) : null
      // An automatic switch never runs on a login it can't name: the backup and Undo would be guesses.
      if (auto && liveText && !liveId) throw fail(409, 'Current login not recognised')
      if (liveId) await noteDrift(liveId)
      // A saved account that isn't the stored login needs its credential written in.
      const toAccount = toProfile === 'personal' && body.to !== 'personal' && body.to !== liveId ? body.to : null
      if (toProfile === from && !toAccount) throw fail(409, body.to === 'personal' || from === 'pool' ? `Already on the ${from === 'pool' ? 'pool' : 'personal account'}` : 'Already on that account')
      // Every non-finished job gets the new settings (so a later restart uses them), but only the
      // ones running now are restarted: a switch must never revive a dormant job.
      const liveIds = new Set(agents.filter((a) => a.jobId && a.live).map((a) => a.jobId))
      const allJobs = await activeJobs(liveIds)
      const { jobs, sessions } = await splitLive(agents, allJobs)
      // An automatic switch (autoswitch.mjs) is decided on the server and has no preview to confirm.
      const plan = typeof body.confirm === 'string' && plans.get(body.confirm)
      if (!auto && (!plan || Date.now() > plan.expires || plan.jobs !== jobs.map((j) => j.short).sort().join(','))) {
        throw fail(409, 'This preview has expired. Open it again.')
      }
      if (body.to === 'personal' && from === 'pool' && (await personalReady(from)) === false) throw fail(409, 'Run `claude auth login` with your personal account first')
      if (body.to === 'pool' && !fs.existsSync(stashFile)) throw fail(409, 'No saved pool profile to restore')
      const bin = await findBin()
      if (!bin) throw fail(409, 'Claude Code CLI not found')
      if (!auto) plans.delete(body.confirm)
      switches.push(now)

      const { dir, touch } = await backup(allJobs, `switch to ${toAccount ? 'account' : body.to}`, { text: liveText, id: liveId })
      let changedJobs
      try {
        // The stored login's tokens may have rotated since it was saved: keep its slot current.
        await accounts.syncSlot(liveId, liveText)
        if (toAccount) { await touch('credential.json', 'oauth-account.json'); await accounts.activate(toAccount) }
        if (toProfile !== from) changedJobs = toProfile === 'personal' ? await applyToPersonal(allJobs, touch) : (await applyToPool(allJobs, touch), null)
        else changedJobs = await catchUpToPersonal(allJobs, touch)
      } catch (e) {
        // activate refused before writing anything (the target's token expired and couldn't be refreshed).
        const untouched = e?.code === 'login_expired' || e?.code === 'refresh_failed'
        const back = untouched ? { ok: true, extra: {} } : await safeRestore(dir)
        await audit({ action: 'switch', from, to: toProfile, account: toAccount, ...meta, restored: back.ok, ...back.extra, ...(typeof e?.code === 'string' && { code: e.code }), results: [] })
        const err = fail(e?.status || 500, `Couldn't change the login, nothing was restarted (${e?.status ? e.message : 'write failed'})${back.ok ? '' : '; putting it back also failed, use Undo'}`)
        // A coded error (login_expired, refresh_failed, too_big with size/max) keeps its fields for autoswitch.
        if (typeof e?.code === 'string') Object.assign(err, { code: e.code }, e.size !== undefined && { size: e.size }, e.max !== undefined && { max: e.max })
        throw err
      }

      // The direct check, before anything is restarted: the live login is the account asked for.
      const expected = toAccount || (toProfile === 'personal' ? liveId : null)
      let verified = null
      if (expected) {
        const check = await checkLogin(expected)
        verified = check.ok ? { verified: true } : { verified: false, note: check.reason }
        if (!check.ok && check.wrong) {
          const back = await safeRestore(dir)
          const reason = back.ok ? `The new login couldn't be confirmed (${check.reason}); everything was put back`
            : `The new login couldn't be confirmed (${check.reason}), and putting it back failed: use Undo`
          await audit({ action: 'switch', from, to: toProfile, account: toAccount, ...meta, ...verified, restored: back.ok, ...back.extra, reason, results: [] })
          return { to: body.to, restored: back.ok, reason, results: [], sessions: [] }
        }
      }

      // What needs a restart: a pool <-> personal change restarts every live job (the process read
      // its env at start); an account -> account switch only the jobs whose settings changed.
      const restartIds = new Set(toProfile !== from ? jobs.map((j) => j.short) : jobs.filter((j) => changedJobs.includes(j.short)).map((j) => j.short))
      pendingRestarts = pendingRestarts.filter((p) => !restartIds.has(p.id))
      for (const id of restartIds) restartQueue.set(id, { short: id, deadline: clock() + idleMs() })
      const first = await restartPass(bin, { inSwitch: true })
      const byId = new Map(first.map((r) => [r.id, r]))
      const results = jobs.map((j) => byId.get(j.short)
        || (restartQueue.has(j.short) ? { id: j.short, status: 'waiting', detail: `Busy: restarts at its next turn boundary (up to ${Math.round(idleMs() / 60_000)} min)` }
          : { id: j.short, status: 'unchanged', detail: 'Not restarted: it uses the new login on its next request' }))
      await audit({ action: 'switch', from, to: toProfile, account: toAccount, ...meta, ...verified, restored: false, results })
      lastAgents = agents
      lastSwitch = { at: clock(), kind: toProfile === from ? 'account' : 'profile', target: expected, respawned: new Set(), drift: null }
      busy = false
      drain(bin)
      return { to: body.to, restored: false, results, sessions, ...verified }
    } finally { busy = false }
  }

  /** Resolves when no restart is waiting any more, with that background pass's results ([] if none). */
  const settled = async () => (draining ? draining : [])

  /** Put back what the newest backup set's switch changed (files only; nothing is respawned). */
  async function undo() {
    const blocked = isBlocked()
    if (blocked) throw fail(501, blocked)
    if (busy) throw fail(409, 'A switch is already running')
    if (permBusy()) throw fail(409, 'A permission-mode switch is running')
    const sets = (await fsp.readdir(backupRoot).catch(() => [])).sort()
    if (!sets.length) throw fail(409, 'Nothing to undo')
    // Undo would put a quarantine account's login back: not on the work Wi-Fi.
    const prev = JSON.parse(await fsp.readFile(path.join(backupRoot, sets.at(-1), 'meta.json'), 'utf8').catch(() => '{}')).credentialAccount
    const q = prev && (await accounts.load()).find((x) => x.id === prev && x.quarantine)
    if (q && (await network?.onWork())) throw fail(409, `Undo would switch back to ${q.label}, a quarantine account, and quarantine accounts can't be used on the work Wi-Fi.`)
    busy = true
    try {
      // The switch being undone no longer needs its restarts.
      restartQueue.clear()
      pendingRestarts = []
      lastSwitch = null
      const meta = await restore(path.join(backupRoot, sets.at(-1)))
      const profile = profileOf(await readSettings())
      await audit({ action: 'undo', backup: sets.at(-1), profile })
      return { profile, restoredFrom: meta.reason }
    } finally { busy = false }
  }

  return { status, switchTo, undo, settled, respawnStale, noteDrift, accounts, isBusy: () => busy, lastChangeAt, poolAvailable: () => fs.existsSync(stashFile), profile: async () => profileOf(await readSettings()) }
}
