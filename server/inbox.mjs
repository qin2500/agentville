/**
 * Delivering one fleet message to a live Claude session's cross-session inbox.
 *
 * Wire format (Claude Code 2.1.x, `peerProtocol` 1, verified on a throwaway session): a unix socket
 * that reads newline-delimited JSON. One frame per message, unauthenticated (auth is required only
 * on Windows, which is refused here; key files are never read):
 *   {"type":"user","message":{"role":"user","content":"<cross-session-message from-name=\"Agentville\">\n…\n</cross-session-message>"},"priority":"next","msg_id":"<uuid>"}
 * The recipient records `origin.msg_id` on the queued turn, which is our only receipt.
 *
 * Safety: only user-owned sockets directly inside the cc-socks directories (or, in tests, only
 * inside AGENTVILLE_FLEET_SOCKET_ROOT). Under AGENTVILLE_TEST/NODE_ENV=test without that root, nothing is
 * ever sent. AGENTVILLE_FLEET_DRY_RUN=1 opens no socket at all.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { readTail } from './fsutil.mjs'

export const PEER_PROTOCOL = 1
const CONNECT_MS = 3000
export const RECEIPT_MS = 10_000

const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
export const dryRun = () => process.env.AGENTVILLE_FLEET_DRY_RUN === '1'

/** Why sending is impossible here, or '' when it is allowed. */
export function sendingBlocked() {
  if (process.platform === 'win32') return 'Sending to agents is not supported on Windows'
  if (testing() && !process.env.AGENTVILLE_FLEET_SOCKET_ROOT) return 'Sending is disabled in tests'
  return ''
}

function socketDirs() {
  if (process.env.AGENTVILLE_FLEET_SOCKET_ROOT) return [path.resolve(process.env.AGENTVILLE_FLEET_SOCKET_ROOT)]
  const uid = process.getuid?.()
  return ['/tmp/cc-socks', '/private/tmp/cc-socks', `/tmp/cc-socks-${uid}`, `/private/tmp/cc-socks-${uid}`,
    process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, 'cc-socks')].filter(Boolean)
}

/** '' when `inbox` is a usable peer socket; otherwise a fixed reason. */
export function inboxProblem(inbox) {
  if (!inbox?.sock) return "Can't be messaged by this Claude version"
  if (inbox.proto !== PEER_PROTOCOL) return 'Unsupported messaging protocol'
  const sock = inbox.sock
  if (typeof sock !== 'string' || !path.isAbsolute(sock) || path.normalize(sock) !== sock || !/^[\w.-]+\.sock$/.test(path.basename(sock))) {
    return "Its message socket isn't usable"
  }
  if (!socketDirs().includes(path.dirname(sock))) return "Its message socket isn't usable"
  const st = fs.lstatSync(sock, { throwIfNoEntry: false })
  if (!st?.isSocket() || (process.getuid && st.uid !== process.getuid())) return "Its message socket isn't usable"
  return ''
}

export const wrap = (text) => `<cross-session-message from-name="Agentville">\n${text}\n</cross-session-message>`

/** Write one frame; resolves { ok, msgId } or { ok:false, detail }. Never retries. */
export function deliver(inbox, text) {
  const msgId = crypto.randomUUID()
  const frame = JSON.stringify({ type: 'user', message: { role: 'user', content: wrap(text) }, priority: 'next', msg_id: msgId }) + '\n'
  return new Promise((resolve) => {
    let done = false
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(r) } }
    const sock = net.createConnection(inbox.sock)
    const timer = setTimeout(() => finish({ ok: false, detail: "Couldn't reach the session" }), CONNECT_MS)
    sock.on('error', () => finish({ ok: false, detail: "Couldn't reach the session" }))
    sock.on('connect', () => sock.end(frame, () => finish({ ok: true, msgId })))
  })
}

/** Poll each transcript's tail for its msg_id until all are seen or RECEIPT_MS passes. */
export async function awaitReceipts(pending, timeout = RECEIPT_MS) {
  const seen = new Map()
  const deadline = Date.now() + timeout
  while (seen.size < pending.length && Date.now() < deadline) {
    for (const p of pending) {
      if (seen.has(p.id) || !p.file) continue
      const tail = await readTail(p.file, 256 * 1024).catch(() => '')
      if (tail.includes(`"msg_id":"${p.msgId}"`)) seen.set(p.id, Date.now())
    }
    if (seen.size < pending.length) await new Promise((r) => setTimeout(r, 400))
  }
  return seen
}
