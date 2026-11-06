// "Open in <terminal>": the server runs the agent's resume command in a new terminal window. In e2e
// the terminal is the fake recorder (SAFE_ENV → test/fixtures/bin/kitty), which logs and runs nothing.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import { HOME, claudeId, row, clearOverrides, inspect } from './helpers.mjs'

const LOG = path.join(HOME, 'terminal.log')
const opened = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0)

test.beforeEach(async ({ page, request }) => {
  await clearOverrides(request)
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await expect(page.locator('#conn')).toHaveText(/Live/)
})

/** Pretend node-pty didn't load: the inspector then offers "Open in <terminal>" instead. */
const noBuiltIn = (page) => page.route('**/api/agents', async (r) => {
  const res = await r.fetch(), j = await res.json()
  await r.fulfill({ response: res, json: { ...j, term: { ...j.term, available: false } } })
})

test('detail: with the built-in terminal there is no "Open in …" (Pop out lives in the terminal); without it, "Open in …" opens through the server', async ({ page }) => {
  const { open, term } = await (await page.request.get('/api/agents')).json()
  expect(open.terminal).toBe('kitty') // the fake, never a real terminal
  expect(term.available).toBe(true)
  await inspect(page, claudeId('leadBuilding'))
  await expect(page.locator('#drawer [data-act="term"]')).toHaveClass(/primary/)
  await expect(page.locator('#drawer [data-act="open"]')).toHaveCount(0)
  await expect(page.locator('#drawer .opennote')).toHaveCount(0)
  await noBuiltIn(page)
  await page.reload()
  await inspect(page, claudeId('leadBuilding'))
  const btn = page.locator('#drawer [data-act="open"]')
  await expect(btn).toHaveText('Open in Kitty')
  await expect(page.locator('#drawer [data-act="term"]')).toHaveCount(0)
  await expect(page.locator('#drawer [data-act="copyresume"]')).toHaveText('Copy attach command') // a background job: its claude attach command
  const before = opened()
  await btn.click()
  await expect(page.locator('#toast')).toContainText('Opened API Lead in Kitty')
  expect(opened()).toBe(before + 1)
})

test('agents that cannot be opened show the server\'s reason instead', async ({ page }) => {
  await inspect(page, claudeId('soloTurn')) // a live interactive session
  await expect(page.locator('#drawer [data-act="term"]')).toBeDisabled()
  await expect(page.locator('#openwhy')).toHaveText('Already running in another terminal')
  await page.locator('[data-act="back"]').click()
  await inspect(page, `${claudeId('leadBuilding')}:sub:worker`)
  await expect(page.locator('#openwhy')).toHaveText('Open its lead instead')
  await expect(page.locator(`#list [data-open="${claudeId('leadBuilding')}:sub:worker"]`)).toHaveCount(0) // no row button either
})

test('rows: a compact open button on hover, and O opens the selected agent', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'hover is a desktop affordance')
  const before = opened()
  const li = page.locator(`#list li:has(> .row[data-id="${claudeId('leadCi')}"])`)
  await li.hover()
  await expect(li.locator('.openbtn')).toBeVisible()
  await li.locator('.openbtn').click()
  await expect(page.locator('#toast')).toContainText('Opened CI Lead in Kitty')
  await page.keyboard.press('Escape')
  await row(page, claudeId('soloError')).click() // Fix lint: not live, so it can be opened
  await page.keyboard.press('o')
  await expect(page.locator('#toast')).toContainText('Opened Fix lint in Kitty')
  expect(opened()).toBe(before + 2)
})

test('a failed open shows the server\'s message inline and is never retried', async ({ page }) => {
  const msg = 'macOS denied Automation access to Ghostty. Allow it in System Settings > Privacy & Security > Automation, then try again.'
  let calls = 0
  await page.route('**/api/open/**', (r) => { calls++; r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: msg }) }) })
  await noBuiltIn(page)
  await page.reload()
  await inspect(page, claudeId('leadBuilding'))
  const btn = page.locator('#drawer [data-act="open"]')
  await btn.click()
  await expect(page.locator('#drawer .act-err')).toHaveText(msg)
  await expect(btn).toHaveText('Open in Kitty') // back from "Opening…", enabled again for a manual retry
  await expect(btn).toBeEnabled()
  await page.waitForTimeout(500)
  expect(calls).toBe(1)
})
