// Resizable panel, the Expand/Dock button, the full-screen Table view and the full-screen Team and
// Status layouts. Shared fixture server, plus one big home for the 2560px screenshots.
import { test, expect, startDocked } from './fixtures.mjs'
import { SHOTS, claudeId, row, clearOverrides, prepareBigHome, startServer, tmpDir, nextPort, inspect } from './helpers.mjs'

const isMobile = (testInfo) => testInfo.project.name === 'mobile'
const trow = (page, id) => page.locator(`#list .trow[data-id="${id}"]`)

test.beforeEach(async ({ page, request }) => {
  await clearOverrides(request)
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await expect(page.locator('#conn')).toHaveText(/Live/)
})

test('splitter resizes the docked panel by drag and keys, persists, and snaps to full past 75%', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'the docked panel is an overlay under 900px; no splitter')
  const panel = page.locator('#panel'), split = page.locator('#splitter'), main = page.locator('#main')
  await expect(split).toHaveAttribute('role', 'separator')
  const w0 = (await panel.boundingBox()).width
  const s = await split.boundingBox()
  await page.mouse.move(s.x + s.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(s.x - 300, 400, { steps: 6 })
  await page.mouse.up()
  const w1 = (await panel.boundingBox()).width
  expect(w1).toBeGreaterThan(w0 + 250)
  await expect(split).toHaveAttribute('aria-valuenow', String(Math.round(w1)))
  await expect(page.locator('#cv')).toHaveCSS('display', 'block') // village still drawn beside it
  // Wider than 600px: rows gain harness + last activity on line 2.
  await expect(page.locator('#list .row .l2').first()).toContainText(/Claude Code|Codex/)
  await split.focus()
  await page.keyboard.press('ArrowRight')
  await expect(split).toHaveAttribute('aria-valuenow', String(Math.round(w1) - 16))
  await page.reload()
  expect(Math.round((await panel.boundingBox()).width)).toBe(Math.round(w1) - 16)
  await page.screenshot({ path: `${SHOTS}/desktop-docked-wide.png` })
  // Drag past 75% of the window: snaps to full-screen, and the docked width is kept for later.
  const s2 = await split.boundingBox()
  await page.mouse.move(s2.x + s2.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(60, 400, { steps: 6 })
  await page.mouse.up()
  await expect(main).toHaveClass(/full/)
  await page.locator('#btn-full').click()
  await expect(main).not.toHaveClass(/full/)
  expect(Math.round((await panel.boundingBox()).width)).toBe(Math.round(w1) - 16)
  // Double-click toggles full-screen too.
  await split.dblclick()
  await expect(main).toHaveClass(/full/)
})

test('the Fleet button follows the server: shown only when /api/agents has a fleet block', async ({ page, request }) => {
  const { fleet } = await (await request.get('/api/agents')).json()
  await expect(page.locator('#btn-fleet')).toBeVisible({ visible: !!fleet })
})

test('Expand / Dock is a labelled button that mentions F', async ({ page }) => {
  const b = page.locator('#btn-full')
  await expect(b).toHaveText(/Expand/)
  await expect(b).toHaveAttribute('title', /\(F\)/)
  await b.click()
  await expect(page.locator('#main')).toHaveClass(/full/)
  await expect(b).toHaveText(/Dock/)
  await expect(page.locator('#view-table')).toHaveAttribute('aria-pressed', 'true')
})

test('Table view: grouped by project, sortable, collapsible by mouse and keys, resting toggle, flat', async ({ page }, testInfo) => {
  await page.locator('#btn-full').click()
  const grid = page.locator('#list .tgrid')
  await expect(grid).toHaveAttribute('role', 'treegrid')
  const projectHead = page.locator('[role="columnheader"]:has([data-key="project"])')
  await expect(projectHead).toHaveCount(0) // grouped: the group header names the project
  const group = page.locator('#list .tgroup[data-group="demo-app"]')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  // Boss → lead → sub nesting inside the project group.
  await expect(trow(page, claudeId('boss'))).toHaveAttribute('aria-level', '2')
  await expect(trow(page, claudeId('leadBuilding'))).toHaveAttribute('aria-level', '3')
  await expect(trow(page, `${claudeId('leadBuilding')}:sub:worker`)).toHaveAttribute('aria-level', '4')
  // Resting agents are behind the toggle.
  await expect(trow(page, claudeId('leadDone'))).toHaveCount(0)
  const toggle = page.locator('[data-act="tresting"]')
  await expect(toggle).toHaveText(/Show resting \(\d+\)/)
  await toggle.click()
  await expect(trow(page, claudeId('leadDone'))).toHaveCount(1)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-full-table.png` })
  // Sort by Agent: aria-sort flips, siblings reorder.
  const agentHead = page.locator('[role="columnheader"]:has([data-key="agent"])')
  await agentHead.locator('button').click()
  await expect(agentHead).toHaveAttribute('aria-sort', 'ascending')
  await agentHead.locator('button').click()
  await expect(agentHead).toHaveAttribute('aria-sort', 'descending')
  // Collapse the group with the mouse, expand it with →, collapse a lead with ←.
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(trow(page, claudeId('boss'))).toHaveCount(0)
  await group.focus()
  await page.keyboard.press('ArrowRight')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  const lead = trow(page, claudeId('leadBuilding'))
  await lead.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(lead).toHaveAttribute('aria-expanded', 'false')
  await expect(trow(page, `${claudeId('leadBuilding')}:sub:worker`)).toHaveCount(0)
  await expect(lead).toBeFocused()
  // Enter opens the existing detail.
  await page.keyboard.press('Enter')
  await expect(page.locator('#drawer .detail h3')).toContainText('API Lead')
  // Beside the list, the inspector is a pane: "← All agents" is gone, ✕ collapses it.
  await expect(page.locator('#drawer .dhead .back')).toBeHidden()
  await page.locator('#drawer [data-act="closedetail"]').click()
  await expect(page.locator('#drawer')).toBeHidden()
  await expect(page.locator('.pbody')).not.toHaveClass(/inspecting/)
  // Flat list: no groups, a plain grid. Search still applies.
  await page.locator('[data-act="tlayout"][data-v="flat"]').click()
  await expect(grid).toHaveAttribute('role', 'grid')
  await expect(projectHead).toHaveCount(1)
  await expect(page.locator('#list .tgroup')).toHaveCount(0)
  await page.locator('#q').fill('lint')
  await expect(trow(page, claudeId('soloError'))).toHaveCount(1)
  await expect(trow(page, claudeId('boss'))).toHaveCount(0)
  // Remembered across reloads.
  await page.reload()
  await expect(page.locator('#view-table')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-act="tlayout"][data-v="flat"]')).toHaveAttribute('aria-pressed', 'true')
})

test('full-screen Team groups cards by project with no "+N resting" links', async ({ page }, testInfo) => {
  await page.locator('#btn-full').click()
  await page.locator('#view-team').click()
  await expect(page.locator('#list .proj .projhead').first()).toBeVisible()
  await expect(page.locator('#list .masonry .card').first()).toBeVisible()
  await expect(page.locator('#list button[data-act="more"]')).toHaveCount(0)
  await expect(page.locator(`#list .card .row[data-id="${claudeId('leadBuilding')}"]`)).toHaveCount(1)
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-full-team-masonry.png` })
  await page.locator('#view-status').click()
  await expect(page.locator('#list .cols .psub').first()).toBeVisible()
})

test('big home at 2560px: Table, Team and Status use the width', async ({ browser }, testInfo) => {
  test.skip(isMobile(testInfo), 'one wide screenshot set is enough')
  const s = await startServer(prepareBigHome(tmpDir('wide'), 160), nextPort())
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } })
  await startDocked(page)
  try {
    await page.goto(s.url)
    await expect(page.locator('#conn')).toHaveText(/Live/)
    await page.locator('#btn-full').click()
    await expect(page.locator('#list .trow:not(.thead)').first()).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/wide-full-table.png` })
    await page.locator('#view-team').click()
    await page.screenshot({ path: `${SHOTS}/wide-full-team.png` })
    await page.locator('#view-status').click()
    await page.screenshot({ path: `${SHOTS}/wide-full-status.png` })
  } finally { await page.close(); await s.stop() }
})

test('hidden agents are findable: "N hidden" button, list with Unhide, and Unhide is primary in detail', async ({ page, request }, testInfo) => {
  // Hide from the detail view: the toast says where to find it again.
  await inspect(page, claudeId('leadCi'))
  await page.locator('#drawer [data-act="hide"]').click()
  await expect(page.locator('#toast')).toContainText('Find it under “1 hidden”')
  await expect(row(page, claudeId('leadCi'))).toHaveCount(0)
  const btn = page.locator('#btn-hidden')
  await expect(btn).toHaveText('1 hidden')
  // Hide the boss too (through the API); the list explains its team stays on screen.
  const boss = claudeId('boss')
  await request.patch(`/api/overrides/${encodeURIComponent(boss)}`, { data: { hidden: true }, headers: { origin: new URL(page.url()).origin } })
  await expect(btn).toHaveText('2 hidden')
  // The button is there in every view, Table included.
  await page.locator('#btn-full').click()
  await expect(btn).toBeVisible()
  await btn.click()
  const pop = page.locator('#pop-hidden')
  await expect(pop.locator('li')).toHaveCount(2)
  await expect(pop.locator('li', { hasText: 'Big Boss' })).toContainText(/Its \d+ team members stay visible without it/)
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-hidden-list.png` })
  await pop.locator(`[data-unhide="${claudeId('leadCi')}"]`).click()
  await expect(pop.locator('li')).toHaveCount(1)
  await expect(btn).toHaveText('1 hidden')
  // A hidden agent's detail leads with Unhide.
  await page.keyboard.press('Escape')
  await page.locator('#btn-filters').click()
  await page.locator('[data-set="hidden"]').check()
  await page.keyboard.press('Escape')
  await page.locator(`#list [data-id="${boss}"]`).first().click()
  await expect(page.locator('#drawer .actions .primary').first()).toHaveText('Unhide')
  await page.locator('#drawer [data-act="unhide"]').click()
  await expect(btn).toBeHidden()
})

test('full screen: clicking empty space closes the inspector and clears the selection; rows, the inspector and drags do not', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'on a phone the inspector covers the whole list, so there is no empty space beside it')
  await page.locator('#btn-full').click() // Table
  const drawer = page.locator('#drawer')
  await page.locator(`#list .trow[data-id="${claudeId('leadCi')}"]`).click()
  await expect(drawer).toBeVisible()
  await expect(page).toHaveURL(/#agent=/)
  const list = await page.locator('#list').boundingBox()
  const empty = { x: list.x + 40, y: list.y + list.height - 30 } // below the last row, left of the drawer
  // A click inside the inspector keeps it open.
  await drawer.locator('.facts').click()
  await expect(drawer).toBeVisible()
  // A row click switches the selection instead of closing.
  await page.locator(`#list .trow[data-id="${claudeId('leadBlocked')}"]`).click()
  await expect(drawer.locator('h3')).toContainText('DB Lead')
  // A drag (e.g. selecting text) across empty space does not close it.
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down()
  await page.mouse.move(empty.x + 120, empty.y - 6, { steps: 4 })
  await page.mouse.up()
  await expect(drawer).toBeVisible()
  // A plain click on nothing closes it and clears #agent=.
  await page.mouse.click(empty.x, empty.y)
  await expect(drawer).toBeHidden()
  await expect(page).not.toHaveURL(/#agent=/)
  await expect(page.locator('#list .trow.cur')).toHaveCount(0)
})

test('full screen: the inspector is a split pane; it never covers the list and the selected row stays visible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'on a phone the inspector is a full-screen sheet')
  const box = (sel) => page.locator(sel).first().boundingBox()
  const apart = (a, b) => a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5
  for (const view of ['table', 'team', 'status']) {
    if (!(await page.locator('#main').getAttribute('class')).includes('full')) await page.locator('#btn-full').click()
    await page.locator(`#view-${view}`).click()
    const sel = view === 'table' ? `#list .trow[data-id="${claudeId('leadCi')}"]` : `#list .row[data-id="${claudeId('leadCi')}"]`
    await page.locator(sel).click()
    await expect(page.locator('#drawer')).toBeVisible()
    await page.waitForTimeout(250) // the 150 ms reflow
    const list = await box('#list'), drawer = await box('#drawer'), row = await box(sel)
    expect(apart(list, drawer), `${view}: inspector overlaps the list`).toBe(true)
    expect(row.x >= list.x - 1 && row.x + row.width <= list.x + list.width + 1, `${view}: row cut off`).toBe(true)
    expect(row.y >= list.y - 1 && row.y + row.height <= list.y + list.height + 1, `${view}: row out of view`).toBe(true)
    if (view === 'table') { // narrower: low-priority columns go first, nothing overlaps
      await expect(page.locator('#list .h-prs')).toBeHidden()
      await expect(page.locator('#list .h-agent')).toBeVisible()
    }
    await page.keyboard.press('Escape') // close the inspector
  }
})
