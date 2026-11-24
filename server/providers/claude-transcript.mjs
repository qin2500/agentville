// Claude Code transcript (JSONL) -> normalized TxEvents for the handoff note. Bounded tail read.
import { readTail, jsonLines } from '../fsutil.mjs'

const TEXT_MAX = 4000
const FILE_KEYS = ['file_path', 'path', 'notebook_path']

const clip = (s) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s)
const stamp = (r) => Date.parse(r.timestamp) || 0

function filesOf(input) {
  const out = []
  if (input && typeof input === 'object') for (const k of FILE_KEYS) if (typeof input[k] === 'string' && input[k]) out.push(input[k])
  return out
}

/** Records (already parsed, oldest first) -> TxEvents, newest last. Pure. */
export function eventsOf(records) {
  const doneIds = new Set()
  for (const r of records) {
    const c = r?.message?.content
    if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_result' && b.tool_use_id) doneIds.add(b.tool_use_id)
  }
  const out = []
  for (const r of records) {
    if (!r || r.isSidechain || r.isMeta) continue
    const role = r.message?.role || r.type
    if (role !== 'user' && role !== 'assistant') continue
    const at = stamp(r)
    const c = r.message?.content
    if (typeof c === 'string') {
      if (c.trim()) out.push({ role, at, text: clip(c.trim()) })
      continue
    }
    if (!Array.isArray(c)) continue
    const text = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
    if (text) out.push({ role, at, text: clip(text) })
    for (const b of c) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
      const ev = { role: 'tool', at, tool: { name: b.name, files: filesOf(b.input), done: doneIds.has(b.id) } }
      if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
        ev.todo = b.input.todos.filter((t) => t && typeof t.content === 'string')
          .map((t) => ({ text: t.content.slice(0, 300), done: t.status === 'completed' }))
      }
      out.push(ev)
    }
  }
  return out
}

/**
 * The tail of an agent's transcript as TxEvents, newest last. `agent.transcriptFile` is the server-private path.
 * Never rejects: no file or an unreadable one gives [].
 */
export async function readTranscript(agent, { maxBytes = 256 * 1024 } = {}) {
  const file = agent?.transcriptFile
  if (typeof file !== 'string' || !file) return []
  try { return eventsOf(jsonLines(await readTail(file, maxBytes))) } catch { return [] }
}
