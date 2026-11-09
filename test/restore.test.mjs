// Restore after crash (server/restore.mjs). Fixture homes and the stub `claude`
// (test/fixtures/bin/claude-bg) only: nothing here can reach a real session, ~/.claude or the network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, IDS, ENV_SECRET } from './fixtures/make-home.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'va-restore-'))
const sockRoot = fs.mkdtempSync('/tmp/vre-') // short: unix socket paths are limited to ~104 bytes
const env = makeHome(root)
const STUB = fileURLToPath(new URL('./fixtures/bin/claude-bg', import.meta.url))
const log = path.join(root, 'claude-bg.log')
const BOOT1 = Date.parse('2026-11-01T08:00:00Z')
const BOOT2 = BOOT1 + 3 * 86_400_000
Object.assign(process.env, env, { AGENTVILLE_CLAUDE_BIN: STUB, AGENTVILLE_FAKE_CLAUDE_LOG: log, AGENTVILLE_FLEET_SOCKET_ROOT: sockRoot, AGENTVILLE_RESTORE_WAIT_MS: '3000', AGENTVILLE_BOOT_TIME: String(BOOT1) })
const R = await import('../server/restore.mjs')
const { createServer } = await import('../server/serve.mjs')

const claudeHome = env.AGENTVILLE_CLAUDE_HOME
const short = (k) => IDS[k].slice(0, 8)
const C = (k) => `claude-code:${IDS[k]}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const kill = (k) => fs.rmSync(path.join(claudeHome, 'sessions', `${short(k)}.json`), { force: true })
const setState = (k, patch) => {
  const f = path.join(claudeHome, 'jobs', short(k), 'state.json')
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }))
}
let servers = []
test.after(() => { for (const s of servers) s.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(sockRoot, { recursive: true, force: true }) })

// ---------- pure parts ----------

test('saved flags: fixed allowlist, values kept whole; anything else means no fallback', () => {
  assert.deepEqual(R.checkFlags(['-n', 'Big Boss', '--model', 'opus[1m]', '--dangerously-skip-permissions', '--add-dir', '/a', '/b', '--effort=high']).args,
    ['-n', 'Big Boss', '--model', 'opus[1m]', '--dangerously-skip-permissions', '--add-dir', '/a', '/b', '--effort=high'])
  assert.deepEqual(R.checkFlags(undefined).args, [])
  assert.match(R.checkFlags(['--print']).error, /Unsupported saved flag --print/)
  assert.match(R.checkFlags(['--resume', 'x']).error, /Unsupported/)
  assert.match(R.checkFlags(['--model']).error, /no value/)
  assert.match(R.checkFlags(['loose']).error, /Unsupported/)
  assert.match(R.checkFlags(['--model', 'a\0b']).error, /plain text/)
  assert.match(R.checkFlags('--model x').error, /not a list/)
  assert.deepEqual(R.checkEnv({ A_MODEL: 'x' }).env, { A_MODEL: 'x' })
  assert.match(R.checkEnv({ 'bad key': 'x' }).error, /plain text/)
  assert.match(R.checkEnv({ A: 1 }).error, /plain text/)
})

test('running set: live top-level Claude jobs and sessions only; names never fall back to prompt text', () => {
  const agents = [
    { id: C('boss'), harness: 'claude-code', kind: 'job', jobId: short('boss'), name: 'Big Boss', title: 'Coordinate the release', live: true, role: 'boss', project: 'demo-app', cwd: '/w' },
    { id: C('soloTurn'), harness: 'claude-code', kind: 'session', name: 'Explain the build', title: 'Explain the build', live: true, role: 'solo' },
    { id: C('leadDone'), harness: 'claude-code', kind: 'job', jobId: short('leadDone'), name: 'Docs', live: false, role: 'lead' },
    { id: `${C('leadBuilding')}:sub:worker`, harness: 'claude-code', kind: 'subagent', name: 'w', live: true },
    { id: 'codex:x', harness: 'codex', kind: 'session', name: 'c', live: true },
  ]
  const set = R.runningSet(agents, Date.parse('2026-11-01T10:00:42Z'))
  assert.deepEqual(set.map((e) => [e.id, e.kind, e.name, e.role]), [
    [C('boss'), 'job', 'Big Boss', 'boss'],
    [C('soloTurn'), 'session', 'Untitled session', 'solo'], // its "name" was its first prompt
  ])
  assert.equal(set[0].seen, Date.parse('2026-11-01T10:00:00Z'), 'minute steps')
  assert.equal(set[0].short, short('boss'))
})

// ---------- snapshot + detection on a fixture home ----------

function agentsNow(over = {}) {
  // What a scan would report: the fixture's live jobs and sessions.
  const live = new Set(fs.readdirSync(path.join(claudeHome, 'sessions')).map((f) => f.slice(0, 8)))
  const job = (k, role, name) => ({ id: C(k), harness: 'claude-code', kind: 'job', jobId: short(k), name, live: live.has(short(k)), role, project: 'demo-app', cwd: path.join(root, 'work', 'demo-app'), ...over[k] })
  const ses = (k, name) => ({ id: C(k), harness: 'claude-code', kind: 'session', name, title: 'prompt', live: live.has(short(k)), role: 'solo', project: 'demo-app', ...over[k] })
  return [job('boss', 'boss', 'Big Boss'), job('leadBuilding', 'lead', 'API Lead'), job('leadBlocked', 'lead', 'DB Lead'), job('leadCi', 'lead', 'CI Lead'), ses('soloTurn', 'Build question'), ses('soloWaiting', 'Research')]
}

test('snapshot: written atomically only on change, kept across a boot, role as of then', async () => {
  const dataDir = path.join(root, 'unit-data')
  const r = R.createRestore({ dataDir, claudeHome: () => claudeHome })
  const file = path.join(dataDir, 'restore.json')
  const t0 = Date.parse('2026-11-01T10:00:00Z')
  await r.record(agentsNow({ leadBlocked: { important: true } }), t0, BOOT1)
  const first = fs.readFileSync(file, 'utf8')
  const m0 = fs.statSync(file).mtimeMs
  await sleep(20)
  await r.record(agentsNow({ leadBlocked: { important: true } }), t0 + 30_000, BOOT1 + 900) // same minute, same boot (jitter)
  assert.equal(fs.statSync(file).mtimeMs, m0, 'unchanged: no write')
  const snap = JSON.parse(first)
  assert.equal(snap.boot, BOOT1)
  assert.equal(snap.running.length, 6)
  assert.equal(snap.running.find((e) => e.id === C('leadBlocked')).important, true)
  assert.doesNotMatch(first, new RegExp(ENV_SECRET), 'no provider env')
  assert.doesNotMatch(first, /Coordinate the release|Build the API/, 'no conversation text')
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600')
  assert.ok(!fs.readdirSync(dataDir).some((f) => f.endsWith('.tmp')), 'no temp file left')

  // The crash: new boot, nothing live. The first scan after it moves the list to `previous`...
  await r.record([], t0 + 86_400_000, BOOT2)
  // ...and later scans in this boot (the boss now looks like a solo: its children are dead too) don't wipe it.
  await r.record(agentsNow({ boss: { role: 'solo', live: true } }), t0 + 86_500_000, BOOT2)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.previous.boot, BOOT1)
  assert.equal(after.previous.running.length, 6)
  assert.equal(after.previous.running.find((e) => e.id === C('boss')).role, 'boss', 'role as recorded while it was live')
  assert.equal(after.running[0].role, 'solo')
})

test('dashboard down during the crash: a snapshot that predates this boot is the earlier boot', async () => {
  const dataDir = path.join(root, 'down-data')
  fs.mkdirSync(dataDir)
  // Last written two boots ago by a server that never ran in between.
  fs.writeFileSync(path.join(dataDir, 'restore.json'), JSON.stringify({ boot: BOOT1, at: Date.now() - 3600e3, running: R.runningSet(agentsNow(), Date.now() - 3600e3), previous: null }))
  const r = R.createRestore({ dataDir, claudeHome: () => claudeHome })
  await r.record([], Date.now(), BOOT2)
  const x = await r.examine({ boot: BOOT2 })
  assert.equal(x.crashBoot, BOOT1)
  assert.deepEqual(x.jobs.map((j) => j.id).sort(), [C('boss'), C('leadBlocked'), C('leadBuilding'), C('leadCi')].sort())
})

test('lost: no live process, not stopped or removed, transcript kept; crown or Important only', async () => {
  const home2 = path.join(root, 'home2')
  makeHome(home2)
  const ch = path.join(home2, 'claude')
  const dataDir = path.join(root, 'detect-data')
  const r = R.createRestore({ dataDir, claudeHome: () => ch })
  const s = (k) => IDS[k].slice(0, 8)
  const job = (k, role, important = false) => ({ id: C(k), harness: 'claude-code', kind: 'job', jobId: s(k), name: k, live: true, role, important })
  const ses = (k, important = false) => ({ id: C(k), harness: 'claude-code', kind: 'session', name: k, live: true, role: 'solo', important, cwd: '/w/x y' })
  await r.record([job('boss', 'boss'), job('leadBuilding', 'lead', true), job('leadBlocked', 'lead', true), job('leadCi', 'lead', true),
    job('leadDone', 'lead', true), job('soloError', 'solo'), ses('soloTurn', true), ses('soloWaiting')], Date.now(), BOOT1)
  // After the reboot: every process is gone, then...
  for (const f of fs.readdirSync(path.join(ch, 'sessions'))) fs.rmSync(path.join(ch, 'sessions', f))
  const st = (k, p) => { const f = path.join(ch, 'jobs', s(k), 'state.json'); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...p })) }
  st('leadBuilding', { state: 'stopped' }) // `claude stop`
  fs.rmSync(path.join(ch, 'jobs', s('leadDone')), { recursive: true }) // `claude rm`
  // leadCi came back by itself, seen only in the daemon's roster.
  fs.mkdirSync(path.join(ch, 'daemon'), { recursive: true })
  fs.writeFileSync(path.join(ch, 'daemon', 'roster.json'), JSON.stringify({ workers: { [s('leadCi')]: { pid: process.pid } } }))
  // soloError: a job record whose transcript is gone.
  fs.mkdirSync(path.join(ch, 'jobs', s('soloError')), { recursive: true })
  fs.writeFileSync(path.join(ch, 'jobs', s('soloError'), 'state.json'), JSON.stringify({ sessionId: '0e0e0e0e-0000-4000-8000-000000000000', state: 'working' }))
  // soloWaiting (a session, not chosen) is still open in a terminal? No: it's dead and simply not chosen.
  await r.record([], Date.now(), BOOT2)
  const x = await r.examine({ boot: BOOT2 })
  const v = Object.fromEntries([...x.jobs, ...x.sessions].map((e) => [e.id, e.verdict]))
  assert.deepEqual(v, {
    [C('boss')]: 'lost', [C('leadBuilding')]: 'stopped', [C('leadBlocked')]: 'lost', [C('leadCi')]: 'running',
    [C('leadDone')]: 'removed', [C('soloError')]: 'no-transcript', [C('soloTurn')]: 'lost', [C('soloWaiting')]: 'not-chosen',
  })
  assert.equal(x.sessions.find((e) => e.id === C('soloTurn')).command, `cd '/w/x y' && claude --resume ${IDS.soloTurn}`)
  // Marked Important after the crash: it counts.
  const y = await r.examine({ boot: BOOT2, important: (id) => id === C('soloWaiting') })
  assert.equal(y.sessions.find((e) => e.id === C('soloWaiting')).verdict, 'lost')
  // Registry liveness: the boss reopened as a job is running, not lost.
  fs.writeFileSync(path.join(ch, 'sessions', 'b.json'), JSON.stringify({ pid: process.pid, sessionId: IDS.boss, kind: 'bg' }))
  assert.equal((await r.examine({ boot: BOOT2 })).jobs.find((e) => e.id === C('boss')).verdict, 'running')
  // Same boot as the snapshot: nothing is offered.
  assert.equal((await r.examine({ boot: BOOT1 })).crashBoot, null)
  // Dismissed for this boot.
  assert.equal((await r.summary({ boot: BOOT2 })).dismissed, false)
  await r.dismiss(BOOT2)
  assert.equal((await r.summary({ boot: BOOT2 })).dismissed, true)
})

// ---------- the API, end to end with the stub claude and a fake inbox ----------

test('API: Important persists; restore previews, confirms once, restores one at a time, messages crowns', async () => {
  const dataDir = path.join(root, 'api-data')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dataDir, 'overrides.json'), JSON.stringify({ [C('leadDone')]: { name: 'Docs (kept)' } }))
  let server = createServer({ dataDir })
  servers.push(server)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  let base = `http://127.0.0.1:${server.address().port}`
  const req = (p, method = 'GET', body) => fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', origin: base }, ...(body !== undefined && { body: JSON.stringify(body) }) })
  const agents = async () => (await (await req('/api/agents')).json()).agents

  // The Important mark: an override, kept across a restart, next to the existing ones.
  for (const k of ['leadBlocked', 'soloTurn']) assert.equal((await req(`/api/overrides/${encodeURIComponent(C(k))}`, 'PATCH', { important: true })).status, 200)
  assert.equal((await req(`/api/overrides/${encodeURIComponent(C('leadCi'))}`, 'PATCH', { important: 'yes' })).status, 400)
  server.close()
  server = createServer({ dataDir })
  servers.push(server)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  let list = await agents()
  assert.equal(list.find((a) => a.id === C('leadBlocked')).important, true)
  assert.equal(list.find((a) => a.id === C('soloTurn')).important, true)
  assert.equal(list.find((a) => a.id === C('leadCi')).important, false)
  assert.equal(list.find((a) => a.id === C('leadDone')).name, 'Docs (kept)', 'existing overrides preserved')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'overrides.json'), 'utf8'))[C('leadDone')].name, 'Docs (kept)')
  assert.equal(list.find((a) => a.id === C('boss')).role, 'boss')

  // Nothing before a reboot.
  assert.equal((await (await req('/api/restore')).json()).crashBoot, null)

  // The crash: a new boot, every process gone but CI Lead's (it's in the daemon roster).
  process.env.AGENTVILLE_BOOT_TIME = String(BOOT2)
  for (const k of ['boss', 'leadBuilding', 'leadBlocked', 'leadCi', 'soloTurn', 'soloWaiting']) kill(k)
  fs.mkdirSync(path.join(claudeHome, 'daemon'), { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'daemon', 'roster.json'), JSON.stringify({ workers: { [short('leadCi')]: { pid: process.pid } } }))
  await sleep(2100) // past the scan cache
  list = await agents()
  const summary = (await (await req('/api/agents')).json()).fleet.restore
  assert.deepEqual({ lost: summary.lost, sessions: summary.sessions, dismissed: summary.dismissed }, { lost: 2, sessions: 1, dismissed: false })

  const st = await (await req('/api/restore')).json()
  assert.deepEqual(st.jobs.map((j) => [j.id, j.crown, j.important]).sort(), [[C('boss'), true, false], [C('leadBlocked'), false, true]].sort())
  assert.deepEqual(st.sessions.map((s) => s.id), [C('soloTurn')])
  assert.match(st.sessions[0].command, new RegExp(`claude --resume ${IDS.soloTurn}$`))
  assert.deepEqual(st.excluded, { running: 1, 'not-chosen': 2 }) // CI Lead; API Lead and Research
  assert.equal(st.message, R.MESSAGE)

  // Preview: exact commands, env key names only, the crown message under the same confirm.
  const bad = await req('/api/restore/preview', 'POST', { ids: [C('leadCi')] })
  assert.equal(bad.status, 400, 'only lost agents can be restored')
  const pv = await req('/api/restore/preview', 'POST', { ids: [C('boss'), C('leadBlocked')] })
  const pvText = await pv.text()
  assert.equal(pv.status, 200)
  assert.doesNotMatch(pvText, new RegExp(ENV_SECRET), 'never a provider env value')
  const preview = JSON.parse(pvText)
  const boss = preview.jobs.find((j) => j.id === C('boss'))
  assert.equal(boss.command, `claude respawn ${short('boss')}`)
  assert.match(boss.fallback.command, new RegExp(`claude --bg --resume ${IDS.boss} -n 'Big Boss' --model 'opus\\[1m\\]'$`))
  assert.ok(boss.fallback.envKeys.includes('ANTHROPIC_AUTH_TOKEN'))
  assert.deepEqual(preview.message, { text: R.MESSAGE, to: [C('boss')] }, 'crowns only')

  // A fake inbox for the boss once it's back: records the frame and writes the receipt.
  const frames = []
  const transcript = path.join(claudeHome, 'projects', '-work-demo-app', `${IDS.boss}.jsonl`)
  const peer = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => { buf += d })
    c.on('end', () => {
      for (const line of buf.split('\n').filter(Boolean)) {
        const f = JSON.parse(line)
        frames.push(f)
        fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'peer', msg_id: f.msg_id } }) + '\n')
      }
    })
  })
  await new Promise((r) => peer.listen(path.join(sockRoot, `${short('boss')}.sock`), r))
  try {
    process.env.FAKE_RESPAWN_FAIL = short('leadBlocked') // respawn refuses it: the documented resume takes over
    const before = runs().length
    const res = await req('/api/restore/run', 'POST', { confirm: preview.confirm })
    const out = await res.json()
    assert.equal(res.status, 200, JSON.stringify(out))
    assert.deepEqual(out.results.map(({ id, status, via }) => ({ id, status, via })), [
      { id: C('boss'), status: 'restored', via: 'respawn' },
      { id: C('leadBlocked'), status: 'restored', via: 'resume' },
    ])
    const argv = runs().slice(before).map((r) => r.argv)
    assert.equal(argv.length, 3)
    assert.deepEqual(argv[0], ['respawn', short('boss')])
    assert.deepEqual(argv[1], ['respawn', short('leadBlocked')])
    assert.deepEqual(argv[2].slice(0, 4), ['--bg', '--resume', IDS.leadBlocked, '--model'], 'the documented resume with its saved flags')
    assert.equal(runs().slice(before)[2].cwd, fs.realpathSync(path.join(root, 'work', 'demo-app')))
    // The crown's one message, framed like the inspector's, with its receipt.
    assert.deepEqual(out.messages.map(({ id, status }) => ({ id, status })), [{ id: C('boss'), status: 'delivered' }])
    assert.equal(frames.length, 1)
    assert.match(frames[0].message.content, /^<cross-session-message from-name="Agentville">\nYou were restarted after the computer crashed\./)
    // One-time token.
    assert.equal((await req('/api/restore/run', 'POST', { confirm: preview.confirm })).status, 409)
    // The log has ids and outcomes only.
    const flog = fs.readFileSync(path.join(dataDir, 'fleet-log.jsonl'), 'utf8')
    assert.match(flog, /"action":"restore"/)
    assert.doesNotMatch(flog, new RegExp(`${ENV_SECRET}|crashed`))
  } finally {
    delete process.env.FAKE_RESPAWN_FAIL
    peer.close()
  }

  // Both back: nothing left to restore.
  assert.equal((await (await req('/api/restore')).json()).jobs.length, 0)

  // Already running vs failed: a fresh lost pair, previewed, then one comes back before the confirm.
  kill('boss'); fs.rmSync(path.join(claudeHome, 'sessions', `${short('leadBlocked')}.json`), { force: true })
  const pv2 = await (await req('/api/restore/preview', 'POST', {})).json()
  assert.deepEqual(pv2.jobs.map((j) => j.id).sort(), [C('boss'), C('leadBlocked')].sort())
  fs.writeFileSync(path.join(claudeHome, 'sessions', `${short('boss')}.json`), JSON.stringify({ pid: process.pid, sessionId: IDS.boss, kind: 'bg' }))
  Object.assign(process.env, { FAKE_RESPAWN_FAIL: '1', FAKE_RESUME_FAIL: '1' })
  try {
    const out = await (await req('/api/restore/run', 'POST', { confirm: pv2.confirm })).json()
    const by = Object.fromEntries(out.results.map((r) => [r.id, r]))
    assert.deepEqual([by[C('boss')].status, by[C('boss')].detail], ['running', 'Already running'])
    assert.deepEqual([by[C('leadBlocked')].status, by[C('leadBlocked')].detail], ['failed', 'Respawn failed (exit 1); resume failed (exit 5)'])
    assert.deepEqual(out.messages.map(({ id, status, detail }) => ({ id, status, detail })), [{ id: C('boss'), status: 'skipped', detail: 'Not restored' }], 'nothing to agents that were not restored')
  } finally { delete process.env.FAKE_RESPAWN_FAIL; delete process.env.FAKE_RESUME_FAIL }

  // Dismiss hides the notice for this boot only.
  assert.equal((await req('/api/restore/dismiss', 'POST', {})).status, 200)
  assert.equal((await (await req('/api/restore')).json()).dismissed, true)
  process.env.AGENTVILLE_BOOT_TIME = String(BOOT1)
})
