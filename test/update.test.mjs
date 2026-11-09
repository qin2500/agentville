// The update check (server/update.mjs) against temp git repos and a fake GitHub API only: never the
// real GitHub, never this repo's own git state.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUpdater, githubRepo, title } from '../server/update.mjs'
import { createServer } from '../server/serve.mjs'
import { makeRepos, fakeGithub, GIT_ENV, REPO } from './fixtures/fake-github.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-update-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
let n = 0
async function setup() {
  const r = makeRepos(path.join(tmp, `case-${++n}`))
  const gh = await fakeGithub(r.origin)
  const env = { ...GIT_ENV, AGENTVILLE_TEST: '1', ...gh.env }
  return { r, gh, env, make: (o = {}) => createUpdater({ env, root: r.install, ...o }) }
}
/** A stand-in npm that records its arguments, so tests see `ci` without installing anything. */
function fakeNpm(dir) {
  const bin = path.join(dir, 'npm'), log = path.join(dir, 'npm.log')
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 })
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) }
}

test('helpers: GitHub URLs and commit titles', () => {
  assert.equal(githubRepo('git+https://github.com/someone/agentville.git'), 'someone/agentville')
  assert.equal(githubRepo('git@github.com:someone/agentville.git'), 'someone/agentville')
  assert.equal(githubRepo('/tmp/origin.git'), null)
  assert.equal(title('Fix the thing\n\nLong body'), 'Fix the thing')
  const long = title('x'.repeat(500))
  assert.ok(long.length <= 120 && long.endsWith('…'))
})

test('up to date: nothing to do, one anonymous request with only the sha in it', async () => {
  const { r, gh, make } = await setup()
  try {
    const s = await make().check()
    assert.equal(s.enabled, true)
    assert.equal(s.behindBy, 0)
    assert.deepEqual(s.changes, [])
    assert.equal(s.canApply, false)
    assert.equal(s.applyBlocked, 'Already up to date.')
    assert.equal(s.current.sha, r.head())
    assert.equal(s.current.short, r.head().slice(0, 7))
    assert.ok(s.checkedAt)
    assert.equal(gh.requests.length, 1)
    assert.equal(gh.requests[0].url, `/repos/${REPO}/compare/${r.head()}...main`)
    assert.equal(gh.requests[0].ua, 'agentville-update-check')
    assert.equal(gh.requests[0].auth, null)
  } finally { await gh.close() }
})

test('behind by N: newest first, first lines only, and it can fast-forward', async () => {
  const { r, gh, make } = await setup()
  try {
    r.publish('Add the update check\n\nWith a body that is never shown')
    r.publish('Fix a typo')
    const latest = r.publish('Make the village bigger')
    const s = await make().check()
    assert.equal(s.behindBy, 3)
    assert.equal(s.latest.sha, latest)
    assert.equal(s.latest.short, latest.slice(0, 7))
    assert.ok(s.latest.date)
    assert.deepEqual(s.changes.map((c) => c.title), ['Make the village bigger', 'Fix a typo', 'Add the update check'])
    assert.ok(s.changes.every((c) => c.short.length === 7 && c.date))
    assert.equal(s.canApply, true)
    assert.equal(s.applyBlocked, undefined)
  } finally { await gh.close() }
})

test('at most 10 changes are listed', async () => {
  const { r, gh, make } = await setup()
  try {
    for (let i = 1; i <= 12; i++) r.publish(`Change ${i}`)
    const s = await make().check()
    assert.equal(s.behindBy, 12)
    assert.equal(s.changes.length, 10)
    assert.equal(s.changes[0].title, 'Change 12')
  } finally { await gh.close() }
})

test("local commits GitHub doesn't know: says so, still counts what main has, can't apply", async () => {
  const { r, gh, make } = await setup()
  try {
    r.publish('Upstream change')
    fs.writeFileSync(path.join(r.install, 'mine.txt'), 'x')
    r.git(r.install, 'add', 'mine.txt')
    r.git(r.install, 'commit', '-q', '-m', 'My own change')
    // Compared from where the clone left GitHub's main: the update is visible, but only by hand.
    const s = await make().check()
    assert.equal(s.note, "Your copy has changes that aren't on GitHub.")
    assert.equal(s.behindBy, 1)
    assert.deepEqual(s.changes.map((c) => c.title), ['Upstream change'])
    assert.equal(s.canApply, false)
    assert.match(s.applyBlocked, /commits that aren't on GitHub/)
    assert.ok(s.commands.includes('git pull origin main') && s.commands.includes('./setup.sh'))
    // With no fork point at all, it can only say it can't tell.
    r.git(r.install, 'update-ref', '-d', 'refs/remotes/origin/main')
    const s3 = await make().check()
    assert.match(s3.note, /changes that aren't on GitHub, so Agentville can't tell/)
    assert.equal(s3.behindBy, 0)
  } finally { await gh.close() }
})

test('local edits or another branch: canApply false with the reason', async () => {
  const { r, gh, make } = await setup()
  try {
    r.publish('Upstream change')
    fs.writeFileSync(path.join(r.install, 'app.txt'), 'edited\n')
    const dirty = await make().check()
    assert.equal(dirty.behindBy, 1)
    assert.equal(dirty.canApply, false)
    assert.equal(dirty.applyBlocked, 'Your copy has local edits.')
    r.git(r.install, 'checkout', '-q', '--', 'app.txt')
    fs.writeFileSync(path.join(r.install, 'untracked.txt'), 'fine')
    assert.equal((await make().check()).canApply, true, 'untracked files do not block')
    r.git(r.install, 'switch', '-q', '-c', 'experiment')
    const branch = await make().check()
    assert.equal(branch.canApply, false)
    assert.match(branch.applyBlocked, /branch “experiment”, not main/)
    assert.ok(branch.commands.includes('git switch main'))
    const u = make()
    await u.check()
    const out = await u.apply()
    assert.equal(out.ok, false)
    assert.match(out.error, /experiment/)
  } finally { await gh.close() }
})

test('apply: fast-forwards, rebuilds, reinstalls only when the lockfile changed, then restarts', async () => {
  const { r, gh, make } = await setup()
  try {
    const npm = fakeNpm(path.join(tmp, `case-${n}`))
    let restarts = 0
    const latest = r.publish('Upstream change')
    const u = make({ npm: npm.bin, restart: () => { restarts++; return true } })
    assert.equal((await u.check()).canApply, true)
    const out = await u.apply()
    assert.equal(out.ok, true, out.error)
    assert.equal(out.sha, latest)
    assert.equal(r.head(), latest)
    assert.deepEqual(out.steps.map((s) => s.name), ['git pull --ff-only origin main', 'npm run build'])
    assert.deepEqual(npm.calls(), ['run build'])
    assert.equal(out.restarting, true)
    assert.equal(restarts, 0, 'the restart waits for the response')
    assert.equal(u.restartNow(), true)
    assert.equal(restarts, 1)
    const after = await u.status()
    assert.equal(after.behindBy, 0)
    assert.equal(after.current.sha, latest)

    r.publish('New dependencies', { lock: true })
    await u.check()
    const out2 = await u.apply()
    assert.equal(out2.ok, true, out2.error)
    assert.deepEqual(out2.steps.map((s) => s.name), ['git pull --ff-only origin main', 'npm ci', 'npm run build'])
    assert.deepEqual(npm.calls().slice(1), ['ci --no-audit --no-fund', 'run build'])
  } finally { await gh.close() }
})

test('apply with the real npm runs the checkout’s build; without a restart it says so', async () => {
  const { r, gh, make } = await setup()
  try {
    r.publish('Upstream change')
    const u = make()
    await u.check()
    assert.equal((await u.status()).canRestart, false)
    const out = await u.apply()
    assert.equal(out.ok, true, out.error)
    assert.equal(out.restarting, false)
    assert.ok(fs.existsSync(path.join(r.install, 'built.txt')))
  } finally { await gh.close() }
})

test('a failed pull leaves the checkout as it was', async () => {
  const { r, gh, make } = await setup()
  try {
    r.publish('Upstream change')
    const before = r.head()
    const u = make()
    await u.check()
    // The remote goes away between the check and the click.
    r.git(r.install, 'remote', 'set-url', 'origin', path.join(tmp, 'nowhere.git'))
    const out = await u.apply()
    assert.equal(out.ok, false)
    assert.match(out.error, /^git pull failed/)
    assert.equal(r.head(), before)
    assert.equal(r.git(r.install, 'status', '--porcelain', '--untracked-files=no'), '')
  } finally { await gh.close() }
})

test('offline and rate limits: keep the last answer and back off', async () => {
  const { r, gh, make } = await setup()
  try {
    r.publish('Upstream change')
    const u = make()
    const good = await u.check()
    assert.equal(good.behindBy, 1)
    gh.mode = 'down'
    const off = await u.check()
    assert.equal(off.behindBy, 1, 'last answer kept')
    assert.equal(off.checkedAt, good.checkedAt)
    assert.match(off.error, /Couldn't reach GitHub/)
    gh.mode = 'rate'
    const before = gh.requests.length
    const rate = await u.check()
    assert.equal(gh.requests.length, before + 1)
    assert.match(rate.error, /slow down/)
    assert.equal(rate.behindBy, 1)
    gh.mode = 'ok'
    const back = await u.check()
    assert.equal(back.error, undefined)
  } finally { await gh.close() }
})

test('the next try backs off: 30 min when offline, not before the rate-limit reset', async () => {
  const { gh, make } = await setup()
  const u = make()
  try {
    await u.start()
    gh.mode = 'down'
    const off = await u.check()
    assert.ok(Math.abs(off.nextCheckAt - Date.now() - 30 * 60e3) < 5000)
    gh.mode = 'rate'
    const rate = await u.check()
    assert.ok(rate.nextCheckAt >= Date.now() + 3500e3, 'waits for x-ratelimit-reset (an hour out)')
    gh.mode = 'ok'
    const ok = await u.check()
    assert.ok(Math.abs(ok.nextCheckAt - Date.now() - 6 * 3600e3) < 5000, 'then every 6 hours')
  } finally { u.stop(); await gh.close() }
})

test('turned off by AGENTVILLE_UPDATE_CHECK=0, outside a git checkout, and in tests without the API override', async () => {
  const { r, gh, env } = await setup()
  const calls = []
  const spy = async (...a) => { calls.push(a); throw new Error('no network in tests') }
  try {
    const offEnv = await createUpdater({ env: { ...env, AGENTVILLE_UPDATE_CHECK: '0' }, root: r.install, fetch: spy }).check()
    assert.equal(offEnv.enabled, false)
    assert.match(offEnv.why, /AGENTVILLE_UPDATE_CHECK=0/)
    const plain = path.join(tmp, 'not-a-checkout')
    fs.mkdirSync(plain, { recursive: true })
    const noGit = await createUpdater({ env, root: plain, fetch: spy }).check()
    assert.equal(noGit.enabled, false)
    assert.match(noGit.why, /isn't a git checkout/)
    // Under test, no API override means no network, even for a real checkout like this repo.
    for (const t of [{ AGENTVILLE_TEST: '1' }, { NODE_ENV: 'test' }, { NODE_TEST_CONTEXT: 'child' }]) {
      const u = createUpdater({ env: { PATH: process.env.PATH, ...t }, fetch: spy })
      await u.start()
      const s = await u.check()
      u.stop()
      assert.equal(s.enabled, false)
      assert.equal(s.why, 'Update checks are off in tests.')
      assert.equal((await u.apply()).ok, false)
    }
    // An API override alone may check (read-only git, no index lock) but never update this repo.
    const own = createUpdater({ env: { PATH: process.env.PATH, AGENTVILLE_TEST: '1', AGENTVILLE_UPDATE_API: gh.url, AGENTVILLE_UPDATE_REPO: REPO }, fetch: spy })
    const ro = await own.check()
    assert.equal(ro.canApply, false)
    assert.match((await own.apply()).error, /off in tests/)
    assert.equal(calls.length, 1, 'only the overridden API was asked')
    assert.ok(calls[0][0].startsWith(gh.url))
    assert.equal(gh.requests.length, 0, 'the spy stood in for it')
  } finally { await gh.close() }
})

test('git missing: quietly off', async () => {
  const { r, gh, env } = await setup()
  try {
    const s = await createUpdater({ env, root: r.install, git: path.join(tmp, 'no-such-git') }).check()
    assert.equal(s.enabled, false)
    assert.match(s.why, /git wasn't found/)
  } finally { await gh.close() }
})

test('HTTP: GET /api/update, POST /api/update/apply behind the local-only guard', async () => {
  const { r, gh, env } = await setup()
  const saved = { ...process.env }
  Object.assign(process.env, env)
  const server = createServer({ dataDir: path.join(tmp, `data-${n}`), update: { root: r.install, env } })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const latest = r.publish('Upstream change')
    const s = await (await fetch(`${base}/api/update?fresh`)).json()
    assert.equal(s.behindBy, 1)
    assert.equal(s.canApply, true)
    assert.equal(typeof s.startedAt, 'number')
    // Another web page can't trigger it; a same-origin JSON POST can.
    assert.equal((await fetch(`${base}/api/update/apply`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })).status, 403)
    assert.equal((await fetch(`${base}/api/update/apply`, { method: 'POST', headers: { origin: base }, body: '{}' })).status, 415)
    const res = await fetch(`${base}/api/update/apply`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' })
    const out = await res.json()
    assert.equal(res.status, 200, out.error)
    assert.equal(out.ok, true)
    assert.equal(out.restarting, false, 'no restart under test')
    assert.equal(r.head(), latest)
    const again = await fetch(`${base}/api/update/apply`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' })
    assert.equal(again.status, 409)
    assert.equal((await again.json()).error, 'Already up to date.')
  } finally {
    await new Promise((ok) => server.close(ok))
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    await gh.close()
  }
})

test('under the desktop app, a restart exits with DESKTOP_RESTART_EXIT so the app starts it again', async (t) => {
  const { spawn } = await import('node:child_process')
  const { DESKTOP_RESTART_EXIT } = await import('../server/update.mjs')
  // canRestartSelf wants to be `…/cli.mjs` outside a test runner: a stand-in entry point, clean env.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-restart-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const entry = path.join(dir, 'cli.mjs')
  fs.writeFileSync(entry, `import http from 'node:http'
import { restartSelf } from ${JSON.stringify(new URL('../server/update.mjs', import.meta.url).href)}
const s = http.createServer().listen(0, '127.0.0.1', () => { if (!restartSelf(s)) process.exit(3) })
`)
  const env = { PATH: process.env.PATH, HOME: dir, AGENTVILLE_DESKTOP: '1' }
  const child = spawn(process.execPath, [entry], { env, stdio: 'ignore' })
  const code = await new Promise((r) => child.once('exit', r))
  assert.equal(code, DESKTOP_RESTART_EXIT)
  assert.equal(DESKTOP_RESTART_EXIT, 75) // desktop/shell.cjs RESTART_EXIT
})
