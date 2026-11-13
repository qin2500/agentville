/**
 * PR state, CI checks and review, from the cache Claude Code keeps in
 * `<claude home>/gh-pr-status-cache.json` (keyed by PR URL). Read-only; never asks GitHub.
 * Re-read only when the file changes. Only fixed fields are kept: no titles, no bodies.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const STATES = { OPEN: 'open', DRAFT: 'draft', MERGED: 'merged', CLOSED: 'closed' }
const REVIEWS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' }
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const MAX_BYTES = 16 * 1024 * 1024

/** One cache entry -> `{ state, checks: { passed, failed, pending }, review }`, or null. */
export function prFacts(v) {
  if (!v || typeof v !== 'object') return null
  const state = STATES[String(v.state || '').toUpperCase()] || null
  if (!state) return null
  const c = v.checks && typeof v.checks === 'object' ? v.checks : {}
  const out = {
    state,
    checks: { passed: count(c.passed), failed: count(c.failed), pending: count(c.pending) },
    review: REVIEWS[String(v.review || '').toUpperCase()] || null,
  }
  const z = v.size
  if (z && typeof z === 'object' && [z.additions, z.deletions, z.files].every((n) => Number.isFinite(n) && n >= 0)) {
    out.size = { additions: count(z.additions), deletions: count(z.deletions), files: count(z.files) }
  }
  return out
}

const key = (href) => String(href || '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()

/** `live` (optional): { get(href) } from prpoll.mjs; its facts are fresher than the cache and win. */
export function createPrStatus(claudeHome, live = null) {
  let stamp = ''
  let byUrl = new Map()
  async function load() {
    const file = path.join(claudeHome(), 'gh-pr-status-cache.json')
    const st = await fsp.stat(file).catch(() => null)
    if (!st || st.size > MAX_BYTES) { stamp = ''; byUrl = new Map(); return byUrl }
    const s = `${file}:${st.mtimeMs}:${st.size}`
    if (s === stamp) return byUrl
    try {
      const d = JSON.parse(await fsp.readFile(file, 'utf8'))
      const next = new Map()
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        for (const [url, v] of Object.entries(d)) { const f = prFacts(v); if (f) next.set(key(url), f) }
      }
      byUrl = next
      stamp = s
    } catch { /* half-written: keep the last good read */ }
    return byUrl
  }
  /** Adds state/checks/review to each agent's PR chips that the cache knows. */
  async function annotate(agents) {
    const m = await load()
    if (!m.size && !live?.size?.()) return
    for (const a of agents) if (a.prs?.length) a.prs = a.prs.map((p) => ({ ...p, ...m.get(key(p.href)), ...live?.get(p.href) }))
  }
  return { load, annotate }
}
