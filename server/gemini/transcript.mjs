// Gemini CLI session transcripts (append-only JSONL with upsert-by-id records), see docs/gemini-cli-notes.md §2.2.
import fsp from 'node:fs/promises'
import { jsonLines, readHead, readTail } from '../fsutil.mjs'

const SYNTHETIC = /^\s*<(session_context|hook_context)>/
const FILE_KEYS = ['file_path', 'absolute_path', 'path', 'dir_path', 'filepath']

/**
 * Replay a transcript's records. Messages upsert by id (last wins, position of first sight kept), `$patch`
 * updates fields of an existing message, `$rewindTo` drops that message and everything after it, `$set`
 * merges header metadata.
 * @returns {{ header: object, messages: object[] }}
 */
export function parseTranscript(text) {
  let header = {}
  const order = []
  const byId = new Map()
  for (const r of jsonLines(String(text || ''))) {
    if (r.$set && typeof r.$set === 'object') { Object.assign(header, r.$set); continue }
    if (r.$patch) {
      for (const u of Array.isArray(r.$patch.updates) ? r.$patch.updates : []) {
        const m = u && byId.get(u.id)
        if (m) Object.assign(m, u)
      }
      continue
    }
    if (typeof r.$rewindTo === 'string') {
      const i = order.indexOf(r.$rewindTo)
      if (i >= 0) for (const id of order.splice(i)) byId.delete(id)
      continue
    }
    if (typeof r.id === 'string' && typeof r.type === 'string') {
      if (!byId.has(r.id)) order.push(r.id)
      byId.set(r.id, r)
      continue
    }
    if (typeof r.sessionId === 'string' && !('id' in r)) header = { ...header, ...r }
    else if (r.summary && !r.id) header.summary = r.summary
  }
  return { header, messages: order.map((id) => byId.get(id)) }
}

/** Text of a user message's parts; '' for tool results and the synthetic context blobs. */
export function userText(m) {
  const c = m?.content
  const parts = Array.isArray(c) ? c : typeof c === 'string' ? [{ text: c }] : []
  const t = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
  return SYNTHETIC.test(t) ? '' : t
}

const at = (m) => Date.parse(m?.timestamp) || 0

function filesOf(args) {
  const out = []
  if (args && typeof args === 'object') for (const k of FILE_KEYS) if (typeof args[k] === 'string' && args[k]) out.push(args[k])
  return out
}

/** Normalize parsed messages to TxEvents, oldest first. */
export function toEvents(messages) {
  const ev = []
  for (const m of messages) {
    const when = at(m)
    if (m.type === 'user') {
      const text = userText(m)
      if (text) ev.push({ role: 'user', at: when, text })
    } else if (m.type === 'gemini') {
      const text = typeof m.content === 'string' ? m.content.trim() : ''
      if (text) ev.push({ role: 'assistant', at: when, text })
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        const name = tc.name || tc.displayName || 'tool'
        const done = !!tc.status && tc.status !== 'scheduled' && tc.status !== 'executing' && tc.status !== 'awaiting_approval'
        const e = { role: 'tool', at: Date.parse(tc.timestamp) || when, tool: { name, files: filesOf(tc.args), done } }
        if (name === 'write_todos' && Array.isArray(tc.args?.todos)) {
          e.todo = tc.args.todos.map((t) => ({ text: String(t.description || t.text || ''), done: t.status === 'completed' }))
        }
        ev.push(e)
      }
    }
  }
  return ev
}

/** @param {{ transcriptFile?: string|null }} agent */
export async function readTranscript(agent, { maxBytes = 512 * 1024 } = {}) {
  const file = agent?.transcriptFile
  if (!file) return []
  try {
    const { size } = await fsp.stat(file)
    let text
    if (size <= maxBytes) text = await fsp.readFile(file, 'utf8')
    else text = await readTail(file, maxBytes) // earlier upserts may be lost: acceptable for a bounded read
    return toEvents(parseTranscript(text).messages)
  } catch { return [] }
}

/** Cheap summary for the scan: header, first real prompt, last message shape. Reads head and tail only. */
export async function summarize(file, { head = 64 * 1024, tail = 64 * 1024 } = {}) {
  const st = await fsp.stat(file)
  const small = st.size <= head + tail
  const text = small ? await fsp.readFile(file, 'utf8') : await readHead(file, head)
  const first = parseTranscript(text)
  let last = first
  if (!small) last = parseTranscript(await readTail(file, tail))
  const msgs = last.messages
  const prompt = (first.messages.map(userText).find(Boolean)) || ''
  const tail1 = msgs[msgs.length - 1] || null
  let pending = false
  if (tail1) {
    if (tail1.type === 'gemini') pending = (tail1.toolCalls || []).some((t) => t.status === 'scheduled' || t.status === 'executing')
    else if (tail1.type === 'user') pending = true // a turn is open: user text or a tool result awaiting the model
  }
  return {
    header: { ...first.header, ...last.header },
    prompt,
    lastType: tail1?.type || null,
    lastText: tail1?.type === 'gemini' && typeof tail1.content === 'string' ? tail1.content.trim() : '',
    turnOpen: pending,
    size: st.size,
    mtime: st.mtimeMs,
  }
}
