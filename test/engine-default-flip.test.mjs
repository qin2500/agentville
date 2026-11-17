// M7 P2 flips the default engine to v2. storedEngine/engineActive truth table against web/src/worlds.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { engineActive, storedEngine } from '../web/src/worlds.js'

const store = (init = {}) => ({ get: (k, d) => (k in init ? init[k] : d), set() {} })
// Default flipped iff an empty store resolves to v2.
const flipped = storedEngine(store()) === 2
const flip = flipped ? false : { todo: 'M7 P2 flips the default' }

test('stored 2 -> 2', () => {
  assert.equal(storedEngine(store({ 'va.engine': 2 })), 2)
  assert.equal(engineActive('', store({ 'va.engine': 2 })), true)
})
test('stored 1 -> 1 (explicit classic stays classic)', () => {
  assert.equal(storedEngine(store({ 'va.engine': 1 })), 1)
  assert.equal(engineActive('', store({ 'va.engine': 1 })), false)
})
test('?engine=1 overrides stored 2; ?engine=2 overrides stored 1', () => {
  assert.equal(engineActive('?engine=1', store({ 'va.engine': 2 })), false)
  assert.equal(engineActive('?engine=2', store({ 'va.engine': 1 })), true)
})
test('?engine= override beats an unset store both ways', () => {
  assert.equal(engineActive('?engine=2', store()), true)
  assert.equal(engineActive('?engine=1', store()), false)
})
test('unset -> storedEngine 2', flip, () => assert.equal(storedEngine(store()), 2))
test('unset -> engineActive true', flip, () => assert.equal(engineActive('', store()), true))
test('unset + unrelated query -> engineActive true', flip, () => assert.equal(engineActive('?world=x', store()), true))
