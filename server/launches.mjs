// Launch ledger: <data>/launches.json, { [ref]: { parentAgentId, provider, via, at } }. 0600, atomic, 14-day TTL.
import fs from 'node:fs'
import path from 'node:path'

export const LAUNCH_TTL_MS = 14 * 24 * 3600 * 1000
const VIAS = new Set(['api', 'handoff', 'ui'])
const HOUR = 3600 * 1000

export function createLaunches({ dataDir, now = Date.now, ttlMs = LAUNCH_TTL_MS } = {}) {
  const file = path.join(dataDir, 'launches.json')
  let map = null

  const load = () => {
    if (map) return map
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch { map = {} }
    return map
  }
  const prune = () => {
    const m = load(); const cut = now() - ttlMs
    for (const [k, v] of Object.entries(m)) if (!v || !(v.at >= cut)) delete m[k]
  }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  // An agent id may be "provider:ref"; the ledger is keyed by bare ref.
  const find = (id) => {
    if (!id) return null
    const m = load()
    if (m[id]) return m[id]
    const i = String(id).indexOf(':')
    return i > 0 && m[String(id).slice(i + 1)] ? m[String(id).slice(i + 1)] : null
  }

  return {
    record({ ref, parentAgentId = null, provider, via = 'api' }) {
      if (!ref || typeof ref !== 'string') throw new Error('launches.record: ref required')
      if (!VIAS.has(via)) throw new Error(`launches.record: bad via ${via}`)
      const m = load(); prune()
      m[ref] = { parentAgentId: parentAgentId || null, provider, via, at: now() }
      save()
      return m[ref]
    },
    get(ref) { prune(); return find(ref) },
    /** startedBy for an agent id or ref. */
    startedBy(id) { prune(); return find(id)?.parentAgentId ?? null },
    /** Number of start links above this agent (0 when it was not started by an agent). Cycle-safe. */
    depth(id) {
      prune()
      let d = 0; const seen = new Set()
      let cur = find(id)
      while (cur && cur.parentAgentId && !seen.has(cur.parentAgentId)) {
        seen.add(cur.parentAgentId); d++
        cur = find(cur.parentAgentId)
      }
      return d
    },
    /** Starts by a caller (or everyone when parentAgentId is omitted) in the last windowMs. */
    count({ parentAgentId, via, windowMs = HOUR } = {}) {
      prune(); const cut = now() - windowMs
      return Object.values(load()).filter((v) =>
        v.at >= cut && (via ? v.via === via : true) && (parentAgentId === undefined || v.parentAgentId === parentAgentId)).length
    },
    /** Re-parent children of oldId under newId (handoff of a lead). */
    reparent(oldId, newId) {
      const m = load(); let n = 0
      for (const v of Object.values(m)) if (v.parentAgentId === oldId) { v.parentAgentId = newId; n++ }
      if (n) save()
      return n
    },
  }
}
