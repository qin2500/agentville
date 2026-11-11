// Important agents are never hidden or folded away automatically: not by the Resting toggle, a
// "+N resting" line, a folded team, the Solo caret, the wide Team's quiet strip, Tree's pills, the
// village's resting-home cap or quiet projects. An explicit hide still wins, and unmarking restores
// the folding. A synthetic fleet with generic names, served by rewriting /api/agents in flight; the
// overrides it carries live in the test (PATCH /api/overrides is answered here too).
import fs from 'node:fs'
import { test, expect } from './fixtures.mjs'

const SHOT_DIR = process.env.IMPORTANT_SHOTS || '/tmp/vshots'
fs.mkdirSync(SHOT_DIR, { recursive: true })
const shot = (page, ti, name) => page.screenshot({ path: `${SHOT_DIR}/important-${name}-${ti.project.name}.png` })
const row = (page, id) => page.locator(`#list .row[data-id="${id}"]`)

// A lead with one awake worker, three resting ones and an Important job under it that stopped; a
// fully resting old team with an Important member; eight resting solos and one Important stopped
// solo, alone in a project nobody has touched for three days.
function fleet(tpl, now, st) {
  const out = []
  const mk = (id, o) => ({ ...tpl, id, name: id, title: '', reason: '', prs: [], changes: null, overrides: null, hidden: st.hidden.has(id), important: st.important.has(id), roleSource: 'detected', severity: null, prompt: null, since: now - 120e3, lastActivityAt: now - 120e3, childIds: [], resume: 'claude attach abc12345', kind: 'job', live: true, ask: null, neverStarted: false, reopened: null, messageWhy: '', self: false, ...o })
  out.push(mk('lead-a', { name: 'Lead Alpha', role: 'lead', project: 'project-a', bucket: 'building', parentId: null }))
  out.push(mk('lead-a-w0', { name: 'Worker A0', role: 'sub', kind: 'subagent', project: 'project-a', parentId: 'lead-a', bucket: 'building' }))
  for (let w = 1; w <= 3; w++) out.push(mk(`lead-a-w${w}`, { name: `Worker A${w}`, role: 'sub', kind: 'subagent', project: 'project-a', parentId: 'lead-a', bucket: 'resting', reason: 'Done', live: false }))
  out.push(mk('pinned-job', { name: 'Pinned Job', role: 'sub', project: 'project-a', parentId: 'lead-a', bucket: 'resting', reason: 'Closed', live: false, lastActivityAt: now - 3 * 3600e3 }))
  out.push(mk('old-lead', { name: 'Old Lead', role: 'lead', project: 'project-b', bucket: 'resting', reason: 'Done', live: false, parentId: null, lastActivityAt: now - 2 * 3600e3 }))
  out.push(mk('old-w0', { name: 'Old Worker', role: 'sub', kind: 'subagent', project: 'project-b', parentId: 'old-lead', bucket: 'resting', reason: 'Done', live: false }))
  out.push(mk('old-keeper', { name: 'Old Keeper', role: 'sub', project: 'project-b', parentId: 'old-lead', bucket: 'resting', reason: 'Closed', live: false }))
  out.push(mk('awake-solo', { name: 'Awake Solo', role: 'solo', kind: 'session', project: 'project-b', parentId: null, bucket: 'building' }))
  for (let s = 0; s < 8; s++) out.push(mk(`rest-solo-${s}`, { name: `Resting Solo ${s}`, role: 'solo', kind: 'session', project: 'project-a', parentId: null, bucket: 'resting', reason: 'Quiet for over a day', live: false, lastActivityAt: now - (30 + s) * 3600e3 }))
  out.push(mk('keeper', { name: 'Keeper Solo', role: 'solo', project: 'project-quiet', parentId: null, bucket: 'resting', reason: 'Closed', live: false, lastActivityAt: now - 72 * 3600e3 }))
  for (const a of out) a.childIds = out.filter((k) => k.parentId === a.id).map((k) => k.id)
  return out
}
const PINNED = ['keeper', 'pinned-job', 'old-keeper']

async function withFleet(page) {
  const st = { important: new Set(PINNED), hidden: new Set() }
  await page.route('**/api/agents*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.agents = fleet(json.agents[0], json.serverTime, st)
    json.counts = { building: 3, stalled: 0, waiting: 0, resting: json.agents.length - 3, errors: 0, prompts: 0, continuable: 0 }
    await route.fulfill({ response, json })
  })
  await page.route('**/api/overrides/**', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop())
    const body = route.request().postDataJSON()
    for (const k of ['important', 'hidden']) if (k in body) { if (body[k]) st[k].add(id); else st[k].delete(id) }
    await route.fulfill({ json: { id, override: {} } })
  })
  return st
}
async function open(page, { panel = 'docked', view = 'team', query = '' } = {}) {
  const st = await withFleet(page)
  await page.goto(`/${query}`)
  await page.evaluate(([p, v]) => {
    localStorage.clear()
    localStorage.setItem('va.panel', JSON.stringify(p))
    localStorage.setItem('va.view', JSON.stringify({ docked: v, full: v }))
  }, [panel, view])
  await page.goto(`/${query}`)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  return st
}

test('docked Team: Important agents stay as rows inside folded teams, "+N resting" and the Solo fold', async ({ page }, ti) => {
  await open(page)
  // Top level: Lead Alpha folded, the Solo fold closed. Pinned Job shows under the folded lead.
  await expect(row(page, 'lead-a')).toBeVisible()
  await expect(page.locator('#list .chev[data-id="lead-a"]')).toHaveAttribute('aria-expanded', 'false')
  await expect(row(page, 'pinned-job')).toBeVisible()
  await expect(row(page, 'pinned-job')).toContainText('Stopped · Closed')
  await expect(row(page, 'pinned-job')).toContainText('Lead Alpha') // "↳ Lead Alpha"
  await expect(row(page, 'old-keeper')).toBeVisible()
  await expect(row(page, 'lead-a-w1')).toHaveCount(0)
  // Solo: resting ones folded behind the caret, the Important one still a row.
  await expect(page.locator('#list .chev[data-id="__solo"]')).toHaveAttribute('aria-label', 'Show 8 resting solo agents')
  await expect(row(page, 'keeper')).toBeVisible()
  await expect(row(page, 'rest-solo-0')).toHaveCount(0)
  await shot(page, ti, 'docked-team')
  // Open the lead: Pinned Job is its own row, not in "+3 resting".
  await page.locator('#list .chev[data-id="lead-a"]').click()
  await expect(row(page, 'lead-a-w0')).toBeVisible()
  await expect(row(page, 'pinned-job')).toBeVisible()
  await expect(page.locator('#list .more button[data-id="lead-a"]')).toHaveText('+ 3 resting')
})

test('docked Status: the Resting toggle stays closed and Important resting agents still show', async ({ page }, ti) => {
  await open(page, { view: 'status' })
  const tog = page.locator('#list .resting-toggle')
  await expect(tog).toHaveAttribute('aria-expanded', 'false')
  for (const id of PINNED) await expect(row(page, id)).toBeVisible()
  await expect(row(page, 'rest-solo-0')).toHaveCount(0)
  await expect(row(page, 'keeper')).toContainText('Stopped · Closed')
  await shot(page, ti, 'docked-status')
  await tog.click()
  await expect(row(page, 'rest-solo-0')).toBeVisible()
})

test('wide Team: Important agents are rows, never in "+N resting" or the Quiet strip', async ({ page }, ti) => {
  await open(page, { panel: 'full' })
  for (const id of PINNED) await expect(row(page, id)).toBeVisible()
  await expect(page.locator('#list .card .restcount').first()).toBeVisible()
  await expect(page.locator('#list [data-act="goto"][data-id="old-lead"]')).toHaveCount(0) // Old Lead is a card, not a Quiet chip
  await expect(row(page, 'old-lead')).toBeVisible()
  await expect(page.locator('#list .card:has(.row[data-id="lead-a"]) .restcount')).toHaveText('+3 resting')
  await shot(page, ti, 'wide-team')
})

test('Tree: Important agents are not behind "+N resting" pills', async ({ page }, ti) => {
  await open(page, { panel: 'full', view: 'tree' })
  const node = (id) => page.locator(`.tv [role="treeitem"][data-id="${id}"]`)
  await expect(node('lead-a')).toBeVisible()
  for (const id of PINNED) await expect(node(id)).toHaveCount(1)
  await expect(node('keeper')).toContainText('Stopped · Closed')
  await expect(node('lead-a-w1')).toHaveCount(0)
  await expect(node('rest-solo-0')).toHaveCount(0)
  await shot(page, ti, 'tree')
})

test('village: Important agents keep their own house and villager, quiet project included', async ({ page }, ti) => {
  await open(page, { panel: 'collapsed', view: 'team', query: '?view=iso&night=0&debug' })
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await page.waitForFunction(() => (window.villageDebug?.().homes?.length || 0) > 0)
  const d = await page.evaluate(() => window.villageDebug())
  for (const id of PINNED) {
    expect(d.homes).toContain(id)
    expect(d.outdoors).toContain(id)
  }
  expect(d.villages.map((v) => v.name)).toContain('project-quiet')
  expect(d.outdoors).not.toContain('rest-solo-0')
  // The resting-home cap (2 per project) still applies to everyone else.
  expect(d.homes.filter((id) => id.startsWith('rest-solo-')).length).toBeLessThanOrEqual(2)
  // Close up on the stopped Important solo: its villager stands at its door, starred and faded.
  await page.evaluate(() => { location.hash = '#agent=keeper' })
  await page.locator('#cv').focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('+')
  await page.waitForTimeout(600)
  await shot(page, ti, 'village')
})

test('an explicit hide still hides an Important agent; unmarking Important restores the folding', async ({ page }, ti) => {
  const st = await open(page, { panel: 'full' })
  // Unmark Pinned Job from its inspector: it folds back into its lead's "+N resting".
  await row(page, 'pinned-job').click()
  const imp = page.locator('#drawer [data-act="important"]')
  await expect(imp).toHaveText('★ Important')
  await expect(page.locator('#drawer .stopnote')).toContainText('Stopped · Closed')
  await imp.click()
  await expect(imp).toHaveText('☆ Mark important')
  await expect.poll(() => st.important.has('pinned-job')).toBe(false)
  await page.keyboard.press('Escape')
  await expect(row(page, 'pinned-job')).toHaveCount(0)
  await expect(page.locator('#list .card:has(.row[data-id="lead-a"]) .restcount')).toHaveText('+4 resting')
  // Hide Keeper Solo (still Important): it is gone from every view.
  await row(page, 'keeper').click()
  await page.locator('#drawer [data-act="hide"]').click()
  await expect.poll(() => st.hidden.has('keeper')).toBe(true)
  await expect(row(page, 'keeper')).toHaveCount(0)
  await expect(page.locator('#btn-hidden')).toHaveText('1 hidden')
  await shot(page, ti, 'after-hide-unmark')
  // Docked too: neither shows, and Old Keeper (still Important) does.
  await page.evaluate(() => localStorage.setItem('va.panel', '"docked"'))
  await page.reload()
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await expect(row(page, 'old-keeper')).toBeVisible()
  await expect(row(page, 'keeper')).toHaveCount(0)
  await expect(row(page, 'pinned-job')).toHaveCount(0)
})

test('Table and Models: "Hide resting" (the default) keeps Important agents', async ({ page }) => {
  await open(page, { panel: 'full', view: 'table' })
  const tr = (id) => page.locator(`#list .trow[data-id="${id}"]`)
  for (const id of PINNED) await expect(tr(id)).toBeVisible()
  await expect(tr('keeper')).toContainText('Stopped · Closed')
  await expect(tr('rest-solo-0')).toHaveCount(0)
  await expect(page.locator('#list [data-act="tresting"]')).toHaveText('Show resting (13)')
  await page.locator('#view-models').click()
  const mr = (id) => page.locator(`#list .mrow[data-id="${id}"]`)
  for (const id of PINNED) await expect(mr(id)).toBeVisible()
  await expect(mr('rest-solo-0')).toHaveCount(0)
})
