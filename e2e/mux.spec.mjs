// Splits in the terminal view (term.js, mux-model.js): drag an agent from the list onto the terminal,
// Ghostty-style drop zones, nested splits, divider resize, focus, close, and the layout coming back.
// The PTYs run the fake CLI (test/fixtures/bin/claude); nothing real is ever run or opened.
import { test, expect } from './fixtures.mjs'
import { claudeId, row, openMenu, clearOverrides } from './helpers.mjs'

const DB = claudeId('leadBlocked') // "DB Lead", a background job → `claude attach`
const CI = claudeId('leadCi') // "CI Lead", also a job
const ids = [DB, CI]
const mux = (page) => page.evaluate(() => window.villageMux())
const pane = (page, id) => page.locator(`#stage .tpane[data-id="${id}"]`)
const paneScreen = (page, id) => pane(page, id).locator('.xterm-rows')

test.beforeEach(async ({ page, request }) => {
  await clearOverrides(request)
  await page.goto('/?debug')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/?debug')
  await expect(page.locator('#conn')).toHaveText(/Live/)
})
test.afterEach(async ({ request, baseURL }) => {
  for (const id of ids) await request.delete(`/api/term/${encodeURIComponent(id)}`, { headers: { origin: baseURL } })
})

async function enter(page, id, name) {
  await openMenu(page, id)
  await page.locator('#ctxmenu [data-cm="term"]').click()
  await expect(page.locator('#stage .tname')).toHaveText(name)
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await expect(paneScreen(page, id)).toContainText('fake-claude>')
  await expect(page.locator('#main')).not.toHaveClass(/tv-anim/)
}
/** Drag a list row onto a pane, at (fx, fy) as fractions of the pane; returns what the drop zone said. */
async function dragOnto(page, fromId, toId, fx, fy, { drop = true } = {}) {
  const src = await row(page, fromId).boundingBox()
  const dst = await pane(page, toId).boundingBox()
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
  await page.mouse.down()
  await page.mouse.move(src.x + src.width / 2 + 20, src.y + src.height / 2, { steps: 4 })
  await page.mouse.move(dst.x + dst.width * fx, dst.y + dst.height * fy, { steps: 8 })
  await expect(page.locator('#stage .mdrop')).toBeVisible()
  const said = await page.locator('#stage .mdrop').textContent()
  await page.waitForTimeout(150) // it slides between zones
  const zone = await page.locator('#stage .mdrop').boundingBox()
  if (drop) await page.mouse.up()
  return { said, zone, dst }
}

test('drag an agent onto the terminal: Ghostty drop zones, nested splits, resize, focus and close', async ({ page }) => {
  await enter(page, DB, 'DB Lead')
  await expect(page.locator('#stage .mux')).toHaveClass(/\bsingle\b/)
  await expect(pane(page, DB).locator('.tpbar')).toBeHidden() // alone it looks exactly as before
  await expect.poll(async () => { const [p] = (await mux(page)).panes; return p.live && p.pty.cols === p.size.cols }).toBe(true)
  const full = (await mux(page)).panes[0].pty.cols

  // Over the right part of the pane: the right half is lit and says so; dropping splits right.
  const { said, zone, dst } = await dragOnto(page, CI, DB, 0.85, 0.5)
  expect(said).toBe('Split right')
  expect(Math.abs(zone.x - (dst.x + dst.width / 2))).toBeLessThan(4)
  expect(Math.abs(zone.width - dst.width / 2)).toBeLessThan(4)
  await expect(page.locator('#stage .mdrop')).toBeHidden()
  await expect(page.locator('#stage .tpane:not([hidden])')).toHaveCount(2)
  await expect(paneScreen(page, CI)).toContainText('fake-claude>')
  let m = await mux(page)
  expect(m.layout).toEqual({ dir: 'row', ratio: 0.5, a: { id: DB }, b: { id: CI } })
  expect(m.focus).toBe(CI)
  await expect(page.locator('#stage .tname')).toHaveText('CI Lead') // the header follows the focused pane
  await expect(page.locator('#stage .mux')).not.toHaveClass(/\bsingle\b/)
  await expect(pane(page, CI).locator('.tpname')).toHaveText('CI Lead')
  await expect(pane(page, CI)).toHaveClass(/\bfocused\b/)
  // Both panes are live and each PTY has its own pane's size (about half the width each).
  await expect.poll(async () => (await mux(page)).panes.every((p) => p.live && p.pty.cols === p.size.cols)).toBe(true)
  m = await mux(page)
  for (const p of m.panes) expect(p.pty.cols).toBeLessThan(full * 0.6)
  for (const p of m.panes) expect(p.pty.cols).toBeGreaterThan(full * 0.35)

  // Keys go to the focused pane only; a click on the other pane focuses it.
  await page.keyboard.type('to ci')
  await page.keyboard.press('Enter')
  await expect(paneScreen(page, CI)).toContainText('echo: to ci')
  await pane(page, DB).locator('.xterm-screen').click()
  await expect(page.locator('#stage .tname')).toHaveText('DB Lead')
  expect((await mux(page)).focus).toBe(DB)
  await page.keyboard.type('to db')
  await page.keyboard.press('Enter')
  await expect(paneScreen(page, DB)).toContainText('echo: to db')
  await expect(paneScreen(page, CI)).not.toContainText('to db')
  // The selection follows the focus, as switching the terminal always did.
  await expect(row(page, DB)).toHaveAttribute('aria-current', 'true')

  // Onto its own pane: no zone, nothing changes.
  {
    const src = await row(page, CI).boundingBox(), b = await pane(page, CI).boundingBox()
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
    await page.mouse.down()
    await page.mouse.move(src.x + 30, src.y + src.height / 2, { steps: 4 })
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.9, { steps: 8 })
    await expect(page.locator('#stage .mdrop')).toBeHidden()
    await page.mouse.up()
    expect((await mux(page)).layout).toEqual({ dir: 'row', ratio: 0.5, a: { id: DB }, b: { id: CI } })
  }

  // Divider: drag the root divider to about 30%; the left PTY narrows, the right widens.
  const before = await mux(page)
  const div = page.locator('#stage .mdiv[data-path=""]')
  const db = await div.boundingBox(), area = await page.locator('#stage .mux').boundingBox()
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2)
  await page.mouse.down()
  await page.mouse.move(area.x + area.width * 0.3, db.y + db.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await mux(page)).layout.ratio).toBeGreaterThan(0.25)
  expect((await mux(page)).layout.ratio).toBeLessThan(0.35)
  await expect.poll(async () => {
    const p = (await mux(page)).panes
    return p[0].pty.cols < before.panes[0].pty.cols - 10 && p[1].pty.cols > before.panes[1].pty.cols + 10 && p.every((x) => x.pty.cols === x.size.cols)
  }).toBe(true)

  // Nested: the same agent dropped on the bottom of DB's pane moves there (an agent is never in two panes).
  const nest = await dragOnto(page, CI, DB, 0.5, 0.92)
  expect(nest.said).toBe('Split down')
  await expect.poll(async () => (await mux(page)).layout).toEqual({ dir: 'column', ratio: 0.5, a: { id: DB }, b: { id: CI } })
  await expect(page.locator('#stage .tpane:not([hidden])')).toHaveCount(2)
  await expect(paneScreen(page, CI)).toContainText('echo: to ci') // the same live session, moved

  // Keys: ⌘⌥↑ focuses the pane above (Ctrl+Alt elsewhere).
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))
  await page.keyboard.press(mac ? 'Meta+Alt+ArrowUp' : 'Control+Alt+ArrowUp')
  await expect.poll(async () => (await mux(page)).focus).toBe(DB)

  // × closes a pane: its sibling takes the whole area, and keeps (or takes) the focus.
  await pane(page, CI).locator('.tpclose').click()
  await expect(page.locator('#stage .tpane:not([hidden])')).toHaveCount(1)
  m = await mux(page)
  expect(m.layout).toEqual({ id: DB })
  expect(m.focus).toBe(DB)
  await expect(page.locator('#stage .mux')).toHaveClass(/\bsingle\b/)
  await expect.poll(async () => (await mux(page)).panes[0].pty.cols).toBe(full)
  // The closed pane's session keeps running (as Close keeps it).
  expect((await (await page.request.get('/api/agents')).json()).term.running).toContain(CI)
})

test('the layout comes back when the terminal is opened again on one of its agents', async ({ page }) => {
  await enter(page, DB, 'DB Lead')
  await dragOnto(page, CI, DB, 0.5, 0.08) // top
  await expect.poll(async () => (await mux(page)).layout).toEqual({ dir: 'column', ratio: 0.5, a: { id: CI }, b: { id: DB } })
  await expect(paneScreen(page, CI)).toContainText('fake-claude>')
  await page.keyboard.press('Shift+Escape')
  await expect(page.locator('#stage')).toBeHidden()
  // Rows are not draggable outside the terminal view.
  await row(page, CI).hover()
  await page.mouse.down()
  expect(await row(page, CI).getAttribute('draggable')).toBe('false')
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await enter(page, CI, 'CI Lead')
  await expect(page.locator('#stage .tpane:not([hidden])')).toHaveCount(2)
  await expect(paneScreen(page, DB)).toContainText('fake-claude>')
  expect((await mux(page)).focus).toBe(CI)
  // Clicking another agent in the list shows it in the focused pane; one already shown is focused.
  await row(page, DB).click()
  await expect(page.locator('#stage .tname')).toHaveText('DB Lead')
  expect((await mux(page)).layout).toEqual({ dir: 'column', ratio: 0.5, a: { id: CI }, b: { id: DB } })
})
