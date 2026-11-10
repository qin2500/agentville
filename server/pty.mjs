/**
 * The built-in terminal: at most one PTY per agent, running the command `openCommand` chose (never
 * one from the page), streamed to the browser over a loopback-only, Origin-checked WebSocket.
 *
 * - A POST spawns (or finds) the agent's PTY and returns a one-time ticket (30 s, single use).
 * - Any number of sockets may watch one PTY; a new one first gets the last ~200 KB of output.
 * - The PTY ends when its process exits, on stop/popout, on server shutdown, or `idleMs` after the
 *   last socket left. A socket closing only detaches.
 * - Every ticket carries this server's `boot` id. A page that lost its socket re-attaches with it
 *   (`reattach`): on the same boot a PTY that has since ended stays ended (`ended()`), so a
 *   reconnect never restarts an exited, stopped or idle-ended session; after a restart (new boot)
 *   the old PTY died with the old server, so it may start a fresh one.
 * - On shutdown every socket hears `{ type: 'ending', why: 'server-restart' }` and closes with 1012.
 * - Terminal content is never logged; the only things kept are the scrollback buffer in memory.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { isLocalRequest } from './local-request.mjs'

const TICKET_MS = 30_000
const SCROLLBACK = 200 * 1024
const IDLE_MS = 10 * 60_000
const END_WAIT_MS = 10_000
const MAX_FRAME = 64 * 1024

/** node-pty, or null with a reason. Its prebuilt spawn-helper is sometimes unpacked without +x. */
let backend
export function loadPty() {
  if (backend !== undefined) return backend
  try {
    const require = createRequire(import.meta.url)
    const pty = require('node-pty')
    const dir = path.dirname(require.resolve('node-pty/package.json'))
    for (const helper of [path.join(dir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), path.join(dir, 'build', 'Release', 'spawn-helper')]) {
      try {
        const st = fs.statSync(helper)
        if (!(st.mode & 0o100)) fs.chmodSync(helper, st.mode | 0o755)
      } catch { /* not this layout */ }
    }
    backend = { pty }
  } catch {
    backend = { pty: null, error: 'Built-in terminal unavailable (node-pty did not load). Run npm install.' }
  }
  return backend
}

/** A WebSocket upgrade must name our exact origin: unlike a GET, a missing Origin is refused. */
export const isLocalUpgrade = (req) => typeof req.headers.origin === 'string' && isLocalRequest(req)

/**
 * The server's env, minus what says "you are inside another program's terminal or agent": a server
 * started from a Claude Code shell would otherwise make the agent think it is nested.
 */
const INHERITED = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|ITERM_.*|GHOSTTY_.*|KITTY_.*|WEZTERM_.*|VSCODE_.*|TMUX|TMUX_PANE|STY)$/
export function ptyEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && !INHERITED.test(k)) out[k] = v
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'

/**
 * @param {object} o
 * @param {number} [o.idleMs]  how long a PTY with no sockets lives
 * @param {number} [o.endWaitMs]  how long a graceful end may take before it escalates
 */
export function createTerminals({ idleMs = IDLE_MS, endWaitMs = END_WAIT_MS, scrollback = SCROLLBACK } = {}) {
  const sessions = new Map() // agentId -> session
  const tickets = new Map() // ticket -> { agentId, expires }
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })
  const boot = crypto.randomBytes(9).toString('base64url')
  const lastEnd = new Map() // agentId -> why its last PTY ended (this boot only; reasons, never content)

  const available = () => !!loadPty().pty
  const info = () => ({ available: available(), running: [...sessions.values()].filter((s) => !s.exit).map((s) => s.agentId) })
  const get = (agentId) => { const s = sessions.get(agentId); return s && !s.exit ? s : null }

  function broadcast(s, msg) {
    const text = JSON.stringify(msg)
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(text)
  }

  function armIdle(s) {
    clearTimeout(s.idleTimer)
    if (s.clients.size || s.exit) return
    s.idleTimer = setTimeout(() => { end(s.agentId, 'idle') }, idleMs)
    s.idleTimer.unref?.()
  }

  /**
   * Spawn `argv` in `cwd` for this agent, or return the PTY it already has.
   * `kind`: 'attach' (a bg job's attach client) or 'resume' (the conversation's own process).
   */
  function open(agentId, { argv, cwd, kind, name }) {
    const { pty, error } = loadPty()
    if (!pty) throw Object.assign(new Error(error), { status: 501 })
    let s = get(agentId)
    if (s?.ending) throw Object.assign(new Error('The built-in terminal is closing; try again in a moment'), { status: 409 })
    const existing = !!s
    if (!s) {
      if (!Array.isArray(argv) || !argv.length || !path.isAbsolute(argv[0]) || !path.isAbsolute(cwd || '')) {
        throw Object.assign(new Error('Invalid launch command'), { status: 500 })
      }
      // Tests may only ever run a fake CLI from the directory they name.
      const fakes = process.env.AGENTVILLE_FAKE_BIN
      if (testing() && !(fakes && path.dirname(argv[0]) === path.resolve(fakes))) {
        throw Object.assign(new Error('Built-in terminal is disabled in tests unless AGENTVILLE_FAKE_BIN names the fake CLI folder'), { status: 501 })
      }
      let proc
      try {
        proc = pty.spawn(argv[0], argv.slice(1), { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: ptyEnv() })
      } catch {
        // Not the error text: it can carry the argv (a session id).
        throw Object.assign(new Error('Could not start the terminal process'), { status: 502 })
      }
      s = { agentId, name, kind, argv, cwd, proc, chunks: [], size: 0, clients: new Set(), exit: null, idleTimer: null, exited: null }
      const session = s
      s.exited = new Promise((resolve) => {
        proc.onExit(({ exitCode, signal }) => {
          session.exit = { code: exitCode, signal: signal || null }
          clearTimeout(session.idleTimer)
          broadcast(session, { type: 'exit', code: exitCode, signal: signal || null, why: session.ending || null })
          for (const ws of session.clients) ws.close(1000, 'exited')
          if (sessions.get(agentId) === session) sessions.delete(agentId)
          lastEnd.delete(agentId)
          lastEnd.set(agentId, session.ending || 'exit')
          while (lastEnd.size > 500) lastEnd.delete(lastEnd.keys().next().value)
          resolve(session.exit)
        })
      })
      proc.onData((d) => {
        session.chunks.push(d)
        session.size += d.length
        while (session.size > scrollback && session.chunks.length > 1) session.size -= session.chunks.shift().length
        for (const ws of session.clients) if (ws.readyState === 1) ws.send(Buffer.from(d, 'utf8'), { binary: true })
      })
      sessions.set(agentId, s)
      armIdle(s)
    }
    for (const [k, v] of tickets) if (Date.now() > v.expires) tickets.delete(k)
    const ticket = crypto.randomBytes(24).toString('base64url')
    tickets.set(ticket, { agentId, expires: Date.now() + TICKET_MS })
    return { ticket, existing, kind: s.kind, name: s.name, boot }
  }

  /**
   * A page re-attaching after its socket dropped names the boot its last ticket came from. On this
   * same boot with no live PTY, the session ended while it was away: why (never restarted for it).
   * Any other boot means the server restarted and took the PTY with it: null (a fresh one may start).
   */
  function ended(agentId, reattach) {
    if (typeof reattach !== 'string' || reattach !== boot || get(agentId)) return null
    return lastEnd.get(agentId) || 'exit'
  }

  /** Validate and consume a ticket: the agent id it was issued for, or null. */
  function redeem(ticket) {
    const t = typeof ticket === 'string' && tickets.get(ticket)
    if (!t) return null
    tickets.delete(ticket)
    return Date.now() <= t.expires ? t.agentId : null
  }

  function reject(socket, status, text) {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  /** The http server's 'upgrade' handler for /api/term/ws?ticket=…. */
  function upgrade(req, socket, head) {
    let url
    try { url = new URL(req.url, 'http://local') } catch { return reject(socket, 400, 'Bad Request') }
    if (url.pathname !== '/api/term/ws') return reject(socket, 404, 'Not Found')
    if (!isLocalUpgrade(req)) return reject(socket, 403, 'Forbidden')
    const agentId = redeem(url.searchParams.get('ticket'))
    if (!agentId) return reject(socket, 401, 'Unauthorized')
    const s = get(agentId)
    if (!s) return reject(socket, 410, 'Gone')
    wss.handleUpgrade(req, socket, head, (ws) => attach(s, ws))
  }

  function attach(s, ws) {
    clearTimeout(s.idleTimer)
    s.clients.add(ws)
    ws.send(JSON.stringify({ type: 'attached', name: s.name, kind: s.kind, replay: s.size }))
    if (s.size) ws.send(Buffer.from(s.chunks.join(''), 'utf8'), { binary: true })
    ws.on('message', (data, isBinary) => {
      if (s.exit || s.ending) return
      if (isBinary) return s.proc.write(data.toString('utf8'))
      let m
      try { m = JSON.parse(data.toString('utf8')) } catch { return }
      if (m?.type === 'input' && typeof m.data === 'string') s.proc.write(m.data)
      else if (m?.type === 'ping') { if (ws.readyState === 1) ws.send('{"type":"pong"}') }
      else if (m?.type === 'resize') {
        const cols = Math.round(Number(m.cols)), rows = Math.round(Number(m.rows))
        if (cols >= 2 && cols <= 500 && rows >= 1 && rows <= 300) { try { s.proc.resize(cols, rows) } catch { /* exited */ } }
      }
    })
    ws.on('close', () => { s.clients.delete(ws); armIdle(s) })
    ws.on('error', () => {})
  }

  const wait = (s, ms) => Promise.race([s.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), ms).unref?.())])
  const signal = (s, sig) => { try { s.proc.kill(sig) } catch { /* gone */ } }

  /**
   * End an agent's PTY and wait for its process to exit. An attach client is simply hung up
   * (that detaches; the job keeps running). The conversation's own process gets Ctrl-C twice, then
   * SIGTERM, then SIGKILL, within `endWaitMs` in all. Resolves true once it has exited.
   */
  async function end(agentId, why = 'stop') {
    const s = get(agentId)
    if (!s) return true
    s.ending ||= why
    broadcast(s, { type: 'ending', why })
    const step = Math.max(50, Math.floor(endWaitMs * 0.4))
    if (s.kind === 'attach') {
      signal(s, 'SIGHUP')
      if (await wait(s, step)) return true
      signal(s, 'SIGTERM')
    } else {
      try { s.proc.write('\x03') } catch { /* gone */ }
      await wait(s, 150)
      try { s.proc.write('\x03') } catch { /* gone */ }
      if (await wait(s, step)) return true
      signal(s, 'SIGTERM')
    }
    if (await wait(s, endWaitMs - step - 150)) return true
    signal(s, 'SIGKILL')
    return wait(s, 1000)
  }

  /**
   * Server shutdown: tell every page the server is going down (it reconnects once it is back), then
   * hang up every PTY (for `claude attach`, that only detaches). A process that ignores the hang-up
   * gets SIGTERM, then SIGKILL, so none outlives the server holding a conversation. Resolves once
   * all have exited (at most ~2 s).
   */
  async function closeAll() {
    const all = [...sessions.values()]
    for (const ws of wss.clients) {
      if (ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'ending', why: 'server-restart' })); ws.close(1012, 'server-restart') } catch { /* gone */ } }
      setTimeout(() => ws.terminate(), 300).unref?.() // a page that never answers the close
    }
    for (const s of all) { clearTimeout(s.idleTimer); s.ending ||= 'shutdown'; signal(s, 'SIGHUP') }
    tickets.clear()
    await Promise.all(all.map(async (s) => {
      if (await wait(s, 800)) return
      signal(s, 'SIGTERM')
      if (await wait(s, 800)) return
      signal(s, 'SIGKILL')
      await wait(s, 400)
    }))
  }

  return { available, info, get, open, ended, redeem, upgrade, end, closeAll, sessions, boot }
}
