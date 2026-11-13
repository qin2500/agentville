/**
 * Auto-switch decisions (audit fixes): when to leave, where to go, the manual-pick guard, the limit
 * signal, audit reasons, backoff and the "continue" nudge. Pure decide() plus createSampler() against
 * a fake account with a fake clock. No network, Keychain, real Claude home or sessions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  decide, extrapolate, createSampler,
  OUT_AT, SWITCH_AT, STALE_MS, PROJECT_WITHIN_MS, WAIT_RESET_MS, TARGET_MIN_ROOM, SOON_WEEK_MS, BACKOFF_MS, COOLDOWN_MS,
} from '../server/autoswitch.mjs'
import { isHarnessLimit } from '../server/claude-code.mjs'

const NOW = 1_800_000_000_000
const MIN = 60e3, H = 3600e3, DAY = 24 * H
const w = (used, resetsIn = 3 * H) => ({ used, resetsAt: NOW + resetsIn })
const base = {
  enabled: true, active: 'A', saved: ['A', 'B', 'C', 'D'], limitHit: false, busy: false, lastAutoAt: 0, poolAvailable: true, now: NOW,
  activeUsage: { fiveHour: w(50, 3 * H), weekly: w(30, 4 * DAY) },
  usage: new Map([['B', { fiveHour: w(10), weekly: w(10, 4 * DAY) }]]),
}
const NOT_OUT = { action: 'none', why: 'not out' }

test('thresholds', () => {
  assert.deepEqual([OUT_AT, SWITCH_AT, PROJECT_WITHIN_MS, STALE_MS, WAIT_RESET_MS, TARGET_MIN_ROOM, SOON_WEEK_MS], [99, 95, 5 * MIN, 2 * MIN, 15 * MIN, 20, 36 * H])
  assert.deepEqual(BACKOFF_MS, [2 * MIN, 4 * MIN, 8 * MIN, 15 * MIN])
})

// ---- 1. when to leave ----
test('leaves when the 5-hour window is projected to fill within 5 min, or at 95% of either window', () => {
  assert.deepEqual(decide({ ...base, projectedMs: 4 * MIN }), { action: 'switch', to: 'B', why: 'projected' })
  assert.deepEqual(decide({ ...base, projectedMs: PROJECT_WITHIN_MS }), { action: 'switch', to: 'B', why: 'projected' })
  assert.deepEqual(decide({ ...base, projectedMs: PROJECT_WITHIN_MS + 1 }), NOT_OUT)
  assert.deepEqual(decide({ ...base, projectedMs: null }), NOT_OUT)
  assert.equal(decide({ ...base, activeUsage: { fiveHour: w(95), weekly: w(30) } }).why, 'five_hour')
  assert.equal(decide({ ...base, activeUsage: { fiveHour: w(94.9), weekly: w(30) } }).why, 'not out')
  assert.equal(decide({ ...base, activeUsage: { fiveHour: w(20), weekly: w(95) } }).why, 'weekly')
})

test('extrapolate: a reading older than 2 min moves on at the local pace; a fresh one is trusted', () => {
  const u = { fiveHour: w(80), weekly: w(30) }
  assert.equal(extrapolate(u, { ageMs: STALE_MS, perHour: 120, ratio: 0.25 }), u, 'exactly 2 min: as read')
  const e = extrapolate(u, { ageMs: 10 * MIN, perHour: 120, ratio: 0.25 })
  assert.equal(e.fiveHour.used, 100, 'capped at 100')
  assert.equal(e.weekly.used, 35)
  assert.equal(u.fiveHour.used, 80, 'input untouched')
  assert.equal(extrapolate(u, { ageMs: 10 * MIN, perHour: 0, ratio: 0.25 }), u, 'no pace known: nothing to extrapolate')
  assert.equal(extrapolate({ error: 'x' }, { ageMs: 10 * MIN, perHour: 50 }).error, 'x')
})

// ---- 2. where to go ----
test('target: needs 20% room in both windows; the 90%-weekly / 113 h account is never chosen over 8% and 20%', () => {
  const act = { fiveHour: w(96), weekly: w(30, 4 * DAY) }
  const usage = new Map([
    ['B', { fiveHour: w(10), weekly: w(90, 113 * H) }],
    ['C', { fiveHour: w(10), weekly: w(8, 100 * H) }],
    ['D', { fiveHour: w(10), weekly: w(20, 90 * H) }],
  ])
  assert.equal(decide({ ...base, activeUsage: act, usage }).to, 'C', 'most weekly headroom when no week resets within 36 h')
  const edge = (five, week) => decide({ ...base, activeUsage: act, usage: new Map([['B', { fiveHour: w(five), weekly: w(week) }]]) }).to
  assert.equal(edge(80, 80), 'B', 'exactly 20% room is enough')
  assert.equal(edge(80.5, 10), 'pool', 'under 20% of the 5-hour window')
  assert.equal(edge(10, 80.5), 'pool', 'under 20% of the week')
})

test('target: soonest weekly reset first, but only within 36 h and with real room', () => {
  const act = { fiveHour: w(96), weekly: w(30, 4 * DAY) }
  const usage = new Map([
    ['B', { fiveHour: w(10), weekly: w(5, 100 * H) }], // most room, week far away
    ['C', { fiveHour: w(10), weekly: w(40, 30 * H) }], // week resets within 36 h
    ['D', { fiveHour: w(10), weekly: w(30, 10 * H) }], // sooner still
  ])
  assert.equal(decide({ ...base, activeUsage: act, usage }).to, 'D')
  usage.set('D', { fiveHour: w(10), weekly: w(85, 10 * H) }) // sooner, but no room: out of the running
  assert.equal(decide({ ...base, activeUsage: act, usage }).to, 'C')
  usage.set('C', { fiveHour: w(10), weekly: w(40, 36 * H + 1) }) // just outside 36 h
  assert.equal(decide({ ...base, activeUsage: act, usage }).to, 'B')
})

test('stays when only the 5-hour window is out and it resets within 15 min', () => {
  const at = (resetsIn, weekly = 30, extra = {}) => decide({ ...base, activeUsage: { fiveHour: w(97, resetsIn), weekly: w(weekly) }, ...extra })
  assert.deepEqual(at(10 * MIN), { action: 'none', why: 'waiting for the 5-hour reset', waitUntil: NOW + 10 * MIN })
  assert.deepEqual(at(WAIT_RESET_MS), { action: 'none', why: 'waiting for the 5-hour reset', waitUntil: NOW + WAIT_RESET_MS })
  assert.equal(at(WAIT_RESET_MS + MIN).action, 'switch')
  assert.equal(at(10 * MIN, 96).action, 'switch', 'the week is out too: waiting would not help')
  assert.equal(at(10 * MIN, 30, { projectedMs: MIN, activeUsage: { fiveHour: w(80, 10 * MIN), weekly: w(30) } }).why, 'waiting for the 5-hour reset', 'also for a projection')
})

// ---- 3. manual pick ----
test('a manual pick is left only when really out (99% or a limit hit)', () => {
  const m = (five, weekly = 30, extra = {}) => decide({ ...base, manual: true, activeUsage: { fiveHour: w(five), weekly: w(weekly) }, ...extra })
  assert.deepEqual(m(97), NOT_OUT)
  assert.deepEqual(m(30, 97), NOT_OUT)
  assert.deepEqual(m(50, 30, { projectedMs: MIN }), NOT_OUT)
  assert.equal(m(99).why, 'five_hour')
  assert.equal(m(30, 99).why, 'weekly')
  assert.equal(m(30, 30, { limitHit: true }).why, 'limit')
  assert.deepEqual(m(50, 30, { rebalance: true, usage: new Map([['B', { fiveHour: w(5), weekly: w(5, DAY) }]]), activeUsage: { fiveHour: w(10), weekly: w(30, 6 * DAY) } }), NOT_OUT, 'never rebalances off a manual pick')
  assert.equal(decide({ ...base, manual: false, rebalance: true, activeUsage: { fiveHour: w(10), weekly: w(30, 6 * DAY) }, usage: new Map([['B', { fiveHour: w(5), weekly: w(5, DAY) }]]) }).why, 'rebalance')
})

// ---- 6. backoff ----
test('decide: no attempt before retryAt, on every path including quarantine', () => {
  const out = { ...base, activeUsage: { fiveHour: w(97, 3 * H), weekly: w(30) } }
  assert.equal(decide({ ...out, retryAt: NOW + 1 }).why, 'backoff')
  assert.equal(decide({ ...out, retryAt: NOW }).action, 'switch')
  const banned = { ...base, onWork: true, quarantine: new Set(['A']), activeUsage: { fiveHour: w(10), weekly: w(10) }, lastAutoAt: NOW - 1000 }
  assert.equal(decide(banned).why, 'quarantine', 'the cooldown does not hold a quarantine move')
  assert.equal(decide({ ...banned, retryAt: NOW + 1 }).why, 'backoff', 'but a backoff does')
})

// ---- 4. the limit signal ----
test('isHarnessLimit: only the harness string, anchored', () => {
  assert.equal(isHarnessLimit("You've hit your weekly limit · resets Oct 28 at 7am"), true)
  assert.equal(isHarnessLimit('You’ve hit your session limit · resets 3pm'), true)
  assert.equal(isHarnessLimit("You've hit your Opus limit"), true)
  assert.equal(isHarnessLimit('I think we may hit the usage limit soon'), false)
  assert.equal(isHarnessLimit("Noted: You've hit your weekly limit"), false, 'anchored at the start')
  assert.equal(isHarnessLimit('Usage limit reached'), false)
  assert.equal(isHarnessLimit(undefined), false)
})

// ---- sampler, with a fake account and clock ----
function rig({ log = [], state = null, accounts = ['A', 'B'], failSwitch = false, nudge = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-auto-guards-'))
  let clock = NOW
  const env = { active: 'A', reading: { fiveHour: w(50), weekly: w(30, 4 * DAY) }, usage: new Map(), agents: [], changeAt: 0, onWork: false }
  env.usage.set('B', { fiveHour: w(10), weekly: w(10, 4 * DAY) })
  env.usage.set('C', { fiveHour: w(10), weekly: w(10, 4 * DAY) })
  const writeLog = (entries) => fs.writeFileSync(path.join(dataDir, 'account-log.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  if (log.length) writeLog(log)
  if (state) fs.writeFileSync(path.join(dataDir, 'autoswitch.json'), JSON.stringify(state))
  const calls = [], nudges = []
  const list = accounts.map((id) => ({ id, label: id.toLowerCase(), quarantine: false }))
  const account = {
    profile: async () => 'acct',
    lastChangeAt: async () => env.changeAt,
    isBusy: () => false,
    poolAvailable: () => true,
    async switchTo(body, ags, opts) {
      calls.push({ at: clock, body, opts })
      if (failSwitch) throw Object.assign(new Error('Switch failed'), { status: 500 })
      env.active = body.to; env.changeAt = clock
      return { restored: false, results: [] }
    },
    accounts: {
      activeUsage: async () => ({ id: env.active, saved: true, ...env.reading }),
      load: async () => list,
      list: async () => ({ active: env.active }),
      usage: async () => ({ accounts: [...env.usage].map(([id, x]) => ({ id, ...x })) }),
    },
  }
  const network = { status: async () => ({ current: { id: 'net', work: env.onWork }, work: env.onWork ? ['net'] : [] }) }
  const sampler = createSampler({ dataDir, account, network, agents: async () => env.agents, nudge: nudge ? async (ids) => { nudges.push(ids); return ids } : null, now: () => clock })
  return { sampler, env, calls, nudges, dataDir, writeLog, list, tick: () => sampler.tick(), at: (t) => { clock = t }, advance: (ms) => { clock += ms }, now: () => clock,
    done: () => fs.rmSync(dataDir, { recursive: true, force: true }) }
}
const AUTO = (at) => ({ at, action: 'switch', auto: true, account: 'A', restored: false })
const MANUAL = (at) => ({ at, action: 'switch', account: 'A', restored: false })

test('sampler: a rising 5-hour window projected to fill within 5 min switches before agents hit the limit', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    // 4 %/min from 62 %, the window started 6 min ago: after 5 min of samples the fit is 4 %/min, 18 % left = 4.5 min.
    let d
    for (let i = 0; i <= 5; i++) {
      r.env.reading = { fiveHour: { used: 62 + 4 * i, resetsAt: NOW + 294 * MIN }, weekly: w(30, 4 * DAY) }
      d = await r.tick()
      if (i < 5) assert.equal(d.why, 'not out', `minute ${i}`)
      else r.advance(0)
      if (i < 5) r.advance(MIN)
    }
    assert.deepEqual([d.action, d.to, d.why], ['switch', 'B', 'projected'])
    const why = r.calls[0].opts.why
    assert.equal(why.reason, 'projected')
    assert.equal(why.active.id, 'A'); assert.equal(why.active.fiveHour, 82)
  } finally { r.done() }
})

test('sampler: a stale active reading is extrapolated at the local pace, not trusted as current', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    const key = 'A'
    // The last real samples were 20-10 min ago, climbing 2 %/min to 80 %.
    r.sampler.samples.set(key, Array.from({ length: 11 }, (_, i) => ({ at: NOW - (20 - i) * MIN, five: { used: 60 + 2 * i, resetsAt: NOW + 270 * MIN }, week: { used: 30, resetsAt: NOW + 4 * DAY } })))
    r.env.reading = { fiveHour: { used: 80, resetsAt: NOW + 270 * MIN }, weekly: w(30, 4 * DAY), stale: true, asOf: NOW - 10 * MIN }
    const d = await r.tick()
    assert.equal(d.action, 'switch')
    const why = r.calls[0].opts.why
    assert.equal(why.active.ageMs, 10 * MIN)
    assert.ok(why.active.fiveHour > 90, `extrapolated past the reading: ${why.active.fiveHour}`)
  } finally { r.done() }
  const same = rig({ log: [AUTO(NOW - 3 * H)] }) // the same 80 % read just now: nothing to do
  try {
    same.env.reading = { fiveHour: { used: 80, resetsAt: NOW + 270 * MIN }, weekly: w(30, 4 * DAY) }
    assert.equal((await same.tick()).why, 'not out')
  } finally { same.done() }
})

test('sampler: the manual-pick guard follows the audit log entry, not timing', async () => {
  // A manual pick right after an automatic switch (within 5 min): still manual.
  const manual = rig({ log: [AUTO(NOW - 4 * MIN), MANUAL(NOW - 2 * MIN)], state: { enabled: true, lastAutoAt: NOW - 4 * MIN - COOLDOWN_MS } })
  try {
    manual.env.reading = { fiveHour: w(97, 3 * H), weekly: w(30, 4 * DAY) }
    assert.equal((await manual.tick()).why, 'not out', '97% on a manual pick: stays')
    manual.env.reading = { fiveHour: w(99, 3 * H), weekly: w(30, 4 * DAY) }
    assert.equal((await manual.tick()).action, 'switch', 'really out: leaves')
  } finally { manual.done() }
  // The reverse: an automatic switch long ago is still automatic.
  const auto = rig({ log: [MANUAL(NOW - 9 * H), AUTO(NOW - 8 * H)] })
  try {
    auto.env.reading = { fiveHour: w(97, 3 * H), weekly: w(30, 4 * DAY) }
    assert.equal((await auto.tick()).action, 'switch')
  } finally { auto.done() }
  // An undo is a manual change; so is no log at all.
  const undo = rig({ log: [AUTO(NOW - 8 * H), { at: NOW - 7 * H, action: 'undo' }] })
  try {
    undo.env.reading = { fiveHour: w(97, 3 * H), weekly: w(30, 4 * DAY) }
    assert.equal((await undo.tick()).why, 'not out')
  } finally { undo.done() }
  const none = rig()
  try {
    none.env.reading = { fiveHour: w(97, 3 * H), weekly: w(30, 4 * DAY) }
    assert.equal((await none.tick()).why, 'not out')
  } finally { none.done() }
})

test('sampler: a limit counts only from a harness-string job record newer than the last change', async () => {
  const live = (id, extra) => ({ id, live: true, bucket: 'stalled', ...extra })
  const r = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    r.env.changeAt = NOW - 60 * MIN
    r.env.agents = [
      live('old', { limitStopAt: NOW - 90 * MIN }), // before the last change: stale
      live('talk', { reason: 'Usage limit', lastActivityAt: NOW - MIN }), // reads like a limit, but no scheduler record says so
      { ...live('gone', { limitStopAt: NOW - 5 * MIN }), live: false },
    ]
    assert.equal((await r.tick()).why, 'not out')
    r.env.agents.push(live('hit1', { limitStopAt: NOW - 5 * MIN }), live('hit2', { limitStopAt: NOW - 2 * MIN }))
    const d = await r.tick()
    assert.deepEqual([d.action, d.why], ['switch', 'limit'])
    assert.deepEqual(r.calls[0].opts.why.limitHit, ['hit1', 'hit2'])
  } finally { r.done() }
})

test('sampler: the switch carries { auto, why } with the active and target numbers', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    r.env.reading = { fiveHour: w(96, 3 * H), weekly: w(30, 4 * DAY) }
    await r.tick()
    assert.equal(r.calls.length, 1)
    assert.deepEqual(r.calls[0].body, { to: 'B' })
    assert.deepEqual(r.calls[0].opts, { auto: true, why: { reason: 'out', active: { id: 'A', fiveHour: 96, weekly: 30, ageMs: 0 }, limitHit: [], target: { id: 'B', fiveHour: 10, weekly: 10 } } })
  } finally { r.done() }
})

// ---- 7. nudge ----
test('nudge: after a successful limit switch, once, to the stopped jobs only', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    r.env.changeAt = NOW - 60 * MIN
    r.env.agents = [{ id: 'j1', live: true, bucket: 'stalled', limitStopAt: NOW - MIN }, { id: 'j1', live: true, bucket: 'stalled', limitStopAt: NOW - MIN }, { id: 'j2', live: true, bucket: 'building' }]
    await r.tick()
    assert.deepEqual(r.nudges, [['j1']])
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.dataDir, 'autoswitch.json'), 'utf8')).last.nudged, 1)
    r.advance(COOLDOWN_MS + MIN); await r.tick() // those jobs now predate the new change
    assert.equal(r.nudges.length, 1, 'never again for the same stop')
  } finally { r.done() }
  const quiet = rig({ log: [AUTO(NOW - 3 * H)] }) // out, but nobody hit the limit: no nudge
  try {
    quiet.env.reading = { fiveHour: w(97, 3 * H), weekly: w(30, 4 * DAY) }
    await quiet.tick()
    assert.equal(quiet.calls.length, 1); assert.equal(quiet.nudges.length, 0)
  } finally { quiet.done() }
  const failed = rig({ log: [AUTO(NOW - 3 * H)], failSwitch: true }) // the switch failed: nothing to continue on
  try {
    failed.env.agents = [{ id: 'j1', live: true, bucket: 'stalled', limitStopAt: NOW - MIN }]
    await failed.tick()
    assert.equal(failed.nudges.length, 0)
  } finally { failed.done() }
})

// ---- 6. backoff, end to end ----
test('sampler: a failing forced quarantine switch backs off 2, 4, 8, 15, 15 min instead of retrying every tick', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)], failSwitch: true, accounts: ['A', 'B'] })
  try {
    r.list[0].quarantine = true // A is a quarantine account, and we are on the work Wi-Fi
    r.env.onWork = true
    r.env.reading = { fiveHour: w(10), weekly: w(10) }
    const attempts = []
    for (let t = 0; t <= 60; t++) { // one enforce check every 10 s would be far more; per-minute is enough to see the gaps
      r.at(NOW + t * MIN)
      const before = r.calls.length
      await r.sampler.enforce()
      if (r.calls.length > before) attempts.push(t)
    }
    assert.deepEqual(attempts, [0, 2, 6, 14, 29, 44, 59])
  } finally { r.done() }
})

test('sampler: a success clears the backoff', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)], state: { enabled: true, failures: 3, retryAt: NOW - 1 }, accounts: ['A', 'B'] })
  try {
    r.env.reading = { fiveHour: w(97, 3 * H), weekly: w(30, 4 * DAY) }
    assert.equal((await r.tick()).action, 'switch')
    const st = JSON.parse(fs.readFileSync(path.join(r.dataDir, 'autoswitch.json'), 'utf8'))
    assert.deepEqual([st.failures, st.retryAt], [0, 0])
  } finally { r.done() }
})
