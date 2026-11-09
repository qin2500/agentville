/** `overrides.json`: the user's corrections. Written only here, atomically, one write at a time. */
import fsp from 'node:fs/promises'
import path from 'node:path'

// Object keys that would reach the prototype instead of an own property.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

const FIELDS = {
  role: (v) => ['boss', 'lead', 'sub', 'solo'].includes(v),
  parentId: (v) => typeof v === 'string' && v.length <= 300, // '' = force top-level
  name: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80,
  hidden: (v) => typeof v === 'boolean',
  // Important: Restore after crash brings it back (with the crown agents). Keyed, like every
  // override, by agent id: a job's id is its first session id, which a respawn keeps.
  important: (v) => v === true,
}

export function createStore(dir) {
  const file = path.join(dir, 'overrides.json')
  let data = null
  let queue = Promise.resolve()

  async function load() {
    if (data) return data
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { data = {} }
    return data
  }

  /** Validates, merges (null clears a field), persists. Throws `{ status, message }` on bad input. */
  function patch(id, body) {
    if (typeof id !== 'string' || !id || id.length > 300 || RESERVED.has(id)) throw Object.assign(new Error('Invalid id'), { status: 400 })
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Body must be a JSON object'), { status: 400 })
    for (const [k, v] of Object.entries(body)) {
      if (!(k in FIELDS)) throw Object.assign(new Error(`Unknown field: ${k}`), { status: 400 })
      if (v !== null && !FIELDS[k](v)) throw Object.assign(new Error(`Invalid ${k}`), { status: 400 })
    }
    if (body.parentId === id) throw Object.assign(new Error('An agent cannot be its own parent'), { status: 400 })
    const run = queue.then(async () => {
      const all = await load()
      const next = { ...all[id] }
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete next[k]
        else next[k] = k === 'name' ? v.trim() : v
      }
      const updated = { ...all }
      if (Object.keys(next).length) updated[id] = next
      else delete updated[id]
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
