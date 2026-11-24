/**
 * A Keychain login past `security -i`'s line limit (MCP OAuth tokens make Claude's item grow past
 * ~2 KB) still switches: the write goes in argv, exactly as Claude Code writes the same item, is read
 * back, and a mismatch rolls back. Everything outside is faked: a fake `/usr/bin/security` (the
 * keychainStore `run` injection), a fake fetch, and temp folders. Nothing touches the real Keychain,
 * ~/.claude, ~/.config or the network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccounts, keychainStore, KEYCHAIN_LINE_LIMIT, KEYCHAIN_MAX_BYTES } from '../server/accounts.mjs'
import { createAccount } from '../server/account.mjs'

process.env.AGENTVILLE_TEST = '1'

const SERVICE = 'Test-credentials'
const ACCT = 'tester'
const UUID = { A: 'aaaaaaaa-1111-4111-8111-111111111111', B: 'bbbbbbbb-2222-4222-8222-222222222222' }
const MARK = 'tok-SECRET-'
const EXP = Date.now() + 3600e3 // one expiry for the live item and the slots, so "the fresher login" is a tie
const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex')
const oauth = (key, n, expiresAt) => ({ accessToken: `${MARK}at-${key}-${n}`, refreshToken: `${MARK}rt-${key}-${n}`, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' })

/** Claude's live item for account `key` with an MCP login padded so the whole item is `bytes` long. */
function liveItem(key, bytes) {
  const make = (pad) => JSON.stringify({ claudeAiOauth: oauth(key, 1, EXP), mcpOAuth: { 'plugin:slack:slack': { accessToken: `${MARK}mcp-${pad}`, expiresAt: 9e12 } } })
  const text = make('x'.repeat(bytes - make('').length))
  assert.equal(Buffer.byteLength(text), bytes)
  return text
}

/**
 * A fake `/usr/bin/security` holding one item. Records every argv and stdin. Models `-i`'s line
 * limit as the real tool does (the line is cut), and `corrupt` damages the next N argv writes.
 */
function fakeSecurity(initial) {
  const calls = []
  let secret = initial
  const state = { corrupt: 0 }
  const store = (hex) => {
    let text = Buffer.from(hex, 'hex').toString('utf8')
    if (state.corrupt > 0) { state.corrupt--; text = text.slice(0, Math.floor(text.length / 2)) }
    secret = text
  }
  const run = async (args, input) => {
    calls.push({ args: [...args], input })
    if (args[0] === 'find-generic-password' && args.includes('-w')) return secret === null ? { code: 44, stdout: '' } : { code: 0, stdout: `${secret}\n` }
    if (args[0] === 'find-generic-password') return { code: 0, stdout: `keychain: "x"\n    "acct"<blob>="${ACCT}"\n` }
    if (args[0] === '-i') {
      const line = String(input).slice(0, KEYCHAIN_LINE_LIMIT + 32) // the real helper cuts long lines
      const hex = /^add-generic-password -U -a "[^"]*" -s "[^"]*" -X ([0-9a-f]+)\n$/.exec(line)?.[1]
      if (hex) store(hex)
      return { code: 0, stdout: '' }
    }
    if (args[0] === 'add-generic-password' && args.length === 8 && args[7] && /^[0-9a-f]+$/.test(args[7])) { store(args[7]); return { code: 0, stdout: '' } }
    return { code: 1, stdout: '' }
  }
  return { run, calls, state, get secret() { return secret } }
}

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body })
/** A fake Anthropic: the profile belongs to the account named in the bearer token (`…at-A-…`). */
const fakeFetch = async (url, opts) => {
  const key = /at-([AB])-/.exec(opts?.headers?.authorization || '')?.[1]
  if (!key) return reply(401, {})
  if (String(url).endsWith('/api/oauth/profile')) return reply(200, { account: { uuid: UUID[key], email: `${key.toLowerCase()}@example.com` } })
  if (String(url).endsWith('/api/oauth/usage')) return reply(200, {})
  return reply(404, {})
}

/** A whole switch: real createAccount + createAccounts over keychainStore(fake security). */
function setup(liveText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-kc-big-'))
  const home = path.join(root, 'claude')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'accounts'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ env: { KEEP: '1' } }, null, 2) + '\n')
  process.env.AGENTVILLE_CLAUDE_HOME = home
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(['A', 'B'].map((k) => ({ id: UUID[k], label: k, email: '', subscriptionType: null, addedAt: 1 }))), { mode: 0o600 })
  fs.writeFileSync(path.join(dataDir, 'accounts', `${UUID.A}.json`), JSON.stringify({ claudeAiOauth: oauth('A', 1, EXP) }), { mode: 0o600 })
  fs.writeFileSync(path.join(dataDir, 'accounts', `${UUID.B}.json`), JSON.stringify({ claudeAiOauth: oauth('B', 1, EXP) }), { mode: 0o600 })
  const sec = fakeSecurity(liveText)
  const store = keychainStore(SERVICE, { run: sec.run })
  const accounts = createAccounts({ dataDir, claudeHome: () => home, exclusive: (fn) => fn(), poolState: async () => ({ active: false, available: false }), store, fetch: fakeFetch })
  const logs = []
  const origLog = console.log, origErr = console.error, origWarn = console.warn
  console.log = console.error = console.warn = (...a) => { logs.push(a.map(String).join(' ')) }
  const account = createAccount({
    dataDir, claudeHome: () => home, accounts, run: async () => ({ timedOut: false, code: 0, stdout: '', stderr: '' }), bin: async () => '/fake/claude', blocked: () => '',
    activity: async () => 'idle', now: () => Date.now(), sleep: async () => {}, idleMs: () => 1, everyMs: () => 1,
  })
  // Every data file but the saved logins (accounts/) and the switch backups, e.g. account-log.jsonl.
  const files = () => fs.readdirSync(dataDir, { recursive: true }).filter((f) => !/^(account-backups|accounts)[\\/]/.test(String(f)) && fs.statSync(path.join(dataDir, String(f))).isFile()).map((f) => fs.readFileSync(path.join(dataDir, String(f)), 'utf8')).join('\n')
  return {
    sec, store, accounts, account, logs, files,
    done: () => { console.log = origLog; console.error = origErr; console.warn = origWarn; fs.rmSync(root, { recursive: true, force: true }) },
  }
}

/** No token (nor its hex) in any log line, error, audit or other data file (the 0600 slots and backups hold logins by design). */
function assertNoSecret(t, ...extra) {
  const hay = [...t.logs, t.files(), ...extra.map((e) => (e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e)))].join('\n')
  assert.ok(!hay.includes(MARK), 'no token text')
  assert.ok(!hay.includes(hexOf(MARK)), 'no token hex')
}

for (const bytes of [2025, 20 * 1024]) {
  test(`a ${bytes}-byte live item switches A -> B: written whole in argv, read back, MCP logins kept`, async () => {
    const live = liveItem('A', bytes)
    const t = setup(live)
    try {
      const out = await t.account.switchTo({ to: UUID.B }, [], { auto: true })
      assert.notEqual(out.restored, true, 'not rolled back')
      const after = JSON.parse(t.sec.secret)
      assert.equal(after.claudeAiOauth.accessToken, `${MARK}at-B-1`)
      assert.deepEqual(after.mcpOAuth, JSON.parse(live).mcpOAuth, 'every other key kept')
      const want = JSON.stringify({ ...JSON.parse(live), claudeAiOauth: oauth('B', 1, after.claudeAiOauth.expiresAt) })
      assert.equal(t.sec.secret, want)
      // The exact helper calls for the write: argv, no stdin data, nothing via `-i`.
      const writes = t.sec.calls.filter((c) => c.args[0] === 'add-generic-password' || c.args[0] === '-i')
      assert.deepEqual(writes.map((c) => c.args), [['add-generic-password', '-U', '-a', ACCT, '-s', SERVICE, '-X', hexOf(want)]])
      assert.equal(writes[0].input, undefined, 'nothing on stdin')
      // Read back after the write.
      const i = t.sec.calls.indexOf(writes[0])
      assert.deepEqual(t.sec.calls[i + 1].args, ['find-generic-password', '-s', SERVICE, '-w'])
      assert.deepEqual(await t.store.headroom(), { size: Buffer.byteLength(want), max: KEYCHAIN_MAX_BYTES, left: KEYCHAIN_MAX_BYTES - Buffer.byteLength(want) })
      assertNoSecret(t, JSON.stringify(out))
    } finally { t.done() }
  })
}

test('a small item still goes over stdin to `security -i` only, with the exact line', async () => {
  const sec = fakeSecurity(null)
  const kc = keychainStore(SERVICE, { run: sec.run })
  const text = JSON.stringify({ claudeAiOauth: oauth('A', 1, 5) })
  await kc.write(text)
  const writes = sec.calls.filter((c) => c.args[0] === 'add-generic-password' || c.args[0] === '-i')
  assert.deepEqual(writes, [{ args: ['-i'], input: `add-generic-password -U -a "${ACCT}" -s "${SERVICE}" -X ${hexOf(text)}\n` }])
  for (const c of sec.calls) assert.ok(!c.args.join(' ').includes(hexOf(MARK)), 'no secret in argv')
})

test('the switch-over point: a line of exactly the limit uses `-i`, one byte more uses argv', async () => {
  const prefixLen = `add-generic-password -U -a "${ACCT}" -s "${SERVICE}" -X `.length
  const bytes = (KEYCHAIN_LINE_LIMIT - prefixLen - 1) / 2 // line = prefix + hex + "\n"
  assert.ok(Number.isInteger(bytes))
  for (const [n, want] of [[bytes, '-i'], [bytes + 1, 'add-generic-password']]) {
    const sec = fakeSecurity(null)
    const kc = keychainStore(SERVICE, { run: sec.run })
    const base = JSON.stringify({ claudeAiOauth: oauth('A', 1, 5), pad: '' })
    const text = JSON.stringify({ claudeAiOauth: oauth('A', 1, 5), pad: 'x'.repeat(n - base.length) })
    await kc.write(text)
    assert.equal(sec.secret, text, `${n} bytes stored whole`)
    assert.deepEqual(sec.calls.filter((c) => c.args[0] === 'add-generic-password' || c.args[0] === '-i').map((c) => c.args[0]), [want])
  }
})

test('a read-back mismatch fails the switch and rolls back to the original item, MCP logins included', async () => {
  const live = liveItem('A', 2025)
  const t = setup(live)
  try {
    t.sec.state.corrupt = 1 // the switch's write is damaged; the rollback's write is not
    let err
    await assert.rejects(t.account.switchTo({ to: UUID.B }, [], { auto: true }), (e) => { err = e; return true })
    assert.match(err.message, /Couldn't change the login, nothing was restarted/)
    assert.doesNotMatch(err.message, /putting it back also failed/)
    assert.notEqual(err.code, 'too_big')
    const after = JSON.parse(t.sec.secret)
    assert.equal(after.claudeAiOauth.accessToken, `${MARK}at-A-1`, 'A is back')
    assert.deepEqual(after.mcpOAuth, JSON.parse(live).mcpOAuth, 'MCP logins back, not lost with the damaged item')
    assert.equal(t.sec.secret, live, 'byte for byte the original item')
    assertNoSecret(t, err)
  } finally { t.done() }
})

test('a helper that keeps failing: the write throws a fixed message, nothing about the secret', async () => {
  const live = liveItem('A', 20 * 1024)
  const sec = fakeSecurity(live)
  sec.state.corrupt = 99
  const kc = keychainStore(SERVICE, { run: sec.run })
  const next = JSON.stringify({ ...JSON.parse(live), claudeAiOauth: oauth('B', 1, 5) })
  let err
  await assert.rejects(kc.write(next), (e) => { err = e; return true })
  assert.equal(err.message, 'The Keychain did not take the new login')
  assert.ok(!JSON.stringify({ m: err.message, ...err }).includes(MARK))
})

test('past the cap (64 KiB): refused with code too_big before any write, the message names lengths only', async () => {
  const sec = fakeSecurity(liveItem('A', 2025))
  const kc = keychainStore(SERVICE, { run: sec.run })
  const huge = liveItem('B', KEYCHAIN_MAX_BYTES + 1)
  const before = sec.secret
  let err
  await assert.rejects(kc.write(huge), (e) => { err = e; return true })
  assert.deepEqual([err.status, err.code, err.size, err.max], [409, 'too_big', KEYCHAIN_MAX_BYTES + 1, KEYCHAIN_MAX_BYTES])
  assert.ok(!err.message.includes(MARK))
  assert.equal(sec.calls.filter((c) => c.args[0] !== 'find-generic-password').length, 0, 'nothing written')
  assert.equal(sec.secret, before)
  await kc.write(liveItem('B', KEYCHAIN_MAX_BYTES)) // exactly at the cap: written
  assert.equal(Buffer.byteLength(sec.secret), KEYCHAIN_MAX_BYTES)
})
