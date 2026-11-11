/**
 * Auto-switch: the decision (pure), then the sampler driving a real switch against a fake Claude
 * home, a fake `claude` and a fake Anthropic API. No real network, Keychain or switch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decide, COOLDOWN_MS, OUT_AT, AVAILABLE_BELOW } from '../server/autoswitch.mjs'
import { createServer } from '../server/serve.mjs'
import { makeAccountHome } from './fixtures/account-home.mjs'
import { fakeAnthropic, UUID, TOKEN_MARK } from './fixtures/fake-anthropic.mjs'

const NOW = 1_800_000_000_000
const w = (used, resetsIn = 3600e3) => ({ used, resetsAt: NOW + resetsIn })
const base = {
  enabled: true, active: 'A', saved: ['A', 'B', 'C', 'D'], limitHit: false, busy: false, lastAutoAt: 0, poolAvailable: true, now: NOW,
  activeUsage: { fiveHour: w(OUT_AT), weekly: w(10) },
  usage: new Map([
    ['B', { fiveHour: w(10, 3 * 3600e3), weekly: w(10) }],
    ['C', { fiveHour: w(50, 1 * 3600e3), weekly: w(20) }], // resets soonest
    ['D', { fiveHour: w(5, 600e3), weekly: w(AVAILABLE_BELOW) }], // resets even sooner, but its week is used up
  ]),
}

test('decide: an account with no 5-hour limit is never out on it, and always has 5-hour room', async () => {
  const { NO_LIMIT } = await import('../server/accounts.mjs')
  assert.equal(decide({ ...base, activeUsage: { fiveHour: NO_LIMIT, weekly: w(10) } }).why, 'not out')
  const only = new Map([['B', { fiveHour: NO_LIMIT, weekly: w(10) }]])
  assert.deepEqual(decide({ ...base, usage: only }), { action: 'switch', to: 'B', why: 'five_hour' })
})

test('decide: the available account whose 5-hour window resets soonest', () => {
  assert.deepEqual(decide(base), { action: 'switch', to: 'C', why: 'five_hour' })
  assert.deepEqual(decide({ ...base, activeUsage: { fiveHour: w(20), weekly: w(99.5) } }), { action: 'switch', to: 'C', why: 'weekly' })
  assert.deepEqual(decide({ ...base, activeUsage: { fiveHour: w(20), weekly: w(20) }, limitHit: true }), { action: 'switch', to: 'C', why: 'limit' })
  const errored = new Map([...base.usage, ['C', { error: 'Login expired — sign in again', fiveHour: null, weekly: null }]])
  assert.equal(decide({ ...base, usage: errored }).to, 'B', 'an account whose usage is unknown is not a target')
})

test('decide: all exhausted goes to the pool, or nowhere without one', () => {
  const out = new Map([...base.usage].map(([k, u]) => [k, { ...u, fiveHour: w(97) }]))
  assert.deepEqual(decide({ ...base, usage: out }), { action: 'switch', to: 'pool', why: 'five_hour' })
  assert.deepEqual(decide({ ...base, usage: out, poolAvailable: false }), { action: 'none', why: 'nowhere to go' })
})

test('decide: guards — toggle off, on the pool, unsaved login, busy, cooldown, not out', () => {
  assert.equal(decide({ ...base, enabled: false }).why, 'off')
  assert.equal(decide({ ...base, active: 'pool' }).why, 'on the pool', 'never from the pool back to an account')
  assert.equal(decide({ ...base, active: 'X' }).why, 'not a saved account')
  assert.equal(decide({ ...base, busy: true }).why, 'a switch is running')
  assert.equal(decide({ ...base, lastAutoAt: NOW - COOLDOWN_MS + 1000 }).why, 'cooldown')
  assert.equal(decide({ ...base, lastAutoAt: NOW - COOLDOWN_MS - 1 }).action, 'switch')
  assert.equal(decide({ ...base, activeUsage: { fiveHour: w(98.9), weekly: w(10) } }).why, 'not out')
})

// ---------- the sampler, end to end against fakes ----------
const PEOPLE = () => ({
  A: { email: 'a@example.com', five: 20, week: 10 },
  B: { email: 'b@example.com', five: 10, week: 10, fiveResetsIn: 3 * 3600e3 },
  C: { email: 'c@example.com', five: 40, week: 30, fiveResetsIn: 1 * 3600e3 },
})
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-auto-'))
  const home = makeAccountHome(root)
  const people = PEOPLE()
  const api = await fakeAnthropic(people)
  Object.assign(process.env, home.env, api.env)
  for (const k of ['FAKE_AUTH', 'FAKE_RESPAWN_FAIL', 'FAKE_RESPAWN_MS', 'FAKE_CLOBBER', 'FAKE_NO_LIVE', 'FAKE_REPLY', 'AGENTVILLE_TERMINAL', 'AGENTVILLE_SAMPLE_MS']) delete process.env[k]
  const dataDir = path.join(root, 'data')
  const server = createServer({ dataDir })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const credFile = path.join(home.home, '.credentials.json')
  const req = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { origin: base, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    const text = await r.text()
    assert.ok(!text.includes(TOKEN_MARK), 'no token in any response')
    return { status: r.status, json: JSON.parse(text) }
  }
  const creds = {}
  // Save A, B and C (A stays Claude's login), then move from the pool to A.
  for (const k of ['A', 'B', 'C']) {
    creds[k] = api.cred(k)
    if (k === 'A') { fs.writeFileSync(credFile, creds.A); await req('POST', '/api/accounts/capture', {}) } else {
      await req('POST', '/api/accounts/add/start', {})
      fs.writeFileSync(credFile, creds[k])
      await req('POST', '/api/accounts/add/finish', {})
    }
  }
  const r = await req('POST', '/api/account/switch', { to: UUID.A, confirm: (await req('GET', '/api/account')).json.confirm })
  assert.equal(r.status, 200)
  const respawns = () => fs.readFileSync(home.log, 'utf8').trim().split('\n').filter((l) => l.includes('"respawn"')).length
  return {
    people, api, dataDir, server, req, creds, respawns, live: () => fs.readFileSync(credFile, 'utf8'),
    async done() { server.close(); await api.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('projection: the binding window, and where auto-switch would go (cached readings only)', async () => {
  const t = await setup()
  try {
    t.people.A.fiveResetsIn = 4.6 * 3600e3 // A's window started 24 min ago
    await t.server.sampler.sample() // A at 20 %
    // 20 min of A rising +1 %/min to its 20 % now (the samples are in memory; inject a history).
    const list = t.server.sampler.samples.get(UUID.A), last = list.at(-1)
    list.unshift(...Array.from({ length: 20 }, (_, i) => ({ at: last.at - (20 - i) * 60e3, five: { ...last.five, used: i }, week: { ...last.week, used: last.week.used } })))
    const calls = () => t.api.requests.filter((r) => r.path === '/api/oauth/usage').length
    const n0 = calls()
    let p = (await t.req('GET', '/api/spend')).json.projection
    assert.equal(p.fiveHour.state, 'runsOut')
    assert.deepEqual([p.binding.window, p.binding.at], ['fiveHour', p.fiveHour.at])
    assert.equal(p.weekly.basis, 'flatOut')
    assert.equal(calls(), n0, 'the projection makes no usage calls')
    // B and C not read yet: nothing known to switch to but the pool.
    assert.deepEqual(p.next, { to: 'pool', label: 'the pool' })
    await t.req('GET', '/api/accounts/usage') // the menu reads every account: now the cache knows C resets soonest
    p = (await t.req('GET', '/api/spend')).json.projection
    assert.deepEqual(p.next, { to: UUID.C, label: 'c@example.com' })
    await t.req('POST', '/api/autoswitch', { enabled: false })
    assert.equal((await t.req('GET', '/api/spend')).json.projection.next, null, 'auto-switch off: no hint')
  } finally { await t.done() }
})

test('sampler: samples the active account only; when it runs out, switches to the soonest-reset account', async () => {
  const t = await setup()
  try {
    const usageCalls = () => t.api.requests.filter((r) => r.path === '/api/oauth/usage').map((r) => r.account)
    const n0 = usageCalls().length
    let d = await t.server.sampler.sample()
    assert.equal(d.why, 'not out')
    assert.deepEqual(usageCalls().slice(n0), ['A'], 'only the active account is sampled')
    assert.equal(t.api.requests.filter((r) => r.path === '/v1/oauth/token').length, 0, 'and nothing is refreshed')
    let spend = (await t.req('GET', '/api/spend')).json
    assert.deepEqual([spend.projection.account, spend.projection.fiveHour.used, spend.projection.fiveHour.state], [UUID.A, 20, 'gathering'])
    assert.equal(spend.autoSwitch.enabled, true, 'on by default')

    const before = t.respawns()
    t.people.A.five = 99
    d = await t.server.sampler.sample()
    assert.deepEqual([d.action, d.to, d.why], ['switch', UUID.C, 'five_hour'])
    assert.equal(t.live(), t.creds.C, "C's login is now Claude's")
    assert.equal(t.respawns() - before, 2, 'the running jobs were respawned (canary first)')
    const log = fs.readFileSync(path.join(t.dataDir, 'account-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1)
    assert.deepEqual([log.action, log.auto, log.account, log.restored], ['switch', true, UUID.C, false])
    spend = (await t.req('GET', '/api/spend')).json
    assert.deepEqual([spend.autoSwitch.last.to, spend.autoSwitch.last.toLabel, spend.autoSwitch.last.fromLabel, spend.autoSwitch.last.why, spend.autoSwitch.last.respawned], [UUID.C, 'c@example.com', 'a@example.com', 'five_hour', 2])
    assert.equal(fs.statSync(path.join(t.dataDir, 'autoswitch.json')).mode & 0o777, 0o600)

    // C runs out too, inside the cooldown: nothing happens.
    t.people.C.five = 100
    d = await t.server.sampler.sample()
    assert.equal(d.why, 'cooldown')
    assert.equal(t.live(), t.creds.C)
  } finally { await t.done() }
})

test('sampler: everything exhausted goes to the pool, and never back; the toggle and a running switch stop it', async () => {
  const t = await setup()
  try {
    assert.deepEqual((await t.req('POST', '/api/autoswitch', { enabled: false })).json, { enabled: false })
    t.people.A.five = 100
    assert.equal((await t.server.sampler.sample()).why, 'off')
    assert.equal((await t.req('POST', '/api/autoswitch', { enabled: 'yes' })).status, 400)
    await t.req('POST', '/api/autoswitch', { enabled: true })

    // A manual switch in progress: the sampler stands aside.
    process.env.FAKE_RESPAWN_MS = '500'
    const manual = t.req('POST', '/api/account/switch', { to: UUID.B, confirm: (await t.req('GET', '/api/account')).json.confirm })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal((await t.server.sampler.sample()).why, 'a switch is running')
    assert.equal((await manual).status, 200)
    delete process.env.FAKE_RESPAWN_MS

    // Now on B; every account is out: the pool.
    t.people.B.five = 99.5
    t.people.C.week = 97
    const d = await t.server.sampler.sample()
    assert.deepEqual([d.action, d.to], ['switch', 'pool'])
    assert.equal((await t.req('GET', '/api/accounts')).json.active, 'pool')
    assert.equal((await t.req('GET', '/api/spend')).json.projection, null, 'no projection on the pool')
    t.people.B.five = 0
    assert.equal((await t.server.sampler.sample()).why, 'on the pool')
  } finally { await t.done() }
})

test('decide: quarantine accounts — gone at once on the work Wi-Fi, preferred elsewhere', () => {
  const quarantine = new Set(['B', 'D'])
  const fine = { fiveHour: w(20), weekly: w(10) }
  // On the work Wi-Fi a quarantine account leaves at once: not out, auto-switch off, in cooldown.
  const banned = { ...base, active: 'B', activeUsage: fine, onWork: true, quarantine, enabled: false, lastAutoAt: NOW - 1000 }
  assert.deepEqual(decide(banned), { action: 'switch', to: 'C', why: 'quarantine' })
  assert.equal(decide({ ...banned, busy: true }).why, 'a switch is running')
  // Even when every regular account is used up: the one that frees up soonest.
  const spent = new Map([['A', { fiveHour: w(100, 2 * 3600e3), weekly: w(40) }], ['C', { fiveHour: w(100, 600e3), weekly: w(99) }], ['D', fine]])
  assert.deepEqual(decide({ ...banned, usage: spent }), { action: 'switch', to: 'C', why: 'quarantine' })
  assert.deepEqual(decide({ ...banned, usage: new Map() }), { action: 'switch', to: 'A', why: 'quarantine' }, 'usage unknown: still a regular account')
  assert.equal(decide({ ...banned, saved: ['B', 'D'], poolAvailable: false }).why, 'nowhere to go', 'no regular account at all')
  // Out on the work Wi-Fi: regular accounts only.
  const both = new Map([['B', { fiveHour: w(10, 600e3), weekly: w(10) }], ['C', { fiveHour: w(10, 3600e3), weekly: w(10) }]])
  assert.equal(decide({ ...base, usage: both, onWork: true, quarantine }).to, 'C')
  // Out anywhere else: a quarantine account first, even when a regular one resets sooner.
  const regularSooner = new Map([['B', { fiveHour: w(10, 3 * 3600e3), weekly: w(10) }], ['C', { fiveHour: w(10, 600e3), weekly: w(10) }]])
  assert.equal(decide({ ...base, usage: regularSooner, quarantine }).to, 'B')
  // The 10 s check off the work Wi-Fi on a regular account: a quarantine account with room, else stay.
  const prefer = { ...base, active: 'A', activeUsage: null, quarantine, usage: regularSooner, prefer: true }
  assert.deepEqual(decide(prefer), { action: 'switch', to: 'B', why: 'prefer' })
  assert.equal(decide({ ...prefer, usage: new Map([['B', { fiveHour: w(99), weekly: w(10) }], ['C', fine]]) }).why, 'no quarantine account available', 'never to another regular one')
  assert.equal(decide({ ...prefer, active: 'D' }).why, 'not out', 'already on a quarantine account')
  assert.equal(decide({ ...prefer, enabled: false }).why, 'off', 'the preference respects the toggle')
  assert.equal(decide({ ...prefer, lastAutoAt: NOW - 1000 }).why, 'cooldown', 'and the cooldown')
})

test('network rule (every 10 s): off a quarantine account at once on the work Wi-Fi, onto one anywhere else', async () => {
  const t = await setup()
  const settle = () => new Promise((r) => setTimeout(r, 300)) // the check that marking the network starts
  try {
    process.env.AGENTVILLE_NETWORK_ID = 'gw:00:00:00:00:00:01' // fake networks: the real one is never read
    await t.req('PATCH', `/api/accounts/${UUID.B}`, { quarantine: true })
    assert.equal((await t.server.sampler.enforce()).why, 'no work network marked', 'nothing happens until one is marked')

    process.env.AGENTVILLE_NETWORK_ID = 'gw:00:00:00:00:00:0f' // at the office
    assert.equal((await t.req('POST', '/api/network/work', { work: true })).json.current.work, true)
    await settle()
    assert.equal((await t.server.sampler.enforce()).why, 'right kind of account', 'a regular account at the office stays')

    process.env.AGENTVILLE_NETWORK_ID = 'gw:00:00:00:00:00:01' // home again: onto the quarantine account
    let d = await t.server.sampler.enforce()
    assert.deepEqual([d.action, d.to, d.why], ['switch', UUID.B, 'prefer'])
    assert.equal(t.live(), t.creds.B)

    process.env.AGENTVILLE_NETWORK_ID = 'none' // offline: nothing changes
    assert.equal((await t.server.sampler.enforce()).why, 'offline')

    // Back at the office, inside the cooldown and with every regular account used up: off B anyway.
    t.people.A.five = 100; t.people.C.five = 100
    await t.req('GET', '/api/accounts/usage?fresh=1')
    process.env.AGENTVILLE_NETWORK_ID = 'gw:00:00:00:00:00:0f'
    d = await t.server.sampler.enforce()
    assert.deepEqual([d.action, d.why], ['switch', 'quarantine'])
    assert.equal(d.to, UUID.C, 'the regular account that frees up soonest')
    assert.equal(t.live(), t.creds.C)
    assert.equal((await t.req('GET', '/api/spend')).json.autoSwitch.last.why, 'quarantine')

    // Home, but the quarantine account has no room: stay on the regular one.
    t.people.B.five = 100
    await t.req('GET', '/api/accounts/usage?fresh=1')
    process.env.AGENTVILLE_NETWORK_ID = 'gw:00:00:00:00:00:01'
    await t.req('POST', '/api/autoswitch', { enabled: true })
    d = await t.server.sampler.enforce()
    assert.ok(['cooldown', 'no quarantine account available'].includes(d.why), d.why)
    assert.equal(t.live(), t.creds.C)
  } finally { delete process.env.AGENTVILLE_NETWORK_ID; await t.done() }
})

test('decide: prefers the account whose weekly window resets soonest, then the 5-hour one', () => {
  const usage = new Map([
    ['B', { fiveHour: w(10, 600e3), weekly: w(10, 7 * 86400e3) }], // 5-hour resets sooner, but its week resets in 7 days
    ['C', { fiveHour: w(10, 3 * 3600e3), weekly: w(30, 2 * 86400e3) }], // week resets in 2 days: use it first
  ])
  assert.deepEqual(decide({ ...base, usage }), { action: 'switch', to: 'C', why: 'five_hour' })
})
