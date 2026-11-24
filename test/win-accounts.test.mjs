/**
 * Accounts, switching, start/stop and restore on Windows, simulated on any host: process.platform
 * is set to 'win32' around each check, and the CLI runner, fetch and rename are injected fakes.
 * Nothing here touches the real ~/.claude, ~/.claude.json, ~/.config, the Keychain or the network:
 * every path is in a temp folder.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { accountsBlocked, createAccounts, writeAtomic } from '../server/accounts.mjs'
import { createAccount, run as accountRun, switchingBlocked } from '../server/account.mjs'
import { actionsBlocked, CMD_UNSAFE, display, run as actionsRun, startPlan, stopPlan } from '../server/actions.mjs'
import { createRestore, restoreBlocked } from '../server/restore.mjs'
import { sendingBlocked } from '../server/inbox.mjs'
import { renameRetry, RENAME_BACKOFF_MS } from '../server/fsutil.mjs'

process.env.AGENTVILLE_TEST = '1'

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
/** Run `fn` (sync or async) with process.platform reporting `platform`. */
async function as(platform, fn) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })
  try { return await fn() } finally { Object.defineProperty(process, 'platform', realPlatform) }
}
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `village-win-${name}-`))
const busy = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })
const CMD = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'

/** A fake execFile: records each call and answers with `answer(call)` -> { err, stdout, stderr }. */
function fakeExec(answer = () => ({})) {
  const calls = []
  const exec = (file, args, opts, cb) => {
    const call = { file, args, opts }
    calls.push(call)
    const { err = null, stdout = '', stderr = '' } = answer(call) || {}
    setImmediate(() => cb(err, stdout, stderr))
    return {}
  }
  exec.calls = calls
  return exec
}

// ---------- rename retry ----------

test('renameRetry: EPERM / EBUSY / EACCES are retried with a short backoff, then the rename goes through', async () => {
  const waits = []
  let n = 0
  const rename = async () => { n++; if (n <= 3) throw busy(['EPERM', 'EBUSY', 'EACCES'][n - 1]) }
  await renameRetry('a', 'b', { rename, wait: async (ms) => { waits.push(ms) } })
  assert.equal(n, 4)
  assert.deepEqual(waits, RENAME_BACKOFF_MS.slice(0, 3))
  assert.equal(RENAME_BACKOFF_MS.length + 1, 10, '10 attempts')
  const total = RENAME_BACKOFF_MS.reduce((a, b) => a + b, 0)
  assert.ok(total >= 800 && total <= 1500, `about 1 s in all (${total} ms)`)
})

test('renameRetry: other errors are thrown at once, without retrying', async () => {
  let n = 0
  await assert.rejects(renameRetry('a', 'b', { rename: async () => { n++; throw busy('ENOENT') }, wait: async () => {} }), { code: 'ENOENT' })
  assert.equal(n, 1)
})

test('writeAtomic: a target held open (EPERM twice) is still written, and no temp file is left', async () => {
  const dir = tmp('atomic')
  try {
    const file = path.join(dir, '.credentials.json')
    fs.writeFileSync(file, 'old')
    let n = 0
    const rename = async (a, b) => { if (++n <= 2) throw busy('EPERM'); return fsp.rename(a, b) }
    await writeAtomic(file, 'new', 0o600, { rename })
    assert.equal(n, 3)
    assert.equal(fs.readFileSync(file, 'utf8'), 'new')
    assert.deepEqual(fs.readdirSync(dir), ['.credentials.json'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('writeAtomic: a target that stays locked keeps its original content; the error is thrown and the temp file removed', async () => {
  const dir = tmp('atomic-fail')
  try {
    const file = path.join(dir, '.credentials.json')
    fs.writeFileSync(file, 'original')
    let n = 0
    const rename = async () => { n++; throw busy('EBUSY') }
    const t0 = Date.now()
    await assert.rejects(writeAtomic(file, 'new', 0o600, { rename }), { code: 'EBUSY' })
    assert.equal(n, 10, 'every attempt was made')
    assert.ok(Date.now() - t0 >= 800, 'over about a second')
    assert.equal(fs.readFileSync(file, 'utf8'), 'original')
    assert.deepEqual(fs.readdirSync(dir), ['.credentials.json'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---------- gates ----------

const GATES = { AGENTVILLE_CLAUDE_HOME: path.join(os.tmpdir(), 'village-win-fake-home'), AGENTVILLE_CLAUDE_BIN: CMD, AGENTVILLE_FLEET_SOCKET_ROOT: path.join(os.tmpdir(), 'village-win-socks') }

test('win32: accounts, switching, start/stop and restore are allowed; Fleet send stays off', async () => {
  await withEnv({ ...GATES, AGENTVILLE_WINDOWS_ACTIONS: undefined }, () => as('win32', () => {
    assert.deepEqual([accountsBlocked(), switchingBlocked(), actionsBlocked(), restoreBlocked()], ['', '', '', ''])
    assert.equal(sendingBlocked(), 'Sending to agents is not supported on Windows')
  }))
  await withEnv({ ...GATES, AGENTVILLE_WINDOWS_ACTIONS: 'on' }, () => as('win32', () => {
    assert.deepEqual([accountsBlocked(), switchingBlocked(), actionsBlocked(), restoreBlocked()], ['', '', '', ''])
  }))
})

test('win32 with AGENTVILLE_WINDOWS_ACTIONS=off: the old gates are back', async () => {
  for (const off of ['off', 'OFF', '0', 'false']) {
    await withEnv({ ...GATES, AGENTVILLE_WINDOWS_ACTIONS: off }, () => as('win32', () => {
      assert.equal(accountsBlocked(), 'Accounts are not supported on Windows')
      assert.equal(switchingBlocked(), 'Account switching is not supported on Windows')
      assert.equal(actionsBlocked(), 'Starting and stopping agents is not supported on Windows')
      assert.equal(restoreBlocked(), 'Restoring agents is not supported on Windows')
      assert.equal(sendingBlocked(), 'Sending to agents is not supported on Windows')
    }))
  }
})

test('the opt-out does nothing off Windows', async () => {
  for (const platform of ['darwin', 'linux']) {
    await withEnv({ ...GATES, AGENTVILLE_WINDOWS_ACTIONS: 'off' }, () => as(platform, () => {
      assert.deepEqual([accountsBlocked(), switchingBlocked(), actionsBlocked(), restoreBlocked(), sendingBlocked()], ['', '', '', '', ''])
    }))
  }
})

// ---------- the CLI through execTarget ----------

const project = { dir: os.tmpdir(), name: 'tmp' }

test('start: a claude.cmd runs through cmd.exe /d /s /c, hidden, with verbatim arguments', async () => {
  const exec = fakeExec(() => ({ stdout: 'backgrounded · 1a2b3c4d\n' }))
  const plan = startPlan({ cwd: project.dir, prompt: 'fix the bug & ship | it <now>', model: 'opus' }, [project])
  const out = await withEnv({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, () => as('win32', () => actionsRun(plan, { exec, bin: async () => CMD })))
  assert.deepEqual(out, { ok: true, jobId: '1a2b3c4d' })
  assert.equal(exec.calls.length, 1)
  const { file, args, opts } = exec.calls[0]
  assert.equal(file, 'C:\\Windows\\system32\\cmd.exe')
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c'])
  assert.ok(args[3].startsWith(`""${CMD}" "--bg"`), args[3])
  assert.ok(args[3].includes('"fix the bug & ship | it <now>"'), 'cmd metacharacters stay inside quotes')
  assert.equal(opts.windowsVerbatimArguments, true)
  assert.equal(opts.windowsHide, true)
  assert.equal(opts.cwd, project.dir)
})

test('start: a prompt cmd.exe cannot carry (a line break, a %VAR% pair) is refused before anything runs', async () => {
  for (const prompt of ['line one\nline two', 'echo %PATH% please']) {
    const exec = fakeExec()
    const plan = startPlan({ cwd: project.dir, prompt }, [project])
    const out = await as('win32', () => actionsRun(plan, { exec, bin: async () => CMD }))
    assert.deepEqual(out, { ok: false, error: CMD_UNSAFE })
    assert.equal(exec.calls.length, 0)
  }
  // A native claude.exe needs no cmd.exe: the same prompt goes straight through as one argv element.
  const exec = fakeExec()
  const plan = startPlan({ cwd: project.dir, prompt: 'line one\nline two 100%' }, [project])
  const out = await as('win32', () => actionsRun(plan, { exec, bin: async () => 'C:\\Users\\me\\.local\\bin\\claude.exe' }))
  assert.equal(out.ok, true)
  assert.equal(exec.calls[0].file, 'C:\\Users\\me\\.local\\bin\\claude.exe')
  assert.equal(exec.calls[0].args.at(-1), 'line one\nline two 100%')
  assert.equal(exec.calls[0].opts.windowsHide, true)
})

test('stop: a failing `claude stop` (or a spawn that throws) is reported, never thrown', async () => {
  const job = { harness: 'claude-code', kind: 'job', jobId: 'abcdef01', bucket: 'working', live: true, id: 'x', name: 'x' }
  const failing = fakeExec(() => ({ err: Object.assign(new Error('exit'), { code: 3 }) }))
  assert.deepEqual(await as('win32', () => actionsRun(stopPlan(job), { exec: failing, bin: async () => CMD })), { ok: false, error: 'Claude Code exited with code 3' })
  assert.deepEqual(failing.calls[0].args.slice(0, 3), ['/d', '/s', '/c'])
  const throwing = () => { throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }) }
  assert.deepEqual(await as('win32', () => actionsRun(stopPlan(job), { exec: throwing, bin: async () => CMD })), { ok: false, error: 'Claude Code exited with code 1' })
  assert.deepEqual(await as('win32', () => actionsRun(stopPlan(job), { exec: failing, bin: async () => null })), { ok: false, error: 'Claude Code CLI not found' })
})

test('display: the shown command quotes for PowerShell on Windows and for sh elsewhere', async () => {
  const plan = startPlan({ cwd: project.dir, prompt: "it's done" }, [project])
  assert.equal(await as('win32', () => display(plan)), "claude --bg -- 'it''s done'")
  assert.equal(await as('darwin', () => display(plan)), `claude --bg -- 'it'"'"'s done'`)
})

test('account run (respawn, auth status): a claude.cmd goes through cmd.exe; a failure is a non-zero code', async () => {
  const exec = fakeExec(() => ({ err: Object.assign(new Error('x'), { code: 2 }), stderr: 'job not found' }))
  const r = await as('win32', () => accountRun(CMD, ['respawn', 'abcdef01'], 5_000, exec))
  assert.deepEqual([r.code, r.timedOut, r.stderr], [2, false, 'job not found'])
  assert.deepEqual(exec.calls[0].args.slice(0, 3), ['/d', '/s', '/c'])
  assert.ok(exec.calls[0].args[3].endsWith('"respawn" "abcdef01""'))
  assert.equal(exec.calls[0].opts.windowsHide, true)
  const ok = fakeExec(() => ({ stdout: '{"loggedIn":true}' }))
  assert.equal((await as('win32', () => accountRun(CMD, ['auth', 'status', '--json'], 5_000, ok))).code, 0)
})

test('restore: respawn runs through cmd.exe; a failed respawn on Windows is a reported result', async () => {
  const root = tmp('restore')
  try {
    const home = path.join(root, 'claude')
    fs.mkdirSync(path.join(home, 'jobs', 'abcdef01'), { recursive: true })
    fs.writeFileSync(path.join(home, 'jobs', 'abcdef01', 'state.json'), JSON.stringify({ sessionId: 'aaaaaaaa-1111-4111-8111-111111111111', state: 'working' }))
    const plan = { short: 'abcdef01', id: 'j1', name: 'j', respawn: { args: ['respawn', 'abcdef01'], cwd: root }, resume: { unavailable: 'Its folder no longer exists' } }
    const failing = fakeExec(() => ({ err: Object.assign(new Error('x'), { code: 1 }) }))
    const restore = createRestore({ dataDir: path.join(root, 'data'), claudeHome: () => home, execFile: failing, bin: async () => CMD })
    const out = await withEnv(GATES, () => as('win32', () => restore.run([plan])))
    assert.deepEqual(out.results, [{ id: 'j1', short: 'abcdef01', status: 'failed', detail: 'Respawn failed (exit 1); its folder no longer exists' }])
    assert.equal(failing.calls.length, 1)
    assert.deepEqual(failing.calls[0].args.slice(0, 3), ['/d', '/s', '/c'])
    assert.equal(failing.calls[0].opts.windowsHide, true)

    const throwing = () => { throw new Error('spawn failed') }
    const restore2 = createRestore({ dataDir: path.join(root, 'data2'), claudeHome: () => home, execFile: throwing, bin: async () => CMD })
    const out2 = await withEnv(GATES, () => as('win32', () => restore2.run([plan])))
    assert.equal(out2.results[0].status, 'failed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ---------- an account switch through fileStore, end to end ----------

const UUID = { A: 'aaaaaaaa-1111-4111-8111-111111111111', B: 'bbbbbbbb-2222-4222-8222-222222222222' }
const MARK = 'tok-SECRET-'
const oauth = (key, n) => ({ accessToken: `${MARK}at-${key}-${n}`, refreshToken: `${MARK}rt-${key}-${n}`, expiresAt: Date.now() + 3600e3, scopes: ['user:inference'], subscriptionType: 'max' })
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body })
/** A fake Anthropic: the profile by bearer token (`…at-A-…` is account A). */
const fakeFetch = async (url, opts) => {
  const key = /at-([AB])-/.exec(/^Bearer (.+)$/.exec(opts?.headers?.authorization || '')?.[1] || '')?.[1]
  if (!key) return reply(401, {})
  if (String(url).endsWith('/api/oauth/profile')) return reply(200, { account: { uuid: UUID[key], email: `${key.toLowerCase()}@example.com` } })
  if (String(url).endsWith('/api/oauth/usage')) return reply(200, { five_hour: { utilization: 1, resets_at: null }, seven_day: { utilization: 1, resets_at: null } })
  return reply(404, {})
}

test('win32: switching accounts writes <claude home>/.credentials.json (EPERM retried), keeps MCP logins, updates .claude.json', async () => {
  const root = tmp('switch')
  const home = path.join(root, 'claude-home')
  const dataDir = path.join(root, 'data')
  const MCP = { 'slack|abc': { accessToken: `${MARK}mcp-slack`, expiresAt: 9e12 } }
  fs.mkdirSync(path.join(dataDir, 'accounts'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const credFile = path.join(home, '.credentials.json')
  fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: oauth('A', 1), mcpOAuth: MCP }))
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: UUID.A } }, null, 2) + '\n')
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2) + '\n')
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify([
    { id: UUID.A, label: 'A', email: '', addedAt: 1, oauthAccount: { accountUuid: UUID.A } },
    { id: UUID.B, label: 'B', email: '', addedAt: 1, oauthAccount: { accountUuid: UUID.B } },
  ]))
  fs.writeFileSync(path.join(dataDir, 'accounts', `${UUID.A}.json`), JSON.stringify({ claudeAiOauth: oauth('A', 1) }))
  fs.writeFileSync(path.join(dataDir, 'accounts', `${UUID.B}.json`), JSON.stringify({ claudeAiOauth: oauth('B', 1) }))

  // Claude Code "has the file open" for the first two renames onto .credentials.json.
  const realRename = fsp.rename
  let held = 2
  let credRenames = 0
  test.mock.method(fsp, 'rename', async (from, to) => {
    if (to === credFile) { credRenames++; if (held-- > 0) throw busy('EPERM') }
    return realRename(from, to)
  })
  const respawns = fakeExec()
  try {
    await withEnv({ AGENTVILLE_CLAUDE_HOME: home, AGENTVILLE_CLAUDE_BIN: CMD, AGENTVILLE_WINDOWS_ACTIONS: undefined }, () => as('win32', async () => {
      const accounts = createAccounts({ dataDir, claudeHome: () => home, exclusive: (fn) => fn(), poolState: async () => ({ active: false, available: false }), fetch: fakeFetch })
      const account = createAccount({
        dataDir, claudeHome: () => home, accounts,
        run: (bin, args, timeout) => accountRun(bin, args, timeout, respawns), bin: async () => CMD, // the real switchingBlocked gate
      })
      const out = await account.switchTo({ to: UUID.B }, [], { auto: true, why: { reason: 'test' } })
      assert.equal(out.restored, false, JSON.stringify(out))
      assert.equal(out.verified, true, 'the live login was read back and confirmed')
    }))
    const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'))
    assert.equal(cred.claudeAiOauth.accessToken, `${MARK}at-B-1`)
    assert.deepEqual(cred.mcpOAuth, MCP, 'MCP logins are kept')
    assert.equal(credRenames, 3, 'two busy renames, then the write went through')
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
    assert.deepEqual(config, { numStartups: 3, oauthAccount: { accountUuid: UUID.B } })
    assert.ok(!fs.existsSync(path.join(home, '.claude.json.lock')), 'the config lock is released')
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.includes('.tmp')), [], 'no temp file left behind')
    assert.equal(respawns.calls.length, 0, 'account -> account restarts nothing')
  } finally {
    test.mock.restoreAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('win32: when .credentials.json stays locked the switch fails, the login is unchanged and nothing is restarted', async () => {
  const root = tmp('switch-locked')
  const home = path.join(root, 'claude-home')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(dataDir, 'accounts'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const credFile = path.join(home, '.credentials.json')
  const before = JSON.stringify({ claudeAiOauth: oauth('A', 1) })
  fs.writeFileSync(credFile, before)
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify([{ id: UUID.A, label: 'A', addedAt: 1 }, { id: UUID.B, label: 'B', addedAt: 1 }]))
  fs.writeFileSync(path.join(dataDir, 'accounts', `${UUID.A}.json`), JSON.stringify({ claudeAiOauth: oauth('A', 1) }))
  fs.writeFileSync(path.join(dataDir, 'accounts', `${UUID.B}.json`), JSON.stringify({ claudeAiOauth: oauth('B', 1) }))
  const realRename = fsp.rename
  test.mock.method(fsp, 'rename', async (from, to) => { if (to === credFile) throw busy('EBUSY'); return realRename(from, to) })
  const respawns = fakeExec()
  try {
    await withEnv({ AGENTVILLE_CLAUDE_HOME: home, AGENTVILLE_CLAUDE_BIN: CMD }, () => as('win32', async () => {
      const accounts = createAccounts({ dataDir, claudeHome: () => home, exclusive: (fn) => fn(), poolState: async () => ({ active: false, available: false }), fetch: fakeFetch })
      const account = createAccount({ dataDir, claudeHome: () => home, accounts, run: (b, a, t) => accountRun(b, a, t, respawns), bin: async () => CMD })
      await assert.rejects(account.switchTo({ to: UUID.B }, [], { auto: true }), (e) => /Couldn't change the login, nothing was restarted/.test(e.message))
    }))
    assert.equal(fs.readFileSync(credFile, 'utf8'), before)
    assert.equal(respawns.calls.length, 0)
  } finally {
    test.mock.restoreAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
