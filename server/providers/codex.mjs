/**
 * Codex provider adapter. Display-only: Agentville lists Codex sessions and threads but never
 * starts, stops, resumes, forks, messages, or hands work off to them, and holds no Codex accounts.
 * Wraps server/codex.mjs (scan + home) and stamps `provider: 'codex'` on every fact.
 * Shape follows docs/providers-design.md §1.2; capabilities are all false except `usage: 'none'`.
 */
import fs from 'node:fs'
import * as codex from '../codex.mjs'

const refuse = (what) => Object.assign(new Error(`Codex is display-only: ${what} is not available`), { status: 409 })

export default {
  id: 'codex',
  label: 'Codex',
  harness: 'codex',
  capabilities: {
    start: false, stop: false, resume: false, fork: false, message: false,
    accounts: false, usage: 'none', handoffTarget: false,
  },

  // environment
  home: () => codex.home(),
  available: async () => (fs.existsSync(codex.home())
    ? { ok: true, why: 'display only' }
    : { ok: false, why: 'Codex data folder not found' }),
  bin: async () => null,
  sessionEnv: ['CODEX_THREAD_ID'],

  // discovery
  scan: async (now = Date.now()) => {
    const facts = await codex.scan(now)
    for (const f of facts) f.provider = 'codex'
    const out = facts
    if (facts.unreadable !== undefined) out.unreadable = facts.unreadable
    return out
  },
  configure: () => {},
  // No Codex turn-boundary check: display-only, so the handoff flow never asks.
  activity: async () => 'idle',

  // start / resume / stop: refused (capabilities all false)
  options: () => ({ models: [], efforts: [], modes: [], promptMax: 0, nameMax: 0 }),
  startPlan: () => { throw refuse('start') },
  resumePlan: () => { throw refuse('resume') },
  stopPlan: () => { throw refuse('stop') },
  forkPlan: () => { throw refuse('fork') },
  display: () => { throw refuse('display') },
  run: async () => ({ ok: false, error: 'Codex is display-only' }),

  // credentials + accounts: none for Codex
  accounts: null,
  credentials: null,
  switcher: null,

  // usage + limits
  isLimitText: (text) => /usage[_ ]limit/i.test(String(text || '')),
  limitModel: () => '',
  tuning: {},

  // handoff: Codex is never a source or target
  readTranscript: async () => [],
}
