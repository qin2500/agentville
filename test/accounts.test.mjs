/**
 * Saved Claude accounts and switching between them, against a fake Claude home (file-mode
 * credentials, never the Keychain), a fake `claude` and a fake Anthropic API on 127.0.0.1. Nothing
 * here reads the real ~/.claude, the real Keychain or the real network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../server/serve.mjs'
import { makeAccountHome, TOKEN } from './fixtures/account-home.mjs'
import { fakeAnthropic, UUID, TOKEN_MARK } from './fixtures/fake-anthropic.mjs'

const PEOPLE = { A: { email: 'a@example.com', five: 12.5, week: 40 }, B: { email: 'b@example.com', five: 80, week: 95 }, C: { email: 'c@example.com', five: 1, week: 2 } }

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-accounts-'))
  const home = makeAccountHome(root)
  const api = await fakeAnthropic(PEOPLE)
  Object.assign(process.env, home.env, api.env, { AGENTVILLE_ACCOUNT_POLL_MS: '30', AGENTVILLE_ACCOUNT_IDLE_MAX_MS: '2000' })
  // Every job at a turn boundary (the fixture's aaaa0001 is mid turn).
  fs.writeFileSync(home.files.aaaa0001, JSON.stringify({ ...JSON.parse(fs.readFileSync(home.files.aaaa0001, 'utf8')), tempo: 'idle' }))
  for (const k of ['FAKE_AUTH', 'FAKE_RESPAWN_FAIL', 'FAKE_RESPAWN_MS', 'FAKE_CLOBBER', 'FAKE_NO_LIVE', 'FAKE_REPLY', 'AGENTVILLE_TERMINAL']) delete process.env[k]
  const dataDir = path.join(root, 'data')
  const server = createServer({ dataDir })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const credFile = path.join(home.home, '.credentials.json')
  const configFile = path.join(home.home, '.claude.json')
  const texts = [] // every response body, checked for tokens at the end
  const req = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { origin: base, ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    texts.push(text)
    return { status: r.status, text, json: JSON.parse(text) }
  }
  const t = {
    root, home, api, dataDir, credFile, configFile, base,
    get: (p) => req('GET', p),
    post: (p, body = {}) => req('POST', p, body),
    patch: (p, body) => req('PATCH', p, body),
    del: (p) => req('DELETE', p),
    login(text, key) { // what `claude auth login` leaves behind
      fs.writeFileSync(credFile, text, { mode: 0o600 })
      if (key) fs.writeFileSync(configFile, JSON.stringify({ numStartups: 3, oauthAccount: api.oauthAccount(key) }, null, 2) + '\n')
    },
    live: () => fs.readFileSync(credFile, 'utf8'),
    slot: (key) => fs.readFileSync(path.join(dataDir, 'accounts', `${UUID[key]}.json`), 'utf8'),
    tokenCalls: () => api.requests.filter((r) => r.path === '/v1/oauth/token'),
    respawns: () => (fs.existsSync(home.log) ? fs.readFileSync(home.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === 'respawn') : []),
    /** No response, log or audit line may ever carry a token or the pool secret. */
    assertNoSecrets() {
      const research = path.join(dataDir, 'research')
      const logs = ['account-log.jsonl', ...(fs.existsSync(research) ? fs.readdirSync(research).map((f) => path.join('research', f)) : [])]
        .map((f) => path.join(dataDir, f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'))
      for (const text of [...texts, ...logs]) {
        assert.ok(!text.includes(TOKEN_MARK), `token leaked: ${text.slice(0, 120)}`)
        assert.ok(!text.includes(TOKEN), 'pool token leaked')
      }
    },
    async done() { server.close(); await api.close(); fs.rmSync(root, { recursive: true, force: true }) },
  }
  return t
}

/** Save A (live) and B (added through the add flow), leaving A in Claude's store. */
async function withTwo(t) {
  const a = t.api.cred('A')
  t.login(a, 'A')
  assert.equal((await t.post('/api/accounts/capture', { label: 'Work' })).status, 200)
  assert.equal((await t.post('/api/accounts/add/start')).status, 200)
  const b = t.api.cred('B')
  t.login(b, 'B')
  const r = await t.post('/api/accounts/add/finish', { label: 'Side' })
  assert.equal(r.status, 200, r.text)
  return { a, b }
}

test('capture saves the current login (0600 files, 0700 folder) and dedupes by account uuid', async () => {
  const t = await setup()
  try {
    const a1 = t.api.cred('A')
    t.login(a1, 'A')
    let r = await t.post('/api/accounts/capture', { label: 'Work' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.account, { id: UUID.A, label: 'Work', email: 'a@example.com', subscriptionType: 'max', quarantine: false, active: false, signedIn: true }, 'on the pool, so not active')
    assert.equal(fs.statSync(path.join(t.dataDir, 'accounts')).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(t.dataDir, 'accounts.json')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(t.dataDir, 'accounts', `${UUID.A}.json`)).mode & 0o777, 0o600)
    assert.equal(t.slot('A'), a1, 'the credential is stored exactly as Claude had it')
    assert.ok(!fs.readFileSync(path.join(t.dataDir, 'accounts.json'), 'utf8').includes(TOKEN_MARK), 'metadata holds no secret')

    // Claude rotated its tokens: capturing again updates the same account, no duplicate.
    const a2 = t.api.cred('A')
    t.login(a2)
    r = await t.post('/api/accounts/capture', {})
    assert.equal(r.json.account.label, 'Work', 'an empty label keeps the old one')
    assert.equal(t.slot('A'), a2)
    const list = (await t.get('/api/accounts')).json
    assert.deepEqual(list.accounts.map((a) => a.id), [UUID.A])
    assert.deepEqual([list.active, list.login, list.pool, list.adding], ['pool', { present: true, id: UUID.A }, { available: true }, false])
    assert.equal(list.accounts[0].active, false, 'on the pool, no account is active…')
    assert.equal(list.accounts[0].signedIn, true, '…but A is the login Claude has stored')
    assert.deepEqual([(await t.post('/api/accounts/capture', { label: 'x'.repeat(61) })).status], [400])
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('add/start then add/finish saves the new login and leaves Claude\'s credential exactly as it was', async () => {
  const t = await setup()
  try {
    const a = t.api.cred('A')
    t.login(a, 'A')
    const before = fs.readFileSync(t.configFile, 'utf8')
    let r = await t.post('/api/accounts/add/start')
    assert.deepEqual([r.status, r.json.command, r.json.opened], [200, 'claude auth login', false], 'no terminal under test')
    assert.equal((await t.get('/api/accounts')).json.adding, true)
    assert.equal(fs.statSync(path.join(t.dataDir, 'accounts', 'pending-add.json')).mode & 0o777, 0o600)
    r = await t.post('/api/accounts/add/finish', {})
    assert.deepEqual([r.status, r.json.error], [409, 'No new login yet. Finish signing in in the terminal, then try again.'])

    t.login(t.api.cred('B'), 'B') // the user signs in as B in the terminal
    r = await t.post('/api/accounts/add/finish', { label: 'Side' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.json.account.id, r.json.account.label, r.json.account.signedIn, r.json.restored], [UUID.B, 'Side', false, true])
    assert.equal(t.live(), a, 'the previous login is back, byte for byte')
    assert.equal(fs.readFileSync(t.configFile, 'utf8'), before, "and Claude's account record with it")
    const list = (await t.get('/api/accounts')).json
    assert.deepEqual(list.accounts.map((x) => [x.label, x.signedIn]), [['a@example.com', true], ['Side', false]])
    assert.equal(list.adding, false)
    assert.equal(t.respawns().length, 0, 'adding never restarts anything')

    // Cancel after signing in also puts the previous login back.
    await t.post('/api/accounts/add/start')
    t.login(t.api.cred('C'), 'C')
    r = await t.post('/api/accounts/add/cancel')
    assert.deepEqual([r.status, r.json.restored], [200, true])
    assert.equal(t.live(), a)
    assert.equal((await t.get('/api/accounts')).json.accounts.length, 2)
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('usage: parsed per account, cached for 60 s, refetched with ?fresh; failures are fixed messages', async () => {
  const t = await setup()
  try {
    await withTwo(t)
    let r = await t.get('/api/accounts/usage')
    assert.equal(r.status, 200)
    const [a, b] = r.json.accounts
    assert.deepEqual([a.id, a.fiveHour.used, a.weekly.used, a.error], [UUID.A, 12.5, 40, undefined])
    assert.deepEqual([b.id, b.fiveHour.used, b.weekly.used], [UUID.B, 80, 95])
    assert.ok(a.fiveHour.resetsAt > Date.now() + 3600e3 && a.weekly.resetsAt > Date.now() + 2 * 86400e3)
    const usageCalls = () => t.api.requests.filter((x) => x.path === '/api/oauth/usage')
    assert.equal(usageCalls().length, 2)
    assert.ok(usageCalls().every((x) => x.beta === 'oauth-2025-04-20'))
    // Each fresh reading goes to the usage research log, the live login marked active.
    const readings = async (n) => {
      const dir = path.join(t.dataDir, 'research')
      for (let i = 0; i < 50; i++) {
        const rows = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('usage-')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : []
        if (rows.length >= n) return rows
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.fail(`expected ${n} research readings`)
    }
    const logged = await readings(2)
    assert.deepEqual(logged.map((x) => [x.account, x.active, x.windows.five_hour.used]).sort(), [[UUID.A, true, 12.5], [UUID.B, false, 80]])
    await t.get('/api/accounts/usage')
    assert.equal(usageCalls().length, 2, 'served from the cache')
    await t.get('/api/accounts/usage?fresh=1')
    assert.equal(usageCalls().length, 4)

    PEOPLE.B.status = 401
    try {
      r = await t.get('/api/accounts/usage?fresh=1')
      assert.deepEqual(r.json.accounts[1], { id: UUID.B, fiveHour: null, weekly: null, error: 'Login expired — sign in again', checkedAt: r.json.accounts[1].checkedAt })
      assert.ok(!r.text.includes('bad token'), "the API's reply is never passed on")
    } finally { delete PEOPLE.B.status }

    // No 5-hour window in a good reading: the account has no 5-hour limit (not "no data").
    const five = PEOPLE.B.five
    PEOPLE.B.five = null
    try {
      r = await t.get('/api/accounts/usage?fresh=1')
      assert.deepEqual([r.json.accounts[1].fiveHour, r.json.accounts[1].weekly.used], [{ used: 0, resetsAt: null, none: true }, 95])
    } finally { PEOPLE.B.five = five }

    // Rate limited (429): keep showing the last good numbers, and leave the account alone for a while.
    PEOPLE.A.status = 429
    try {
      const before = usageCalls().length
      r = await t.get('/api/accounts/usage?fresh=1')
      const a2 = r.json.accounts[0]
      assert.deepEqual([a2.fiveHour.used, a2.weekly.used, a2.stale, a2.note], [12.5, 40, true, 'Anthropic is rate-limiting usage checks'])
      assert.equal(a2.error, undefined, 'the bars stay; no error')
      const calledA = () => usageCalls().slice(before).filter((x) => x.account === 'A').length
      assert.equal(calledA(), 1)
      await t.get('/api/accounts/usage?fresh=1')
      assert.equal(calledA(), 1, 'backed off: no new call for A')
    } finally { delete PEOPLE.A.status }
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('an expired inactive account is refreshed and its rotated tokens saved; the live account never is', async () => {
  const t = await setup()
  try {
    // A is live and its token has expired; B is saved and expired too.
    const a = t.api.cred('A', { expiresAt: Date.now() - 1000 })
    t.login(a, 'A')
    await t.post('/api/accounts/capture', {})
    await t.post('/api/accounts/add/start')
    const b = t.api.cred('B', { expiresAt: Date.now() - 1000 })
    t.login(b, 'B')
    await t.post('/api/accounts/add/finish', {})
    assert.equal(t.live(), a)

    const r = await t.get('/api/accounts/usage')
    const [ua, ub] = r.json.accounts
    assert.equal(ua.error, 'Token expired — Claude Code refreshes it on its next request')
    assert.equal(ub.weekly.used, 95)
    const calls = t.tokenCalls()
    assert.equal(calls.length, 1, 'exactly one refresh')
    assert.deepEqual([calls[0].account, calls[0].grant, calls[0].clientId], ['B', 'refresh_token', '9d1c250a-e61b-44d9-88ed-5944d1962f5e'])
    assert.equal(calls[0].refreshToken, JSON.parse(b).claudeAiOauth.refreshToken)
    const saved = JSON.parse(t.slot('B')).claudeAiOauth
    assert.notEqual(saved.refreshToken, JSON.parse(b).claudeAiOauth.refreshToken, 'the rotated refresh token was saved')
    assert.ok(saved.expiresAt > Date.now() + 3000e3)
    assert.equal(t.live(), a, "Claude's login is untouched")
    assert.equal(t.slot('A'), a)
    // A second, fresh check uses the saved rotated token and never refreshes again.
    await t.get('/api/accounts/usage?fresh=1')
    assert.equal(t.tokenCalls().length, 1)
    assert.ok(!t.tokenCalls().some((c) => c.account === 'A'), 'the live account is never refreshed')
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('switch account -> account: swaps the credential, restarts nothing, settings untouched', async () => {
  const t = await setup()
  try {
    const { a, b } = await withTwo(t)
    const status = async () => (await t.get('/api/account')).json
    let r = await t.post('/api/account/switch', { to: UUID.A, confirm: (await status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal(t.live(), a, 'A was already stored: a plain pool -> personal switch')
    assert.equal((await t.get('/api/accounts')).json.active, UUID.A)
    const settings = fs.readFileSync(path.join(t.home.home, 'settings.json'), 'utf8')
    const jobs = fs.readFileSync(path.join(t.home.home, 'jobs', 'aaaa0001', 'state.json'), 'utf8')

    // Claude rotated A's tokens while it ran: the switch must save those before swapping.
    const a2 = t.api.cred('A')
    t.login(a2)
    const before = t.respawns().length
    r = await t.post('/api/account/switch', { to: UUID.B, confirm: (await status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.restored, false)
    assert.deepEqual(r.json.results.map((x) => [x.id, x.status]), [['aaaa0001', 'unchanged'], ['aaaa0002', 'unchanged']])
    assert.deepEqual(t.respawns().slice(before), [], 'running jobs pick the swapped login up themselves: no respawn')
    assert.equal(t.live(), b, "B's login is now Claude's")
    const entry = fs.readFileSync(path.join(t.dataDir, 'account-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1)
    assert.deepEqual([entry.action, entry.account, entry.auto, entry.restored], ['switch', UUID.B, false, false])
    assert.equal(JSON.parse(fs.readFileSync(t.configFile, 'utf8')).oauthAccount.accountUuid, UUID.B)
    assert.equal(t.slot('A'), a2, "A's rotated tokens were saved first")
    assert.equal(fs.readFileSync(path.join(t.home.home, 'settings.json'), 'utf8'), settings, 'settings unchanged')
    assert.equal(fs.readFileSync(path.join(t.home.home, 'jobs', 'aaaa0001', 'state.json'), 'utf8'), jobs, 'job flags unchanged')
    const list = (await t.get('/api/accounts')).json
    assert.deepEqual([list.active, list.accounts.map((x) => x.active)], [UUID.B, [false, true]])

    r = await t.post('/api/account/switch', { to: UUID.B, confirm: (await status()).confirm })
    assert.deepEqual([r.status, r.json.error], [409, 'Already on that account'])
    r = await t.del(`/api/accounts/${UUID.B}`)
    assert.deepEqual([r.status, r.json.error], [409, 'That account is signed in to Claude Code right now. Switch to another account first.'])

    // Account -> pool: B is re-captured, then the pool settings come back; the login stays.
    r = await t.post('/api/account/switch', { to: 'pool', confirm: (await status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal((await t.get('/api/accounts')).json.active, 'pool')
    assert.equal(t.live(), b)
    assert.ok(fs.readFileSync(path.join(t.home.home, 'settings.json'), 'utf8').includes(TOKEN))

    r = await t.post('/api/account/switch', { to: UUID.A, confirm: (await status()).confirm })
    assert.deepEqual([r.status, r.json.error], [429, 'Too many switches; wait a minute'], 'the rate limit still applies')
    const log = fs.readFileSync(path.join(t.dataDir, 'account-log.jsonl'), 'utf8')
    assert.match(log, new RegExp(UUID.B), 'the audit log names account ids')
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('account -> account cleans up a job that still carries pool settings, instead of failing its check', async () => {
  const t = await setup()
  try {
    await withTwo(t)
    const status = async () => (await t.get('/api/account')).json
    let r = await t.post('/api/account/switch', { to: UUID.A, confirm: (await status()).confirm })
    assert.equal(r.status, 200, r.text)
    // The job ends up on pool settings again (not running at the first switch, relaunched from an old command…).
    const file = path.join(t.home.home, 'jobs', 'aaaa0001', 'state.json')
    const pooled = { ...JSON.parse(fs.readFileSync(file, 'utf8')), respawnFlags: ['--name', 'API Lead', '--model', 'cc/claude-opus-5-5'], providerEnv: { CLAUDE_CODE_SUBAGENT_MODEL: 'cc/claude-sonnet-5-5', OTHER: '1' } }
    fs.writeFileSync(file, JSON.stringify(pooled, null, 2))
    r = await t.post('/api/account/switch', { to: UUID.B, confirm: (await status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.restored, false, JSON.stringify(r.json.results))
    assert.deepEqual(r.json.results.map((x) => [x.id, x.status]), [['aaaa0001', 'respawned'], ['aaaa0002', 'unchanged']], 'only the job whose settings changed is restarted')
    const now = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual([now.respawnFlags, now.providerEnv], [['--name', 'API Lead', '--model', 'claude-opus-5-5'], { OTHER: '1' }])
    // Back to the pool: its pool settings come back.
    r = await t.post('/api/account/switch', { to: 'pool', confirm: (await status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).respawnFlags, ['--name', 'API Lead', '--model', 'cc/claude-opus-5-5'])
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('pool -> an account that is not the stored login: its credential is written and the pool stashed', async () => {
  const t = await setup()
  try {
    const { b } = await withTwo(t) // A is the stored login
    const r = await t.post('/api/account/switch', { to: UUID.B, confirm: (await t.get('/api/account')).json.confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.restored, false)
    assert.equal(t.live(), b)
    assert.ok(!fs.readFileSync(path.join(t.home.home, 'settings.json'), 'utf8').includes(TOKEN))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.home.home, 'jobs', 'aaaa0001', 'state.json'), 'utf8')).respawnFlags, ['--name', 'API Lead', '--model', 'claude-opus-5-5'])
    assert.equal((await t.get('/api/accounts')).json.active, UUID.B)
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('Undo after an account -> account switch puts the previous login back byte for byte', async () => {
  const t = await setup()
  try {
    const { a, b } = await withTwo(t)
    const status = async () => (await t.get('/api/account')).json
    assert.equal((await t.post('/api/account/switch', { to: UUID.A, confirm: (await status()).confirm })).status, 200)
    const config = fs.readFileSync(t.configFile, 'utf8')
    const settings = fs.readFileSync(path.join(t.home.home, 'settings.json'), 'utf8')
    let r = await t.post('/api/account/switch', { to: UUID.B, confirm: (await status()).confirm })
    assert.equal(r.json.restored, false, r.text)
    assert.equal(t.live(), b)
    const sets = fs.readdirSync(path.join(t.dataDir, 'account-backups')).sort()
    const dir = path.join(t.dataDir, 'account-backups', sets.at(-1))
    assert.equal(fs.statSync(path.join(dir, 'credential.json')).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).changed, ['credential.json', 'oauth-account.json'], 'only the login changed')
    // The user edits settings after the switch: Undo of an account switch must not revert that.
    fs.writeFileSync(path.join(t.home.home, 'settings.json'), settings.replace('"opus"', '"sonnet"'))
    r = await t.post('/api/account/undo', {})
    assert.equal(r.status, 200, r.text)
    assert.equal(t.live(), a, 'Undo restores the previous login')
    assert.equal(fs.readFileSync(t.configFile, 'utf8'), config)
    assert.match(fs.readFileSync(path.join(t.home.home, 'settings.json'), 'utf8'), /"sonnet"/, 'settings were not part of that switch')
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('rename, remove, and the guards: Origin, test mode, unknown ids', async () => {
  const t = await setup()
  try {
    await withTwo(t)
    let r = await t.patch(`/api/accounts/${UUID.B}`, { label: '  Personal  ' })
    assert.deepEqual([r.status, r.json.account.label], [200, 'Personal'])
    assert.equal((await t.patch(`/api/accounts/${UUID.B}`, { label: '' })).status, 400)
    assert.equal((await t.patch(`/api/accounts/${UUID.C}`, { label: 'x' })).status, 404)
    r = await t.del(`/api/accounts/${UUID.A}`)
    assert.equal(r.status, 409, 'A is the stored login')
    r = await t.del(`/api/accounts/${UUID.B}`)
    assert.deepEqual([r.status, r.json.removed], [200, UUID.B])
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'accounts', `${UUID.B}.json`)))
    assert.equal((await t.post('/api/account/switch', { to: UUID.B, confirm: 'x' })).status, 400)
    r = await fetch(`${t.base}/api/accounts/capture`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 403)
    const home = process.env.AGENTVILLE_CLAUDE_HOME
    delete process.env.AGENTVILLE_CLAUDE_HOME // under test, accounts need a fake home
    try {
      r = await t.get('/api/accounts')
      assert.deepEqual([r.status, r.json.error], [501, 'Accounts are disabled in tests'])
    } finally { process.env.AGENTVILLE_CLAUDE_HOME = home }
    t.assertNoSecrets()
  } finally { await t.done() }
})

test('quarantine accounts: marked per account, refused on the work Wi-Fi, fine anywhere else', async () => {
  const t = await setup()
  process.env.AGENTVILLE_NETWORK_ID = 'gw:0a:0b:0c:0d:0e:0f' // a fake network: the real one is never read
  try {
    await withTwo(t)
    let r = await t.patch(`/api/accounts/${UUID.B}`, { quarantine: true })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.account.quarantine, true)
    assert.equal(r.json.account.label, 'Side', 'the name is untouched')
    assert.equal((await t.patch(`/api/accounts/${UUID.B}`, { quarantine: 'yes' })).status, 400)
    assert.equal((await t.patch(`/api/accounts/${UUID.B}`, {})).status, 400)
    let list = (await t.get('/api/accounts')).json
    assert.deepEqual(list.accounts.map((a) => [a.label, a.quarantine]), [['Work', false], ['Side', true]])
    assert.deepEqual(list.network.current, { id: 'gw:0a:0b:0c:0d:0e:0f', gateway: '', work: false })

    // Mark this network as the work Wi-Fi: switching to the quarantine account is refused.
    r = await t.post('/api/network/work', { work: true })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.current.work, true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dataDir, 'networks.json'), 'utf8')).work[0].id, 'gw:0a:0b:0c:0d:0e:0f')
    const status = async () => (await t.get('/api/account')).json
    r = await t.post('/api/account/switch', { to: UUID.B, confirm: (await status()).confirm })
    assert.equal(r.status, 409)
    assert.match(r.json.error, /Side is a quarantine account.*work Wi-Fi/)
    assert.equal((await t.post('/api/network/work', { work: 'x' })).status, 400)

    // Unmarked (somewhere else): the switch goes through.
    assert.equal((await t.post('/api/network/work', { work: false })).json.current.work, false)
    r = await t.post('/api/account/switch', { to: UUID.B, confirm: (await status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal((await t.get('/api/accounts')).json.active, UUID.B)

    // Back on the work Wi-Fi, Undo can't put the quarantine account back either.
    await t.post('/api/account/switch', { to: UUID.A, confirm: (await status()).confirm })
    await t.post('/api/network/work', { work: true })
    r = await t.post('/api/account/undo', {})
    assert.equal(r.status, 409)
    assert.match(r.json.error, /Undo would switch back to Side/)
    t.assertNoSecrets()
  } finally { delete process.env.AGENTVILLE_NETWORK_ID; await t.done() }
})
