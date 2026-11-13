/**
 * The account swap's safety rules, against a fake credential store, a fake Keychain helper and a
 * fake fetch (accounts.mjs's injection points). Nothing here touches the real Keychain, ~/.claude,
 * ~/.claude.json or the network: every path is in a temp folder.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccounts, keychainStore, usageReader, ACTIVE_BACKOFF_CAP_MS, withOauth } from '../server/accounts.mjs'

process.env.AGENTVILLE_TEST = '1'

const UUID = { A: 'aaaaaaaa-1111-4111-8111-111111111111', B: 'bbbbbbbb-2222-4222-8222-222222222222' }
const MARK = 'tok-SECRET-'
const oauth = (key, n, expiresAt) => ({ accessToken: `${MARK}at-${key}-${n}`, refreshToken: `${MARK}rt-${key}-${n}`, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' })
const MCP_NOW = { 'slack|abc': { accessToken: `${MARK}mcp-slack-current`, expiresAt: 9e12 } }
const MCP_OLD = { 'slack|abc': { accessToken: `${MARK}mcp-slack-old`, expiresAt: 1 } }

const reply = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => body })

/** A fake Anthropic: profile/usage by bearer token prefix (`…at-A-…` is account A). */
function fakeFetch({ mode = 'ok', tokenMode = 'ok', usage = () => reply(200, { five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3600e3).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86400e3).toISOString() } }) } = {}) {
  const calls = []
  const f = async (url, opts) => {
    const token = /^Bearer (.+)$/.exec(opts?.headers?.authorization || '')?.[1] || ''
    calls.push({ url: String(url) })
    if (mode === 'down') throw new TypeError('fetch failed')
    if (String(url).endsWith('/v1/oauth/token')) {
      if (tokenMode !== 'ok') return reply(tokenMode === 'down' ? 503 : 400, { error: 'invalid_grant' })
      const rt = JSON.parse(opts.body).refresh_token
      const k = /rt-([AB])-/.exec(rt)?.[1]
      return reply(200, { access_token: `${MARK}at-${k}-new`, refresh_token: `${MARK}rt-${k}-new`, expires_in: 3600 })
    }
    const key = /at-([AB])-/.exec(token)?.[1]
    if (mode === '401' || !key) return reply(401, { error: 'nope' })
    if (String(url).endsWith('/api/oauth/profile')) return reply(200, { account: { uuid: UUID[key], email: `${key.toLowerCase()}@example.com` } })
    if (String(url).endsWith('/api/oauth/usage')) return usage(key)
    return reply(404, {})
  }
  f.calls = calls
  return f
}

function setup({ live = null, slots = {}, fetchOpts } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-acct-safety-'))
  const home = path.join(root, 'claude-home')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'accounts'), { recursive: true, mode: 0o700 })
  process.env.AGENTVILLE_CLAUDE_HOME = home
  const meta = Object.keys(slots).map((k) => ({ id: UUID[k], label: k, email: '', subscriptionType: null, addedAt: 1 }))
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(meta), { mode: 0o600 })
  for (const [k, text] of Object.entries(slots)) fs.writeFileSync(path.join(dataDir, 'accounts', `${UUID[k]}.json`), text, { mode: 0o600 })
  const store = { text: live, writes: 0, read: async () => store.text, write: async (t) => { store.writes++; store.text = t } }
  const fetch = fakeFetch(fetchOpts)
  const accounts = createAccounts({ dataDir, claudeHome: () => home, exclusive: (fn) => fn(), poolState: async () => ({ active: false, available: false }), store, fetch })
  const slotPath = (k) => path.join(dataDir, 'accounts', `${UUID[k]}.json`)
  return {
    accounts, store, fetch, home, dataDir,
    slot: (k) => JSON.parse(fs.readFileSync(slotPath(k), 'utf8')),
    slotMode: (k) => fs.statSync(slotPath(k)).mode & 0o777,
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test('withOauth replaces only claudeAiOauth and keeps every other key in order', () => {
  const cur = JSON.stringify({ claudeAiOauth: oauth('A', 1, 5), mcpOAuth: MCP_NOW, other: 1 })
  const out = JSON.parse(withOauth(cur, oauth('B', 1, 6)))
  assert.deepEqual(Object.keys(out), ['claudeAiOauth', 'mcpOAuth', 'other'])
  assert.equal(out.claudeAiOauth.accessToken, `${MARK}at-B-1`)
  assert.deepEqual(out.mcpOAuth, MCP_NOW)
  assert.deepEqual(JSON.parse(withOauth(null, oauth('B', 1, 6))), { claudeAiOauth: oauth('B', 1, 6) })
})

test('old slots are migrated on load to claudeAiOauth only, staying 0600', async () => {
  const t = setup({ slots: { B: JSON.stringify({ claudeAiOauth: oauth('B', 1, 100), mcpOAuth: MCP_OLD }) } })
  try {
    await t.accounts.load()
    assert.deepEqual(Object.keys(t.slot('B')), ['claudeAiOauth'])
    assert.equal(t.slot('B').claudeAiOauth.accessToken, `${MARK}at-B-1`)
    assert.equal(t.slotMode('B'), 0o600)
  } finally { t.done() }
})

test('activate swaps only the Claude login: the current mcpOAuth is kept, never the slot\'s old copy', async () => {
  const now = Date.now()
  const t = setup({
    live: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3), mcpOAuth: MCP_NOW }),
    slots: { A: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3) }), B: JSON.stringify({ claudeAiOauth: oauth('B', 1, now + 3600e3), mcpOAuth: MCP_OLD }) },
  })
  try {
    await t.accounts.activate(UUID.B)
    const live = JSON.parse(t.store.text)
    assert.equal(live.claudeAiOauth.accessToken, `${MARK}at-B-1`)
    assert.deepEqual(live.mcpOAuth, MCP_NOW)
    assert.deepEqual(Object.keys(t.slot('B')), ['claudeAiOauth'])
    // And back: restoreLive puts A's login back, still with the current MCP logins.
    t.store.text = JSON.stringify({ ...JSON.parse(t.store.text), mcpOAuth: { ...MCP_NOW, 'linear|x': { accessToken: `${MARK}mcp-linear` } } })
    await t.accounts.restoreLive(JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3), mcpOAuth: MCP_OLD }), UUID.A)
    const back = JSON.parse(t.store.text)
    assert.equal(back.claudeAiOauth.accessToken, `${MARK}at-A-1`)
    assert.deepEqual(Object.keys(back.mcpOAuth), ['slack|abc', 'linear|x'])
    assert.equal(back.mcpOAuth['slack|abc'].accessToken, `${MARK}mcp-slack-current`)
  } finally { t.done() }
})

test('a slot is only overwritten by a login with a newer expiresAt', async () => {
  const t = setup({ slots: { A: JSON.stringify({ claudeAiOauth: oauth('A', 2, 2000) }) } })
  try {
    assert.equal(await t.accounts.syncSlot(UUID.A, JSON.stringify({ claudeAiOauth: oauth('A', 1, 1000), mcpOAuth: MCP_NOW })), false)
    assert.equal(t.slot('A').claudeAiOauth.accessToken, `${MARK}at-A-2`)
    assert.equal(await t.accounts.syncSlot(UUID.A, JSON.stringify({ claudeAiOauth: oauth('A', 3, 2000) })), false, 'same expiresAt: kept')
    assert.equal(await t.accounts.syncSlot(UUID.A, JSON.stringify({ claudeAiOauth: oauth('A', 4, 3000), mcpOAuth: MCP_NOW })), true)
    assert.deepEqual(t.slot('A'), { claudeAiOauth: oauth('A', 4, 3000) }, 'newer: written, login only')
    // Concurrent syncs of an old and a new copy: the newer one wins whatever the order.
    await Promise.all([t.accounts.syncSlot(UUID.A, JSON.stringify({ claudeAiOauth: oauth('A', 6, 5000) })), t.accounts.syncSlot(UUID.A, JSON.stringify({ claudeAiOauth: oauth('A', 5, 4000) }))])
    assert.equal(t.slot('A').claudeAiOauth.expiresAt, 5000)
  } finally { t.done() }
})

test('activate re-reads the live item and saves the outgoing account\'s rotated login first', async () => {
  const now = Date.now()
  const t = setup({
    // Claude refreshed A after it was saved: new tokens (not matching the slot), later expiresAt.
    live: JSON.stringify({ claudeAiOauth: oauth('A', 9, now + 7200e3), mcpOAuth: MCP_NOW }),
    slots: { A: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 60e3) }), B: JSON.stringify({ claudeAiOauth: oauth('B', 1, now + 3600e3) }) },
  })
  try {
    await t.accounts.activate(UUID.B)
    assert.equal(t.slot('A').claudeAiOauth.accessToken, `${MARK}at-A-9`)
    assert.equal(JSON.parse(t.store.text).claudeAiOauth.accessToken, `${MARK}at-B-1`)
  } finally { t.done() }
})

test('checkActive: ok, wrong account, 401, unreachable, no login; never returns a token or email', async () => {
  const live = JSON.stringify({ claudeAiOauth: oauth('A', 1, Date.now() + 3600e3), mcpOAuth: MCP_NOW })
  const results = []
  for (const [mode, expected, want] of [
    ['ok', 'A', { ok: true }],
    ['ok', 'B', { ok: false, reason: 'signed in to a different account' }],
    ['401', 'A', { ok: false, reason: 'login rejected', expiresAt: JSON.parse(live).claudeAiOauth.expiresAt }],
    ['down', 'A', { ok: false, reason: 'could not reach Anthropic' }],
  ]) {
    const t = setup({ live, fetchOpts: { mode } })
    try {
      const r = await t.accounts.checkActive(UUID[expected])
      assert.deepEqual(r, want, `${mode}/${expected}`)
      assert.ok(t.fetch.calls.length === 1 && t.fetch.calls[0].url.endsWith('/api/oauth/profile'))
      results.push(r)
    } finally { t.done() }
  }
  const t = setup({ live: null })
  try { results.push(await t.accounts.checkActive(UUID.A)); assert.deepEqual(results.at(-1), { ok: false, reason: 'no login stored' }) } finally { t.done() }
  const text = JSON.stringify(results)
  assert.ok(!text.includes(MARK) && !text.includes('@example.com'))
})

test('usage backoff after a 429: the active account waits at most 2 min, an inactive one honours Retry-After', async () => {
  let clock = 1_000_000
  let limited = false
  const fetch = fakeFetch({ usage: () => (limited ? reply(429, {}, { 'retry-after': '900' }) : reply(200, { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 6, resets_at: null } })) })
  const read = usageReader(null, { fetchImpl: fetch, now: () => clock })
  const token = `${MARK}at-A-1`
  for (const active of [true, false]) {
    const key = active ? 'active' : 'inactive'
    const first = await read(key, token, active)
    assert.equal(first.checkedAt, clock)
    const goodAt = clock
    limited = true
    clock += 1000
    const r1 = await read(key, token, active)
    assert.equal(r1.stale, true)
    assert.equal(r1.checkedAt, goodAt, 'checkedAt is when the reading shown was fetched')
    const n = fetch.calls.length
    clock += ACTIVE_BACKOFF_CAP_MS - 2000
    await read(key, token, active)
    assert.equal(fetch.calls.length, n, 'still backing off')
    clock += 3000
    await read(key, token, active)
    assert.equal(fetch.calls.length, active ? n + 1 : n, active ? 'active: retried after 2 min' : 'inactive: Retry-After (15 min) honoured')
    if (!active) { clock += 15 * 60e3; await read(key, token, active); assert.equal(fetch.calls.length, n + 1) }
    limited = false
    clock += 60e3
  }
  // An account backed off for 15 min while inactive is capped at 2 min once it becomes active.
  limited = true
  await read('switched', token, false).catch(() => {}) // no earlier reading: the fixed error
  const n = fetch.calls.length
  clock += ACTIVE_BACKOFF_CAP_MS + 1000
  await read('switched', token, false).catch(() => {})
  assert.equal(fetch.calls.length, n)
  await read('switched', token, true).catch(() => {})
  assert.equal(fetch.calls.length, n + 1)
})

/** A fake `/usr/bin/security`: keeps one item, records every argv and stdin. */
function fakeSecurity() {
  const calls = []
  let secret = null
  const run = async (args, input) => {
    calls.push({ args, input })
    if (args[0] === 'find-generic-password' && args.includes('-w')) return secret === null ? { code: 44, stdout: '' } : { code: 0, stdout: Buffer.from(secret).toString('hex') + '\n' }
    if (args[0] === 'find-generic-password') return { code: 0, stdout: 'keychain: "x"\n    "acct"<blob>="tester"\n' }
    if (args[0] === '-i') { const hex = / -X ([0-9a-f]+)\n$/.exec(input)?.[1]; if (hex) secret = Buffer.from(hex, 'hex').toString('utf8'); return { code: 0, stdout: '' } }
    return { code: 1, stdout: '' }
  }
  return { run, calls, get secret() { return secret } }
}

test('Keychain writes go over stdin only; an item too big for the helper is refused before anything is written', async () => {
  const sec = fakeSecurity()
  const kc = keychainStore('Test-credentials', { run: sec.run })
  const small = JSON.stringify({ claudeAiOauth: oauth('A', 1, 5), mcpOAuth: MCP_NOW })
  await kc.write(small)
  assert.equal(sec.secret, small)
  assert.equal(await kc.read(), small)
  const big = JSON.stringify({ claudeAiOauth: oauth('A', 2, 5), mcpOAuth: { pad: { accessToken: `${MARK}${'x'.repeat(2500)}` } } })
  const before = sec.calls.filter((c) => c.args[0] === '-i').length
  await assert.rejects(kc.write(big), (e) => e.tooLarge === true && /too big to update safely/.test(e.message) && !e.message.includes(MARK))
  assert.equal(sec.calls.filter((c) => c.args[0] === '-i').length, before, 'nothing sent to the helper')
  assert.equal(sec.secret, small, 'item unchanged')
  for (const c of sec.calls) assert.ok(!c.args.join(' ').includes(MARK) && !c.args.some((a) => /^[0-9a-f]{40,}$/i.test(a)), 'no secret in argv')
})

test('writeOauthAccount changes only oauthAccount and keeps the file mode', async () => {
  const t = setup({})
  const file = path.join(t.home, '.claude.json')
  try {
    fs.writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { x: 1 }, oauthAccount: { accountUuid: UUID.A } }, null, 2) + '\n', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    assert.equal(await t.accounts.writeOauthAccount({ accountUuid: UUID.B }), true)
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(json, { numStartups: 3, projects: { x: 1 }, oauthAccount: { accountUuid: UUID.B } })
    assert.equal(fs.statSync(file).mode & 0o777, 0o644)
    assert.deepEqual(fs.readdirSync(t.home).filter((f) => f.endsWith('.tmp')), [])
  } finally { t.done() }
})

// ---- Review fixes: unreadable store (B2), helper limit (B4), expired target (#3),
// add-account restore (#4), Claude Code's config lock (#14).

/** A store that can't be read (locked Keychain, helper timeout): read throws, writes are counted. */
const unreadableStore = (store) => { store.read = async () => { throw Object.assign(new Error("Couldn't read Claude's stored login — nothing was changed"), { unreadable: true, status: 503 }) } }

test('Keychain read: null only for "not found" (44); a timeout or locked keychain throws, with no output in the error', async () => {
  for (const [code, want] of [[44, null], [1, 'throws'], [36, 'throws'], [0, 'text']]) {
    const kc = keychainStore('Test-credentials', { run: async () => ({ code, stdout: code === 0 ? '{"claudeAiOauth":{}}\n' : `${MARK}leak\n` }) })
    if (want === 'throws') await assert.rejects(kc.read(), (e) => e.unreadable === true && e.code === 'unreadable' && !e.message.includes(MARK))
    else assert.equal(await kc.read(), want === null ? null : '{"claudeAiOauth":{}}')
  }
})

test('an unreadable live login: nothing is written anywhere, and checkActive says "could not read" (not "no login stored")', async () => {
  const now = Date.now()
  const t = setup({
    live: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3), mcpOAuth: MCP_NOW }),
    slots: { A: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3) }), B: JSON.stringify({ claudeAiOauth: oauth('B', 1, now - 1) }) },
  })
  try {
    const slotsBefore = [t.slot('A'), t.slot('B')]
    unreadableStore(t.store)
    await assert.rejects(t.accounts.activate(UUID.B), (e) => e.unreadable === true)
    await assert.rejects(t.accounts.restoreLive(JSON.stringify({ claudeAiOauth: oauth('A', 0, 1) }), UUID.A), (e) => e.unreadable === true)
    await assert.rejects(t.accounts.addStart(), (e) => e.unreadable === true)
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'accounts', 'pending-add.json')), 'no add started')
    assert.deepEqual(await t.accounts.checkActive(UUID.A), { ok: false, reason: 'could not read the login' })
    const u = await t.accounts.activeUsage()
    assert.equal(u.saved, false); assert.equal(u.unreadable, true)
    const usage = await t.accounts.usage({ fresh: true })
    assert.equal(usage.accounts.find((x) => x.id === UUID.B).error.includes('recognised'), true, 'an expired slot is not refreshed while the live login is unknown')
    assert.equal(t.store.writes, 0)
    assert.ok(!t.fetch.calls.some((c) => c.url.endsWith('/v1/oauth/token')), 'no refresh')
    assert.deepEqual([t.slot('A'), t.slot('B')], slotsBefore)
    assert.equal(await t.accounts.headroom(), null)
  } finally { t.done() }
})

test('helper limit: headroom() gives { size, max, left } from the item length; one character over is refused with code too_big', async () => {
  const sec = fakeSecurity()
  const kc = keychainStore('Test-credentials', { run: sec.run })
  const small = JSON.stringify({ claudeAiOauth: oauth('A', 1, 5) })
  await kc.write(small)
  const h = await kc.headroom()
  assert.deepEqual(Object.keys(h), ['size', 'max', 'left'])
  assert.equal(h.size, small.length)
  assert.equal(h.left, h.max - h.size)
  const prefix = 'add-generic-password -U -a "tester" -s "Test-credentials" -X '
  assert.equal(h.max, Math.floor((4000 - prefix.length - 1) / 2))
  assert.ok(!JSON.stringify(h).includes(MARK))
  const sized = (n) => { const base = JSON.stringify({ claudeAiOauth: oauth('A', 2, 5), pad: '' }); return JSON.stringify({ claudeAiOauth: oauth('A', 2, 5), pad: 'x'.repeat(n - base.length) }) }
  await kc.write(sized(h.max)) // exactly at the limit: fits
  assert.equal(sec.secret.length, h.max)
  const before = sec.secret
  await assert.rejects(kc.write(sized(h.max + 1)), (e) => e.status === 409 && e.code === 'too_big' && e.tooLarge === true && !e.message.includes(MARK))
  assert.equal(sec.secret, before, 'unchanged')
  assert.equal((await kc.headroom()).left, 0)
  // The file store (Linux, tests) has no limit.
  const t = setup({ live: small })
  try { assert.deepEqual(await t.accounts.headroom(), { size: small.length, max: null, left: null }) } finally { t.done() }
})

test('activate refreshes an expired target first (never the live account); a dead refresh token stops the switch with nothing written', async () => {
  const now = Date.now()
  const liveA = JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3), mcpOAuth: MCP_NOW })
  // Expired B, live A: B is refreshed, then switched to with the new tokens.
  let t = setup({ live: liveA, slots: { A: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3) }), B: JSON.stringify({ claudeAiOauth: oauth('B', 1, now + 30e3) }) } })
  try {
    await t.accounts.activate(UUID.B)
    assert.equal(t.fetch.calls.filter((c) => c.url.endsWith('/v1/oauth/token')).length, 1)
    assert.equal(t.slot('B').claudeAiOauth.accessToken, `${MARK}at-B-new`)
    const live = JSON.parse(t.store.text)
    assert.equal(live.claudeAiOauth.accessToken, `${MARK}at-B-new`)
    assert.deepEqual(live.mcpOAuth, MCP_NOW)
  } finally { t.done() }
  // The target is the live account (expired there too): never refreshed here.
  t = setup({ live: JSON.stringify({ claudeAiOauth: oauth('B', 1, now - 1) }), slots: { B: JSON.stringify({ claudeAiOauth: oauth('B', 1, now - 1) }) } })
  try {
    await t.accounts.activate(UUID.B)
    assert.equal(t.fetch.calls.filter((c) => c.url.endsWith('/v1/oauth/token')).length, 0)
  } finally { t.done() }
  // The live login can't be identified (unknown tokens, Anthropic down): it might be B, so no refresh.
  t = setup({ live: JSON.stringify({ claudeAiOauth: oauth('B', 7, now + 3600e3) }), slots: { B: JSON.stringify({ claudeAiOauth: oauth('B', 1, now - 1) }) }, fetchOpts: { mode: 'down' } })
  try {
    await t.accounts.activate(UUID.B)
    assert.ok(!t.fetch.calls.some((c) => c.url.endsWith('/v1/oauth/token')))
  } finally { t.done() }
  // A refresh token Anthropic rejects: the switch is refused before anything is written.
  t = setup({ live: liveA, slots: { A: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3) }), B: JSON.stringify({ claudeAiOauth: oauth('B', 1, now - 1) }) }, fetchOpts: { tokenMode: 'rejected' } })
  try {
    await assert.rejects(t.accounts.activate(UUID.B), (e) => e.status === 409 && e.code === 'login_expired' && !e.message.includes(MARK))
    assert.equal(t.store.writes, 0)
    assert.equal(t.store.text, liveA)
  } finally { t.done() }
})

test('add cancel/finish never put back a login whose refresh token Claude has since rotated', async () => {
  const now = Date.now()
  const a1 = JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3), mcpOAuth: MCP_NOW })
  const a2 = JSON.stringify({ claudeAiOauth: oauth('A', 2, now + 7200e3), mcpOAuth: MCP_NOW })
  // Cancel: no new login, but Claude rotated A meanwhile. A's current login stays; nothing is written.
  let t = setup({ live: a1, slots: { A: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3) }) } })
  try {
    await t.accounts.addStart()
    t.store.text = a2
    const writes = t.store.writes
    assert.deepEqual(await t.accounts.addCancel(), { restored: false })
    assert.equal(t.store.text, a2, 'the rotated login is kept, never the spent one')
    assert.equal(t.store.writes, writes)
  } finally { t.done() }
  // Finish: B signed in; A was rotated (and synced to its slot) before the sign-in. A's fresher slot goes back.
  t = setup({ live: a1, slots: { A: JSON.stringify({ claudeAiOauth: oauth('A', 1, now + 3600e3) }) } })
  try {
    await t.accounts.addStart()
    await t.accounts.syncSlot(UUID.A, a2)
    t.store.text = JSON.stringify({ claudeAiOauth: oauth('B', 1, now + 3600e3), mcpOAuth: MCP_NOW })
    const r = await t.accounts.addFinish({})
    assert.equal(r.restored, true)
    const live = JSON.parse(t.store.text)
    assert.equal(live.claudeAiOauth.refreshToken, `${MARK}rt-A-2`)
    assert.deepEqual(live.mcpOAuth, MCP_NOW)
  } finally { t.done() }
})

test("writeOauthAccount holds Claude Code's ~/.claude.json.lock: waits for it, takes over a stale one, leaves the file alone while it is held", async () => {
  const t = setup({})
  const file = path.join(t.home, '.claude.json')
  const lock = `${file}.lock`
  const write = (uuid) => fs.writeFileSync(file, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: uuid } }, null, 2) + '\n')
  const uuidNow = () => JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount.accountUuid
  try {
    write(UUID.A)
    // Held, then released by Claude: the write waits and then lands.
    fs.mkdirSync(lock)
    setTimeout(() => fs.rmdirSync(lock), 300)
    const t0 = Date.now()
    assert.equal(await t.accounts.writeOauthAccount({ accountUuid: UUID.B }), true)
    assert.ok(Date.now() - t0 >= 250, 'waited for the lock')
    assert.equal(uuidNow(), UUID.B)
    assert.ok(!fs.existsSync(lock), 'lock released')
    // A stale lock (an abandoned Claude): taken over.
    fs.mkdirSync(lock)
    const old = new Date(Date.now() - 30e3)
    fs.utimesSync(lock, old, old)
    assert.equal(await t.accounts.writeOauthAccount({ accountUuid: UUID.A }), true)
    assert.equal(uuidNow(), UUID.A)
    assert.ok(!fs.existsSync(lock))
    // Held throughout: left alone, the lock untouched.
    fs.mkdirSync(lock)
    assert.equal(await t.accounts.writeOauthAccount({ accountUuid: UUID.B }), false)
    assert.equal(uuidNow(), UUID.A)
    assert.ok(fs.existsSync(lock), "Claude's lock is never removed while fresh")
  } finally { t.done() }
})
