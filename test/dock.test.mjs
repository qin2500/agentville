import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDock } from '../server/dock.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dock-'))
const pr = (n, state, extra = {}) => ({ id: `#${n}`, href: `https://github.com/acme/app/pull/${n}`, state, checks: { passed: 1, failed: 0, pending: 0 }, review: null, ...extra })
const agent = (id, ...prs) => ({ id, name: `name-${id}`, prs })
const clock = () => { const c = { t: 1_000_000 }; c.now = () => c.t; return c }

test('open then merged gives a sail', async () => {
  const c = clock(); const d = createDock({ dataDir: tmp(), now: c.now })
  let r = await d.update([agent('a', pr(1, 'open'))])
  assert.equal(r.loading.length, 1)
  assert.equal(r.loading[0].repo, 'acme/app')
  assert.equal(r.loading[0].agentName, 'name-a')
  assert.equal(r.loading[0].since, 1_000_000)
  c.t += 5000
  r = await d.update([agent('a', pr(1, 'merged'))])
  assert.equal(r.loading.length, 0)
  assert.equal(r.sailed.length, 1)
  assert.equal(r.sailed[0].at, 1_005_000)
  assert.equal(r.total, 1)
})

test('first-seen merged counts but does not sail; closed and draft drop out', async () => {
  const d = createDock({ dataDir: tmp() })
  const r = await d.update([agent('a', pr(1, 'merged'), pr(2, 'closed'), pr(3, 'draft'))])
  assert.equal(r.total, 1)
  assert.deepEqual(r.sailed, [])
  assert.deepEqual(r.loading, [])
})

test('dedupes across agents and orders oldest first', async () => {
  const c = clock(); const d = createDock({ dataDir: tmp(), now: c.now })
  await d.update([agent('a', pr(2, 'open'))])
  c.t += 10
  const r = await d.update([agent('a', pr(2, 'open')), agent('b', pr(2, 'open', { href: 'https://GitHub.com/acme/app/pull/2/' }), pr(1, 'open'))])
  assert.equal(r.loading.length, 2)
  assert.equal(r.loading[0].href.endsWith('/2'), true)
  assert.equal(r.loading[0].agentId, 'a')
})

test('level thresholds', async () => {
  const lv = async (n) => (await createDock({ dataDir: tmp() }).update([agent('a', ...Array.from({ length: n }, (_, i) => pr(i, 'merged')))])).level
  assert.deepEqual([await lv(0), await lv(4), await lv(5), await lv(20), await lv(50), await lv(100)], [1, 1, 2, 3, 4, 5])
})

test('persists across a new createDock on the same dir', async () => {
  const dir = tmp(); const c = clock()
  const d1 = createDock({ dataDir: dir, now: c.now })
  await d1.update([agent('a', pr(1, 'open'), pr(9, 'merged'))])
  const d2 = createDock({ dataDir: dir, now: c.now })
  c.t += 100
  const r = await d2.update([agent('a', pr(1, 'merged'))])
  assert.equal(r.sailed.length, 1)
  assert.equal(r.total, 2)
  const r3 = await createDock({ dataDir: dir, now: c.now }).update([])
  assert.equal(r3.sailed.length, 1)
  assert.equal(r3.total, 2)
  assert.equal(fs.statSync(path.join(dir, 'dock.json')).mode & 0o777, 0o600)
})

test('sailed keeps 24 h and 12, newest first', async () => {
  const c = clock(); const d = createDock({ dataDir: tmp(), now: c.now })
  await d.update([agent('a', ...Array.from({ length: 15 }, (_, i) => pr(i, 'open')))])
  c.t += 1000
  let r = await d.update([agent('a', ...Array.from({ length: 15 }, (_, i) => pr(i, 'merged')))])
  assert.equal(r.sailed.length, 12)
  assert.equal(r.total, 15)
  c.t += 25 * 3600 * 1000
  r = await d.update([])
  assert.equal(r.sailed.length, 0)
  assert.equal(r.total, 15)
  await d.update([agent('a', pr(100, 'open'))])
  c.t += 1; await d.update([agent('a', pr(100, 'merged'))])
  c.t += 1; await d.update([agent('a', pr(101, 'open'))])
  c.t += 1; r = await d.update([agent('a', pr(101, 'merged'))])
  assert.deepEqual(r.sailed.map((s) => s.id), ['#101', '#100'])
})

test('loading entries carry size when known and omit it otherwise', async () => {
  const d = createDock({ dataDir: tmp() })
  const r = await d.update([agent('a', pr(1, 'open', { size: { additions: 10, deletions: 2, files: 3 } }), pr(2, 'open'))])
  assert.deepEqual(r.loading.find((l) => l.id === '#1').size, { additions: 10, deletions: 2, files: 3 })
  assert.equal('size' in r.loading.find((l) => l.id === '#2'), false)
})

test('harbour size follows lifetime total and never shrinks; load only grows it', async () => {
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} })
  const { harbourTier, tierForTotal, resetHarbourTier, LIFETIME_TIER2, LIFETIME_TIER3, LIFETIME_TIER4 } = await import('../web/src/dock-art.js')
  assert.deepEqual([0, LIFETIME_TIER2 - 1, LIFETIME_TIER2, LIFETIME_TIER3 - 1, LIFETIME_TIER3, LIFETIME_TIER4 - 1, LIFETIME_TIER4, 762].map(tierForTotal), [1, 1, 2, 2, 3, 3, 4, 4])
  const load = (n) => Array.from({ length: n }, (_, i) => ({ id: `#${i}` }))
  resetHarbourTier()
  // a long-running fleet: 11 PRs loading, then 3 for an hour: still the big harbour
  assert.equal(harbourTier({ total: 762, loading: load(11) }, 0), 4)
  assert.equal(harbourTier({ total: 762, loading: load(3) }, 1), 4)
  assert.equal(harbourTier({ total: 762, loading: load(3) }, 3600e3), 4)
  // a new install grows with the load, then with its history
  resetHarbourTier()
  assert.equal(harbourTier({ total: 0, loading: load(3) }, 0), 1)
  assert.equal(harbourTier({ total: 0, loading: load(16) }, 1), 4)
  assert.equal(harbourTier({ total: 0, loading: load(0) }, 2), 4)
  assert.equal(harbourTier({ total: 0, loading: load(0) }, 2 + 11 * 60e3), 1)
  assert.equal(harbourTier({ total: 45, loading: load(0) }, 2 + 11 * 60e3), 3)
})
