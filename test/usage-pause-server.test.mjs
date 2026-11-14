/**
 * Usage pause (server/usage-pause.mjs) and its wiring: the state machine against fakes, the auto-switch
 * nudges it holds, and GET/POST /api/usage-pause. Fakes only: a temp data dir, fake agents, a fake clock,
 * a fake delivery. Never the real ~/.claude, ~/.codex, Keychain or network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUsagePause, shouldPause, pauseTargets, resumeTargets, PAUSE_TEXT, RESUME_TEXT } from '../server/usage-pause.mjs'
import { createSampler } from '../server/autoswitch.mjs'

const NOW = 1_800_000_000_000
const MIN = 60e3, H = 3600e3, DAY = 24 * H
const OUT = { why: 'all accounts low', until: NOW + 2 * H }
const top = (id, extra = {}) => ({ id, name: `Agent ${id}`, role: 'solo', kind: 'session', harness: 'claude-code', live: true, bucket: 'stalled', hidden: false, self: false, ...extra })

function rig({ agents = [top('a'), top('b')], file = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-usage-pause-'))
  if (file) fs.writeFileSync(path.join(dataDir, 'usage-pause.json'), JSON.stringify(file))
  let clock = NOW
  const env = { agents, blocked: null, room: false, fail: new Set() }
  const sent = [], logs = [], sleeps = []
  const make = () => createUsagePause({ dataDir,
    agents: async () => env.agents,
    blocked: async () => env.blocked,
    canRequest: async () => env.room,
    deliverTo: async (id, text) => { sent.push({ id, text }); return !env.fail.has(id) },
    log: (e) => logs.push(e), now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms } })
  const r = { dataDir, env, sent, logs, sleeps, pause: make(), restart() { r.pause = make() }, advance: (ms) => { clock += ms },
    file: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-pause.json'), 'utf8')),
    done: () => fs.rmSync(dataDir, { recursive: true, force: true }) }
  return r
}

test('shouldPause: only "all accounts low", not too_big, not a lapsed block', () => {
  assert.equal(shouldPause({ blocked: null, now: NOW }), false)
  assert.equal(shouldPause({ blocked: OUT, now: NOW }), true)
  assert.equal(shouldPause({ blocked: { why: 'all accounts low', until: null }, now: NOW }), true)
  assert.equal(shouldPause({ blocked: { reason: 'too_big', size: 1, max: 2 }, now: NOW }), false)
  assert.equal(shouldPause({ blocked: { why: 'all accounts low', until: NOW - 1 }, now: NOW }), false)
})

test('pauseTargets: top-level live Claude agents only', () => {
  const list = [top('a'), top('sub', { role: 'sub', kind: 'subagent' }), top('hid', { hidden: true }), top('me', { self: true }),
    top('rest', { bucket: 'resting' }), top('dead', { live: false }), top('cx', { harness: 'codex' }), top('lead', { role: 'lead', bucket: 'building' }), top('a')]
  assert.deepEqual(pauseTargets(list).map((t) => t.id), ['a', 'lead'])
  assert.deepEqual(pauseTargets([top('x')], 'x'), [])
})

test('resumeTargets: recorded, still there, not hidden, not already resumed', () => {
  const record = { agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'gone', name: 'G' }], resumed: [{ id: 'c', status: 'sent' }] }
  const now = [top('a', { bucket: 'resting' }), top('b', { hidden: true }), top('c')]
  assert.deepEqual(resumeTargets(record, now), [{ id: 'a', name: 'A' }])
})

test('full cycle: pause once, hold, resume once each staggered, then running', async () => {
  const r = rig({ agents: [top('a'), top('b'), top('s', { role: 'sub', kind: 'subagent' }), top('h', { hidden: true })] })
  try {
    assert.equal((await r.pause.tick()).state, 'running')
    assert.equal(r.sent.length, 0)
    r.env.blocked = OUT
    const p = await r.pause.tick()
    assert.equal(p.state, 'paused')
    assert.equal(p.reason, 'all accounts low')
    assert.equal(p.until, OUT.until)
    assert.deepEqual(p.agents, [{ id: 'a', name: 'Agent a' }, { id: 'b', name: 'Agent b' }])
    assert.deepEqual(r.sent, [{ id: 'a', text: PAUSE_TEXT }, { id: 'b', text: PAUSE_TEXT }])
    assert.equal(r.pause.holding(), true)
    assert.equal(r.logs.length, 1)
    assert.equal(r.logs[0].action, 'usage-pause')
    // Still out: many ticks, nothing more.
    for (let i = 0; i < 5; i++) { r.advance(MIN); await r.pause.tick() }
    assert.equal(r.sent.length, 2)
    // Not blocked any more but no real room yet: still paused.
    r.env.blocked = null
    assert.equal((await r.pause.tick()).state, 'paused')
    assert.equal(r.sent.length, 2)
    // Room: resume.
    r.env.room = true
    const done = await r.pause.tick()
    assert.equal(done.state, 'running')
    assert.equal(r.pause.holding(), false)
    assert.deepEqual(r.sent.slice(2), [{ id: 'a', text: RESUME_TEXT }, { id: 'b', text: RESUME_TEXT }])
    assert.deepEqual(r.sleeps, [2000])
    assert.deepEqual(done.resumed, [{ id: 'a', status: 'sent' }, { id: 'b', status: 'sent' }])
    assert.equal(r.logs.at(-1).action, 'usage-resume')
    // And quiet afterwards.
    await r.pause.tick(); await r.pause.tick()
    assert.equal(r.sent.length, 4)
  } finally { r.done() }
})

test('failed deliveries are never retried; a new pause is a new round', async () => {
  const r = rig()
  try {
    r.env.fail.add('b')
    r.env.blocked = OUT
    await r.pause.tick(); await r.pause.tick(); await r.pause.tick()
    assert.deepEqual(r.sent.map((s) => s.id), ['a', 'b'])
    assert.deepEqual(r.logs[0].results, [{ id: 'a', status: 'sent' }, { id: 'b', status: 'failed' }])
    r.env.blocked = null; r.env.room = true
    const info = await r.pause.tick()
    assert.deepEqual(info.resumed, [{ id: 'a', status: 'sent' }, { id: 'b', status: 'failed' }])
    await r.pause.tick()
    assert.equal(r.sent.length, 4)
    // A second outage later: each agent hears once again.
    r.env.blocked = OUT; r.env.room = false; r.env.fail.clear()
    await r.pause.tick()
    assert.equal(r.sent.length, 6)
  } finally { r.done() }
})

test('an agent that starts during the pause is told once; nothing for hidden or sub-agents', async () => {
  const r = rig({ agents: [top('a')] })
  try {
    r.env.blocked = OUT
    await r.pause.tick()
    r.env.agents = [top('a'), top('n'), top('h', { hidden: true }), top('s', { role: 'sub', kind: 'subagent' })]
    await r.pause.tick(); await r.pause.tick()
    assert.deepEqual(r.sent.map((s) => s.id), ['a', 'n'])
    assert.deepEqual(r.pause.info().agents.map((a) => a.id), ['a', 'n'])
  } finally { r.done() }
})

test('a restart mid-pause keeps the state and never re-sends', async () => {
  const r = rig()
  try {
    r.env.blocked = OUT
    await r.pause.tick()
    assert.equal(r.file().state, 'paused')
    r.restart()
    assert.equal(r.pause.holding(), true, 'holding straight after a restart, before any tick')
    await r.pause.tick()
    assert.equal(r.sent.length, 2)
    r.env.blocked = null; r.env.room = true
    await r.pause.tick()
    assert.equal(r.sent.length, 4)
  } finally { r.done() }
})

test('a restart mid-resume finishes the rest without repeating anyone', async () => {
  const r = rig({ agents: [top('a'), top('b'), top('c')],
    file: { enabled: true, state: 'resuming', since: NOW - H, until: null, reason: 'all accounts low', agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], resumed: [{ id: 'a', status: 'sent' }, { id: 'b', status: 'sending' }] } })
  try {
    assert.equal(r.pause.holding(), true)
    r.env.room = true
    const info = await r.pause.tick()
    assert.deepEqual(r.sent, [{ id: 'c', text: RESUME_TEXT }])
    assert.equal(info.state, 'running')
    assert.deepEqual(info.resumed, [{ id: 'a', status: 'sent' }, { id: 'b', status: 'sent-unconfirmed' }, { id: 'c', status: 'sent' }])
  } finally { r.done() }
})

test('blocked again mid-resume goes back to paused without new pause messages', async () => {
  const r = rig({ file: { enabled: true, state: 'resuming', since: NOW, until: null, reason: 'all accounts low', agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], resumed: [] } })
  try {
    r.env.blocked = OUT
    assert.equal((await r.pause.tick()).state, 'paused')
    assert.equal(r.sent.length, 0)
  } finally { r.done() }
})

test('disabled: no new pause; turning it off mid-pause releases the nudgers but still resumes', async () => {
  const r = rig()
  try {
    await r.pause.setEnabled(false)
    r.env.blocked = OUT
    assert.equal((await r.pause.tick()).state, 'running')
    assert.equal(r.sent.length, 0)
    await r.pause.setEnabled(true)
    await r.pause.tick()
    assert.equal(r.pause.holding(), true)
    await r.pause.setEnabled(false)
    assert.equal(r.pause.holding(), false)
    assert.equal(r.file().enabled, false)
    r.env.blocked = null; r.env.room = true
    await r.pause.tick()
    assert.deepEqual(r.sent.slice(2).map((s) => s.text), [RESUME_TEXT, RESUME_TEXT])
    await assert.rejects(r.pause.setEnabled('yes'), /true or false/)
  } finally { r.done() }
})

test('one tick at a time; a throwing dependency never breaks the loop', async () => {
  const r = rig()
  try {
    r.env.blocked = OUT
    const [x, y] = [r.pause.tick(), r.pause.tick()]
    assert.equal(x, y)
    await x
    assert.equal(r.sent.length, 2)
    const bad = createUsagePause({ dataDir: r.dataDir, agents: async () => { throw new Error('scan') }, blocked: async () => { throw new Error('x') },
      canRequest: async () => { throw new Error('y') }, deliverTo: async () => { throw new Error('z') }, now: () => NOW })
    assert.equal((await bad.tick()).state, 'paused') // persisted state from the rig; nothing to do safely
  } finally { r.done() }
})

test('nothing secret in the file or the log lines', async () => {
  const r = rig({ agents: [top('a', { prompt: 'TOPSECRET', transcriptFile: '/x/TOPSECRET.jsonl' })] })
  try {
    r.env.blocked = OUT
    await r.pause.tick()
    r.env.blocked = null; r.env.room = true
    await r.pause.tick()
    const all = fs.readFileSync(path.join(r.dataDir, 'usage-pause.json'), 'utf8') + JSON.stringify(r.logs)
    assert.ok(!all.includes('TOPSECRET'))
  } finally { r.done() }
})

// ---- auto-switch holds its "continue" nudge and stale-login respawn while paused ----
const w = (used, resetsIn = 3 * H) => ({ used, resetsAt: NOW + resetsIn })
function sampler({ holding }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-usage-pause-auto-'))
  fs.writeFileSync(path.join(dataDir, 'account-log.jsonl'), JSON.stringify({ at: NOW - 3 * H, action: 'switch', auto: true, from: 'A', to: 'B', restored: false }) + '\n')
  let clock = NOW
  const env = { reading: { fiveHour: w(100, 10 * MIN), weekly: w(30, 4 * DAY) }, agents: [{ id: 'j1', live: true, bucket: 'stalled', limitStopAt: NOW - 5 * MIN, limitText: "You've hit your session limit" }] }
  const nudges = []
  const list = ['A', 'B'].map((id) => ({ id, label: id, quarantine: false }))
  const account = {
    profile: async () => 'acct', lastChangeAt: async () => 0, isBusy: () => false, poolAvailable: () => false,
    switchTo: async () => ({ restored: false, results: [] }),
    accounts: { activeUsage: async () => ({ id: 'A', saved: true, ...env.reading }), load: async () => list, list: async () => ({ active: 'A' }),
      usage: async () => ({ accounts: [{ id: 'B', fiveHour: w(10), weekly: w(10, 4 * DAY) }] }) },
  }
  const s = createSampler({ dataDir, account, agents: async () => env.agents, nudge: async (ids) => { nudges.push(ids); return ids }, holding, now: () => clock })
  return { s, env, nudges, advance: (ms) => { clock += ms }, done: () => fs.rmSync(dataDir, { recursive: true, force: true }) }
}

test('auto-switch: no "continue" nudge at the 5-hour reset while the fleet is paused', async () => {
  for (const held of [true, false]) {
    const r = sampler({ holding: () => held })
    try {
      assert.equal((await r.s.tick()).why, 'waiting for the 5-hour reset')
      r.advance(11 * MIN)
      r.env.reading = { fiveHour: w(5, 5 * H), weekly: w(30, 4 * DAY) }
      await r.s.tick()
      assert.deepEqual(r.nudges, held ? [] : [['j1']])
    } finally { r.done() }
  }
})

// ---- HTTP ----
test('GET/POST /api/usage-pause', async () => {
  const { makeHome } = await import('./fixtures/make-home.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-usage-pause-http-'))
  Object.assign(process.env, makeHome(root))
  const { createServer } = await import('../server/serve.mjs')
  const dataDir = path.join(root, 'data')
  const server = createServer({ dataDir })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const get = await (await fetch(`${base}/api/usage-pause`)).json()
    assert.deepEqual(get, { enabled: true, state: 'running', since: null, until: null, reason: null, agents: [], resumed: [] })
    const post = (body, type = 'application/json') => fetch(`${base}/api/usage-pause`, { method: 'POST', headers: { origin: base, 'content-type': type }, body: JSON.stringify(body) })
    const off = await post({ enabled: false })
    assert.equal(off.status, 200)
    assert.equal((await off.json()).enabled, false)
    assert.equal((await (await fetch(`${base}/api/usage-pause`)).json()).enabled, false)
    assert.equal((await post({ enabled: 'no' })).status, 400)
    assert.equal((await post({ enabled: true }, 'text/plain')).status, 415)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-pause.json'), 'utf8')).enabled, false)
    assert.equal(typeof server.usagePause.holding, 'function')
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
