import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHome, EXPECTED, IDS } from './fixtures/make-home.mjs'
import { scan as scanClaude } from '../server/claude-code.mjs'
import { scan as scanCodex } from '../server/codex.mjs'
import { build } from '../server/classify.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-adapters-'))
Object.assign(process.env, makeHome(root))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const agents = async () => build([...(await scanClaude()), ...(await scanCodex())])

test('fixture home: every agent lands in its expected bucket, role and reason', async () => {
  const out = await agents()
  assert.equal(out.length, Object.keys(EXPECTED).length)
  for (const a of out) {
    const e = EXPECTED[a.id]
    assert.ok(e, `unexpected agent ${a.id}`)
    assert.deepEqual({ bucket: a.bucket, role: a.role, ...(e.reason && { reason: a.reason }) }, e, a.id)
  }
  const boss = out.find((a) => a.id === `claude-code:${IDS.boss}`)
  assert.equal(boss.childIds.length, 4, 'spawn edges from `claude --bg` output')
  const lead = out.find((a) => a.id === `claude-code:${IDS.leadBuilding}`)
  assert.deepEqual(lead.prs, [{ id: '101', href: 'https://github.com/example/demo-app/pull/101' }])
  assert.equal(lead.project, 'demo-app')
  for (const sub of out.filter((a) => a.parentId === lead.id)) assert.deepEqual([sub.project, sub.cwd], ['demo-app', path.join(root, 'work', 'demo-app')], sub.id)
  assert.match(lead.resume, /^claude attach /)
  // Nothing from transcripts beyond titles: no tool args, commands or outputs.
  assert.doesNotMatch(JSON.stringify(out), /npm test|look around|backgrounded/)
})

test('scheduler wait survives turn_duration bookkeeping but not newer real work', async () => {
  const file = path.join(process.env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app', `${IDS.leadCi}.jsonl`)
  const job = JSON.parse(fs.readFileSync(path.join(process.env.AGENTVILLE_CLAUDE_HOME, 'jobs', IDS.leadCi.slice(0, 8), 'state.json'), 'utf8'))
  const at = (ms) => new Date(Date.parse(job.updatedAt) + ms).toISOString()
  const ci = async () => (await agents()).find((a) => a.id === `claude-code:${IDS.leadCi}`)
  fs.appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: at(140) }) + '\n')
  assert.equal((await ci()).bucket, 'waiting')
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: at(200), message: { content: 'continue' } }) + '\n')
  assert.notEqual((await ci()).reason, 'Agent reports waiting for CI or checks')
})

test('a subagent does not inherit its parent needing the user', async () => {
  const transcript = path.join(process.env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app', `${IDS.leadBuilding}.jsonl`)
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: {} }] } }) + '\n')
  const out = await agents()
  assert.equal(out.find((a) => a.id === `claude-code:${IDS.leadBuilding}`).bucket, 'stalled')
  assert.equal(out.find((a) => a.id === `claude-code:${IDS.leadBuilding}:sub:worker`).bucket, 'building')
})

test('missing homes are fine', async () => {
  const empty = path.join(root, 'nothing')
  const saved = { ...process.env }
  Object.assign(process.env, { AGENTVILLE_CLAUDE_HOME: empty, AGENTVILLE_CODEX_HOME: empty })
  try {
    assert.equal((await scanClaude()).length, 0)
    assert.equal((await scanCodex()).length, 0)
  } finally { Object.assign(process.env, saved) }
})

test('garbage transcripts are skipped and a recent mtime alone is never Building', async () => {
  const project = path.join(process.env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app')
  const junk = 'bbbbbbbb-0000-4000-8000-000000000000'
  fs.writeFileSync(path.join(project, `${junk}.jsonl`), Buffer.from([0, 159, 146, 150, 10, 123, 34]))
  fs.writeFileSync(path.join(process.env.AGENTVILLE_CODEX_HOME, 'sessions', '2026', '10', '21', `rollout-x-${junk}.jsonl`), 'not json\n')
  // A real-looking session, written seconds ago, mid-tool, with no live process: it stopped.
  const crashed = 'cccccccc-0000-4000-8000-000000000000'
  fs.writeFileSync(path.join(project, `${crashed}.jsonl`), [
    { type: 'user', sessionId: crashed, cwd: '/work/demo-app', timestamp: new Date().toISOString(), message: { content: 'go' } },
    { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const out = await agents()
  assert.ok(!out.some((a) => a.id.includes(junk)), 'garbage files are not agents')
  const c = out.find((a) => a.id === `claude-code:${crashed}`)
  assert.deepEqual([c.bucket, c.reason, c.live], ['stalled', 'Stopped unexpectedly', false])
  for (const a of out.filter((x) => x.bucket === 'building' && x.harness === 'claude-code')) assert.ok(a.live, `${a.id} building without liveness`)
  assert.ok(out.every((a) => Number.isInteger(a.since) && Number.isInteger(a.lastActivityAt)))
})

test('liveness rule: a not-live clean finish rests; Codex finished turns rest after 6 h', async () => {
  const project = path.join(process.env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app')
  const ts = new Date().toISOString()
  const closed = 'dddddddd-0000-4000-8000-000000000000'
  fs.writeFileSync(path.join(project, `${closed}.jsonl`), [
    { type: 'user', sessionId: closed, cwd: '/work/demo-app', uuid: `${closed}-u`, timestamp: ts, message: { content: 'hi' } },
    { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  // Live agents keep "Turn finished"; the fixture solo is live.
  let out = await agents()
  assert.deepEqual([out.find((a) => a.id === `claude-code:${closed}`).bucket, out.find((a) => a.id === `claude-code:${closed}`).reason], ['resting', 'Closed'])
  assert.equal(out.find((a) => a.id === `claude-code:${IDS.soloTurn}`).reason, 'Turn finished — awaiting your reply')
  const rollout = fs.readdirSync(path.join(process.env.AGENTVILLE_CODEX_HOME, 'sessions', '2026', '10', '21')).find((f) => f.includes(IDS.codexTurn))
  const file = path.join(process.env.AGENTVILLE_CODEX_HOME, 'sessions', '2026', '10', '21', rollout)
  const old = new Date(Date.now() - 7 * 3_600_000)
  fs.utimesSync(file, old, old)
  out = await agents()
  assert.equal(out.find((a) => a.id === `codex:${IDS.codexTurn}`).bucket, 'resting')
})

test('a superseded copy of a session folds into the newest one; unreadable files are counted', async () => {
  const project = path.join(process.env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app')
  const [orig, copy] = ['eeeeeee1-0000-4000-8000-000000000000', 'eeeeeee2-0000-4000-8000-000000000000']
  const ts = new Date().toISOString()
  const write = (sid, extra) => fs.writeFileSync(path.join(project, `${sid}.jsonl`), [
    { type: 'user', sessionId: sid, cwd: '/work/demo-app', uuid: 'shared-first-record', timestamp: ts, message: { content: 'hi' }, ...extra },
    { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  write(orig)
  write(copy, { session_id: orig })
  fs.utimesSync(path.join(project, `${orig}.jsonl`), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  const denied = path.join(project, 'eeeeeee3-0000-4000-8000-000000000000.jsonl')
  fs.writeFileSync(denied, '{}\n')
  fs.chmodSync(denied, 0o000)
  try {
    const facts = await scanClaude()
    const ids = facts.map((a) => a.id)
    assert.ok(ids.includes(`claude-code:${copy}`) && !ids.includes(`claude-code:${orig}`))
    if (process.getuid?.() !== 0) assert.equal(facts.unreadable, 1)
  } finally { fs.chmodSync(denied, 0o644) }
})

test('live session registry status: busy, asking, idle-with-pending-tool, unknown and stale', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const project = path.join(claude, 'projects', '-work-demo-app')
  const ago = (ms) => new Date(Date.now() - ms).toISOString()
  const make = (n, status, records, quietMs, extra = {}) => {
    const sid = `${String(n).padStart(8, '9')}-0000-4000-8000-000000000000`
    const file = path.join(project, `${sid}.jsonl`)
    records[0] = { ...records[0], sessionId: sid, cwd: '/work/demo-app', uuid: `${sid}-u` }
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    fs.utimesSync(file, new Date(Date.now() - quietMs), new Date(Date.now() - quietMs))
    fs.writeFileSync(path.join(claude, 'sessions', `${sid.slice(0, 8)}.json`), JSON.stringify({ pid: 1, sessionId: sid, ...(status && { status }), ...extra }))
    return `claude-code:${sid}`
  }
  const user = { type: 'user', timestamp: ago(3_600_000), message: { content: 'go' } }
  const call = (name, msAgo) => ({ type: 'assistant', timestamp: ago(msAgo), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: name, name, input: { command: 'make' } }] } })
  const done = { type: 'assistant', timestamp: ago(3_000_000), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }
  const ids = {
    busyOld: make(1, 'busy', [user, done], 3_000_000),
    asking: make(2, 'needs_user', [user, done], 60_000),
    approval: make(3, 'idle', [user, call('Bash', 45 * 60_000)], 45 * 60_000),
    plan: make(4, 'idle', [user, call('ExitPlanMode', 60_000)], 60_000),
    stuck: make(5, '', [user, call('Bash', 45 * 60_000)], 45 * 60_000),
    unknown: make(6, 'shell', [user, call('Bash', 60_000)], 60_000),
    permission: make(7, 'waiting', [user, call('Bash', 60_000)], 60_000, { waitingFor: 'permission prompt' }),
    question: make(8, 'idle', [user, call('AskUserQuestion', 60_000)], 60_000),
    dialog: make(9, 'waiting', [user, done], 60_000, { waitingFor: 'dialog open' }),
  }
  const out = Object.fromEntries((await agents()).map((a) => [a.id, `${a.bucket} / ${a.reason}`]))
  assert.equal(out[ids.busyOld], 'building / ')
  assert.equal(out[ids.asking], 'stalled / Needs your input')
  assert.equal(out[ids.approval], 'stalled / Needs a click: permission prompt')
  assert.equal(out[ids.plan], 'stalled / Needs a click: approve the plan')
  assert.equal(out[ids.permission], 'stalled / Needs a click: permission prompt')
  assert.equal(out[ids.question], 'stalled / Needs a click: pick an option')
  assert.equal(out[ids.dialog], 'stalled / Needs a click: a dialog is open')
  const prompts = Object.fromEntries((await agents()).map((a) => [a.id, a.prompt]))
  assert.deepEqual([ids.permission, ids.question, ids.plan, ids.asking, ids.stuck].map((id) => prompts[id]), ['permission', 'question', 'plan', null, null])
  assert.equal(out[ids.stuck], 'stalled / No progress for 30 min')
  assert.equal(out[ids.unknown], 'building / ', 'unknown status falls through to the transcript')
  for (const [k, id] of Object.entries(ids)) assert.notEqual(out[id], 'stalled / Stopped unexpectedly', k)
})

test('an idle teammate without its live lead is closed, not waiting', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  fs.rmSync(path.join(claude, 'sessions', `${IDS.leadBuilding.slice(0, 8)}.json`))
  const mate = (await agents()).find((a) => a.id === `claude-code:${IDS.leadBuilding}:sub:mate`)
  assert.deepEqual([mate.bucket, mate.reason], ['resting', 'Closed'])
})

test('a Codex thread imported from another agent and untouched since is closed, never stalled', async () => {
  const codexHome = process.env.AGENTVILLE_CODEX_HOME
  const day = path.join(codexHome, 'sessions', '2026', '10', '21')
  const file = path.join(day, fs.readdirSync(day).find((f) => f.includes(IDS.codexTurn)))
  const fresh = new Date(Date.now() - 30 * 60_000) // a finished turn 30 min ago: stalled without the import
  fs.utimesSync(file, fresh, fresh)
  const id = `codex:${IDS.codexTurn}`
  assert.equal((await agents()).find((a) => a.id === id).bucket, 'stalled')
  const importFile = path.join(codexHome, 'external_agent_session_imports.json')
  fs.writeFileSync(importFile, JSON.stringify({ records: [
    { source_path: '/x/.claude/projects/p/s.jsonl', imported_thread_id: IDS.codexTurn, imported_at: Math.floor(fresh.getTime() / 1000), title: 't' },
  ], detected_connector_records: [] }))
  let a = (await agents()).find((x) => x.id === id)
  assert.deepEqual([a.bucket, a.reason, a.live], ['resting', 'Closed', false])
  // Continued in Codex after the import: an ordinary thread again.
  const later = new Date()
  fs.utimesSync(file, later, later)
  a = (await agents()).find((x) => x.id === id)
  assert.equal(a.bucket, 'stalled')
  fs.rmSync(importFile)
})

test('API errors: scheduler-blocked API failure and the synthetic error message are red errors, not questions', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  // The scheduler's shape: a live job parked as `blocked` with an "API Error: 503 …" detail.
  const jobSid = 'abcdef12-0000-4000-8000-000000000000'
  const iso = (ago) => new Date(Date.now() - ago).toISOString()
  fs.writeFileSync(path.join(claude, 'projects', '-work-demo-app', `${jobSid}.jsonl`), [
    { type: 'user', sessionId: jobSid, cwd: '/work/demo-app', uuid: `${jobSid}-u`, timestamp: iso(120_000), message: { content: 'Nightly sync' } },
    { type: 'assistant', isApiErrorMessage: true, timestamp: iso(100_000), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 503 {"error":"Member authorization unavailable"}' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.mkdirSync(path.join(claude, 'jobs', jobSid.slice(0, 8)), { recursive: true })
  fs.writeFileSync(path.join(claude, 'jobs', jobSid.slice(0, 8), 'state.json'), JSON.stringify({ sessionId: jobSid, resumeSessionId: jobSid, cwd: '/work/demo-app',
    name: 'Sync Job', state: 'blocked', tempo: 'blocked', createdAt: iso(200_000), updatedAt: iso(90_000), detail: 'API Error: 503 {"error":"Member authorization unavailable"}' }))
  fs.writeFileSync(path.join(claude, 'sessions', 'sync.json'), JSON.stringify({ pid: 1, sessionId: jobSid, status: 'idle' }))
  const id = `claude-code:${jobSid}`
  let a = (await agents()).find((x) => x.id === id)
  assert.deepEqual([a.bucket, a.reason, a.severity], ['stalled', 'API error (503)', 'error'])
  assert.doesNotMatch(JSON.stringify(a), /Member authorization/, 'only the status code is surfaced')
  // Still mid-turn (registry busy): Claude Code is retrying on its own; still red, but says so.
  const regFile = path.join(claude, 'sessions', 'sync.json')
  fs.writeFileSync(regFile, JSON.stringify({ pid: 1, sessionId: jobSid, status: 'busy' }))
  a = (await agents()).find((x) => x.id === id)
  assert.deepEqual([a.bucket, a.reason, a.severity], ['stalled', 'Retrying — API error (503)', 'error'])
  fs.writeFileSync(regFile, JSON.stringify({ pid: 1, sessionId: jobSid, status: 'idle' }))
  // A newer, non-blocked scheduler state clears it.
  const stateFile = path.join(claude, 'jobs', jobSid.slice(0, 8), 'state.json')
  const saved = fs.readFileSync(stateFile, 'utf8')
  const later = new Date(Date.now() + 1000).toISOString()
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(saved), state: 'working', tempo: 'active', detail: 'Working', updatedAt: later }))
  a = (await agents()).find((x) => x.id === id)
  assert.equal(a.bucket, 'building')
  fs.writeFileSync(stateFile, saved)
  // Newer real work in the transcript clears the transcript-level error for a session.
  const file = path.join(claude, 'projects', '-work-demo-app', `${IDS.soloError}.jsonl`)
  const before = fs.readFileSync(file, 'utf8')
  assert.equal((await agents()).find((x) => x.id === `claude-code:${IDS.soloError}`).severity, 'error')
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: later, message: { content: 'retry please' } }) + '\n' +
    JSON.stringify({ type: 'assistant', timestamp: later, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }) + '\n')
  a = (await agents()).find((x) => x.id === `claude-code:${IDS.soloError}`)
  assert.notEqual(a.severity, 'error')
  fs.writeFileSync(file, before)
})

test('needs-user from a live blocked job beats structural waiting; bookkeeping does not make it stale', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const id = IDS.boss // a live boss with busy children: without the fix it would be "Waiting on N agents"
  const stateFile = path.join(claude, 'jobs', id.slice(0, 8), 'state.json')
  const saved = fs.readFileSync(stateFile, 'utf8')
  const t0 = Date.now()
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(saved), state: 'blocked', tempo: 'blocked', detail: 'Plan ready; awaits your approval', updatedAt: new Date(t0).toISOString() }))
  const file = path.join(claude, 'projects', '-work-demo-app', `${id}.jsonl`)
  const before = fs.readFileSync(file, 'utf8')
  const at = (ms) => new Date(t0 + ms).toISOString()
  // Newer, but all bookkeeping: local slash command records, a meta record, a sidechain write, turn_duration.
  fs.appendFileSync(file, [
    { type: 'user', isMeta: true, timestamp: at(1000), message: { content: '<local-command-caveat>…</local-command-caveat>' } },
    { type: 'user', timestamp: at(1001), message: { content: '<command-name>/status</command-name>' } },
    { type: 'user', timestamp: at(1002), message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
    { type: 'assistant', isSidechain: true, timestamp: at(1003), message: { content: [{ type: 'text', text: 'sub' }] } },
    { type: 'system', subtype: 'turn_duration', timestamp: at(1004) },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  let a = (await agents()).find((x) => x.id === `claude-code:${id}`)
  assert.deepEqual([a.bucket, a.reason, a.severity], ['stalled', 'Needs your input', 'attention'])
  // Real newer main-thread work does supersede the blocked record.
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: at(2000), message: { content: 'approved, go' } }) + '\n' +
    JSON.stringify({ type: 'assistant', timestamp: at(2001), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }) + '\n')
  a = (await agents()).find((x) => x.id === `claude-code:${id}`)
  assert.notEqual(a.reason, 'Needs your input')
  fs.writeFileSync(file, before)
  fs.writeFileSync(stateFile, saved)
})

test('a blocked job given a new prompt is building: tempo active or a busy process beats the stale state', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const id = IDS.boss
  const stateFile = path.join(claude, 'jobs', id.slice(0, 8), 'state.json')
  const saved = fs.readFileSync(stateFile, 'utf8')
  // What the CLI writes when the user answers a blocked job: the detail becomes the new prompt, tempo
  // goes active and a tool is in flight, but `state` stays blocked until the turn ends.
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(saved), state: 'blocked', tempo: 'active', detail: 'Make the caption centered',
    fan: [{ id: 'b1', kind: 'shell', label: 'git commit', startedAt: Date.now() }], updatedAt: new Date(Date.now() + 1000).toISOString() }))
  const a = (await agents()).find((x) => x.id === `claude-code:${id}`)
  assert.notEqual(a.reason, 'Needs your input')
  assert.notEqual(a.bucket, 'stalled')
  fs.writeFileSync(stateFile, saved)
})

test('a blocked job whose needs is "approve <Tool>: …" is sitting in a permission prompt; a typed question is not', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const id = IDS.boss
  const stateFile = path.join(claude, 'jobs', id.slice(0, 8), 'state.json')
  const saved = fs.readFileSync(stateFile, 'utf8')
  const set = (needs) => fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(saved), state: 'working', tempo: 'blocked', detail: 'Applying edits', needs, updatedAt: new Date(Date.now() + 1000).toISOString() }))
  set("approve Bash: python3 - <<'EOF' …")
  let a = (await agents()).find((x) => x.id === `claude-code:${id}`)
  assert.deepEqual([a.bucket, a.prompt, a.reason], ['stalled', 'permission', 'Needs a click: permission prompt'])
  set('approve or decline edits 1-4')
  a = (await agents()).find((x) => x.id === `claude-code:${id}`)
  assert.deepEqual([a.bucket, a.prompt], ['stalled', null])
  fs.writeFileSync(stateFile, saved)
})

test('a job that failed before it ever ran says why; a newer launch with its name replaces it', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const job = (short, sid, extra) => {
    fs.mkdirSync(path.join(claude, 'jobs', short), { recursive: true })
    fs.writeFileSync(path.join(claude, 'jobs', short, 'state.json'), JSON.stringify({ sessionId: sid, name: 'Billing Lead', cwd: '/work/demo-app', tempo: 'idle', ...extra }))
  }
  const t = Date.now()
  job('f0000001', 'f0000001-0000-4000-8000-000000000000', { state: 'failed', detail: 'source session abcdef01-2345-4678-9abc-def012345678 not found', createdAt: new Date(t - 60_000).toISOString(), updatedAt: new Date(t - 60_000).toISOString() })
  let a = (await agents()).find((x) => x.id === 'claude-code:f0000001-0000-4000-8000-000000000000')
  assert.deepEqual([a.bucket, a.severity, a.reason], ['stalled', 'error', "Couldn't start: source session abcdef01… not found"])
  assert.deepEqual([a.neverStarted, a.resume], [true, null], 'nothing to open: no attach command')
  job('f0000002', 'f0000002-0000-4000-8000-000000000000', { state: 'working', tempo: 'active', createdAt: new Date(t - 30_000).toISOString(), updatedAt: new Date(t).toISOString() })
  a = (await agents()).find((x) => x.id === 'claude-code:f0000001-0000-4000-8000-000000000000')
  assert.deepEqual([a.bucket, a.severity, a.reason], ['resting', null, 'Failed to start; relaunched'])
  for (const short of ['f0000001', 'f0000002']) fs.rmSync(path.join(claude, 'jobs', short), { recursive: true })
})

test('a job restarted mid-turn ("send a prompt to start", its last tool call left pending) needs a "continue", not a click', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const id = IDS.boss
  const stateFile = path.join(claude, 'jobs', id.slice(0, 8), 'state.json')
  const saved = fs.readFileSync(stateFile, 'utf8')
  const file = path.join(claude, 'projects', '-work-demo-app', `${id}.jsonl`)
  const before = fs.readFileSync(file, 'utf8')
  const sessFile = path.join(claude, 'sessions', `${id.slice(0, 8)}.json`)
  const sess = fs.existsSync(sessFile) ? fs.readFileSync(sessFile, 'utf8') : null
  const t = Date.now()
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(t - 5000).toISOString(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'make' } }] } }) + '\n')
  fs.writeFileSync(sessFile, JSON.stringify({ pid: 1, sessionId: id, kind: 'bg', status: 'idle', jobId: id.slice(0, 8) }))
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(saved), state: 'working', tempo: 'blocked', detail: 'Inserting tables', needs: 'send a prompt to start', updatedAt: new Date(t).toISOString() }))
  try {
    const a = (await agents()).find((x) => x.id === `claude-code:${id}`)
    assert.deepEqual([a.bucket, a.prompt, a.reason, a.severity], ['stalled', null, 'Restarted mid-task: send "continue"', 'attention'])
  } finally {
    fs.writeFileSync(file, before); fs.writeFileSync(stateFile, saved)
    if (sess === null) fs.rmSync(sessFile, { force: true }); else fs.writeFileSync(sessFile, sess)
  }
})

test('a live session whose transcript has no cwd (a fork) takes its project from the registry', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const sid = '7e570000-0000-4000-8000-000000000001'
  const dir = path.join(claude, 'projects', '-work-forked')
  fs.mkdirSync(dir, { recursive: true })
  const t = new Date().toISOString()
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    { type: 'user', timestamp: t, sessionId: sid, uuid: 'u1', message: { content: 'go' } },
    { type: 'assistant', timestamp: t, sessionId: sid, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.writeFileSync(path.join(claude, 'sessions', 'fork.json'), JSON.stringify({ pid: 1, sessionId: sid, status: 'idle', cwd: '/work/demo-app' }))
  try {
    const a = (await agents()).find((x) => x.id === `claude-code:${sid}`)
    assert.deepEqual([a.project, a.cwd], ['demo-app', '/work/demo-app'])
    // Ended, with a folder only in its later records (past the head): still known, so it can be reopened.
    fs.rmSync(path.join(claude, 'sessions', 'fork.json'))
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: t, cwd: '/work/demo-app', sessionId: sid }) + '\n')
    const b = (await agents()).find((x) => x.id === `claude-code:${sid}`)
    assert.deepEqual([b.project, b.cwd, b.live], ['demo-app', '/work/demo-app', false])
  } finally { fs.rmSync(dir, { recursive: true }); fs.rmSync(path.join(claude, 'sessions', 'fork.json'), { force: true }) }
})

test('fewer false stalls: a live job that reports done rests; an older stopped copy of a relaunched job rests; an empty copy is closed', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const t = Date.now()
  const job = (short, extra) => {
    const sid = `${short}-0000-4000-8000-000000000000`
    fs.mkdirSync(path.join(claude, 'jobs', short), { recursive: true })
    fs.writeFileSync(path.join(claude, 'jobs', short, 'state.json'), JSON.stringify({ sessionId: sid, cwd: '/work/demo-app', updatedAt: new Date(t - 60_000).toISOString(), ...extra }))
    return `claude-code:${sid}`
  }
  const dir = path.join(claude, 'projects', '-work-demo-app')
  const talk = (sid) => fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    { type: 'user', timestamp: new Date(t - 120_000).toISOString(), sessionId: sid, cwd: '/work/demo-app', uuid: `${sid}-u`, message: { content: 'go' } },
    { type: 'assistant', timestamp: new Date(t - 90_000).toISOString(), sessionId: sid, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const doneId = job('d0000001', { name: 'Wallets Lead', state: 'done', tempo: 'idle', detail: 'retired; checks handed over' })
  talk('d0000001-0000-4000-8000-000000000000')
  fs.writeFileSync(path.join(claude, 'sessions', 'd0000001.json'), JSON.stringify({ pid: 1, sessionId: 'd0000001-0000-4000-8000-000000000000', status: 'idle', jobId: 'd0000001' }))
  const oldId = job('d0000002', { name: 'Phase 9 Lead', state: 'blocked', tempo: 'blocked', detail: 'awaiting your decisions', createdAt: new Date(t - 86_400_000).toISOString() })
  talk('d0000002-0000-4000-8000-000000000000')
  job('d0000003', { name: 'Phase 9 Lead', state: 'working', tempo: 'active', createdAt: new Date(t - 3_600_000).toISOString(), updatedAt: new Date(t).toISOString() })
  const empty = 'e0000004-0000-4000-8000-000000000000'
  fs.writeFileSync(path.join(dir, `${empty}.jsonl`), [{ type: 'custom-title', customTitle: 'Lead (recompact 1)', sessionId: empty }, { type: 'mode', sessionId: empty }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  try {
    const out = await agents()
    const get = (id) => out.find((x) => x.id === id)
    assert.deepEqual([get(doneId).bucket, get(doneId).reason], ['resting', 'Done'])
    assert.deepEqual([get(oldId).bucket, get(oldId).reason], ['resting', 'Replaced by a newer session'])
    assert.equal(get(`claude-code:${empty}`)?.reason ?? 'Closed', 'Closed')
  } finally {
    for (const short of ['d0000001', 'd0000002', 'd0000003']) fs.rmSync(path.join(claude, 'jobs', short), { recursive: true })
    for (const sid of ['d0000001', 'd0000002']) fs.rmSync(path.join(dir, `${sid}-0000-4000-8000-000000000000.jsonl`))
    fs.rmSync(path.join(dir, `${empty}.jsonl`)); fs.rmSync(path.join(claude, 'sessions', 'd0000001.json'))
  }
})

test('a compacted copy (recompactSource) that never took over is folded into its original, not "Stopped unexpectedly"', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const dir = path.join(claude, 'projects', '-work-demo-app')
  const orig = 'c0000001-0000-4000-8000-000000000000', copy = 'c0000002-0000-4000-8000-000000000000'
  const t = Date.now()
  const at = (ms) => new Date(t - ms).toISOString()
  fs.writeFileSync(path.join(dir, `${copy}.jsonl`), [
    { type: 'user', isCompactSummary: true, timestamp: at(60_000), sessionId: copy, cwd: '/work/demo-app', uuid: 'cp-u', message: { content: 'This session is being continued…' } },
    { type: 'assistant', timestamp: at(59_000), sessionId: copy, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'user', timestamp: at(58_000), sessionId: copy, message: { content: 'a queued message' } },
    // The marker is in the closing records, far from the head on a real copy.
    { type: 'system', subtype: 'recompact-brief', timestamp: at(58_000), sessionId: copy, recompactSource: { sessionId: orig } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.utimesSync(path.join(dir, `${copy}.jsonl`), new Date(t - 58_000), new Date(t - 58_000))
  fs.writeFileSync(path.join(dir, `${orig}.jsonl`), [
    { type: 'user', timestamp: at(30_000), sessionId: orig, cwd: '/work/demo-app', uuid: 'or-u', message: { content: 'go' } },
    { type: 'assistant', timestamp: at(20_000), sessionId: orig, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  try {
    const out = await agents()
    assert.ok(out.some((x) => x.id === `claude-code:${orig}`))
    const c = out.find((x) => x.id === `claude-code:${copy}`)
    assert.ok(!c || c.bucket === 'resting', `the copy rests (${c?.reason})`)
  } finally { for (const sid of [orig, copy]) fs.rmSync(path.join(dir, `${sid}.jsonl`)) }
})

test('the Mac sleeping or the network dropping is an interruption to "continue", not a red API error', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const iso = (ago) => new Date(Date.now() - ago).toISOString()
  const cases = [
    ['5eep0000', "API Error: Your computer went to sleep mid-response. The response above may be incomplete.", 'Interrupted when the Mac slept: send "continue"'],
    ['0ff10000', "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", 'Lost the connection: send "continue"'],
  ]
  const made = []
  try {
    for (const [short, text, reason] of cases) {
      const sid = `${short.replace(/[^0-9a-f]/g, '0')}-0000-4000-8000-000000000000`
      const s8 = sid.slice(0, 8)
      made.push(s8)
      fs.writeFileSync(path.join(claude, 'projects', '-work-demo-app', `${sid}.jsonl`), [
        { type: 'user', sessionId: sid, cwd: '/work/demo-app', uuid: `${sid}-u`, timestamp: iso(120_000), message: { content: 'go' } },
        { type: 'assistant', isApiErrorMessage: true, timestamp: iso(100_000), message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n')
      fs.mkdirSync(path.join(claude, 'jobs', s8), { recursive: true })
      fs.writeFileSync(path.join(claude, 'jobs', s8, 'state.json'), JSON.stringify({ sessionId: sid, cwd: '/work/demo-app', name: `Job ${s8}`, state: 'blocked', tempo: 'blocked', createdAt: iso(200_000), updatedAt: iso(90_000), detail: text, needs: `API unavailable — retry · ${text}` }))
      const a = (await agents()).find((x) => x.id === `claude-code:${sid}`)
      assert.deepEqual([a.bucket, a.reason, a.severity, a.prompt], ['stalled', reason, 'attention', null], text)
      const { continuable } = await import('../server/fleet.mjs')
      assert.ok(continuable(a), 'Fleet → Continue reaches it')
    }
  } finally {
    for (const s8 of made) {
      fs.rmSync(path.join(claude, 'jobs', s8), { recursive: true, force: true })
      fs.rmSync(path.join(claude, 'projects', '-work-demo-app', `${s8}-0000-4000-8000-000000000000.jsonl`), { force: true })
    }
  }
})

test('Codex error and stream_error events are error severity', async () => {
  const day = path.join(process.env.AGENTVILLE_CODEX_HOME, 'sessions', '2026', '10', '21')
  const file = path.join(day, fs.readdirSync(day).find((f) => f.includes(IDS.codexRunning)))
  const before = fs.readFileSync(file, 'utf8')
  for (const type of ['error', 'stream_error']) {
    fs.writeFileSync(file, before + JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type } }) + '\n')
    const a = (await agents()).find((x) => x.id === `codex:${IDS.codexRunning}`)
    assert.deepEqual([a.bucket, a.severity], ['stalled', 'error'], type)
  }
  fs.writeFileSync(file, before)
})

test('a stale "done" job reopened in a terminal is that live interactive session; an older terminal entry is not; it falls back when the terminal ends', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const id = `claude-code:${IDS.leadDone}` // job record: state done, tempo idle, written 10 min ago
  const reg = path.join(claude, 'sessions', 'reopened.json')
  const t = Date.now()
  const open = (extra) => fs.writeFileSync(reg, JSON.stringify({ pid: 1, sessionId: IDS.leadDone, kind: 'interactive', startedAt: t - 60_000, statusUpdatedAt: t - 1000, ...extra }))
  const get = async () => (await agents()).find((x) => x.id === id)
  try {
    const before = await get()
    assert.deepEqual([before.bucket, before.reason, before.reopened], ['resting', 'Done', null])
    // Busy in the terminal: Building, whatever the job record says.
    open({ status: 'busy' })
    let a = await get()
    assert.deepEqual([a.bucket, a.live, a.reopened, a.kind, a.jobId, a.role], ['building', true, IDS.leadDone, 'job', IDS.leadDone.slice(0, 8), before.role])
    assert.equal(a.resume, `claude --resume ${IDS.leadDone}`, 'an interactive session is resumed, never attached')
    // Idle after a finished turn: awaiting the user's reply, not resting.
    open({ status: 'idle' })
    a = await get()
    assert.deepEqual([a.bucket, a.reason], ['stalled', 'Turn finished — awaiting your reply'])
    // Idle with a tool call left pending: the permission prompt, like any interactive session.
    const file = path.join(claude, 'projects', '-work-demo-app', `${IDS.leadDone}.jsonl`)
    const saved = fs.readFileSync(file, 'utf8')
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(t).toISOString(), message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }) + '\n')
    a = await get()
    assert.deepEqual([a.bucket, a.prompt], ['stalled', 'permission'])
    fs.writeFileSync(file, saved)
    // A terminal entry older than the job record does not override it: the job's 'done' stands.
    open({ status: 'idle', startedAt: t - 3_600_000, statusUpdatedAt: t - 1_800_000 })
    a = await get()
    assert.deepEqual([a.bucket, a.reason, a.reopened, a.resume], ['resting', 'Done', null, `claude attach ${IDS.leadDone.slice(0, 8)}`])
    // A background process for the job (kind 'bg') is not a terminal.
    open({ status: 'idle', kind: 'bg' })
    assert.equal((await get()).reopened, null)
  } finally { fs.rmSync(reg, { force: true }) }
  // The terminal session ended: back to the job record.
  const a = await get()
  assert.deepEqual([a.bucket, a.reason, a.live, a.reopened], ['resting', 'Done', false, null])
})

test('reopened in a terminal: a stale failed or blocked job record raises no API error, cut-off or question', async () => {
  const claude = process.env.AGENTVILLE_CLAUDE_HOME
  const id = IDS.leadDone
  const stateFile = path.join(claude, 'jobs', id.slice(0, 8), 'state.json')
  const saved = fs.readFileSync(stateFile, 'utf8')
  const reg = path.join(claude, 'sessions', 'reopened.json')
  const t = Date.now()
  try {
    fs.writeFileSync(reg, JSON.stringify({ pid: 1, sessionId: id, kind: 'interactive', status: 'idle', startedAt: t - 60_000, statusUpdatedAt: t - 1000 }))
    for (const patch of [
      { state: 'failed', tempo: 'idle', detail: 'API Error: 529 overloaded' },
      { state: 'blocked', tempo: 'blocked', detail: 'Your computer went to sleep', needs: 'Pick one' },
      { state: 'blocked', tempo: 'blocked', detail: "You've hit your weekly limit · resets Oct 28 at 7am" },
    ]) {
      fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(saved), ...patch }))
      const a = (await agents()).find((x) => x.id === `claude-code:${id}`)
      assert.deepEqual([a.bucket, a.reason, a.severity, a.ask], ['stalled', 'Turn finished — awaiting your reply', 'attention', null], patch.detail)
    }
  } finally { fs.writeFileSync(stateFile, saved); fs.rmSync(reg, { force: true }) }
})
