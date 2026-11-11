/**
 * Per-project history for the world view: PR buildings, agents ever seen, transcript bytes.
 *
 * Scans only see agents whose files are still on disk, so what must outlive them (PRs, agent ids,
 * first-seen time) goes into `projects.json` in our data dir: append-only, written only when
 * something new appears. Inputs are agent fields we already have; no transcript is read here.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
/** "Being worked on": one of a working agent's last LIVE_LAST PRs, first seen within LIVE_MS. */
const LIVE_LAST = 2
const LIVE_MS = 72 * 60 * 60 * 1000

export function createProjectStore(dir) {
  const file = path.join(dir, 'projects.json')
  let data = null // { [project]: { firstSeenAt, agentIds: [], prs: { [href]: { id, firstSeenAt } } } }
  let queue = Promise.resolve()

  async function load() {
    if (data) return data
    try {
      const d = JSON.parse(await fsp.readFile(file, 'utf8'))
      data = d && typeof d === 'object' && !Array.isArray(d) ? d : {}
    } catch { data = {} }
    return data
  }

  /**
   * Fold this scan's agents into the registry; returns the `projects` payload. `removed`: ids dropped
   * for being quiet too long; they are not counted, and a project left with only those is not listed.
   */
  async function update(agents, now = Date.now(), removed = new Set()) {
    const reg = await load()
    let changed = false
    for (const a of agents) {
      const name = a.project || 'unknown'
      if (RESERVED.has(name)) continue
      if (!Object.hasOwn(reg, name)) { reg[name] = { firstSeenAt: now, agentIds: [], prs: {} }; changed = true }
      const p = reg[name]
      // An agent's own last activity predates our first scan of it; the earliest one wins.
      const born = a.lastActivityAt || now
      if (born < p.firstSeenAt) { p.firstSeenAt = born; changed = true }
      if (!p.agentIds.includes(a.id)) { p.agentIds.push(a.id); changed = true }
      for (const pr of a.prs || []) {
        if (!pr?.href || p.prs[pr.href]) continue
        p.prs[pr.href] = { id: pr.id, firstSeenAt: now }
        changed = true
      }
    }
    if (changed) {
      const snapshot = JSON.stringify(reg) + '\n'
      queue = queue.then(async () => {
        await fsp.mkdir(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await fsp.writeFile(tmp, snapshot)
        await fsp.rename(tmp, file)
      }).catch((e) => console.error(`projects.json not saved: ${e.message}`))
      await queue
    }

    const byProject = new Map()
    for (const a of agents) {
      const name = a.project || 'unknown'
      if (!byProject.has(name)) byProject.set(name, [])
      byProject.get(name).push(a)
    }
    const gone = (name) => !byProject.has(name) && reg[name].agentIds.some((id) => removed.has(id))
    return Object.keys(reg).sort().filter((name) => !gone(name)).map((name) => {
      const here = byProject.get(name) || []
      const p = reg[name]
      return {
        name,
        prs: Object.entries(p.prs).map(([href, pr]) => {
          const holders = here.filter((a) => (a.prs || []).some((x) => x.href === href))
          return {
            id: pr.id,
            href,
            firstSeenAt: pr.firstSeenAt,
            agentIds: holders.map((a) => a.id),
            // Scaffolding only while it is current work: a working, live agent lists it among its
            // latest PRs (scheduler children are appended in order) and it is recent. Else finished.
            live: now - pr.firstSeenAt < LIVE_MS && holders.some((a) => a.live && a.bucket !== 'resting' &&
              (a.prs || []).slice(-LIVE_LAST).some((x) => x.href === href)),
          }
        }).sort((x, y) => x.firstSeenAt - y.firstSeenAt || x.href.localeCompare(y.href)),
        agentsEver: p.agentIds.filter((id) => !removed.has(id)).length,
        transcriptBytes: here.reduce((n, a) => n + (a.sizeBytes || 0), 0),
        firstSeenAt: p.firstSeenAt,
      }
    })
  }

  return { update }
}
