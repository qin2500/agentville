/** Agent notifications: `notifications.json` (agent id -> { message, title, at, count }), written atomically. */
import fsp from 'node:fs/promises'
import path from 'node:path'

export const MAX_MESSAGE = 500
export const MAX_TITLE = 80
export const MAX_AGENTS = 200
export const KEEP_GONE_MS = 7 * 24 * 60 * 60 * 1000
export const PER_MINUTE = 30
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

/** Remove control characters, trim. */
export const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()

/** Validates a notify body. Returns { session, message, title } or throws { status, message }. */
export function parseNotify(body) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 })
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object')
  if (typeof body.session !== 'string' || !body.session.trim() || body.session.length > 300) throw bad('session is required')
  if (typeof body.message !== 'string') throw bad('message is required')
  const message = clean(body.message)
  if (!message || message.length > MAX_MESSAGE) throw bad(`message must be 1-${MAX_MESSAGE} characters`)
  let title = ''
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== 'string') throw bad('title must be text')
    title = clean(body.title)
    if (title.length > MAX_TITLE) throw bad(`title must be at most ${MAX_TITLE} characters`)
  }
  return { session: body.session.trim(), message, title }
}

/**
 * Resolve a session or thread id to an Agentville agent id. Accepts the agent id itself
 * (`claude-code:<sid>`, `codex:<thread>`, `<parent>:sub:<n>`), a bare Claude Code session id or
 * Codex thread id, or a session a job was reopened/forked from (`forkSid(id)`). null if none.
 */
export function resolveSession(session, agents, forkSid = () => null) {
  const ids = new Set(agents.map((a) => a.id))
  for (const cand of [session, `claude-code:${session}`, `codex:${session}`]) if (ids.has(cand)) return cand
  for (const a of agents) if (forkSid(a.id) === session) return a.id
  return null
}

export function createNotifications(dir, { now = () => Date.now() } = {}) {
  const file = path.join(dir, 'notifications.json')
  let data = null
  let queue = Promise.resolve()
  const hits = new Map() // agent id -> recent notify times

  async function load() {
    if (data) return data
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { data = {} }
    return data
  }

  const save = async (next) => {
    await fsp.mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    await fsp.rename(tmp, file)
    data = next
  }
  const serial = (fn) => { const run = queue.then(fn); queue = run.catch(() => {}); return run }

  /** True (and counted) while under PER_MINUTE for this agent. */
  function allow(id) {
    const t = now()
    const list = (hits.get(id) || []).filter((x) => t - x < 60_000)
    if (list.length >= PER_MINUTE) { hits.set(id, list); return false }
    list.push(t)
    hits.set(id, list)
    return true
  }

  function add(id, { message, title }) {
    if (RESERVED.has(id)) throw Object.assign(new Error('Invalid id'), { status: 400 })
    return serial(async () => {
      const all = await load()
      const prev = all[id]
      const notice = { message, title, at: now(), count: (prev?.count || 0) + 1 }
      const next = { ...all, [id]: notice }
      const keys = Object.keys(next)
      if (keys.length > MAX_AGENTS) { // drop the oldest notices beyond the cap
        keys.sort((a, b) => next[a].at - next[b].at)
        for (const k of keys.slice(0, keys.length - MAX_AGENTS)) delete next[k]
      }
      await save(next)
      return notice
    })
  }

  function clear(id) {
    return serial(async () => {
      const all = await load()
      if (!Object.hasOwn(all, id)) return false
      const next = { ...all }
      delete next[id]
      await save(next)
      return true
    })
  }

  /** Drop notices of agents that are gone and older than 7 days. Returns whether anything changed. */
  function prune(liveIds) {
    return serial(async () => {
      const all = await load()
      const t = now()
      const next = Object.fromEntries(Object.entries(all).filter(([id, n]) => liveIds.has(id) || t - (n.at || 0) < KEEP_GONE_MS))
      if (Object.keys(next).length === Object.keys(all).length) return false
      await save(next)
      return true
    })
  }

  return { load, add, clear, prune, allow }
}
