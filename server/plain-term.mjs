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

export const PLAIN_PREFIX = 'shell:'
export const KINDS = ['shell', 'claude', 'codex']
const LABEL = { shell: 'Terminal', claude: 'Claude', codex: 'Codex' }
const MAX_ENTRIES = 50

const refuse = (status, message) => Object.assign(new Error(message), { status })
const isDir = (p) => !!p && path.isAbsolute(p) && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()
const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }

/** `~/code/x` for a folder under home, else the full path. */
export const tilde = (dir, home = os.homedir()) => (dir === home ? '~' : dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir)

/** pid and every process below it in a `{ pid, ppid }` table (the root included). */
export function descendants(rootPid, procs) {
  const kids = new Map()
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p) }
  const out = new Map([[rootPid, procs.find((p) => p.pid === rootPid) || { pid: rootPid, ppid: 0, command: '' }]])
  const todo = [rootPid]
  while (todo.length) for (const k of kids.get(todo.pop()) || []) if (!out.has(k.pid)) { out.set(k.pid, k); todo.push(k.pid) }
  return [...out.values()]
}

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 3000, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout)))
})
/** All processes: `{ pid, ppid, command }` (command is the executable's path as ps shows it). */
export async function listProcesses() {
  const out = await run('/bin/ps', ['-axo', 'pid=,ppid=,comm='])
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], command: m[3].trim() }))
}
/** A process's working folder, or null (macOS and Linux with lsof). */
export async function cwdOf(pid) {
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
export function createPlainTerms({ home = os.homedir(), shell = () => process.env.SHELL, findBin, procs = listProcesses, cwd = cwdOf, registry = readRegistry } = {}) {
  const entries = new Map() // id -> { id, kind, argv, cwd, title, at }

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
    if (!allowed.includes(dir) || !isDir(dir)) throw refuse(400, 'Pick your home folder or one of the listed projects')
    let argv
    if (kind === 'shell') argv = [shellPath(), '-l']
    else {
      const bin = await findBin(kind)
      if (!bin) throw refuse(409, `${LABEL[kind]} CLI not found`)
      argv = [bin] // a fixed command: the CLI's own interactive mode, no flags
    }
    const id = `${PLAIN_PREFIX}${crypto.randomBytes(12).toString('base64url')}`
    const entry = { id, kind, argv, cwd: dir, title: `${LABEL[kind]} — ${tilde(dir, home)}`, at: Date.now() }
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
        const proc = tree.find((p) => path.basename(p.command) === 'codex')
        const dir = proc && await cwd(proc.pid)
        if (dir) {
          const cands = agents.filter((a) => a.harness === 'codex' && a.live && a.cwd && real(a.cwd) === real(dir) && !claimed.has(a.id))
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
