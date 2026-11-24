import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPlainTerms, winShell, parseWinProcesses, listProcesses, cwdOf, tilde, normPath } from '../server/plain-term.mjs'
import { createTerminals } from '../server/pty.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-win-'))
const winEnv = { PATH: 'C:\\a;C:\\Program Files\\PowerShell\\7', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
const PS5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const mk = (o = {}) => createPlainTerms({ home: tmp, platform: 'win32', env: winEnv, findBin: async () => null, ...o })

test('shell choice: pwsh on PATH wins', async () => {
  const t = mk({ exists: (f) => f === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' || f === PS5 })
  assert.deepEqual((await t.create({ kind: 'shell' })).argv, ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo'])
})
test('shell choice: Windows PowerShell, then ComSpec without args', async () => {
  assert.deepEqual((await mk({ exists: (f) => f === PS5 }).create({ kind: 'shell' })).argv, [PS5, '-NoLogo'])
  assert.deepEqual((await mk({ exists: () => false }).create({ kind: 'shell' })).argv, ['C:\\Windows\\System32\\cmd.exe'])
  assert.ok(!(await mk({ exists: () => false }).create({ kind: 'shell' })).argv.includes('-l'))
  assert.equal(winShell({ env: { Path: 'C:\\x', SYSTEMROOT: 'D:\\W' }, exists: (f) => f === 'C:\\x\\pwsh.exe' }), 'C:\\x\\pwsh.exe')
})
test('.cmd/.bat claude and codex are wrapped; .exe is not', async () => {
  const calls = []
  const execTarget = (bin, args) => { calls.push(bin); return { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', bin, ...args], opts: {} } }
  const bins = { claude: 'C:\\n\\claude.cmd', codex: 'C:\\n\\codex.exe' }
  const t = mk({ execTarget, findBin: async (k) => bins[k] })
  assert.deepEqual((await t.create({ kind: 'claude' })).argv, ['C:\\Windows\\System32\\cmd.exe', '/c', 'C:\\n\\claude.cmd'])
  assert.deepEqual((await t.create({ kind: 'codex' })).argv, ['C:\\n\\codex.exe'])
  assert.deepEqual(calls, ['C:\\n\\claude.cmd'])
})
test('PowerShell JSON: array, single object, junk', () => {
  const two = '[{"ProcessId":4,"ParentProcessId":0,"Name":"System"},{"ProcessId":9,"ParentProcessId":4,"Name":"codex.exe"}]'
  assert.deepEqual(parseWinProcesses(two), [{ pid: 4, ppid: 0, command: 'System' }, { pid: 9, ppid: 4, command: 'codex.exe' }])
  assert.deepEqual(parseWinProcesses('\uFEFF{"ProcessId":7,"ParentProcessId":1,"Name":"a.exe"}'), [{ pid: 7, ppid: 1, command: 'a.exe' }])
  assert.deepEqual(parseWinProcesses(''), [])
  assert.deepEqual(parseWinProcesses('nope'), [])
})
test('listProcesses on win32 runs powershell hidden; cwdOf is null', async () => {
  let seen
  const exec = async (cmd, args, opts) => { seen = { cmd, args, opts }; return '{"ProcessId":7,"ParentProcessId":1,"Name":"a.exe"}' }
  assert.deepEqual(await listProcesses({ platform: 'win32', exec }), [{ pid: 7, ppid: 1, command: 'a.exe' }])
  assert.equal(seen.cmd, 'powershell.exe')
  assert.ok(seen.args.includes('-NoProfile') && seen.args.includes('-NonInteractive'))
  assert.equal(seen.opts.windowsHide, true)
  assert.ok(seen.opts.timeout > 0)
  assert.equal(await cwdOf(1, { platform: 'win32' }), null)
})
test('paths compare case-insensitively with normalised slashes on win32', async () => {
  const t = createPlainTerms({ home: tmp.toUpperCase().replace(/\//g, '\\'), platform: 'win32', env: winEnv, findBin: async () => null, exists: () => false })
  // home differs in case/slashes from the real folder, yet is accepted
  const e = await t.create({ kind: 'shell', cwd: tmp })
  assert.equal(e.cwd, tmp)
  assert.equal(e.title.endsWith('~'), true)
  assert.equal(normPath('C:\\Users\\Me\\', 'win32'), 'c:/users/me')
  assert.equal(tilde('C:\\Users\\ME\\code\\x', 'c:/users/me', 'win32'), '~/code/x')
  assert.equal(tilde('D:\\other', 'C:\\Users\\me', 'win32'), 'D:\\other')
  await assert.rejects(t.create({ kind: 'shell', cwd: path.join(tmp, 'nope') }), /Pick your home/)
})
test('win32 status links codex via the terminal folder when cwd is null', async () => {
  const t = mk({
    exists: () => false, findBin: async () => 'C:\\n\\codex.exe',
    procs: async () => [{ pid: 1, ppid: 0, command: 'pwsh.exe' }, { pid: 2, ppid: 1, command: 'Codex.EXE' }],
    cwd: async () => null, registry: async () => [],
  })
  const e = await t.create({ kind: 'codex' })
  const out = await t.status({ get: () => ({ proc: { pid: 1 } }) }, [{ id: 'codex:a', harness: 'codex', live: true, cwd: tmp.toUpperCase() }])
  assert.equal(out[0].id, e.id)
  assert.equal(out[0].agentId, 'codex:a') // case-insensitive folder match, no cwd from the OS
})
test('POSIX behaviour unchanged', async () => {
  const sh = path.join(tmp, 'posix-sh'); fs.writeFileSync(sh, '#!/bin/sh\n')
  const t = createPlainTerms({ home: tmp, platform: 'darwin', shell: () => sh, findBin: async () => '/x/claude.cmd', execTarget: () => { throw new Error('no') } })
  assert.deepEqual((await t.create({ kind: 'shell' })).argv, [sh, '-l'])
  assert.deepEqual((await t.create({ kind: 'claude' })).argv, ['/x/claude.cmd'])
  await assert.rejects(t.create({ kind: 'shell', cwd: tmp.toUpperCase() }), /Pick your home|./)
  assert.equal(tilde(tmp + path.sep + 'a', tmp, 'linux').replace(/\\/g, '/'), '~/a')
  assert.equal(normPath('/A/b', 'linux'), '/A/b')
})
test('pty kill on win32 takes no signal', async () => {
  const sent = []
  const terms = createTerminals({ platform: 'win32', endWaitMs: 100 })
  let exit
  const proc = { kill: (...a) => { sent.push(a); exit() }, write() {}, onExit: (f) => { exit = () => f({ exitCode: 0 }) } }
  const fake = { agentId: 'x', kind: 'attach', proc, clients: new Set(), exit: null, exited: new Promise((r) => { proc.onExit = (f) => { exit = () => { terms.sessions.get('x').exit = {}; r() } } }) }
  proc.onExit(() => {})
  terms.sessions.set('x', fake)
  assert.equal(await terms.end('x'), true)
  assert.ok(sent.length >= 1 && sent.every((a) => a.length === 0))
})
test('execTarget refusal becomes a 409', async () => {
  const t = mk({ findBin: async () => 'C:\\n\\claude.cmd', execTarget: () => { throw new Error('bad') } })
  await assert.rejects(t.create({ kind: 'claude' }), (e) => e.status === 409)
})
