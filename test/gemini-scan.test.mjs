import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scan } from '../server/gemini/scan.mjs'
import { parseTranscript, readTranscript } from '../server/gemini/transcript.mjs'

const SID = '11111111-2222-3333-4444-555555555555'
const L = (o) => JSON.stringify(o)
const session = [
  { sessionId: SID, projectHash: 'abc', startTime: '2026-11-24T16:50:31.203Z', lastUpdated: '2026-11-24T16:50:31.203Z', kind: 'main' },
  { id: 'u0', timestamp: '2026-11-24T16:50:31.204Z', type: 'user', content: [{ text: '<session_context>\nWorkspace Directories: /w/app\n</session_context>' }] },
  { $set: { lastUpdated: '2026-11-24T16:50:32.000Z' } },
  { id: 'u1', timestamp: '2026-11-24T16:50:33.000Z', type: 'user', content: [{ text: 'fix the bug' }] },
  { id: 'g1', timestamp: '2026-11-24T16:50:34.000Z', type: 'gemini', content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { file_path: '/w/app/a.js' }, status: 'scheduled' }] },
  { id: 'g1', timestamp: '2026-11-24T16:50:34.000Z', type: 'gemini', content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { file_path: '/w/app/a.js' }, status: 'success' }] },
  { id: 'u2', timestamp: '2026-11-24T16:50:35.000Z', type: 'user', content: [{ text: 'bad turn' }] },
  { $rewindTo: 'u2' },
  { id: 'g2', timestamp: '2026-11-24T16:50:36.000Z', type: 'gemini', content: 'Fixed.' },
  { $patch: { updates: [{ id: 'g2', content: 'Fixed it.' }] } },
].map(L).join('\n') + '\n{"partial'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gscan-'))
  const home = path.join(root, 'home')
  const chats = path.join(home, '.gemini', 'tmp', 'app', 'chats')
  fs.mkdirSync(path.join(chats, SID), { recursive: true }) // subagent dir is ignored
  fs.writeFileSync(path.join(home, '.gemini', 'tmp', 'app', '.project_root'), '/w/app\n')
  fs.writeFileSync(path.join(home, '.gemini', 'projects.json'), L({ projects: { '/w/app': 'app' } }))
  const file = path.join(chats, 'session-2026-11-24T16-50-11111111.jsonl')
  fs.writeFileSync(file, session)
  return { root, home, file }
}

test('transcript replay: upsert, $rewindTo, $patch, synthetic skip', async () => {
  const { messages } = parseTranscript(session)
  assert.deepEqual(messages.map((m) => m.id), ['u0', 'u1', 'g1', 'g2'])
  assert.equal(messages[3].content, 'Fixed it.')
  const { file } = setup()
  const ev = await readTranscript({ transcriptFile: file }, { maxBytes: 1e6 })
  assert.deepEqual(ev.map((e) => e.role), ['user', 'tool', 'assistant'])
  assert.equal(ev[0].text, 'fix the bug')
  assert.deepEqual(ev[1].tool, { name: 'read_file', files: ['/w/app/a.js'], done: true })
})

test('scan: facts, cwd from .project_root, injected runs, liveness from runner', async () => {
  const { home } = setup()
  const prev = process.env.GEMINI_CLI_HOME
  process.env.GEMINI_CLI_HOME = home
  try {
    const now = Date.now()
    const run = { runId: 'r1', pid: process.pid, cwd: '/w/app', sessionId: SID, name: 'bug', startedAt: now, state: 'running', parentAgentId: 'claude:x' }
    const facts = await scan(now, { runs: async () => [run, { runId: 'r2', pid: 1, state: 'running', cwd: '/w/other', startedAt: now, name: 'new' }] })
    const f = facts.find((x) => x.id === `gemini:${SID}`)
    assert.equal(f.harness, 'gemini-cli')
    assert.equal(f.provider, 'gemini')
    assert.equal(f.cwd, '/w/app')
    assert.equal(f.project, 'app')
    assert.equal(f.title, 'fix the bug')
    assert.equal(f.live, true)
    assert.equal(f.lifecycle, 'running')
    assert.equal(f.parentId, 'claude:x')
    assert.ok(facts.find((x) => x.id === 'gemini:r2')) // run with no session yet
    const idle = await scan(now, { runs: async () => [] })
    assert.equal(idle.find((x) => x.id === `gemini:${SID}`).live, false)
    assert.equal(idle[0].lifecycle, 'idle')
  } finally { if (prev === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = prev }
})

test('scan: extra account homes', async () => {
  const a = setup()
  const b = setup()
  process.env.GEMINI_CLI_HOME = a.home
  try {
    const facts = await scan(Date.now(), { runs: async () => [], homes: [b.home] })
    assert.equal(facts.length, 2)
  } finally { delete process.env.GEMINI_CLI_HOME }
})
