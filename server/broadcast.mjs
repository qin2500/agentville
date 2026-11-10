/**
 * Message agents: one message the user wrote, sent to many live Claude sessions at once (README
 * "Message agents"). The page picks the recipients (its filters are web/src/broadcast-match.js); the
 * server re-checks each one, binds a one-time confirm token to that exact set and text, and fans the
 * message out over the inspector's path (inbox.mjs: one peer-message frame each, receipt = msg_id).
 *
 * Logs carry ids, counts and outcomes only, never the text.
 */
import { readTail } from './fsutil.mjs'
import { RECEIPT_MS } from './inbox.mjs'

/** At most this many recipients in one broadcast. */
export const MAX_RECIPIENTS = 50
/** Broadcasts a minute (separate from the inspector's 10 single messages a minute). */
export const PER_MINUTE = 3
/** Sockets written at once. Receipts are watched for all of them together, not one slot each. */
export const CONCURRENCY = 4
/** Same limit as the inspector's message. */
export const TEXT_MAX = 8000
export const SELF_WHY = 'This is the session Agentville is running in.'

/** The dashboard's own Claude session, if it was started from one ('claude-code:<sid>' or null). */
export function selfId(env = process.env) {
  const sid = env.AGENTVILLE_SELF_SESSION || env.CLAUDE_CODE_SESSION_ID || ''
  return /^[0-9a-f-]{36}$/i.test(sid) ? `claude-code:${sid}` : null
}

/** '' when `text` is a message we can send; otherwise why not. */
export function textProblem(text) {
  if (typeof text !== 'string' || !text.trim()) return "The message can't be empty."
  if (text.length > TEXT_MAX) return `The message can be at most ${TEXT_MAX} characters.`
  if (/cross-session-message/i.test(text)) return 'The message may not contain a cross-session-message tag.'
  return ''
}

/** A clean, sorted, de-duplicated id list, or a { error } the API returns as a 400. */
export function recipientIds(ids) {
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string' && i.length <= 200)) return { error: 'ids must be a list of agent ids' }
  const out = [...new Set(ids)].sort()
  if (!out.length) return { error: 'Pick at least one agent.' }
  if (out.length > MAX_RECIPIENTS) return { error: `A broadcast can go to at most ${MAX_RECIPIENTS} agents; this one has ${out.length}. Narrow the filters or untick some.` }
  return { ids: out }
}

export const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const receiptIn = async ({ file, msgId }) => !!file && (await readTail(file, 256 * 1024).catch(() => '')).includes(`"msg_id":"${msgId}"`)

/**
 * Send to every id with at most `concurrency` sockets in flight. `send(id)` resolves
 * { ok:true, msgId, file } | { ok:false, detail } | { skipped:true, detail }. `emit` gets each
 * recipient's progress: 'sent' (written, receipt pending) then one final 'delivered' |
 * 'sent-unconfirmed' | 'failed' | 'skipped'. Resolves the final results in `ids` order.
 */
export async function fanOut(ids, { send, emit = () => {}, concurrency = CONCURRENCY, receiptMs = RECEIPT_MS, pollMs = 400, seen = receiptIn } = {}) {
  const final = new Map()
  const waiting = []
  let next = 0
  let writing = 0
  const settle = (id, r) => { final.set(id, r); emit({ id, ...r }) }
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]
      let r
      try { r = await send(id) } catch { r = { ok: false, detail: "Couldn't reach the session" } }
      if (r?.skipped) settle(id, { status: 'skipped', detail: r.detail })
      else if (!r?.ok) settle(id, { status: 'failed', detail: r?.detail || "Couldn't reach the session" })
      else {
        waiting.push({ id, msgId: r.msgId, file: r.file, deadline: Date.now() + receiptMs })
        emit({ id, status: 'sent' })
      }
    }
  }
  const watch = async () => {
    while (writing || waiting.length) {
      for (const w of [...waiting]) {
        const got = await seen(w).catch(() => false)
        if (got || Date.now() > w.deadline) {
          waiting.splice(waiting.indexOf(w), 1)
          settle(w.id, got ? { status: 'delivered', at: Date.now() } : { status: 'sent-unconfirmed', detail: `Not confirmed within ${Math.round(receiptMs / 1000)} s` })
        }
      }
      if (writing || waiting.length) await sleep(pollMs)
    }
  }
  writing = 1
  const watcher = watch()
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker))
  writing = 0
  await watcher
  return ids.map((id) => ({ id, ...final.get(id) }))
}

/** "Delivered to 12 of 14" plus the other outcomes, for the log and the sheet. */
export function summarize(results) {
  const n = (s) => results.filter((r) => r.status === s).length
  return { total: results.length, delivered: n('delivered'), sent: n('sent-unconfirmed'), failed: n('failed'), skipped: n('skipped') }
}
