import test from 'node:test'
import assert from 'node:assert/strict'
import { project, projectWeekly, weeklyPerFive, flatOut, binding, MIN_SAMPLES, RATIO_PRIOR, RATIO_MIN, RATIO_MAX } from '../server/projection.mjs'

const NOW = 1_800_000_000_000
const RESET = NOW + 3 * 3600e3
/** One sample a minute, ending now, rising by `perMin` % from `start`. */
const series = (count, start, perMin, resetsAt = RESET) =>
  Array.from({ length: count }, (_, i) => ({ at: NOW - (count - 1 - i) * 60e3, used: start + i * perMin, resetsAt }))

test('rising usage runs out before the reset: extrapolated from the latest reading', () => {
  // 49.5 % now at +30 %/h, in a window that started 99 min ago: recent and average agree.
  const reset = NOW - 99 * 60e3 + 5 * 3600e3
  const p = project(series(20, 40, 0.5, reset), NOW)
  assert.equal(p.state, 'runsOut')
  assert.deepEqual([p.perHour, p.perHourRecent, p.perHourAvg], [30, 30, 30])
  assert.ok(Math.abs(p.at - (NOW + (100 - 49.5) / 0.5 * 60e3)) < 1000)
  assert.equal(p.resetsAt, reset)
  // Without a reset time there is no window average: the recent pace alone.
  const q = project(series(20, 40, 0.5, null), NOW)
  assert.deepEqual([q.perHour, q.perHourAvg], [30, null])
})

test('the pace blends the recent rate with the average since the window started', () => {
  // 30 min at +60 %/h after a quiet start: 49.5 % used, 2 h into the window (average ≈ 25 %/h).
  const p = project(series(31, 19.5, 1), NOW)
  assert.equal(p.perHourRecent, 60)
  assert.equal(p.perHourAvg, 24.8)
  assert.equal(p.perHour, Math.round((60 + 24.75) / 2 * 10) / 10)
})

test('slow enough to last until the reset', () => {
  const p = project(series(20, 10, 0.05), NOW) // +3 %/h, 100 % far beyond the reset
  assert.deepEqual([p.state, p.resetsAt], ['lasts', RESET])
})

test('flat or falling usage lasts', () => {
  assert.equal(project(series(20, 30, 0), NOW).state, 'lasts')
  assert.equal(project(series(20, 30, 0.001), NOW).state, 'lasts', 'under the flat threshold')
})

test('too few samples, or too short a span, is "gathering"', () => {
  assert.equal(project([], NOW).state, 'gathering')
  assert.equal(project(series(MIN_SAMPLES - 1, 10, 1), NOW).state, 'gathering')
  const quick = [0, 1, 2, 3].map((i) => ({ at: NOW - (3 - i) * 30e3, used: 10 + i, resetsAt: RESET })) // 1.5 min span
  assert.equal(project(quick, NOW).state, 'gathering')
  const old = series(20, 10, 1).map((s) => ({ ...s, at: s.at - 3600e3 })) // all older than the fit window
  assert.equal(project(old, NOW).state, 'gathering')
})

test('a reset in the samples starts the fit over; at 100 % it is out', () => {
  const before = series(10, 80, 1, NOW - 60e3).map((s) => ({ ...s, at: s.at - 12 * 60e3 }))
  const after = series(4, 1, 0.1) // 4 samples after the reset: too short a span to project yet
  assert.equal(project([...before, ...after], NOW).state, 'gathering')
  assert.deepEqual(project(series(10, 91, 1), NOW), { state: 'out', resetsAt: RESET, perHourAvg: 50 })
})

// ---------- steadiness: whole-percent readings, a single burst, a sustained one ----------
const T0 = 1_800_000_000_000 // a 5-hour window starts here
const WIN = T0 + 5 * 3600e3
/** One whole-percent reading a minute from the window start to minute `to`; `usage(m)` is the true %. */
const readings = (usage, to) => Array.from({ length: to + 1 }, (_, m) => ({ at: T0 + m * 60e3, used: Math.floor(usage(m)), resetsAt: WIN }))
/** project() as it would have run at each minute from..to. */
const replay = (usage, from, to) => {
  const all = readings(usage, to)
  return Array.from({ length: to - from + 1 }, (_, i) => { const m = from + i; return { m, ...project(all.slice(0, m + 1), T0 + m * 60e3) } })
}

test('a single 1 % step does not swing the pace (slow, whole-percent usage)', () => {
  // +2 %/h: the reading steps up once every 30 min. The old 30-min line read up to 2.9 %/h here.
  const ps = replay((m) => (2 * m) / 60, 60, 180).map((p) => p.perHour)
  assert.ok(Math.max(...ps) <= 2.2, `max ${Math.max(...ps)}`)
  assert.ok(Math.min(...ps) >= 0.5, `min ${Math.min(...ps)}`)
})

test('steady usage reads steady through the whole-percent steps', () => {
  const ps = replay((m) => (20 * m) / 60, 60, 120).map((p) => p.perHour)
  assert.ok(Math.max(...ps) - Math.min(...ps) < 1.5, ps.join(' '))
})

test('a single burst moves the pace less than the recent rate alone, and fades', () => {
  // +30 %/h, with one 5 % jump at minute 90.
  const rows = replay((m) => (30 * m) / 60 + (m >= 90 ? 5 : 0), 85, 125)
  const peak = Math.max(...rows.map((p) => p.perHour)), peakRecent = Math.max(...rows.map((p) => p.perHourRecent))
  assert.ok(peak < 40, `peak ${peak}`) // the old 30-min line peaked at 44.5
  assert.ok(peak < peakRecent)
  assert.ok(rows.at(-1).perHour < 32, `back to ≈ 30 after 35 min: ${rows.at(-1).perHour}`)
})

test('a sustained burst moves the projection within a few minutes', () => {
  // +30 %/h for 90 min, then +120 %/h.
  const rows = replay((m) => (m <= 90 ? (30 * m) / 60 : 45 + (120 * (m - 90)) / 60), 90, 96)
  const before = rows[0], after5 = rows.find((p) => p.m === 95)
  assert.ok(after5.perHour >= before.perHour * 1.25, `${before.perHour} -> ${after5.perHour}`)
  assert.ok(before.at - after5.at > 30 * 60e3, 'the run-out comes at least 30 min sooner')
})

// ---------- weekly: respects the 5-hour cap ----------
const at = (s) => new Date(s).getTime() // local time, as the dashboard shows it

/** The live case of 2026-11-10 17:27: 5-hour 62 % (window from 16:30, a burst in the last 30 min), weekly 17 %. */
function liveCase() {
  const now = at('2026-11-10T17:27:00'), r5 = at('2026-11-10T21:30:00'), rw = at('2026-11-16T12:00:00')
  const list = []
  for (let m = 57; m >= 0; m--) {
    const el = 57 - m, five = el <= 27 ? (el * 5) / 27 : 5 + ((el - 27) * 57) / 30
    list.push({ at: now - m * 60e3, five: { used: Math.floor(five), resetsAt: r5 }, week: { used: Math.floor(2.5 + five * 0.26), resetsAt: rw } })
  }
  const fiveHour = { used: 62, ...project(list.map((s) => ({ at: s.at, ...s.five })), now) }
  const weekly = projectWeekly({ week: { used: 17, resetsAt: rw }, five: fiveHour, ratio: weeklyPerFive(list), now })
  return { now, r5, rw, list, fiveHour, weekly }
}

test('live case: the 5-hour pace is the blend, not the 30-min burst', () => {
  const { fiveHour } = liveCase()
  assert.equal(fiveHour.state, 'runsOut')
  assert.ok(fiveHour.perHourRecent > 110 && fiveHour.perHourAvg > 60 && fiveHour.perHourAvg < 70)
  assert.ok(fiveHour.perHour > 85 && fiveHour.perHour < 95, `${fiveHour.perHour}`)
  const t = new Date(fiveHour.at)
  assert.deepEqual([t.getHours(), t.getMinutes() >= 48 && t.getMinutes() <= 56], [17, true], t.toString())
})

test('live case: the week cannot run out at 20:12 today; flat out it is Wednesday morning', () => {
  const { weekly, r5, rw, fiveHour } = liveCase()
  assert.equal(weekly.basis, 'flatOut')
  assert.equal(weekly.ratioFrom, 'samples')
  assert.ok(Math.abs(weekly.ratio - 0.26) < 0.02, `${weekly.ratio}`)
  assert.equal(weekly.state, 'runsOut')
  assert.ok(weekly.at > r5, 'not before the 5-hour reset (the old line said 20:12 today)')
  const t = new Date(weekly.at)
  assert.deepEqual([t.toDateString(), t.getHours() >= 6 && t.getHours() < 11], [new Date(at('2026-11-11T12:00:00')).toDateString(), true], t.toString())
  // By the 21:30 reset the week reaches only ≈ 27 %: 17 + (100 − 62)·r.
  assert.ok(Math.abs(17 + 38 * weekly.ratio - 27) < 1)
  // At the week's own average (17 % in 29.5 h) it lasts until the reset.
  assert.deepEqual([weekly.average.state, weekly.average.perHour], ['lasts', 0.6])
  assert.ok(rw > weekly.at)
  assert.deepEqual(binding(fiveHour, weekly), { window: 'fiveHour', state: 'runsOut', at: fiveHour.at })
})

test('weekly per 5-hour ratio: measured, with a default and clamps', () => {
  const s = (pairs) => pairs.map(([five, week], i) => ({ at: i * 60e3, five: { used: five }, week: { used: week } }))
  assert.deepEqual(weeklyPerFive(s([[10, 5], [20, 7], [30, 10]])), { ratio: 0.25, from: 'samples' })
  assert.deepEqual(weeklyPerFive([]), { ratio: RATIO_PRIOR, from: 'default' })
  assert.deepEqual(weeklyPerFive(s([[10, 5], [10, 6], [10, 7]])), { ratio: RATIO_PRIOR, from: 'default' }, '5-hour flat: no ratio to measure')
  assert.deepEqual(weeklyPerFive(s([[10, 5], [15, 6], [19, 7]])), { ratio: RATIO_PRIOR, from: 'default' }, 'too little 5-hour movement: noisy')
  assert.deepEqual(weeklyPerFive(s([[0, 5], [40, 5]])), { ratio: RATIO_MIN, from: 'samples' }, 'weekly flat: clamped up')
  assert.deepEqual(weeklyPerFive(s([[0, 5], [20, 45]])), { ratio: RATIO_MAX, from: 'samples' }, 'clamped down')
  // A 5-hour reset in the middle is skipped, not counted as a fall.
  assert.deepEqual(weeklyPerFive(s([[80, 20], [95, 24], [0, 24], [10, 26]])), { ratio: 0.24, from: 'samples' })
  // The default is what the weekly projection uses when nothing is measured.
  const w = projectWeekly({ week: { used: 10, resetsAt: NOW + 6 * 86400e3 }, five: { used: 0, resetsAt: NOW + 5 * 3600e3, perHour: 50, state: 'lasts' }, now: NOW })
  assert.deepEqual([w.ratio, w.ratioFrom], [RATIO_PRIOR, 'default'])
})

test('weekly lasts when even flat out it reaches 100 % only after its reset', () => {
  // 50 % used, resets in 5.5 h: this window adds 25 %, the next starts at +5 h and has 30 min (≈ 12.5 %).
  const five = { used: 0, resetsAt: NOW + 5 * 3600e3, perHour: 100, state: 'lasts' }
  const w = projectWeekly({ week: { used: 50, resetsAt: NOW + 5.5 * 3600e3 }, five, ratio: { ratio: 0.25, from: 'samples' }, now: NOW })
  assert.equal(w.state, 'lasts')
  // With a later reset it runs out one hour into the next window (+6 h).
  const w2 = projectWeekly({ week: { used: 50, resetsAt: NOW + 48 * 3600e3 }, five, ratio: { ratio: 0.25, from: 'samples' }, now: NOW })
  assert.deepEqual([w2.state, w2.at], ['runsOut', NOW + 6 * 3600e3])
  assert.equal(w2.perHour, 25)
})

test('flat out: a 5-hour window already full waits for its reset', () => {
  const f = flatOut({ weekUsed: 90, weekResetsAt: NOW + 86400e3, fiveUsed: 100, fiveResetsAt: NOW + 2 * 3600e3, pace: 50, ratio: 0.2, now: NOW })
  assert.deepEqual(f, { state: 'runsOut', at: NOW + 3 * 3600e3 }) // reset at +2 h, then 10 % at 10 %/h
  // A weekly reset sooner than the 5-hour one, under the cap: plain extrapolation (here 30 min).
  assert.deepEqual(flatOut({ weekUsed: 95, weekResetsAt: NOW + 3600e3, fiveUsed: 0, fiveResetsAt: NOW + 3 * 3600e3, pace: 50, ratio: 0.2, now: NOW }), { state: 'runsOut', at: NOW + 1800e3 })
})

test('weekly: gathering until the 5-hour pace is known, out at 100 %, own samples with no 5-hour limit', () => {
  const week = { used: 30, resetsAt: NOW + 86400e3 }
  assert.equal(projectWeekly({ week, five: { used: 5, resetsAt: NOW + 3600e3, state: 'gathering' }, now: NOW }).state, 'gathering')
  assert.equal(projectWeekly({ week: { ...week, used: 100 }, five: { state: 'gathering' }, now: NOW }).state, 'out')
  const samples = series(20, 20, 0.5, NOW + 86400e3) // weekly +30 %/h on its own
  const w = projectWeekly({ week: { used: 29.5, resetsAt: NOW + 86400e3 }, five: { none: true }, samples, now: NOW })
  assert.deepEqual([w.basis, w.state], ['samples', 'runsOut'])
})

test('header: the window that binds first', () => {
  const five = (o) => ({ resetsAt: NOW + 3 * 3600e3, ...o })
  // 5-hour first.
  assert.deepEqual(binding(five({ state: 'runsOut', at: NOW + 3600e3 }), { state: 'runsOut', at: NOW + 86400e3 }), { window: 'fiveHour', state: 'runsOut', at: NOW + 3600e3 })
  // The week before the 5-hour run-out.
  assert.deepEqual(binding(five({ state: 'runsOut', at: NOW + 3600e3 }), { state: 'runsOut', at: NOW + 1800e3 }), { window: 'weekly', state: 'runsOut', at: NOW + 1800e3 })
  // The 5-hour window lasts, but the week runs out before its reset.
  assert.deepEqual(binding(five({ state: 'lasts' }), { state: 'runsOut', at: NOW + 2 * 3600e3 }), { window: 'weekly', state: 'runsOut', at: NOW + 2 * 3600e3 })
  // … or only after it: nothing in the header.
  assert.equal(binding(five({ state: 'lasts' }), { state: 'runsOut', at: NOW + 4 * 3600e3 }), null)
  assert.equal(binding(five({ state: 'gathering' }), { state: 'gathering' }), null)
  // Out of usage.
  assert.deepEqual(binding(five({ state: 'out' }), { state: 'lasts' }), { window: 'fiveHour', state: 'out' })
  assert.deepEqual(binding(five({ state: 'out' }), { state: 'out' }), { window: 'weekly', state: 'out' })
  // No 5-hour limit: the week whenever it runs out.
  assert.deepEqual(binding({ none: true, state: 'none' }, { state: 'runsOut', at: NOW + 9 * 3600e3 }), { window: 'weekly', state: 'runsOut', at: NOW + 9 * 3600e3 })
})
