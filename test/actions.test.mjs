// Start / stop / fork, end to end against a stub `claude` (test/fixtures/bin/claude-bg) that only
// records its argv and writes fake job folders in the fixture home. No real agent is ever touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, IDS } from './fixtures/make-home.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'va-act-'))
const env = makeHome(root)
const STUB = fileURLToPath(new URL('./fixtures/bin/claude-bg', import.meta.url))
const log = path.join(root, 'claude-bg.log')
Object.assign(process.env, env, { AGENTVILLE_CLAUDE_BIN: STUB, AGENTVILLE_FAKE_CLAUDE_LOG: log })
const { createServer } = await import('../server/serve.mjs')
const A = await import('../server/actions.mjs')

const dataDir = path.join(root, 'data')
const server = createServer({ dataDir })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }) })
const get = async (p) => (await fetch(`${base}${p}`)).json()
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) })
const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const cwd = path.join(root, 'work', 'demo-app')
const C = (k) => `claude-code:${IDS[k]}`

test('start: every field is allowlisted; the prompt goes after `--` as one argument', () => {
  const projects = [{ dir: cwd, name: 'demo-app' }]
  const p = A.startPlan({ cwd, prompt: '--dangerously-skip-permissions; rm -rf ~', name: 'Docs bot', model: 'sonnet', effort: 'high', permissionMode: 'plan', worktree: true }, projects)
  assert.deepEqual(p.args, ['--bg', '--name=Docs bot', '--model=sonnet', '--effort=high', '--permission-mode=plan', '--worktree', '--', '--dangerously-skip-permissions; rm -rf ~'])
  assert.equal(p.cwd, cwd)
  assert.equal(A.display(p), "claude --bg '--name=Docs bot' --model=sonnet --effort=high --permission-mode=plan --worktree -- '--dangerously-skip-permissions; rm -rf ~'")
  assert.deepEqual(A.startPlan({ cwd, prompt: 'hi' }, projects).args, ['--bg', '--', 'hi'], 'defaults leave the flags out')
  const refuse = (body, re) => assert.throws(() => A.startPlan({ cwd, prompt: 'x', ...body }, projects), re)
  refuse({ cwd: '/etc' }, /Pick one of the listed projects/)
  refuse({ prompt: '   ' }, /Write a prompt/)
  refuse({ model: 'gpt-5' }, /Unknown model/)
  refuse({ permissionMode: 'bypassPermissions' }, /Unknown permission mode/)
  refuse({ effort: 'ultra' }, /Unknown effort/)
  refuse({ name: 'two\nlines' }, /one line/)
  refuse({ name: 'x'.repeat(81) }, /at most 80/)
  refuse({ prompt: 'x'.repeat(8001) }, /at most 8000/)
  refuse({ worktree: 'yes' }, /true or false/)
  refuse({ prompt: ['a'] }, /must be text/)
})

test('stop and fork: jobs and Claude conversations only, each refusal says why', () => {
  const job = { id: 'j', harness: 'claude-code', kind: 'job', jobId: 'abcd1234', name: 'Job', bucket: 'building', live: true }
  assert.deepEqual(A.stopPlan(job).args, ['stop', 'abcd1234'])
  assert.throws(() => A.stopPlan({ ...job, kind: 'session' }), /interactive session, not a background job/)
  assert.throws(() => A.stopPlan({ ...job, harness: 'codex' }), /Codex/)
  assert.throws(() => A.stopPlan({ ...job, kind: 'subagent' }), /stops with its lead/)
  assert.throws(() => A.stopPlan({ ...job, jobId: '../x' }), /no id/)
  const sid = IDS.soloTurn
  assert.deepEqual(A.forkPlan({ ...job, kind: 'session' }, { sid, cwd }, 'Try B').args, ['--resume', sid, '--fork-session', '--bg', '--name=Try B'])
  assert.throws(() => A.forkPlan({ ...job, harness: 'codex' }, { sid, cwd }), /Claude Code sessions only/)
  assert.throws(() => A.forkPlan(job, { sid: 'nope', cwd }), /no saved conversation/)
  assert.throws(() => A.forkPlan(job, { sid, cwd: path.join(root, 'gone') }), /no longer exists/)
})

test('under test, nothing runs without a fake home and a fake claude', () => {
  const bin = process.env.AGENTVILLE_CLAUDE_BIN
  delete process.env.AGENTVILLE_CLAUDE_BIN
  try { assert.match(A.actionsBlocked(), /disabled in tests/) } finally { process.env.AGENTVILLE_CLAUDE_BIN = bin }
  assert.equal(A.actionsBlocked(), '')
})

test('new agent: options list known projects; preview shows the command; run starts it once and it appears', async () => {
  const o = await get('/api/act/options')
  assert.equal(o.blocked, '')
  assert.ok(o.projects.some((p) => p.dir === cwd), 'the fixture project folder is offered')
  assert.ok(!o.modes.includes('bypassPermissions'))
  const pv = await (await post('/api/act/preview', { kind: 'start', cwd, prompt: 'Write the changelog', name: 'Changelog', model: 'haiku' })).json()
  assert.equal(pv.command, "claude --bg --name=Changelog --model=haiku -- 'Write the changelog'")
  assert.equal(pv.cwd, cwd)
  assert.equal(runs().length, 0, 'a preview runs nothing')
  const r = await (await post('/api/act/run', { confirm: pv.confirm })).json()
  assert.equal(r.ok, true)
  assert.match(r.jobId, /^[0-9a-f]{8}$/)
  const [call] = runs()
  assert.deepEqual(call.argv, ['--bg', '--name=Changelog', '--model=haiku', '--', 'Write the changelog'])
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(cwd))
  assert.equal((await post('/api/act/run', { confirm: pv.confirm })).status, 409, 'a confirmation runs once')
  const { agents } = await get('/api/agents')
  const born = agents.find((a) => a.jobId === r.jobId)
  assert.equal(born?.name, 'Changelog')
  assert.equal(born.bucket, 'building')
  // The log names the action and outcome, never the prompt.
  const logged = fs.readFileSync(path.join(dataDir, 'fleet-log.jsonl'), 'utf8')
  assert.match(logged, /"action":"start"/)
  assert.doesNotMatch(logged, /changelog/i)
})

test('stop: a background job stops; an interactive session is refused with the reason', async () => {
  const pv = await (await post('/api/act/preview', { kind: 'stop', id: C('leadCi') })).json()
  assert.equal(pv.command, `claude stop ${IDS.leadCi.slice(0, 8)}`)
  const r = await (await post('/api/act/run', { confirm: pv.confirm })).json()
  assert.equal(r.ok, true)
  assert.deepEqual(runs().at(-1).argv, ['stop', IDS.leadCi.slice(0, 8)])
  const { agents } = await get('/api/agents')
  assert.equal(agents.find((a) => a.id === C('leadCi')).bucket, 'resting')
  const no = await post('/api/act/preview', { kind: 'stop', id: C('soloTurn') })
  assert.equal(no.status, 409)
  assert.match((await no.json()).error, /interactive session/)
  const codex = await post('/api/act/preview', { kind: 'stop', id: `codex:${IDS.codexRunning}` })
  assert.match((await codex.json()).error, /Codex/)
})

test('fork: resumes the conversation as a new background copy, in its folder', async () => {
  const pv = await (await post('/api/act/preview', { kind: 'fork', id: C('soloTurn'), name: 'Explain v2' })).json()
  assert.equal(pv.command, `claude --resume ${IDS.soloTurn} --fork-session --bg '--name=Explain v2'`)
  const r = await (await post('/api/act/run', { confirm: pv.confirm })).json()
  assert.equal(r.ok, true)
  const call = runs().at(-1)
  assert.deepEqual(call.argv, ['--resume', IDS.soloTurn, '--fork-session', '--bg', '--name=Explain v2'])
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(cwd))
  // A job forks from its current conversation.
  const job = await (await post('/api/act/preview', { kind: 'fork', id: C('leadBlocked') })).json()
  assert.equal(job.command, `claude --resume ${IDS.leadBlocked} --fork-session --bg`)
})

test('guards: foreign origin, unknown kind, bad tokens, and the rate limit', async () => {
  assert.equal((await post('/api/act/preview', { kind: 'start', cwd, prompt: 'x' }, { origin: 'http://evil.test' })).status, 403)
  assert.equal((await post('/api/act/run', { confirm: 'x' }, { origin: 'http://evil.test' })).status, 403)
  assert.equal((await post('/api/act/preview', { kind: 'exec', command: 'rm -rf /' })).status, 400)
  assert.equal((await post('/api/act/run', { confirm: 'not-a-token' })).status, 409)
  // A message confirmation can't run a command.
  assert.equal((await post('/api/act/run', { confirm: crypto.randomUUID() })).status, 409)
  let last
  for (let i = 0; i < 12; i++) {
    const pv = await (await post('/api/act/preview', { kind: 'start', cwd, prompt: `n${i}` })).json()
    last = await post('/api/act/run', { confirm: pv.confirm })
    if (last.status === 429) break
  }
  assert.equal(last.status, 429, 'at most 10 starts, stops and forks a minute')
})

test('a failing claude is reported, not hidden', async () => {
  const plan = A.startPlan({ cwd, prompt: 'x' }, [{ dir: cwd, name: 'demo-app' }])
  process.env.FAKE_CLAUDE_FAIL = '1'
  try {
    const r = await A.run(plan)
    assert.equal(r.ok, false)
    assert.match(r.error, /exited with code 2/)
  } finally { delete process.env.FAKE_CLAUDE_FAIL }
})
