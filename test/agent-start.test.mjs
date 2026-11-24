import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLaunches, TOKEN_ENV } from '../server/launches.mjs'
import { parseAgentStart, checkAgentStart, checkAndRecord, rollback, clampMode } from '../server/agent-start.mjs'

const real = (p) => fs.realpathSync.native(p)
const root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'agstart-')))
const home = path.join(root, 'home'); const proj = path.join(home, 'proj'); const sub = path.join(proj, 'sub')
const other = path.join(home, 'other'); const outside = path.join(root, 'outside')
for (const d of [sub, other, outside]) fs.mkdirSync(d, { recursive: true })
fs.symlinkSync(outside, path.join(proj, 'escape'))

/** Agents keyed by session, in the shape classify.mjs produces. */
const agent = (o) => ({ kind: 'session', live: true, cwd: proj, provider: 'claude', ...o })
const AGENTS = {
  S: agent({ id: 'claude-code:S' }),
  JOB: agent({ id: 'claude-code:JOB', kind: 'job', permissionMode: 'acceptEdits' }),
  PLAN: agent({ id: 'claude-code:PLAN', kind: 'job', permissionMode: 'plan' }),
  SUB: agent({ id: 'claude-code:S:sub:1', kind: 'subagent' }),
  TM: agent({ id: 'claude-code:TM', kind: 'teammate' }),
  TH: agent({ id: 'codex:TH', kind: 'thread', provider: 'codex' }),
  DEAD: agent({ id: 'claude-code:DEAD', live: false }),
  LIVEISH: agent({ id: 'claude-code:LIVEISH', live: 'yes' }),
  HOMECALLER: agent({ id: 'claude-code:HOMECALLER', cwd: home }),
  ROOTCALLER: agent({ id: 'claude-code:ROOTCALLER', cwd: '/' }),
}

const mkCtx = (over = {}, cfgOver = {}) => {
  let t = 1_000_000
  const launches = createLaunches({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agl-')), now: () => t })
  const agents = { ...AGENTS }
  const cfg = { enabled: true, perHour: 20, maxDepth: 3, ...cfgOver }
  const ctx = {
    launches, homedir: home,
    settings: { get: () => ({ agentStarts: cfg }), defaultProvider: () => 'claude' },
    resolveSession: (s) => agents[s] || Object.values(agents).find((a) => a.id === s) || null,
    providerStatus: () => ({ usable: true }),
    knownProjects: () => [{ dir: other, name: 'other' }],
    startPlan: (provider, i) => ({ kind: 'start', provider, args: ['x'], cwd: i.cwd, env: { A: '1' } }),
    ...over,
  }
  return { ctx, launches, agents, tick: (ms) => { t += ms } }
}
const input = (o = {}) => ({ session: 'S', provider: null, prompt: 'p', cwd: null, model: '', permissionMode: '', token: '', ...o })

// F6
test('parse strips launch internals from the body', () => {
  const r = parseAgentStart({ session: 's', prompt: 'x', env: { PATH: '/evil' }, args: ['--yolo'], bin: '/bin/sh', home: '/h',
    account: 'a', runId: 'r', resume: 'id', auto: true, worktree: 'w', token: 'tok' })
  assert.equal(r.ok, true)
  for (const k of ['env', 'args', 'bin', 'home', 'account', 'runId', 'resume', 'auto', 'worktree']) assert.equal(k in r.value, false, k)
  assert.equal(r.value.token, 'tok')
})
test('parse: basics', () => {
  assert.equal(parseAgentStart(null).ok, false)
  assert.equal(parseAgentStart({ session: 's' }).ok, false)
  assert.equal(parseAgentStart({ session: 's', prompt: 'x', provider: 'codex' }).ok, false)
  assert.equal(parseAgentStart({ session: 's', prompt: 'x', cwd: 'rel' }).ok, false)
  assert.equal(parseAgentStart({ session: 's', prompt: ' x ' }).value.prompt, 'x')
})
test('guard: subagent, teammate and thread callers are refused', () => {
  const { ctx } = mkCtx()
  for (const s of ['SUB', 'TM', 'TH']) assert.equal(checkAgentStart(input({ session: s }), ctx).status, 403, s)
})
test('guard: caller must be live === true', () => {
  const { ctx } = mkCtx()
  assert.equal(checkAgentStart(input({ session: 'DEAD' }), ctx).status, 404)
  assert.equal(checkAgentStart(input({ session: 'LIVEISH' }), ctx).status, 404)
  assert.equal(checkAgentStart(input({ session: 'nobody' }), ctx).status, 404)
  assert.equal(checkAgentStart(input(), ctx).ok, true)
})
test('guard: disabled unless enabled === true', () => {
  assert.equal(checkAgentStart(input(), mkCtx({}, { enabled: false }).ctx).status, 403)
  assert.equal(checkAgentStart(input(), mkCtx({}, { enabled: 'yes' }).ctx).status, 403)
})

// F2
test('mode: yolo and bypassPermissions are refused outright', () => {
  for (const m of ['yolo', 'bypassPermissions']) {
    assert.equal(parseAgentStart({ session: 's', prompt: 'x', permissionMode: m }).status, 400, m)
    const { ctx } = mkCtx()
    assert.equal(checkAgentStart(input({ permissionMode: m, provider: m === 'yolo' ? 'gemini' : 'claude' }), ctx).status, 400)
  }
})
test('mode: child is clamped to the caller; unknown caller mode counts as default', () => {
  const { ctx } = mkCtx()
  // S has no known mode -> default cap.
  let r = checkAgentStart(input({ permissionMode: 'acceptEdits' }), ctx)
  assert.equal(r.permissionMode, ''); assert.equal(r.modeClamped, true)
  r = checkAgentStart(input({ permissionMode: 'auto_edit', provider: 'gemini' }), ctx)
  assert.equal(r.permissionMode, 'default'); assert.equal(r.modeClamped, true)
  // JOB runs acceptEdits: acceptEdits / auto_edit pass, auto is clamped to acceptEdits.
  assert.equal(checkAgentStart(input({ session: 'JOB', permissionMode: 'acceptEdits' }), ctx).permissionMode, 'acceptEdits')
  assert.equal(checkAgentStart(input({ session: 'JOB', permissionMode: 'auto_edit', provider: 'gemini' }), ctx).permissionMode, 'auto_edit')
  assert.equal(checkAgentStart(input({ session: 'JOB', permissionMode: 'auto' }), ctx).permissionMode, 'acceptEdits')
  // A plan-mode caller can only start plan-mode children.
  assert.equal(checkAgentStart(input({ session: 'PLAN' }), ctx).permissionMode, 'plan')
  assert.equal(checkAgentStart(input({ session: 'PLAN', provider: 'gemini' }), ctx).permissionMode, 'plan')
  // Stricter than the caller is fine.
  assert.equal(checkAgentStart(input({ session: 'JOB', permissionMode: 'plan' }), ctx).permissionMode, 'plan')
  // A bypass caller still can't start a bypass child, and gets at most auto.
  assert.deepEqual(clampMode('claude', 'auto', 'bypassPermissions'), { ok: true, mode: 'auto', clamped: false })
  assert.equal(clampMode('gemini', 'auto_edit', 'yolo').mode, 'auto_edit')
  // Wrong vocabulary for the provider is a 400.
  assert.equal(checkAgentStart(input({ permissionMode: 'auto_edit' }), ctx).status, 400)
  assert.equal(checkAgentStart(input({ permissionMode: 'acceptEdits', provider: 'gemini' }), ctx).status, 400)
})
test('mode: the clamped mode is what startPlan sees', () => {
  let seen = null
  const { ctx } = mkCtx({ startPlan: (p, i) => { seen = i; return { args: [] } } })
  checkAgentStart(input({ permissionMode: 'auto', model: 'opus', env: { X: 1 } }), ctx)
  assert.equal(seen.permissionMode, '')
  assert.equal('env' in seen, false)
})
test('model must match the allowlist pattern', () => {
  for (const m of ['--dangerous', '-x', 'a b', 'a;b', '$(x)', '../x']) {
    assert.equal(parseAgentStart({ session: 's', prompt: 'x', model: m }).status, 400, m)
    assert.equal(checkAgentStart(input({ model: m }), mkCtx().ctx).status, 400, m)
  }
  for (const m of ['opus', 'claude-opus-4.5', 'gemini-2.5-pro', 'vendor:model_1']) assert.equal(parseAgentStart({ session: 's', prompt: 'x', model: m }).ok, true, m)
})

// F4
test('cwd: inside the caller realpath, or exactly a known project; trusted only for the latter', () => {
  const { ctx } = mkCtx()
  let r = checkAgentStart(input(), ctx)
  assert.equal(r.cwd, proj); assert.equal(r.trusted, false)
  r = checkAgentStart(input({ cwd: sub }), ctx)
  assert.equal(r.cwd, sub); assert.equal(r.trusted, false)
  r = checkAgentStart(input({ cwd: other }), ctx)
  assert.equal(r.ok, true); assert.equal(r.trusted, true)
  assert.equal(checkAgentStart(input({ cwd: path.join(other, '..') }), ctx).status, 403)
  assert.equal(checkAgentStart(input({ cwd: outside }), ctx).status, 403)
  assert.equal(checkAgentStart(input({ cwd: `${proj}/../other/../../outside` }), ctx).status, 403)
  // A symlink inside the caller cwd that points outside is judged by its target.
  assert.equal(checkAgentStart(input({ cwd: path.join(proj, 'escape') }), ctx).status, 403)
  // Must exist and be a directory.
  assert.equal(checkAgentStart(input({ cwd: path.join(proj, 'missing') }), ctx).status, 400)
  fs.writeFileSync(path.join(proj, 'f.txt'), 'x')
  assert.equal(checkAgentStart(input({ cwd: path.join(proj, 'f.txt') }), ctx).status, 400)
})
test('cwd: a project equal to the caller cwd is trusted', () => {
  const { ctx } = mkCtx({ knownProjects: () => [proj] })
  assert.equal(checkAgentStart(input(), ctx).trusted, true)
})
test('cwd: home, / and a drive root are never an "inside" base', () => {
  const { ctx } = mkCtx()
  assert.equal(checkAgentStart(input({ session: 'HOMECALLER', cwd: proj }), ctx).status, 403)
  assert.equal(checkAgentStart(input({ session: 'HOMECALLER' }), ctx).status, 403)
  assert.equal(checkAgentStart(input({ session: 'ROOTCALLER', cwd: outside }), ctx).status, 403)
  // ...but a known project still works for them.
  assert.equal(checkAgentStart(input({ session: 'HOMECALLER', cwd: other }), ctx).trusted, true)
  // Home or / as a "known project" is not trusted either.
  const c2 = mkCtx({ knownProjects: () => [{ dir: home }, { dir: '/' }] }).ctx
  assert.equal(checkAgentStart(input({ session: 'HOMECALLER' }), c2).status, 403)
})

// F5
test('ceilings: settings cannot raise perHour past 60 or maxDepth past 3', () => {
  const { ctx, launches } = mkCtx({}, { perHour: 1000, maxDepth: 99 })
  for (let i = 0; i < 60; i++) launches.record({ ref: `r${i}`, parentAgentId: `claude-code:other${i % 3}`, provider: 'claude' })
  assert.equal(checkAgentStart(input(), ctx).status, 429)
  const c2 = mkCtx({}, { maxDepth: 99 })
  c2.launches.record({ ref: 'a', parentAgentId: 'claude-code:root', provider: 'claude' })
  c2.launches.record({ ref: 'b', parentAgentId: 'claude-code:a', provider: 'claude' })
  const t = c2.launches.record({ ref: 'S', parentAgentId: 'claude-code:b', provider: 'claude' }).token
  assert.equal(checkAgentStart(input({ token: t }), c2.ctx).status, 429)
})
test('ceilings: non-numeric settings fall back to the defaults', () => {
  const { ctx, launches } = mkCtx({}, { perHour: 'lots', maxDepth: null })
  for (let i = 0; i < 20; i++) launches.record({ ref: `r${i}`, parentAgentId: 'claude-code:S', provider: 'claude' })
  assert.equal(checkAgentStart(input(), ctx).status, 429)
})
test('identity: a ledger-known caller must present its token', () => {
  const { ctx, launches } = mkCtx()
  const { token } = launches.record({ ref: 'S', parentAgentId: 'claude-code:top', provider: 'claude' })
  assert.equal(checkAgentStart(input(), ctx).status, 403)
  assert.equal(checkAgentStart(input({ token: 'wrong-wrong-wrong-wrong' }), ctx).status, 403)
  const other = launches.record({ ref: 'X', parentAgentId: null, provider: 'claude', via: 'ui' }).token
  assert.equal(checkAgentStart(input({ token: other }), ctx).status, 403, "someone else's token")
  const r = checkAgentStart(input({ token }), ctx)
  assert.equal(r.ok, true); assert.equal(r.depth, 1)
})
test('identity: a token while the caller is still pending carries its depth', () => {
  const { ctx, launches } = mkCtx()
  launches.record({ ref: 'mid', parentAgentId: 'claude-code:top', provider: 'claude' })
  const { token } = launches.record({ ref: 'pending-x', parentAgentId: 'claude-code:mid', provider: 'gemini', pending: true })
  // The new child calls before bind(): its own id isn't in the ledger yet, but its token is.
  const r = checkAgentStart(input({ token }), ctx)
  assert.equal(r.depth, 2)
})
test('depth: parent -> child -> grandchild with real id shapes', () => {
  const { ctx, launches, agents } = mkCtx({ providerStatus: () => ({ usable: true }) })
  // Parent: a top-level Claude session the user started.
  agents.P = agent({ id: 'claude-code:P' })
  const a = checkAndRecord(input({ session: 'claude-code:P', provider: 'claude' }), ctx)
  assert.equal(a.ok, true); assert.equal(a.depth, 0)
  assert.equal(a.plan.env[TOKEN_ENV], a.token)
  launches.bind(a.launchId, 'job-c1', ['claude-code:C1'])
  agents.C1 = agent({ id: 'claude-code:C1', kind: 'job' })
  // Child (Claude job) starts a Gemini grandchild.
  assert.equal(checkAndRecord(input({ session: 'claude-code:C1', provider: 'gemini' }), ctx).status, 403, 'no token')
  const b = checkAndRecord(input({ session: 'claude-code:C1', provider: 'gemini', token: a.token }), ctx)
  assert.equal(b.ok, true); assert.equal(b.depth, 1)
  launches.bind(b.launchId, 'run-g1')
  agents.G1 = agent({ id: 'gemini:run-g1', provider: 'gemini' })
  assert.equal(launches.depth('gemini:run-g1'), 2)
  assert.equal(launches.startedBy('gemini:run-g1'), 'claude-code:C1')
  // Grandchild starts a great-grandchild (depth 3, the hard max).
  const c = checkAndRecord(input({ session: 'gemini:run-g1', provider: 'claude', token: b.token }), ctx)
  assert.equal(c.ok, true); assert.equal(c.depth, 2)
  launches.bind(c.launchId, 'job-c3', ['claude-code:C3'])
  agents.C3 = agent({ id: 'claude-code:C3', kind: 'job' })
  assert.equal(launches.depth('claude-code:C3'), 3)
  // ...which can't start another.
  assert.equal(checkAndRecord(input({ session: 'claude-code:C3', token: c.token }), ctx).status, 429)
})
test('checkAndRecord: records in the same sync section, so back-to-back calls see each other', () => {
  const { ctx } = mkCtx({}, { perHour: 2 })
  const a = checkAndRecord(input(), ctx); const b = checkAndRecord(input(), ctx); const c = checkAndRecord(input(), ctx)
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(c.status, 429)
  assert.equal(rollback(a.launchId, ctx), true)
  assert.equal(checkAndRecord(input(), ctx).ok, true)
})
test('corrupt ledger: depth fails closed, starts refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agl-'))
  fs.writeFileSync(path.join(dir, 'launches.json'), '{garbage')
  const { ctx } = mkCtx({ launches: createLaunches({ dataDir: dir }) })
  assert.equal(checkAgentStart(input(), ctx).status, 429)
})
test('provider: unusable is 409; startPlan rejection is 400', () => {
  assert.equal(checkAgentStart(input({ provider: 'gemini' }), mkCtx({ providerStatus: (p) => ({ usable: p !== 'gemini', why: 'out' }) }).ctx).status, 409)
  assert.equal(checkAgentStart(input(), mkCtx({ startPlan: () => ({ ok: false, error: 'bad' }) }).ctx).status, 400)
  assert.equal(checkAgentStart(input(), mkCtx({ startPlan: () => { throw new Error('x') } }).ctx).status, 400)
})
