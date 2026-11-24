// Claude provider adapter: wraps the existing Claude modules (nothing moves). See docs/providers-design.md §1.3.
import fs from 'node:fs'
import path from 'node:path'
import * as cc from '../claude-code.mjs'
import * as actions from '../actions.mjs'
import { jobActivity } from '../account.mjs'
import { limitModel } from '../autoswitch.mjs'
import { respawnArgs, resumeArgs } from '../restore.mjs'
import { readTranscript } from './claude-transcript.mjs'

const bad = (message, status = 400) => Object.assign(new Error(message), { status })
const SHORT = /^[0-9a-f]{8}$/

let account = null // the createAccount() instance, bound by configure()
let dataDir = null
const bound = () => {
  if (!account) throw bad('The Claude account module is not configured yet', 503)
  return account
}

const stamp = (plan) => ({ ...plan, provider: 'claude' })

function readJobState(short) {
  try { return JSON.parse(fs.readFileSync(path.join(cc.home(), 'jobs', short, 'state.json'), 'utf8')) } catch { return null }
}

export default {
  id: 'claude',
  label: 'Claude',
  harness: 'claude-code',
  capabilities: { start: true, stop: true, resume: true, fork: true, message: true, accounts: true, usage: 'api', handoffTarget: true },

  // environment
  home: cc.home,
  available: async () => {
    const why = actions.actionsBlocked()
    if (why) return { ok: false, why }
    const bin = await actions.claudeBin()
    return bin ? { ok: true, why: '' } : { ok: false, why: 'Claude Code CLI not found' }
  },
  bin: actions.claudeBin,
  sessionEnv: ['CLAUDE_CODE_SESSION_ID'],

  // discovery
  async scan(now) {
    const facts = await cc.scan(now)
    for (const f of facts) { f.provider = 'claude'; f.harness = f.harness || 'claude-code' }
    return facts
  },
  /** `{ dataDir, account? }`: dataDir feeds the transcript-edge cache; `account` is serve's createAccount() result. */
  configure(opts = {}) {
    if (opts.dataDir !== undefined) { dataDir = opts.dataDir; cc.configureCache(dataDir) }
    if (opts.account) account = opts.account
  },
  async activity(agent) {
    const short = agent?.jobId
    if (SHORT.test(short || '')) {
      const a = await jobActivity(cc.home(), short)
      return a !== 'busy' && agent.limitStopAt > 0 ? 'limit' : a
    }
    if (agent?.limitStopAt > 0) return 'limit'
    return agent?.bucket === 'building' ? 'busy' : 'idle'
  },

  // start / resume / stop
  options: () => ({ models: actions.MODELS, efforts: actions.EFFORTS, modes: actions.MODES, promptMax: actions.PROMPT_MAX, nameMax: actions.NAME_MAX }),
  startPlan: (body, projects) => stamp(actions.startPlan(body, projects)),
  /** Respawn the same job when it has one; a prompt (or no job folder) goes through `--bg --resume`. */
  resumePlan(agent, { prompt } = {}) {
    if (!agent) throw bad('No such agent', 404)
    const short = agent.jobId
    const st = SHORT.test(short || '') ? readJobState(short) : null
    if (st && !prompt) return stamp({ kind: 'resume', ...respawnArgs(short, st), id: agent.id, name: agent.name, jobId: short })
    const sid = agent.fork?.sid
    const base = st || { sessionId: sid, cwd: agent.fork?.cwd }
    const r = resumeArgs(base)
    if (r.unavailable) throw bad(r.unavailable, 409)
    return stamp({ kind: 'resume', args: prompt ? [...r.args, '--', String(prompt)] : r.args, cwd: r.cwd, id: agent.id, name: agent.name, jobId: SHORT.test(short || '') ? short : undefined })
  },
  stopPlan: (agent) => stamp(actions.stopPlan(agent)),
  forkPlan: (agent, fork, name) => stamp(actions.forkPlan(agent, fork, name)),
  display: actions.display,
  run: (plan, opts) => actions.run(plan, opts).then((r) => ({ ...r, ...(r.ok && { ref: { jobId: r.jobId || undefined } }) }), (e) => ({ ok: false, error: String(e?.message || e) })),

  // credentials + accounts (the same objects serve builds)
  get accounts() { return bound().accounts },
  credentials: {
    read: () => bound().accounts.readLive(),
    write: (text) => bound().accounts.restoreLive(text),
    identify: (text, opts) => bound().accounts.identify(text, opts),
  },
  get switcher() { return bound() },

  // usage + limits
  isLimitText: cc.isHarnessLimit,
  limitModel,
  tuning: {},

  // handoff
  readTranscript,
}
