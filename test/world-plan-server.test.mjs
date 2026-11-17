// P1 contract: GET/PUT /api/world-plan (see /tmp/enginev2/M7-PLAN.md). Skips until server/world-plan.mjs and the route exist.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { withServer } from './support/with-server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const present = fs.existsSync(path.join(here, '../server/world-plan.mjs')) &&
  /world-plan/.test(fs.readFileSync(path.join(here, '../server/serve.mjs'), 'utf8'))
const skip = present ? false : 'server/world-plan.mjs or its /api/world-plan route is absent (activates on P1 merge)'

const K = 'va.engine2.world'
function call(port, method, body, { origin = `http://127.0.0.1:${port}`, raw } = {}) {
  const data = raw ?? (body === undefined ? undefined : JSON.stringify(body))
  const headers = { host: `127.0.0.1:${port}` }
  if (origin) headers.origin = origin
  if (data !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data) }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/api/world-plan', headers }, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null } catch {} resolve({ status: res.statusCode, body: j }) })
    })
    req.on('error', reject)
    req.end(data)
  })
}
const put = (port, key, value, baseRev, o) => call(port, 'PUT', { key, value, baseRev }, o)
const planFile = (dir) => path.join(dir, 'world-plan.json')

test('GET empty -> {v:1,keys:{}}', { skip }, () => withServer(async ({ port }) => {
  const r = await call(port, 'GET', undefined, { origin: null })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { v: 1, keys: {} })
}))

test('PUT baseRev 0 creates; second baseRev 0 -> 409 {rev,value}; stale rev -> 409', { skip }, () => withServer(async ({ port, dataDir }) => {
  const a = await put(port, K, { a: 1 }, 0)
  assert.equal(a.status, 200)
  assert.equal(a.body.rev, 1)
  const b = await put(port, K, { a: 2 }, 0)
  assert.equal(b.status, 409)
  assert.equal(b.body.rev, 1)
  assert.deepEqual(b.body.value, { a: 1 })
  assert.equal((await put(port, K, { a: 3 }, 1)).body.rev, 2)
  assert.equal((await put(port, K, { a: 4 }, 1)).status, 409, 'stale rev')
  const g = await call(port, 'GET', undefined, { origin: null })
  assert.deepEqual(g.body.keys[K].value, { a: 3 })
  assert.equal(JSON.parse(fs.readFileSync(planFile(dataDir), 'utf8')).keys[K].rev, 2)
}))

test('disallowed keys (incl. any .demo) -> 400', { skip }, () => withServer(async ({ port }) => {
  for (const k of ['foo', 'va.engine2.world.demo', 'va.world3.demo', 'va.seen.demo', '../x', 'va.engine2.world/../x', '']) {
    assert.equal((await put(port, k, 1, 0)).status, 400, k)
  }
  for (const k of ['va.engine2.world.harbour', 'va.world2', 'va.engine2.seed', 'va.seen']) {
    assert.equal((await put(port, k, 1, 0)).status, 200, k)
  }
}))

test('>2MB value -> 413', { skip }, () => withServer(async ({ port }) => {
  const r = await put(port, K, 'x'.repeat(2 * 1024 * 1024 + 10), 0)
  assert.equal(r.status, 413)
}))

test('cross-origin / origin-less PUT -> 403', { skip }, () => withServer(async ({ port }) => {
  assert.equal((await put(port, K, 1, 0, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await put(port, K, 1, 0, { origin: null })).status, 403)
  assert.deepEqual((await call(port, 'GET', undefined, { origin: null })).body.keys, {})
}))

test('corrupt file is quarantined and served empty', { skip }, async () => {
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'wp-corrupt-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(planFile(dataDir), '{not json')
  try {
    await withServer(async ({ port }) => {
      const g = await call(port, 'GET', undefined, { origin: null })
      assert.equal(g.status, 200)
      assert.deepEqual(g.body, { v: 1, keys: {} })
      const q = fs.readdirSync(dataDir).filter((f) => f.startsWith('world-plan.json.corrupt-'))
      assert.equal(q.length, 1)
      assert.equal(fs.readFileSync(path.join(dataDir, q[0]), 'utf8'), '{not json')
    }, { dataDir })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('v:2 file is read-only: PUT 409 reason "version"', { skip }, async () => {
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'wp-v2-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const v2 = JSON.stringify({ v: 2, keys: { [K]: { rev: 5, at: 1, value: { z: 1 } } } })
  fs.writeFileSync(planFile(dataDir), v2)
  try {
    await withServer(async ({ port }) => {
      const r = await put(port, K, { a: 1 }, 5)
      assert.equal(r.status, 409)
      assert.equal(r.body.reason, 'version')
      assert.equal(fs.readFileSync(planFile(dataDir), 'utf8'), v2, 'untouched')
    }, { dataDir })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('20 concurrent PUTs: valid JSON, per-key rev monotonic, one winner per rev', { skip }, () => withServer(async ({ port, dataDir }) => {
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => put(port, K, { i }, 0)))
  assert.equal(rs.filter((r) => r.status === 200).length, 1, 'all used baseRev 0: exactly one wins')
  assert.ok(rs.every((r) => r.status === 200 || r.status === 409))
  // chained writers on a second key: each retries from the latest rev
  const K2 = 'va.engine2.world.chain'
  let ok = 0
  await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    for (let t = 0; t < 100; t++) {
      const g = await call(port, 'GET', undefined, { origin: null })
      const rev = g.body.keys[K2]?.rev || 0
      const r = await put(port, K2, { i }, rev)
      if (r.status === 200) { ok++; return }
    }
  }))
  assert.equal(ok, 20)
  const file = JSON.parse(fs.readFileSync(planFile(dataDir), 'utf8'))
  assert.equal(file.keys[K2].rev, 20)
  assert.equal(file.keys[K].rev, 1)
}))

test('writes stay inside dataDir', { skip }, () => withServer(async ({ port, dataDir, root }) => {
  await put(port, K, { a: 1 }, 0)
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  const stray = walk(root).filter((f) => /world-plan/.test(f) && !f.startsWith(dataDir + path.sep))
  assert.deepEqual(stray, [])
  assert.ok(fs.existsSync(planFile(dataDir)))
}))

for (const name of ['AGENTVILLE_WORLD_PLAN', 'VILLAGE_WORLD_PLAN']) {
  test(`${name}=0 -> GET 404`, { skip }, () => withServer(async ({ port }) => {
    assert.equal((await call(port, 'GET', undefined, { origin: null })).status, 404)
  }, { env: { [name]: '0' } }))
}
