/**
 * Low-priority accounts: the PATCH flag, the weighting in decide() (urgency = weekly room / hours to the
 * reset, a quarter for low priority, use-it-or-lose-it floor, a margin against trading places), and the
 * sampler carrying the note. Pure decide() plus a fake account and clock, and one server against a fake
 * Claude home and a fake Anthropic API: no real ~/.claude, Keychain, network or accounts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  decide, createSampler, urgency, mustDrain, COOLDOWN_MS, OUT_AT, REBALANCE_CHECK_MS,
  LOW_PRIORITY_WEIGHT, LOW_PRIORITY_MARGIN, LOW_PRIORITY_DRAIN_PER_HOUR, FLAT_OUT_WEEK_PER_HOUR, URGENCY_MIN_HOURS,
} from '../server/autoswitch.mjs'
import { NO_LIMIT } from '../server/accounts.mjs'
import { decideBefore } from './fixtures/autoswitch-decide-before-lowprio.mjs'
import { createServer } from '../server/serve.mjs'
import { makeAccountHome } from './fixtures/account-home.mjs'
import { fakeAnthropic, UUID, TOKEN_MARK } from './fixtures/fake-anthropic.mjs'

const NOW = 1_800_000_000_000
const MIN = 60e3
const H = 3600e3
const DAY = 24 * H
const w = (used, resetsIn = H) => ({ used, resetsAt: NOW + resetsIn })
const u = (five, week) => ({ fiveHour: five, weekly: week })
const LOW = new Set(['L'])
const base = {
  enabled: true, active: 'A', saved: ['A', 'B', 'L'], limitHit: false, busy: false, lastAutoAt: 0, poolAvailable: true, now: NOW,
  activeUsage: u(w(OUT_AT, 2 * H), w(40, 4 * DAY)), lowPriority: LOW,
}
const withUsage = (entries, extra = {}) => ({ ...base, usage: new Map(entries), ...extra })

test('the constants: a quarter weight, a 1.25 margin, drain floor at half of one 5-hour window per 5 hours', () => {
  assert.equal(LOW_PRIORITY_WEIGHT, 0.25)
  assert.equal(LOW_PRIORITY_MARGIN, 1.25)
  assert.equal(FLAT_OUT_WEEK_PER_HOUR, 5, '100 % of the 5-hour window per 5 h at the default ratio 0.25')
  assert.equal(LOW_PRIORITY_DRAIN_PER_HOUR, 2.5)
  assert.equal(URGENCY_MIN_HOURS, 1)
})

test('urgency and mustDrain: room per hour to the weekly reset; unknown is 0 / false', () => {
  assert.equal(urgency(u(w(0), w(20, 24 * H)), NOW).toFixed(3), (80 / 24).toFixed(3))
  assert.equal(urgency(u(w(0), w(50, 5 * DAY)), NOW).toFixed(3), (50 / 120).toFixed(3))
  assert.equal(urgency(u(w(0), w(50, 10 * MIN)), NOW), 50, 'hours floored at 1')
  assert.equal(urgency(u(w(0), { used: 10, resetsAt: null }), NOW), 0)
  assert.equal(urgency({ error: 'x' }, NOW), 0)
  assert.equal(urgency(null, NOW), 0)
  assert.equal(mustDrain(u(w(0), w(20, 24 * H)), NOW), true, '80 % in 24 h > 2.5 %/h')
  assert.equal(mustDrain(u(w(0), w(20, 7 * DAY)), NOW), false)
  assert.equal(mustDrain(u(w(0), w(55, 20 * H)), NOW), false, '45 % in 20 h = 2.25 %/h: drainable')
  assert.equal(mustDrain(u(w(0), w(55, 20 * H)), NOW, true), true, 'the active one keeps it down to 2 %/h')
  assert.equal(mustDrain(u(w(0), { used: 0, resetsAt: null }), NOW), false)
})

test('skipped while a regular account has room and its reset is far away', () => {
  const s = withUsage([['B', u(w(10, 3 * H), w(50, 5 * DAY))], ['L', u(w(0, 4 * H), w(20, 6.5 * DAY))]])
  assert.deepEqual(decide(s), { action: 'switch', to: 'B', why: 'five_hour' })
  // Without the flag L would win (most weekly room): the weighting is what holds it back.
  assert.equal(decide({ ...s, lowPriority: new Set() }).to, 'L')
  // A week out with 80 % left: urgency 0.48, weighted 0.12, against B's 0.42.
  assert.equal(decide(withUsage([['B', u(w(10), w(50, 5 * DAY))], ['L', u(w(0), w(20, 7 * DAY - MIN))]])).to, 'B')
})

test("chosen near its reset with lots of room (the user's 1 day / 80 % example), with a note", () => {
  const d = decide(withUsage([['B', u(w(10, 3 * H), w(50, 5 * DAY))], ['L', u(w(0, 4 * H), w(20, 24 * H))]]))
  assert.deepEqual(d, { action: 'switch', to: 'L', why: 'five_hour', note: 'low priority, but its week resets in 24 h with 80% left' })
  // By weighting alone (below the drain floor): 60 % in 30 h = 2 %/h, weighted 0.5, beats B's 40 % in 5 days (0.33).
  const near = withUsage([['B', u(w(10), w(60, 5 * DAY))], ['L', u(w(0), w(40, 30 * H))]])
  assert.equal(mustDrain(near.usage.get('L'), NOW), false)
  assert.deepEqual(decide(near), { action: 'switch', to: 'L', why: 'five_hour', note: 'low priority, but its week resets in 30 h with 60% left' })
  // Days in the note past 48 h.
  const far = decide(withUsage([['L', u(w(0), w(10, 3 * DAY))]]))
  assert.equal(far.note, 'low priority, but no regular account has room')
})

test('used when every regular account is out: never excluded, only weighted down', () => {
  const outB = u(w(97, 3 * H), w(50, 5 * DAY))
  assert.deepEqual(decide(withUsage([['B', outB], ['L', u(w(0), w(70, 7 * DAY - MIN))]])),
    { action: 'switch', to: 'L', why: 'five_hour', note: 'low priority, but no regular account has room' })
  // The last resort too: only nearly-used accounts left, L is one of them and the only one that can run.
  const fb = decide(withUsage([['B', u(w(95), w(98, 5 * DAY))], ['L', u(w(50), w(90, 6 * DAY))]]))
  assert.deepEqual(fb, { action: 'switch', to: 'L', why: 'five_hour', fallback: true, note: 'low priority, but no regular account has room' })
  // In the last resort a regular one that can run still beats a low-priority one far from its reset.
  const fb2 = decide(withUsage([['B', u(w(50), w(92, 4 * DAY))], ['L', u(w(50), w(85, 6 * DAY))]]))
  assert.deepEqual([fb2.to, fb2.fallback, fb2.note], ['B', true, undefined])
  // Several low-priority ones and no regular one: today's order among them (most weekly room).
  const two = decide({ ...withUsage([['B', outB], ['L', u(w(0), w(50, 6 * DAY))], ['M', u(w(0), w(30, 6 * DAY))]]), saved: ['A', 'B', 'L', 'M'], lowPriority: new Set(['L', 'M']) })
  assert.equal(two.to, 'M')
})

test('rebalance onto a low-priority account: only when its reset is sooner AND it beats the active one by the margin', () => {
  const reb = { rebalance: true, activeUsage: u(w(20, 2 * H), w(50, 5 * DAY)) } // A: 50 % in 120 h = 0.42
  // The user's example: L at 80 % with a day left. Its week resets 4 days sooner; 0.83 weighted (in fact drained in full).
  assert.deepEqual(decide(withUsage([['L', u(w(10, 2 * H), w(20, 24 * H))]], reb)),
    { action: 'switch', to: 'L', why: 'rebalance', note: 'low priority, but its week resets in 24 h with 80% left' })
  // Resets 2 days sooner, but 50 % in 3 days = 0.69, weighted 0.17 < 1.25 x 0.42: stays.
  assert.deepEqual(decide(withUsage([['L', u(w(10, 2 * H), w(50, 3 * DAY))]], reb)), { action: 'none', why: 'not out' })
  assert.equal(decide({ ...withUsage([['L', u(w(10, 2 * H), w(50, 3 * DAY))]], reb), lowPriority: new Set() }).to, 'L', 'a regular one would be taken')
})

test('leaving a low-priority account: rebalance moves to a regular one that is clearly more urgent', () => {
  const onL = { active: 'L', rebalance: true, activeUsage: u(w(20, 2 * H), w(40, 3 * DAY)) } // 60 % in 72 h: 0.83, weighted 0.21
  // B resets later (no "sooner" rule) but 50 % in 5 days = 0.42 >= 1.25 x 0.21.
  assert.deepEqual(decide(withUsage([['B', u(w(10, 2 * H), w(50, 5 * DAY))]], onL)),
    { action: 'switch', to: 'B', why: 'rebalance', note: "off a low-priority account: this one's week resets in 5 days with 50% left" })
  assert.equal(decide({ ...withUsage([['B', u(w(10, 2 * H), w(50, 5 * DAY))]], onL), lowPriority: new Set() }).action, 'none', 'a regular active one stays (unchanged)')
  // Inside the margin: B 0.24 vs 1.25 x 0.21 = 0.26: stays.
  assert.equal(decide(withUsage([['B', u(w(10, 2 * H), w(71, 5 * DAY))]], onL)).action, 'none')
  // B without rebalance room (5-hour window busy): stays.
  assert.equal(decide(withUsage([['B', u(w(85, 2 * H), w(50, 5 * DAY))]], onL)).action, 'none')
  // A low-priority account that must be drained (90 % in 30 h) is not left for a merely more urgent one.
  const drain = { ...onL, activeUsage: u(w(20, 2 * H), w(10, 30 * H)) }
  assert.equal(decide(withUsage([['B', u(w(10, 2 * H), w(20, 2 * DAY))]], drain)).action, 'none')
  // ...but the old "resets REBALANCE_LEAD_MS sooner" rule still applies to it, as to any account.
  assert.equal(decide(withUsage([['B', u(w(10, 2 * H), w(20, 20 * H))]], drain)).to, 'B')
  // A hand-picked low-priority account is never rebalanced away.
  assert.equal(decide({ ...withUsage([['B', u(w(10, 2 * H), w(50, 5 * DAY))]], onL), manual: true }).why, 'not out')
})

test('the margin works both ways: two accounts with close weighted urgencies never trade places', () => {
  // On B (regular): L must beat 1.25 x B. On L: B must beat 1.25 x weighted L. Sweep L's room across the band.
  const bU = u(w(10, 2 * H), w(60, 4 * DAY)) // 0.42
  for (let used = 0; used <= 80; used += 1) {
    const lU = u(w(10, 2 * H), w(used, 12 * H)) // resets sooner, so only the urgency test can hold it back
    const toL = decide({ ...withUsage([['B', bU], ['L', lU]]), active: 'B', activeUsage: bU, rebalance: true }).to === 'L'
    const toB = decide({ ...withUsage([['B', bU], ['L', lU]]), active: 'L', activeUsage: lU, rebalance: true }).to === 'B'
    assert.ok(!(toL && toB), `room ${100 - used}: both directions would switch`)
  }
})

test('no oscillation over simulated time (rebalance every 15 min, the cooldown, burning the active account)', () => {
  // Two regular-vs-low-priority set-ups, one with urgencies that stay close for days.
  for (const [label, start, burn] of [
    ['wide', { A: { used: 40, resetsIn: 5 * DAY }, L: { used: 10, resetsIn: 3 * DAY } }, 0.6],
    // A: 30 % in 120 h = 0.25; L: 100 % in 96 h, weighted 0.26: inside the margin at the start.
    ['close', { A: { used: 70, resetsIn: 5 * DAY }, L: { used: 0, resetsIn: 4 * DAY } }, 0.35],
  ]) {
    const st = { A: { ...start.A, resetsAt: NOW + start.A.resetsIn }, L: { ...start.L, resetsAt: NOW + start.L.resetsIn } }
    let active = 'A', lastAutoAt = 0
    const switches = []
    for (let t = NOW; t < NOW + 6 * DAY; t += REBALANCE_CHECK_MS) {
      for (const k of ['A', 'L']) if (st[k].resetsAt <= t) { st[k].used = 0; st[k].resetsAt += 7 * DAY } // a weekly reset
      st[active].used = Math.min(100, st[active].used + burn / 4)
      const read = (k) => ({ fiveHour: { used: 30, resetsAt: t + 2 * H }, weekly: { used: st[k].used, resetsAt: st[k].resetsAt } })
      const out = st[active].used >= OUT_AT
      const other = active === 'A' ? 'L' : 'A'
      const d = decide({ enabled: true, active, saved: ['A', 'L'], activeUsage: read(active), usage: new Map([[other, read(other)]]), limitHit: false, busy: false,
        lastAutoAt, poolAvailable: false, now: t, lowPriority: LOW, rebalance: !out })
      if (d.action === 'switch') { switches.push({ t, to: d.to }); active = d.to; lastAutoAt = t }
    }
    for (let i = 1; i < switches.length; i++) {
      assert.ok(switches[i].t - switches[i - 1].t >= 12 * H, `${label}: switched back within ${(switches[i].t - switches[i - 1].t) / H} h`)
    }
    assert.ok(switches.length <= 3, `${label}: ${switches.length} switches in 6 days`)
  }
})

test('regular-only: the same decisions as before, on the existing fixtures and on random scenarios', () => {
  const fixtures = [ // the autoswitch.test.mjs / autoswitch-rebalance.test.mjs shapes
    { activeUsage: u(w(OUT_AT), w(10)), usage: new Map([['B', u(w(10, 3 * H), w(10))], ['C', u(w(50, H), w(20))], ['D', u(w(5, 600e3), w(95))]]) },
    { rebalance: true, activeUsage: u(w(20, 2 * H), w(30, 5 * DAY)), usage: new Map([['B', u(w(10, 2 * H), w(30, DAY))]]) },
    { activeUsage: u(NO_LIMIT, w(10)), usage: new Map([['B', u(NO_LIMIT, w(10))]]) },
  ]
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
  const reading = () => (rnd() < 0.05 ? { error: 'Login expired', fiveHour: null, weekly: null }
    : u(rnd() < 0.1 ? NO_LIMIT : w(Math.round(rnd() * 100), rnd() * 5 * H), rnd() < 0.05 ? { used: 0, resetsAt: null } : w(Math.round(rnd() * 100), rnd() * 7 * DAY)))
  for (let i = 0; i < 3000; i++) {
    const ids = ['B', 'C', 'D'].slice(0, 1 + Math.floor(rnd() * 3))
    fixtures.push({
      saved: ['A', ...ids], activeUsage: rnd() < 0.1 ? null : reading(), usage: new Map(ids.map((id) => [id, reading()])),
      limitHit: rnd() < 0.2, manual: rnd() < 0.3, rebalance: rnd() < 0.4, prefer: rnd() < 0.2, onWork: rnd() < 0.2,
      quarantine: new Set(ids.filter(() => rnd() < 0.3).concat(rnd() < 0.15 ? ['A'] : [])), projectedMs: pick([null, 60e3, 3600e3]),
    })
  }
  for (const f of fixtures) {
    const args = { enabled: true, active: 'A', saved: ['A', 'B', 'C', 'D'], limitHit: false, busy: false, lastAutoAt: 0, poolAvailable: true, now: NOW, ...f }
    const before = decideBefore(args)
    assert.deepEqual(decide(args), before)
    assert.deepEqual(decide({ ...args, lowPriority: new Set(['Z']) }), before, 'a low-priority id that is not in play changes nothing')
  }
})

test('quarantine, the network ban and prefer', () => {
  const Q = new Set(['L'])
  // The ban wins over everything: off a quarantine account on the work Wi-Fi to a low-priority regular one.
  const ban = { ...withUsage([['B', u(w(10), w(10, DAY))]]), saved: ['A', 'B'], active: 'A', activeUsage: u(w(10), w(10, DAY)), onWork: true, quarantine: new Set(['A']), lowPriority: new Set(['B']), lastAutoAt: NOW - MIN }
  assert.deepEqual([decide(ban).action, decide(ban).to, decide(ban).why], ['switch', 'B', 'quarantine'])
  assert.equal(decide({ ...ban, enabled: false }).to, 'B', 'toggle notwithstanding')
  // On the work Wi-Fi a quarantine + low-priority account is never a candidate, however urgent.
  const work = withUsage([['B', u(w(97), w(50, 5 * DAY))], ['L', u(w(0), w(10, 20 * H))]], { onWork: true, quarantine: Q })
  assert.equal(decide(work).action, 'none')
  // Off it, a quarantine + low-priority account: weighted like any low-priority one, then quarantine-first.
  const off = withUsage([['B', u(w(10), w(50, 5 * DAY))], ['L', u(w(0), w(30, 6 * DAY))]], { quarantine: Q })
  assert.equal(decide(off).to, 'B', 'held back: 70 % in 6 days is weighted 0.12 < 0.42')
  assert.equal(decide({ ...off, lowPriority: new Set() }).to, 'L', 'a plain quarantine account still comes first')
  assert.equal(decide({ ...off, usage: new Map([['B', u(w(10), w(50, 5 * DAY))], ['L', u(w(0), w(30, 24 * H))]]) }).to, 'L', 'urgent: quarantine-first again')
  // prefer (enforce, off the work Wi-Fi, activeUsage null: the active reading comes from the cache).
  const reg = u(w(10), w(50, 5 * DAY))
  const prefer = { ...withUsage([['A', reg], ['L', u(w(0), w(30, 6 * DAY))]]), activeUsage: null, quarantine: Q, prefer: true }
  assert.deepEqual(decide(prefer), { action: 'none', why: 'the quarantine account is low priority' })
  assert.deepEqual(decide({ ...prefer, lowPriority: new Set() }), { action: 'switch', to: 'L', why: 'prefer' }, 'prefer unchanged for a plain quarantine account')
  const urgent = decide({ ...prefer, usage: new Map([['A', reg], ['L', u(w(0), w(30, 24 * H))]]) })
  assert.deepEqual(urgent, { action: 'switch', to: 'L', why: 'prefer', note: 'low priority, but its week resets in 24 h with 70% left' })
  assert.equal(decide({ ...prefer, lastAutoAt: NOW - MIN }).why, 'cooldown')
  // A quarantine account that is not low priority is still preferred over a low-priority quarantine one.
  const both = decide({ ...prefer, saved: ['A', 'L', 'Q2'], quarantine: new Set(['L', 'Q2']), usage: new Map([['A', reg], ['L', u(w(0), w(0, 2 * DAY))], ['Q2', u(w(0), w(70, 6 * DAY))]]) })
  assert.equal(both.to, 'Q2')
})

// ---- the sampler, with a fake account and clock ----
function rig({ active = 'A', reading, usage, list }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-auto-lowprio-'))
  const clock = NOW
  const env = { active, reading, usage, changeAt: NOW - 3 * H }
  fs.writeFileSync(path.join(dataDir, 'account-log.jsonl'), JSON.stringify({ at: NOW - 3 * H, action: 'switch', auto: true, to: active, restored: false }) + '\n')
  const calls = []
  const account = {
    profile: async () => 'acct',
    lastChangeAt: async () => env.changeAt,
    isBusy: () => false,
    async switchTo(body, _agents, meta) { calls.push({ body, meta }); env.active = body.to; env.changeAt = clock; return { restored: false, results: [] } },
    accounts: {
      activeUsage: async () => ({ id: env.active, saved: true, ...env.reading }),
      load: async () => list,
      list: async () => ({ active: env.active }),
      usage: async () => ({ accounts: [...env.usage].map(([id, x]) => ({ id, ...x })) }),
      cachedUsage: () => env.usage,
    },
  }
  const sampler = createSampler({ dataDir, account, network: null, agents: async () => [], now: () => clock })
  return { sampler, env, calls, done: () => fs.rmSync(dataDir, { recursive: true, force: true }) }
}
const LIST = [{ id: 'A', label: 'a' }, { id: 'B', label: 'b' }, { id: 'L', label: 'l', lowPriority: true }]

test('sampler: reads lowPriority off the saved list; the switch, info().last and the audit why carry the note', async () => {
  const r = rig({ reading: u(w(OUT_AT, 2 * H), w(40, 4 * DAY)), list: LIST,
    usage: new Map([['B', u(w(10, 3 * H), w(50, 5 * DAY))], ['L', u(w(0, 4 * H), w(20, 24 * H))]]) })
  try {
    const d = await r.sampler.tick()
    assert.deepEqual([d.action, d.to, d.note], ['switch', 'L', 'low priority, but its week resets in 24 h with 80% left'])
    assert.equal(r.calls[0].meta.why.note, d.note)
    const last = (await r.sampler.info()).last
    assert.deepEqual([last.to, last.toLabel, last.why, last.note], ['L', 'l', 'five_hour', d.note])
  } finally { r.done() }
  const far = rig({ reading: u(w(OUT_AT, 2 * H), w(40, 4 * DAY)), list: LIST,
    usage: new Map([['B', u(w(10, 3 * H), w(50, 5 * DAY))], ['L', u(w(0, 4 * H), w(20, 7 * DAY - MIN))]]) })
  try {
    const d = await far.sampler.tick()
    assert.deepEqual([d.to, d.note], ['B', undefined])
    assert.equal('note' in (await far.sampler.info()).last, false)
  } finally { far.done() }
})

// ---- the PATCH route, against a fake Claude home and a fake Anthropic API ----
const PEOPLE = { A: { email: 'a@example.com', five: 12.5, week: 40 }, B: { email: 'b@example.com', five: 80, week: 95 } }
async function server() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-lowprio-'))
  const home = makeAccountHome(root)
  const api = await fakeAnthropic(PEOPLE)
  Object.assign(process.env, home.env, api.env, { AGENTVILLE_ACCOUNT_POLL_MS: '30', AGENTVILLE_ACCOUNT_IDLE_MAX_MS: '2000' })
  for (const k of ['FAKE_AUTH', 'FAKE_RESPAWN_FAIL', 'FAKE_RESPAWN_MS', 'FAKE_CLOBBER', 'FAKE_NO_LIVE', 'FAKE_REPLY', 'AGENTVILLE_TERMINAL']) delete process.env[k]
  const dataDir = path.join(root, 'data')
  const srv = createServer({ dataDir })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const credFile = path.join(home.home, '.credentials.json'), configFile = path.join(home.home, '.claude.json')
  const texts = []
  const req = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { origin: base, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    texts.push(text)
    return { status: r.status, json: JSON.parse(text), text }
  }
  const login = (key) => {
    fs.writeFileSync(credFile, api.cred(key), { mode: 0o600 })
    fs.writeFileSync(configFile, JSON.stringify({ numStartups: 3, oauthAccount: api.oauthAccount(key) }, null, 2) + '\n')
  }
  return { dataDir, req, login, texts, async done() { srv.close(); await api.close(); fs.rmSync(root, { recursive: true, force: true }) } }
}

test('PATCH lowPriority: validated, stored only when true, independent of quarantine and label', async () => {
  const t = await server()
  try {
    t.login('A')
    assert.equal((await t.req('POST', '/api/accounts/capture', { label: 'Work' })).status, 200)
    assert.equal((await t.req('POST', '/api/accounts/add/start', {})).status, 200)
    t.login('B')
    assert.equal((await t.req('POST', '/api/accounts/add/finish', { label: 'Side' })).status, 200)
    const meta = () => JSON.parse(fs.readFileSync(path.join(t.dataDir, 'accounts.json'), 'utf8')).find((a) => a.id === UUID.B)
    let r = await t.req('PATCH', `/api/accounts/${UUID.B}`, { lowPriority: true })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.json.account.lowPriority, r.json.account.quarantine, r.json.account.label], [true, false, 'Side'])
    assert.equal(meta().lowPriority, true)
    for (const bad of ['yes', 1, null, {}]) assert.equal((await t.req('PATCH', `/api/accounts/${UUID.B}`, { lowPriority: bad })).status, 400, JSON.stringify(bad))
    assert.equal((await t.req('PATCH', `/api/accounts/${UUID.B}`, { lowPriority: 'yes', label: 'New' })).status, 400, 'a bad flag changes nothing')
    assert.equal(meta().label, 'Side')
    r = await t.req('PATCH', `/api/accounts/${UUID.B}`, { lowPriority: true, quarantine: true, label: 'Spare' })
    assert.deepEqual([r.json.account.lowPriority, r.json.account.quarantine, r.json.account.label], [true, true, 'Spare'], 'both flags at once')
    r = await t.req('PATCH', `/api/accounts/${UUID.B}`, { quarantine: false })
    assert.deepEqual([r.json.account.lowPriority, r.json.account.quarantine], [true, false], 'quarantine alone leaves it')
    r = await t.req('PATCH', `/api/accounts/${UUID.B}`, { lowPriority: false })
    assert.equal(r.json.account.lowPriority, false)
    assert.equal('lowPriority' in meta(), false, 'omitted when false')
    assert.equal((await t.req('PATCH', `/api/accounts/${UUID.B}`, {})).status, 400)
    const list = (await t.req('GET', '/api/accounts')).json
    assert.deepEqual(list.accounts.map((a) => [a.label, a.lowPriority]), [['Work', false], ['Spare', false]])
    for (const text of t.texts) assert.ok(!text.includes(TOKEN_MARK), 'no token in any reply')
  } finally { await t.done() }
})
