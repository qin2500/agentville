// Models view, Gemini (Antigravity) side. Reads only model names, token counts and times from the brain
// transcript (`transcript_full.jsonl`, reply rows carry `model`, `created_at`, `input_tokens`, `cache_read_tokens`,
// `output_tokens`) and the run's `state.json` (the requested model). Never a path, prompt or reply text.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { jsonLines, readTail, readJson } from '../fsutil.mjs'

const MAX_BYTES = 8 * 1024 * 1024
const ID_RE = /^[\w.-]{1,200}$/
const MODEL_RE = /^[\w.:/@-]{1,80}$/
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0)

const cache = new Map() // file -> { sig, facts }

/** Brain transcript rows -> { model, at, ctx, tokens: { [model]: { day: [in, out, 0, cacheRead], hour } }, history }. */
export function foldRows(rows, now = Date.now()) {
  let model = '', at = 0, ctx = 0
  const tokens = {}
  const history = []
  for (const r of rows) {
    const m = typeof r?.model === 'string' && MODEL_RE.test(r.model) ? r.model : ''
    const t = Date.parse(r?.created_at)
    if (!m || !Number.isFinite(t)) continue
    if (model && m !== model) history.push({ at: t, from: model, to: m })
    if (t >= at) { model = m; at = t; ctx = num(r.input_tokens) + num(r.cache_read_tokens) }
    const age = now - t
    if (age > 86400e3) continue
    const e = (tokens[m] ||= { day: [0, 0, 0, 0], hour: [0, 0, 0, 0] })
    const v = [num(r.input_tokens), num(r.output_tokens) + num(r.thinking_tokens), 0, num(r.cache_read_tokens)]
    for (let i = 0; i < 4; i++) { e.day[i] += v[i]; if (age <= 3600e3) e.hour[i] += v[i] }
  }
  return { model, at, ctx, tokens, history }
}

/** The requested model of an Agentville-started run (`state.json`), or null. */
export async function runModel(dataDir, runId) {
  if (!dataDir || !runId) return null
  const s = await readJson(path.join(dataDir, 'gemini-runs', String(runId).replace(/[^\w.-]/g, '_'), 'state.json'))
  return typeof s?.model === 'string' && MODEL_RE.test(s.model) ? s.model : null
}

/** Facts for one Gemini agent: `{ model, at, ctx, tokens, history, requested }`; empty when nothing is readable. */
export async function geminiModelFacts({ conversationId, runId, dataDir, agyDir, now = Date.now() }) {
  const out = { model: '', at: 0, ctx: 0, tokens: {}, history: [], requested: await runModel(dataDir, runId).catch(() => null) }
  if (!agyDir || !ID_RE.test(String(conversationId || ''))) return out
  const logs = path.join(agyDir, 'brain', conversationId, '.system_generated', 'logs')
  for (const n of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const file = path.join(logs, n)
    let st
    try { st = await fsp.stat(file); if (!st.isFile()) continue } catch { continue }
    const sig = `${st.size}:${st.mtimeMs}:${Math.floor(now / 60e3)}`
    let hit = cache.get(file)
    if (hit?.sig !== sig) {
      try { hit = { sig, facts: foldRows(jsonLines(await readTail(file, MAX_BYTES)), now) } } catch { continue }
      cache.set(file, hit)
      if (cache.size > 200) cache.delete(cache.keys().next().value)
    }
    if (hit.facts.model) return { ...out, ...hit.facts }
  }
  return out
}
