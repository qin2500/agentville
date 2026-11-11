// Docked Team view: top level only until a caret opens a team. Each folded parent carries a one-line
// summary of everyone under it (count plus status tally), carets are remembered per agent across
// polls and reloads, and search, filters and selection reveal what they point at without touching
// the saved state. A synthetic fleet with generic names, served by rewriting /api/agents in flight.
import fs from 'node:fs'
import { test, expect } from './fixtures.mjs'

const SHOT_DIR = process.env.TEAM_SHOTS || '/tmp/vshots'
const SHOT_LABEL = process.env.TEAM_SHOT_LABEL || 'after'
fs.mkdirSync(SHOT_DIR, { recursive: true })
const isMobile = (ti) => ti.project.name === 'mobile'
const row = (page, id) => page.locator(`#list .row[data-id="${id}"]`)
const caret = (page, id) => page.locator(`#list .chev[data-id="${id}"]`)
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('va.teamOpen') || '[]'))
test.use({ openTeams: false }) // the app's own folded start

// 6 bosses × 3 leads × 5 workers, 2 bossless leads, 30 solos (5 awake). A "needs you" two levels
// under boss-0 (inside a resting lead) and an error under boss-1.
function fleet(tpl, now) {
  const out = []
  const mk = (id, o) => ({ ...tpl, id, name: id, title: '', reason: '', prs: [], changes: null, overrides: null, hidden: false, important: false, roleSource: 'detected', severity: null, prompt: null, since: now - 120e3, lastActivityAt: now - 120e3, childIds: [], resume: null, kind: 'job', live: true, ...o })
  for (let b = 0; b < 6; b++) {
    const project = `project-${b % 3}`, boss = `boss-${b}`
    out.push(mk(boss, { name: `Boss ${b}`, role: 'boss', project, bucket: b % 2 ? 'waiting' : 'building', parentId: null }))
    for (let l = 0; l < 3; l++) {
      const lead = `${boss}-lead-${l}`
      out.push(mk(lead, { name: `Lead ${b}.${l}`, role: 'lead', project, parentId: boss, bucket: l === 0 ? 'building' : 'resting', live: l === 0 }))
      for (let w = 0; w < 5; w++) {
        let bucket = l === 0 && w < 2 ? (w ? 'waiting' : 'building') : 'resting', severity = null
        if (b === 0 && l === 1 && w === 2) { bucket = 'stalled'; severity = 'attention' }
        if (b === 1 && l === 2 && w === 0) { bucket = 'stalled'; severity = 'error' }
        out.push(mk(`${lead}-w${w}`, { name: `Worker ${b}.${l}.${w}`, role: 'sub', kind: 'subagent', project, parentId: lead, bucket, severity, live: bucket !== 'resting' }))
      }
    }
  }
  for (let l = 0; l < 2; l++) {
    const lead = `toplead-${l}`
    out.push(mk(lead, { name: `Top Lead ${l}`, role: 'lead', project: 'project-9', parentId: null, bucket: 'building' }))
    for (let w = 0; w < 3; w++) out.push(mk(`${lead}-w${w}`, { name: `Helper ${l}.${w}`, role: 'sub', kind: 'subagent', project: 'project-9', parentId: lead, bucket: w ? 'resting' : 'building', live: !w }))
  }
  for (let s = 0; s < 30; s++) out.push(mk(`solo-${s}`, { name: `Solo ${s}`, role: 'solo', kind: 'session', project: `project-${s % 4}`, parentId: null, bucket: s < 5 ? 'building' : 'resting', live: s < 5 }))
  return out
}
async function withFleet(page) {
  let polls = 0
  await page.route('**/api/agents*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.agents = fleet(json.agents[0], json.serverTime)
    polls++
    await route.fulfill({ response, json })
  })
  return { polls: () => polls }
}
async function open(page, { keep = false } = {}) {
  const f = await withFleet(page)
  await page.goto('/')
  await page.evaluate((keep) => {
    if (!keep) localStorage.clear()
    localStorage.setItem('va.panel', '"docked"')
    localStorage.setItem('va.view', JSON.stringify({ docked: 'team', full: 'team' }))
  }, keep)
  await page.goto('/')
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await expect(row(page, 'boss-0')).toBeVisible()
  return f
}

test('screenshot: the docked Team view on a big fleet', async ({ page }, ti) => {
  await open(page)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/docked-team-${SHOT_LABEL}-${ti.project.name}.png` })
  if (SHOT_LABEL === 'before') return
  await caret(page, 'boss-0').click()
  await caret(page, 'boss-0-lead-1').click()
  await expect(row(page, 'boss-0-lead-1-w2')).toBeVisible()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(400) // rows slide into place (150 ms)
  await page.screenshot({ path: `${SHOT_DIR}/docked-team-${SHOT_LABEL}-expanded-${ti.project.name}.png` })
})

test('top level only by default: bosses, bossless leads and awake solos; no "+N resting" lines', async ({ page }) => {
  await open(page)
  for (let b = 0; b < 6; b++) await expect(row(page, `boss-${b}`)).toBeVisible()
  for (const id of ['toplead-0', 'toplead-1', 'solo-0', 'solo-4']) await expect(row(page, id)).toBeVisible()
  await expect(page.locator('#list .row[data-id*="-lead-"]')).toHaveCount(0)
  await expect(page.locator('#list .row[data-id*="-w"]')).toHaveCount(0)
  await expect(page.locator('#list ul.kids')).toHaveCount(0)
  await expect(page.locator('#list [data-act="more"]')).toHaveCount(0)
  // resting solos fold into the Solo heading (its caret), not a separate line
  await expect(row(page, 'solo-5')).toHaveCount(0)
  const solo = page.locator('#list section.tsolo')
  await expect(solo.locator('h2')).toContainText('30')
  await expect(solo.locator('h2 .tt.resting .num')).toHaveText('25')
  await caret(page, '__solo').click()
  await expect(row(page, 'solo-5')).toBeVisible()
  await caret(page, '__solo').click()
  await expect(row(page, 'solo-5')).toHaveCount(0)
  // carets say they're folded
  await expect(caret(page, 'boss-0')).toHaveAttribute('aria-expanded', 'false')
  await expect(caret(page, 'boss-0')).toHaveText('▸')
})

test('a folded parent sums up everyone under it, a nested "needs you" and error included', async ({ page }) => {
  await open(page)
  const sum = (id) => row(page, id).locator('.tsum')
  await expect(sum('boss-0').locator('.tsn')).toHaveText('18 reports') // 3 leads + 15 workers
  await expect(sum('boss-0').locator('.tt.stalled .num')).toHaveText('1')
  await expect(sum('boss-0').locator('.tt.stalled')).toContainText('need you')
  await expect(sum('boss-0').locator('.tt.error')).toHaveCount(0)
  await expect(sum('boss-1').locator('.tt.error .num')).toHaveText('1')
  await expect(sum('boss-2').locator('.tt.stalled')).toHaveCount(0)
  await expect(sum('boss-2').locator('.tt.building .num')).toHaveText('2')
  await expect(sum('boss-2').locator('.tt.waiting .num')).toHaveText('1')
  await expect(sum('boss-2').locator('.tt.resting .num')).toHaveText('15')
  await expect(sum('toplead-0').locator('.tsn')).toHaveText('3 reports')
  await expect(row(page, 'solo-0').locator('.tsum')).toHaveCount(0)
  // it's part of the row's accessible name, so the alert is announced too
  await expect(row(page, 'boss-0')).toHaveAccessibleName(/18 reports.*1 need you/)
})

test('carets open one level at a time and are remembered across a poll and a reload', async ({ page }) => {
  const f = await open(page)
  await caret(page, 'boss-0').click()
  await expect(row(page, 'boss-0-lead-1')).toBeVisible()
  await expect(row(page, 'boss-0').locator('.tsum')).toHaveCount(0) // open: the members show instead
  await expect(row(page, 'boss-0-lead-1-w2')).toHaveCount(0) // a child opens folded, the same way
  await expect(row(page, 'boss-0-lead-1').locator('.tsum .tt.stalled .num')).toHaveText('1')
  await caret(page, 'boss-0-lead-1').click()
  await expect(row(page, 'boss-0-lead-1-w2')).toBeVisible()
  expect((await saved(page)).sort()).toEqual(['boss-0', 'boss-0-lead-1'])
  // a poll neither re-folds nor moves the scroll
  const list = page.locator('#list')
  await list.evaluate((el) => { el.scrollTop = 120 })
  const top = await list.evaluate((el) => el.scrollTop)
  const n = f.polls()
  await expect.poll(() => f.polls(), { timeout: 15_000 }).toBeGreaterThan(n + 1)
  await expect(row(page, 'boss-0-lead-1-w2')).toBeAttached()
  expect(await list.evaluate((el) => el.scrollTop)).toBe(top)
  await page.reload()
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await expect(row(page, 'boss-0-lead-1-w2')).toBeAttached()
  await expect(row(page, 'boss-1-lead-0')).toHaveCount(0)
  // folding is remembered too
  await caret(page, 'boss-0').click()
  await expect(row(page, 'boss-0-lead-1')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await expect(row(page, 'boss-0')).toBeVisible()
  await expect(row(page, 'boss-0-lead-1')).toHaveCount(0)
  expect(await saved(page)).toEqual(['boss-0-lead-1'])
  // Expand all / Collapse all
  await page.locator('#list [data-act="expandall"]').click()
  await expect(row(page, 'boss-5-lead-2')).toBeAttached()
  await expect(row(page, 'boss-5-lead-0-w1')).toBeAttached()
  await expect(row(page, 'toplead-1-w0')).toBeAttached()
  await page.locator('#list [data-act="collapseall"]').click()
  await expect(page.locator('#list ul.kids')).toHaveCount(0)
  expect(await saved(page)).toEqual([])
})

test('search and filters reveal a nested match without changing what is saved', async ({ page }) => {
  await open(page)
  await page.locator('#q').fill('Worker 3.2.4')
  await expect(row(page, 'boss-3-lead-2-w4')).toBeVisible()
  await expect(row(page, 'boss-3')).toHaveClass(/\bctx\b/) // ancestors show, dimmed
  expect(await saved(page)).toEqual([])
  await page.locator('#q').fill('')
  await expect(row(page, 'boss-3-lead-2-w4')).toHaveCount(0)
  // a filter (role: Subagent) reveals the deep rows too
  await page.locator('#btn-filters').click()
  await page.locator('#pop-filters input[data-f="roles"][value="sub"]').check()
  await page.locator('#btn-filters').click()
  await expect(row(page, 'boss-0-lead-1-w2')).toBeAttached()
  await expect(row(page, 'boss-1-lead-2-w0')).toBeAttached()
  expect(await saved(page)).toEqual([])
  await page.locator('.fchip').click()
  await expect(row(page, 'boss-1-lead-2-w0')).toHaveCount(0)
})

test('selecting a nested agent reveals it; a click on a folded parent selects it and leaves it folded', async ({ page }, ti) => {
  await open(page)
  await page.evaluate(() => { location.hash = '#agent=boss-4-lead-0-w1' })
  await expect(row(page, 'boss-4-lead-0-w1')).toBeVisible()
  await expect(row(page, 'boss-4-lead-0-w1')).toHaveAttribute('aria-current', 'true')
  expect(await saved(page)).toEqual([])
  // the row is only revealed: picking something else folds it back
  await row(page, 'boss-2').click()
  await expect(row(page, 'boss-2')).toHaveAttribute('aria-current', 'true')
  await expect(row(page, 'boss-4-lead-0-w1')).toHaveCount(0)
  await expect(row(page, 'boss-2-lead-0')).toHaveCount(0) // selecting a folded parent doesn't open it
  await expect(caret(page, 'boss-2')).toHaveAttribute('aria-expanded', 'false')
})

test('arrow keys fold and unfold a team', async ({ page }, ti) => {
  test.skip(isMobile(ti), 'keyboard flow')
  await open(page)
  await row(page, 'boss-0').focus()
  await page.keyboard.press('ArrowRight')
  await expect(row(page, 'boss-0-lead-0')).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(row(page, 'boss-0-lead-0')).toHaveCount(0)
  await expect(row(page, 'boss-0')).toBeFocused()
})
