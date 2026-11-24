/**
 * Plain terminals over HTTP: the guard (Origin, JSON, kind and folder allowlist), that the command
 * is never the request's, that a plain terminal is not an agent, that it runs in the built-in PTY
 * and ends with DELETE, and that an interactive Claude session in the CLI's registry is a normal,
 * visible agent. The "shell" and "claude" are test/fixtures/bin's fakes; HOME is a temp dir.
 */
import baseTest from 'node:test'
import { posixTest, shortTmp } from './support/posix.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { createServer } from '../server/serve.mjs'
const test = posixTest(baseTest, 'fixtures/bin fake CLIs and the fake terminal are node-shebang scripts that Windows cannot exec; Windows PTY coverage is in plain-term-win.test.mjs')

const FAKES = fileURLToPath(new URL('./fixtures/bin', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-plainapi-'))
const home = path.join(root, 'home')
const claudeHome = path.join(root, 'claude-home')
const events = path.join(root, 'events.log')
fs.mkdirSync(home); fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true })
const sid = 'dddddddd-0000-4000-8000-000000000001'
const ts = new Date().toISOString()
const projDir = path.join(claudeHome, 'projects', '-home')
fs.mkdirSync(projDir, { recursive: true })
fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), [
  { type: 'user', sessionId: sid, cwd: home, uuid: 'u1', timestamp: ts, message: { content: 'hi' } },
  { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
].map((r) => JSON.stringify(r)).join('\n') + '\n')
// The CLI's registry says this test process is the interactive session.
fs.writeFileSync(path.join(claudeHome, 'sessions', 'a.json'), JSON.stringify({ pid: process.pid, sessionId: sid, status: 'idle', kind: 'interactive', cwd: home, startedAt: Date.now() }))

const saved = { ...process.env }
Object.assign(process.env, {
  AGENTVILLE_TEST: '1', AGENTVILLE_FAKE_BIN: FAKES, HOME: home, SHELL: path.join(FAKES, 'claude'),
  PATH: `${FAKES}:${path.dirname(process.execPath)}:/usr/bin:/bin`, AGENTVILLE_FAKE_CLAUDE_LOG: events,
  AGENTVILLE_CLAUDE_HOME: claudeHome, AGENTVILLE_CODEX_HOME: path.join(root, 'codex-home'),
})
const server = createServer({ dataDir: path.join(root, 'data'), termIdleMs: 400, termEndWaitMs: 3000 })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
test.after(() => { server.close(); process.env = saved; fs.rmSync(root, { recursive: true, force: true }) })

const send = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) })
const plain = (body, headers) => send('/api/term-plain', body, headers)
const logs = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) }
}

test('the guard: foreign origin, no origin and non-JSON are refused', async () => {
  assert.equal((await plain({ kind: 'shell' }, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await fetch(`${base}/api/term-plain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kind":"shell"}' })).status, 403)
  assert.equal((await plain({ kind: 'shell' }, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await fetch(`${base}/api/term-plain`, { headers: { origin: base } })).status, 404, 'POST only')
})

test('only an enumerated kind and an allowed folder are accepted', async () => {
  for (const body of [{ kind: 'bash -c id' }, { kind: 'shell', cwd: '/etc' }, { kind: 'shell', cwd: path.join(home, '..') }, { kind: 'shell', cwd: 7 }, {}]) {
    const r = await plain(body)
    assert.ok([400].includes(r.status) || (r.status === 200 && !body.kind), JSON.stringify(body))
  }
  assert.equal((await plain({ kind: 'shell', cwd: '/etc' })).status, 400)
})

test('a plain shell runs the fixed login command in the PTY, is no agent, and ends with DELETE', async () => {
  // A request cannot name a command: extra fields are ignored.
  const r = await plain({ kind: 'shell', argv: ['/bin/sh', '-c', 'touch /tmp/va-pwned'], command: 'x' })
  assert.equal(r.status, 200)
  const made = await r.json()
  assert.match(made.id, /^shell:/)
  assert.equal(made.name, 'Terminal — ~')
  assert.equal(fs.existsSync('/tmp/va-pwned'), false)
  // Unregistered shell ids are refused like any unknown agent.
  assert.equal((await send(`/api/term/${encodeURIComponent('shell:nope')}`, {})).status, 404)

  const t = await send(`/api/term/${encodeURIComponent(made.id)}`, { cols: 80, rows: 24 })
  assert.equal(t.status, 200)
  const out = await t.json()
  assert.equal(out.name, 'Terminal — ~')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/term/ws?ticket=${encodeURIComponent(out.ticket)}`, { headers: { origin: base } })
  let text = ''
  ws.on('message', (d, bin) => { if (bin) text += d.toString('utf8') })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  await until(() => text.includes('fake claude -l'))
  assert.ok(text.includes(`cwd ${fs.realpathSync(home)}`) || text.includes(`cwd ${home}`), 'starts in home')
  assert.deepEqual(logs().find((e) => e.event === 'start').argv, ['-l'])

  const snap = await (await fetch(`${base}/api/agents`)).json()
  assert.ok(!snap.agents.some((a) => String(a.id).startsWith('shell:')), 'not an agent')
  assert.deepEqual(snap.term.plain.map((p) => [p.id, p.title, p.agentId]), [[made.id, 'Terminal — ~', null]])

  const del = await fetch(`${base}/api/term/${encodeURIComponent(made.id)}`, { method: 'DELETE', headers: { origin: base } })
  assert.deepEqual(await del.json(), { stopped: true })
  assert.deepEqual((await (await fetch(`${base}/api/agents`)).json()).term.plain, [])
  assert.equal((await send(`/api/term/${encodeURIComponent(made.id)}`, {})).status, 404, 'forgotten once closed')
  ws.close()
})

test('"+ Claude" starts the bare claude on PATH with no flags and no prompt', async () => {
  const before = logs().length
  const made = await (await plain({ kind: 'claude', prompt: 'do it', model: 'opus' })).json()
  assert.equal(made.name, 'Claude — ~')
  const out = await (await send(`/api/term/${encodeURIComponent(made.id)}`, { cols: 80, rows: 24 })).json()
  assert.ok(out.ticket)
  const start = await until(() => logs().slice(before).find((e) => e.event === 'start'))
  assert.deepEqual(start.argv, [])
  await fetch(`${base}/api/term/${encodeURIComponent(made.id)}`, { method: 'DELETE', headers: { origin: base } })
})

test('an interactive Claude session from the CLI registry is a visible agent (nothing hides it)', async () => {
  const snap = await (await fetch(`${base}/api/agents`)).json()
  const a = snap.agents.find((x) => x.id === `claude-code:${sid}`)
  assert.ok(a, 'scanned')
  assert.notEqual(a.hidden, true)
  assert.equal(a.live, true)
})
