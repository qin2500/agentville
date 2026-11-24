import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLaunches } from '../server/launches.mjs'
import { parseAgentStart, checkAgentStart } from '../server/agent-start.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'))
const mkCtx = (over = {}) => {
  let t = 1_000_000
  const launches = createLaunches({ dataDir: tmp(), now: () => t })
  const cfg = { enabled: true, perHour: 2, maxDepth: 2 }
  return { launches, tick: (ms) => { t += ms }, ctx: { launches,
    settings: { get: () => ({ agentStarts: cfg }), defaultProvider: () => 'claude' },
    resolveSession: (s) => (s === 'S' ? { id: 'claude:S', cwd: '/w/proj', live: true } : s === 'SUB' ? { id: 'x', cwd: '/w', live: true, isSubagent: true } : null),
    providerStatus: (p) => ({ usable: p !== 'gemini', why: 'out' }),
    knownProjects: () => ['/w/other'], ...over } }
}
const input = (o = {}) => ({ session: 'S', provider: null, prompt: 'p', cwd: null, ...o })

test('ledger: 0600, ttl, depth, counts', () => {
  const { launches, tick } = mkCtx()
  launches.record({ ref: 'a', parentAgentId: null, provider: 'claude', via: 'ui' })
  launches.record({ ref: 'b', parentAgentId: 'a', provider: 'claude' })
  launches.record({ ref: 'c', parentAgentId: 'claude:b', provider: 'gemini' })
  assert.equal(launches.depth('c'), 2)
  assert.equal(launches.depth('a'), 0)
  assert.equal(launches.count({ parentAgentId: 'a' }), 1)
  const dir = tmp(); const l2 = createLaunches({ dataDir: dir }); l2.record({ ref: 'z', provider: 'claude' })
  assert.equal(fs.statSync(path.join(dir, 'launches.json')).mode & 0o777, 0o600)
  tick(15 * 24 * 3600 * 1000)
  assert.equal(launches.get('a'), null)
})
test('ledger: cycle safe', () => {
  const { launches } = mkCtx()
  launches.record({ ref: 'a', parentAgentId: 'b', provider: 'claude' })
  launches.record({ ref: 'b', parentAgentId: 'a', provider: 'claude' })
  assert.ok(launches.depth('a') <= 2)
})
test('parse', () => {
  assert.equal(parseAgentStart(null).ok, false)
  assert.equal(parseAgentStart({ session: 's' }).ok, false)
  assert.equal(parseAgentStart({ session: 's', prompt: 'x', provider: 'codex' }).ok, false)
  assert.equal(parseAgentStart({ session: 's', prompt: 'x', cwd: 'rel' }).ok, false)
  assert.equal(parseAgentStart({ session: 's', prompt: ' x ' }).value.prompt, 'x')
})
test('guards', () => {
  const { ctx, launches } = mkCtx()
  assert.equal(checkAgentStart(input(), ctx).ok, true)
  assert.equal(checkAgentStart(input({ cwd: '/w/proj/sub' }), ctx).ok, true)
  assert.equal(checkAgentStart(input({ cwd: '/w/other' }), ctx).ok, true)
  assert.equal(checkAgentStart(input({ cwd: '/etc' }), ctx).status, 403)
  assert.equal(checkAgentStart(input({ cwd: '/w/proj/../x' }), ctx).status, 403)
  assert.equal(checkAgentStart(input({ session: 'nope' }), ctx).status, 404)
  assert.equal(checkAgentStart(input({ session: 'SUB' }), ctx).status, 403)
  assert.equal(checkAgentStart(input({ provider: 'gemini' }), ctx).status, 409)
  const off = { ...ctx, settings: { ...ctx.settings, get: () => ({ agentStarts: { enabled: false } }) } }
  assert.equal(checkAgentStart(input(), off).status, 403)
  launches.record({ ref: 'r1', parentAgentId: 'claude:S', provider: 'claude' })
  launches.record({ ref: 'r2', parentAgentId: 'claude:S', provider: 'claude' })
  assert.equal(checkAgentStart(input(), ctx).status, 429)
})
test('depth and startPlan', () => {
  const { ctx, launches } = mkCtx()
  launches.record({ ref: 'S', parentAgentId: 'p1', provider: 'claude', via: 'handoff' })
  launches.record({ ref: 'p1', parentAgentId: 'p0', provider: 'claude', via: 'ui' })
  assert.equal(checkAgentStart(input(), ctx).status, 429)
  const c2 = mkCtx().ctx
  assert.equal(checkAgentStart(input(), { ...c2, startPlan: () => ({ ok: false, error: 'bad model' }) }).status, 400)
  assert.equal(checkAgentStart(input(), { ...c2, startPlan: () => { throw new Error('x') } }).status, 400)
})
