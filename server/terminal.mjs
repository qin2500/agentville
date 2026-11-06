/**
 * Put a command in a new terminal window. Ported from Bot Crossing server/lib/terminal.mjs (MIT,
 * Jarren Rocks); see NOTICE. The caller passes an argv whose argv[0] is already an absolute
 * executable and an existing absolute cwd; nothing here builds a command from user input.
 *
 * macOS: Ghostty (1.3+ native AppleScript `new window`), else Terminal.app (`do script`).
 * Linux: AGENTVILLE_TERMINAL, $TERMINAL, gnome-terminal, x-terminal-emulator.
 * `AGENTVILLE_TERMINAL` (a name or absolute path) is used alone when set: no fallback.
 */
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** PATH first, then `extraDirs`; absolute and a regular executable file, or null. */
export async function findExecutable(name, extraDirs = []) {
  if (typeof name !== 'string' || !name) return null
  const explicit = name.includes('/')
  for (const dir of explicit ? ['.'] : [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraDirs]) {
    const candidate = path.resolve(dir, name)
    try {
      await fsp.access(candidate, fsp.constants.X_OK)
      if ((await fsp.stat(candidate)).isFile()) return candidate
    } catch { /* not here */ }
  }
  return null
}

/** POSIX single-quoting: safe in sh, bash and zsh for any string, including newlines. */
export const shQuote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'"

/** How each known terminal wants "run this argv in this directory", after its end-of-options marker. */
const TERMINALS = {
  'gnome-terminal': (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  kgx: (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  ptyxis: (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  konsole: (dir, cmd) => ['--workdir', dir, '-e', ...cmd],
  'xfce4-terminal': (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  'mate-terminal': (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  kitty: (dir, cmd) => [`--directory=${dir}`, ...cmd],
  alacritty: (dir, cmd) => ['--working-directory', dir, '-e', ...cmd],
  ghostty: (dir, cmd) => [`--working-directory=${dir}`, '-e', ...cmd],
  wezterm: (dir, cmd) => ['start', '--cwd', dir, '--', ...cmd],
  foot: (dir, cmd) => [`--working-directory=${dir}`, ...cmd],
  terminator: (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  xterm: (_dir, cmd) => ['-e', ...cmd],
}

const macGhostty = () => [path.join('/Applications', 'Ghostty.app'), path.join(os.homedir(), 'Applications', 'Ghostty.app')]
  .map((app) => path.join(app, 'Contents', 'MacOS', 'ghostty')).find((bin) => fs.existsSync(bin)) || null
const TERMINAL_APP = '/System/Applications/Utilities/Terminal.app'

/**
 * Ghostty 1.3+ creates a window in the normal application instance via its native scripting
 * API. Dynamic values are process arguments, never script source. The native API takes command
 * text, not config-file shell:/direct: prefixes; Ghostty wraps it in bash `exec -l`, so provide
 * only the quoted executable and argv.
 */
export function ghosttyMacLaunch(executable, cwd, argv) {
  const suffix = `${path.sep}Contents${path.sep}MacOS${path.sep}ghostty`
  if (!executable.endsWith(suffix)) return null
  const bundle = executable.slice(0, -suffix.length)
  if (!bundle.endsWith('.app')) return null
  return {
    executable: '/usr/bin/osascript',
    args: [fileURLToPath(new URL('./ghostty-window.applescript', import.meta.url)), bundle, cwd, argv.map(shQuote).join(' ')],
    app: 'Ghostty',
  }
}

/** Terminal.app runs a shell command line in the user's login shell; cwd goes in as a quoted `cd`. */
export function terminalAppLaunch(cwd, argv) {
  return {
    executable: '/usr/bin/osascript',
    args: [fileURLToPath(new URL('./terminal-window.applescript', import.meta.url)), `cd ${shQuote(cwd)} && ${argv.map(shQuote).join(' ')}`],
    app: 'Terminal',
  }
}

/**
 * osascript must finish successfully and print the confirmation to count as a window. Never
 * infer success from elapsed time, retry, or fall back after a denial.
 */
export function runAppleScript(launch, cwd, timeout = 15000) {
  const app = launch.app || 'The terminal'
  return new Promise((resolve) => {
    execFile(launch.executable, launch.args, { cwd, timeout, maxBuffer: 16384 }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return resolve({ ok: false, error: `${app} did not confirm window creation. Check for an Automation permission prompt and an existing new window before trying again.` })
        const detail = String(stderr || '').trim()
        if (detail.includes('-1743') || /not authorized|not permitted/i.test(detail)) {
          return resolve({ ok: false, error: `macOS denied Automation access to ${app}. Allow it in System Settings > Privacy & Security > Automation, then try again.` })
        }
        // Not err.message: execFile embeds the argv, which holds the session id.
        return resolve({ ok: false, error: `${app} could not create a window (${detail.slice(0, 200) || err.code || 'launch failed'}). No fallback was attempted.` })
      }
      resolve(String(stdout).trim() === 'agentville-window-created'
        ? { ok: true }
        : { ok: false, error: `${app} did not confirm window creation. Check for a new window before trying again.` })
    })
  })
}

/** A refusal arrives at once; a later non-zero exit means the window came up and its command ended. */
const REFUSAL_MS = 300
const GRACE_MS = 1500

function trySpawn(cmd, args, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, stdio: 'ignore', detached: true })
    } catch (err) {
      return resolve({ ok: false, error: err?.code || 'spawn failed' })
    }
    const startedAt = Date.now()
    let timer = null
    let settled = false
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    child.on('error', (err) => done({ ok: false, error: err?.code || 'spawn failed' }))
    child.on('exit', (code, signal) => {
      if (code === 0 || Date.now() - startedAt >= REFUSAL_MS) return done({ ok: true })
      done({ ok: false, error: `${path.basename(cmd)} exited with ${signal ? `signal ${signal}` : `code ${code}`}` })
    })
    timer = setTimeout(() => { child.unref(); done({ ok: true }) }, GRACE_MS)
  })
}

/**
 * Which terminal would be used, without opening anything: `{ kind, name, bin }` or null.
 * kind: 'ghostty-mac' | 'terminal-app' | 'spawn'.
 */
export async function detectTerminal() {
  const override = process.env.AGENTVILLE_TERMINAL
  // Under test, only an explicitly named (fake) terminal may ever be used: never auto-detect.
  if (!override && (process.env.NODE_ENV === 'test' || process.env.AGENTVILLE_TEST === '1')) return null
  if (override) {
    const bin = await findExecutable(override)
    if (!bin) return null
    if (process.platform === 'darwin' && ghosttyMacLaunch(bin, '/', ['/x'])) return { kind: 'ghostty-mac', name: 'ghostty', bin }
    const name = path.basename(bin)
    return TERMINALS[name] || name === 'x-terminal-emulator' ? { kind: 'spawn', name, bin } : null
  }
  if (process.platform === 'darwin') {
    const ghostty = macGhostty()
    if (ghostty) return { kind: 'ghostty-mac', name: 'ghostty', bin: ghostty }
    return fs.existsSync(TERMINAL_APP) ? { kind: 'terminal-app', name: 'terminal', bin: TERMINAL_APP } : null
  }
  if (process.platform !== 'linux' || !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return null
  for (const name of [...new Set([process.env.TERMINAL, 'gnome-terminal', 'x-terminal-emulator'].filter(Boolean))]) {
    const bin = await findExecutable(name)
    const base = bin && path.basename(bin)
    if (bin && (TERMINALS[base] || base === 'x-terminal-emulator')) return { kind: 'spawn', name: base, bin }
  }
  return null
}

/** Run `argv` in a new window of `term` (from detectTerminal) with `cwd` as its directory. */
export async function openInTerminal(term, argv, cwd) {
  const wellFormed = Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string' && a)
  if (!wellFormed || !path.isAbsolute(argv[0]) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { ok: false, error: 'Invalid launch command' }
  }
  if (!term) return { ok: false, error: 'No supported terminal' }
  if (term.kind === 'ghostty-mac') return runAppleScript(ghosttyMacLaunch(term.bin, cwd, argv), cwd)
  if (term.kind === 'terminal-app') return runAppleScript(terminalAppLaunch(cwd, argv), cwd)
  // Debian's x-terminal-emulator wrapper only guarantees `-e`.
  const args = term.name === 'x-terminal-emulator' ? ['-e', ...argv] : TERMINALS[term.name](cwd, argv)
  const r = await trySpawn(term.bin, args, cwd)
  return r.ok ? r : { ok: false, error: `Could not open a terminal (${r.error})` }
}
