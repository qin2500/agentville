import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fakeBin as shimBin, WIN } from './support/posix.mjs'
import { createRunner, parseEvents, startArgs, runEnv, isQuotaText, scrub } from '../server/gemini/runner.mjs'

// A fake `gemini`: records argv + env to $AGENTVILLE_FAKE_LOG, then behaves per $AGENTVILLE_FAKE_MODE.
function fakeBin(dir) {
  return shimBin(dir, 'gemini', `const fs = require('fs')
const a = process.argv.slice(2)
fs.appendFileSync(process.env.AGENTVILLE_FAKE_LOG, JSON.stringify({ a, home: process.env.GEMINI_CLI_HOME, norelaunch: process.env.GEMINI_CLI_NO_RELAUNCH, agent: process.env.AGENTVILLE_AGENT_ID, handoff: process.env.AGENTVILLE_HANDOFF_ID, port: process.env.AGENTVILLE_PORT, secret: process.env.GEMINI_API_KEY, goog: process.env.GOOGLE_APPLICATION_CREDENTIALS, enc: process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE, cwd: process.cwd() }) + '\\n')
const flag = (n) => (a.find((x) => x.startsWith(n + '=')) || '').slice(n.length + 1)
const sid = flag('--session-id') || flag('--resume')
const mode = process.env.AGENTVILLE_FAKE_MODE || 'ok'
const out = (o) => console.log(JSON.stringify(o))
out({ type: 'init', session_id: sid, model: 'gemini-2.5-flash' })
if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'quota') { out({ type: 'result', status: 'error', error: { type: 'Error', message: '[API Error: You have exhausted your daily quota on this model.]' } }); process.exit(173) }
else { out({ type: 'message', role: 'assistant', content: 'hi', delta: true }); out({ type: 'result', status: 'success', stats: { total_tokens: 3 } }) }
`)
}

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timeout')
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemrun-'))
  const log = path.join(dir, 'calls.log')
  const bin = fakeBin(dir)
  const env = { ...process.env, AGENTVILLE_FAKE_LOG: log }
  const runner = createRunner({ dataDir: dir, bin, env, killGraceMs: 300 })
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { dir, runner, env, calls, log }
}

test('startArgs builds the documented command, resume swaps the flag', () => {
  assert.deepEqual(startArgs({ prompt: 'x', model: 'm', mode: 'yolo', sessionId: 'S', allowYolo: true }), ['--prompt=x', '-o', 'stream-json', '--skip-trust', '--approval-mode=yolo', '--model=m', '--session-id=S'])
  const r = startArgs({ prompt: 'y', mode: 'bogus', sessionId: 'S', resume: 'R' })
  assert.deepEqual(r, ['--prompt=y', '-o', 'stream-json', '--skip-trust', '--approval-mode=default', '--resume=R'])
  assert.equal(runEnv({ base: {}, home: '/h', agentId: 'a' }).GEMINI_CLI_NO_RELAUNCH, 'true')
})

test('parseEvents tolerates junk and finds session, result, error', () => {
  const e = parseEvents('noise\n{"type":"init","session_id":"s1","model":"m"}\n{bad\n{"type":"result","status":"error","error":{"message":"boom"}}\n')
  assert.equal(e.sessionId, 's1'); assert.equal(e.result, 'error'); assert.equal(e.error, 'boom')
  assert.ok(isQuotaText('You have exhausted your daily quota')); assert.ok(!isQuotaText('syntax error'))
})

test('start runs a turn, records state, then resume reuses the session id', async () => {
  const { dir, runner, calls } = setup()
  const st = runner.start({ cwd: dir, prompt: 'hello', mode: 'yolo', allowYolo: true, model: 'gemini-2.5-flash', home: '/acct/home', name: 'n' })
  assert.equal(st.state, 'running'); assert.ok(st.pid)
  const mode = fs.statSync(path.join(runner.dirOf(st.runId), 'state.json')).mode & 0o777
  if (!WIN) assert.equal(mode, 0o600)
  const done = await waitFor(() => { const s = runner.refresh(st.runId); return s.state === 'idle' && s })
  assert.equal(done.lastMessage, 'hi'); assert.equal(done.exitCode, 0)
  const first = calls()[0]
  assert.equal(first.home, '/acct/home'); assert.equal(first.norelaunch, 'true'); assert.equal(first.agent, `gemini:${st.runId}`)
  assert.ok(first.a.some((x) => x.startsWith('--session-id=')) && first.a.includes('--approval-mode=yolo'))
  runner.resume(st.runId, 'again', { allowYolo: true })
  await waitFor(() => calls().length === 2)
  const second = calls()[1].a
  assert.ok(second.includes(`--resume=${st.sessionId}`))
  assert.ok(!second.some((x) => x.startsWith('--session-id')))
  await waitFor(() => runner.refresh(st.runId).state === 'idle' && runner.get(st.runId).turn === 2)
  assert.equal(runner.list().length, 1)
})

test('quota error (exit 173 + result.error) records a limitStop', async () => {
  const { dir, env, runner } = setup()
  env.AGENTVILLE_FAKE_MODE = 'quota'
  const st = runner.start({ cwd: dir, prompt: 'q' })
  const s = await waitFor(() => { const r = runner.refresh(st.runId); return r.state === 'limit' && r?.limitStop && r }, 20000)
  assert.equal(s.limitStop.kind, 'limit'); assert.ok(s.limitStop.at > 0); assert.match(s.limitStop.text, /daily quota/)
  assert.equal(s.exitCode, 173)
})

test('skipTrust option: --skip-trust only when true (default true)', () => {
  assert.ok(startArgs({ prompt: 'x' }).includes('--skip-trust'))
  assert.ok(startArgs({ prompt: 'x', skipTrust: true }).includes('--skip-trust'))
  assert.ok(!startArgs({ prompt: 'x', skipTrust: false }).includes('--skip-trust'))
  const seen = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemrun-'))
  const runner = createRunner({ dataDir: dir, env: { PATH: '' }, isAlive: () => true, bin: 'gemini',
    spawn: (_b, argv) => { seen.push(argv); return { pid: 99, on() {}, unref() {} } } })
  const st = runner.start({ cwd: dir, prompt: 'p', skipTrust: false })
  assert.ok(!seen[0].includes('--skip-trust'))
  runner.start({ cwd: dir, prompt: 'p' })
  assert.ok(seen[1].includes('--skip-trust'))
  assert.ok(st.runId)
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemrun-'))
  const hits = []
  const runner = createRunner({ dataDir: dir, platform: 'win32', env: { PATH: '' }, isAlive: () => true, taskkill: (p) => hits.push(p),
    spawn: () => ({ pid: 4242, on() {}, unref() {} }), bin: 'gemini.exe' })
  const st = runner.start({ cwd: dir, prompt: 'p' })
  await runner.stop(st.runId)
  assert.deepEqual(hits, [4242])
})

test('F1: model is validated and flag-shaped values stay inert', () => {
  assert.throws(() => startArgs({ prompt: 'x', model: '--approval-mode=yolo' }), /invalid model/)
  assert.throws(() => startArgs({ prompt: 'x', model: 'a b' }), /invalid model/)
  assert.throws(() => startArgs({ prompt: 'x', resume: '--x' }), /invalid session/)
  const a = startArgs({ prompt: '--approval-mode=yolo', model: 'gemini-2.5-pro' })
  assert.equal(a[0], '--prompt=--approval-mode=yolo') // one inert token
  assert.equal(a.filter((x) => x.startsWith('--approval-mode')).length, 1)
  assert.ok(a.includes('--approval-mode=default'))
  const { dir, runner } = setup()
  assert.throws(() => runner.start({ cwd: dir, prompt: 'p', model: '--approval-mode=yolo' }), /invalid model/)
  assert.deepEqual(runner.list(), [])
})

test('F2: yolo needs explicit allowYolo', () => {
  assert.throws(() => startArgs({ prompt: 'x', mode: 'yolo' }), /allowYolo/)
  assert.throws(() => startArgs({ prompt: 'x', mode: 'yolo', allowYolo: 'true' }), /allowYolo/)
  const { dir, runner } = setup()
  assert.throws(() => runner.start({ cwd: dir, prompt: 'p', mode: 'yolo' }), /allowYolo/)
})

test('F7: env is an allowlist, account env merged whole, handoff recorded', async () => {
  const e = runEnv({ base: { PATH: '/bin', HOME: '/h', LC_ALL: 'C', HTTPS_PROXY: 'p', AGENTVILLE_X: '1', GEMINI_API_KEY: 'k', GOOGLE_APPLICATION_CREDENTIALS: 'g', GEMINI_CLI_HOME: '/old', AWS_SECRET: 's', OPENAI_API_KEY: 'o' },
    accountEnv: { GEMINI_CLI_HOME: '/acct', GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true' }, port: 4321, handoffId: 'H1' })
  assert.equal(e.PATH, '/bin'); assert.equal(e.LC_ALL, 'C'); assert.equal(e.HTTPS_PROXY, 'p'); assert.equal(e.AGENTVILLE_X, '1')
  assert.equal(e.GEMINI_API_KEY, undefined); assert.equal(e.GOOGLE_APPLICATION_CREDENTIALS, undefined)
  assert.equal(e.AWS_SECRET, undefined); assert.equal(e.OPENAI_API_KEY, undefined)
  assert.equal(e.GEMINI_CLI_HOME, '/acct'); assert.equal(e.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE, 'true')
  assert.equal(e.AGENTVILLE_PORT, '4321'); assert.equal(e.AGENTVILLE_HANDOFF_ID, 'H1')
  assert.equal(runEnv({ base: { GEMINI_CLI_HOME: '/old' } }).GEMINI_CLI_HOME, undefined)
  assert.equal(runEnv({ base: { AGENTVILLE_HANDOFF_ID: 'keep' } }).AGENTVILLE_HANDOFF_ID, 'keep')

  const { dir, runner, env, calls } = setup()
  env.GEMINI_API_KEY = 'leak'; env.GOOGLE_APPLICATION_CREDENTIALS = 'leak2'
  const st = runner.start({ cwd: dir, prompt: 'p', handoffId: 'H2', accountEnv: { GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true' } })
  assert.equal(st.handoffId, 'H2')
  await waitFor(() => calls().length === 1)
  const c = calls()[0]
  assert.equal(c.handoff, 'H2'); assert.equal(c.enc, 'true'); assert.equal(c.secret, undefined); assert.equal(c.goog, undefined)
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
  await waitFor(() => runner.refresh(st.runId).state === 'limit')
  assert.ok(!fs.readFileSync(path.join(runner.dirOf(st.runId), 'state.json'), 'utf8').includes('secret instructions secret instructions'))

  const t = scrub('failed key=AIzaSyA1234567890abcdefghijk Bearer abcdefgh12345678 ' + 'x'.repeat(500))
  assert.ok(t.length <= 200); assert.ok(!/AIza|abcdefgh12345678/.test(t)); assert.match(t, /redacted/)

  const old = path.join(dir, 'gemini-runs', 'old-run')
  fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'state.json'), '{"state":"idle"}')
  const past = new Date(Date.now() - 30 * 86_400_000); fs.utimesSync(old, past, past)
  assert.deepEqual(runner.prune(14), ['old-run'])
  assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(runner.dirOf(st.runId)))
})

// TEMP PROBE (win debug): remove before landing.
test('TEMP probe windows stdio variants', { skip: !WIN }, async () => {
  const { spawn } = await import('node:child_process')
  const { execTarget } = await import('../server/platform.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'))
  const bin = shimBin(dir, 'p', `console.log(JSON.stringify({ hi: 1, argv: process.argv.slice(2) })); process.stderr.write('ERR\\n'); process.exit(7)`)
  const node = path.join(dir, 'p.cjs')
  const res = {}
  const run = (name, file, args, opts, flag = 'a') => new Promise((resolve) => {
    const out = path.join(dir, name + '.out'), err = path.join(dir, name + '.err')
    const o = fs.openSync(out, flag), e = fs.openSync(err, flag)
    let c
    try { c = spawn(file, args, { stdio: ['ignore', o, e], windowsHide: true, ...opts }) } finally { fs.closeSync(o); fs.closeSync(e) }
    c.on('error', (x) => { res[name] = 'spawnerr ' + x.message; resolve() })
    c.on('exit', (code) => setTimeout(() => { res[name] = { code, out: fs.readFileSync(out, 'utf8'), err: fs.readFileSync(err, 'utf8') }; resolve() }, 500))
  })
  const t = execTarget(bin, ['--prompt=hello world', '-o', 'x'])
  await run('A_cmd_detached', t.file, t.args, { ...t.opts, detached: true })
  await run('B_cmd_attached', t.file, t.args, { ...t.opts, detached: false })
  await run('E_cmd_detached_w', t.file, t.args, { ...t.opts, detached: true }, 'w')
  await run('D_node_detached', process.execPath, [node, '--prompt=x'], { detached: true })
  await run('F_cmd_detached_nohide', t.file, t.args, { ...t.opts, detached: true, windowsHide: false })
  assert.fail('PROBE ' + JSON.stringify({ t, env: Object.keys(process.env).filter((k) => /^(path|comspec|systemroot|pathext)$/i.test(k)), res }, null, 1))
})
