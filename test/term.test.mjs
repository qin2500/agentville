/**
 * The built-in terminal: command selection (openCommand's rules), tickets, the WebSocket guard,
 * one PTY per agent with scrollback replay, pop-out ordering, idle end, and no content in logs.
 * Every CLI here is test/fixtures/bin's fake (it prints a prompt and echoes lines); every terminal
 * window is the fake recorder. No real claude or codex is ever run.
 */
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { createServer } from '../server/serve.mjs'
import { createTerminals, ptyEnv } from '../server/pty.mjs'

const FAKES = fileURLToPath(new URL('./fixtures/bin', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-term-'))
const events = path.join(root, 'events.log') // fake claude and fake terminal both append here
const ws = path.join(root, 'work')
fs.mkdirSync(ws)
const failing = path.join(root, 'failbin')
fs.mkdirSync(failing)
// A missing interpreter fails at spawn time, so the refusal never depends on timing.
fs.writeFileSync(path.join(failing, 'kitty'), '#!/nonexistent/interpreter\n')
fs.chmodSync(path.join(failing, 'kitty'), 0o755)

// A tiny home: a bg job, two closed sessions, a live session, a sub and a Codex thread.
const ids = {
  job: 'aaaaaaa1-0000-4000-8000-000000000000', closed: 'aaaaaaa2-0000-4000-8000-000000000000',
  live: 'aaaaaaa3-0000-4000-8000-000000000000', closed2: 'aaaaaaa4-0000-4000-8000-000000000000',
  idle: 'aaaaaaa5-0000-4000-8000-000000000000', codex: 'bbbbbbb1-0000-4000-8000-000000000000',
}
const claudeHome = path.join(root, 'claude-home')
const project = path.join(claudeHome, 'projects', '-work')
const ts = new Date().toISOString()
fs.mkdirSync(project, { recursive: true })
for (const sid of [ids.job, ids.closed, ids.live, ids.closed2, ids.idle]) {
  fs.writeFileSync(path.join(project, `${sid}.jsonl`), [
    { type: 'user', sessionId: sid, cwd: ws, uuid: `${sid}-u`, timestamp: ts, message: { content: 'hi' } },
    { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
}
fs.mkdirSync(path.join(claudeHome, 'jobs', 'aaaaaaa1'), { recursive: true })
fs.writeFileSync(path.join(claudeHome, 'jobs', 'aaaaaaa1', 'state.json'), JSON.stringify({ sessionId: ids.job, resumeSessionId: ids.job, cwd: ws, state: 'working', tempo: 'idle', createdAt: ts, updatedAt: ts }))
fs.mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true })
fs.writeFileSync(path.join(claudeHome, 'sessions', 'live.json'), JSON.stringify({ pid: 1, sessionId: ids.live, status: 'idle' }))
const subs = path.join(project, ids.job, 'subagents')
fs.mkdirSync(subs, { recursive: true })
fs.writeFileSync(path.join(subs, 'agent-s1.jsonl'), JSON.stringify({ type: 'user', timestamp: ts, message: { content: 'x' } }) + '\n')
const codexHome = path.join(root, 'codex-home')
const day = path.join(codexHome, 'sessions', '2026', '10', '22')
fs.mkdirSync(day, { recursive: true })
fs.writeFileSync(path.join(day, `rollout-x-${ids.codex}.jsonl`), [
  { type: 'session_meta', timestamp: ts, payload: { id: ids.codex, cwd: ws } },
  { type: 'event_msg', timestamp: ts, payload: { type: 'task_started' } },
].map((r) => JSON.stringify(r)).join('\n') + '\n')

const savedEnv = { ...process.env }
Object.assign(process.env, {
  AGENTVILLE_TEST: '1', AGENTVILLE_FAKE_BIN: FAKES,
  PATH: `${FAKES}:${path.dirname(process.execPath)}:/usr/bin:/bin`, AGENTVILLE_TERMINAL: path.join(FAKES, 'kitty'),
  AGENTVILLE_FAKE_TERMINAL_LOG: events, AGENTVILLE_FAKE_CLAUDE_LOG: events,
  AGENTVILLE_CLAUDE_HOME: claudeHome, AGENTVILLE_CODEX_HOME: codexHome,
})

// Everything the server prints, to prove no terminal content is ever logged.
const printed = []
for (const k of ['log', 'error', 'warn', 'info', 'debug']) {
  const orig = console[k]
  console[k] = (...a) => { printed.push(a.map(String).join(' ')); return orig.apply(console, a) }
}

const dataDir = path.join(root, 'data')
const server = createServer({ dataDir, termIdleMs: 400, termEndWaitMs: 3000 })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
test.after(() => { server.close(); process.env = savedEnv; fs.rmSync(root, { recursive: true, force: true }) })

const cc = (sid) => `claude-code:${sid}`
const post = (p, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: '{}' })
const term = (id) => post(`/api/term/${encodeURIComponent(id)}`)
const log = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const starts = (id8) => log().filter((e) => e.event === 'start' && e.argv.some((a) => a.startsWith(id8)))
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) }
}

/** A WebSocket client that collects output text and control messages. */
function connect(ticket, { origin = base, host, at = port } = {}) {
  const headers = { ...(origin !== null && { origin }), ...(host && { host }) }
  const sock = new WebSocket(`ws://127.0.0.1:${at}/api/term/ws?ticket=${encodeURIComponent(ticket)}`, { headers })
  const c = { sock, out: '', msgs: [], status: null, closed: false, code: null }
  sock.on('message', (d, bin) => { if (bin) c.out += d.toString('utf8'); else c.msgs.push(JSON.parse(d.toString('utf8'))) })
  sock.on('unexpected-response', (_req, res) => { c.status = res.statusCode; sock.terminate() })
  sock.on('error', () => {})
  sock.on('close', (code) => { c.closed = true; c.code = code })
  c.opened = new Promise((resolve) => { sock.on('open', () => resolve(true)); sock.on('close', () => resolve(false)) })
  c.type = (text) => sock.send(JSON.stringify({ type: 'input', data: text }))
  c.see = (s) => until(() => c.out.includes(s))
  return c
}

test('command selection reuses openCommand: refusals spawn nothing', async () => {
  const expect = async (id, status, error) => {
    const r = await term(id)
    assert.deepEqual([r.status, (await r.json()).error], [status, error], id)
  }
  await expect(cc(ids.live), 409, 'Already running in another terminal')
  await expect(`${cc(ids.job)}:sub:s1`, 409, 'Open its lead instead')
  await expect('claude-code:nope', 404, 'No such agent')
  assert.equal(log().filter((e) => e.event === 'start').length, 0)
  // Cross-origin and non-JSON are refused like every other action.
  assert.equal((await post(`/api/term/${encodeURIComponent(cc(ids.job))}`, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await post(`/api/term/${encodeURIComponent(cc(ids.job))}`, { 'content-type': 'text/plain' })).status, 415)
})

test('a bg job runs `claude attach <short>`; I/O and resize reach the PTY', async () => {
  const r = await term(cc(ids.job))
  const body = await r.json()
  assert.equal(r.status, 200)
  assert.equal(body.existing, false)
  assert.equal(body.kind, 'attach')
  const c = connect(body.ticket)
  assert.equal(await c.opened, true)
  await c.see('fake-claude>')
  assert.deepEqual(c.msgs[0], { type: 'attached', name: c.msgs[0].name, kind: 'attach', replay: c.msgs[0].replay, cols: 100, rows: 30 })
  assert.deepEqual(starts('aaaaaaa1').map((e) => e.argv), [['attach', 'aaaaaaa1']])
  c.type('hello there\r')
  await c.see('echo: hello there')
  c.sock.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
  await new Promise((r) => setTimeout(r, 100))
  c.type('size\r')
  await c.see('size 120x40')
  const agents = await (await fetch(`${base}/api/agents`)).json()
  assert.deepEqual(agents.term, { available: true, running: [cc(ids.job)] })
  // While it is embedded, "Open in Ghostty" refuses: one process per conversation.
  const open = await post(`/api/open/${encodeURIComponent(cc(ids.job))}`)
  assert.deepEqual([open.status, (await open.json()).error], [409, 'Running in the built-in terminal; use Pop out'])
  c.sock.close()
})

test('one PTY per agent: re-opening re-attaches and replays the scrollback', async () => {
  const r = await term(cc(ids.job))
  const body = await r.json()
  assert.equal(body.existing, true)
  const c = connect(body.ticket)
  await c.see('echo: hello there') // from before this socket existed
  assert.equal(starts('aaaaaaa1').length, 1, 'never a second process')
  c.sock.close()
})

test('tickets are single use; the WebSocket demands our exact Origin and Host', async () => {
  const { ticket } = await (await term(cc(ids.job))).json()
  for (const [opts, why] of [[{ origin: 'http://evil.example' }, 'foreign origin'], [{ origin: null }, 'no origin'],
    [{ origin: `http://localhost:${port + 1}` }, 'other port'], [{ origin: 'null' }, 'null origin'], [{ host: 'evil.example' }, 'foreign host']]) {
    const c = connect(ticket, opts)
    assert.equal(await c.opened, false, why)
    await until(() => c.status)
    assert.equal(c.status, 403, why)
  }
  // The refusals didn't burn it; the first good use does.
  const ok = connect(ticket)
  assert.equal(await ok.opened, true)
  const again = connect(ticket)
  assert.equal(await again.opened, false)
  await until(() => again.status)
  assert.equal(again.status, 401)
  const bogus = connect('not-a-ticket')
  await until(() => bogus.status)
  assert.equal(bogus.status, 401)
  ok.sock.close()
})

test('tickets expire after 30 s', async () => {
  const terms = createTerminals({ idleMs: 60_000 })
  try {
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const a = terms.open('x', { argv: [path.join(FAKES, 'claude'), 'attach', 'feedfeed'], cwd: ws, kind: 'attach', name: 'X' })
    const b = terms.open('x', { argv: [], cwd: ws, kind: 'attach', name: 'X' })
    assert.equal(b.existing, true)
    mock.timers.tick(29_000)
    assert.equal(terms.redeem(a.ticket), 'x')
    assert.equal(terms.redeem(a.ticket), null, 'single use')
    mock.timers.tick(1_001)
    assert.equal(terms.redeem(b.ticket), null, 'expired')
  } finally {
    mock.timers.reset()
    terms.closeAll()
  }
})

test('under test, only a CLI from AGENTVILLE_FAKE_BIN may ever be spawned', () => {
  const terms = createTerminals()
  const saved = process.env.AGENTVILLE_FAKE_BIN
  try {
    assert.throws(() => terms.open('y', { argv: ['/bin/sh', '-c', 'true'], cwd: ws, kind: 'resume', name: 'Y' }), { status: 501 })
    delete process.env.AGENTVILLE_FAKE_BIN
    assert.throws(() => terms.open('y', { argv: [path.join(FAKES, 'claude'), '--resume', 'x'], cwd: ws, kind: 'resume', name: 'Y' }), { status: 501 })
    assert.deepEqual(terms.info().running, [])
  } finally { process.env.AGENTVILLE_FAKE_BIN = saved; terms.closeAll() }
})

test('pop out (bg job): the attach client is hung up before Ghostty opens `claude attach`', async () => {
  const before = log().length
  const r = await post(`/api/term/${encodeURIComponent(cc(ids.job))}/popout`)
  assert.deepEqual([r.status, await r.json()], [200, { ok: true, terminal: 'kitty', closed: true }])
  const after = log().slice(before)
  const exit = after.findIndex((e) => e.event === 'exit' && e.argv.includes('aaaaaaa1'))
  const win = after.findIndex((e) => !e.event)
  assert.ok(exit >= 0 && win > exit, `exit before window: ${JSON.stringify(after)}`)
  assert.equal(after[exit].why, 'sighup')
  assert.deepEqual(after[win].argv, [`--directory=${ws}`, path.join(FAKES, 'claude'), 'attach', 'aaaaaaa1'])
  assert.deepEqual((await (await fetch(`${base}/api/agents`)).json()).term.running, [])
})

test('pop out (resumed session): Ctrl-C ends it, it exits, then Ghostty runs the same resume', async () => {
  const { ticket } = await (await term(cc(ids.closed))).json()
  const c = connect(ticket)
  await c.see('fake-claude>')
  assert.deepEqual(starts('aaaaaaa2').map((e) => e.argv), [['--resume', ids.closed]])
  const before = log().length
  const r = await post(`/api/term/${encodeURIComponent(cc(ids.closed))}/popout`)
  assert.equal(r.status, 200)
  const after = log().slice(before)
  const exit = after.findIndex((e) => e.event === 'exit')
  const win = after.findIndex((e) => !e.event)
  assert.ok(exit >= 0 && win > exit, JSON.stringify(after))
  assert.equal(after[exit].why, 'ctrl-c')
  assert.deepEqual(after[win].argv, [`--directory=${ws}`, path.join(FAKES, 'claude'), '--resume', ids.closed])
  await until(() => c.closed)
  assert.ok(c.msgs.some((m) => m.type === 'ending' && m.why === 'popout'))
  assert.ok(c.msgs.some((m) => m.type === 'exit' && m.why === 'popout'))
})

test('pop out: no terminal keeps the embedded PTY; a failed window says the PTY is gone', async () => {
  const { ticket } = await (await term(cc(ids.closed2))).json()
  const c = connect(ticket)
  await c.see('fake-claude>')
  const saved = process.env.AGENTVILLE_TERMINAL
  try {
    process.env.AGENTVILLE_TERMINAL = path.join(root, 'missing-terminal')
    let r = await post(`/api/term/${encodeURIComponent(cc(ids.closed2))}/popout`)
    assert.deepEqual([r.status, (await r.json()).error], [501, 'No supported terminal'])
    assert.equal(c.closed, false, 'still attached')
    process.env.AGENTVILLE_TERMINAL = path.join(failing, 'kitty')
    r = await post(`/api/term/${encodeURIComponent(cc(ids.closed2))}/popout`)
    const body = await r.json()
    assert.equal(r.status, 502)
    assert.equal(body.closed, true)
    assert.match(body.error, /^Could not open a terminal .*The built-in terminal was already closed/)
  } finally { process.env.AGENTVILLE_TERMINAL = saved }
})

test('the process exiting ends the PTY and reports its code', async () => {
  const { ticket } = await (await term(`codex:${ids.codex}`)).json()
  const c = connect(ticket)
  await c.see('fake-codex>')
  assert.deepEqual(log().filter((e) => e.event === 'start' && e.cli === 'codex').map((e) => e.argv), [['resume', ids.codex]])
  c.type('exit\r')
  await until(() => c.msgs.find((m) => m.type === 'exit'))
  assert.equal(c.msgs.find((m) => m.type === 'exit').code, 7)
  await until(() => c.closed)
})

test('DELETE stops it; with no socket attached it ends on its own after the idle timeout', async () => {
  let { ticket } = await (await term(cc(ids.idle))).json()
  let c = connect(ticket)
  await c.see('fake-claude>')
  let r = await fetch(`${base}/api/term/${encodeURIComponent(cc(ids.idle))}`, { method: 'DELETE', headers: { origin: base } })
  assert.deepEqual([r.status, await r.json()], [200, { stopped: true }])
  await until(() => c.closed)
  r = await fetch(`${base}/api/term/${encodeURIComponent(cc(ids.idle))}`, { method: 'DELETE', headers: { origin: base } })
  assert.deepEqual(await r.json(), { stopped: false })
  ;({ ticket } = await (await term(cc(ids.idle))).json())
  c = connect(ticket)
  await c.see('fake-claude>')
  c.sock.close()
  await until(async () => !(await (await fetch(`${base}/api/agents`)).json()).term.running.length, 4000) // termIdleMs: 400
  assert.equal(log().filter((e) => e.event === 'exit' && e.argv.includes(ids.idle)).length, 2)
})

test('server shutdown hangs up every PTY', async () => {
  const s2 = createServer({ dataDir: path.join(root, 'data2') })
  await new Promise((r) => s2.listen(0, '127.0.0.1', r))
  const b2 = `http://127.0.0.1:${s2.address().port}`
  const r = await fetch(`${b2}/api/term/${encodeURIComponent(cc(ids.job))}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b2 }, body: '{}' })
  assert.equal(r.status, 200)
  // Wait for the fake's prompt (its signal handlers are set by then), not just its start.
  const session = s2.terms.get(cc(ids.job))
  await until(async () => (await session.screen.snapshot()).includes('fake-claude>'))
  await new Promise((done) => s2.close(done))
  // Poll the PTY's own exit; the escalation window is ~2 s, so 8 s leaves a wide margin.
  const exit = await Promise.race([session.exited, new Promise((r) => setTimeout(() => r(null), 8000))])
  assert.ok(exit, 'the PTY exited')
  assert.deepEqual(s2.terms.info().running, [])
})

/** Its own server (the main one's rate limit is shared): `open(id, body)` POSTs /api/term/:id. */
async function ownServer(opts = {}, listenPort = 0) {
  const s = createServer({ dataDir: path.join(root, `data-${crypto.randomUUID()}`), ...opts })
  await new Promise((r) => s.listen(listenPort, '127.0.0.1', r))
  const at = s.address().port, b = `http://127.0.0.1:${at}`
  const open = (id, body = {}) => fetch(`${b}/api/term/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b }, body: JSON.stringify(body) })
  const stop = (id) => fetch(`${b}/api/term/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { origin: b } })
  return { s, at, b, open, stop, conn: (ticket) => connect(ticket, { origin: b, at }), close: () => new Promise((r) => s.close(r)) }
}

test('a reconnect (reattach: boot) re-attaches a live PTY but never restarts one that ended meanwhile', async () => {
  const srv = await ownServer({ termIdleMs: 300, termEndWaitMs: 3000 })
  const id = cc(ids.closed2), id8 = 'aaaaaaa4'
  const n0 = starts(id8).length
  try {
    let r = await srv.open(id)
    const first = await r.json()
    assert.equal(r.status, 200)
    assert.match(first.boot, /^[\w-]{8,}$/)
    let c = srv.conn(first.ticket)
    await c.see('fake-claude>')
    c.type('before the drop\r')
    await c.see('echo: before the drop')
    // The app answers a ping (a page checks a socket that might have died in sleep).
    c.sock.send(JSON.stringify({ type: 'ping' }))
    await until(() => c.msgs.some((m) => m.type === 'pong'))
    c.sock.terminate() // the socket dies; the process does not
    r = await srv.open(id, { reattach: first.boot })
    const again = await r.json()
    assert.deepEqual([r.status, again.existing, again.boot], [200, true, first.boot])
    c = srv.conn(again.ticket)
    await c.see('echo: before the drop') // replayed
    c.type('after\r')
    await c.see('echo: after')
    assert.equal(starts(id8).length, n0 + 1, 'the same process, never a second')

    // It exits while the page is away: a reconnect is refused, and nothing starts.
    c.type('exit\r')
    await until(() => c.closed)
    r = await srv.open(id, { reattach: first.boot })
    assert.deepEqual([r.status, await r.json()], [410, { error: 'The terminal session has ended', ended: true, why: 'exit' }])
    assert.equal(starts(id8).length, n0 + 1)
    // "Start again" (no reattach) does start it.
    r = await srv.open(id)
    assert.equal(r.status, 200)
    c = srv.conn((await r.json()).ticket)
    await c.see('fake-claude>')
    await until(() => starts(id8).length === n0 + 2)
    c.sock.close()
    // Ended idle (300 ms with no socket): still ended for a reconnect.
    await until(() => !srv.s.terms.get(id), 4000)
    r = await srv.open(id, { reattach: first.boot })
    assert.deepEqual([r.status, (await r.json()).why], [410, 'idle'])
    // Stopped: the same.
    r = await srv.open(id)
    c = srv.conn((await r.json()).ticket)
    await c.see('fake-claude>')
    await srv.stop(id)
    r = await srv.open(id, { reattach: first.boot })
    assert.deepEqual([r.status, (await r.json()).why], [410, 'stop'])
    assert.equal(starts(id8).length, n0 + 3)
    // A boot this server never issued (it restarted): the old PTY is gone with it, so it starts one.
    r = await srv.open(id, { reattach: 'an-older-boot' })
    assert.equal(r.status, 200)
    await srv.conn((await r.json()).ticket).see('fake-claude>')
    await until(() => starts(id8).length === n0 + 4)
  } finally { await srv.stop(id); await srv.close() }
})

test('shutdown tells each page the server is restarting (1012); after the restart old tickets are dead and a reconnect starts one PTY', async () => {
  const id = cc(ids.closed2), id8 = 'aaaaaaa4'
  let srv = await ownServer()
  const { ticket, boot } = await (await srv.open(id)).json()
  const c = srv.conn(ticket)
  await c.see('fake-claude>')
  const spare = (await (await srv.open(id)).json()).ticket // issued, never used
  const session = srv.s.terms.get(id)
  const at = srv.at
  await srv.close()
  await until(() => c.closed)
  assert.deepEqual(c.msgs.filter((m) => m.type === 'ending'), [{ type: 'ending', why: 'server-restart' }])
  assert.equal(c.code, 1012)
  assert.ok(await Promise.race([session.exited, new Promise((r) => setTimeout(() => r(null), 8000))]), 'the PTY went with the server')
  // The "restarted" server on the same port.
  const n0 = starts(id8).length
  srv = await ownServer({}, at)
  try {
    const stale = srv.conn(spare)
    assert.equal(await stale.opened, false)
    assert.equal(stale.status, 401)
    const [a, b] = await Promise.all([srv.open(id, { reattach: boot }), srv.open(id, { reattach: boot })]) // two pages at once
    assert.deepEqual([a.status, b.status], [200, 200])
    const fresh = await a.json()
    assert.notEqual(fresh.boot, boot)
    const c2 = srv.conn(fresh.ticket)
    await c2.see('fake-claude>')
    c2.type('back\r')
    await c2.see('echo: back')
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(starts(id8).length, n0 + 1, 'one process, not one per reconnect')
  } finally { await srv.stop(id); await srv.close() }
})

test('terminal content never reaches a log or the data folder', async () => {
  const SECRET = 'sk-ant-term-secret-0123456789'
  const { ticket } = await (await term(cc(ids.closed))).json()
  const c = connect(ticket)
  await c.see('fake-claude>')
  c.type(`${SECRET}\r`)
  await c.see(`echo: ${SECRET}`)
  c.sock.close()
  await new Promise((r) => setTimeout(r, 100))
  const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir, { recursive: true }).map((f) => path.join(dataDir, f)).filter((f) => fs.statSync(f).isFile()) : []
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), f)
  assert.ok(!printed.some((l) => l.includes(SECRET) || l.includes('echo:') || l.includes('fake-claude>')), printed.join('\n'))
  await fetch(`${base}/api/term/${encodeURIComponent(cc(ids.closed))}`, { method: 'DELETE', headers: { origin: base } })
})

test('rate limit: at most 30 terminal requests a minute', async () => {
  let last
  for (let i = 0; i < 31; i++) last = await term(cc(ids.live)) // refusals count too
  assert.equal(last.status, 429)
})

test('the PTY env drops nesting markers from the server\'s own terminal or agent', () => {
  const env = ptyEnv({ PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', TERM_PROGRAM: 'ghostty', GHOSTTY_RESOURCES_DIR: '/x', TMUX: 't', TERM: 'dumb', ANTHROPIC_BASE_URL: 'keep' })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', ANTHROPIC_BASE_URL: 'keep', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
})

test('shutdown escalates: a process that ignores the hang-up and SIGTERM is killed, never left behind', async () => {
  const dir = path.join(root, 'stubborn')
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, "#!/bin/sh\ntrap '' HUP TERM INT\necho ready\nwhile :; do sleep 0.1; done\n")
  fs.chmodSync(bin, 0o755)
  const saved = process.env.AGENTVILLE_FAKE_BIN
  const terms = createTerminals()
  try {
    process.env.AGENTVILLE_FAKE_BIN = dir
    terms.open('z', { argv: [bin, 'attach', 'deadbeef'], cwd: ws, kind: 'attach', name: 'Z' })
    const s = terms.get('z')
    await until(async () => (await s.screen.snapshot()).includes('ready')) // its traps are set
    const t0 = Date.now()
    await terms.closeAll()
    assert.equal(s.exit?.signal, 9, 'SIGKILL in the end')
    assert.ok(Date.now() - t0 < 3000)
    assert.deepEqual(terms.info().running, [])
  } finally { process.env.AGENTVILLE_FAKE_BIN = saved }
})

// ---------- sizes, repaints and the attach snapshot ----------
const winches = (id8, since) => log().filter((e) => e.event === 'winch' && e.argv.some((a) => a.startsWith(id8)) && e.at >= since)

test('a new PTY starts at the size the page asks for; sizes below 20×5 never reach it', async () => {
  const srv = await ownServer({ termEndWaitMs: 3000 })
  const id = cc(ids.closed), id8 = 'aaaaaaa2'
  try {
    const r = await srv.open(id, { cols: 132, rows: 41 })
    const c = srv.conn((await r.json()).ticket)
    await c.see('fake-claude>')
    assert.deepEqual([c.msgs[0].cols, c.msgs[0].rows], [132, 41])
    const t0 = Date.now()
    for (const [cols, rows] of [[2, 45], [19, 40], [80, 4], [0, 0], [-5, 10], ['x', 'y'], [501, 40], [80, 301]]) c.sock.send(JSON.stringify({ type: 'resize', cols, rows }))
    await new Promise((res) => setTimeout(res, 150))
    c.type('size\r')
    await c.see('size 132x41')
    assert.deepEqual(winches(id8, t0), [], 'no SIGWINCH at all')
    // A refused start size falls back to the default rather than a 2-column PTY.
    await srv.stop(id)
    const r2 = await srv.open(id, { cols: 2, rows: 45 })
    const c2 = srv.conn((await r2.json()).ticket)
    await c2.see('fake-claude>')
    assert.deepEqual([c2.msgs[0].cols, c2.msgs[0].rows], [100, 30])
  } finally { await srv.stop(id); await srv.close() }
})

test('repaint at an unchanged size nudges the PTY a column and back (two SIGWINCHes); a new size is one', async () => {
  const srv = await ownServer({ termEndWaitMs: 3000 })
  const id = cc(ids.closed), id8 = 'aaaaaaa2'
  try {
    const c = srv.conn((await (await srv.open(id, { cols: 90, rows: 30 })).json()).ticket)
    await c.see('fake-claude>')
    let t0 = Date.now()
    c.sock.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 })) // unchanged, no repaint: nothing
    await new Promise((res) => setTimeout(res, 150))
    assert.deepEqual(winches(id8, t0), [])
    c.sock.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30, repaint: true }))
    await until(() => winches(id8, t0).length >= 2)
    assert.deepEqual(winches(id8, t0).map((w) => `${w.cols}x${w.rows}`), ['89x30', '90x30'])
    t0 = Date.now()
    c.sock.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40, repaint: true })) // a real change is its own repaint
    await until(() => winches(id8, t0).length >= 1)
    await new Promise((res) => setTimeout(res, 150))
    assert.deepEqual(winches(id8, t0).map((w) => `${w.cols}x${w.rows}`), ['120x40'])
    // At the minimum width the nudge goes wider, never below it.
    t0 = Date.now()
    c.sock.send(JSON.stringify({ type: 'resize', cols: 20, rows: 40 }))
    await until(() => winches(id8, t0).length >= 1)
    c.sock.send(JSON.stringify({ type: 'resize', cols: 20, rows: 40, repaint: true }))
    await until(() => winches(id8, t0).length >= 3)
    assert.deepEqual(winches(id8, t0).map((w) => `${w.cols}x${w.rows}`), ['20x40', '21x40', '20x40'])
  } finally { await srv.stop(id); await srv.close() }
})

test('attaching mid-stream gets a snapshot: the alternate screen and the mouse modes survive any amount of output', async () => {
  const srv = await ownServer({ termEndWaitMs: 3000 })
  const id = cc(ids.closed), id8 = 'aaaaaaa2'
  try {
    const c = srv.conn((await (await srv.open(id, { cols: 80, rows: 24 })).json()).ticket)
    await c.see('fake-claude>')
    c.type('fullscreen\r')
    await c.see('FULLSCREEN 80x24')
    c.type('noise 400\r') // far more than the 200 KB a raw replay kept: the mode sets are long gone from it
    await until(() => (c.out.match(/frame (\d+)/g) || []).length >= 3)
    await new Promise((res) => setTimeout(res, 300))
    const c2 = srv.conn((await (await srv.open(id)).json()).ticket)
    await until(() => c2.msgs[0]?.type === 'attached' && c2.out.includes('FULLSCREEN'))
    assert.ok(c2.out.includes('\x1b[?1049h'), 'in the alternate screen')
    assert.ok(c2.out.includes('\x1b[?1000h'), 'mouse tracking')
    assert.ok(c2.out.includes('\x1b[?1006h'), 'SGR mouse encoding')
    assert.ok(c2.msgs[0].replay < 64 * 1024, `a screen, not the stream (${c2.msgs[0].replay} bytes)`)
    // Live output after the snapshot comes once, in order.
    c2.type('after snap\r')
    await c2.see('echo: after snap')
    assert.equal(c2.out.split('echo: after snap').length, 2)
  } finally { await srv.stop(id); await srv.close() }
})
