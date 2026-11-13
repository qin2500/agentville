/** `loops.json`: per agent id, when the user last looked, marked it Done, and a snooze time. No conversation text. */
import fsp from 'node:fs/promises'
import path from 'node:path'

const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const DAY = 86400000
const KEEP_MS = 14 * DAY
const MAX_SNOOZE_MS = 30 * DAY
const KEYS = ['seen', 'done', 'snoozeUntil', 'reopen']
const bad = (m) => Object.assign(new Error(m), { status: 400 })

const newest = (e) => Math.max(0, e.seenAt || 0, e.doneAt || 0, e.snoozeUntil || 0)
function prune(all, now) {
  const out = {}
  for (const [id, e] of Object.entries(all)) {
    if (RESERVED.has(id) || !e || typeof e !== 'object') continue
    if (now - newest(e) <= KEEP_MS) out[id] = e
  }
  return out
}

export function createLoops(dir) {
  const file = path.join(dir, 'loops.json')
  let data = null
  let queue = Promise.resolve()

  async function load() {
    if (data) return data
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? prune(parsed, Date.now()) : {}
    } catch { data = {} }
    return data
  }

  /** Validates, merges, prunes, persists. Throws `{ status: 400 }` on bad input. Returns the updated entry. */
  function patch(id, body, now = Date.now()) {
    if (typeof id !== 'string' || !id || id.length > 300 || RESERVED.has(id)) throw bad('Invalid id')
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object')
    for (const [k, v] of Object.entries(body)) {
      if (!KEYS.includes(k)) throw bad(`Unknown field: ${k}`)
      if (k === 'snoozeUntil') {
        if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v > now && v < now + MAX_SNOOZE_MS)) throw bad('Invalid snoozeUntil')
      } else if (v !== true) throw bad(`Invalid ${k}`)
    }
    const run = queue.then(async () => {
      const all = await load()
      const next = { ...all[id] }
      if (body.seen) next.seenAt = now
      if (body.done) { next.doneAt = now; next.seenAt = now; delete next.snoozeUntil }
      if ('snoozeUntil' in body) {
        if (body.snoozeUntil === null) delete next.snoozeUntil
        else next.snoozeUntil = body.snoozeUntil
      }
      if (body.reopen) delete next.doneAt
      const updated = prune({ ...all, [id]: next }, now)
      await fsp.mkdir(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(updated, null, 2) + '\n')
      await fsp.rename(tmp, file)
      data = updated
      return next
    })
    queue = run.catch(() => {})
    return run
  }

  return { load, patch }
}
