// Unit tests for server/world-plan.mjs (D5). Temp dirs only; HTTP only on 127.0.0.1 port 0.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { isLocalRequest } from '../server/local-request.mjs'
import { createWorldPlan, worldPlanRoute, allowedKey, worldPlanEnabled, MAX_KEY_BYTES, WORLD_PLAN_FILE } from '../server/world-plan.mjs'

const roots = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'village-world-plan-')); roots.push(d); return d }
test.after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }) })
const fileIn = (dir) => path.join(dir, WORLD_PLAN_FILE)

test('key allowlist: engine2 world keys, worldN, seed, seen; never demo or anything else', () => {
  for (const k of ['va.engine2.world', 'va.engine2.world.abc-1.x', 'va.world1', 'va.world42', 'va.engine2.seed', 'va.seen']) assert.ok(allowedKey(k), k)
  for (const k of ['va.engine2.world.demo', 'va.engine2.world.demo.x', 'va.engine2.world.Big', 'va.world', 'va.worldx', 'va.engine', 'va.seen.x',
    'va.engine2.seed2', 'xva.seen', 'va.engine2.world.', '', null, 7, 'va.engine2.world.' + 'a'.repeat(300)]) assert.ok(!allowedKey(k), String(k))
})

test('read on a fresh dir is empty; put creates rev 1 and persists across instances', async () => {
  const dir = path.join(tmp(), 'nested', 'data') // dataDir does not exist yet
  const plan = createWorldPlan(dir, { now: () => 1234 })
  assert.deepEqual(await plan.read(), { v: 1, keys: {} })
  assert.equal(fs.existsSync(fileIn(dir)), false, 'reading never creates the file')
  assert.deepEqual(await plan.put('va.engine2.seed', 99, 0), { ok: true, rev: 1 })
  assert.deepEqual(await plan.put('va.engine2.seed', 100, 1), { ok: true, rev: 2 })
  const disk = JSON.parse(fs.readFileSync(fileIn(dir), 'utf8'))
  assert.deepEqual(disk, { v: 1, keys: { 'va.engine2.seed': { rev: 2, at: 1234, value: 100 } } })
  process.platform !== 'win32' && assert.equal(fs.statSync(fileIn(dir)).mode & 0o777, 0o600)
  assert.deepEqual((await createWorldPlan(dir).read()).keys['va.engine2.seed'], { rev: 2, at: 1234, value: 100 })
  assert.deepEqual(fs.readdirSync(dir), [WORLD_PLAN_FILE], 'no tmp files left behind')
})

test('compare-and-set: stale baseRev -> 409 with the current rev and value; absent key is rev 0', async () => {
  const plan = createWorldPlan(tmp())
  assert.deepEqual(await plan.put('va.world1', { a: 1 }, 3), { ok: false, status: 409, reason: 'stale', rev: 0, value: null })
  assert.deepEqual(await plan.put('va.world1', { a: 1 }, null), { ok: true, rev: 1 }, 'null baseRev means "absent"')
  assert.deepEqual(await plan.put('va.world1', { a: 2 }, 0), { ok: false, status: 409, reason: 'stale', rev: 1, value: { a: 1 } })
  assert.deepEqual((await plan.read()).keys['va.world1'].value, { a: 1 })
})

test('validation: bad key/baseRev/value -> 400, oversize value -> 413, oversize file -> 413', async () => {
  const plan = createWorldPlan(tmp())
  assert.equal((await plan.put('va.engine2.world.demo', 1, 0)).status, 400)
  assert.equal((await plan.put('localStorage', 1, 0)).status, 400)
  assert.equal((await plan.put('va.seen', 1, -1)).status, 400)
  assert.equal((await plan.put('va.seen', 1, 1.5)).status, 400)
  assert.equal((await plan.put('va.seen', 1, '0')).status, 400)
  assert.equal((await plan.put('va.seen', undefined, 0)).status, 400)
  const big = 'x'.repeat(MAX_KEY_BYTES) // + 2 quote bytes when serialized
  assert.deepEqual(await plan.put('va.seen', big, 0), { ok: false, status: 413, reason: 'key-size' })
  const almost = 'x'.repeat(MAX_KEY_BYTES - 1024)
  for (let i = 1; i <= 3; i++) assert.equal((await plan.put(`va.world${i}`, almost, 0)).ok, true)
  assert.equal((await plan.put('va.world4', almost, 0)).ok, true) // ~8 MB - 4 KB + overhead, still fits
  assert.deepEqual(await plan.put('va.world5', almost, 0), { ok: false, status: 413, reason: 'file-size' })
  assert.equal((await plan.read()).keys['va.world5'], undefined)
})

test('20 concurrent puts: one queue, every write lands exactly once, revs are sequential', async () => {
  const dir = tmp()
  const plan = createWorldPlan(dir)
  // Same key, same baseRev: exactly one wins, the rest see 409 with the winner's value.
  const same = await Promise.all(Array.from({ length: 20 }, (_, i) => plan.put('va.engine2.world', { i }, 0)))
  assert.equal(same.filter((r) => r.ok).length, 1)
  const winner = same.findIndex((r) => r.ok)
  for (const r of same.filter((r) => !r.ok)) assert.deepEqual(r, { ok: false, status: 409, reason: 'stale', rev: 1, value: { i: winner } })
  // Different keys: all succeed and all survive (no lost update from interleaved read-modify-write).
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => plan.put(`va.world${i}`, { i }, 0)))
  assert.ok(many.every((r) => r.ok && r.rev === 1))
  // A chain on one key, each built on the previous rev, issued all at once.
  const chain = await Promise.all(Array.from({ length: 20 }, (_, i) => plan.put('va.seen', i, i)))
  assert.deepEqual(chain.map((r) => r.rev), Array.from({ length: 20 }, (_, i) => i + 1))
  const disk = JSON.parse(fs.readFileSync(fileIn(dir), 'utf8'))
  assert.equal(Object.keys(disk.keys).length, 22)
  assert.deepEqual(disk.keys['va.seen'].value, 19)
  assert.deepEqual(fs.readdirSync(dir).sort(), [WORLD_PLAN_FILE])
})

test('crash safety: a failed rename leaves the old file intact and the state unchanged', async () => {
  const dir = tmp()
  await createWorldPlan(dir).put('va.seen', 'old', 0)
  const before = fs.readFileSync(fileIn(dir), 'utf8')
  let fail = true
  const flaky = { ...fsp, rename: async (a, b) => { if (fail && a.includes('.tmp-')) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fsp.rename(a, b) } }
  const plan = createWorldPlan(dir, { fs: flaky })
  await assert.rejects(plan.put('va.seen', 'new', 1), /EIO/)
  assert.equal(fs.readFileSync(fileIn(dir), 'utf8'), before)
  assert.deepEqual(fs.readdirSync(dir), [WORLD_PLAN_FILE], 'tmp file cleaned up')
  assert.equal((await plan.read()).keys['va.seen'].value, 'old')
  fail = false
  assert.deepEqual(await plan.put('va.seen', 'new', 1), { ok: true, rev: 2 }, 'the queue survives a failed write')
})

test('crash safety: stale tmp files from a crash are swept, the real file is untouched', async () => {
  const dir = tmp()
  await createWorldPlan(dir).put('va.seen', 1, 0)
  fs.writeFileSync(`${fileIn(dir)}.tmp-1-1`, '{"v":1,"keys":{"va.seen":{"rev":9')
  assert.equal((await createWorldPlan(dir).read()).keys['va.seen'].rev, 1)
  assert.deepEqual(fs.readdirSync(dir), [WORLD_PLAN_FILE])
})

test('corrupt file is moved aside to .corrupt-<ts> and the plan starts empty', async () => {
  const dir = tmp()
  fs.writeFileSync(fileIn(dir), '{"v":1,"keys":{trunc')
  const plan = createWorldPlan(dir, { now: () => 777 })
  assert.deepEqual(await plan.read(), { v: 1, keys: {} })
  assert.equal(fs.readFileSync(`${fileIn(dir)}.corrupt-777`, 'utf8'), '{"v":1,"keys":{trunc')
  assert.deepEqual(await plan.put('va.seen', 1, 0), { ok: true, rev: 1 })
  // Wrong shape counts as corrupt too.
  const dir2 = tmp()
  fs.writeFileSync(fileIn(dir2), '[1,2]')
  assert.deepEqual(await createWorldPlan(dir2, { now: () => 5 }).read(), { v: 1, keys: {} })
  assert.ok(fs.existsSync(`${fileIn(dir2)}.corrupt-5`))
})

test('a future version is served but read-only (put -> 409 version) and never rewritten', async () => {
  const dir = tmp()
  const future = { v: 2, keys: { 'va.seen': { rev: 4, at: 1, value: 'from-v2' } }, extra: true }
  fs.writeFileSync(fileIn(dir), JSON.stringify(future))
  const plan = createWorldPlan(dir)
  const doc = await plan.read()
  assert.equal(doc.v, 2)
  assert.equal(doc.keys['va.seen'].value, 'from-v2')
  assert.deepEqual(await plan.put('va.seen', 'x', 4), { ok: false, status: 409, reason: 'version' })
  assert.deepEqual(JSON.parse(fs.readFileSync(fileIn(dir), 'utf8')), future)
})

test('deleting the file by hand (rollback) is picked up without a restart', async () => {
  const dir = tmp()
  const plan = createWorldPlan(dir)
  await plan.put('va.seen', 1, 0)
  fs.rmSync(fileIn(dir))
  assert.deepEqual(await plan.read(), { v: 1, keys: {} })
  assert.deepEqual(await plan.put('va.seen', 2, 0), { ok: true, rev: 1 })
})

test('env switch: AGENTVILLE_WORLD_PLAN primary, VILLAGE_WORLD_PLAN legacy; either =0 disables', () => {
  assert.equal(worldPlanEnabled({}), true)
  assert.equal(worldPlanEnabled({ AGENTVILLE_WORLD_PLAN: '1' }), true)
  assert.equal(worldPlanEnabled({ AGENTVILLE_WORLD_PLAN: '0' }), false)
  assert.equal(worldPlanEnabled({ VILLAGE_WORLD_PLAN: '0' }), false)
  assert.equal(worldPlanEnabled({ AGENTVILLE_WORLD_PLAN: '1', VILLAGE_WORLD_PLAN: '0' }), false)
})

// --- HTTP glue, mounted the same way serve.mjs does (global isLocalRequest guard, then the route). ---
async function withRoute(env, fn) {
  const dir = tmp()
  const route = worldPlanRoute(createWorldPlan(dir), { env })
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = http.createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req)) return send(res, 403, { error: 'Local requests only' })
      if (req.url === '/api/world-plan' && await route(req, res, send)) return
      send(res, 404, { error: 'Not found' })
    } catch (e) { send(res, e.status || 500, { error: e.message }) }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = (method, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/api/world-plan', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    req.end(body)
  })
  const origin = `http://127.0.0.1:${port}`
  const put = (b, extra = {}) => call('PUT', { 'content-type': 'application/json', origin, ...extra }, typeof b === 'string' ? b : JSON.stringify(b))
  try { await fn({ call, put, origin, dir }) } finally { await new Promise((r) => server.close(r)) }
}

test('HTTP: GET shape, PUT 200/409/400/413, cross-origin 403, other methods 405', async () => {
  await withRoute({}, async ({ call, put }) => {
    assert.deepEqual(await call('GET'), { status: 200, body: { v: 1, keys: {} } })
    assert.deepEqual(await put({ key: 'va.engine2.world', value: { towns: [1] }, baseRev: 0 }), { status: 200, body: { rev: 1 } })
    assert.deepEqual(await call('GET'), { status: 200, body: { v: 1, keys: { 'va.engine2.world': { rev: 1, value: { towns: [1] } } } } })
    assert.deepEqual(await put({ key: 'va.engine2.world', value: 'x', baseRev: 0 }), { status: 409, body: { rev: 1, value: { towns: [1] } } })
    assert.equal((await put({ key: 'va.engine2.world.demo', value: 1, baseRev: 0 })).status, 400)
    assert.equal((await put({ key: 'va.seen', baseRev: 0 })).status, 400, 'missing value')
    assert.equal((await put('{nope')).status, 400)
    assert.equal((await put('[]')).status, 400)
    assert.equal((await put({ key: 'va.seen', value: 'x'.repeat(MAX_KEY_BYTES + 1), baseRev: 0 })).status, 413)
    assert.equal((await put({ key: 'va.seen', value: 1, baseRev: 0 }, { origin: 'http://evil.example' })).status, 403)
    assert.equal((await call('PUT', { 'content-type': 'application/json' }, '{}')).status, 403, 'origin-less PUT')
    assert.equal((await call('POST', { origin: 'http://evil.example' })).status, 403)
    assert.equal((await call('DELETE')).status, 403, 'origin-less DELETE')
  })
  await withRoute({}, async ({ call, origin }) => {
    assert.equal((await call('DELETE', { origin })).status, 405)
  })
})

test('HTTP: a body over the 8 MB cap is refused with 413', async () => {
  await withRoute({}, async ({ put }) => {
    const r = await put(JSON.stringify({ key: 'va.seen', baseRev: 0, value: 'x'.repeat(8 * 1024 * 1024 + 10) }))
    assert.equal(r.status, 413)
  })
})

test('HTTP: AGENTVILLE_WORLD_PLAN=0 or VILLAGE_WORLD_PLAN=0 -> both routes 404', async () => {
  for (const env of [{ AGENTVILLE_WORLD_PLAN: '0' }, { VILLAGE_WORLD_PLAN: '0' }]) {
    await withRoute(env, async ({ call, put, dir }) => {
      assert.equal((await call('GET')).status, 404)
      assert.equal((await put({ key: 'va.seen', value: 1, baseRev: 0 })).status, 404)
      assert.equal(fs.existsSync(fileIn(dir)), false)
    })
  }
})

test('serve.mjs wiring: real createServer answers /api/world-plan; env is read per request', async () => {
  const { makeHome } = await import('./fixtures/make-home.mjs')
  const { createServer } = await import('../server/serve.mjs')
  const root = tmp()
  Object.assign(process.env, makeHome(root))
  const dataDir = path.join(root, 'data')
  const server = createServer({ dataDir })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const put = (b, origin = base) => fetch(`${base}/api/world-plan`, { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(b) })
  try {
    assert.deepEqual(await (await fetch(`${base}/api/world-plan`)).json(), { v: 1, keys: {} })
    const ok = await put({ key: 'va.engine2.seed', value: 7, baseRev: 0 })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { rev: 1 })
    assert.ok(fs.existsSync(path.join(dataDir, WORLD_PLAN_FILE)))
    assert.equal((await put({ key: 'va.engine2.seed', value: 8, baseRev: 1 }, 'http://evil.example')).status, 403)
    for (const name of ['AGENTVILLE_WORLD_PLAN', 'VILLAGE_WORLD_PLAN']) {
      process.env[name] = '0'
      try {
        assert.equal((await fetch(`${base}/api/world-plan`)).status, 404)
        assert.equal((await put({ key: 'va.engine2.seed', value: 8, baseRev: 1 })).status, 404)
      } finally { delete process.env[name] }
    }
    assert.equal((await fetch(`${base}/api/world-plan`)).status, 200)
  } finally { await new Promise((r) => server.close(r)) }
})
