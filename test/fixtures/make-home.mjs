#!/usr/bin/env node
/**
 * Synthetic fixture homes for tests and Playwright. Never real data.
 *
 *   node test/fixtures/make-home.mjs <dir>    # prints the env vars to point the server at it
 *
 * Writes <dir>/claude (AGENTVILLE_CLAUDE_HOME) and <dir>/codex (AGENTVILLE_CODEX_HOME), stamped
 * relative to `now` so every agent is fresh. Expected result is exported as EXPECTED.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const uuid = (n) => `${String(n).padStart(8, 'a')}-0000-4000-8000-000000000000`
export const IDS = {
  boss: uuid(1), leadBuilding: uuid(2), leadBlocked: uuid(3), leadCi: uuid(4), leadDone: uuid(5),
  soloTurn: uuid(6), soloWaiting: uuid(7), soloError: uuid(8), soloOld: uuid(9),
  codexRunning: uuid(10), codexTurn: uuid(11),
}
const short = (id) => id.slice(0, 8)
/** Sits in a job's providerEnv beside its model aliases; must never reach any API response. */
export const ENV_SECRET = 'sk-ant-oat01-FIXTUREPROVIDERTOKENdoNotLeak42'
/** What the Models view should find (see test/models.test.mjs and e2e/models.spec.mjs). */
export const MODELS = {
  boss: { now: 'claude-opus-5-5', flag: 'opus[1m]', env: 'claude-opus-5[1m]' }, // pinned older Opus: mismatch
  leadBuilding: { from: 'claude-opus-5', now: 'claude-opus-5-5', flag: 'claude-opus-5-5[1m]', ctx: 850_000 }, // switched, context 85%
  leadBlocked: { now: 'cc/claude-opus-5-5', flag: 'cc/claude-opus-5-5' }, // still on the pool
  leadCi: { now: 'claude-sonnet-5-5', flag: 'sonnet' },
  soloTurn: { now: 'claude-opus-5-5' }, // settings default opus[1m]
  soloWaiting: { now: 'claude-haiku-4-5-20251001' },
  worker: { now: 'claude-sonnet-5-5', requested: 'sonnet' },
  mate: { now: 'claude-opus-5-5', requested: 'inherit' },
  codexRunning: { now: 'gpt-6.1-sol', window: 272_000 },
}

/** What the blocked DB Lead asks for (job `needs`) and the scheduler's suggested reply. */
export const ASK = { needs: 'Pick the migration tool: knex or prisma?', suggestedReply: 'Use knex, matching the existing migrations.' }
/** Claude Code's PR status cache (`gh-pr-status-cache.json`), keyed by PR URL. */
export const PR_STATUS = {
  'https://github.com/example/demo-app/pull/101': { number: 101, title: '', state: 'OPEN', checks: { passed: 7, failed: 1, pending: 2 }, review: 'REVIEW_REQUIRED', additions: 412, deletions: 37 },
  'https://github.com/example/demo-app/pull/99': { number: 99, title: '', state: 'MERGED', checks: { passed: 9, failed: 0, pending: 0 }, review: 'APPROVED', additions: 20, deletions: 4 },
}

/** id -> expected { bucket, role } (Claude ids prefixed claude-code:, Codex codex:). */
export const EXPECTED = {
  [`claude-code:${IDS.boss}`]: { bucket: 'waiting', role: 'boss', reason: 'Waiting on 2 agents' },
  [`claude-code:${IDS.leadBuilding}`]: { bucket: 'building', role: 'lead' },
  [`claude-code:${IDS.leadBuilding}:sub:worker`]: { bucket: 'building', role: 'sub' },
  [`claude-code:${IDS.leadBuilding}:sub:mate`]: { bucket: 'waiting', role: 'sub', reason: 'Waiting on its lead' },
  [`claude-code:${IDS.leadBlocked}`]: { bucket: 'stalled', role: 'lead', reason: 'Needs your input' },
  [`claude-code:${IDS.leadCi}`]: { bucket: 'waiting', role: 'lead', reason: 'Agent reports waiting for CI or checks' },
  [`claude-code:${IDS.leadDone}`]: { bucket: 'resting', role: 'lead' },
  [`claude-code:${IDS.soloTurn}`]: { bucket: 'stalled', role: 'solo', reason: 'Turn finished — awaiting your reply' },
  [`claude-code:${IDS.soloWaiting}`]: { bucket: 'waiting', role: 'solo', reason: 'Waiting for a subagent to finish' },
  [`claude-code:${IDS.soloError}`]: { bucket: 'stalled', role: 'solo', reason: 'API error (529)' },
  [`claude-code:${IDS.soloOld}`]: { bucket: 'resting', role: 'solo' },
  [`codex:${IDS.codexRunning}`]: { bucket: 'building', role: 'solo' },
  [`codex:${IDS.codexTurn}`]: { bucket: 'stalled', role: 'solo' },
}

export function makeHome(root, now = Date.now()) {
  const iso = (agoMs) => new Date(now - agoMs).toISOString()
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
  }
  const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  const setMtime = (file, agoMs) => fs.utimesSync(file, new Date(now - agoMs), new Date(now - agoMs))
  const claude = path.join(root, 'claude')
  // Real folders inside the fixture root, so "Open" can succeed against the fake terminal.
  const cwd = path.join(root, 'work', 'demo-app')
  const codexCwd = path.join(root, 'work', 'codex-app')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(codexCwd, { recursive: true })
  const project = path.join(claude, 'projects', '-work-demo-app')

  // Assistant replies carry a model and usage like the real CLI's (each its own message id).
  let msg = 0
  const reply = (model, ctx = 20_000) => ({ id: `msg_fx_${++msg}`, model, usage: { input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 1000, cache_read_input_tokens: Math.max(0, ctx - 1010) } })
  const prompt = (sid, text, ago = 60_000) => ({ type: 'user', sessionId: sid, cwd, uuid: `${sid}-u`, timestamp: iso(ago), message: { role: 'user', content: text } })
  const say = (ago, text = 'Done.', model = 'claude-opus-5-5', ctx) => ({ type: 'assistant', timestamp: iso(ago), message: { ...reply(model, ctx), stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
  const call = (ago, name, input, id = 'call-1', model = 'claude-opus-5-5', ctx) => ({ type: 'assistant', timestamp: iso(ago), message: { ...reply(model, ctx), stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } })
  const result = (ago, id, text) => ({ type: 'user', timestamp: iso(ago), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })
  const transcript = (sid, records, agoMs = 5_000) => {
    const file = path.join(project, `${sid}.jsonl`)
    write(file, jsonl(records))
    setMtime(file, agoMs)
    return file
  }
  const job = (sid, state) => write(path.join(claude, 'jobs', short(sid), 'state.json'), {
    sessionId: sid, resumeSessionId: sid, cwd, createdAt: iso(2_900_000), updatedAt: iso(10_000), children: [], ...state,
  })
  // Interactive sessions default to the settings model.
  write(path.join(claude, 'settings.json'), { model: 'opus[1m]' })
  write(path.join(claude, 'gh-pr-status-cache.json'), PR_STATUS)
  const live = (sid) => write(path.join(claude, 'sessions', `${short(sid)}.json`), { pid: 1, sessionId: sid, kind: 'bg' })

  // Boss: launched three leads with `claude --bg`, now idle with its turn finished.
  const launch = (n, sid) => [
    call(3_000_000 - n, 'Bash', { command: `claude --bg -n "Lead ${n}" "do the work"` }, `launch-${n}`),
    result(3_000_000 - n - 1, `launch-${n}`, `backgrounded · ${short(sid)}\n  claude attach ${short(sid)}    open it`),
  ]
  transcript(IDS.boss, [prompt(IDS.boss, 'Coordinate the release', 3_700_000),
    ...launch(1, IDS.leadBuilding), ...launch(2, IDS.leadBlocked), ...launch(3, IDS.leadCi), ...launch(4, IDS.leadDone),
    say(20_000, 'Leads are running.')])
  job(IDS.boss, { name: 'Big Boss', state: 'working', tempo: 'idle', createdAt: iso(4_000_000),
    respawnFlags: ['-n', 'Big Boss', '--model', MODELS.boss.flag],
    providerEnv: { ANTHROPIC_DEFAULT_OPUS_MODEL: MODELS.boss.env, CLAUDE_CODE_SUBAGENT_MODEL: 'inherit', ANTHROPIC_AUTH_TOKEN: ENV_SECRET, ANTHROPIC_BASE_URL: `https://gateway.invalid/${ENV_SECRET}` } })
  live(IDS.boss)

  // Lead building, with one running subagent and one idle teammate.
  // It started on Opus 5 and moved to Opus 5.5 an hour ago; its context is 85 % of 1M.
  transcript(IDS.leadBuilding, [prompt(IDS.leadBuilding, 'Build the API', 7_200_000), say(7_000_000, 'Planned.', MODELS.leadBuilding.from),
    say(3_600_000, 'Started.', MODELS.leadBuilding.now), call(2_000, 'Read', { file_path: 'x' }, 'call-1', MODELS.leadBuilding.now, MODELS.leadBuilding.ctx)], 2_000)
  job(IDS.leadBuilding, { name: 'API Lead', state: 'working', tempo: 'active', fan: [{ kind: 'agent', id: 'aworker' }],
    respawnFlags: ['--model', MODELS.leadBuilding.flag, '--effort', 'high'],
    children: [{ kind: 'pr', id: '101', href: 'https://github.com/example/demo-app/pull/101' }] })
  live(IDS.leadBuilding)
  const subs = path.join(project, IDS.leadBuilding, 'subagents')
  write(path.join(subs, 'agent-worker.jsonl'), jsonl([prompt('w', 'Write tests'), call(1_000, 'Bash', { command: 'npm test' }, 'call-1', MODELS.worker.now)]))
  write(path.join(subs, 'agent-worker.meta.json'), { agentType: 'test-engineer', description: 'Write the tests', model: MODELS.worker.requested })
  write(path.join(subs, 'agent-mate.jsonl'), jsonl([prompt('m', 'Review'), say(30_000, 'Done.', MODELS.mate.now)]))
  write(path.join(subs, 'agent-mate.meta.json'), { agentType: 'reviewer', name: 'reviewer', teamName: 'session-x', description: 'Review the diff', model: MODELS.mate.requested })

  transcript(IDS.leadBlocked, [prompt(IDS.leadBlocked, 'Migrate the DB'), say(60_000, 'Done.', MODELS.leadBlocked.now)], 60_000)
  job(IDS.leadBlocked, { name: 'DB Lead', state: 'blocked', tempo: 'blocked', respawnFlags: ['--model', MODELS.leadBlocked.flag],
    needs: ASK.needs, suggestedReply: ASK.suggestedReply })
  live(IDS.leadBlocked)

  transcript(IDS.leadCi, [prompt(IDS.leadCi, 'Ship the fix', 120_000), say(90_000, 'Done.', MODELS.leadCi.now)], 90_000)
  job(IDS.leadCi, { name: 'CI Lead', state: 'working', tempo: 'idle', detail: 'waiting on CI for #101', inFlight: { tasks: 0, queued: 0, kinds: [] }, respawnFlags: ['--model', MODELS.leadCi.flag] })
  live(IDS.leadCi)

  transcript(IDS.leadDone, [prompt(IDS.leadDone, 'Docs pass'), say(600_000)], 600_000)
  job(IDS.leadDone, { name: 'Docs Lead', state: 'done', tempo: 'idle', updatedAt: iso(600_000),
    children: [{ kind: 'pr', id: '99', href: 'https://github.com/example/demo-app/pull/99' }] })

  // Interactive solos.
  transcript(IDS.soloTurn, [prompt(IDS.soloTurn, 'Explain the build'), say(30_000)], 30_000)
  live(IDS.soloTurn)
  transcript(IDS.soloWaiting, [prompt(IDS.soloWaiting, 'Research options'), call(40_000, 'Agent', { prompt: 'look around' }, 'call-1', MODELS.soloWaiting.now)], 40_000)
  live(IDS.soloWaiting)
  // The CLI's shape for a failed request: a synthetic assistant message carrying the error text.
  const apiFail = (ago, code, body) => ({ type: 'assistant', isApiErrorMessage: true, timestamp: iso(ago),
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: `API Error: ${code} ${body}` }] } })
  transcript(IDS.soloError, [prompt(IDS.soloError, 'Fix lint'), apiFail(50_000, 529, '{"error":"Overloaded"}')], 50_000)

  transcript(IDS.soloOld, [prompt(IDS.soloOld, 'Old question', 3 * 86_400_000), say(3 * 86_400_000)], 3 * 86_400_000)

  // Codex: one mid-turn, one finished turn.
  const codex = path.join(root, 'codex')
  const rollout = (id, events, agoMs, extra = []) => {
    const file = path.join(codex, 'sessions', '2026', '10', '21', `rollout-2026-10-21T00-00-00-${id}.jsonl`)
    write(file, jsonl([{ type: 'session_meta', timestamp: iso(agoMs + 1000), payload: { id, cwd: codexCwd } },
      { type: 'response_item', timestamp: iso(agoMs + 900), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Refactor the parser' }] } },
      ...extra,
      ...events.map((type) => ({ type: 'event_msg', timestamp: iso(agoMs), payload: type === 'task_started' ? { type, model_context_window: MODELS.codexRunning.window } : { type } }))]))
    setMtime(file, agoMs)
  }
  rollout(IDS.codexRunning, ['task_started'], 5_000, [
    { type: 'turn_context', timestamp: iso(5_800), payload: { model: MODELS.codexRunning.now, cwd: codexCwd } },
    { type: 'event_msg', timestamp: iso(5_500), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 41_000 }, last_token_usage: { input_tokens: 40_000, cached_input_tokens: 30_000, output_tokens: 1_000, total_tokens: 41_000 }, model_context_window: MODELS.codexRunning.window } } },
  ])
  rollout(IDS.codexTurn, ['task_started', 'task_complete'], 60_000)

  // Never a real terminal: "Open" goes to a fake that only records its argv.
  return {
    AGENTVILLE_CLAUDE_HOME: claude, AGENTVILLE_CODEX_HOME: codex,
    AGENTVILLE_TERMINAL: fileURLToPath(new URL('./bin/kitty', import.meta.url)),
    AGENTVILLE_FAKE_TERMINAL_LOG: path.join(root, 'terminal.log'),
    AGENTVILLE_FAKE_CLAUDE_LOG: path.join(root, 'claude.log'),
    AGENTVILLE_FAKE_BIN: fileURLToPath(new URL('./bin', import.meta.url)),
    AGENTVILLE_TEST: '1',
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || 'fixture-home')
  const env = makeHome(dir)
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}=${JSON.stringify(v)}`)
  console.log(`export AGENTVILLE_DATA_DIR=${JSON.stringify(path.join(dir, 'data'))}`)
}
