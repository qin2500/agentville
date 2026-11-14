// Regression tests for server/usage-pause.mjs, written from the spec (fakes only).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUsagePause, shouldPause, pauseTargets, resumeTargets } from '../server/usage-pause.mjs'

const A = (id, extra = {}) => ({ id, name: `agent-${id}`, role: 'lead', hidden: false, bucket: 'active', live: true, reason: '', ...extra })

function rig(initialAgents, opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'usage-pause-'))
  const s = {
    dataDir, t: 1_000_000, agents: initialAgents, blockedNow: null, can: true, sent: [],
  }
  s.make = () => createUsagePause({
    dataDir,
    agents: () => s.agents,
    blocked: () => s.blockedNow,
    deliverTo: async (id, text) => { s.sent.push({ id, text }); return true },
    canRequest: async () => s.can,
    log: () => {},
    now: () => s.t,
  })
  s.up = opts.dataDir ? null : s.make()
  // Tick repeatedly, advancing the fake clock, so any staggering finishes.
  s.pump = async (up, n = 30, stepMs = 60_000) => {
    for (let i = 0; i < n; i++) { await up.tick(); s.t += stepMs }
  }
  return s
}
const countFor = (s, id) => s.sent.filter((m) => m.id === id).length
const block = (s) => { s.blockedNow = { why: 'usage limit', until: s.t + 3_600_000 } }

test('pure helpers: shouldPause and pauseTargets', () => {
  assert.equal(shouldPause({ blocked: null, now: 1 }), false)
  assert.equal(shouldPause({ blocked: { why: 'x', until: Date.now() + 1e6 }, now: Date.now() }), true)
  const ids = pauseTargets([
    A('a'), A('b', { role: 'sub' }), A('c', { hidden: true }), A('d', { bucket: 'resting' }), A('e', { bucket: 'stalled' }),
  ]).map((x) => x.id)
  assert.ok(ids.includes('a'))
  for (const bad of ['b', 'c', 'd']) assert.ok(!ids.includes(bad), `${bad} must not be a target`)
})

test('pure helper: resumeTargets skips agents that were not recorded', () => {
  const record = { agents: [{ id: 'a', name: 'agent-a' }] }
  const ids = resumeTargets(record, [A('a'), A('late')]).map((x) => x.id)
  assert.deepEqual(ids, ['a'])
})

test('1. not blocked: running, no messages, not holding', async () => {
  const s = rig([A('a'), A('b')])
  await s.pump(s.up, 3)
  assert.equal(s.up.info().state, 'running')
  assert.equal(s.sent.length, 0)
  assert.equal(s.up.holding(), false)
})

test('2. blocked: paused, one message per top-level live agent only', async () => {
  const s = rig([
    A('a'), A('b'), A('sub1', { role: 'sub' }), A('hid', { hidden: true }),
    A('rest', { bucket: 'resting' }), A('done', { bucket: 'resting', reason: 'done' }),
  ])
  block(s)
  await s.pump(s.up, 10)
  const info = s.up.info()
  assert.equal(info.state, 'paused')
  assert.equal(s.up.holding(), true)
  assert.equal(countFor(s, 'a'), 1)
  assert.equal(countFor(s, 'b'), 1)
  for (const id of ['sub1', 'hid', 'rest', 'done']) assert.equal(countFor(s, id), 0, id)
  assert.deepEqual(info.agents.map((x) => x.id).sort(), ['a', 'b'])
})

test('3. repeated ticks while blocked send nothing more', async () => {
  const s = rig([A('a'), A('b')])
  block(s)
  await s.pump(s.up, 10)
  const n = s.sent.length
  await s.pump(s.up, 20)
  assert.equal(s.sent.length, n)
  assert.equal(s.up.info().state, 'paused')
})

test('4. unblocked but canRequest false: stays paused', async () => {
  const s = rig([A('a')])
  block(s)
  await s.pump(s.up, 5)
  s.blockedNow = null
  s.can = false
  const n = s.sent.length
  await s.pump(s.up, 20)
  assert.equal(s.up.info().state, 'paused')
  assert.equal(s.up.holding(), true)
  assert.equal(s.sent.length, n)
})

test('5. unblocked and canRequest true: each recorded agent resumed once, ends running', async () => {
  const s = rig([A('a'), A('b')])
  block(s)
  await s.pump(s.up, 5)
  s.sent.length = 0
  s.blockedNow = null
  s.can = true
  await s.pump(s.up, 60)
  assert.equal(countFor(s, 'a'), 1)
  assert.equal(countFor(s, 'b'), 1)
  assert.equal(s.up.info().state, 'running')
  assert.equal(s.up.holding(), false)
  await s.pump(s.up, 5)
  assert.equal(s.sent.length, 2, 'no extra messages after resume')
})

test('6. setEnabled(false): never pauses even when blocked', async () => {
  const s = rig([A('a')])
  s.up.setEnabled(false)
  block(s)
  await s.pump(s.up, 10)
  assert.equal(s.up.info().enabled, false)
  assert.equal(s.up.info().state, 'running')
  assert.equal(s.sent.length, 0)
  assert.equal(s.up.holding(), false)
})

test('7. restart mid-pause: new instance on same dataDir is still paused with same agents', async () => {
  const s = rig([A('a'), A('b')])
  block(s)
  await s.pump(s.up, 5)
  assert.ok(fs.existsSync(path.join(s.dataDir, 'usage-pause.json')))
  const before = s.up.info().agents.map((x) => x.id).sort()
  const sentBefore = s.sent.length
  const up2 = s.make()
  assert.equal(up2.info().state, 'paused')
  assert.deepEqual(up2.info().agents.map((x) => x.id).sort(), before)
  assert.equal(up2.holding(), true)
  await s.pump(up2, 5)
  assert.equal(s.sent.length, sentBefore, 'restart must not re-send pause messages')
})

test('8. agents that appeared after the pause are not sent a resume message', async () => {
  const s = rig([A('a')])
  block(s)
  await s.pump(s.up, 5)
  s.agents = [A('a'), A('late')]
  s.sent.length = 0
  s.blockedNow = null
  await s.pump(s.up, 60)
  assert.equal(countFor(s, 'a'), 1)
  assert.equal(countFor(s, 'late'), 0)
  assert.equal(s.up.info().state, 'running')
})
