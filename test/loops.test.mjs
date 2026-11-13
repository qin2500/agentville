import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLoops } from '../server/loops.mjs'

const DAY = 86400000
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'loops-'))
const NOW = 1_800_000_000_000

test('seen, done, snooze, reopen', async () => {
  const dir = await tmp()
  const l = createLoops(dir)
  assert.deepEqual(await l.patch('a', { seen: true }, NOW), { seenAt: NOW })
  await l.patch('a', { snoozeUntil: NOW + DAY }, NOW)
  assert.equal((await l.load()).a.snoozeUntil, NOW + DAY)
  assert.deepEqual(await l.patch('a', { done: true }, NOW + 5), { seenAt: NOW + 5, doneAt: NOW + 5 })
  assert.deepEqual(await l.patch('a', { reopen: true }, NOW + 6), { seenAt: NOW + 5 })
  await l.patch('a', { snoozeUntil: NOW + 2 * DAY }, NOW)
  assert.deepEqual(await l.patch('a', { snoozeUntil: null }, NOW), { seenAt: NOW + 5 })
  const again = createLoops(dir)
  assert.deepEqual((await again.load()).a, { seenAt: NOW + 5 })
})

test('validation', async () => {
  const l = createLoops(await tmp())
  const status = async (id, body) => { try { await l.patch(id, body, NOW); return 200 } catch (e) { return e.status } }
  assert.equal(await status('a', { nope: 1 }), 400)
  assert.equal(await status('a', { seen: false }), 400)
  assert.equal(await status('a', { snoozeUntil: NOW - 1 }), 400)
  assert.equal(await status('a', { snoozeUntil: NOW + 31 * DAY }), 400)
  assert.equal(await status('a', { snoozeUntil: NaN }), 400)
  assert.equal(await status('a', []), 400)
  assert.equal(await status('__proto__', { seen: true }), 400)
  assert.equal(await status('', { seen: true }), 400)
})

test('prunes entries older than 14 days', async () => {
  const dir = await tmp()
  const l = createLoops(dir)
  await l.patch('old', { seen: true }, NOW)
  await l.patch('new', { seen: true }, NOW + 15 * DAY)
  assert.deepEqual(Object.keys(await l.load()), ['new'])
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'loops.json'), 'utf8'))
  assert.deepEqual(Object.keys(onDisk), ['new'])
})
