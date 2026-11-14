/**
 * Auto-switch last resort (incident 2026-11-13: the active account hit its 5-hour limit, every other
 * account had under 20% of its week left, and auto-switch did nothing). Pure decide() plus createSampler()
 * against a fake account and clock. No network, Keychain, real Claude home or sessions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decide, blockedUntil, createSampler, TARGET_MIN_ROOM, FALLBACK_MIN_ROOM, FALLBACK_MIN_FIVE_ROOM, WAIT_RESET_MS } from '../server/autoswitch.mjs'

const NOW = 1_800_000_000_000
const MIN = 60e3, H = 3600e3, DAY = 24 * H
const w = (used, resetsIn = 3 * H) => ({ used, resetsAt: NOW + resetsIn })

// The incident: D active and out on its 5-hour window (resets in 20 min), A/B/C low on their weeks.
const INCIDENT = {
  enabled: true, active: 'D', saved: ['A', 'B', 'C', 'D'], limitHit: true, busy: false, lastAutoAt: 0, poolAvailable: false, now: NOW, manual: true,
  activeUsage: { fiveHour: w(100, 20 * MIN), weekly: w(27, 5 * DAY) },
  usage: new Map([
    ['A', { fiveHour: w(0, 4 * H), weekly: w(98, 1 * DAY) }],
    ['B', { fiveHour: w(0, 4 * H), weekly: w(95, 2 * DAY) }],
    ['C', { fiveHour: w(2, 4 * H), weekly: w(87, 3 * DAY) }],
  ]),
}

test('constants: the last-resort floors sit well under the normal target room', () => {
  assert.deepEqual([TARGET_MIN_ROOM, FALLBACK_MIN_ROOM, FALLBACK_MIN_FIVE_ROOM], [20, 3, 10])
})

test('incident numbers: really out with no 20% target goes to C (most weekly room among accounts not out)', () => {
  assert.deepEqual(decide(INCIDENT), { action: 'switch', to: 'C', why: 'five_hour', fallback: true })
  assert.deepEqual(decide({ ...INCIDENT, activeUsage: { fiveHour: w(90, 20 * MIN), weekly: w(27, 5 * DAY) } }), { action: 'switch', to: 'C', why: 'limit', fallback: true }, 'a limit stop alone')
  assert.deepEqual(decide({ ...INCIDENT, limitHit: false }), { action: 'switch', to: 'C', why: 'five_hour', fallback: true }, 'OUT_AT alone, no limit stop yet')
  assert.deepEqual(decide({ ...INCIDENT, activeUsage: { fiveHour: w(40), weekly: w(99.5) }, limitHit: false }).to, 'C', 'out on the week')
  // Before the fix this was { action: 'none', why: 'nowhere to go' }.
})

test('last resort: ranked by weekly room, then soonest weekly reset; floors are inclusive', () => {
  const two = (b, c) => decide({ ...INCIDENT, usage: new Map([['B', b], ['C', c]]) }).to
  assert.equal(two({ fiveHour: w(0), weekly: w(90) }, { fiveHour: w(0), weekly: w(85) }), 'C')
  assert.equal(two({ fiveHour: w(0), weekly: w(90, 1 * DAY) }, { fiveHour: w(0), weekly: w(90, 2 * DAY) }), 'B', 'same room: the week that resets sooner')
  assert.equal(two({ fiveHour: w(0), weekly: w(97) }, { fiveHour: w(0), weekly: w(97.5) }), 'B', 'exactly 3% of the week is enough')
  assert.equal(two({ fiveHour: w(90), weekly: w(50) }, { fiveHour: w(91), weekly: w(10) }), 'B', 'exactly 10% of the 5-hour window is enough')
  assert.equal(two({ fiveHour: { used: 0, resetsAt: null, none: true }, weekly: w(96) }, { fiveHour: w(95), weekly: w(10) }), 'B', 'no 5-hour limit always has room')
  const none = decide({ ...INCIDENT, usage: new Map([['B', { error: 'Login expired', fiveHour: null, weekly: null }], ['C', { fiveHour: w(95), weekly: w(10) }]]) })
  assert.deepEqual(none, { action: 'none', why: 'nowhere to go' }, 'unknown usage, or under 10% of the 5-hour window: not a last resort')
})

test('last resort comes before the pool (the pool is one-way), and a real target before both', () => {
  assert.equal(decide({ ...INCIDENT, poolAvailable: true }).to, 'C')
  const roomy = new Map([...INCIDENT.usage, ['B', { fiveHour: w(50), weekly: w(70) }]])
  assert.deepEqual(decide({ ...INCIDENT, usage: roomy }), { action: 'switch', to: 'B', why: 'five_hour' })
  const dead = new Map([...INCIDENT.usage].map(([k, u]) => [k, { ...u, weekly: w(99) }]))
  assert.equal(decide({ ...INCIDENT, usage: dead, poolAvailable: true }).to, 'pool')
})

test('proactive switching still needs 20% room: no hop onto a nearly-used account early', () => {
  const soft = { ...INCIDENT, manual: false, limitHit: false }
  assert.deepEqual(decide({ ...soft, activeUsage: { fiveHour: w(96, 2 * H), weekly: w(27, 5 * DAY) } }), { action: 'none', why: 'nowhere to go' }, 'at SWITCH_AT, not OUT_AT')
  assert.deepEqual(decide({ ...soft, activeUsage: { fiveHour: w(80, 2 * H), weekly: w(27, 5 * DAY) }, projectedMs: 2 * MIN }), { action: 'none', why: 'nowhere to go' }, 'projected to fill')
  assert.deepEqual(decide({ ...soft, activeUsage: { fiveHour: w(80, 2 * H), weekly: w(27, 5 * DAY) }, rebalance: true }), { action: 'none', why: 'not out' }, 'rebalance')
})

test('the 5-hour wait rule still wins when the reset is within 15 min', () => {
  const soon = { ...INCIDENT, activeUsage: { fiveHour: w(100, WAIT_RESET_MS), weekly: w(27, 5 * DAY) } }
  assert.deepEqual(decide(soon), { action: 'none', why: 'waiting for the 5-hour reset', waitUntil: NOW + WAIT_RESET_MS })
})

test('blockedUntil: the soonest time any account can run again', () => {
  const dead = new Map([
    ['A', { fiveHour: w(0), weekly: w(99, 30 * H) }],
    ['B', { fiveHour: w(100, 2 * H), weekly: w(98, 10 * H) }], // both windows: the later reset
    ['C', { error: 'Login expired', fiveHour: null, weekly: null }],
  ])
  assert.equal(blockedUntil({ ...INCIDENT, usage: dead, activeUsage: { fiveHour: w(100, 20 * MIN), weekly: w(99, 2 * DAY) } }), NOW + 10 * H, 'B frees up first')
  assert.equal(blockedUntil({ ...INCIDENT, usage: dead, activeUsage: { fiveHour: w(100, 40 * MIN), weekly: w(27) } }), NOW + 40 * MIN, 'the active one is counted too')
  assert.equal(blockedUntil({ ...INCIDENT, saved: ['C', 'D'], usage: dead, activeUsage: { fiveHour: { used: 100, resetsAt: null }, weekly: w(27) } }), null, 'unknown')
})

// ---- the sampler, with a fake account and clock ----
function rig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-auto-fallback-'))
  let clock = NOW
  const env = { active: 'D', reading: INCIDENT.activeUsage, usage: new Map(INCIDENT.usage), agents: [], changeAt: NOW - 3 * H, pool: false }
  fs.writeFileSync(path.join(dataDir, 'account-log.jsonl'), JSON.stringify({ at: NOW - 3 * H, action: 'switch', account: 'D', restored: false }) + '\n')
  const calls = [], nudges = []
  const list = ['A', 'B', 'C', 'D'].map((id) => ({ id, label: id.toLowerCase(), quarantine: false }))
  const account = {
    profile: async () => 'acct',
    lastChangeAt: async () => env.changeAt,
    isBusy: () => false,
    poolAvailable: () => env.pool,
    async switchTo(body) { calls.push(body); env.active = body.to; env.changeAt = clock; return { restored: false, results: [] } },
    accounts: {
      activeUsage: async () => ({ id: env.active, saved: true, ...env.reading }),
      load: async () => list,
      list: async () => ({ active: env.active }),
      usage: async () => ({ accounts: [...env.usage].map(([id, x]) => ({ id, ...x })) }),
    },
  }
  const sampler = createSampler({ dataDir, account, network: null, agents: async () => env.agents, nudge: async (ids) => { nudges.push(ids); return ids }, now: () => clock })
  const logLines = () => fs.readFileSync(path.join(dataDir, 'account-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  return { sampler, env, calls, nudges, logLines, advance: (ms) => { clock += ms }, at: (t) => { clock = t }, done: () => fs.rmSync(dataDir, { recursive: true, force: true }) }
}
const stopped = (at) => [{ id: 'j1', live: true, bucket: 'stalled', limitStopAt: at }, { id: 'j2', live: true, bucket: 'stalled', limitStopAt: at }]

test('sampler, incident numbers: switches to C and tells the stopped jobs to continue', async () => {
  const r = rig()
  try {
    r.env.agents = stopped(NOW - MIN)
    const d = await r.sampler.tick()
    assert.deepEqual([d.action, d.to, d.why, d.fallback], ['switch', 'C', 'five_hour', true])
    assert.deepEqual(r.calls, [{ to: 'C' }])
    assert.deepEqual(r.nudges, [['j1', 'j2']])
    assert.equal((await r.sampler.info()).blocked, null)
  } finally { r.done() }
})

test('sampler, every account out: no switch, a { why, until } block for the banner, one log line, cleared once it can run', async () => {
  const r = rig()
  try {
    r.env.agents = stopped(NOW - MIN)
    r.env.usage = new Map([
      ['A', { fiveHour: w(0), weekly: w(99, 30 * H) }],
      ['B', { fiveHour: w(0), weekly: w(98, 10 * H) }],
      ['C', { fiveHour: w(100, 2 * H), weekly: w(50, 3 * DAY) }],
    ])
    r.env.reading = { fiveHour: w(100, 50 * MIN), weekly: w(27, 5 * DAY) }
    let d = await r.sampler.tick()
    assert.deepEqual([d.action, d.why], ['none', 'nowhere to go'])
    assert.equal(r.calls.length, 0)
    assert.deepEqual((await r.sampler.info()).blocked, { why: 'all accounts low', until: NOW + 50 * MIN }, 'the active 5-hour reset is the soonest')
    const blockedLines = () => r.logLines().filter((e) => e.action === 'autoswitch_blocked')
    assert.equal(blockedLines().length, 1)
    assert.deepEqual(Object.keys(blockedLines()[0]).sort(), ['account', 'accounts', 'at', 'action', 'until', 'why'].sort(), 'no emails, labels or tokens')
    assert.equal(JSON.stringify(blockedLines()[0]).includes('@'), false)

    r.advance(MIN); await r.sampler.tick()
    assert.equal(blockedLines().length, 1, 'one line per episode, not one a minute')

    // Within 15 min of the reset: the wait rule; the banner stays (jobs are still stopped).
    r.advance(40 * MIN)
    d = await r.sampler.tick()
    assert.equal(d.why, 'waiting for the 5-hour reset')
    assert.deepEqual((await r.sampler.info()).blocked, { why: 'all accounts low', until: NOW + 50 * MIN })

    // Past the reset: the reading still says 100% (held over), but the window has reset: not out, the jobs get "continue" once.
    r.at(NOW + 51 * MIN)
    d = await r.sampler.tick()
    assert.equal(d.why, 'not out')
    assert.deepEqual(r.nudges, [['j1', 'j2']], 'the "continue" nudge fires at the reset')
    assert.equal((await r.sampler.info()).blocked, null, 'the banner clears')
    r.advance(MIN); await r.sampler.tick()
    assert.equal(r.nudges.length, 1, 'never again for the same stop')
    assert.equal(r.calls.length, 0)
  } finally { r.done() }
})

test('sampler: a block clears when an account frees up and the switch goes through', async () => {
  const r = rig()
  try {
    r.env.usage = new Map([['A', { fiveHour: w(0), weekly: w(99, 30 * H) }], ['B', { fiveHour: w(0), weekly: w(99, 30 * H) }], ['C', { fiveHour: w(0), weekly: w(99, 30 * H) }]])
    r.env.reading = { fiveHour: w(100, 2 * H), weekly: w(27, 5 * DAY) }
    await r.sampler.tick()
    assert.equal((await r.sampler.info()).blocked.why, 'all accounts low')
    r.env.usage.set('B', { fiveHour: w(0), weekly: w(60, 2 * DAY) }) // B's week reset
    r.advance(MIN)
    const d = await r.sampler.tick()
    assert.deepEqual([d.action, d.to], ['switch', 'B'])
    assert.equal((await r.sampler.info()).blocked, null)
  } finally { r.done() }
})
