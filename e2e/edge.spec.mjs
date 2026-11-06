// Things a stranger's machine will throw at it: odd names, odd homes, odd ports, odd browsers.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import { EDGE, IDS, tmpDir, nextPort, spawnServer, SHOTS, prepareEdgeHome, startServer, clearOverrides, row, claudeId, inspect } from './helpers.mjs'

const isMobile = (testInfo) => testInfo.project.name === 'mobile'
const tmp = tmpDir
const port = nextPort

test.describe('edge-case home', () => {
  let s, ids
  test.beforeAll(async () => {
    const r = prepareEdgeHome(tmp('edge'))
    ids = r.ids
    s = await startServer(r.env, port())
  })
  test.afterAll(async () => s?.stop())

  test('long, unbroken, RTL, CJK and duplicate names render without overflow; unreadable file is skipped', async ({ page }, testInfo) => {
    await page.goto(s.url)
    await expect(page.locator('#conn')).toHaveText(/Live/)
    for (const k of ['long', 'unbroken', 'rtl', 'cjk', 'dup']) await expect(row(page, ids[k])).toHaveCount(1)
    await expect(row(page, ids.rtl)).toContainText(EDGE.rtl)
    await expect(row(page, ids.cjk)).toContainText(EDGE.cjk)
    await expect(row(page, ids.denied)).toHaveCount(0) // chmod 000: skipped, not a crash
    const overflow = await page.locator('#list .row').evaluateAll((rs) => rs.filter((r) => r.scrollWidth > r.clientWidth + 1).length)
    expect(overflow).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-edge-names.png` })
    await inspect(page, ids.unbroken)
    expect(await page.locator('#drawer').evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true)
  })

  test('a truncated name or title says so with an ellipsis instead of cutting mid-word', async ({ request }) => {
    const { agents } = await (await request.get(`${s.url}/api/agents`)).json()
    const a = agents.find((x) => x.id === ids.long)
    if (a.name.length < EDGE.long.length) expect(a.name, 'name is cut').toMatch(/…$/)
    if (a.title.length < EDGE.long.length) expect(a.title, 'title is cut').toMatch(/…$/)
  })

  test('no agent name or title is unbounded (Codex thread titles included)', async ({ request }) => {
    const { agents } = await (await request.get(`${s.url}/api/agents`)).json()
    const long = agents.filter((a) => a.name.length > 200 || a.title.length > 200).map((a) => `${a.id}: name ${a.name.length}, title ${a.title.length}`)
    expect(long).toEqual([])
  })

  test('Codex spawn edges nest the child thread under its parent', async ({ request }) => {
    const { agents } = await (await request.get(`${s.url}/api/agents`)).json()
    const child = agents.find((a) => a.id === `codex:${IDS.codexTurn}`)
    expect(child.parentId).toBe(`codex:${IDS.codexRunning}`)
    expect(child.role).toBe('sub')
  })

  test('a resting namesake does not stamp an id suffix on the live agent', async ({ page }) => {
    await page.goto(s.url)
    await expect(page.locator('#conn')).toHaveText(/Live/)
    // The suffix exists to tell two rows apart; a resting copy is not shown, so it only costs name width.
    await expect(row(page, claudeId('soloError')).locator('.dup')).toHaveCount(0)
  })

  test('two agents with the same name can be told apart in the list', async ({ page }) => {
    await page.goto(s.url)
    await expect(page.locator('#conn')).toHaveText(/Live/)
    const a = (await row(page, claudeId('soloTurn')).innerText()).trim()
    const b = (await row(page, ids.dup).innerText()).trim()
    expect(a, 'duplicate-named rows render identically').not.toBe(b)
  })
})

test('a harness folder that exists but is empty explains itself', async ({ page }) => {
  const dir = tmp('emptydirs')
  for (const d of ['claude', 'codex']) fs.mkdirSync(path.join(dir, d))
  const s = await startServer({ AGENTVILLE_CLAUDE_HOME: path.join(dir, 'claude'), AGENTVILLE_CODEX_HOME: path.join(dir, 'codex'), AGENTVILLE_DATA_DIR: path.join(dir, 'data') }, port())
  try {
    await page.goto(s.url)
    await expect(page.locator('#list')).toContainText('No agents found yet.')
    await expect(page.locator('#list')).toContainText('found, no sessions yet')
  } finally { await s.stop() }
})

test('a bad AGENTVILLE_PORT fails with a clear message, not a stack trace', async ({}, testInfo) => {
  test.skip(isMobile(testInfo), 'server-only')
  const child = spawnServer({ AGENTVILLE_PORT: '99999', AGENTVILLE_DATA_DIR: tmp('port'), AGENTVILLE_CLAUDE_HOME: '/nonexistent', AGENTVILLE_CODEX_HOME: '/nonexistent' })
  let out = ''
  child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c))
  const code = await new Promise((r) => { child.on('exit', r); setTimeout(() => { child.kill(); r('timeout') }, 5000) })
  expect(code).toBe(1)
  expect(out).toMatch(/AGENTVILLE_PORT/)
  expect(out).not.toMatch(/\n\s+at /)
})

test('keyboard only: find an agent, open it, rename and re-role it, save', async ({ page, request }, testInfo) => {
  test.skip(isMobile(testInfo), 'keyboard flow')
  await clearOverrides(request)
  await page.goto('/')
  await expect(page.locator('#conn')).toHaveText(/Live/)
  const id = claudeId('soloWaiting')
  await page.keyboard.press('/')
  await page.keyboard.type('research')
  await page.keyboard.press('Enter') // selects first match
  await expect(row(page, id)).toHaveAttribute('aria-current', 'true')
  for (let i = 0; i < 40 && !(await row(page, id).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(row(page, id)).toBeFocused()
  await page.keyboard.press('Enter') // already selected: opens detail
  await expect(page.locator('#drawer h3')).toBeFocused()
  const edit = page.locator('#drawer [data-act="edit"]')
  for (let i = 0; i < 20 && !(await edit.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(edit).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#drawer input[name="name"]')).toBeFocused()
  await page.keyboard.type('Keyboard Hero')
  await page.keyboard.press('Tab')
  await expect(page.locator('#drawer select[name="role"]')).toBeFocused()
  await page.keyboard.type('Lead') // type-ahead on a focused <select>
  await expect(page.locator('#drawer select[name="role"]')).toHaveValue('lead')
  await page.keyboard.press('Enter') // submits the form
  await expect(page.locator('#drawer h3')).toContainText('Keyboard Hero')
  const { agents } = await (await request.get('/api/agents')).json()
  expect(agents.find((a) => a.id === id).overrides).toEqual({ name: 'Keyboard Hero', role: 'lead' })
  await expect(page.locator('#drawer [data-act="edit"]')).toBeFocused() // focus returns somewhere sensible
  await clearOverrides(request)
})

test('hash change to a resting agent on an open tab reveals it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await page.goto(`/#agent=${encodeURIComponent(claudeId('soloOld'))}`)
  await expect(row(page, claudeId('soloOld'))).toBeVisible()
})

for (const [name, opts] of [
  ['laptop-1280x720', { viewport: { width: 1280, height: 720 } }],
  ['qhd-2560x1440', { viewport: { width: 2560, height: 1440 } }],
  ['zoom200', { viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 }], // 1440×900 at 200% browser zoom
  ['light-os', { viewport: { width: 1440, height: 900 }, colorScheme: 'light' }],
]) {
  test(`layout holds: ${name}`, async ({ browser }, testInfo) => {
    test.skip(isMobile(testInfo), 'desktop sizes')
    const ctx = await browser.newContext(opts)
    const page = await ctx.newPage()
    await page.goto(testInfo.project.use.baseURL)
    await expect(page.locator('#conn')).toHaveText(/Live/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('header.top').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(page.locator('#q')).toBeVisible()
    await expect(page.locator('.counter[data-bucket="stalled"]')).toBeVisible()
    const [bg, fg] = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color])
    expect(bg).toBe('rgb(15, 17, 21)') // stays dark under a light OS theme
    expect(fg).toBe('rgb(236, 235, 231)')
    await page.screenshot({ path: `${SHOTS}/desktop-${name}.png` })
    await ctx.close()
  })
}

test('reduced motion: the village stops animating when idle', async ({ browser }, testInfo) => {
  test.skip(isMobile(testInfo), 'desktop')
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto(testInfo.project.use.baseURL)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await page.waitForTimeout(1500) // let the sprite sheets load and the first frame land
  const draws = await page.evaluate(async () => {
    let n = 0
    const g = document.getElementById('cv').getContext('2d'), orig = g.drawImage
    g.drawImage = function (...a) { n++; return orig.apply(this, a) }
    await new Promise((r) => setTimeout(r, 4000))
    return n
  })
  // Normal motion redraws ~8×/s; reduced motion redraws only when a poll changes what's visible.
  expect(draws).toBeLessThan(150)
  await ctx.close()
})
