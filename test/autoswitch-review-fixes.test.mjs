/**
 * Auto-switch review fixes: wait-for-reset, stale-login detection, backoff, too-big Keychain,
 * model-specific limits. Fake account, clock and nudge; no network, Keychain or real sessions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSampler, limitModel, decide, BACKOFF_MS, COOLDOWN_MS, WAIT_RESET_MS, MODEL_HOP_MS } from '../server/autoswitch.mjs'

const NOW = 1_800_000_000_000
const MIN = 60e3, H = 3600e3, DAY = 24 * H
const w = (used, resetsIn = 3 * H) => ({ used, resetsAt: NOW + resetsIn })

function rig({ log = [], state = null, failWith = null, headroom = undefined, respawn = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-auto-fixc-'))
  let clock = NOW
  const env = { active: 'A', reading: { fiveHour: w(50), weekly: w(30, 4 * DAY) }, usage: new Map(), agents: [], changeAt: 0, head: headroom }
  env.usage.set('B', { fiveHour: w(10), weekly: w(10, 4 * DAY) })
  if (log.length) fs.writeFileSync(path.join(dataDir, 'account-log.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n')
  if (state) fs.writeFileSync(path.join(dataDir, 'autoswitch.json'), JSON.stringify(state))
  const calls = [], nudges = [], stale = []
  const list = ['A', 'B'].map((id) => ({ id, label: id.toLowerCase(), quarantine: false }))
  const account = {
    profile: async () => 'acct', lastChangeAt: async () => env.changeAt, isBusy: () => false, poolAvailable: () => false,
    async switchTo(body, ags, opts) {
      calls.push({ at: clock, body, opts })
      if (failWith) throw failWith
      env.active = body.to; env.changeAt = clock
      return { restored: false, results: [] }
    },
    ...(respawn && { respawnStale: async (ids) => { stale.push(ids) } }),
    accounts: {
      activeUsage: async () => ({ id: env.active, saved: true, ...env.reading }),
      load: async () => list, list: async () => ({ active: env.active }),
      usage: async () => ({ accounts: [...env.usage].map(([id, x]) => ({ id, ...x })) }),
      ...(headroom !== undefined && { headroom: async () => env.head }),
    },
  }
  const sampler = createSampler({ dataDir, account, agents: async () => env.agents, nudge: async (ids) => { nudges.push(ids); return ids }, now: () => clock })
  return { sampler, env, calls, nudges, stale, tick: () => sampler.tick(), advance: (ms) => { clock += ms }, now: () => clock,
    state: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'autoswitch.json'), 'utf8')), done: () => fs.rmSync(dataDir, { recursive: true, force: true }) }
}
const AUTO = (at, extra = {}) => ({ at, action: 'switch', auto: true, from: 'A', to: 'B', restored: false, ...extra })
const job = (id, stopAt, text = "You've hit your session limit") => ({ id, live: true, bucket: 'stalled', limitStopAt: stopAt, limitText: text })

test('waiting for the 5-hour reset ends without a switch; stops from the wait get one nudge', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    r.env.reading = { fiveHour: w(100, 10 * MIN), weekly: w(30, 4 * DAY) }
    r.env.agents = [job('j1', NOW - 5 * MIN)]
    assert.equal((await r.tick()).why, 'waiting for the 5-hour reset')
    assert.equal(r.state().waitUntil, NOW + 10 * MIN)
    r.advance(5 * MIN)
    r.env.agents.push(job('j2', NOW + 2 * MIN)) // hits the limit during the wait
    assert.equal((await r.tick()).action, 'none')
    r.advance(6 * MIN) // the reset has passed
    r.env.reading = { fiveHour: w(5, 5 * H), weekly: w(30, 4 * DAY) }
    assert.equal((await r.tick()).action, 'none', 'no switch after the reset')
    assert.equal(r.calls.length, 0)
    assert.deepEqual(r.nudges, [['j1', 'j2']])
    assert.equal(r.state().waitUntil, undefined)
  } finally { r.done() }
})

test('a limit stop newer than the wait still counts', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)], state: { enabled: true, waitUntil: NOW - MIN, waitSetAt: NOW - 20 * MIN } })
  try {
    r.env.reading = { fiveHour: w(30), weekly: w(30, 4 * DAY) }
    r.env.agents = [job('old', NOW - 5 * MIN), job('new', NOW)]
    r.advance(2 * MIN)
    const d = await r.tick()
    assert.equal(d.why, 'limit')
    assert.deepEqual(r.calls[0].opts.why.limitHit, ['new'])
  } finally { r.done() }
})

test('a limit stop right after a switch with room left respawns the stale jobs instead of switching', async () => {
  const r = rig({ log: [AUTO(NOW - 4 * MIN)] })
  try {
    r.env.changeAt = NOW - 4 * MIN
    r.env.agents = [job('j1', NOW - MIN)]
    assert.equal((await r.tick()).why, 'not out')
    assert.deepEqual(r.stale, [['j1']])
    assert.equal(r.calls.length, 0)
    await r.tick()
    assert.equal(r.stale.length, 1, 'once per switch')
  } finally { r.done() }
  const pool = rig({ log: [AUTO(NOW - 4 * MIN, { from: 'pool' })] }) // not account to account
  try {
    pool.env.changeAt = NOW - 4 * MIN
    pool.env.agents = [job('j1', NOW - MIN)]
    await pool.tick()
    assert.equal(pool.stale.length, 0)
  } finally { pool.done() }
  const hot = rig({ log: [AUTO(NOW - 4 * MIN)] }) // the active account is nearly out: switch as usual
  try {
    hot.env.changeAt = NOW - 4 * MIN
    hot.env.reading = { fiveHour: w(96), weekly: w(30, 4 * DAY) }
    hot.env.agents = [job('j1', NOW - MIN)]
    await hot.tick()
    assert.equal(hot.stale.length, 0)
  } finally { hot.done() }
})

test('lastAutoAt is set only on success; a failure follows the 2/4/8 min backoff, not the 15 min cooldown', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)], failWith: Object.assign(new Error('Switch failed'), { status: 500 }) })
  try {
    r.env.reading = { fiveHour: w(97), weekly: w(30, 4 * DAY) }
    await r.tick()
    assert.equal(r.calls.length, 1)
    assert.equal(r.state().lastAutoAt, undefined)
    assert.equal(r.state().retryAt, NOW + BACKOFF_MS[0])
    r.advance(BACKOFF_MS[0] - 1)
    assert.equal((await r.tick()).why, 'backoff')
    r.advance(1)
    await r.tick()
    assert.equal(r.calls.length, 2, 'retried after 2 min, not 15')
    assert.equal(r.state().retryAt, r.now() + BACKOFF_MS[1])
  } finally { r.done() }
  const ok = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    ok.env.reading = { fiveHour: w(97), weekly: w(30, 4 * DAY) }
    await ok.tick()
    assert.equal(ok.state().lastAutoAt, NOW)
    assert.ok(COOLDOWN_MS > 0)
  } finally { ok.done() }
})

test('too_big stops retries, is surfaced, and clears when room returns or the user switches', async () => {
  const err = Object.assign(new Error('Too big'), { status: 409, code: 'too_big', size: 4100, max: 4000 })
  const r = rig({ log: [AUTO(NOW - 3 * H)], headroom: { size: 4100, max: 4000, left: -100 }, failWith: err })
  try {
    r.env.reading = { fiveHour: w(97), weekly: w(30, 4 * DAY) }
    await r.tick()
    assert.equal(r.calls.length, 1)
    assert.deepEqual((await r.sampler.info()).blocked, { reason: 'too_big', size: 4100, max: 4000 })
    for (let i = 0; i < 5; i++) { r.advance(20 * MIN); assert.equal((await r.tick()).why, 'login entry too big') }
    assert.equal(r.calls.length, 1)
    r.env.head = { size: 3000, max: 4000, left: 1000 }
    r.advance(MIN)
    await r.tick()
    assert.equal(r.calls.length, 2, 'room again: tries again')
  } finally { r.done() }
  const m = rig({ log: [AUTO(NOW - 3 * H)], state: { enabled: true, tooBig: { at: NOW - H } }, headroom: { size: 4100, max: 4000, left: -100 } })
  try {
    m.env.reading = { fiveHour: w(97), weekly: w(30, 4 * DAY) }
    assert.equal((await m.tick()).why, 'login entry too big')
    m.env.changeAt = NOW - MIN // the user switched by hand
    assert.notEqual((await m.tick()).why, 'login entry too big')
  } finally { m.done() }
  const low = rig({ headroom: { size: 3800, max: 4000, left: 200 } })
  try { await low.tick(); assert.deepEqual((await low.sampler.info()).headroom, { size: 3800, max: 4000, left: 200 }) } finally { low.done() }
})

test('limitModel names the model, not plain windows', () => {
  assert.equal(limitModel("You've hit your Opus weekly limit · resets 3pm"), 'opus')
  assert.equal(limitModel("You've hit your Sonnet limit"), 'sonnet')
  assert.equal(limitModel("You've hit your weekly limit"), '')
  assert.equal(limitModel("You've hit your session limit"), '')
  assert.equal(limitModel('hello'), '')
})

test('model-specific limits hop at most once an hour and record the model; plain limits are never held back', async () => {
  const OPUS = "You've hit your Opus weekly limit"
  const r = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    r.env.agents = [job('j1', NOW - MIN, OPUS)]
    assert.equal((await r.tick()).why, 'limit')
    assert.equal(r.calls[0].opts.why.model, 'opus')
    r.env.active = 'A'; r.advance(COOLDOWN_MS + MIN) // back on A; a new Opus stop within the hour does not hop again
    r.env.agents = [job('j1', r.now() - MIN, OPUS)]
    assert.equal((await r.tick()).why, 'not out')
    r.advance(MODEL_HOP_MS)
    r.env.agents = [job('j1', r.now() - MIN, OPUS)]
    assert.equal((await r.tick()).why, 'limit')
  } finally { r.done() }
  const p = rig({ log: [AUTO(NOW - 3 * H)], state: { enabled: true, lastModelHopAt: NOW - MIN } })
  try { p.env.agents = [job('j1', NOW - MIN)]; assert.equal((await p.tick()).why, 'limit') } finally { p.done() }
})

test('decide reports the reset time it is waiting for', () => {
  const d = decide({ enabled: true, active: 'A', saved: ['A', 'B'], limitHit: true, busy: false, lastAutoAt: 0, poolAvailable: false, now: NOW,
    activeUsage: { fiveHour: w(100, WAIT_RESET_MS - 1), weekly: w(30, 4 * DAY) }, usage: new Map() })
  assert.equal(d.waitUntil, NOW + WAIT_RESET_MS - 1)
})
