/**
 * Token spend: incremental, append-only reading of synthetic transcripts in a fake home. Never the
 * real ~/.claude or ~/.codex.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSpend, parseLine } from '../server/spend.mjs'

const T0 = Math.floor(Date.now() / 3600e3) * 3600e3 - 2 * 3600e3 // an hour boundary, so files written now are in the window
const iso = (min) => new Date(T0 + min * 60e3).toISOString()
const claudeRec = (id, min, u = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(min), message: { id, model: 'm', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, ...u }, content: [{ type: 'text', text: 'secret content' }] } }) + '\n'
const codexRec = (min, total, last) => JSON.stringify({ timestamp: iso(min), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last }, rate_limits: null } }) + '\n'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-spend-'))
  const claude = path.join(root, 'claude'), codex = path.join(root, 'codex')
  const proj = path.join(claude, 'projects', '-w')
  fs.mkdirSync(path.join(proj, 's1', 'subagents'), { recursive: true })
  fs.mkdirSync(path.join(codex, 'sessions', '2026', '10', '26'), { recursive: true })
  let now = T0 + 30 * 60e3
  const make = () => createSpend({ dataDir: path.join(root, 'data'), claudeHome: () => claude, codexHome: () => codex, now: () => now })
  return {
    root, main: path.join(proj, 's1.jsonl'), sub: path.join(proj, 's1', 'subagents', 'agent-x.jsonl'),
    rollout: path.join(codex, 'sessions', '2026', '10', '26', 'rollout-2026-10-26T12-00-00-aaaaaaaa-0000-4000-8000-000000000000.jsonl'),
    make, setNow: (t) => { now = t }, done: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}
const totals = (sp) => sp.summary(60).last60

test('parseLine: Claude usage per assistant record; Codex counts only when its running total grows', () => {
  assert.deepEqual(parseLine(claudeRec('m1', 0), 'claude', {}).add, [10, 5, 100, 1000, 0, 0, 0])
  assert.equal(parseLine(JSON.stringify({ type: 'user', timestamp: iso(0), message: { content: 'usage' } }), 'claude', {}), null)
  assert.equal(parseLine('{"type":"assistant", "usage": tru', 'claude', {}), null, 'a half-written line is ignored')
  const st = {}
  const last = { input_tokens: 300, cached_input_tokens: 200, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 340 }
  assert.deepEqual(parseLine(codexRec(0, 340, last), 'codex', st).add, [0, 0, 0, 0, 100, 40, 200], 'cached input is split out of input')
  assert.equal(parseLine(codexRec(0, 340, last), 'codex', st), null, 'a repeated event is not counted again')
  assert.equal(parseLine(codexRec(1, 400, last), 'codex', st).add[5], 40)
})

test('appended bytes only; streamed duplicates and half lines are handled; subagents and Codex count', async () => {
  const t = setup()
  try {
    // A streamed reply: two records, one message id.
    fs.writeFileSync(t.main, JSON.stringify({ type: 'user', timestamp: iso(0) }) + '\n' + claudeRec('m1', 1) + claudeRec('m1', 1))
    fs.writeFileSync(t.sub, claudeRec('s1', 2, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }))
    fs.writeFileSync(t.rollout, codexRec(3, 50, { input_tokens: 30, cached_input_tokens: 10, output_tokens: 20, total_tokens: 50 }))
    const sp = t.make()
    await sp.update()
    assert.deepEqual(totals(sp), { input: 11, output: 6, cacheCreation: 100, cacheRead: 1000, tokens: 1117 })
    assert.deepEqual(sp.summary(60).codex, { input: 20, output: 20, cacheRead: 10, tokens: 50 })
    assert.equal(sp.files()[t.main].off, fs.statSync(t.main).size)

    // Half a line: not counted, and the offset waits at the line start.
    const rec = claudeRec('m2', 4)
    const before = fs.statSync(t.main).size
    fs.appendFileSync(t.main, rec.slice(0, 40))
    await sp.update()
    assert.equal(totals(sp).tokens, 1117)
    assert.equal(sp.files()[t.main].off, before)
    fs.appendFileSync(t.main, rec.slice(40))
    await sp.update()
    assert.equal(totals(sp).tokens, 1117 + 1115)

    // Per-minute series, newest last.
    const s = sp.summary(60)
    assert.equal(s.series.length, 60)
    assert.equal(s.series.at(-1).t, T0 + 30 * 60e3)
    assert.equal(s.series.find((x) => x.t === T0 + 60e3).tokens, 1115)
    assert.equal(s.series.find((x) => x.t === T0 + 60e3).cacheRead, 1000)
    assert.equal(sp.summary(300).series.length, 300)
  } finally { t.done() }
})

test('truncation or replacement re-reads from the start without double counting; a restart resumes', async () => {
  const t = setup()
  try {
    fs.writeFileSync(t.main, claudeRec('m1', 1) + claudeRec('m2', 2))
    let sp = t.make()
    await sp.update()
    assert.equal(totals(sp).tokens, 2230)
    // Rewritten shorter (truncated), plus one new record.
    fs.writeFileSync(t.main, claudeRec('m2', 2) + claudeRec('m3', 3))
    fs.truncateSync(t.main, fs.statSync(t.main).size)
    await sp.update()
    assert.equal(totals(sp).tokens, 3345, 'only m3 is new')
    // Replaced by another file (new inode) holding the same records.
    const tmp = `${t.main}.tmp`
    fs.writeFileSync(tmp, claudeRec('m1', 1) + claudeRec('m2', 2) + claudeRec('m3', 3))
    fs.renameSync(tmp, t.main)
    await sp.update()
    assert.equal(totals(sp).tokens, 3345)
    await sp.flush()
    // A restart keeps the buckets and offsets: nothing is zeroed or counted twice.
    sp = t.make()
    await sp.update()
    assert.equal(totals(sp).tokens, 3345)
    fs.appendFileSync(t.main, claudeRec('m4', 4))
    await sp.update()
    assert.equal(totals(sp).tokens, 4460)
    const saved = path.join(t.root, 'data', 'spend.json')
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600)
    assert.ok(!fs.readFileSync(saved, 'utf8').includes('secret content'), 'no transcript content is kept')
  } finally { t.done() }
})

test('bounded work: a byte budget per tick, an enormous line skipped, the 24 h window', async () => {
  const t = setup()
  process.env.AGENTVILLE_SPEND_BUDGET = '700'
  process.env.AGENTVILLE_SPEND_CHUNK = '600' // longer than a record, shorter than the blob line
  try {
    // An old record (outside 24 h), a line longer than a chunk, then two real ones.
    t.setNow(T0 + 25 * 3600e3)
    const recent = (id) => JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 25 * 3600e3 - 120e3).toISOString(), message: { id, usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n'
    fs.writeFileSync(t.main, claudeRec('old', 0) + JSON.stringify({ type: 'blob', x: 'y'.repeat(1000) }) + '\n' + recent('r1') + recent('r2'))
    fs.utimesSync(t.main, new Date(T0 + 25 * 3600e3), new Date(T0 + 25 * 3600e3))
    const sp = t.make()
    await sp.update()
    assert.equal(sp.summary(60).catchingUp, true, 'out of budget: more next tick')
    for (let i = 0; i < 10 && sp.files()[t.main].off < fs.statSync(t.main).size; i++) await sp.update()
    assert.equal(sp.files()[t.main].off, fs.statSync(t.main).size)
    assert.equal(totals(sp).tokens, 4, 'the old record is outside the window; the long line is skipped')
    await sp.update()
    assert.equal(sp.summary(60).catchingUp, false)
  } finally {
    delete process.env.AGENTVILLE_SPEND_BUDGET
    delete process.env.AGENTVILLE_SPEND_CHUNK
    t.done()
  }
})

test('a week of spend: records up to 7 days old count; 24 h and 7 d ranges are aggregated', async () => {
  const t = setup()
  try {
    // Three days ago, yesterday, and now; plus one 8 days old that falls outside the week.
    fs.writeFileSync(t.main, claudeRec('old8', -8 * 1440) + claudeRec('d3', -3 * 1440) + claudeRec('d1', -1440 + 40) + claudeRec('now', 29))
    const sp = t.make()
    await sp.update()
    const w = sp.summary(10080)
    assert.equal(w.week.tokens, 1115 * 3, '8-day-old record excluded')
    assert.equal(w.step, 60)
    assert.equal(w.series.length, 168, 'hourly points for 7 days')
    assert.equal(w.series.reduce((a, x) => a + x.tokens, 0), 1115 * 3)
    const d = sp.summary(1440)
    assert.equal(d.step, 10)
    assert.equal(d.range.tokens, 1115 * 2, 'yesterday (inside 24 h) and now')
    assert.equal(d.recent.length, 60)
    assert.equal(sp.summary(60).range.tokens, 1115)
  } finally { t.done() }
})

test('a data dir that refuses writes (a full disk) never fails an update; it keeps counting and saves once it can', async () => {
  const t = setup()
  try {
    fs.writeFileSync(t.main, claudeRec('m1', 1))
    const data = path.join(t.root, 'data')
    fs.mkdirSync(data, { recursive: true })
    fs.chmodSync(data, 0o500) // stands in for ENOSPC: the temp file can't be created
    const sp = t.make()
    const errors = []
    const orig = console.error
    console.error = (...a) => errors.push(a.join(' '))
    try { await sp.update(); await sp.flush() } finally { console.error = orig }
    assert.equal(totals(sp).tokens, 1115, 'counted in memory')
    assert.equal(errors.length, 1, 'one warning, not one per tick')
    assert.match(errors[0], /Couldn't save token spend \(EACCES\)/)
    assert.deepEqual(fs.readdirSync(data), [], 'no half-written temp file left behind')
    fs.chmodSync(data, 0o700)
    await sp.flush()
    assert.ok(fs.existsSync(path.join(data, 'spend.json')), 'saved once writes work again')
  } finally { fs.chmodSync(path.join(t.root, 'data'), 0o700); t.done() }
})
