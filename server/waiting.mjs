// Ported from Bot Crossing server/harnesses/waiting.mjs (MIT, Jarren Rocks). Semantics unchanged; see NOTICE.
/** Explicit outstanding wait calls only. Never interpret prose, inactivity or arbitrary Bash
 * as a wait. Read bounded transcript tails; never return commands, arguments or tool output. */
export const WAIT_TTL_MS = 30 * 60 * 1000

function argsOf(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {}
  try { return JSON.parse(value) } catch { return {} }
}

function classify(name, input) {
  const args = argsOf(input)
  const tool = String(name || '').split(/[.:]/).at(-1)
  // A dialog the user answers by clicking (Agentville addition): a plan to approve, or options to pick.
  if (tool === 'ExitPlanMode') return { needsUser: true, prompt: 'plan' }
  if (['AskUserQuestion', 'request_user_input', 'request_user_input_async'].includes(tool)) return { needsUser: true, prompt: 'question' }
  if (['wait_agent', 'wait_agent_completion'].includes(tool) ||
      (tool === 'wait' && Array.isArray(args.ids) && args.ids.length)) {
    return { kind: 'subagent', reason: 'Waiting for an agent to finish' }
  }
  if (['Agent', 'Task'].includes(tool) && args.run_in_background !== true) {
    return { kind: 'subagent', reason: 'Waiting for a subagent to finish' }
  }
  if (tool === 'TaskOutput' && args.block !== false && typeof args.task_id === 'string') {
    return { kind: 'task', reason: 'Waiting for background work to finish' }
  }
  if (tool === 'wait' && typeof args.cell_id === 'string' && !args.terminate) {
    return { kind: 'task', reason: 'Waiting for an ongoing tool operation' }
  }
  // Deliberately narrow: a blocking gh watcher, not a one-shot gh query or every shell call.
  const command = args.command ?? args.cmd
  if (['Bash', 'exec_command', 'shell_command'].includes(tool) && typeof command === 'string' &&
      /^\s*gh\s+(?:run\s+watch\b|pr\s+checks\b[^\n;&|]*\s--watch\b)/.test(command) &&
      !/--help\b|--version\b/.test(command) && !/[;&|\n]/.test(command) && args.run_in_background !== true) {
    return { kind: 'external-job', reason: 'Waiting for GitHub Actions checks' }
  }
  return null
}

export function readWaitEvidence(records, harness) {
  let pending = new Map()
  const call = (id, name, input, timestamp) => {
    const evidence = classify(name, input)
    if (id) pending.set(id, evidence ? { ...evidence, since: Date.parse(timestamp) || 0 } : null)
  }
  for (const r of records) {
    if (harness === 'claude-code') {
      const blocks = Array.isArray(r.message?.content) ? r.message.content : []
      if (r.type === 'assistant') {
        // A new assistant step supersedes old calls, including truncated/missing results.
        pending.clear()
        for (const b of blocks) if (b.type === 'tool_use') call(b.id, b.name, b.input, r.timestamp)
      } else if (r.type === 'user') {
        const results = blocks.filter((b) => b.type === 'tool_result')
        if (!results.length) pending.clear()
        for (const b of results) {
          pending.delete(b.tool_use_id)
          if (b.is_error) pending.clear()
        }
      } else if (r.type === 'system' && ['turn_duration', 'api_error'].includes(r.subtype)) pending.clear()
    } else {
      const p = r.payload
      if (r.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted', 'error'].includes(p?.type)) pending.clear()
      if (r.type !== 'response_item' || !p) continue
      if (['function_call', 'custom_tool_call'].includes(p.type)) {
        // Keep concurrent calls: any normal outstanding operation means it is still working.
        call(p.call_id, p.name, p.arguments ?? p.input, r.timestamp)
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) pending.delete(p.call_id)
      else if (p.type === 'message') pending.clear()
    }
  }
  const values = [...pending.values()]
  const asking = values.find((v) => v?.needsUser)
  if (asking) return { needsUser: true, prompt: asking.prompt }
  // Parallel normal tools can still be doing work. Don't call the whole agent waiting.
  if (!values.length || values.some((v) => !v)) return null
  const value = values[0]
  return { ...value, expiresAt: value.since + WAIT_TTL_MS, source: 'outstanding-tool' }
}

export function currentWait(evidence, now = Date.now()) {
  return evidence?.kind && evidence.since > 0 && evidence.since <= now && now < evidence.expiresAt ? evidence : null
}

/** Claude's own scheduler can be idle while a known background task is in flight.
 * Do not expose its free-form detail/needs/providerEnv fields to the browser. A completed
 * turn with leftover teammates, a permission block, or a queued new turn is not a wait. */
/** A scheduler status the job reports as its current state (blocked/done) holds this long. */
// The agent's own current status line: valid until it changes (the 24 h quiet rule rests it after that).
export const REPORTED_STATE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The agent's own one-line status (the scheduler's `detail`) read as a wait, or null. Anything
 * addressed to the user wins and is not a wait. Only these named categories count: CI/checks,
 * another agent, a merge, or a scheduled time. Never transcript prose.
 */
export function reportedWait(detail) {
  const d = typeof detail === 'string' ? detail : ''
  if (!d || /\b(?:you|your|user|approv\w*|permission|decisions?|decide|go-aheads?|confirm\w*|choice|clarif\w*|call)\b/i.test(d)) return null
  // An intention ("Next I will wait for CI") is not a wait yet.
  if (/\b(?:will|going to|plan(?:s|ning)? to|next I)\b/i.test(d)) return null
  const waiting = /\b(?:wait\w*|await\w*|watch\w*|pending|running|until|poll\w*|queued|paused|handed|relay\w*|set for|scheduled)\b/i.test(d)
  if (!waiting) return null
  if (/\b(?:big boss|boss|leads?|agents?|subagents?|teammates?|workers?)\b/i.test(d)) return { kind: 'subagent', reason: 'Agent reports waiting on another agent' }
  if (/\b(?:CI|checks?|GitHub Actions|workflow runs?|pipelines?|builds?)\b/i.test(d)) return { kind: 'external-job', reason: 'Agent reports waiting for CI or checks' }
  if (/\bmerge[sd]?\b|\bmerge queue\b/i.test(d)) return { kind: 'external-job', reason: 'Agent reports waiting for a merge' }
  if (/\b(?:set for|scheduled|tonight|tomorrow)\b|\b\d{1,2}:\d{2}\b/i.test(d)) return { kind: 'external-job', reason: 'Agent reports a scheduled step' }
  // Any other wait it reports ("queued behind the shared lock", "waiting on the Q3 numbers").
  return { kind: 'external-job', reason: 'Agent reports waiting on other work' }
}

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

export function jobWaitEvidence(state, now = Date.now(), { live = false } = {}) {
  const since = Date.parse(state?.updatedAt) || 0
  if (!since || since > now) return null
  const report = reportedWait(state.detail)
  // blocked/done is the job's current state (not a passing report), so it holds longer; a report
  // of waiting on CI or another agent turns it from "needs you" into a wait.
  if (['blocked', 'done'].includes(state.state) || state.tempo === 'blocked') {
    // `needs` is what it is asking someone for: with one set, its status is not a wait.
    if (report && !(typeof state.needs === 'string' && state.needs.trim()) && now - since < REPORTED_STATE_TTL_MS) return { ...report, since, expiresAt: since + REPORTED_STATE_TTL_MS, source: 'harness-reported-wait' }
    return state.state === 'done' ? null : { needsUser: true }
  }
  const flight = state.inFlight
  // A live job with a wakeup set (`inFlight.wake`, a session cron) checks back by itself.
  const wake = Number(flight?.wake?.at)
  if (live && state.tempo === 'idle' && !state.needs && wake > now) {
    return { kind: 'external-job', reason: `Scheduled to check back at ${hhmm(wake)}`, since, expiresAt: wake + 15 * 60e3, source: 'harness-wake' }
  }
  // A live job's background commands/agents in flight are its current state, whatever is queued.
  const busyKinds = Array.isArray(flight?.kinds) && flight.kinds.length && flight.kinds.every((k) => ['local_agent', 'in_process_teammate', 'local_bash', 'monitor'].includes(k))
  if (live && state.tempo === 'idle' && !state.needs && flight?.tasks > 0 && busyKinds && now - since < REPORTED_STATE_TTL_MS) {
    const agentsOnly = flight.kinds.every((k) => ['local_agent', 'in_process_teammate'].includes(k))
    return { kind: agentsOnly ? 'subagent' : 'task', reason: agentsOnly ? 'Waiting for background agents' : 'Waiting for background work', since, expiresAt: since + REPORTED_STATE_TTL_MS, source: 'harness-in-flight' }
  }
  if (state.state !== 'working' || state.tempo !== 'idle' || state.needs || flight?.queued > 0) return null
  // An idle job reporting a wait on CI/another agent is still waiting until its status changes.
  if (report && now - since < REPORTED_STATE_TTL_MS) return { ...report, since, expiresAt: since + REPORTED_STATE_TTL_MS, source: 'harness-reported-wait' }
  if (now - since >= WAIT_TTL_MS) return null
  if (!(flight?.tasks > 0) || !Array.isArray(flight.kinds)) return null
  const kinds = flight.kinds
  if (!kinds.length || kinds.some((k) => !['local_agent', 'in_process_teammate', 'local_bash', 'monitor'].includes(k))) return null
  const agentsOnly = kinds.every((k) => ['local_agent', 'in_process_teammate'].includes(k))
  return {
    kind: agentsOnly ? 'subagent' : 'task',
    reason: agentsOnly ? 'Waiting for background agents' : 'Waiting for background work',
    since, expiresAt: since + WAIT_TTL_MS, source: 'harness-in-flight',
  }
}
