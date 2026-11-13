import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildQuery, createPrPoll, factsFromNode, mapResponse, parsePrUrl, pickTargets } from '../server/prpoll.mjs'
import { createPrStatus } from '../server/prstatus.mjs'

const url = (n, repo = 'acme/app') => `https://github.com/${repo}/pull/${n}`
const node = (state, extra = {}, contexts = []) => ({
  state, isDraft: false, reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] }, ...extra,
})

test('factsFromNode maps state, checks and review', () => {
  const f = factsFromNode(node('OPEN', { reviewDecision: 'CHANGES_REQUESTED' }, [
    { status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' },
    { status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS', conclusion: null },
    { state: 'SUCCESS' }, { state: 'PENDING' }, { state: 'ERROR' },
  ]))
  assert.deepEqual(f, { state: 'open', checks: { passed: 3, failed: 2, pending: 2 }, review: 'changes' })
  assert.equal(factsFromNode(node('OPEN', { isDraft: true })).state, 'draft')
  assert.equal(factsFromNode(node('MERGED', { reviewDecision: 'APPROVED' })).review, 'approved')
  assert.equal(factsFromNode(node('CLOSED')).state, 'closed')
  assert.equal(factsFromNode(null), null)
  assert.equal(factsFromNode({ state: 'WEIRD' }), null)
  assert.deepEqual(factsFromNode({ state: 'MERGED' }).checks, { passed: 0, failed: 0, pending: 0 })
})

test('targets: github PR urls only, deduped, capped', () => {
  const t = pickTargets([url(1), url(1) + '#x', 'https://gitlab.com/a/b/pull/2', 'https://github.com/a/b/issues/3', url(2)])
  assert.deepEqual(t, [url(1), url(2)])
  assert.equal(pickTargets(Array.from({ length: 100 }, (_, i) => url(i + 1))).length, 60)
  assert.equal(parsePrUrl('https://github.com/a"b/c/pull/1'), null)
})

test('mapResponse tolerates missing PRs', () => {
  const prs = [url(1), url(2)].map(parsePrUrl)
  const m = mapResponse({ data: { p0: { pullRequest: node('MERGED') }, p1: { pullRequest: null } }, errors: [{}] }, prs)
  assert.deepEqual([...m.keys()], [url(1)])
  assert.match(buildQuery(prs), /p1: repository\(owner:"acme", name:"app"\)\{ pullRequest\(number:2\)/)
})

test('poll refreshes results and overrides the cache; failures back off and keep results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpoll-'))
  fs.writeFileSync(path.join(dir, 'gh-pr-status-cache.json'), JSON.stringify({ [url(1)]: { state: 'OPEN', checks: { passed: 1 } }, [url(2)]: { state: 'OPEN' } }))
  let mode = 'ok'; const asked = []; const logs = []
  const run = async (q) => {
    asked.push(q)
    if (mode === 'fail') throw Object.assign(new Error('x'), { code: 'ENOENT' })
    return { data: { p0: { pullRequest: node('MERGED') } } }
  }
  const poll = createPrPoll({ targets: () => [url(1)], run, intervalMs: 1000, log: (m) => logs.push(m) })
  assert.equal(await poll.poll(), 1)
  assert.equal(asked.length, 1)
  const status = createPrStatus(() => dir, poll)
  const agents = [{ prs: [{ href: url(1) }, { href: url(2) }] }]
  await status.annotate(agents)
  assert.equal(agents[0].prs[0].state, 'merged') // poll wins over the cache
  assert.equal(agents[0].prs[1].state, 'open') // not polled: cache stands

  mode = 'fail'
  assert.equal(await poll.poll(), -1)
  assert.equal(poll.delay(), 2000)
  await poll.poll(); await poll.poll()
  assert.equal(poll.delay(), 8000)
  for (let i = 0; i < 12; i++) await poll.poll()
  assert.equal(poll.delay(), 15 * 60_000)
  assert.equal(poll.get(url(1)).state, 'merged') // last good result kept
  assert.ok(logs.length && logs.every((l) => l.length < 100 && !/token/i.test(l)))
  mode = 'ok'; await poll.poll()
  assert.equal(poll.delay(), 1000)
})

test('no targets: nothing is asked; interval 0 never schedules', async () => {
  let called = 0
  const poll = createPrPoll({ targets: () => [], run: async () => { called++ }, intervalMs: 0 })
  assert.equal(await poll.poll(), 0)
  poll.start()
  assert.equal(called, 0)
})

test('size: query asks for it, facts carry it, missing size is omitted', () => {
  assert.match(buildQuery([parsePrUrl(url(1))]), /additions deletions changedFiles/)
  const f = factsFromNode(node('OPEN', { additions: 120, deletions: 7, changedFiles: 4 }))
  assert.deepEqual(f.size, { additions: 120, deletions: 7, files: 4 })
  assert.equal('size' in factsFromNode(node('OPEN')), false)
})
