// Buckets, hierarchy, panel modes, search/filters, detail view, selection. Shared fixture server.
import { test, expect } from './fixtures.mjs'
import { EXPECTED, IDS, SHOTS, row, claudeId, clearOverrides, inspect, villagerPoint } from './helpers.mjs'

const isMobile = (testInfo) => testInfo.project.name === 'mobile'

test.beforeEach(async ({ page, request }) => {
  await clearOverrides(request)
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await expect(page.locator('#conn')).toHaveText(/Live/)
})

test('every fixture agent lands in the right bucket with the right reason and role', async ({ page }) => {
  await page.locator('[data-act="resting"]').click()
  for (const [id, want] of Object.entries(EXPECTED)) {
    const r = row(page, id)
    await expect(r, id).toHaveCount(1)
    await expect(r).toHaveClass(new RegExp(`\\bb-${want.bucket}\\b`))
    await expect(r).toHaveClass(new RegExp(`\\b${want.role}\\b`))
    if (want.reason) await expect(r.locator('.l2')).toContainText(want.reason)
    // The row sits in its bucket's section.
    expect(await r.evaluate((el) => el.closest('.sec').className)).toContain(want.bucket)
  }
})

test('top bar counts match the API and the section headers', async ({ page, request }) => {
  const { counts } = await (await request.get('/api/agents')).json()
  for (const b of ['stalled', 'waiting', 'building']) {
    await expect(page.locator(`.counter[data-bucket="${b}"] .num`)).toHaveText(String(counts[b]))
    await expect(page.locator(`.sec.${b} h2 .c`)).toHaveText(String(counts[b]))
  }
  await expect(page).toHaveTitle(`(${counts.stalled}) Agentville`)
})

test('Stalled is the first, filled attention list; Waiting is calm', async ({ page }) => {
  await expect(page.locator('#list .sec').first()).toHaveClass(/stalled/)
  const bg = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(await bg('.counter[data-bucket="stalled"]')).not.toBe('rgba(0, 0, 0, 0)')
  expect(await bg('.counter[data-bucket="waiting"]')).toBe('rgba(0, 0, 0, 0)')
  expect(await bg('#list .row.b-stalled')).not.toBe('rgba(0, 0, 0, 0)')
  expect(await bg('#list .row.b-waiting')).toBe('rgba(0, 0, 0, 0)')
})

test('roles are distinguishable without colour (glyph shape + accessible name)', async ({ page }) => {
  const glyph = (id) => row(page, id).locator('svg.role path').getAttribute('d')
  const shapes = new Set([await glyph(claudeId('boss')), await glyph(claudeId('leadBlocked')),
    await glyph(`${claudeId('leadBuilding')}:sub:worker`), await glyph(claudeId('soloTurn'))])
  expect(shapes.size).toBe(4)
  // Rows are named by their visible text (WCAG 2.5.3) plus a screen-reader-only role/bucket tail.
  await expect(row(page, claudeId('boss'))).toHaveAccessibleName(/^Big Boss\b.*, Boss, Waiting for /)
  await expect(row(page, `${claudeId('leadBuilding')}:sub:worker`)).toHaveAccessibleName(/Subagent.*under API Lead/)
})

test('Team view nests leads under the boss and subs under their lead', async ({ page }, testInfo) => {
  await page.locator('#view-team').click()
  const boss = page.locator(`li:has(> .tw .row[data-id="${claudeId('boss')}"])`)
  for (const k of ['leadBuilding', 'leadBlocked', 'leadCi']) await expect(boss.locator(`> ul.kids .row[data-id="${claudeId(k)}"]`)).toHaveCount(1)
  const api = page.locator(`li:has(> .tw .row[data-id="${claudeId('leadBuilding')}"])`)
  for (const s of ['worker', 'mate']) await expect(api.locator(`> ul.kids .row[data-id="${claudeId('leadBuilding')}:sub:${s}"]`)).toHaveCount(1)
  await expect(page.locator('.tsolo, section.sec').filter({ hasText: 'Solo' }).locator(`.row[data-id="${claudeId('soloTurn')}"]`)).toHaveCount(1)
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-team-docked.png` })
  // Sibling leads must line up: a lead with children must not look nested under the one above it.
  const x = (k) => row(page, claudeId(k)).locator('svg.role').evaluate((el) => Math.round(el.getBoundingClientRect().left))
  expect(await x('leadBuilding'), 'API Lead glyph x vs sibling DB Lead').toBe(await x('leadBlocked'))
})

test('panel modes via keys and buttons persist across reload', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'keyboard shortcuts are a desktop flow')
  const main = page.locator('#main')
  await page.locator('body').press('\\')
  await expect(main).toHaveClass(/collapsed/)
  await page.screenshot({ path: `${SHOTS}/desktop-collapsed.png` })
  await page.locator('#btn-expand').click()
  await expect(main).not.toHaveClass(/collapsed|full/)
  await page.locator('body').press('f')
  await expect(main).toHaveClass(/full/)
  await expect(page.locator('#view-table')).toHaveAttribute('aria-pressed', 'true') // full defaults to Table
  await page.screenshot({ path: `${SHOTS}/desktop-full-table.png` })
  await page.locator('#view-team').click()
  await page.screenshot({ path: `${SHOTS}/desktop-full-team.png` })
  await page.locator('body').press('v') // Status → Team → Table → Models → Status
  await expect(page.locator('#view-table')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('body').press('v')
  await expect(page.locator('#view-models')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('body').press('v')
  await expect(page.locator('#view-status')).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: `${SHOTS}/desktop-full-status.png` })
  await page.reload()
  await expect(main).toHaveClass(/full/)
  await expect(page.locator('#view-status')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('body').press('Escape')
  await expect(main).not.toHaveClass(/full/)
  await expect(page.locator('#view-status')).toHaveAttribute('aria-pressed', 'true') // docked keeps Status
})

test('search filters rows, Enter selects first match, Esc clears then blurs', async ({ page }, testInfo) => {
  if (!isMobile(testInfo)) await page.locator('body').press('/')
  else await page.locator('#q').click()
  await expect(page.locator('#q')).toBeFocused()
  await page.keyboard.type('ci lead')
  await expect(page.locator('#list .row')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#agent=${encodeURIComponent(claudeId('leadCi'))}`))
  await page.locator('#q').fill('docs') // resting agents are searchable
  await expect(row(page, claudeId('leadDone'))).toBeVisible()
  await page.locator('#q').fill('zzz-nothing')
  await expect(page.locator('#list')).toContainText('No agents match')
  await page.locator('#q').press('Escape')
  await expect(page.locator('#q')).toHaveValue('')
  await page.locator('#q').press('Escape')
  await expect(page.locator('#q')).not.toBeFocused()
})

test('filters: harness and role narrow the list, chips remove them, counts stay global', async ({ page }) => {
  const stalled = await page.locator('.counter[data-bucket="stalled"] .num').textContent()
  await page.locator('#btn-filters').click()
  await page.locator('#pop-filters input[data-f="harness"][value="codex"]').check()
  await page.locator('body').click({ position: { x: 5, y: 60 } }).catch(() => {}) // outside click closes
  await expect(page.locator('#list .row')).toHaveCount(2)
  await expect(page.locator('#btn-filters')).toHaveText(/Filters · 1/)
  await expect(page.locator('.counter[data-bucket="stalled"] .num')).toHaveText(stalled)
  await page.locator('.fchip').click()
  await expect(page.locator('#list .row').first()).toBeVisible()
  expect(await page.locator('#list .row').count()).toBeGreaterThan(2)
})

test('keyboard triage: J/K jump stalled rows, arrows move, Enter opens detail, Esc backs out', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'keyboard flow')
  await page.locator('body').press('j')
  const first = page.locator('#list .row.b-stalled').first()
  await expect(first).toBeFocused()
  await expect(first).toHaveAttribute('aria-current', 'true')
  await page.keyboard.press('j')
  await expect(page.locator('#list .row.b-stalled').nth(1)).toBeFocused()
  await page.keyboard.press('k')
  await expect(first).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('#list .row.b-stalled').nth(1)).toBeFocused()
  await page.keyboard.press('Enter') // select
  await page.keyboard.press('Enter') // open detail
  await expect(page.locator('#drawer')).toBeVisible()
  await expect(page.locator('#drawer h3')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#drawer')).toBeHidden()
  await expect(page.locator('#list .row.b-stalled').nth(1)).toBeFocused()
})

test('detail view shows facts and copies resume command and id', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await inspect(page, claudeId('leadBlocked'))
  const d = page.locator('#drawer')
  await expect(d.locator('h3')).toContainText('DB Lead')
  await expect(d).toContainText('Needs your input')
  await expect(d.locator('.facts')).toContainText('Big Boss')
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-detail.png` })
  await d.locator('[data-act="copyresume"]').click()
  await expect(d.locator('[data-act="copyresume"]')).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude attach ${IDS.leadBlocked.slice(0, 8)}`)
  await d.locator('[data-act="copyid"]').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(claudeId('leadBlocked'))
  // Parent link navigates to the boss.
  await d.locator('[data-act="goto"]').first().click()
  await expect(d.locator('h3')).toContainText('Big Boss')
  // A subagent has no resume command and says so.
  await d.locator('[data-act="back"]').click()
  await inspect(page, `${claudeId('leadBuilding')}:sub:worker`)
  await expect(page.locator('#drawer [data-act="copyresume"]')).toHaveCount(0) // it's a link now; no link when there's nothing to copy
  await expect(page.locator('#drawer')).toContainText('No resume command')
})

test('deep link #agent= selects and reveals the agent; selection survives reload', async ({ page }) => {
  const id = claudeId('soloOld') // resting: must auto-expand Resting
  await page.goto('about:blank') // a real deep link is a fresh load, not a same-document hash change
  await page.goto(`/#agent=${encodeURIComponent(id)}`)
  await expect(row(page, id)).toBeVisible()
  await expect(row(page, id)).toHaveAttribute('aria-current', 'true')
  await page.reload()
  await expect(row(page, id)).toHaveAttribute('aria-current', 'true')
  await page.goto('about:blank')
  await page.goto('/#agent=claude-code:does-not-exist')
  await expect(page.locator('#list .row[aria-current]')).toHaveCount(0)
})

test('village to list: clicking a stalled villager selects its row', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'village is behind the panel on mobile')
  await page.goto('/?debug')
  const tag = page.locator('#labels .tag.st', { hasText: 'DB Lead' })
  await expect(tag).toBeVisible()
  const p = await villagerPoint(page, claudeId('leadBlocked'))
  await page.mouse.click(p.x, p.y)
  await expect(row(page, claudeId('leadBlocked'))).toHaveAttribute('aria-current', 'true')
  await expect(page).toHaveURL(/#agent=/)
  // Keyboard path into the canvas: arrows cycle, Enter selects.
  await page.locator('#cv').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#cv')).toHaveAttribute('aria-label', /Press Enter to select/)
  await page.keyboard.press('Enter')
  await expect(page.locator('#list .row[aria-current]')).toHaveCount(1)
})

test('list to village: selecting a row frees the name tag and plots stay put across reloads', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'village is behind the panel on mobile')
  await row(page, claudeId('leadCi')).click()
  await expect(page.locator('#labels .tag.sel')).toHaveText('CI Lead')
  const plots = await page.evaluate(() => localStorage.getItem('va.plots'))
  const signs = () => page.locator('#labels .sign').allTextContents()
  const before = await signs()
  await page.reload()
  await expect(page.locator('#labels .tag.sel')).toHaveText('CI Lead')
  expect(await page.evaluate(() => localStorage.getItem('va.plots'))).toBe(plots)
  expect((await signs()).sort()).toEqual(before.sort())
  await page.screenshot({ path: `${SHOTS}/desktop-village-selected.png` })
})

test('stalled is amber, errors are red: a red "N errors" pill filters to them and they sort first', async ({ page, request }) => {
  const { counts, agents } = await (await request.get('/api/agents')).json()
  const errorIds = agents.filter((a) => a.severity === 'error' && !a.hidden).map((a) => a.id)
  expect(counts.errors).toBe(errorIds.length)
  expect(errorIds).toContain(claudeId('soloError'))
  const bg = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(await bg('.counter.stalled')).toBe('rgb(242, 184, 75)') // amber
  expect(await bg('.counter.errors')).toBe('rgb(255, 114, 98)') // red, only because errors > 0
  await expect(page.locator('.counter.errors')).toHaveText(new RegExp(`^${errorIds.length} Errors?$`))
  await expect(page.locator('.counter.errors')).toHaveAccessibleName(/included in Stalled$/) // a subset, not extra
  expect(await page.locator(`#list .row[data-id="${claudeId('soloError')}"]`).evaluate((el) => getComputedStyle(el).borderLeftColor)).toBe('rgb(255, 114, 98)')
  // Rows: errors carry a red fill and come first in Stalled; needs-you rows are amber.
  expect(await bg(`#list .row[data-id="${claudeId('soloError')}"]`)).toBe('rgb(58, 26, 24)')
  expect(await bg(`#list .row[data-id="${claudeId('leadBlocked')}"]`)).toBe('rgb(46, 36, 16)')
  await expect(page.locator('#list .sec.stalled .row').first()).toHaveClass(/sev-error/)
  await page.locator('.counter.errors').click()
  await expect(page.locator('#list .row')).toHaveCount(errorIds.length)
  await expect(page.locator('#fchips')).toContainText('Errors only')
  // The detail says "Error", not just red.
  await inspect(page, claudeId('soloError'))
  await expect(page.locator('#drawer .pill')).toContainText('Error')
})

test.describe('first run', () => {
  test.use({ firstRun: true })
  test('opens on the expanded Team view; Dock shows the village, and that choice sticks', async ({ page }) => {
    await expect(page.locator('.main')).toHaveClass(/\bfull\b/)
    await expect(page.locator('#view-team')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('#btn-full').click()
    await expect(page.locator('.main')).not.toHaveClass(/\bfull\b/)
    await page.reload()
    await expect(page.locator('.main')).not.toHaveClass(/\bfull\b/)
  })
})
