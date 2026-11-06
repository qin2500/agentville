import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, build, cap, REASONS, REST_MS } from '../server/classify.mjs'
import { WAIT_TTL_MS } from '../server/waiting.mjs'

const now = 1_800_000_000_000
const wait = (over = {}) => ({ kind: 'subagent', reason: 'Waiting for a subagent to finish', since: now - 1000, expiresAt: now - 1000 + WAIT_TTL_MS, source: 'outstanding-tool', ...over })
const agent = (over = {}) => ({ id: 'a', harness: 'claude-code', kind: 'session', lastActivityAt: now - 1000, lifecycle: 'running', ...over })

test('rules apply in priority order: needs-user > error > wait > running > idle', () => {
  const all = agent({ needsUser: true, lifecycle: 'failed', waitingOn: wait() })
  assert.equal(classify(all, now).reason, REASONS.needsUser)
  assert.equal(classify({ ...all, needsUser: false }, now).reason, REASONS.failed)
  assert.equal(classify({ ...all, needsUser: false, lifecycle: 'running' }, now).bucket, 'waiting')
  assert.equal(classify(agent(), now).bucket, 'building')
  assert.deepEqual([classify(agent({ lifecycle: 'idle' }), now).bucket, classify(agent({ lifecycle: 'idle' }), now).reason], ['stalled', REASONS.turn])
  assert.equal(classify(agent({ lifecycle: 'dead' }), now).reason, REASONS.dead)
  for (const l of ['done', 'stopped', 'closed']) assert.equal(classify(agent({ lifecycle: l, needsUser: true }), now).bucket, 'resting')
  // Old evidence is history, whatever it says.
  assert.equal(classify(agent({ needsUser: true, lastActivityAt: now - REST_MS - 1 }), now).bucket, 'resting')
})

test('each wait source maps to its reasonSource; waits expire after the TTL', () => {
  assert.equal(classify(agent({ waitingOn: wait() }), now).reasonSource, 'tool')
  const sched = classify(agent({ waitingOn: wait({ source: 'harness-reported-wait', reason: 'Agent reports waiting for CI or checks' }) }), now)
  assert.deepEqual([sched.bucket, sched.reasonSource, sched.since], ['waiting', 'scheduler', now - 1000])
  assert.equal(classify(agent({ waitingOn: wait({ source: 'harness-in-flight' }) }), now).reasonSource, 'scheduler')
  assert.equal(classify(agent({ waitingOn: wait() }), now + WAIT_TTL_MS).bucket, 'building', 'expired wait falls through')
  assert.equal(classify(agent({ needsUser: true, needsUserSource: 'scheduler' }), now).reasonSource, 'scheduler')
})

test('structural wait: idle parent with busy children waits; stalled/resting children do not count', () => {
  const facts = [
    agent({ id: 'boss', kind: 'job', lifecycle: 'idle' }),
    agent({ id: 'l1', kind: 'job', parentId: 'boss' }),
    agent({ id: 'l2', kind: 'job', parentId: 'boss', lifecycle: 'idle', waitingOn: wait() }),
    agent({ id: 'l3', kind: 'job', parentId: 'boss', lifecycle: 'idle' }),
    agent({ id: 'l4', kind: 'job', parentId: 'boss', lifecycle: 'done' }),
  ]
  const boss = build(facts, {}, now).find((a) => a.id === 'boss')
  assert.deepEqual([boss.bucket, boss.reason, boss.reasonSource], ['waiting', 'Waiting on 2 agents', 'children'])
  // Recursive: a lead waiting on its own subs makes its boss wait too.
  const chain = build([agent({ id: 'b', kind: 'job', lifecycle: 'idle' }), agent({ id: 'l', kind: 'job', parentId: 'b', lifecycle: 'idle' }),
    agent({ id: 's', kind: 'subagent', parentId: 'l' })], {}, now)
  assert.equal(chain.find((a) => a.id === 'b').reason, 'Waiting on 1 agent')
  // A dead parent is not "waiting": it cannot collect its children.
  assert.equal(build([agent({ id: 'p', lifecycle: 'dead' }), agent({ id: 'c', kind: 'job', parentId: 'p' })], {}, now)[0].bucket, 'stalled')
})

test('roles: boss/lead/sub/solo from structure', () => {
  const r = Object.fromEntries(build([
    agent({ id: 'boss', kind: 'job' }),
    agent({ id: 'lead', kind: 'job', parentId: 'boss' }),
    agent({ id: 'sub', kind: 'subagent', parentId: 'lead' }),
    agent({ id: 'worker', kind: 'job', parentId: 'lead2' }),
    agent({ id: 'lead2', kind: 'job' }),
    agent({ id: 'team', kind: 'session' }),
    agent({ id: 'mate', kind: 'teammate', parentId: 'team' }),
    agent({ id: 'solo' }),
  ], {}, now).map((a) => [a.id, [a.role, a.roleSource]]))
  assert.deepEqual(r, {
    boss: ['boss', 'detected'], lead: ['lead', 'detected'], sub: ['sub', 'detected'], worker: ['sub', 'detected'],
    lead2: ['lead', 'detected'], team: ['lead', 'detected'], mate: ['sub', 'detected'], solo: ['solo', 'default'],
  })
})

test('idle teammate: waits on its lead while fresh, rests once parked for 30+ min', () => {
  const mate = (ago) => classify(agent({ kind: 'teammate', parentId: 'l', lifecycle: 'idle', lastActivityAt: now - ago }), now)
  assert.deepEqual([mate(60_000).bucket, mate(60_000).reason], ['waiting', REASONS.lead])
  assert.deepEqual([mate(31 * 60_000).bucket, mate(31 * 60_000).reason], ['resting', REASONS.parked])
})

test('subagents never inherit the parent needs-user or wait', () => {
  const [p, s] = build([agent({ id: 'p', needsUser: true, waitingOn: wait() }), agent({ id: 's', kind: 'subagent', parentId: 'p' })], {}, now)
  assert.equal(p.bucket, 'stalled')
  assert.equal(s.bucket, 'building')
})

test('overrides beat detection: role, parent (incl. forced top-level), name, hidden; cycles are safe', () => {
  const facts = [agent({ id: 'boss', kind: 'job' }), agent({ id: 'lead', kind: 'job', parentId: 'boss' }), agent({ id: 'x', name: 'Detected' })]
  const out = build(facts, {
    x: { role: 'lead', parentId: 'boss', name: 'Mine', hidden: true },
    lead: { parentId: '' },
  }, now)
  const by = Object.fromEntries(out.map((a) => [a.id, a]))
  assert.deepEqual([by.x.role, by.x.roleSource, by.x.parentId, by.x.name, by.x.hidden], ['lead', 'override', 'boss', 'Mine', true])
  assert.equal(by.lead.parentId, null)
  assert.deepEqual(by.boss.childIds, ['x'])
  assert.deepEqual(by.x.overrides, { role: 'lead', parentId: 'boss', name: 'Mine', hidden: true })
  assert.equal(by.boss.overrides, null)
  const cyc = build([agent({ id: 'a', lifecycle: 'idle' }), agent({ id: 'b', lifecycle: 'idle' })], { a: { parentId: 'b' }, b: { parentId: 'a' } }, now)
  assert.equal(cyc.length, 2)
})

test('a resting detected parent does not own a live child', () => {
  const out = build([agent({ id: 'old', lifecycle: 'closed' }), agent({ id: 'boss', kind: 'job', parentId: 'old' }),
    agent({ id: 'gone', kind: 'job', parentId: 'old', lifecycle: 'done' })], {}, now)
  assert.equal(out[1].parentId, null)
  assert.equal(out[2].parentId, 'old', 'history stays attached')
})

test('names and titles are capped at a word boundary with an ellipsis', () => {
  assert.equal(cap('short', 80), 'short')
  const long = 'alpha beta gamma delta '.repeat(20)
  const c = cap(long, 40)
  assert.ok(c.length <= 40 && c.endsWith('…'), c)
  assert.match(c, /(alpha|beta|gamma|delta)…$/, 'cut between words')
  assert.equal(cap('x'.repeat(100), 10), 'xxxxxxxxx…', 'unbroken text still ends with an ellipsis')
  const [a] = build([agent({ name: long, title: long })], {}, now)
  assert.ok(a.name.length <= 80 && a.title.length <= 160)
})

test('stalled severity: failures and crashes are errors, everything else is attention, others null', () => {
  const out = Object.fromEntries(build([
    agent({ id: 'err', lifecycle: 'failed' }),
    agent({ id: 'dead', lifecycle: 'dead' }),
    agent({ id: 'ask', needsUser: true }),
    agent({ id: 'approve', needsUser: true, needsUserReason: REASONS.approval }),
    agent({ id: 'turn', lifecycle: 'idle' }),
    agent({ id: 'stuck', lifecycle: 'stuck' }),
    agent({ id: 'run' }),
    agent({ id: 'rest', lifecycle: 'done' }),
  ], {}, now).map((a) => [a.id, a.severity]))
  assert.deepEqual(out, { err: 'error', dead: 'error', ask: 'attention', approve: 'attention', turn: 'attention', stuck: 'attention', run: null, rest: null })
})
