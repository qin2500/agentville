#!/usr/bin/env node
// Push a notification from an agent into Agentville. No dependencies.
// Usage: node tools/notify.mjs "message" [--title "t"] [--session <id>] [--port 5275]
import http from 'node:http'

const args = process.argv.slice(2)
const opts = { title: '', session: '', port: process.env.AGENTVILLE_PORT || '5275' }
const rest = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--title' || a === '--session' || a === '--port') {
    if (i + 1 >= args.length) { console.error(`notify: ${a} needs a value`); process.exit(2) }
    opts[a.slice(2)] = args[++i]
  } else if (a === '-h' || a === '--help') {
    console.log('Usage: notify.mjs "message" [--title "t"] [--session <id>] [--port 5275]'); process.exit(0)
  } else rest.push(a)
}
const message = rest.join(' ').trim()
if (!message) { console.error('notify: a message is required. Usage: notify.mjs "message" [--title "t"] [--session <id>] [--port 5275]'); process.exit(2) }
const session = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || ''
if (!session) { console.error('notify: no session id. Pass --session, or run inside Claude Code (CLAUDE_CODE_SESSION_ID) or Codex (CODEX_THREAD_ID).'); process.exit(2) }
const port = Number(opts.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('notify: invalid --port'); process.exit(2) }

const payload = JSON.stringify({ session, message, ...(opts.title && { title: opts.title }) })
const req = http.request({
  host: '127.0.0.1', port, path: '/api/notify', method: 'POST', timeout: 10000,
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), origin: `http://127.0.0.1:${port}` },
}, (res) => {
  let out = ''
  res.on('data', (c) => { out += c })
  res.on('end', () => {
    let body = {}
    try { body = JSON.parse(out) } catch {}
    if (res.statusCode === 200 && body.ok) process.exit(0)
    console.error(`notify: ${res.statusCode === 404 ? 'no Agentville agent matches this session' : body.error || `server returned ${res.statusCode}`}`)
    process.exit(1)
  })
})
req.on('timeout', () => req.destroy(new Error('timed out')))
req.on('error', (err) => { console.error(`notify: could not reach Agentville on port ${port} (${err.code || err.message})`); process.exit(1) })
req.end(payload)
