/**
 * Switch every agent between the shared "pool" gateway and the user's Claude accounts.
 *
 * The pool lives in `<claude home>/settings.json` → `env` (gateway URL, token, model aliases).
 * Switching to personal moves those keys into `<data>/pool-profile.json` (0600), strips the
 * gateway-only `cc/` model alias from each running background job's saved respawn flags and
 * provider env, then `claude respawn`s the jobs one at a time; switching back restores exactly
 * what was stashed. Switching between saved accounts (server/accounts.mjs) swaps the login in
 * Claude's credential store and respawns the running jobs; settings don't change. Every edit is
 * preceded by a backup set (including Claude's credential), the first respawn is a canary that
 * rolls everything back on failure, and no env value or token is ever returned or logged.
 * Interactive sessions are never touched: they are listed for the user to restart.
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
/** How long the canary gets to come back, then to show its first reply (tests shorten both). */
const verifyMs = () => Number(process.env.AGENTVILLE_ACCOUNT_VERIFY_MS) || 60_000
const replyMs = () => Number(process.env.AGENTVILLE_ACCOUNT_REPLY_MS) || 20_000
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

/** `network`: createNetwork(), so a quarantine account is never switched to on the work Wi-Fi. */
export function createAccount({ dataDir, claudeHome, onReading, network }) {
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
  const accounts = createAccounts({
    dataDir, claudeHome, exclusive, onReading,
    poolState: async () => ({ active: profileOf(await readSettings()) === 'pool', available: fs.existsSync(stashFile) }),
  })

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
    const bin = await claudeBin()
    if (!bin) return false
    const r = await run(bin, ['auth', 'status', '--json'], 15_000)
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
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], 5_000)
    return r.code === 0
  }

  /** What a switch would do. `agents` (from the scan) supply names, liveness and interactive sessions. */
  async function status(agents) {
    const blocked = switchingBlocked()
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
    }
  }

  /** `cred`: Claude's live credential now `{ text, id }`, kept 0600 so a rollback or Undo restores it. */
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
    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ at: Date.now(), reason, files, credentialAccount: cred.id || null }) + '\n', { mode: 0o600 })
    return dir
  }

  /** Put every file in a backup set back exactly; a stash that didn't exist then is removed. */
  async function restore(dir) {
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'))
    for (const f of meta.files) {
      const text = await fsp.readFile(path.join(dir, f), 'utf8')
      if (f === 'credential.json') { await accounts.restoreLive(text, meta.credentialAccount); continue }
      if (f === 'oauth-account.json') { await accounts.writeOauthAccount(JSON.parse(text)); continue }
      const target = f === 'settings.json' ? settingsFile()
        : f === 'pool-profile.json' ? stashFile
        : path.join(jobsDir(), path.basename(f, '.json'), 'state.json')
      await writeAtomic(target, text, f === 'pool-profile.json' ? 0o600 : undefined)
    }
    if (!meta.files.includes('pool-profile.json')) await fsp.rm(stashFile, { force: true })
    return meta
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

  async function applyToPersonal(jobs) {
    const settings = await readSettings() // re-read just before writing
    const env = settings.json.env || {}
    const stash = { savedAt: Date.now(), envOrder: Object.keys(env), env: {}, jobs: {} }
    for (const k of POOL_KEYS) if (Object.hasOwn(env, k)) { stash.env[k] = env[k]; delete env[k] }
    for (const j of jobs) {
      const fresh = JSON.parse(await fsp.readFile(j.file, 'utf8'))
      stash.jobs[j.short] = { respawnFlags: fresh.respawnFlags, providerEnv: fresh.providerEnv }
    }
    await fsp.mkdir(dataDir, { recursive: true })
    await writeAtomic(stashFile, JSON.stringify(stash, null, 2) + '\n', 0o600)
    await writeAtomic(settingsFile(), serializeLike(settings.text, { ...settings.json, env }))
    await stripJobs(jobs)
  }

  /** Remove the pool model flag and pool env from each job's saved settings (a no-op when clean). */
  async function stripJobs(jobs) {
    for (const j of jobs) {
      const text = await fsp.readFile(j.file, 'utf8')
      const state = JSON.parse(text)
      if (Array.isArray(state.respawnFlags)) state.respawnFlags = stripPoolModel(state.respawnFlags)
      if (state.providerEnv && typeof state.providerEnv === 'object') {
        for (const k of POOL_KEYS) delete state.providerEnv[k]
      }
      await writeAtomic(j.file, serializeLike(text, state))
    }
  }

  /**
   * Already on a personal login, switching to another: a job can still carry pool settings (it was
   * not running at the first switch, or was added since). Stash its originals next to the others so
   * going back to the pool restores them, then clean it like the rest.
   */
  async function catchUpToPersonal(jobs) {
    const left = []
    for (const j of jobs) {
      const s = JSON.parse(await fsp.readFile(j.file, 'utf8'))
      const flags = Array.isArray(s.respawnFlags) ? s.respawnFlags : []
      if (JSON.stringify(stripPoolModel(flags)) !== JSON.stringify(flags) || POOL_KEYS.some((k) => Object.hasOwn(s.providerEnv || {}, k))) left.push({ j, s })
    }
    if (!left.length) return
    const stash = JSON.parse(await fsp.readFile(stashFile, 'utf8').catch(() => 'null'))
    if (stash) {
      stash.jobs ||= {}
      for (const { j, s } of left) stash.jobs[j.short] ??= { respawnFlags: s.respawnFlags, providerEnv: s.providerEnv }
      await writeAtomic(stashFile, JSON.stringify(stash, null, 2) + '\n', 0o600)
    }
    await stripJobs(left.map((x) => x.j))
  }

  async function applyToPool(jobs) {
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
    await writeAtomic(settingsFile(), serializeLike(settings.text, { ...settings.json, env }))
    for (const j of jobs) {
      const saved = stash.jobs?.[j.short]
      if (!saved) continue
      const text = await fsp.readFile(j.file, 'utf8')
      const state = JSON.parse(text)
      if (saved.respawnFlags === undefined) delete state.respawnFlags; else state.respawnFlags = saved.respawnFlags
      if (saved.providerEnv === undefined) delete state.providerEnv; else state.providerEnv = saved.providerEnv
      await writeAtomic(j.file, serializeLike(text, state))
    }
    await fsp.rm(stashFile, { force: true })
  }

  const backSince = (job, state, since) => liveSince(claudeHome(), job.short, state, since)

  async function transcriptFor(sid) {
    const projects = path.join(claudeHome(), 'projects')
    for (const d of await fsp.readdir(projects).catch(() => [])) {
      const f = path.join(projects, d, `${sid}.jsonl`)
      if (fs.existsSync(f)) return f
    }
    return null
  }

  /**
   * After the canary's respawn: (1) it comes back live, (2) its saved flags still carry our edit,
   * (3) its first new reply, if one arrives, is not a synthetic API-error message (the sign that the
   * new account can't serve it). Only `message.model` is read from the transcript. The model id
   * can't tell pool from personal (the gateway reports plain ids too), so it isn't compared.
   * Returns '' when verified, else which check failed; `note` says whether a reply was seen.
   */
  async function verifyCanary(job, to, since, poolFlags) {
    const wantPool = to === 'pool'
    let state = JSON.parse(await fsp.readFile(job.file, 'utf8'))
    const until = Date.now() + verifyMs()
    while (!(await backSince(job, state, since))) {
      if (Date.now() > until) return { failed: "Verification failed: the first job didn't come back within the time limit" }
      await sleep(300)
    }
    state = JSON.parse(await fsp.readFile(job.file, 'utf8'))
    const flags = state.respawnFlags || []
    const models = flags.flatMap((f, i) => (flags[i - 1] === '--model' ? [f] : f.startsWith('--model=') ? [f.slice(8)] : []))
    const poolEnvLeft = POOL_KEYS.some((k) => Object.hasOwn(state.providerEnv || {}, k))
    if (!wantPool && (models.some((m) => m.startsWith('cc/')) || poolEnvLeft)) {
      return { failed: "Verification failed: the job's saved settings were changed back" }
    }
    if (wantPool && poolFlags && JSON.stringify(poolFlags) !== JSON.stringify(state.respawnFlags)) {
      return { failed: "Verification failed: the job's saved settings were changed back" }
    }
    const file = await transcriptFor(state.resumeSessionId || state.sessionId)
    const replyUntil = Date.now() + replyMs()
    while (file && Date.now() < replyUntil) {
      const text = await fsp.readFile(file, 'utf8').catch(() => '')
      for (const line of text.split('\n')) {
        if (!line.includes('"assistant"')) continue
        let r
        try { r = JSON.parse(line) } catch { continue }
        if (r.type !== 'assistant' || r.isSidechain || (Date.parse(r.timestamp) || 0) < since) continue
        if (r.message?.model === '<synthetic>' || r.isApiErrorMessage === true) return { failed: 'Verification failed: the first reply after the restart was an API error' }
        return { failed: '', note: 'reply seen' }
      }
      await sleep(300)
    }
    return { failed: '', note: 'no reply yet (job idle)' }
  }

  /**
   * `{ to, confirm }` -> `{ to, results: [{id, status, detail?}], restored, sessions }`. `to` is
   * 'pool', 'personal' (whatever login Claude has stored) or a saved account id.
   */
  async function switchTo(body, agents, { auto = false } = {}) {
    const blocked = switchingBlocked()
    if (blocked) throw fail(501, blocked)
    const saved = await accounts.load()
    if (!body || !(['pool', 'personal'].includes(body.to) || saved.some((a) => a.id === body.to))) throw fail(400, 'to must be "pool", "personal" or a saved account id')
    const target = saved.find((a) => a.id === body.to)
    if (target?.quarantine && (await network?.onWork())) throw fail(409, `${target.label} is a quarantine account, and quarantine accounts can't be used on the work Wi-Fi.`)
    if (busy) throw fail(409, 'A switch is already running')
    const now = Date.now()
    while (switches.length && now - switches[0] > 60_000) switches.shift()
    if (switches.length >= 3) throw fail(429, 'Too many switches; wait a minute')
    busy = true
    try {
      const settings = await readSettings()
      const from = profileOf(settings)
      const toProfile = body.to === 'pool' ? 'pool' : 'personal'
      // Which saved account Claude's stored login is (it may have rotated since it was saved).
      const liveText = await accounts.readLive()
      const liveId = liveText ? await accounts.identify(liveText, { network: true }).catch(() => null) : null
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
      const bin = await claudeBin()
      if (!bin) throw fail(409, 'Claude Code CLI not found')
      if (!auto) plans.delete(body.confirm)
      switches.push(now)

      const stashCopy = body.to === 'pool' ? JSON.parse(await fsp.readFile(stashFile, 'utf8')) : null
      const stashedJob = (short) => stashCopy?.jobs?.[short] || null
      const dir = await backup(allJobs, `switch to ${toAccount ? 'account' : body.to}`, { text: liveText, id: liveId })
      try {
        // The stored login's tokens may have rotated since it was saved: keep its slot current.
        await accounts.syncSlot(liveId, liveText)
        if (toAccount) await accounts.activate(toAccount)
        if (toProfile !== from) await (toProfile === 'personal' ? applyToPersonal(allJobs) : applyToPool(allJobs))
        else if (toProfile === 'personal') await catchUpToPersonal(allJobs)
      } catch (e) {
        await restore(dir)
        await audit({ action: 'switch', from, to: toProfile, account: toAccount, restored: true, results: [] })
        throw fail(500, `Couldn't change the login, nothing was restarted (${e.status ? e.message : 'write failed'})`)
      }

      const results = []
      let tested = false // the first job actually restarted is the canary
      for (const j of jobs) {
        const since = Date.now()
        const r = await run(bin, ['respawn', j.short], RESPAWN_MS)
        // Reopened in a terminal since the preview: the user restarts it there; not a failure.
        if (r.code !== 0 && /another terminal/i.test(r.stderr + r.stdout)) {
          results.push({ id: j.short, status: 'skipped', detail: 'Open in a terminal: restart it there' })
          continue
        }
        const i = tested ? 1 : 0
        tested = true
        let detail = r.code === 0 ? '' : r.timedOut ? 'Respawn timed out' : `Respawn failed (exit ${r.code})`
        let verified
        if (!detail && i === 0) {
          verified = await verifyCanary(j, toProfile, since, stashedJob(j.short)?.respawnFlags)
          detail = verified.failed
        }
        if (!detail) { results.push({ id: j.short, status: 'respawned', ...(verified?.note && { verified: verified.note }) }); continue }
        results.push({ id: j.short, status: 'failed', detail })
        if (i === 0) {
          // The canary failed: put every file back as it was and stop. If its respawn itself had
          // succeeded (only verification failed), it is now running on the new settings, so it is
          // respawned once more onto the restored ones (best effort, no retry).
          await restore(dir)
          if (r.code === 0) {
            const again = await run(bin, ['respawn', j.short], RESPAWN_MS)
            results.at(-1).restarted = again.code === 0 ? 'back on the previous settings' : 'could not be restarted; restart it by hand'
          }
          for (const rest of jobs.slice(jobs.indexOf(j) + 1)) results.push({ id: rest.short, status: 'skipped', detail: 'Not attempted after the first respawn failed' })
          await audit({ action: 'switch', from, to: toProfile, account: toAccount, ...(auto && { auto }), restored: true, results })
          return { to: body.to, restored: true, results, sessions: [] }
        }
      }
      await audit({ action: 'switch', from, to: toProfile, account: toAccount, ...(auto && { auto }), restored: false, results })
      return { to: body.to, restored: false, results, sessions }
    } finally { busy = false }
  }

  /** Put back the newest backup set (files only; nothing is respawned). */
  async function undo() {
    const blocked = switchingBlocked()
    if (blocked) throw fail(501, blocked)
    if (busy) throw fail(409, 'A switch is already running')
    const sets = (await fsp.readdir(backupRoot).catch(() => [])).sort()
    if (!sets.length) throw fail(409, 'Nothing to undo')
    // Undo would put a quarantine account's login back: not on the work Wi-Fi.
    const prev = JSON.parse(await fsp.readFile(path.join(backupRoot, sets.at(-1), 'meta.json'), 'utf8').catch(() => '{}')).credentialAccount
    const q = prev && (await accounts.load()).find((x) => x.id === prev && x.quarantine)
    if (q && (await network?.onWork())) throw fail(409, `Undo would switch back to ${q.label}, a quarantine account, and quarantine accounts can't be used on the work Wi-Fi.`)
    busy = true
    try {
      const meta = await restore(path.join(backupRoot, sets.at(-1)))
      const profile = profileOf(await readSettings())
      await audit({ action: 'undo', backup: sets.at(-1), profile })
      return { profile, restoredFrom: meta.reason }
    } finally { busy = false }
  }

  return { status, switchTo, undo, accounts, isBusy: () => busy, lastChangeAt, poolAvailable: () => fs.existsSync(stashFile), profile: async () => profileOf(await readSettings()) }
}
