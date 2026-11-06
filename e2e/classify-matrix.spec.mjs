// The attention list must be right on a stranger's machine: an agent that needs the user must never
// rest or wait, and a crashed one must never rest. Each case is a synthetic transcript scanned by
// the real server; the matrix runs once (API-level, no browser).
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import { tmpDir, startServer, nextPort } from './helpers.mjs'

const MIN = 60_000
const ALIVE = 1 // launchd: always running
const DEAD = 2 ** 22 - 7 // above macOS/Linux default pid_max ranges in practice; never a live process here
const uuid = (n) => `c${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`

// [label, records(ago) => [...], { pid?, agoMs }, expectation]
const user = (ago, text = 'Do the thing') => ({ type: 'user', timestamp: iso(ago), message: { role: 'user', content: text } })
const said = (ago) => ({ type: 'assistant', timestamp: iso(ago), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } })
const tool = (ago, name, input = {}) => ({ type: 'assistant', timestamp: iso(ago), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t-${name}`, name, input }] } })
const result = (ago, name) => ({ type: 'user', timestamp: iso(ago), message: { content: [{ type: 'tool_result', tool_use_id: `t-${name}`, content: 'ok' }] } })
let NOW = Date.now()
function iso(ago) { return new Date(NOW - ago).toISOString() }

const CLAUDE = [
  ['live, turn finished 2 h ago', (a) => [user(a + 1000), said(a)], { pid: ALIVE, ago: 120 * MIN }, { bucket: 'stalled' }],
  ['live, AskUserQuestion pending 10 min', (a) => [user(a + 1000), tool(a, 'AskUserQuestion', { questions: [] })], { pid: ALIVE, ago: 10 * MIN }, { bucket: 'stalled', reason: 'Needs a click: pick an option' }],
  ['live, ExitPlanMode (plan approval) pending 10 min', (a) => [user(a + 1000), tool(a, 'ExitPlanMode', { plan: 'x' })], { pid: ALIVE, ago: 10 * MIN }, { bucket: 'stalled', reason: 'Needs a click: approve the plan' }],
  ['live, Bash pending 45 min (permission prompt or long command)', (a) => [user(a + 1000), tool(a, 'Bash', { command: 'make' })], { pid: ALIVE, ago: 45 * MIN }, { bucket: 'stalled', reason: 'Needs a click: permission prompt' }], // registry says idle with a tool pending
  ['live, interrupted by user 5 min ago', (a) => [user(a + 1000), user(a, '[Request interrupted by user]')], { pid: ALIVE, ago: 5 * MIN }, { bucket: 'stalled' }],
  ['crashed (dead pid) mid tool call 5 min ago', (a) => [user(a + 1000), tool(a, 'Bash', { command: 'make' })], { pid: DEAD, ago: 5 * MIN }, { bucket: 'stalled', reason: 'Stopped unexpectedly' }],
  ['crashed (dead pid) right after a tool result', (a) => [user(a + 2000), tool(a + 1000, 'Read'), result(a, 'Read')], { pid: DEAD, ago: 5 * MIN }, { bucket: 'stalled', reason: 'Stopped unexpectedly' }],
  ['crashed (no registry) right after the user prompt', (a) => [user(a)], { ago: 5 * MIN }, { bucket: 'stalled', reason: 'Stopped unexpectedly' }],
  ['API error, process gone', (a) => [user(a + 1000), { type: 'system', subtype: 'api_error', timestamp: iso(a) }], { pid: DEAD, ago: 5 * MIN }, { bucket: 'stalled', reason: 'API error' }],
  // The CLI's own registry status (~/.claude/sessions/*.json) decides permission prompts and long tools.
  ['registry busy, Bash pending 45 min (long command)', (a) => [user(a + 1000), tool(a, 'Bash', { command: 'make' })], { pid: ALIVE, status: 'busy', ago: 45 * MIN }, { bucket: 'building' }],
  ['registry waiting, turn finished', (a) => [user(a + 1000), said(a)], { pid: ALIVE, status: 'waiting', ago: 2 * MIN }, { bucket: 'stalled', reason: 'Needs your input' }],
  ['registry idle, foreground subagent pending', (a) => [user(a + 1000), tool(a, 'Agent', { prompt: 'x' })], { pid: ALIVE, ago: 5 * MIN }, { bucket: 'waiting' }],
  ['registry idle, blocking TaskOutput pending', (a) => [user(a + 1000), tool(a, 'TaskOutput', { task_id: 'b1', block: true })], { pid: ALIVE, ago: 5 * MIN }, { bucket: 'waiting' }],
  ['registry shell (unknown), Bash pending 45 min', (a) => [user(a + 1000), tool(a, 'Bash', { command: 'make' })], { pid: ALIVE, status: 'shell', ago: 45 * MIN }, { bucket: 'stalled', notReason: 'Stopped unexpectedly' }],
  ['no registry status (older CLI), Bash pending 5 min', (a) => [user(a + 1000), tool(a, 'Bash', { command: 'make' })], { pid: ALIVE, status: null, ago: 5 * MIN }, { bucket: 'building' }],
  ['dead pid whose registry still says busy', (a) => [user(a + 1000), tool(a, 'Bash', { command: 'make' })], { pid: DEAD, status: 'busy', ago: 5 * MIN }, { bucket: 'stalled', reason: 'Stopped unexpectedly' }],
  ['exited cleanly after a finished turn', (a) => [user(a + 1000), said(a)], { pid: DEAD, ago: 5 * MIN }, { bucket: 'resting' }],
]

function writeClaude(home) {
  const proj = path.join(home, 'claude', 'projects', '-work-matrix')
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(path.join(home, 'claude', 'sessions'), { recursive: true })
  return CLAUDE.map(([label, recs, o, want], i) => {
    const sid = uuid(i)
    const records = recs(o.ago)
    records[0] = { ...records[0], sessionId: sid, cwd: '/work/matrix', uuid: `${sid}-u` }
    const file = path.join(proj, `${sid}.jsonl`)
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    fs.utimesSync(file, new Date(NOW - o.ago), new Date(NOW - o.ago))
    if (o.pid) fs.writeFileSync(path.join(home, 'claude', 'sessions', `${sid.slice(0, 8)}.json`), JSON.stringify({ pid: o.pid, sessionId: sid, kind: 'interactive', ...(o.status === null ? {} : { status: o.status || 'idle' }) }))
    return { label, id: `claude-code:${sid}`, want }
  })
}

const CODEX = [
  ['Codex turn open 40 min, no completion (crash or hang)', ['task_started'], 40 * MIN, { notBucket: 'resting' }],
  ['Codex turn finished 1 h ago', ['task_started', 'task_complete'], 60 * MIN, { bucket: 'stalled' }],
  ['Codex turn finished 7 h ago', ['task_started', 'task_complete'], 7 * 60 * MIN, { bucket: 'resting' }],
  ['Codex error 10 min ago', ['task_started', 'error'], 10 * MIN, { bucket: 'stalled', reason: 'Hit an error' }],
]
function writeCodex(home) {
  const day = path.join(home, 'codex', 'sessions', '2026', '10', '21')
  fs.mkdirSync(day, { recursive: true })
  return CODEX.map(([label, events, ago, want], i) => {
    const id = `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`
    const file = path.join(day, `rollout-2026-10-21T00-00-00-${id}.jsonl`)
    fs.writeFileSync(file, [{ type: 'session_meta', timestamp: iso(ago + 2000), payload: { id, cwd: '/work/matrix-codex' } },
      { type: 'response_item', timestamp: iso(ago + 1000), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: label }] } },
      ...events.map((type) => ({ type: 'event_msg', timestamp: iso(ago), payload: { type } }))].map((r) => JSON.stringify(r)).join('\n') + '\n')
    fs.utimesSync(file, new Date(NOW - ago), new Date(NOW - ago))
    return { label, id: `codex:${id}`, want }
  })
}

let server, cases
test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name !== 'desktop') return
  try { process.kill(DEAD, 0); throw new Error(`pid ${DEAD} is alive; pick another DEAD pid`) } catch (e) { if (e.code !== 'ESRCH') throw e }
  NOW = Date.now()
  const home = tmpDir('matrix')
  cases = [...writeClaude(home), ...writeCodex(home)]
  server = await startServer({ AGENTVILLE_CLAUDE_HOME: path.join(home, 'claude'), AGENTVILLE_CODEX_HOME: path.join(home, 'codex'), AGENTVILLE_DATA_DIR: path.join(home, 'data') }, nextPort())
})
test.afterAll(async () => server?.stop())

for (const [label] of [...CLAUDE, ...CODEX]) {
  test(`classification: ${label}`, async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'API-level matrix runs once')
    const c = cases.find((x) => x.label === label)
    const { agents } = await (await request.get(`${server.url}/api/agents`)).json()
    const a = agents.find((x) => x.id === c.id)
    expect(a, 'agent is listed').toBeTruthy()
    const got = `${a.bucket} / ${a.reason || '-'}`
    if (c.want.bucket) expect(a.bucket, got).toBe(c.want.bucket)
    if (c.want.reason) expect(a.reason, got).toBe(c.want.reason)
    if (c.want.notBucket) expect(a.bucket, got).not.toBe(c.want.notBucket)
    if (c.want.notReason) expect(a.reason, got).not.toBe(c.want.notReason)
  })
}
