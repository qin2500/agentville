/**
 * Restore after crash: bring back the crown agents (role 'boss') and the agents the user marked
 * Important that were running when the Mac went down.
 *
 * Claude Code's daemon does not restart background jobs after a reboot: it logs
 * `bg adopt: adopted=0 respawned=0 dead=N` and leaves them. So on every scan we keep a small
 * running-set snapshot in our own data dir (`restore.json`): which top-level Claude agents are live
 * right now, with their role and Important mark *as of then* (after a crash the children are dead
 * too, so a role computed afterwards would lose the crown). Ids, names, folders and times only: no
 * conversation text, no provider env. It is written atomically and only when it changes.
 *
 * When the machine's boot time moves on, the last snapshot from the earlier boot is kept as
 * `previous` (a later scan can't wipe it). That also covers the dashboard being down during the
 * crash: its snapshot simply predates this boot.
 *
 * A job from `previous` is *lost* when it has no live process (neither in the session registry nor
 * in the daemon's roster), wasn't deliberately stopped (`claude stop` leaves `state: "stopped"`),
 * wasn't removed (`claude rm` deletes its job folder), and still has its transcript.
 *
 * Restoring runs, one job at a time and only behind a one-time confirm token, `claude respawn
 * <short>` (same job, same id, its own saved flags and provider env), and if that fails,
 * `claude --bg --resume <session>` with the job's saved respawn flags (fixed allowlist) under its
 * saved provider env, in its folder. See README "Restore after crash" for why respawn comes first.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { claudeBin } from './actions.mjs'
import { shQuote } from './terminal.mjs'

export const CROWN_ROLES = ['boss'] // the roles the village draws with a crown (web/src/world.js)
export const BOOT_SLACK_MS = 2 * 60_000 // two readings of one boot time differ by at most this
export const KEEP_MS = 14 * 24 * 3600_000 // a pre-boot snapshot older than this is not offered
export const RUN_MS = 120_000
export const MESSAGE = 'You were restarted after the computer crashed. Check which of your sub-agents and background jobs were lost, and restart the ones you still need.'
const SHORT = /^[0-9a-f]{8}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/
const MINUTE = 60_000
const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
const waitMs = () => Number(process.env.AGENTVILLE_RESTORE_WAIT_MS) || 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bad = (message, status = 400) => Object.assign(new Error(message), { status })

/** When this machine booted (ms). AGENTVILLE_BOOT_TIME pins it in tests. os.uptime() reads kern.boottime on macOS. */
export function bootTime() {
  const pinned = Number(process.env.AGENTVILLE_BOOT_TIME)
  if (pinned) return pinned
  return Math.round((Date.now() - os.uptime() * 1000) / 1000) * 1000
}
export const sameBoot = (a, b) => Math.abs((a || 0) - (b || 0)) <= BOOT_SLACK_MS

/** Why restoring can't run here ('' = it can). Tests must name a fake Claude home and a fake `claude`. */
export function restoreBlocked() {
  if (process.platform === 'win32') return 'Restoring agents is not supported on Windows'
  if (testing() && !(process.env.AGENTVILLE_CLAUDE_HOME && process.env.AGENTVILLE_CLAUDE_BIN)) return 'Restoring agents is disabled in tests'
  return ''
}

/** Saved respawn flags the documented fallback may pass on, by name. Anything else: no fallback. */
const VALUE_FLAGS = new Set(['--model', '-n', '--name', '--permission-mode', '--effort', '--settings', '--mcp-config', '--agent', '--agents',
  '--append-system-prompt', '--system-prompt', '--fallback-model'])
const LIST_FLAGS = new Set(['--add-dir', '--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools'])
const BOOL_FLAGS = new Set(['--dangerously-skip-permissions', '--strict-mcp-config', '--no-chrome', '--chrome', '--verbose'])

/** `respawnFlags` -> argv to append, or `{ error }`. Every flag name from the lists above; values are kept whole. */
export function checkFlags(flags) {
  if (flags == null) return { args: [] }
  if (!Array.isArray(flags) || flags.length > 200) return { error: 'Its saved flags are not a list' }
  const out = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]
    if (typeof f !== 'string' || f.length > 64_000 || f.includes('\0')) return { error: 'Its saved flags are not plain text' }
    const eq = f.startsWith('--') ? f.indexOf('=') : -1
    const name = eq > 0 ? f.slice(0, eq) : f
    if (eq > 0) {
      if (!VALUE_FLAGS.has(name) && !LIST_FLAGS.has(name)) return { error: `Unsupported saved flag ${name.slice(0, 40)}` }
      out.push(f)
    } else if (BOOL_FLAGS.has(f)) out.push(f)
    else if (VALUE_FLAGS.has(f)) {
      if (i + 1 >= flags.length || typeof flags[i + 1] !== 'string') return { error: `Saved flag ${f} has no value` }
      out.push(f, flags[++i])
    } else if (LIST_FLAGS.has(f)) {
      out.push(f)
      let n = 0
      while (i + 1 < flags.length && typeof flags[i + 1] === 'string' && !flags[i + 1].startsWith('-')) { out.push(flags[++i]); n++ }
      if (!n) return { error: `Saved flag ${f} has no value` }
    } else return { error: `Unsupported saved flag ${String(f).slice(0, 40)}` }
    if (out.some((x) => typeof x !== 'string' || x.includes('\0'))) return { error: 'Its saved flags are not plain text' }
  }
  return { args: out }
}

/** A job's saved provider env: string values under env-like key names, or `{ error }`. Values are never logged or returned. */
export function checkEnv(env) {
  if (env == null) return { env: {} }
  if (typeof env !== 'object' || Array.isArray(env)) return { error: 'Its saved provider settings are not an object' }
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY.test(k) || typeof v !== 'string' || v.includes('\0')) return { error: 'Its saved provider settings are not plain text' }
    out[k] = v
  }
  return { env: out }
}

/**
 * The name the app shows for it (classify.mjs `safeName`: an override, a custom title, the job's
 * name, an AI title), never conversation text. Without one, a fixed label.
 */
export function safeName(a, short) {
  const n = typeof a.safeName === 'string' ? a.safeName.trim() : ''
  if (n) return n.slice(0, 80)
  return a.harness === 'codex' ? 'Codex thread' : a.kind === 'job' ? `Job ${short}` : 'Untitled session'
}
const KIND = (a) => (a.harness === 'codex' ? 'codex' : a.kind === 'job' ? 'job' : 'session')
const entryOf = (a, seen) => {
  const sid = a.id.slice(a.id.indexOf(':') + 1)
  return {
    kind: KIND(a),
    id: a.id,
    ...(a.kind === 'job' && { short: a.jobId }),
    sid,
    name: safeName(a, a.jobId),
    project: a.project || '',
    cwd: a.cwd || null,
    role: a.role || 'solo',
    important: a.important === true,
    seen,
  }
}
/**
 * The agents worth remembering: live, top-level Claude Code jobs and interactive sessions, and
 * top-level Codex threads (listed after a crash when Important, never restored from here).
 */
export function runningSet(agents, now = Date.now()) {
  const seen = Math.floor(now / MINUTE) * MINUTE // minute steps, so a write happens at most once a minute
  const claude = (a) => a.harness === 'claude-code' && (a.kind === 'session' || (a.kind === 'job' && SHORT.test(a.jobId || ''))) && UUID.test(a.id.slice('claude-code:'.length))
  const codex = (a) => a.harness === 'codex' && a.kind === 'session' && /^codex:[\w-]{1,100}$/.test(a.id)
  return agents
    .filter((a) => a.live && (claude(a) || codex(a)))
    .map((a) => entryOf(a, seen))
    .sort((x, y) => (x.id < y.id ? -1 : 1))
}

/**
 * `<claude home>` is read for: jobs/<short>/state.json (state, sessionId, resumeSessionId, cwd,
 * worktreePath, respawnFlags, providerEnv; the last two only when building a restore),
 * projects/<dir>/<sid>.jsonl (existence only), sessions/*.json (pid, sessionId, jobId, inbox) and
 * daemon/roster.json (workers' pids).
 */
export function createRestore({ dataDir, claudeHome }) {
  const file = path.join(dataDir, 'restore.json')
  let data = null
  let queue = Promise.resolve()
  const runs = []

  async function load() {
    if (data) return data
    try {
      const d = JSON.parse(await fsp.readFile(file, 'utf8'))
      data = { boot: d.boot || 0, at: d.at || 0, running: Array.isArray(d.running) ? d.running : [], previous: d.previous || null, dismissed: d.dismissed || 0 }
    } catch { data = { boot: 0, at: 0, running: [], previous: null, dismissed: 0 } }
    return data
  }
  /** Serialised, atomic, and only when the content changed. */
  function save(mutate) {
    const run = queue.then(async () => {
      const cur = await load()
      const next = mutate(structuredClone(cur))
      if (!next || JSON.stringify(next) === JSON.stringify(cur)) return cur
      await fsp.mkdir(dataDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      await fsp.rename(tmp, file)
      data = next
      return next
    })
    queue = run.catch(() => {})
    return run
  }

  /** Called with each scan's agents. A new boot moves the last snapshot to `previous`, once. */
  function record(agents, now = Date.now(), boot = bootTime()) {
    const running = runningSet(agents, now)
    return save((d) => {
      if (d.boot && !sameBoot(d.boot, boot)) {
        // The earlier boot's last word. Only replaced by a later boot's, never by a scan in this one.
        if (d.running.length) d.previous = { boot: d.boot, at: d.at, running: d.running }
        d.running = []
        d.at = 0
        d.dismissed = 0
      }
      d.boot = sameBoot(d.boot, boot) ? d.boot : boot
      // The kept list's names follow what the app shows now (a rename, a new title, an older snapshot).
      if (d.previous?.running?.length) {
        const byId = new Map(agents.map((a) => [a.id, a]))
        for (const e of d.previous.running) {
          const a = byId.get(e.id)
          const n = a && typeof a.safeName === 'string' ? a.safeName.trim().slice(0, 80) : ''
          if (n && n !== e.name) e.name = n
        }
      }
      const ids = (xs) => xs.map((x) => `${x.id}:${x.role}:${x.important}:${x.name}:${x.cwd}`).join('|')
      if (ids(running) !== ids(d.running) || (running.length && running[0].seen !== d.at)) {
        d.running = running
        d.at = running.length ? running[0].seen : d.at
      }
      return d
    })
  }

  // ---------- what is running now ----------
  const home = () => claudeHome()
  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
  }
  /** Live registry entries: sessionId -> { jobId, inbox }. */
  async function registry() {
    const out = new Map()
    const dir = path.join(home(), 'sessions')
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.json')) continue
      let s
      try { s = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) } catch { continue }
      if (!s?.sessionId || !alive(s.pid)) continue
      out.set(s.sessionId, {
        jobId: typeof s.jobId === 'string' ? s.jobId : null,
        inbox: typeof s.messagingSocketPath === 'string' ? { sock: s.messagingSocketPath, proto: s.peerProtocol } : null,
      })
    }
    return out
  }
  /** Job shorts the daemon has a live worker for. */
  async function roster() {
    const out = new Set()
    try {
      const r = JSON.parse(await fsp.readFile(path.join(home(), 'daemon', 'roster.json'), 'utf8'))
      for (const [short, w] of Object.entries(r?.workers || {})) if (SHORT.test(short) && alive(w?.pid)) out.add(short)
    } catch { /* no daemon yet */ }
    return out
  }
  async function readState(short) {
    try { return JSON.parse(await fsp.readFile(path.join(home(), 'jobs', short, 'state.json'), 'utf8')) } catch (e) { return e.code === 'ENOENT' ? undefined : null }
  }
  async function transcript(sid) {
    if (!UUID.test(sid || '')) return null
    for (const d of await fsp.readdir(path.join(home(), 'projects')).catch(() => [])) {
      const f = path.join(home(), 'projects', d, `${sid}.jsonl`)
      if (fs.existsSync(f)) return f
    }
    return null
  }
  const jobLive = (short, st, reg, ros) => ros.has(short)
    || [...reg].some(([sid, r]) => r.jobId === short || sid === st?.sessionId || (st?.resumeSessionId && sid === st.resumeSessionId))

  /**
   * Every entry from before this boot, each with a verdict: 'lost' | 'running' | 'stopped' |
   * 'removed' | 'no-transcript' | 'not-chosen' (neither a crown agent nor Important).
   * `important(id)` is the current mark, so marking a lost agent after the crash still counts.
   */
  async function examine({ important = () => false, live = () => false, now = Date.now(), boot = bootTime() } = {}) {
    const d = await load()
    const prev = d.previous && !sameBoot(d.previous.boot, boot) && now - (d.previous.at || 0) < KEEP_MS ? d.previous : null
    if (!prev) return { boot, crashBoot: null, at: null, dismissed: false, jobs: [], sessions: [], codex: [] }
    const [reg, ros] = await Promise.all([registry(), roster()])
    const jobs = []
    const sessions = []
    const codex = []
    for (const e of prev.running) {
      const chosen = CROWN_ROLES.includes(e.role) || e.important || important(e.id)
      const base = { id: e.id, name: e.name, project: e.project, cwd: e.cwd, role: e.role, crown: CROWN_ROLES.includes(e.role), important: e.important || important(e.id), seen: e.seen }
      if (e.kind === 'codex') {
        // Listed only: a Codex thread is reopened in the Codex app. Never a command here.
        codex.push({ ...base, verdict: live(e.id) ? 'running' : chosen ? 'lost' : 'not-chosen', note: 'Codex thread — reopen it in the Codex app' })
      } else if (e.kind === 'job') {
        if (!SHORT.test(e.short || '')) continue
        const st = await readState(e.short)
        let verdict
        if (st === undefined) verdict = 'removed'
        else if (!st || !UUID.test(st.sessionId || '')) verdict = 'removed'
        else if (jobLive(e.short, st, reg, ros)) verdict = 'running'
        else if (st.state === 'stopped') verdict = 'stopped'
        else if (!(await transcript(st.resumeSessionId || st.sessionId))) verdict = 'no-transcript'
        else verdict = chosen ? 'lost' : 'not-chosen'
        jobs.push({ ...base, short: e.short, verdict })
      } else {
        let verdict
        if (reg.has(e.sid)) verdict = 'running'
        else if (!(await transcript(e.sid))) verdict = 'no-transcript'
        else verdict = chosen ? 'lost' : 'not-chosen'
        const cmd = `claude --resume ${e.sid}`
        sessions.push({ ...base, sid: e.sid, verdict, command: e.cwd ? `cd ${shQuote(e.cwd)} && ${cmd}` : cmd })
      }
    }
    return { boot, crashBoot: prev.boot, at: prev.at, dismissed: sameBoot(d.dismissed, boot), jobs, sessions, codex }
  }

  /** The `fleet.restore` summary in /api/agents: enough for the notice, nothing more. */
  async function summary(opts) {
    const x = await examine(opts)
    const lost = x.jobs.filter((j) => j.verdict === 'lost').length
    const terms = x.sessions.filter((s) => s.verdict === 'lost').length + x.codex.filter((s) => s.verdict === 'lost').length
    return x.crashBoot ? { lost, sessions: terms, at: x.at, boot: x.boot, dismissed: x.dismissed } : null
  }

  function dismiss(boot = bootTime()) { return save((d) => ({ ...d, dismissed: boot })) }

  // ---------- plans ----------
  /** What restoring `short` would run: respawn first, the documented resume as the fallback. */
  async function planJob(j) {
    const st = await readState(j.short)
    if (!st) throw bad('Its job folder is gone', 409)
    const sid = st.resumeSessionId && UUID.test(st.resumeSessionId) ? st.resumeSessionId : st.sessionId
    const dirOk = (p) => typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()
    const cwd = [st.worktreePath, st.cwd].find(dirOk) || null
    const respawn = { args: ['respawn', j.short], cwd: cwd || os.homedir() }
    const flags = checkFlags(st.respawnFlags)
    const env = checkEnv(st.providerEnv)
    const why = !UUID.test(sid || '') ? 'It has no saved session id' : !cwd ? 'Its folder no longer exists' : flags.error || env.error || ''
    const resume = why ? { unavailable: why } : { args: ['--bg', '--resume', sid, ...flags.args], cwd, envKeys: Object.keys(env.env).sort() }
    return { short: j.short, id: j.id, name: j.name, project: j.project, crown: j.crown, important: j.important, respawn, resume }
  }
  // Brackets are quoted too: pasted into zsh, `opus[1m]` would be a glob.
  const display = (args) => ['claude', ...args].map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : shQuote(x))).join(' ')
  /** The confirm step's view of a plan: exact commands; env key names only, never values. */
  const shown = (p) => ({
    id: p.id, short: p.short, name: p.name, project: p.project, crown: p.crown, important: p.important,
    command: display(p.respawn.args),
    fallback: p.resume.unavailable ? { unavailable: p.resume.unavailable }
      : { command: `cd ${shQuote(p.resume.cwd)} && ${display(p.resume.args)}`, envKeys: p.resume.envKeys },
  })

  /** `ids`: agent ids from the lost list (all of them when omitted). */
  async function preview(ids, opts) {
    const x = await examine(opts)
    const lost = x.jobs.filter((j) => j.verdict === 'lost')
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 200 || !ids.every((i) => typeof i === 'string'))) throw bad('ids must be a list of agent ids')
    const pick = ids === undefined ? lost : lost.filter((j) => ids.includes(j.id))
    if (!pick.length) throw bad('Pick at least one agent to restore')
    const plans = []
    for (const j of pick) plans.push(await planJob(j))
    const crowns = plans.filter((p) => p.crown)
    return { plans, view: { jobs: plans.map(shown), message: crowns.length ? { text: MESSAGE, to: crowns.map((p) => p.id) } : null } }
  }

  // ---------- run ----------
  function exec(bin, args, { cwd, env }) {
    return new Promise((resolve) => {
      execFile(bin, args, { cwd, env, timeout: RUN_MS, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: Boolean(err?.killed), out: `${stdout || ''}\n${stderr || ''}` })
      })
    })
  }
  /** Until the job has a live process again, or the wait runs out. */
  async function cameBack(short) {
    const until = Date.now() + waitMs()
    for (;;) {
      const st = await readState(short)
      if (jobLive(short, st, await registry(), await roster())) return true
      if (Date.now() > until) return false
      await sleep(250)
    }
  }
  const failText = (what, r) => (r.timedOut ? `${what} timed out` : `${what} failed (exit ${r.code})`)

  /**
   * Runs confirmed plans one at a time. Each result: `{ id, short, status: 'restored' | 'running' |
   * 'failed', via?, detail? }`. Then the crown agents among the restored get MESSAGE through `send`
   * (serve.mjs: the inspector's message path with its receipt), each reported per agent.
   */
  async function run(plans, { send } = {}) {
    const blocked = restoreBlocked()
    if (blocked) throw bad(blocked, 501)
    const now = Date.now()
    while (runs.length && now - runs[0] > 60_000) runs.shift()
    if (runs.length >= 3) throw bad('Too many restores; wait a minute', 429)
    runs.push(now)
    const bin = await claudeBin()
    if (!bin) throw bad('Claude Code CLI not found', 409)
    const results = []
    for (const p of plans) {
      const st = await readState(p.short)
      if (!st) { results.push({ id: p.id, short: p.short, status: 'failed', detail: 'Its job folder is gone' }); continue }
      if (jobLive(p.short, st, await registry(), await roster())) { results.push({ id: p.id, short: p.short, status: 'running', detail: 'Already running' }); continue }
      const r = await exec(bin, p.respawn.args, { cwd: p.respawn.cwd, env: process.env })
      if (r.code === 0) {
        results.push({ id: p.id, short: p.short, status: 'restored', via: 'respawn', ...(!(await cameBack(p.short)) && { detail: 'Not seen running yet' }) })
        continue
      }
      // Reopened in a terminal meanwhile: it is running, just not as a background job.
      if (/another terminal/i.test(r.out)) { results.push({ id: p.id, short: p.short, status: 'running', detail: 'Open in a terminal' }); continue }
      if (p.resume.unavailable) { results.push({ id: p.id, short: p.short, status: 'failed', detail: `${failText('Respawn', r)}; ${p.resume.unavailable.toLowerCase()}` }); continue }
      // Re-read the env just before use; it is passed to the child only, never kept or logged.
      const env = checkEnv((await readState(p.short))?.providerEnv)
      if (env.error) { results.push({ id: p.id, short: p.short, status: 'failed', detail: `${failText('Respawn', r)}; ${env.error.toLowerCase()}` }); continue }
      const r2 = await exec(bin, p.resume.args, { cwd: p.resume.cwd, env: { ...process.env, ...env.env } })
      if (r2.code === 0) results.push({ id: p.id, short: p.short, status: 'restored', via: 'resume', ...(!(await cameBack(p.short)) && { detail: 'Not seen running yet' }) })
      else results.push({ id: p.id, short: p.short, status: 'failed', detail: `${failText('Respawn', r)}; ${failText('resume', r2)}` })
    }
    const messages = []
    for (const p of plans.filter((x) => x.crown)) {
      const res = results.find((x) => x.id === p.id)
      if (res?.status !== 'restored') { messages.push({ id: p.id, status: 'skipped', detail: 'Not restored' }); continue }
      messages.push({ id: p.id, ...(send ? await send(p, await inboxOf(p.short)) : { status: 'skipped', detail: 'Sending is not available' }) })
    }
    return { results, messages }
  }

  /** The restored job's inbox and transcript, once its process advertises one (or the wait runs out). */
  async function inboxOf(short) {
    const until = Date.now() + waitMs()
    for (;;) {
      const st = await readState(short)
      const reg = await registry()
      for (const [sid, r] of reg) {
        if (r.inbox && (r.jobId === short || sid === st?.sessionId || sid === st?.resumeSessionId)) return { inbox: r.inbox, file: await transcript(sid) }
      }
      if (Date.now() > until) return { inbox: null, file: null }
      await sleep(250)
    }
  }

  return { load, record, examine, summary, dismiss, preview, run }
}
