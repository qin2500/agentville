import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scan, agentColor } from '../server/claude-code.mjs'
import { build } from '../server/classify.mjs'

const uuid = (n) => `${String(n).padStart(8, 'c')}-0000-4000-8000-000000000000`
const IDS = { session: uuid(1), jobOwn: uuid(2), jobTranscript: uuid(3), plain: uuid(4) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-color-'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const project = path.join(root, 'projects', '-work-demo')
fs.mkdirSync(project, { recursive: true })
const at = new Date(Date.now() - 60_000).toISOString()
const transcript = (sid, ...extra) => fs.writeFileSync(path.join(project, `${sid}.jsonl`), [
  { type: 'user', sessionId: sid, cwd: '/work/demo', uuid: `u-${sid}`, timestamp: at, message: { role: 'user', content: 'hello' } },
  { type: 'assistant', sessionId: sid, cwd: '/work/demo', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } },
  ...extra,
].map((r) => JSON.stringify(r)).join('\n') + '\n')
const job = (sid, extra) => {
  const dir = path.join(root, 'jobs', sid.slice(0, 8))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ sessionId: sid, name: 'demo', state: 'done', cwd: '/work/demo', createdAt: at, updatedAt: at, ...extra }))
}

// Interactive session: the last `agent-color` record wins.
transcript(IDS.session, { type: 'agent-color', agentColor: 'red', sessionId: IDS.session }, { type: 'agent-color', agentColor: 'purple', sessionId: IDS.session })
// Job with its own color: state.json wins over the transcript.
job(IDS.jobOwn, { color: 'cyan' })
transcript(IDS.jobOwn, { type: 'agent-color', agentColor: 'green', sessionId: IDS.jobOwn })
// Job without one: falls back to the transcript.
job(IDS.jobTranscript, {})
transcript(IDS.jobTranscript, { type: 'agent-color', agentColor: 'orange', sessionId: IDS.jobTranscript })
// No color anywhere.
transcript(IDS.plain)

test('agent color: job state.json, else the last transcript record, else null', async () => {
  process.env.AGENTVILLE_CLAUDE_HOME = root
  const agents = build(await scan(), {})
  const color = (sid) => agents.find((a) => a.id === `claude-code:${sid}`)?.color
  assert.equal(color(IDS.session), 'purple')
  assert.equal(color(IDS.jobOwn), 'cyan')
  assert.equal(color(IDS.jobTranscript), 'orange')
  assert.equal(color(IDS.plain), null)
})

test('agent color: only the /color names count', () => {
  assert.equal(agentColor('Blue'), 'blue')
  for (const v of ['default', '#ff0000', '', null, 42]) assert.equal(agentColor(v), null)
})
