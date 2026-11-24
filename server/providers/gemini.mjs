// Gemini provider adapter (docs/providers-design.md section 1.4). Composes server/gemini/*:
//   runner.mjs     createRunner({ dataDir, bin, port }) -> { start, resume, stop, refresh, get, list, dirOf, prune }; startArgs
//   scan.mjs       scan(now, { runs }), configure({ dataDir, homes }), home
//   transcript.mjs readTranscript(agent, { maxBytes })   (agent.transcriptFile, kept server-side here)
//   accounts.mjs   createGeminiAccounts({ dataDir, busyHomes }) -> { accounts, switcher, credentials, envFor, homes, accountOfHome, loginArgv }
//   limits.mjs     isLimitText(text, exitCode), limitModel(text, model), usage(), tuning
// Every import is guarded: a missing module degrades that part of the adapter and available() says why.
//
// Agent ids: `gemini:<runId>` when Agentville's runner owns the session (stable from the first scan, before any
// session file exists), `gemini:<sessionId>` for a session Agentville did not start. The runner state's
// `sessionId` maps one to the other, so one run is always one agent.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findExecutable } from '../terminal.mjs'
import { cliDirs, quoteForShell } from '../platform.mjs'

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

const binPath = async () => process.env.AGENTVILLE_GEMINI_BIN || findExecutable('gemini', cliDirs('gemini'))
const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'

// New launches never get yolo from the form (same rule as Claude's bypassPermissions).
export const MODELS = ['', 'gemini-2.5-pro', 'gemini-2.5-flash']
export const MODES = ['', 'auto_edit']
export const PROMPT_MAX = 8000
export const NAME_MAX = 80

let dataDir = null
let port = null // Agentville's port, injected into every run as AGENTVILLE_PORT (§5)
let runner = null // createRunner() result, built on first use once dataDir and the bin are known
let runnerBin = null
let bound = null // createGeminiAccounts() result: { accounts, switcher, credentials, envFor, homes, accountOfHome, loginArgv }
const noted = new Set() // runId:limitAt already reported to accounts.noteLimit
let privateOf = new Map() // agent id -> { transcriptFile, runId, sessionId } from the last scan

async function getRunner() {
  if (!runnerMod?.createRunner) throw missing('runner', R)
  if (!dataDir) throw bad('The Gemini adapter is not configured yet', 503)
  const bin = await binPath()
  if (!bin) throw bad('Gemini CLI not found', 409)
  if (!runner || runnerBin !== bin) { runner = runnerMod.createRunner({ dataDir, bin, port }); runnerBin = bin }
  return runner
}
/** The active account's env for a new turn (null: no saved account, the CLI's own home). */
const accountEnv = async () => (HAS_ACCOUNTS ? accountsPart().envFor() : null)
/** Runner states without spawning anything (no bin needed): list() only reads and refreshes state files. */
function listRuns() {
  if (!runnerMod?.createRunner || !dataDir) return []
  try { return (runner || runnerMod.createRunner({ dataDir })).list() } catch { return [] }
}

/** Homes that running Gemini processes use: P7 refuses to delete those. */
const busyHomes = async () => listRuns().filter((r) => r.state === 'running' && r.home).map((r) => r.home)
const accountsPart = () => {
  if (bound) return bound
  if (!HAS_ACCOUNTS) throw missing('accounts', A)
  if (!dataDir) throw bad('The Gemini adapter is not configured yet', 503)
  bound = createAccounts({ dataDir, busyHomes })
  return bound
}
const delegate = (pick, names) => Object.fromEntries(names.map((n) => [n, (...a) => {
  const o = pick()
  if (typeof o?.[n] !== 'function') throw missing(`accounts.${n}`)
  return o[n](...a)
}]))
const ACCOUNT_OPS = ['load', 'list', 'usage', 'cachedUsage', 'activeUsage', 'capture', 'addStart', 'addFinish',
  'addCancel', 'rename', 'remove', 'readLive', 'identify', 'activate', 'restoreLive', 'checkActive', 'headroom']
const SWITCH_OPS = ['profile', 'status', 'switchTo', 'undo', 'lastChangeAt', 'isBusy', 'respawnStale', 'settled']
const accountsProxy = delegate(() => accountsPart().accounts, ACCOUNT_OPS)
const switcherProxy = delegate(() => accountsPart().switcher, SWITCH_OPS)
const credentialsProxy = delegate(() => accountsPart().credentials, ['read', 'write', 'identify'])

/** A run that stopped on the quota: mark its account out (once per stop). Best effort. */
async function noteLimitOf(run) {
  if (!HAS_ACCOUNTS || !dataDir || run?.state !== 'limit' || !run.home) return
  const key = `${run.runId}:${run.limitStop?.at || run.endedAt || 0}`
  if (noted.has(key)) return
  noted.add(key)
  try {
    const part = accountsPart()
    const id = await part.accountOfHome?.(run.home)
    if (id) await part.accounts.noteLimit?.(id)
  } catch { /* the sampler sees it on the next limit anyway */ }
}

const DEFAULT_LIMIT = /\b429\b|RESOURCE_EXHAUSTED|quota/i
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
    Object.assign(f, { lifecycle: 'failed', errorReason: 'Usage limit reached on Gemini', live: false,
      limitStop: { at: stopAt, resetsAt: run.limitStop?.resetsAt || null, kind: 'limit' },
      limitStopAt: stopAt, limitDetail: String(run.limitStop?.text || '').slice(0, 300) })
  } else if (run.state === 'error') Object.assign(f, { lifecycle: 'failed', errorReason: `Hit an error: ${String(run.error || '').slice(0, 120)}`.trim() })
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
  label: 'Gemini',
  harness: 'gemini-cli',
  // accounts: only once P7's accounts module exists (spec placeholder: capabilities.accounts=false until G4).
  capabilities: { start: true, stop: true, resume: true, fork: false, message: false, accounts: HAS_ACCOUNTS, usage: 'estimate', handoffTarget: true },

  // environment
  home: () => (scanMod?.home ? scanMod.home() : process.env.GEMINI_CLI_HOME || os.homedir()),
  available: async () => {
    if (!runnerMod?.createRunner) return { ok: false, why: `Gemini runner module missing${R.error ? ` (${R.error})` : ''}` }
    if (testing() && !process.env.AGENTVILLE_GEMINI_BIN) return { ok: false, why: 'Starting Gemini agents is disabled in tests' }
    const bin = await binPath()
    if (!bin) return { ok: false, why: 'Gemini CLI not found' }
    return { ok: true, why: '' }
  },
  bin: binPath,
  sessionEnv: ['GEMINI_SESSION_ID', 'AGENTVILLE_AGENT_ID'],
  missingModules: MISSING_WHY,

  // discovery
  async scan(now = Date.now()) {
    const runs = listRuns()
    for (const r of runs) await noteLimitOf(r)
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
      priv.set(f.id, { transcriptFile: f.transcriptFile || null, runId: f.runId || null, sessionId: byRun.get(f.runId)?.sessionId || f.sessionId || sid })
      const t = facts.titles?.[`gemini:${sid}`]
      if (t) titles.push({ id: f.id, names: [f.name, t].filter(Boolean), project: f.project, at: f.lastActivityAt || 0 })
    }
    privateOf = priv
    const out = facts
    out.titles = titles
    return out
  },
  /** `{ dataDir, account? }`. Binds the account module to dataDir and points the scan at every account home. */
  configure(opts = {}) {
    if (opts.port !== undefined) { port = opts.port || null; runner = null }
    if (opts.dataDir !== undefined && opts.dataDir !== dataDir) {
      dataDir = opts.dataDir; runner = null; bound = null
      try { runnerMod?.createRunner?.({ dataDir }).prune?.() } catch { /* best effort, once per data folder */ }
    }
    if (opts.account) bound = opts.account
    if (HAS_ACCOUNTS && dataDir) {
      const part = accountsPart()
      // The real objects from here on (the sampler reads switcher.accounts, which the proxies don't carry).
      this.accounts = part.accounts; this.switcher = part.switcher; this.credentials = part.credentials
    }
    const homes = HAS_ACCOUNTS && dataDir ? async () => { try { return await accountsPart().homes() } catch { return [] } } : undefined
    scanMod?.configure?.({ dataDir, ...(homes && { homes }) })
  },
  /** Step 1 of adding an account: P7's addStart with the real bin, so its argv can be opened in a terminal. */
  async addStart({ force = false } = {}) { return accountsPart().accounts.addStart({ bin: await binPath(), force: force === true }) },
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
    const mode = pick(body.permissionMode, MODES, 'permission mode')
    let args
    try { args = runnerMod?.startArgs ? runnerMod.startArgs({ prompt: body.prompt, model, mode }) : [`--prompt=${body.prompt}`] } catch (e) { throw bad(e.message) }
    // body.env is never forwarded (security review). Only the handoff id the engine sets is kept, as a field.
    const hid = typeof body.env?.AGENTVILLE_HANDOFF_ID === 'string' && /^[0-9a-f]{16}$/.test(body.env.AGENTVILLE_HANDOFF_ID) ? body.env.AGENTVILLE_HANDOFF_ID : null
    return stamp({ kind: 'start', args, cwd: project.dir, name, project: project.name, prompt: body.prompt, model, mode,
      ...(typeof body.parentAgentId === 'string' && { parentAgentId: body.parentAgentId }),
      ...(hid && { handoffId: hid }) })
  },
  /** A follow-up turn on a run Agentville started (`-r <sessionId> -p`). */
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
    : ['gemini', ...plan.args].map((x) => (/^[\w@%+=:,./[\]-]+$/.test(x) ? x : quoteForShell(x))).join(' ')),
  /** Never rejects. start -> { ok, ref:{ runId, sessionId }, id }. */
  run: async (plan) => {
    try {
      const r = await getRunner()
      if (plan.kind === 'start') {
        const env = await accountEnv()
        // Never allowYolo: MODES has no yolo, and agent starts must not get it (security review).
        const st = r.start({ home: env?.GEMINI_CLI_HOME || undefined, accountEnv: env || undefined, cwd: plan.cwd, prompt: plan.prompt,
          model: plan.model || undefined, mode: plan.mode || undefined, name: plan.name,
          parentAgentId: plan.parentAgentId || null, handoffId: plan.handoffId || null })
        return { ok: true, id: st.agentId, ref: { runId: st.runId, sessionId: st.sessionId } }
      }
      if (plan.kind === 'resume') { const env = await accountEnv(); const st = r.resume(plan.runId, plan.prompt, { accountEnv: env || undefined }); return { ok: true, id: st.agentId, ref: { runId: st.runId, sessionId: st.sessionId } } }
      if (plan.kind === 'stop') { await r.stop(plan.runId); return { ok: true, ref: { runId: plan.runId } } }
      return { ok: false, error: `Unknown plan kind ${plan.kind}` }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  },

  // credentials + accounts
  accounts: accountsProxy,
  credentials: credentialsProxy,
  switcher: switcherProxy,

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
