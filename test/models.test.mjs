/**
 * The Models view: model names, configured-model resolution, per-file model tracking in spend.mjs,
 * and GET /api/models against the synthetic fixture home. Never the real ~/.claude or ~/.codex.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { makeHome, IDS, MODELS, ENV_SECRET } from './fixtures/make-home.mjs'
import { modelLabel, parseModel, resolve, mismatch, familyOf, buildModels } from '../server/models.mjs'
import { jobModelConfig, modelEnv } from '../server/claude-code.mjs'
import { createSpend } from '../server/spend.mjs'
import { createServer } from '../server/serve.mjs'

test('model names: short display names, routing and window aside', () => {
  const cases = {
    'claude-opus-5-5': 'Opus 5.5', 'cc/claude-opus-5-5': 'Opus 5.5', 'claude-opus-5-5[1m]': 'Opus 5.5', 'claude-opus-5': 'Opus 5',
    'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-4-5-20251001': 'Haiku 4.5', 'claude-3-5-sonnet-20241022': 'Sonnet 3.5',
    'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-5': 'GPT-5', opus: 'Opus', 'sonnet[1m]': 'Sonnet', 'claude-fable-1': 'Fable 1',
  }
  for (const [id, label] of Object.entries(cases)) assert.equal(modelLabel(id), label, id)
  assert.deepEqual(parseModel('cc/claude-opus-5-5[1m]'), { base: 'claude-opus-5-5', pool: true, oneM: true })
  assert.equal(familyOf('claude-3-5-sonnet-20241022'), 'sonnet')
  assert.equal(familyOf('gpt-6.1-sol'), null)
})

test('configured: aliases resolve through the job env, then settings; [1m] and cc/ carry through', () => {
  const job = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5[1m]' }
  const settings = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'cc/claude-sonnet-5-5' }
  assert.deepEqual(resolve('opus[1m]', [job, settings]), { raw: 'opus[1m]', id: 'claude-opus-5', alias: null, via: 'ANTHROPIC_DEFAULT_OPUS_MODEL', pool: false, oneM: true })
  const s = resolve('sonnet', [job, settings])
  assert.equal(s.id, 'claude-sonnet-5-5')
  assert.equal(s.pool, true, 'the alias points at a gateway model')
  assert.equal(resolve('haiku', [job, settings]).alias, 'haiku', 'unresolved: Claude Code picks its own default')
  assert.equal(resolve('claude-opus-5-5[1m]', []).id, 'claude-opus-5-5')
  assert.equal(resolve(null, []), null)
  // Mismatch ignores routing, the window and date suffixes; an unresolved alias compares by family.
  assert.equal(mismatch('claude-opus-5-5', resolve('cc/claude-opus-5-5[1m]', [])), false)
  assert.equal(mismatch('claude-haiku-4-5-20251001', resolve('claude-haiku-4-5', [])), false)
  assert.equal(mismatch('claude-opus-5-5', resolve('opus[1m]', [job])), true, 'pinned to the older Opus')
  assert.equal(mismatch('claude-opus-5-5', resolve('opus', [])), false)
  assert.equal(mismatch('claude-sonnet-5-5', resolve('opus', [])), true)
  assert.equal(mismatch('claude-opus-5-5', resolve('default', [])), false)
})

test('job config: only --model, --effort and env keys ending in _MODEL are read; other values never', () => {
  const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5[1m]', CLAUDE_CODE_SUBAGENT_MODEL: 'inherit', ANTHROPIC_SMALL_FAST_MODEL: 'not a model; rm -rf' }
  // Reading any other value throws, so this test fails if the code ever looks at one.
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']) {
    Object.defineProperty(env, k, { enumerable: true, get() { throw new Error(`read ${k}`) } })
  }
  const cfg = jobModelConfig({ respawnFlags: ['-n', 'x', '--model', 'opus[1m]', '--effort=high', '--dangerously-skip-permissions'], providerEnv: env })
  assert.deepEqual(cfg, { model: 'opus[1m]', effort: 'high', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5[1m]', CLAUDE_CODE_SUBAGENT_MODEL: 'inherit' } })
  assert.deepEqual(jobModelConfig({}), { model: null, effort: null, env: {} })
  assert.deepEqual(modelEnv(['x']), {})
})

// ---------- per-file model tracking (spend.mjs) ----------
const T0 = Math.floor(Date.now() / 3600e3) * 3600e3 - 2 * 3600e3
const iso = (min) => new Date(T0 + min * 60e3).toISOString()
const rec = (id, min, model, u = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(min), message: { id, model, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, ...u }, content: [{ type: 'text', text: 'secret content' }] } }) + '\n'
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-models-'))
  const claude = path.join(root, 'claude'), codex = path.join(root, 'codex')
  fs.mkdirSync(path.join(claude, 'projects', '-w'), { recursive: true })
  fs.mkdirSync(path.join(codex, 'sessions', '2026', '10', '26'), { recursive: true })
  let now = T0 + 120 * 60e3
  return {
    root, main: path.join(claude, 'projects', '-w', 's1.jsonl'),
    rollout: path.join(codex, 'sessions', '2026', '10', '26', 'rollout-2026-10-26T12-00-00-aaaaaaaa-0000-4000-8000-000000000000.jsonl'),
    make: () => createSpend({ dataDir: path.join(root, 'data'), claudeHome: () => claude, codexHome: () => codex, now: () => now }),
    setNow: (t) => { now = t }, done: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test('spend tracks each file\'s model: latest, changes, context size and tokens per model', async () => {
  const t = home()
  try {
    fs.writeFileSync(t.main, rec('a', 10, 'claude-opus-5') + rec('b', 30, 'claude-opus-5') + rec('c', 90, 'claude-opus-5-5') + rec('c', 90, 'claude-opus-5-5')
      + JSON.stringify({ type: 'assistant', timestamp: iso(100), isApiErrorMessage: true, message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [] } }) + '\n'
      + rec('d', 110, 'claude-opus-5-5', { cache_read_input_tokens: 400_000 }))
    const sp = t.make()
    await sp.update()
    const f = sp.modelFacts(t.main)
    assert.equal(f.model, 'claude-opus-5-5', 'the synthetic error record is not a model')
    assert.equal(f.ctx, 10 + 100 + 400_000, 'input + cache writes + cache reads of the latest reply')
    assert.deepEqual(f.history, [{ at: T0 + 90 * 60e3, from: 'claude-opus-5', to: 'claude-opus-5-5' }])
    assert.deepEqual(f.tokens['claude-opus-5'].day, [20, 10, 200, 2000])
    assert.deepEqual(f.tokens['claude-opus-5'].hour, [0, 0, 0, 0], 'both Opus 5 replies are over an hour old')
    assert.deepEqual(f.tokens['claude-opus-5-5'].day, [20, 10, 200, 401_000], 'a streamed reply (same id twice) counts once')
    assert.equal(sp.summary(1440).day.tokens, 1115 * 3 + 400_115, 'the minute buckets agree')
    assert.equal(sp.modelFacts('/nope'), null)

    // Codex: the turn names the model, the turn start the window; tokens go to that model.
    fs.writeFileSync(t.rollout, [
      { timestamp: iso(100), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { timestamp: iso(100), type: 'event_msg', payload: { type: 'task_started', model_context_window: 272000 } },
      { timestamp: iso(101), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 70 }, last_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 20 } } } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
    await sp.flush()
    t.setNow(T0 + 121 * 60e3)
    const sp2 = t.make() // discovery is throttled, so a fresh instance (resuming from spend.json) finds the rollout
    await sp2.update()
    const c = sp2.modelFacts(t.rollout)
    assert.equal(c.model, 'gpt-6.1-sol')
    assert.equal(c.window, 272000)
    assert.equal(c.ctx, 50)
    assert.deepEqual(c.tokens['gpt-6.1-sol'].day, [30, 20, 0, 20])
    // A restart keeps the model state (it persists in spend.json) without the transcript content.
    assert.deepEqual(sp2.modelFacts(t.main).history, f.history)
    const saved = fs.readFileSync(path.join(t.root, 'data', 'spend.json'), 'utf8')
    assert.equal(JSON.parse(saved).v, 3)
    assert.ok(!saved.includes('secret content'))
  } finally { t.done() }
})

test('model history is capped and 24 h slots are dropped', async () => {
  const t = home()
  try {
    t.setNow(T0 + 26 * 3600e3)
    let lines = ''
    for (let i = 0; i < 14; i++) lines += rec(`m${i}`, 24 * 60 + i, i % 2 ? 'claude-opus-5-5' : 'claude-sonnet-5-5')
    lines += rec('old', 0, 'claude-sonnet-5-5')
    fs.writeFileSync(t.main, rec('first', -60, 'claude-haiku-4-5') + lines)
    const sp = t.make()
    await sp.update()
    const f = sp.modelFacts(t.main)
    assert.equal(f.history.length, 10, 'at most 10 changes kept')
    assert.equal(f.model, 'claude-opus-5-5', 'an older record arriving later does not change the current model')
    assert.equal(f.tokens['claude-haiku-4-5'], undefined, 'more than 24 h old: no tokens')
  } finally { t.done() }
})

test('upgrading a version-2 spend.json re-reads files for models once, without counting tokens twice', async () => {
  const t = home()
  try {
    fs.writeFileSync(t.main, rec('a', 100, 'claude-opus-5-5'))
    const codexLine = (min, total) => JSON.stringify({ timestamp: iso(min), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 10 } } } }) + '\n'
    fs.writeFileSync(t.rollout, codexLine(100, 50))
    let sp = t.make()
    await sp.update()
    await sp.flush()
    const before = sp.summary(1440)
    // Turn the saved file back into version 2: no models.
    const file = path.join(t.root, 'data', 'spend.json')
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete j.models
    j.v = 2
    fs.writeFileSync(file, JSON.stringify(j))
    fs.appendFileSync(t.rollout, codexLine(101, 100))
    sp = t.make()
    await sp.update()
    const after = sp.summary(1440)
    assert.equal(after.day.tokens, before.day.tokens, 'Claude: nothing counted twice')
    assert.equal(after.dayCodex.tokens, before.dayCodex.tokens * 2, 'Codex: only the new event counts')
    assert.equal(sp.modelFacts(t.main).model, 'claude-opus-5-5', 'models are built from the re-read')
    assert.deepEqual(sp.modelFacts(t.main).tokens['claude-opus-5-5'].day, [10, 5, 100, 1000])
    assert.deepEqual(sp.modelFacts(t.rollout).tokens[''].day, [60, 20, 0, 20], 'Codex tokens for the model state cover both events')
  } finally { t.done() }
})

test('buildModels: cards by model and window, in a fixed order; hidden agents left out', () => {
  const agents = [
    { id: 'a', harness: 'claude-code', bucket: 'building', live: true },
    { id: 'b', harness: 'claude-code', bucket: 'resting', live: false },
    { id: 'c', harness: 'claude-code', bucket: 'stalled', live: false, hidden: true },
    { id: 'd', harness: 'claude-code', bucket: 'waiting', live: true },
  ]
  const day = (n) => ({ hour: [0, 0, 0, 0], day: [n, 0, 0, 0] })
  const facts = { fa: { model: 'claude-sonnet-5-5', ctx: 10, tokens: { 'claude-sonnet-5-5': day(100) } }, fb: { model: 'claude-opus-5-5', ctx: 10, tokens: { 'claude-opus-5-5': day(300) } },
    fc: { model: 'claude-opus-5-5', ctx: 10, tokens: { 'claude-opus-5-5': day(999) } }, fd: { model: 'claude-opus-5-5', ctx: 10, tokens: {} } }
  const info = new Map(agents.map((a) => [a.id, { kind: 'job', file: `f${a.id}`, config: { model: a.id === 'd' ? 'opus[1m]' : null, env: {} } }]))
  const out = buildModels({ agents, info, facts: (f) => facts[f], profile: 'personal', defaults: { model: null, env: {} } })
  assert.deepEqual(out.models.map((c) => [c.label, c.agents, c.live, c.day]), [['Opus 5.5 · 1M', 1, 1, 0], ['Opus 5.5', 0, 0, 300], ['Sonnet 5.5', 1, 1, 100]])
  assert.equal(out.models[1].share, 0.75)
})

// ---------- GET /api/models against the fixture home ----------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-models-api-'))
const env = makeHome(root)
const server = await (async () => {
  Object.assign(process.env, env)
  const s = createServer({ dataDir: path.join(root, 'data') })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  return s
})()
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }) })
const rowOf = (body, id) => body.agents.find((a) => a.id === id)

test('GET /api/models: model now, configured, route, context, tokens and flags per agent', async () => {
  const res = await fetch(`${base}/api/models`)
  assert.equal(res.status, 200)
  const body = await res.json()
  const raw = JSON.stringify(body)
  assert.ok(!raw.includes(ENV_SECRET), 'no providerEnv secret')
  assert.ok(!raw.includes('gateway.invalid'), 'no base URL')
  assert.ok(!raw.includes(root), 'no file paths')
  assert.ok(!raw.includes('Build the API') && !raw.includes('Done.'), 'no transcript content')
  assert.equal(body.profile, 'personal')

  const boss = rowOf(body, `claude-code:${IDS.boss}`)
  assert.equal(boss.now.label, 'Opus 5.5')
  assert.deepEqual([boss.configured.raw, boss.configured.id, boss.configured.label, boss.configured.via, boss.configured.source], ['opus[1m]', 'claude-opus-5', 'Opus 5 · 1M', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'flag'])
  assert.deepEqual(boss.flags, ['mismatch'])
  assert.equal(boss.context.window, 1_000_000)

  const lead = rowOf(body, `claude-code:${IDS.leadBuilding}`)
  assert.deepEqual([lead.now.id, lead.configured.label, lead.configured.effort, lead.route], [MODELS.leadBuilding.now, 'Opus 5.5 · 1M', 'high', 'personal'])
  assert.deepEqual(lead.context, { used: MODELS.leadBuilding.ctx, window: 1_000_000 })
  assert.deepEqual(lead.flags, ['context'], '85 % of 1M; Opus 5.5 is what it was told')
  assert.deepEqual(lead.history.map((h) => [h.fromLabel, h.toLabel]), [['Opus 5', 'Opus 5.5']])
  assert.deepEqual(lead.byModel.map((m) => m.label), ['Opus 5.5', 'Opus 5'])
  for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) assert.ok(lead.byModel[0][k] > 0, k)

  const blocked = rowOf(body, `claude-code:${IDS.leadBlocked}`)
  assert.equal(blocked.route, 'pool')
  assert.deepEqual(blocked.flags, ['pool'], 'on the pool while the account is personal; cc/ alone is no mismatch')

  const worker = rowOf(body, `claude-code:${IDS.leadBuilding}:sub:worker`)
  assert.deepEqual([worker.now.label, worker.configured.label, worker.configured.source], ['Sonnet 5.5', 'Sonnet', 'subagent'])
  const mate = rowOf(body, `claude-code:${IDS.leadBuilding}:sub:mate`)
  assert.deepEqual([mate.configured.label, mate.configured.source, mate.configured.id], ['Inherits', 'inherit', MODELS.leadBuilding.now])
  assert.ok(lead.tokens.day > 0 && worker.tokens.day > 0 && lead.tokens.day !== lead.tokens.day + worker.tokens.day, 'each row counts its own transcript')

  const solo = rowOf(body, `claude-code:${IDS.soloWaiting}`)
  assert.deepEqual([solo.now.label, solo.configured.source, solo.flags], ['Haiku 4.5', 'settings', []], 'a settings default is not flagged')
  assert.equal(solo.oneM, false, 'the default\'s [1m] is for Opus, not this Haiku')
  assert.equal(rowOf(body, `claude-code:${IDS.soloError}`).now, null, 'only a synthetic error record: no model')

  const codex = rowOf(body, `codex:${IDS.codexRunning}`)
  assert.deepEqual([codex.now.label, codex.route, codex.context.window, codex.context.used], ['GPT-6.1 Sol', 'codex', 272_000, 40_000])

  const labels = body.models.map((c) => c.label)
  for (const l of ['Opus 5.5 · 1M', 'Sonnet 5.5', 'Haiku 4.5', 'GPT-6.1 Sol']) assert.ok(labels.includes(l), l)
  assert.ok(Math.abs(body.models.reduce((n, c) => n + c.share, 0) - 1) < 1e-9)
})

test('GET /api/models is local-only like every other route', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/models', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 403)
})

test('Codex model settings come from the state DB (model, effort, provider)', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(env.AGENTVILLE_CODEX_HOME, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, model TEXT, reasoning_effort TEXT, model_provider TEXT)')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(IDS.codexTurn, '/w', 'gpt-6.1-sol', 'high', 'openai')
  db.close()
  await new Promise((r) => setTimeout(r, 2100)) // the agent scan is shared for 2 s
  const body = await (await fetch(`${base}/api/models`)).json()
  const row = rowOf(body, `codex:${IDS.codexTurn}`)
  assert.deepEqual([row.now.label, row.configured.label, row.configured.effort, row.provider], ['GPT-6.1 Sol', 'GPT-6.1 Sol', 'high', 'openai'])
})
