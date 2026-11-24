/**
 * Spec tests for docs/providers-design.md §5: parseAgentStart / checkAgentStart guards, against the real ctx
 * shape (see server/agent-start.mjs): settings { get, defaultProvider }, launches (createLaunches),
 * resolveSession(session) -> agent, providerStatus(id) -> { usable }, knownProjects() -> [{ dir, name }].
 * Each rejection asserts the specific status, so a test can't pass because some other guard tripped.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseAgentStart, checkAgentStart } from '../server/agent-start.mjs'
import { createLaunches } from '../server/launches.mjs'

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agspec-')))
const work = path.join(root, 'work'); const proj = path.join(work, 'proj'); const sub = path.join(proj, 'sub')
const other = path.join(work, 'other'); const etc = path.join(root, 'etc')
for (const d of [sub, other, etc]) fs.mkdirSync(d, { recursive: true })

const caller = { id: 'claude-code:s1', provider: 'claude', kind: 'session', live: true, cwd: proj }
const baseCtx = ({ agentStarts = {}, who = caller, usable = () => true, seed } = {}) => {
  const launches = createLaunches({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agspec-l-')) })
  seed?.(launches)
  return {
    launches, homedir: path.join(root, 'nohome'),
    settings: { get: () => ({ agentStarts: { enabled: true, perHour: 20, maxDepth: 3, ...agentStarts } }), defaultProvider: () => 'claude' },
    resolveSession: (s) => (s === 'claude-code:s1' || s === 's1' ? who : null),
    providerStatus: (p) => ({ usable: usable(p), why: 'not found' }),
    knownProjects: () => [{ dir: other, name: 'other' }],
  }
}
const input = (over = {}) => ({ session: 'claude-code:s1', provider: 'gemini', prompt: 'do it', cwd: proj, model: '', permissionMode: '', token: '', ...over })
const check = (i, c) => checkAgentStart(i, c)

test('parseAgentStart: a valid body parses with provider, prompt and cwd', () => {
  const r = parseAgentStart({ session: 's', provider: 'gemini', prompt: 'hi', cwd: '/a' })
  assert.equal(r.ok, true)
  assert.equal(r.value.provider, 'gemini'); assert.equal(r.value.cwd, '/a')
})
test('parseAgentStart: missing prompt is a 400', () => {
  assert.equal(parseAgentStart({ session: 's', provider: 'gemini' }).status, 400)
})
test('parseAgentStart: non-object body is a 400', () => {
  for (const b of [null, 'x', 5, []]) assert.equal(parseAgentStart(b).status, 400)
})
test('parseAgentStart: unknown provider and codex are a 400', () => {
  for (const p of ['nope', 'codex']) assert.equal(parseAgentStart({ session: 's', provider: p, prompt: 'hi' }).status, 400, p)
})
test('checkAgentStart: happy path is accepted', () => {
  const r = check(input(), baseCtx())
  assert.equal(r.ok, true); assert.equal(r.provider, 'gemini'); assert.equal(r.cwd, proj)
})
test('guard: agentStarts.enabled=false is a 403', () => {
  assert.equal(check(input(), baseCtx({ agentStarts: { enabled: false } })).status, 403)
})
test('guard: caller that does not resolve is a 404', () => {
  assert.equal(check(input({ session: 'ghost' }), baseCtx()).status, 404)
})
test('guard: a subagent caller is a 403', () => {
  assert.equal(check(input(), baseCtx({ who: { ...caller, kind: 'subagent' } })).status, 403)
})
test('guard: cwd outside the caller cwd and known projects is a 403', () => {
  assert.equal(check(input({ cwd: etc }), baseCtx()).status, 403)
})
test('guard: cwd inside the caller cwd is accepted', () => {
  assert.equal(check(input({ cwd: sub }), baseCtx()).ok, true)
})
test('guard: a known project is accepted', () => {
  assert.equal(check(input({ cwd: other }), baseCtx()).ok, true)
})
test('guard: a ../ escape from the caller cwd is a 403', () => {
  assert.equal(check(input({ cwd: `${proj}/../other/../../etc` }), baseCtx()).status, 403)
})
test('guard: unusable target provider is a 409', () => {
  assert.equal(check(input(), baseCtx({ usable: (p) => p !== 'gemini' })).status, 409)
})
const chain = (n) => (l) => {
  // s1 sits n start links below a top-level agent.
  let parent = 'claude-code:top'
  for (let i = 0; i < n - 1; i++) { l.record({ ref: `a${i}`, parentAgentId: parent, provider: 'claude' }); parent = `claude-code:a${i}` }
  return l.record({ ref: 's1', parentAgentId: parent, provider: 'claude' }).token
}
test('guard: start depth at maxDepth is a 429', () => {
  let token; const ctx = baseCtx({ seed: (l) => { token = chain(3)(l) } })
  assert.equal(ctx.launches.depth('claude-code:s1'), 3)
  assert.equal(check(input({ token }), ctx).status, 429)
})
test('guard: depth under maxDepth is accepted', () => {
  let token; const ctx = baseCtx({ seed: (l) => { token = chain(2)(l) } })
  assert.equal(check(input({ token }), ctx).ok, true)
})
test('guard: perHour reached for the caller is a 429', () => {
  const ctx = baseCtx({ seed: (l) => { for (let i = 0; i < 20; i++) l.record({ ref: `k${i}`, parentAgentId: 'claude-code:s1', provider: 'gemini' }) } })
  assert.equal(check(input(), ctx).status, 429)
})
test('guard: 60 per hour overall is a 429', () => {
  const ctx = baseCtx({ seed: (l) => { for (let i = 0; i < 60; i++) l.record({ ref: `k${i}`, parentAgentId: `claude-code:x${i}`, provider: 'gemini' }) } })
  assert.equal(check(input(), ctx).status, 429)
})
