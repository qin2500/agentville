/** The panel's views (web/src/views.js): the saved 'va.view' migration and the V cycle. Pure: no DOM. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { VIEWS, viewsFrom, nextView } from '../web/src/views.js'

test('the views are Team, Tree and Models; there is no Status or Table', () => {
  assert.deepEqual(VIEWS, ['team', 'tree', 'models'])
})

test('a saved Status or Table view falls back to Team, docked or full', () => {
  assert.deepEqual(viewsFrom({ docked: 'status', full: 'table' }), { docked: 'team', full: 'team' })
  assert.deepEqual(viewsFrom({ docked: 'table', full: 'tree' }), { docked: 'team', full: 'tree' })
  assert.deepEqual(viewsFrom({ docked: 'models', full: 'status' }), { docked: 'models', full: 'team' })
})

test('other saved views are kept; missing, old or junk values get the defaults', () => {
  assert.deepEqual(viewsFrom({ docked: 'tree', full: 'models' }), { docked: 'tree', full: 'models' })
  assert.deepEqual(viewsFrom({ full: 'models' }), { docked: 'team', full: 'models' })
  assert.deepEqual(viewsFrom(undefined), { docked: 'team', full: 'team' })
  assert.deepEqual(viewsFrom(null), { docked: 'team', full: 'team' })
  assert.deepEqual(viewsFrom('iso'), { docked: 'team', full: 'team' }) // the village's old string
  assert.deepEqual(viewsFrom({ docked: 'grid', full: 42 }), { docked: 'team', full: 'team' })
})

test('V cycles Team → Tree → Models → Team and never lands on Status or Table', () => {
  assert.equal(nextView('team'), 'tree')
  assert.equal(nextView('tree'), 'models')
  assert.equal(nextView('models'), 'team')
  assert.equal(nextView('status'), 'team') // a stale value still moves on to a real view
  assert.equal(nextView('table'), 'team')
})
