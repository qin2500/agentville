// Drag a pane by its title bar onto another pane: the two swap, the sessions stay connected (no
// reconnect, so no new PTY attach), scrollback survives. Fake CLI only; headless.
import { test, expect } from './fixtures.mjs'
import { clearStorage, claudeId, row, openMenu, clearOverrides } from './helpers.mjs'
import fs from 'node:fs'

const DB = claudeId('leadBlocked'), CI = claudeId('leadCi')
const SHOTS = '/tmp/va-mux-drag'
const mux = (page) => page.evaluate(() => window.villageMux())
const pane = (page, id) => page.locator(`#stage .tpane[data-id="${id}"]`)
const screen = (page, id) => pane(page, id).locator('.xterm-rows')

test.beforeEach(async ({ page, request }) => {
  await clearOverrides(request)
  await page.addInitScript(() => { // count every terminal socket ever opened
    const W = window.WebSocket; window.__ws = 0
    window.WebSocket = class extends W { constructor(...a) { super(...a); window.__ws++ } }
  })
  await page.goto('/?debug')
  await clearStorage(page)
  await page.goto('/?debug')
  await expect(page.locator('#conn')).toHaveText(/Live/)
})
test.afterEach(async ({ request, baseURL }) => {
  for (const id of [DB, CI]) await request.delete(`/api/term/${encodeURIComponent(id)}`, { headers: { origin: baseURL } })
})

test('dragging a pane by its bar swaps it with another; sessions stay connected', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await openMenu(page, DB)
  await page.locator('#ctxmenu [data-cm="term"]').click()
  await expect(screen(page, DB)).toContainText('fake-claude>')
  // Alone: no drag affordance.
  await expect(pane(page, DB).locator('.tpbar')).toBeHidden()

  // A second pane through the existing list drop.
  const src = await row(page, CI).boundingBox(), dst = await pane(page, DB).boundingBox()
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
  await page.mouse.down()
  await page.mouse.move(src.x + 40, src.y + src.height / 2, { steps: 4 })
  await page.mouse.move(dst.x + dst.width * 0.85, dst.y + dst.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('#stage .tpane:not([hidden])')).toHaveCount(2)
  await expect(screen(page, CI)).toContainText('fake-claude>')
  await page.keyboard.type('hello scroll'); await page.keyboard.press('Enter')
  await expect(screen(page, CI)).toContainText('echo: hello scroll')
  await expect.poll(async () => (await mux(page)).panes.every((p) => p.live && p.pty.cols === p.size.cols)).toBe(true)
  expect((await mux(page)).layout).toMatchObject({ a: { id: DB }, b: { id: CI } })
  const sockets = await page.evaluate(() => window.__ws)
  const bar = pane(page, DB).locator('.tpbar')
  await expect(bar).toHaveCSS('cursor', 'grab')

  const grab = async () => { const b = await bar.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down() }
  const target = async () => { const t = await pane(page, CI).boundingBox(); return { x: t.x + t.width / 2, y: t.y + t.height / 2 } }

  // Esc cancels.
  await grab(); let t = await target()
  await page.mouse.move(t.x, t.y, { steps: 8 })
  await expect(page.locator('#stage .mdrop')).toBeVisible()
  await page.keyboard.press('Escape'); await page.mouse.up()
  expect((await mux(page)).layout).toMatchObject({ a: { id: DB }, b: { id: CI } })
  // Dropping outside the grid cancels.
  await grab(); await page.mouse.move(t.x, t.y, { steps: 6 }); await page.mouse.move(5, 5, { steps: 6 }); await page.mouse.up()
  expect((await mux(page)).layout).toMatchObject({ a: { id: DB }, b: { id: CI } })

  // The real drop, with screenshots mid-drag and after.
  await grab(); t = await target()
  await page.mouse.move(t.x, t.y, { steps: 10 })
  await expect(page.locator('#stage .mdrop')).toHaveAttribute('data-target', CI)
  await page.screenshot({ path: `${SHOTS}/mid-drag.png` })
  await page.mouse.up()
  await expect.poll(async () => (await mux(page)).layout).toMatchObject({ a: { id: CI }, b: { id: DB } })
  await page.screenshot({ path: `${SHOTS}/after-drop.png` })

  // Same sessions: no new socket, still live, scrollback kept, sizes refitted, and typing still works.
  expect(await page.evaluate(() => window.__ws)).toBe(sockets)
  await expect(screen(page, CI)).toContainText('echo: hello scroll')
  await expect.poll(async () => (await mux(page)).panes.every((p) => p.live && p.pty.cols === p.size.cols)).toBe(true)
  await page.keyboard.type('after move'); await page.keyboard.press('Enter')
  await expect(screen(page, (await mux(page)).focus)).toContainText('echo: after move')
})
