/**
 * "Sign in again" for a saved account whose login expired. Fakes only (fake credential store, fake
 * fetch, temp folders): never the real ~/.claude, the Keychain or the network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccounts } from '../server/accounts.mjs'
import { isLoginExpired } from '../web/src/acct-items.js'

process.env.AGENTVILLE_TEST = '1'
const UUID = { A: 'aaaaaaaa-1111-4111-8111-111111111111', B: 'bbbbbbbb-2222-4222-8222-222222222222' }
const oauth = (key, n) => ({ accessToken: `tok-at-${key}-${n}`, refreshToken: `tok-rt-${key}-${n}`, expiresAt: Date.now() + 3600e3, scopes: ['user:inference'], subscriptionType: 'max' })
const reply = (status, body) => ({ status, ok: status < 300, headers: { get: () => null }, json: async () => body })
const fetch = async (url, opts) => {
  const key = /at-([AB])-/.exec(opts?.headers?.authorization || '')?.[1]
  if (!key) return reply(401, {})
  if (String(url).endsWith('/api/oauth/profile')) return reply(200, { account: { uuid: UUID[key], email: `${key.toLowerCase()}@example.com` } })
  return reply(404, {})
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-relogin-'))
  const home = path.join(root, 'claude-home'), dataDir = path.join(root, 'data')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'accounts'), { recursive: true, mode: 0o700 })
  process.env.AGENTVILLE_CLAUDE_HOME = home
  const meta = [{ id: UUID.A, label: 'Work', email: 'a@example.com', subscriptionType: 'max', addedAt: 1, quarantine: true, lowPriority: true }]
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(meta), { mode: 0o600 })
  const slot = (id) => path.join(dataDir, 'accounts', `${id}.json`)
  fs.writeFileSync(slot(UUID.A), JSON.stringify({ claudeAiOauth: oauth('A', 1) }), { mode: 0o600 })
  const live = JSON.stringify({ claudeAiOauth: oauth('B', 1) }) // the account in use now (not saved)
  const store = { text: live, read: async () => store.text, write: async (t) => { store.text = t } }
  const accounts = createAccounts({ dataDir, claudeHome: () => home, exclusive: (fn) => fn(), poolState: async () => ({ active: false, available: false }), store, fetch })
  return { accounts, store, live, dataDir, slot, meta: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('the button is for the login-expired error only', () => {
  assert.equal(isLoginExpired({ error: 'Login expired — sign in again' }), true)
  for (const error of ["Couldn't read Claude's stored login", "Couldn't reach Anthropic", 'Token expired — Claude Code refreshes it on its next request', "Couldn't refresh the login", 'Saved login is missing — add the account again']) assert.equal(isLoginExpired({ error }), false, error)
  assert.equal(isLoginExpired({ fiveHour: {} }), false)
  assert.equal(isLoginExpired(null), false)
})

test('signing in again as the same account updates its slot in place, keeping label and flags', async () => {
  const t = setup()
  try {
    await t.accounts.addStart()
    t.store.text = JSON.stringify({ claudeAiOauth: oauth('A', 2) }) // what `claude auth login` leaves behind
    const r = await t.accounts.addFinish({})
    const all = t.meta()
    const a = all.filter((x) => x.id === UUID.A)
    // (addStart also saves the account that was running, B, as every add does; A must not be duplicated.)
    assert.deepEqual(all.map((x) => x.id).sort(), [UUID.A, UUID.B])
    assert.equal(a[0].label, 'Work')
    assert.equal(a[0].quarantine, true)
    assert.equal(a[0].lowPriority, true)
    assert.equal(r.account.id, UUID.A)
    assert.equal(JSON.parse(fs.readFileSync(t.slot(UUID.A), 'utf8')).claudeAiOauth.refreshToken, 'tok-rt-A-2')
    assert.equal(r.restored, true)
    assert.equal(t.store.text, t.live, 'what was running is put back')
  } finally { t.done() }
})

test('signing in as a different account behaves like add: a new slot, the expired one untouched', async () => {
  const t = setup()
  try {
    await t.accounts.addStart() // the live B is saved first, as in every add
    const before = fs.readFileSync(t.slot(UUID.A), 'utf8')
    t.store.text = JSON.stringify({ claudeAiOauth: oauth('B', 2) })
    const r = await t.accounts.addFinish({})
    assert.equal(r.account.id, UUID.B)
    assert.deepEqual(t.meta().map((a) => a.id).sort(), [UUID.A, UUID.B])
    assert.equal(fs.readFileSync(t.slot(UUID.A), 'utf8'), before)
  } finally { t.done() }
})
