/** `tasks.json`: the follow-up Tasks list. Every top-level agent becomes a task until the user checks it off; ideas have no agent. */
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const DAY = 86400000
const SEED_MS = 3 * DAY
const KEEP_DONE_MS = 30 * DAY
const KEYS = ['done', 'reopen', 'rename', 'delete', 'agentId']
const bad = (m) => Object.assign(new Error(m), { status: 400 })
const missing = () => Object.assign(new Error('Unknown task'), { status: 404 })
const str = (v) => typeof v === 'string' && v ? v.slice(0, 300) : undefined
const validId = (id) => typeof id === 'string' && id && id.length <= 300 && !RESERVED.has(id)

export function createTasks(dir) {
  const file = path.join(dir, 'tasks.json')
  let data = null
  let queue = Promise.resolve()

  async function load() {
    if (data) return data
    try {
      const p = JSON.parse(await fsp.readFile(file, 'utf8'))
      const items = {}
      if (p && typeof p.items === 'object' && p.items && !Array.isArray(p.items)) {
        for (const [id, e] of Object.entries(p.items)) if (validId(id) && e && typeof e === 'object') items[id] = e
      }
      data = { installedAt: Number.isFinite(p?.installedAt) ? p.installedAt : 0, items }
    } catch { data = { installedAt: 0, items: {} } }
    return data
  }

  async function write(next) {
    await fsp.mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
    await fsp.rename(tmp, file)
    data = next
  }

  const serial = (fn) => {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }

  const topLevel = (a) => a && a.id && !a.parentId && !a.hidden && a.role !== 'sub'

  /** Adds new top-level agents, refreshes name/title, prunes old done entries. Writes only on change. */
  function sync(agents, now = Date.now()) {
    return serial(async () => {
      const cur = await load()
      let changed = false
      const installedAt = cur.installedAt || now
      if (!cur.installedAt) changed = true
      const items = { ...cur.items }
      for (const a of agents || []) {
        if (!topLevel(a) || !validId(a.id)) continue
        const e = items[a.id]
        if (!e) {
          if ((a.lastActivityAt || 0) > installedAt - SEED_MS) {
            items[a.id] = { kind: 'agent', agentId: a.id, name: str(a.name), title: str(a.title), addedAt: now }
            changed = true
          }
        } else if (e.kind === 'agent' && (e.name !== str(a.name) || e.title !== str(a.title))) {
          items[a.id] = { ...e, name: str(a.name), title: str(a.title) }
          changed = true
        }
      }
      for (const [id, e] of Object.entries(items)) {
        if (e.doneAt && now - e.doneAt > KEEP_DONE_MS) { delete items[id]; changed = true }
      }
      if (changed) await write({ installedAt, items })
      return data
    })
  }

  function patch(id, body, now = Date.now()) {
    if (!validId(id)) throw bad('Invalid id')
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object')
    for (const [k, v] of Object.entries(body)) {
      if (!KEYS.includes(k)) throw bad(`Unknown field: ${k}`)
      if (k === 'rename') {
        if (v !== null && !(typeof v === 'string' && v.length >= 1 && v.length <= 120)) throw bad('Invalid rename')
      } else if (k === 'agentId') {
        if (typeof v !== 'string' || !validId(v)) throw bad('Invalid agentId')
      } else if (v !== true) throw bad(`Invalid ${k}`)
    }
    return serial(async () => {
      const cur = await load()
      const e = Object.hasOwn(cur.items, id) ? cur.items[id] : null
      if (!e) throw missing()
      if ((body.delete || body.agentId) && e.kind !== 'idea') throw bad('Only ideas can be deleted or linked')
      if (body.delete) {
        const items = { ...cur.items }
        delete items[id]
        await write({ ...cur, items })
        return { id, ...e }
      }
      const next = { ...e }
      if (body.done) next.doneAt = now
      if (body.reopen) delete next.doneAt
      if ('rename' in body) { if (body.rename === null) delete next.rename; else next.rename = body.rename }
      if (body.agentId) next.agentId = body.agentId
      await write({ ...cur, items: { ...cur.items, [id]: next } })
      return { id, ...next }
    })
  }

  function addIdea(text, now = Date.now()) {
    const t = typeof text === 'string' ? text.trim() : ''
    if (!t || t.length > 300) throw bad('Idea text must be 1 to 300 characters')
    return serial(async () => {
      const cur = await load()
      const id = `idea-${crypto.randomBytes(6).toString('hex')}`
      const entry = { kind: 'idea', text: t, addedAt: now }
      await write({ ...cur, installedAt: cur.installedAt || now, items: { ...cur.items, [id]: entry } })
      return { id, ...entry }
    })
  }

  /** Stores an AI-written short name on an existing agent entry. Returns the entry or null. */
  function setAiName(id, name) {
    const n = typeof name === 'string' ? name.trim() : ''
    if (!validId(id) || n.length < 1 || n.length > 60) return Promise.resolve(null)
    return serial(async () => {
      const cur = await load()
      const e = Object.hasOwn(cur.items, id) ? cur.items[id] : null
      if (!e || e.kind !== 'agent') return null
      const next = { ...e, aiName: n }
      await write({ ...cur, items: { ...cur.items, [id]: next } })
      return { id, ...next }
    })
  }

  return { load, sync, patch, addIdea, setAiName }
}
