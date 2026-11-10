// Overrides, live updates, resilience, security, accessibility, empty states, scale.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import AxeBuilder from '@axe-core/playwright'
import { HOME, IDS, SECRET, SHOTS, prepareHome, prepareBigHome, startServer, tmpDir, nextPort, clearOverrides, row, claudeId, inspect } from './helpers.mjs'

const isMobile = (testInfo) => testInfo.project.name === 'mobile'
const tmp = tmpDir
const port = nextPort

test.beforeEach(async ({ page, request }) => {
  await clearOverrides(request)
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
})

test('overrides: rename, role and hide/undo from the UI persist across reload', async ({ page }, testInfo) => {
  const id = claudeId('soloTurn')
  await page.goto(`/#agent=${encodeURIComponent(id)}`)
  await inspect(page, id)
  const d = page.locator('#drawer')
  await d.locator('[data-act="edit"]').click()
  await d.locator('input[name="name"]').fill('Renamed Solo')
  await d.locator('select[name="role"]').selectOption('lead')
  await d.locator('[type="submit"]').click()
  await expect(d.locator('h3')).toContainText('Renamed Solo')
  await expect(d.locator('.facts')).toContainText('set manually')
  await page.reload()
  await expect(row(page, id)).toContainText('Renamed Solo')
  await expect(row(page, id).locator('.ov')).toHaveCount(1) // override dot
  await inspect(page, id)
  await d.locator('[data-act="hide"]').click()
  await expect(page.locator('#toast')).toContainText('hidden')
  await expect(row(page, id)).toHaveCount(0)
  await page.locator('#toast button', { hasText: 'Undo' }).click()
  await expect(row(page, id)).toHaveCount(1)
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-after-overrides.png` })
})

test('overrides: reparent to a lead and force top level', async ({ page }) => {
  const id = claudeId('soloWaiting')
  await page.goto(`/#agent=${encodeURIComponent(id)}`)
  await inspect(page, id)
  const d = page.locator('#drawer')
  await d.locator('[data-act="edit"]').click()
  await d.locator('select[name="parent"]').selectOption(claudeId('leadCi'))
  await d.locator('[type="submit"]').click()
  await expect(d.locator('.facts')).toContainText('CI Lead')
  await d.locator('[data-act="back"]').click()
  await page.locator('#view-team').click()
  await expect(page.locator(`li:has(> .tw .row[data-id="${claudeId('leadCi')}"]) .row[data-id="${id}"]`)).toHaveCount(1)
})

test('an override name is rendered as text, never as HTML', async ({ page, request, baseURL }) => {
  const id = claudeId('soloTurn')
  const res = await request.patch(`/api/overrides/${encodeURIComponent(id)}`, {
    headers: { origin: baseURL, 'content-type': 'application/json' }, data: { name: '<img src=x onerror="window.__xss=1">' },
  })
  expect(res.status()).toBe(200)
  await page.goto(`/#agent=${encodeURIComponent(id)}`)
  await expect(row(page, id)).toContainText('<img src=x')
  await inspect(page, id)
  expect(await page.evaluate(() => window.__xss)).toBeUndefined()
})

test('security: no transcript/tool content or secret reaches the API or the DOM', async ({ page, request }) => {
  const api = await (await request.get('/api/agents')).text()
  expect(api).not.toContain(SECRET)
  expect(api).not.toContain('ANTHROPIC_API_KEY')
  expect(api).not.toContain('npm test') // a tool command in the worker transcript
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await inspect(page, claudeId('leadBuilding'))
  const html = await page.content()
  expect(html).not.toContain(SECRET)
  expect(html).not.toContain('ANTHROPIC_API_KEY')
})

test('security: cross-origin and non-local requests are refused', async ({ request, baseURL }) => {
  const id = encodeURIComponent(claudeId('soloTurn'))
  const patch = (headers) => request.patch(`/api/overrides/${id}`, { headers: { 'content-type': 'application/json', ...headers }, data: { name: 'pwned' } })
  expect((await patch({ origin: 'http://evil.example' })).status()).toBe(403)
  expect((await patch({ origin: baseURL.replace('127.0.0.1', 'localhost') })).status()).toBe(403)
  expect((await patch({})).status()).toBe(403) // no Origin: not a same-origin browser write
  expect((await request.get('/api/agents', { headers: { host: 'evil.example' } })).status()).toBe(403)
  expect((await request.patch(`/api/overrides/${id}`, { headers: { origin: baseURL, 'content-type': 'text/plain' }, data: '{"name":"x"}' })).status()).toBe(415)
  expect((await request.patch(`/api/overrides/${id}`, { headers: { origin: baseURL, 'content-type': 'application/json' }, data: { role: 'king' } })).status()).toBe(400)
  const { agents } = await (await request.get('/api/agents')).json()
  expect(agents.find((a) => a.id === decodeURIComponent(id)).name).not.toBe('pwned')
})

test('garbage files in the homes do not crash the scan or invent agents', async ({ request }) => {
  const body = await (await request.get('/api/agents')).json()
  expect(body.warnings).toEqual([])
  const ids = body.agents.map((a) => a.id)
  for (const junk of ['bbbbbbbb', 'cccccccc', 'dddddddd']) expect(ids.join(), `phantom agent from ${junk}.jsonl`).not.toContain(junk)
  expect(body.agents.filter((a) => a.name === 'Untitled').map((a) => a.id)).toEqual([])
})

test('live updates: buckets change, agents appear and disappear without losing focus', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'runs once; mutates the shared fixture')
  const codexRun = `codex:${IDS.codexRunning}`
  await expect(row(page, codexRun)).toHaveClass(/b-building/)
  // Keep focus on a row that does not change.
  await row(page, claudeId('leadCi')).focus()
  const env = { claude: path.join(HOME, 'claude'), codex: path.join(HOME, 'codex') }
  try {
    const rollout = fs.readdirSync(path.join(env.codex, 'sessions', '2026', '10', '21')).find((f) => f.includes(IDS.codexRunning))
    fs.appendFileSync(path.join(env.codex, 'sessions', '2026', '10', '21', rollout),
      JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' } }) + '\n')
    const sid = 'fffffff1-0000-4000-8000-000000000000'
    fs.writeFileSync(path.join(env.claude, 'projects', '-work-demo-app', `${sid}.jsonl`), JSON.stringify({ type: 'user', sessionId: sid, cwd: '/work/demo-app', uuid: 'u', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Brand new agent' } }) + '\n'
      + JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }] } }) + '\n')
    fs.rmSync(path.join(env.claude, 'projects', '-work-demo-app', `${IDS.soloError}.jsonl`))

    await expect(row(page, codexRun)).toHaveClass(/b-stalled/, { timeout: 10_000 })
    await expect(row(page, `claude-code:${sid}`)).toContainText('Brand new agent')
    await expect(row(page, claudeId('soloError'))).toHaveCount(0)
    await expect(row(page, claudeId('leadCi'))).toBeFocused()
  } finally {
    prepareHome(HOME)
  }
})

test('offline: killing the server shows the offline state, restarting recovers; overrides survive restart', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'server lifecycle runs once')
  test.setTimeout(90_000)
  const dir = tmp('offline'), p = port()
  const env = prepareHome(dir)
  let s = await startServer(env, p)
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  const id = claudeId('leadCi')
  expect((await page.request.patch(`${s.url}/api/overrides/${encodeURIComponent(id)}`, {
    headers: { origin: s.url, 'content-type': 'application/json' }, data: { name: 'Persisted Name' } })).status()).toBe(200)
  await expect(row(page, id)).toContainText('Persisted Name')
  await s.stop()
  await expect(page.locator('#conn')).toHaveText(/Offline/, { timeout: 20_000 })
  await expect(page.locator('#banner')).toContainText("Can't reach the Agentville server")
  await page.screenshot({ path: `${SHOTS}/desktop-offline.png` })
  s = await startServer(env, p)
  await page.locator('#btn-retry').click()
  await expect(page.locator('#conn')).toHaveText(/Live/, { timeout: 15_000 })
  await expect(page.locator('#banner')).toBeHidden()
  await expect(row(page, id)).toContainText('Persisted Name')
  await s.stop()
})

test('empty homes show a friendly explanation; one harness alone works', async ({ page }, testInfo) => {
  const dir = tmp('empty'), p = port()
  const none = await startServer({ AGENTVILLE_CLAUDE_HOME: path.join(dir, 'no-claude'), AGENTVILLE_CODEX_HOME: path.join(dir, 'no-codex'), AGENTVILLE_DATA_DIR: path.join(dir, 'data') }, p)
  await page.goto(none.url)
  await expect(page.locator('#list')).toContainText('No agents found yet.')
  await expect(page.locator('#list')).toContainText('not found')
  await expect(page.locator('#list')).toContainText('Agentville reads Claude Code sessions from ~/.claude and Codex sessions from ~/.codex')
  await expect(page.locator('.counter[data-bucket="stalled"]')).toHaveClass(/zero/)
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-empty.png` })
  await none.stop()
  const full = prepareHome(path.join(dir, 'h'))
  const codexOnly = await startServer({ ...full, AGENTVILLE_CLAUDE_HOME: path.join(dir, 'no-claude') }, p)
  await page.goto(codexOnly.url)
  await expect(page.locator('#list .row')).toHaveCount(2)
  await codexOnly.stop()
})

test('accessibility: axe finds no serious violations; skip link and focus ring work', async ({ page }, testInfo) => {
  await expect(page.locator('#conn')).toHaveText(/Live/)
  // label-content-name-mismatch (WCAG 2.5.3) is an axe "experimental" rule, so it has to be switched on.
  const results = await new AxeBuilder({ page }).options({ rules: { 'label-content-name-mismatch': { enabled: true } } }).analyze()
  const bad = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')})`)).toEqual([])
  if (isMobile(testInfo)) return
  await page.keyboard.press('Tab')
  await expect(page.locator('.skip')).toBeFocused()
  await page.keyboard.press('Tab')
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
  expect(outline).not.toBe('none')
})

test('mobile/desktop: no horizontal overflow, top bar fits, rows tappable', async ({ page }, testInfo) => {
  await expect(page.locator('#conn')).toHaveText(/Live/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const top = await page.locator('header.top').evaluate((el) => el.scrollWidth <= el.clientWidth)
  expect(top, 'top bar content fits').toBe(true)
  const h = (await row(page, claudeId('leadBlocked')).boundingBox()).height
  expect(h).toBeGreaterThanOrEqual(isMobile(testInfo) ? 44 : 30)
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-docked.png` })
  if (isMobile(testInfo)) {
    await row(page, claudeId('leadBlocked')).tap()
    await expect(row(page, claudeId('leadBlocked'))).toHaveAttribute('aria-current', 'true')
    await page.locator('#btn-collapse').tap()
    await page.screenshot({ path: `${SHOTS}/mobile-village.png` })
    await expect(page.locator('#cv')).toBeVisible()
  }
})

test('150+ agents: renders, scrolls, and idles cheaply', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'perf measured once on desktop')
  test.setTimeout(90_000)
  const dir = tmp('big'), p = port()
  const s = await startServer(prepareBigHome(dir, 160), p)
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  const n = await page.locator('#list .row').count()
  expect(n).toBeGreaterThan(150)
  await page.screenshot({ path: `${SHOTS}/desktop-big.png` })
  await page.locator('body').press('f')
  await page.screenshot({ path: `${SHOTS}/desktop-big-full.png` })
  await page.locator('body').press('Escape')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  // Idle: 10 s of wall clock, nothing touched.
  const a = await metric()
  await page.waitForTimeout(10_000)
  const b = await metric()
  const cpu = (b.TaskDuration - a.TaskDuration) / (b.Timestamp - a.Timestamp)
  testInfo.annotations.push({ type: 'idle-cpu', description: `${(cpu * 100).toFixed(1)}% main thread, ${b.LayoutCount - a.LayoutCount} layouts, ${b.RecalcStyleCount - a.RecalcStyleCount} style recalcs over 10s with ${n} rows` })
  console.log(testInfo.annotations.at(-1).description)
  expect(cpu, 'idle main-thread busy fraction').toBeLessThan(0.1)
  // Scroll the list end to end and time it.
  const t = await page.locator('#list').evaluate(async (el) => {
    const t0 = performance.now()
    for (let y = 0; y < el.scrollHeight; y += 200) { el.scrollTop = y; await new Promise(requestAnimationFrame) }
    return (performance.now() - t0) / Math.ceil(el.scrollHeight / 200)
  })
  testInfo.annotations.push({ type: 'scroll', description: `${t.toFixed(1)} ms/frame while scrolling` })
  console.log(`scroll ${t.toFixed(1)} ms/frame`)
  expect(t).toBeLessThan(50)
  await s.stop()
})

test('a done job reopened in a terminal leaves Resting, and its inspector says where it is open', async ({ page }) => {
  const id = claudeId('leadDone')
  const reg = path.join(HOME, 'claude', 'sessions', 'reopened.json')
  const now = Date.now()
  fs.writeFileSync(reg, JSON.stringify({ pid: 1, sessionId: IDS.leadDone, kind: 'interactive', status: 'busy', startedAt: now - 60_000, statusUpdatedAt: now }))
  try {
    await page.goto(`/#agent=${encodeURIComponent(id)}`)
    await inspect(page, id)
    const d = page.locator('#drawer')
    await expect(d.locator('.reopened')).toContainText('Reopened in a terminal')
  } finally { fs.rmSync(reg, { force: true }) }
  await page.reload()
  await inspect(page, id)
  await expect(page.locator('#drawer .reopened')).toHaveCount(0)
})
