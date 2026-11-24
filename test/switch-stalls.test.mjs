/**
 * Stalls after an account -> account switch (2026-11-20 investigation). Regression tests for:
 *  1. the post-switch "continue" waits out Claude's 30 s credential cache (the Contracts Lead got
 *     "continue" 0.3 s after the 11-20 switch and stopped on the old login's limit again 2 s later);
 *  2. a job that stops on the limit after the switch gets "continue" (not a second switch), and only a
 *     job that stops again after that is restarted, with the scan's current agents, then nudged;
 *  3. respawnStale given the current agents queues a job that stopped both before and after the switch
 *     (with the switch-time snapshot it queued nothing, so nothing ever restarted it);
 *  4. a job the scheduler parked as 'blocked' on the usage limit or an API error is at a turn boundary;
 *  5. really out (a limit hit or OUT_AT) is not held by the 15 min cooldown.
 * Fakes only: temp dirs, a fake clock and sleep, fake account/accounts/run. No real ~/.claude, Keychain,
 * network or sessions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSampler, decide, COOLDOWN_MS, CRED_CACHE_MS, NUDGE_AFTER_SWITCH_MS } from '../server/autoswitch.mjs'
import { createAccount, jobActivity } from '../server/account.mjs'

const NOW = Date.UTC(2026, 10, 20, 16, 54, 0)
const MIN = 60e3, H = 3600e3, DAY = 24 * H
const w = (used, resetsIn = 3 * H) => ({ used, resetsAt: NOW + resetsIn })
const LIMIT = "You've hit your 5-hour limit · resets 2:30pm (America/New_York)"
const job = (id, stopAt, jobId = id) => ({ id, jobId, live: true, bucket: 'stalled', limitStopAt: stopAt, limitText: LIMIT })
const AUTO = (at) => ({ at, action: 'switch', auto: true, from: 'A', to: 'B', restored: false })

function rig({ log = [], queued = (ids) => ids } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-switch-stalls-'))
  let clock = NOW
  const env = { active: 'A', reading: { fiveHour: w(50), weekly: w(30, 4 * DAY) }, usage: new Map(), agents: [], changeAt: 0 }
  env.usage.set('B', { fiveHour: w(0), weekly: w(10, 4 * DAY) })
  if (log.length) fs.writeFileSync(path.join(dataDir, 'account-log.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const calls = [], nudges = [], stale = [], sleeps = []
  let settle = []
  const list = ['A', 'B'].map((id) => ({ id, label: id.toLowerCase(), quarantine: false }))
  const account = {
    profile: async () => 'acct', lastChangeAt: async () => env.changeAt, isBusy: () => false, poolAvailable: () => false,
    async switchTo(body) {
      calls.push({ at: clock, body })
      env.active = body.to; env.changeAt = clock
      fs.appendFileSync(path.join(dataDir, 'account-log.jsonl'), JSON.stringify(AUTO(clock)) + '\n')
      return { restored: false, results: [] }
    },
    async respawnStale(ids, agents) {
      stale.push({ ids, agents })
      const shorts = agents.filter((a) => ids.includes(a.id)).map((a) => a.jobId)
      const q = queued(shorts)
      settle = q.map((s) => ({ id: s, status: 'respawned' }))
      return { queued: q }
    },
    settled: async () => settle,
    accounts: {
      activeUsage: async () => ({ id: env.active, saved: true, ...env.reading }),
      load: async () => list, list: async () => ({ active: env.active }),
      usage: async () => ({ accounts: [...env.usage].map(([id, x]) => ({ id, ...x })) }),
    },
  }
  const sampler = createSampler({ dataDir, account, agents: async () => env.agents,
    nudge: async (ids) => { nudges.push({ at: clock, ids }); return ids }, now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms } })
  return { sampler, env, calls, nudges, stale, sleeps, tick: () => sampler.tick(), advance: (ms) => { clock += ms }, now: () => clock,
    done: () => fs.rmSync(dataDir, { recursive: true, force: true }) }
}
const flush = () => new Promise(setImmediate)

test('a limit switch sends its "continue" only once Claude\'s 30 s credential cache has let go of the old login', async () => {
  const r = rig({ log: [AUTO(NOW - 3 * H)] })
  try {
    assert.ok(NUDGE_AFTER_SWITCH_MS > CRED_CACHE_MS)
    r.env.reading = { fiveHour: w(98), weekly: w(30, 4 * DAY) }
    r.env.agents = [job('lead1', NOW - 18e3), job('lead2', NOW - 12e3)] // stopped on the limit just before
    const d = await r.tick()
    assert.deepEqual([d.action, d.why], ['switch', 'limit'])
    assert.equal(r.nudges.length, 1)
    assert.deepEqual(r.nudges[0].ids, ['lead1', 'lead2'])
    assert.ok(r.nudges[0].at - r.calls[0].at >= NUDGE_AFTER_SWITCH_MS, `nudged ${r.nudges[0].at - r.calls[0].at} ms after the switch`)
  } finally { r.done() }
})

test('a limit stop inside the cache window after a switch is neither a switch nor a nudge yet; then "continue"', async () => {
  const r = rig({ log: [AUTO(NOW - 10e3)] })
  try {
    r.env.active = 'B'; r.env.changeAt = NOW - 10e3
    r.env.agents = [job('lead1', NOW - 8e3)] // went out on the old login 2 s after the switch
    let d = await r.tick()
    assert.equal(d.action, 'none')
    assert.equal(r.calls.length, 0, 'not a reason to switch again')
    assert.equal(r.nudges.length, 0, 'a "continue" now could go out on the old login too')
    r.advance(CRED_CACHE_MS)
    d = await r.tick()
    assert.equal(r.calls.length, 0)
    assert.deepEqual(r.nudges.map((n) => n.ids), [['lead1']])
    await r.tick()
    assert.equal(r.nudges.length, 1, 'once per switch')
  } finally { r.done() }
})

test('stopped again after that "continue": restarted with the current agents, then "continue" once it is back', async () => {
  const r = rig({ log: [AUTO(NOW - 2 * MIN)] })
  try {
    r.env.active = 'B'; r.env.changeAt = NOW - 2 * MIN
    r.env.agents = [job('agent-1', NOW - MIN, 'aaaa0001')]
    await r.tick()
    assert.deepEqual(r.nudges.map((n) => n.ids), [['agent-1']])
    assert.equal(r.stale.length, 0)
    r.advance(MIN)
    r.env.agents = [job('agent-1', NOW + 30e3, 'aaaa0001')]
    await r.tick()
    assert.equal(r.stale.length, 1)
    assert.deepEqual(r.stale[0].ids, ['agent-1'])
    assert.equal(r.stale[0].agents[0].limitStopAt, NOW + 30e3, "the scan's current agents, not the switch-time snapshot")
    await flush(); await flush()
    assert.deepEqual(r.nudges.map((n) => n.ids), [['agent-1'], ['agent-1']], 'a restarted job waits for a prompt: it gets one')
    r.advance(MIN)
    await r.tick()
    assert.equal(r.stale.length, 1, 'restarted once per switch')
    assert.equal(r.calls.length, 0)
  } finally { r.done() }
})

// ---- account.mjs ----

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-switch-stalls-acct-'))
  const claude = path.join(root, 'claude')
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ env: { KEEP: '1' } }) + '\n')
  return { root, claude }
}

test('respawnStale with the current agents queues a job that stopped on the limit both before and after the switch', async () => {
  const { root, claude } = home()
  try {
    for (const short of ['aaaa0001', 'aaaa0002']) {
      fs.mkdirSync(path.join(claude, 'jobs', short), { recursive: true })
      fs.writeFileSync(path.join(claude, 'jobs', short, 'state.json'), JSON.stringify({ sessionId: `${short}-s`, state: 'blocked', tempo: 'blocked', detail: LIMIT }))
    }
    const slots = { A: 'login-a', B: 'login-b' }
    const st = { live: slots.A }
    const idOf = (t) => Object.keys(slots).find((k) => slots[k] === t) || null
    const clock = { t: 1_000_000 }
    const respawns = []
    const account = createAccount({
      dataDir: path.join(root, 'data'), claudeHome: () => claude, bin: async () => '/fake/claude', blocked: () => '',
      run: async (bin, args) => { if (args[0] === 'respawn') respawns.push(args[1]); return { timedOut: false, code: 0, stdout: '', stderr: '' } },
      accounts: {
        load: async () => [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }], readLive: async () => st.live, identify: async (t) => idOf(t),
        syncSlot: async () => {}, activate: async (id) => { st.live = slots[id] }, checkActive: async (id) => ({ ok: idOf(st.live) === id }),
        restoreLive: async (t) => { st.live = t }, readOauthAccount: async () => ({}), writeOauthAccount: async () => {},
      },
      activity: async () => 'idle', now: () => clock.t, sleep: async (ms) => { clock.t += ms; await flush() }, idleMs: () => 600_000, everyMs: () => 3_000,
    })
    // At the switch both had already stopped on the old account's limit (as on 2026-11-20).
    const atSwitch = ['aaaa0001', 'aaaa0002'].map((j) => ({ id: `agent-${j}`, jobId: j, live: true, kind: 'job', limitStopAt: clock.t - 15e3 }))
    await account.switchTo({ to: 'B' }, atSwitch, { auto: true })
    clock.t += 2e3
    // aaaa0001 stopped again after the switch; aaaa0002 did not.
    const current = [{ ...atSwitch[0], limitStopAt: clock.t }, atSwitch[1]]
    assert.deepEqual((await account.respawnStale(['agent-aaaa0001'])).queued, [], 'the switch-time snapshot still carries the old stop: the bug')
    const r = await account.respawnStale(['agent-aaaa0001', 'agent-aaaa0002'], current)
    assert.deepEqual(r.queued, ['aaaa0001'])
    await account.settled()
    assert.deepEqual(respawns, ['aaaa0001'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a job the scheduler parked as blocked on the usage limit or an API error is at a turn boundary', async () => {
  const { root, claude } = home()
  try {
    fs.mkdirSync(path.join(claude, 'jobs', 'aaaa0001'), { recursive: true })
    const state = (s) => fs.writeFileSync(path.join(claude, 'jobs', 'aaaa0001', 'state.json'), JSON.stringify({ sessionId: 's1', ...s }))
    const reg = (status) => fs.writeFileSync(path.join(claude, 'sessions', 'x.json'), JSON.stringify({ pid: process.pid, jobId: 'aaaa0001', status }))
    for (const detail of [LIMIT, "You've hit your weekly limit · resets 6am (America/New_York)", 'API Error: 500 Internal server error']) {
      state({ state: 'blocked', tempo: 'blocked', detail })
      for (const status of ['shell', 'idle', 'waiting']) { reg(status); assert.equal(await jobActivity(claude, 'aaaa0001'), 'idle', `${detail.slice(0, 20)} / ${status}`) }
      reg('needs_user')
      assert.equal(await jobActivity(claude, 'aaaa0001'), 'busy', 'a dialog is never cut off')
    }
    reg('shell')
    state({ state: 'blocked', tempo: 'blocked', detail: 'awaiting your yes on 19 jobs' })
    assert.equal(await jobActivity(claude, 'aaaa0001'), 'busy', 'a question to the user is not a stop')
    state({ state: 'blocked', tempo: 'active', detail: LIMIT })
    assert.equal(await jobActivity(claude, 'aaaa0001'), 'busy', 'the scheduler says it is working again')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---- decide() ----

test('really out is not held by the cooldown; a soft reason still is', () => {
  const base = {
    enabled: true, active: 'A', saved: ['A', 'B'], limitHit: false, busy: false, lastAutoAt: NOW - COOLDOWN_MS + 2 * MIN, poolAvailable: false, now: NOW,
    activeUsage: { fiveHour: w(40), weekly: w(30, 4 * DAY) }, usage: new Map([['B', { fiveHour: w(0), weekly: w(10, 4 * DAY) }]]),
  }
  assert.deepEqual([decide({ ...base, limitHit: true }).action, decide({ ...base, limitHit: true }).why], ['switch', 'limit'])
  assert.equal(decide({ ...base, activeUsage: { fiveHour: w(30), weekly: w(100, 4 * DAY) } }).action, 'switch')
  assert.equal(decide({ ...base, activeUsage: { fiveHour: w(96), weekly: w(30, 4 * DAY) } }).why, 'cooldown')
  assert.equal(decide({ ...base, projectedMs: 60e3 }).why, 'cooldown')
})
