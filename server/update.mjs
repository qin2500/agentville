/**
 * Update check: is this git checkout behind GitHub's `main`, and (when it's safe) update it in place.
 *
 * Shortly after start, then every 30 minutes, the server compares its own checkout's HEAD with `main`
 * on GitHub through the public API, without auth: one GET whose URL carries the local commit sha
 * and nothing else. Offline, rate limits and unknown commits are expected: the last good answer is
 * kept and the next try backs off.
 *
 * Env: AGENTVILLE_UPDATE_CHECK=0 turns it off; AGENTVILLE_AUTO_UPDATE=0 makes automatic updating off by default (the setting still wins once saved). AGENTVILLE_UPDATE_REPO (owner/repo) and
 * AGENTVILLE_UPDATE_API (base URL) override what is checked; AGENTVILLE_UPDATE_DIR, the checkout.
 * Under test (AGENTVILLE_TEST=1 / NODE_ENV=test) it never calls the network unless
 * AGENTVILLE_UPDATE_API is set, and never updates this install's own checkout.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://api.github.com'
const USER_AGENT = 'agentville-update-check'
const EVERY_MS = 30 * 60e3
/** Automatic updates wait for open in-app terminals this long, then go ahead anyway. */
export const DEFER_CAP_MS = 3 * 3600e3
const FIRST_MS = 15_000
const OFFLINE_RETRY_MS = 30 * 60e3
const MIN_FRESH_MS = 60e3
const MAX_CHANGES = 10
const MAX_TITLE = 120
// node --test marks its children with NODE_TEST_CONTEXT: a unit test that forgot AGENTVILLE_TEST still counts.
const testing = (env) => env.AGENTVILLE_TEST === '1' || env.NODE_ENV === 'test' || !!env.NODE_TEST_CONTEXT
const short = (sha) => (sha || '').slice(0, 7)

/** owner/repo from a GitHub URL (https, ssh or git+https), else null. */
export function githubRepo(url) {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim())
  return m ? `${m[1]}/${m[2]}` : null
}
const validRepo = (r) => (typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null)

/** The first line of a commit message, trimmed to a length a dialog can show. */
export function title(message) {
  const line = String(message || '').split('\n')[0].trim()
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line
}

/**
 * The commands that install and build, as { cmd, args, env } each. Elsewhere that is plain npm.
 * On Windows nothing goes through npm.cmd (Node 20+ refuses to spawn a .cmd without a shell, and
 * through cmd it has hit a %~dp0 MODULE_NOT_FOUND): npm's own npm-cli.js and vite's vite.js run
 * with this node, as server/cli.mjs does. Under Electron that node is the app binary, so those
 * children (and only they) get ELECTRON_RUN_AS_NODE=1.
 */
export function installCommands({ platform = process.platform, execPath = process.execPath, npm = 'npm', env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') {
    return { ci: { cmd: npm, args: ['ci', '--no-audit', '--no-fund'] }, build: [{ cmd: npm, args: ['run', 'build'] }] }
  }
  const p = path.win32
  const nodeDir = p.dirname(execPath)
  const cli = [p.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), p.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  const npmCli = cli.find((c) => exists(c)) || cli[0]
  const childEnv = env.AGENTVILLE_DESKTOP === '1' || process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  const node = (...args) => ({ cmd: execPath, args, env: childEnv })
  return {
    ci: node(npmCli, 'ci', '--no-audit', '--no-fund'),
    // The build script is prebuild (the mods index) then `vite build web`.
    build: [node(p.join('tools', 'mods-index.mjs')), node(p.join('node_modules', 'vite', 'bin', 'vite.js'), 'build', 'web')],
  }
}

/** True when a `git diff --name-only` listing names something under desktop/. */
export const touchesDesktop = (names) => String(names || '').split(/\r?\n/).some((l) => /^desktop\//.test(l.trim()))

function run(cmd, args, { cwd, timeout = 30_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    // GIT_TERMINAL_PROMPT=0: a remote that wants a password fails instead of waiting forever.
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, missing: err?.code === 'ENOENT', stdout: String(stdout || ''), stderr: String(stderr || ''), error: err })
    })
  })
}
/** The last meaningful line of a failed command's output, for a one-line error. */
const tail = (r) => (`${r.stderr}\n${r.stdout}`.trim().split('\n').filter((l) => l.trim()).pop() || r.error?.message || 'failed').slice(0, 300)

/** npm next to the running node when it's there (Finder-launched apps get a thin PATH), else PATH's. */
function defaultNpm() {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const near = path.join(path.dirname(process.execPath), name)
  return fs.existsSync(near) ? near : name
}

/**
 * Restart this server: respond first (the caller does), close the HTTP server, start the same
 * command again, then exit. Only when we were started as `node server/cli.mjs` (not under a test
 * wrapper); returns false when it can't be done safely, so the page says "restart it yourself".
 *
 * From a terminal (`npm start`), a detached copy would outlive Ctrl-C and the shell, so the old
 * process stays as a thin parent instead: same terminal, Ctrl-C still stops both. Started in the
 * background (nohup, output to a log) the new copy is detached and writes to the same log. Under the
 * desktop app it just exits with DESKTOP_RESTART_EXIT and the app starts it again.
 */
export function canRestartSelf() {
  return !testing(process.env) && /(^|[/\\])cli\.mjs$/.test(process.argv[1] || '')
}
/** Exit code that asks the desktop app (desktop/main.cjs) to start its server again. */
export const DESKTOP_RESTART_EXIT = 75
export function restartSelf(server) {
  if (!canRestartSelf()) return false
  // Started by the desktop app: it owns the process, so let it do the restart (and reload its window).
  if (process.env.AGENTVILLE_DESKTOP === '1') {
    const bye = () => process.exit(DESKTOP_RESTART_EXIT)
    setTimeout(bye, 5000) // open WebSockets (built-in terminals) can keep close() waiting
    server.close(bye)
    server.closeAllConnections?.()
    return true
  }
  const tty = !!(process.stdout.isTTY || process.stdin.isTTY)
  const again = () => {
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(), env: process.env, detached: !tty, stdio: tty ? 'inherit' : ['ignore', 1, 2],
    })
    if (tty) {
      for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill(sig) } catch {} })
      child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
      child.on('error', () => process.exit(1))
    } else {
      child.unref()
      process.exit(0)
    }
  }
  server.close(again)
  server.closeAllConnections?.()
  return true
}

/**
 * @param {object} o
 * @param {string} [o.root]      the checkout (default: AGENTVILLE_UPDATE_DIR, else this install)
 * @param {object} [o.env]
 * @param {Function} [o.fetch]
 * @param {string} [o.git] [o.npm]  binaries
 * @param {Function|null} [o.restart]  called after a successful update; returns true if it restarts
 * @param {string|null} [o.settingsFile]  small JSON file kept across restarts: autoUpdate, the last applied update, the app-rebuild notice
 * @param {Function} [o.terminalsOpen]  how many in-app terminals are open (sync or async); automatic updates wait for 0
 * @param {Function} [o.runner]  stand-in for running a command (tests), same shape as the default
 */
export function createUpdater({ env = process.env, root, fetch: fetchImpl = globalThis.fetch, git = 'git', npm = defaultNpm(), restart = null, now = Date.now,
  platform = process.platform, execPath = process.execPath, runner = run, settingsFile = null, terminalsOpen = () => 0 } = {}) {
  const dir = path.resolve(root || env.AGENTVILLE_UPDATE_DIR || ROOT)
  const apiBase = (env.AGENTVILLE_UPDATE_API || API).replace(/\/+$/, '')
  const startedAt = now()
  const S = {
    enabled: true, why: null, repo: null,
    current: null, branch: null, latest: null, behindBy: 0, changes: [], compare: null,
    dirty: false, originRepo: null, note: null, error: null, checkedAt: null, nextAt: null, applying: false,
  }
  // Kept across restarts (settingsFile): autoUpdate (default on), applied (last update), appBuild (sha that changed desktop/).
  const P = { autoUpdate: env.AGENTVILLE_AUTO_UPDATE !== '0', applied: null, appBuild: null }
  try {
    const raw = settingsFile && JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    if (raw && typeof raw === 'object') {
      if (typeof raw.autoUpdate === 'boolean') P.autoUpdate = raw.autoUpdate
      if (raw.applied && typeof raw.applied.short === 'string') P.applied = raw.applied
      if (typeof raw.appBuild === 'string') P.appBuild = raw.appBuild
    }
  } catch { /* none yet, or unreadable: defaults */ }
  const persist = () => {
    if (!settingsFile) return
    try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(P)) } catch { /* read-only data dir: stays in memory */ }
  }
  let deferredSince = null
  let autoError = null
  let timer = null
  let inflight = null
  let ready = null

  // --no-optional-locks: a background check never takes the index lock from the user's own git.
  const g = (args, o) => runner(git, ['--no-optional-locks', ...args], { cwd: dir, env, ...o })
  const off = (why) => { S.enabled = false; S.why = why; return false }

  /** Decide once whether the feature can run here at all, and read the local version. */
  async function init() {
    if (env.AGENTVILLE_UPDATE_CHECK === '0') return off('Update checks are turned off (AGENTVILLE_UPDATE_CHECK=0).')
    if (testing(env) && !env.AGENTVILLE_UPDATE_API) return off('Update checks are off in tests.')
    // Its own .git, not a parent folder's: installed inside another repo, that repo isn't us.
    if (!fs.existsSync(path.join(dir, '.git'))) return off("This copy of Agentville isn't a git checkout, so it can't check for updates.")
    const v = await g(['--version'], { timeout: 10_000 })
    if (v.missing) return off("git wasn't found, so Agentville can't check for updates.")
    if (!(await readLocal())) return off("Couldn't read this checkout's git history.")
    const origin = await g(['remote', 'get-url', 'origin'])
    S.originRepo = origin.ok ? githubRepo(origin.stdout) : null
    let pkg = {}
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch {}
    const fromPkg = githubRepo(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url)
    // A fork's origin is the fork, so it's checked against the fork's own main.
    S.repo = validRepo(env.AGENTVILLE_UPDATE_REPO) || S.originRepo || fromPkg
    if (!S.repo) return off("Couldn't tell which GitHub repository this copy came from.")
    return true
  }

  async function readLocal() {
    const head = await g(['rev-parse', 'HEAD'])
    if (!head.ok) return false
    S.current = head.stdout.trim()
    const br = await g(['symbolic-ref', '--short', '-q', 'HEAD'])
    S.branch = br.ok ? br.stdout.trim() : null
    // Tracked changes only: an untracked file can't be lost by a fast-forward (git refuses instead).
    const st = await g(['status', '--porcelain', '--untracked-files=no'])
    S.dirty = !st.ok || st.stdout.trim() !== ''
    return true
  }

  async function get(p) {
    return fetchImpl(`${apiBase}${p}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    })
  }

  /** When the next try may happen after a rate-limit answer (at least 15 min out). */
  function rateLimitedUntil(res) {
    const t = now()
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
    const after = Number(res.headers.get('retry-after')) * 1000
    return Math.max(t + 15 * 60e3, Number.isFinite(reset) ? reset : 0, Number.isFinite(after) ? t + after : 0)
  }
  const isRateLimit = (res) => res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')

  /** One compare call. Returns { res, body } or throws for network errors. */
  async function compare(base) {
    const res = await get(`/repos/${S.repo}/compare/${base}...main`)
    const body = res.ok ? await res.json() : null
    return { res, body }
  }

  async function doCheck() {
    if (!(await readLocal())) { S.error = "Couldn't read this checkout's git history."; return schedule(OFFLINE_RETRY_MS) }
    try {
      let { res, body } = await compare(S.current)
      let unknownLocal = false
      if (res.status === 404) {
        // GitHub doesn't know our HEAD: local commits. Compare from where we left GitHub's main instead.
        unknownLocal = true
        const known = await g(['merge-base', 'HEAD', 'refs/remotes/origin/main'])
        if (known.ok && known.stdout.trim()) ({ res, body } = await compare(known.stdout.trim()))
      }
      if (isRateLimit(res)) {
        const until = rateLimitedUntil(res)
        S.error = 'GitHub asked Agentville to slow down; it will check again later.'
        return schedule(until - now())
      }
      if (!res.ok && !(unknownLocal && res.status === 404)) {
        S.error = res.status === 404 ? `GitHub has no repository ${S.repo}.` : `GitHub answered ${res.status}.`
        return schedule(res.status >= 500 ? OFFLINE_RETRY_MS : EVERY_MS)
      }
      S.error = null
      S.checkedAt = now()
      if (!res.ok) { // unknown local commit and no usable fork point
        Object.assign(S, { compare: 'local', latest: null, behindBy: 0, changes: [], note: "Your copy has changes that aren't on GitHub, so Agentville can't tell whether it's behind." })
        return schedule(EVERY_MS)
      }
      const commits = Array.isArray(body.commits) ? body.commits : []
      const behindBy = Number(body.ahead_by) || 0 // ahead_by: how far main is ahead of us
      let last = commits[commits.length - 1]
      if (behindBy > commits.length) { // the compare lists at most 250 commits; ask for main's head
        const r = await get(`/repos/${S.repo}/commits/main`)
        if (r.ok) last = await r.json()
      }
      const status = unknownLocal ? 'local' : body.status
      S.compare = status
      S.behindBy = status === 'behind' || status === 'identical' ? 0 : behindBy
      S.latest = S.behindBy && last?.sha
        ? { sha: last.sha, short: short(last.sha), date: last.commit?.committer?.date || last.commit?.author?.date || null }
        : { sha: S.current, short: short(S.current), date: null }
      S.changes = S.behindBy ? commits.slice(-MAX_CHANGES).reverse().map((c) => ({
        short: short(c.sha), title: title(c.commit?.message), date: c.commit?.committer?.date || c.commit?.author?.date || null,
      })) : []
      S.note = status === 'local' ? "Your copy has changes that aren't on GitHub."
        : status === 'diverged' ? "Your copy has commits that aren't on GitHub's main."
        : status === 'behind' ? "Your copy is newer than GitHub's main." : null
      return schedule(EVERY_MS)
    } catch {
      S.error = "Couldn't reach GitHub to check for updates."
      return schedule(OFFLINE_RETRY_MS)
    }
  }

  function schedule(ms) {
    clearTimeout(timer)
    S.nextAt = now() + ms
    if (!started) return
    timer = setTimeout(() => check().catch(() => {}), Math.max(1000, ms))
    timer.unref?.()
  }

  let started = false
  async function check({ fresh = true } = {}) {
    if (!(await (ready ??= init()))) return status()
    // A page asking for a fresh answer gets one at most once a minute (tests: every time).
    if (!fresh || (S.checkedAt && now() - S.checkedAt < MIN_FRESH_MS && !testing(env))) return status()
    inflight ??= doCheck().then(autoApply).catch(() => {}).finally(() => { inflight = null })
    await inflight
    return status()
  }

  /** Why "Update now" can't run here, or null when it can. */
  function blocked({ busy = S.applying } = {}) {
    if (!S.enabled) return S.why
    if (busy) return 'An update is already running.'
    if (testing(env) && dir === ROOT) return 'Updating this checkout is off in tests.'
    if (!S.behindBy) return 'Already up to date.'
    if (S.branch !== 'main') return S.branch ? `You're on the branch “${S.branch}”, not main.` : "Your copy isn't on a branch (detached HEAD)."
    if (S.dirty) return 'Your copy has local edits.'
    if (S.compare === 'local' || S.compare === 'diverged') return "Your copy has commits that aren't on GitHub's main."
    if (S.compare !== 'ahead') return "Agentville can't fast-forward your copy."
    if (S.originRepo && S.originRepo.toLowerCase() !== S.repo.toLowerCase()) return `Your “origin” remote isn't ${S.repo}.`
    return null
  }

  function status() {
    const why = blocked()
    return {
      enabled: S.enabled,
      ...(S.why && { why: S.why }),
      startedAt,
      current: S.current ? { sha: S.current, short: short(S.current), branch: S.branch } : null,
      ...(S.latest && { latest: S.latest }),
      behindBy: S.behindBy,
      changes: S.changes,
      canApply: !why,
      ...(why && { applyBlocked: why }),
      ...(S.note && { note: S.note }),
      ...(S.error && { error: S.error }),
      // What to run by hand, in this checkout, when the button can't.
      commands: S.enabled ? [`cd ${JSON.stringify(dir)}`, ...(S.branch && S.branch !== 'main' ? ['git switch main'] : []), 'git pull origin main', './setup.sh'] : [],
      canRestart: !!restart,
      autoUpdate: P.autoUpdate,
      ...(deferredSince != null && { deferredSince }),
      ...(autoError && { autoError }),
      ...(P.applied && { applied: P.applied }),
      needsAppBuild: !!P.appBuild && env.AGENTVILLE_DESKTOP === '1',
      applying: S.applying,
      checkedAt: S.checkedAt,
      nextCheckAt: started ? S.nextAt : null,
    }
  }

  /**
   * Fast-forward to GitHub's main, reinstall if the lockfile changed, rebuild. A failed pull leaves
   * the checkout as it was. Returns { ok, steps, sha?, restarting?, error? }; the caller responds,
   * then calls `restartNow()` when `restarting`.
   */
  async function apply() {
    if (!(await (ready ??= init()))) return { ok: false, error: S.why, steps: [] }
    if (S.applying) return { ok: false, error: 'An update is already running.', steps: [] }
    S.applying = true
    const steps = []
    const step = (name, r) => { steps.push({ name, ok: r.ok }); return r.ok }
    try {
      await readLocal() // the tree may have changed since the last check
      const why = blocked({ busy: false })
      if (why) return { ok: false, error: why, steps }
      const before = S.current
      const pull = await g(['pull', '--ff-only', '--no-rebase', 'origin', 'main'], { timeout: 180_000 })
      if (!step('git pull --ff-only origin main', pull)) {
        // ff-only never half-applies; if HEAD moved anyway, put it back.
        const head = (await g(['rev-parse', 'HEAD'])).stdout.trim()
        if (head && head !== before) await g(['reset', '--keep', before])
        await readLocal()
        return { ok: false, error: `git pull failed: ${tail(pull)}`, steps }
      }
      await readLocal()
      const lock = await g(['diff', '--name-only', before, S.current, '--', 'package-lock.json'])
      const cmds = installCommands({ platform, execPath, npm, env })
      const later = (what, r) => `The code is updated, but ${what} failed (${tail(r)}). Run ./setup.sh in ${dir}, then restart Agentville.`
      if (lock.stdout.trim()) {
        const ci = await runner(cmds.ci.cmd, cmds.ci.args, { cwd: dir, env: { ...env, ...cmds.ci.env }, timeout: 15 * 60e3 })
        if (!step('npm ci', ci)) return { ok: false, updated: true, error: later('npm ci', ci), steps }
      }
      for (const b of cmds.build) {
        const build = await runner(b.cmd, b.args, { cwd: dir, env: { ...env, ...b.env }, timeout: 10 * 60e3 })
        if (!step(platform === 'win32' ? path.win32.basename(b.args[0]) : 'npm run build', build)) return { ok: false, updated: true, error: later('the build', build), steps }
      }
      // Pulled commits that touched desktop/ need the app shell rebuilt by hand (app:build): the running exe can't be replaced.
      const shell = await g(['diff', '--name-only', before, S.current, '--', 'desktop'])
      const desktopChanged = shell.ok && touchesDesktop(shell.stdout)
      P.applied = { sha: S.current, short: short(S.current), title: S.changes[0]?.title || '', at: now() }
      if (desktopChanged) P.appBuild = S.current
      persist()
      Object.assign(S, { behindBy: 0, changes: [], compare: 'identical', latest: { sha: S.current, short: short(S.current), date: null }, note: null })
      return { ok: true, steps, sha: S.current, short: short(S.current), desktopChanged, restarting: !!restart }
    } finally {
      S.applying = false
    }
  }

  /** After a check: with automatic updates on, apply what's available when the usual safety checks pass. */
  async function autoApply() {
    if (!P.autoUpdate || !S.enabled || !S.behindBy || S.applying || blocked()) { deferredSince = null; return }
    // An open in-app terminal closes on restart: wait for it, retried at each check, but not past the cap.
    let terms = 0
    try { terms = Number(await terminalsOpen()) || 0 } catch { /* unknown: don't hold the update back */ }
    if (terms > 0) {
      deferredSince ??= now()
      if (now() - deferredSince < DEFER_CAP_MS) return
    }
    deferredSince = null
    const out = await apply()
    autoError = out.ok ? null : out.error || 'The automatic update failed.'
    if (out.ok && out.restarting) setTimeout(() => restart?.(), 500).unref?.()
  }

  return {
    dir,
    /** The saved choices: { autoUpdate?: boolean, dismissAppBuild?: true }. */
    configure(patch = {}) {
      if (typeof patch.autoUpdate === 'boolean') P.autoUpdate = patch.autoUpdate
      if (patch.dismissAppBuild) P.appBuild = null
      if (!P.autoUpdate) deferredSince = null
      persist()
      return status()
    },
    /** Read the local version now and check GitHub after a short wait (AGENTVILLE_UPDATE_DELAY_MS). */
    async start() {
      started = true
      if (!(await (ready ??= init()))) return
      const first = Number(env.AGENTVILLE_UPDATE_DELAY_MS)
      schedule(Number.isFinite(first) && first >= 0 ? first : FIRST_MS)
    },
    stop() { started = false; clearTimeout(timer) },
    async status() { await (ready ??= init()); return status() },
    check,
    apply,
    /** After the response to a successful apply has gone out. True when a restart was started. */
    restartNow() { return restart ? restart() !== false : false },
  }
}
