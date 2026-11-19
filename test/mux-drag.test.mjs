// Drag-to-rearrange in the terminal view: the pure reorder (mux-model.js swap).
import test from 'node:test'
import assert from 'node:assert/strict'
import * as M from '../web/src/mux-model.js'

const abc = () => M.insert(M.insert(M.leaf('A'), 'A', 'B', 'right'), 'B', 'C', 'bottom') // A | (B over C)

test('swap: two panes trade places, shape and ratios stay', () => {
  const t = M.resize(abc(), '', 0.3)
  const s = M.swap(t, 'A', 'C')
  assert.deepEqual(M.leaves(s), ['C', 'B', 'A'])
  assert.equal(s.ratio, 0.3)
  assert.equal(s.dir, 'row'); assert.equal(s.b.dir, 'column')
})
test('swap is symmetric and an involution', () => {
  const t = abc()
  assert.deepEqual(M.swap(t, 'A', 'B'), M.swap(t, 'B', 'A'))
  assert.deepEqual(M.swap(M.swap(t, 'A', 'B'), 'A', 'B'), t)
})
test('swap: same id, unknown id or empty tree change nothing', () => {
  const t = abc()
  assert.equal(M.swap(t, 'A', 'A'), t)
  assert.equal(M.swap(t, 'A', 'Z'), t)
  assert.equal(M.swap(t, 'Z', 'A'), t)
  assert.equal(M.swap(null, 'A', 'B'), null)
})
test('swap leaves its input alone, keeps every agent once, and the result still parses', () => {
  const t = abc(), before = JSON.stringify(t)
  const s = M.swap(t, 'B', 'C')
  assert.equal(JSON.stringify(t), before)
  assert.deepEqual(M.leaves(s).sort(), ['A', 'B', 'C'])
  assert.deepEqual(M.parse(JSON.parse(M.serialize(s))), s)
})
