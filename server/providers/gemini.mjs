// Gemini provider adapter (docs/providers-design.md section 1.4), driving the Antigravity CLI (`agy`), which
// replaced Gemini CLI for Google AI Pro/Ultra accounts (docs/antigravity-cli-notes.md). Provider id stays `gemini`.
// Composes server/gemini/*:
//   runner.mjs     createRunner({ dataDir, bin, port }) -> { start, resume, stop, refresh, get, list, dirOf, prune }; startArgs
//   scan.mjs       scan(now, { runs }), configure({ dataDir }), home
//   transcript.mjs readTranscript(agent, { maxBytes })   (agent.transcriptFile, kept server-side here)
//   accounts.mjs   createGeminiAccounts({ dataDir, bin }) -> { accounts, switcher: null, credentials, loginArgv }
//   limits.mjs     isLimitText(text, exitCode), limitModel(text, model), usage(), tuning
// One agy sign-in per OS user (OS keyring), so the provider is single-account with no switcher.
// Every import is guarded: a missing module degrades that part of the adapter and available() says why.
//
// Agent ids: `gemini:<runId>` when Agentville's runner owns the session (stable from the first scan, before agy
// reports a conversation id), `gemini:<conversationId>` for a session the user ran by hand (display only).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findExecutable } from '../terminal.mjs'
import { quoteForShell } from '../platform.mjs'

const load = async (name) => {
  try { return { mod: await import(name) } } catch (e) { return { mod: null, error: String(e?.message || e) } }
}
const [R, S, T, A, L] = await Promise.all(['../gemini/runner.mjs', '../gemini/scan.mjs', '../gemini/transcript.mjs',
  '../gemini/accounts.mjs', '../gemini/limits.mjs'].map(load))
const runnerMod = R.mod, scanMod = S.mod, transcript = T.mod, acctMod = A.mod, limits = L.mod
const createAccounts = acctMod?.createGeminiAccounts || acctMod?.createAccounts
const HAS_ACCOUNTS = typeof createAccounts === 'function'

const bad = (message, status = 400) => Object.assign(new Error(message), { status })
const missing = (what, r) => bad(`Gemini ${what} is not available${r?.error ? ` (${r.error})` : ''}`, 503)
const stamp = (plan) => ({ ...plan, provider: 'gemini' })
const MISSING_WHY = () => [['runner', R], ['scan', S], ['transcript', T], ['accounts', A], ['limits', L]]
  .filter(([, x]) => !x.mod).map(([n]) => n).join(', ')

export const AGY_MISSING = 'Antigravity CLI not found. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash (Windows: irm https://antigravity.google/cli/install.ps1 | iex)'
/** Where agy lives besides PATH: ~/.local/bin (Unix installer), %LOCALAPPDATA%\\agy\\bin (Windows installer). */
export function agyDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || home, 'AppData', 'Local')
    return [path.join(local, 'agy', 'bin'), path.join(env.USERPROFILE || home, '.local', 'bin')]
  }
  return [path.join(home, '.local', 'bin')]
}
export const NOT_SIGNED_IN = 'Gemini (Antigravity) is not signed in. Open the account menu and choose Add Gemini account.'
const binPath = async () => process.env.AGENTVILLE_AGY_BIN || process.env.AGENTVILLE_GEMINI_BIN || findExecutable('agy', agyDirs())
const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'

// Model slugs come from `agy models` on a real install; until then only the CLI default is offered.
export const MODELS = ['']
// '' = default (agy accept-edits), auto, plan. There is no yolo (--dangerously-skip-permissions is never passed).
export const MODES = ['', 'auto', 'plan']
/** Older Gemini CLI / agent-start names that mean the default. */
const MODE_ALIAS = { default: '', auto_edit: '', 'accept-edits': '' }
export const PROMPT_MAX = 8000
export const NAME_MAX = 80

let dataDir = null
let port = null // Agentville's port, injected into every run as AGENTVILLE_PORT (§5)
let runner = null // createRunner() result, built on first use once dataDir and the bin are known
let runnerBin = null
let bound = null // createGeminiAccounts() result: { accounts, switcher: null, credentials, loginArgv }
const noted = new Set() // runId:limitAt already reported to accounts.noteLimit
let privateOf = new Map() // agent id -> { transcriptFile, runId, sessionId } from the last scan

async function getRunner() {
  if (!runnerMod?.createRunner) throw missing('runner', R)
  if (!dataDir) throw bad('The Gemini adapter is not configured yet', 503)
  const bin = await binPath()
  if (!bin) throw bad(AGY_MISSING, 409)
  if (!runner || runnerBin !== bin) { runner = runnerMod.createRunner({ dataDir, bin, port }); runnerBin = bin }
  return runner
}
/** Runner states without spawning anything (no bin needed): list() only reads and refreshes state files. */
function listRuns() {
  if (!runnerMod?.createRunner || !dataDir) return []
  try { return (runner || runnerMod.createRunner({ dataDir })).list() } catch { return [] }
}

const accountsPart = () => {
  if (bound) return bound
  if (!HAS_ACCOUNTS) throw missing('accounts', A)
  if (!dataDir) throw bad('The Gemini adapter is not configured yet', 503)
  bound = createAccounts({ dataDir, bin: binPath })
  return bound
}
const delegate = (pick, names) => Object.fromEntries(names.map((n) => [n, (...a) => {
  const o = pick()
  if (typeof o?.[n] !== 'function') throw missing(`accounts.${n}`)
  return o[n](...a)
}]))
const ACCOUNT_OPS = ['load', 'list', 'usage', 'cachedUsage', 'activeUsage', 'capture', 'addStart', 'addFinish',
  'addCancel', 'rename', 'remove', 'readLive', 'identify', 'activate', 'restoreLive', 'checkActive', 'headroom']
const accountsProxy = delegate(() => accountsPart().accounts, ACCOUNT_OPS)
const credentialsProxy = delegate(() => accountsPart().credentials, ['read', 'write', 'identify'])

/** A run that stopped on the quota: mark its account out (once per stop). Best effort. */
async function noteLimitOf(run) {
  if (!HAS_ACCOUNTS || !dataDir || run?.state !== 'limit') return
  const key = `${run.runId}:${run.limitStop?.at || run.endedAt || 0}`
  if (noted.has(key)) return
  noted.add(key)
  try {
    await accountsPart().accounts.noteLimit?.(undefined, run.limitStop?.at || undefined)
  } catch { /* the sampler sees it on the next limit anyway */ }
}

const DEFAULT_LIMIT = /quota|RESOURCE_EXHAUSTED|\b429\b|rate.?limit/i
const runIdOf = (agent) => {
  const id = String(agent?.id || '')
  if (!id.startsWith('gemini:')) return null
  const p = privateOf.get(id)
  if (p) return p.runId || null
  const key = id.slice(7)
  return listRuns().find((r) => r.runId === key || r.sessionId === key)?.runId || null
}

/** Runner state -> the extra fact fields the scan doesn't derive (limit, error, idle turns, activity time). */
function applyRun(f, run, now) {
  if (!run) return f
  const at = Math.max(f.lastActivityAt || 0, run.endedAt || 0, run.turnStartedAt || 0)
  f.lastActivityAt = at
  f.jobId = null
  if (run.state === 'limit') {
    const stopAt = run.limitStop?.at || run.endedAt || now
    Object.assign(f, { lifecycle: 'failed', errorReason: 'Usage limit reached on Gemini (Antigravity)', live: false,
      limitStop: { at: stopAt, resetsAt: run.limitStop?.resetsAt || null, kind: 'limit' },
      limitStopAt: stopAt, limitDetail: String(run.limitStop?.text || '').slice(0, 300) })
  } else if (run.state === 'error') Object.assign(f, { lifecycle: 'failed', errorReason: `Hit an error: ${String(run.error || '').slice(0, 120)}`.trim(), ...(run.authNeeded && { authNeeded: true }) })
  else if (run.state === 'idle' && f.lifecycle !== 'running') f.lifecycle = 'idle'
  else if (run.state === 'exited') f.lifecycle = 'dead'
  return f
}

/** Runs only (no scan module): one fact per run Agentville started. */
function runFact(run, now) {
  const cwd = run.cwd || null
  const live = run.state === 'running'
  return applyRun({ id: `gemini:${run.runId}`, harness: 'gemini-cli', provider: 'gemini', kind: 'session',
    name: String(run.name || ''), title: '', project: cwd ? path.basename(cwd) : 'unknown', cwd, parentId: run.parentAgentId || null,
    live, lastActivityAt: run.startedAt || 0, lifecycle: live ? 'running' : run.state === 'stopped' ? 'stopped' : 'idle',
    needsUser: false, prs: [], resume: null, runId: run.runId, handoffId: run.handoffId || null, transcriptFile: null }, run, now)
}

function cleanName(v) {
  if (v == null || v === '') return ''
  if (typeof v !== 'string') throw bad('The name must be text')
  const s = v.trim()
  if (s.length > NAME_MAX) throw bad(`The name can be at most ${NAME_MAX} characters`)
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad('The name must be one line of text')
  return s
}
const pick = (v, list, what) => { const s = v == null ? '' : v; if (!list.includes(s)) throw bad(`Unknown ${what}`); return s }

export default {
  id: 'gemini',
  label: 'Gemini (Antigravity)',
  harness: 'gemini-cli',
  // accounts: display only (one "Antigravity sign-in" entry); switcher is null.
  capabilities: { start: true, stop: true, resume: true, fork: false, message: false, accounts: HAS_ACCOUNTS, usage: 'estimate', handoffTarget: true },

  // environment
  home: () => (scanMod?.home ? scanMod.home() : process.env.AGENTVILLE_AGY_HOME || os.homedir()),
  available: async () => {
    if (!runnerMod?.createRunner) return { ok: false, why: `Gemini runner module missing${R.error ? ` (${R.error})` : ''}` }
    if (testing() && !process.env.AGENTVILLE_GEMINI_BIN && !process.env.AGENTVILLE_AGY_BIN) return { ok: false, why: 'Starting Gemini agents is disabled in tests' }
    const bin = await binPath()
    if (!bin) return { ok: false, why: AGY_MISSING }
    return { ok: true, why: '' }
  },
  bin: binPath,
  sessionEnv: ['AGENTVILLE_AGENT_ID'],
  missingModules: MISSING_WHY,

  // discovery
  async scan(now = Date.now()) {
    const runs = listRuns()
    for (const r of runs) {
      await noteLimitOf(r)
      if (r.state === 'error' && r.authNeeded && HAS_ACCOUNTS && dataDir) { try { await accountsPart().accounts.noteSignedOut?.(r.endedAt || undefined) } catch { /* best effort */ } }
    }
    const byRun = new Map(runs.map((r) => [r.runId, r]))
    let facts
    if (scanMod?.scan) facts = await scanMod.scan(now, { dataDir, runs: async () => runs })
    else facts = Object.assign(runs.map((r) => runFact(r, now)), { unreadable: 0, titles: {} })
    const titles = []
    const priv = new Map()
    for (const f of facts) {
      const sid = f.id.startsWith('gemini:') ? f.id.slice(7) : null
      // One stable id per run: gemini:<runId> whenever the runner owns the session.
      if (f.runId) f.id = `gemini:${f.runId}`
      f.provider = 'gemini'; f.harness = f.harness || 'gemini-cli'
      applyRun(f, byRun.get(f.runId), now)
      const r = byRun.get(f.runId)
      priv.set(f.id, { transcriptFile: f.transcriptFile || null, runId: f.runId || null, sessionId: r?.conversationId || r?.sessionId || f.sessionId || sid })
      const t = facts.titles?.[f.id] || facts.titles?.[`gemini:${sid}`]
      if (t) titles.push({ id: f.id, names: [f.name, t].filter(Boolean), project: f.project, at: f.lastActivityAt || 0 })
    }
    privateOf = priv
    const out = facts
    out.titles = titles
    return out
  },
  /** `{ dataDir, account? }`. Binds the account module to dataDir and the scan to the runs folder. */
  configure(opts = {}) {
    if (opts.port !== undefined) { port = opts.port || null; runner = null }
    if (opts.dataDir !== undefined && opts.dataDir !== dataDir) {
      dataDir = opts.dataDir; runner = null; bound = null
      try { runnerMod?.createRunner?.({ dataDir }).prune?.() } catch { /* best effort, once per data folder */ }
    }
    if (opts.account) bound = opts.account
    if (HAS_ACCOUNTS && dataDir) {
      const part = accountsPart()
      this.accounts = part.accounts; this.credentials = part.credentials
    }
    scanMod?.configure?.({ dataDir })
  },
  /** Step 1 of signing in: addStart with the real bin, so its argv (plain `agy`) can be opened in a terminal. */
  async addStart({ force = false } = {}) { return accountsPart().accounts.addStart({ bin: (await binPath()) || null, force: force === true }) },
  /** From the runner state: running -> busy, limit -> limit, finished turn -> idle, stopped/gone -> gone. */
  async activity(agent) {
    const runId = runIdOf(agent)
    const st = runId && runner ? runner.refresh(runId) : runId ? listRuns().find((r) => r.runId === runId) : null
    if (st) return st.state === 'running' ? 'busy' : st.state === 'limit' ? 'limit' : st.state === 'idle' || st.state === 'error' ? 'idle' : 'gone'
    if (agent?.limitStopAt > 0) return 'limit'
    if (agent?.live === false) return 'gone'
    return agent?.bucket === 'building' ? 'busy' : 'idle'
  },

  // start / resume / stop
  options: () => ({ models: MODELS, efforts: [''], modes: MODES, promptMax: PROMPT_MAX, nameMax: NAME_MAX }),
  startPlan(body, projects = []) {
    if (!body || typeof body !== 'object') throw bad('Body must be a JSON object')
    let project = projects.find((p) => p.dir === body.cwd)
    if (!project && typeof body.cwd === 'string' && body.cwd.length <= 1024 && path.isAbsolute(body.cwd) && !/[\u0000-\u001f]/.test(body.cwd)) {
      if (!fs.statSync(body.cwd, { throwIfNoEntry: false })?.isDirectory()) throw bad(`No such folder: ${body.cwd}`)
      const dir = path.resolve(body.cwd)
      project = { dir, name: path.basename(dir) || dir }
    }
    if (!project) throw bad('Pick a project, or type the full path of a folder')
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw bad('Write a prompt for the new agent')
    if (body.prompt.length > PROMPT_MAX) throw bad(`The prompt can be at most ${PROMPT_MAX} characters`)
    if (/\0/.test(body.prompt)) throw bad("The prompt can't contain a NUL character")
    const name = cleanName(body.name)
    const model = pick(body.model, MODELS, 'model')
    const rawMode = body.permissionMode == null ? '' : body.permissionMode
    const mode = pick(Object.hasOwn(MODE_ALIAS, rawMode) ? MODE_ALIAS[rawMode] : rawMode, MODES, 'permission mode')
    let args
    try { args = runnerMod?.startArgs ? runnerMod.startArgs({ prompt: body.prompt, model, mode }) : [`--prompt=${body.prompt}`] } catch (e) { throw bad(e.message) }
    // body.env is never forwarded (security review). Only the handoff id the engine sets is kept, as a field.
    const hid = typeof body.env?.AGENTVILLE_HANDOFF_ID === 'string' && /^[0-9a-f]{16}$/.test(body.env.AGENTVILLE_HANDOFF_ID) ? body.env.AGENTVILLE_HANDOFF_ID : null
    return stamp({ kind: 'start', args, cwd: project.dir, name, project: project.name, prompt: body.prompt, model, mode,
      ...(typeof body.parentAgentId === 'string' && { parentAgentId: body.parentAgentId }),
      ...(hid && { handoffId: hid }) })
  },
  /** A follow-up turn on a run Agentville started (`--conversation <id>`). */
  resumePlan(agent, { prompt } = {}) {
    if (!agent) throw bad('No such agent', 404)
    const runId = runIdOf(agent)
    if (!runId) throw bad('Only Gemini agents started from Agentville can be resumed here', 409)
    const text = String(prompt || 'continue')
    const sid = privateOf.get(agent.id)?.sessionId
    let args
    try { args = runnerMod?.startArgs ? runnerMod.startArgs({ prompt: text, resume: sid || undefined }) : [`--prompt=${text}`] } catch (e) { throw bad(e.message) }
    return stamp({ kind: 'resume', args, cwd: agent.cwd || '', id: agent.id, name: agent.name, runId, prompt: text })
  },
  stopPlan(agent) {
    if (!agent) throw bad('No such agent', 404)
    const runId = runIdOf(agent)
    if (!runId) throw bad('Only Gemini agents started from Agentville can be stopped here', 409)
    if (!agent.live) throw bad("This agent isn't running", 409)
    return stamp({ kind: 'stop', args: [], cwd: agent.cwd || '', id: agent.id, name: agent.name, runId })
  },
  display: (plan) => (plan.kind === 'stop' ? `stop Gemini run ${plan.runId}`
    : ['agy', ...plan.args].map((x) => (/^[\w@%+=:,./[\]-]+$/.test(x) ? x : quoteForShell(x))).join(' ')),
  /** Never rejects. start -> { ok, ref:{ runId, sessionId }, id }. */
  run: async (plan) => {
    try {
      const r = await getRunner()
      if (plan.kind === 'start') {
        // A headless agy with no sign-in opens a browser and waits (agy 1.5.16): never start one before the user
        // confirmed a sign-in with "Add Gemini account" -> "I've signed in".
        if (HAS_ACCOUNTS && !testing() && !(await accountsPart().accounts.signedIn?.())) return { ok: false, error: NOT_SIGNED_IN }
        // No yolo path exists: MODES has none and the runner never passes --dangerously-skip-permissions.
        // The per-launch token of an agent start (launches.mjs TOKEN_ENV) rides in accountEnv: the runner's env is
        // an allowlist and accountEnv is the one map it merges whole.
        const tok = typeof plan.env?.AGENTVILLE_AGENT_TOKEN === 'string' && /^[\w-]{16,200}$/.test(plan.env.AGENTVILLE_AGENT_TOKEN) ? plan.env.AGENTVILLE_AGENT_TOKEN : null
        const mode = Object.hasOwn(MODE_ALIAS, plan.mode || '') ? '' : plan.mode
        const st = r.start({ accountEnv: tok ? { AGENTVILLE_AGENT_TOKEN: tok } : undefined, cwd: plan.cwd, prompt: plan.prompt,
          model: plan.model || undefined, mode: MODES.includes(mode) ? mode : '', name: plan.name,
          parentAgentId: plan.parentAgentId || null, handoffId: plan.handoffId || null })
        return { ok: true, id: st.agentId, ref: { runId: st.runId, sessionId: st.sessionId } }
      }
      if (plan.kind === 'resume') { const st = r.resume(plan.runId, plan.prompt); return { ok: true, id: st.agentId, ref: { runId: st.runId, sessionId: st.sessionId } } }
      if (plan.kind === 'stop') { await r.stop(plan.runId); return { ok: true, ref: { runId: plan.runId } } }
      return { ok: false, error: `Unknown plan kind ${plan.kind}` }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  },

  // credentials + accounts
  accounts: accountsProxy,
  credentials: credentialsProxy,
  switcher: null, // one agy sign-in per OS user: nothing to switch between

  // usage + limits
  isLimitText: (t, exitCode) => (limits?.isLimitText ? limits.isLimitText(t, exitCode) : DEFAULT_LIMIT.test(String(t || ''))),
  limitModel: (t, model) => (limits?.limitModel ? limits.limitModel(t, model) : ''),
  tuning: limits?.tuning || {},

  // handoff: the transcript file is server-private, kept from the last scan
  readTranscript: async (agent, opts) => {
    if (!transcript?.readTranscript) return []
    const file = agent?.transcriptFile || privateOf.get(agent?.id)?.transcriptFile
    return transcript.readTranscript({ ...agent, transcriptFile: file }, opts)
  },
}
