import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHome, IDS } from './fixtures/make-home.mjs'
import { scan as scanClaude } from '../server/claude-code.mjs'
import { scan as scanCodex } from '../server/codex.mjs'
import { build } from '../server/classify.mjs'
import { createProjectStore } from '../server/projects.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-projects-'))
Object.assign(process.env, makeHome(root))
const dataDir = path.join(root, 'data')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const agents = async () => build([...(await scanClaude()), ...(await scanCodex())])
const PR = (n) => `https://github.com/example/demo-app/pull/${n}`

test('projects: PRs from working and resting agents, live only while a working live agent holds it', async () => {
  const list = await agents()
  const projects = await createProjectStore(dataDir).update(list)
  const demo = projects.find((p) => p.name === 'demo-app')
  const byHref = Object.fromEntries(demo.prs.map((p) => [p.href, p]))
  assert.deepEqual([byHref[PR(101)].id, byHref[PR(101)].live, byHref[PR(101)].agentIds], ['101', true, [`claude-code:${IDS.leadBuilding}`]])
  assert.deepEqual([byHref[PR(99)].live, byHref[PR(99)].agentIds], [false, [`claude-code:${IDS.leadDone}`]], 'a resting agent\'s PR is a finished building')
  const here = list.filter((a) => a.project === 'demo-app')
  assert.equal(demo.agentsEver, here.length)
  assert.ok(demo.transcriptBytes > 0)
  assert.equal(demo.transcriptBytes, here.reduce((n, a) => n + a.sizeBytes, 0))
  assert.ok(projects.some((p) => p.name === 'codex-app'))
  assert.ok(Number.isFinite(demo.firstSeenAt) && demo.firstSeenAt <= Date.now())
})

test('the registry outlives the agents: PRs and agentsEver persist after their files are gone', async () => {
  const file = path.join(dataDir, 'projects.json')
  const before = fs.statSync(file).mtimeMs
  const store = createProjectStore(dataDir) // a fresh process
  let projects = await store.update([])
  const demo = projects.find((p) => p.name === 'demo-app')
  assert.deepEqual(demo.prs.map((p) => [p.id, p.live, p.agentIds.length]).sort(), [['101', false, 0], ['99', false, 0]])
  assert.ok(demo.agentsEver > 0)
  assert.equal(demo.transcriptBytes, 0)
  assert.equal(fs.statSync(file).mtimeMs, before, 'nothing new, nothing written')
  // A new PR is appended, never replacing old ones.
  projects = await store.update([{ id: 'x', project: 'demo-app', prs: [{ id: '7', href: PR(7) }], live: true, bucket: 'building', lastActivityAt: Date.now() }])
  assert.deepEqual(projects.find((p) => p.name === 'demo-app').prs.map((p) => p.id).sort(), ['101', '7', '99'])
  assert.equal(projects.find((p) => p.name === 'demo-app').prs.find((p) => p.id === '7').live, true)
})

test('reserved project names never reach the registry', async () => {
  const projects = await createProjectStore(path.join(root, 'd2')).update([{ id: 'y', project: '__proto__', prs: [] }])
  assert.deepEqual(projects, [])
})

test('live = working live agent, among its last 2 PRs, first seen within 72 h', async () => {
  const dir = path.join(root, 'd3')
  const store = createProjectStore(dir)
  const now = Date.now()
  const agent = { id: 'boss', project: 'p', live: true, bucket: 'building', lastActivityAt: now, prs: [1, 2, 3].map((n) => ({ id: String(n), href: PR(n) })) }
  let prs = (await store.update([agent], now))[0].prs
  assert.deepEqual(prs.map((p) => [p.id, p.live]), [['1', false], ['2', true], ['3', true]], 'only the last two')
  prs = (await store.update([{ ...agent, bucket: 'resting' }], now))[0].prs
  assert.ok(prs.every((p) => !p.live), 'a resting holder means finished')
  prs = (await store.update([agent], now + 73 * 3600e3))[0].prs
  assert.ok(prs.every((p) => !p.live), 'older than 72 h means finished')
})
