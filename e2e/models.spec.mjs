// The Models view: model cards that filter, the per-agent treegrid with configured model, route,
// context and flags, the inspector's Models section, and live refresh. Its own fixture home and
// server (it appends to transcripts); never the real ~/.claude or ~/.codex.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import AxeBuilder from '@axe-core/playwright'
import { SHOTS, SECRET, IDS, claudeId, prepareHome, startServer, tmpDir, nextPort } from './helpers.mjs'
import { ENV_SECRET } from '../test/fixtures/make-home.mjs'

const isMobile = (testInfo) => testInfo.project.name === 'mobile'
const mrow = (page, id) => page.locator(`#list .mrow[data-id="${id}"]`)
const card = (page, label) => page.locator('.mcards .mcard', { has: page.locator('.ml', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
const serious = async (page, include) => {
  let axe = new AxeBuilder({ page }).options({ rules: { 'label-content-name-mismatch': { enabled: true } } })
  if (include) axe = axe.include(include)
  const r = await axe.analyze()
  return r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.length} (${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')})`)
}

let s, env
test.beforeAll(async () => {
  env = prepareHome(tmpDir('models'))
  s = await startServer(env, nextPort())
})
test.afterAll(async () => { await s?.stop() })

async function openModels(page) {
  await page.goto(s.url)
  await page.evaluate(() => localStorage.clear())
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await page.locator('#btn-full').click()
  await page.locator('#view-models').click()
  await expect(page.locator('#view-models')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#list .mgrid')).toHaveAttribute('role', 'treegrid')
}

test('cards per model in use; each row shows model now, configured, route, context and flags', async ({ page }, testInfo) => {
  await openModels(page)
  for (const l of ['Opus 5.5 · 1M', 'Sonnet 5.5', 'Haiku 4.5', 'GPT-6.1 Sol']) await expect(card(page, l)).toHaveCount(1)
  await expect(card(page, 'Opus 5.5 · 1M')).toContainText(/\d+ agents · \d+ live/)
  await expect(card(page, 'Opus 5.5 · 1M')).toContainText(/% of 24 h tokens/)

  // A job pinned to an older Opus: replies come from Opus 5.5, it was told Opus 5 (1M).
  const boss = mrow(page, claudeId('boss'))
  await expect(boss.locator('.c-now')).toHaveText('Opus 5.5')
  await expect(boss.locator('.c-cfg')).toContainText('Opus 5 · 1M')
  await expect(boss.locator('.c-cfg')).toHaveAttribute('title', /ANTHROPIC_DEFAULT_OPUS_MODEL = claude-opus-5/)
  await expect(boss.locator('.mflag')).toHaveText(['Mismatch'])
  // Switched models an hour ago, and 85 % of its 1M context used.
  const lead = mrow(page, claudeId('leadBuilding'))
  await expect(lead.locator('.c-changed')).toContainText('Opus 5 → Opus 5.5')
  await expect(lead.locator('.c-ctx')).toContainText('850k / 1M')
  await expect(lead.locator('.c-cfg')).toContainText('high')
  await expect(lead.locator('.mflag')).toHaveText(['Context 85%'])
  // On the pool while the account is personal.
  const pool = mrow(page, claudeId('leadBlocked'))
  await expect(pool.locator('.c-route')).toHaveText('Pool')
  await expect(pool.locator('.mflag')).toHaveText(['Still on pool'])
  // Subagents: a teammate inherits its lead's model; a worker asked for Sonnet.
  await expect(mrow(page, `${claudeId('leadBuilding')}:sub:mate`).locator('.c-cfg')).toHaveText('Inherits')
  await expect(mrow(page, `${claudeId('leadBuilding')}:sub:worker`).locator('.c-now')).toHaveText('Sonnet 5.5')
  await expect(mrow(page, `codex:${IDS.codexRunning}`).locator('.c-route')).toHaveText('Codex')
  // Grouped like Table: project → boss → lead → sub.
  await expect(boss).toHaveAttribute('aria-level', '2')
  await expect(lead).toHaveAttribute('aria-level', '3')
  await expect(mrow(page, `${claudeId('leadBuilding')}:sub:worker`)).toHaveAttribute('aria-level', '4')
  // Resting agents behind a toggle, like Table.
  await expect(mrow(page, claudeId('leadDone'))).toHaveCount(0)
  const resting = page.locator('[data-act="mresting"]')
  await resting.click()
  await expect(resting).toHaveAttribute('aria-pressed', 'true')
  await expect(mrow(page, claudeId('leadDone'))).toHaveCount(1)
  await resting.click()
  await expect(mrow(page, claudeId('leadDone'))).toHaveCount(0)

  expect(await serious(page)).toEqual([])
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-full-models.png` })
  // Nothing secret anywhere: not the providerEnv token, not the tool-output secret.
  const html = await page.content()
  expect(html).not.toContain(ENV_SECRET)
  expect(html).not.toContain(SECRET)
  const api = await (await page.request.get(`${s.url}/api/models`)).text()
  expect(api).not.toContain(ENV_SECRET)
  expect(api).not.toContain(env.AGENTVILLE_CLAUDE_HOME)
})

test('a card filters to its model (toggle, aria-pressed); ancestors stay as context; the order holds', async ({ page }) => {
  await openModels(page)
  const ids = () => page.locator('#list .mrow').evaluateAll((els) => els.map((e) => e.dataset.id))
  const before = await ids()
  await page.waitForTimeout(4500) // two polls: nothing moves
  expect(await ids()).toEqual(before)
  const sonnet = card(page, 'Sonnet 5.5')
  await sonnet.click()
  await expect(sonnet).toHaveAttribute('aria-pressed', 'true')
  await expect(mrow(page, claudeId('leadCi'))).toHaveCount(1)
  await expect(mrow(page, claudeId('soloWaiting'))).toHaveCount(0)
  await expect(mrow(page, claudeId('boss'))).toHaveClass(/ctx/) // its parent, shown dimmed
  await expect(page.locator('[data-act="mclear"]')).toContainText('Sonnet 5.5')
  await sonnet.click()
  await expect(sonnet).toHaveAttribute('aria-pressed', 'false')
  await expect(mrow(page, claudeId('soloWaiting'))).toHaveCount(1)
  expect(await ids()).toEqual(before)
})

test('the inspector adds a Models section: tokens by model and the model history', async ({ page }, testInfo) => {
  await openModels(page)
  await mrow(page, claudeId('leadBuilding')).click()
  const sec = page.locator('#drawer .dmodels')
  await expect(sec).toBeVisible()
  await expect(sec.locator('h4')).toHaveText('Models')
  const rows = sec.locator('.mtable tbody tr')
  await expect(rows.locator('th')).toHaveText(['Opus 5.5', 'Opus 5', 'All'])
  await expect(sec.locator('.mtable thead')).toContainText(/Input\s*Output\s*Cache write\s*Cache read/)
  await expect(sec.locator('.mhist li')).toHaveCount(1)
  await expect(sec.locator('.mhist li').first()).toContainText(/Opus 5 → Opus 5\.5 · 1h ago/)
  await expect(sec).toContainText('850k of 1M (85%)')
  expect(await serious(page, '#drawer')).toEqual([])
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-models-inspector.png` })
  // Other views' inspectors are unchanged.
  if (isMobile(testInfo)) return
  await page.locator('#view-table').click()
  await expect(page.locator('#drawer .dmodels')).toHaveCount(0)
})

test('it refreshes live: a reply on another model shows up without a reload', async ({ page }) => {
  await openModels(page)
  const solo = mrow(page, claudeId('soloTurn'))
  await expect(solo.locator('.c-now')).toHaveText('Opus 5.5')
  const file = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app', `${IDS.soloTurn}.jsonl`)
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'msg_live_1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 }, content: [{ type: 'text', text: 'ok' }] } }) + '\n')
  await expect(solo.locator('.c-now')).toHaveText('Sonnet 5.5', { timeout: 12_000 })
  await expect(solo.locator('.c-changed')).toContainText('Opus 5.5 → Sonnet 5.5')
})

test('V cycles Status → Team → Tree → Table → Models; keys move through the Models rows', async ({ page }, testInfo) => {
  test.skip(isMobile(testInfo), 'keyboard shortcuts are a desktop path')
  await openModels(page)
  await page.locator('#view-table').click()
  await page.locator('body').press('v')
  await expect(page.locator('#view-models')).toHaveAttribute('aria-pressed', 'true')
  const first = page.locator('#list .mgrid .trow:not(.thead)').first()
  await first.focus()
  await first.press('ArrowDown')
  await expect(page.locator('#list .mgrid .trow:not(.thead)').nth(1)).toBeFocused()
  await page.locator('body').press('v')
  await expect(page.locator('#view-status')).toHaveAttribute('aria-pressed', 'true')
})
