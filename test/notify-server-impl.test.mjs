// Server + CLI side of agent notifications. Fixture homes and temp data dirs only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { withServer } from './support/with-server.mjs'
import { IDS } from './fixtures/make-home.mjs'
import { parseNotify, resolveSession, createNotifications } from '../server/notify.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(here, '../tools/notify.mjs')
const AGENT = `claude-code:${IDS.soloTurn}`

function call(port, method, p, body, { origin = `http://127.0.0.1:${port}` } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body)
  const headers = { host: `127.0.0.1:${port}` }
  if (origin) headers.origin = origin
  if (data !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data) }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null } catch {} resolve({ status: res.statusCode, body: j }) })
    })
    req.on('error', reject)
    req.end(data)
  })
}
const agentsOf = async (port) => (await call(port, 'GET', '/api/agents')).body.agents

test('parseNotify validates and cleans', () => {
  assert.deepEqual(parseNotify({ session: 's', message: '  hi\u0007 there\n', title: ' t ' }), { session: 's', message: 'hi there', title: 't' })
  for (const b of [null, [], {}, { session: 's' }, { session: 's', message: '   ' }, { session: 's', message: 'x'.repeat(501) }, { session: 's', message: 'x', title: 'y'.repeat(81) }, { session: 's', message: 5 }]) {
    assert.throws(() => parseNotify(b), (e) => e.status === 400)
  }
  assert.equal(parseNotify({ session: 's', message: 'x'.repeat(500) }).message.length, 500)
})

test('resolveSession accepts ids, bare session ids and fork sids', () => {
  const agents = [{ id: 'claude-code:abc' }, { id: 'codex:t1' }, { id: 'claude-code:abc:sub:7' }, { id: 'claude-code:job' }]
  assert.equal(resolveSession('claude-code:abc', agents), 'claude-code:abc')
  assert.equal(resolveSession('abc', agents), 'claude-code:abc')
  assert.equal(resolveSession('t1', agents), 'codex:t1')
  assert.equal(resolveSession('claude-code:abc:sub:7', agents), 'claude-code:abc:sub:7')
  assert.equal(resolveSession('resumed', agents, (id) => (id === 'claude-code:job' ? 'resumed' : null)), 'claude-code:job')
  assert.equal(resolveSession('nope', agents), null)
})

test('store: count, clear, cap, prune, rate limit', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'village-notify-'))
  let t = 1_000_000
  const n = createNotifications(dir, { now: () => t })
  try {
    assert.equal((await n.add('a', { message: 'one', title: '' })).count, 1)
    assert.equal((await n.add('a', { message: 'two', title: 'T' })).count, 2)
    assert.equal((await n.load()).a.message, 'two')
    assert.equal(await n.clear('a'), true)
    assert.equal(await n.clear('a'), false)
    for (let i = 0; i < 205; i++) { t++; await n.add(`x${i}`, { message: 'm', title: '' }) }
    const all = await n.load()
    assert.equal(Object.keys(all).length, 200)
    assert.ok(!('x0' in all) && 'x204' in all)
    t += 8 * 24 * 3600_000
    assert.equal(await n.prune(new Set(['x204'])), true)
    assert.deepEqual(Object.keys(await n.load()), ['x204'])
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')))
    for (let i = 0; i < 30; i++) assert.equal(n.allow('r'), true)
    assert.equal(n.allow('r'), false)
    assert.equal(n.allow('other'), true)
    t += 61_000
    assert.equal(n.allow('r'), true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('API: notify, snapshot, clear, guards', async () => {
  await withServer(async ({ port, dataDir }) => {
    const bare = IDS.soloTurn
    let r = await call(port, 'POST', '/api/notify', { session: bare, message: 'done with X', title: 'X' })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.id, AGENT)
    assert.equal(r.body.notice.count, 1)
    r = await call(port, 'POST', '/api/notify', { session: AGENT, message: 'again' })
    assert.equal(r.body.notice.count, 2)
    const a = (await agentsOf(port)).find((x) => x.id === AGENT)
    assert.equal(a.notice.message, 'again')
    assert.equal(a.notice.count, 2)
    assert.ok(typeof a.notice.at === 'number')
    assert.ok((await agentsOf(port)).filter((x) => x.id !== AGENT).every((x) => x.notice === null))
    assert.ok(fs.existsSync(path.join(dataDir, 'notifications.json')))

    assert.equal((await call(port, 'POST', '/api/notify', { session: 'nope', message: 'x' })).status, 404)
    assert.equal((await call(port, 'POST', '/api/notify', { session: bare, message: '' })).status, 400)
    assert.equal((await call(port, 'POST', '/api/notify', { session: bare, message: 'x' }, { origin: null })).status, 403)
    assert.equal((await call(port, 'POST', '/api/notify', { session: bare, message: 'x' }, { origin: 'http://evil.example' })).status, 403)
    assert.equal((await call(port, 'POST', '/api/notify/clear', { id: AGENT }, { origin: null })).status, 403)

    r = await call(port, 'POST', '/api/notify/clear', { id: AGENT })
    assert.deepEqual([r.status, r.body], [200, { ok: true }])
    assert.equal((await call(port, 'POST', '/api/notify/clear', { id: AGENT })).status, 200)
    assert.equal((await agentsOf(port)).find((x) => x.id === AGENT).notice, null)
  })
})

test('API: 429 past 30 a minute per agent', async () => {
  await withServer(async ({ port }) => {
    let last
    for (let i = 0; i < 31; i++) last = await call(port, 'POST', '/api/notify', { session: IDS.soloTurn, message: `m${i}` })
    assert.equal(last.status, 429)
  })
})

test('CLI: exit codes, success, no secret leak', async () => {
  const run = (args, env = {}) => new Promise((resolve) => execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })))
  assert.equal((await run(['hi'])).code, 2)
  assert.equal((await run([], { CLAUDE_CODE_SESSION_ID: 'x' })).code, 2)
  await withServer(async ({ port }) => {
    const ok = await run(['done', '--title', 'T', '--port', String(port)], { CLAUDE_CODE_SESSION_ID: IDS.soloTurn, SECRET_TOKEN: 'sk-leak' })
    assert.equal(ok.code, 0, ok.stderr)
    assert.equal((await agentsOf(port)).find((x) => x.id === AGENT).notice.title, 'T')
    const viaCodex = await run(['hi', '--port', String(port)], { CODEX_THREAD_ID: IDS.codexRunning })
    assert.equal(viaCodex.code, 0, viaCodex.stderr)
    const missing = await run(['hi', '--session', 'nope', '--port', String(port)], { SECRET_TOKEN: 'sk-leak' })
    assert.equal(missing.code, 1)
    assert.ok(!missing.stderr.includes('sk-leak'))
    const down = await run(['hi', '--session', 's', '--port', '1'])
    assert.equal(down.code, 1)
    assert.match(down.stderr, /could not reach/)
  })
})
