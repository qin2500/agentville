// Sub-agents terminated by the usage limit or an API error: classified as stopped (not "Done"),
// rolled up on the parent and the Tasks list, and the one-message-per-parent resume nudge.
// Synthetic fixtures and fakes only: never the real ~/.claude, accounts, network or sessions.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scan as scanClaude, apiLimitOf } from '../server/claude-code.mjs'
import { scan as scanCodex } from '../server/codex.mjs'
import { build, subsStopped } from '../server/classify.mjs'
import { createSubLimitNudger, nudgeText, pending, parentProblem, MAX_AGE_MS } from '../server/sub-limit.mjs'
import { taskRows } from '../web/src/tasks-model.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-sub-limit-'))
const claude = path.join(root, 'claude')
const codex = path.join(root, 'codex')
process.env.AGENTVILLE_CLAUDE_HOME = claude
process.env.AGENTVILLE_CODEX_HOME = codex
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

const PARENT = 'cafe0001-0000-4000-8000-000000000000'
const proj = path.join(claude, 'projects', '-work-app')
const subs = path.join(proj, PARENT, 'subagents')
const iso = (ago) => new Date(Date.now() - ago).toISOString()
const line = (r) => JSON.stringify(r) + '\n'
const SECRET = 'TOPSECRET conversation text'
const resetSec = Math.floor((Date.now() + 20 * 60e3) / 1000)

const limitRecord = (ago, text = "You've hit your 5-hour limit · resets 6:20pm") => ({
  type: 'assistant', isSidechain: true, isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, apiErrorType: 'rate_limit_error',
  quotaLimits: { status: 'rejected', resetsAt: resetSec, rateLimitType: 'five_hour' }, timestamp: iso(ago),
  message: { model: '<synthetic>', content: [{ type: 'text', text }] },
})
const work = (ago) => [
  { type: 'user', isSidechain: true, timestamp: iso(ago + 2000), message: { content: SECRET } },
  { type: 'assistant', isSidechain: true, timestamp: iso(ago + 1000), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: SECRET } }] } },
  { type: 'user', isSidechain: true, timestamp: iso(ago + 500), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: SECRET }] } },
]
function sub(id, records, meta = { agentType: 'general-purpose', description: 'Build part', finished: true }) {
  fs.mkdirSync(subs, { recursive: true })
  fs.writeFileSync(path.join(subs, `agent-${id}.jsonl`), records.map(line).join(''))
  fs.writeFileSync(path.join(subs, `agent-${id}.meta.json`), JSON.stringify(meta))
}

fs.mkdirSync(proj, { recursive: true })
fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true })
fs.writeFileSync(path.join(proj, `${PARENT}.jsonl`), [
  { type: 'user', sessionId: PARENT, cwd: '/work/app', uuid: 'u1', timestamp: iso(600_000), message: { content: 'Coordinate the build' } },
  { type: 'assistant', sessionId: PARENT, timestamp: iso(590_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spawned helpers' }] } },
].map(line).join(''))
fs.writeFileSync(path.join(claude, 'sessions', 'p.json'), JSON.stringify({ pid: process.pid, sessionId: PARENT, status: 'idle', kind: 'interactive' }))
sub('aaa111', [...work(70_000), limitRecord(60_000)])
sub('bbb222', [...work(70_000), limitRecord(55_000)])
sub('ccc333', [...work(70_000), { ...limitRecord(50_000, 'API Error: 500 {"type":"error"}'), error: 'unknown', apiErrorStatus: 500, quotaLimits: undefined }])
sub('ddd444', [...work(70_000), { type: 'assistant', isSidechain: true, timestamp: iso(40_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All done' }] } }])

const agents = async () => build([...(await scanClaude()), ...(await scanCodex())])
const pid = `claude-code:${PARENT}`
const sid = (s) => `${pid}:sub:${s}`

test('apiLimitOf reads the record fields, and the reset time only from the harness text', () => {
  assert.deepEqual(apiLimitOf(limitRecord(0)), { resetsAt: resetSec * 1000, reason: 'Stopped by usage limit · resets 6:20pm' })
  assert.equal(apiLimitOf({ ...limitRecord(0, 'API Error: 500'), error: 'unknown', apiErrorStatus: 500, quotaLimits: null }), null)
  // A 429 that isn't the account's quota (no rejected quota) is an API error, not the usage limit.
  assert.equal(apiLimitOf({ ...limitRecord(0, 'API Error: 429'), quotaLimits: { status: 'allowed' } }), null)
  assert.equal(apiLimitOf({ ...limitRecord(0, 'Request failed'), quotaLimits: { status: 'rejected' } }).reason, 'Stopped by usage limit')
})

test('a sub-agent the usage limit terminated is stalled red, not Done; the parent and Tasks say so', async () => {
  const out = await agents()
  const a = out.find((x) => x.id === sid('aaa111'))
  assert.deepEqual([a.bucket, a.severity, a.reason, a.role], ['stalled', 'error', 'Stopped by usage limit · resets 6:20pm', 'sub'])
  assert.equal(a.limitStop.kind, 'limit')
  assert.equal(a.limitStop.resetsAt, resetSec * 1000)
  assert.ok(Math.abs(a.limitStop.at - (Date.now() - 60_000)) < 5000)
  const c = out.find((x) => x.id === sid('ccc333'))
  assert.deepEqual([c.bucket, c.severity, c.reason, c.limitStop.kind, c.limitStop.resetsAt], ['stalled', 'error', 'Stopped by an API error (500)', 'api', null])
  const d = out.find((x) => x.id === sid('ddd444'))
  assert.deepEqual([d.bucket, d.reason, d.limitStop], ['resting', 'Done', null])
  const p = out.find((x) => x.id === pid)
  assert.deepEqual([p.bucket, p.severity, p.reason], ['stalled', 'error', '3 sub-agents stopped by the usage limit or API errors'])
  assert.deepEqual(p.subsStopped, { count: 3, limit: 2, resetsAt: resetSec * 1000 })
  assert.doesNotMatch(JSON.stringify(out), /TOPSECRET|hit your|All done/)
  const tasks = taskRows([{ id: pid, kind: 'agent', agentId: pid, addedAt: 0 }], out, {})
  assert.deepEqual([tasks.open[0].status, tasks.open[0].tone], ['3 sub-agents stopped by the usage limit or API errors', 'error'])
})

test('resumed (a newer record after the error) it is no longer stopped', async () => {
  const file = path.join(subs, 'agent-bbb222.jsonl')
  const before = fs.readFileSync(file, 'utf8')
  fs.appendFileSync(file, line({ type: 'user', isSidechain: true, timestamp: iso(1000), message: { content: 'continue' } }) +
    line({ type: 'assistant', isSidechain: true, timestamp: iso(500), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }))
  const out = await agents()
  assert.equal(out.find((x) => x.id === sid('bbb222')).limitStop, null)
  assert.equal(out.find((x) => x.id === pid).subsStopped.count, 2)
  fs.writeFileSync(file, before)
  fs.utimesSync(file, new Date(), new Date(Date.now() + 2000))
})

test('subsStopped wording', () => {
  assert.equal(subsStopped([{ kind: 'limit' }]), '1 sub-agent stopped by the usage limit')
  assert.equal(subsStopped([{ kind: 'limit' }, { kind: 'limit' }]), '2 sub-agents stopped by the usage limit')
  assert.equal(subsStopped([{ kind: 'api' }]), '1 sub-agent stopped by an API error')
})

test('a working parent keeps building; a parent stalled on its own question keeps that reason', () => {
  const kid = (id, p) => ({ id, parentId: p, kind: 'subagent', harness: 'claude-code', lifecycle: 'failed', errorReason: 'Stopped by usage limit', lastActivityAt: Date.now(), limitStop: { at: Date.now() - 1000, resetsAt: null, kind: 'limit' } })
  const out = build([
    { id: 'p1', kind: 'session', harness: 'claude-code', lifecycle: 'running', live: true, lastActivityAt: Date.now() }, kid('p1:sub:a', 'p1'),
    { id: 'p2', kind: 'session', harness: 'claude-code', lifecycle: 'idle', live: true, needsUser: true, lastActivityAt: Date.now() }, kid('p2:sub:a', 'p2'),
  ])
  const by = new Map(out.map((a) => [a.id, a]))
  assert.equal(by.get('p1').bucket, 'building')
  assert.equal(by.get('p1').subsStopped.count, 1)
  assert.equal(by.get('p2').reason, 'Needs your input')
})

test('Codex: a child thread stopped by the usage limit error code', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const P = 'c0de0001-0000-4000-8000-000000000000', C = 'c0de0002-0000-4000-8000-000000000000'
  fs.mkdirSync(codex, { recursive: true })
  const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, updated_at_ms INTEGER); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(P, '/work/app', Date.now() - 5000)
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(C, '/work/app', Date.now() - 5000)
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)').run(P, C)
  db.close()
  const dir = path.join(codex, 'sessions', '2026', '11', '13')
  fs.mkdirSync(dir, { recursive: true })
  const roll = (id, events) => fs.writeFileSync(path.join(dir, `rollout-2026-11-13T00-00-00-${id}.jsonl`),
    [{ type: 'session_meta', timestamp: iso(9000), payload: { id, cwd: '/work/app' } }, ...events].map(line).join(''))
  roll(P, [{ type: 'event_msg', timestamp: iso(8000), payload: { type: 'task_complete' } }])
  roll(C, [{ type: 'event_msg', timestamp: iso(8000), payload: { type: 'task_started' } },
    { type: 'event_msg', timestamp: iso(7000), payload: { type: 'error', message: SECRET, codex_error_info: 'usage_limit_exceeded' } }])
  const out = await agents()
  const c = out.find((x) => x.id === `codex:${C}`)
  assert.deepEqual([c.bucket, c.severity, c.reason, c.limitStop?.kind], ['stalled', 'error', 'Stopped by usage limit', 'limit'])
  assert.doesNotMatch(JSON.stringify(c), /TOPSECRET/)
  fs.rmSync(codex, { recursive: true, force: true })
})

// ---- the nudge ----
const T0 = Date.UTC(2026, 10, 13, 23, 0)
const stopped = (id, parentId, at, extra = {}) => ({ id: `${parentId}:sub:${id}`, parentId, kind: 'subagent', bucket: 'stalled', limitStop: { at, resetsAt: null, kind: 'limit', ...extra } })
const parent = (id, extra = {}) => ({ id, kind: 'session', harness: 'claude-code', live: true, hidden: false, bucket: 'stalled', ...extra })

function harness({ list, changedAt = 0, room = true, deliverOk = true, now = T0 + 60_000, dir = fs.mkdtempSync(path.join(root, 'nudge-')) }) {
  const env = { list, changedAt, room, now, fresh: null, sent: [], logs: [], deliverOk }
  const nudger = createSubLimitNudger({
    dataDir: dir, selfId: 'claude-code:self',
    agents: async ({ fresh } = {}) => (fresh && env.fresh ? env.fresh : env.list),
    changedAt: async () => env.changedAt,
    canRequest: async () => env.room,
    deliverTo: async (id, text) => { if (!env.deliverOk) return false; env.sent.push({ id, text }); return true },
    log: (l) => env.logs.push(l), now: () => env.now,
  })
  return { env, nudger, dir }
}

test('nothing until the account changes or the reset passes; then one message per parent', async () => {
  const list = [parent('P'), stopped('a1', 'P', T0), stopped('a2', 'P', T0 + 1000), parent('Q'), stopped('b1', 'Q', T0, { resetsAt: T0 + 30 * 60e3 })]
  const { env, nudger } = harness({ list })
  assert.deepEqual(await nudger.tick(), [])
  env.changedAt = T0 + 30_000 // a switch after the stops: P is ready; Q's switch also counts
  assert.deepEqual((await nudger.tick()).sort(), ['P', 'Q'])
  const p = env.sent.find((s) => s.id === 'P')
  assert.match(p.text, /^2 of your sub-agents were stopped by the usage limit/)
  assert.match(p.text, /SendMessage/)
  assert.match(p.text, /continue where you stopped/)
  assert.match(p.text, /a1, a2/)
  assert.equal(env.logs.length, 2)
  assert.match(env.logs[0], /^sub-limit nudge: [PQ] told to resume [12] stopped sub-agents?$/)
  // Same incident, later ticks: never again.
  env.now += 10 * 60e3
  assert.deepEqual(await nudger.tick(), [])
  assert.equal(env.sent.length, 2)
})

test('the reset time passing is enough without a switch', async () => {
  const { env, nudger } = harness({ list: [parent('P'), stopped('a1', 'P', T0, { resetsAt: T0 + 120_000 })] })
  assert.deepEqual(await nudger.tick(), [])
  env.now = T0 + 121_000
  assert.deepEqual(await nudger.tick(), ['P'])
})

test('no message while the active account has no room; a stop older than the change waits for the next change', async () => {
  const { env, nudger } = harness({ list: [parent('P'), stopped('a1', 'P', T0)], changedAt: T0 - 1000, room: true })
  assert.deepEqual(await nudger.tick(), [], 'the change came before the stop: requests are still on the exhausted login')
  env.changedAt = T0 + 1000
  env.room = false
  assert.deepEqual(await nudger.tick(), [])
  env.room = true
  assert.deepEqual(await nudger.tick(), ['P'])
})

test('re-checked at delivery: children resumed since, or a parent hidden since, get nothing', async () => {
  const { env, nudger } = harness({ list: [parent('P'), stopped('a1', 'P', T0), parent('Q'), stopped('b1', 'Q', T0)], changedAt: T0 + 1000 })
  env.fresh = [parent('P'), { ...stopped('a1', 'P', T0), bucket: 'building', limitStop: null }, parent('Q', { hidden: true }), stopped('b1', 'Q', T0)]
  assert.deepEqual(await nudger.tick(), [])
  assert.equal(env.sent.length, 0)
})

test('never a hidden, dead, Codex, sub-agent or Agentville parent; never the sub-agents themselves', async () => {
  const list = [
    parent('H', { hidden: true }), stopped('h', 'H', T0),
    parent('D', { live: false }), stopped('d', 'D', T0),
    parent('X', { harness: 'codex' }), stopped('x', 'X', T0),
    { ...parent('S'), kind: 'subagent', parentId: 'P0' }, stopped('s', 'S', T0),
    parent('claude-code:self'), stopped('m', 'claude-code:self', T0),
    stopped('o', 'GONE', T0),
  ]
  const { env, nudger } = harness({ list, changedAt: T0 + 1000 })
  assert.deepEqual(await nudger.tick(), [])
  assert.equal(env.sent.length, 0)
  assert.equal(parentProblem(parent('ok')), '')
})

test('a failed delivery is retried on the next tick, then sent once', async () => {
  const { env, nudger } = harness({ list: [parent('P'), stopped('a1', 'P', T0)], changedAt: T0 + 1000, deliverOk: false })
  assert.deepEqual(await nudger.tick(), [])
  env.deliverOk = true
  assert.deepEqual(await nudger.tick(), ['P'])
  assert.deepEqual(await nudger.tick(), [])
})

test('state survives a restart; a new incident later gets a new message', async () => {
  const first = harness({ list: [parent('P'), stopped('a1', 'P', T0)], changedAt: T0 + 1000 })
  assert.deepEqual(await first.nudger.tick(), ['P'])
  const again = harness({ list: first.env.list, changedAt: T0 + 1000, dir: first.dir })
  assert.deepEqual(await again.nudger.tick(), [], 'covered across a restart')
  again.env.list = [parent('P'), stopped('a1', 'P', T0), stopped('a9', 'P', T0 + 3600e3)]
  again.env.now = T0 + 3600e3 + 60_000
  assert.deepEqual(await again.nudger.tick(), [], 'the new stop is after the last change')
  again.env.changedAt = T0 + 3600e3 + 30_000
  assert.deepEqual(await again.nudger.tick(), ['P'])
  assert.match(again.env.sent[0].text, /^One of your sub-agents was stopped/)
  assert.match(again.env.sent[0].text, /a9/)
  assert.doesNotMatch(again.env.sent[0].text, /a1\b/, 'only the stops the parent has not been told about')
})

test('the toggle (default on) turns the nudge off', async () => {
  const { env, nudger } = harness({ list: [parent('P'), stopped('a1', 'P', T0)], changedAt: T0 + 1000 })
  assert.deepEqual(await nudger.info(), { enabled: true })
  await nudger.setEnabled(false)
  assert.deepEqual(await nudger.tick(), [])
  await assert.rejects(nudger.setEnabled('yes'), /true or false/)
  await nudger.setEnabled(true)
  assert.deepEqual(await nudger.tick(), ['P'])
  assert.equal(env.sent.length, 1)
})

test('stops older than MAX_AGE_MS are history', () => {
  const list = [parent('P'), stopped('a1', 'P', T0)]
  assert.equal(pending(list, { changedAt: T0 + 1, now: T0 + MAX_AGE_MS + 1 }).length, 0)
  assert.equal(pending(list, { changedAt: T0 + 1, now: T0 + 1000 }).length, 1)
  assert.match(nudgeText([{ kind: 'api', subId: 'z' }]), /^One of your sub-agents was stopped by an API error/)
})
