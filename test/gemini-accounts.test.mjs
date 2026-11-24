import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGeminiAccounts, geminiIdOf, emailOf, nextPacificMidnight } from '../server/gemini/accounts.mjs'

const TOKEN = 'ya29.FAKE-ACCESS-TOKEN-never-shown'
const REFRESH = '1//FAKE-REFRESH-never-shown'

async function tmpData() { return fsp.mkdtemp(path.join(os.tmpdir(), 'agv-gemini-acct-')) }

/** What the official `gemini` sign-in leaves in a home. oauth_creds.json is made unreadable (0000) so
 *  any attempt by the module to open it fails the test; root ignores modes, so skip that part there. */
async function fakeSignIn(home, email, { lock = true } = {}) {
  const dir = path.join(home, '.gemini')
  await fsp.writeFile(path.join(dir, 'google_accounts.json'), JSON.stringify({ active: email, old: [] }))
  const creds = path.join(dir, 'oauth_creds.json')
  await fsp.writeFile(creds, JSON.stringify({ access_token: TOKEN, refresh_token: REFRESH, expiry_date: 1 }), { mode: 0o600 })
  if (lock && process.getuid?.() !== 0 && process.platform !== 'win32') await fsp.chmod(creds, 0o000)
}
const modeOf = async (p) => (await fsp.stat(p)).mode & 0o777
const posix = process.platform !== 'win32'

async function addAccount(g, email, label) {
  const start = await g.accounts.addStart({ bin: '/opt/bin/gemini' })
  await fakeSignIn(start.home, email)
  return { start, ...(await g.accounts.addFinish({ label })) }
}

test('helpers: id from email, email from google_accounts.json, Pacific midnight', () => {
  assert.match(geminiIdOf('A@Example.com'), /^gemini-[a-f0-9]{16}$/)
  assert.equal(geminiIdOf('A@Example.com'), geminiIdOf(' a@example.com '))
  assert.equal(geminiIdOf(''), null)
  assert.equal(emailOf('{"active":"x@y.z","old":[]}'), 'x@y.z')
  assert.equal(emailOf('{"active":null}'), null)
  assert.equal(emailOf('not json'), null)
  // 2026-11-24 12:00 UTC is 04:00 PST: next midnight PST is 2026-11-25 08:00 UTC.
  assert.equal(nextPacificMidnight(Date.parse('2026-11-24T12:00:00Z')), Date.parse('2026-11-25T08:00:00Z'))
  // Summer (PDT, UTC-7).
  assert.equal(nextPacificMidnight(Date.parse('2026-07-01T06:59:00Z')), Date.parse('2026-07-01T07:00:00Z'))
})

test('add: fresh 0700 home, official sign-in argv, identity from google_accounts.json only', async () => {
  const dataDir = await tmpData()
  // A Claude row already in the shared registry must survive.
  await fsp.writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify([{ id: 'claude-uuid-1234', label: 'C', email: 'c@x' }]))
  const g = createGeminiAccounts({ dataDir })
  const start = await g.accounts.addStart({ bin: '/opt/bin/gemini' })
  assert.ok(start.home.startsWith(path.join(dataDir, 'accounts', 'gemini')))
  assert.equal(start.env.GEMINI_CLI_HOME, start.home)
  if (posix) {
    assert.deepEqual(start.argv, ['/usr/bin/env', `GEMINI_CLI_HOME=${start.home}`, '/opt/bin/gemini'])
    assert.equal(await modeOf(start.home), 0o700)
    assert.equal(await modeOf(path.join(start.home, '.gemini')), 0o700)
  }
  const settings = JSON.parse(await fsp.readFile(path.join(start.home, '.gemini', 'settings.json'), 'utf8'))
  assert.equal(settings.security.auth.selectedType, 'oauth-personal')
  assert.equal((await g.accounts.list()).adding, true)

  await assert.rejects(g.accounts.addFinish({}), (e) => e.status === 409)
  await fakeSignIn(start.home, 'me@example.com')
  const { account } = await g.accounts.addFinish({ label: 'Personal Google' })
  assert.equal(account.id, geminiIdOf('me@example.com'))
  assert.equal(account.label, 'Personal Google')
  assert.equal(account.active, true, 'the first account becomes active')

  const l = await g.accounts.list()
  assert.equal(l.active, account.id)
  assert.equal(l.adding, false)
  const rows = JSON.parse(await fsp.readFile(path.join(dataDir, 'accounts.json'), 'utf8'))
  assert.ok(rows.some((r) => r.id === 'claude-uuid-1234' && r.provider === 'claude'))
  assert.ok(rows.some((r) => r.id === account.id && r.provider === 'gemini'))
  const env = await g.envFor()
  assert.deepEqual(env, { GEMINI_CLI_HOME: start.home, GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' })
  // No token anywhere in what we store or return.
  for (const text of [JSON.stringify(l), JSON.stringify(rows), await g.accounts.readLive()]) {
    assert.ok(!text.includes(TOKEN) && !text.includes(REFRESH))
  }
  assert.equal(await g.accounts.identify(await g.accounts.readLive()), account.id)
  await assert.rejects(g.accounts.capture({}), (e) => e.status === 409)
})

test('switch moves only the pointer: no credential file changes, live agents keep their account', async () => {
  const dataDir = await tmpData()
  const g = createGeminiAccounts({ dataDir })
  const a = await addAccount(g, 'a@example.com', 'A')
  const b = await addAccount(g, 'b@example.com', 'B')
  assert.equal((await g.accounts.list()).active, a.account.id)
  const snap = async () => Promise.all([a.start.home, b.start.home].map(async (h) => {
    const p = path.join(h, '.gemini', 'oauth_creds.json'); const s = await fsp.stat(p); return `${s.size}:${s.mtimeMs}:${s.ino}`
  }))
  const before = await snap()

  const agents = [{ id: 'gemini:run1', provider: 'gemini', live: true, name: 'r1' }, { id: 'claude:x', provider: 'claude', live: true }]
  await assert.rejects(g.switcher.switchTo({ to: b.account.id, confirm: 'bogus' }, agents), (e) => e.status === 409)
  const st = await g.switcher.status(agents)
  assert.deepEqual(st.plan.jobs.map((j) => j.id), ['gemini:run1'])
  const out = await g.switcher.switchTo({ to: b.account.id, confirm: st.confirm }, agents)
  assert.equal(out.restored, false)
  assert.equal(out.verified, true)
  assert.deepEqual(out.results.map((r) => [r.id, r.status]), [['gemini:run1', 'unchanged']])
  assert.equal((await g.accounts.list()).active, b.account.id)
  assert.equal((await g.envFor()).GEMINI_CLI_HOME, b.start.home)
  assert.equal((await g.envFor(a.account.id)).GEMINI_CLI_HOME, a.start.home)
  assert.deepEqual(await snap(), before, 'no oauth_creds.json was touched')
  assert.deepEqual(await g.accounts.checkActive(b.account.id), { ok: true })
  assert.equal((await g.accounts.checkActive(a.account.id)).ok, false)
  assert.ok((await g.switcher.lastChangeAt()) > 0)

  await assert.rejects(g.switcher.switchTo({ to: b.account.id }, agents, { auto: true }), /Already on that account/)

  const log = await fsp.readFile(path.join(dataDir, 'account-log.jsonl'), 'utf8')
  assert.match(log, /"provider":"gemini"/)
  assert.ok(!log.includes('@example.com') && !log.includes(TOKEN))

  await g.switcher.undo()
  assert.equal((await g.accounts.list()).active, a.account.id)
  assert.deepEqual(await snap(), before)
})

test('a home whose sign-in changed (or vanished) is never used', async () => {
  const dataDir = await tmpData()
  const g = createGeminiAccounts({ dataDir })
  const a = await addAccount(g, 'a@example.com', 'A')
  const b = await addAccount(g, 'b@example.com', 'B')
  // Someone ran /auth inside B's home and signed in as someone else.
  await fsp.writeFile(path.join(b.start.home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'other@example.com' }))
  await assert.rejects(g.envFor(b.account.id), (e) => e.code === 'login_expired')
  await assert.rejects(g.switcher.switchTo({ to: b.account.id }, [], { auto: true }), (e) => e.code === 'login_expired')
  assert.equal((await g.accounts.list()).active, a.account.id, 'a refused switch changes nothing')
  // A's sign-in deleted.
  await fsp.rm(path.join(a.start.home, '.gemini', 'oauth_creds.json'), { force: true })
  assert.equal((await g.accounts.checkActive(a.account.id)).ok, false)
})

test('re-adding a saved Google account gives it a new home and keeps the old one', async () => {
  const dataDir = await tmpData()
  const g = createGeminiAccounts({ dataDir })
  const first = await addAccount(g, 'a@example.com', 'A')
  const again = await addAccount(g, 'A@example.com')
  assert.equal(again.account.id, first.account.id)
  assert.equal((await g.accounts.load()).length, 1)
  assert.equal((await g.envFor()).GEMINI_CLI_HOME, again.start.home)
  assert.ok(fs.existsSync(path.join(first.start.home, '.gemini')), 'old home left for runs still using it')
  const homes = await g.homes()
  assert.ok(homes.includes(first.start.home) && homes.includes(again.start.home))
  assert.equal(await g.accountOfHome(first.start.home), first.account.id)
  assert.equal((await g.accounts.list()).accounts[0].label, 'A')
})

test('cancel deletes the pending home; a new start discards an old pending one', async () => {
  const dataDir = await tmpData()
  const g = createGeminiAccounts({ dataDir })
  const s1 = await g.accounts.addStart()
  assert.equal(s1.argv, null)
  const s2 = await g.accounts.addStart()
  assert.ok(!fs.existsSync(s1.home))
  await g.accounts.addCancel()
  assert.ok(!fs.existsSync(s2.home))
  assert.equal((await g.accounts.list()).adding, false)
  await assert.rejects(g.accounts.addFinish({}), (e) => e.status === 409)
})

test('remove: refused while active or busy, then deletes the saved sign-in files only', async () => {
  const dataDir = await tmpData()
  let busy = []
  const g = createGeminiAccounts({ dataDir, busyHomes: async () => busy })
  const a = await addAccount(g, 'a@example.com', 'A')
  const b = await addAccount(g, 'b@example.com', 'B')
  await assert.rejects(g.accounts.remove(a.account.id), (e) => e.status === 409)
  busy = [b.start.home]
  await assert.rejects(g.accounts.remove(b.account.id), /still running/)
  busy = []
  await fsp.mkdir(path.join(b.start.home, '.gemini', 'tmp'), { recursive: true })
  assert.deepEqual(await g.accounts.remove(b.account.id), { removed: b.account.id })
  assert.ok(!fs.existsSync(path.join(b.start.home, '.gemini', 'oauth_creds.json')))
  assert.ok(!fs.existsSync(path.join(b.start.home, '.gemini', 'google_accounts.json')))
  assert.ok(fs.existsSync(path.join(b.start.home, '.gemini', 'tmp')), 'session history stays')
  assert.deepEqual((await g.accounts.load()).map((x) => x.id), [a.account.id])
  await assert.rejects(g.accounts.remove(b.account.id), (e) => e.status === 404)
})

test('rename flags and quarantine on the work network', async () => {
  const dataDir = await tmpData()
  let work = false
  const g = createGeminiAccounts({ dataDir, network: { onWork: async () => work } })
  await addAccount(g, 'a@example.com', 'A')
  const b = await addAccount(g, 'b@example.com', 'B')
  const r = await g.accounts.rename(b.account.id, { label: 'Bee', quarantine: true, lowPriority: true })
  assert.deepEqual([r.account.label, r.account.quarantine, r.account.lowPriority], ['Bee', true, true])
  await assert.rejects(g.accounts.rename(b.account.id, {}), (e) => e.status === 400)
  work = true
  await assert.rejects(g.switcher.switchTo({ to: b.account.id }, [], { auto: true }), /quarantine/)
  work = false
  await g.switcher.switchTo({ to: b.account.id }, [], { auto: true })
  work = true
  await g.switcher.switchTo({ to: (await g.accounts.load())[0].id }, [], { auto: true })
  await assert.rejects(g.switcher.undo(), /quarantine/)
})

test('errors-only usage: a limit hit marks the account out until Pacific midnight', async () => {
  const dataDir = await tmpData()
  let t = Date.parse('2026-11-24T12:00:00Z')
  const g = createGeminiAccounts({ dataDir, now: () => t })
  const a = await addAccount(g, 'a@example.com', 'A')
  let u = await g.accounts.activeUsage()
  assert.deepEqual([u.id, u.saved, u.weekly.used, u.fiveHour.none], [a.account.id, true, 0, true])
  assert.equal(u.weekly.resetsAt, Date.parse('2026-11-25T08:00:00Z'))
  await g.accounts.noteLimit(a.account.id)
  u = await g.accounts.activeUsage()
  assert.equal(u.weekly.used, 100)
  assert.equal(g.accounts.cachedUsage().get(a.account.id).weekly.used, 100)
  // Persisted across a restart.
  const g2 = createGeminiAccounts({ dataDir, now: () => t })
  assert.equal((await g2.accounts.usage()).accounts[0].weekly.used, 100)
  t = Date.parse('2026-11-25T08:00:01Z')
  assert.equal((await g2.accounts.activeUsage()).weekly.used, 0)
})

test('AccountOps and SwitchOps carry every key the provider contract checks', async () => {
  const g = createGeminiAccounts({ dataDir: await tmpData() })
  for (const f of ['load', 'list', 'usage', 'cachedUsage', 'activeUsage', 'capture', 'addStart', 'addFinish', 'addCancel',
    'rename', 'remove', 'readLive', 'identify', 'activate', 'restoreLive', 'checkActive', 'headroom']) assert.equal(typeof g.accounts[f], 'function', f)
  for (const f of ['profile', 'status', 'switchTo', 'undo', 'lastChangeAt', 'isBusy']) assert.equal(typeof g.switcher[f], 'function', f)
  for (const f of ['read', 'write', 'identify']) assert.equal(typeof g.credentials[f], 'function', f)
  assert.equal(await g.accounts.readLive(), null)
  assert.equal(await g.envFor(), null)
  assert.equal(await g.accounts.activeUsage(), null)
  await assert.rejects(g.credentials.write('x'), (e) => e.status === 409)
})
