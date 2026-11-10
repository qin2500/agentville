/**
 * "Open in terminal": which command each agent gets, refusals, guard and rate limit, and argv
 * delivery. Every terminal here is a fake that records its argv; nothing real is ever opened and
 * no real session is resumed. Partly adapted from Bot Crossing test/terminal.test.mjs (MIT).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../server/serve.mjs'
import { ghosttyMacLaunch, terminalAppLaunch, runAppleScript } from '../server/terminal.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-open-'))
const bin = path.join(root, 'bin')
const log = path.join(root, 'terminal.log')
const ws = path.join(root, "work space it's $(touch nope) ; | x")
const claude = path.join(root, 'claude')
const codex = path.join(root, 'codex')
fs.mkdirSync(bin)
fs.mkdirSync(ws)
const script = (file, body) => { fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`); fs.chmodSync(file, 0o755) }
// The fake terminal records its argv and cwd as one JSON line, then exits 0 like a D-Bus terminal.
script(path.join(bin, 'kitty'), `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n')`)
for (const name of ['claude', 'codex']) script(path.join(bin, name), 'process.exit(3) // never run by the fake terminal')

// A tiny home: a bg job, a closed session, a live session, a sub, a Codex thread and a spawned child.
const ids = { job: 'aaaaaaa1-0000-4000-8000-000000000000', closed: 'aaaaaaa2-0000-4000-8000-000000000000', live: 'aaaaaaa3-0000-4000-8000-000000000000', codex: 'bbbbbbb1-0000-4000-8000-000000000000' }
const claudeHome = path.join(root, 'claude-home')
const project = path.join(claudeHome, 'projects', '-ws')
const ts = new Date().toISOString()
const transcript = (sid) => {
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, `${sid}.jsonl`), [
    { type: 'user', sessionId: sid, cwd: ws, uuid: `${sid}-u`, timestamp: ts, message: { content: 'hi' } },
    { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
}
for (const sid of [ids.job, ids.closed, ids.live]) transcript(sid)
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
  PATH: `${bin}:/usr/bin:/bin`, AGENTVILLE_TERMINAL: path.join(bin, 'kitty'),
  AGENTVILLE_CLAUDE_HOME: claudeHome, AGENTVILLE_CODEX_HOME: codexHome,
})
const server = createServer({ dataDir: path.join(root, 'data') })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); process.env = savedEnv; fs.rmSync(root, { recursive: true, force: true }) })

const open = (id, headers = {}) => fetch(`${base}/api/open/${encodeURIComponent(id)}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: '{}' })
const opened = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []

test('agents payload names the terminal Open would use', async () => {
  assert.deepEqual((await (await fetch(`${base}/api/agents`)).json()).open, { terminal: 'kitty' })
})

test('the server picks the command per agent kind; the argv reaches the terminal intact', async () => {
  let r = await open(`claude-code:${ids.job}`)
  assert.deepEqual([r.status, await r.json()], [200, { ok: true, terminal: 'kitty' }])
  r = await open(`claude-code:${ids.closed}`)
  assert.equal(r.status, 200)
  const [job, closed] = opened()
  assert.deepEqual(job.argv, [`--directory=${ws}`, path.join(bin, 'claude'), 'attach', 'aaaaaaa1'])
  assert.deepEqual(closed.argv, [`--directory=${ws}`, path.join(bin, 'claude'), '--resume', ids.closed])
  assert.equal(fs.realpathSync(closed.cwd), fs.realpathSync(ws))
  assert.ok(!fs.existsSync(path.join(ws, 'nope')))
})

test('refusals: live session, subagent, unknown, missing Codex CLI', async () => {
  const before = opened().length
  const expect = async (id, status, error) => {
    const r = await open(id)
    assert.deepEqual([r.status, (await r.json()).error], [status, error], id)
  }
  await expect(`claude-code:${ids.live}`, 409, 'Already running in another terminal')
  await expect(`claude-code:${ids.job}:sub:s1`, 409, 'Open its lead instead')
  await expect('claude-code:nope', 404, 'No such agent')
  // Only provable where no real codex sits in the standard locations.
  const realCodex = [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].some((d) => fs.existsSync(path.join(d, 'codex')))
  fs.renameSync(path.join(bin, 'codex'), codex)
  try { if (!realCodex) await expect(`codex:${ids.codex}`, 409, 'Codex CLI not found') } finally { fs.renameSync(codex, path.join(bin, 'codex')) }
  assert.equal(opened().length, before, 'no terminal was started for a refusal')
  const r = await open(`codex:${ids.codex}`)
  assert.equal(r.status, 200)
  assert.deepEqual(opened().at(-1).argv, [`--directory=${ws}`, path.join(bin, 'codex'), 'resume', ids.codex])
})

test('guard: cross-origin and non-JSON are refused; the body cannot choose the command', async () => {
  assert.equal((await open(`claude-code:${ids.closed}`, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await open(`claude-code:${ids.closed}`, { 'content-type': 'text/plain' })).status, 415)
  const before = opened().length
  const r = await fetch(`${base}/api/open/${encodeURIComponent(`claude-code:${ids.closed}`)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ argv: ['/bin/rm', '-rf', '/'], cwd: '/' }) })
  assert.equal(r.status, 200)
  assert.deepEqual(opened().slice(before)[0].argv.slice(1), [path.join(bin, 'claude'), '--resume', ids.closed])
})

test('opens are rate limited to 10 a minute', async () => {
  let last
  for (let i = 0; i < 10; i++) last = await open(`claude-code:${ids.job}`)
  assert.equal(last.status, 429)
})

test('no supported terminal: 501 and the capability is null', async () => {
  process.env.AGENTVILLE_TERMINAL = path.join(root, 'missing-terminal')
  try {
    await new Promise((r) => setTimeout(r, 2100)) // scan cache
    assert.equal((await (await fetch(`${base}/api/agents`)).json()).open.terminal, null)
    const r = await open(`claude-code:${ids.job}`)
    assert.deepEqual([r.status, (await r.json()).error], [501, 'No supported terminal'])
  } finally { process.env.AGENTVILLE_TERMINAL = path.join(bin, 'kitty') }
})

// Adversarial arguments through the exact shells that will run them.
const values = ["single'quote", 'double"quote', '$(touch nope)', '; touch nope', '--flag', 'line\nbreak', '`touch nope`', '$HOME', '雪']
const echoArgv = [process.execPath, '-e', 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd()}))', '--', ...values]

test('Ghostty (macOS) command text survives its bash `exec -l` wrapper; no shell: prefix, no extra exec', { skip: process.platform === 'win32' }, () => {
  const launch = ghosttyMacLaunch('/Applications/Ghostty.app/Contents/MacOS/ghostty', ws, echoArgv)
  assert.equal(launch.executable, '/usr/bin/osascript')
  assert.deepEqual(launch.args.slice(1, 3), ['/Applications/Ghostty.app', ws])
  assert.match(launch.args[0], /ghostty-window\.applescript$/)
  // Ghostty 1.3.1 runs native API commands as: /bin/bash --noprofile --norc -c 'exec -l <command>'.
  const wrap = (command) => execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', `exec -l ${command}`], { cwd: ws, encoding: 'utf8', stdio: 'pipe' })
  assert.deepEqual(JSON.parse(wrap(launch.args[3])), { argv: values, cwd: fs.realpathSync(ws) })
  assert.throws(() => wrap(`shell:exec ${launch.args[3]}`))
  assert.ok(!fs.existsSync(path.join(ws, 'nope')))
  assert.equal(ghosttyMacLaunch('/usr/local/bin/ghostty', ws, echoArgv), null)
  const source = fs.readFileSync(launch.args[0], 'utf8')
  assert.doesNotMatch(source, /shell:|exec /, 'no dynamic value or prefix in the script source')
})

test('Terminal.app command line survives sh, bash and zsh, cwd included', { skip: process.platform === 'win32' }, () => {
  const launch = terminalAppLaunch(ws, echoArgv)
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter((s) => fs.existsSync(s))) {
    const out = execFileSync(shell, ['-c', launch.args[1]], { cwd: os.tmpdir(), encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    assert.deepEqual(JSON.parse(out), { argv: values, cwd: fs.realpathSync(ws) }, shell)
  }
  assert.ok(!fs.existsSync(path.join(ws, 'nope')))
})

test('AppleScript runner needs explicit success; denial, failure, timeout and missing binary report without leaking argv', async () => {
  const run = (code, timeout) => runAppleScript({ executable: process.execPath, args: ['-e', code], app: 'Ghostty' }, os.tmpdir(), timeout)
  assert.deepEqual(await run('console.log("agentville-window-created")'), { ok: true })
  assert.equal((await run('')).ok, false)
  assert.match((await run('console.error("Not authorized to send Apple events to Ghostty. (-1743)");process.exit(1)')).error, /Automation/)
  assert.match((await run('console.error("script error");process.exit(1)')).error, /script error.*No fallback/)
  assert.match((await run('setTimeout(()=>{},10000)', 50)).error, /before trying again/)
  const missing = await runAppleScript({ executable: '/nonexistent/agentville-test', args: ['private-session-id'] }, os.tmpdir())
  assert.equal(missing.ok, false)
  assert.ok(!missing.error.includes('private-session-id'))
})

test('under AGENTVILLE_TEST or NODE_ENV=test, no terminal is auto-detected: Open is 501', async () => {
  const { detectTerminal } = await import('../server/terminal.mjs')
  const saved = { t: process.env.AGENTVILLE_TERMINAL, v: process.env.AGENTVILLE_TEST, n: process.env.NODE_ENV }
  try {
    delete process.env.AGENTVILLE_TERMINAL
    for (const [k, v] of [['AGENTVILLE_TEST', '1'], ['NODE_ENV', 'test']]) {
      delete process.env.AGENTVILLE_TEST
      delete process.env.NODE_ENV
      process.env[k] = v
      assert.equal(await detectTerminal(), null, k)
    }
    await new Promise((r) => setTimeout(r, 2100)) // scan cache
    const r = await open(`claude-code:${ids.closed}`)
    assert.deepEqual([r.status, (await r.json()).error], [501, 'No supported terminal'])
  } finally {
    process.env.AGENTVILLE_TERMINAL = saved.t
    if (saved.v === undefined) delete process.env.AGENTVILLE_TEST; else process.env.AGENTVILLE_TEST = saved.v
    if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n
  }
})

test('a launch that failed before it started is refused: there is no session to attach to', async () => {
  const { openCommand, NEVER_STARTED } = await import('../server/serve.mjs')
  await assert.rejects(openCommand({ id: 'claude-code:f0000001-0000-4000-8000-000000000000', harness: 'claude-code', kind: 'job', jobId: 'f0000001', cwd: os.tmpdir(), neverStarted: true }),
    (e) => e.status === 409 && e.message === NEVER_STARTED)
})

test('a job reopened in a terminal is opened like the live interactive session it is: never attached', async () => {
  const { openCommand } = await import('../server/serve.mjs')
  const job = { id: `claude-code:${ids.job}`, harness: 'claude-code', kind: 'job', jobId: 'aaaaaaa1', cwd: os.tmpdir() }
  await assert.rejects(openCommand({ ...job, live: true, reopened: ids.job }), (e) => e.status === 409 && e.message === 'Already running in another terminal')
  assert.equal((await openCommand({ ...job, live: true, reopened: null })).argv[1], 'attach')
})
