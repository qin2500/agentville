#!/usr/bin/env node
// Agentville CLI for agents. No dependencies.
//   agentville start [--provider gemini|claude] [--cwd DIR] [--name N] [--model M] [--mode P] "prompt"
//   agentville status <agent-id>
//   agentville notify "message" [--title T]
// Common flags: --session <id>, --port 5275 (default: AGENTVILLE_PORT or 5275).
import http from 'node:http'

const USAGE = `Usage:
  agentville start [--provider gemini|claude] [--cwd DIR] [--name N] [--model M] [--mode P] "prompt"
  agentville status <agent-id>
  agentville notify "message" [--title T]
Common flags: --session <id>  --port 5275`

const fail = (msg, code = 1) => { console.error(`agentville: ${msg}`); process.exit(code) }
const usageFail = (msg) => { console.error(`agentville: ${msg}\n${USAGE}`); process.exit(2) }

const [cmd, ...args] = process.argv.slice(2)
if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(USAGE); process.exit(cmd ? 0 : 2) }
if (!['start', 'status', 'notify'].includes(cmd)) usageFail(`unknown command "${cmd}"`)

const FLAGS = {
  start: ['provider', 'cwd', 'name', 'model', 'mode', 'session', 'port'],
  status: ['session', 'port'],
  notify: ['title', 'session', 'port'],
}[cmd]
const opts = { port: process.env.AGENTVILLE_PORT || '5275' }
const rest = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0) }
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(a)
  if (m && FLAGS.includes(m[1])) {
    if (m[2] !== undefined) opts[m[1]] = m[2]
    else if (i + 1 >= args.length) usageFail(`--${m[1]} needs a value`)
    else opts[m[1]] = args[++i]
  } else if (a.startsWith('--') && a.length > 2) usageFail(`unknown flag ${a}`)
  else rest.push(a)
}

const port = Number(opts.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) usageFail('invalid --port')

// Gemini sets GEMINI_SESSION_ID inside its processes.
const sessionFromEnv = () => opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.AGENTVILLE_AGENT_ID || process.env.GEMINI_SESSION_ID || process.env.CODEX_THREAD_ID || ''
const needSession = () => {
  const s = sessionFromEnv()
  if (!s) usageFail('no session id. Pass --session, or run inside an agent (CLAUDE_CODE_SESSION_ID or AGENTVILLE_AGENT_ID).')
  return s
}

function call(method, path, body, done) {
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers = { origin: `http://127.0.0.1:${port}` }
  if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
  const req = http.request({ host: '127.0.0.1', port, path, method, timeout: 30000, headers }, (res) => {
    let out = ''
    res.on('data', (c) => { out += c })
    res.on('end', () => {
      let data = {}
      try { data = JSON.parse(out) } catch {}
      done(res.statusCode, data)
    })
  })
  req.on('timeout', () => req.destroy(new Error('timed out')))
  req.on('error', (err) => fail(`could not reach Agentville on port ${port} (${err.code || err.message})`))
  req.end(payload ?? undefined)
}
const errText = (status, body) => body.error || `server returned ${status}`

if (cmd === 'start') {
  const prompt = rest.join(' ').trim()
  if (!prompt) usageFail('start needs a prompt')
  const body = { session: needSession(), prompt }
  for (const k of ['provider', 'cwd', 'name', 'model']) if (opts[k]) body[k] = opts[k]
  if (opts.mode) body.permissionMode = opts.mode
  if (!body.cwd) body.cwd = process.cwd()
  call('POST', '/api/agents/start', body, (status, data) => {
    if (status === 200 && data.ok) {
      const id = data.id || (data.ref && data.ref.runId)
      if (!id) fail('started, but the server returned no agent id')
      console.log(id)
      process.exit(0)
    }
    fail(`start: ${errText(status, data)}`)
  })
} else if (cmd === 'status') {
  if (rest.length !== 1) usageFail('status needs exactly one agent id')
  call('GET', `/api/agents/${encodeURIComponent(rest[0])}/status`, undefined, (status, data) => {
    if (status === 200) { console.log(JSON.stringify(data)); process.exit(0) }
    fail(`status: ${status === 404 ? 'no such agent' : errText(status, data)}`)
  })
} else {
  const message = rest.join(' ').trim()
  if (!message) usageFail('notify needs a message')
  const body = { session: needSession(), message, ...(opts.title && { title: opts.title }) }
  call('POST', '/api/notify', body, (status, data) => {
    if (status === 200 && data.ok) process.exit(0)
    fail(`notify: ${status === 404 ? 'no Agentville agent matches this session' : errText(status, data)}`)
  })
}
