import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandoffs, handoffId, orderChildrenFirst, problem } from '../server/handoff.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agv-handoff-'))

/** A fake world: agents, two fake adapters, provider state and a fake clock. */
function world({ dataDir = tmp(), mode = 'auto', maxHops = 2 } = {}) {
  const w = {
    dataDir, t: 1_000_000, agents: [], calls: [], logs: [], launches: [], reparents: [],
    activity: {}, // agentId -> array of activities to return in turn (last one repeats)
    transcript: {},
    appear: true, startOk: true, stopOk: true, resumeOk: true, nextRef: 1, neverStarted: false,
    state: { claude: { usable: false, exhausted: { since: 1_000_000, until: null } }, gemini: { usable: true, exhausted: null } },
    settings: { defaultProvider: 'claude', providerOrder: ['claude', 'gemini'], handoff: { mode, maxHops } },
  }
  const mk = (id, label) => ({
    id, label, capabilities: { start: true, stop: true, resume: true, handoffTarget: true },
    options: () => ({ promptMax: 4000 }),
    async activity(a) { const q = w.activity[a.id] || ['idle']; return q.length > 1 ? q.shift() : q[0] },
    async readTranscript(a) { return w.transcript[a.id] || [{ role: 'user', at: 1, text: 'fix the bug' }] },
    startPlan(body) { return { kind: 'start', provider: id, ...body } },
    stopPlan(a) { return { kind: 'stop', provider: id, id: a.id } },
    resumePlan(a, { prompt }) { return { kind: 'resume', provider: id, id: a.id, prompt } },
    async run(plan) {
      w.calls.push(plan)
      if (plan.kind === 'start') {
        if (!w.startOk) return { ok: false, error: 'nope' }
        const ref = `run${w.nextRef++}`
        if (w.appear) w.agents.push({ id: `${id}:${ref}`, provider: id, kind: 'job', jobId: ref, live: true, name: plan.name, cwd: plan.cwd, neverStarted: w.neverStarted })
        return { ok: true, ref: { runId: ref } }
      }
      if (plan.kind === 'stop') {
        if (!w.stopOk) return { ok: false }
        const a = w.agents.find((x) => x.id === plan.id); if (a) a.live = false
        return { ok: true }
      }
      if (plan.kind === 'resume') return { ok: w.resumeOk }
      return { ok: false }
    },
  })
  w.adapters = { claude: mk('claude', 'Claude'), gemini: mk('gemini', 'Gemini') }
  w.opts = {
    dataDir,
    getProvider: (id) => w.adapters[id],
    settings: { get: () => w.settings },
    agents: async () => w.agents.map((a) => ({ ...a })),
    providerState: async () => JSON.parse(JSON.stringify(w.state)),
    buildNote: (events, changes, meta) => `# Note\nTask: ${events.find((e) => e.role === 'user')?.text || ''}\n` +
      `interrupted: ${meta.interrupted?.tool || '-'}\nchildren: ${(meta.children || []).map((c) => `${c.oldId}->${c.newId}`).join(',')}\n` +
      `subagents: ${(meta.subagents || []).map((s) => s.description).join(',')}\nquestions: ${(meta.questions || []).join('|')}\n`,
    notePrompt: (note, max, { notePath } = {}) => `PREAMBLE ${notePath}\n${note}`.slice(0, max - 500),
    readChanges: async () => ({ files: [] }),
    launches: { record: (e) => w.launches.push(e), reparent: (a, b) => w.reparents.push([a, b]) },
    log: (e) => w.logs.push(e),
    now: () => w.t,
    sleep: async (ms) => { w.t += ms },
  }
  w.make = (extra = {}) => createHandoffs({ ...w.opts, ...extra })
  w.starts = () => w.calls.filter((c) => c.kind === 'start')
  w.stops = () => w.calls.filter((c) => c.kind === 'stop')
  return w
}

const job = (id, extra = {}) => ({ id, provider: 'claude', harness: 'claude-code', kind: 'job', jobId: id.split(':')[1], live: true, name: `name-${id}`, cwd: '/w/p', ...extra })
const run = async (h) => { await h.tick(); await h.idle() }

test('handoffId: 16 hex chars from sha256(agentId + episodeId)', () => {
  assert.match(handoffId('claude:a', 'claude-1'), /^[0-9a-f]{16}$/)
  assert.equal(handoffId('claude:a', 'claude-1'), handoffId('claude:a', 'claude-1'))
  assert.notEqual(handoffId('claude:a', 'claude-1'), handoffId('claude:a', 'claude-2'))
})

test('happy path: wait, note, start, confirm, then stop the old agent', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  const h = w.make()
  await run(h)
  const [r] = h.list()
  assert.equal(r.state, 'done')
  assert.equal(r.id, handoffId('claude:j1', 'claude-1000000'))
  assert.deepEqual(r.chain, ['claude', 'gemini'])
  assert.equal(r.to.agentId, 'gemini:run1')
  const [s] = w.starts()
  assert.equal(s.provider, 'gemini')
  assert.equal(s.cwd, '/w/p')
  assert.equal(s.name, 'name-claude:j1 (from Claude)')
  assert.deepEqual(s.env, { AGENTVILLE_AGENT_ID: r.id, AGENTVILLE_HANDOFF_ID: r.id })
  assert.match(s.prompt, /fix the bug/)
  assert.ok(s.prompt.includes(r.notePath))
  // stop came after the start was confirmed
  assert.deepEqual(w.calls.map((c) => c.kind), ['start', 'stop'])
  assert.equal(w.stops()[0].id, 'claude:j1')
  // files: ledger + note, both 0600
  const file = path.join(w.dataDir, 'handoffs.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.records[r.id].state, 'done')
  assert.equal(saved.episodes.claude.id, 'claude-1000000')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(r.notePath).mode & 0o777, 0o600)
  assert.match(fs.readFileSync(r.notePath, 'utf8'), /Task: fix the bug/)
  assert.deepEqual(w.launches, [{ ref: 'run1', parentAgentId: null, provider: 'gemini', via: 'handoff' }])
  // account-log: one line on done, ids only
  assert.equal(w.logs.filter((l) => l.action === 'handoff').length, 1)
  assert.ok(!JSON.stringify(w.logs).includes('fix the bug'))
  // annotations and covers
  assert.deepEqual(h.annotate('claude:j1').handoff.toAgentId, 'gemini:run1')
  assert.equal(h.annotate('gemini:run1').handedOffFrom.fromAgentId, 'claude:j1')
  assert.equal(h.covers('claude:j1'), true)
})

test('de-dupe: repeated ticks and a manual handoff during an auto one join the same record', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.activity['claude:j1'] = ['busy', 'busy', 'busy', 'idle']
  const h = w.make()
  await h.tick(); await h.tick()
  const joined = await h.start('claude:j1', {})
  await h.idle(); await run(h)
  assert.equal(h.list().length, 1)
  assert.equal(joined.id, h.list()[0].id)
  assert.equal(w.starts().length, 1)
})

test('who is handed off: top-level live (or limit-stopped this episode) agents of the exhausted provider only', () => {
  const ctx = { provider: 'claude', since: 1_000_000, selfId: 'claude:self' }
  assert.equal(problem(job('claude:a'), ctx), '')
  assert.equal(problem({ ...job('claude:a'), kind: 'subagent' }, ctx), 'sub-agent')
  assert.equal(problem({ ...job('claude:a'), hidden: true }, ctx), 'hidden')
  assert.equal(problem(job('claude:self'), ctx), 'self')
  assert.equal(problem({ ...job('claude:a'), neverStarted: true }, ctx), 'never started')
  assert.equal(problem({ ...job('gemini:a'), provider: 'gemini' }, ctx), 'other provider')
  assert.equal(problem({ ...job('claude:a'), live: false, limitStop: { at: 1_000_000 - 60_000, kind: 'limit' } }, ctx), '')
  assert.equal(problem({ ...job('claude:a'), live: false, limitStop: { at: 1_000_000 - 3600_000, kind: 'limit' } }, ctx), 'not running')
  assert.equal(problem({ ...job('claude:a'), live: false }, ctx), 'not running')
})

test('turn boundary: waits while busy, then marks the running tool as interrupted after the max wait', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.activity['claude:j1'] = ['busy']
  w.transcript['claude:j1'] = [{ role: 'user', at: 1, text: 'go' }, { role: 'tool', at: 2, tool: { name: 'Bash', files: [], done: false } }]
  const t0 = w.t
  const h = w.make({ idleMaxMs: 30_000, pollMs: 3000 })
  await run(h)
  const [r] = h.list()
  assert.equal(r.state, 'done')
  assert.deepEqual(r.interrupted, { tool: 'Bash' })
  assert.ok(w.t - t0 >= 30_000)
  assert.match(fs.readFileSync(r.notePath, 'utf8'), /interrupted: Bash/)
})

test('a dialog continues at once and the note records the question', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.activity['claude:j1'] = ['dialog']
  w.transcript['claude:j1'] = [{ role: 'user', at: 1, text: 'go' }, { role: 'assistant', at: 2, text: 'Should I delete the table?' }]
  const h = w.make()
  await run(h)
  assert.match(fs.readFileSync(h.list()[0].notePath, 'utf8'), /questions: Should I delete the table\?/)
})

test('the target is also out before starting: cancelled, nothing started or stopped, usage-pause covers it', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.activity['claude:j1'] = ['busy', 'idle']
  const h = w.make()
  await h.tick()
  w.state.gemini.usable = false
  await h.idle()
  const [r] = h.list()
  assert.equal(r.state, 'cancelled')
  assert.equal(r.error, 'no provider has room')
  assert.equal(w.calls.length, 0)
  assert.equal(h.covers('claude:j1'), false)
})

test('no target at all: no record is made', async () => {
  const w = world()
  w.state.gemini.usable = false
  w.agents.push(job('claude:j1'))
  const h = w.make()
  await run(h)
  assert.equal(h.list().length, 0)
})

test('the source recovers while waiting: cancelled', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.activity['claude:j1'] = ['busy', 'busy', 'busy', 'idle']
  const h = w.make()
  await h.tick()
  w.state.claude = { usable: true, exhausted: null }
  await h.idle()
  assert.equal(h.list()[0].state, 'cancelled')
  assert.equal(h.list()[0].error, 'source recovered')
  assert.equal(w.calls.length, 0)
})

test('start succeeds but the agent never appears: failed, old agent kept, one automatic retry, then the user decides', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.appear = false
  const h = w.make()
  await run(h)
  let [r] = h.list()
  assert.equal(r.state, 'failed')
  assert.equal(r.attempts, 1)
  assert.equal(w.stops().length, 0)
  await run(h) // too early to retry
  assert.equal(w.starts().length, 1)
  w.t += 120_000
  await run(h)
  ;[r] = h.list()
  assert.equal(w.starts().length, 2)
  assert.equal(r.state, 'failed')
  assert.equal(r.attempts, 2)
  w.t += 600_000
  await run(h)
  assert.equal(w.starts().length, 2, 'no third start without the user')
  w.appear = true
  await h.retry(r.id); await h.idle()
  assert.equal(h.get(r.id).state, 'done')
})

test('a retry adopts an earlier start that showed up late instead of starting again', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.appear = false
  const h = w.make()
  await run(h)
  w.agents.push({ id: 'gemini:run1', provider: 'gemini', kind: 'job', jobId: 'run1', live: true })
  w.t += 120_000
  await run(h)
  assert.equal(w.starts().length, 1)
  assert.equal(h.list()[0].state, 'done')
  assert.equal(h.list()[0].to.agentId, 'gemini:run1')
})

test('the new agent shows up as neverStarted: failed, old agent not stopped', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.neverStarted = true
  const h = w.make()
  await run(h)
  assert.equal(h.list()[0].state, 'failed')
  assert.equal(h.list()[0].error, 'the new agent never started')
  assert.equal(w.stops().length, 0)
})

test('start refused: failed, nothing stopped', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.startOk = false
  const h = w.make()
  await run(h)
  assert.equal(h.list()[0].state, 'failed')
  assert.equal(w.stops().length, 0)
})

test('stop fails: done with a warning, no blind retry', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.stopOk = false
  const h = w.make()
  await run(h); await run(h)
  assert.equal(h.list()[0].state, 'done')
  assert.equal(h.list()[0].warning, 'old agent still running')
  assert.equal(w.stops().length, 1)
})

test('an interactive session is not stopped: done with "close the old terminal"', async () => {
  const w = world()
  w.agents.push({ id: 'claude:s1', provider: 'claude', kind: 'session', live: true, name: 's', cwd: '/w' })
  const h = w.make()
  await run(h)
  assert.equal(h.list()[0].state, 'done')
  assert.equal(h.list()[0].note, 'close the old terminal')
  assert.equal(w.stops().length, 0)
})

test('lead with children: children first, the lead note maps old -> new ids, subagents listed not handed off', async () => {
  const w = world()
  w.agents.push(job('claude:lead'))
  w.agents.push(job('claude:kid', { parentId: 'claude:lead' }))
  w.agents.push({ id: 'claude:lead:sub:1', provider: 'claude', kind: 'subagent', parentId: 'claude:lead', live: true, name: 'run the tests' })
  w.activity['claude:kid'] = ['busy', 'busy', 'idle']
  const h = w.make()
  await run(h)
  assert.equal(h.list().length, 2)
  const starts = w.starts()
  assert.match(starts[0].name, /^name-claude:kid/)
  assert.match(starts[1].name, /^name-claude:lead/)
  const lead = h.list().find((r) => r.from.agentId === 'claude:lead')
  const note = fs.readFileSync(lead.notePath, 'utf8')
  assert.match(note, /children: claude:kid->gemini:run1/)
  assert.match(note, /subagents: run the tests/)
  assert.deepEqual(w.launches.find((l) => l.ref === 'run1').parentAgentId, 'claude:lead')
  assert.ok(w.reparents.some(([a, b]) => a === 'claude:lead' && b === 'gemini:run2'))
})

test('orderChildrenFirst: deepest first, stable otherwise', () => {
  const l = [{ id: 'a' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'd' }]
  assert.deepEqual(orderChildrenFirst(l).map((x) => x.id), ['c', 'b', 'a', 'd'])
})

test('at most 2 at once, 2 s apart', async () => {
  const w = world()
  for (const n of [1, 2, 3]) w.agents.push(job(`claude:j${n}`))
  let running = 0; let peak = 0
  const base = w.adapters.claude.activity
  w.adapters.claude.activity = async (a) => { running++; peak = Math.max(peak, running); await new Promise((r) => setImmediate(r)); running--; return base(a) }
  const h = w.make()
  await run(h)
  assert.ok(peak <= 2)
  assert.equal(h.list().filter((r) => r.state === 'done').length, 3)
})

test('maxHops bounds ping-pong per lineage', async () => {
  const w = world({ maxHops: 1 })
  w.agents.push(job('claude:j1'))
  const h = w.make()
  await run(h)
  assert.equal(h.list()[0].state, 'done')
  // now Gemini runs out too; Claude has room again
  w.state = { claude: { usable: true, exhausted: null }, gemini: { usable: false, exhausted: { since: w.t, until: null } } }
  await run(h)
  assert.equal(h.list().length, 1, 'the handed-off agent is not handed back automatically')
  // with maxHops 2 it would go back
  w.settings.handoff.maxHops = 2
  await run(h)
  assert.equal(h.list().length, 2)
  assert.ok(h.list().some((r) => r.chain.join() === 'claude,gemini,claude' && r.from.agentId === 'gemini:run1'))
})

test('restart mid-flow: "starting" without a ref finds the agent carrying the hid instead of starting again', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  const hid = handoffId('claude:j1', 'claude-1000000')
  const rec = {
    id: hid, episode: 'claude-1000000', chain: ['claude', 'gemini'],
    from: { agentId: 'claude:j1', provider: 'claude', kind: 'job', jobId: 'j1', cwd: '/w/p', name: 'n', parentAgentId: null },
    to: { provider: 'gemini' }, state: 'starting', attempts: 0, createdAt: w.t, updatedAt: w.t, notePath: '/nowhere.md',
  }
  fs.writeFileSync(path.join(w.dataDir, 'handoffs.json'), JSON.stringify({ version: 1, episodes: { claude: { id: 'claude-1000000', since: 1_000_000, until: null } }, records: { [hid]: rec } }))
  w.agents.push({ id: 'gemini:runX', provider: 'gemini', kind: 'job', runId: 'runX', live: true, handoffId: hid })
  const h = w.make()
  await run(h)
  assert.equal(w.starts().length, 0)
  assert.equal(h.get(hid).state, 'done')
  assert.equal(h.get(hid).to.agentId, 'gemini:runX')

  // the same record with no such agent: started exactly once
  const w2 = world()
  w2.agents.push(job('claude:j1'))
  fs.writeFileSync(path.join(w2.dataDir, 'handoffs.json'), JSON.stringify({ version: 1, episodes: {}, records: { [hid]: rec } }))
  const h2 = w2.make()
  await run(h2); await run(h2)
  assert.equal(w2.starts().length, 1)
  assert.equal(h2.get(hid).state, 'done')
})

test('restart mid-wait: the idle clock keeps its persisted start time', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.activity['claude:j1'] = ['busy']
  const hid = handoffId('claude:j1', 'claude-1000000')
  const rec = {
    id: hid, episode: 'claude-1000000', chain: ['claude', 'gemini'],
    from: { agentId: 'claude:j1', provider: 'claude', kind: 'job', jobId: 'j1', cwd: '/w/p', name: 'n', parentAgentId: null },
    to: { provider: 'gemini' }, state: 'waiting_idle', waitSince: w.t - 57_000, attempts: 0, createdAt: w.t, updatedAt: w.t,
  }
  fs.writeFileSync(path.join(w.dataDir, 'handoffs.json'), JSON.stringify({ version: 1, episodes: {}, records: { [hid]: rec } }))
  const t0 = w.t
  const h = w.make({ idleMaxMs: 60_000 })
  await run(h)
  assert.ok(w.t - t0 <= 6000, `waited ${w.t - t0} ms`)
  assert.equal(h.get(hid).state, 'done')
  assert.deepEqual(h.get(hid).interrupted, { tool: 'tool' })
  assert.equal(w.starts().length, 1)
})

test('undo: stops the new agent and resumes the old one with the note path; files untouched', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  const h = w.make()
  await run(h)
  const r = h.list()[0]
  const u = await h.undo(r.id)
  assert.equal(u.state, 'undone')
  const tail = w.calls.slice(-2)
  assert.deepEqual(tail.map((c) => [c.kind, c.provider, c.id]), [['stop', 'gemini', 'gemini:run1'], ['resume', 'claude', 'claude:j1']])
  assert.ok(tail[1].prompt.includes(r.notePath))
  assert.match(tail[1].prompt, /Gemini agent/)
  assert.equal(h.covers('claude:j1'), false)
  await assert.rejects(h.undo(r.id), (e) => e.status === 409)
})

test('undo only from started or done', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.startOk = false
  const h = w.make()
  await run(h)
  await assert.rejects(h.undo(h.list()[0].id), (e) => e.status === 409)
})

test('ask mode: records wait for approval; approve runs one', async () => {
  const w = world({ mode: 'ask' })
  w.agents.push(job('claude:j1'))
  const h = w.make()
  await run(h); await run(h)
  const [r] = h.list()
  assert.equal(r.state, 'planned')
  assert.equal(r.awaiting, 'approval')
  assert.equal(w.calls.length, 0)
  await h.approve(r.id); await h.idle()
  assert.equal(h.get(r.id).state, 'done')
})

test('mode off: nothing happens', async () => {
  const w = world({ mode: 'off' })
  w.agents.push(job('claude:j1'))
  const h = w.make()
  await run(h)
  assert.equal(h.list().length, 0)
})

test('manual hand-back with no episode: a fresh record in the other direction', async () => {
  const w = world()
  w.state = { claude: { usable: true, exhausted: null }, gemini: { usable: true, exhausted: null } }
  w.agents.push({ id: 'gemini:r9', provider: 'gemini', kind: 'job', runId: 'r9', live: true, name: 'g', cwd: '/w' })
  const h = w.make()
  const r = await h.start('gemini:r9', { to: 'claude' }); await h.idle()
  assert.equal(h.get(r.id).state, 'done')
  assert.equal(w.starts()[0].provider, 'claude')
  assert.match(w.starts()[0].name, /\(from Gemini\)$/)
  await assert.rejects(h.start('gemini:r9', { to: 'codex' }), (e) => e.status === 409)
})

test('dismiss: a failed record stays failed and is not retried', async () => {
  const w = world()
  w.agents.push(job('claude:j1'))
  w.appear = false
  const h = w.make()
  await run(h)
  await h.dismiss(h.list()[0].id)
  w.t += 600_000
  await run(h)
  assert.equal(w.starts().length, 1)
  assert.equal(h.list()[0].dismissed, true)
})
