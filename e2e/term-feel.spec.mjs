// The terminal's feel: the sizes the PTY hears, repaints after a re-show or re-attach, wheel
// scrolling after leaving and coming back, instant switching, focus on close, copy / paste, find
// and links. The server runs the fake CLI (test/fixtures/bin/claude) in a PTY; its "fullscreen"
// mode does what Claude Code's fullscreen renderer does (alternate screen, SGR mouse tracking, a
// frame redrawn on every SIGWINCH). Every SIGWINCH the fake sees is in its log, so these tests
// assert on the sizes the PTY actually received. Nothing real is ever run.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import { HOME, IDS, claudeId, row, clearOverrides, openMenu } from './helpers.mjs'

const ID = claudeId('leadBlocked') // "DB Lead", a background job → `claude attach <short>`
const OTHER = claudeId('leadCi') // "CI Lead", also a job
const SHORT = IDS.leadBlocked.slice(0, 8)
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const events = () => lines(path.join(HOME, 'claude.log'))
/** Every size the PTY of `short` was given (each SIGWINCH the fake saw), after `since`. */
const winches = (since = 0, short = SHORT) => events().filter((e) => e.event === 'winch' && e.argv.includes(short) && e.at >= since)
const screen = (page) => page.locator('#stage .termhost:not([hidden]) .xterm-rows')
const typeLine = async (page, text) => { await page.keyboard.type(text); await page.keyboard.press('Enter') }
const MIN = { cols: 20, rows: 5 }

test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name === 'mobile', 'desktop layout'))

test.beforeEach(async ({ page, request }) => {
  await clearOverrides(request)
  await page.goto('/?debug')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/?debug')
  await expect(page.locator('#conn')).toHaveText(/Live/)
})
test.afterEach(async ({ request, baseURL }) => {
  for (const id of [ID, OTHER]) await request.delete(`/api/term/${encodeURIComponent(id)}`, { headers: { origin: baseURL } })
})

async function enter(page, name = 'DB Lead') {
  await page.locator('#ctxmenu [data-cm="term"]').click()
  await expect(page.locator('#stage')).toBeVisible()
  await expect(page.locator('#stage .tname')).toHaveText(name)
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await expect(screen(page)).toContainText(/fake-claude>|FULLSCREEN/)
  await expect(page.locator('#main')).not.toHaveClass(/tv-anim/)
}
async function close(page) {
  await page.keyboard.press('Shift+Escape')
  await expect(page.locator('#stage')).toBeHidden()
}
/** Open the agent's terminal from its menu, closing whatever is open first. */
async function reopen(page, id = ID, name = 'DB Lead') {
  if (await page.locator('#stage').isVisible()) await close(page)
  await openMenu(page, id)
  await enter(page, name)
}
const fullscreenLine = (page) => screen(page).locator('div').first()
const dbg = (page) => page.evaluate(() => window.villageTerm())
const termSize = async (page) => (await dbg(page)).size
const visibleText = async (page) => (await dbg(page)).rows.join('\n')
/** Where column `col` of the visible row containing `text` is on screen (the DOM renderer's rows). */
async function cellAt(page, text, offset = 0) {
  const rowsEl = screen(page)
  const { size } = await dbg(page)
  const box = await rowsEl.boundingBox()
  const rows = await rowsEl.locator(':scope > div').allInnerTexts()
  const y = rows.findIndex((r) => r.replace(/\u00a0/g, ' ').includes(text))
  if (y < 0) throw new Error(`"${text}" is not on screen`)
  const col = rows[y].replace(/\u00a0/g, ' ').indexOf(text) + offset
  const cw = box.width / size.cols, ch = box.height / size.rows
  return { x: box.x + (col + 0.5) * cw, y: box.y + (y + 0.5) * ch }
}
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control+Shift'

test('no size below the minimum, and none while hidden, ever reaches the PTY', async ({ page }) => {
  // A slow machine: the layout transition takes many frames, so a narrow mid-transition size
  // would have time to get through (it did: "2x45" reached the PTY before the fix).
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  const t0 = Date.now()
  await openMenu(page, ID)
  await enter(page)
  await typeLine(page, 'fullscreen')
  await expect(screen(page)).toContainText('FULLSCREEN')
  // Fresh terminals (a reload starts from nothing) and kept ones (close and reopen).
  for (let i = 0; i < 2; i++) {
    await page.reload()
    await expect(page.locator('#conn')).toHaveText(/Live/)
    await reopen(page)
    await close(page)
    await reopen(page)
  }
  // The host collapsing (a layout squeeze) or hidden (display: none) while it is showing.
  await page.evaluate(() => { document.querySelector('#stage .termwrap').style.width = '6px' })
  await page.waitForTimeout(400)
  await page.evaluate(() => { document.querySelector('#stage .termwrap').style.width = '' })
  await page.evaluate(() => { document.querySelector('#stage').style.display = 'none' })
  await page.waitForTimeout(400)
  await page.evaluate(() => { document.querySelector('#stage').style.display = '' })
  await page.waitForTimeout(600)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  const seen = winches(t0)
  expect(seen.length).toBeGreaterThan(0)
  for (const w of seen) {
    expect(w.cols, JSON.stringify(seen.map((x) => `${x.cols}x${x.rows}`))).toBeGreaterThanOrEqual(MIN.cols)
    expect(w.rows).toBeGreaterThanOrEqual(MIN.rows)
  }
  // …and the frame on screen is drawn for the size the terminal really has.
  const sz = await termSize(page)
  await expect(fullscreenLine(page)).toContainText(`FULLSCREEN ${sz.cols}x${sz.rows}`)
})

test('the server never passes a size below the minimum to the PTY, whoever sends it', async ({ page, baseURL }) => {
  await openMenu(page, ID)
  await enter(page)
  const sz = await termSize(page)
  await page.waitForTimeout(500) // the opening repaint is done
  const t0 = Date.now()
  // Straight to the socket, as a page with a collapsed host would have.
  const { ticket } = await (await page.request.post(`/api/term/${encodeURIComponent(ID)}`, { headers: { origin: baseURL }, data: {} })).json()
  await page.evaluate(async (ticket) => {
    const ws = new WebSocket(`ws://${location.host}/api/term/ws?ticket=${encodeURIComponent(ticket)}`)
    await new Promise((r) => { ws.onopen = r })
    for (const [cols, rows] of [[2, 45], [19, 30], [80, 4], [0, 0]]) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    await new Promise((r) => setTimeout(r, 300))
    ws.close()
  }, ticket)
  expect(winches(t0)).toEqual([])
  await typeLine(page, 'size')
  await expect(screen(page)).toContainText(`size ${sz.cols}x${sz.rows}`)
})

test('re-attaching and re-showing force a repaint at the real size; the frame is never garbage', async ({ page }) => {
  await openMenu(page, ID)
  await enter(page)
  await typeLine(page, 'fullscreen')
  await expect(screen(page)).toContainText('FULLSCREEN')
  const whole = async () => {
    const sz = await termSize(page)
    await expect(fullscreenLine(page)).toContainText(`FULLSCREEN ${sz.cols}x${sz.rows}`)
    // Every row is a whole row of this width: "row N....|", nothing reflowed into a narrow column.
    const rows = (await dbg(page)).rows
    for (const r of rows.slice(2, sz.rows)) expect(r).toMatch(new RegExp(`^row \\d+\\.*\\|$`))
    for (const r of rows.slice(2, sz.rows)) expect(r.length).toBe(sz.cols)
    return sz
  }
  // Re-attach: a reload is a brand-new terminal on the same PTY (what the app does after a restart).
  await page.reload()
  await expect(page.locator('#conn')).toHaveText(/Live/)
  let t0 = Date.now()
  await reopen(page)
  await expect.poll(() => winches(t0).length).toBeGreaterThanOrEqual(1) // the app was made to redraw
  let sz = await whole()
  await expect.poll(() => winches(t0).at(-1)).toMatchObject(sz)
  // Re-show: close and reopen the kept terminal.
  await close(page)
  t0 = Date.now()
  await reopen(page)
  await expect.poll(() => winches(t0).length).toBeGreaterThanOrEqual(2) // nudged a column and back
  sz = await whole()
  expect(winches(t0).at(-1)).toMatchObject(sz)
  expect(winches(t0).at(-2).cols).toBe(sz.cols - 1)
})

test('wheel scrolling works after leaving and coming back: scrollback, and an app with mouse tracking', async ({ page }) => {
  await openMenu(page, ID)
  await enter(page)
  await typeLine(page, 'flood 150')
  await expect(screen(page)).toContainText('line 150 of 150')
  const xt = page.locator('#stage .termhost:not([hidden]) .xterm-screen')
  const scrollTop = async () => {
    await xt.hover()
    // Each wheel event moves three lines (as in VS Code's terminal: xterm uses its scrollable).
    for (let i = 0; i < 80 && (await dbg(page)).viewportY > 0; i++) await page.mouse.wheel(0, -1000)
    expect((await dbg(page)).viewportY).toBe(0)
    await expect.poll(() => visibleText(page)).toContain('line 1 of 150')
    for (let i = 0; i < 80 && (await dbg(page)).viewportY < (await dbg(page)).baseY; i++) await page.mouse.wheel(0, 1000)
    await expect.poll(async () => { const d = await dbg(page); return d.viewportY === d.baseY }).toBe(true)
  }
  // Left and back (the kept terminal), and reloaded (a fresh terminal from the server's snapshot).
  await close(page)
  await reopen(page)
  await scrollTop()
  await page.reload()
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await reopen(page)
  await expect.poll(async () => (await dbg(page)).baseY).toBeGreaterThan(100) // the scrollback came back
  await scrollTop()

  // Fullscreen (alternate screen + SGR mouse tracking), as Claude Code's renderer: the wheel
  // belongs to the app, as in any terminal. Enough output that the start of the stream (where the
  // modes were set) is long gone from any raw replay, then a fresh terminal attaches.
  await typeLine(page, 'fullscreen')
  await expect(screen(page)).toContainText('FULLSCREEN')
  await typeLine(page, 'noise 320')
  await expect(screen(page)).toContainText('wheel up 0')
  await page.reload()
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await reopen(page)
  await expect.poll(async () => (await dbg(page)).mouse).toBe('vt200') // the app's mouse mode survived
  expect((await dbg(page)).buffer).toBe('alternate')
  await xt.hover()
  await page.mouse.wheel(0, -300)
  await expect(screen(page)).toContainText(/wheel up [1-9]/)
  // …and the same after leaving and coming back.
  await close(page)
  await reopen(page)
  await xt.hover()
  const before = Number((await visibleText(page)).match(/wheel up (\d+)/)[1])
  await page.mouse.wheel(0, -300)
  await expect.poll(async () => Number((await visibleText(page)).match(/wheel up (\d+)/)[1])).toBeGreaterThan(before)
})

test('switching agents and back is instant: same content and scroll position, no reconnect, no resize while hidden', async ({ page }) => {
  await openMenu(page, ID)
  await enter(page)
  await typeLine(page, 'flood 300')
  await expect(screen(page)).toContainText('line 300 of 300')
  await page.locator('#stage .termhost:not([hidden]) .xterm-screen').hover()
  await page.mouse.wheel(0, -900)
  await expect.poll(async () => { const d = await dbg(page); return d.viewportY < d.baseY }).toBe(true)
  await page.waitForTimeout(200)
  const before = await dbg(page)
  await expect(page.locator('#stage .termjump')).toBeVisible()

  // To the other agent.
  await page.evaluate((id) => { location.hash = `#agent=${encodeURIComponent(id)}` }, OTHER) // as a click in the village column does
  await expect(page.locator('#stage .tname')).toHaveText('CI Lead')
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await expect(page.locator('#stage .termjump')).toBeHidden() // CI's own state, not DB's
  const hiddenFrom = Date.now()
  await page.locator('#stage .termhost:not([hidden]) .xterm-screen').click()
  await typeLine(page, 'on the other one')
  await expect(screen(page)).toContainText('echo: on the other one')
  // Resize the window while DB Lead is hidden: only the terminal on screen may hear it.
  const vp = page.viewportSize()
  await page.setViewportSize({ width: vp.width - 120, height: vp.height - 80 })
  await page.waitForTimeout(400)
  await page.setViewportSize(vp)
  await page.waitForTimeout(400)
  expect(winches(hiddenFrom)).toEqual([]) // DB Lead's PTY heard nothing while hidden
  expect(winches(hiddenFrom, IDS.leadCi.slice(0, 8)).length).toBeGreaterThan(0) // CI's did

  // Back: shown at once, as it was, without "Connecting…".
  await page.evaluate(() => {
    window.__statuses = []
    new MutationObserver(() => window.__statuses.push(document.querySelector('#stage .termstatus').textContent))
      .observe(document.querySelector('#stage .termstatus'), { childList: true, characterData: true, subtree: true })
  })
  const back = Date.now()
  await page.evaluate((id) => { location.hash = `#agent=${encodeURIComponent(id)}` }, ID)
  await expect(page.locator('#stage .tname')).toHaveText('DB Lead')
  const after = await dbg(page)
  expect(after.id).toBe(ID)
  expect(after.viewportY).toBe(before.viewportY)
  expect(after.rows).toEqual(before.rows)
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await expect(page.locator('#stage .termjump')).toBeVisible()
  expect(await page.evaluate(() => window.__statuses)).not.toContain('Connecting…')
  expect(after.kept).toEqual(expect.arrayContaining([ID, OTHER]))
  // The re-show repainted it (a nudge and back), and it still takes keys.
  await expect.poll(() => winches(back).length).toBeGreaterThanOrEqual(2)
  await page.locator('#stage .termhost:not([hidden]) .xterm-screen').click()
  await typeLine(page, 'back again')
  await expect(screen(page)).toContainText('echo: back again')
  const live = events().filter((e) => e.argv.includes(SHORT))
  expect(live.filter((e) => e.event === 'start').length - live.filter((e) => e.event === 'exit').length).toBe(1)
})

test('closing gives the keyboard back exactly where it was; reopening restores the terminal as it was', async ({ page }) => {
  // Opened by double-clicking its row: on close the row has the keyboard again.
  await row(page, ID).dblclick()
  await expect(page.locator('#stage')).toBeVisible()
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await typeLine(page, 'flood 120')
  await expect(screen(page)).toContainText('line 120 of 120')
  await page.locator('#stage .termhost:not([hidden]) .xterm-screen').hover()
  await page.mouse.wheel(0, -400)
  await expect.poll(async () => { const d = await dbg(page); return d.viewportY < d.baseY }).toBe(true)
  await page.waitForTimeout(200)
  const before = await dbg(page)
  await close(page)
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-id]')?.dataset.id)).toBe(ID)
  // Opened from the agent menu with the keyboard: the menu is gone, so back to its row.
  await row(page, ID).focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.locator('#ctxmenu [data-cm="term"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#stage')).toBeVisible()
  const again = await dbg(page)
  expect(again.viewportY).toBe(before.viewportY)
  expect(again.rows).toEqual(before.rows)
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#stage .xterm'))).toBe(true)
  await page.keyboard.press('Shift+Escape')
  await expect(page.locator('#stage')).toBeHidden()
  await expect(row(page, ID)).toBeFocused()
})

test('copy a selection, paste (bracketed), find, clear the view and the jump to the latest output', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openMenu(page, ID)
  await enter(page)
  await typeLine(page, 'copytoken')
  await expect(screen(page)).toContainText('echo: copytoken')
  // Double-click selects the word; Cmd-C copies it (and sends the app nothing).
  const at = await cellAt(page, 'echo: copytoken', 'echo: '.length + 2)
  await page.mouse.dblclick(at.x, at.y)
  await page.keyboard.press(`${MOD}+c`)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('copytoken')
  // Paste: the app asked for bracketed paste, so it arrives as one paste, not as typed keys.
  await typeLine(page, 'paste')
  await page.evaluate(() => navigator.clipboard.writeText('two words'))
  await page.locator('#stage .termhost:not([hidden]) .xterm-screen').click()
  await page.keyboard.press(`${MOD}+v`)
  await page.keyboard.press('Enter') // the fake's PTY is line-buffered
  await expect.poll(() => visibleText(page)).toContain('pasted["two words"]')

  // Find: Cmd-F, type, the match is scrolled into view; Esc gives the keyboard back.
  await typeLine(page, 'flood 300')
  await expect(screen(page)).toContainText('line 300 of 300')
  await page.keyboard.press(`${MOD}+f`)
  const input = page.locator('#stage .termfind input')
  await expect(input).toBeFocused()
  await input.fill('line 17 of 300')
  await expect(page.locator('#stage .findcount')).toHaveText('1 of 1')
  await expect.poll(() => visibleText(page)).toContain('line 17 of 300')
  await input.press('Escape')
  await expect(page.locator('#stage .termfind')).toBeHidden()
  await expect(page.locator('#stage')).toBeVisible() // Esc closed find, not the terminal
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#stage .xterm'))).toBe(true)

  // Scrolled up while output arrives: "↓ New output" takes you back down.
  await typeLine(page, 'tick 12')
  await expect(screen(page)).toContainText('tick 1')
  await page.locator('#stage .termhost:not([hidden]) .xterm-screen').hover()
  await page.mouse.wheel(0, -1200)
  await expect(page.locator('#stage .termjump')).toHaveText('↓ New output')
  await page.locator('#stage .termjump').click()
  await expect.poll(async () => { const d = await dbg(page); return d.viewportY === d.baseY }).toBe(true)
  await expect(page.locator('#stage .termjump')).toBeHidden()

  // Cmd-K clears this view only: the scrollback goes, the PTY hears nothing.
  await expect(screen(page)).toContainText('tick 12')
  const n = events().length
  await page.keyboard.press(`${MOD}+k`)
  await expect.poll(async () => (await dbg(page)).baseY).toBe(0)
  await page.waitForTimeout(200)
  expect(events().length).toBe(n)
  await typeLine(page, 'still here')
  await expect(screen(page)).toContainText('echo: still here')
})

test('links: Cmd-click opens them outside the app; a plain click does not', async ({ page }) => {
  await page.addInitScript(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null } })
  await page.reload()
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await openMenu(page, ID)
  await enter(page)
  await typeLine(page, 'https://example.com/docs?x=1')
  await expect(screen(page)).toContainText('echo: https://example.com/docs?x=1')
  const at = await cellAt(page, 'https://example.com/docs?x=1', 4)
  await page.mouse.move(at.x, at.y)
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__opened)).toEqual([])
  await page.mouse.move(at.x + 2, at.y)
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control')
  await page.mouse.click(at.x + 2, at.y)
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control')
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual([['https://example.com/docs?x=1', '_blank', 'noopener,noreferrer']])
})

test('the WebGL renderer (when the page has WebGL) draws the same terminal and takes keys', async ({ page }) => {
  await page.goto('/?debug&webgl')
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await openMenu(page, ID)
  await page.locator('#ctxmenu [data-cm="term"]').click()
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await expect.poll(async () => (await dbg(page)).renderer).toMatch(/webgl|dom/)
  await typeLine(page, 'via webgl')
  await expect.poll(() => visibleText(page)).toContain('echo: via webgl')
})
