// Gemini provider adapter (docs/providers-design.md section 1.4). Composes server/gemini/*, which other pieces
// write in parallel (runner P5, scan+transcript P6, accounts P7, limits P8). Every import is guarded: a missing
// module degrades that part of the adapter instead of crashing the server, and available() says why.
//
// Seams read from those modules (all optional, all looked up by name):
//   runner.mjs     startArgs(body), resumeArgs(agent, {prompt}), stopPlan(agent)?, options(), run(plan, opts), configure(opts)?
//   scan.mjs       scan(now), home()?
//   transcript.mjs readTranscript(agent, {maxBytes})
//   accounts.mjs   createAccounts(opts) -> { accounts, switcher } (or the object itself), or named exports accounts / switcher
//   limits.mjs     isLimitText(t), limitModel(t), tuning, usage?(...)
import os from 'node:os'
import path from 'node:path'
import { findExecutable } from '../terminal.mjs'
import { cliDirs, quoteForShell } from '../platform.mjs'

const load = async (name) => {
  try { return { mod: await import(name) } } catch (e) { return { mod: null, error: String(e?.message || e) } }
}
const [R, S, T, A, L] = await Promise.all(['../gemini/runner.mjs', '../gemini/scan.mjs', '../gemini/transcript.mjs',
  '../gemini/accounts.mjs', '../gemini/limits.mjs'].map(load))
const runner = R.mod, scanMod = S.mod, transcript = T.mod, acctMod = A.mod, limits = L.mod

const bad = (message, status = 400) => Object.assign(new Error(message), { status })
const missing = (what, r) => bad(`Gemini ${what} is not available${r?.error ? ` (${r.error})` : ''}`, 503)
const stamp = (plan) => ({ ...plan, provider: 'gemini' })
const MISSING_WHY = () => [['runner', R], ['scan', S], ['transcript', T], ['accounts', A], ['limits', L]]
  .filter(([, x]) => !x.mod).map(([n]) => n).join(', ')

const binPath = async () => process.env.AGENTVILLE_GEMINI_BIN || findExecutable('gemini', cliDirs('gemini'))

let dataDir = null
let bound = null // { accounts, switcher } once configure() runs
const accountsPart = () => {
  if (bound) return bound
  if (!acctMod) throw missing('accounts', A)
  if (acctMod.accounts || acctMod.switcher) bound = { accounts: acctMod.accounts, switcher: acctMod.switcher || acctMod.accounts }
  else if (typeof acctMod.createAccounts === 'function') {
    const r = acctMod.createAccounts({ dataDir })
    bound = { accounts: r.accounts || r, switcher: r.switcher || r }
  } else throw missing('accounts', { error: 'no createAccounts export' })
  return bound
}
// Lazy proxy so assertAdapter sees every function even before the module is bound.
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

const DEFAULT_LIMIT = /\b429\b|RESOURCE_EXHAUSTED|quota/i

export default {
  id: 'gemini',
  label: 'Gemini',
  harness: 'gemini-cli',
  capabilities: { start: true, stop: true, resume: true, fork: false, message: false, accounts: true, usage: 'estimate', handoffTarget: true },

  // environment
  home: () => (scanMod?.home ? scanMod.home() : path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini')),
  available: async () => {
    if (!runner) return { ok: false, why: `Gemini runner module missing${R.error ? ` (${R.error})` : ''}` }
    const bin = await binPath()
    if (!bin) return { ok: false, why: 'Gemini CLI not found' }
    return { ok: true, why: '' }
  },
  bin: binPath,
  sessionEnv: ['GEMINI_SESSION_ID', 'AGENTVILLE_AGENT_ID'],
  missingModules: MISSING_WHY,

  // discovery
  async scan(now) {
    if (!scanMod?.scan) return Object.assign([], { unreadable: 0 })
    const facts = await scanMod.scan(now)
    for (const f of facts) { f.provider = 'gemini'; f.harness = f.harness || 'gemini-cli' }
    return facts
  },
  configure(opts = {}) {
    if (opts.dataDir !== undefined) dataDir = opts.dataDir
    if (opts.account) bound = { accounts: opts.account.accounts || opts.account, switcher: opts.account.switcher || opts.account }
    runner?.configure?.(opts)
    scanMod?.configure?.(opts)
    acctMod?.configure?.(opts)
  },
  /** Gemini has no turn-boundary signal yet: a live run is busy, a stopped one with a limit hit is 'limit'. */
  async activity(agent) {
    if (agent?.limitStopAt > 0) return 'limit'
    if (agent?.live === false || agent?.bucket === 'gone') return 'gone'
    return agent?.bucket === 'building' ? 'busy' : 'idle'
  },

  // start / resume / stop
  options: () => (runner?.options ? runner.options() : { models: [''], efforts: [''], modes: [''], promptMax: 8000, nameMax: 80 }),
  startPlan(body = {}, projects) {
    if (!runner?.startArgs) throw missing('runner', R)
    const cwd = body.cwd
    if (!cwd) throw bad('cwd is required')
    return stamp({ kind: 'start', args: runner.startArgs(body, projects), cwd, env: body.env, name: body.name })
  },
  resumePlan(agent, { prompt } = {}) {
    if (!agent) throw bad('No such agent', 404)
    if (!runner?.resumeArgs) throw missing('runner', R)
    const r = runner.resumeArgs(agent, { prompt })
    if (r?.unavailable) throw bad(r.unavailable, 409)
    const args = Array.isArray(r) ? r : r.args
    return stamp({ kind: 'resume', args, cwd: r.cwd || agent.cwd || agent.fork?.cwd, id: agent.id, name: agent.name })
  },
  stopPlan(agent) {
    if (!agent) throw bad('No such agent', 404)
    if (runner?.stopPlan) return stamp(runner.stopPlan(agent))
    return stamp({ kind: 'stop', args: [], cwd: agent.cwd || '', id: agent.id, name: agent.name })
  },
  display: (plan) => ['gemini', ...plan.args].map((x) => (/^[\w@%+=:,./[\]-]+$/.test(x) ? x : quoteForShell(x))).join(' '),
  run: async (plan, opts) => {
    try {
      if (!runner?.run) return { ok: false, error: missing('runner', R).message }
      return await runner.run(plan, opts)
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  },

  // credentials + accounts
  accounts: accountsProxy,
  credentials: {
    read: () => accountsProxy.readLive(),
    write: (text) => accountsProxy.restoreLive(text),
    identify: (text, opts) => accountsProxy.identify(text, opts),
  },
  switcher: switcherProxy,

  // usage + limits
  isLimitText: (t) => (limits?.isLimitText ? limits.isLimitText(t) : DEFAULT_LIMIT.test(String(t || ''))),
  limitModel: (t) => (limits?.limitModel ? limits.limitModel(t) : ''),
  tuning: limits?.tuning || {},

  // handoff
  readTranscript: async (agent, opts) => (transcript?.readTranscript ? transcript.readTranscript(agent, opts) : []),
}
