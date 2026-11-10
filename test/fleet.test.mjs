import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHome, IDS } from './fixtures/make-home.mjs'
import { createServer } from '../server/serve.mjs'
import { notePathFor } from '../server/fleet.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-fleet-'))
Object.assign(process.env, makeHome(root))
const dataDir = path.join(root, 'data')
const server = createServer({ dataDir })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }) })

const C = (k) => `claude-code:${IDS[k]}`
const get = async (p) => (await fetch(`${base}${p}`)).json()
const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) })
const agent = async (id) => (await get('/api/agents')).agents.find((a) => a.id === id)

test('agents payload advertises send mode; sending is disabled in tests without a socket root', async () => {
  const { fleet } = await get('/api/agents')
  assert.deepEqual(fleet, { mode: 'send', blocked: 'Sending is disabled in tests', last: null, pending: null, restore: null })
  const p = await get('/api/fleet/preview?action=offline')
  const r = await post('/api/fleet/send', { action: 'offline', confirm: p.confirm })
  assert.equal(r.status, 501)
})

test('preview: boss gets one relaying copy, leads/subs are reached by relay, solos and Codex get their own', async () => {
  const p = await get('/api/fleet/preview?action=offline')
  assert.equal(p.mode, 'send')
  assert.equal(p.targets.find((t) => t.id === `codex:${IDS.codexTurn}`).problem, "Can't be messaged: Codex")
  const ids = p.targets.map((t) => t.id)
  assert.ok(ids.includes(C('boss')) && ids.includes(C('soloTurn')) && ids.includes(`codex:${IDS.codexTurn}`))
  for (const lead of ['leadBuilding', 'leadBlocked', 'leadCi']) assert.ok(!ids.includes(C(lead)), `${lead} is reached via the boss`)
  assert.ok(!ids.includes(C('leadDone')) && !ids.includes(C('soloOld')), 'resting agents are not targets')
  const boss = p.targets.find((t) => t.id === C('boss'))
  assert.match(boss.text, /^\[Agentville · prep for internet loss\]/)
  assert.match(boss.text, /Forward this exact message to every lead/)
  assert.ok(boss.relayTo.includes(C('leadBuilding')) && boss.relayTo.includes(`${C('leadBuilding')}:sub:worker`))
  assert.equal(p.relayed.find((r) => r.id === `${C('leadBuilding')}:sub:worker`).viaId, C('leadBuilding'))
  assert.deepEqual(boss.reach, { how: 'Attach to the background job', command: `claude attach ${IDS.boss.slice(0, 8)}` })
  const solo = p.targets.find((t) => t.id === C('soloTurn'))
  assert.doesNotMatch(solo.text, /\{|Forward this/, 'placeholders filled; no relay for a solo')
  assert.ok(solo.text.includes(path.join(root, 'work', 'demo-app', '.agentville-note.md')), 'no .git dir: note at the workspace root')
  assert.equal(solo.reach.how, 'Switch to its terminal')
  assert.ok(p.excluded.resting >= 2)
  assert.deepEqual(p.commands, [], 'internet loss needs no restart commands')
})

test('reboot preview lists the commands the user may run; custom text is filled; bad input is refused', async () => {
  const p = await get('/api/fleet/preview?action=reboot')
  const cmds = p.commands.map((c) => c.command)
  assert.ok(cmds.includes('claude respawn --all') && cmds.includes(`claude respawn ${IDS.boss.slice(0, 8)}`))
  assert.ok(cmds.includes(`cd '${path.join(root, 'work', 'demo-app')}' && claude --resume ${IDS.soloTurn}`))
  const custom = await (await post('/api/fleet/preview', { action: 'offline', text: 'Hi {name}, park work in {project}.' })).json()
  assert.ok(custom.targets.some((t) => t.text.startsWith('Hi Big Boss, park work in demo-app.')))
  assert.equal((await fetch(`${base}/api/fleet/preview?action=nuke`)).status, 400)
  assert.equal((await post('/api/fleet/preview', { action: 'offline', text: 7 })).status, 400)
})

test('mark: guarded, validated, persisted; a marked prep pauses recipients until new activity or resume', async () => {
  assert.equal((await post('/api/fleet/mark', { action: 'reboot', ids: [] }, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await post('/api/fleet/mark', { action: 'explode', ids: [] })).status, 400)
  assert.equal((await post('/api/fleet/mark', { action: 'reboot', ids: 'all' })).status, 400)
  assert.equal((await post('/api/fleet/mark', { action: 'reboot', ids: [C('boss'), C('soloTurn')] })).status, 200)
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'fleet.json'), 'utf8'))
  assert.equal(saved.pending.kind, 'reboot')
  const { fleet } = await get('/api/agents')
  assert.deepEqual([fleet.pending.kind, fleet.pending.rebootDetected, fleet.last.kind], ['reboot', false, 'reboot'])

  // The user pastes the prep into the solo; it replies and stops -> paused, not stalled.
  const file = path.join(process.env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app', `${IDS.soloTurn}.jsonl`)
  const at = (ms) => new Date(Date.now() + ms).toISOString()
  const say = (text, ms) => fs.appendFileSync(file, [
    { type: 'user', timestamp: at(ms), message: { content: text } },
    { type: 'assistant', timestamp: at(ms + 1), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  say('[Agentville · prep for laptop reboot]\nYour user is about to restart', 10)
  await new Promise((r) => setTimeout(r, 2100)) // scan cache
  let a = await agent(C('soloTurn'))
  assert.deepEqual([a.bucket, a.reason], ['waiting', 'Paused for reboot prep'])
  // An agent not in the prep is unaffected.
  assert.equal((await agent(C('soloError'))).reason, 'API error (529)')
  // New user activity ends the pause.
  say('Actually, one more thing', 20)
  await new Promise((r) => setTimeout(r, 2100))
  a = await agent(C('soloTurn'))
  assert.deepEqual([a.bucket, a.reason], ['stalled', 'Turn finished — awaiting your reply'])
  // Resume clears the pending prep.
  assert.equal((await post('/api/fleet/mark', { action: 'resume', ids: [C('soloTurn')] })).status, 200)
  const after = (await get('/api/agents')).fleet
  assert.deepEqual([after.pending, after.last.kind], [null, 'resume'])
})

test('note path: inside the workspace, in .git when it is a real git dir', () => {
  const ws = fs.mkdtempSync(path.join(root, 'ws-'))
  assert.equal(notePathFor({ id: 'x', cwd: ws }, dataDir), path.join(ws, '.agentville-note.md'))
  fs.writeFileSync(path.join(ws, '.git'), 'gitdir: /elsewhere\n') // a worktree
  assert.equal(notePathFor({ id: 'x', cwd: ws }, dataDir), path.join(ws, '.agentville-note.md'))
  fs.rmSync(path.join(ws, '.git'))
  fs.mkdirSync(path.join(ws, '.git'))
  assert.equal(notePathFor({ id: 'x', cwd: ws }, dataDir), path.join(ws, '.git', 'agentville-note.md'))
  assert.equal(notePathFor({ id: 'codex:a/b', cwd: null }, dataDir), path.join(dataDir, 'notes', 'codex-a-b.md'))
})

test('a second prep of the same kind joins the batch; a different kind replaces it', async () => {
  await post('/api/fleet/mark', { action: 'offline', ids: ['a'] })
  const first = (await get('/api/agents')).fleet.pending
  await post('/api/fleet/mark', { action: 'offline', ids: ['b'] })
  let p = (await get('/api/agents')).fleet.pending
  assert.deepEqual([p.kind, p.at, p.ids], ['offline', first.at, ['a', 'b']], 'first batch keeps its time, so it stays paused')
  await post('/api/fleet/mark', { action: 'reboot', ids: ['c'] })
  p = (await get('/api/agents')).fleet.pending
  assert.deepEqual([p.kind, p.ids], ['reboot', ['c']])
})

test('mark is rate limited', async () => {
  let last
  for (let i = 0; i < 12; i++) last = await post('/api/fleet/mark', { action: 'offline', ids: [] })
  assert.equal(last.status, 429)
})

test('a job reopened in a terminal is reached and restarted like the interactive session it is', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const reg = path.join(claude, 'sessions', 'reopened.json')
  const now = Date.now()
  fs.writeFileSync(reg, JSON.stringify({ pid: 1, sessionId: IDS.leadDone, kind: 'interactive', status: 'idle', startedAt: now - 60_000, statusUpdatedAt: now }))
  // Top level, so it is a target of its own rather than reached through the boss.
  const patch = (body) => fetch(`${base}/api/overrides/${encodeURIComponent(C('leadDone'))}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })
  assert.equal((await patch({ parentId: '' })).status, 200)
  try {
    await new Promise((r) => setTimeout(r, 2100)) // past the scan cache
    const p = await get('/api/fleet/preview?action=reboot')
    const t = p.targets.find((x) => x.id === C('leadDone'))
    assert.deepEqual(t.reach.how, 'Switch to its terminal')
    assert.match(t.reach.command, new RegExp(`claude --resume ${IDS.leadDone}$`))
    const cmds = p.commands.map((c) => c.command)
    assert.ok(!cmds.includes(`claude respawn ${IDS.leadDone.slice(0, 8)}`), 'never respawned as a background job')
    assert.ok(cmds.some((c) => c.endsWith(`claude --resume ${IDS.leadDone}`)))
  } finally { fs.rmSync(reg, { force: true }); await patch({ parentId: null }) }
})
