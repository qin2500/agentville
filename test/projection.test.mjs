import test from 'node:test'
import assert from 'node:assert/strict'
import { project, MIN_SAMPLES } from '../server/projection.mjs'

const NOW = 1_800_000_000_000
const RESET = NOW + 3 * 3600e3
/** One sample a minute, ending now, rising by `perMin` % from `start`. */
const series = (count, start, perMin, resetsAt = RESET) =>
  Array.from({ length: count }, (_, i) => ({ at: NOW - (count - 1 - i) * 60e3, used: start + i * perMin, resetsAt }))

test('rising usage runs out before the reset: extrapolated from the latest reading', () => {
  const p = project(series(20, 40, 0.5), NOW) // 49.5 % now, +30 %/h
  assert.equal(p.state, 'runsOut')
  assert.equal(p.perHour, 30)
  assert.ok(Math.abs(p.at - (NOW + (100 - 49.5) / 0.5 * 60e3)) < 1000)
  assert.equal(p.resetsAt, RESET)
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
  assert.deepEqual(project(series(10, 91, 1), NOW), { state: 'out', resetsAt: RESET })
})
