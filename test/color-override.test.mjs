import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore, COLOR_NAMES } from '../server/overrides.mjs'
import { build } from '../server/classify.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-color-ov-'))
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
const fact = { id: 'a', harness: 'claude-code', kind: 'session', name: 'A', cwd: '/w', lastActivityAt: Date.now() - 1000, color: 'red' }

test('color override: all 8 names accepted, anything else is a 400', async () => {
  const store = createStore(dir)
  for (const c of COLOR_NAMES) assert.deepEqual(await store.patch('a', { color: c }), { color: c })
  for (const bad of ['mauve', 'Red', '', 3, true, {}]) {
    assert.throws(() => store.patch('a', { color: bad }), (e) => e.status === 400)
  }
})

test('color override wins over the transcript colour; null clears back to it', async () => {
  const store = createStore(dir)
  await store.patch('a', { color: 'blue' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'overrides.json'), 'utf8')).a.color, 'blue')
  let a = build([fact], await store.load()).find((x) => x.id === 'a')
  assert.equal(a.color, 'blue')
  await store.patch('a', { color: null })
  a = build([fact], await store.load()).find((x) => x.id === 'a')
  assert.equal(a.color, 'red')
  assert.equal(a.overrides, null)
})
