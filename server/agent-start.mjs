// Agent-to-agent start: body parsing and guards for POST /api/agents/start (design §5).
//
// Hardening beyond §5 (security review):
// - F2 permission mode: yolo / bypassPermissions are refused; the child's mode is clamped to be no more
//   permissive than the caller's (unknown caller mode counts as `default`); model names are allowlisted.
// - F4 cwd: realpaths only; inside the caller's realpath cwd (never `/`, a drive root or home as the base),
//   or exactly a known project root. `trusted` is true only for an exact known project root.
// - F5 caller identity: ledger-known callers must present their per-launch token; checkAndRecord records in
//   the same synchronous section as the check; hard ceilings settings can't raise.
// - F6 guards: no subagent/teammate/thread callers; caller must be live === true; launch internals
//   (env, args, bin, ...) are never taken from the body.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TOKEN_ENV } from './launches.mjs'

const PROVIDERS = new Set(['claude', 'gemini'])
const MAX_PROMPT = 100_000
export const HARD_PER_HOUR_ALL = 60
export const HARD_MAX_DEPTH = 3
const DEFAULT_PER_HOUR = 20
export const MODEL_RE = /^[A-Za-z0-9][\w.\-:]*$/
const REFUSED_MODES = new Set(['yolo', 'bypassPermissions'])
const NO_START_KINDS = new Set(['subagent', 'teammate', 'thread'])

// Strictness rank shared by both vocabularies (higher = more permissive).
// Claude: plan < default < acceptEdits < auto/dontAsk < bypassPermissions
// Gemini: plan < default < auto_edit < yolo
const RANK = { plan: 0, '': 1, default: 1, manual: 1, acceptEdits: 2, auto_edit: 2, auto: 3, dontAsk: 3, bypassPermissions: 4, yolo: 4 }
const VOCAB = {
  claude: new Set(['', 'default', 'manual', 'plan', 'acceptEdits', 'auto', 'dontAsk']),
  gemini: new Set(['', 'default', 'plan', 'auto_edit', 'auto']),
}
// Most permissive allowed child mode at each rank, in the child's vocabulary.
const AT_RANK = { claude: ['plan', '', 'acceptEdits', 'auto'], gemini: ['plan', 'default', 'auto_edit', 'auto'] }

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const fail = (status, error) => ({ ok: false, status, error })

/**
 * Normalize the request body. Returns { ok:true, value } or { ok:false, status:400, error }.
 * Only the listed fields are copied; env, args, bin, home, account, runId, resume, auto, worktree and
 * anything else in the body are dropped.
 */
export function parseAgentStart(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'body must be a JSON object')
  const session = str(body.session, 200)
  if (!session) return fail(400, 'session required')
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) return fail(400, 'prompt required')
  if (prompt.length > MAX_PROMPT) return fail(400, 'prompt too long')
  const provider = body.provider == null || body.provider === '' ? null : String(body.provider)
  if (provider && !PROVIDERS.has(provider)) return fail(400, 'unknown provider')
  const cwd = str(body.cwd, 4096)
  if (cwd && !path.isAbsolute(cwd)) return fail(400, 'cwd must be absolute')
  const model = str(body.model, 100)
  if (model && !MODEL_RE.test(model)) return fail(400, 'bad model name')
  const permissionMode = str(body.permissionMode, 50)
  if (REFUSED_MODES.has(permissionMode)) return fail(400, `permission mode ${permissionMode} is not allowed for agent starts`)
  if (permissionMode && !Object.hasOwn(RANK, permissionMode)) return fail(400, 'unknown permission mode')
  return { ok: true, value: { session, provider, prompt, name: str(body.name, 120), cwd: cwd || null, model, permissionMode, token: str(body.token, 200) } }
}

/** The child's permission mode, clamped to the caller's. Returns { ok, mode, clamped } or a fail. */
export function clampMode(provider, requested, callerMode) {
  const req = requested == null ? '' : String(requested)
  if (REFUSED_MODES.has(req)) return fail(400, `permission mode ${req} is not allowed for agent starts`)
  if (!VOCAB[provider]?.has(req)) return fail(400, `permission mode ${req} is not valid for ${provider}`)
  const callerRank = typeof callerMode === 'string' && Object.hasOwn(RANK, callerMode) ? RANK[callerMode] : RANK.default
  const cap = Math.min(callerRank, 3)
  const norm = (m) => (provider === 'claude' ? (m === 'default' ? '' : m) : (m === '' ? 'default' : m))
  if (RANK[req] <= cap) return { ok: true, mode: norm(req), clamped: false }
  return { ok: true, mode: AT_RANK[provider][cap], clamped: true }
}

const realDir = (p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null
  try {
    const r = fs.realpathSync.native(p)
    return fs.statSync(r).isDirectory() ? r : null
  } catch { return null }
}
const inside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Resolve and authorize the cwd. Returns { ok, cwd, trusted } or a fail. */
export function checkCwd(requested, callerCwd, projects, home = os.homedir()) {
  const target = realDir(requested || callerCwd)
  if (!target) return fail(400, 'cwd must be an existing directory')
  const realHome = realDir(home) || home
  const tooBroad = (p) => p === path.parse(p).root || p === realHome
  const base = realDir(callerCwd)
  const known = new Set((Array.isArray(projects) ? projects : [])
    .map((p) => realDir(typeof p === 'string' ? p : p?.dir)).filter((p) => p && !tooBroad(p)))
  const trusted = known.has(target)
  const okInside = !!base && !tooBroad(base) && inside(target, base)
  if (!okInside && !trusted) return fail(403, 'cwd must be the caller cwd, inside it, or a known project')
  return { ok: true, cwd: target, trusted }
}

const limit = (v, dflt, ceiling) => Math.min(Number.isFinite(v) && v >= 0 ? v : dflt, ceiling)

/**
 * input: parseAgentStart().value. ctx (all injected, all synchronous):
 *   settings: { get() -> { agentStarts: { enabled, perHour, maxDepth } }, defaultProvider() -> id }
 *   launches: createLaunches() result
 *   resolveSession(session) -> agent record | null   (needs id, kind, live, cwd; optional provider, permissionMode)
 *   providerStatus(id) -> { usable, why? }
 *   knownProjects() -> [{ dir, name }] (strings also accepted)
 *   startPlan?(provider, input) -> Plan | { ok:false, error } | throws
 *   homedir?: string (tests)
 * Returns { ok:true, provider, cwd, trusted, permissionMode, modeClamped, model, caller, callerId, depth, plan }
 * or { ok:false, status, error }.
 */
export function checkAgentStart(input, ctx) {
  if (!input || typeof input !== 'object') return fail(400, 'bad input')
  const cfg = ctx.settings.get()?.agentStarts || {}
  if (cfg.enabled !== true) return fail(403, 'agent starts are disabled')

  const caller = ctx.resolveSession(input.session)
  if (!caller || typeof caller !== 'object' || caller.live !== true) return fail(404, 'caller session is not a live agent')
  if (NO_START_KINDS.has(caller.kind) || caller.isSubagent || caller.subagent) return fail(403, `${caller.kind || 'subagent'} callers cannot start agents`)
  const callerId = typeof caller.id === 'string' && caller.id ? caller.id : input.session

  // F5: a caller the ledger knows as Agentville-launched must prove it with its per-launch token.
  const L = ctx.launches
  const ownRef = L.refOf(callerId) || L.refOf(input.session)
  const token = typeof input.token === 'string' ? input.token : ''
  const tokenRef = token ? L.refByToken(token) : null
  if (token && !tokenRef) return fail(403, 'launch token does not match')
  if (ownRef && tokenRef !== ownRef) return fail(403, 'launch token required for this caller')

  const provider = input.provider || ctx.settings.defaultProvider()
  if (!PROVIDERS.has(provider)) return fail(400, 'unknown provider')
  const st = ctx.providerStatus(provider)
  if (!st || !st.usable) return fail(409, `provider ${provider} is not usable${st?.why ? `: ${st.why}` : ''}`)

  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (model && !MODEL_RE.test(model)) return fail(400, 'bad model name')
  const pm = clampMode(provider, input.permissionMode || '', caller.permissionMode)
  if (!pm.ok) return pm

  const cw = checkCwd(input.cwd, caller.cwd, ctx.knownProjects?.() || [], ctx.homedir || os.homedir())
  if (!cw.ok) return cw

  const maxDepth = limit(cfg.maxDepth, HARD_MAX_DEPTH, HARD_MAX_DEPTH)
  const depth = L.depth(tokenRef || callerId)
  if (!(depth < maxDepth)) return fail(429, 'start depth limit reached')
  if (L.count({ via: 'api' }) >= HARD_PER_HOUR_ALL) return fail(429, 'overall hourly start limit reached')
  if (L.count({ parentAgentId: callerId, via: 'api' }) >= limit(cfg.perHour, DEFAULT_PER_HOUR, HARD_PER_HOUR_ALL)) return fail(429, 'per-caller hourly start limit reached')

  const clean = { session: input.session, provider, prompt: input.prompt, name: input.name || '', cwd: cw.cwd, model, permissionMode: pm.mode }
  let plan = null
  if (ctx.startPlan) {
    try {
      plan = ctx.startPlan(provider, clean)
      if (plan && plan.ok === false) return fail(400, plan.error || 'start plan rejected')
      if (plan && typeof plan.then === 'function') return fail(500, 'startPlan must be synchronous')
    } catch (e) { return fail(400, e?.message || 'start plan rejected') }
  }
  return { ok: true, provider, cwd: cw.cwd, trusted: cw.trusted, permissionMode: pm.mode, modeClamped: pm.clamped, model, caller, callerId, depth, plan }
}

/**
 * checkAgentStart + launches.record in one synchronous section (no await), so two concurrent requests
 * can't both pass the rate/depth checks. On success adds { launchId, token } and puts the token into
 * plan.env[TOKEN_ENV]. The caller must then spawn, and either launches.bind(launchId, ref, [agentId])
 * on success or launches.rollback(launchId) on failure.
 */
export function checkAndRecord(input, ctx) {
  const r = checkAgentStart(input, ctx)
  if (!r.ok) return r
  let rec
  try {
    rec = ctx.launches.record({ ref: `pending-${crypto.randomUUID()}`, parentAgentId: r.callerId, provider: r.provider, via: 'api', pending: true })
  } catch { return fail(503, 'launch ledger unavailable') }
  const plan = r.plan && typeof r.plan === 'object' ? { ...r.plan, env: { ...(r.plan.env || {}), [TOKEN_ENV]: rec.token } } : r.plan
  return { ...r, plan, launchId: rec.ref, token: rec.token }
}

/** Undo checkAndRecord's record after a failed spawn. */
export function rollback(launchId, ctx) { return ctx.launches.rollback(launchId) }
