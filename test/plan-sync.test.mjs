// P2 contract: web/src/plan-sync.js { hydratePlan, installPlanMirror, SYNC_KEY_RE }. Skips until the module exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/src/plan-sync.js')
const mod = fs.existsSync(file) ? await import(file) : null
const skip = mod ? false : 'web/src/plan-sync.js is absent (activates on P2 merge)'
const K = 'va.engine2.world'

const fakeLs = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size }, _m: m }
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
/** Fake server: state.keys = { k: {rev,value} }; records calls; online=false throws. */
function fakeFetch(state = { keys: {} }) {
  const f = async (url, opts = {}) => {
    f.calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) })
    if (!f.online) throw new TypeError('offline')
    if ((opts.method || 'GET') === 'GET') return json(200, { v: 1, keys: state.keys })
    const { key, value, baseRev } = JSON.parse(opts.body)
    const cur = state.keys[key]
    if ((cur?.rev || 0) !== baseRev || f.forceConflict) return json(409, { rev: cur?.rev || 0, value: cur?.value })
    state.keys[key] = { rev: baseRev + 1, at: Date.now(), value }
    return json(200, { rev: baseRev + 1 })
  }
  f.calls = []; f.online = true; f.state = state
  f.puts = () => f.calls.filter((c) => c.method === 'PUT')
  return f
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const val = (ls, k) => JSON.parse(ls.getItem(k))

test('SYNC_KEY_RE matches plan keys, never .demo', { skip }, () => {
  const re = mod.SYNC_KEY_RE
  for (const k of ['va.engine2.world', 'va.engine2.world.harbour', 'va.world3', 'va.engine2.seed', 'va.seen']) assert.ok(re.test(k), k)
  for (const k of ['va.engine2.world.demo', 'va.world3.demo', 'va.other', 'va.engine', 'x.va.seen']) assert.ok(!re.test(k), k)
})

test('migrate: local plan, empty server -> uploaded at baseRev 0, local kept', { skip }, async () => {
  const ls = fakeLs({ [K]: JSON.stringify({ a: 1 }) }); const fetch = fakeFetch()
  await mod.hydratePlan({ fetch, ls, timeoutMs: 200 })
  await wait(50)
  assert.deepEqual(fetch.state.keys[K]?.value, { a: 1 })
  assert.equal(fetch.puts()[0].body.baseRev, 0)
  assert.deepEqual(val(ls, K), { a: 1 })
})

test('adopt newer: server has a plan the client lacks -> written to localStorage', { skip }, async () => {
  const ls = fakeLs(); const fetch = fakeFetch({ keys: { [K]: { rev: 3, value: { s: 'srv' } } } })
  await mod.hydratePlan({ fetch, ls, timeoutMs: 200 })
  assert.deepEqual(val(ls, K), { s: 'srv' })
  assert.equal(fetch.puts().length, 0)
})

test('same rev/content: nothing changes and nothing is pushed', { skip }, async () => {
  const fetch = fakeFetch({ keys: { [K]: { rev: 2, value: { same: 1 } } } })
  const ls = fakeLs({ [K]: JSON.stringify({ same: 1 }) })
  await mod.hydratePlan({ fetch, ls, timeoutMs: 200 })
  await wait(30)
  assert.deepEqual(val(ls, K), { same: 1 })
  assert.equal(fetch.puts().length, 0)
})

test('first-contact conflict: keep local, back up server copy, follower, conflicts[]', { skip }, async () => {
  const fetch = fakeFetch({ keys: { [K]: { rev: 4, value: { s: 'srv' } } } })
  const ls = fakeLs({ [K]: JSON.stringify({ l: 'local' }) }) // local exists, never synced
  const res = await mod.hydratePlan({ fetch, ls, timeoutMs: 200 })
  assert.deepEqual(val(ls, K), { l: 'local' }, 'never auto-switches')
  const backups = [...ls._m.entries()].filter(([k]) => k !== K && /backup/i.test(k))
  assert.ok(backups.length >= 1, 'a backup key is written')
  assert.ok(backups.some(([, v]) => v.includes('srv')), 'backup holds the server copy')
  assert.ok(Array.isArray(res?.conflicts) && res.conflicts.length >= 1, 'conflicts[] reported')
  assert.ok(JSON.stringify(res.conflicts).includes(K))
  await wait(30)
  assert.equal(fetch.puts().length, 0, 'follower: does not overwrite the server plan')
})

test('offline: local kept, no throw; dirty edit flushes once back online', { skip }, async () => {
  const ls = fakeLs({ [K]: JSON.stringify({ a: 1 }) }); const fetch = fakeFetch(); fetch.online = false
  await mod.hydratePlan({ fetch, ls, timeoutMs: 100 })
  assert.deepEqual(val(ls, K), { a: 1 })
  let hook
  mod.installPlanMirror({ onStoreSet: (cb) => { hook = cb }, fetch, ls, debounceMs: 5 })
  assert.equal(typeof hook, 'function', 'mirror registers an onStoreSet callback')
  ls.setItem(K, JSON.stringify({ a: 2 })); hook(K, { a: 2 })
  await wait(40)
  assert.equal(Object.keys(fetch.state.keys).length, 0, 'nothing reached the server while offline')
  fetch.online = true
  hook(K, { a: 2 })
  await wait(120)
  assert.deepEqual(fetch.state.keys[K]?.value, { a: 2 })
})

test('mirror: non-sync keys are ignored; edits are debounced into one PUT', { skip }, async () => {
  const ls = fakeLs(); const fetch = fakeFetch(); let hook
  mod.installPlanMirror({ onStoreSet: (cb) => { hook = cb }, fetch, ls, debounceMs: 20 })
  hook('va.engine', 2); hook('va.engine2.world.demo', { x: 1 })
  for (let i = 0; i < 5; i++) { ls.setItem(K, JSON.stringify({ i })); hook(K, { i }) }
  await wait(120)
  assert.equal(fetch.puts().length, 1)
  assert.deepEqual(fetch.state.keys[K].value, { i: 4 })
})

test('mirror 409 -> stale: local untouched, never pushes that key again', { skip }, async () => {
  const ls = fakeLs(); const fetch = fakeFetch({ keys: { [K]: { rev: 7, value: { other: 1 } } } }); let hook
  mod.installPlanMirror({ onStoreSet: (cb) => { hook = cb }, fetch, ls, debounceMs: 5 })
  ls.setItem(K, JSON.stringify({ mine: 1 })); hook(K, { mine: 1 })
  await wait(60)
  const after409 = fetch.puts().length
  assert.ok(after409 >= 1)
  assert.deepEqual(val(ls, K), { mine: 1 }, 'no live re-layout: local not replaced')
  for (let i = 0; i < 3; i++) { ls.setItem(K, JSON.stringify({ mine: 2 + i })); hook(K, { mine: 2 + i }); await wait(30) }
  assert.equal(fetch.puts().length, after409, 'stale key is never pushed again')
  assert.deepEqual(fetch.state.keys[K].value, { other: 1 })
})
