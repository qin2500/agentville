// Automatic updates (server/update.mjs): the decision logic with a fake clock, a fake GitHub and
// injected git/npm runners (nothing real runs), and the Windows command construction.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUpdater, installCommands, touchesDesktop, DEFER_CAP_MS } from '../server/update.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-auto-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
let n = 0
const HOUR = 3600e3
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40)

/** One fake install: a folder with a .git, a scripted git, and a record of every other command. */
function rig({ dirty = false, desktop = '', lock = '', terminals = 0, platform = 'linux', env: extra = {}, settings = false } = {}) {
  const dir = path.join(tmp, `case-${++n}`)
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  const R = { head: OLD, dirty, terminals, clock: 1_000_000, calls: [], restarts: 0, desktop, lock }
  R.settingsFile = settings ? path.join(dir, 'update.json') : null
  const ok = (stdout = '') => ({ ok: true, missing: false, stdout, stderr: '', error: null })
  const runner = async (cmd, args, o = {}) => {
    if (cmd !== 'git') { R.calls.push({ cmd, args, env: o.env }); return ok() }
    const a = args.filter((x) => x !== '--no-optional-locks')
    R.calls.push({ cmd, args: a })
    if (a[0] === '--version') return ok('git version 2')
    if (a[0] === 'rev-parse') return ok(R.head)
    if (a[0] === 'symbolic-ref') return ok('main')
    if (a[0] === 'status') return ok(R.dirty ? ' M file' : '')
    if (a[0] === 'remote') return ok('https://github.com/example/agentville.git')
    if (a[0] === 'pull') { R.head = NEW; return ok() }
    if (a[0] === 'diff') return ok(a.includes('desktop') ? R.desktop : R.lock)
    return ok()
  }
  const fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ status: 'ahead', ahead_by: 1, commits: [{ sha: NEW, commit: { message: 'Faster village\n\nbody', committer: { date: '2026-11-25T00:00:00Z' } } }] }),
  })
  const u = createUpdater({
    root: dir, env: { AGENTVILLE_TEST: '1', AGENTVILLE_UPDATE_API: 'http://fake.invalid', ...extra }, fetch, runner, platform,
    execPath: platform === 'win32' ? 'C:\\node\\node.exe' : '/usr/bin/node', npm: 'npm', now: () => R.clock,
    restart: () => { R.restarts++; return true }, terminalsOpen: () => R.terminals, settingsFile: R.settingsFile,
  })
  const ran = (what) => R.calls.some((c) => c.cmd === what || c.args?.[0] === what)
  return { R, u, ran, make: (o = {}) => createUpdater({ root: dir, env: { AGENTVILLE_TEST: '1', AGENTVILLE_UPDATE_API: 'http://fake.invalid', ...extra }, fetch, runner, platform, now: () => R.clock, settingsFile: R.settingsFile, ...o }) }
}

test('auto on (the default): an available update is applied without asking, then restarts', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { R, u, ran } = rig()
    const s = await u.check()
    assert.equal(s.autoUpdate, true)
    assert.ok(ran('pull'), 'pulled')
    assert.ok(R.calls.some((c) => c.cmd === 'npm' && c.args.join(' ') === 'run build'), 'built')
    assert.ok(!R.calls.some((c) => c.args?.[0] === 'ci'), 'lockfile unchanged: no npm ci')
    assert.equal(R.restarts, 0, 'restart waits so the response can go out')
    mock.timers.tick(600)
    assert.equal(R.restarts, 1)
    const after = await u.status()
    assert.equal(after.applied.short, NEW.slice(0, 7))
    assert.equal(after.applied.title, 'Faster village')
  } finally { mock.timers.reset() }
})

test('auto off: the update is offered, never applied', async () => {
  const { R, u, ran } = rig({ settings: true })
  u.configure({ autoUpdate: false })
  const s = await u.check()
  assert.equal(s.autoUpdate, false)
  assert.equal(s.canApply, true)
  assert.equal(s.behindBy, 1)
  assert.ok(!ran('pull'))
  assert.equal(R.restarts, 0)
})

test('auto on but unsafe (local edits): nothing applied, and the reason is still given', async () => {
  const { u, ran } = rig({ dirty: true })
  const s = await u.check()
  assert.ok(!ran('pull'))
  assert.equal(s.canApply, false)
  assert.match(s.applyBlocked, /local edits/)
})

test('an open in-app terminal defers it, retried at each check, applied after the 3 hour cap', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { R, u, ran } = rig({ terminals: 2 })
    const first = await u.check()
    assert.ok(!ran('pull'))
    assert.equal(first.deferredSince, R.clock)
    R.clock += 30 * 60e3
    await u.check()
    assert.ok(!ran('pull'), 'still deferred after 30 minutes')
    R.clock += DEFER_CAP_MS - 31 * 60e3 // 1 minute short of the cap, measured from the first deferral
    await u.check()
    assert.ok(!ran('pull'), 'still deferred just under 3 hours')
    R.clock += 2 * 60e3
    await u.check()
    assert.ok(ran('pull'), 'applied anyway once it has waited 3 hours')
  } finally { mock.timers.reset() }
})

test('the terminal closing ends the deferral: applied at the next check', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { R, u, ran } = rig({ terminals: 1 })
    await u.check()
    assert.ok(!ran('pull'))
    R.terminals = 0
    R.clock += 30 * 60e3
    await u.check()
    assert.ok(ran('pull'))
  } finally { mock.timers.reset() }
})

test('desktop/ changes: no automatic rebuild, a notice that survives a restart until dismissed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { u, make, R } = rig({ desktop: 'desktop/main.cjs\n', settings: true, env: { AGENTVILLE_DESKTOP: '1' } })
    await u.check()
    const s = await u.status()
    assert.equal(s.needsAppBuild, true)
    assert.ok(!R.calls.some((c) => /app:build/.test((c.args || []).join(' '))), 'never rebuilds the shell itself')
    const again = make() // a restarted server reads the saved file
    assert.equal((await again.status()).needsAppBuild, true)
    assert.equal(again.configure({ dismissAppBuild: true }).needsAppBuild, false)
    assert.equal((await make().status()).needsAppBuild, false)
  } finally { mock.timers.reset() }
})

test('no desktop/ change: no notice', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { u } = rig({ desktop: '', env: { AGENTVILLE_DESKTOP: '1' } })
    await u.check()
    assert.equal((await u.status()).needsAppBuild, false)
  } finally { mock.timers.reset() }
})

test('autoUpdate is saved across restarts', async () => {
  const { u, make } = rig({ settings: true })
  assert.equal((await u.status()).autoUpdate, true)
  u.configure({ autoUpdate: false })
  assert.equal((await make().status()).autoUpdate, false)
})

test('desktop/ detection', () => {
  assert.equal(touchesDesktop('desktop/main.cjs\nweb/src/x.js'), true)
  assert.equal(touchesDesktop('web/src/desktop/x.js\nREADME.md'), false)
  assert.equal(touchesDesktop(''), false)
})

test('Windows: npm ci and the build run with node directly, never npm.cmd', () => {
  const exe = 'C:\\Program Files\\nodejs\\node.exe'
  const near = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  const cmds = installCommands({ platform: 'win32', execPath: exe, env: {}, exists: (f) => f === near })
  assert.equal(cmds.ci.cmd, exe)
  assert.deepEqual(cmds.ci.args, [near, 'ci', '--no-audit', '--no-fund'])
  assert.deepEqual(cmds.build.map((b) => [b.cmd, ...b.args]), [
    [exe, 'tools\\mods-index.mjs'],
    [exe, 'node_modules\\vite\\bin\\vite.js', 'build', 'web'],
  ])
  assert.ok(![cmds.ci, ...cmds.build].some((c) => /\.cmd$|npm$/i.test(c.cmd)))
})

test('Windows: falls back to ..\\lib\\node_modules\\npm when npm is not next to node', () => {
  const exe = 'C:\\tools\\node\\bin\\node.exe'
  const lib = 'C:\\tools\\node\\lib\\node_modules\\npm\\bin\\npm-cli.js'
  const cmds = installCommands({ platform: 'win32', execPath: exe, env: {}, exists: (f) => f === lib })
  assert.equal(cmds.ci.args[0], lib)
})

test('Windows under Electron: ELECTRON_RUN_AS_NODE is set for these children only', () => {
  const cmds = installCommands({ platform: 'win32', execPath: 'C:\\Agentville\\Agentville.exe', env: { AGENTVILLE_DESKTOP: '1' }, exists: () => true })
  for (const c of [cmds.ci, ...cmds.build]) assert.deepEqual(c.env, { ELECTRON_RUN_AS_NODE: '1' })
  const plain = installCommands({ platform: 'win32', execPath: 'C:\\node\\node.exe', env: {}, exists: () => true })
  for (const c of [plain.ci, ...plain.build]) assert.deepEqual(c.env, {})
})

test('elsewhere: plain npm, unchanged', () => {
  const c = installCommands({ platform: 'linux', npm: '/usr/bin/npm' })
  assert.deepEqual(c.ci, { cmd: '/usr/bin/npm', args: ['ci', '--no-audit', '--no-fund'] })
  assert.deepEqual(c.build, [{ cmd: '/usr/bin/npm', args: ['run', 'build'] }])
})

test('apply with platform win32 runs the lockfile install and build through node', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { u, R } = rig({ platform: 'win32', lock: 'package-lock.json\n' })
    await u.check()
    const node = R.calls.filter((c) => c.cmd === 'C:\\node\\node.exe')
    assert.equal(node.length, 3)
    assert.match(node[0].args.join(' '), /npm-cli\.js ci /)
    assert.match(node[2].args.join(' '), /vite\.js build web$/)
    assert.ok(!R.calls.some((c) => c.cmd === 'npm'))
  } finally { mock.timers.reset() }
})
