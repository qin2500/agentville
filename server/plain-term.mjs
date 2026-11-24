/**
 * Plain terminals: a login shell (or an interactive `claude` / `codex`) in the built-in terminal,
 * with no agent behind it. The page may only choose WHAT KIND (an enumerated value) and a folder
 * that is the user's home or one of the known projects; the command is built here and never comes
 * from a request. A plain terminal has an unguessable `shell:` id, is not an agent, and never
 * appears in the village or the agent list.
 *
 * Linking: when `claude` or `codex` runs inside one, the agent it becomes is found from the PTY's
 * process tree (the Claude CLI's own session registry names its pid; Codex has no registry, so its
 * process's folder picks the live Codex agent there). Nothing in the user's shell is configured.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { home as claudeHome } from './claude-code.mjs'
import { execTarget as platformExecTarget } from './platform.mjs'

export const PLAIN_PREFIX = 'shell:'
export const KINDS = ['shell', 'claude', 'codex']
const LABEL = { shell: 'Terminal', claude: 'Claude', codex: 'Codex' }
const MAX_ENTRIES = 50

const refuse = (status, message) => Object.assign(new Error(message), { status })
const isDir = (p) => !!p && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()
const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }

/** A path as compared on `platform`: on win32, forward slashes, no trailing slash, case-folded. */
export function normPath(p, platform = process.platform) {
  if (platform !== 'win32') return p
  const n = path.win32.normalize(String(p)).replace(/\\/g, '/')
  return (n.length > 3 ? n.replace(/\/+$/, '') : n).toLowerCase()
}

/** `~/code/x` for a folder under home, else the full path. */
export function tilde(dir, home = os.homedir(), platform = process.platform) {
  if (platform !== 'win32') return dir === home ? '~' : dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir
  const d = normPath(dir, platform)
  const h = normPath(home, platform)
  if (d === h) return '~'
  return d.startsWith(h.replace(/\/$/, '') + '/') ? `~${dir.slice(h.replace(/\/$/, '').length).replace(/\\/g, '/')}` : dir
}

/** A process name without its Windows executable extension, lower-cased on win32. */
const exeName = (command, platform = process.platform) => {
  if (platform !== 'win32') return path.basename(command)
  return path.win32.basename(String(command)).replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase()
}

/** pid and every process below it in a `{ pid, ppid }` table (the root included). */
export function descendants(rootPid, procs) {
  const kids = new Map()
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p) }
  const out = new Map([[rootPid, procs.find((p) => p.pid === rootPid) || { pid: rootPid, ppid: 0, command: '' }]])
  const todo = [rootPid]
  while (todo.length) for (const k of kids.get(todo.pop()) || []) if (!out.has(k.pid)) { out.set(k.pid, k); todo.push(k.pid) }
  return [...out.values()]
}

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 3000, maxBuffer: 4 << 20, ...opts }, (err, stdout) => resolve(err ? '' : String(stdout)))
})
const WIN_PS = ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress']
/** Parse `ConvertTo-Json` output: an array, or a bare object when there is exactly one process. */
export function parseWinProcesses(out) {
  let j
  try { j = JSON.parse(String(out).replace(/^\uFEFF/, '')) } catch { return [] }
  return (Array.isArray(j) ? j : [j]).filter((r) => r && Number.isInteger(r.ProcessId))
    .map((r) => ({ pid: r.ProcessId, ppid: Number.isInteger(r.ParentProcessId) ? r.ParentProcessId : 0, command: String(r.Name || '') }))
}
/** All processes: `{ pid, ppid, command }` (command is the executable's path as ps shows it; on Windows its name). */
export async function listProcesses({ platform = process.platform, exec = run } = {}) {
  if (platform === 'win32') {
    return parseWinProcesses(await exec('powershell.exe', WIN_PS, { windowsHide: true, timeout: 15000 }))
  }
  const out = await exec('/bin/ps', ['-axo', 'pid=,ppid=,comm='])
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], command: m[3].trim() }))
}
/** A process's working folder, or null (macOS and Linux with lsof; always null on Windows). */
export async function cwdOf(pid, { platform = process.platform } = {}) {
  if (platform === 'win32') return null
  const out = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) || null
}
/** The Claude CLI's live-session registry: `{ pid, sessionId, cwd, kind }` per file. Read only. */
export async function readRegistry(dir = path.join(claudeHome(), 'sessions')) {
  const out = []
  let names = []
  try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')) } catch { return out }
  for (const n of names) {
    try {
      const s = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'))
      if (s?.sessionId && Number.isInteger(s.pid)) out.push({ pid: s.pid, sessionId: s.sessionId, cwd: s.cwd || '', kind: s.kind || '' })
    } catch { /* unreadable: not a session */ }
  }
  return out
}

/**
 * @param {object} o
 * @param {() => string|null} [o.shell]  the login shell (default $SHELL when absolute)
 * @param {(name: string) => Promise<string|null>} o.findBin  absolute path of `claude` / `codex`
 */
/** Is `p` an existing file? */
const isFile = (p) => !!fs.statSync(p, { throwIfNoEntry: false })?.isFile()

/** The default Windows shell: pwsh on PATH, else Windows PowerShell, else %ComSpec%. */
export function winShell({ env = process.env, exists = isFile } = {}) {
  const get = (k) => env[k] ?? env[Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase())]
  for (const d of String(get('PATH') || '').split(';').filter(Boolean)) {
    const f = path.win32.join(d.replace(/^"|"$/g, ''), 'pwsh.exe')
    if (exists(f)) return f
  }
  const root = get('SystemRoot') || get('windir') || 'C:\\Windows'
  const ps = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (exists(ps)) return ps
  return get('ComSpec') || path.win32.join(root, 'System32', 'cmd.exe')
}

export function createPlainTerms({
  home = os.homedir(), shell = () => process.env.SHELL, findBin, procs = () => listProcesses(), cwd = cwdOf, registry = readRegistry,
  platform = process.platform, env = process.env, exists = isFile, execTarget = platformExecTarget,
} = {}) {
  const win = platform === 'win32'
  const entries = new Map() // id -> { id, kind, argv, cwd, title, at }

  const shellArgv = () => {
    const f = winShell({ env, exists })
    return /(^|[\\/])(pwsh|powershell)\.exe$/i.test(f) ? [f, '-NoLogo'] : [f]
  }
  const shellPath = () => {
    const s = shell()
    return typeof s === 'string' && path.isAbsolute(s) && fs.statSync(s, { throwIfNoEntry: false })?.isFile() ? s : '/bin/zsh'
  }

  /** Register a plain terminal. `projects` are the folders the app already offers ({ dir }). */
  async function create({ kind = 'shell', cwd: want, projects = [] } = {}) {
    if (!KINDS.includes(kind)) throw refuse(400, 'Unknown terminal kind')
    const dir = want == null || want === '' ? home : want
    if (typeof dir !== 'string') throw refuse(400, 'The folder must be text')
    const allowed = [home, ...projects.map((p) => p.dir)]
    const same = (a) => normPath(a, platform) === normPath(dir, platform)
    if (!allowed.some(same) || !isDir(dir)) throw refuse(400, 'Pick your home folder or one of the listed projects')
    let argv
    if (kind === 'shell') argv = win ? shellArgv() : [shellPath(), '-l']
    else {
      const bin = await findBin(kind)
      if (!bin) throw refuse(409, `${LABEL[kind]} CLI not found`)
      argv = [bin] // a fixed command: the CLI's own interactive mode, no flags
      if (win && /\.(cmd|bat)$/i.test(bin)) {
        try { const t = execTarget(bin, [], { platform, env }); argv = [t.file, ...t.args] } catch { throw refuse(409, `${LABEL[kind]} CLI path cannot be launched`) }
      } // ConPTY cannot run a .cmd directly
    }
    const id = `${PLAIN_PREFIX}${crypto.randomBytes(12).toString('base64url')}`
    const entry = { id, kind, argv, cwd: dir, title: `${LABEL[kind]} — ${tilde(dir, home, platform)}`, at: Date.now() }
    entries.set(id, entry)
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
    return entry
  }

  const get = (id) => (typeof id === 'string' ? entries.get(id) || null : null)
  const forget = (id) => entries.delete(id)

  /**
   * The running plain terminals, each with the agent now living in it (or null). `terms` is the
   * pty registry (needs `get(id)` -> session with `proc.pid`), `agents` the latest snapshot.
   */
  async function status(terms, agents) {
    const running = [...entries.values()].map((e) => ({ e, s: terms.get(e.id) })).filter((x) => x.s?.proc?.pid)
    if (!running.length) return []
    const table = await procs()
    const reg = await registry()
    const claimed = new Set()
    const out = []
    for (const { e, s } of running) {
      const tree = descendants(s.proc.pid, table)
      const pids = new Set(tree.map((p) => p.pid))
      let agentId = null
      // Claude: its registry names the pid of a process in this terminal's tree.
      const mine = reg.filter((r) => pids.has(r.pid) && (!r.kind || r.kind === 'interactive'))
      for (const r of mine.reverse()) {
        const id = `claude-code:${r.sessionId}`
        if (agents.some((a) => a.id === id) && !claimed.has(id)) { agentId = id; break }
      }
      // Codex: no registry. A codex process here + the one live Codex agent in its folder.
      if (!agentId) {
        const proc = tree.find((p) => exeName(p.command, platform) === 'codex')
        // Windows cannot read another process's folder: use the folder the terminal was opened in.
        const dir = proc && ((await cwd(proc.pid)) || (win ? e.cwd : null))
        if (dir) {
          const same = (a, b) => (win ? normPath(a, platform) === normPath(b, platform) : real(a) === real(b))
          const cands = agents.filter((a) => a.harness === 'codex' && a.live && a.cwd && same(a.cwd, dir) && !claimed.has(a.id))
          cands.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
          agentId = cands[0]?.id || null
        }
      }
      if (agentId) claimed.add(agentId)
      out.push({ id: e.id, kind: e.kind, title: e.title, cwd: e.cwd, agentId })
    }
    return out
  }

  return { create, get, forget, status, entries }
}
