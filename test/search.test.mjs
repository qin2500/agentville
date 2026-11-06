// Conversation search over names and titles (never prompt text), PR links from transcripts, PR
// status from Claude Code's cache, and changed-file chips: all on a synthetic home.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeHome, IDS } from './fixtures/make-home.mjs'
import { prFacts } from '../server/prstatus.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'va-search-'))
const env = makeHome(root)
Object.assign(process.env, env)
const project = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app')
const cwd = path.join(root, 'work', 'demo-app')
const day = 86_400_000
// A resting session (3 days old) whose names only appear deep in the file, after its prompt.
const oldSid = 'eeeeeeee-0000-4000-8000-000000000001'
const ts = new Date(Date.now() - 3 * day).toISOString()
const oldFile = path.join(project, `${oldSid}.jsonl`)
fs.writeFileSync(oldFile, [
  { type: 'user', sessionId: oldSid, cwd, uuid: 'o1', timestamp: ts, message: { role: 'user', content: 'Prompt text about the zebra migration' } },
  { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Assistant text mentioning quokka' }] } },
  { type: 'custom-title', customTitle: 'Billing export rewrite', sessionId: oldSid },
  { type: 'agent-name', agentName: 'invoice-bot', sessionId: oldSid },
  { type: 'pr-link', sessionId: oldSid, prNumber: 77, prUrl: 'https://github.com/example/demo-app/pull/77', prRepository: 'example/demo-app', timestamp: ts },
  // A tool result quoting a title record is not a title.
  { type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '{"type":"custom-title","customTitle":"Fake title"}' }] } },
].map((r) => JSON.stringify(r)).join('\n') + '\n')
fs.utimesSync(oldFile, new Date(Date.now() - 3 * day), new Date(Date.now() - 3 * day))
// A live session that linked a PR.
fs.appendFileSync(path.join(project, `${IDS.soloTurn}.jsonl`), JSON.stringify({ type: 'pr-link', sessionId: IDS.soloTurn, prNumber: 101, prUrl: 'https://github.com/example/demo-app/pull/101', prRepository: 'example/demo-app', timestamp: new Date().toISOString() }) + '\n')
// The fixture folder as a git checkout with an uncommitted edit.
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', '-C', cwd, ...args], { stdio: 'pipe' })
fs.writeFileSync(path.join(cwd, 'app.js'), 'a\nb\n')
git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base')
fs.writeFileSync(path.join(cwd, 'app.js'), 'a\nb\nc\nd\n')

const { createServer } = await import('../server/serve.mjs')
const server = createServer({ dataDir: path.join(root, 'data') })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }) })
const get = async (p) => (await fetch(`${base}${p}`)).json()

test('search finds names and titles, resting sessions included, and points at the agent', async () => {
  const r = await get('/api/search?q=invoice')
  assert.equal(r.results.length, 1)
  assert.deepEqual({ ...r.results[0], at: 0 }, { id: `claude-code:${oldSid}`, name: 'invoice-bot', matched: 'invoice-bot', project: 'demo-app', at: 0 })
  assert.equal((await get('/api/search?q=billing export')).results[0].id, `claude-code:${oldSid}`)
  assert.equal((await get('/api/search?q=big boss')).results[0].id, `claude-code:${IDS.boss}`, 'job names count too')
})

test('search never matches prompt text, assistant text or quoted records', async () => {
  for (const q of ['zebra', 'quokka', 'fake title', 'explain the build']) assert.deepEqual((await get(`/api/search?q=${encodeURIComponent(q)}`)).results, [], q)
  assert.deepEqual((await get('/api/search?q=a')).results, [], 'one letter is not a search')
})

test('PR links from transcripts join the agent PRs; PR status comes from the cache only', async () => {
  const { agents } = await get('/api/agents')
  const solo = agents.find((a) => a.id === `claude-code:${IDS.soloTurn}`)
  assert.deepEqual(solo.prs, [{ id: '101', href: 'https://github.com/example/demo-app/pull/101', state: 'open', checks: { passed: 7, failed: 1, pending: 2 }, review: 'required' }])
  const old = agents.find((a) => a.id === `claude-code:${oldSid}`)
  assert.deepEqual(old.prs, [{ id: '77', href: 'https://github.com/example/demo-app/pull/77' }], 'not in the cache: no status')
  const done = agents.find((a) => a.id === `claude-code:${IDS.leadDone}`)
  assert.equal(done.prs[0].state, 'merged')
  assert.doesNotMatch(JSON.stringify(agents), /additions|"title":""/)
})

test('PR cache entries: fixed fields only, unknown states dropped', () => {
  assert.deepEqual(prFacts({ state: 'OPEN', checks: { passed: 2, failed: -1, pending: 'x' }, review: 'CHANGES_REQUESTED', title: 'secret' }), { state: 'open', checks: { passed: 2, failed: 0, pending: 0 }, review: 'changes' })
  assert.equal(prFacts({ state: 'WEIRD' }), null)
  assert.equal(prFacts(null), null)
})

test('changes: non-resting agents in a git folder get a summary; resting ones never', async () => {
  let agents
  for (let i = 0; i < 40; i++) { // the first poll queues the git read; a later one has it
    agents = (await get('/api/agents')).agents
    if (agents.some((a) => a.changes)) break
    await new Promise((r) => setTimeout(r, 2100))
  }
  const solo = agents.find((a) => a.id === `claude-code:${IDS.soloTurn}`)
  assert.deepEqual(solo.changes, { added: 2, removed: 0, files: 1 })
  assert.equal(agents.find((a) => a.id === `claude-code:${oldSid}`).changes, null)
  assert.equal(agents.find((a) => a.id === `claude-code:${IDS.leadBuilding}:sub:worker`).changes, null, 'a subagent in its lead\'s folder leaves it to the lead')
  const d = await get(`/api/agents/${encodeURIComponent(`claude-code:${IDS.soloTurn}`)}/changes`)
  assert.deepEqual(d.changes.files, [{ path: 'app.js', add: 2, del: 0, binary: false }])
})
