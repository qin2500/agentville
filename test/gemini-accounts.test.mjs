import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeBin, WIN } from './support/posix.mjs'
import { createGeminiAccounts, probeSignIn, ACCOUNT_ID, DEFAULT_LABEL, AGY_MISSING_MESSAGE, PROBE_PRINT_TIMEOUT } from '../server/gemini/accounts.mjs'

const AUTH_FAIL_LINE = '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}}'
const tmpData = () => fsp.mkdtemp(path.join(os.tmpdir(), 'agv-agy-acct-'))
const BIN = '/opt/bin/agy'
const mk = async (probeResult = { ok: true }, extra = {}) => {
  const dataDir = await tmpData()
  const probes = []
  const g = createGeminiAccounts({ dataDir, bin: async () => BIN, probe: async (o) => { probes.push(o); return typeof probeResult === 'function' ? probeResult() : probeResult }, ...extra })
  return { dataDir, g, probes }
}

test('addStart with no agy is a 409 gemini_missing with the install hint, and leaves no pending state', async () => {
  const dataDir = await tmpData()
  const g = createGeminiAccounts({ dataDir })
  await assert.rejects(g.accounts.addStart({ bin: null }), (e) => {
    assert.equal(e.status, 409)
    assert.deepEqual(e.body, { error: 'gemini_missing', message: AGY_MISSING_MESSAGE })
    assert.match(e.message, /antigravity\.google\/cli\/install\.sh/)
    assert.match(e.message, /install\.ps1/)
    return true
  })
  assert.equal(fs.existsSync(path.join(dataDir, 'accounts', 'gemini', 'pending-add.json')), false)
  const ok = await g.accounts.addStart({ bin: BIN })
  assert.equal(ok.command, 'agy')
})

test('addStart opens plain agy with the PATH fix; a second add within 10 min is in progress unless forced', async () => {
  const { g } = await mk()
  const s = await g.accounts.addStart({ bin: BIN })
  if (!WIN) assert.deepEqual(s.argv, ['/usr/bin/env', `PATH=${[path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(':')}`, BIN])
  assert.deepEqual(s.env, {})
  assert.equal((await g.accounts.list()).adding, true)
  await assert.rejects(g.accounts.addStart({ bin: BIN }), (e) => e.code === 'add_in_progress')
  assert.ok(await g.accounts.addStart({ bin: BIN, force: true }))
  await g.accounts.addCancel()
  assert.equal((await g.accounts.list()).adding, false)
})

test('Windows sign-in argv runs agy under cmd /k and refuses unsafe paths', async () => {
  const { g } = await mk({ ok: true }, { platform: 'win32' })
  const argv = g.loginArgv('C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe')
  assert.deepEqual(argv.slice(1), ['/d', '/k', 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe'])
  assert.throws(() => g.loginArgv('C:\\a&b\\agy.exe'), /cmd\.exe/)
})

test("I've signed in: probe ok saves one entry (default label), list shows it; switcher is null", async () => {
  const { g, probes } = await mk()
  assert.equal(g.switcher, null)
  assert.deepEqual((await g.accounts.list()).accounts, [])
  assert.equal(await g.accounts.signedIn(), false)
  await g.accounts.addStart({ bin: BIN })
  const r = await g.accounts.addFinish({ label: '' })
  assert.equal(probes[0].bin, BIN)
  assert.equal(r.account.id, ACCOUNT_ID); assert.equal(r.account.label, DEFAULT_LABEL); assert.equal(r.account.email, 'Antigravity sign-in')
  const l = await g.accounts.list()
  assert.equal(l.accounts.length, 1); assert.equal(l.active, ACCOUNT_ID); assert.equal(l.adding, false); assert.equal(l.accounts[0].active, true)
  assert.equal(await g.accounts.signedIn(), true)
  // A second confirm keeps one entry and takes a new label.
  await g.accounts.addFinish({ label: 'Personal' })
  assert.deepEqual((await g.accounts.list()).accounts.map((a) => a.label), ['Personal'])
  assert.equal(await g.accounts.checkActive(ACCOUNT_ID).then((x) => x.ok), true)
  assert.equal(await g.accounts.activate(ACCOUNT_ID), false)
  assert.deepEqual(await g.credentials.read(), { active: 'Personal' })
})

test("I've signed in: auth error / missing / other failures are refused and save nothing", async () => {
  for (const [res, re] of [[{ ok: false, auth: true }, /Not signed in yet/], [{ ok: false, missing: true }, /Antigravity CLI not found/], [{ ok: false, error: 'boom' }, /boom/]]) {
    const { g } = await mk(res)
    await assert.rejects(g.accounts.addFinish({}), (e) => e.status === 409 && re.test(e.message))
    assert.deepEqual((await g.accounts.list()).accounts, [])
  }
})

test('an auth failure after sign-in marks it signed out until confirmed again; older failures are ignored', async () => {
  let t = 1000
  const { g } = await mk({ ok: true }, { now: () => t })
  await g.accounts.addFinish({})
  assert.equal(await g.accounts.noteSignedOut(500), false) // from before the sign-in
  t = 2000
  assert.equal(await g.accounts.noteSignedOut(1500), true)
  assert.equal(await g.accounts.signedIn(), false)
  assert.equal((await g.accounts.list()).accounts[0].signedIn, false)
  t = 3000
  await g.accounts.addFinish({})
  assert.equal(await g.accounts.signedIn(), true)
  assert.equal(await g.accounts.noteSignedOut(1500), false)
})

test('limits: noteLimit marks the account out for 5 h; rename / remove; old per-home rows are ignored', async () => {
  let t = Date.UTC(2026, 10, 24, 12)
  const dataDir = await tmpData()
  // A row from the old Gemini CLI (per-home) design must not show.
  await fsp.writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify([{ id: 'claude-uuid-1234', label: 'C' }]))
  const g = createGeminiAccounts({ dataDir, bin: async () => BIN, probe: async () => ({ ok: true }), now: () => t })
  await g.accounts.addFinish({})
  assert.equal((await g.accounts.usage()).accounts[0].fiveHour.used, 0)
  await g.accounts.noteLimit(ACCOUNT_ID, t)
  assert.equal((await g.accounts.activeUsage()).fiveHour.used, 100)
  t += 5 * 3600e3 + 1
  assert.equal((await g.accounts.activeUsage()).fiveHour.used, 0)
  await g.accounts.rename(ACCOUNT_ID, { label: 'Home', lowPriority: true })
  assert.equal((await g.accounts.list()).accounts[0].lowPriority, true)
  await assert.rejects(g.accounts.rename('gemini-other', { label: 'x' }), (e) => e.status === 404)
  const r = await g.accounts.remove(ACCOUNT_ID)
  assert.match(r.note, /\/logout/)
  assert.deepEqual((await g.accounts.list()).accounts, [])
  // Claude's row in the shared registry survives.
  assert.ok(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8').includes('claude-uuid-1234'))
  await assert.rejects(g.accounts.capture(), (e) => e.status === 409)
  await assert.rejects(g.credentials.write(), (e) => e.status === 409)
})

test('probeSignIn against a fake agy: real auth-failure output -> auth; success -> ok; uses --print-timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyprobe-'))
  const log = path.join(dir, 'argv.log')
  const bin = fakeBin(dir, 'agy', `const fs = require('fs')
fs.writeFileSync(process.env.AGENTVILLE_FAKE_LOG, JSON.stringify(process.argv.slice(2)))
if (process.env.AGENTVILLE_FAKE_MODE === 'auth') { console.log(${JSON.stringify(AUTH_FAIL_LINE)}); console.error('Authentication required. Please visit the URL to log in:'); process.exit(1) }
console.log(JSON.stringify({ event: 'init', conversation_id: 'c9', init: {} }))
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))`)
  const env = { ...process.env, AGENTVILLE_FAKE_LOG: log }
  assert.deepEqual(await probeSignIn({ bin, env: { ...env, AGENTVILLE_FAKE_MODE: 'auth' }, cwd: dir }), { ok: false, auth: true, error: 'agy says authentication is required' })
  const argv = JSON.parse(fs.readFileSync(log, 'utf8'))
  assert.deepEqual(argv.slice(argv.indexOf('--print-timeout'), argv.indexOf('--print-timeout') + 2), ['--print-timeout', PROBE_PRINT_TIMEOUT])
  assert.deepEqual(await probeSignIn({ bin, env, cwd: dir }), { ok: true })
  assert.equal((await probeSignIn({ bin: null })).missing, true)
  assert.equal((await probeSignIn({ bin: path.join(dir, 'nope'), env, cwd: dir })).ok, false)
})
