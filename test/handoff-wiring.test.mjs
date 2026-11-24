// P16 wiring: a crash between target.run() and the engine's `started` save must not cause a second start.
// The handoff-refs ledger links the new agent's ref to the hid; annotate() puts handoffId back on the scan.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandoffs } from '../server/handoff.mjs'
import { buildNote, notePrompt } from '../server/handoff-note.mjs'
import { createHandoffRefs } from '../server/handoff-refs.mjs'

const OLD = { id: 'claude:old1', provider: 'claude', harness: 'claude-code', kind: 'job', jobId: 'abcd1234', live: true, cwd: os.tmpdir(), name: 'old', bucket: 'building' }

function fakes(runs) {
  const target = {
    id: 'gemini', label: 'Gemini', capabilities: { start: true, handoffTarget: true },
    options: () => ({ promptMax: 8000 }),
    startPlan: (body) => ({ kind: 'start', provider: 'gemini', args: [], cwd: body.cwd, env: body.env, name: body.name }),
    run: async (plan) => { runs.push(plan); return { ok: true, ref: { runId: `r${runs.length}` } } },
    stopPlan: () => ({ kind: 'stop' }), activity: async () => 'idle', readTranscript: async () => [],
  }
  const source = { ...target, id: 'claude', label: 'Claude', run: async () => ({ ok: true }), activity: async () => 'limit',
    stopPlan: (a) => ({ kind: 'stop', id: a.id }) }
  return { gemini: target, claude: source }
}

test('restart after a crash between run() and the started save adopts the new agent; no second start', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agv-p16-'))
  const settings = { get: () => ({ defaultProvider: 'claude', providerOrder: ['claude', 'gemini'], handoff: { mode: 'auto', maxHops: 2 } }) }
  const providerState = () => ({ claude: { usable: false, exhausted: null }, gemini: { usable: true, exhausted: null } })
  const deps = (getProvider, agents) => ({ dataDir, getProvider, settings, agents, providerState, buildNote, notePrompt,
    sleep: async () => {}, pollMs: 0, staggerMs: 0, appearMaxMs: 0 })

  // Boot 1: the handoff starts the new agent through the wrapped adapter.
  const runs1 = []
  const ad1 = fakes(runs1)
  const refs1 = createHandoffRefs({ dataDir })
  const h1 = createHandoffs(deps(refs1.wrap((id) => ad1[id]), async () => [OLD]))
  const rec = await h1.start(OLD.id, { to: 'gemini' })
  await h1.idle()
  assert.equal(runs1.length, 1)
  assert.equal(runs1[0].env.AGENTVILLE_HANDOFF_ID, rec.id)

  // Simulate the crash: on disk the record is still `starting` with no ref (the started save never landed).
  const file = path.join(dataDir, 'handoffs.json')
  const db = JSON.parse(fs.readFileSync(file, 'utf8'))
  const r = db.records[rec.id]
  r.state = 'starting'; delete r.to.ref; delete r.to.refs; delete r.to.agentId; delete r.startedAt; delete r.stopAttemptAt
  fs.writeFileSync(file, JSON.stringify(db))

  // Boot 2: the scan shows the new agent without handoffId; the refs ledger restores it.
  const runs2 = []
  const ad2 = fakes(runs2)
  const refs2 = createHandoffRefs({ dataDir })
  const scanned = () => refs2.annotate([{ ...OLD, live: false }, { id: 'gemini:r1', provider: 'gemini', harness: 'gemini-cli', kind: 'session', runId: 'r1', live: true, cwd: OLD.cwd }])
  const h2 = createHandoffs(deps(refs2.wrap((id) => ad2[id]), async () => scanned()))
  await h2.tick()
  await h2.idle()
  assert.equal(runs2.length, 0, 'no second start')
  const after = h2.get(rec.id)
  assert.ok(['started', 'stopping', 'done'].includes(after.state), after.state)
  assert.equal(after.to.ref, 'r1')
})

test('annotate maps refs and provider-prefixed ids; unknown refs stay unannotated', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agv-p16-'))
  const refs = createHandoffRefs({ dataDir })
  refs.record('deadbeef', '0123456789abcdef')
  refs.record('bad', 'not-a-hid')
  const list = refs.annotate([{ id: 'claude-code:x', jobId: 'deadbeef' }, { id: 'gemini:deadbeef' }, { id: 'z', jobId: 'bad' }])
  assert.deepEqual(list.map((a) => a.handoffId || null), ['0123456789abcdef', '0123456789abcdef', null])
  assert.equal((fs.statSync(path.join(dataDir, 'handoff-refs.json')).mode & 0o777), 0o600)
})
