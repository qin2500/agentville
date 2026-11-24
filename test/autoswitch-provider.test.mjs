// P10: the sampler and the usage pause per provider. Claude's decisions must stay byte-identical.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decide, hardOut, createSampler, SWITCH_AT, OUT_AT, SOON_WEEK_MS, WAIT_RESET_MS, TARGET_MIN_ROOM } from '../server/autoswitch.mjs'
import { createUsagePause, pauseTargets, resumeTargets, PAUSE_TEXT, RESUME_TEXT } from '../server/usage-pause.mjs'

const NOW = 1_800_000_000_000
// 972 decisions from the pre-change decide() on a fixed grid; the hash was taken from the original module.
const GOLDEN = 'd8b39d2500dc9b3ac5cb890853a5e7c4b6974722249dc167af3a5c525836f11c'

function* grid(NOW) {
  const used = [0, 10, 50, 80, 94, 95, 98, 99, 100]
  const rs = [600e3, 3600e3, 20 * 60e3, 10 * 3600e3, 40 * 3600e3, 150 * 3600e3]
  let n = 0
  for (const f of used) for (const wk of used) for (const r of rs) for (const wr of [rs[1], rs[4]]) {
    n++
    const w = (u, ri) => ({ used: u, resetsAt: NOW + ri })
    const usage = new Map([
      ['B', { fiveHour: w(10 + (n % 7) * 10, rs[n % 6]), weekly: w((n * 7) % 100, rs[(n + 1) % 6]) }],
      ['C', { fiveHour: n % 5 === 0 ? { used: 0, resetsAt: null, none: true } : w((n * 3) % 100, rs[(n + 2) % 6]), weekly: w((n * 11) % 100, rs[(n + 3) % 6]) }],
      ['D', n % 4 === 0 ? { error: 'x', fiveHour: null, weekly: null } : { fiveHour: w(5, 600e3), weekly: w(96, 3600e3) }],
    ])
    yield { enabled: true, active: 'A', saved: ['A', 'B', 'C', 'D'], limitHit: n % 9 === 0, busy: false, lastAutoAt: n % 11 === 0 ? NOW - 60e3 : 0,
      poolAvailable: true, now: NOW, activeUsage: { fiveHour: w(f, r), weekly: w(wk, wr) }, usage,
      rebalance: n % 3 === 0, prefer: n % 13 === 0, projectedMs: n % 8 === 0 ? 60e3 : null, lowPriority: new Set(n % 2 ? ['B'] : ['C']) }
  }
}

const hash = (tuning) => {
  const out = []
  for (const i of grid(NOW)) out.push(tuning === undefined ? decide(i) : decide({ ...i, tuning }))
  return crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex')
}

test('decide: no tuning is byte-identical to the original', () => assert.equal(hash(), GOLDEN))
test('decide: empty tuning and explicit Claude constants are byte-identical', () => {
  assert.equal(hash({}), GOLDEN)
  assert.equal(hash({ SWITCH_AT, OUT_AT, SOON_WEEK_MS, WAIT_RESET_MS, TARGET_MIN_ROOM }), GOLDEN)
})
test('decide: tuning overrides take effect', () => {
  const w = (used, ri = 3600e3) => ({ used, resetsAt: NOW + ri })
  const b = { enabled: true, active: 'A', saved: ['A', 'B'], limitHit: false, busy: false, lastAutoAt: 0, now: NOW,
    activeUsage: { fiveHour: w(80), weekly: w(10) }, usage: new Map([['B', { fiveHour: w(10), weekly: w(10) }]]) }
  assert.equal(decide(b).why, 'not out')
  assert.deepEqual(decide({ ...b, tuning: { SWITCH_AT: 75 } }), { action: 'switch', to: 'B', why: 'five_hour' })
  assert.equal(hardOut({ fiveHour: w(90), weekly: w(10) }, false), '')
  assert.equal(hardOut({ fiveHour: w(90), weekly: w(10) }, false, { OUT_AT: 90 }), 'five_hour')
})

test('createSampler: default file is autoswitch.json; a provider gets its own file and tag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-'))
  const c = createSampler({ dataDir: dir, account: {}, agents: async () => [], network: null })
  await c.setEnabled(false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'autoswitch.json'), 'utf8')).enabled, false)
  assert.equal((await c.info()).provider, 'claude')
  const g = createSampler({ dataDir: dir, provider: 'gemini', file: 'autoswitch-gemini.json', tuning: { SWITCH_AT: 80 }, account: {}, agents: async () => [], network: null })
  assert.equal((await g.info()).enabled, true, 'state is not shared with Claude')
  await g.setEnabled(false)
  assert.ok(fs.existsSync(path.join(dir, 'autoswitch-gemini.json')))
  assert.equal((await g.info()).provider, 'gemini')
})

const A = (id, extra = {}) => ({ id, name: id, kind: 'job', bucket: 'active', live: true, harness: 'claude-code', ...extra })
test('pauseTargets: Claude default is unchanged; other providers filter by provider', () => {
  const agents = [A('c1'), A('c2', { provider: 'claude' }), A('g1', { harness: 'gemini-cli', provider: 'gemini' }), A('g2', { harness: 'gemini-cli' }), A('x', { harness: 'codex' })]
  assert.deepEqual(pauseTargets(agents).map((a) => a.id), ['c1', 'c2'])
  assert.deepEqual(pauseTargets(agents, null, 'claude').map((a) => a.id), ['c1', 'c2'])
  assert.deepEqual(pauseTargets(agents, null, 'gemini').map((a) => a.id), ['g1', 'g2'])
  const rec = { agents: [{ id: 'c1' }, { id: 'g1' }] }
  assert.deepEqual(resumeTargets(rec, agents).map((a) => a.id), ['c1'])
  assert.deepEqual(resumeTargets(rec, agents, null, 'gemini').map((a) => a.id), ['g1'])
})

test('createUsagePause: provider, file and text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upp-'))
  const sent = [], logs = []
  const mk = (extra) => createUsagePause({ dataDir: dir, agents: () => [A('c1'), A('g1', { harness: 'gemini-cli', provider: 'gemini' })],
    blocked: () => ({ why: 'out', until: NOW + 3600e3 }), deliverTo: async (id, t) => { sent.push([id, t]); return true },
    canRequest: async () => true, log: (e) => logs.push(e), now: () => NOW, staggerMs: 0, ...extra })
  await mk({}).tick()
  assert.deepEqual(sent, [['c1', PAUSE_TEXT]])
  assert.ok(fs.existsSync(path.join(dir, 'usage-pause.json')))
  assert.equal('provider' in logs[0], false, 'Claude log lines are unchanged')
  sent.length = 0; logs.length = 0
  await mk({ provider: 'gemini', file: 'usage-pause-gemini.json', text: { pause: 'P', resume: RESUME_TEXT + '!' } }).tick()
  assert.deepEqual(sent, [['g1', 'P']])
  assert.ok(fs.existsSync(path.join(dir, 'usage-pause-gemini.json')))
  assert.equal(logs[0].provider, 'gemini')
})
