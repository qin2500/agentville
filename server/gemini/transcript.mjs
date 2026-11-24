// Gemini provider transcripts, Antigravity CLI (`agy`). Two sources (docs/antigravity-cli-notes.md §2, §3.4):
// 1. The runner's own out.log: agy stream-json (`init`, `step_update`, `result`), for runs Agentville started.
// 2. `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript*.jsonl` for sessions the user ran by
//    hand. That layout is third-party and undocumented, so rows are read best-effort and unknown shapes dropped.
// Everything is tolerant: unknown events and fields are ignored, never thrown on.
import fsp from 'node:fs/promises'
import { jsonLines, readHead, readTail } from '../fsutil.mjs'
import { joinDelta } from './runner.mjs'

const FILE_KEYS = ['file_path', 'absolute_path', 'path', 'dir_path', 'filepath', 'AbsolutePath', 'TargetFile', 'FilePath']
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null)
const str = (x) => (typeof x === 'string' ? x : '')

function filesOf(args) {
  const out = []
  const a = obj(args)
  if (a) for (const k of FILE_KEYS) if (typeof a[k] === 'string' && a[k]) out.push(a[k])
  return out
}

/** Text of a brain-transcript `content` field: a string, `{ text }`, or a list of either. */
function textOf(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(textOf).join('')
  const o = obj(c)
  return o ? str(o.text) || str(o.content) || '' : ''
}

/** stream-json rows (out.log, possibly several turns) -> TxEvents, oldest first. De-duplicated per step. */
export function streamToEvents(rows, at = 0) {
  const steps = new Map()
  const order = []
  let turn = 0
  for (const e of rows) {
    const kind = str(e?.event) || str(e?.type)
    if (kind === 'init') { turn++; continue }
    if (kind !== 'step_update') continue
    const u = obj(e.step_update) || e
    const key = `${turn}:${str(u.conversation_id)}:${Number.isFinite(u.step_index) ? u.step_index : order.length}`
    let s = steps.get(key)
    if (!s) { s = { type: str(u.step_type), text: '', tool: null, done: false }; steps.set(key, s); order.push(key) }
    s.type = str(u.step_type) || s.type
    s.done = s.done || str(u.state) === 'DONE'
    if (s.type === 'agent_response' || s.type === 'user_input') s.text = joinDelta(s.text, str(u.text_delta))
    const ti = obj(u.tool_info)
    if (s.type === 'tool' || ti) s.tool = { name: str(u.tool_name) || str(ti?.name) || s.tool?.name || 'tool', files: ti ? filesOf(ti.parameters) : s.tool?.files || [] }
  }
  const ev = []
  for (const k of order) {
    const s = steps.get(k)
    if (s.type === 'user_input' && s.text.trim()) ev.push({ role: 'user', at, text: s.text.trim() })
    else if (s.type === 'agent_response' && s.text.trim()) ev.push({ role: 'assistant', at, text: s.text.trim() })
    else if (s.tool) ev.push({ role: 'tool', at, tool: { ...s.tool, done: s.done } })
  }
  return ev
}

/** Brain transcript rows (`step_index`, `source`, `type`, `status`, `content`; schema unconfirmed) -> TxEvents. */
export function brainToEvents(rows, at = 0) {
  const ev = []
  for (const r of rows) {
    if (!obj(r)) continue
    const kind = `${str(r.type)} ${str(r.source)}`.toLowerCase()
    const when = Date.parse(r.timestamp || r.created_at || '') || at
    const text = textOf(r.content).trim()
    if (/user/.test(kind)) { if (text) ev.push({ role: 'user', at: when, text }) }
    else if (/tool|command|call/.test(kind)) {
      const t = obj(r.tool_call) || obj(r.toolCall) || obj(r.tool_info) || {}
      ev.push({ role: 'tool', at: when, tool: { name: str(t.name) || str(r.tool_name) || 'tool', files: filesOf(t.parameters || t.args), done: !/active|running|pending/i.test(str(r.status)) } })
    } else if (text && /response|model|agent|assistant|planner/.test(kind)) ev.push({ role: 'assistant', at: when, text })
  }
  return ev
}

/** Rows of either source -> TxEvents. stream-json is recognised by its `event` field. */
export function toEvents(rows, at = 0) {
  const list = Array.isArray(rows) ? rows : []
  return list.some((r) => typeof r?.event === 'string') ? streamToEvents(list, at) : brainToEvents(list, at)
}

/** @param {{ transcriptFile?: string|null }} agent */
export async function readTranscript(agent, { maxBytes = 512 * 1024 } = {}) {
  const file = agent?.transcriptFile
  if (!file) return []
  try {
    const { size, mtimeMs } = await fsp.stat(file)
    const text = size <= maxBytes ? await fsp.readFile(file, 'utf8') : await readTail(file, maxBytes)
    return toEvents(jsonLines(text), mtimeMs)
  } catch { return [] }
}

/** Cheap summary for the scan: first user text, last assistant text, size and mtime. Head and tail only. */
export async function summarize(file, { head = 64 * 1024, tail = 64 * 1024 } = {}) {
  const st = await fsp.stat(file)
  const small = st.size <= head + tail
  const first = toEvents(jsonLines(small ? await fsp.readFile(file, 'utf8') : await readHead(file, head)))
  const last = small ? first : toEvents(jsonLines(await readTail(file, tail)))
  const end = last[last.length - 1] || null
  return {
    prompt: first.find((e) => e.role === 'user')?.text || '',
    lastType: end?.role || null,
    lastText: end?.role === 'assistant' ? end.text : '',
    size: st.size,
    mtime: st.mtimeMs,
  }
}

/** Old name kept for importers: parse a transcript text to TxEvents. */
export const parseTranscript = (text) => ({ header: {}, messages: [], events: toEvents(jsonLines(String(text || ''))) })
