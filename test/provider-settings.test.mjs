import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProviderSettings } from '../server/provider-settings.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agv-ps-'))

test('defaults when no file', () => {
  const s = createProviderSettings({ dataDir: tmp() })
  const g = s.get()
  assert.equal(g.defaultProvider, 'claude')
  assert.deepEqual(g.providerOrder, ['claude', 'gemini'])
  assert.equal(g.handoff.mode, 'auto')
  assert.equal(g.handoff.minWaitMs, 1800000)
  assert.deepEqual(g.agentStarts, { enabled: true, perHour: 20, maxDepth: 3 })
})

test('default provider moves to front and persists', () => {
  const dir = tmp()
  const s = createProviderSettings({ dataDir: dir })
  s.set({ defaultProvider: 'gemini' })
  assert.deepEqual(s.order(), ['gemini', 'claude'])
  assert.equal(createProviderSettings({ dataDir: dir }).defaultProvider(), 'gemini')
  assert.equal(fs.statSync(path.join(dir, 'providers.json')).mode & 0o777, 0o600)
})

test('order is deduped and default-first', () => {
  const s = createProviderSettings({ dataDir: tmp() })
  s.set({ providerOrder: ['gemini', 'gemini', 'claude'] })
  assert.deepEqual(s.order(), ['claude', 'gemini'])
  s.set({ defaultProvider: 'gemini', providerOrder: ['claude', 'gemini'] })
  assert.deepEqual(s.order(), ['gemini', 'claude'])
})

test('rejects unknown providers and codex', () => {
  const s = createProviderSettings({ dataDir: tmp() })
  assert.throws(() => s.set({ defaultProvider: 'codex' }), /codex/)
  assert.throws(() => s.set({ providerOrder: ['claude', 'codex'] }), /codex/)
  assert.throws(() => s.set({ defaultProvider: 'nope' }), /unknown/)
  assert.equal(s.defaultProvider(), 'claude')
})

test('validates handoff and agentStarts, merges partial patches', () => {
  const s = createProviderSettings({ dataDir: tmp() })
  assert.throws(() => s.set({ handoff: { mode: 'sometimes' } }))
  assert.throws(() => s.set({ handoff: { minWaitMs: -1 } }))
  assert.throws(() => s.set({ agentStarts: { perHour: 1.5 } }))
  assert.throws(() => s.set({ agentStarts: { enabled: 'yes' } }))
  const r = s.set({ handoff: { mode: 'ask', minWaitMs: 0 }, agentStarts: { enabled: false } })
  assert.equal(r.handoff.mode, 'ask')
  assert.equal(r.handoff.minWaitMs, 0)
  assert.equal(r.handoff.maxHops, 2)
  assert.equal(r.agentStarts.enabled, false)
  assert.equal(r.agentStarts.perHour, 20)
})

test('corrupt or hand-edited file falls back per field', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'providers.json'), '{nope')
  assert.equal(createProviderSettings({ dataDir: dir }).get().defaultProvider, 'claude')
  fs.writeFileSync(path.join(dir, 'providers.json'),
    JSON.stringify({ defaultProvider: 'codex', providerOrder: ['gemini'], handoff: { mode: 'off', minWaitMs: 'x' } }))
  const g = createProviderSettings({ dataDir: dir }).get()
  assert.equal(g.defaultProvider, 'claude')
  assert.equal(g.handoff.mode, 'off')
  assert.equal(g.handoff.minWaitMs, 1800000)
  assert.deepEqual(g.providerOrder, ['claude', 'gemini'])
})
