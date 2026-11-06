/** Which projects the village shows (web/src/quiet.js, docs/ARCHITECTURE.md). Pure: no DOM, no server. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { visibleProjects, QUIET_MS, QUIET_FALLBACK } from '../web/src/quiet.js'

const NOW = 1_800_000_000_000
const DAY = 24 * 3600e3
const ag = (project, bucket, agoMs) => ({ project, bucket, lastActivityAt: NOW - agoMs })

test('a project shows while any agent is awake or was active inside the window; all or nothing', () => {
  const { shown, quiet } = visibleProjects([
    ag('live', 'building', 5 * DAY), ag('live', 'resting', 9 * DAY), // one awake agent keeps the whole project
    ag('recent', 'resting', QUIET_MS - 60e3),                        // resting, but active within a day
    ag('stalled', 'stalled', 40 * DAY),
    ag('waiting', 'waiting', 40 * DAY),
    ag('old', 'resting', QUIET_MS + 60e3), ag('old', 'resting', 3 * DAY),
    ag('older', 'resting', 30 * DAY),
  ], { now: NOW })
  assert.deepEqual([...shown].sort(), ['live', 'recent', 'stalled', 'waiting'])
  assert.deepEqual(quiet, ['old', 'older']) // most recent first
})

test('the toggle off shows everything; keep forces a project in', () => {
  const agents = [ag('a', 'building', 0), ag('b', 'resting', 5 * DAY)]
  assert.deepEqual([...visibleProjects(agents, { now: NOW, hideQuiet: false }).shown].sort(), ['a', 'b'])
  assert.deepEqual(visibleProjects(agents, { now: NOW, hideQuiet: false }).quiet, [])
  const kept = visibleProjects(agents, { now: NOW, keep: ['b'] })
  assert.deepEqual([...kept.shown].sort(), ['a', 'b'])
  assert.deepEqual(kept.quiet, [])
})

test('never an empty village: with everything quiet, the most recently active few show', () => {
  const agents = ['p1', 'p2', 'p3', 'p4', 'p5'].map((p, i) => ag(p, 'resting', (i + 2) * DAY))
  const { shown, quiet } = visibleProjects(agents, { now: NOW })
  assert.equal(shown.size, QUIET_FALLBACK)
  assert.deepEqual([...shown], ['p1', 'p2', 'p3'])
  assert.deepEqual(quiet, ['p4', 'p5'])
  assert.deepEqual(visibleProjects([], { now: NOW }), { shown: new Set(), quiet: [] })
})

test('agents with no project share one "—" project', () => {
  const { shown } = visibleProjects([{ bucket: 'building', lastActivityAt: NOW }], { now: NOW })
  assert.deepEqual([...shown], ['—'])
})
