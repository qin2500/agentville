/**
 * Server-side town plan (decision D5): one JSON file shared by every browser/Electron window, so they
 * all show the same town. <dataDir>/world-plan.json = { v: 1, keys: { [key]: { rev, at, value } } }.
 *
 * - Every read and write runs on one in-process promise queue; writes are tmp + fsync + rename.
 * - put() is compare-and-set per key: baseRev must equal the key's current rev (0 when absent).
 * - A file written by a newer version (v > 1) is served but never overwritten (PUT 409 'version').
 * - An unparseable file is renamed world-plan.json.corrupt-<ts> and the plan starts empty.
 * - AGENTVILLE_WORLD_PLAN=0 (or the legacy VILLAGE_WORLD_PLAN=0) turns the HTTP routes off (404).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isLocalRequest } from './local-request.mjs'

export const WORLD_PLAN_VERSION = 1
export const WORLD_PLAN_FILE = 'world-plan.json'
export const KEY_RE = /^va\.(engine2\.world(\.[a-z0-9.-]+)?|world\d+|engine2\.seed|seen)$/
export const MAX_KEY_BYTES = 2 * 1024 * 1024
export const MAX_FILE_BYTES = 8 * 1024 * 1024
/** The PUT body carries one value (<= 2 MB) plus its key; capped at the file limit like the plan itself. */
export const MAX_BODY_BYTES = MAX_FILE_BYTES

/** Demo towns are throwaway: a `demo` segment anywhere in the key is never stored. */
export const allowedKey = (key) => typeof key === 'string' && key.length <= 200 && KEY_RE.test(key) && !/(^|\.)demo(\.|$)/.test(key)

export const worldPlanEnabled = (env = process.env) =>
  env.AGENTVILLE_WORLD_PLAN !== '0' && env.VILLAGE_WORLD_PLAN !== '0'

const empty = () => ({ v: WORLD_PLAN_VERSION, keys: {} })
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x)

/**
 * @param {string} dataDir
 * @param {{ fs?: typeof fsp, now?: () => number }} [opts]  fs is injectable so tests can fail a step.
 */
export function createWorldPlan(dataDir, { fs = fsp, now = Date.now } = {}) {
  const file = path.join(dataDir, WORLD_PLAN_FILE)
  let tail = Promise.resolve()
  const queue = (fn) => {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  // Cached doc, trusted only while the file's identity (ino/size/mtime) is unchanged, so deleting or
  // replacing the file by hand (rollback: delete -> re-migrate) takes effect without a restart.
  let cache = null // { stamp, doc, readOnly: false | 'version' | 'corrupt' }
  let swept = false
  let seq = 0
  const stampOf = (st) => (st ? `${st.ino}:${st.size}:${st.mtimeMs}` : 'none')

  async function sweepTmp() {
    if (swept) return
    swept = true
    const names = await fs.readdir(dataDir).catch(() => [])
    await Promise.all(names.filter((n) => n.startsWith(`${WORLD_PLAN_FILE}.tmp-`))
      .map((n) => fs.rm(path.join(dataDir, n), { force: true }).catch(() => {})))
  }

  async function load() {
    await sweepTmp()
    const st = await fs.stat(file).catch((e) => { if (e.code === 'ENOENT') return null; throw e })
    const stamp = stampOf(st)
    if (cache && cache.stamp === stamp) return cache
    if (!st) return (cache = { stamp, doc: empty(), readOnly: false })
    const text = await fs.readFile(file, 'utf8')
    let doc = null
    try { doc = JSON.parse(text) } catch { /* corrupt */ }
    if (isObj(doc) && Number.isInteger(doc.v) && doc.v > WORLD_PLAN_VERSION) {
      return (cache = { stamp, doc, readOnly: 'version' }) // a newer app wrote it: serve, never overwrite
    }
    if (isObj(doc) && doc.v === WORLD_PLAN_VERSION && isObj(doc.keys)) {
      const keys = {}
      for (const [k, e] of Object.entries(doc.keys)) {
        if (isObj(e) && Number.isInteger(e.rev) && e.rev > 0 && 'value' in e) keys[k] = { rev: e.rev, at: Number(e.at) || 0, value: e.value }
      }
      return (cache = { stamp, doc: { v: WORLD_PLAN_VERSION, keys }, readOnly: false })
    }
    // Corrupt: keep the bytes for a human, start empty.
    const aside = `${file}.corrupt-${now()}`
    try {
      await fs.rename(file, aside)
      return (cache = { stamp: 'none', doc: empty(), readOnly: false })
    } catch {
      return (cache = { stamp, doc: empty(), readOnly: 'corrupt' }) // could not move it aside: never overwrite it
    }
  }

  async function writeAtomic(doc, text) {
    await fs.mkdir(dataDir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${++seq}`
    let fh = null
    try {
      fh = await fs.open(tmp, 'w', 0o600)
      await fh.writeFile(text, 'utf8')
      await fh.sync()
      await fh.close()
      fh = null
      await fs.rename(tmp, file)
    } catch (e) {
      if (fh) await fh.close().catch(() => {})
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
    try { // make the rename itself durable (best effort; not every platform allows fsync on a directory)
      const dh = await fs.open(dataDir, 'r')
      try { await dh.sync() } finally { await dh.close() }
    } catch { /* ignore */ }
    const st = await fs.stat(file).catch(() => null)
    cache = { stamp: stampOf(st), doc, readOnly: false }
  }

  /** @returns {Promise<{v:number, keys:Record<string,{rev:number, at:number, value:any}>}>} treat as read-only */
  const read = () => queue(async () => {
    const { doc } = await load()
    return { v: doc.v, keys: isObj(doc.keys) ? { ...doc.keys } : {} }
  })

  /** Compare-and-set one key. Never throws for bad input; I/O failures reject (old file stays intact). */
  const put = (key, value, baseRev) => queue(async () => {
    if (!allowedKey(key)) return { ok: false, status: 400, reason: 'key' }
    if (baseRev === null || baseRev === undefined) baseRev = 0
    if (!Number.isInteger(baseRev) || baseRev < 0) return { ok: false, status: 400, reason: 'baseRev' }
    let text
    try { text = JSON.stringify(value) } catch { return { ok: false, status: 400, reason: 'value' } }
    if (text === undefined) return { ok: false, status: 400, reason: 'value' }
    if (Buffer.byteLength(text) > MAX_KEY_BYTES) return { ok: false, status: 413, reason: 'key-size' }
    const state = await load()
    if (state.readOnly) return { ok: false, status: 409, reason: state.readOnly }
    const cur = state.doc.keys[key]
    const rev = cur?.rev || 0
    if (baseRev !== rev) return { ok: false, status: 409, reason: 'stale', rev, value: cur ? cur.value : null }
    const next = { v: WORLD_PLAN_VERSION, keys: { ...state.doc.keys, [key]: { rev: rev + 1, at: now(), value: JSON.parse(text) } } }
    const out = JSON.stringify(next)
    if (Buffer.byteLength(out) > MAX_FILE_BYTES) return { ok: false, status: 413, reason: 'file-size' }
    await writeAtomic(next, out)
    return { ok: true, rev: rev + 1 }
  })

  return { file, read, put }
}

async function readLimited(req, limit) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 })
    chunks.push(c)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
}

/**
 * HTTP glue for serve.mjs: returns a handler `(req, res, send) => Promise<boolean>` that answers
 * /api/world-plan and returns true, or returns false (route off or another path) so the caller 404s.
 *   GET  -> 200 { v, keys: { [k]: { rev, value } } }
 *   PUT  { key, value, baseRev } -> 200 { rev } | 409 { rev, value } (stale) | 409 { error, reason } | 400 | 413
 */
export function worldPlanRoute(plan, { env = process.env } = {}) {
  return async (req, res, send) => {
    if (!worldPlanEnabled(env)) return false
    if (req.method === 'GET') {
      const doc = await plan.read()
      const keys = {}
      for (const [k, e] of Object.entries(doc.keys)) if (isObj(e)) keys[k] = { rev: e.rev, value: e.value }
      send(res, 200, { v: doc.v, keys })
      return true
    }
    if (req.method === 'PUT') {
      if (!isLocalRequest(req)) { send(res, 403, { error: 'Local requests only' }); return true }
      const body = await readLimited(req, MAX_BODY_BYTES)
      if (!isObj(body) || !('value' in body)) { send(res, 400, { error: 'Expected { key, value, baseRev }' }); return true }
      const r = await plan.put(body.key, body.value, body.baseRev)
      if (r.ok) send(res, 200, { rev: r.rev })
      else if (r.status === 409 && r.reason === 'stale') send(res, 409, { rev: r.rev, value: r.value })
      else send(res, r.status, { error: r.reason === 'version' ? 'The town plan was saved by a newer version and is read-only'
        : r.reason === 'corrupt' ? 'The town plan file is unreadable and could not be moved aside'
        : r.status === 413 ? 'Too large' : `Invalid ${r.reason}`, reason: r.reason })
      return true
    }
    send(res, 405, { error: 'Method not allowed' })
    return true
  }
}
