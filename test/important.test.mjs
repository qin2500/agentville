/** Important agents are never folded away automatically (web/src/important.js and its users). Pure. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pinned, folds, stoppedNote } from '../web/src/important.js'
import { buildTree, SOLO_KEY, groupKey } from '../web/src/tree-model.js'
import { visibleProjects, QUIET_MS } from '../web/src/quiet.js'

const ag = (id, o = {}) => ({ id, name: o.name || id, role: 'solo', bucket: 'building', project: 'alpha', parentId: null, live: true, ...o })
const ids = (nodes) => nodes.map((n) => n.id)

test('pinned: Important and not hidden; an explicit hide wins', () => {
  assert.equal(pinned(ag('a', { important: true })), true)
  assert.equal(pinned(ag('a', { important: true, hidden: true })), false)
  assert.equal(pinned(ag('a')), false)
  assert.equal(pinned(null), false)
})

test('folds: resting agents fold unless Important; unmarking restores folding', () => {
  const a = ag('a', { bucket: 'resting', important: true })
  assert.equal(folds(a), false)
  assert.equal(folds({ ...a, important: false }), true)
  assert.equal(folds({ ...a, hidden: true }), true)
  assert.equal(folds(ag('b')), false)
})

test('stoppedNote: only for a pinned agent that is not running', () => {
  assert.equal(stoppedNote(ag('a', { important: true, live: false, bucket: 'resting', reason: 'Closed' })), 'Stopped · Closed')
  assert.equal(stoppedNote(ag('a', { important: true, live: false, bucket: 'resting', reason: 'Stopped' })), 'Stopped')
  assert.equal(stoppedNote(ag('a', { important: true, live: false, reason: '' })), 'Stopped')
  assert.equal(stoppedNote(ag('a', { important: true, live: true, reason: 'Closed' })), '')
  assert.equal(stoppedNote(ag('a', { live: false, reason: 'Closed' })), '')
  assert.equal(stoppedNote(ag('a', { important: true, hidden: true, live: false, reason: 'Closed' })), '')
})

test('Tree: an Important resting report is not behind its parent\'s "+N resting" pill', () => {
  const agents = [
    ag('lead', { role: 'lead' }),
    ag('r1', { role: 'sub', parentId: 'lead', bucket: 'resting' }),
    ag('imp', { role: 'sub', parentId: 'lead', bucket: 'resting', important: true, live: false }),
  ]
  const m = buildTree(agents)
  const lead = m.nodes.get('lead')
  assert.deepEqual(ids(lead.kids), ['imp'])
  assert.equal(lead.pill.n, 1)
  // Unmarked, it folds with the other one.
  const m2 = buildTree(agents.map((a) => ({ ...a, important: false })))
  assert.deepEqual(ids(m2.nodes.get('lead').kids), [])
  assert.equal(m2.nodes.get('lead').pill.n, 2)
})

test('Tree: an Important resting member keeps its whole resting team out of the project pill', () => {
  const m = buildTree([
    ag('old', { role: 'lead', bucket: 'resting' }),
    ag('deep', { role: 'sub', parentId: 'old', bucket: 'resting', important: true }),
    ag('quiet', { role: 'lead', bucket: 'resting' }), ag('q1', { role: 'sub', parentId: 'quiet', bucket: 'resting' }),
  ])
  const g = m.groups.find((x) => x.key === groupKey('alpha'))
  assert.deepEqual(ids(g.roots), ['old'])
  assert.deepEqual(ids(m.nodes.get('old').kids), ['deep'])
  assert.equal(g.pill.teams, 1)
})

test('Tree: an Important resting solo stays out of the Solo pill; a hidden one does not', () => {
  const m = buildTree([ag('s1', { bucket: 'resting' }), ag('s2', { bucket: 'resting', important: true }), ag('s3')])
  const solo = m.groups.find((g) => g.key === SOLO_KEY)
  assert.deepEqual(ids(solo.roots).sort(), ['s2', 's3'])
  assert.equal(solo.pill.n, 1)
  const m2 = buildTree([ag('s1', { bucket: 'resting' }), ag('s2', { bucket: 'resting', important: true, hidden: true }), ag('s3')])
  assert.deepEqual(ids(m2.groups.find((g) => g.key === SOLO_KEY).roots), ['s3'])
})

test('Village: a quiet project with an Important agent still shows', () => {
  const now = 10 * QUIET_MS
  const old = now - 3 * QUIET_MS
  const agents = [
    ag('a', { project: 'busy' }),
    ag('b', { project: 'kept', bucket: 'resting', lastActivityAt: old, important: true }),
    ag('c', { project: 'gone', bucket: 'resting', lastActivityAt: old }),
  ]
  const v = visibleProjects(agents, { now })
  assert.deepEqual([...v.shown].sort(), ['busy', 'kept'])
  assert.deepEqual(v.quiet, ['gone'])
  const v2 = visibleProjects(agents.map((a) => ({ ...a, important: false })), { now })
  assert.deepEqual([...v2.shown], ['busy'])
})
