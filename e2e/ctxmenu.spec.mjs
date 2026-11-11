// The agent menu (ctxmenu.js), which replaced the inspector: right-click an agent in the village,
// Status, Team (docked and wide), Tree and the terminal header; the keyboard, long-press and "⋯"
// paths; the header (name, status, project/role/harness, PR chips); each action reaching its
// endpoint or confirm step; and names no longer squeezed by PR chips.
import { test, expect } from './fixtures.mjs'
import { claudeId, row, clearOverrides, openMenu, menuItem, villagerAt, IDS, teamView } from './helpers.mjs'

const SHOT = '/tmp/vshots'
const API = claudeId('leadBuilding') // API Lead: building, PR #101 (open, 1 check failing)
const DB = claudeId('leadBlocked') // DB Lead: stalled, a background job
const WORKER = `${API}:sub:worker`
const isMobile = (ti) => ti.project.name === 'mobile'
const m = (page) => page.locator('#ctxmenu')
const inViewport = async (page) => {
  const b = await m(page).boundingBox(), v = page.viewportSize()
  return b.x >= 0 && b.y >= 0 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5
}

test.beforeEach(async ({ page, request }) => {
  await clearOverrides(request)
  await page.goto('/?debug')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/?debug')
  await expect(page.locator('#conn')).toHaveText(/Live/)
})

test('no inspector anywhere: no drawer, no detail pane, no PR chips beside names', async ({ page }) => {
  await expect(page.locator('#drawer, .drawer, .detail')).toHaveCount(0)
  await row(page, API).click()
  await expect(page.locator('#drawer, .drawer, .detail')).toHaveCount(0)
  // The row's name has the room: no "#101" chip next to it, and it isn't clipped.
  await expect(row(page, API).locator('.nm .chip:not(.chg)')).toHaveCount(0)
  const name = row(page, API).locator('.nm > span').first()
  await expect(name).toHaveText('API Lead')
  expect(await name.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
  // The PR is still found by search.
  await page.locator('#q').fill('#101')
  await expect(row(page, API)).toBeVisible()
})

test('right-click a Status row: the header, then the actions in order', async ({ page }, ti) => {
  const menu = await openMenu(page, API)
  await expect(menu.locator('.cm-name')).toHaveText('API Lead')
  await expect(menu.locator('.cm-status .pill')).toContainText('Building')
  await expect(menu.locator('.cm-meta')).toContainText('demo-app · Lead · Claude Code · active')
  // PRs: chips that open externally, like the PR links elsewhere.
  const pr = menu.locator('.cm-prs a.chip')
  await expect(pr).toHaveCount(1)
  await expect(pr).toContainText('#101')
  await expect(pr).toHaveAttribute('href', 'https://github.com/example/demo-app/pull/101')
  await expect(pr).toHaveAttribute('target', '_blank')
  await expect(pr).toHaveClass(/pr-failing/)
  // No conversation text.
  await expect(menu).not.toContainText('Build the API')
  const acts = await menu.locator('.cm-item').evaluateAll((els) => els.map((e) => e.dataset.cm))
  expect(acts).toEqual(['term', 'showvillage', 'copy', 'fork', 'stop', 'important', 'edit', 'hide'])
  await expect(menuItem(page, 'copy')).toHaveText('Copy attach command')
  await expect(menuItem(page, 'stop')).toHaveText('Stop job…')
  await expect(menuItem(page, 'important')).toHaveText('Mark important')
  await expect(menuItem(page, 'hide')).toHaveText('Hide in village')
  expect(await inViewport(page)).toBe(true)
  await page.screenshot({ path: `${SHOT}/ctxmenu-${ti.project.name}-status.png` })
  // Outside click closes it; so does a scroll of the list.
  await page.mouse.click(5, page.viewportSize().height - 5)
  await expect(m(page)).toBeHidden()
  await openMenu(page, API)
  await page.locator('#list').evaluate((l) => l.dispatchEvent(new Event('scroll')))
  await expect(m(page)).toBeHidden()
})

test('a subagent: only what applies, and Open in terminal says why it is off', async ({ page }) => {
  await row(page, API).click() // its lead is selected, so its team shows
  await teamView(page)
  await row(page, WORKER).click({ button: 'right' })
  await expect(m(page).locator('.cm-name')).toHaveText('test-engineer')
  await expect(menuItem(page, 'term')).toHaveAttribute('aria-disabled', 'true')
  await expect(menuItem(page, 'term')).toContainText('Open its lead instead')
  for (const a of ['fork', 'stop', 'important']) await expect(menuItem(page, a)).toHaveCount(0)
  // A disabled item does nothing.
  await menuItem(page, 'term').click()
  await expect(page.locator('#stage')).toBeHidden()
})

test('Team: docked rows and wide cards open the menu', async ({ page }, ti) => {
  await teamView(page)
  await row(page, DB).click({ button: 'right' })
  await expect(m(page).locator('.cm-name')).toHaveText('DB Lead')
  await page.keyboard.press('Escape')
  await expect(m(page)).toBeHidden()
  await page.locator('#btn-full').click()
  await page.locator('#view-team').click()
  const card = page.locator(`#list .card .row[data-id="${API}"]`)
  await card.click({ button: 'right' })
  await expect(m(page).locator('.cm-name')).toHaveText('API Lead')
  expect(await inViewport(page)).toBe(true)
  await page.screenshot({ path: `${SHOT}/ctxmenu-${ti.project.name}-team.png` })
})

test('Tree: right-click a node', async ({ page }) => {
  await page.locator('#btn-full').click()
  await page.locator('#view-tree').click()
  const node = page.locator(`#list .tnode[data-id="${DB}"]`)
  await node.scrollIntoViewIfNeeded()
  await node.click({ button: 'right' })
  await expect(m(page).locator('.cm-name')).toHaveText('DB Lead')
  await expect(page.locator(`#list .tnode[data-id="${DB}"].cm-target`)).toHaveCount(1)
})

test('village: right-click a villager', async ({ page }, ti) => {
  test.skip(isMobile(ti), 'the docked panel covers the village on a phone')
  await page.locator('#cv').focus()
  for (let i = 0; i < 3 && (await page.evaluate(() => window.villageDebug().zoom)) < 2; i++) await page.keyboard.press('+')
  await page.waitForTimeout(400)
  const pt = await villagerAt(page, API)
  expect(pt, 'API Lead is on screen').toBeTruthy()
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  await expect(m(page).locator('.cm-name')).toHaveText('API Lead')
  expect(await inViewport(page)).toBe(true)
  await page.screenshot({ path: `${SHOT}/ctxmenu-desktop-village.png` })
  // Left click still selects (and doesn't open the menu).
  await page.keyboard.press('Escape')
  await page.mouse.click(pt.x, pt.y)
  await expect(row(page, API)).toHaveAttribute('aria-current', 'true')
  await expect(m(page)).toBeHidden()
})

test('keyboard: Shift+F10 and the ContextMenu key on a focused row; arrows, Enter and Esc', async ({ page }) => {
  await row(page, API).focus()
  await page.keyboard.press('Shift+F10')
  await expect(m(page)).toBeVisible()
  await expect(menuItem(page, 'term')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menuItem(page, 'showvillage')).toBeFocused()
  await page.keyboard.press('End')
  await expect(menuItem(page, 'hide')).toBeFocused()
  await page.keyboard.press('ArrowDown') // wraps
  await expect(menuItem(page, 'term')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menuItem(page, 'hide')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(m(page)).toBeHidden()
  await expect(row(page, API)).toBeFocused() // back where it was
  await page.keyboard.press('ContextMenu')
  await expect(m(page)).toBeVisible()
  // Enter runs the focused item: Edit… opens its sheet.
  await page.keyboard.press('e')
  await expect(menuItem(page, 'edit')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#agentsheet')).toBeVisible()
  await expect(page.locator('#agentsheet h2')).toHaveText('Edit API Lead')
  await page.keyboard.press('Escape')
  await expect(page.locator('#agentsheet')).toBeHidden()
  // Enter on the selected row opens it too.
  await row(page, API).focus()
  await page.keyboard.press('Enter')
  await expect(row(page, API)).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('Enter')
  await expect(m(page).locator('.cm-name')).toHaveText('API Lead')
})

test('touch: a long press and the "⋯" button open the menu; a tap still selects', async ({ page }, ti) => {
  const r = row(page, API)
  await r.scrollIntoViewIfNeeded()
  const b = await r.boundingBox()
  const at = { x: b.x + 60, y: b.y + b.height / 2 }
  await r.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: at.x, clientY: at.y, button: 0 })
  await page.waitForTimeout(700)
  await expect(m(page).locator('.cm-name')).toHaveText('API Lead')
  await r.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, clientX: at.x, clientY: at.y, button: 0 })
  expect(await inViewport(page)).toBe(true)
  await page.keyboard.press('Escape')
  // The "⋯" button (always shown on a touch screen).
  const more = page.locator(`#list .menubtn[data-menu="${DB}"]`)
  if (isMobile(ti)) await expect(more).toBeVisible()
  else await row(page, DB).hover()
  await more.click()
  await expect(m(page).locator('.cm-name')).toHaveText('DB Lead')
  if (isMobile(ti)) await page.screenshot({ path: `${SHOT}/ctxmenu-mobile-longpress.png` })
  await page.keyboard.press('Escape')
  // A short tap selects, as before.
  await r.click()
  await expect(r).toHaveAttribute('aria-current', 'true')
  await expect(m(page)).toBeHidden()
})

test('the menu stays inside the viewport near the bottom-right corner', async ({ page }) => {
  await row(page, API).scrollIntoViewIfNeeded()
  await row(page, API).dispatchEvent('contextmenu', { clientX: page.viewportSize().width - 4, clientY: page.viewportSize().height - 4, bubbles: true })
  await expect(m(page)).toBeVisible()
  expect(await inViewport(page)).toBe(true)
})

test('actions reach their endpoints and keep their confirm steps', async ({ page, context, baseURL }, ti) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
  // Copy attach command.
  await openMenu(page, DB)
  await menuItem(page, 'copy').click()
  await expect(page.locator('#toast')).toContainText(`claude attach ${IDS.leadBlocked.slice(0, 8)}`)
  // Fork…: a sheet, the command preview, then nothing runs until Fork.
  await openMenu(page, DB)
  await menuItem(page, 'fork').click()
  const sheet = page.locator('#agentsheet')
  await expect(sheet.locator('h2')).toHaveText('Fork DB Lead')
  const pv = page.waitForRequest((r) => r.url().endsWith('/api/act/preview') && r.postDataJSON().kind === 'fork')
  await sheet.locator('[data-as="review"]').click()
  await pv
  await expect(sheet.locator('#act-cmd')).toContainText('claude')
  await expect(sheet.locator('[data-as="run"]')).toHaveText('Fork')
  await sheet.locator('[data-as="close"]').click()
  await expect(sheet).toBeHidden()
  // Stop job…: the preview first, then the confirm button.
  await openMenu(page, DB)
  const sp = page.waitForRequest((r) => r.url().endsWith('/api/act/preview') && r.postDataJSON().kind === 'stop')
  await menuItem(page, 'stop').click()
  await sp
  await expect(sheet.locator('h2')).toHaveText('Stop DB Lead?')
  await expect(sheet.locator('#act-cmd')).toContainText(IDS.leadBlocked.slice(0, 8))
  await expect(sheet.locator('[data-as="run"]')).toHaveText('Stop job')
  await page.screenshot({ path: `${SHOT}/ctxmenu-${ti.project.name}-stop-confirm.png` })
  await sheet.locator('[data-as="close"]').click()
  // Mark important: PATCH, then the star and "Unmark important".
  await openMenu(page, DB)
  const imp = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/api/overrides/') && r.postDataJSON().important === true)
  await menuItem(page, 'important').click()
  await imp
  await expect(row(page, DB).locator('.star')).toBeVisible()
  await openMenu(page, DB)
  await expect(m(page).locator('.cm-title .star')).toBeVisible()
  await expect(menuItem(page, 'important')).toHaveText('Unmark important')
  await menuItem(page, 'important').click()
  await expect(row(page, DB).locator('.star')).toHaveCount(0)
  // Edit…: the override form; Save sends it.
  await openMenu(page, DB)
  await menuItem(page, 'edit').click()
  await sheet.locator('input[name="name"]').fill('Database Lead')
  const ed = page.waitForRequest((r) => r.method() === 'PATCH' && r.postDataJSON().name === 'Database Lead')
  await sheet.locator('[type="submit"]').click()
  await ed
  await expect(sheet).toBeHidden()
  await expect(row(page, DB).locator('.nm > span').first()).toHaveText('Database Lead')
  // Hide in village: gone from the list, with Undo; shown hidden, "Show in village again" brings it back.
  await openMenu(page, DB)
  await menuItem(page, 'hide').click()
  await expect(row(page, DB)).toHaveCount(0)
  await expect(page.locator('#toast')).toContainText('hidden')
  await page.locator('#btn-filters').click()
  await page.locator('#pop-filters [data-set="hidden"]').check()
  await page.keyboard.press('Escape')
  await openMenu(page, DB)
  await expect(m(page).locator('.htag')).toHaveText('Hidden')
  await menuItem(page, 'unhide').click()
  await expect(row(page, DB)).not.toHaveClass(/is-hidden/)
})

test('Open in terminal and Show in village; the terminal header name has the menu too', async ({ page }, ti) => {
  test.skip(isMobile(ti), 'desktop layout')
  await openMenu(page, DB)
  await menuItem(page, 'showvillage').click()
  await expect(row(page, DB)).toHaveAttribute('aria-current', 'true')
  await openMenu(page, DB)
  await menuItem(page, 'term').click()
  await expect(page.locator('#stage')).toBeVisible()
  await expect(page.locator('#stage .tname')).toHaveText('DB Lead')
  // The stage has the inspector's old room: nothing on its right (once the 150 ms layout move is over).
  await expect(page.locator('#main')).not.toHaveClass(/tv-anim/)
  const st = await page.locator('#stage').boundingBox()
  expect(st.x + st.width).toBeGreaterThan(page.viewportSize().width - 4)
  await page.locator('#stage .tname').click({ button: 'right' })
  await expect(m(page).locator('.cm-name')).toHaveText('DB Lead')
  await expect(menuItem(page, 'term')).toHaveText(/In the terminal/)
  await page.keyboard.press('Escape')
  await page.locator('#stage .tclose').click()
  await expect(page.locator('#stage')).toBeHidden()
  await page.request.delete(`/api/term/${encodeURIComponent(DB)}`, { headers: { origin: new URL(page.url()).origin } })
})
