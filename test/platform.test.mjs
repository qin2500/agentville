import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliDirs, execTarget, quoteForShell, isWin } from '../server/platform.mjs'
import { findExecutable, shQuote, openInTerminal } from '../server/terminal.mjs'

const WIN = { platform: 'win32' }

test('isWin reflects the host', () => assert.equal(isWin, process.platform === 'win32'))

test('cliDirs on POSIX keeps the original lists and order', () => {
  const home = '/h'
  const fwd = (a) => a.map((d) => d.replace(/\\/g, '/'))   // path.join on a Windows host joins with backslashes
  assert.deepEqual(fwd(cliDirs('claude', { platform: 'darwin', home })), ['/h/.local/bin', '/h/.claude/local', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])
  assert.deepEqual(fwd(cliDirs('codex', { platform: 'linux', home })), ['/h/.local/bin', '/h/.npm-global/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])
})

test('cliDirs on Windows uses the profile, npm, WindowsApps and bun dirs', () => {
  const env = { USERPROFILE: 'C:\\U', APPDATA: 'C:\\U\\AppData\\Roaming', LOCALAPPDATA: 'C:\\U\\AppData\\Local' }
  const claude = cliDirs('claude', { ...WIN, env })
  assert.equal(claude.length, 5)
  assert.ok(claude.some((d) => d.endsWith(path.join('Programs', 'claude'))))
  assert.ok(claude.some((d) => d.endsWith('npm')) && claude.some((d) => d.endsWith('WindowsApps')) && claude.some((d) => d.endsWith(path.join('.bun', 'bin'))))
  const codex = cliDirs('codex', { ...WIN, env })
  assert.equal(codex.length, 4)
  assert.ok(!codex.some((d) => d.endsWith(path.join('Programs', 'claude'))))
})

test('execTarget: POSIX and non-.cmd are passed through', () => {
  assert.deepEqual(execTarget('/bin/ls', ['-l'], { platform: 'darwin' }), { file: '/bin/ls', args: ['-l'], opts: {} })
  assert.deepEqual(execTarget('C:\\x\\claude.exe', ['a'], WIN), { file: 'C:\\x\\claude.exe', args: ['a'], opts: {} })
  // .cmd on POSIX is just a file name
  assert.equal(execTarget('x.cmd', [], { platform: 'linux' }).file, 'x.cmd')
})

// cmd.exe drops one caret layer: `^x` -> `x` (and `^^` -> `^`)
const uncaret = (t) => t.replace(/\^(.)/gs, '$1')

// CommandLineToArgvW / MSVCRT rules for one already-isolated argument text
function parseArgv(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++
    if (i >= text.length) break
    let arg = '', inQ = false
    while (i < text.length && (inQ || (text[i] !== ' ' && text[i] !== '\t'))) {
      let bs = 0
      while (text[i] === '\\') { bs++; i++ }
      if (text[i] === '"') {
        arg += '\\'.repeat(Math.floor(bs / 2))
        if (bs % 2) { arg += '"'; i++ } else if (inQ && text[i + 1] === '"') { arg += '"'; i += 2 } else { inQ = !inQ; i++ }
      } else { arg += '\\'.repeat(bs); if (i < text.length) arg += text[i++] }
    }
    out.push(arg)
  }
  return out
}

// what a .cmd shim's child really sees: cmd strips carets once, the shim re-parses and strips again
function childArgv(args) {
  const line = execTarget('c.cmd', args, { ...WIN, env: {} }).args[3]
  assert.ok(line.startsWith('"^"c.cmd^" ') && line.endsWith('"'), line)
  const rest = line.slice('"^"c.cmd^" '.length, -1)
  assert.equal(uncaret(uncaret(rest)).includes('\n'), false)
  return parseArgv(uncaret(uncaret(rest)))
}

test('execTarget wraps .cmd/.bat in cmd.exe with caret-escaped quoted verbatim args', () => {
  const t = execTarget('C:\\Program Files\\n\\npm.cmd', ['run', 'build'], { ...WIN, env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } })
  assert.equal(t.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.deepEqual(t.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(t.args[3], '"^"C:\\Program Files\\n\\npm.cmd^" ^^^"run^^^" ^^^"build^^^""')
  assert.equal(t.opts.windowsVerbatimArguments, true)
  assert.equal(execTarget('a.BAT', [], { ...WIN, env: {} }).file, 'cmd.exe')
})

test('execTarget argv round-trip through CommandLineToArgvW rules', () => {
  const cases = [
    ['\\"'], ['trailing\\'], ['\\\\"'], ['\\\\\\"x'], ['two words', 'a  b'], ['&|<>^'], ['(a)!b'], ['say "hi" & calc | x'],
    ['héllo ✓ 日本'], [''], ['', 'x', ''], ['C:\\dir\\'], ['C:\\a b\\'],
    ['fix it\\" --approval-mode yolo --include-directories C:\\ \\"x'],
  ]
  for (const argv of cases) assert.deepEqual(childArgv(argv), argv, JSON.stringify(argv))
})

test('execTarget: the breakout prompt stays one argument', () => {
  const evil = 'fix it\\" --approval-mode yolo --include-directories C:\\ \\"x'
  assert.equal(childArgv(['-p', evil]).length, 2)
})

test('execTarget refuses newlines, NUL and %..% sequences', () => {
  assert.throws(() => execTarget('c.cmd', ['a\nb'], { ...WIN, env: {} }))
  assert.throws(() => execTarget('c.cmd', ['a\rb'], { ...WIN, env: {} }))
  assert.throws(() => execTarget('c.cmd', ['a\0b'], { ...WIN, env: {} }))
  assert.throws(() => execTarget('c.cmd', ['%PATH%'], { ...WIN, env: {} }))
  assert.throws(() => execTarget('c.cmd', ['50%', '%x'], { ...WIN, env: {} }))
  assert.doesNotThrow(() => execTarget('c.cmd', ['50%'], { ...WIN, env: {} }))
})

test('quoteForShell: POSIX single quotes, PowerShell on Windows', () => {
  assert.equal(quoteForShell("it's", { platform: 'darwin' }), shQuote("it's"))
  assert.equal(shQuote("it's"), `'it'"'"'s'`)
  assert.equal(quoteForShell("it's", WIN), "'it''s'")
})

test('findExecutable: POSIX requires the exec bit and ignores PATHEXT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'))
  fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'plain'), 'x', { mode: 0o644 })
  const env = { PATH: dir }
  assert.equal(await findExecutable('tool', [], { platform: 'linux', env }), path.join(dir, 'tool'))
  // access(X_OK) is always true on a Windows host, so the exec-bit refusal can only be seen on POSIX
  if (process.platform !== 'win32') assert.equal(await findExecutable('plain', [], { platform: 'linux', env }), null)
  assert.equal(await findExecutable('tool', [], { platform: 'linux', env: { PATH: '' } }), null)
  assert.equal(await findExecutable('tool', [dir], { platform: 'linux', env: { PATH: '' } }), path.join(dir, 'tool'))
  assert.equal(await findExecutable('', []), null)
})

test('findExecutable: Windows tries PATHEXT, .exe before .cmd, no X_OK', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'))
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'))
  for (const f of ['both.cmd', 'both.exe', 'shim.cmd', 'run.BAT']) fs.writeFileSync(path.join(dir, f), 'x', { mode: 0o644 })
  fs.writeFileSync(path.join(extra, 'far.cmd'), 'x')
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  assert.equal(await findExecutable('both', [], { ...WIN, env }), path.join(dir, 'both.exe'))
  assert.equal(await findExecutable('shim', [], { ...WIN, env }), path.join(dir, 'shim.cmd'))
  assert.equal(await findExecutable('shim.cmd', [], { ...WIN, env }), path.join(dir, 'shim.cmd'))
  assert.equal(await findExecutable('far', [extra], { ...WIN, env }), path.join(extra, 'far.cmd'))
  assert.equal(await findExecutable('missing', [extra], { ...WIN, env }), null)
  // PATHEXT order: .exe is still preferred even when listed after .cmd
  assert.equal(await findExecutable('both', [], { ...WIN, env: { PATH: dir, PATHEXT: '.CMD;.EXE' } }), path.join(dir, 'both.exe'))
  // default PATHEXT when unset
  assert.equal(await findExecutable('shim', [], { ...WIN, env: { PATH: dir } }), path.join(dir, 'shim.cmd'))
})

test('findExecutable: explicit paths are not searched on PATH', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'))
  fs.writeFileSync(path.join(dir, 'x.cmd'), 'x')
  assert.equal(await findExecutable(path.join(dir, 'x'), [], { ...WIN, env: { PATH: '' } }), path.join(dir, 'x.cmd'))
  assert.equal(await findExecutable('sub/x', [dir], { ...WIN, env: { PATH: dir } }), null)
})

test('openInTerminal still validates its input', async () => {
  assert.equal((await openInTerminal(null, ['/x'], '/')).ok, false)
  assert.equal((await openInTerminal({ kind: 'wt' }, ['x'], '/')).ok, false)
})
