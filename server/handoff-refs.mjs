/**
 * Handoff id <- new agent ref, for restart recovery (docs/providers-design.md §3.4, "Server restarts mid-flow").
 *
 * handoff.mjs finds the agent a handoff started by `agent.handoffId === hid`. Gemini runs carry it in their run
 * state; a Claude `--bg` job doesn't record its env anywhere we can read. So every handoff start goes through
 * `wrap(getProvider)`: the moment the target's `run()` returns a ref, `<data>/handoff-refs.json` gets
 * `{ [ref]: { hid, at } }` (sync, atomic, 0600), before the engine saves `started`. A crash between the two
 * leaves the link on disk, `annotate(facts)` puts `handoffId` back on the scanned agent, and the engine adopts
 * it instead of starting a second agent. Entries are kept 14 days.
 */
import fs from 'node:fs'
import path from 'node:path'

const KEEP_MS = 14 * 24 * 3600 * 1000
const HID = /^[0-9a-f]{16}$/

export function createHandoffRefs({ dataDir, now = Date.now }) {
  const file = path.join(dataDir, 'handoff-refs.json')
  let map = null
  const load = () => {
    if (map) return map
    try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {} } catch { map = {} }
    return map
  }
  function record(ref, hid) {
    if (!ref || typeof ref !== 'string' || !HID.test(hid || '')) return
    const m = load(); const cut = now() - KEEP_MS
    for (const [k, v] of Object.entries(m)) if (!(v?.at >= cut)) delete m[k]
    m[ref] = { hid, at: now() }
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  /** The hid a ref (jobId / sessionId / runId / agent id) was started for, or null. */
  function of(ref) {
    if (!ref) return null
    const m = load()
    const s = String(ref)
    const i = s.indexOf(':')
    return m[s]?.hid || (i > 0 ? m[s.slice(i + 1)]?.hid : null) || null
  }
  /** Set `handoffId` on facts/agents that lack it, from their refs. Mutates and returns the list. */
  function annotate(list) {
    for (const a of list || []) {
      if (!a || a.handoffId) continue
      const hid = of(a.jobId) || of(a.runId) || of(a.sessionId) || of(a.id)
      if (hid) a.handoffId = hid
    }
    return list
  }
  /** A getProvider whose adapters record the ref of every handoff start (env AGENTVILLE_HANDOFF_ID) on success. */
  function wrap(getProvider) {
    const cache = new Map()
    return (id) => {
      const a = getProvider(id)
      if (!a) return a
      if (cache.get(id)?.base === a) return cache.get(id).wrapped
      const wrapped = Object.create(a)
      wrapped.run = async (plan, ...rest) => {
        const res = await a.run(plan, ...rest)
        const hid = plan?.env?.AGENTVILLE_HANDOFF_ID || plan?.handoffId
        if (res?.ok && plan?.kind === 'start' && hid) {
          const r = res.ref || {}
          for (const ref of [r.jobId, r.sessionId, r.runId, res.jobId, res.id]) { try { record(ref, hid) } catch { /* best effort */ } }
        }
        return res
      }
      cache.set(id, { base: a, wrapped })
      return wrapped
    }
  }
  return { record, of, annotate, wrap }
}
