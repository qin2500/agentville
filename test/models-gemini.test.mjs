/** Models view, Gemini (Antigravity): labels, the transcript reader and the row shape. Synthetic fixtures only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { modelLabel, buildModels } from '../server/models.mjs'
import { geminiModelFacts } from '../server/gemini/models.mjs'

const L = (o) => JSON.stringify(o)
const NOW = Date.parse('2026-11-24T21:00:00Z')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agymodels-'))
  const agyDir = path.join(root, 'home', '.gemini', 'antigravity-cli'), dataDir = path.join(root, 'data')
  const logs = path.join(agyDir, 'brain', 'c1', '.system_generated', 'logs')
  fs.mkdirSync(logs, { recursive: true })
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-23T01:00:00Z', content: 'secret prompt' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-23T01:00:05Z', model: 'gemini-3.8-flash-low', input_tokens: 999, output_tokens: 9 },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-24T20:30:00Z', model: 'gemini-4-neon-medium', input_tokens: 1000, cache_read_tokens: 500, output_tokens: 100 },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-24T20:50:00Z', model: 'gemini-4-neon-high', input_tokens: 2000, cache_read_tokens: 1500, output_tokens: 200, thinking_tokens: 50 },
  ].map(L).join('\n') + '\n{"partial')
  const run = path.join(dataDir, 'gemini-runs', 'r1')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'state.json'), L({ runId: 'r1', model: 'gemini-4-neon' }))
  return { agyDir, dataDir }
}

test('labels for Antigravity model ids', () => {
  assert.equal(modelLabel('gemini-4-neon-high'), 'Gemini 4 Neon · High')
  assert.equal(modelLabel('gemini-3.8-flash-low'), 'Gemini 3.8 Flash · Low')
  assert.equal(modelLabel('gemini-pro-orchestrator-neon'), 'Gemini Pro Orchestrator Neon')
  assert.equal(modelLabel('gpt-oss-120b-medium'), 'GPT-OSS 120B · Medium')
  assert.equal(modelLabel('claude-opus-5-5-high'), 'Opus 5.5 · High')
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5')
})

test('brain transcript: newest model, tokens in the last 24 h, change history, requested model', async () => {
  const { agyDir, dataDir } = fixture()
  const g = await geminiModelFacts({ conversationId: 'c1', runId: 'r1', dataDir, agyDir, now: NOW })
  assert.equal(g.model, 'gemini-4-neon-high')
  assert.equal(g.requested, 'gemini-4-neon')
  assert.equal(g.ctx, 3500)
  assert.deepEqual(g.tokens['gemini-4-neon-high'].day, [2000, 250, 0, 1500])
  assert.equal(g.tokens['gemini-3.8-flash-low'], undefined, 'older than 24 h')
  assert.equal(g.history.length, 2)
  assert.equal(JSON.stringify(g).includes('secret'), false)
  const none = await geminiModelFacts({ conversationId: '../x', dataDir, agyDir, now: NOW })
  assert.equal(none.model, '')
})

test('buildModels: a Gemini row has route, configured, tokens and no pool or false mismatch flag', async () => {
  const { agyDir, dataDir } = fixture()
  const g = await geminiModelFacts({ conversationId: 'c1', runId: 'r1', dataDir, agyDir, now: NOW })
  const agents = [{ id: 'gemini:r1', harness: 'gemini-cli', provider: 'gemini', bucket: 'building', live: true }, { id: 'gemini:h1', harness: 'gemini-cli', provider: 'gemini', bucket: 'building', live: false }]
  const out = buildModels({ agents, info: new Map(), facts: () => null, profile: 'personal', defaults: { model: null, env: {} }, gemini: new Map([['gemini:r1', g]]), now: NOW })
  const [r, none] = out.agents
  assert.equal(r.now.label, 'Gemini 4 Neon · High')
  assert.equal(r.configured.label, 'Gemini 4 Neon')
  assert.equal(r.route, 'antigravity')
  assert.deepEqual(r.context, { used: 3500, window: null })
  assert.equal(r.tokens.day, 5350)
  assert.equal(r.history[0].toLabel, 'Gemini 4 Neon · High')
  assert.deepEqual(r.flags, [])
  assert.equal(none.configured.label, 'Antigravity default')
  assert.equal(none.now, null)
  assert.ok(out.models.some((c) => c.label === 'Gemini 4 Neon · High'))
})
