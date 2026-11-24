import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scan } from '../server/gemini/scan.mjs'
import { readTranscript, toEvents } from '../server/gemini/transcript.mjs'

const L = (o) => JSON.stringify(o)
const STREAM = [
  { event: 'init', conversation_id: 'c1', init: { cwd: '/w/app' } },
  { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'DONE', step_type: 'user_input', text_delta: 'fix the bug' } },
  { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/w/app/a.js' } } } },
  { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/w/app/a.js' }, output: 'x' } } },
  { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Fixed' } },
  { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: ' it.' } },
  { event: 'whatever' },
  { event: 'result', result: { status: 'SUCCESS', response: 'Fixed it.' } },
].map(L).join('\n') + '\n{"partial'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyscan-'))
  const dataDir = path.join(root, 'data'), home = path.join(root, 'home')
  const runDir = path.join(dataDir, 'gemini-runs', 'r1')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'out.log'), STREAM)
  const agy = path.join(home, '.gemini', 'antigravity-cli')
  fs.mkdirSync(path.join(agy, 'cache'), { recursive: true })
  fs.writeFileSync(path.join(agy, 'cache', 'last_conversations.json'), L({ '/w/app': 'c1', '/w/hand': 'h1', '/w/gone': 'g1', relative: 'x1' }))
  const logs = path.join(agy, 'brain', 'h1', '.system_generated', 'logs')
  fs.mkdirSync(logs, { recursive: true })
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), [{ step_index: 0, source: 'USER', type: 'USER_INPUT', content: 'hand prompt' }, { step_index: 1, type: 'PLANNER_RESPONSE', content: 'ok' }].map(L).join('\n'))
  return { dataDir, home, runDir }
}

test('transcript: stream-json out.log -> user, tool (deduped, done), assistant', async () => {
  const { runDir } = setup()
  const ev = await readTranscript({ transcriptFile: path.join(runDir, 'out.log') })
  assert.deepEqual(ev.map((e) => e.role), ['user', 'tool', 'assistant'])
  assert.equal(ev[0].text, 'fix the bug'); assert.equal(ev[2].text, 'Fixed it.')
  assert.deepEqual(ev[1].tool, { name: 'view_file', files: ['/w/app/a.js'], done: true })
  assert.deepEqual(toEvents([{ odd: 1 }, null, 5]), [])
  assert.deepEqual(await readTranscript({ transcriptFile: '/no/such/file' }), [])
})

test('scan: runs are facts with out.log; hand-run sessions from last_conversations + brain; missing ones dropped', async () => {
  const { dataDir, home } = setup()
  const now = Date.now()
  const run = { runId: 'r1', pid: process.pid, cwd: '/w/app', conversationId: 'c1', sessionId: 'c1', name: 'bug', title: 'fix the bug', startedAt: now, state: 'running', parentAgentId: 'claude:x' }
  const facts = await scan(now, { dataDir, home, runs: async () => [run, { runId: 'r2', pid: 1, state: 'error', error: 'boom', cwd: '/w/other', startedAt: now }] })
  const f = facts.find((x) => x.id === 'gemini:r1')
  assert.equal(f.provider, 'gemini'); assert.equal(f.harness, 'gemini-cli'); assert.equal(f.cwd, '/w/app'); assert.equal(f.project, 'app')
  assert.equal(f.live, true); assert.equal(f.lifecycle, 'running'); assert.equal(f.parentId, 'claude:x')
  assert.equal(f.transcriptFile, path.join(dataDir, 'gemini-runs', 'r1', 'out.log')); assert.equal(f.resume, 'agy --conversation c1')
  assert.equal(facts.titles['gemini:r1'], 'fix the bug')
  const r2 = facts.find((x) => x.id === 'gemini:r2')
  assert.equal(r2.lifecycle, 'failed'); assert.match(r2.errorReason, /boom/)
  // c1 belongs to r1 (not listed twice); h1 is a hand session; g1 has no transcript; 'relative' is not a path.
  const hand = facts.find((x) => x.id === 'gemini:h1')
  assert.equal(hand.cwd, '/w/hand'); assert.equal(hand.title, 'hand prompt'); assert.equal(hand.live, false)
  assert.deepEqual(facts.map((x) => x.id).sort(), ['gemini:h1', 'gemini:r1', 'gemini:r2'])
})

test('scan: no agy folder at all is fine', async () => {
  const facts = await scan(Date.now(), { home: '/definitely/not/here', runs: async () => [] })
  assert.deepEqual([...facts], [])
})
