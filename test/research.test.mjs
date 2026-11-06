/**
 * Usage research log: token rows from synthetic transcripts in a fake home, usage windows, and the
 * fit recovering known weights from a synthetic log. Never the real ~/.claude or data dir.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createSpend } from '../server/spend.mjs'
import { createResearch, usageWindows, BUCKET_MS } from '../server/research.mjs'

const T0 = Math.floor(Date.now() / 3600e3) * 3600e3 - 2 * 3600e3
const iso = (min) => new Date(T0 + min * 60e3).toISOString()
const rec = (id, min, model, u = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(min), message: { id, model, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 }, speed: 'standard', ...u } } }) + '\n'
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('tokens are logged per 5-minute bucket, session, model and speed; each message once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-research-'))
  try {
    const proj = path.join(root, 'claude', 'projects', '-w')
    fs.mkdirSync(path.join(proj, 'abcdef12-0000', 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(proj, 'abcdef12-0000.jsonl'), rec('m1', 1, 'claude-opus-5-5') + rec('m1', 1, 'claude-opus-5-5') + rec('m2', 2, 'claude-opus-5-5', { speed: 'fast' }))
    fs.writeFileSync(path.join(proj, 'abcdef12-0000', 'subagents', 'agent-x.jsonl'), rec('s1', 3, 'claude-haiku-5-5'))
    const now = T0 + 30 * 60e3
    const research = createResearch({ dataDir: path.join(root, 'data'), now: () => now })
    const sp = createSpend({ dataDir: path.join(root, 'data'), claudeHome: () => path.join(root, 'claude'), codexHome: () => path.join(root, 'codex'), research, now: () => now })
    await sp.update()
    const rows = lines(path.join(research.dir, `tokens-${new Date(T0).toISOString().slice(0, 7)}.jsonl`))
    const by = (m, sp) => rows.find((r) => r.m === m && r.sp === sp)
    assert.equal(rows.length, 3)
    assert.deepEqual(by('claude-opus-5-5', 'standard'), { t: Math.floor((T0 + 60e3) / BUCKET_MS) * BUCKET_MS, s: 'abcdef12', m: 'claude-opus-5-5', sp: 'standard', f: [10, 5, 40, 60, 1000], n: 1 })
    assert.equal(by('claude-opus-5-5', 'fast').n, 1)
    assert.equal(by('claude-haiku-5-5', 'standard').s, 'abcdef12', "a subagent counts under its parent's session")
    await sp.update()
    assert.equal(lines(path.join(research.dir, fs.readdirSync(research.dir)[0])).length, 3, 'nothing new, nothing logged')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('usageWindows keeps every window with a utilization', () => {
  assert.deepEqual(usageWindows({ five_hour: { utilization: 12.5, resets_at: '2026-10-30T10:00:00Z' }, seven_day_opus: { utilization: 3, resets_at: null }, extra_usage: { is_enabled: false }, seven_day_sonnet: null }),
    { five_hour: { used: 12.5, resetsAt: Date.parse('2026-10-30T10:00:00Z') }, seven_day_opus: { used: 3, resetsAt: null } })
  assert.deepEqual(usageWindows(null), {})
})

test('the fit recovers known weights from a synthetic log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-fit-'))
  try {
    const dir = path.join(root, 'research')
    fs.mkdirSync(dir)
    const t0 = Date.UTC(2026, 9, 1)
    const W = [0.2, 1, 0.25, 0.4, 0.02] // % per million tokens: input, output, cw5m, cw1h, cache read
    let used = 0, tok = '', use = ''
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 400; i++) {
      const t = t0 + i * BUCKET_MS
      const f = [rnd() * 2e5, rnd() * 3e5, rnd() * 3e5, rnd() * 4e5, rnd() * 2e7].map(Math.round)
      tok += JSON.stringify({ t, s: 'abcdef12', m: 'claude-opus-5-5', sp: 'standard', f, n: 1 }) + '\n'
      if (i % 6 === 0) use += JSON.stringify({ at: t, account: 'acct-1', active: true, windows: { five_hour: { used, resetsAt: t0 + 1e9 } } }) + '\n'
      used += f.reduce((s, v, k) => s + (v / 1e6) * W[k], 0)
    }
    fs.writeFileSync(path.join(dir, 'tokens-2026-10.jsonl'), tok)
    fs.writeFileSync(path.join(dir, 'usage-2026-10.jsonl'), use)
    const out = execFileSync(process.execPath, ['tools/usage-fit.mjs', '--data', root], { encoding: 'utf8' })
    assert.match(out, /R² 1\.000/)
    for (const [name, v] of [['cacheRead', 0.02], ['output', 1]]) assert.match(out, new RegExp(`^${name} +[\\d.]+ +${v === 1 ? '1\\.00' : '0\\.0200'}`, 'm'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
