// Stable ordering: rows don't move on activity, newcomers append, nothing reorders under the
// pointer, and Team cards keep their order while urgency changes. Each test mutates its own home.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import { IDS, claudeId, row, prepareHome, startServer, tmpDir, nextPort } from './helpers.mjs'

let s, env
const project = () => path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app')
const t = (ms = 0) => new Date(Date.now() + ms).toISOString()
const append = (id, records) => fs.appendFileSync(path.join(project(), `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
const ids = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => e.dataset.id))
const codexRun = `codex:${IDS.codexRunning}`
const finishCodex = () => {
  const day = path.join(env.AGENTVILLE_CODEX_HOME, 'sessions', '2026', '10', '21')
  const f = fs.readdirSync(day).find((n) => n.includes(IDS.codexRunning))
  fs.appendFileSync(path.join(day, f), JSON.stringify({ type: 'event_msg', timestamp: t(), payload: { type: 'task_complete' } }) + '\n')
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'ordering is the same on mobile; hover is desktop-only')
  env = prepareHome(tmpDir('order'))
  s = await startServer(env, nextPort())
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await page.mouse.move(200, 400) // over the village, not the list
})
test.afterEach(async () => { await s?.stop() })

test('a building agent getting busier does not move; a new agent appends to the end of its section', async ({ page }) => {
  const building = '#list .sec.building .row'
  const before = await ids(page, building)
  expect(before.length).toBeGreaterThan(1)
  // Fresh activity on the API Lead (it used to jump to the top as "most recently active").
  append(IDS.leadBuilding, [{ type: 'assistant', timestamp: t(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'z1', name: 'Read', input: { file_path: 'y' } }] } }])
  await page.waitForTimeout(4500) // two polls
  expect(await ids(page, building)).toEqual(before)
  // A brand-new building agent lands at the end.
  const sid = 'fffffff2-0000-4000-8000-000000000000'
  fs.writeFileSync(path.join(project(), `${sid}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: sid, cwd: '/work/demo-app', uuid: 'u', timestamp: t(), message: { role: 'user', content: 'Newcomer' } }) + '\n'
    + JSON.stringify({ type: 'assistant', timestamp: t(1), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }] } }) + '\n')
  // …and is live (a session file, as the fixture's own live agents have), so it counts as Building.
  fs.writeFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'sessions', `${sid.slice(0, 8)}.json`), JSON.stringify({ pid: 1, sessionId: sid, kind: 'bg' }))
  await expect(page.locator(`${building}[data-id="claude-code:${sid}"]`)).toHaveCount(1, { timeout: 10_000 })
  const after = await ids(page, building)
  expect(after.at(-1)).toBe(`claude-code:${sid}`)
  expect(after.slice(0, -1)).toEqual(before)
})

test('a status change while the pointer is over the list waits until the pointer leaves', async ({ page }) => {
  await expect(page.locator(`#list .sec.building .row[data-id="${codexRun}"]`)).toHaveCount(1)
  await page.locator('#list .sec.waiting h2').hover()
  finishCodex()
  // Contents update in place (it turns amber/stalled) but the row stays in the Building section.
  await expect(row(page, codexRun)).toHaveClass(/b-stalled/, { timeout: 10_000 })
  await expect(page.locator(`#list .sec.building .row[data-id="${codexRun}"]`)).toHaveCount(1)
  // Pointer leaves the panel: the held move applies.
  await page.mouse.move(200, 400)
  await expect(page.locator(`#list .sec.stalled .row[data-id="${codexRun}"]`)).toHaveCount(1)
})

test('Team cards keep their order across polls while urgency changes', async ({ page }) => {
  await page.locator('#btn-full').click()
  await page.locator('#view-team').click()
  await page.mouse.move(5, 5) // the top bar: outside the list
  const cards = '#list .card'
  const firstRow = (sel) => page.locator(sel).evaluateAll((els) => els.map((e) => e.querySelector('.row')?.dataset.id || e.textContent.slice(0, 20)))
  const before = await firstRow(cards)
  expect(before.length).toBeGreaterThan(1)
  finishCodex() // a solo turns stalled
  append(IDS.leadBuilding, [ // the API Lead ends its turn
    { type: 'user', timestamp: t(10), message: { content: 'thanks' } },
    { type: 'assistant', timestamp: t(11), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ])
  await expect(row(page, codexRun)).toHaveClass(/b-stalled/, { timeout: 10_000 })
  await page.waitForTimeout(2500)
  expect(await firstRow(cards)).toEqual(before)
})
