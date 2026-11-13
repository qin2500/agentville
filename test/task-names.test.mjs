import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTasks } from '../server/tasks.mjs'
import { createTaskNamer } from '../server/task-names.mjs'

const NOW = 1_800_000_000_000
const u = (content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })

async function setup(lines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tnames-'))
  const file = path.join(dir, 't.jsonl')
  await fs.writeFile(file, lines.join('\n') + '\n')
  const tasks = createTasks(dir)
  await tasks.sync([{ id: 'a', name: 'a', title: 'a', lastActivityAt: NOW }], NOW)
  return { tasks, file }
}

test('skips meta/continuation lines and saves cleaned name', async () => {
  const { tasks, file } = await setup([
    u('This session is being continued from x'),
    u('meta text', { isMeta: true }),
    u([{ type: 'tool_result', content: 'zzz' }]),
    u('<system-reminder>hidden</system-reminder>'),
    u([{ type: 'text', text: '<system-reminder>hidden</system-reminder>Fix the sample widget' }]),
  ])
  const seen = []
  const helper = { run: async (p) => { seen.push(p); return '"Fix sample widget."\nextra' } }
  const n = createTaskNamer({ helper, tasks, transcriptFor: async () => file, now: () => NOW })
  n.kick(); await n.idle()
  assert.deepEqual(seen, ['Fix the sample widget'])
  assert.equal((await tasks.load()).items.a.aiName, 'Fix sample widget')
})

test('disabled helper is quiet and does not count tries', async () => {
  const { tasks, file } = await setup([u('Do a thing')])
  let calls = 0
  const helper = { run: async () => { calls++; throw { code: 'disabled' } } }
  const n = createTaskNamer({ helper, tasks, transcriptFor: async () => file, now: () => NOW })
  for (let i = 0; i < 5; i++) { n.kick(); await n.idle() }
  assert.equal(calls, 5)
  assert.equal((await tasks.load()).items.a.aiName, undefined)
})

test('failure backs off 10 minutes, max 3 tries', async () => {
  const { tasks, file } = await setup([u('Do a thing')])
  let calls = 0, t = NOW
  const helper = { run: async () => { calls++; throw new Error('boom') } }
  const n = createTaskNamer({ helper, tasks, transcriptFor: async () => file, now: () => t })
  n.kick(); await n.idle(); assert.equal(calls, 1)
  n.kick(); await n.idle(); assert.equal(calls, 1)
  for (let i = 0; i < 4; i++) { t += 11 * 60000; n.kick(); await n.idle() }
  assert.equal(calls, 3)
})

test('no usable request is skipped without calling helper', async () => {
  const { tasks, file } = await setup([u('This session is being continued ...')])
  let calls = 0
  const n = createTaskNamer({ helper: { run: async () => { calls++; return 'x' } }, tasks, transcriptFor: async () => file, now: () => NOW })
  n.kick(); await n.idle()
  assert.equal(calls, 0)
})
