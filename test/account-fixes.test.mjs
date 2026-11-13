/**
 * Review fixes in server/account.mjs and server/permmode.mjs: backup pruning keeps the only pool
 * copy, 'shell' is not idle, a failed rollback is still audited, stale-login respawns, drift
 * logging, revoked logins, permmode/account overlap, narrow Undo of job flags, and the auto-switch
 * refusal on an unrecognised login. Every outside piece is faked; only temp dirs are touched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccount, jobActivity, withModel } from '../server/account.mjs'
import { createPermSwitch, withBypass, BYPASS } from '../server/permmode.mjs'

const JOBS = ['aaaa0001', 'aaaa0002']
const POOL_ENV = { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'tok', KEEP: '1' }

function setup({ check = (id, live) => ({ ok: live === id }), activity = () => 'idle', pool = false, flags = ['--model', 'claude-opus-5-5'], providerEnv = {}, permBusy, permBusyJob, accountsPatch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-acct-fix-'))
  const home = path.join(root, 'claude')
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'opus', env: pool ? POOL_ENV : { KEEP: '1' } }, null, 2) + '\n')
  if (pool) fs.writeFileSync(path.join(home, '.credentials.json'), '{}')
  for (const short of JOBS) {
    fs.mkdirSync(path.join(home, 'jobs', short), { recursive: true })
    fs.writeFileSync(path.join(home, 'jobs', short, 'state.json'), JSON.stringify({ sessionId: `${short}-s`, state: 'working', respawnFlags: flags, providerEnv }))
  }
  const slots = { A: '{"claudeAiOauth":{"accessToken":"a"}}', B: '{"claudeAiOauth":{"accessToken":"b"}}' }
  const state = { live: slots.A }
  const idOf = (text) => Object.keys(slots).find((k) => slots[k] === text) || null
  const accounts = {
    load: async () => [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    readLive: async () => state.live,
    identify: async (text) => idOf(text),
    syncSlot: async () => {},
    activate: async (id) => { state.live = slots[id] },
    checkActive: async (id) => check(id, idOf(state.live)),
    restoreLive: async (text) => { state.live = text },
    readOauthAccount: async () => ({ accountUuid: idOf(state.live) }),
    writeOauthAccount: async () => {},
    ...accountsPatch,
  }
  const clock = { t: 1_000_000 }
  const calls = []
  const run = async (bin, args) => { if (args[0] === 'respawn') calls.push(args); return { timedOut: false, code: 0, stdout: '', stderr: '' } }
  const dataDir = path.join(root, 'data')
  const account = createAccount({
    dataDir, claudeHome: () => home, accounts, run, bin: async () => '/fake/claude', blocked: () => '',
    activity: async (short) => activity(short, clock.t), now: () => clock.t, sleep: async (ms) => { clock.t += ms; await new Promise(setImmediate) },
    idleMs: () => 600_000, everyMs: () => 3_000,
    ...(permBusy && { permBusy }), ...(permBusyJob && { permBusyJob }),
  })
  const agents = JOBS.map((j) => ({ id: `agent-${j}`, jobId: j, live: true, harness: 'claude-code', kind: 'job' }))
  const log = () => fs.readFileSync(path.join(dataDir, 'account-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const jobFile = (short) => path.join(home, 'jobs', short, 'state.json')
  return { root, home, dataDir, account, agents, calls, clock, log, jobFile, state, slots, idOf: () => idOf(state.live) }
}

/**
 * Let the background restart queue run `n` poll passes. The fake sleep advances the fake clock one
 * poll per pass, so a real-time wait would let a fast machine run past the 10-minute idle deadline
 * and give a held job up as "pending"; counting passes keeps the test independent of speed.
 */
async function polls(t, n = 5) {
  const end = t.clock.t + n * 3_000
  for (let i = 0; t.clock.t < end && i < 10_000; i++) await new Promise(setImmediate)
  assert.ok(t.clock.t >= end, 'the restart queue kept polling')
}

test('B1: pruning never removes the newest set holding the pool settings while there is no stash', async () => {
  for (const stash of [false, true]) {
    const t = setup()
    const root = path.join(t.dataDir, 'account-backups')
    const names = Array.from({ length: 11 }, (_, i) => `2000-01-01T00-00-${String(i).padStart(2, '0')}-000Z`)
    for (const [i, n] of names.entries()) {
      fs.mkdirSync(path.join(root, n, 'jobs'), { recursive: true })
      fs.writeFileSync(path.join(root, n, 'meta.json'), '{}')
      fs.writeFileSync(path.join(root, n, 'settings.json'), JSON.stringify({ env: i === 0 ? POOL_ENV : { KEEP: '1' } }))
    }
    if (stash) fs.writeFileSync(path.join(t.dataDir, 'pool-profile.json'), '{}')
    await t.account.switchTo({ to: 'B' }, t.agents, { auto: true })
    const left = fs.readdirSync(root).sort()
    if (stash) {
      assert.equal(left.length, 10)
      assert.ok(!left.includes(names[0]), 'with a stash the old pool set is pruned like any other')
    } else {
      assert.equal(left.length, 11, 'the newest 10 plus the only pool copy')
      assert.ok(left.includes(names[0]), 'the only pool copy is kept')
      assert.ok(!left.includes(names[1]))
    }
  }
})

test("B3: a job waiting on a background shell ('shell') is busy, not idle", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'village-acct-shell-'))
  fs.mkdirSync(path.join(home, 'jobs', 'aaaa0001'), { recursive: true })
  fs.mkdirSync(path.join(home, 'sessions'))
  fs.writeFileSync(path.join(home, 'jobs', 'aaaa0001', 'state.json'), JSON.stringify({ sessionId: 's1' }))
  const reg = path.join(home, 'sessions', 'x.json')
  fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, jobId: 'aaaa0001', status: 'shell' }))
  assert.equal(await jobActivity(home, 'aaaa0001'), 'busy')
  fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, jobId: 'aaaa0001', status: 'idle' }))
  assert.equal(await jobActivity(home, 'aaaa0001'), 'idle')
})

test('a rollback whose restore throws still writes the audit entry', async () => {
  // The swap fails, then putting the old login back fails too.
  const t = setup({ accountsPatch: { activate: async () => { throw new Error('keychain write failed') }, restoreLive: async () => { throw new Error('keychain locked') } } })
  await assert.rejects(t.account.switchTo({ to: 'B' }, t.agents, { auto: true }), (e) => e.status === 500 && /Undo/.test(e.message))
  const e = t.log().at(-1)
  assert.deepEqual([e.action, e.restored, typeof e.restoreFailed], ['switch', false, 'string'])
  assert.ok(!t.account.isBusy())

  // The check finds another account, and the restore throws.
  const u = setup({ check: () => ({ ok: false, reason: 'signed in to a different account' }), accountsPatch: { restoreLive: async () => { throw new Error('locked') } } })
  const out = await u.account.switchTo({ to: 'B' }, u.agents, { auto: true })
  assert.equal(out.restored, false)
  assert.match(out.reason, /Undo/)
  const f = u.log().at(-1)
  assert.deepEqual([f.action, f.restored, typeof f.restoreFailed], ['switch', false, 'string'])
})

test('#3: "login rejected" on a token not about to expire is revoked: rolled back; on an expired one it stands', async () => {
  const t = setup({ check: () => ({ ok: false, reason: 'login rejected', expiresAt: Date.now() + 10 * 60_000 }) })
  const out = await t.account.switchTo({ to: 'B' }, t.agents, { auto: true })
  assert.equal(out.restored, true)
  assert.equal(t.idOf(), 'A', 'the previous login is back')
  for (const expiresAt of [Date.now() - 1000, Date.now() + 30_000, undefined]) {
    const u = setup({ check: () => ({ ok: false, reason: 'login rejected', expiresAt }) })
    const r = await u.account.switchTo({ to: 'B' }, u.agents, { auto: true })
    assert.deepEqual([r.restored, r.verified, r.note], [false, false, 'login rejected'])
    assert.equal(u.idOf(), 'B')
  }
})

test('#2: respawnStale queues jobs that hit the limit soon after an account switch, once, idle-gated', async () => {
  let busy = new Set()
  const t = setup({ activity: (short) => (busy.has(short) ? 'busy' : 'idle') })
  assert.deepEqual((await t.account.respawnStale(['agent-aaaa0001'], t.agents)).queued, [], 'no switch yet')
  await t.account.switchTo({ to: 'B' }, t.agents, { auto: true })
  busy = new Set(JOBS) // both mid turn: nothing is cut off
  const at = t.clock.t
  const agents = t.agents.map((a) => ({ ...a, limitStopAt: at + 1000 }))
  agents.push({ id: 'agent-old', jobId: 'aaaa0003', live: true, limitStopAt: at - 1 })
  const r = await t.account.respawnStale(['agent-aaaa0001', 'agent-aaaa0002', 'agent-old'], agents)
  assert.deepEqual(r.queued.sort(), ['aaaa0001', 'aaaa0002'])
  assert.equal(t.log().at(-1).action, 'stale-respawn')
  assert.deepEqual((await t.account.respawnStale(['agent-aaaa0001'], agents)).queued, [], 'already queued: not twice')
  const st = await t.account.status(t.agents)
  assert.deepEqual(st.restarts.map((x) => x.id).sort(), ['aaaa0001', 'aaaa0002'])
  await polls(t)
  busy = new Set()
  await t.account.settled()
  assert.deepEqual(t.calls.map((c) => c[1]).sort(), ['aaaa0001', 'aaaa0002'])
  assert.deepEqual((await t.account.respawnStale(['agent-aaaa0001'], agents)).queued, [], 'once per switch')

  // Past the window: nothing.
  const u = setup()
  await u.account.switchTo({ to: 'B' }, u.agents, { auto: true })
  u.clock.t += 11 * 60_000
  assert.deepEqual((await u.account.respawnStale(['agent-aaaa0001'])).queued, [])
})

test('#2: respawnStale ignores pool/personal switches; uses the agents the switch saw by default', async () => {
  const t = setup({ pool: true })
  await t.account.switchTo({ to: 'personal' }, t.agents, { auto: true })
  assert.equal((await t.account.respawnStale(['agent-aaaa0001'])).reason, 'no recent account switch')
  const u = setup()
  await u.account.switchTo({ to: 'B' }, u.agents, { auto: true })
  assert.deepEqual((await u.account.respawnStale(['agent-aaaa0001'])).queued, ['aaaa0001'])
})

test('#2: noteDrift logs once when the live account is not the one the last switch landed on', async () => {
  const t = setup()
  assert.equal(await t.account.noteDrift('A'), false, 'no switch yet: nothing to compare')
  await t.account.switchTo({ to: 'B' }, t.agents, { auto: true })
  assert.equal(await t.account.noteDrift('B'), false)
  assert.equal(await t.account.noteDrift('A'), true)
  assert.equal(await t.account.noteDrift('A'), true)
  const drift = t.log().filter((e) => e.action === 'drift')
  assert.equal(drift.length, 1)
  assert.deepEqual([drift[0].expected, drift[0].live], ['B', 'A'])
  // A switch that finds the login changed under it logs the drift too.
  const u = setup()
  await u.account.switchTo({ to: 'B' }, u.agents, { auto: true })
  u.state.live = u.slots.A
  await u.account.switchTo({ to: 'B' }, u.agents, { auto: true })
  assert.ok(u.log().some((e) => e.action === 'drift' && e.expected === 'B' && e.live === 'A'))
})

test('#7: an account switch or Undo is refused while a permission-mode switch runs', async () => {
  let perm = true
  const t = setup({ permBusy: () => perm })
  await assert.rejects(t.account.switchTo({ to: 'B' }, t.agents, { auto: true }), (e) => e.status === 409 && e.message === 'A permission-mode switch is running')
  perm = false
  await t.account.switchTo({ to: 'B' }, t.agents, { auto: true })
  perm = true
  await assert.rejects(t.account.undo(), (e) => e.status === 409 && e.message === 'A permission-mode switch is running')
})

test('#7: a queued restart waits while permmode is working on that job', async () => {
  let held = 'aaaa0001'
  const t = setup({ pool: true, permBusyJob: (short) => short === held })
  const out = await t.account.switchTo({ to: 'personal' }, t.agents, { auto: true })
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['aaaa0001', 'waiting'], ['aaaa0002', 'respawned']])
  await polls(t)
  assert.deepEqual(t.calls.map((c) => c[1]), ['aaaa0002'])
  held = null
  await t.account.settled()
  assert.deepEqual(t.calls.map((c) => c[1]), ['aaaa0002', 'aaaa0001'])
})

test('#7: permmode reports the job it is working on', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-perm-fix-'))
  const home = path.join(root, 'claude')
  const short = 'abcdef12'
  fs.mkdirSync(path.join(home, 'jobs', short), { recursive: true })
  fs.writeFileSync(path.join(home, 'jobs', short, 'state.json'), JSON.stringify({ respawnFlags: [] }))
  let seen = 'unset'
  fs.mkdirSync(path.join(home, 'sessions'))
  const run = async () => { fs.writeFileSync(path.join(home, 'sessions', 'x.json'), JSON.stringify({ pid: process.pid, jobId: short })); return { code: 0 } }
  const sw = createPermSwitch({ claudeHome: () => home, dataDir: path.join(root, 'data'), blocked: () => '', run, bin: async () => '/fake', verifyMs: () => 500,
    activity: async () => { seen = sw.busyJob(); return 'gone' }, now: () => 0, sleep: async () => {} })
  assert.equal(sw.busyJob(), null)
  await sw.toBypass(short, { live: true })
  assert.equal(seen, short)
  assert.equal(sw.busyJob(), null)
})

test('#8: Undo of a pool -> personal switch puts back only the model and pool env, keeping a later bypass', async () => {
  const t = setup({ pool: true, flags: ['--name', 'x', '--model', 'cc/claude-opus-5-5'], providerEnv: { CLAUDE_CODE_SUBAGENT_MODEL: 'cc/x', OTHER: '1' } })
  await t.account.switchTo({ to: 'personal' }, t.agents, { auto: true })
  await t.account.settled()
  const file = t.jobFile('aaaa0001')
  const mid = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(mid.respawnFlags, ['--name', 'x', '--model', 'claude-opus-5-5'])
  // Later: the user switches the job to bypass mode and an unrelated env key changes.
  fs.writeFileSync(file, JSON.stringify({ ...mid, respawnFlags: withBypass(mid.respawnFlags), providerEnv: { ...mid.providerEnv, OTHER: '2' } }))
  await t.account.undo()
  const now = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(now.respawnFlags, ['--permission-mode', BYPASS, '--name', 'x', '--model', 'cc/claude-opus-5-5'])
  assert.deepEqual(now.providerEnv, { OTHER: '2', CLAUDE_CODE_SUBAGENT_MODEL: 'cc/x' })
})

test('withModel sets the model value in either form and leaves everything else', () => {
  assert.deepEqual(withModel(['-n', 'a', '--model', 'x', 'p'], ['--model', 'cc/x']), ['-n', 'a', '--model', 'cc/x', 'p'])
  assert.deepEqual(withModel(['--model=x', 'p'], ['--model=cc/x']), ['--model=cc/x', 'p'])
  assert.deepEqual(withModel(['--model=x'], ['--model', 'cc/x']), ['--model=cc/x'])
  assert.deepEqual(withModel(['p'], ['--model', 'cc/x']), ['p'], 'no model now: left alone')
  assert.deepEqual(withModel(['--model', 'x'], ['p']), ['--model', 'x'], 'none saved: left alone')
})

test('#10: an auto switch is refused when the stored login is not recognised; a manual one proceeds', async () => {
  const t = setup()
  t.state.live = '{"claudeAiOauth":{"accessToken":"unknown"}}'
  await assert.rejects(t.account.switchTo({ to: 'B' }, t.agents, { auto: true }), (e) => e.status === 409 && e.message === 'Current login not recognised')
  assert.equal(fs.existsSync(path.join(t.dataDir, 'account-backups')), false, 'nothing backed up or changed')
  const { confirm } = await t.account.status(t.agents)
  const out = await t.account.switchTo({ to: 'B', confirm }, t.agents)
  assert.equal(out.restored, false)
  assert.equal(t.idOf(), 'B')
})

test('an unreadable login store is never "no login": auto refused, manual refused, nothing changed', async () => {
  const unreadable = () => { throw Object.assign(new Error('Keychain read failed'), { status: 503, code: 'unreadable' }) }
  const t = setup({ accountsPatch: { readLive: async () => unreadable() } })
  await assert.rejects(t.account.switchTo({ to: 'B' }, t.agents, { auto: true }), (e) => e.status === 409 && e.message === 'Current login not recognised')
  const { confirm } = await t.account.status(t.agents)
  await assert.rejects(t.account.switchTo({ to: 'B', confirm }, t.agents), (e) => e.status === 503 && e.code === 'unreadable')
  assert.equal(fs.existsSync(path.join(t.dataDir, 'account-backups')), false)
  assert.equal(t.idOf(), 'A')
})

test('coded activate errors keep status and code (and size/max); a refused refresh is not rolled back', async () => {
  let restores = 0
  const cases = [
    [Object.assign(new Error('That login expired'), { status: 409, code: 'login_expired' }), 0],
    [Object.assign(new Error('Refresh failed'), { status: 502, code: 'refresh_failed' }), 0],
    [Object.assign(new Error('Too big'), { status: 409, code: 'too_big', size: 5000, max: 4096 }), 1],
  ]
  for (const [err, wantRestores] of cases) {
    restores = 0
    const t = setup({ accountsPatch: { activate: async () => { throw err }, restoreLive: async () => { restores++ } } })
    await assert.rejects(t.account.switchTo({ to: 'B' }, t.agents, { auto: true }), (e) => {
      assert.deepEqual([e.status, e.code, e.size, e.max], [err.status, err.code, err.size, err.max])
      assert.ok(e.message.includes(err.message))
      return true
    })
    assert.equal(restores, wantRestores, err.code)
    const e = t.log().at(-1)
    assert.deepEqual([e.action, e.restored, e.code], ['switch', true, err.code])
    assert.deepEqual(t.calls, [])
  }
})
