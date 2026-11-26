/**
 * Agentville: static web/dist + a read-only agents API on 127.0.0.1 only.
 * Env: AGENTVILLE_PORT (5275), AGENTVILLE_DATA_DIR, AGENTVILLE_CLAUDE_HOME, AGENTVILLE_CODEX_HOME.
 */
import { logSafely } from './fsutil.mjs'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { isLocalRequest } from './local-request.mjs'
import { defaultDataDir } from './datadir.mjs'
import { createNotifications, parseNotify, resolveSession } from './notify.mjs'
import { createWorldPlan, worldPlanRoute } from './world-plan.mjs'
import { build, dropQuiet, QUIET_REMOVE_MS } from './classify.mjs'
import { createStore } from './overrides.mjs'
import { createLoops } from './loops.mjs'
import { createHelper } from './helper.mjs'
import { ACTIONS, createFleetStore, currentPending, preview, continuable } from './fleet.mjs'
import { awaitReceipts, deliver, dryRun, inboxProblem, sendingBlocked, wrap } from './inbox.mjs'
import { actionsBlocked, display, forkPlan, knownProjects, MODELS, EFFORTS, MODES, PROMPT_MAX, NAME_MAX, run as runPlan, startPlan, stopPlan } from './actions.mjs'
import { createChanges } from './changes.mjs'
import { fanOut, PER_MINUTE as BROADCASTS_PER_MINUTE, MAX_RECIPIENTS, recipientIds, sameSet, SELF_WHY, selfId, summarize, textProblem } from './broadcast.mjs'
import { createPrStatus } from './prstatus.mjs'
import { createDock } from './dock.mjs'
import { createPrPoll } from './prpoll.mjs'
import crypto from 'node:crypto'
import { createProjectStore } from './projects.mjs'
import { createAccount } from './account.mjs'
import { createPermSwitch } from './permmode.mjs'
import { createRestore, restoreBlocked, MESSAGE as RESTORE_MESSAGE } from './restore.mjs'
import { accountsBlocked } from './accounts.mjs'
import { createSpend } from './spend.mjs'
import { buildModels, readDefaults } from './models.mjs'
import { geminiModelFacts } from './gemini/models.mjs'
import { agyDir as agyDirOf, defaultHome as agyHome } from './gemini/scan.mjs'
import { createSampler, OUT_AT } from './autoswitch.mjs'
import { createSubLimitNudger } from './sub-limit.mjs'
import { createUsagePause } from './usage-pause.mjs'
import { createResearch } from './research.mjs'
import { createNetwork } from './network.mjs'
import { cliDirs, isWin } from './platform.mjs'
import { detectTerminal, findExecutable, openInTerminal, runAppleScript } from './terminal.mjs'
import { normalizeLayout, layoutLeaves, ghosttyLayoutLaunch } from './ghostty-layout.mjs'
import { createTerminals } from './pty.mjs'
import { createPlainTerms } from './plain-term.mjs'
import { canRestartSelf, createUpdater, restartSelf } from './update.mjs'
import * as claude from './claude-code.mjs'
import * as codex from './codex.mjs'
import { getProvider, providers, providerOfAgent } from './providers/index.mjs'
import { createProviderSettings } from './provider-settings.mjs'
import { createProviderSwitch, fallbackTarget } from './provider-switch.mjs'
import { createLaunches, newToken, TOKEN_ENV } from './launches.mjs'
import { parseAgentStart, checkAndRecord, rollback } from './agent-start.mjs'
import { buildNote, notePrompt } from './handoff-note.mjs'
import { readChanges } from './changes.mjs'
import { createHandoffRefs } from './handoff-refs.mjs'

// The handoff engine (P12) is optional: a build without server/handoff.mjs runs with handoffs off.
const handoffMod = await import('./handoff.mjs').catch((e) => {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('handoff.mjs')) return null
  throw e
})
const SCAN_LABEL = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini (Antigravity)' }
const SUB_KIND = new Set(['subagent', 'teammate', 'thread'])
/** A page or API body never sets env, lineage or handoff fields: only the server does (handoffs, agent starts). */
const fromPage = (body) => {
  if (!body || typeof body !== 'object') return body
  const { env: _e, parentAgentId: _p, handoffId: _h, args: _a, bin: _b, home: _ho, account: _ac, accountEnv: _ae, ...rest } = body
  return rest
}
/** Hard ceilings for agent starts, whatever providers.json says (security review). */
export const AGENT_STARTS_MAX_PER_HOUR = 60
export const AGENT_STARTS_MAX_DEPTH = 3
/** Flip to true once server/gemini/runner.mjs start() takes `skipTrust` (then untrusted folders run without it). */
const GEMINI_RUNNER_SKIP_TRUST = true

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'web', 'dist')
const SCAN_TTL_MS = 2000
const STALE_MS = 60_000 // how old a scan may be and still be served while the next one runs
const HOME = os.homedir()
// Never inside an app bundle; a shell function or alias is invisible here by construction.
const CLAUDE_DIRS = cliDirs('claude')
const CODEX_DIRS = cliDirs('codex')
export const NEVER_STARTED = "This launch failed before it started, so there's no session to open"
const refuse = (status, message) => Object.assign(new Error(message), { status })

/** The argv and cwd to open an agent with, decided only from our own data. Throws a 4xx otherwise. */
export async function openCommand(a) {
  if (!a) throw refuse(404, 'No such agent')
  if (['subagent', 'teammate', 'thread'].includes(a.kind)) throw refuse(409, 'Open its lead instead')
  if (a.neverStarted) throw refuse(409, NEVER_STARTED)
  const cwd = a.cwd && path.isAbsolute(a.cwd) && fs.statSync(a.cwd, { throwIfNoEntry: false })?.isDirectory() ? a.cwd : null
  if (!cwd) throw refuse(409, "Its folder no longer exists")
  if (a.harness === 'codex') {
    const codexBin = await findExecutable('codex', CODEX_DIRS)
    if (!codexBin) throw refuse(409, 'Codex CLI not found')
    return { argv: [codexBin, 'resume', a.id.slice('codex:'.length)], cwd }
  }
  const claudeBin = await findExecutable('claude', CLAUDE_DIRS)
  if (!claudeBin) throw refuse(409, 'Claude Code CLI not found')
  // A job reopened in a terminal is that interactive session now: attaching would start a second process.
  if (a.kind === 'job' && !a.reopened && /^[0-9a-f]{8}$/.test(a.jobId || '')) return { argv: [claudeBin, 'attach', a.jobId], cwd }
  // Resuming a session that is already open elsewhere makes a second process on one conversation.
  if (a.live) throw refuse(409, 'Already running in another terminal')
  const sid = a.id.slice('claude-code:'.length)
  if (!/^[0-9a-f-]{36}$/i.test(sid)) throw refuse(409, 'Not a resumable session')
  return { argv: [claudeBin, '--resume', sid], cwd }
}

export { defaultDataDir }

export function createServer({ dataDir = defaultDataDir(), termIdleMs, termEndWaitMs, update = {}, staleOk = false } = {}) {
  const store = createStore(dataDir)
  const worldPlan = worldPlanRoute(createWorldPlan(dataDir)) // D5: GET/PUT /api/world-plan
  const loops = createLoops(dataDir)
  const notifications = createNotifications(dataDir)
  const helper = createHelper({ dir: dataDir, claudeHome: claude.home })
  // The built-in terminal (server/pty.mjs): one PTY per agent, the command always from openCommand.
  const terms = createTerminals({ idleMs: termIdleMs, endWaitMs: termEndWaitMs })
  const termActs = []
  // Plain terminals (plain-term.mjs): a shell or an interactive CLI with no agent; the kind and folder are the page's only say.
  const plain = createPlainTerms({ findBin: (name) => findExecutable(name, name === 'codex' ? CODEX_DIRS : CLAUDE_DIRS) })
  // A person opens a handful of terminals a minute. The shared e2e server opens many more, so a test
  // run (and only a test run) may raise the cap with AGENTVILLE_TERM_PER_MINUTE.
  const termTesting = process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
  const termPerMinute = (termTesting && Number(process.env.AGENTVILLE_TERM_PER_MINUTE)) || 30
  const fleetStore = createFleetStore(dataDir)
  // Server-private, never in the API: each live Claude agent's inbox and transcript file.
  let inboxes = new Map()
  let transcriptOf = new Map()
  // Server-private: per agent, its transcript and model settings for /api/models (never sent as is).
  let modelInfo = new Map()
  const geminiFactsOf = (id) => {
    const g = modelInfo.get(id)?.gemini
    return g ? geminiModelFacts({ ...g, dataDir, agyDir: agyDirOf(agyHome()) }).catch(() => null) : null
  }
  const plans = new Map() // confirm token -> the previewed plan, valid 2 min, usable once
  const sends = []
  // One agent at a time: a message (inspector reply / compose) or a start, stop or fork. Each is a
  // previewed plan behind a one-time confirm token, like Fleet's.
  const oneOffs = new Map() // confirm token -> { kind, ..., expires }
  const messages = [] // message sends in the last minute
  const broadcasts = [] // "Message agents" sends in the last minute
  const runs = [] // starts, stops and forks in the last minute
  let forks = new Map() // server-private: id -> { sid, cwd } a fork would copy
  let titles = [] // server-private: conversation names for search (never prompt text)
  let quietIds = new Set() // removed by the last scan: quiet for over QUIET_REMOVE_DAYS
  const changes = createChanges()
  const dock = createDock({ dataDir })
  let lastAgents = [] // the latest snapshot's agents: the live PR poll asks about their open PRs
  const testingEnv = process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
  const prPoll = createPrPoll({
    intervalMs: Number(process.env.AGENTVILLE_PR_POLL_MS ?? (testingEnv ? 0 : 120_000)) || 0,
    targets: () => [
      ...lastAgents.flatMap((a) => (a.prs || []).filter((p) => p.state === 'open' || p.state === 'draft').map((p) => p.href)),
      ...dock.openHrefs(),
    ],
  })
  const prStatus = createPrStatus(claude.home, prPoll)
  const projectStore = createProjectStore(dataDir)
  // Usage research log: tokens by model next to every usage reading (see research.mjs).
  const research = createResearch({ dataDir })
  const network = createNetwork({ dataDir })
  // Restore after crash (restore.mjs): the running-set snapshot and the lost crown/Important jobs.
  const restore = createRestore({ dataDir, claudeHome: claude.home })
  const account = createAccount({ dataDir, claudeHome: claude.home, onReading: research.usage, network,
    // Switches refuse while a permission-mode switch runs; permSwitch is built just below, so ask it lazily.
    permBusy: () => typeof permSwitch?.isBusy === 'function' && permSwitch.isBusy(),
    permBusyJob: (short) => typeof permSwitch?.busyJob === 'function' && permSwitch.busyJob() === short })
  // One background job to bypass-permissions mode, on the user's click (permmode.mjs).
  const permSwitch = createPermSwitch({ dataDir, claudeHome: claude.home, busy: () => account.isBusy() })
  // Token spend is read when the page asks (every few seconds while it is open) and with each usage sample.
  const spend = createSpend({ dataDir, claudeHome: claude.home, codexHome: codex.home, research })
  const sampler = createSampler({ dataDir, account, network,
    // The scan's agents plus, privately, when each job's scheduler record last said the harness limit (claude-code.mjs).
    agents: async () => agentsOf('claude'),
    // A stale-login nudge skips agents in a non-terminal handoff (§3.6).
    nudge: (ids) => nudgeAgents(ids.filter((id) => !handoffs?.inFlight(id))), holding: () => usagePause.holding() })
  // ---- providers (docs/providers-design.md §2, §3, §5) ----
  const providerSettings = createProviderSettings({ dataDir }) // get() is synchronous
  const launches = createLaunches({ dataDir })
  const handoffRefs = createHandoffRefs({ dataDir })
  let privateFacts = new Map() // server-private per agent: { limitStop, limitStopAt, handoffId, runId, sessionId, transcriptFile }
  /** One provider's agents (API records plus the private limit/handoff fields the samplers and handoffs read). */
  async function agentsOf(provider) {
    return (await snapshot()).agents.filter((a) => !provider || providerOfAgent(a) === provider).map(withPrivate)
  }
  const withPrivate = (a) => {
    const f = privateFacts.get(a.id) || {}
    return { ...a, limitStopAt: limitStops.get(a.id)?.at || 0, limitText: limitStops.get(a.id)?.text || '',
      ...(f.limitStop && !a.limitStop && { limitStop: f.limitStop }), ...(f.handoffId && { handoffId: f.handoffId }),
      ...(f.runId && { runId: f.runId }), ...(f.sessionId && { sessionId: f.sessionId }), ...(f.transcriptFile && { transcriptFile: f.transcriptFile }) }
  }
  // Claude binds its account module here; the other adapters only need the data folder.
  for (const p of providers()) {
    try { p.configure(p.id === 'claude' ? { dataDir, account } : { dataDir }) } catch (e) { logSafely(e) }
  }
  // One sampler per provider with accounts (§3.1). Claude's is the existing one, under its old file name.
  const samplers = { claude: sampler }
  for (const p of providers()) {
    if (p.id === 'claude' || !p.capabilities?.accounts || !p.switcher) continue // no switcher: nothing to rotate
    try {
      samplers[p.id] = createSampler({ dataDir, provider: p.id, file: `autoswitch-${p.id}.json`, tuning: p.tuning || {}, account: p.switcher, network,
        agents: async () => agentsOf(p.id) })
    } catch (e) { logSafely(e) }
  }
  const providerSwitch = createProviderSwitch({ settings: providerSettings, providers: () => providers(), samplers,
    // Without accounts a provider is out when its agents stopped on the limit (§3.2). A Gemini run that stopped on
    // its quota has exited, so a recent limit stop counts as live for this check.
    agents: async (id) => (await agentsOf(id)).map((a) => (a.limitStop && !a.live ? { ...a, live: true } : a)),
    onEpisode: (ev) => { logFleet({ at: Date.now(), action: 'provider-episode', type: ev.type, provider: ev.provider, episode: ev.episode?.id }) } })
  const handoffs = handoffMod?.createHandoffs ? handoffMod.createHandoffs({
    dataDir, getProvider: handoffRefs.wrap((id) => {
      const a = getProvider(id)
      if (!a) return a
      const w = Object.create(a)
      w.run = (plan, ...rest) => launchWithToken(withPort(plan), { via: 'handoff', provider: id, parentAgentId: plan?.parentAgentId || null }, (p) => a.run(p, ...rest))
      return w
    }), settings: providerSettings,
    agents: () => agentsOf(null), providerState: () => providerSwitch.status(), buildNote, notePrompt, readChanges,
    // The start wrapper above records (and binds) every handoff launch with its token; the engine's own
    // record of the same ref is then a no-op. reparent and the reads go to the ledger as they are.
    launches: Object.assign(Object.create(launches), { record: (x) => (x?.ref && launches.refOf(x.ref) ? null : launches.record(x)) }),
    fallbackTarget, providerOfAgent, selfId: selfId(),
    projects: async () => knownProjects((await snapshot()).agents),
    log: (e) => logFleet({ ...e, source: 'handoff' }),
  }) : null
  /** Usable as a start target now (§3.3): starts + takes handoffs, available, not exhausted. */
  async function providerStatusOf(id) {
    const a = getProvider(id)
    if (!a) return { usable: false, why: 'not installed' }
    if (!a.capabilities?.start) return { usable: false, why: 'display only' }
    let av
    try { av = await a.available() } catch { av = { ok: false, why: 'check failed' } }
    if (!av?.ok) return { usable: false, why: av?.why || 'not available' }
    if (providerSwitch.exhausted(id)) return { usable: false, why: 'out on every account' }
    return { usable: true, why: '' }
  }
  /** GET /api/providers' list (§5). */
  async function providerList() {
    const st = providerSwitch.status()
    return Promise.all(providers().map(async (p) => {
      let av
      try { av = await p.available() } catch { av = { ok: false, why: 'check failed' } }
      let activeAccount = null
      if (p.capabilities?.accounts) {
        try { const l = await p.accounts.list(); const a = (l?.accounts || []).find((x) => x.active); activeAccount = a ? { id: a.id, label: a.label } : null } catch { activeAccount = null }
      }
      return { id: p.id, label: p.label, available: Boolean(av?.ok), why: av?.why || '', capabilities: { ...p.capabilities },
        activeAccount, exhausted: st[p.id]?.exhausted || null }
    }))
  }
  /** The plan's adapter: `plan.provider`, Claude for plans from before providers. */
  const adapterOf = (provider) => {
    const a = getProvider(provider || 'claude')
    if (!a) throw Object.assign(new Error(`Unknown provider ${provider}`), { status: 400 })
    return a
  }
  /** Every agent Agentville starts gets AGENTVILLE_PORT (§5), so it can call back. */
  const withPort = (plan) => {
    const port = server.address()?.port
    return plan?.kind === 'start' && port ? { ...plan, env: { ...plan.env, AGENTVILLE_PORT: String(port) } } : plan
  }
  /**
   * UI and handoff starts get a per-launch token too, so their children can start agents (security review):
   * a pending ledger record before the spawn, the token in the child's env, then bind to the real ref or roll back.
   */
  async function launchWithToken(plan, { via, provider, parentAgentId = null }, runFn) {
    if (plan?.kind !== 'start') return runFn(plan)
    const token = newToken()
    let rec = null
    try { rec = launches.record({ ref: `pending-${crypto.randomUUID()}`, parentAgentId, provider, via, token, pending: true }) } catch (e) { logSafely(e) }
    const r = await runFn({ ...plan, env: { ...plan.env, ...(rec && { [TOKEN_ENV]: token }) } })
    if (rec) {
      const ref = r?.ref?.runId || r?.ref?.jobId || r?.ref?.sessionId || r?.jobId || null
      try { if (r?.ok && ref) launches.bind(rec.ref, ref, [r.id].filter(Boolean)); else launches.rollback(rec.ref) } catch (e) { logSafely(e) }
    }
    return r
  }
  /** Why starting/stopping on this provider can't run here ('' = it can). Claude keeps actionsBlocked()'s exact text. */
  async function blockedFor(provider) {
    if (!provider || provider === 'claude') return actionsBlocked()
    const a = getProvider(provider)
    if (!a || !a.capabilities?.start) return `${a?.label || provider} agents can't be started from here`
    try { const av = await a.available(); return av?.ok ? '' : av?.why || 'not available' } catch { return 'not available' }
  }
  let limitStops = new Map() // agent id -> { at: limitStopAt, text: the harness limit string }
  // Update check against GitHub's main (update.mjs); restarting needs `server`, so it's looked up late.
  const updater = createUpdater({ restart: canRestartSelf() ? () => restartSelf(server) : null, settingsFile: path.join(dataDir, 'update.json'), terminalsOpen: () => terms.info().running.length, ...update })
  // Sub-agents the API terminated: once requests work again, tell each parent (once) to resume them (sub-limit.mjs).
  const subLimit = createSubLimitNudger({ dataDir, selfId: selfId(),
    agents: async ({ fresh } = {}) => { if (fresh) cached = null; return (await snapshot()).agents.filter((a) => !handoffs?.inFlight(a.id)) },
    changedAt: () => account.lastChangeAt(),
    canRequest: subLimitRoom,
    deliverTo: async (id, text) => {
      if (usagePause.holding() || sendingBlocked() || dryRun()) return false
      const inbox = inboxes.get(id)
      if (!inbox || inboxProblem(inbox)) return false
      const ok = (await deliver(inbox, text)).ok
      if (ok) await logFleet({ at: Date.now(), action: 'resume-subagents', source: 'sub-limit', results: [{ id, status: 'sent' }] })
      return ok
    } })
  // Every account out (auto-switch blocked): tell the top-level agents once to checkpoint and wait, hold every
  // automated nudger, and tell them once to continue when an account has room again (usage-pause.mjs).
  // Only agents the handoff flow left with no target are paused (§3.6: handoff.covers).
  const usagePause = createUsagePause({ dataDir, selfId: selfId(),
    agents: async () => (await snapshot()).agents.filter((a) => !handoffs?.covers(a.id)),
    blocked: async () => (await sampler.info()).blocked,
    canRequest: subLimitRoom,
    deliverTo: async (id, text) => {
      if (sendingBlocked() || dryRun()) return false
      const inbox = inboxes.get(id)
      if (!inbox || inboxProblem(inbox)) return false
      return (await deliver(inbox, text)).ok
    },
    log: (entry) => logFleet(entry) })
  /** Requests on Claude's active login can work: the latest reading is of it (after the last change) and neither window is out. */
  async function subLimitRoom() {
    if ((await account.profile()) === 'pool') return true
    const r = sampler.reading()
    if (!r || r.error || r.stale || !r.at || r.at < (await account.lastChangeAt())) return false
    return !(r.fiveHour?.used >= OUT_AT) && !(r.weekly?.used >= OUT_AT)
  }
  const startedAt = Date.now()
  const opens = []
  const since = new Map() // id -> { bucket, since }: when it entered its current bucket
  let cached = null
  let inflight = null

  async function scanAll() {
    const now = Date.now()
    const warnings = []
    // One scan per registered provider (§1.3). Gemini always scans (its runs live in our data folder), except
    // under test, where it would read the real ~/.gemini unless a fake home is named.
    const adapters = providers()
    const sources = {}
    for (const p of adapters) sources[p.id] = p.id === 'gemini' ? !(testingEnv && !process.env.AGENTVILLE_AGY_HOME) : fs.existsSync(p.home())
    const results = await Promise.allSettled(adapters.map((p) => (sources[p.id] ? p.scan(now) : [])))
    const scanned = []
    let unreadable = 0
    results.forEach((r, i) => {
      const id = adapters[i].id
      if (r.status === 'fulfilled') {
        for (const f of r.value) { f.provider ??= id; scanned.push(f) }
        unreadable += r.value.unreadable || 0
      } else warnings.push(`${SCAN_LABEL[id] || adapters[i].label} scan failed: ${r.reason?.message || r.reason}`)
    })
    handoffRefs.annotate(scanned)
    if (unreadable) warnings.push(`${unreadable} session file${unreadable === 1 ? '' : 's'} couldn't be read (check file permissions).`)
    if (!sources.claude && !sources.codex) warnings.push(`No agent data found. Looked for Claude Code in ${claude.home()} and Codex in ${codex.home()}.`)
    const fleetData = await fleetStore.load()
    const pending = currentPending(fleetData, now)
    const overrides = await store.load()
    // Quiet for over QUIET_REMOVE_DAYS (not live, not Important): gone from every view, before any work.
    const { kept: facts, removed } = dropQuiet(scanned, overrides, now)
    quietIds = removed
    const agents = build(facts, overrides, now, pending, {
      startedBy: (id) => launches.startedBy(id),
      handoff: handoffs ? (id) => handoffs.annotate(id) : undefined,
    })
    const notices = await notifications.load()
    await notifications.prune(new Set(agents.map((a) => a.id))).catch(logSafely)
    for (const a of agents) { const n = Object.hasOwn(notices, a.id) ? notices[a.id] : null; a.notice = n ? { message: n.message, title: n.title, at: n.at, count: n.count } : null }
    const counts = { building: 0, stalled: 0, waiting: 0, resting: 0, errors: 0, prompts: 0, continuable: 0 }
    for (const a of agents) {
      const prev = since.get(a.id)
      if (prev?.bucket === a.bucket) a.since = prev.since
      else if (prev) a.since = now
      since.set(a.id, { bucket: a.bucket, since: a.since })
      if (!a.hidden) { counts[a.bucket]++; if (a.severity === 'error') counts.errors++; if (a.prompt) counts.prompts++; if (continuable(a)) counts.continuable++ }
    }
    inboxes = new Map(facts.map((f) => [f.id, f.inbox || null]))
    transcriptOf = new Map(facts.map((f) => [f.id, f.transcriptFile || null]))
    modelInfo = new Map(facts.map((f) => [f.id, { kind: f.kind, harness: f.harness, parentId: f.parentId || null, file: f.transcriptFile || null, config: f.modelConfig || null, ...(f.provider === 'gemini' && { gemini: { conversationId: f.sessionId || null, runId: f.runId || null } }) }]))
    // Gemini agents: the model of the latest reply (cached per transcript), so cards and filters can use it.
    await Promise.all(agents.filter((a) => modelInfo.get(a.id)?.gemini).map(async (a) => {
      const g = await geminiFactsOf(a.id)
      a.model = g?.model || null
    }))
    forks = new Map(facts.filter((f) => f.fork).map((f) => [f.id, f.fork]))
    limitStops = new Map(facts.filter((f) => f.limitStopAt).map((f) => [f.id, { at: f.limitStopAt, text: f.limitDetail || '' }]))
    privateFacts = new Map(facts.map((f) => [f.id, { limitStop: f.limitStop && f.limitStopAt ? f.limitStop : null, handoffId: f.handoffId || null,
      runId: f.runId || null, sessionId: f.sessionId || null, transcriptFile: f.transcriptFile || null }]))
    const keptIds = new Set(facts.map((f) => f.id))
    titles = results.flatMap((r) => (r.status === 'fulfilled' && r.value.titles) || [])
      .filter((t) => keptIds.has(t.id) || (!removed.has(t.id) && now - (t.at || 0) <= QUIET_REMOVE_MS))
    const byId = new Map(agents.map((a) => [a.id, a]))
    const self = selfId()
    const dirs = new Set()
    for (const a of agents) {
      // Why it can't be messaged from the inspector ('' = it can). Fixed strings only.
      a.messageWhy = messageProblem(a)
      // The session Agentville itself runs in (if any): never one of "Message agents"' recipients.
      a.self = a.id === self
      // Changed files in its folder: never for resting agents, and a subagent working in its lead's
      // folder leaves that to the lead.
      const parent = ['subagent', 'teammate', 'thread'].includes(a.kind) && a.parentId && byId.get(a.parentId)
      if (a.bucket !== 'resting' && !a.hidden && a.cwd && !(parent && parent.cwd === a.cwd)) {
        dirs.add(a.cwd)
        a.changes = changes.summary(a.cwd)
      } else a.changes = null
    }
    changes.prune(dirs)
    await prStatus.annotate(agents)
    lastAgents = agents
    const dockState = await dock.update(agents).catch(() => ({ loading: [], sailed: [], total: 0, level: 1 }))
    // Fleet sends to live Claude sessions; `blocked` says why it can't here ('' = it can).
    const fleet = { mode: 'send', blocked: sendingBlocked(), last: fleetData.last, pending: pending && { ...pending, rebootDetected: startedAt > pending.at } }
    // Restore after crash: remember what is running now; report what an earlier boot lost.
    if (sources.claude) {
      await restore.record(agents, now).catch(logSafely)
      const liveIds = new Set(agents.filter((a) => a.live).map((a) => a.id))
      fleet.restore = await restore.summary({ important: (id) => overrides[id]?.important === true, live: (id) => liveIds.has(id), removed: (id) => removed.has(id), now }).catch(() => null)
    } else fleet.restore = null
    // Which terminal "Open" would use (nothing is opened here); null hides the button.
    const open = { terminal: (await detectTerminal())?.name ?? null }
    const projects = await projectStore.update(agents, now, removed)
    return { serverTime: now, counts, agents, sources, warnings, fleet, open, projects, dock: dockState, loops: await loops.load(), helper: { enabled: (await helper.status()).enabled } }
  }

  function messageProblem(a) {
    if (a.provider === 'gemini' || a.harness === 'gemini-cli') return "Gemini agents can't be messaged from here yet"
    if (a.harness !== 'claude-code') return "Codex threads can't be messaged from here. Reply in Codex."
    if (['subagent', 'teammate', 'thread'].includes(a.kind)) return "Subagents can't be messaged. Message its lead instead."
    if (!a.live) return "Not running, so there's no session to message. Open it to resume it."
    return inboxProblem(inboxes.get(a.id))
  }
  /**
   * After a limit-triggered account switch: send "continue" (the fleet "continue" text) to the jobs that
   * stopped on the limit, once each. Same delivery as /api/fleet/send, with the same checks; a job whose
   * session isn't reachable yet (respawning) gets one retry after a few seconds. Returns the delivered ids.
   */
  async function nudgeAgents(ids) {
    if (usagePause.holding() || sendingBlocked() || dryRun()) return []
    const sent = new Set()
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 5000))
      cached = null
      const snap = await snapshot()
      for (const id of ids) {
        if (sent.has(id)) continue
        if (!limitStops.get(id)) continue // resumed since: its limit stop is gone from the fresh scan
        const a = snap.agents.find((x) => x.id === id)
        const inbox = inboxes.get(id)
        if (!a?.live || !inbox || inboxProblem(inbox)) continue
        if ((await deliver(inbox, 'continue')).ok) sent.add(id)
      }
      if (sent.size === ids.length) break
    }
    if (sent.size) await logFleet({ at: Date.now(), action: 'continue', source: 'autoswitch', results: [...sent].map((id) => ({ id, status: 'sent' })) })
    cached = null
    return [...sent]
  }
  const logFleet = async (entry) => {
    await fsp.mkdir(dataDir, { recursive: true }).catch(() => {})
    await fsp.appendFile(path.join(dataDir, 'fleet-log.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 }).catch(() => {})
  }
  /** ponytail: one global window per kind, single local user. Throws a 429 past `max` a minute. */
  const limit = (list, max, what) => {
    const now = Date.now()
    while (list.length && now - list[0] > 60_000) list.shift()
    if (list.length >= max) throw Object.assign(new Error(`Too many ${what}; wait a minute`), { status: 429 })
    list.push(now)
  }
  const token = (plan) => {
    for (const [k, v] of oneOffs) if (Date.now() > v.expires) oneOffs.delete(k)
    const confirm = crypto.randomUUID()
    oneOffs.set(confirm, { ...plan, expires: Date.now() + 120_000 })
    return confirm
  }
  /** The plan behind a confirm token, once. 409 when it expired, was used, or is another kind. */
  const redeem = (confirm, kinds) => {
    const plan = typeof confirm === 'string' && oneOffs.get(confirm)
    if (!plan || Date.now() > plan.expires || !kinds.includes(plan.kind)) throw Object.assign(new Error('This confirmation has expired. Check it again.'), { status: 409 })
    oneOffs.delete(confirm)
    return plan
  }

  // Polls every few seconds must be cheap: share one scan per SCAN_TTL_MS, never run two at once.
  // A scan that has just been asked for again returns the last one at once (up to STALE_MS old) and
  // refreshes behind it; actions that must see their own change clear `cached` first, so they wait.
  async function snapshot() {
    if (cached && Date.now() - cached.serverTime < SCAN_TTL_MS) return cached
    inflight ??= scanAll().then((s) => (cached = s)).finally(() => { inflight = null })
    if (cached && staleOk && Date.now() - cached.serverTime < STALE_MS) { inflight.catch(() => {}); return cached }
    return inflight
  }

  /** Walk up from the proposed parent through the current tree; reaching `id` means a cycle. */
  async function refuseCycle(id, parentId) {
    const parentOf = new Map((await snapshot()).agents.map((a) => [a.id, a.parentId]))
    for (let p = parentId, hops = 0; p && hops < 1000; p = parentOf.get(p), hops++) {
      if (p === id) throw Object.assign(new Error('That parent would create a cycle'), { status: 400 })
    }
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    let size = 0
    const chunks = []
    for await (const c of req) {
      size += c.length
      if (size > 16 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 })
      chunks.push(c)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
  }

  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
  async function serveStatic(req, res, url) {
    let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)))
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return send(res, 403, { error: 'Forbidden' })
    let st = await fsp.stat(file).catch(() => null)
    if (!st?.isFile()) { file = path.join(DIST, 'index.html'); st = await fsp.stat(file).catch(() => null) } // SPA fallback
    if (!st) return send(res, 404, { error: 'web/dist not built. Run npm run build.' })
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
  }

  /**
   * Built-in terminal → a terminal window, never both at once. The embedded process ends first
   * (and must actually exit), then the window opens with the same server-chosen command.
   */
  async function popout(id) {
    const running = terms.get(id)
    const { argv, cwd } = running || plain.get(id) || await openCommand((await snapshot()).agents.find((a) => a.id === id))
    const term = await detectTerminal()
    if (!term) return [501, { error: 'No supported terminal' }] // checked first: the embedded one stays
    if (running && !(await terms.end(id, 'popout'))) {
      return [504, { error: "The built-in terminal's process did not exit, so no second one was opened", closed: false }]
    }
    cached = null
    const r = await openInTerminal(term, argv, cwd)
    if (r.ok) return [200, { ok: true, terminal: term.name, closed: !!running }]
    return [502, { error: running ? `${r.error} The built-in terminal was already closed; open it again with Terminal.` : r.error, closed: !!running }]
  }

  /**
   * The terminal view's split layout → one Ghostty window with the same splits (ghostty-layout.mjs).
   * The same rule as `popout`, for every pane: never in both places. Every pane's command is decided
   * (and any refusal returned) before anything ends; then each embedded process ends and must exit;
   * only then does the window open. Ghostty only: no other terminal has scriptable splits.
   */
  async function popoutLayout(body) {
    const tree = normalizeLayout(body?.layout)
    const ids = layoutLeaves(tree)
    const term = await detectTerminal()
    if (!term) return [501, { error: 'No supported terminal' }]
    if (term.kind !== 'ghostty-mac') return [501, { error: 'Popping out a split layout needs Ghostty' }]
    const agents = (await snapshot()).agents
    const commands = new Map(), running = []
    for (const id of ids) {
      const live = terms.get(id)
      if (live) { running.push(id); commands.set(id, { argv: live.argv, cwd: live.cwd }); continue }
      const a = agents.find((x) => x.id === id)
      const own = plain.get(id)
      if (own) { commands.set(id, own); continue }
      try {
        commands.set(id, await openCommand(a))
      } catch (err) {
        if (!err.status) throw err
        return [err.status, { error: `${a?.name || 'An agent'}: ${err.message}`, closed: false }]
      }
    }
    const ended = await Promise.all(running.map((id) => terms.end(id, 'popout')))
    cached = null
    if (ended.some((ok) => !ok)) {
      return [504, { error: "A built-in terminal's process did not exit, so no Ghostty window was opened", closed: running.filter((_, i) => ended[i]) }]
    }
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined)
    const focus = typeof body?.focus === 'string' && ids.includes(body.focus) ? body.focus : null
    const launch = ghosttyLayoutLaunch(term.bin, tree, commands, { focus, cellW: n(body?.cell?.w), cellH: n(body?.cell?.h), width: n(body?.size?.w), height: n(body?.size?.h) })
    if (!launch) return [501, { error: 'Popping out a split layout needs Ghostty' }]
    if (isWin) return [501, { error: 'Popping out a split layout is not supported on Windows' }]
    const r = await runAppleScript(launch, HOME, 30000)
    if (r.ok) return [200, { ok: true, terminal: term.name, panes: ids.length, closed: running }]
    return [502, { error: running.length ? `${r.error} The built-in terminals were already closed; open them again from the list.` : r.error, closed: running }]
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local')
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' })
        return await serveStatic(req, res, url)
      }
      if (!isLocalRequest(req)) return send(res, 403, { error: 'Local requests only' })
      if (url.pathname === '/api/agents' && req.method === 'GET') {
        const snap = await snapshot()
        const info = terms.info()
        // A plain terminal with an agent inside it: that agent counts as "in the built-in terminal" too.
        const plainList = await plain.status(terms, snap.agents)
        return send(res, 200, { ...snap, term: { ...info, plain: plainList, running: [...info.running, ...plainList.map((p) => p.agentId).filter(Boolean)] } })
      }
      if (url.pathname === '/api/notify' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        let input
        try { input = parseNotify(await readBody(req)) } catch (err) { return send(res, err.status || 400, { ok: false, error: err.message }) }
        const agents = (await snapshot()).agents
        const id = resolveSession(input.session, agents, (x) => forks.get(x)?.sid || null)
        if (!id) return send(res, 404, { ok: false, error: 'no agent with that session' })
        if (!notifications.allow(id)) return send(res, 429, { ok: false, error: 'Too many notifications for this agent; wait a minute' })
        const notice = await notifications.add(id, input)
        cached = null // the next poll shows it
        return send(res, 200, { ok: true, id, notice })
      }
      if (url.pathname === '/api/notify/clear' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = await readBody(req)
        if (!body || typeof body.id !== 'string' || !body.id || body.id.length > 300) return send(res, 400, { ok: false, error: 'id is required' })
        if (await notifications.clear(body.id)) cached = null
        return send(res, 200, { ok: true })
      }
      if (url.pathname === '/api/world-plan' && await worldPlan(req, res, send)) return
      if (url.pathname === '/api/termlayout/popout' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = await readBody(req)
        // Counted with the other terminal requests. ponytail: one global window, single local user.
        const now = Date.now()
        while (termActs.length && now - termActs[0] > 60_000) termActs.shift()
        if (termActs.length >= termPerMinute) return send(res, 429, { error: 'Too many terminal requests; wait a minute' })
        termActs.push(now)
        return send(res, ...await popoutLayout(body))
      }
      if (url.pathname === '/api/term-plain' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = await readBody(req)
        const now = Date.now()
        while (termActs.length && now - termActs[0] > 60_000) termActs.shift()
        if (termActs.length >= termPerMinute) return send(res, 429, { error: 'Too many terminal requests; wait a minute' })
        termActs.push(now)
        if (!terms.available()) return send(res, 501, { error: 'Built-in terminal unavailable (node-pty did not load). Run npm install.' })
        // Only the kind (shell | claude | codex) and a folder from the allowed set are read; the command is ours.
        const e = await plain.create({ kind: body?.kind, cwd: body?.cwd, projects: knownProjects((await snapshot()).agents) })
        return send(res, 200, { id: e.id, kind: e.kind, name: e.title, cwd: e.cwd })
      }
      const tm = /^\/api\/term\/([^/]+)(\/popout)?$/.exec(url.pathname)
      if (tm && (req.method === 'POST' || (req.method === 'DELETE' && !tm[2]))) {
        let reattach = null, size = null
        if (req.method === 'POST') {
          if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
          // The server decides the command; the body may only name the boot a page re-attaches from,
          // and the size its terminal has (so a new PTY starts at that size; pty.mjs checks it).
          const body = await readBody(req)
          if (typeof body?.reattach === 'string' && body.reattach.length <= 64) reattach = body.reattach
          if (body?.cols != null && body?.rows != null) size = { cols: body.cols, rows: body.rows }
        }
        const id = decodeURIComponent(tm[1])
        if (req.method === 'DELETE') {
          const was = !!terms.get(id)
          const ended = await terms.end(id, 'stop')
          if (ended) plain.forget(id)
          cached = null
          return ended ? send(res, 200, { stopped: was }) : send(res, 504, { error: "The terminal's process did not exit" })
        }
        // ponytail: one global window, single local user. Starts, re-attaches and pop-outs all count.
        const now = Date.now()
        while (termActs.length && now - termActs[0] > 60_000) termActs.shift()
        if (termActs.length >= termPerMinute) return send(res, 429, { error: 'Too many terminal requests; wait a minute' })
        termActs.push(now)
        if (tm[2]) return send(res, ...await popout(id))
        if (!terms.available()) return send(res, 501, { error: 'Built-in terminal unavailable (node-pty did not load). Run npm install.' })
        // A reconnect never restarts a session that ended (exit, stop, idle) while the page was away.
        const why = terms.ended(id, reattach)
        if (why) return send(res, 410, { error: 'The terminal session has ended', ended: true, why })
        const running = terms.get(id)
        const agent = (await snapshot()).agents.find((a) => a.id === id)
        // An agent already in our PTY is re-attached; otherwise openCommand decides (and refuses).
        const own = plain.get(id) // a plain terminal: its command was fixed when it was created
        const { argv, cwd } = running || own || await openCommand(agent)
        const out = terms.open(id, { argv, cwd, kind: own ? 'shell' : argv[1] === 'attach' ? 'attach' : 'resume', name: own?.title || agent?.name || running?.name || id, size })
        cached = null
        return send(res, 200, out)
      }
      const m = /^\/api\/overrides\/(.+)$/.exec(url.pathname)
      if (m && req.method === 'PATCH') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const id = decodeURIComponent(m[1])
        const body = await readBody(req)
        if (typeof body?.parentId === 'string' && body.parentId && body.parentId !== id) await refuseCycle(id, body.parentId)
        const override = await store.patch(id, body)
        cached = null
        return send(res, 200, { id, override })
      }
      if (url.pathname === '/api/helper') {
        if (req.method === 'GET') return send(res, 200, await helper.status())
        if (req.method === 'POST') {
          if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
          const status = await helper.setEnabled((await readBody(req))?.enabled)
          cached = null
          return send(res, 200, status)
        }
      }
      const lm = /^\/api\/loops\/(.+)$/.exec(url.pathname)
      if (lm && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const entry = await loops.patch(decodeURIComponent(lm[1]), await readBody(req))
        cached = null
        return send(res, 200, entry)
      }
      // Switch one background job to bypass permissions. The job is looked up from the agent id here.
      const bm = /^\/api\/agents\/([^/]+)\/bypass$/.exec(url.pathname)
      if (bm && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        await readBody(req) // the body carries nothing we use
        const a = (await snapshot()).agents.find((x) => x.id === decodeURIComponent(bm[1]))
        if (!a) return send(res, 404, { error: 'No such agent' })
        if (a.harness !== 'claude-code' || a.kind !== 'job' || !a.jobId) return send(res, 409, { error: 'Only background jobs can be switched here' })
        const out = await permSwitch.toBypass(a.jobId, { live: a.live, reopened: Boolean(a.reopened) })
        cached = null
        return send(res, 200, out)
      }
      if (url.pathname === '/api/fleet/preview' && ['GET', 'POST'].includes(req.method)) {
        let action = url.searchParams.get('action')
        let text
        if (req.method === 'POST') {
          if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
          const body = await readBody(req)
          action = body?.action
          text = body?.text
          if (text !== undefined && (typeof text !== 'string' || text.length > 8000)) return send(res, 400, { error: 'text must be a string of at most 8000 characters' })
        }
        if (!ACTIONS.includes(action)) return send(res, 400, { error: 'Unknown action' })
        if (typeof text === 'string' && /cross-session-message/i.test(text)) return send(res, 400, { error: 'text may not contain a cross-session-message tag' })
        const snap = await snapshot()
        const plan = preview({ action, agents: snap.agents, store: await fleetStore.load(), dataDir, text, problemOf: (id) => inboxProblem(inboxes.get(id)) })
        const confirm = crypto.randomUUID()
        for (const [k, v] of plans) if (Date.now() > v.expires) plans.delete(k)
        plans.set(confirm, { action, targets: plan.targets.filter((t) => !t.problem).map((t) => ({ id: t.id, text: t.text })), expires: Date.now() + 120_000 })
        return send(res, 200, { ...plan, confirm, blocked: sendingBlocked() })
      }
      const o = /^\/api\/open\/(.+)$/.exec(url.pathname)
      if (o && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        await readBody(req) // the body carries nothing we use: the server decides the command
        const id = decodeURIComponent(o[1])
        // A second terminal on the same conversation is exactly what the single-process rule forbids.
        if (terms.get(id)) return send(res, 409, { error: 'Running in the built-in terminal; use Pop out' })
        const { argv, cwd } = await openCommand((await snapshot()).agents.find((a) => a.id === id))
        const term = await detectTerminal()
        if (!term) return send(res, 501, { error: 'No supported terminal' })
        // Counted only when a window is actually attempted. ponytail: one global window, single local user.
        const now = Date.now()
        while (opens.length && now - opens[0] > 60_000) opens.shift()
        if (opens.length >= 10) return send(res, 429, { error: 'Too many opens; wait a minute' })
        opens.push(now)
        const r = await openInTerminal(term, argv, cwd)
        return r.ok ? send(res, 200, { ok: true, terminal: term.name }) : send(res, 502, { error: r.error })
      }
      if (url.pathname === '/api/account' && req.method === 'GET') {
        return send(res, 200, await account.status((await snapshot()).agents))
      }
      if (['/api/account/switch', '/api/account/undo'].includes(url.pathname) && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = await readBody(req)
        const out = url.pathname.endsWith('/undo') ? await account.undo() : await account.switchTo(body, (await snapshot()).agents)
        cached = null
        return send(res, 200, out)
      }
      // Saved Claude accounts (server/accounts.mjs). No response ever carries a token.
      if (url.pathname === '/api/accounts' && req.method === 'GET') {
        const top = { ...(await account.accounts.list()), network: await network.status(), autoSwitch: await sampler.info() }
        // byProvider (§5): every provider with accounts; the top level stays Claude's.
        const st = providerSwitch.status()
        const byProvider = { claude: { ...top, exhausted: st.claude?.exhausted || null } }
        for (const p of providers()) {
          if (p.id === 'claude' || !p.capabilities?.accounts) continue
          try { byProvider[p.id] = { ...(await p.accounts.list()), autoSwitch: await samplers[p.id]?.info?.().catch(() => null) ?? null, exhausted: st[p.id]?.exhausted || null } }
          catch (e) { byProvider[p.id] = { accounts: [], error: e.status ? e.message : 'unavailable', exhausted: st[p.id]?.exhausted || null } }
        }
        return send(res, 200, { ...top, byProvider })
      }
      // The network this Mac is on, and marking it as the work Wi-Fi (network.mjs).
      if (url.pathname === '/api/network' && req.method === 'GET') return send(res, 200, await network.status({ fresh: true }))
      if (url.pathname === '/api/network/work' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const out = await network.mark(await readBody(req))
        sampler.enforce() // a quarantine account may now have to go
        return send(res, 200, out)
      }
      if (url.pathname === '/api/accounts/usage' && req.method === 'GET') {
        const fresh = url.searchParams.has('fresh')
        const out = await account.accounts.usage({ fresh })
        // Other providers' readings join the same list (ids never collide: gemini-antigravity, ...).
        for (const p of providers()) {
          if (p.id === 'claude' || !p.capabilities?.accounts || typeof p.accounts?.usage !== 'function') continue
          try { const r = await p.accounts.usage({ fresh }); for (const a of r?.accounts || []) (out.accounts ||= []).push({ ...a, provider: p.id }) } catch { /* that provider's bars show "Usage not checked" */ }
        }
        return send(res, 200, out)
      }
      const ac = /^\/api\/accounts\/(capture|add\/start|add\/finish|add\/cancel|[A-Za-z0-9-]{8,64})$/.exec(url.pathname)
      if (ac && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.method !== 'DELETE' && !/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = req.method === 'DELETE' ? null : await readBody(req)
        const what = ac[1]
        // Another provider's add flow (§5: POST /api/accounts/add/start { provider }).
        const prov = typeof body?.provider === 'string' ? body.provider : 'claude'
        if (prov !== 'claude' && req.method === 'POST' && what.startsWith('add/')) {
          const p = getProvider(prov)
          if (!p?.capabilities?.accounts) return send(res, 409, { error: `${p?.label || prov} accounts can't be added here` })
          if (what === 'add/finish') return send(res, 200, await p.accounts.addFinish(body))
          if (what === 'add/cancel') return send(res, 200, await p.accounts.addCancel())
          // Step 1: the adapter makes a fresh home and returns the sign-in argv (ours, never the page's).
          // `force` (start over) only from the page itself; bin and argv are always the server's.
          const force = body?.force === true && req.headers['x-agentville-ui'] === '1'
          let out
          try { out = typeof p.addStart === 'function' ? await p.addStart({ force }) : await p.accounts.addStart({ bin: await p.bin(), force }) }
          catch (e) { if (e.body) return send(res, e.status, e.body); if (e.status) return send(res, e.status, { error: e.message, ...(typeof e.code === 'string' && { code: e.code }) }); throw e }
          const { argv, env: _env, home: _home, ...shown } = out || {}
          const term = Array.isArray(argv) && argv.length && await detectTerminal()
          if (!term) return send(res, 200, { ...shown, opened: false, ...(!argv && { error: `${p.label} CLI not found` }) })
          const r = await openInTerminal(term, argv, os.homedir())
          // The terminal would not open: drop the pending add we just made so the next click starts clean.
          if (!r.ok) { await p.accounts.addCancel().catch(() => {}); return send(res, 500, { error: r.error || `Couldn't open a terminal for the ${p.label} sign-in` }) }
          return send(res, 200, { ...shown, opened: r.ok, terminal: term.name, ...(!r.ok && { error: r.error }) })
        }
        const accounts = account.accounts
        if (req.method === 'POST' && what === 'capture') return send(res, 200, await accounts.capture(body))
        if (req.method === 'POST' && what === 'add/finish') return send(res, 200, await accounts.addFinish(body))
        if (req.method === 'POST' && what === 'add/cancel') return send(res, 200, await accounts.addCancel())
        if (req.method === 'POST' && what === 'add/start') {
          const out = await accounts.addStart()
          // Opened here, on this request only; the argv is ours, never the page's.
          const bin = process.env.AGENTVILLE_CLAUDE_BIN || await findExecutable('claude', CLAUDE_DIRS)
          const term = bin && await detectTerminal()
          if (!term) return send(res, 200, { ...out, opened: false, ...(!bin && { error: 'Claude Code CLI not found' }) })
          const r = await openInTerminal(term, [bin, 'auth', 'login'], os.homedir())
          return send(res, 200, { ...out, opened: r.ok, terminal: term.name, ...(!r.ok && { error: r.error }) })
        }
        if (req.method === 'PATCH' && !what.includes('/') && what !== 'capture') return send(res, 200, await accounts.rename(what, body))
        if (req.method === 'DELETE' && !what.includes('/') && what !== 'capture') return send(res, 200, await accounts.remove(what))
      }
      if (url.pathname === '/api/spend' && req.method === 'GET') {
        const minutes = [60, 300, 1440, 10080].find((m) => String(m) === url.searchParams.get('minutes')) || 60
        await spend.update()
        return send(res, 200, { serverTime: Date.now(), spend: spend.summary(minutes), projection: await sampler.projection(), autoSwitch: await sampler.info() })
      }
      // The Models view: per agent, the model it is on, what it was told to use, route, context, tokens.
      if (url.pathname === '/api/models' && req.method === 'GET') {
        const snap = await snapshot()
        await spend.update()
        const profile = await account.profile().catch(() => 'personal')
        const gemini = new Map()
        await Promise.all(snap.agents.filter((a) => modelInfo.get(a.id)?.gemini).map(async (a) => { const g = await geminiFactsOf(a.id); if (g) gemini.set(a.id, g) }))
        return send(res, 200, buildModels({
          agents: snap.agents, info: modelInfo, facts: spend.modelFacts, profile, gemini,
          defaults: await readDefaults(claude.home()), catchingUp: spend.catchingUp(),
        }))
      }
      if (url.pathname === '/api/usage-pause' && req.method === 'GET') return send(res, 200, usagePause.info())
      if (url.pathname === '/api/usage-pause' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        return send(res, 200, await usagePause.setEnabled((await readBody(req))?.enabled))
      }
      if (url.pathname === '/api/sub-limit' && req.method === 'GET') return send(res, 200, await subLimit.info())
      if (url.pathname === '/api/sub-limit' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        return send(res, 200, await subLimit.setEnabled((await readBody(req))?.enabled))
      }
      if (url.pathname === '/api/autoswitch' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        return send(res, 200, await sampler.setEnabled((await readBody(req))?.enabled))
      }
      // ---- one agent: message it, or start, stop or fork one (README "Acting on agents") ----
      const json = () => { if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected application/json'), { status: 415 }) }
      if (url.pathname === '/api/message/preview' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const text = body?.text
        if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: "The message can't be empty." })
        if (text.length > 8000) return send(res, 400, { error: 'The message can be at most 8000 characters.' })
        if (/cross-session-message/i.test(text)) return send(res, 400, { error: 'The message may not contain a cross-session-message tag.' })
        const a = (await snapshot()).agents.find((x) => x.id === body?.id)
        if (!a) return send(res, 404, { error: 'No such agent' })
        const problem = a.messageWhy || sendingBlocked()
        if (problem) return send(res, 409, { error: problem })
        // Exactly what lands in the session: the text inside the peer-message wrapper.
        return send(res, 200, { id: a.id, name: a.name, text, sent: wrap(text), confirm: token({ kind: 'message', id: a.id, text }) })
      }
      if (url.pathname === '/api/message/send' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const blocked = sendingBlocked()
        if (blocked) return send(res, 501, { error: blocked })
        const plan = redeem(body?.confirm, ['message'])
        limit(messages, 10, 'messages')
        cached = null
        const a = (await snapshot()).agents.find((x) => x.id === plan.id)
        const inbox = inboxes.get(plan.id)
        let out
        if (!a?.live || !inbox) out = { id: plan.id, status: 'failed', detail: 'Session ended' }
        else if (inboxProblem(inbox)) out = { id: plan.id, status: 'failed', detail: inboxProblem(inbox) }
        else if (dryRun()) out = { id: plan.id, status: 'skipped', detail: 'Dry run' }
        else {
          const r = await deliver(inbox, plan.text)
          if (!r.ok) out = { id: plan.id, status: 'failed', detail: r.detail }
          else {
            const seen = await awaitReceipts([{ id: plan.id, msgId: r.msgId, file: transcriptOf.get(plan.id) }])
            out = seen.has(plan.id) ? { id: plan.id, status: 'delivered', at: seen.get(plan.id) } : { id: plan.id, status: 'sent-unconfirmed', detail: 'Not confirmed within 10 s' }
          }
        }
        await logFleet({ at: Date.now(), action: 'message', results: [out] })
        cached = null
        return send(res, 200, out)
      }
      // ---- many agents: "Message agents" (broadcast.mjs, README "Message agents") ----
      if (url.pathname === '/api/broadcast/preview' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const bad = textProblem(body?.text)
        if (bad) return send(res, 400, { error: bad })
        const picked = recipientIds(body?.ids)
        if (picked.error) return send(res, 400, { error: picked.error, max: MAX_RECIPIENTS })
        const blocked = sendingBlocked()
        if (blocked) return send(res, 409, { error: blocked })
        const byId = new Map((await snapshot()).agents.map((a) => [a.id, a]))
        const refused = picked.ids.map((id) => {
          const a = byId.get(id)
          const why = !a ? 'No longer listed' : a.messageWhy || (a.self ? SELF_WHY : '')
          return why && { id, name: a?.name || id, why }
        }).filter(Boolean)
        if (refused.length) return send(res, 409, { error: `${refused.length === 1 ? '1 of these agents' : `${refused.length} of these agents`} can't be messaged now. Review the list again.`, refused })
        const recipients = picked.ids.map((id) => ({ id, name: byId.get(id).name }))
        return send(res, 200, { recipients, count: recipients.length, text: body.text, sent: wrap(body.text), max: MAX_RECIPIENTS, confirm: token({ kind: 'broadcast', ids: picked.ids, text: body.text }) })
      }
      if (url.pathname === '/api/broadcast/send' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const blocked = sendingBlocked()
        if (blocked) return send(res, 501, { error: blocked })
        const held = typeof body?.confirm === 'string' && oneOffs.get(body.confirm)
        if (!held || Date.now() > held.expires || held.kind !== 'broadcast') return send(res, 409, { error: 'This confirmation has expired. Check it again.' })
        // Bound to the exact set and text that were confirmed: anything else needs a new confirm.
        const picked = recipientIds(body?.ids)
        if (picked.error || !sameSet(picked.ids, held.ids) || body?.text !== held.text) {
          oneOffs.delete(body.confirm)
          return send(res, 409, { error: 'The recipients or the message changed since you confirmed. Review them again.', changed: true })
        }
        limit(broadcasts, BROADCASTS_PER_MINUTE, 'broadcasts') // before redeeming: a 429 leaves the token usable
        const plan = redeem(body.confirm, ['broadcast'])
        cached = null
        const byId = new Map((await snapshot()).agents.map((a) => [a.id, a]))
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
        const line = (o) => { try { res.write(JSON.stringify(o) + '\n') } catch { /* the page went away; sending goes on */ } }
        line({ start: true, count: plan.ids.length })
        const results = await fanOut(plan.ids, {
          emit: ({ id, status, detail }) => line({ id, status, ...(detail && { detail }) }),
          send: async (id) => {
            const a = byId.get(id)
            const why = !a ? 'No longer listed' : a.messageWhy || (a.self ? SELF_WHY : '')
            if (why) return { ok: false, detail: why }
            const inbox = inboxes.get(id)
            if (!inbox) return { ok: false, detail: 'Session ended' }
            const problem = inboxProblem(inbox)
            if (problem) return { ok: false, detail: problem }
            if (dryRun()) return { skipped: true, detail: 'Dry run' }
            const r = await deliver(inbox, plan.text)
            return r.ok ? { ok: true, msgId: r.msgId, file: transcriptOf.get(id) } : { ok: false, detail: r.detail }
          },
        })
        const summary = summarize(results)
        // Ids, counts and outcomes only: never the text.
        await logFleet({ at: Date.now(), action: 'broadcast', count: results.length, summary, results: results.map(({ id, status, detail }) => ({ id, status, ...(detail && { detail }) })) })
        cached = null
        line({ done: true, summary })
        return res.end()
      }
      const ch = /^\/api\/agents\/([^/]+)\/changes$/.exec(url.pathname)
      if (ch && req.method === 'GET') {
        const a = (await snapshot()).agents.find((x) => x.id === decodeURIComponent(ch[1]))
        if (!a) return send(res, 404, { error: 'No such agent' })
        if (!a.cwd) return send(res, 200, { id: a.id, changes: null })
        return send(res, 200, { id: a.id, changes: await changes.detail(a.cwd) })
      }
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100)
        if (q.length < 2) return send(res, 200, { q, results: [] })
        await snapshot()
        const best = new Map()
        for (const t of titles) {
          const hit = t.names.find((n) => n.toLowerCase().includes(q))
          if (hit && (!best.has(t.id) || best.get(t.id).at < t.at)) best.set(t.id, { id: t.id, name: t.names[0], matched: hit, project: t.project, at: Math.round(t.at) })
        }
        const results = [...best.values()].sort((x, y) => y.at - x.at)
        return send(res, 200, { q, total: results.length, results: results.slice(0, 25) })
      }
      if (url.pathname === '/api/act/options' && req.method === 'GET') {
        const snap = await snapshot()
        // Per provider (§5): lists plus availability. The top-level lists stay Claude's for back-compat.
        const provs = {}
        for (const p of providers()) {
          if (!p.capabilities?.start) continue
          const st = await providerStatusOf(p.id)
          let o = {}
          try { o = p.options() } catch { o = {} }
          provs[p.id] = { label: p.label, models: o.models || [''], efforts: o.efforts || [''], modes: o.modes || [''], promptMax: o.promptMax || PROMPT_MAX, nameMax: o.nameMax || NAME_MAX,
            available: st.usable, why: st.usable ? '' : st.why }
        }
        return send(res, 200, { blocked: actionsBlocked(), projects: knownProjects(snap.agents).map(({ dir, name }) => ({ dir, name })), models: MODELS, efforts: EFFORTS, modes: MODES, promptMax: PROMPT_MAX, nameMax: NAME_MAX,
          defaultProvider: providerSettings.defaultProvider(), providers: provs })
      }
      // ---- providers (docs/providers-design.md §5) ----
      if (url.pathname === '/api/providers' && req.method === 'GET') {
        const s = providerSettings.get()
        return send(res, 200, { defaultProvider: s.defaultProvider, providerOrder: s.providerOrder, handoff: s.handoff, agentStarts: s.agentStarts, providers: await providerList() })
      }
      if (url.pathname === '/api/providers/settings' && req.method === 'PUT') {
        json()
        const body = await readBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Body must be a JSON object' })
        const starts = body.agentStarts && typeof body.agentStarts === 'object' ? { ...body.agentStarts } : null
        // Agents may call this API too: only the page (X-Agentville-UI: 1) may turn agent starts on.
        if (starts?.enabled === true && !providerSettings.get().agentStarts?.enabled && req.headers['x-agentville-ui'] !== '1') {
          return send(res, 403, { error: 'Turn agent starts on from Settings in Agentville' })
        }
        if (starts) {
          if (Number.isFinite(Number(starts.perHour))) starts.perHour = Math.min(Number(starts.perHour), AGENT_STARTS_MAX_PER_HOUR)
          if (Number.isFinite(Number(starts.maxDepth))) starts.maxDepth = Math.min(Number(starts.maxDepth), AGENT_STARTS_MAX_DEPTH)
        }
        let next
        try { next = providerSettings.set(starts ? { ...body, agentStarts: starts } : body) } catch (e) { return send(res, e.status || 400, { error: e.message }) }
        return send(res, 200, { ok: true, settings: next })
      }
      // An agent starts an agent (§5). Same guard as /api/notify: local only (above) and a JSON body.
      if (url.pathname === '/api/agents/start' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        if (typeof req.headers.origin !== 'string') return send(res, 403, { ok: false, error: 'Origin required' }) // isLocalRequest checked it matches
        const parsed = parseAgentStart(await readBody(req))
        if (!parsed.ok) return send(res, parsed.status || 400, { ok: false, error: parsed.error })
        const input = parsed.value // the plan is built from these fields only, never from the raw body
        cached = null
        const agents = (await snapshot()).agents // fresh: the caller must be live now
        const byId = new Map(agents.map((a) => [a.id, a]))
        const status = {}
        for (const p of providers()) status[p.id] = await providerStatusOf(p.id)
        const projects = knownProjects(agents)
        const port = String(server.address()?.port || '')
        // Synchronous from here to the record: two concurrent requests can't both pass the rate/depth checks.
        const verdict = checkAndRecord(input, {
          settings: providerSettings, launches,
          resolveSession: (session) => {
            const id = resolveSession(session, agents, (x) => forks.get(x)?.sid || null)
              || agents.find((a) => privateFacts.get(a.id)?.runId === session || privateFacts.get(a.id)?.sessionId === session)?.id
            const a = id && byId.get(id)
            return a ? { ...a, isSubagent: SUB_KIND.has(a.kind) } : null
          },
          providerStatus: (id) => status[id] || { usable: false, why: 'not installed' },
          knownProjects: () => projects,
          startPlan: (provider, i) => adapterOf(provider).startPlan({ cwd: i.cwd, prompt: i.prompt, name: i.name, model: i.model, permissionMode: i.permissionMode }, projects),
        })
        if (!verdict.ok) return send(res, verdict.status || 400, { ok: false, error: verdict.error })
        const undo = () => { try { rollback(verdict.launchId, { launches }) } catch (e) { logSafely(e) } }
        // --skip-trust only for a trusted (known project) folder. plan.skipTrust carries it to the runner; until the
        // runner honours it (it always passes --skip-trust today), an untrusted Gemini start is refused here.
        if (verdict.provider === 'gemini' && !verdict.trusted && !GEMINI_RUNNER_SKIP_TRUST) { undo(); return send(res, 403, { ok: false, error: 'Gemini agent starts need a known project folder' }) }
        if (verdict.provider === 'claude' && actionsBlocked()) { undo(); return send(res, 501, { ok: false, error: actionsBlocked() }) }
        try { limit(runs, 10, 'starts and stops') } catch (e) { undo(); throw e }
        const plan = { ...verdict.plan, parentAgentId: verdict.callerId, ...(verdict.provider === 'gemini' && { skipTrust: verdict.trusted === true }),
          env: { ...verdict.plan?.env, AGENTVILLE_PARENT_ID: verdict.callerId, ...(port && { AGENTVILLE_PORT: port }) } }
        const r = await adapterOf(verdict.provider).run(plan)
        const ref = r.ref?.runId || r.ref?.jobId || r.ref?.sessionId || r.jobId || null
        if (r.ok && ref) { try { launches.bind(verdict.launchId, ref, [r.id].filter(Boolean)) } catch (e) { logSafely(e) } }
        else undo()
        // Ids only: never the prompt, cwd or stderr.
        await logFleet({ at: Date.now(), action: 'agent-start', source: 'api', parent: verdict.callerId, provider: verdict.provider, ok: Boolean(r.ok && ref), ...(ref && { ref }) })
        cached = null
        if (!r.ok || !ref) return send(res, 502, { ok: false, error: 'start failed' })
        return send(res, 200, { ok: true, id: r.id || null, ref: r.ref || { jobId: r.jobId }, provider: verdict.provider })
      }
      const as = /^\/api\/agents\/([^/]+)\/status$/.exec(url.pathname)
      if (as && req.method === 'GET') {
        const id = decodeURIComponent(as[1])
        const a = (await snapshot()).agents.find((x) => x.id === id || privateFacts.get(x.id)?.runId === id || x.jobId === id)
        if (!a) return send(res, 404, { error: 'No such agent' })
        return send(res, 200, { id: a.id, provider: a.provider, bucket: a.bucket, live: a.live, handoff: a.handoff || null })
      }
      // Handoffs (§3.5). Without the engine: an empty list, and 404 for the actions.
      if (url.pathname === '/api/handoffs' && req.method === 'GET') {
        return send(res, 200, handoffs ? { handoffs: handoffs.list(), episodes: handoffs.info().episodes } : { handoffs: [], episodes: {} })
      }
      const hm = /^\/api\/handoffs\/([0-9a-f]{16})\/(undo|retry|dismiss|approve)$/.exec(url.pathname)
      if (hm && req.method === 'POST') {
        json()
        await readBody(req)
        if (!handoffs) return send(res, 404, { error: 'Handoffs are not available in this build' })
        const out = await handoffs[hm[2]](hm[1])
        cached = null
        return send(res, 200, out ?? { ok: true })
      }
      const mh = /^\/api\/agents\/([^/]+)\/handoff$/.exec(url.pathname)
      if (mh && req.method === 'POST') {
        json()
        const body = await readBody(req)
        if (!handoffs) return send(res, 404, { error: 'Handoffs are not available in this build' })
        const to = body?.to == null || body.to === '' ? undefined : String(body.to)
        if (to && !['claude', 'gemini'].includes(to)) return send(res, 400, { error: 'Unknown provider' })
        const out = await handoffs.start(decodeURIComponent(mh[1]), { to })
        cached = null
        return send(res, 200, out)
      }
      if (url.pathname === '/api/act/preview' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const snap = await snapshot()
        const a = typeof body?.id === 'string' ? snap.agents.find((x) => x.id === body.id) : null
        // New agents: `provider` (default: defaultProvider, §5). Stop/fork: the agent's own provider.
        const provider = body?.kind === 'start' ? (typeof body.provider === 'string' && body.provider ? body.provider : providerSettings.defaultProvider())
          : a ? providerOfAgent(a) || 'claude' : 'claude'
        const ad = body?.kind === 'start' || body?.kind === 'stop' ? adapterOf(provider) : null
        if (body?.kind === 'start' && !ad.capabilities?.start) return send(res, 409, { error: `${ad.label} agents can't be started from here` })
        const plan = provider === 'claude' || body?.kind === 'fork'
          ? (body?.kind === 'start' ? startPlan(fromPage(body), knownProjects(snap.agents))
            : body?.kind === 'stop' ? stopPlan(a)
            : body?.kind === 'fork' ? forkPlan(a, a && forks.get(a.id), body.name)
            : null)
          : body?.kind === 'start' ? ad.startPlan(fromPage(body), knownProjects(snap.agents))
          : body?.kind === 'stop' ? ad.stopPlan(withPrivate(a))
          : null
        if (!plan) return send(res, 400, { error: 'Unknown action' })
        const p = { ...plan, provider: plan.provider || provider }
        return send(res, 200, { kind: p.kind, provider: p.provider, id: p.id || null, name: p.name, command: adapterOf(p.provider).display(p), cwd: p.cwd, blocked: await blockedFor(p.provider), confirm: token(p) })
      }
      if (url.pathname === '/api/act/run' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        // The plan names its provider (set at preview); a token from before providers is Claude's.
        const held = typeof body?.confirm === 'string' && oneOffs.get(body.confirm)
        const provider = held?.provider || 'claude'
        const blocked = await blockedFor(provider)
        if (blocked) return send(res, 501, { error: blocked })
        const plan = redeem(body?.confirm, ['start', 'stop', 'fork'])
        limit(runs, 10, 'starts and stops')
        const r = await launchWithToken(withPort(plan), { via: 'ui', provider }, (p) => (provider === 'claude' ? runPlan(p) : adapterOf(provider).run(p)))
        // Ids and outcomes only: never the prompt.
        await logFleet({ at: Date.now(), action: plan.kind, ...(provider !== 'claude' && { provider }), ...(plan.id && { id: plan.id }), ...(plan.project && { project: plan.project }), ok: r.ok, ...(r.jobId && { jobId: r.jobId }), ...(r.ref?.runId && { runId: r.ref.runId }), ...(r.error && { error: r.error }) })
        cached = null
        return send(res, r.ok ? 200 : 502, r.ok ? { ok: true, kind: plan.kind, provider, jobId: r.jobId || null, id: r.id || null, name: plan.name } : { error: r.error })
      }
      // ---- Restore after crash (restore.mjs, README "Restore after crash") ----
      if (url.pathname === '/api/restore' && req.method === 'GET') {
        const snap = await snapshot()
        const overrides = await store.load()
        const byId = new Map(snap.agents.map((a) => [a.id, a]))
        const x = await restore.examine({ important: (id) => overrides[id]?.important === true, live: (id) => byId.get(id)?.live === true, removed: (id) => quietIds.has(id) })
        // The name the rest of the app shows for it (never prompt text), when the scan still knows it.
        const named = (e) => ({ ...e, name: byId.get(e.id)?.safeName || e.name })
        const lostJobs = x.jobs.filter((j) => j.verdict === 'lost').map(named)
        const lostSessions = x.sessions.filter((j) => j.verdict === 'lost').map(named)
        const excluded = {}
        for (const e of [...x.jobs, ...x.sessions, ...x.codex]) if (e.verdict !== 'lost') excluded[e.verdict] = (excluded[e.verdict] || 0) + 1
        return send(res, 200, { blocked: restoreBlocked(), crashBoot: x.crashBoot, boot: x.boot, at: x.at, dismissed: x.dismissed, jobs: lostJobs, sessions: lostSessions, codex: x.codex.filter((c) => c.verdict === 'lost').map(named), excluded, message: RESTORE_MESSAGE })
      }
      if (url.pathname === '/api/restore/preview' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const overrides = await store.load()
        const { plans, view } = await restore.preview(body?.ids, { important: (id) => overrides[id]?.important === true, removed: (id) => quietIds.has(id) })
        return send(res, 200, { ...view, blocked: restoreBlocked(), sendBlocked: sendingBlocked(), confirm: token({ kind: 'restore', plans }) })
      }
      if (url.pathname === '/api/restore/run' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const blocked = restoreBlocked()
        if (blocked) return send(res, 501, { error: blocked })
        const plan = redeem(body?.confirm, ['restore'])
        // The crown agents' one message: the inspector's path (peer-message frame + receipt).
        const sendTo = async (p, { inbox, file }) => {
          const why = sendingBlocked()
          if (why) return { status: 'skipped', detail: why }
          if (!inbox) return { status: 'failed', detail: "Can't be messaged yet" }
          const problem = inboxProblem(inbox)
          if (problem) return { status: 'failed', detail: problem }
          if (dryRun()) return { status: 'skipped', detail: 'Dry run' }
          const r = await deliver(inbox, RESTORE_MESSAGE)
          if (!r.ok) return { status: 'failed', detail: r.detail }
          const seen = await awaitReceipts([{ id: p.id, msgId: r.msgId, file }])
          return seen.has(p.id) ? { status: 'delivered', at: seen.get(p.id) } : { status: 'sent-unconfirmed', detail: 'Not confirmed within 10 s' }
        }
        const out = await restore.run(plan.plans, { send: sendTo })
        // Ids and outcomes only.
        await logFleet({ at: Date.now(), action: 'restore', results: out.results, messages: out.messages.map(({ id, status, detail }) => ({ id, status, ...(detail && { detail }) })) })
        cached = null
        return send(res, 200, out)
      }
      if (url.pathname === '/api/restore/dismiss' && req.method === 'POST') {
        json()
        await readBody(req)
        await restore.dismiss()
        cached = null
        return send(res, 200, { ok: true })
      }
      if (url.pathname === '/api/fleet/send' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = await readBody(req)
        const blocked = sendingBlocked()
        if (blocked) return send(res, 501, { error: blocked })
        const plan = typeof body?.confirm === 'string' && plans.get(body.confirm)
        if (!plan || Date.now() > plan.expires || plan.action !== body?.action) return send(res, 409, { error: 'This preview has expired. Open it again.' })
        // Only the previewed recipients, optionally fewer (unticked); the text is the preview's.
        let targets = plan.targets
        if (body.ids !== undefined) {
          if (!Array.isArray(body.ids) || !body.ids.every((i) => typeof i === 'string')) return send(res, 400, { error: 'ids must be a list of agent ids' })
          targets = targets.filter((t) => body.ids.includes(t.id))
        }
        // ponytail: one global window, fine for a single local user.
        const now = Date.now()
        while (sends.length && now - sends[0] > 60_000) sends.shift()
        if (sends.length >= 5) return send(res, 429, { error: 'Too many sends; wait a minute' })
        sends.push(now)
        plans.delete(body.confirm) // one send per preview
        cached = null
        const snap = await snapshot()
        const results = await Promise.all(targets.map(async (t) => {
          const a = snap.agents.find((x) => x.id === t.id)
          const inbox = inboxes.get(t.id)
          if (!a?.live || !inbox) return { id: t.id, status: 'failed', detail: 'Session ended' }
          const problem = inboxProblem(inbox)
          if (problem) return { id: t.id, status: 'failed', detail: problem }
          if (dryRun()) return { id: t.id, status: 'skipped', detail: 'Dry run' }
          const r = await deliver(inbox, t.text)
          return r.ok ? { id: t.id, status: 'sent', msgId: r.msgId, file: transcriptOf.get(t.id) } : { id: t.id, status: 'failed', detail: r.detail }
        }))
        const seen = await awaitReceipts(results.filter((r) => r.status === 'sent'))
        const out = results.map(({ id, status, detail }) => status !== 'sent' ? { id, status, ...(detail && { detail }) }
          : seen.has(id) ? { id, status: 'delivered', at: seen.get(id) } : { id, status: 'sent-unconfirmed', detail: 'Not confirmed within 10 s' })
        // A sent prep pauses its recipients exactly like a manual mark did.
        const reached = out.filter((r) => ['delivered', 'sent-unconfirmed'].includes(r.status)).map((r) => r.id)
        if (plan.action !== 'continue' && reached.length) await fleetStore.mark({ action: plan.action, ids: reached })
        await logFleet({ at: now, action: plan.action, results: out })
        cached = null
        return send(res, 200, { action: plan.action, results: out })
      }
      // Update check (update.mjs): ?fresh asks GitHub again (at most once a minute).
      if (url.pathname === '/api/update' && req.method === 'GET') {
        return send(res, 200, url.searchParams.has('fresh') ? await updater.check() : await updater.status())
      }
      if (url.pathname === '/api/update/settings' && req.method === 'PUT') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = await readBody(req)
        if (body?.autoUpdate !== undefined && typeof body.autoUpdate !== 'boolean') return send(res, 400, { error: 'autoUpdate must be true or false' })
        return send(res, 200, updater.configure({ autoUpdate: body?.autoUpdate, dismissAppBuild: body?.dismissAppBuild === true }))
      }
      if (url.pathname === '/api/update/apply' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        await readBody(req) // the body carries nothing we use
        const out = await updater.apply()
        // Respond first; the restart closes this server.
        if (out.restarting) res.once('finish', () => setTimeout(() => updater.restartNow(), 200))
        return send(res, out.ok ? 200 : 409, out)
      }
      if (url.pathname === '/api/fleet/mark' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const record = await fleetStore.mark(await readBody(req))
        cached = null
        return send(res, 200, { ok: true, record })
      }
      return send(res, 404, { error: 'Not found' })
    } catch (e) {
      try { send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' }) } catch { /* the client went away */ }
      if (!e.status) logSafely(e)
    }
  })
  // The usage sampler (and auto-switch) runs once a minute while the server is up. Under test it
  // runs only when AGENTVILLE_SAMPLE_MS names an interval (and accounts point at a fake home).
  const testing = process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
  const sampleMs = Number(process.env.AGENTVILLE_SAMPLE_MS) || (testing ? 0 : 60_000)
  if (sampleMs && !accountsBlocked()) {
    // tokens keep pace with readings, page open or not; stopped sub-agents are checked on the fresh reading
    // then the usage pause (enter, hold, or resume), then sub-limit (held while paused; after a resume it picks up the killed sub-agents)
    const tick = () => {
      Promise.resolve(sampler.sample()).finally(() => Promise.resolve(usagePause.tick()).catch(() => {}).finally(() => { if (!usagePause.holding()) subLimit.tick() }))
      for (const [id, s] of Object.entries(samplers)) if (id !== 'claude') Promise.resolve(s.sample()).catch(() => {})
      spend.update().catch(() => {})
    }
    const first = setTimeout(tick, Math.min(3000, sampleMs))
    const every = setInterval(tick, sampleMs)
    // The network rule (quarantine accounts and the work Wi-Fi) is checked every 10 s.
    const watch = setInterval(() => sampler.enforce(), Math.min(10_000, sampleMs))
    first.unref(); every.unref(); watch.unref()
    server.on('close', () => { clearTimeout(first); clearInterval(every); clearInterval(watch) })
  }
  // Provider exhaustion + handoffs (§3.2-3.4): once per loop, after the samplers, whatever accountsBlocked() says
  // (a provider without accounts needs no account module). providerSwitch.tick() is called only here.
  if (sampleMs) {
    let busy = false
    const providerTick = async () => {
      if (busy) return
      busy = true
      try { await providerSwitch.tick(); await handoffs?.tick() } catch (e) { logSafely(e) } finally { busy = false }
    }
    const pFirst = setTimeout(providerTick, Math.min(5000, sampleMs))
    const pEvery = setInterval(providerTick, sampleMs)
    pFirst.unref(); pEvery.unref()
    server.on('close', () => { clearTimeout(pFirst); clearInterval(pEvery) })
  }
  // Adapters that start processes inject AGENTVILLE_PORT; the port is known once listening.
  server.on('listening', () => { for (const p of providers()) { try { if (p.id !== 'claude') p.configure({ port: server.address()?.port }) } catch (e) { logSafely(e) } } })
  updater.start().catch(() => {})
  server.on('close', () => updater.stop())
  prPoll.start(30_000) // after the first scans have filled in the PRs; no-op when the interval is 0 (the default under test)
  server.on('close', () => prPoll.stop())
  server.on('upgrade', (req, socket, head) => terms.upgrade(req, socket, head))
  // Before close, not on 'close': open WebSockets would otherwise keep the server from closing.
  const close = server.close.bind(server)
  server.close = (cb) => { terms.closeAll(); return close(cb) }
  Object.assign(server, { sampler, samplers, providerSwitch, handoffs, providerSettings, launches, spend, terms, updater, subLimit, usagePause, prewarm: () => snapshot().catch(() => {}) })
  return server
}

