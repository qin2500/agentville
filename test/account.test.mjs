/**
 * Pool <-> personal switching, against fake homes and a fake `claude` only. Nothing here reads or
 * touches the real ~/.claude, real jobs or the real CLI.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../server/serve.mjs'

import { makeAccountHome, SETTINGS, TOKEN } from './fixtures/account-home.mjs'

const setTempo = (file, tempo) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), tempo }))
const until = async (ok, ms = 3000) => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
const auditLog = (dataDir) => fs.readFileSync(path.join(dataDir, 'account-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

/** A fresh fake home + fake claude + server (see test/fixtures/account-home.mjs). */
async function setup({ busy = false, idleMaxMs = 2000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-account-'))
  const { env, home, log, files } = makeAccountHome(root)
  Object.assign(process.env, env, { AGENTVILLE_ACCOUNT_POLL_MS: '30', AGENTVILLE_ACCOUNT_IDLE_MAX_MS: String(idleMaxMs) })
  // The fixture's aaaa0001 is mid turn (tempo active); most tests want every job at a turn boundary.
  if (!busy) setTempo(files.aaaa0001, 'idle')
  for (const k of ['FAKE_AUTH', 'FAKE_RESPAWN_FAIL', 'FAKE_RESPAWN_MS', 'FAKE_CLOBBER', 'FAKE_NO_LIVE', 'FAKE_REPLY', 'FAKE_RESPAWN_TERMINAL']) delete process.env[k]
  const dataDir = path.join(root, 'data')
  const server = createServer({ dataDir })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const originals = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]))
  const read = (k) => fs.readFileSync(files[k], 'utf8')
  const status = async () => (await fetch(`${base}/api/account`)).json()
  const post = async (p, body, headers = {}) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) })
    const text = await r.text()
    return { status: r.status, text, json: JSON.parse(text) }
  }
  const respawns = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[0] === 'respawn') : [])
  const done = () => { server.close(); fs.rmSync(root, { recursive: true, force: true }) }
  return { root, home, dataDir, base, files, originals, read, status, post, respawns, done, setTempo: (k, v) => setTempo(files[k], v) }
}

test('status: profile, readiness and the plan, with no secret anywhere', async () => {
  const t = await setup()
  try {
    const s = await t.status()
    assert.deepEqual([s.profile, s.personalReady, s.poolStashed, s.blocked], ['pool', true, false, ''])
    assert.deepEqual(s.plan.jobs.map((j) => [j.id, j.model]), [['aaaa0001', 'cc/claude-opus-5-5'], ['aaaa0002', 'cc/claude-sonnet-5-5']], 'non-terminal jobs only')
    assert.equal(typeof s.confirm, 'string')
    assert.doesNotMatch(JSON.stringify(s), new RegExp(`${TOKEN}|gateway\\.example|someone@`))
  } finally { t.done() }
})

test('round trip pool -> personal -> pool restores every file byte for byte; nothing leaks', async () => {
  const t = await setup()
  try {
    let r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.results, [{ id: 'aaaa0001', status: 'respawned' }, { id: 'aaaa0002', status: 'respawned' }])
    assert.deepEqual(t.respawns(), [['respawn', 'aaaa0001'], ['respawn', 'aaaa0002']], 'sequential, no extra flags')
    const settings = JSON.parse(t.read('settings'))
    assert.deepEqual(settings.env, { KEEP_ME: 'yes', ALSO_KEEP: 'x' }, 'pool keys out, others kept')
    assert.deepEqual([settings.permissions, settings.model, settings.hooks], [SETTINGS.permissions, 'opus', {}])
    const j1 = JSON.parse(t.read('aaaa0001'))
    assert.deepEqual(j1.respawnFlags, ['--name', 'API Lead', '--model', 'claude-opus-5-5'])
    assert.deepEqual(j1.providerEnv, { OTHER: '1' })
    assert.deepEqual(JSON.parse(t.read('aaaa0002')).respawnFlags, ['--model=claude-sonnet-5-5'])
    assert.equal(t.read('aaaa0003'), t.originals.aaaa0003, 'a finished job is never touched')
    assert.deepEqual(JSON.parse(t.read('aaaa0004')).respawnFlags, ['--model', 'claude-opus-5-5'], 'a dormant job gets the new settings…')
    assert.ok(!t.respawns().some((a) => a[1] === 'aaaa0004'), '…but is never restarted')
    const stash = path.join(t.dataDir, 'pool-profile.json')
    assert.equal(fs.statSync(stash).mode & 0o777, 0o600)
    assert.ok(fs.readFileSync(stash, 'utf8').includes(TOKEN), 'the token is kept only in the 0600 stash')
    assert.equal((await t.status()).profile, 'personal')
    assert.doesNotMatch(r.text, new RegExp(TOKEN))

    r = await t.post('/api/account/switch', { to: 'pool', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200, r.text)
    for (const k of ['settings', 'aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004']) assert.equal(t.read(k), t.originals[k], k)
    assert.ok(!fs.existsSync(stash))
    // Backups are private, and no log or response carries a secret.
    const backups = path.join(t.dataDir, 'account-backups')
    assert.equal(fs.statSync(backups).mode & 0o777, 0o700)
    for (const set of fs.readdirSync(backups)) assert.equal(fs.statSync(path.join(backups, set, 'settings.json')).mode & 0o777, 0o600)
    assert.doesNotMatch(fs.readFileSync(path.join(t.dataDir, 'account-log.jsonl'), 'utf8'), new RegExp(TOKEN))
  } finally { t.done() }
})

test('a failed respawn is reported and skipped; the other jobs still restart and nothing is rolled back', async () => {
  const t = await setup()
  try {
    process.env.FAKE_RESPAWN_FAIL = '1'
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.restored, false)
    assert.deepEqual(r.json.results.map((x) => [x.id, x.status, x.detail]), [['aaaa0001', 'failed', 'Respawn failed (exit 7)'], ['aaaa0002', 'respawned', undefined]])
    assert.deepEqual(t.respawns().map((a) => a[1]), ['aaaa0001', 'aaaa0002'])
    assert.equal((await t.status()).profile, 'personal', 'the switch stands')
    assert.deepEqual(JSON.parse(t.read('aaaa0001')).respawnFlags, ['--name', 'API Lead', '--model', 'claude-opus-5-5'], 'its settings are switched for its next start')
    const entry = auditLog(t.dataDir).at(-1)
    assert.deepEqual([entry.action, entry.auto, entry.restored, entry.results[0].status], ['switch', false, false, 'failed'])
  } finally { t.done() }
})

test('a busy job is restarted only once its turn ends; the switch does not wait for it', async () => {
  const t = await setup({ busy: true })
  try {
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.results.map((x) => [x.id, x.status]), [['aaaa0001', 'waiting'], ['aaaa0002', 'respawned']])
    assert.deepEqual(t.respawns().map((a) => a[1]), ['aaaa0002'], 'the busy job is not cut off')
    assert.deepEqual((await t.status()).restarts, [{ id: 'aaaa0001', status: 'waiting' }])
    await new Promise((res) => setTimeout(res, 150))
    assert.deepEqual(t.respawns().map((a) => a[1]), ['aaaa0002'], 'still busy: still not restarted')
    t.setTempo('aaaa0001', 'idle') // its turn ended
    await until(() => t.respawns().some((a) => a[1] === 'aaaa0001'))
    await until(() => auditLog(t.dataDir).at(-1).action === 'restart')
    assert.deepEqual(auditLog(t.dataDir).at(-1).results, [{ id: 'aaaa0001', status: 'respawned' }])
    assert.deepEqual((await t.status()).restarts, [])
  } finally { t.done() }
})

test('a job still busy at the cap is left "restart pending", never killed', async () => {
  const t = await setup({ busy: true, idleMaxMs: 200 })
  try {
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.json.results[0].status, 'waiting')
    await until(() => auditLog(t.dataDir).at(-1).action === 'restart')
    assert.deepEqual(auditLog(t.dataDir).at(-1).results.map((x) => [x.id, x.status]), [['aaaa0001', 'pending']])
    assert.ok(!t.respawns().some((a) => a[1] === 'aaaa0001'))
    assert.deepEqual((await t.status()).restarts.map((x) => [x.id, x.status]), [['aaaa0001', 'pending']])
  } finally { t.done() }
})

test('Undo puts back only what the switch changed, and only the flags and env of a job file', async () => {
  const t = await setup()
  try {
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200, r.text)
    // Claude rewrites job files as they run; the finished job was not part of the switch at all.
    for (const k of ['aaaa0001', 'aaaa0003']) fs.writeFileSync(t.files[k], JSON.stringify({ ...JSON.parse(t.read(k)), state: 'idle', note: 'written later' }))
    const u = await t.post('/api/account/undo', {})
    assert.deepEqual([u.status, u.json.profile], [200, 'pool'])
    assert.equal(t.read('settings'), t.originals.settings)
    const j1 = JSON.parse(t.read('aaaa0001'))
    const o1 = JSON.parse(t.originals.aaaa0001)
    assert.deepEqual([j1.respawnFlags, j1.providerEnv], [o1.respawnFlags, o1.providerEnv], 'flags and env put back')
    assert.deepEqual([j1.state, j1.note], ['idle', 'written later'], "the job's own later writes are kept")
    assert.deepEqual(JSON.parse(t.read('aaaa0003')).note, 'written later', 'a file the switch did not change is left alone')
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'pool-profile.json')))
  } finally { t.done() }
})

test('backups: only the newest 10 sets are kept', async () => {
  const t = await setup()
  try {
    const root = path.join(t.dataDir, 'account-backups')
    for (let i = 0; i < 12; i++) fs.mkdirSync(path.join(root, `2000-01-01T00-00-${String(i).padStart(2, '0')}-000Z`), { recursive: true })
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200, r.text)
    const sets = fs.readdirSync(root).sort()
    assert.equal(sets.length, 10)
    assert.ok(!sets[9].startsWith('2000-'), 'the new set is kept')
    assert.equal(sets[0], '2000-01-01T00-00-03-000Z', 'the oldest are removed')
  } finally { t.done() }
})

test('refusals: same profile, stale token, Origin, test guard; nothing changes', async () => {
  const t = await setup()
  try {
    let r = await t.post('/api/account/switch', { to: 'pool', confirm: (await t.status()).confirm })
    assert.deepEqual([r.status, r.json.error], [409, 'Already on the pool'])
    r = await t.post('/api/account/switch', { to: 'personal', confirm: 'not-a-token' })
    assert.deepEqual([r.status, r.json.error], [409, 'This preview has expired. Open it again.'])
    assert.equal((await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm }, { origin: 'http://evil.example' })).status, 403)
    const bin = process.env.AGENTVILLE_CLAUDE_BIN
    delete process.env.AGENTVILLE_CLAUDE_BIN
    try {
      r = await t.post('/api/account/switch', { to: 'personal', confirm: 'x' })
      assert.deepEqual([r.status, r.json.error], [501, 'Account switching is disabled in tests'])
    } finally { process.env.AGENTVILLE_CLAUDE_BIN = bin }
    for (const k of ['settings', 'aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004']) assert.equal(t.read(k), t.originals[k], k)
    assert.equal(t.respawns().length, 0)
  } finally { t.done() }
})

test('one switch at a time; undo puts the last backup back', async () => {
  const t = await setup()
  try {
    process.env.FAKE_RESPAWN_MS = '400'
    const c1 = (await t.status()).confirm
    const c2 = (await t.status()).confirm
    const [a, b] = await Promise.all([
      t.post('/api/account/switch', { to: 'personal', confirm: c1 }),
      t.post('/api/account/switch', { to: 'personal', confirm: c2 }),
    ])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    assert.equal([a, b].find((x) => x.status === 409).json.error, 'A switch is already running')
    assert.equal((await t.status()).profile, 'personal')
    const u = await t.post('/api/account/undo', {})
    assert.deepEqual([u.status, u.json.profile], [200, 'pool'])
    for (const k of ['settings', 'aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004']) assert.equal(t.read(k), t.originals[k], k)
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'pool-profile.json')))
  } finally { t.done() }
})

test('personalReady: a claude.ai login is true; on the pool anything else is "unknown" and the switch may proceed', async () => {
  const t = await setup()
  try {
    assert.equal((await t.status()).personalReady, true)
    for (const mode of ['gateway', 'none']) {
      process.env.FAKE_AUTH = mode
      assert.equal((await t.status()).personalReady, 'unknown', mode)
    }
    // On the pool, auth status shows the gateway's token, but a stored personal login still counts.
    const cred = path.join(process.env.AGENTVILLE_CLAUDE_HOME, '.credentials.json')
    fs.writeFileSync(cred, '{}')
    assert.equal((await t.status()).personalReady, true, 'stored login found while the pool is active')
    fs.rmSync(cred)
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.deepEqual([r.status, r.json.restored, r.json.results[0].status], [200, false, 'respawned'])
  } finally { t.done() }
})

test('a job marked done whose process is still running is switched and restarted too', async () => {
  const t = await setup()
  try {
    // aaaa0003 is "done" in its record, but its process is alive (a finished job left open).
    fs.writeFileSync(path.join(t.home, 'sessions', 'aaaa0003.json'), JSON.stringify({ pid: process.pid, sessionId: 'aaaa0003-0000-4000-8000-000000000000', jobId: 'aaaa0003', status: 'idle' }))
    const s = await t.status()
    assert.ok(s.plan.jobs.some((j) => j.id === 'aaaa0003'), 'listed in the plan')
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: s.confirm })
    assert.equal(r.status, 200, r.text)
    assert.ok(t.respawns().some((a) => a[1] === 'aaaa0003'), 'restarted')
    assert.deepEqual(JSON.parse(t.read('aaaa0003')).respawnFlags, ['--model', 'claude-opus-5-5'])
    assert.ok(!t.respawns().some((a) => a[1] === 'aaaa0004'), 'a dormant job still is not')
  } finally { t.done() }
})

test('a job reopened in a terminal is left to the user, never restarted, and never blocks the switch', async () => {
  const t = await setup()
  try {
    // The user ran `claude --resume` on aaaa0001: its live registry entry is interactive, not bg.
    fs.writeFileSync(path.join(t.home, 'sessions', 'aaaa0001.json'), JSON.stringify({ pid: process.pid, sessionId: 'aaaa0001-0000-4000-8000-000000000000', kind: 'interactive', status: 'idle' }))
    const s = await t.status()
    assert.deepEqual(s.plan.jobs.map((j) => j.id), ['aaaa0002'])
    assert.ok(s.plan.sessions.some((x) => x.note === 'Open in a terminal: restart it there'), 'listed to restart by hand')
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: s.confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.restored, false)
    assert.deepEqual(t.respawns(), [['respawn', 'aaaa0002']])
    assert.deepEqual(JSON.parse(t.read('aaaa0001')).respawnFlags, ['--name', 'API Lead', '--model', 'claude-opus-5-5'], 'its settings still change for its next start')
  } finally { t.done() }
})

test('a job reopened in a terminal after the preview is skipped; the next job still restarts', async () => {
  const t = await setup()
  try {
    process.env.FAKE_RESPAWN_TERMINAL = 'aaaa0001'
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.restored, false)
    assert.deepEqual(r.json.results, [
      { id: 'aaaa0001', status: 'skipped', detail: 'Open in a terminal: restart it there' },
      { id: 'aaaa0002', status: 'respawned' },
    ])
  } finally { delete process.env.FAKE_RESPAWN_TERMINAL; t.done() }
})
