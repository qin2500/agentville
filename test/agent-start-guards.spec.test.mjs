/**
 * Spec tests for docs/providers-design.md section 5: parseAgentStart / checkAgentStart guards.
 * ctx is the real seam (server/agent-start.mjs): settings { get(), defaultProvider() }, launches { depth(id),
 * count({ parentAgentId?, via }) }, resolveSession(s), providerStatus(id), knownProjects(). The server's
 * resolveSession marks sub-agent kinds with `isSubagent`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tryLoad, outcome } from './support/spec-load.mjs'

const mod = await tryLoad('../server/agent-start.mjs')
const opts = mod ? {} : { todo: 'waiting on P14' }

const caller = { id: 'claude:s1', provider: 'claude', kind: 'session', live: true, cwd: '/work/proj' }
const cfg = { agentStarts: { enabled: true, perHour: 20, maxDepth: 3 }, defaultProvider: 'claude', providerOrder: ['claude', 'gemini'] }
const settingsOf = (c) => ({ get: () => c, defaultProvider: () => c.defaultProvider })
const usableAll = { claude: { usable: true }, gemini: { usable: true } }
const baseCtx = ({ settings = cfg, resolve = () => caller, state = usableAll, depth = 0, starts = 0 } = {}) => ({
  settings: settingsOf(settings),
  resolveSession: resolve,
  providerStatus: (id) => state[id] || { usable: false, why: 'unknown' },
  knownProjects: () => ['/work/proj'],
  launches: { depth: () => depth, count: ({ parentAgentId } = {}) => (parentAgentId ? starts : 0) },
})
const input = (over = {}) => ({ session: 'claude:s1', provider: 'gemini', prompt: 'do it', cwd: '/work/proj', ...over })
const check = (i, c) => outcome(() => mod.checkAgentStart(i, c))

test('parseAgentStart: a valid body parses with provider, prompt and cwd', opts, async () => {
  const r = await outcome(() => mod.parseAgentStart({ session: 's', provider: 'gemini', prompt: 'hi', cwd: '/a' }))
  assert.equal(r.rejected, false)
})
test('parseAgentStart: missing prompt is rejected', opts, async () => {
  const r = await outcome(() => mod.parseAgentStart({ session: 's', provider: 'gemini' }))
  assert.equal(r.rejected, true)
})
test('parseAgentStart: non-object body is rejected', opts, async () => {
  for (const b of [null, 'x', 5, []]) assert.equal((await outcome(() => mod.parseAgentStart(b))).rejected, true)
})
test('parseAgentStart: unknown provider and codex are rejected', opts, async () => {
  for (const p of ['nope', 'codex']) {
    const r = await outcome(() => mod.parseAgentStart({ session: 's', provider: p, prompt: 'hi' }))
    assert.equal(r.rejected, true, p)
  }
})
test('checkAgentStart: happy path is accepted', opts, async () => {
  assert.equal((await check(input(), baseCtx())).rejected, false)
})
test('guard: agentStarts.enabled=false is a 4xx', opts, async () => {
  const s = { ...cfg, agentStarts: { ...cfg.agentStarts, enabled: false } }
  const r = await check(input(), baseCtx({ settings: s }))
  assert.equal(r.rejected, true)
  if (typeof r.status === 'number') assert.ok(r.status >= 400 && r.status < 500)
})
test('guard: caller that does not resolve is a 4xx', opts, async () => {
  const r = await check(input(), baseCtx({ resolve: () => null }))
  assert.equal(r.rejected, true)
})
test('guard: a subagent caller is a 4xx', opts, async () => {
  const sub = { ...caller, kind: 'subagent', isSubagent: true }
  assert.equal((await check(input(), baseCtx({ resolve: () => sub }))).rejected, true)
})
test('guard: cwd outside the caller cwd and known projects is a 4xx', opts, async () => {
  assert.equal((await check(input({ cwd: '/etc' }), baseCtx())).rejected, true)
})
test('guard: cwd inside the caller cwd is accepted', opts, async () => {
  assert.equal((await check(input({ cwd: '/work/proj/sub' }), baseCtx())).rejected, false)
})
test('guard: a ../ escape from the caller cwd is a 4xx', opts, async () => {
  assert.equal((await check(input({ cwd: '/work/proj/../other' }), baseCtx())).rejected, true)
})
test('guard: unusable target provider is a 4xx', opts, async () => {
  const st = { claude: { usable: true }, gemini: { usable: false, why: 'not found' } }
  assert.equal((await check(input(), baseCtx({ state: st }))).rejected, true)
})
test('guard: start depth at maxDepth is a 4xx', opts, async () => {
  assert.equal((await check(input(), baseCtx({ depth: 3 }))).rejected, true)
})
test('guard: depth under maxDepth is accepted', opts, async () => {
  assert.equal((await check(input(), baseCtx({ depth: 2 }))).rejected, false)
})
test('guard: perHour reached for the caller is a 4xx', opts, async () => {
  assert.equal((await check(input(), baseCtx({ starts: 20 }))).rejected, true)
})
