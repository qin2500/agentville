// UI behaviour for agent notices (spec items 7 and 8), through the pure helpers in web/src/ui.js.
// The page-level behaviour (clear on click, no clear on hover or poll) is also covered headless by e2e/notify-ui.spec.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} })
const { BUCKETS, byDisplayRank, clearNotice, displayState, hasNotice } = await import('../web/src/ui.js')

const notice = { message: 'Deploy finished', title: '', at: 1, count: 1 }
const agent = (id, bucket, n = null) => ({ id, bucket, notice: n })

test('an agent with a non-null notice sorts above stalled agents', () => {
  const list = [agent('s', 'stalled'), agent('n', 'resting', notice)].sort(byDisplayRank)
  assert.deepEqual(list.map(a => a.id), ['n', 's'])
})

test('a notice beats every other state', () => {
  const list = [...BUCKETS.map(b => agent(b, b)), agent('n', 'building', notice)].sort(byDisplayRank)
  assert.equal(list[0].id, 'n')
  assert.equal(displayState(list[0]), 'notice')
})

test('the notice colour differs from every other state colour', () => {
  const css = fs.readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
  const token = name => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]?.toLowerCase()
  const n = token('notice')
  assert.ok(n, '--notice is defined')
  for (const other of ['stalled', 'error', 'prompt', 'waiting', 'building', 'resting']) assert.notEqual(token(other), n, other)
})

test('a notice leaves the real bucket unchanged', () => {
  const a = agent('x', 'stalled', notice)
  assert.equal(displayState(a), 'notice')
  assert.equal(a.bucket, 'stalled')
})

test('an agent whose notice is null shows its normal state', () => {
  const a = agent('x', 'building')
  assert.equal(hasNotice(a), false)
  assert.equal(displayState(a), 'building')
})

test('clearing posts /api/notify/clear with the agent id', async () => {
  const calls = []
  const ok = await clearNotice('claude-code:abc', async (url, init) => { calls.push({ url, init }); return { ok: true } })
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.match(String(calls[0].url), /\/api\/notify\/clear$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'claude-code:abc' })
})

test('a failed clear returns false and never throws', async () => {
  assert.equal(await clearNotice('x', async () => { throw new Error('down') }), false)
})

test.todo('hovering an agent does not clear its notice (page-level; see e2e/notify-ui.spec.mjs)')
test.todo('a passive refresh of /api/agents does not clear its notice (page-level; see e2e/notify-ui.spec.mjs)')
