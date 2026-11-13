/**
 * The account switch (server/account.mjs) with every outside piece faked: a fake accounts object
 * (no Keychain, no network), a fake `run` (no real `claude`), a fake job-activity registry and a
 * fake clock. Only a temp Claude home is touched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccount, stderrLine, waitForIdle } from '../server/account.mjs'

const JOBS = ['aaaa0001', 'aaaa0002']

function setup({ check = (id, live) => ({ ok: live === id }), runFor = () => ({ code: 0, stdout: '', stderr: '' }), activity = () => 'idle', idleMs = 600_000, everyMs = 3_000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-acct-unit-'))
  const home = path.join(root, 'claude')
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'opus', env: { KEEP: '1' } }, null, 2) + '\n')
  for (const short of JOBS) {
    fs.mkdirSync(path.join(home, 'jobs', short), { recursive: true })
    fs.writeFileSync(path.join(home, 'jobs', short, 'state.json'), JSON.stringify({ sessionId: `${short}-s`, state: 'working', respawnFlags: ['--model', 'claude-opus-5-5'], providerEnv: {} }))
  }
  // A fake of createAccounts(): Claude's stored login is one of the slot texts.
  const slots = { A: '{"claudeAiOauth":{"accessToken":"a"}}', B: '{"claudeAiOauth":{"accessToken":"b"}}' }
  let live = slots.A
  const idOf = (text) => Object.keys(slots).find((k) => slots[k] === text) || null
  const checks = []
  const accounts = {
    load: async () => [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    readLive: async () => live,
    identify: async (text) => idOf(text),
    syncSlot: async () => {},
    activate: async (id) => { live = slots[id] },
    checkActive: async (id) => { checks.push(id); return check(id, idOf(live)) },
    restoreLive: async (text) => { live = text },
    readOauthAccount: async () => ({ accountUuid: idOf(live) }),
    writeOauthAccount: async () => {},
  }
  const clock = { t: 1_000_000 }
  const calls = []
  const run = async (bin, args) => { if (args[0] === 'respawn') calls.push(args); return { timedOut: false, ...runFor(args[1]) } }
  const dataDir = path.join(root, 'data')
  const account = createAccount({
    dataDir, claudeHome: () => home, accounts, run, bin: async () => '/fake/claude', blocked: () => '',
    activity: async (short) => activity(short, clock.t), now: () => clock.t, sleep: async (ms) => { clock.t += ms; await new Promise(setImmediate) },
    idleMs: () => idleMs, everyMs: () => everyMs,
  })
  const agents = JOBS.map((j) => ({ id: j, jobId: j, live: true, harness: 'claude-code', kind: 'job' }))
  const log = () => fs.readFileSync(path.join(dataDir, 'account-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const jobFile = (short) => path.join(home, 'jobs', short, 'state.json')
  return { root, home, dataDir, account, agents, calls, checks, clock, log, jobFile, live: () => idOf(live) }
}

test('account -> account: the swap is checked directly, nothing is respawned, auto and why are logged', async () => {
  const t = setup()
  const why = { reason: 'limit', active: { id: 'A', fiveHour: 99, weekly: 40, ageMs: 5000 }, limitHit: ['agent-1'], target: { id: 'B', fiveHour: 3, weekly: 10 } }
  const out = await t.account.switchTo({ to: 'B' }, t.agents, { auto: true, why })
  assert.equal(out.restored, false)
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['aaaa0001', 'unchanged'], ['aaaa0002', 'unchanged']])
  assert.deepEqual(t.calls, [], 'no respawn at all')
  assert.deepEqual(t.checks, ['B'])
  assert.equal(t.live(), 'B')
  const e = t.log().at(-1)
  assert.deepEqual([e.action, e.auto, e.account, e.restored, e.why, e.verified], ['switch', true, 'B', false, why, true])
  assert.ok((await t.account.lastChangeAt()) > 0)
})

test('a check that finds another account (or none) rolls the swap back and restarts nothing', async () => {
  for (const reason of ['signed in to a different account', 'no login stored']) {
    const t = setup({ check: () => ({ ok: false, reason }) })
    const out = await t.account.switchTo({ to: 'B' }, t.agents, { auto: true, why: { reason: 'out' } })
    assert.equal(out.restored, true)
    assert.ok(out.reason.includes(`couldn't be confirmed (${reason})`), out.reason)
    assert.equal(t.live(), 'A', 'the previous login is back')
    assert.deepEqual(t.calls, [])
    const e = t.log().at(-1)
    assert.deepEqual([e.action, e.auto, e.restored, e.why.reason, e.verified, e.note], ['switch', true, true, 'out', false, reason], 'a rolled-back entry stays distinguishable')
  }
})

test('a check that cannot decide (expired token, no network, rate limit) keeps the switch, logged unverified', async () => {
  for (const reason of ['login rejected', 'could not reach Anthropic', 'Anthropic is rate-limiting checks', 'unexpected response from Anthropic']) {
    const t = setup({ check: () => ({ ok: false, reason }) })
    const out = await t.account.switchTo({ to: 'B' }, t.agents, { auto: true })
    assert.deepEqual([out.restored, out.verified, out.note], [false, false, reason])
    assert.equal(t.live(), 'B', 'the swap stands: Claude refreshes the token on its next request')
    const e = t.log().at(-1)
    assert.deepEqual([e.restored, e.verified, e.note], [false, false, reason])
    assert.deepEqual(t.calls, [], 'nothing restarted')
  }
})

test('account -> account: a job with leftover pool settings is cleaned and restarted only when idle', async () => {
  let busyUntil = 0
  const t = setup({ activity: (short, now) => (short === 'aaaa0001' && now < busyUntil ? 'busy' : 'idle') })
  busyUntil = t.clock.t + 10_000
  const file = t.jobFile('aaaa0001')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), respawnFlags: ['--model', 'cc/claude-opus-5-5'], providerEnv: { CLAUDE_CODE_SUBAGENT_MODEL: 'cc/x', OTHER: '1' } }))
  const out = await t.account.switchTo({ to: 'B', confirm: (await t.account.status(t.agents)).confirm }, t.agents, {})
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['aaaa0001', 'waiting'], ['aaaa0002', 'unchanged']])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).respawnFlags, ['--model', 'claude-opus-5-5'])
  assert.deepEqual(t.calls, [], 'not while it is busy')
  const later = await t.account.settled()
  assert.deepEqual(later, [{ id: 'aaaa0001', status: 'respawned' }])
  assert.deepEqual(t.calls, [['respawn', 'aaaa0001']])
  assert.ok(t.clock.t >= busyUntil, 'restarted only after its turn ended')
  assert.equal(t.log().at(-1).action, 'restart')
  assert.equal(t.log().at(-2).auto, false)
})

test('a job busy past the cap is left restart pending and never respawned', async () => {
  const t = setup({ activity: () => 'busy', idleMs: 10_000, everyMs: 3_000 })
  const file = t.jobFile('aaaa0002')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), respawnFlags: ['--model=cc/claude-sonnet-5-5'] }))
  const out = await t.account.switchTo({ to: 'B', confirm: (await t.account.status(t.agents)).confirm }, t.agents, {})
  assert.equal(out.results[1].status, 'waiting')
  const later = await t.account.settled()
  assert.deepEqual(later.map((r) => [r.id, r.status]), [['aaaa0002', 'pending']])
  assert.match(later[0].detail, /restart pending/)
  assert.deepEqual(t.calls, [])
  assert.deepEqual((await t.account.status(t.agents)).restarts.map((r) => [r.id, r.status]), [['aaaa0002', 'pending']])
})

test('a respawn failure for one job is skipped past, with a sanitised first stderr line', async () => {
  const secret = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const t = setup({ runFor: (short) => (short === 'aaaa0001' ? { code: 3, stdout: '', stderr: `\nError: bad --append-system-prompt "do the secret thing" token ${secret}\nsecond line` } : { code: 0, stdout: '', stderr: '' }) })
  for (const j of JOBS) {
    const f = t.jobFile(j)
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), respawnFlags: ['--model', 'cc/claude-opus-5-5'] }))
  }
  const out = await t.account.switchTo({ to: 'B', confirm: (await t.account.status(t.agents)).confirm }, t.agents, {})
  assert.equal(out.restored, false)
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['aaaa0001', 'failed'], ['aaaa0002', 'respawned']])
  assert.match(out.results[0].detail, /^Respawn failed \(exit 3\): Error: bad --append-system-prompt …/)
  for (const leak of [secret, 'secret thing', 'second line']) assert.ok(!JSON.stringify(out).includes(leak), leak)
  assert.ok(!fs.readFileSync(path.join(t.dataDir, 'account-log.jsonl'), 'utf8').includes(secret))
  assert.equal(t.live(), 'B', 'the switch stands')
})

test('rollback restores only respawnFlags and providerEnv of a job file (read-modify-write)', async () => {
  const t = setup({ check: () => ({ ok: false, reason: 'signed in to a different account' }) })
  const file = t.jobFile('aaaa0001')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), respawnFlags: ['--model', 'cc/claude-opus-5-5'], providerEnv: { CLAUDE_CODE_SUBAGENT_MODEL: 'cc/x' } }))
  const untouched = fs.readFileSync(t.jobFile('aaaa0002'), 'utf8')
  // Claude writes the job file while the switch runs: the check is where we simulate that.
  const orig = t.account.accounts.checkActive
  t.account.accounts.checkActive = async (id) => {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'idle', updatedAt: 'later' }))
    fs.writeFileSync(t.jobFile('aaaa0002'), untouched.replace('"working"', '"idle"'))
    return orig(id)
  }
  const out = await t.account.switchTo({ to: 'B', confirm: (await t.account.status(t.agents)).confirm }, t.agents, {})
  assert.equal(out.restored, true)
  const now = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual([now.respawnFlags, now.providerEnv, now.state, now.updatedAt], [['--model', 'cc/claude-opus-5-5'], { CLAUDE_CODE_SUBAGENT_MODEL: 'cc/x' }, 'idle', 'later'])
  assert.match(fs.readFileSync(t.jobFile('aaaa0002'), 'utf8'), /"idle"/, 'a job the switch did not change is not written back')
})

test('waitForIdle: idle at once, idle after a wait, gone, and the cap', async () => {
  const clock = { t: 0 }
  const opts = { maxMs: 10, pollMs: 3, now: () => clock.t, sleep: async (ms) => { clock.t += ms } }
  assert.deepEqual(await waitForIdle(async () => 'idle', opts), { state: 'idle', waited: false })
  let n = 0
  assert.deepEqual(await waitForIdle(async () => (n++ < 2 ? 'busy' : 'idle'), opts), { state: 'idle', waited: true })
  assert.deepEqual(await waitForIdle(async () => 'gone', opts), { state: 'gone', waited: false })
  clock.t = 0
  assert.deepEqual(await waitForIdle(async () => 'busy', opts), { state: 'timeout', waited: true })
  assert.ok(clock.t >= 10)
})

test('stderrLine keeps the first line and drops flag values, quotes and tokens', () => {
  assert.equal(stderrLine(''), '')
  assert.equal(stderrLine('\n  Job not found\nmore'), 'Job not found')
  assert.equal(stderrLine('bad --model=cc/secret-model value'), 'bad --model … value')
  assert.equal(stderrLine('got "a prompt here"'), 'got "…"')
  assert.equal(stderrLine('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xyz'), 'token …')
  assert.ok(stderrLine('x'.repeat(500)).length <= 160)
})
