/**
 * Codex adapter: `state_<n>.sqlite` thread rows + rollout transcripts. Read-only, bounded reads.
 * Ported and simplified from Bot Crossing server/harnesses/codex.mjs (MIT, Jarren Rocks).
 * Spawned child threads come from `thread_spawn_edges` and are reported as `kind: 'thread'` subs.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { jsonLines, listDirs, listFiles, projectOf, readHead, readTail } from './fsutil.mjs'
import { readWaitEvidence, currentWait } from './waiting.mjs'

/** AGENTVILLE_CODEX_HOME (tests/fixtures) > CODEX_HOME > ~/.codex. */
export const home = () => process.env.AGENTVILLE_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const TAIL_BYTES = 64 * 1024
const HEAD_BYTES = 64 * 1024
const ACTIVE_MS = 30 * 60 * 1000
const IDLE_MS = 6 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID = (id) => `codex:${id}`
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()
const text = (v) => (typeof v === 'string' && v.trim() ? clean(v).slice(0, 80) : null)

let sqlite
const sqliteApi = () => (sqlite ??= import('node:sqlite').catch(() => null))

/** Thread rows and spawn edges. Columns are probed: this is private, versioned state. */
async function database() {
  const out = { rows: new Map(), parent: new Map() }
  let names
  try { names = await fsp.readdir(home()) } catch { return out }
  const file = names.filter((n) => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)) - Number(a.match(/\d+/)))[0]
  const api = await sqliteApi()
  if (!file || !api?.DatabaseSync) return out
  let db
  try {
    db = new api.DatabaseSync(path.join(home(), file), { readOnly: true })
    const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name))
    if (!cols.has('id')) return out
    const col = (n, d = "''") => (cols.has(n) ? `t.${n}` : d)
    const time = cols.has('updated_at_ms') ? 't.updated_at_ms' : cols.has('updated_at') ? 't.updated_at * 1000' : '0'
    for (const r of db.prepare(`SELECT t.id, ${col('cwd')} AS cwd, ${col('title')} AS title, ${col('preview')} AS preview,
        ${col('first_user_message')} AS first_user_message, ${col('agent_nickname')} AS nickname,
        ${col('archived', '0')} AS archived, ${col('model', 'NULL')} AS model, ${col('reasoning_effort', 'NULL')} AS effort,
        ${col('model_provider', 'NULL')} AS provider, ${time} AS updated_at_ms FROM threads t`).all()) {
      if (UUID.test(r.id || '')) out.rows.set(r.id, r)
    }
    const edgeCols = new Set(db.prepare('PRAGMA table_info(thread_spawn_edges)').all().map((r) => r.name))
    if (edgeCols.has('parent_thread_id') && edgeCols.has('child_thread_id')) {
      for (const e of db.prepare('SELECT parent_thread_id p, child_thread_id c FROM thread_spawn_edges').all()) {
        if (UUID.test(e.p || '') && UUID.test(e.c || '')) out.parent.set(e.c, e.p)
      }
    }
  } catch { /* locked or reshaped DB: transcripts still answer */ } finally { try { db?.close() } catch {} }
  return out
}

/**
 * Threads Codex created by importing another agent's session (e.g. a Claude Code transcript):
 * `external_agent_session_imports.json` records[].imported_thread_id -> latest import time (ms).
 * They mirror someone else's conversation; nobody is waiting on them in Codex.
 */
async function imports() {
  const out = new Map()
  try {
    const file = path.join(home(), 'external_agent_session_imports.json')
    if ((await fsp.stat(file)).size > 8 * 1024 * 1024) return out
    for (const r of JSON.parse(await fsp.readFile(file, 'utf8'))?.records || []) {
      const at = Number(r?.imported_at)
      if (!UUID.test(r?.imported_thread_id || '') || !Number.isFinite(at)) continue
      const ms = at < 1e12 ? at * 1000 : at
      out.set(r.imported_thread_id, Math.max(out.get(r.imported_thread_id) || 0, ms))
    }
  } catch { /* no imports */ }
  return out
}
const IMPORT_SLACK_MS = 2 * 60 * 1000

async function rollouts() {
  const out = new Map()
  for (const y of await listDirs(path.join(home(), 'sessions')))
    for (const m of await listDirs(y))
      for (const d of await listDirs(m))
        for (const file of await listFiles(d, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
          const id = /([0-9a-f-]{36})\.jsonl$/i.exec(file)?.[1]
          const st = id && UUID.test(id) ? await fsp.stat(file).catch(() => null) : null
          if (st) out.set(id, { file, mtime: st.mtimeMs, size: st.size, stamp: `${st.mtimeMs}:${st.size}` })
        }
  return out
}

const cache = new Map()
async function facts(entry) {
  const hit = cache.get(entry.file)
  if (hit?.stamp === entry.stamp) return hit.facts
  let unreadable = false
  const tail = jsonLines(await readTail(entry.file, TAIL_BYTES).catch(() => { unreadable = true; return '' }))
  let lifecycle = null
  for (const r of tail) {
    const t = r?.type === 'event_msg' && r.payload?.type
    // `stream_error` is a dropped stream; anything after it (a retry's completion) supersedes it.
    if (['task_started', 'task_complete', 'turn_aborted', 'error', 'stream_error'].includes(t)) lifecycle = { type: t, error: t === 'error' || t === 'stream_error' || Boolean(r.payload.error) }
  }
  let cwd = ''
  let prompt = ''
  let valid = false
  for (const r of jsonLines(await readHead(entry.file, HEAD_BYTES).catch(() => ''))) {
    valid ||= r.type === 'session_meta'
    if (r.type === 'session_meta') cwd ||= r.payload?.cwd || ''
    if (r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user' && !prompt) {
      const c = r.payload.content
      prompt = clean(Array.isArray(c) ? c.map((p) => p?.text || '').join(' ') : c).slice(0, 2000)
    }
  }
  const out = { lifecycle, evidence: readWaitEvidence(tail, 'codex'), cwd, prompt, valid, unreadable }
  cache.set(entry.file, { stamp: entry.stamp, facts: out })
  return out
}

export async function scan(now = Date.now()) {
  const [{ rows, parent }, files, imported] = await Promise.all([database(), rollouts(), imports()])
  const out = []
  let unreadable = 0
  for (const id of new Set([...rows.keys(), ...files.keys()])) {
    const row = rows.get(id)
    const entry = files.get(id)
    const f = entry ? await facts(entry) : { lifecycle: null, evidence: null, cwd: '', prompt: '' }
    if (f.unreadable) unreadable++
    if (!row && !f.valid) continue // not a Codex rollout: no DB row and no session_meta
    const lastActivityAt = Math.max(Number(row?.updated_at_ms) || 0, entry?.mtime || 0)
    const started = f.lifecycle?.type === 'task_started'
    // Codex records no process liveness, so an open turn (`task_started`) is the evidence and
    // ponytail: a 30-minute quiet window bounds it; a turn that has gone quiet is treated as dead.
    let lifecycle
    // An import nobody has touched in Codex since it was written is a mirror, not a conversation.
    const mirror = imported.has(id) && (entry?.mtime || 0) <= imported.get(id) + IMPORT_SLACK_MS
    if (row?.archived === 1 || row?.archived === true) lifecycle = 'done'
    else if (mirror) lifecycle = 'closed'
    else if (f.lifecycle?.error) lifecycle = 'failed'
    else if (f.lifecycle?.type === 'turn_aborted') lifecycle = 'stopped'
    else if (started) lifecycle = now - lastActivityAt < ACTIVE_MS ? 'running' : 'dead'
    // No liveness to prove anyone is still at the other end, so a finished turn rests after 6 h.
    else lifecycle = now - lastActivityAt < IDLE_MS ? 'idle' : 'closed'
    const cwd = row?.cwd || f.cwd || ''
    const prompt = clean(row?.preview || row?.first_user_message || f.prompt)
    const parentId = parent.has(id) ? ID(parent.get(id)) : null
    out.push({
      id: ID(id),
      harness: 'codex',
      kind: parentId ? 'thread' : 'session',
      name: clean(row?.nickname) || clean(row?.title),
      title: prompt,
      project: projectOf(cwd),
      cwd: cwd || null,
      parentId,
      live: !mirror && started && lifecycle === 'running',
      lastActivityAt,
      sizeBytes: entry?.size || 0,
      lifecycle,
      needsUser: !mirror && started && f.evidence?.needsUser === true,
      needsUserSource: 'tool',
      prompt: f.evidence?.prompt || null,
      waitingOn: !mirror && started ? currentWait(f.evidence, now) : null,
      prs: [],
      resume: parentId ? null : `codex resume ${id}`,
      // Server-private (not in the API): the rollout, and the thread's model settings.
      transcriptFile: entry?.file || null,
      modelConfig: { model: text(row?.model), effort: text(row?.effort), provider: text(row?.provider) },
    })
  }
  out.unreadable = unreadable
  return out
}
