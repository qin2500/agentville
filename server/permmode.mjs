/**
 * Switch one Claude Code background job to bypass-permissions mode, on the user's explicit click.
 *
 * A job's permission mode lives in `<claude home>/jobs/<short>/state.json` → `respawnFlags`.
 * The switch backs that file up (0600, under `<data>/perm-backups`, apart from the account
 * switch's backups so its Undo never picks one up), rewrites the flags atomically, and
 * `claude respawn`s the job if it is running now, then checks it came back on the new flags. The
 * user asked for this one job and confirmed the interruption, but the respawn still waits up to two
 * minutes for the job to reach a turn boundary first, then goes ahead. A failed respawn puts the
 * file back. One switch at a time, never during an account switch.
 * Flag values are never returned or logged: respawn flags can hold prompt text.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { claudeBin as findClaude, jobActivity, liveSince, run as runClaude, serializeLike, switchingBlocked, waitForIdle } from './account.mjs'
import { writeAtomic } from './accounts.mjs'

export const BYPASS = 'bypassPermissions'
const SHORT = /^[0-9a-f]{8}$/
const MODE = /^[A-Za-z]{1,32}$/
const RESPAWN_MS = 120_000
/** How long the respawn waits for the job to go idle before it goes ahead anyway. */
const IDLE_WAIT_MS = 120_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (status, message) => Object.assign(new Error(message), { status })

/** Flags whose next argument is a value (so a value is never mistaken for a flag). */
const VALUE_FLAGS = new Set(['--model', '-n', '--name', '--effort', '--settings', '--mcp-config', '--agent', '--agents',
  '--append-system-prompt', '--system-prompt', '--fallback-model', '--resume', '-r', '--session-id', '--output-format',
  '--input-format', '--max-turns', '--permission-prompt-tool', '--max-budget-usd'])
const PM = '--permission-mode'
const DROP = new Set(['--allow-dangerously-skip-permissions'])

/** Walk `flags`, calling `on(kind, i)` for each: 'pm' (value at i+1), 'pm=' , 'skip', 'drop', 'value' (pair at i), 'other'. */
function walk(flags, on) {
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]
    if (f === PM) { on('pm', i); i++ } else if (typeof f === 'string' && f.startsWith(`${PM}=`)) on('pm=', i)
    else if (f === '--dangerously-skip-permissions') on('skip', i)
    else if (DROP.has(f)) on('drop', i)
    else if (VALUE_FLAGS.has(f) && i + 1 < flags.length) { on('value', i); i++ } else on('other', i)
  }
}

/** The job's permission mode from its respawn flags: 'bypassPermissions', another mode, or '' (default). */
export function modeOf(flags) {
  if (!Array.isArray(flags)) return ''
  let mode = '', skip = false
  walk(flags, (kind, i) => {
    if (kind === 'skip') skip = true
    else if (kind === 'pm') mode = String(flags[i + 1] ?? '')
    else if (kind === 'pm=') mode = flags[i].slice(PM.length + 1)
  })
  if (skip) return BYPASS
  return MODE.test(mode) ? mode : ''
}

/**
 * The same flags in bypass mode: every `--permission-mode X` / `--permission-mode=X` and
 * `--allow-dangerously-skip-permissions` removed, then `--permission-mode bypassPermissions` put
 * where the first permission flag was (or first). Every other argument keeps its place.
 */
export function withBypass(flags) {
  const list = Array.isArray(flags) ? flags : []
  const out = []
  let at = -1
  walk(list, (kind, i) => {
    if (kind === 'pm' || kind === 'pm=' || kind === 'drop') { if (at < 0) at = out.length; return }
    out.push(list[i])
    if (kind === 'value') out.push(list[i + 1])
  })
  out.splice(at < 0 ? 0 : at, 0, PM, BYPASS)
  return out
}

/**
 * `claudeHome()`: the Claude home dir. `run(bin, args, timeoutMs)` -> `{ code, timedOut, stdout, stderr }`.
 * `bin()`: the claude executable. `busy()`: true while an account switch runs. `activity(short)`:
 * 'idle' | 'busy' | 'gone' (default: the job file and registry); `idleMs`, `pollMs`, `now`, `sleep`
 * steer the wait for a turn boundary (tests use a fake clock).
 */
export function createPermSwitch({
  claudeHome, dataDir, run = runClaude, bin = findClaude, blocked = switchingBlocked, busy = () => false,
  verifyMs = () => Number(process.env.AGENTVILLE_PERM_VERIFY_MS) || 60_000,
  activity, idleMs = () => Number(process.env.AGENTVILLE_PERM_IDLE_MS) || IDLE_WAIT_MS, pollMs = () => Number(process.env.AGENTVILLE_PERM_POLL_MS) || 2_000,
  now: clock = Date.now, sleep: nap = sleep,
}) {
  const jobState = activity || ((short) => jobActivity(claudeHome(), short))
  let switching = false
  let working = null // the job the running switch is changing (account.mjs holds its restart meanwhile)
  const stateFile = (short) => path.join(claudeHome(), 'jobs', short, 'state.json')

  /** short -> mode for every job with a readable state.json. */
  async function modes() {
    const out = new Map()
    const dir = path.join(claudeHome(), 'jobs')
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!SHORT.test(name)) continue
      try { out.set(name, modeOf(JSON.parse(await fsp.readFile(stateFile(name), 'utf8')).respawnFlags)) } catch { /* unreadable */ }
    }
    return out
  }

  async function backup(short, text) {
    const root = path.join(dataDir, 'perm-backups')
    await fsp.mkdir(root, { recursive: true, mode: 0o700 })
    await fsp.chmod(root, 0o700).catch(() => {})
    const file = path.join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-${short}.json`)
    await fsp.writeFile(file, text, { mode: 0o600 })
    return file
  }

  /**
   * Switch job `short` to bypass mode. `live`: restart it now so the mode applies (a job that isn't
   * running only gets its saved flags changed). `reopened`: it is open in a terminal, so refused.
   * Resolves `{ ok, mode, restarted, waited? }` (`waited`: the job was busy, so the restart waited
   * for its turn to end, up to two minutes, before going ahead); throws an Error with `.status` otherwise.
   */
  async function toBypass(short, { live = false, reopened = false } = {}) {
    const why = blocked()
    if (why) throw fail(501, why)
    if (!SHORT.test(short || '')) throw fail(409, 'Not a background job')
    if (reopened) throw fail(409, 'Open in a terminal: change its mode there')
    if (switching) throw fail(409, 'A mode switch is already running')
    if (busy()) throw fail(409, 'An account switch is running; try again when it finishes')
    switching = true
    working = short
    try {
      const file = stateFile(short)
      const text = await fsp.readFile(file, 'utf8').catch(() => null)
      if (text === null) throw fail(404, 'Its job file is gone')
      let state
      try { state = JSON.parse(text) } catch { throw fail(409, "Its job file can't be read") }
      const flags = Array.isArray(state.respawnFlags) ? state.respawnFlags : []
      if (flags.some((f) => typeof f !== 'string')) throw fail(409, "Its saved flags can't be read")
      if (modeOf(flags) === BYPASS) throw fail(409, 'Already in bypass permissions mode')
      const exe = live ? await bin() : null
      if (live && !exe) throw fail(409, 'Claude Code CLI not found')
      const saved = await backup(short, text)
      // Re-read just before writing: Claude rewrites this file as the job runs.
      const fresh = await fsp.readFile(file, 'utf8')
      const now = JSON.parse(fresh)
      now.respawnFlags = withBypass(Array.isArray(now.respawnFlags) ? now.respawnFlags : [])
      await writeAtomic(file, serializeLike(fresh, now))
      if (!live) return { ok: true, mode: BYPASS, restarted: false }

      // Let a turn in progress finish (up to the cap), then restart: the user confirmed the interruption.
      const idle = await waitForIdle(() => jobState(short), { maxMs: idleMs(), pollMs: pollMs(), now: clock, sleep: nap })
      const waited = idle.waited
      // It stopped while we waited for its turn to end: its saved flags already say bypass, which it
      // uses when it next starts. Respawning it now would revive a job that has finished.
      if (idle.waited && idle.state === 'gone') return { ok: true, mode: BYPASS, restarted: false }
      const since = Date.now()
      const r = await run(exe, ['respawn', short], RESPAWN_MS)
      if (r.code !== 0) {
        await writeAtomic(file, await fsp.readFile(saved, 'utf8'))
        const out = `${r.stderr}\n${r.stdout}`
        if (/another terminal/i.test(out)) throw fail(409, 'Open in a terminal: change its mode there')
        throw fail(502, r.timedOut ? 'Restart timed out; its mode was put back' : `Restart failed (exit ${r.code}); its mode was put back`)
      }
      const until = Date.now() + verifyMs()
      while (!(await liveSince(claudeHome(), short, now, since))) {
        if (Date.now() > until) throw fail(504, "Restarted in bypass mode, but it didn't come back within the time limit")
        await sleep(300)
      }
      const after = JSON.parse(await fsp.readFile(file, 'utf8').catch(() => '{}'))
      if (modeOf(after.respawnFlags) !== BYPASS) throw fail(500, "Restarted, but its saved mode was changed back")
      return { ok: true, mode: BYPASS, restarted: true, waited }
    } finally { switching = false; working = null }
  }

  /** `busyJob()`: the job short a running switch is working on, or null. */
  return { modes, toBypass, isBusy: () => switching, busyJob: () => working }
}
