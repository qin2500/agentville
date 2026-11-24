import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fakeBin as shimBin, WIN } from './support/posix.mjs'
import { createRunner, parseEvents, startArgs, runEnv, isQuotaText, isAuthText, scrub, launchTarget, classifyTurn, joinDelta, QUOTA_RETRY_MS } from '../server/gemini/runner.mjs'

// The exact not-signed-in output of agy 1.5.16 (one stdout line, exit 1).
export const AUTH_FAIL_LINE = '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}}'

// A fake `agy`: records argv + env to $AGENTVILLE_FAKE_LOG, then emits agy stream-json per $AGENTVILLE_FAKE_MODE.
function fakeBin(dir) {
  return shimBin(dir, 'agy', `const fs = require('fs')
const a = process.argv.slice(2)
fs.appendFileSync(process.env.AGENTVILLE_FAKE_LOG, JSON.stringify({ a, upd: process.env.AGY_CLI_DISABLE_AUTO_UPDATE, agent: process.env.AGENTVILLE_AGENT_ID, handoff: process.env.AGENTVILLE_HANDOFF_ID, port: process.env.AGENTVILLE_PORT, secret: process.env.GEMINI_API_KEY, goog: process.env.GOOGLE_APPLICATION_CREDENTIALS, tok: process.env.AGENTVILLE_AGENT_TOKEN, cwd: process.cwd() }) + '\\n')
const i = a.indexOf('--conversation')
const conv = i >= 0 ? a[i + 1] : 'conv-' + Math.random().toString(16).slice(2, 10)
const mode = process.env.AGENTVILLE_FAKE_MODE || 'ok'
const out = (o) => console.log(JSON.stringify(o))
if (mode === 'auth') { console.log(${JSON.stringify(AUTH_FAIL_LINE)}); console.error('Authentication required. Please visit the URL to log in:'); process.exit(1) }
out({ event: 'init', conversation_id: conv, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'request-review', model: 'gemini-x' } })
if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'quota') { out({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: Model quota reached' } }); process.exit(1) }
else {
  out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'user_input' } })
  out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'a\\r\\n' } } })
  out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'h' } })
  out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'i' } })
  out({ event: 'brand_new_event', whatever: 1 })
  out({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: '', num_turns: 1, usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } })
}
`)
}

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timeout')
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyrun-'))
  const log = path.join(dir, 'calls.log')
  const bin = fakeBin(dir)
  const env = { ...process.env, AGENTVILLE_FAKE_LOG: log }
  const runner = createRunner({ dataDir: dir, bin, env, killGraceMs: 300 })
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { dir, runner, env, calls, log }
}

test('startArgs builds the agy command and maps modes; never a yolo flag', () => {
  assert.deepEqual(startArgs({ prompt: 'x', model: 'm' }), ['-p', 'x', '--output-format', 'stream-json', '--mode', 'accept-edits', '--model', 'm'])
  assert.deepEqual(startArgs({ prompt: 'y', mode: 'auto', resume: 'c1' }), ['-p', 'y', '--output-format', 'stream-json', '--mode', 'auto', '--conversation', 'c1'])
  assert.equal(startArgs({ prompt: 'z', mode: 'plan' })[5], 'plan')
  assert.equal(startArgs({ prompt: 'z', mode: 'auto_edit' })[5], 'accept-edits')
  assert.throws(() => startArgs({ prompt: 'x', mode: 'yolo' }), /unknown mode/)
  for (const m of ['', 'auto', 'plan', 'default']) assert.ok(!startArgs({ prompt: 'x', mode: m }).some((a) => /dangerously|skip-trust|approval-mode|session-id/.test(a)))
})

test('F1: model / conversation validated; flag-shaped prompt stays one inert token', () => {
  assert.throws(() => startArgs({ prompt: 'x', model: '--dangerously-skip-permissions' }), /invalid model/)
  assert.throws(() => startArgs({ prompt: 'x', model: 'a b' }), /invalid model/)
  assert.throws(() => startArgs({ prompt: 'x', resume: '--x' }), /invalid conversation/)
  const a = startArgs({ prompt: '--dangerously-skip-permissions' })
  assert.equal(a[1], ' --dangerously-skip-permissions')
  assert.equal(a.filter((x) => x === '--dangerously-skip-permissions').length, 0)
})

test('parseEvents: tolerant, init conversation id, joined deltas, result, unknown events ignored', () => {
  const t = ['noise', '{bad', JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model: 'm' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'lo' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Hello' } }), // full repeat
    JSON.stringify({ event: 'step_update', step_update: { step_index: 4, step_type: 'tool', tool_info: { name: 'x', error: { type: 'E', message: 'boom' } } } }),
    JSON.stringify({ event: 'mystery', x: [1] }), JSON.stringify([1, 2]), 'null',
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', usage: { total_tokens: 9 } } })].join('\r\n')
  const e = parseEvents(t)
  assert.equal(e.conversationId, 'c1'); assert.equal(e.sessionId, 'c1'); assert.equal(e.model, 'm')
  assert.equal(e.lastAssistant, 'Hello'); assert.equal(e.status, 'SUCCESS'); assert.deepEqual(e.toolErrors, ['boom'])
  assert.equal(e.usage.total_tokens, 9)
  assert.equal(parseEvents(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Final' } })).lastAssistant, 'Final')
  assert.equal(joinDelta('ab', 'c'), 'abc'); assert.equal(joinDelta('ab', 'abc'), 'abc')
  assert.doesNotThrow(() => parseEvents(JSON.stringify({ event: 'step_update', step_update: null })))
})

test('the real not-signed-in output parses as an auth error, not quota', () => {
  const e = parseEvents(AUTH_FAIL_LINE)
  assert.equal(e.status, 'ERROR'); assert.equal(e.error, 'authentication failed or timed out'); assert.equal(e.conversationId, null)
  const c = classifyTurn(e, { stderr: 'Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/x', exitCode: 1 })
  assert.equal(c.state, 'error'); assert.equal(c.auth, true); assert.match(c.error, /sign-in needed/)
  assert.ok(isAuthText('Authentication required.')); assert.ok(!isAuthText('all good'))
})

test('classifyTurn: quota on ERROR or stderr, strong text on SUCCESS, tool 429s ignored on success', () => {
  assert.equal(classifyTurn({ status: 'ERROR', error: 'Model quota reached' }, { exitCode: 1 }).state, 'limit')
  assert.equal(classifyTurn({ status: null }, { exitCode: 1, stderr: 'HTTP 429 Too Many Requests' }).state, 'limit')
  assert.equal(classifyTurn({ status: 'SUCCESS', response: 'You have exhausted your capacity on this model.' }, { exitCode: 0 }).state, 'limit')
  assert.equal(classifyTurn({ status: 'SUCCESS', response: 'I fixed the rate limit code', toolErrors: ['429'] }, { exitCode: 0 }).state, 'idle')
  assert.equal(classifyTurn({ status: 'ERROR', error: 'unknown model' }, { exitCode: 1 }).state, 'error')
  assert.equal(classifyTurn({ status: null }, { exitCode: null }).state, 'exited')
  assert.ok(isQuotaText('rate-limit hit')); assert.ok(!isQuotaText('syntax error'))
})

test('start runs a turn, records the conversation id, then resume passes --conversation', async () => {
  const { dir, runner, calls } = setup()
  const st = runner.start({ cwd: dir, prompt: 'hello', model: 'gemini-x', name: 'n', accountEnv: { AGENTVILLE_AGENT_TOKEN: 'tok' } })
  assert.equal(st.state, 'running'); assert.ok(st.pid)
  if (!WIN) assert.equal(fs.statSync(path.join(runner.dirOf(st.runId), 'state.json')).mode & 0o777, 0o600)
  const done = await waitFor(() => { const s = runner.refresh(st.runId); return s.state === 'idle' && s })
  assert.equal(done.lastMessage, 'hi'); assert.equal(done.exitCode, 0); assert.match(done.conversationId, /^conv-/)
  assert.equal(done.sessionId, done.conversationId); assert.equal(done.stats.total_tokens, 3)
  const first = calls()[0]
  assert.equal(first.upd, 'true'); assert.equal(first.agent, `gemini:${st.runId}`); assert.equal(first.tok, 'tok')
  assert.deepEqual(first.a.slice(0, 6), ['-p', 'hello', '--output-format', 'stream-json', '--mode', 'accept-edits'])
  assert.ok(!first.a.includes('--conversation'))
  runner.resume(st.runId, 'again')
  await waitFor(() => calls().length === 2)
  const second = calls()[1].a
  assert.deepEqual(second.slice(second.indexOf('--conversation'), second.indexOf('--conversation') + 2), ['--conversation', done.conversationId])
  await waitFor(() => runner.refresh(st.runId).state === 'idle' && runner.get(st.runId).turn === 2)
  assert.equal(runner.get(st.runId).conversationId, done.conversationId)
  assert.equal(runner.list().length, 1)
})

test('resume before agy reported a conversation id is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyrun-'))
  const runner = createRunner({ dataDir: dir, env: { PATH: '' }, isAlive: () => false, bin: 'agy', spawn: () => ({ pid: 99, on() {}, unref() {} }) })
  const st = runner.start({ cwd: dir, prompt: 'p' })
  assert.throws(() => runner.resume(st.runId, 'x'), /no conversation id/)
})

test('quota error records a limitStop with a cautious 5h retry', async () => {
  const { dir, env, runner } = setup()
  env.AGENTVILLE_FAKE_MODE = 'quota'
  const st = runner.start({ cwd: dir, prompt: 'q' })
  const s = await waitFor(() => { const r = runner.refresh(st.runId); return r.state === 'limit' && r }, 20000)
  assert.equal(s.limitStop.kind, 'limit'); assert.match(s.limitStop.text, /quota/)
  assert.equal(s.limitStop.resetsAt - s.limitStop.at, QUOTA_RETRY_MS)
})

test('not signed in: the run ends as an auth error (authNeeded), never a limit', async () => {
  const { dir, env, runner } = setup()
  env.AGENTVILLE_FAKE_MODE = 'auth'
  const st = runner.start({ cwd: dir, prompt: 'a' })
  const s = await waitFor(() => { const r = runner.refresh(st.runId); return r.state !== 'running' && r.state !== 'starting' && r }, 20000)
  assert.equal(s.state, 'error'); assert.equal(s.authNeeded, true); assert.match(s.error, /sign-in/)
})

test('stop terminates a hung run', async () => {
  const { dir, env, runner } = setup()
  env.AGENTVILLE_FAKE_MODE = 'hang'
  const st = runner.start({ cwd: dir, prompt: 'h' })
  await new Promise((r) => setTimeout(r, 300))
  const s = await runner.stop(st.runId)
  assert.equal(s.state, 'stopped')
  await waitFor(() => { try { process.kill(st.pid, 0); return false } catch { return true } })
})

test('stop on win32 uses taskkill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyrun-'))
  const hits = []
  const runner = createRunner({ dataDir: dir, platform: 'win32', env: { PATH: '' }, isAlive: () => true, taskkill: (p) => hits.push(p),
    spawn: () => ({ pid: 4242, on() {}, unref() {} }), bin: 'agy.exe' })
  const st = runner.start({ cwd: dir, prompt: 'p' })
  await runner.stop(st.runId)
  assert.deepEqual(hits, [4242])
})

test('F7: env is an allowlist plus AGY_CLI_DISABLE_AUTO_UPDATE; no Gemini CLI env', async () => {
  const e = runEnv({ base: { PATH: '/bin', HOME: '/h', LC_ALL: 'C', HTTPS_PROXY: 'p', AGENTVILLE_X: '1', DBUS_SESSION_BUS_ADDRESS: 'd', XDG_RUNTIME_DIR: '/r', GEMINI_API_KEY: 'k', GOOGLE_APPLICATION_CREDENTIALS: 'g', GEMINI_CLI_HOME: '/old', AGY_ADC_AUTH: 'true', AWS_SECRET: 's', OPENAI_API_KEY: 'o' },
    accountEnv: { AGENTVILLE_AGENT_TOKEN: 't' }, port: 4321, handoffId: 'H1' })
  assert.equal(e.PATH, '/bin'); assert.equal(e.LC_ALL, 'C'); assert.equal(e.HTTPS_PROXY, 'p'); assert.equal(e.AGENTVILLE_X, '1')
  assert.equal(e.DBUS_SESSION_BUS_ADDRESS, 'd'); assert.equal(e.XDG_RUNTIME_DIR, '/r')
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_CLI_HOME', 'AGY_ADC_AUTH', 'AWS_SECRET', 'OPENAI_API_KEY', 'GEMINI_CLI_NO_RELAUNCH']) assert.equal(e[k], undefined, k)
  assert.equal(e.AGY_CLI_DISABLE_AUTO_UPDATE, 'true'); assert.equal(e.AGENTVILLE_AGENT_TOKEN, 't')
  assert.equal(e.AGENTVILLE_PORT, '4321'); assert.equal(e.AGENTVILLE_HANDOFF_ID, 'H1')

  const { dir, runner, env, calls } = setup()
  env.GEMINI_API_KEY = 'leak'; env.GOOGLE_APPLICATION_CREDENTIALS = 'leak2'
  const st = runner.start({ cwd: dir, prompt: 'p', handoffId: 'H2' })
  assert.equal(st.handoffId, 'H2')
  await waitFor(() => calls().length === 1)
  const c = calls()[0]
  assert.equal(c.handoff, 'H2'); assert.equal(c.secret, undefined); assert.equal(c.goog, undefined)
})

test('F10: 0700 dirs, no prompt text in state, capped + redacted errors, prune', async () => {
  const { dir, runner, env } = setup()
  env.AGENTVILLE_FAKE_MODE = 'quota'
  const secretPrompt = 'my secret instructions '.repeat(20)
  const st = runner.start({ cwd: dir, prompt: secretPrompt })
  if (!WIN) {
    assert.equal(fs.statSync(path.join(dir, 'gemini-runs')).mode & 0o777, 0o700)
    assert.equal(fs.statSync(runner.dirOf(st.runId)).mode & 0o777, 0o700)
  }
  assert.ok(st.title.length <= 80); assert.equal(st.prompt, undefined)
  await waitFor(() => runner.refresh(st.runId).state === 'limit', 20000)
  assert.ok(!fs.readFileSync(path.join(runner.dirOf(st.runId), 'state.json'), 'utf8').includes('secret instructions secret instructions'))
  const t = scrub('failed key=AIzaSyA1234567890abcdefghijk Bearer abcdefgh12345678 ' + 'x'.repeat(500))
  assert.ok(t.length <= 200); assert.ok(!/AIza|abcdefgh12345678/.test(t)); assert.match(t, /redacted/)
  const old = path.join(dir, 'gemini-runs', 'old-run')
  fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'state.json'), '{"state":"idle"}')
  const past = new Date(Date.now() - 30 * 86_400_000); fs.utimesSync(old, past, past)
  assert.deepEqual(runner.prune(14), ['old-run'])
  assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(runner.dirOf(st.runId)))
})

test('launchTarget: POSIX/agy.exe spawn the bin directly; a Windows .cmd shim runs under a node launcher', () => {
  assert.deepEqual(launchTarget('/x/agy', ['-p', 'a'], { platform: 'darwin' }), { file: '/x/agy', args: ['-p', 'a'], opts: {}, env: {} })
  const t = launchTarget('C:\\g\\agy.cmd', ['-p', 'a b'], { platform: 'win32', env: { ComSpec: 'C:\\cmd.exe' }, execPath: 'C:\\node.exe', electron: true })
  assert.equal(t.file, 'C:\\node.exe'); assert.equal(t.args[0], '-e'); assert.equal(t.args[2], '--')
  assert.deepEqual(t.env, { ELECTRON_RUN_AS_NODE: '1' })
  const inner = JSON.parse(t.args[3])
  assert.equal(inner.file, 'C:\\cmd.exe'); assert.deepEqual(inner.args.slice(0, 3), ['/d', '/s', '/c']); assert.equal(inner.opts.windowsVerbatimArguments, true)
  const exe = launchTarget('C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe', ['-p', 'x'], { platform: 'win32', electron: true })
  assert.equal(exe.file, 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe'); assert.deepEqual(exe.env, {})
})
