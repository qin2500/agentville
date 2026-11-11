// The terminal view. The server runs the fake CLI (test/fixtures/bin/claude: a prompt that echoes
// lines) in a PTY; "Pop out" goes to the fake terminal recorder. Nothing real is ever run.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import { HOME, IDS, claudeId, row, clearOverrides, inspect, prepareHome, startServer, nextPort, tmpDir } from './helpers.mjs'

const ID = claudeId('leadBlocked') // "DB Lead", a background job → `claude attach <short>`
const OTHER = claudeId('leadCi') // "CI Lead", also a job
const SHORT = IDS.leadBlocked.slice(0, 8)
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const windows = () => lines(path.join(HOME, 'terminal.log'))
const claudeEvents = () => lines(path.join(HOME, 'claude.log'))
const screen = (page) => page.locator('#stage .termhost:not([hidden]) .xterm-rows')
const box = async (page, sel) => page.locator(sel).boundingBox()
const running = async (page) => (await (await page.request.get('/api/agents')).json()).term.running

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

async function enter(page, id = ID, name = 'DB Lead') {
  const btn = page.locator('#drawer [data-act="term"]')
  await btn.click()
  await expect(page.locator('#stage')).toBeVisible()
  await expect(page.locator('#stage .tname')).toHaveText(name)
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await expect(screen(page)).toContainText('fake-claude>')
  await expect(page.locator('#main')).not.toHaveClass(/tv-anim/) // the 200 ms layout transition is over
}
const typeLine = async (page, text) => { await page.keyboard.type(text); await page.keyboard.press('Enter') }

test('Terminal takes the centre; the village and inspector compress to the sides; Shift+Esc puts it all back', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop layout')
  await inspect(page, ID)
  await page.waitForTimeout(700) // selecting pans the village; let that finish
  const before = { village: await box(page, '#village'), panel: await box(page, '#panel'), cam: await page.evaluate(() => window.villageDebug().cam) }
  const vp = page.viewportSize()
  await enter(page)
  // Centre and large; the village is a narrow column on the left, the inspector a column on the right.
  const st = await box(page, '#stage'), vil = await box(page, '#village'), pan = await box(page, '#panel')
  expect(st.width).toBeGreaterThan(vp.width * 0.5)
  expect(st.height).toBeGreaterThan(vp.height * 0.85)
  expect(vil.width).toBeGreaterThan(100)
  expect(vil.width).toBeLessThan(before.village.width * 0.5)
  expect(vil.x + vil.width).toBeLessThanOrEqual(st.x + 1)
  expect(pan.x).toBeGreaterThanOrEqual(st.x + st.width - 1)
  await expect(page.locator('#drawer h3')).toContainText('DB Lead')
  await expect(page.locator('#drawer [data-act="term"]')).toHaveText('In the terminal')
  // Header: role glyph, name, bucket badge, and the three actions.
  await expect(page.locator('#stage .tglyph svg')).toHaveCount(1)
  await expect(page.locator('#stage .tbadge')).toHaveText('Stalled')
  for (const t of ['popout', 'stop']) await expect(page.locator(`#stage [data-tact="${t}"]`)).toBeVisible()
  await expect(page.locator('#stage .tclose')).toBeVisible()
  expect(claudeEvents().some((e) => e.event === 'start' && e.argv.join(' ') === `attach ${SHORT}`)).toBe(true)

  // Typing reaches the PTY; global shortcuts (V F / J K O) and Esc stay in the terminal.
  await typeLine(page, 'hello village')
  await expect(screen(page)).toContainText('echo: hello village')
  await page.keyboard.type('vf/jko')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await expect(page.locator('#stage')).toBeVisible()
  await expect(page.locator('#main')).not.toHaveClass(/\bfull\b/)
  await expect(page.locator('#view-status')).toHaveAttribute('aria-pressed', 'true')
  await expect(screen(page)).toContainText('echo: vf/jko')
  // It fits on resize: a taller window reaches the PTY (the fake prints its size on "size").
  const sizes = async () => (await screen(page).innerText()).match(/size \d+x\d+/g) || []
  const size = async () => {
    const n = (await sizes()).length
    await typeLine(page, 'size')
    await expect.poll(async () => (await sizes()).length).toBe(n + 1)
    return (await sizes()).at(-1).match(/(\d+)x(\d+)/).slice(1).map(Number)
  }
  const [cols0, rows0] = await size()
  await page.setViewportSize({ width: vp.width + 200, height: vp.height + 200 })
  await page.waitForTimeout(300)
  const [cols1, rows1] = await size()
  expect(rows1).toBeGreaterThan(rows0)
  expect(cols1).toBeGreaterThan(cols0)
  await page.setViewportSize(vp)

  // Shift+Esc closes the view: the layout, the detail and the camera are exactly as before.
  await page.keyboard.press('Shift+Escape')
  await expect(page.locator('#stage')).toBeHidden()
  await expect(page.locator('#main')).not.toHaveClass(/termview|tv-anim/)
  expect(await box(page, '#village')).toEqual(before.village)
  expect(await box(page, '#panel')).toEqual(before.panel)
  await expect.poll(() => page.evaluate(() => window.villageDebug().cam)).toEqual(before.cam)
  await expect(page.locator('#drawer h3')).toContainText('DB Lead')
  await expect(page.locator('#drawer [data-act="term"]')).toBeFocused()
  await expect(page.locator('#drawer [data-act="term"]')).toHaveText('Terminal · running') // only detached
  expect(await running(page)).toContain(ID)
})

test('double-clicking an agent opens it in the built-in terminal; one that can\'t be opened shows its inspector', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop layout')
  await row(page, ID).dblclick()
  await expect(page.locator('#stage')).toBeVisible()
  await expect.poll(() => running(page)).toContain(ID)
  await page.locator('#stage .tclose').click()
  await expect(page.locator('#stage')).toBeHidden()
  await row(page, `${claudeId('leadBuilding')}:sub:worker`).dblclick()
  await expect(page.locator('#stage')).toBeHidden()
  await expect(page.locator('#openwhy')).toHaveText('Open its lead instead')
})

test('double-clicking a villager opens it in the built-in terminal', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop layout')
  await page.locator('#cv').focus()
  for (let i = 0; i < 3 && (await page.evaluate(() => window.villageDebug().zoom)) < 2; i++) await page.keyboard.press('+')
  // Screen position of the agent's sprite, from the debug view (world px -> canvas CSS px).
  const pt = await page.evaluate((id) => {
    const d = window.villageDebug(), h = d.hits.find((x) => x.id === id), v = d.view, cv = document.getElementById('cv').getBoundingClientRect()
    return h && { x: cv.left + (h.x + h.w / 2 - v.vx) * v.k * v.px, y: cv.top + (h.y + h.h / 2 - v.vy) * v.k * v.px }
  }, ID)
  expect(pt, 'the agent is on screen').toBeTruthy()
  await page.mouse.dblclick(pt.x, pt.y)
  await expect(page.locator('#stage')).toBeVisible()
  await expect.poll(() => running(page)).toContain(ID)
})

test('switching agents: while the terminal is open, clicking another agent opens it in the terminal', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop layout')
  await inspect(page, ID)
  await enter(page)
  await typeLine(page, 'first agent')
  await expect(screen(page)).toContainText('echo: first agent')
  await page.locator('#drawer [data-act="back"]').click()
  await row(page, OTHER).click() // one click swaps the centre terminal to it
  await expect(page.locator('#stage .tname')).toHaveText('CI Lead')
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await expect(page.locator('#drawer h3')).toContainText('CI Lead')
  await expect(screen(page)).toContainText(`fake claude attach ${IDS.leadCi.slice(0, 8)}`)
  await expect(screen(page)).not.toContainText('echo: first agent')
  expect(await running(page)).toEqual(expect.arrayContaining([ID, OTHER])) // the first only detached
  // A subagent can't be opened: its inspector shows why, and the centre stays put.
  const sub = `${claudeId('leadBuilding')}:sub:worker`
  await page.locator('#drawer [data-act="back"]').click()
  if (await row(page, sub).count()) {
    await row(page, sub).click()
    await expect(page.locator('#stage .tname')).toHaveText('CI Lead')
  }
  // Back to the first: it re-attaches and replays what was there.
  await page.locator('#drawer [data-act="back"]').click()
  await row(page, ID).click()
  await expect(page.locator('#stage .tname')).toHaveText('DB Lead')
  await expect(screen(page)).toContainText('echo: first agent')
  const live = claudeEvents().filter((e) => e.argv.includes(SHORT))
  expect(live.filter((e) => e.event === 'start').length - live.filter((e) => e.event === 'exit').length).toBe(1)
})

test('Close restores a full-screen Table exactly: view, sort, selection', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop layout')
  await page.keyboard.press('f')
  await page.locator('#view-table').click()
  const agentHead = page.locator('[role="columnheader"]:has([data-key="agent"])')
  await agentHead.locator('button').click()
  await expect(agentHead).toHaveAttribute('aria-sort', 'ascending')
  await page.locator(`#list .trow[data-id="${ID}"]`).click()
  await expect(page.locator('#drawer h3')).toContainText('DB Lead')
  await enter(page)
  // From full screen the list is the left column and the inspector the right one.
  const st = await box(page, '#stage'), list = await box(page, '#list'), dr = await box(page, '#drawer')
  expect(list.x + list.width).toBeLessThanOrEqual(st.x + 1)
  expect(dr.x).toBeGreaterThanOrEqual(st.x + st.width - 1)
  expect(st.width).toBeGreaterThan(page.viewportSize().width * 0.5)
  await expect(page.locator('#list .trow').first()).toBeVisible()
  // Change things while in the terminal view; Close must undo them.
  await agentHead.locator('button').click()
  await expect(agentHead).toHaveAttribute('aria-sort', 'descending')
  await page.locator('#stage .tclose').click()
  await expect(page.locator('#stage')).toBeHidden()
  await expect(page.locator('#main')).toHaveClass(/\bfull\b/)
  await expect(page.locator('#view-table')).toHaveAttribute('aria-pressed', 'true')
  await expect(agentHead).toHaveAttribute('aria-sort', 'ascending')
  await expect(page.locator(`#list .trow[data-id="${ID}"]`)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#drawer h3')).toContainText('DB Lead')
})

test('Pop out ends the embedded attach first, then opens the same command; the view closes', async ({ page }) => {
  await inspect(page, ID)
  await enter(page)
  const before = windows().length
  await page.locator('#stage [data-tact="popout"]').click()
  await expect(page.locator('#toast')).toContainText('Opened DB Lead in Kitty')
  await expect(page.locator('#stage')).toBeHidden()
  const opened = windows().slice(before)
  expect(opened).toHaveLength(1)
  expect(opened[0].argv.slice(-2)).toEqual(['attach', SHORT])
  expect(claudeEvents().filter((e) => e.event === 'exit' && e.argv.includes(SHORT)).at(-1).why).toBe('sighup')
  expect(await running(page)).not.toContain(ID)
  await expect(page.locator('#drawer [data-act="term"]')).toHaveText('Terminal')
})

test('on a phone the terminal is full screen, and Back restores the previous view', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone layout')
  await inspect(page, ID)
  await enter(page)
  const st = await box(page, '#stage')
  const vp = page.viewportSize()
  expect([st.x, st.y, Math.round(st.width), Math.round(st.height)]).toEqual([0, 0, vp.width, vp.height])
  await page.locator('#stage .termhost:not([hidden]) .xterm').click()
  await typeLine(page, 'from the phone')
  await expect(screen(page)).toContainText('echo: from the phone')
  await expect(page.locator('#stage .tclose')).toBeHidden()
  await page.locator('#stage .tback').click()
  await expect(page.locator('#stage')).toBeHidden()
  await expect(page.locator('#drawer h3')).toContainText('DB Lead')
  expect(await running(page)).toContain(ID)
})

test('refusals: a live session and a subagent have no Terminal', async ({ page }) => {
  await inspect(page, claudeId('soloTurn'))
  await expect(page.locator('#drawer [data-act="term"]')).toBeDisabled()
  await expect(page.locator('#openwhy')).toHaveText('Already running in another terminal')
  await page.locator('[data-act="back"]').click()
  await inspect(page, `${claudeId('leadBuilding')}:sub:worker`)
  await expect(page.locator('#drawer [data-act="term"]')).toBeDisabled()
  await expect(page.locator('#openwhy')).toHaveText('Open its lead instead')
})

// ---------- dropped sockets, server restarts, focus ----------
const status = (page) => page.locator('#stage .termstatus')
const notice = (page) => page.locator('#stage .termnotice')
const starts = () => claudeEvents().filter((e) => e.event === 'start' && e.argv.includes(SHORT)).length
/** Every terminal socket goes through a pass-through proxy, so a test can kill one from the server side. */
async function proxySockets(page) {
  const socks = []
  await page.routeWebSocket(/\/api\/term\/ws/, (ws) => { ws.connectToServer(); socks.push(ws) })
  // Close the page's side as a dying server would (1001 "going away"); the proxy closes the server side.
  return { kill: () => socks.at(-1).close({ code: 1001, reason: 'going away' }), count: () => socks.length }
}
const termFocused = (page) => page.evaluate(() => !!document.activeElement?.closest('#stage .xterm'))

test('a socket that drops while the process runs reconnects on its own; typing works again without switching agents', async ({ page }) => {
  const socks = await proxySockets(page)
  await inspect(page, ID)
  await enter(page)
  await typeLine(page, 'before the drop')
  await expect(screen(page)).toContainText('echo: before the drop')
  const n = starts(), opened = socks.count()
  await socks.kill() // what a server restart, sleep or a network blip does to the page
  await expect.poll(() => socks.count()).toBeGreaterThan(opened) // reconnected by itself
  await expect(status(page)).toHaveText('Attached')
  await expect(notice(page)).toBeHidden()
  expect(await termFocused(page)).toBe(true)
  await typeLine(page, 'after the drop')
  await expect(screen(page)).toContainText('echo: after the drop')
  await expect(screen(page)).toContainText('echo: before the drop') // the same PTY, replayed
  await expect(page.locator('#stage .tname')).toHaveText('DB Lead')
  expect(starts()).toBe(n) // re-attached, never a second `claude attach`
})

test('keys typed while the terminal is still attaching are sent once it is live; no notice sticks', async ({ page }) => {
  // Hold the screen snapshot (the first binary frame) back a moment, as a busy server does.
  await page.routeWebSocket(/\/api\/term\/ws/, (ws) => {
    const server = ws.connectToServer()
    let first = true
    server.onMessage((m) => {
      if (first && typeof m !== 'string') { first = false; setTimeout(() => ws.send(m), 1200); return }
      ws.send(m)
    })
    ws.onMessage((m) => server.send(m))
  })
  await inspect(page, ID)
  await page.locator('#drawer [data-act="term"]').click()
  await expect(page.locator('#stage .termstatus')).toHaveText('Attached')
  await typeLine(page, 'early keys') // before the snapshot has arrived
  await expect(screen(page)).toContainText('echo: early keys')
  await expect(notice(page)).toBeHidden()
  await typeLine(page, 'later keys')
  await expect(screen(page)).toContainText('echo: later keys')
  await expect(notice(page)).toBeHidden()
})

test('typing while disconnected is not sent, and says so; it works again once reconnected', async ({ page }) => {
  const socks = await proxySockets(page)
  await inspect(page, ID)
  await enter(page)
  // Hold every reconnect off until the test lets go.
  let hold = true
  await page.route(/\/api\/term\/[^/]+$/, (r) => (hold && r.request().method() === 'POST' ? r.fulfill({ status: 503, body: '{}' }) : r.continue()))
  await socks.kill()
  await expect(status(page)).toHaveText('Reconnecting…')
  await expect(notice(page)).toBeVisible()
  await expect(notice(page)).toContainText('Reconnecting')
  await typeLine(page, 'lost keys')
  await expect(notice(page)).toHaveText('Reconnecting — what you just typed was not sent. Typing works again in a moment.')
  await expect(notice(page)).toHaveClass(/dropped/)
  hold = false
  await expect(status(page)).toHaveText('Attached', { timeout: 15_000 })
  await expect(notice(page)).toBeHidden()
  await typeLine(page, 'found keys')
  await expect(screen(page)).toContainText('echo: found keys')
  await expect(screen(page)).not.toContainText('lost keys') // dropped, never replayed late
})

test('a process that exits shows Start again and is never restarted on its own', async ({ page }) => {
  await inspect(page, ID)
  await enter(page)
  const n = starts()
  await typeLine(page, 'exit')
  await expect(status(page)).toHaveText('Process exited (code 7) — Start again')
  // Coming back to the page and typing don't bring it back.
  await page.evaluate(() => { dispatchEvent(new Event('online')); dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  await page.locator('#stage .termhost:not([hidden]) .xterm').click()
  await page.keyboard.type('x')
  await expect(notice(page)).toHaveText('Not sent: this session has ended. Use Start again to run it again.')
  await page.waitForTimeout(2500) // longer than the first few reconnect delays
  await expect(status(page)).toHaveText('Process exited (code 7) — Start again')
  expect(starts()).toBe(n)
  expect(await running(page)).not.toContain(ID)
  await page.locator('#stage [data-tact="reconnect"]').click()
  await expect(status(page)).toHaveText('Attached')
  await expect.poll(starts).toBe(n + 1)
  expect(await termFocused(page)).toBe(true) // the button gives the keyboard back
  await typeLine(page, 'started again')
  await expect(screen(page)).toContainText('echo: started again')
})

test('a session that ended while the page was disconnected stays ended (Start again), like an idle end', async ({ page, baseURL }) => {
  const socks = await proxySockets(page)
  await inspect(page, ID)
  await enter(page)
  const n = starts()
  let hold = true
  await page.route(/\/api\/term\/[^/]+$/, (r) => (hold && r.request().method() === 'POST' ? r.fulfill({ status: 503, body: '{}' }) : r.continue()))
  await socks.kill()
  await expect(status(page)).toHaveText('Reconnecting…')
  // Meanwhile it ends on the server (the idle timeout, or a Stop from elsewhere).
  await page.request.delete(`/api/term/${encodeURIComponent(ID)}`, { headers: { origin: baseURL } })
  hold = false
  await expect(status(page)).toHaveText('Stopped — Start again', { timeout: 15_000 })
  await page.waitForTimeout(1500)
  expect(starts()).toBe(n)
  expect(await running(page)).not.toContain(ID)
})

test('the terminal keeps the keyboard across data refreshes and re-renders; a click anywhere in it takes it back', async ({ page, request, baseURL }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop layout (the hint is hidden on a phone)')
  await inspect(page, ID)
  await enter(page)
  expect(await termFocused(page)).toBe(true)
  // A rename re-renders the header and the inspector; then let a few 2 s polls go by.
  await request.patch(`/api/overrides/${encodeURIComponent(ID)}`, { headers: { origin: baseURL, 'content-type': 'application/json' }, data: { name: 'DB Lead Two' } })
  await expect(page.locator('#stage .tname')).toHaveText('DB Lead Two')
  await page.waitForTimeout(4500)
  expect(await termFocused(page)).toBe(true)
  await page.keyboard.type('v') // a global shortcut (switch view) belongs to the terminal here
  await typeLine(page, 'kept')
  await expect(screen(page)).toContainText('echo: vkept')
  await expect(page.locator('#view-status')).toHaveAttribute('aria-pressed', 'true')
  // Clicks outside the xterm but inside the terminal area: header text, the hint, the frame.
  for (const [sel, position] of [['#stage .tname'], ['#stage .termhint'], ['#stage', { x: 3, y: 3 }]]) {
    await page.locator('#q').focus()
    expect(await termFocused(page)).toBe(false)
    await page.locator(sel).click({ position })
    expect(await termFocused(page), sel).toBe(true)
  }
  await typeLine(page, 'clicked')
  await expect(screen(page)).toContainText('echo: clicked')
  await clearOverrides(request)
})

test('a server restart: the page says so, reconnects by itself, and typing reaches a fresh `claude attach`', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'one layout is enough for the restart')
  const dir = tmpDir('term-restart')
  const env = prepareHome(dir), port = nextPort()
  const log = () => lines(env.AGENTVILLE_FAKE_CLAUDE_LOG).filter((e) => e.argv.includes(SHORT))
  let s = await startServer(env, port)
  try {
    await page.goto(`${s.url}/?debug`)
    await expect(page.locator('#conn')).toHaveText(/Live/)
    await inspect(page, ID)
    await enter(page)
    await typeLine(page, 'before restart')
    await expect(screen(page)).toContainText('echo: before restart')
    await s.stop() // SIGTERM: the server tells the page, hangs up the PTY and exits
    await expect(status(page)).toHaveText('Server restarting — reconnecting…')
    await expect(notice(page)).toContainText('Server restarting')
    expect(log().filter((e) => e.event === 'exit').length).toBe(1)
    s = await startServer(env, port)
    await expect(status(page)).toHaveText('Attached', { timeout: 20_000 })
    await expect(notice(page)).toBeHidden()
    await expect(page.locator('#stage .tname')).toHaveText('DB Lead') // never switched agents
    await typeLine(page, 'after restart')
    await expect(screen(page)).toContainText('echo: after restart')
    const ev = log()
    expect(ev.filter((e) => e.event === 'start').length - ev.filter((e) => e.event === 'exit').length).toBe(1) // exactly one alive
  } finally { await s.stop() }
})
