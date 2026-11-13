import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTasks } from '../server/tasks.mjs'

const DAY = 86400000
const NOW = 1_800_000_000_000
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'tasks-'))
const ag = (id, o = {}) => ({ id, name: id, title: `t-${id}`, lastActivityAt: NOW, ...o })

test('seeds last 3 days, then picks up new agents', async () => {
  const t = createTasks(await tmp())
  await t.sync([ag('new'), ag('old', { lastActivityAt: NOW - 4 * DAY })], NOW)
  let s = await t.load()
  assert.equal(s.installedAt, NOW)
  assert.deepEqual(Object.keys(s.items), ['new'])
  assert.equal(s.items.new.kind, 'agent')
  await t.sync([ag('new'), ag('old', { lastActivityAt: NOW - 4 * DAY }), ag('later', { lastActivityAt: NOW + 5 })], NOW + 10)
  s = await t.load()
  assert.deepEqual(Object.keys(s.items).sort(), ['later', 'new'])
})

test('sub, child, hidden ignored; title refresh; survives agent removal', async () => {
  const dir = await tmp()
  const t = createTasks(dir)
  await t.sync([ag('s', { role: 'sub' }), ag('c', { parentId: 'x' }), ag('h', { hidden: true }), ag('a')], NOW)
  assert.deepEqual(Object.keys((await t.load()).items), ['a'])
  await t.sync([ag('a', { title: 'renamed' })], NOW + 1)
  assert.equal((await t.load()).items.a.title, 'renamed')
  await t.sync([], NOW + 2)
  const fresh = createTasks(dir)
  assert.equal((await fresh.load()).items.a.title, 'renamed')
})

test('done, reopen, rename, prune after 30 days', async () => {
  const t = createTasks(await tmp())
  await t.sync([ag('a')], NOW)
  assert.equal((await t.patch('a', { done: true }, NOW + 1)).doneAt, NOW + 1)
  assert.equal('doneAt' in (await t.patch('a', { reopen: true }, NOW + 2)), false)
  assert.equal((await t.patch('a', { rename: 'Hi' })).rename, 'Hi')
  assert.equal('rename' in (await t.patch('a', { rename: null })), false)
  await t.patch('a', { done: true }, NOW)
  await t.sync([], NOW + 31 * DAY)
  assert.deepEqual((await t.load()).items, {})
})

test('ideas: add, link, delete; agents cannot be deleted', async () => {
  const t = createTasks(await tmp())
  await t.sync([ag('a')], NOW)
  const idea = await t.addIdea('  try X  ', NOW)
  assert.match(idea.id, /^idea-[0-9a-f]+$/)
  assert.equal(idea.text, 'try X')
  assert.equal((await t.patch(idea.id, { agentId: 'a' })).agentId, 'a')
  await assert.rejects(async () => t.patch('a', { delete: true }), { status: 400 })
  await assert.rejects(async () => t.patch('a', { agentId: 'b' }), { status: 400 })
  await t.patch(idea.id, { delete: true })
  assert.equal((await t.load()).items[idea.id], undefined)
})

test('validation', async () => {
  const t = createTasks(await tmp())
  await t.sync([ag('a')], NOW)
  await assert.rejects(async () => t.addIdea('   '), { status: 400 })
  await assert.rejects(async () => t.addIdea('x'.repeat(301)), { status: 400 })
  await assert.rejects(async () => t.patch('a', { bogus: true }), { status: 400 })
  await assert.rejects(async () => t.patch('a', { done: 'yes' }), { status: 400 })
  await assert.rejects(async () => t.patch('a', { rename: '' }), { status: 400 })
  await assert.rejects(async () => t.patch('a', { rename: 'x'.repeat(121) }), { status: 400 })
  await assert.rejects(async () => t.patch('nope', { done: true }), { status: 404 })
  await assert.rejects(async () => t.patch('__proto__', { done: true }), { status: 400 })
})
