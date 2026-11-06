// The desktop-notification differ (web/src/notify.js) on snapshot fixtures: which transitions
// notify, with per-agent tags and one key per event, and what never does.
import test from 'node:test'
import assert from 'node:assert/strict'
import { transitions } from '../web/src/notify.js'

const ALL = { input: true, finished: true, checks: true }
const pr = (failed, extra = {}) => ({ id: '101', href: 'https://github.com/example/demo-app/pull/101', state: 'open', checks: { passed: 3, failed, pending: 0 }, review: null, ...extra })
const agent = (o) => ({ id: 'a', name: 'API Lead', project: 'demo-app', bucket: 'building', reason: '', severity: null, prompt: null, since: 1, prs: [], ask: null, hidden: false, ...o })
const snap = (...xs) => xs.map(agent)

test('needs your input: once when it starts, with its question; a click prompt and errors are not this', () => {
  const before = snap({})
  const asked = snap({ bucket: 'stalled', reason: 'Needs your input', severity: 'attention', since: 5, ask: { needs: 'Pick knex or prisma?', suggestedReply: '' } })
  const [n, ...rest] = transitions(before, asked, ALL)
  assert.equal(rest.length, 0)
  assert.deepEqual(n, { kind: 'input', id: 'a', key: 'input:a:5', tag: 'va-input:a', title: 'API Lead needs your input', body: 'Pick knex or prisma? · demo-app' })
  assert.deepEqual(transitions(asked, asked, ALL), [], 'still asking: nothing new')
  assert.deepEqual(transitions(before, snap({ bucket: 'stalled', reason: 'Needs a click: permission prompt', severity: 'attention', prompt: 'permission' }), ALL), [], 'the needs-a-click toggle covers that')
  assert.deepEqual(transitions(before, snap({ bucket: 'stalled', reason: 'API error (529)', severity: 'error' }), ALL), [])
  assert.equal(transitions(before, snap({ bucket: 'stalled', reason: 'Restarted mid-task: send "continue"', severity: 'attention' }), ALL)[0].kind, 'input')
})

test('finished: building → awaiting your reply, or → done; not from waiting, not a crash', () => {
  const building = snap({})
  const turn = transitions(building, snap({ bucket: 'stalled', reason: 'Turn finished — awaiting your reply', severity: 'attention', since: 9 }), ALL)
  assert.deepEqual(turn.map((x) => [x.kind, x.title, x.tag, x.key]), [['finished', 'API Lead finished its turn', 'va-finished:a', 'finished:a:9']])
  assert.equal(transitions(building, snap({ bucket: 'resting', reason: 'Done' }), ALL)[0].title, 'API Lead is done')
  assert.deepEqual(transitions(snap({ bucket: 'waiting', reason: 'Waiting on 2 agents' }), snap({ bucket: 'stalled', reason: 'Turn finished — awaiting your reply' }), ALL), [])
  assert.deepEqual(transitions(building, snap({ bucket: 'stalled', reason: 'Stopped unexpectedly', severity: 'error' }), ALL), [])
  assert.deepEqual(transitions(building, snap({ bucket: 'resting', reason: 'Closed' }), ALL), [])
})

test('PR checks: passing (or pending) → failing notifies once per PR; unknown before or still failing does not', () => {
  const ok = snap({ prs: [pr(0)] })
  const bad = snap({ prs: [pr(2)] })
  const [n] = transitions(ok, bad, ALL)
  assert.deepEqual([n.kind, n.title, n.tag, n.key, n.body], ['checks', 'PR #101 checks failing', 'va-checks:https://github.com/example/demo-app/pull/101', 'checks:https://github.com/example/demo-app/pull/101:2', '2 failed · API Lead · demo-app'])
  assert.deepEqual(transitions(bad, bad, ALL), [])
  assert.deepEqual(transitions(snap({ prs: [{ id: '101', href: pr(0).href }] }), bad, ALL), [], 'no status before: not a transition')
  assert.deepEqual(transitions(ok, snap({ prs: [pr(2, { state: 'merged' })] }), ALL), [], 'a merged PR is history')
})

test('toggles, new agents and hidden agents', () => {
  const before = snap({})
  const after = snap({ bucket: 'stalled', reason: 'Turn finished — awaiting your reply' })
  assert.deepEqual(transitions(before, after, { input: true, checks: true }), [], 'finished is off')
  assert.deepEqual(transitions([], after, ALL), [], 'nothing for agents first seen in this poll')
  assert.deepEqual(transitions(before, [{ ...after[0], hidden: true }], ALL), [])
  assert.deepEqual(transitions(null, after, ALL), [])
})
