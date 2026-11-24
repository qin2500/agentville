import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import claude from '../server/providers/claude.mjs'
import { eventsOf, readTranscript } from '../server/providers/claude-transcript.mjs'
import { respawnArgs, resumeArgs } from '../server/restore.mjs'

const SID = '11111111-2222-3333-4444-555555555555'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agv-p3-'))

test('adapter shape', async () => {
  assert.equal(claude.id, 'claude')
  assert.equal(claude.harness, 'claude-code')
  for (const k of ['home', 'available', 'bin', 'scan', 'configure', 'activity', 'options', 'startPlan', 'resumePlan', 'stopPlan', 'forkPlan', 'display', 'run', 'isLimitText', 'limitModel', 'readTranscript']) {
    assert.equal(typeof claude[k], 'function', k)
  }
  assert.deepEqual(claude.sessionEnv, ['CLAUDE_CODE_SESSION_ID'])
  assert.ok(claude.options().models.includes('opus'))
  assert.throws(() => claude.accounts, /not configured/)
  const fake = { accounts: { readLive: async () => 'x' } }
  claude.configure({ account: fake })
  assert.equal(claude.accounts, fake.accounts)
  assert.equal(claude.switcher, fake)
  assert.equal(await claude.credentials.read(), 'x')
  claude.configure({ account: null })
})

test('limit text and plans carry provider', () => {
  assert.equal(claude.isLimitText("You've hit your Opus weekly limit"), true)
  assert.equal(claude.isLimitText('hello'), false)
  assert.equal(claude.limitModel("You've hit your Opus weekly limit"), 'opus')
  const dir = tmp()
  const p = claude.startPlan({ cwd: dir, prompt: 'hi', name: 'n' }, [])
  assert.equal(p.provider, 'claude')
  assert.equal(p.kind, 'start')
  assert.match(claude.display(p), /^claude --bg/)
})

test('stopPlan stamps provider and rejects sessions', () => {
  const job = { harness: 'claude-code', kind: 'job', jobId: 'abcdef12', id: 'j', bucket: 'building' }
  assert.equal(claude.stopPlan(job).provider, 'claude')
  assert.throws(() => claude.stopPlan({ ...job, kind: 'session' }), /interactive session/)
})

test('respawnArgs and resumeArgs', () => {
  const cwd = tmp()
  assert.deepEqual(respawnArgs('abcdef12', { cwd }), { args: ['respawn', 'abcdef12'], cwd })
  assert.equal(respawnArgs('abcdef12', null).cwd, os.homedir())
  const r = resumeArgs({ sessionId: SID, cwd })
  assert.deepEqual(r.args.slice(0, 3), ['--bg', '--resume', SID])
  assert.equal(r.cwd, cwd)
  assert.match(resumeArgs({ sessionId: 'nope', cwd }).unavailable, /session id/)
  assert.match(resumeArgs({ sessionId: SID, cwd: '/nonexistent-dir-xyz' }).unavailable, /folder/)
})

test('resumePlan prefers respawn of the job', () => {
  const home = tmp()
  const cwd = tmp()
  fs.mkdirSync(path.join(home, 'jobs', 'abcdef12'), { recursive: true })
  fs.writeFileSync(path.join(home, 'jobs', 'abcdef12', 'state.json'), JSON.stringify({ sessionId: SID, cwd }))
  const old = process.env.AGENTVILLE_CLAUDE_HOME
  process.env.AGENTVILLE_CLAUDE_HOME = home
  try {
    const agent = { id: 'a', name: 'A', jobId: 'abcdef12' }
    const p = claude.resumePlan(agent)
    assert.equal(p.kind, 'resume')
    assert.deepEqual(p.args, ['respawn', 'abcdef12'])
    assert.equal(p.provider, 'claude')
    const q = claude.resumePlan(agent, { prompt: 'go on' })
    assert.deepEqual(q.args.slice(0, 3), ['--bg', '--resume', SID])
    assert.equal(q.args.at(-1), 'go on')
  } finally { if (old === undefined) delete process.env.AGENTVILLE_CLAUDE_HOME; else process.env.AGENTVILLE_CLAUDE_HOME = old }
})

test('activity: limit stop, session bucket', async () => {
  assert.equal(await claude.activity({ id: 's', bucket: 'building' }), 'busy')
  assert.equal(await claude.activity({ id: 's', bucket: 'resting' }), 'idle')
  assert.equal(await claude.activity({ id: 's', limitStopAt: 5 }), 'limit')
})

const rec = (type, content, extra = {}) => ({ type, timestamp: '2026-01-01T00:00:00Z', message: { role: type, content }, ...extra })

test('eventsOf normalizes text, tools, todos', () => {
  const ev = eventsOf([
    rec('user', 'fix the bug'),
    rec('assistant', [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a/b.js' } },
      { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'pending' }] } }]),
    rec('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    rec('assistant', [{ type: 'text', text: 'side' }], { isSidechain: true }),
    { type: 'summary' },
  ])
  assert.deepEqual(ev.map((e) => e.role), ['user', 'assistant', 'tool', 'tool'])
  assert.equal(ev[0].text, 'fix the bug')
  assert.deepEqual(ev[2].tool, { name: 'Edit', files: ['/a/b.js'], done: true })
  assert.equal(ev[3].tool.done, false)
  assert.deepEqual(ev[3].todo, [{ text: 'one', done: true }, { text: 'two', done: false }])
  assert.equal(ev[0].at, Date.parse('2026-01-01T00:00:00Z'))
})

test('readTranscript is bounded, tolerant and never rejects', async () => {
  const dir = tmp()
  const file = path.join(dir, 's.jsonl')
  const lines = []
  for (let i = 0; i < 200; i++) lines.push(JSON.stringify(rec(i % 2 ? 'assistant' : 'user', `message ${i}`)))
  fs.writeFileSync(file, `${lines.join('\n')}\n{"broken`)
  const ev = await readTranscript({ transcriptFile: file }, { maxBytes: 2000 })
  assert.ok(ev.length > 0 && ev.length < 200)
  assert.equal(ev.at(-1).text, 'message 199')
  assert.deepEqual(await readTranscript({ transcriptFile: path.join(dir, 'missing') }, { maxBytes: 100 }), [])
  assert.deepEqual(await readTranscript({}, { maxBytes: 100 }), [])
})
