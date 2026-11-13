/** Names tasks with the built-in helper (Haiku): reads the first real user request from the agent transcript and asks for a short name. */
import fs from 'node:fs'
import readline from 'node:readline'

const MAX_READ = 2 * 1024 * 1024
const MAX_TEXT = 1500
const MAX_PER_PASS = 10
const MAX_TRIES = 3
const BACKOFF_MS = 10 * 60 * 1000
const SYSTEM = 'You name tasks for a to-do list. Reply with only the name: 3 to 8 words, imperative or noun phrase, no quotes, no trailing period.'
// Harness-written user turns (notifications, hand-backs, hook output) are not the user's request.
const SKIP = ['This session is being continued', '<command-', '<local-command', '<system-reminder>', 'Caveat:',
  '<task-notification', '[SYSTEM NOTIFICATION', 'Another Claude session sent', '<agent-message', '<teammate-message',
  '<bash-', '<user-prompt-submit-hook', 'Base directory for this skill', '[Request interrupted']

function usable(raw) {
  const t = String(raw).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!t || SKIP.some((p) => t.startsWith(p))) return ''
  return t
}

/** First real user request (up to ~1500 chars) from a .jsonl transcript, or ''. */
export async function firstRequest(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', end: MAX_READ - 1 })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.includes('"user"')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      if (o?.type !== 'user' || o.isMeta || o.isCompactSummary) continue
      const c = o.message?.content
      let text = ''
      if (typeof c === 'string') text = usable(c)
      else if (Array.isArray(c)) text = c.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => usable(x.text)).filter(Boolean).join('\n')
      if (text) return text.slice(0, MAX_TEXT)
    }
  } catch { /* unreadable */ } finally { rl.close(); stream.destroy() }
  return ''
}

export function cleanName(reply) {
  if (typeof reply !== 'string') return ''
  let s = reply.split('\n').map((l) => l.trim()).find(Boolean) || ''
  s = s.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').replace(/[.。]+$/, '').trim()
  return s.slice(0, 60).trim()
}

export function createTaskNamer({ helper, tasks, transcriptFor, now = Date.now }) {
  const state = new Map() // id -> { tries, after }
  let running = false

  async function nameOne(id) {
    const st = state.get(id) || { tries: 0, after: 0 }
    state.set(id, st)
    st.tries++
    let file = null
    try { file = await transcriptFor(id) } catch { /* none */ }
    const text = file ? await firstRequest(file) : ''
    if (!text) { st.tries = MAX_TRIES; return true }
    try {
      const name = cleanName(await helper.run(text, { system: SYSTEM }))
      if (!name) { st.after = now() + BACKOFF_MS; return true }
      await tasks.setAiName(id, name)
      return true
    } catch (e) {
      if (e?.code === 'disabled') { st.tries--; return false }
      st.after = now() + BACKOFF_MS
      return true
    }
  }

  async function pass() {
    const { items } = await tasks.load()
    const todo = Object.entries(items)
      .filter(([id, e]) => e && e.kind === 'agent' && !e.aiName && (state.get(id)?.tries || 0) < MAX_TRIES && (state.get(id)?.after || 0) <= now())
      .sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0))
      .slice(0, MAX_PER_PASS)
    for (const [id] of todo) if (!(await nameOne(id))) break
  }

  return {
    kick() {
      if (running) return
      running = true
      pass().catch(() => {}).finally(() => { running = false })
    },
    /** Resolves when the current pass ends (for tests). */
    async idle() { while (running) await new Promise((r) => setTimeout(r, 5)) },
  }
}
