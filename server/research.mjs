/**
 * Usage research log: raw material for working out how subscription usage limits weigh tokens.
 * Two append-only JSONL files per month under `<data>/research/`, joined offline (tools/usage-fit.mjs):
 *
 *   tokens-YYYY-MM.jsonl  { t, s, m, sp, f: [input, output, cacheWrite5m, cacheWrite1h, cacheRead], n }
 *     Claude tokens per 5-minute bucket `t`, session `s` (first 8 chars), model `m` and speed `sp`
 *     (fast mode), over `n` messages. Rows are deltas: the same key may appear again when late
 *     records arrive, so readers sum them.
 *   usage-YYYY-MM.jsonl   { at, account, saved, active, stale?, windows: { name: { used, resetsAt } } }
 *     Every usage reading the sampler takes: the active login each minute, and every saved account
 *     when it checks them all. `windows` keeps every window Anthropic returns, not just the two we show.
 *
 * Only counts, ids, model names and times: never content or credentials. Writing never throws (a full
 * disk is logged once in a while), and stops while the folder is over MAX_BYTES.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { logSafely } from './fsutil.mjs'

export const BUCKET_MS = 5 * 60e3
const MAX_BYTES = 1024 * 1024 * 1024
const SIZE_CHECK_MS = 10 * 60e3

export function createResearch({ dataDir, now = Date.now }) {
  const dir = path.join(dataDir, 'research')
  let size = null, sizeAt = 0, warnedAt = 0
  const month = (at) => new Date(at).toISOString().slice(0, 7)

  async function full() {
    if (size === null || now() - sizeAt > SIZE_CHECK_MS) {
      size = 0
      sizeAt = now()
      for (const f of await fsp.readdir(dir).catch(() => [])) size += (await fsp.stat(path.join(dir, f)).catch(() => null))?.size || 0
    }
    return size > MAX_BYTES
  }
  async function append(kind, rows) {
    if (!rows.length) return
    try {
      if (await full()) return
      await fsp.mkdir(dir, { recursive: true })
      const byFile = new Map()
      for (const r of rows) {
        const f = path.join(dir, `${kind}-${month(r.t ?? r.at)}.jsonl`)
        byFile.set(f, (byFile.get(f) || '') + JSON.stringify(r) + '\n')
      }
      for (const [f, text] of byFile) { await fsp.appendFile(f, text, { mode: 0o600 }); size += Buffer.byteLength(text) }
    } catch (e) {
      if (now() - warnedAt > 10 * 60e3) { warnedAt = now(); logSafely(`Couldn't write the usage research log (${e.code || e.message}).`) }
    }
  }

  /** Token rows waiting for the next flush: key -> row. */
  const pending = new Map()
  /** One Claude message: `{ at, session, model, speed, f: [5] }`. */
  function addTokens({ at, session, model, speed, f }) {
    const t = Math.floor(at / BUCKET_MS) * BUCKET_MS
    const key = `${t}|${session}|${model}|${speed}`
    let r = pending.get(key)
    if (!r) pending.set(key, (r = { t, s: session, m: model, sp: speed, f: [0, 0, 0, 0, 0], n: 0 }))
    f.forEach((v, i) => { r.f[i] += v })
    r.n++
  }
  async function flush() {
    const rows = [...pending.values()]
    pending.clear()
    await append('tokens', rows)
  }

  /** One usage reading. `raw`: Anthropic's windows as { name: { used, resetsAt } }. */
  const usage = (entry) => append('usage', [{ at: now(), ...entry }])

  return { addTokens, flush, usage, dir }
}

/** Every window in an /api/oauth/usage reply that has a utilization, as { name: { used, resetsAt } }. */
export function usageWindows(u) {
  const out = {}
  for (const [k, w] of Object.entries(u && typeof u === 'object' ? u : {})) {
    if (w && typeof w === 'object' && typeof w.utilization === 'number') out[k] = { used: w.utilization, resetsAt: Date.parse(w.resets_at) || null }
  }
  return out
}
