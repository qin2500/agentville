// Settings → World picker and ?world= (engine v2 only). Headless; no focus-stealing windows.
import { test, expect } from './fixtures.mjs'

const KEY = 'va.world.mod'
const stored = (page) => page.evaluate((k) => localStorage.getItem(k), KEY)
const openSettings = async (page) => { await page.locator('#btn-settings').click(); await expect(page.locator('#pop-settings')).toBeVisible() }

test('classic village: no World picker', async ({ page }) => {
  await page.goto('/?engine=1')
  await openSettings(page)
  await expect(page.locator('#pop-settings [data-set="world"]')).toHaveCount(0)
})

test('engine v2: the picker lists the bundled worlds and the choice persists across reload', async ({ page }) => {
  await page.goto('/?engine=2')
  await openSettings(page)
  const sel = page.locator('#pop-settings [data-set="world"]')
  await expect(sel).toHaveCount(1)
  const ids = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value))
  expect(ids).toContain('agentville.fantasy')
  expect(ids).toContain('agentville.base')
  await expect(sel).toHaveValue('agentville.fantasy')
  await Promise.all([page.waitForNavigation(), sel.selectOption('agentville.base')])
  expect(JSON.parse(await stored(page))).toBe('agentville.base')
  await openSettings(page)
  await expect(page.locator('#pop-settings [data-set="world"]')).toHaveValue('agentville.base')
})

test('?world= wins for the session without writing the setting', async ({ page }) => {
  await page.goto('/?engine=2&world=agentville.base')
  expect(await stored(page)).toBeNull()
  await openSettings(page)
  await expect(page.locator('#pop-settings [data-set="world"]')).toHaveValue('agentville.base')
})

test('an invalid ?world= falls back to the default and the village still draws', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  for (const w of ['Foo', 'a.b.demo', '%3Cscript%3E']) {
    await page.goto(`/?engine=2&world=${w}`)
    await expect(page.locator('#conn')).toHaveText(/Live/)
    await expect(page.locator('#cv')).toHaveAttribute('data-engine', /^(?!empty$).+/)
    await openSettings(page)
    await expect(page.locator('#pop-settings [data-set="world"]')).toHaveValue('agentville.fantasy')
  }
  expect(errors).toEqual([])
})
