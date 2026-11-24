import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackTarget, createProviderSwitch, limitStopsOut, EXHAUST_CONFIRM_MS } from '../server/provider-switch.mjs'

const S = { defaultProvider: 'claude', providerOrder: ['claude', 'gemini'] }
const ok = { usable: true }

test('fallbackTarget: non-default out -> default; default out -> next in order', () => {
  assert.equal(fallbackTarget('gemini', S, { claude: ok, gemini: ok }), 'claude')
  assert.equal(fallbackTarget('claude', S, { claude: ok, gemini: ok }), 'gemini')
  assert.equal(fallbackTarget('claude', S, { claude: ok, gemini: { usable: false } }), null)
  assert.equal(fallbackTarget('gemini', S, { claude: { usable: false }, gemini: ok }), null)
  const three = { defaultProvider: 'gemini', providerOrder: ['x', 'gemini', 'claude'] }
  assert.equal(fallbackTarget('claude', three, { gemini: ok, x: ok, claude: ok }), 'gemini')
  assert.equal(fallbackTarget('gemini', three, { gemini: ok, x: ok, claude: ok }), 'x')
})

test('fallbackTarget: codex is never a target', () => {
  assert.equal(fallbackTarget('claude', { defaultProvider: 'claude', providerOrder: ['claude', 'codex'] }, { codex: ok }), null)
})

function rig({ minWaitMs = 30 * 60e3, blocked = null, geminiOk = true } = {}) {
  let t = 1_000_000
  const box = { blocked }
  const events = []
  const sampler = { info: async () => ({ enabled: true, blocked: box.blocked }) }
  const adapters = [
    { id: 'claude', capabilities: { accounts: true, start: true, handoffTarget: true }, available: async () => ({ ok: true }) },
    { id: 'gemini', capabilities: { accounts: true, start: true, handoffTarget: true }, available: async () => ({ ok: geminiOk, why: 'Gemini CLI not found' }) },
    { id: 'codex', capabilities: { accounts: false, start: false, handoffTarget: false }, available: async () => ({ ok: true }) },
  ]
  const sw = createProviderSwitch({
    settings: { get: () => ({ ...S, handoff: { mode: 'auto', minWaitMs } }) },
    providers: () => adapters,
    samplers: { claude: sampler, gemini: { info: async () => ({ blocked: null }) } },
    now: () => t,
    onEpisode: (e) => events.push(e),
  })
  return { sw, box, events, adv: (ms) => { t += ms }, now: () => t }
}

test('exhaustion needs 2 ticks and EXHAUST_CONFIRM_MS', async () => {
  const r = rig({ blocked: { why: 'all accounts low', until: null } })
  await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), false)
  assert.equal(r.sw.episode('claude').id, 'claude-1000000')
  r.adv(30e3); await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), false, '2 ticks but not 2 minutes')
  r.adv(EXHAUST_CONFIRM_MS); await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), true)
  assert.equal(r.sw.target('claude'), 'gemini')
  assert.equal(r.sw.usable('claude'), false)
  assert.deepEqual(r.sw.status().claude.exhausted, { since: 1_000_000, until: null })
  r.box.blocked = null; await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), true, 'one clear tick is not enough to end the episode')
  await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), false)
  assert.equal(r.sw.episode('claude'), null)
  assert.deepEqual(r.events.map((e) => e.type), ['start', 'end'])
})

test('regression: an info() error keeps the last signal; a one-tick flap keeps the same episode id', async () => {
  const r = rig({ blocked: { why: 'all accounts low', until: null } })
  const sampler = { info: async () => ({ blocked: r.box.blocked }) }
  let fail = false
  sampler.info = async () => { if (fail) throw new Error('keychain busy'); return { blocked: r.box.blocked } }
  const sw = createProviderSwitch({
    settings: { get: () => S }, providers: () => [{ id: 'claude', capabilities: { accounts: true, start: true, handoffTarget: true }, available: async () => ({ ok: true }) }],
    samplers: { claude: sampler }, now: r.now, onEpisode: (e) => r.events.push(e),
  })
  await sw.tick(); r.adv(EXHAUST_CONFIRM_MS); await sw.tick()
  assert.equal(sw.exhausted('claude'), true)
  const id = sw.episode('claude').id
  fail = true; r.adv(30e3); await sw.tick()
  assert.equal(sw.exhausted('claude'), true, 'a failed reading is not "not out"')
  assert.equal(sw.episode('claude').id, id)
  fail = false; r.box.blocked = null; r.adv(30e3); await sw.tick()
  assert.equal(sw.episode('claude').id, id, 'one clear tick holds the episode')
  r.box.blocked = { why: 'all accounts low', until: null }; r.adv(30e3); await sw.tick()
  assert.equal(sw.episode('claude').id, id, 'out again: same episode, so the same handoff ids')
  assert.equal(sw.exhausted('claude'), true)
  assert.deepEqual(r.events.map((e) => e.type), ['start'])
})

test('regression: a provider with an unconfirmed out signal is not a usable target', async () => {
  const r = rig({ blocked: null })
  const sw = createProviderSwitch({
    settings: { get: () => S },
    providers: () => [
      { id: 'claude', capabilities: { accounts: true, start: true, handoffTarget: true }, available: async () => ({ ok: true }) },
      { id: 'gemini', capabilities: { accounts: true, start: true, handoffTarget: true }, available: async () => ({ ok: true }) },
    ],
    samplers: { claude: { info: async () => ({ blocked: { why: 'all accounts low', until: null } }) }, gemini: { info: async () => ({ blocked: { why: 'all accounts low', until: null } }) } },
    now: r.now,
  })
  await sw.tick()
  assert.equal(sw.exhausted('gemini'), false, 'not confirmed yet')
  assert.equal(sw.usable('gemini'), false, 'but already unusable')
  r.adv(EXHAUST_CONFIRM_MS); await sw.tick()
  assert.equal(sw.exhausted('claude'), true)
  assert.equal(sw.target('claude'), null)
})

test('regression: tick() is single-flight', async () => {
  let calls = 0
  let release
  const gate = new Promise((res) => { release = res })
  const sw = createProviderSwitch({
    settings: { get: () => S },
    providers: () => [{ id: 'claude', capabilities: { accounts: true, start: true, handoffTarget: true }, available: async () => ({ ok: true }) }],
    samplers: { claude: { info: async () => { calls++; await gate; return { blocked: null } } } },
  })
  const a = sw.tick(); const b = sw.tick()
  assert.equal(a, b)
  release(); await Promise.all([a, b])
  assert.equal(calls, 1)
  await sw.tick()
  assert.equal(calls, 2, 'a new pass after the first one settles')
})

test('other blocked reasons do not count', async () => {
  const r = rig({ blocked: { reason: 'too_big', size: 1, max: 2 } })
  await r.sw.tick(); r.adv(EXHAUST_CONFIRM_MS); await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), false)
  assert.equal(r.sw.episode('claude'), null)
})

test('minWaitMs: a provider that frees up soon is not exhausted', async () => {
  const r = rig({ minWaitMs: 30 * 60e3 })
  r.box.blocked = { why: 'all accounts low', until: r.now() + EXHAUST_CONFIRM_MS + 10 * 60e3 }
  await r.sw.tick(); r.adv(EXHAUST_CONFIRM_MS); await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), false)
  r.box.blocked = { why: 'all accounts low', until: r.now() + 2 * 3600e3 }
  r.adv(1); await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), true)
  const z = rig({ minWaitMs: 0 })
  z.box.blocked = { why: 'all accounts low', until: z.now() + EXHAUST_CONFIRM_MS + 60e3 }
  await z.sw.tick(); z.adv(EXHAUST_CONFIRM_MS); await z.sw.tick()
  assert.equal(z.sw.exhausted('claude'), true, 'minWaitMs 0 = always hand off')
})

test('an unavailable target leaves no target', async () => {
  const r = rig({ blocked: { why: 'all accounts low', until: null }, geminiOk: false })
  await r.sw.tick(); r.adv(EXHAUST_CONFIRM_MS); await r.sw.tick()
  assert.equal(r.sw.exhausted('claude'), true)
  assert.equal(r.sw.target('claude'), null)
  assert.deepEqual(r.sw.state().gemini, { usable: false, why: 'Gemini CLI not found' })
  assert.equal(r.sw.state().codex.usable, false)
})

test('limitStopsOut: providers without accounts', () => {
  const now = 10_000_000
  const stopped = { id: 'a', live: true, lastActivityAt: now - 60e3, limitStop: { at: now - 60e3, resetsAt: now + 3600e3, kind: 'limit' } }
  assert.deepEqual(limitStopsOut([stopped], now), { at: now - 60e3, until: now + 3600e3 })
  assert.equal(limitStopsOut([stopped, { id: 'b', live: true, lastActivityAt: now - 1000 }], now), null, 'another ran since')
  assert.equal(limitStopsOut([{ ...stopped, limitStop: { ...stopped.limitStop, at: now - 11 * 60e3 } }], now), null, 'too old')
  assert.equal(limitStopsOut([{ ...stopped, live: false }], now), null)
  assert.equal(limitStopsOut([{ ...stopped, limitStop: { ...stopped.limitStop, kind: 'api' } }], now), null)
})

test('a provider without accounts confirms through agents()', async () => {
  let t = 5_000_000
  const sw = createProviderSwitch({
    settings: { get: async () => ({ ...S, handoff: { minWaitMs: 0 } }) },
    providers: () => [
      { id: 'claude', capabilities: { accounts: true, start: true, handoffTarget: true }, available: async () => ({ ok: true }) },
      { id: 'gemini', capabilities: { accounts: false, start: true, handoffTarget: true }, available: async () => ({ ok: true }) },
    ],
    samplers: () => ({ info: async () => ({ blocked: null }) }),
    agents: (id) => (id === 'gemini' ? [{ id: 'g', live: true, lastActivityAt: t, limitStop: { at: 5_000_000, kind: 'limit' } }] : []),
    now: () => t,
  })
  await sw.tick(); t += EXHAUST_CONFIRM_MS; await sw.tick()
  assert.equal(sw.exhausted('gemini'), true)
  assert.equal(sw.target('gemini'), 'claude')
})
