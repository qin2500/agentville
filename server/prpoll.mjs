/**
 * Live PR state for the PRs Agentville believes are open. Claude Code's own cache
 * (gh-pr-status-cache.json, see prstatus.mjs) is written rarely, so on its own the dock never
 * sees an open -> merged change. Every interval this asks GitHub once, with ONE batched GraphQL
 * query through the `gh` CLI (no shell, 20 s timeout), and keeps only { state, checks, review }
 * per PR: no titles, no bodies. Results override the cache (see prstatus.annotate).
 * Failures (gh missing, signed out, network, rate limit) log one short line and back off.
 */
import { execFile } from 'node:child_process'
import { prFacts } from './prstatus.mjs'

export const MAX_TARGETS = 60
const MAX_RESULTS = 500
const TIMEOUT_MS = 20_000
const MAX_BACKOFF_MS = 15 * 60_000
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})$/i

export const keyOf = (href) => String(href || '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase()

/** github.com PR URL -> { owner, name, number } or null. */
export function parsePrUrl(href) {
  const m = PR_URL.exec(String(href || '').replace(/[#?].*$/, '').replace(/\/+$/, ''))
  return m ? { owner: m[1], name: m[2], number: Number(m[3]) } : null
}

/** Distinct github PR hrefs (first spelling wins), capped. */
export function pickTargets(hrefs, max = MAX_TARGETS) {
  const seen = new Map()
  for (const h of hrefs) {
    const k = keyOf(h)
    if (k && !seen.has(k) && parsePrUrl(h)) seen.set(k, h)
    if (seen.size >= max) break
  }
  return [...seen.values()]
}

const FIELDS = 'state isDraft reviewDecision additions deletions changedFiles commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{conclusion status} ... on StatusContext{state}}}}}}}'

/** One query, one alias (p0, p1, ...) per PR. */
export function buildQuery(prs) {
  const body = prs.map((p, i) => `p${i}: repository(owner:"${p.owner}", name:"${p.name}"){ pullRequest(number:${p.number}){ ${FIELDS} } }`).join('\n')
  return `query {\n${body}\n}`
}

const OK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])

/** A GraphQL pullRequest node -> prstatus facts, or null. */
export function factsFromNode(pr) {
  if (!pr || typeof pr !== 'object') return null
  const checks = { passed: 0, failed: 0, pending: 0 }
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n !== 'object') continue
    if ('status' in n || 'conclusion' in n) {
      if (n.status && n.status !== 'COMPLETED') checks.pending++
      else if (OK_CONCLUSIONS.has(n.conclusion)) checks.passed++
      else if (n.conclusion) checks.failed++
      else checks.pending++
    } else if (n.state) {
      if (n.state === 'SUCCESS') checks.passed++
      else if (PENDING_STATES.has(n.state)) checks.pending++
      else checks.failed++
    }
  }
  const state = pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state
  return prFacts({ state, checks, review: pr.reviewDecision, size: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles } })
}

/** Whole `gh api graphql` response + the PRs asked about -> Map(key -> facts). */
export function mapResponse(resp, prs) {
  const out = new Map()
  const data = resp?.data
  if (!data || typeof data !== 'object') return out
  prs.forEach((p, i) => {
    const f = factsFromNode(data[`p${i}`]?.pullRequest)
    if (f) out.set(keyOf(`https://github.com/${p.owner}/${p.name}/pull/${p.number}`), f)
  })
  return out
}

/** The real runner: `gh api graphql -f query=...`, no shell. Resolves to the parsed JSON. */
export function ghRunner(query) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', 'graphql', '-f', `query=${query}`], { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout) => {
      if (err) return reject(err)
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('bad json')) }
    })
  })
}

const why = (e) => (e?.code === 'ENOENT' ? 'gh not found' : e?.killed ? 'timed out' : e?.message === 'bad json' ? 'unreadable reply' : 'gh failed (signed out, offline or rate limited?)')

/**
 * targets: () => hrefs believed open. run: (query) => Promise<parsed response> (inject a fake in tests).
 * intervalMs 0 = never polls on its own (poll() still works).
 */
export function createPrPoll({ targets, run = ghRunner, intervalMs = 120_000, log = (m) => console.warn(m), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let results = new Map()
  let delay = intervalMs
  let timer = null
  let stopped = true

  /** One poll. Returns how many PRs were refreshed, or -1 on failure. Never throws. */
  async function poll() {
    let list
    try { list = pickTargets(targets() || []).map(parsePrUrl) } catch { return 0 }
    if (!list.length) return 0
    try {
      const got = mapResponse(await run(buildQuery(list)), list)
      for (const [k, f] of got) { results.delete(k); results.set(k, f) }
      while (results.size > MAX_RESULTS) results.delete(results.keys().next().value)
      delay = intervalMs
      return got.size
    } catch (e) {
      delay = Math.min(Math.max(delay, intervalMs) * 2, MAX_BACKOFF_MS)
      log(`pr poll: ${why(e)}; retrying in ${Math.round(delay / 1000)}s`)
      return -1
    }
  }

  function schedule(ms) {
    if (stopped) return
    timer = setTimer(async () => { await poll(); schedule(delay) }, ms)
    timer?.unref?.()
  }
  function start(firstMs = 5000) {
    if (!intervalMs || !stopped) return
    stopped = false
    schedule(firstMs)
  }
  function stop() { stopped = true; if (timer) clearTimer(timer); timer = null }

  return { poll, start, stop, get: (href) => results.get(keyOf(href)), size: () => results.size, delay: () => delay }
}
