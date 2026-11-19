// A pushed notice: teal row, a letter badge on the villager, cleared on open (mocked /api/agents, headless).
import fs from 'node:fs'
import { test, expect } from './fixtures.mjs'
import { claudeId, clearOverrides, row } from './helpers.mjs'
import { engineReady, layoutReady, zoomTo } from './engine-helpers.mjs'

const SHOTS = '/tmp/va-notify'
test.beforeEach(async ({ request }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'docked panel covers the village on a phone')
  fs.mkdirSync(SHOTS, { recursive: true })
  await clearOverrides(request)
})

test('notice row is teal, shows the line, clears on open and keeps the message readable', async ({ page }) => {
  const id = claudeId('leadBlocked')
  const clears = []
  let noticed = true
  await page.route('**/api/notify/clear', (r) => { clears.push(r.request().postData()); noticed = false; r.fulfill({ json: { ok: true } }) })
  await page.route('**/api/agents*', async (route) => {
    const response = await route.fetch(), json = await response.json()
    const a = json.agents.find((x) => x.id === id)
    if (a) a.notice = noticed ? { message: 'Deploy finished\nSee the dashboard', title: 'Deploy finished', at: 1700000000000, count: 2 } : null
    await route.fulfill({ response, json })
  })
  await page.goto('/?engine=2&debug')
  const r = row(page, id)
  await expect(r).toHaveClass(/has-notice/)
  await expect(r.locator('.l2')).toContainText('Deploy finished (×2)')
  expect(await r.evaluate((el) => getComputedStyle(el).borderLeftColor)).toBe('rgb(63, 224, 214)')
  await expect(page).toHaveTitle(/✉ 1/)
  await engineReady(page); await layoutReady(page); await zoomTo(page, 2)
  await page.screenshot({ path: `${SHOTS}/panel-and-village.png` })
  await r.click()
  await expect(r).not.toHaveClass(/has-notice/)
  await expect(r).toHaveClass(/read-notice/)
  await expect(r.locator('.nbody')).toContainText('See the dashboard')
  expect(clears).toHaveLength(1)
  expect(JSON.parse(clears[0])).toEqual({ id })
  await page.screenshot({ path: `${SHOTS}/after-open.png` })
})
