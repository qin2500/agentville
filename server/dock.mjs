/**
 * The dock: open PRs load, merged PRs sail. Fed from the agents' annotated `prs[]` (see prstatus.mjs).
 * No network, no titles: only hrefs, ids, repo, agent id/name, state, checks, review and times.
 * Persists `<dataDir>/dock.json` (merged hrefs, recent sails, first-seen-open times), written
 * atomically at 0o600 and only when something changed.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeAtomic } from './accounts.mjs'

const DAY = 24 * 60 * 60 * 1000
const MAX_SAILED = 12
const MAX_MERGED = 5000
const MAX_OPEN = 500
const THRESHOLDS = [5, 20, 50, 100]

const key = (href) => String(href || '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()
const repoOf = (href) => /^https?:\/\/github\.com\/([^/]+\/[^/]+)\//i.exec(String(href || ''))?.[1] || ''
const num = (v) => (Number.isFinite(v) ? v : 0)

export function createDock({ dataDir, now = Date.now }) {
  const file = path.join(dataDir, 'dock.json')
  let loaded = false
  let merged = [] // oldest first; hrefs (normalised)
  let mergedSet = new Set()
  let open = new Map() // href -> since
  let sailed = [] // newest first
  let writing = Promise.resolve()

  async function load() {
    loaded = true
    try {
      const d = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (Array.isArray(d.merged)) merged = d.merged.filter((h) => typeof h === 'string').slice(-MAX_MERGED)
      mergedSet = new Set(merged)
      if (d.open && typeof d.open === 'object') for (const [h, t] of Object.entries(d.open)) if (Number.isFinite(t)) open.set(h, t)
      if (Array.isArray(d.sailed)) {
        sailed = d.sailed.filter((s) => s && typeof s.href === 'string' && Number.isFinite(s.at))
      }
    } catch { /* missing or half-written: start fresh */ }
  }

  function save() {
    const text = JSON.stringify({ merged, open: Object.fromEntries(open), sailed }) + '\n'
    writing = writing
      .then(async () => {
        await fsp.mkdir(dataDir, { recursive: true })
        await writeAtomic(file, text, 0o600)
      })
      .catch(() => {})
    return writing
  }

  async function update(agents) {
    if (!loaded) await load()
    const t = num(now())
    const before = JSON.stringify([merged, [...open], sailed])
    const loadingByHref = new Map()
    const seen = new Set()

    for (const a of agents || []) {
      for (const p of a?.prs || []) {
        const href = key(p?.href)
        if (!href) continue
        if (p.state === 'open') {
          seen.add(href)
          if (!open.has(href)) open.set(href, t)
          if (!loadingByHref.has(href)) {
            loadingByHref.set(href, {
              href: p.href, id: p.id ?? null, repo: repoOf(p.href), agentId: a.id ?? null, agentName: a.name ?? null,
              state: 'open', checks: p.checks || { passed: 0, failed: 0, pending: 0 }, review: p.review ?? null, since: open.get(href),
            })
          }
        } else if (p.state === 'merged') {
          if (!mergedSet.has(href)) {
            mergedSet.add(href)
            merged.push(href)
            if (open.has(href)) sailed.unshift({ href: p.href, id: p.id ?? null, repo: repoOf(p.href), agentId: a.id ?? null, agentName: a.name ?? null, at: t })
          }
          open.delete(href)
          seen.add(href)
        } else if (p.state) {
          open.delete(href) // draft or closed: no longer loading
          seen.add(href)
        }
      }
    }
    if (merged.length > MAX_MERGED) { merged = merged.slice(-MAX_MERGED); mergedSet = new Set(merged) }
    if (open.size > MAX_OPEN) open = new Map([...open].sort((x, y) => y[1] - x[1]).slice(0, MAX_OPEN))
    sailed = sailed.filter((s) => t - s.at <= DAY).sort((x, y) => y.at - x.at).slice(0, MAX_SAILED)

    if (JSON.stringify([merged, [...open], sailed]) !== before) await save()

    const total = mergedSet.size
    return {
      loading: [...loadingByHref.values()].sort((x, y) => x.since - y.since),
      sailed: sailed.map(({ href, id, repo, agentId, agentName, at }) => ({ href, id, repo, agentId, agentName, at })),
      total,
      level: 1 + THRESHOLDS.filter((n) => total >= n).length,
    }
  }

  return { update }
}
