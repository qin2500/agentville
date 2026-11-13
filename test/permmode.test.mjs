/**
 * Bypass-permissions switch (server/permmode.mjs): pure flag tests, and toBypass against a temp
 * Claude home with a fake `run`. Never the real ~/.claude, never the real `claude`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { modeOf, withBypass, createPermSwitch, BYPASS } from '../server/permmode.mjs'

const AGENTS = '{"x":{"description":"--permission-mode plan","prompt":"p"}}'

test('modeOf reads the mode, skip flag first, default empty', () => {
  assert.equal(modeOf(undefined), '')
  assert.equal(modeOf(['--model', 'opus']), '')
  assert.equal(modeOf(['--permission-mode', 'auto']), 'auto')
  assert.equal(modeOf(['--permission-mode=acceptEdits']), 'acceptEdits')
  assert.equal(modeOf(['--permission-mode', 'bypassPermissions']), BYPASS)
  assert.equal(modeOf(['--dangerously-skip-permissions', '--permission-mode', 'auto']), BYPASS)
  // A value of another flag is never read as the mode flag.
  assert.equal(modeOf(['--append-system-prompt', '--permission-mode', 'do the thing']), '')
})

test('withBypass replaces every mode flag and keeps every other argument in order', () => {
  assert.deepEqual(withBypass([]), ['--permission-mode', BYPASS])
  assert.deepEqual(
    withBypass(['--model', 'opus', '--permission-mode', 'auto', '--agents', AGENTS, '--permission-mode=plan', '--allow-dangerously-skip-permissions', 'fix the --permission-mode bug']),
    ['--model', 'opus', '--permission-mode', BYPASS, '--agents', AGENTS, 'fix the --permission-mode bug'])
  assert.deepEqual(withBypass(['--permission-mode=auto', '-n', 'job']), ['--permission-mode', BYPASS, '-n', 'job'])
  assert.deepEqual(withBypass(['--dangerously-skip-permissions', 'prompt']), ['--permission-mode', BYPASS, '--dangerously-skip-permissions', 'prompt'])
  // A value that looks like the flag stays where it is.
  assert.deepEqual(withBypass(['--append-system-prompt', '--permission-mode', 'p']), ['--permission-mode', BYPASS, '--append-system-prompt', '--permission-mode', 'p'])
})

function setup(flags, { runResult = { code: 0, stdout: '', stderr: '' }, register = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-perm-'))
  const home = path.join(root, 'claude')
  const short = 'abcdef12'
  const file = path.join(home, 'jobs', short, 'state.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  const original = JSON.stringify({ sessionId: '11111111-1111-1111-1111-111111111111', state: 'running', respawnFlags: flags }, null, 2) + '\n'
  fs.writeFileSync(file, original)
  const calls = []
  const run = async (bin, args) => {
    calls.push(args)
    // The respawned job registers itself with a live pid (this test process).
    if (runResult.code === 0 && register) fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, jobId: short }))
    return { timedOut: false, ...runResult }
  }
  const sw = createPermSwitch({ claudeHome: () => home, dataDir: path.join(root, 'data'), run, bin: async () => '/fake/claude', blocked: () => '', verifyMs: () => 500 })
  return { sw, short, file, original, calls, root, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) }
}

test('toBypass rewrites flags, backs up, respawns and verifies a live job', async () => {
  const t = setup(['--model', 'opus', '--permission-mode', 'auto', 'go'])
  assert.deepEqual(await t.sw.toBypass(t.short, { live: true }), { ok: true, mode: BYPASS, restarted: true })
  assert.deepEqual(t.read().respawnFlags, ['--model', 'opus', '--permission-mode', BYPASS, 'go'])
  assert.deepEqual(t.calls, [['respawn', t.short]])
  const backups = fs.readdirSync(path.join(t.root, 'data', 'perm-backups'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(t.root, 'data', 'perm-backups', backups[0]), 'utf8'), t.original)
  assert.equal((await t.sw.modes()).get(t.short), BYPASS)
  await assert.rejects(t.sw.toBypass(t.short, { live: true }), { status: 409, message: /Already/ })
})

test('a job that is not running only gets its flags changed', async () => {
  const t = setup(['--permission-mode=auto'])
  assert.deepEqual(await t.sw.toBypass(t.short, { live: false }), { ok: true, mode: BYPASS, restarted: false })
  assert.deepEqual(t.calls, [])
  assert.equal(modeOf(t.read().respawnFlags), BYPASS)
})

test('a failed respawn puts the file back exactly', async () => {
  const t = setup(['--permission-mode', 'auto'], { runResult: { code: 1, stdout: '', stderr: 'boom' } })
  await assert.rejects(t.sw.toBypass(t.short, { live: true }), { status: 502 })
  assert.equal(fs.readFileSync(t.file, 'utf8'), t.original)
})

test('an interactive session is refused, before or at respawn', async () => {
  const t = setup(['--permission-mode', 'auto'], { runResult: { code: 1, stdout: '', stderr: 'Session is running in another terminal' } })
  await assert.rejects(t.sw.toBypass(t.short, { live: true, reopened: true }), { status: 409 })
  assert.deepEqual(t.calls, [])
  await assert.rejects(t.sw.toBypass(t.short, { live: true }), { status: 409, message: /terminal/ })
  assert.equal(fs.readFileSync(t.file, 'utf8'), t.original)
})

test('refuses a bad short id', async () => {
  const t = setup([])
  await assert.rejects(t.sw.toBypass('../../x', { live: true }), { status: 409 })
})
