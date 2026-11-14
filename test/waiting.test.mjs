// Adapted from Bot Crossing test/waiting.test.mjs (MIT, Jarren Rocks).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readWaitEvidence, currentWait, jobWaitEvidence, WAIT_TTL_MS } from '../server/waiting.mjs'

const now = Date.parse('2026-01-01T00:00:00.000Z') // fixed: a real clock's epoch-ms can contain "123"
const stamp = new Date(now).toISOString()
const claudeCall = (name, input = {}) => ({ type: 'assistant', timestamp: stamp, message: { content: [{ type: 'tool_use', id: 'call', name, input }] } })
const codexCall = (name, args = {}) => ({ type: 'response_item', timestamp: stamp, payload: { type: 'function_call', call_id: 'call', name, arguments: JSON.stringify(args) } })

test('explicit waits only, with fixed reasons that leak no arguments', () => {
  for (const [name, args, kind] of [['Agent', {}, 'subagent'], ['TaskOutput', { task_id: 'secret-id' }, 'task'],
    ['Bash', { command: 'gh run watch 123' }, 'external-job'], ['Bash', { command: 'gh pr checks 42 --watch' }, 'external-job']]) {
    const e = currentWait(readWaitEvidence([claudeCall(name, args)], 'claude-code'), now)
    assert.equal(e.kind, kind)
    assert.doesNotMatch(JSON.stringify(e), /secret-id|123/)
  }
  assert.equal(readWaitEvidence([codexCall('wait', { ids: ['a'] })], 'codex').kind, 'subagent')
  for (const [name, args] of [['Bash', { command: 'npm test' }], ['Bash', { command: 'gh run watch 1 & echo' }], ['Task', { run_in_background: true }]]) {
    assert.equal(readWaitEvidence([claudeCall(name, args)], 'claude-code'), null, name)
  }
  assert.equal(readWaitEvidence([claudeCall('AskUserQuestion')], 'claude-code').needsUser, true)
})

test('results, turn bookkeeping and errors clear tool waits; TTL is measured from the evidence', () => {
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } }
  for (const end of [result, { type: 'system', subtype: 'turn_duration' }, { type: 'system', subtype: 'api_error' }]) {
    assert.equal(readWaitEvidence([claudeCall('Task'), end], 'claude-code'), null)
  }
  const e = readWaitEvidence([claudeCall('Task')], 'claude-code')
  assert.ok(currentWait(e, now))
  assert.equal(currentWait(e, now + WAIT_TTL_MS), null)
})

test('scheduler waits: in-flight agents, reported CI/agent waits; never approvals, stale or queued', () => {
  const state = { state: 'working', tempo: 'idle', updatedAt: stamp, inFlight: { tasks: 1, queued: 0, kinds: ['local_agent'] } }
  assert.equal(jobWaitEvidence(state, now).source, 'harness-in-flight')
  const ci = { ...state, detail: 'waiting on #12 CI and merges', inFlight: { tasks: 0, queued: 0, kinds: [] } }
  assert.deepEqual([jobWaitEvidence(ci, now).kind, jobWaitEvidence(ci, now).reason], ['external-job', 'Agent reports waiting for CI or checks'])
  assert.equal(jobWaitEvidence({ ...ci, detail: 'Waiting for other agents to finish' }, now).kind, 'subagent')
  for (const detail of ['waiting for your approval on CI', 'Next I will wait for CI']) assert.equal(jobWaitEvidence({ ...ci, detail }, now), null)
  for (const patch of [{ state: 'done' }, { tempo: 'active' }, { inFlight: { tasks: 1, queued: 1, kinds: ['local_agent'] } }]) {
    assert.equal(jobWaitEvidence({ ...state, ...patch }, now), null)
  }
  assert.equal(jobWaitEvidence(state, now + WAIT_TTL_MS), null)
})

test('blocked or done jobs whose own status reports a wait on CI, another agent, a merge or a schedule are waiting, not needs-you', () => {
  const at = (detail, st = 'blocked') => jobWaitEvidence({ state: st, tempo: st === 'blocked' ? 'blocked' : 'idle', updatedAt: stamp, detail }, now)
  assert.equal(at('PR #7251 all 25 checks green; handed to Big Boss to land', 'done').reason, 'Agent reports waiting on another agent')
  assert.equal(at('final evidence ready; awaiting relay to Big Boss').reason, 'Agent reports waiting on another agent')
  assert.equal(at('waiting for CI on #7140').reason, 'Agent reports waiting for CI or checks')
  assert.equal(at('pushes paused until release PR to main merges', 'done').reason, 'Agent reports waiting for a merge')
  assert.equal(at("PR #7287 ready; tonight's dry run set for 21:00 UTC", 'done').reason, 'Agent reports a scheduled step')
  // Anything addressed to the user still needs the user.
  for (const d of ['PR #7033 CI green, lint clean; awaiting your merge', 'awaiting 3 decisions: check cap', 'awaiting approval for prod check']) {
    assert.deepEqual(at(d), { needsUser: true }, d)
  }
  assert.equal(at('PR merged, all done', 'done'), null, 'a done job with nothing pending reports no wait')
})

test('usage limits read as a red usage limit with the reset time, never the rest of the message', async () => {
  const { usageLimitReason } = await import('../server/claude-code.mjs')
  assert.equal(usageLimitReason("You've hit your weekly limit · resets Oct 28 at 7am (America/New_York)"), 'Usage limit · resets Oct 28 at 7am')
  assert.equal(usageLimitReason("You've hit your session limit · resets 3pm"), 'Usage limit · resets 3pm')
  assert.equal(usageLimitReason('Usage limit reached'), 'Usage limit reached')
  assert.equal(usageLimitReason('waiting for CI'), '')
})

test('an agent-reported wait stays a wait while its status is unchanged (hours later), until the 24 h limit', () => {
  const hours = (h) => now - h * 3600e3
  const at = (st, tempo, h, detail) => jobWaitEvidence({ state: st, tempo, updatedAt: new Date(hours(h)).toISOString(), detail }, now)
  assert.equal(at('blocked', 'blocked', 7, 'final evidence ready; awaiting relay to Big Boss').reason, 'Agent reports waiting on another agent')
  assert.equal(at('working', 'idle', 1, '#7331 ready; waiting on Big Boss EXPLAIN for 10-24 plan').reason, 'Agent reports waiting on another agent')
  assert.deepEqual(at('blocked', 'blocked', 25, 'awaiting relay to Big Boss'), { needsUser: true }, 'past 24 h it is no longer trusted')
})

test('live jobs: a wakeup set, or background work in flight even with a message queued, is a wait; not once the process is gone', () => {
  const now = Date.parse('2026-10-28T21:55:00Z')
  const base = { state: 'working', tempo: 'idle', updatedAt: new Date(now - 60_000).toISOString(), detail: 'closure numbers due at the check' }
  const wake = { ...base, inFlight: { tasks: 1, queued: 0, kinds: ['session_cron'], wake: { at: now + 90 * 60e3, fires: 1 } } }
  const w = jobWaitEvidence(wake, now, { live: true })
  assert.equal(w.source, 'harness-wake')
  assert.match(w.reason, /^Scheduled to check back at \d\d:\d\d$/)
  assert.ok(currentWait(w, now + 80 * 60e3), 'holds until the wakeup')
  assert.equal(jobWaitEvidence({ ...wake, inFlight: { ...wake.inFlight, wake: { at: now - 60e3 } } }, now, { live: true })?.source, undefined, 'a wakeup in the past proves nothing')
  const bash = { ...base, inFlight: { tasks: 2, queued: 1, kinds: ['local_bash'] } }
  assert.equal(jobWaitEvidence(bash, now, { live: true }).reason, 'Waiting for background work')
  assert.ok(currentWait(jobWaitEvidence(bash, now + 2 * 3600e3, { live: true }), now + 2 * 3600e3), 'a long CI watch is still a wait')
  for (const s of [wake, bash]) assert.equal(jobWaitEvidence(s, now, { live: false }), null, 'not running: no proof of a wait')
})

test('any other wait an agent reports is a wait; anything for the user still is not', () => {
  const at = (detail) => jobWaitEvidence({ state: 'working', tempo: 'idle', updatedAt: new Date(Date.now() - 60e3).toISOString(), detail }, Date.now())?.reason
  assert.equal(at('schema pass 2 queued behind the shared lock; then review'), 'Agent reports waiting on other work')
  assert.equal(at('PR #7818 open; next batch waiting on the Q3 numbers'), 'Agent reports waiting on other work')
  assert.equal(at('waiting on your go for the deploy'), undefined)
  assert.equal(at('Inserting tables, adding triggers'), undefined)
})

test('a blocked job asking for something (needs set, or "go-aheads") is not read as waiting', () => {
  const now = Date.now(), updatedAt = new Date(now - 60e3).toISOString()
  assert.deepEqual(jobWaitEvidence({ state: 'blocked', tempo: 'blocked', updatedAt, detail: 'batch 1 ready; awaiting flag go-aheads' }, now), { needsUser: true })
  assert.deepEqual(jobWaitEvidence({ state: 'blocked', tempo: 'blocked', updatedAt, detail: 'queued behind the lock', needs: 'Decide the cap' }, now), { needsUser: true })
})
