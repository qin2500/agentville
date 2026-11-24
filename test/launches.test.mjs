import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLaunches } from '../server/launches.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'))

test('ledger: 0600, ttl, depth, counts', () => {
  let t = 1_000_000
  const launches = createLaunches({ dataDir: tmp(), now: () => t })
  launches.record({ ref: 'a', parentAgentId: null, provider: 'claude', via: 'ui' })
  launches.record({ ref: 'b', parentAgentId: 'a', provider: 'claude' })
  launches.record({ ref: 'c', parentAgentId: 'claude-code:b', provider: 'gemini' })
  assert.equal(launches.depth('c'), 2)
  assert.equal(launches.depth('a'), 0)
  assert.equal(launches.depth('never-seen'), 0)
  assert.equal(launches.count({ parentAgentId: 'a' }), 1)
  const dir = tmp(); const l2 = createLaunches({ dataDir: dir }); l2.record({ ref: 'z', provider: 'claude' })
  assert.equal(fs.statSync(path.join(dir, 'launches.json')).mode & 0o777, 0o600)
  t += 15 * 24 * 3600 * 1000
  assert.equal(launches.get('a'), null)
})

test('ledger: a cycle fails closed', () => {
  const launches = createLaunches({ dataDir: tmp() })
  launches.record({ ref: 'a', parentAgentId: 'b', provider: 'claude' })
  launches.record({ ref: 'b', parentAgentId: 'a', provider: 'claude' })
  assert.equal(launches.depth('a'), Infinity)
})

test('ledger: record returns a token, stores only its hash', () => {
  const dir = tmp()
  const launches = createLaunches({ dataDir: dir })
  const r = launches.record({ ref: 'run1', parentAgentId: 'claude-code:p', provider: 'gemini' })
  assert.equal(typeof r.token, 'string')
  assert.ok(r.token.length >= 32)
  const disk = fs.readFileSync(path.join(dir, 'launches.json'), 'utf8')
  assert.equal(disk.includes(r.token), false)
  assert.equal(JSON.parse(disk).run1.tokenHash.length, 64)
  assert.equal(launches.verifyToken('gemini:run1', r.token), true)
  assert.equal(launches.verifyToken('gemini:run1', 'x'.repeat(43)), false)
  assert.equal(launches.refByToken(r.token), 'run1')
  assert.equal(launches.refByToken('nope'), null)
  const r2 = launches.record({ ref: 'run2', provider: 'gemini' })
  assert.notEqual(r2.token, r.token)
})

test('ledger: pending record, bind to the real ref with aliases, rollback', () => {
  const launches = createLaunches({ dataDir: tmp() })
  const p = launches.record({ ref: 'pending-1', parentAgentId: 'claude-code:P', provider: 'claude', pending: true })
  assert.equal(launches.count({ via: 'api' }), 1)
  assert.equal(launches.bind('pending-1', 'job-9', ['claude-code:sid-9']), true)
  assert.equal(launches.get('pending-1'), null)
  assert.equal(launches.get('claude-code:sid-9').parentAgentId, 'claude-code:P')
  assert.equal(launches.verifyToken('claude-code:sid-9', p.token), true)
  assert.equal(launches.depth('claude-code:sid-9'), 1)
  launches.record({ ref: 'pending-2', parentAgentId: 'claude-code:P', provider: 'claude', pending: true })
  assert.equal(launches.rollback('pending-2'), true)
  assert.equal(launches.count({ via: 'api' }), 1)
})

test('ledger: __proto__ and friends are not entries', () => {
  const launches = createLaunches({ dataDir: tmp() })
  assert.equal(launches.get('__proto__'), null)
  assert.equal(launches.refOf('constructor'), null)
  assert.equal(launches.depth('__proto__'), 0)
})

test('ledger: corrupt file fails closed for depth, is kept, and is not reset', () => {
  for (const junk of ['{not json', '[]', '{"a":{"at":"x","via":"api","parentAgentId":null}}']) {
    let t = 5_000
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'launches.json'), junk)
    const launches = createLaunches({ dataDir: dir, now: () => t })
    assert.equal(launches.depth('claude-code:someone'), Infinity, junk)
    assert.equal(launches.failClosed(), true)
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('launches.json.corrupt-')), 'corrupt copy kept')
    // A fresh process still sees the fail-closed marker: no reset.
    const again = createLaunches({ dataDir: dir, now: () => t })
    assert.equal(again.depth('claude-code:someone'), Infinity)
    // A chain fully known after the corruption still has a real depth.
    again.record({ ref: 'top', parentAgentId: null, provider: 'claude', via: 'ui' })
    again.record({ ref: 'kid', parentAgentId: 'claude-code:top', provider: 'claude' })
    assert.equal(again.depth('claude-code:kid'), 1)
    // ...but one that leads into the lost part is not.
    again.record({ ref: 'orphan', parentAgentId: 'claude-code:lost', provider: 'claude' })
    assert.equal(again.depth('claude-code:orphan'), Infinity)
    // After one TTL every lost entry would have expired; the marker goes too.
    t += 15 * 24 * 3600 * 1000
    assert.equal(again.failClosed(), false)
    assert.equal(again.depth('claude-code:someone'), 0)
  }
})
