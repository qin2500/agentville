/**
 * Handoff note: a pure extraction from a normalized transcript (TxEvent[], newest last) and the
 * working folder's changes. No LLM call: the old agent is out of usage and can't write its own note.
 *
 *   buildNote(events, changes, meta) -> markdown string
 *   notePrompt(note, max)            -> the prompt the new agent starts with (<= max characters)
 *
 * meta (all optional): { name, id, provider, transcriptPath, interrupted:{tool}, questions:string[],
 *   subagents:[{description}], children:[{name?, oldId, newId}] }
 * changes: the `readChanges(cwd)` shape ({ files:[{path,add,del,untracked}] }) or null.
 */

const USER_MAX = 600
const ASSISTANT_MAX = 800
const ASSISTANT_KEEP = 3
const FILE_TOOLS = /^(edit|write|multiedit|notebookedit|replace|write_file|edit_file|apply_patch)$/i

const cut = (s, n) => {
  const t = String(s ?? '').trim()
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…` : t
}

const list = (v) => (Array.isArray(v) ? v : [])

/** The latest todo list in the transcript (the last event that carries one). */
function lastTodos(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.todo
    if (Array.isArray(t) && t.length) return t
  }
  return []
}

/** Files named by Edit/Write-style tool calls, plus every file of any tool when the tool name is unknown. */
function toolFiles(events) {
  const out = new Set()
  for (const e of events) {
    const t = e?.tool
    if (t && FILE_TOOLS.test(String(t.name || ''))) for (const f of list(t.files)) if (typeof f === 'string' && f) out.add(f)
  }
  return out
}

function mergedFiles(events, changes) {
  const rows = new Map()
  for (const f of list(changes?.files)) {
    if (!f?.path) continue
    const stat = f.untracked ? 'new' : f.binary ? 'binary' : `+${f.add ?? 0} -${f.del ?? 0}`
    rows.set(f.path, stat)
  }
  for (const p of toolFiles(events)) if (!rows.has(p)) rows.set(p, 'edited')
  return [...rows].sort((a, b) => a[0].localeCompare(b[0]))
}

function bullets(items) {
  return items.map((s) => `- ${s}`).join('\n')
}

export function buildNote(events, changes, meta = {}) {
  const ev = list(events).filter(Boolean)
  const m = meta || {}
  const out = []
  const from = [m.name, m.id && `id ${m.id}`].filter(Boolean).join(', ')
  out.push(`# Handoff${from ? ` from ${from}` : ''}`)
  out.push(`The previous agent${m.provider ? ` (${m.provider})` : ''} ran out of usage. You are taking over its work in this folder. Continue; do not start over.`)

  // Task
  const prompts = ev.filter((e) => e.role === 'user' && e.text && e.text.trim()).map((e) => cut(e.text, USER_MAX))
  out.push('## Task')
  if (!prompts.length) out.push('(no user prompt found in the transcript)')
  else {
    out.push(prompts[0])
    if (prompts.length > 1) out.push(`Later instructions from the user:\n${bullets(prompts.slice(1))}`)
  }

  // Done
  const todos = lastTodos(ev)
  const doneTodos = todos.filter((t) => t.done).map((t) => cut(t.text, 200))
  const texts = ev.filter((e) => e.role === 'assistant' && e.text && e.text.trim()).slice(-ASSISTANT_KEEP).map((e) => cut(e.text, ASSISTANT_MAX))
  out.push('## Done')
  if (doneTodos.length) out.push(`Completed todo items:\n${bullets(doneTodos)}`)
  if (texts.length) out.push(`Last things the agent said:\n${bullets(texts.map((t) => t.replace(/\n+/g, '\n  ')))}`)
  if (!doneTodos.length && !texts.length) out.push('(nothing recorded)')

  // Changed files
  const files = mergedFiles(ev, changes)
  out.push('## Changed files')
  out.push(files.length ? bullets(files.map(([p, s]) => `${p} (${s})`)) : '(none found)')

  // Last state
  out.push('## Last state')
  const lastAssistant = [...ev].reverse().find((e) => e.role === 'assistant' && e.text && e.text.trim())
  const lastTool = [...ev].reverse().find((e) => e.tool)
  const state = []
  if (lastAssistant) state.push(`Last message: ${cut(lastAssistant.text, ASSISTANT_MAX)}`)
  if (lastTool) state.push(`Last tool: ${lastTool.tool.name}${list(lastTool.tool.files).length ? ` on ${list(lastTool.tool.files).slice(0, 3).join(', ')}` : ''}${lastTool.tool.done ? '' : ' (not finished)'}`)
  out.push(state.length ? bullets(state) : '(unknown)')

  // Left
  const left = []
  for (const t of todos.filter((x) => !x.done)) left.push(`TODO: ${cut(t.text, 200)}`)
  if (m.interrupted?.tool) left.push(`A \`${m.interrupted.tool}\` call was still running when you took over; check its effect before redoing it.`)
  for (const q of list(m.questions)) left.push(`Open question: ${cut(q, 400)}`)
  for (const s of list(m.subagents)) left.push(`Subagent still running when the lead stopped (re-run if needed): ${cut(s?.description ?? s, 200)}`)
  for (const c of list(m.children)) left.push(`Child job${c.name ? ` "${c.name}"` : ''}: old id ${c.oldId} is now ${c.newId}`)
  out.push('## Left')
  out.push(left.length ? bullets(left) : '(nothing listed; check the last state above)')

  // Pointers
  if (m.transcriptPath || m.name || m.id) {
    out.push('## Pointers')
    const p = []
    if (m.transcriptPath) p.push(`Old transcript (read-only): ${m.transcriptPath}`)
    if (m.name) p.push(`Old agent name: ${m.name}`)
    if (m.id) p.push(`Old agent id: ${m.id}`)
    out.push(bullets(p))
  }
  return `${out.join('\n\n')}\n`
}

const PREAMBLE = 'You are continuing work another agent started; it ran out of usage. Below is its handoff note. Verify the current state of the files before acting, then finish what is left.'

/** Fixed preamble plus the note, cut to `max - 500` (room for the path line and the caller's wrapping). */
export function notePrompt(note, max, { notePath } = {}) {
  const budget = Math.max(0, (Number(max) || 0) - 500)
  const pointer = notePath ? `\n\nThe full note is at: ${notePath}` : ''
  const head = `${PREAMBLE}${pointer}\n\n`
  const body = String(note ?? '')
  const room = Math.max(0, budget - head.length)
  const cutBody = body.length > room ? `${body.slice(0, Math.max(0, room - 40)).trimEnd()}\n\n[note cut; read the full note file]` : body
  return head + cutBody
}
