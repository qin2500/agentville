/**
 * Auto-switch rebalance: with the active account NOT out, move to the account whose weekly allowance
 * expires soonest (use it before it is lost). Pure decide() + fresh(); no network, Keychain or real homes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decide, fresh, COOLDOWN_MS, OUT_AT,
  REBALANCE_LEAD_MS, REBALANCE_MIN_ROOM, REBALANCE_MAX_FIVE,
} from '../server/autoswitch.mjs'
import { NO_LIMIT } from '../server/accounts.mjs'

const NOW = 1_800_000_000_000
const H = 3600e3
const DAY = 24 * H
const w = (used, resetsIn = H) => ({ used, resetsAt: NOW + resetsIn })
const u = (five, week) => ({ fiveHour: five, weekly: week })
const base = {
  enabled: true, active: 'A', saved: ['A', 'B', 'C'], limitHit: false, busy: false, lastAutoAt: 0, poolAvailable: true, now: NOW,
  rebalance: true,
  activeUsage: u(w(20, 2 * H), w(30, 5 * DAY)),
  usage: new Map([['B', u(w(10, 2 * H), w(30, 1 * DAY))]]),
}
const withUsage = (entries) => ({ ...base, usage: new Map(entries) })
const NOT_OUT = { action: 'none', why: 'not out' }

test('the exported thresholds are the specified numbers', () => {
  assert.equal(REBALANCE_LEAD_MS, 6 * H)
  assert.equal(REBALANCE_MIN_ROOM, 10)
  assert.equal(REBALANCE_MAX_FIVE, 80)
})

test('fresh: a window that has reset since it was read is back to 0 used', () => {
  const r = fresh(u({ used: 100, resetsAt: NOW - 1 }, { used: 40, resetsAt: NOW + H }), NOW)
  assert.equal(r.fiveHour.used, 0)
  assert.equal(r.weekly.used, 40)
  assert.equal(fresh(u({ used: 100, resetsAt: NOW }, w(1)), NOW).fiveHour.used, 0, 'resetsAt === now counts as reset')
  assert.equal(fresh(u({ used: 100, resetsAt: NOW + 1 }, w(1)), NOW).fiveHour.used, 100)
  assert.equal(fresh(u(w(5), { used: 90, resetsAt: NOW - 5 }), NOW).weekly.used, 0)
})

test('fresh: returns a copy, passes null/errored readings through, leaves NO_LIMIT alone', () => {
  const orig = u({ used: 100, resetsAt: NOW - 1 }, w(40))
  const r = fresh(orig, NOW)
  assert.notEqual(r, orig)
  assert.equal(orig.fiveHour.used, 100, 'input is not mutated')
  assert.equal(fresh(null, NOW), null)
  assert.equal(fresh(undefined, NOW), undefined)
  const err = { error: 'Login expired', fiveHour: null, weekly: null }
  assert.deepEqual(fresh(err, NOW), err)
  const nl = fresh(u(NO_LIMIT, w(40)), NOW)
  assert.deepEqual(nl.fiveHour, { used: 0, resetsAt: null, none: true })
  assert.equal(nl.weekly.used, 40)
})

test('rebalance off or absent: an account that is not out stays put', () => {
  assert.deepEqual(decide({ ...base, rebalance: false }), NOT_OUT)
  const { rebalance, ...noFlag } = base
  assert.deepEqual(decide(noFlag), NOT_OUT)
})

test('rebalance: moves to an account whose weekly resets at least 6h earlier', () => {
  assert.deepEqual(decide(base), { action: 'switch', to: 'B', why: 'rebalance' })
})

test('real case: out on 5h; B resets 5h sooner but its week is 7 days away; C week resets in 2 days -> C', () => {
  const d = decide({
    ...base, saved: ['A', 'B', 'C'], rebalance: false,
    activeUsage: u(w(OUT_AT, 4 * H), w(30, 5 * DAY)),
    usage: new Map([
      ['B', u(w(10, 1 * H), w(10, 7 * DAY))],
      ['C', u(w(10, 4 * H), w(10, 2 * DAY))],
    ]),
  })
  assert.deepEqual(d, { action: 'switch', to: 'C', why: 'five_hour' })
})

test('ranking tie-break: equal weekly reset falls to the sooner 5-hour reset', () => {
  const d = decide({
    ...base, rebalance: false, activeUsage: u(w(OUT_AT), w(10, 9 * DAY)),
    usage: new Map([
      ['B', u(w(10, 4 * H), w(10, 2 * DAY))],
      ['C', u(w(10, 1 * H), w(10, 2 * DAY))],
    ]),
  })
  assert.equal(d.to, 'C')
})

test('rebalance returns to the earlier-expiring account once its 5h window has reset (via fresh)', () => {
  const cached = u({ used: 100, resetsAt: NOW - 60e3 }, w(30, 1 * DAY)) // read while out; the window reset since
  const stale = decide(withUsage([['B', cached]]))
  assert.deepEqual(stale, NOT_OUT, 'raw cached reading shows B at 100% on 5h: no move')
  assert.deepEqual(decide(withUsage([['B', fresh(cached, NOW)]])), { action: 'switch', to: 'B', why: 'rebalance' })
})

test('no flip-flop: from the earliest-expiring account there is nothing earlier to move to', () => {
  const b = u(w(10, 2 * H), w(30, 1 * DAY))
  const a = u(w(20, 2 * H), w(30, 5 * DAY))
  assert.equal(decide({ ...base, active: 'A', activeUsage: a, usage: new Map([['B', b]]) }).to, 'B')
  assert.deepEqual(decide({ ...base, active: 'B', activeUsage: b, usage: new Map([['A', a]]) }), NOT_OUT)
})

test('lead threshold: 6h earlier moves, just under 6h does not', () => {
  const act = w(30, 5 * DAY)
  const at = (lead) => decide({ ...base, activeUsage: u(w(20), act), usage: new Map([['B', u(w(10), { used: 30, resetsAt: act.resetsAt - lead })]]) })
  assert.equal(at(REBALANCE_LEAD_MS).action, 'switch')
  assert.deepEqual(at(REBALANCE_LEAD_MS - 1), NOT_OUT)
})

test('active weekly reset unknown while used: no rebalance (an unreadable week is not "never expires")', () => {
  const d = decide({ ...base, activeUsage: u(w(20), { used: 30, resetsAt: null }), usage: new Map([['B', u(w(10), w(30, 30 * DAY))]]) })
  assert.deepEqual(d, NOT_OUT)
})

test('room threshold: 10% weekly left moves, under 10% does not', () => {
  const at = (used) => decide(withUsage([['B', u(w(10), w(used, 1 * DAY))]]))
  assert.equal(at(100 - REBALANCE_MIN_ROOM).action, 'switch')
  assert.deepEqual(at(100 - REBALANCE_MIN_ROOM + 0.5), NOT_OUT)
})

test('5-hour threshold: under 80 moves, at 80 does not', () => {
  const at = (used) => decide(withUsage([['B', u(w(used), w(30, 1 * DAY))]]))
  assert.equal(at(REBALANCE_MAX_FIVE - 1).action, 'switch')
  assert.deepEqual(at(REBALANCE_MAX_FIVE), NOT_OUT)
})

test('only the best-ranked candidate is judged: a worse-ranked one that would qualify is not a fallback', () => {
  // B ranks first (earliest weekly) but has no 5h room; C qualifies on its own but ranks behind B.
  const d = decide(withUsage([
    ['B', u(w(90), w(30, 1 * DAY))],
    ['C', u(w(10), w(30, 2 * DAY))],
  ]))
  assert.deepEqual(d, NOT_OUT)
})

test('a NO_LIMIT candidate counts as 5-hour room', () => {
  assert.deepEqual(decide(withUsage([['B', u(NO_LIMIT, w(30, 1 * DAY))]])), { action: 'switch', to: 'B', why: 'rebalance' })
  const still = decide(withUsage([['B', u(NO_LIMIT, w(95 - 5 + 1, 1 * DAY))]])) // weekly room 4%: still gated on weekly
  assert.deepEqual(still, NOT_OUT)
})

test('candidates that are errored or unavailable are never rebalance targets', () => {
  assert.deepEqual(decide(withUsage([['B', { error: 'Login expired', fiveHour: null, weekly: null }]])), NOT_OUT)
  assert.deepEqual(decide(withUsage([['B', u(w(10), w(96, 1 * DAY))]])), NOT_OUT)
})

test('rebalance never targets the pool, even with no account to move to', () => {
  assert.deepEqual(decide({ ...base, usage: new Map(), poolAvailable: true }), NOT_OUT)
})

test('guards: cooldown, busy, disabled, pool active all suppress a rebalance', () => {
  assert.equal(decide({ ...base, lastAutoAt: NOW - COOLDOWN_MS + 1000 }).why, 'cooldown')
  assert.equal(decide({ ...base, lastAutoAt: NOW - COOLDOWN_MS - 1 }).why, 'rebalance')
  assert.equal(decide({ ...base, busy: true }).why, 'a switch is running')
  assert.equal(decide({ ...base, enabled: false }).why, 'off')
  assert.equal(decide({ ...base, active: 'pool' }).why, 'on the pool')
  for (const d of [{ lastAutoAt: NOW - 1000 }, { busy: true }, { enabled: false }, { active: 'pool' }]) {
    assert.equal(decide({ ...base, ...d }).action, 'none')
  }
})

test('when the active account IS out, rebalance does not change the reason', () => {
  const d = decide({ ...base, activeUsage: u(w(OUT_AT), w(30, 5 * DAY)) })
  assert.deepEqual(d, { action: 'switch', to: 'B', why: 'five_hour' })
})

test('rebalance: never away from an account whose week is unreadable (rate-limited or errored)', () => {
  const usage = new Map([['B', { fiveHour: { used: 5, resetsAt: NOW + 3600e3 }, weekly: { used: 5, resetsAt: NOW + 6.5 * 86400e3 } }]])
  const args = { enabled: true, active: 'A', saved: ['A', 'B'], usage, limitHit: false, busy: false, lastAutoAt: 0, poolAvailable: true, now: NOW, rebalance: true }
  assert.equal(decide({ ...args, activeUsage: { error: 'Anthropic is rate-limiting usage checks' } }).action, 'none')
  assert.equal(decide({ ...args, activeUsage: { fiveHour: { used: 10, resetsAt: NOW + 3600e3 } } }).action, 'none')
  assert.equal(decide({ ...args, activeUsage: { fiveHour: { used: 10, resetsAt: NOW + 3600e3 }, weekly: { used: 40, resetsAt: null } } }).action, 'none')
  // A week not started yet (nothing used, no reset) really has no deadline.
  assert.equal(decide({ ...args, activeUsage: { fiveHour: { used: 0, resetsAt: null }, weekly: { used: 0, resetsAt: null } } }).why, 'rebalance')
})
