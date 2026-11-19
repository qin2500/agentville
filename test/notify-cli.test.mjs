// tools/notify.mjs, from the spec: session from --session, else CLAUDE_CODE_SESSION_ID, else CODEX_THREAD_ID;
// exit 2 with neither; exit 0 on success; non-zero when the server is down or answers 404.
// Runs against a stub HTTP server on an ephemeral 127.0.0.1 port. Nothing real is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../tools/notify.mjs', import.meta.url))

function stub(status = 200, reply) {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw) } catch {}
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply ?? (status === 200 ? { ok: true, id: 'claude-code:x', notice: { message: 'm', count: 1 } } : { ok: false, error: 'unknown session' })))
    })
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ seen, port: server.address().port, close: () => new Promise((c) => { server.close(c); server.closeAllConnections?.() }) })))
}

function run(args, env = {}) {
  assert.ok(fs.existsSync(CLI), 'tools/notify.mjs exists')
  // A scrubbed env: only PATH and what the test passes, so no real session id leaks in.
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { err += d })
    const t = setTimeout(() => p.kill(), 15000)
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
}

test('--session posts { session, message } to /api/notify with a matching Origin and exits 0', async () => {
  const s = await stub()
  try {
    const r = await run(['build is green', '--session', 'sess-1', '--port', String(s.port)])
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(s.seen.length, 1)
    assert.equal(s.seen[0].method, 'POST')
    assert.equal(s.seen[0].url, '/api/notify')
    assert.equal(s.seen[0].body.session, 'sess-1')
    assert.equal(s.seen[0].body.message, 'build is green')
    assert.equal(s.seen[0].headers.origin, `http://127.0.0.1:${s.port}`, 'the local guard needs an Origin')
  } finally { await s.close() }
})

test('--title is sent as title', async () => {
  const s = await stub()
  try {
    const r = await run(['hello', '--title', 'Heads up', '--session', 's', '--port', String(s.port)])
    assert.equal(r.code, 0, r.err)
    assert.equal(s.seen[0].body.title, 'Heads up')
  } finally { await s.close() }
})

test('without --session it reads CLAUDE_CODE_SESSION_ID', async () => {
  const s = await stub()
  try {
    const r = await run(['hi', '--port', String(s.port)], { CLAUDE_CODE_SESSION_ID: 'claude-sess' })
    assert.equal(r.code, 0, r.err)
    assert.equal(s.seen[0].body.session, 'claude-sess')
  } finally { await s.close() }
})

test('without --session it falls back to CODEX_THREAD_ID', async () => {
  const s = await stub()
  try {
    const r = await run(['hi', '--port', String(s.port)], { CODEX_THREAD_ID: 'codex-thread' })
    assert.equal(r.code, 0, r.err)
    assert.equal(s.seen[0].body.session, 'codex-thread')
  } finally { await s.close() }
})

test('CLAUDE_CODE_SESSION_ID wins over CODEX_THREAD_ID', async () => {
  const s = await stub()
  try {
    const r = await run(['hi', '--port', String(s.port)], { CLAUDE_CODE_SESSION_ID: 'c1', CODEX_THREAD_ID: 't1' })
    assert.equal(r.code, 0, r.err)
    assert.equal(s.seen[0].body.session, 'c1')
  } finally { await s.close() }
})

test('--session beats the environment', async () => {
  const s = await stub()
  try {
    const r = await run(['hi', '--session', 'explicit', '--port', String(s.port)], { CLAUDE_CODE_SESSION_ID: 'c1' })
    assert.equal(r.code, 0, r.err)
    assert.equal(s.seen[0].body.session, 'explicit')
  } finally { await s.close() }
})

test('no session anywhere: exit code 2 and nothing is sent', async () => {
  const s = await stub()
  try {
    const r = await run(['hi', '--port', String(s.port)])
    assert.equal(r.code, 2, r.err + r.out)
    assert.equal(s.seen.length, 0)
  } finally { await s.close() }
})

test('a 404 from the server is a non-zero exit', async () => {
  const s = await stub(404)
  try {
    const r = await run(['hi', '--session', 'nope', '--port', String(s.port)])
    assert.notEqual(r.code, 0)
    assert.notEqual(r.code, 2, 'exit 2 is reserved for a missing session')
  } finally { await s.close() }
})

test('server down: non-zero exit', async () => {
  const s = await stub()
  const port = s.port
  await s.close() // the port is now closed
  const r = await run(['hi', '--session', 's', '--port', String(port)])
  assert.notEqual(r.code, 0)
  assert.notEqual(r.code, 2)
})
