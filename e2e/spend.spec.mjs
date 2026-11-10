// Token spend panel and automatic account switching, against a fake Claude home, fake `claude` and
// fake Anthropic API only. Never the real ~/.claude, Keychain, CLI or network.
import { test, expect } from './fixtures.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { SHOTS, nextPort, startServer, tmpDir } from './helpers.mjs'
import { makeAccountHome } from '../test/fixtures/account-home.mjs'
import { fakeAnthropic, UUID, TOKEN_MARK } from '../test/fixtures/fake-anthropic.mjs'

test.skip(process.platform === 'win32', 'accounts are not supported on Windows')

let n = 0
/** Append one assistant reply with usage to a fake transcript, timestamped now. */
function spendTokens(home, tokens) {
  const file = path.join(home.home, 'projects', '-w', 'aaaa0001-0000-4000-8000-000000000000.jsonl')
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { id: `msg_e2e_${++n}`, usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 }, content: [] } }) + '\n')
}
async function serve(api, extra = {}) {
  const root = tmpDir('spend')
  const home = makeAccountHome(root)
  const s = await startServer({ ...home.env, ...api.env, AGENTVILLE_DATA_DIR: path.join(root, 'data'), ...extra }, nextPort())
  const call = async (method, p, body) => {
    const r = await fetch(`${s.url}${p}`, { method, headers: { origin: s.url, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return r.json()
  }
  return { ...s, home, call, credFile: path.join(home.home, '.credentials.json') }
}

test('the spend panel shows the last 60 minutes and updates by itself', async ({ page }, testInfo) => {
  const api = await fakeAnthropic({})
  const s = await serve(api)
  try {
    spendTokens(s.home, 1200)
    await page.goto(s.url)
    const btn = page.locator('#btn-spend')
    // The total includes cache reads: 1,200 input + 5,000 cache reads.
    await expect(btn.locator('b')).toHaveText('6.2k')
    await expect(btn).toHaveAttribute('aria-label', /^6\.2k\/60m: token spend, 6 thousand tokens in the last 60 minutes/)
    spendTokens(s.home, 3400) // no click: the next poll picks it up
    await expect(btn.locator('b')).toHaveText('15k', { timeout: 12000 })
    await btn.click()
    const pop = page.locator('#pop-spend')
    await expect(pop.locator('.sp-nums .head').nth(1)).toContainText('15k')
    await expect(pop.locator('svg.spark')).toHaveAttribute('aria-label', /Tokens per minute over the past hour/)
    await expect(pop).toContainText('On the pool')
    await expect(pop.locator('.sp-nums .head').nth(0)).toContainText('Last 7 days')
    await expect(pop.locator('.sp-nums .head').nth(1)).toContainText('Last 24 hours')
    await expect(pop.locator('[data-sp-range]')).toHaveCount(0)
    await expect(pop.locator('.sp-head')).toContainText(/Last hour 15k tokens/)
    // The breakdown is collapsed until asked for, then splits each total by kind.
    const more = pop.locator('[data-sp-detail]')
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(pop.locator('.sp-table')).toHaveCount(0)
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(more).toBeFocused()
    const table = pop.locator('.sp-table')
    await expect(table.locator('thead')).toContainText(/Last hour\s*24 h\s*7 days/)
    await expect(table.locator('tr', { hasText: 'Input' }).locator('td')).toHaveText(['4.6k', '4.6k', '4.6k'])
    await expect(table.locator('tr', { hasText: 'Cache reads' }).locator('td')).toHaveText(['10k', '10k', '10k'])
    await expect(table.locator('tr.total td')).toHaveText(['15k', '15k', '15k'])
    await expect(more).toHaveAttribute('aria-expanded', 'true', { timeout: 7000 }) // survives the 5 s refresh
    // Hover any point on the line: a readout with that minute's time and tokens.
    const chart = pop.locator('.sp-chart'), box = await chart.boundingBox()
    await page.mouse.move(box.x + box.width - 2, box.y + 20)
    await expect(pop.locator('.sp-tip')).toBeVisible()
    await expect(pop.locator('.sp-tip')).toContainText(/ · [\d.,k]+ tokens/)
    await chart.focus()
    await page.keyboard.press('Home')
    await expect(pop.locator('.sp-tip')).toContainText(/0 tokens/)
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-spend.png` })
    // A shortcut from usage to the Models view in the agent panel.
    await pop.locator('[data-sp-models]').click()
    await expect(pop).toBeHidden()
    await expect(page.locator('#view-models')).toHaveAttribute('aria-pressed', 'true')
  } finally { await s.stop(); await api.close() }
})

test('an account that runs out is switched automatically, with a banner and Undo', async ({ page }) => {
  const api = await fakeAnthropic({
    A: { email: 'a@example.com', five: 99, week: 10 },
    B: { email: 'b@example.com', five: 10, week: 10, fiveResetsIn: 3 * 3600e3 },
    C: { email: 'c@example.com', five: 20, week: 10, fiveResetsIn: 3600e3 },
  })
  const s = await serve(api, { AGENTVILLE_SAMPLE_MS: '1000' })
  try {
    const creds = { A: api.cred('A'), B: api.cred('B'), C: api.cred('C') }
    fs.writeFileSync(s.credFile, creds.A)
    await s.call('POST', '/api/accounts/capture', {})
    for (const k of ['B', 'C']) {
      await s.call('POST', '/api/accounts/add/start', {})
      fs.writeFileSync(s.credFile, creds[k])
      await s.call('POST', '/api/accounts/add/finish', {})
    }
    await page.goto(s.url)
    await expect(page.locator('#btn-account')).toHaveText(/Pool/)
    // The user moves to A, which is already out: the sampler moves everyone to C (soonest reset).
    const r = await s.call('POST', '/api/account/switch', { to: UUID.A, confirm: (await s.call('GET', '/api/account')).confirm })
    expect(r.restored).toBe(false)
    const toast = page.locator('#toast')
    await expect(toast).toContainText('Switched automatically to c@example.com', { timeout: 20000 })
    await expect(toast).toContainText('5-hour limit reached')
    await expect(page.locator('#btn-account')).toHaveText(/c@example\.com/, { timeout: 10000 })
    expect(fs.readFileSync(s.credFile, 'utf8')).toBe(creds.C)
    await page.locator('#btn-spend').click()
    await expect(page.locator('#pop-spend')).toContainText('a@example.com → c@example.com')
    await expect(page.locator('#pop-spend input[data-sp-auto]')).toBeChecked()
    await page.keyboard.press('Escape')
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(toast).toContainText('Account settings restored')
    await expect(page.locator('#btn-account')).toHaveText(/a@example\.com/, { timeout: 10000 })
    expect(fs.readFileSync(s.credFile, 'utf8')).toBe(creds.A)
    expect(await page.content()).not.toContain(TOKEN_MARK)
  } finally { await s.stop(); await api.close() }
})

test('the projection details: the blended 5-hour pace, the capped weekly estimate, and the binding window in the header', async ({ page }, testInfo) => {
  const api = await fakeAnthropic({})
  const s = await serve(api)
  try {
    const now = Date.now(), min = 60e3, h = 3600e3
    let projection = {
      account: 'acct', saved: true, at: now,
      fiveHour: { used: 62, state: 'runsOut', at: now + 25 * min, resetsAt: now + 4 * h, perHour: 90, perHourRecent: 114.2, perHourAvg: 65.3 },
      weekly: { used: 17, state: 'runsOut', at: now + 15 * h, resetsAt: now + 6 * 24 * h, perHour: 23.4, ratio: 0.26, ratioFrom: 'samples', basis: 'flatOut', average: { state: 'lasts', perHour: 0.6 } },
      binding: { window: 'fiveHour', state: 'runsOut', at: now + 25 * min },
      next: { to: 'x', label: 'c@example.com' },
    }
    // The real spend numbers, with this projection (no account or usage endpoint involved).
    await page.route('**/api/spend*', async (route) => {
      const res = await route.fetch()
      await route.fulfill({ response: res, json: { ...(await res.json()), projection } })
    })
    await page.goto(s.url)
    const btn = page.locator('#btn-spend')
    await expect(btn.locator('.sp-proj')).toContainText(/5h out ≈ \d{1,2}:\d\d [ap]m/)
    await expect(btn).toHaveAttribute('aria-label', /Weekly: At this pace, earliest ≈/)
    await btn.click()
    const pop = page.locator('#pop-spend')
    await expect(pop.locator('[data-sp-five]')).toContainText(/Runs out ≈ .+ \(resets .+\)/)
    await expect(pop.locator('[data-sp-five]')).toContainText('62% used')
    await expect(pop.locator('[data-sp-five-why]')).toHaveText('At 90%/h: 114%/h over the last 30 min, 65%/h on average this window.')
    await expect(pop.locator('[data-sp-week]')).toContainText(/At this pace, earliest ≈ .+/)
    await expect(pop.locator('[data-sp-week]')).toContainText('17% used')
    await expect(pop.locator('[data-sp-week-why]')).toHaveText("If every 5-hour window is used in full (each ≈ 26% of the week). At this week's average (0.6%/h): lasts until the reset.")
    await expect(pop.locator('[data-sp-next]')).toHaveText('Then auto-switches to c@example.com.')
    await expect(pop).toContainText('Times assume the agents keep going.')
    await pop.locator('#sp-proj-h').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-projection.png` })

    // The 5-hour window lasts, but the week runs out before its reset: the header says so.
    projection = { ...projection,
      fiveHour: { ...projection.fiveHour, state: 'lasts', at: undefined, perHour: 10, perHourRecent: 12, perHourAvg: 8 },
      weekly: { ...projection.weekly, used: 97, at: now + 70 * min, ratioFrom: 'default', ratio: 0.25, average: null },
      binding: { window: 'weekly', state: 'runsOut', at: now + 70 * min }, next: null }
    await expect(btn.locator('.sp-proj')).toContainText(/week out ≈ \d{1,2}:\d\d [ap]m/, { timeout: 12000 })
    await expect(pop.locator('[data-sp-five]')).toContainText('Lasts until the reset at')
    await expect(pop.locator('[data-sp-week-why]')).toHaveText('If every 5-hour window is used in full (each assumed ≈ 25% of the week).')
    await expect(pop.locator('[data-sp-next]')).toHaveCount(0)
  } finally { await s.stop(); await api.close() }
})
