import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeBin } from './support/posix.mjs'
import { createGeminiAccounts, parseUsage, readAgyUsage, USAGE_CACHE_MS } from '../server/gemini/accounts.mjs'
import { nextQuotaReset, RETRY_MS } from '../server/gemini/limits.mjs'

const bucket = (id, window, frac, reset) => ({ id, name: window, window, remaining_fraction: frac, reset_time: reset })
const JSON_OUT = (g5 = 0.979973316192627, gw = 0.9871736764907837) => JSON.stringify({
  conversation_id: '', status: 'SUCCESS', response: 'x', command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [bucket('gemini-weekly', 'weekly', gw, '2026-12-01T20:24:11Z'), bucket('gemini-5h', '5h', g5, '2026-11-25T01:24:11Z')] },
    { name: 'Claude and GPT models', buckets: [bucket('3p-weekly', 'weekly', 1, '2026-12-01T20:27:16Z'), bucket('3p-5h', '5h', 1, '2026-11-25T01:27:16Z')] },
  ] } } })

test('parseUsage: Gemini group is the main reading, others go to extra', () => {
  const u = parseUsage(JSON_OUT())
  assert.deepEqual(u.fiveHour, { used: 2, resetsAt: Date.parse('2026-11-25T01:24:11Z') })
  assert.deepEqual(u.weekly, { used: 1, resetsAt: Date.parse('2026-12-01T20:24:11Z') })
  assert.equal(u.extra.length, 1)
  assert.equal(u.extra[0].name, 'Claude and GPT models')
  assert.equal(u.extra[0].fiveHour.used, 0)
})
test('parseUsage: group matched by bucket id prefix, a 0 fraction marks the window out, junk gives null', () => {
  const j = { command: { data: { groups: [{ name: 'Renamed', buckets: [bucket('gemini-5h', '5h', 0, '2026-11-25T01:24:11Z')] }] } } }
  const u = parseUsage(JSON.stringify(j))
  assert.deepEqual(u.fiveHour, { used: 100, resetsAt: Date.parse('2026-11-25T01:24:11Z'), out: true })
  assert.equal(u.weekly, null)
  assert.equal(parseUsage('not json'), null)
  assert.equal(parseUsage('{"command":{"data":{"groups":[]}}}'), null)
})

const mk = async (usageReader, nowRef = { t: 1_000_000 }) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agv-agy-usage-'))
  const g = createGeminiAccounts({ dataDir, bin: async () => '/opt/bin/agy', probe: async () => ({ ok: true }), usageReader, now: () => nowRef.t })
  await g.accounts.addFinish({})
  return { g, nowRef }
}

test('usage() returns the Claude-shaped reading, cached for 5 minutes', async () => {
  let calls = 0
  const { g, nowRef } = await mk(async () => { calls++; return { ok: true, usage: parseUsage(JSON_OUT()) } })
  const r = (await g.accounts.usage()).accounts[0]
  assert.equal(r.id, 'gemini-antigravity')
  assert.equal(r.fiveHour.used, 2); assert.equal(r.weekly.used, 1); assert.equal(r.source, 'agy-usage')
  assert.equal(r.checkedAt, 1_000_000)
  await g.accounts.activeUsage(); g.accounts.cachedUsage()
  assert.equal(calls, 1)
  assert.equal(g.accounts.cachedUsage().get('gemini-antigravity').weekly.used, 1)
  nowRef.t += USAGE_CACHE_MS + 1
  await g.accounts.activeUsage()
  assert.equal(calls, 2)
  assert.equal((await g.accounts.activeUsage()).saved, true)
})

test('failure falls back to the estimate with an error note and never throws', async () => {
  const { g } = await mk(async () => { throw new Error('boom') })
  const r = (await g.accounts.usage()).accounts[0]
  assert.equal(r.stale, true); assert.equal(r.error, 'boom'); assert.equal(r.estimate, true)
  assert.equal(r.fiveHour.used, 0)
  const { g: g2 } = await mk(async () => ({ ok: false, auth: true }))
  assert.match((await g2.accounts.activeUsage()).error, /Not signed in/)
})

test('after a good reading, a later failure keeps it marked stale', async () => {
  let ok = true
  const { g, nowRef } = await mk(async () => (ok ? { ok: true, usage: parseUsage(JSON_OUT()) } : { ok: false, error: 'down' }))
  await g.accounts.usage()
  ok = false; nowRef.t += USAGE_CACHE_MS + 1
  const r = (await g.accounts.usage()).accounts[0]
  assert.equal(r.stale, true); assert.equal(r.error, 'down'); assert.equal(r.fiveHour.used, 2)
  assert.equal(await g.accounts.exhaustion(), null)
})

test('exhaustion: a window at 0 remaining is out until its reset_time', async () => {
  const nowRef = { t: Date.parse('2026-11-24T21:00:00Z') }
  const { g } = await mk(async () => ({ ok: true, usage: parseUsage(JSON_OUT(0, 0.5)) }), nowRef)
  assert.deepEqual(await g.accounts.exhaustion(), { until: Date.parse('2026-11-25T01:24:11Z') })
  const { g: g2 } = await mk(async () => ({ ok: true, usage: parseUsage(JSON_OUT()) }), nowRef)
  assert.equal(await g2.accounts.exhaustion(), null)
})

test('nextQuotaReset prefers a real reset time', () => {
  assert.equal(nextQuotaReset(1000), 1000 + RETRY_MS)
  assert.equal(nextQuotaReset(1000, 5000), 5000)
  assert.equal(nextQuotaReset(1000, 500), 1000 + RETRY_MS)
})

test('readAgyUsage runs the fake agy (no shell), parses its JSON, and fails cleanly', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agv-fake-agy-'))
  const bin = fakeBin(dir, 'agy', `
    const a = process.argv.slice(2)
    if (a[0] !== '-p' || a[1] !== '/usage' || !a.includes('json') || process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true') { console.error('bad args'); process.exit(2) }
    process.stdout.write(${JSON.stringify(JSON_OUT())})
  `)
  const r = await readAgyUsage({ bin })
  assert.equal(r.ok, true); assert.equal(r.usage.fiveHour.used, 2)
  const bad = fakeBin(dir, 'agy2', `console.error('authentication failed or timed out'); process.exit(1)`)
  const f = await readAgyUsage({ bin: bad })
  assert.equal(f.ok, false); assert.equal(f.auth, true)
  const hang = fakeBin(dir, 'agy3', `setTimeout(() => {}, 60000)`)
  const t = await readAgyUsage({ bin: hang, timeoutMs: 300 })
  assert.equal(t.ok, false); assert.match(t.error, /timed out/)
  assert.equal((await readAgyUsage({ bin: null })).missing, true)
})
