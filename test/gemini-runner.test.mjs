import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRunner, parseEvents, startArgs, runEnv, isQuotaText } from '../server/gemini/runner.mjs'

// A fake `gemini`: records argv + env to $FAKE_LOG, then behaves per $FAKE_MODE.
function fakeBin(dir) {
  const f = path.join(dir, 'gemini')
  fs.writeFileSync(f, `#!/usr/bin/env node
const fs = require('fs')
const a = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ a, home: process.env.GEMINI_CLI_HOME, norelaunch: process.env.GEMINI_CLI_NO_RELAUNCH, agent: process.env.AGENTVILLE_AGENT_ID, cwd: process.cwd() }) + '\\n')
const sid = a[a.indexOf('--session-id') + 1] || a[a.indexOf('-r') + 1]
const mode = process.env.FAKE_MODE || 'ok'
const out = (o) => console.log(JSON.stringify(o))
out({ type: 'init', session_id: sid, model: 'gemini-2.5-flash' })
if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'quota') { out({ type: 'result', status: 'error', error: { type: 'Error', message: '[API Error: You have exhausted your daily quota on this model.]' } }); process.exit(173) }
else { out({ type: 'message', role: 'assistant', content: 'hi', delta: true }); out({ type: 'result', status: 'success', stats: { total_tokens: 3 } }) }
`, { mode: 0o755 })
  return f
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
  const env = { ...process.env, FAKE_LOG: log }
  const runner = createRunner({ dataDir: dir, bin, env, killGraceMs: 300 })
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  return { dir, runner, env, calls, log }
}

test('startArgs builds the documented command, resume swaps the flag', () => {
  assert.deepEqual(startArgs({ prompt: 'x', model: 'm', mode: 'yolo', sessionId: 'S' }), ['-p', 'x', '-o', 'stream-json', '--skip-trust', '--approval-mode', 'yolo', '-m', 'm', '--session-id', 'S'])
  const r = startArgs({ prompt: 'y', mode: 'bogus', sessionId: 'S', resume: 'R' })
  assert.deepEqual(r, ['-p', 'y', '-o', 'stream-json', '--skip-trust', '--approval-mode', 'default', '-r', 'R'])
  assert.equal(runEnv({ base: {}, home: '/h', agentId: 'a' }).GEMINI_CLI_NO_RELAUNCH, 'true')
})

test('parseEvents tolerates junk and finds session, result, error', () => {
  const e = parseEvents('noise\n{"type":"init","session_id":"s1","model":"m"}\n{bad\n{"type":"result","status":"error","error":{"message":"boom"}}\n')
  assert.equal(e.sessionId, 's1'); assert.equal(e.result, 'error'); assert.equal(e.error, 'boom')
  assert.ok(isQuotaText('You have exhausted your daily quota')); assert.ok(!isQuotaText('syntax error'))
})

test('start runs a turn, records state, then resume reuses the session id', async () => {
  const { dir, runner, calls } = setup()
  const st = runner.start({ cwd: dir, prompt: 'hello', mode: 'yolo', model: 'gemini-2.5-flash', home: '/acct/home', name: 'n' })
  assert.equal(st.state, 'running'); assert.ok(st.pid)
  const mode = fs.statSync(path.join(runner.dirOf(st.runId), 'state.json')).mode & 0o777
  assert.equal(mode, 0o600)
  const done = await waitFor(() => { const s = runner.refresh(st.runId); return s.state === 'idle' && s })
  assert.equal(done.lastMessage, 'hi'); assert.equal(done.exitCode, 0)
  const first = calls()[0]
  assert.equal(first.home, '/acct/home'); assert.equal(first.norelaunch, 'true'); assert.equal(first.agent, `gemini:${st.runId}`)
  assert.ok(first.a.includes('--session-id') && first.a.includes('yolo'))
  runner.resume(st.runId, 'again')
  await waitFor(() => calls().length === 2)
  const second = calls()[1].a
  assert.equal(second[second.indexOf('-r') + 1], st.sessionId)
  assert.ok(!second.includes('--session-id'))
  await waitFor(() => runner.refresh(st.runId).state === 'idle' && runner.get(st.runId).turn === 2)
  assert.equal(runner.list().length, 1)
})

test('quota error (exit 173 + result.error) records a limitStop', async () => {
  const { dir, env, runner } = setup()
  env.FAKE_MODE = 'quota'
  const st = runner.start({ cwd: dir, prompt: 'q' })
  const s = await waitFor(() => { const r = runner.refresh(st.runId); return r.state === 'limit' && r })
  assert.equal(s.limitStop.kind, 'limit'); assert.ok(s.limitStop.at > 0); assert.match(s.limitStop.text, /daily quota/)
  assert.equal(s.exitCode, 173)
})

test('stop terminates a hung run', async () => {
  const { dir, env, runner } = setup()
  env.FAKE_MODE = 'hang'
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
