// Tree view: the org chart of who reports to whom. Rendering, resting pills and folding, the
// inspector on click, keyboard moves (ARIA tree), state kept across polls, search with dimmed
// ancestors, the narrow / phone outline, and a ~1,000-agent fleet (served by rewriting
// /api/agents in flight; generic names only). Never the real ~/.claude or ~/.codex.
import fs from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './fixtures.mjs'
import { claudeId } from './helpers.mjs'

const SHOT_DIR = process.env.TREE_SHOTS || '/tmp/vshots'
fs.mkdirSync(SHOT_DIR, { recursive: true })
const shot = (page, name) => page.screenshot({ path: `${SHOT_DIR}/tree-${name}.png` })
const isMobile = (ti) => ti.project.name === 'mobile'
const card = (page, id) => page.locator(`.tv [role="treeitem"][data-id="${id}"]`)
const named = (page, name) => page.locator('.tv .tnode', { has: page.locator('.tnm', { hasText: new RegExp(`^${name}$`) }) })
/**
 * Connector ends on screen that lead to no card in the page: an end of a segment that touches no
 * other segment and isn't on the edge of a rendered card. Ghost connectors show up here.
 */
function looseEndsInPage() {
  const d = document.querySelector('.tv.chart .tvedges path')?.getAttribute('d') || ''
  const segs = (d.match(/M[^M]+/g) || []).map((x) => x.match(/-?[\d.]+/g).map(Number))
  const cards = [...document.querySelectorAll('.tv.chart .tnode')].map((el) => {
    const m = el.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)
    return { x: +m[1], y: +m[2], w: el.offsetWidth, h: el.offsetHeight }
  })
  const port = document.querySelector('.tv.chart .tvport'), world = document.querySelector('.tv.chart .tvworld')
  const t = world.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)
  const [tx, ty, k] = [+t[1], +t[2], +t[3]]
  const vis = (x, y) => x * k + tx >= 2 && x * k + tx <= port.clientWidth - 2 && y * k + ty >= 2 && y * k + ty <= port.clientHeight - 2
  const on = (x, y, [x1, y1, x2, y2]) => Math.abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) < 0.5 &&
    x >= Math.min(x1, x2) - 0.5 && x <= Math.max(x1, x2) + 0.5 && y >= Math.min(y1, y2) - 0.5 && y <= Math.max(y1, y2) + 0.5
  const onCard = (x, y) => cards.some((c) => x >= c.x - 1 && x <= c.x + c.w + 1 && y >= c.y - 1 && y <= c.y + c.h + 1)
  const bad = []
  segs.forEach((g, i) => {
    for (const [x, y] of [[g[0], g[1]], [g[2], g[3]]]) {
      if (!vis(x, y) || onCard(x, y) || segs.some((h, j) => j !== i && on(x, y, h))) continue
      bad.push(`${x},${y}`)
    }
  })
  return bad
}
const looseEnds = (page) => page.evaluate(looseEndsInPage)
/** Click, then check in the same task (after its microtasks): what a screenshot could catch. */
const clickThenLooseEnds = (page, selector) => page.evaluate(async ([sel, fn]) => {
  document.querySelector(sel).click()
  await Promise.resolve()
  return new Function(`return (${fn})()`)()
}, [selector, looseEndsInPage.toString()])
const focusedId = (page) => page.evaluate(() => document.activeElement?.dataset?.id || null)

async function open(page, { panel = 'full', view = 'tree' } = {}) {
  await page.goto('/')
  await page.evaluate(([p, v]) => { localStorage.clear(); localStorage.setItem('va.panel', JSON.stringify(p)); localStorage.setItem('va.view', JSON.stringify({ docked: v, full: v })) }, [panel, view])
  await page.goto('/')
  await expect(page.locator('#conn')).toHaveText(/Live/)
  if (view === 'tree') await expect(page.locator('.tv [role="treeitem"]').first()).toBeVisible()
}

// ---------- a big synthetic fleet: 8 bosses, 40 leads, 880 workers, 80 solos; ~30 awake ----------
function fleet(tpl, now) {
  const out = []
  const mk = (id, o) => ({ ...tpl, id, name: id, title: '', reason: '', prs: [], changes: null, overrides: null, hidden: false, important: false, roleSource: 'detected', severity: null, prompt: null, since: now - 120e3, lastActivityAt: now - 120e3, childIds: [], resume: null, kind: 'job', ...o })
  for (let b = 0; b < 8; b++) {
    const project = `project-${b % 4}`
    const boss = `boss-${b}`
    out.push(mk(boss, { name: `Boss ${b}`, role: 'boss', project, bucket: b % 2 ? 'waiting' : 'building', live: true, parentId: null }))
    for (let l = 0; l < 5; l++) {
      const lead = `${boss}-lead-${l}`
      out.push(mk(lead, { name: `Lead ${b}.${l}`, role: 'lead', project, parentId: boss, bucket: l === 0 ? 'building' : 'resting', live: l === 0 }))
      for (let w = 0; w < 22; w++) {
        const awake = l === 0 && w < 2
        out.push(mk(`${lead}-w${w}`, { name: `Worker ${b}.${l}.${w}`, role: 'sub', kind: 'subagent', project, parentId: lead, bucket: awake ? (w ? 'stalled' : 'waiting') : 'resting', live: awake }))
      }
    }
  }
  for (let s = 0; s < 80; s++) out.push(mk(`solo-${s}`, { name: `Solo ${s}`, role: 'solo', kind: 'session', project: `project-${s % 6}`, parentId: null, bucket: s < 6 ? 'building' : 'resting', live: s < 6 }))
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

test.describe('desktop', () => {
  test.beforeEach(({}, ti) => test.skip(isMobile(ti), 'the chart is the wide layout; phones get the outline (below)'))

  test('Tree tab next to Team: crowned boss on top, leads under it, orthogonal connectors, solos last', async ({ page }) => {
    await open(page, { view: 'team' })
    const tabs = await page.locator('.seg[aria-label="Group by"] button').allTextContents()
    expect(tabs.indexOf('Tree')).toBe(tabs.indexOf('Team') + 1)
    await page.locator('#view-tree').click()
    await expect(page.locator('#view-tree')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.tv')).toHaveClass(/chart/)
    const boss = card(page, claudeId('boss'))
    await expect(boss).toHaveClass(/r-boss/)
    await expect(boss).toHaveAttribute('aria-level', '2')
    const lead = card(page, claudeId('leadBuilding'))
    await expect(lead).toHaveAttribute('aria-level', '3')
    const [b, l] = [await boss.boundingBox(), await lead.boundingBox()]
    expect(l.y).toBeGreaterThan(b.y + b.height)
    const d = await page.locator('.tvedges path').getAttribute('d')
    for (const s of d.match(/M[^M]+/g)) { const [x1, y1, x2, y2] = s.match(/-?[\d.]+/g).map(Number); expect(x1 === x2 || y1 === y2).toBe(true) }
    // headings: the project first, Solo at the end
    const heads = await page.locator('.tv .thd .thn').allTextContents()
    expect(heads[heads.length - 1]).toBe('Solo')
    expect(heads).toContain('demo-app')
    // no conversation text: a card holds the name, a status word, an age and maybe a pill
    expect(await boss.locator('.tn2').textContent()).toMatch(/^(Building|Waiting|Needs you|Needs a click|Error|Resting)· \S+(\+\d+ resting)?$/)
    // the choice is remembered (va.view), and V cycles Team → Tree → Table
    await page.reload()
    await expect(page.locator('#view-tree')).toHaveAttribute('aria-pressed', 'true')
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('va.view'))).full).toBe('tree')
    await page.locator('#view-team').click()
    await page.locator('body').press('v')
    await expect(page.locator('#view-tree')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('body').press('v')
    await expect(page.locator('#view-models')).toHaveAttribute('aria-pressed', 'true')
    // every card the chart has is drawn from the first frame, and every connector on screen ends on one
    expect(await clickThenLooseEnds(page, '#view-tree')).toEqual([])
    await expect(card(page, claudeId('leadBuilding'))).toBeVisible()
    await expect(named(page, 'test-engineer')).toBeVisible()
    expect(await looseEnds(page)).toEqual([])
    await shot(page, 'desktop')
    const axe = await new AxeBuilder({ page }).include('#list').analyze()
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([])
  })

  test('resting reports fold into "+N resting"; pills open, teams fold, Expand all / Collapse to live', async ({ page }) => {
    await open(page)
    const boss = card(page, claudeId('boss')), docs = card(page, claudeId('leadDone'))
    await expect(docs).toHaveCount(0)
    await expect(boss.locator('.tpill')).toHaveText('+1 resting')
    await boss.locator('.tpill').click()
    await expect(docs).toBeVisible()
    await expect(boss.locator('.tpill')).toHaveText('− resting')
    // fold the API lead's team, and unfold it
    const api = card(page, claudeId('leadBuilding'))
    const kid = named(page, 'reviewer')
    await expect(kid).toBeVisible()
    await api.locator('.ttog').click()
    await expect(kid).toHaveCount(0)
    expect(await looseEnds(page)).toEqual([])
    await expect(api.locator('.ttog')).toHaveText('+2')
    await expect(api).toHaveAttribute('aria-expanded', 'false')
    await api.locator('.ttog').click()
    await expect(kid).toBeVisible()
    // Collapse to live puts every pill back; Expand all opens them all, Solo's too
    await page.locator('[data-tv="live"]').click()
    await expect(docs).toHaveCount(0)
    const old = card(page, claudeId('soloOld'))
    await expect(old).toHaveCount(0)
    await page.locator('[data-tv="expand"]').click()
    await expect(docs).toBeVisible()
    await expect(old).toBeVisible()
    await expect(page.locator('.tvcount')).toHaveText(/^(\d+) of \1 shown$/)
    await shot(page, 'desktop-expanded')
  })

  test('click selects; right-click opens the agent menu; double-click activates like elsewhere', async ({ page }) => {
    await open(page)
    const lead = card(page, claudeId('leadBlocked'))
    await lead.click()
    await expect(lead).toHaveClass(/cur/)
    await expect(lead).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#ctxmenu')).toBeHidden()
    await card(page, claudeId('boss')).click({ button: 'right' })
    await expect(page.locator('#ctxmenu .cm-name')).toHaveText('Big Boss')
    await page.keyboard.press('Escape')
    // a subagent can't be opened in a terminal: a double-click shows its menu, which says why
    await named(page, 'test-engineer').dblclick()
    await expect(page.locator('#ctxmenu .cm-name')).toHaveText('test-engineer')
    await expect(page.locator('#ctxmenu .cm-item[data-cm="term"]')).toHaveAttribute('aria-disabled', 'true')
    await shot(page, 'desktop-menu')
  })

  test('keyboard: Up to the parent, Down to the first report, Left/Right to siblings, Enter opens', async ({ page }) => {
    await open(page)
    await expect(page.locator('.tv [role="tree"]')).toHaveAttribute('aria-label', /reports/)
    // one tab stop: the first heading
    await expect(page.locator('.tv [role="treeitem"][tabindex="0"]')).toHaveCount(1)
    const boss = card(page, claudeId('boss'))
    await boss.focus()
    await page.keyboard.press('ArrowDown')
    const first = await focusedId(page)
    await expect(card(page, first)).toHaveAttribute('aria-level', '3')
    await expect(card(page, first)).toHaveAttribute('aria-posinset', '1')
    await page.keyboard.press('ArrowRight')
    const second = await focusedId(page)
    expect(second).not.toBe(first)
    await expect(card(page, second)).toHaveAttribute('aria-posinset', '2')
    await expect(card(page, second)).toHaveAttribute('tabindex', '0')
    await page.keyboard.press('ArrowLeft')
    expect(await focusedId(page)).toBe(first)
    await page.keyboard.press('ArrowUp')
    expect(await focusedId(page)).toBe(claudeId('boss'))
    await page.keyboard.press('ArrowUp')
    expect(await focusedId(page)).toBe('proj:demo-app')
    // Down on a resting pill opens it; Space folds a team
    await boss.focus()
    await page.keyboard.press('Space')
    await expect(boss).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Space')
    await expect(boss).toHaveAttribute('aria-expanded', 'true')
    // Enter selects; Enter again (or Shift+F10) opens its menu
    await named(page, 'test-engineer').focus()
    await page.keyboard.press('Enter')
    await expect(named(page, 'test-engineer')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(page.locator('#ctxmenu .cm-name')).toHaveText('test-engineer')
    await page.keyboard.press('Escape')
    await expect(page.locator('#ctxmenu')).toBeHidden()
    await page.keyboard.press('Shift+F10')
    await expect(page.locator('#ctxmenu .cm-name')).toHaveText('test-engineer')
  })

  test('a poll keeps pills, folds, the camera, the focused card and the card elements themselves', async ({ page }) => {
    await open(page)
    const boss = card(page, claudeId('boss'))
    await boss.locator('.tpill').click()
    await card(page, claudeId('leadBuilding')).locator('.ttog').click()
    await page.locator('.tvport').hover()
    await page.mouse.wheel(40, 30)
    const cam = await page.locator('.tvworld').getAttribute('style')
    await boss.focus()
    await boss.evaluate((el) => { el._probe = 'same' })
    for (let i = 0; i < 2; i++) await page.waitForResponse((r) => r.url().includes('/api/agents'))
    await page.waitForTimeout(100)
    await expect(card(page, claudeId('leadDone'))).toBeVisible()
    await expect(named(page, 'reviewer')).toHaveCount(0)
    expect(await page.locator('.tvworld').getAttribute('style')).toBe(cam)
    expect(await focusedId(page)).toBe(claudeId('boss'))
    expect(await boss.evaluate((el) => el._probe)).toBe('same')
  })

  test('search keeps the chain of command: matches plus dimmed ancestors', async ({ page }) => {
    await open(page)
    await page.locator('#q').fill('test-engineer')
    await expect(named(page, 'test-engineer')).not.toHaveClass(/ctx/)
    await expect(card(page, claudeId('leadBuilding'))).toHaveClass(/ctx/)
    await expect(card(page, claudeId('boss'))).toHaveClass(/ctx/)
    await expect(card(page, claudeId('leadBlocked'))).toHaveCount(0)
    await expect(page.locator('.tvcount')).toHaveText('3 shown · 1 match')
    expect(await looseEnds(page)).toEqual([])
    await shot(page, 'desktop-search')
    await page.locator('#q').fill('')
    await expect(card(page, claudeId('leadBlocked'))).toBeVisible()
  })

  test('docked panel (narrow) gets the outline, not the chart', async ({ page }) => {
    await open(page, { panel: 'docked' })
    await expect(page.locator('.tv')).toHaveClass(/outline/)
    await expect(page.locator('.tv .tvedges')).toBeHidden()
    await shot(page, 'docked')
  })

  test('~1,000 agents: fast to open, folded by default, only on-screen cards in the DOM, smooth polls', async ({ page }) => {
    const f = await withFleet(page)
    await open(page, { view: 'team' })
    await page.evaluate(() => {
      window.__long = []
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask', buffered: false })
    })
    const openMs = await page.evaluate(() => { const t = performance.now(); document.getElementById('view-tree').click(); return performance.now() - t })
    await page.locator('#view-team').click()
    expect(await clickThenLooseEnds(page, '#view-tree')).toEqual([])
    expect(openMs).toBeLessThan(400)
    await expect(page.locator('.tvcount')).toHaveText(/ of 1008 shown$/)
    const folded = Number((await page.locator('.tvcount').innerText()).split(' ')[0])
    expect(folded).toBeLessThan(120)
    await expect(named(page, 'Boss 0')).toBeVisible()
    expect(await looseEnds(page)).toEqual([])
    await shot(page, 'large')
    const expandMs = await page.evaluate(() => { const t = performance.now(); document.querySelector('[data-tv="expand"]').click(); return performance.now() - t })
    expect(expandMs).toBeLessThan(600)
    await expect(page.locator('.tvcount')).toHaveText('1008 of 1008 shown')
    expect(await page.locator('.tv .tnode').count()).toBeLessThan(500) // culled to the viewport
    // panning brings other cards in, in place
    const before = await page.locator('.tv .tnode').evaluateAll((els) => els.map((e) => e.dataset.id).join())
    await page.locator('.tvport').hover()
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400)
    await expect.poll(() => page.locator('.tv .tnode').evaluateAll((els) => els.map((e) => e.dataset.id).join())).not.toBe(before)
    // polls with 1,000 agents don't block the page
    const n = f.polls()
    await expect.poll(() => f.polls(), { timeout: 10_000 }).toBeGreaterThan(n + 1)
    const long = await page.evaluate(() => Math.max(0, ...window.__long))
    expect(long).toBeLessThan(250)
    await page.locator('[data-tv="fit"]').click()
    await expect.poll(() => looseEnds(page)).toEqual([])
    await shot(page, 'large-expanded-fit')
    await page.locator('[data-tv="live"]').click()
    await expect(page.locator('.tvcount')).toHaveText(`${folded} of 1008 shown`)
  })
})

test.describe('mobile', () => {
  test.beforeEach(({}, ti) => test.skip(!isMobile(ti), 'phone layout'))

  test('a phone gets an indented outline; arrows walk it; tapping opens the inspector', async ({ page }) => {
    await open(page, { panel: 'full' })
    await expect(page.locator('.tv')).toHaveClass(/outline/)
    const boss = card(page, claudeId('boss')), lead = card(page, claudeId('leadBuilding')), kid = named(page, 'test-engineer')
    await expect(kid).toHaveAttribute('aria-level', '4')
    const [b, l, k] = [await boss.boundingBox(), await lead.boundingBox(), await kid.boundingBox()]
    expect(l.x).toBeGreaterThan(b.x)
    expect(k.x).toBeGreaterThan(l.x)
    expect(k.x + k.width).toBeLessThanOrEqual(390) // no sideways scrolling
    expect(await page.evaluate(() => document.getElementById('list').scrollWidth <= document.getElementById('list').clientWidth + 1)).toBe(true)
    await shot(page, 'mobile')
    await boss.focus()
    await page.keyboard.press('ArrowDown')
    await expect(card(page, await focusedId(page))).toHaveAttribute('aria-level', '3')
    await page.keyboard.press('ArrowLeft')
    expect(await focusedId(page)).toBe(claudeId('boss'))
    await page.keyboard.press('ArrowLeft') // fold
    await expect(boss).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('ArrowRight') // unfold
    await expect(boss).toHaveAttribute('aria-expanded', 'true')
    await kid.tap()
    await expect(kid).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#ctxmenu')).toBeHidden()
  })

  test('the big fleet stays an outline with only nearby rows in the DOM', async ({ page }) => {
    await withFleet(page)
    await open(page, { panel: 'full' })
    await page.locator('[data-tv="expand"]').click()
    await expect(page.locator('.tvcount')).toHaveText('1008 of 1008 shown')
    expect(await page.locator('.tv .tnode').count()).toBeLessThan(120)
    await page.locator('#list').evaluate((el) => { el.scrollTop = 20000 })
    await expect(page.locator('.tv .tnode').first()).toBeVisible()
    await shot(page, 'mobile-large')
  })
})
