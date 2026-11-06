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

/** A fresh fake home + fake claude + server (see test/fixtures/account-home.mjs). */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-account-'))
  const { env, home, log, files } = makeAccountHome(root)
  Object.assign(process.env, env)
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
  return { root, home, dataDir, base, files, originals, read, status, post, respawns, done }
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
    assert.deepEqual(r.json.results, [{ id: 'aaaa0001', status: 'respawned', verified: 'no reply yet (job idle)' }, { id: 'aaaa0002', status: 'respawned' }])
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

test('the first respawn is a canary: on failure every file is restored and the rest are not attempted', async () => {
  const t = await setup()
  try {
    process.env.FAKE_RESPAWN_FAIL = '1'
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200)
    assert.equal(r.json.restored, true)
    assert.deepEqual(r.json.results.map((x) => [x.id, x.status, x.detail]), [['aaaa0001', 'failed', 'Respawn failed (exit 7)'], ['aaaa0002', 'skipped', 'Not attempted after the first respawn failed']])
    for (const k of ['settings', 'aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004']) assert.equal(t.read(k), t.originals[k], k)
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'pool-profile.json')))
    assert.equal(t.respawns().length, 1)
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
    process.env.FAKE_REPLY = 'ok'
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.deepEqual([r.status, r.json.restored, r.json.results[0].verified], [200, false, 'reply seen'])
  } finally { t.done() }
})

test('canary verification: not back, settings changed back, or an API-error reply all roll everything back', async () => {
  for (const [env, detail] of [
    [{ FAKE_NO_LIVE: '1' }, "Verification failed: the first job didn't come back within the time limit"],
    [{ FAKE_CLOBBER: '1' }, "Verification failed: the job's saved settings were changed back"],
    [{ FAKE_REPLY: 'synthetic' }, 'Verification failed: the first reply after the restart was an API error'],
  ]) {
    const t = await setup()
    try {
      Object.assign(process.env, env)
      const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.restored, true, detail)
      assert.deepEqual(r.json.results.map((x) => [x.id, x.status, x.detail]), [['aaaa0001', 'failed', detail], ['aaaa0002', 'skipped', 'Not attempted after the first respawn failed']])
      for (const k of ['settings', 'aaaa0002', 'aaaa0003']) assert.equal(t.read(k), t.originals[k], k)
      if (!env.FAKE_CLOBBER) assert.equal(t.read('aaaa0001'), t.originals.aaaa0001)
      // Respawned, failed verification, files restored, respawned once more onto them.
      assert.deepEqual(t.respawns(), [['respawn', 'aaaa0001'], ['respawn', 'aaaa0001']])
      assert.equal(r.json.results[0].restarted, 'back on the previous settings')
    } finally { t.done() }
  }
})

test('switching back to the pool verifies the restored flags too', async () => {
  const t = await setup()
  try {
    let r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.json.restored, false)
    process.env.FAKE_CLOBBER = '1' // the daemon "writes" a different flag set than the stash
    const stash = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'pool-profile.json'), 'utf8'))
    stash.jobs.aaaa0001.respawnFlags = ['--model', 'cc/claude-sonnet-5-5'] // so the clobbered state differs
    fs.writeFileSync(path.join(t.dataDir, 'pool-profile.json'), JSON.stringify(stash))
    r = await t.post('/api/account/switch', { to: 'pool', confirm: (await t.status()).confirm })
    assert.deepEqual([r.json.restored, r.json.results[0].detail], [true, "Verification failed: the job's saved settings were changed back"])
    assert.equal((await t.status()).profile, 'personal', 'rolled back to where it was')
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

test('a job reopened in a terminal after the preview is skipped; the next job is the canary', async () => {
  const t = await setup()
  try {
    process.env.FAKE_RESPAWN_TERMINAL = 'aaaa0001'
    const r = await t.post('/api/account/switch', { to: 'personal', confirm: (await t.status()).confirm })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.restored, false)
    assert.deepEqual(r.json.results, [
      { id: 'aaaa0001', status: 'skipped', detail: 'Open in a terminal: restart it there' },
      { id: 'aaaa0002', status: 'respawned', verified: 'no reply yet (job idle)' },
    ])
  } finally { delete process.env.FAKE_RESPAWN_TERMINAL; t.done() }
})
