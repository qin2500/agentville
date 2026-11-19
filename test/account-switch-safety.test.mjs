/**
 * The 2026-11-18 pool round trip: switching pool -> personal -> pool -> personal within minutes left
 * agents on the gateway route (a deleted settings key never leaves a running Claude), restarts that
 * never ran (an agent stopped on an API error kept watch-loop shells running, so it never looked
 * idle), and a background restart pass that restarted jobs a second time across a later switch.
 * Every outside piece is faked (accounts, `claude`, the clock); only temp dirs are touched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccount, jobActivity, PERSONAL_ROUTING_ENV } from '../server/account.mjs'

const JOBS = ['aaaa0001', 'aaaa0002']
const POOL_ENV = { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key', KEEP: '1' }

function setup({ activity, run: runFor } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-acct-safety-'))
  const home = path.join(root, 'claude')
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'opus', env: POOL_ENV }, null, 2) + '\n')
  fs.writeFileSync(path.join(home, '.credentials.json'), '{}') // a stored personal login (existence only)
  for (const short of JOBS) {
    fs.mkdirSync(path.join(home, 'jobs', short), { recursive: true })
    fs.writeFileSync(path.join(home, 'jobs', short, 'state.json'), JSON.stringify({ sessionId: `${short}-s`, state: 'working', respawnFlags: ['--model', 'cc/opus'], providerEnv: {} }))
  }
  const slots = { A: '{"claudeAiOauth":{"accessToken":"a"}}' }
  const accounts = {
    load: async () => [{ id: 'A', label: 'A' }],
    readLive: async () => slots.A,
    identify: async () => 'A',
    syncSlot: async () => {},
    activate: async () => {},
    checkActive: async () => ({ ok: true }),
    restoreLive: async () => {},
    readOauthAccount: async () => ({ accountUuid: 'A' }),
    writeOauthAccount: async () => {},
  }
  const clock = { t: 1_000_000 }
  const calls = []
  const run = async (bin, args) => {
    if (args[0] === 'respawn') { calls.push(args[1]); if (runFor) return runFor(args[1]) }
    return { timedOut: false, code: 0, stdout: '', stderr: '' }
  }
  const dataDir = path.join(root, 'data')
  const account = createAccount({
    dataDir, claudeHome: () => home, accounts, run, bin: async () => '/fake/claude', blocked: () => '',
    ...(activity && { activity: (short) => activity(short, clock.t) }),
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; await new Promise(setImmediate) },
    idleMs: () => 600_000, everyMs: () => 3_000,
  })
  const agents = JOBS.map((j) => ({ id: `agent-${j}`, jobId: j, live: true, harness: 'claude-code', kind: 'job' }))
  const settings = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))
  return { root, home, dataDir, account, agents, calls, clock, settings }
}

const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }

function registry(home, short, status, extra = {}) {
  fs.writeFileSync(path.join(home, 'sessions', `${short}.json`), JSON.stringify({ pid: process.pid, jobId: short, sessionId: `${short}-s`, status, ...extra }))
}
function jobState(home, short, fields) {
  const file = path.join(home, 'jobs', short, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...fields }))
}

test('an agent stopped on an API error is at a turn boundary, even with watch-loop shells still running', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'village-acct-failed-'))
  fs.mkdirSync(path.join(home, 'jobs', 'aaaa0001'), { recursive: true })
  fs.mkdirSync(path.join(home, 'sessions'))
  const state = (s) => fs.writeFileSync(path.join(home, 'jobs', 'aaaa0001', 'state.json'), JSON.stringify({ sessionId: 's1', ...s }))
  const reg = (status) => fs.writeFileSync(path.join(home, 'sessions', 'x.json'), JSON.stringify({ pid: process.pid, jobId: 'aaaa0001', status }))
  state({ state: 'failed', tempo: 'idle' })
  for (const status of ['shell', 'busy', 'waiting', 'idle']) { reg(status); assert.equal(await jobActivity(home, 'aaaa0001'), 'idle', status) }
  for (const status of ['needs_user', 'blocked', 'needs_trust']) { reg(status); assert.equal(await jobActivity(home, 'aaaa0001'), 'busy', `a dialog (${status}) is never cut off`) }
  reg('shell')
  state({ state: 'failed', tempo: 'active' })
  assert.equal(await jobActivity(home, 'aaaa0001'), 'busy', 'the scheduler says it is working again')
  state({ state: 'working', tempo: 'idle' })
  assert.equal(await jobActivity(home, 'aaaa0001'), 'busy', 'a working job waiting on a shell still waits')
  fs.rmSync(path.join(home, 'sessions', 'x.json'))
  state({ state: 'failed', tempo: 'idle' })
  assert.equal(await jobActivity(home, 'aaaa0001'), 'gone', 'no live process: nothing to restart')
})

test('a switch restarts an errored agent at once instead of leaving it "restart pending"', async () => {
  const t = setup() // the real registry check, on the temp home
  registry(t.home, 'aaaa0001', 'shell')
  jobState(t.home, 'aaaa0001', { state: 'failed', tempo: 'idle', detail: 'API Error: 400 tools: Tool names must be unique.' })
  registry(t.home, 'aaaa0002', 'shell') // a healthy agent whose turn is waiting on a shell
  const out = await t.account.switchTo({ to: 'personal' }, t.agents, { auto: true })
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['aaaa0001', 'respawned'], ['aaaa0002', 'waiting']])
  assert.deepEqual(t.calls, ['aaaa0001'])
})

test('pool -> personal writes explicit Personal routing, so a running agent cannot keep the gateway route', async () => {
  const t = setup({ activity: () => 'idle' })
  await t.account.switchTo({ to: 'personal' }, t.agents, { auto: true })
  const env = t.settings().env
  for (const [k, v] of Object.entries(PERSONAL_ROUTING_ENV)) assert.equal(env[k], v, k)
  assert.equal(env.KEEP, '1')
  assert.equal(await t.account.profile(), 'personal', 'the neutral values read as Personal, not the pool')
  // and back: the stashed pool profile returns exactly, with no Personal neutralizer left behind
  await t.account.switchTo({ to: 'pool' }, t.agents, { auto: true })
  assert.deepEqual(t.settings().env, POOL_ENV)
  assert.equal(await t.account.profile(), 'pool')
})

test('Undo of a switch to the pool puts Personal back with explicit routing, not just without pool keys', async () => {
  const t = setup({ activity: () => 'idle' })
  await t.account.switchTo({ to: 'personal' }, t.agents, { auto: true })
  // An old Personal backup (from before the neutralizers existed): no routing keys at all.
  fs.writeFileSync(path.join(t.home, 'settings.json'), JSON.stringify({ model: 'opus', env: { KEEP: '1' } }, null, 2) + '\n')
  await t.account.switchTo({ to: 'pool' }, t.agents, { auto: true })
  assert.equal(await t.account.profile(), 'pool')
  t.clock.t += 61_000
  const out = await t.account.undo()
  assert.equal(out.profile, 'personal')
  const env = t.settings().env
  for (const [k, v] of Object.entries(PERSONAL_ROUTING_ENV)) assert.equal(env[k], v, k)
})

test('a switch is refused while an earlier switch is still respawning an agent', async () => {
  let release
  const hung = new Promise((r) => { release = r })
  let busyUntil = 1_000_000 + 6_000
  const t = setup({
    activity: (short, now) => (short === 'aaaa0001' && now < busyUntil ? 'busy' : 'idle'),
    run: async (short) => { if (short === 'aaaa0001') await hung; return { timedOut: false, code: 0, stdout: '', stderr: '' } },
  })
  const out = await t.account.switchTo({ to: 'personal' }, t.agents, { auto: true })
  assert.deepEqual(out.results.map((r) => r.status), ['waiting', 'respawned'])
  // The background pass picks aaaa0001 up once it is idle and its respawn is now running.
  for (let i = 0; i < 200 && !t.calls.includes('aaaa0001'); i++) await tick(1)
  assert.ok(t.calls.includes('aaaa0001'))
  await assert.rejects(t.account.switchTo({ to: 'pool' }, t.agents, { auto: true }), (e) => e.status === 409 && /still restarting/.test(e.message))
  await assert.rejects(t.account.undo(), (e) => e.status === 409)
  assert.equal(await t.account.profile(), 'personal', 'nothing changed under the respawn')
  release()
  await t.account.settled()
  const back = await t.account.switchTo({ to: 'pool' }, t.agents, { auto: true })
  assert.equal(back.restored, false, 'once it has started, switching works again')
  busyUntil = 0
})

test('a background restart pass that began before a switch never restarts a job a second time after it', async () => {
  // The first switch leaves aaaa0001 waiting. The background pass then checks it; that check is
  // slow, and a second switch starts and restarts the job itself while it runs.
  let phase = 'busy'
  let releaseCheck
  let checking = false
  const t = setup({
    activity: async (short) => {
      if (short !== 'aaaa0001') return 'idle'
      if (phase === 'slow') { phase = 'idle'; checking = true; return new Promise((r) => { releaseCheck = () => r('idle') }) }
      return phase
    },
  })
  await t.account.switchTo({ to: 'personal' }, t.agents, { auto: true })
  assert.deepEqual(t.calls, ['aaaa0002'])
  phase = 'slow'
  for (let i = 0; i < 200 && !checking; i++) await tick(1)
  assert.ok(checking, 'the background pass is checking aaaa0001')
  t.clock.t += 61_000
  const second = await t.account.switchTo({ to: 'pool' }, t.agents, { auto: true })
  assert.deepEqual(second.results.map((r) => [r.id, r.status]), [['aaaa0001', 'respawned'], ['aaaa0002', 'respawned']])
  releaseCheck()
  await tick(50)
  await t.account.settled()
  assert.deepEqual(t.calls, ['aaaa0002', 'aaaa0001', 'aaaa0002'], 'aaaa0001 restarted once, by the second switch')
})
