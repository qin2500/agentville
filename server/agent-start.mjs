// Agent-to-agent start: body parsing and guards for POST /api/agents/start (design §5).
import path from 'node:path'

const PROVIDERS = new Set(['claude', 'gemini'])
const MAX_PROMPT = 100_000
const PER_HOUR_ALL = 60

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Normalize the request body. Returns { ok:true, value } or { ok:false, status:400, error }. */
export function parseAgentStart(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'body must be a JSON object' }
  const session = str(body.session, 200)
  if (!session) return { ok: false, status: 400, error: 'session required' }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) return { ok: false, status: 400, error: 'prompt required' }
  if (prompt.length > MAX_PROMPT) return { ok: false, status: 400, error: 'prompt too long' }
  const provider = body.provider == null || body.provider === '' ? null : String(body.provider)
  if (provider && !PROVIDERS.has(provider)) return { ok: false, status: 400, error: 'unknown provider' }
  const cwd = str(body.cwd, 4096)
  if (cwd && !path.isAbsolute(cwd)) return { ok: false, status: 400, error: 'cwd must be absolute' }
  return { ok: true, value: { session, provider, prompt, name: str(body.name, 120), cwd: cwd || null, model: str(body.model, 100), permissionMode: str(body.permissionMode, 50) } }
}

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
const fail = (status, error) => ({ ok: false, status, error })

/**
 * input: parseAgentStart().value. ctx (all injected):
 *   settings: createProviderSettings result; launches: createLaunches result;
 *   resolveSession(session) -> agent | null; providerStatus(id) -> { usable, why? };
 *   knownProjects() -> string[]; startPlan?(provider, input) -> { ok, error? } | throws.
 * On success returns { ok:true, provider, cwd, caller, plan }.
 */
export function checkAgentStart(input, ctx) {
  const cfg = ctx.settings.get().agentStarts || {}
  if (!cfg.enabled) return fail(403, 'agent starts are disabled')
  const caller = ctx.resolveSession(input.session)
  if (!caller || caller.live === false) return fail(404, 'caller session is not a live agent')
  if (caller.isSubagent || caller.subagent) return fail(403, 'subagents cannot start agents')

  const provider = input.provider || ctx.settings.defaultProvider()
  const st = ctx.providerStatus(provider)
  if (!st || !st.usable) return fail(409, `provider ${provider} is not usable${st?.why ? `: ${st.why}` : ''}`)

  const cwd = input.cwd || caller.cwd
  if (!cwd) return fail(400, 'cwd required')
  const projects = ctx.knownProjects?.() || []
  const okCwd = (caller.cwd && inside(cwd, caller.cwd)) || projects.some((p) => path.resolve(p) === path.resolve(cwd))
  if (!okCwd) return fail(403, 'cwd must be the caller cwd, inside it, or a known project')

  const callerId = caller.id || input.session
  if (ctx.launches.depth(callerId) >= (cfg.maxDepth ?? 3)) return fail(429, 'start depth limit reached')
  if (ctx.launches.count({ parentAgentId: callerId, via: 'api' }) >= (cfg.perHour ?? 20)) return fail(429, 'per-caller hourly start limit reached')
  if (ctx.launches.count({ via: 'api' }) >= PER_HOUR_ALL) return fail(429, 'overall hourly start limit reached')

  let plan = null
  if (ctx.startPlan) {
    try {
      plan = ctx.startPlan(provider, { ...input, cwd })
      if (plan && plan.ok === false) return fail(400, plan.error || 'start plan rejected')
    } catch (e) { return fail(400, e?.message || 'start plan rejected') }
  }
  return { ok: true, provider, cwd, caller, plan }
}
