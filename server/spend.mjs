/**
 * Token spend: per-minute token counts for the last 7 days, from Claude Code transcripts (main and
 * subagent sidechains) and Codex rollouts. Read incrementally: each file keeps a byte offset and
 * only newly appended, complete lines are parsed, under a byte budget per tick. Minute buckets,
 * offsets and recently counted message ids persist in `<data>/spend.json` so a restart neither
 * zeroes nor double counts. Only token counts, ids and timestamps are read, never content.
 *
 * Claude: an assistant record's `message.usage` (input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens). A streamed reply writes one record per
 * content block, all with the same `message.id` and identical usage, so each id counts once.
 * Codex: `event_msg` `token_count` events; `last_token_usage` counts when `total_token_usage.total_tokens`
 * grew (Codex repeats the event). Its input_tokens include cached_input_tokens, which are split out.
 *
 * Models (the Models view): per file, the model of the latest assistant reply, when it last changed
 * (the last few changes), the size of the latest request's context, and tokens per model in 5-minute
 * slots for the last 24 h. Kept per file so a re-read rebuilds it without touching the minute buckets.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { listDirs, listFiles, logSafely } from './fsutil.mjs'
import { writeAtomic } from './accounts.mjs'

export const WINDOW_MS = 7 * 86400e3
const MIN = 60e3
const CHUNK = () => Number(process.env.AGENTVILLE_SPEND_CHUNK) || 16 * 1024 * 1024 // tests shrink both
const BUDGET = () => Number(process.env.AGENTVILLE_SPEND_BUDGET) || 128 * 1024 * 1024 // bytes per tick
const DISCOVER_MS = 30e3
const SAVE_MS = 30e3
/** Bucket fields, in order. */
export const FIELDS = ['input', 'output', 'cacheCreation', 'cacheRead', 'codexInput', 'codexOutput', 'codexCacheRead']
const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0)
const DAY = 86400e3
/** Per-file model token slots: 5 minutes, kept for 24 h (plus the slot that straddles the edge). */
export const SLOT = 5 * 60e3
const HISTORY = 10
const RECENT_IDS = 16
const MODEL = /^[\w.:/@\[\]<>-]{1,80}$/ // a model id, never free text
const modelName = (v) => (typeof v === 'string' && MODEL.test(v) ? v : '')

/**
 * Turn one complete transcript line into `{ id?, at, add: [7 numbers] }`, or null. `state` is the
 * file's own state (Codex's running total lives there).
 */
export function parseLine(line, kind, state) {
  const codexMeta = kind === 'codex' && (line.includes('"turn_context"') || line.includes('"task_started"'))
  if (kind === 'claude' ? !line.includes('"usage"') : !line.includes('"token_count"') && !codexMeta) return null
  let r
  try { r = JSON.parse(line) } catch { return null }
  const at = Date.parse(r?.timestamp)
  if (!Number.isFinite(at)) return null
  // Codex names its model per turn and its context window when a turn starts: no tokens, just facts.
  if (codexMeta && r.type === 'turn_context') return { at, meta: { model: modelName(r.payload?.model) } }
  if (codexMeta && r.type === 'event_msg' && r.payload?.type === 'task_started') return { at, meta: { window: n(r.payload.model_context_window) } }
  if (kind === 'claude') {
    const u = r.type === 'assistant' && r.message?.usage
    if (!u || typeof u !== 'object') return null
    const cw = n(u.cache_creation_input_tokens), cw1h = Math.min(cw, n(u.cache_creation?.ephemeral_1h_input_tokens))
    return {
      id: typeof r.message.id === 'string' ? r.message.id : null, at,
      mdl: modelName(r.message.model),
      // The size of this request's context: everything it sent, cached or not.
      ctx: n(u.input_tokens) + n(u.cache_read_input_tokens) + cw,
      add: [n(u.input_tokens), n(u.output_tokens), cw, n(u.cache_read_input_tokens), 0, 0, 0],
      // For the usage research log: model, speed and the 5-minute / 1-hour cache write split.
      model: typeof r.message.model === 'string' ? r.message.model.slice(0, 64) : '?',
      speed: typeof u.speed === 'string' ? u.speed.slice(0, 16) : '',
      split: [n(u.input_tokens), n(u.output_tokens), cw - cw1h, cw1h, n(u.cache_read_input_tokens)],
    }
  }
  const info = r.type === 'event_msg' && r.payload?.type === 'token_count' && r.payload.info
  const total = n(info?.total_token_usage?.total_tokens)
  if (!info || total <= (state.total || 0)) return null
  state.total = total
  const u = info.last_token_usage || {}
  const cached = n(u.cached_input_tokens)
  return { at, add: [0, 0, 0, 0, Math.max(0, n(u.input_tokens) - cached), n(u.output_tokens), cached], ctx: n(u.input_tokens), win: n(info.model_context_window) }
}

/** `research`: an optional createResearch(), told about every Claude message counted. */
export function createSpend({ dataDir, claudeHome, codexHome, research, now = Date.now }) {
  const file = path.join(dataDir, 'spend.json')
  // { files: { path: { off, ino, kind, total?, skip? } }, minutes: { minute: [7] }, seen: { id: minute },
  //   models: { path: { m, mAt, at, ctx, win, hist: [[at, from, to]], b: { slot: { model: [4] } }, ids } } }
  let S = null
  let known = [] // [{ path, kind }]
  let discoveredAt = 0
  let savedAt = 0
  let warnedAt = 0
  let dirty = false
  let catchingUp = true
  let running = null

  async function load() {
    try {
      const j = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (j?.v === 3) S = { files: j.files || {}, minutes: j.minutes || {}, seen: j.seen || {}, models: j.models || {} }
      // Version 2 kept no models: keep its counts and read every file again once, from the start. The
      // bytes it had already counted (`upto`) only feed the models, never the minute buckets again
      // (Codex has no message ids to catch a second count). The per-file models build from scratch.
      else if (j?.v === 2) {
        const files = {}
        for (const [p, e] of Object.entries(j.files || {})) if (e && Number.isFinite(e.off)) files[p] = { off: 0, ino: e.ino, kind: e.kind, upto: e.off }
        S = { files, minutes: j.minutes || {}, seen: j.seen || {}, models: {} }
        dirty = true
      }
    } catch { /* first run */ }
    S ??= { files: {}, minutes: {}, seen: {}, models: {} }
  }
  async function save(force) {
    if (!dirty || (!force && now() - savedAt < SAVE_MS)) return
    try {
      await fsp.mkdir(dataDir, { recursive: true })
      await writeAtomic(file, JSON.stringify({ v: 3, ...S }), 0o600)
      dirty = false
    } catch (e) {
      // A full disk (ENOSPC) or a read-only data dir: keep counting in memory, try again later.
      if (now() - warnedAt > 10 * 60e3) { warnedAt = now(); logSafely(`Couldn't save token spend (${e.code || e.message}); counting in memory and retrying.`) }
    }
    savedAt = now()
  }

  /** Transcripts written within the window. */
  async function discover() {
    const cut = now() - WINDOW_MS
    const out = []
    const keep = async (p, kind) => { const st = await fsp.stat(p).catch(() => null); if (st && st.mtimeMs >= cut) out.push({ path: p, kind }) }
    const projects = path.join(claudeHome(), 'projects')
    for (const dir of await listDirs(projects)) {
      for (const f of await listFiles(dir, (x) => x.endsWith('.jsonl'))) await keep(f, 'claude')
      for (const sid of await listDirs(dir)) for (const f of await listFiles(path.join(sid, 'subagents'), (x) => x.endsWith('.jsonl'))) await keep(f, 'claude')
    }
    for (const y of await listDirs(path.join(codexHome(), 'sessions')))
      for (const m of await listDirs(y))
        for (const d of await listDirs(m))
          for (const f of await listFiles(d, (x) => x.startsWith('rollout-') && x.endsWith('.jsonl'))) await keep(f, 'codex')
    known = out
    // Forget files that dropped out of the window.
    const live = new Set(out.map((f) => f.path))
    for (const p of Object.keys(S.files)) if (!live.has(p)) { delete S.files[p]; dirty = true }
    for (const p of Object.keys(S.models)) if (!live.has(p)) { delete S.models[p]; dirty = true }
  }

  /** The session a transcript belongs to: its own id, or its parent's for a subagent. */
  const sessionOf = (p) => (path.basename(path.dirname(p)) === 'subagents' ? path.basename(path.dirname(path.dirname(p))) : path.basename(p, '.jsonl')).slice(0, 8)

  /** The file's model facts. Runs for every record, counted before or not (see load). */
  function track(rec, file) {
    const st = (S.models[file] ??= { m: '', mAt: 0, at: 0, ctx: 0, win: 0, hist: [], b: {}, ids: [] })
    const setModel = (model) => {
      if (!model || rec.at < st.mAt) return
      if (st.m && st.m !== model) { st.hist.push([rec.at, st.m, model]); if (st.hist.length > HISTORY) st.hist.splice(0, st.hist.length - HISTORY) }
      st.m = model
      st.mAt = rec.at
    }
    if (rec.meta) { setModel(rec.meta.model); if (rec.meta.window) st.win = rec.meta.window; return }
    if (rec.mdl === '<synthetic>') return // the CLI's own error placeholder, not a model reply
    if (rec.id) { // a streamed reply repeats its id (and usage) once per content block
      if (st.ids.includes(rec.id)) return
      st.ids.push(rec.id)
      if (st.ids.length > RECENT_IDS) st.ids.shift()
    }
    setModel(rec.mdl)
    if (rec.at >= st.at) { st.at = rec.at; if (rec.ctx) st.ctx = rec.ctx; if (rec.win) st.win = rec.win }
    if (rec.at < now() - DAY - SLOT || rec.at > now() + 5 * MIN) return
    const slot = Math.floor(rec.at / SLOT) * SLOT
    const a = rec.add
    const add = rec.mdl !== undefined ? [a[0], a[1], a[2], a[3]] : [a[4], a[5], 0, a[6]] // Claude : Codex
    if (!add.some(Boolean)) return
    const b = ((st.b[slot] ??= {})[st.m || rec.mdl || ''] ??= [0, 0, 0, 0])
    add.forEach((v, i) => { b[i] += v })
  }

  function count(rec, file) {
    if (!rec.add) return
    const minute = Math.floor(rec.at / MIN) * MIN
    if (rec.at < now() - WINDOW_MS || rec.at > now() + 5 * MIN) return
    if (rec.id) {
      if (S.seen[rec.id] !== undefined) return
      S.seen[rec.id] = minute
    }
    const b = (S.minutes[minute] ??= FIELDS.map(() => 0))
    rec.add.forEach((v, i) => { b[i] += v })
    if (research && rec.split) research.addTokens({ at: rec.at, session: sessionOf(file), model: rec.model, speed: rec.speed, f: rec.split })
    dirty = true
  }

  /** Read what was appended to one file, up to `budget` bytes. Returns the bytes read. */
  async function readNew(f, budget) {
    const st = await fsp.stat(f.path).catch(() => null)
    if (!st) return 0
    let s = S.files[f.path]
    if (s && s.mtime === st.mtimeMs && s.size === st.size) return 0 // untouched since the last tick
    const fh = await fsp.open(f.path, 'r')
    let read = 0
    try {
      // New, replaced (another inode), truncated or rewritten in place (the bytes just before our
      // offset changed): start over. Counted message ids keep a re-read from double counting.
      if (s && s.ino === st.ino && st.size >= s.off && s.off > 0 && (await tailOf(fh, s.off)) !== s.tail) s = null
      if (!s || s.ino !== st.ino || st.size < s.off) { s = S.files[f.path] = { off: 0, ino: st.ino, kind: f.kind }; delete S.models[f.path]; dirty = true }
      while (s.off < st.size && read < budget) {
        const len = Math.min(CHUNK(), st.size - s.off)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, s.off)
        if (!bytesRead) break
        read += bytesRead
        const chunk = buf.subarray(0, bytesRead)
        let start = 0
        if (s.skip) { // inside a line too long to hold: drop it up to its end
          const nl = chunk.indexOf(10)
          if (nl < 0) { s.off += bytesRead; continue }
          start = nl + 1
          s.skip = false
        }
        const last = chunk.lastIndexOf(10)
        if (last < start) {
          // No complete line yet. A full chunk without a newline is one enormous line: skip it.
          if (bytesRead === CHUNK() && !start) { s.off += bytesRead; s.skip = true } else s.off += start
          break
        }
        // Up to the last newline only: a half-written line is read next time, and never splits a UTF-8 character.
        let pos = s.off + start // byte offset of the line, needed only while re-reading counted bytes
        for (const line of chunk.toString('utf8', start, last).split('\n')) {
          const counted = s.upto > pos
          if (counted) pos += Buffer.byteLength(line) + 1
          const rec = line && parseLine(line, f.kind, s)
          if (rec) { track(rec, f.path); if (!counted) count(rec, f.path) }
        }
        s.off += last + 1
        if (s.upto && s.off >= s.upto) delete s.upto
        dirty = true
      }
      s.tail = await tailOf(fh, s.off)
      if (s.off >= st.size) { s.mtime = st.mtimeMs; s.size = st.size } else delete s.mtime
    } finally { await fh.close() }
    return read
  }
  /** The (up to) 512 bytes before `off`, hashed: the fingerprint of what was already read. */
  async function tailOf(fh, off) {
    const len = Math.min(512, off)
    const buf = Buffer.alloc(len)
    if (len) await fh.read(buf, 0, len, off - len)
    return crypto.createHash('sha1').update(buf).digest('base64')
  }

  async function tick() {
    if (!S) await load()
    if (now() - discoveredAt > DISCOVER_MS) { await discover(); discoveredAt = now() }
    let budget = BUDGET()
    for (const f of known) {
      if (budget <= 0) break
      budget -= await readNew(f, budget)
    }
    catchingUp = budget <= 0 // ran out of budget: there is more to read next tick
    // Drop minutes and ids older than the window.
    const cut = now() - WINDOW_MS
    for (const m of Object.keys(S.minutes)) if (Number(m) < cut - MIN) { delete S.minutes[m]; dirty = true }
    for (const [id, m] of Object.entries(S.seen)) if (m < cut - MIN) { delete S.seen[id]; dirty = true }
    const slotCut = now() - DAY - SLOT
    for (const st of Object.values(S.models)) for (const t of Object.keys(st.b)) if (Number(t) < slotCut) { delete st.b[t]; dirty = true }
    await save(false)
    await research?.flush()
  }

  /** One tick at a time; callers share it. */
  const update = () => (running ??= tick().finally(() => { running = null }))

  /** Field sums over the `span` minutes ending now. */
  function totals(span) {
    const nowMin = Math.floor(now() / MIN) * MIN
    const sum = FIELDS.map(() => 0)
    for (let t = nowMin - (span - 1) * MIN; t <= nowMin; t += MIN) S?.minutes[t]?.forEach((v, i) => { sum[i] += v })
    const [input, output, cacheCreation, cacheRead, codexInput, codexOutput, codexCacheRead] = sum
    return {
      claude: { input, output, cacheCreation, cacheRead, tokens: input + output + cacheCreation + cacheRead },
      codex: { input: codexInput, output: codexOutput, cacheRead: codexCacheRead, tokens: codexInput + codexOutput + codexCacheRead },
    }
  }

  /**
   * `minutes` (60, 300, 1440 or 10080) -> a series of at most ~180 points (oldest first; each point
   * is `step` minutes summed), totals for that range, and the last 60 min and 7 days.
   * `tokens` = input + output + cache writes + cache reads (each field is also reported on its own).
   */
  function summary(minutes = 60) {
    minutes = Math.max(1, Math.min(Math.round(minutes) || 60, WINDOW_MS / MIN))
    const step = minutes <= 300 ? 1 : minutes <= 1440 ? 10 : 60
    const nowMin = Math.floor(now() / MIN) * MIN
    const end = nowMin - (nowMin % (step * MIN)) // points align to whole steps
    const series = []
    for (let p = end - (Math.ceil(minutes / step) - 1) * step * MIN; p <= end; p += step * MIN) {
      let tokens = 0, cacheRead = 0, codex = 0
      for (let t = p; t < p + step * MIN && t <= nowMin; t += MIN) {
        const b = S?.minutes[t]
        if (b) { tokens += b[0] + b[1] + b[2] + b[3]; cacheRead += b[3]; codex += b[4] + b[5] + b[6] }
      }
      series.push({ t: p, tokens, cacheRead, codex })
    }
    const hour = totals(60), day = totals(1440), week = totals(WINDOW_MS / MIN), range = totals(minutes)
    // The top bar's sparkline: always the last 60 minutes, minute by minute.
    const recent = []
    for (let t = nowMin - 59 * MIN; t <= nowMin; t += MIN) { const b = S?.minutes[t]; recent.push(b ? b[0] + b[1] + b[2] + b[3] : 0) }
    return {
      minutes, step, series, recent, catchingUp,
      last60: hour.claude, codex: hour.codex,
      day: day.claude, dayCodex: day.codex,
      week: week.claude, weekCodex: week.codex,
      range: range.claude, rangeCodex: range.codex,
    }
  }

  /**
   * One transcript's model facts, or null if it hasn't been read: the latest model, when it was last
   * used, the latest request's context size (and Codex's window), the last few model changes, and
   * tokens per model `[input, output, cacheWrite, cacheRead]` for the last hour and 24 hours.
   */
  function modelFacts(file) {
    const st = S?.models[file]
    if (!st) return null
    const t = now(), tokens = {}
    for (const [slot, per] of Object.entries(st.b)) {
      const s = Number(slot)
      if (s + SLOT <= t - DAY) continue
      for (const [model, v] of Object.entries(per)) {
        const e = (tokens[model] ??= { hour: [0, 0, 0, 0], day: [0, 0, 0, 0] })
        v.forEach((x, i) => { e.day[i] += x; if (s + SLOT > t - 3600e3) e.hour[i] += x })
      }
    }
    return { model: st.m, at: st.at, ctx: st.ctx, window: st.win, history: st.hist.map(([at, from, to]) => ({ at, from, to })), tokens }
  }

  return { update, summary, modelFacts, catchingUp: () => catchingUp, flush: () => save(true), files: () => S?.files }
}
