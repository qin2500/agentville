// Provider settings (<data>/providers.json). Spec: docs/providers-design.md section 2.3.
import fs from 'node:fs'
import path from 'node:path'

export const TARGET_PROVIDERS = ['claude', 'gemini']
export const HANDOFF_MODES = ['auto', 'ask', 'off']

export const DEFAULTS = Object.freeze({
  version: 1,
  defaultProvider: 'claude',
  providerOrder: ['claude', 'gemini'],
  handoff: { mode: 'auto', minWaitMs: 1800000, maxHops: 2 },
  agentStarts: { enabled: true, perHour: 20, maxDepth: 3 },
})

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const clone = () => JSON.parse(JSON.stringify(DEFAULTS))

function checkProvider(p) {
  if (p === 'codex') throw new Error('codex cannot be a handoff or start target')
  if (!TARGET_PROVIDERS.includes(p)) throw new Error(`unknown provider: ${String(p)}`)
  return p
}
function checkInt(name, v, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer ${min}..${max}`)
  return v
}

/** Merge a patch into a settings object, validating strictly. Throws on bad input. */
function apply(base, patch) {
  if (!isObj(patch)) throw new Error('patch must be an object')
  const out = JSON.parse(JSON.stringify(base))
  if (patch.defaultProvider !== undefined) out.defaultProvider = checkProvider(patch.defaultProvider)
  if (patch.providerOrder !== undefined) {
    if (!Array.isArray(patch.providerOrder)) throw new Error('providerOrder must be an array')
    out.providerOrder = patch.providerOrder.map(checkProvider)
  }
  if (patch.handoff !== undefined) {
    if (!isObj(patch.handoff)) throw new Error('handoff must be an object')
    const h = patch.handoff
    if (h.mode !== undefined) {
      if (!HANDOFF_MODES.includes(h.mode)) throw new Error(`handoff.mode must be one of ${HANDOFF_MODES.join(', ')}`)
      out.handoff.mode = h.mode
    }
    if (h.minWaitMs !== undefined) out.handoff.minWaitMs = checkInt('handoff.minWaitMs', h.minWaitMs, 0)
    if (h.maxHops !== undefined) out.handoff.maxHops = checkInt('handoff.maxHops', h.maxHops, 0, 100)
  }
  if (patch.agentStarts !== undefined) {
    if (!isObj(patch.agentStarts)) throw new Error('agentStarts must be an object')
    const a = patch.agentStarts
    if (a.enabled !== undefined) {
      if (typeof a.enabled !== 'boolean') throw new Error('agentStarts.enabled must be a boolean')
      out.agentStarts.enabled = a.enabled
    }
    if (a.perHour !== undefined) out.agentStarts.perHour = checkInt('agentStarts.perHour', a.perHour, 0, 1000)
    if (a.maxDepth !== undefined) out.agentStarts.maxDepth = checkInt('agentStarts.maxDepth', a.maxDepth, 0, 20)
  }
  // Normalize: deduped, default first, every target provider present.
  const seen = new Set([out.defaultProvider])
  const order = [out.defaultProvider]
  for (const p of [...out.providerOrder, ...TARGET_PROVIDERS]) if (!seen.has(p)) { seen.add(p); order.push(p) }
  out.providerOrder = order
  return out
}

/** Lenient load: drop invalid fields instead of throwing. */
function sanitize(raw) {
  let cur = clone()
  if (!isObj(raw)) return cur
  const parts = [
    { defaultProvider: raw.defaultProvider },
    { providerOrder: raw.providerOrder },
    ...Object.entries(isObj(raw.handoff) ? raw.handoff : {}).map(([k, v]) => ({ handoff: { [k]: v } })),
    ...Object.entries(isObj(raw.agentStarts) ? raw.agentStarts : {}).map(([k, v]) => ({ agentStarts: { [k]: v } })),
  ]
  for (const p of parts) { try { cur = apply(cur, p) } catch { /* skip bad field */ } }
  return apply(cur, {})
}

export function createProviderSettings({ dataDir }) {
  const file = path.join(dataDir, 'providers.json')

  function get() {
    try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { return clone() }
  }
  function set(patch) {
    const next = apply(get(), patch)
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
    return next
  }
  return { get, set, defaultProvider: () => get().defaultProvider, order: () => get().providerOrder }
}
