// Launch ledger: <data>/launches.json, { [ref]: { parentAgentId, provider, via, at, tokenHash, aliases?, pending? } }.
// 0600, atomic, 14-day TTL.
//
// Security notes (agents starting agents):
// - Every record gets a per-launch secret. `record` returns the raw `token` once; the ledger keeps only its
//   sha256. The launcher injects the token into the child (TOKEN_ENV), and the child must present it when it
//   asks to start an agent, so another process can't claim to be a ledger-known agent.
// - A corrupt or unreadable file never resets the ledger silently. It is moved aside and a fail-closed marker
//   is written; until the marker expires (one TTL, when every lost entry would have expired anyway), a chain
//   that ends in an id the ledger doesn't know has depth Infinity.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const LAUNCH_TTL_MS = 14 * 24 * 3600 * 1000
export const TOKEN_ENV = 'AGENTVILLE_AGENT_TOKEN'
const VIAS = new Set(['api', 'handoff', 'ui'])
const HOUR = 3600 * 1000
const MARK = '!failClosed'

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')
export const newToken = () => crypto.randomBytes(32).toString('base64url')
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

const validEntry = (v) => v && typeof v === 'object' && !Array.isArray(v) && Number.isFinite(v.at) &&
  VIAS.has(v.via) && (v.parentAgentId === null || typeof v.parentAgentId === 'string') &&
  (v.aliases === undefined || (Array.isArray(v.aliases) && v.aliases.every((x) => typeof x === 'string')))

export function createLaunches({ dataDir, now = Date.now, ttlMs = LAUNCH_TTL_MS } = {}) {
  const file = path.join(dataDir, 'launches.json')
  let map = null

  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  const load = () => {
    if (map) return map
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
      if (e?.code === 'ENOENT') { map = Object.create(null); return map }
      raw = null
    }
    let parsed = null
    try { parsed = raw == null ? null : JSON.parse(raw) } catch { parsed = null }
    const ok = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.entries(parsed).every(([k, v]) => (k === MARK ? v && Number.isFinite(v.at) : validEntry(v)))
    if (ok) { map = Object.assign(Object.create(null), parsed); return map }
    // Corrupt: keep the evidence, never reset to "nobody has a parent".
    try { fs.renameSync(file, `${file}.corrupt-${now()}`) } catch { /* best effort */ }
    map = Object.create(null)
    map[MARK] = { at: now() }
    try { save() } catch { /* stays fail-closed in memory */ }
    return map
  }
  const entries = () => Object.entries(load()).filter(([k]) => k !== MARK)
  const prune = () => {
    const m = load(); const cut = now() - ttlMs
    for (const [k, v] of Object.entries(m)) if (!v || !(v.at >= cut)) delete m[k]
  }
  const failClosed = () => { prune(); return !!load()[MARK] }

  // An agent id may be "provider:ref"; the ledger is keyed by bare ref, and an entry may carry aliases
  // (for example the agent id of a Claude job keyed by its jobId).
  const findRef = (id) => {
    if (!id || typeof id !== 'string') return null
    const m = load()
    const i = id.indexOf(':')
    const cands = i > 0 ? [id, id.slice(i + 1)] : [id]
    for (const c of cands) if (c !== MARK && Object.hasOwn(m, c)) return c
    for (const [k, v] of entries()) if (v.aliases?.includes(id)) return k
    return null
  }
  const find = (id) => { const k = findRef(id); return k ? load()[k] : null }

  return {
    /**
     * Record a launch. Returns { ref, token, parentAgentId, provider, via, at }. `token` is the raw secret
     * (pass one you already injected into the child, or let it be generated); only its hash is stored.
     */
    record({ ref, parentAgentId = null, provider, via = 'api', token, pending = false, aliases } = {}) {
      if (!ref || typeof ref !== 'string' || ref === MARK) throw new Error('launches.record: ref required')
      if (!VIAS.has(via)) throw new Error(`launches.record: bad via ${via}`)
      const m = load(); prune()
      const tok = typeof token === 'string' && token.length >= 16 ? token : newToken()
      const e = { parentAgentId: parentAgentId || null, provider, via, at: now(), tokenHash: hash(tok) }
      if (pending) e.pending = true
      if (Array.isArray(aliases) && aliases.length) e.aliases = aliases.filter((x) => typeof x === 'string')
      m[ref] = e
      save()
      return { ref, token: tok, parentAgentId: e.parentAgentId, provider, via, at: e.at }
    },
    /** Re-key a pending record (checkAndRecord's launchId) to the real ref once the spawn returns it. */
    bind(id, ref, aliases = []) {
      const m = load(); const k = findRef(id)
      if (!k || !ref || typeof ref !== 'string' || ref === MARK) return false
      const e = m[k]
      delete m[k]; delete e.pending
      const al = new Set([...(e.aliases || []), ...aliases.filter((x) => typeof x === 'string')])
      if (al.size) e.aliases = [...al]
      m[ref] = e
      save()
      return true
    },
    /** Drop a record whose spawn failed. */
    rollback(id) {
      const m = load(); const k = findRef(id)
      if (!k) return false
      delete m[k]; save()
      return true
    },
    get(ref) { prune(); return find(ref) },
    /** The ledger ref for an agent id, or null. */
    refOf(id) { prune(); return findRef(id) },
    /** Ledger ref whose token matches, or null. */
    refByToken(token) {
      if (typeof token !== 'string' || !token) return null
      prune(); const h = hash(token)
      for (const [k, v] of entries()) if (sameHash(v.tokenHash, h)) return k
      return null
    },
    /** True when `token` belongs to the ledger record for `id`. */
    verifyToken(id, token) {
      if (typeof token !== 'string' || !token) return false
      const e = this.get(id)
      return !!e && sameHash(e.tokenHash, hash(token))
    },
    /** startedBy for an agent id or ref. */
    startedBy(id) { prune(); return find(id)?.parentAgentId ?? null },
    /** True while a corrupt ledger keeps depth fail-closed. */
    failClosed,
    /**
     * Number of start links above this agent (0 when it was not started by an agent). Cycle-safe.
     * While the ledger is fail-closed, a chain that ends in an id the ledger doesn't know is Infinity.
     */
    depth(id) {
      const closed = failClosed()
      let d = 0; const seen = new Set()
      let cur = find(id)
      if (!cur) return closed ? Infinity : 0
      while (cur.parentAgentId) {
        if (seen.has(cur.parentAgentId)) return Infinity
        seen.add(cur.parentAgentId); d++
        const next = find(cur.parentAgentId)
        if (!next) return closed ? Infinity : d
        cur = next
      }
      return d
    },
    /** Starts by a caller (or everyone when parentAgentId is omitted) in the last windowMs. Includes pending. */
    count({ parentAgentId, via, windowMs = HOUR } = {}) {
      prune(); const cut = now() - windowMs
      return entries().map(([, v]) => v).filter((v) =>
        v.at >= cut && (via ? v.via === via : true) && (parentAgentId === undefined || v.parentAgentId === parentAgentId)).length
    },
    /** Re-parent children of oldId under newId (handoff of a lead). */
    reparent(oldId, newId) {
      let n = 0
      for (const [, v] of entries()) if (v.parentAgentId === oldId) { v.parentAgentId = newId; n++ }
      if (n) save()
      return n
    },
  }
}
