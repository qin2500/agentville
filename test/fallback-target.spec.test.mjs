/** Spec tests for docs/providers-design.md section 3.3: fallbackTarget(from, settings, state). Waiting on P13. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tryLoad } from './support/spec-load.mjs'

const mod = await tryLoad('../server/provider-switch.mjs')
const opts = mod ? {} : { todo: 'waiting on P13' }
const fb = (...a) => mod.fallbackTarget(...a)
const U = { usable: true }, N = { usable: false, why: 'out' }

test('non-default provider out hands to the default when usable', opts, () => {
  assert.equal(fb('gemini', { defaultProvider: 'claude', providerOrder: ['claude', 'gemini'] }, { claude: U, gemini: N }), 'claude')
})
test('default provider out hands to the next in order', opts, () => {
  assert.equal(fb('claude', { defaultProvider: 'claude', providerOrder: ['claude', 'gemini'] }, { claude: N, gemini: U }), 'gemini')
})
test('default is tried first even if providerOrder lists it later', opts, () => {
  assert.equal(fb('x', { defaultProvider: 'gemini', providerOrder: ['claude', 'gemini'] }, { claude: U, gemini: U }), 'gemini')
})
test('the source provider is never its own target', opts, () => {
  assert.equal(fb('claude', { defaultProvider: 'claude', providerOrder: ['claude', 'gemini'] }, { claude: U, gemini: N }), null)
})
test('no usable provider gives null', opts, () => {
  assert.equal(fb('claude', { defaultProvider: 'claude', providerOrder: ['claude', 'gemini'] }, { claude: N, gemini: N }), null)
})
test('a provider missing from state is not usable', opts, () => {
  assert.equal(fb('claude', { defaultProvider: 'claude', providerOrder: ['claude', 'gemini'] }, { claude: N }), null)
})
test('codex is never a target unless state says usable (state never marks it so)', opts, () => {
  assert.equal(fb('claude', { defaultProvider: 'claude', providerOrder: ['claude', 'codex', 'gemini'] }, { claude: N, codex: N, gemini: U }), 'gemini')
})
test('order after default follows providerOrder, skipping unusable', opts, () => {
  const s = { defaultProvider: 'claude', providerOrder: ['claude', 'a', 'b', 'c'] }
  assert.equal(fb('claude', s, { a: N, b: U, c: U }), 'b')
})
test('is pure: does not mutate its inputs', opts, () => {
  const s = { defaultProvider: 'claude', providerOrder: ['claude', 'gemini'] }
  const st = { claude: N, gemini: U }
  const snap = JSON.stringify([s, st])
  fb('claude', s, st)
  assert.equal(JSON.stringify([s, st]), snap)
})
