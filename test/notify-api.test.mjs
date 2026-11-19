// Regression tests for POST /api/notify, POST /api/notify/clear and the `notice` field on GET /api/agents.
// Written from the spec, not the implementation. Fixture homes only (withServer + makeHome); nothing real.
process.env.AGENTVILLE_TEST = '1'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { withServer } from './support/with-server.mjs'
import { IDS } from './fixtures/make-home.mjs'

const CLAUDE = IDS.soloTurn // Claude Code session id
const CODEX = IDS.codexTurn // Codex thread id

const call = async (base, p, { method = 'GET', body, origin = base, headers = {} } = {}) => {
  const h = { ...headers }
  if (body !== undefined) h['content-type'] = 'application/json'
  if (origin !== null) h.origin = origin
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  let json = null
  try { json = await r.json() } catch {}
  return { status: r.status, body: json }
}
const notify = (base, body, o) => call(base, '/api/notify', { method: 'POST', body, ...o })
const clear = (base, body, o) => call(base, '/api/notify/clear', { method: 'POST', body, ...o })
const agents = async (base) => (await call(base, '/api/agents')).body.agents
const find = async (base, sid) => (await agents(base)).find((a) => a.id.endsWith(sid))

test('every agent has notice: null before any notify', () => withServer(async ({ base }) => {
  const list = await agents(base)
  assert.ok(list.length > 0)
  for (const a of list) assert.ok('notice' in a && a.notice === null, `${a.id} notice`)
}))

test('notify a Claude session: 200 { ok, id, notice } and GET /api/agents shows it', () => withServer(async ({ base }) => {
  const before = await find(base, CLAUDE)
  const r = await notify(base, { session: CLAUDE, message: 'build is green', title: 'CI' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  assert.equal(typeof r.body.id, 'string')
  assert.ok(r.body.id.endsWith(CLAUDE))
  assert.equal(r.body.notice.message, 'build is green')
  assert.equal(r.body.notice.title, 'CI')
  assert.equal(r.body.notice.count, 1)
  assert.equal(typeof r.body.notice.at, 'number')
  const a = await find(base, CLAUDE)
  assert.deepEqual(a.notice, r.body.notice)
  assert.equal(a.bucket, before.bucket, 'the real bucket is unchanged')
  assert.equal(a.reason, before.reason)
}))

test('notify a Codex thread works too', () => withServer(async ({ base }) => {
  const r = await notify(base, { session: CODEX, message: 'tests done' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await find(base, CODEX)).notice.message, 'tests done')
  assert.equal((await find(base, CLAUDE)).notice, null, 'other agents are untouched')
}))

test('a new notice replaces the message and increments count', () => withServer(async ({ base }) => {
  await notify(base, { session: CLAUDE, message: 'first' })
  const r = await notify(base, { session: CLAUDE, message: 'second' })
  assert.equal(r.status, 200)
  assert.equal(r.body.notice.message, 'second')
  assert.equal(r.body.notice.count, 2)
  const n = (await find(base, CLAUDE)).notice
  assert.equal(n.message, 'second')
  assert.equal(n.count, 2)
}))

test('message is trimmed; control characters are stripped', () => withServer(async ({ base }) => {
  const r = await notify(base, { session: CLAUDE, message: '  hel\u0000lo\u0007 wor\u001bld \n', title: 'T\u0001i\u0002tle' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.notice.message, 'hello world')
  assert.equal(r.body.notice.title, 'Title')
}))

test('input validation: 400 for bad bodies', () => withServer(async ({ base }) => {
  const bad = [
    {}, { session: CLAUDE }, { message: 'x' },
    { session: CLAUDE, message: '' },
    { session: CLAUDE, message: '   \n ' },
    { session: CLAUDE, message: 'x'.repeat(501) },
    { session: CLAUDE, message: 42 },
    { session: CLAUDE, message: 'ok', title: 'y'.repeat(81) },
    { session: 7, message: 'ok' },
  ]
  for (const body of bad) {
    const r = await notify(base, body)
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)} -> ${r.status}`)
    assert.equal(r.body?.ok, false)
  }
  const raw = await fetch(base + '/api/notify', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{nope' })
  assert.equal(raw.status, 400)
  assert.equal((await find(base, CLAUDE)).notice, null, 'rejected input stores nothing')
}))

test('input limits: 500-char message and 80-char title are accepted', () => withServer(async ({ base }) => {
  const r = await notify(base, { session: CLAUDE, message: 'm'.repeat(500), title: 't'.repeat(80) })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.notice.message.length, 500)
  const one = await notify(base, { session: CLAUDE, message: ' x ' })
  assert.equal(one.status, 200)
}))

test('unknown session: 404 { ok: false, error }', () => withServer(async ({ base }) => {
  const r = await notify(base, { session: 'deadbeef-0000-4000-8000-000000000000', message: 'hi' })
  assert.equal(r.status, 404)
  assert.equal(r.body.ok, false)
  assert.equal(typeof r.body.error, 'string')
}))

test('rate limit: 429 after 30 notifies per minute for one agent, other agents unaffected', () => withServer(async ({ base }) => {
  for (let i = 0; i < 30; i++) {
    const r = await notify(base, { session: CLAUDE, message: `n${i}` })
    assert.equal(r.status, 200, `notify ${i + 1}: ${JSON.stringify(r.body)}`)
  }
  const over = await notify(base, { session: CLAUDE, message: 'one too many' })
  assert.equal(over.status, 429)
  assert.equal(over.body.ok, false)
  assert.equal((await notify(base, { session: CODEX, message: 'fine' })).status, 200)
}))

test('clear: 200 { ok: true }, notice back to null, count resets, idempotent', () => withServer(async ({ base }) => {
  const n1 = await notify(base, { session: CLAUDE, message: 'a' })
  await notify(base, { session: CLAUDE, message: 'b' })
  const id = n1.body.id
  const c = await clear(base, { id })
  assert.equal(c.status, 200)
  assert.equal(c.body.ok, true)
  assert.equal((await find(base, CLAUDE)).notice, null)
  const again = await clear(base, { id })
  assert.equal(again.status, 200)
  assert.equal(again.body.ok, true)
  const unknown = await clear(base, { id: 'claude-code:nope' })
  assert.equal(unknown.status, 200, 'clearing an agent with no notice is not an error')
  const fresh = await notify(base, { session: CLAUDE, message: 'c' })
  assert.equal(fresh.body.notice.count, 1, 'count restarts after a clear')
}))

test('clear: a missing id is a 400', () => withServer(async ({ base }) => {
  const r = await clear(base, {})
  assert.equal(r.status, 400)
}))

test('local only: wrong Origin is rejected on both POSTs and stores nothing', () => withServer(async ({ base }) => {
  for (const p of ['/api/notify', '/api/notify/clear']) {
    const r = await call(base, p, { method: 'POST', body: { session: CLAUDE, message: 'x', id: `claude-code:${CLAUDE}` }, origin: 'http://evil.example' })
    assert.ok([401, 403].includes(r.status), `${p} -> ${r.status}`)
  }
  assert.equal((await find(base, CLAUDE)).notice, null)
}))

test('local only: a POST with no Origin is rejected', () => withServer(async ({ base }) => {
  for (const p of ['/api/notify', '/api/notify/clear']) {
    const r = await call(base, p, { method: 'POST', body: { session: CLAUDE, message: 'x', id: `claude-code:${CLAUDE}` }, origin: null })
    assert.ok([401, 403].includes(r.status), `${p} -> ${r.status}`)
  }
  assert.equal((await find(base, CLAUDE)).notice, null)
}))

test('local only: a clear with the wrong Origin does not clear', () => withServer(async ({ base }) => {
  const n = await notify(base, { session: CLAUDE, message: 'keep me' })
  const r = await clear(base, { id: n.body.id }, { origin: 'http://evil.example' })
  assert.ok([401, 403].includes(r.status))
  assert.equal((await find(base, CLAUDE)).notice.message, 'keep me')
}))

test('local only: the matching Origin is accepted', () => withServer(async ({ base, port }) => {
  const r = await notify(base, { session: CLAUDE, message: 'ok' }, { origin: `http://127.0.0.1:${port}` })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const c = await clear(base, { id: r.body.id }, { origin: `http://127.0.0.1:${port}` })
  assert.equal(c.status, 200)
}))

test('persistence: notifications.json in the data dir survives a server restart', async () => {
  const os = await import('node:os')
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'village-notify-'))
  const dataDir = path.join(keep, 'data')
  try {
    await withServer(async ({ base }) => {
      const r = await notify(base, { session: CLAUDE, message: 'remember me', title: 'Sticky' })
      assert.equal(r.status, 200, JSON.stringify(r.body))
    }, { dataDir })
    // withServer removes its own temp root (not our dataDir): the file must still be there.
    assert.ok(fs.existsSync(path.join(dataDir, 'notifications.json')), 'notifications.json written to the data dir')
    await withServer(async ({ base }) => {
      const a = await find(base, CLAUDE)
      assert.equal(a.notice?.message, 'remember me')
      assert.equal(a.notice?.title, 'Sticky')
      assert.equal(a.notice?.count, 1)
      await clear(base, { id: a.id })
    }, { dataDir })
    await withServer(async ({ base }) => {
      assert.equal((await find(base, CLAUDE)).notice, null, 'a clear persists too')
    }, { dataDir })
  } finally { fs.rmSync(keep, { recursive: true, force: true }) }
})
