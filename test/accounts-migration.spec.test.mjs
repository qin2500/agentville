/** Spec tests for docs/providers-design.md section 2.1: account-registry loadMeta/saveMeta and the one-off migration. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tryLoad } from './support/spec-load.mjs'

// Ids follow account-registry's ID_RE (8-64 chars). The seam is createAccountRegistry({ dataDir }) -> { loadMeta(provider), saveMeta(provider, list) }.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-reg-'))
const lib = await tryLoad('../server/account-registry.mjs')
const mod = lib ? lib.createAccountRegistry({ dataDir }) : null
const opts = mod ? {} : { todo: 'waiting on P2' }
const file = path.join(dataDir, 'accounts.json')
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const legacy = [{ id: 'aaaa0001', label: 'Work', email: 'a@example.com', addedAt: 1 }, { id: 'bbbb0002', label: 'Home', email: 'b@example.com', addedAt: 2 }]

test('rows without provider read as claude; gemini sees none', opts, async () => {
  fs.writeFileSync(file, JSON.stringify(legacy))
  const claude = await mod.loadMeta('claude')
  assert.deepEqual(claude.map((a) => a.id), ['aaaa0001', 'bbbb0002'])
  assert.deepEqual(await mod.loadMeta('gemini'), [])
})

test('first save rewrites with provider:claude and keeps one pre-providers copy', opts, async () => {
  fs.writeFileSync(file, JSON.stringify(legacy))
  fs.rmSync(file + '.pre-providers', { force: true })
  await mod.saveMeta('claude', legacy.map((a) => ({ ...a, label: a.label + '!' })))
  assert.ok(read().every((a) => a.provider === 'claude'))
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.pre-providers', 'utf8')), legacy)
})

test('the pre-providers copy is made once, not overwritten by later saves', opts, async () => {
  fs.writeFileSync(file, JSON.stringify(legacy))
  fs.rmSync(file + '.pre-providers', { force: true })
  await mod.saveMeta('claude', legacy)
  await mod.saveMeta('claude', [legacy[0]])
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.pre-providers', 'utf8')), legacy)
})

test('saving gemini rows keeps claude rows, and the reverse', opts, async () => {
  fs.writeFileSync(file, JSON.stringify(legacy))
  await mod.saveMeta('gemini', [{ id: 'gemini-0001', label: 'G', addedAt: 3 }])
  assert.deepEqual((await mod.loadMeta('claude')).map((a) => a.id), ['aaaa0001', 'bbbb0002'])
  assert.deepEqual((await mod.loadMeta('gemini')).map((a) => a.id), ['gemini-0001'])
  await mod.saveMeta('claude', [legacy[0]])
  assert.deepEqual((await mod.loadMeta('gemini')).map((a) => a.id), ['gemini-0001'])
  assert.deepEqual((await mod.loadMeta('claude')).map((a) => a.id), ['aaaa0001'])
})

test('concurrent saves from both providers do not drop each other', opts, async () => {
  fs.writeFileSync(file, JSON.stringify(legacy))
  await Promise.all([
    mod.saveMeta('claude', [legacy[0], { id: 'cccc0003', label: 'C', addedAt: 4 }]),
    mod.saveMeta('gemini', [{ id: 'gemini-0002', label: 'G2', addedAt: 5 }]),
  ])
  assert.deepEqual((await mod.loadMeta('claude')).map((a) => a.id).sort(), ['aaaa0001', 'cccc0003'])
  assert.deepEqual((await mod.loadMeta('gemini')).map((a) => a.id), ['gemini-0002'])
})

test('saved rows carry their provider on disk', opts, async () => {
  fs.writeFileSync(file, JSON.stringify([]))
  await mod.saveMeta('gemini', [{ id: 'gemini-0009', label: 'G', addedAt: 1 }])
  assert.equal(read().find((a) => a.id === 'gemini-0009').provider, 'gemini')
})
