// Account menu and switch, against the backend's fake Claude home, fake `claude` and fake
// Anthropic API only (test/fixtures/account-home.mjs, fake-anthropic.mjs). Never the real ~/.claude,
// Keychain, CLI or network. One server per test: a switch changes the fake home.
import { test, expect } from './fixtures.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { SHOTS, nextPort, startServer, tmpDir } from './helpers.mjs'
import { makeAccountHome } from '../test/fixtures/account-home.mjs'
import { fakeAnthropic, TOKEN_MARK } from '../test/fixtures/fake-anthropic.mjs'

test.skip(process.platform === 'win32', 'account switching is not supported on Windows')

async function serve(fake = {}) {
  const root = tmpDir('account')
  const home = makeAccountHome(root)
  const s = await startServer({ ...home.env, AGENTVILLE_DATA_DIR: path.join(root, 'data'), ...fake }, nextPort())
  return { ...s, home, respawns: () => (fs.existsSync(home.log) ? fs.readFileSync(home.log, 'utf8') : '').split('\n').filter((l) => l.includes('"respawn"')) }
}
const sheet = (page) => page.locator('#acct')
const menu = (page) => page.locator('#pop-account')
/** The pre-accounts path: the menu's "Claude login" row switches the pool to the stored login. */
async function openPersonal(page) {
  await page.locator('#btn-account').click()
  await menu(page).getByRole('button', { name: 'Switch to your personal account' }).click()
}

test('switch to personal: the plan, per-job results, the top bar, then Undo', async ({ page }, testInfo) => {
  const s = await serve({ FAKE_REPLY: 'ok' })
  try {
    await page.goto(s.url)
    const btn = page.locator('#btn-account')
    await expect(btn).toHaveText(/Pool/)
    await btn.click()
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
    await expect(menu(page).locator('.acct-row.on')).toContainText('Pool')
    await menu(page).getByRole('button', { name: 'Switch to your personal account' }).click()
    await expect(menu(page)).toBeHidden()
    await expect(sheet(page).locator('h2')).toHaveText('Switch to your personal account')
    await expect(sheet(page).locator('h2')).toBeFocused()
    // Exactly what will happen: the two running jobs (the finished one is left alone).
    await expect(sheet(page)).toContainText('2 background jobs restart with full context on your personal account')
    await expect(sheet(page).locator('.manual li')).toHaveCount(2)
    await expect(sheet(page)).toContainText('aaaa0001')
    await expect(sheet(page)).not.toContainText('aaaa0003')
    expect(s.respawns()).toHaveLength(0) // opening the sheet changes nothing
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-account-confirm.png` })

    await sheet(page).getByRole('button', { name: 'Switch to Personal' }).click()
    await expect(sheet(page).locator('h2')).toHaveText('Now on your personal account', { timeout: 20000 })
    await expect(sheet(page).locator('.acct-results li.st-respawned')).toHaveCount(2)
    await expect(sheet(page)).toContainText('verified: reply seen')
    await expect(btn).toHaveText(/Personal/)
    expect(s.respawns()).toHaveLength(2)
    // Never a token, gateway URL or env value.
    const html = await page.content()
    for (const secret of [s.home.TOKEN, 'gateway.example', 'ANTHROPIC_']) expect(html).not.toContain(secret)
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-account-results.png` })

    await sheet(page).getByRole('button', { name: 'Undo' }).click()
    await expect(sheet(page).locator('h2')).toHaveText('Settings restored: Pool')
    await expect(sheet(page).getByRole('button', { name: 'Undo' })).toHaveCount(0)
    await expect(btn).toHaveText(/Pool/)
    expect(fs.readFileSync(s.home.files.settings, 'utf8')).toContain(s.home.TOKEN) // the pool settings are back
    await sheet(page).getByRole('button', { name: 'Done' }).click()
    await expect(sheet(page)).not.toBeVisible()
    await expect(btn).toBeFocused()
  } finally { await s.stop() }
})

test('a failed first respawn rolls everything back and says so', async ({ page }) => {
  const s = await serve({ FAKE_RESPAWN_FAIL: '1' })
  try {
    await page.goto(s.url)
    await openPersonal(page)
    await sheet(page).getByRole('button', { name: 'Switch to Personal' }).click()
    await expect(sheet(page).locator('h2')).toHaveText('Nothing changed: the switch was rolled back', { timeout: 20000 })
    await expect(sheet(page).locator('li.st-failed')).toContainText('Respawn failed (exit 7)')
    await expect(sheet(page).locator('li.st-skipped')).toContainText('Not attempted after the first respawn failed')
    await expect(sheet(page).getByRole('button', { name: 'Undo' })).toHaveCount(0) // nothing to undo
    await expect(page.locator('#btn-account')).toHaveText(/Pool/)
    expect(s.respawns()).toHaveLength(1)
  } finally { await s.stop() }
})

test('a personal login the server cannot see is a tip with Copy; the switch still runs', async ({ page, context }) => {
  const s = await serve({ FAKE_AUTH: 'gateway' })
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    await page.goto(s.url)
    await openPersonal(page)
    const tip = sheet(page).locator('#acct-login')
    await expect(tip).toContainText('claude auth login')
    await tip.getByRole('button', { name: 'Copy' }).click()
    await expect(tip.getByRole('button', { name: /Copied|Couldn't copy/ })).toBeVisible()
    // A stale preview (the plan token expired) is explained, and the new plan is shown.
    await page.route('**/api/account/switch', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This preview has expired. Open it again.' }) }), { times: 1 })
    await sheet(page).getByRole('button', { name: 'Switch to Personal' }).click()
    await expect(sheet(page).locator('#acct-err')).toHaveText("Couldn't switch: This preview has expired. Open it again.")
    await expect(sheet(page).getByRole('button', { name: 'Switch to Personal' })).toBeEnabled()
    await sheet(page).getByRole('button', { name: 'Switch to Personal' }).click()
    await expect(sheet(page).locator('h2')).toHaveText('Now on your personal account', { timeout: 20000 })
  } finally { await s.stop() }
})

test('Add account without saving first: the login it saves straight away shows its usage', async ({ page }) => {
  const api = await fakeAnthropic({ A: { email: 'work@example.com', five: 12, week: 40 } })
  const s = await serve({ ...api.env })
  fs.writeFileSync(path.join(s.home.home, '.credentials.json'), api.cred('A'), { mode: 0o600 })
  try {
    await page.goto(s.url)
    await page.locator('#btn-account').click()
    await menu(page).getByRole('button', { name: /Add account/ }).click()
    const work = menu(page).locator('.acct-row', { hasText: 'work@example.com' })
    await expect(work.locator('.ubar')).toHaveCount(2)
    await expect(work).not.toContainText('Usage not checked')
  } finally { await s.stop(); await api.close() }
})

test('saved accounts: save the login, add another, usage bars, switch account to account', async ({ page }, testInfo) => {
  const api = await fakeAnthropic({ A: { email: 'work@example.com', five: 12, week: 40 }, B: { email: 'side@example.com', five: 75, week: 93 } })
  const s = await serve({ ...api.env, FAKE_REPLY: 'ok' })
  const credFile = path.join(s.home.home, '.credentials.json')
  const a = api.cred('A'), b = api.cred('B')
  fs.writeFileSync(credFile, a, { mode: 0o600 })
  try {
    await page.goto(s.url)
    const btn = page.locator('#btn-account')
    await expect(btn).toHaveText(/Pool/)
    await btn.click()
    // The stored login isn't saved yet: save it, and it becomes a row with its usage.
    await menu(page).getByRole('button', { name: 'Save' }).click()
    const work = menu(page).locator('.acct-row', { hasText: 'work@example.com' })
    await expect(work.locator('.ubar')).toHaveCount(2)
    await expect(work.locator('.ubar').first()).toContainText(/12% · resets in 2h/)
    await expect(work.locator('[role="meter"]').nth(1)).toHaveAttribute('aria-valuenow', '40')

    // Add a second account: step 1 opens a terminal, step 2 saves the new login and puts A back.
    await menu(page).getByRole('button', { name: /Add account/ }).click()
    await expect(menu(page).locator('.acct-add')).toContainText('claude auth login')
    await expect(menu(page).locator('#acct-add-label')).toBeFocused()
    fs.writeFileSync(credFile, b, { mode: 0o600 }) // the user signs in as B in that terminal
    await menu(page).locator('#acct-add-label').fill('Side')
    await menu(page).getByRole('button', { name: "I've logged in" }).click()
    const side = menu(page).locator('.acct-row', { hasText: 'Side' })
    await expect(side).toContainText('side@example.com · Max')
    await expect(side.locator('.ubar.hi')).toHaveCount(1) // 93% weekly reads as nearly used up
    expect(fs.readFileSync(credFile, 'utf8')).toBe(a) // adding never changes Claude's login
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-account-menu.png` })

    // Rename inline.
    await side.getByRole('button', { name: 'Rename Side' }).click()
    await menu(page).locator('#acct-rename').fill('Side job')
    await menu(page).locator('#acct-rename').press('Enter')
    await expect(menu(page).locator('.acct-row', { hasText: 'Side job' })).toBeVisible()

    // Switch to it: the confirm sheet names it, then the top bar does.
    await menu(page).getByRole('button', { name: 'Switch to Side job' }).click()
    await expect(sheet(page).locator('h2')).toHaveText('Switch to Side job')
    await expect(sheet(page)).toContainText("Claude Code's login becomes Side job")
    await sheet(page).getByRole('button', { name: 'Switch to Side job' }).click()
    await expect(sheet(page).locator('h2')).toHaveText('Now on Side job', { timeout: 20000 })
    await expect(btn).toHaveText(/Side job/)
    expect(fs.readFileSync(credFile, 'utf8')).toBe(b)
    expect(s.respawns()).toHaveLength(2)
    await sheet(page).getByRole('button', { name: 'Done' }).click()

    await btn.click()
    await expect(menu(page).locator('.acct-row.on')).toContainText('Side job')
    await expect(menu(page).locator('.acct-row', { hasText: 'Side job' }).getByRole('button', { name: /Remove/ })).toHaveCount(0) // the signed-in one can't be removed
    const html = await page.content()
    for (const secret of [TOKEN_MARK, s.home.TOKEN, 'gateway.example']) expect(html).not.toContain(secret)
  } finally { await s.stop(); await api.close() }
})

test('quarantine accounts: mark one, mark the work Wi-Fi, and it can no longer be switched to there', async ({ page }, testInfo) => {
  const api = await fakeAnthropic({ A: { email: 'work@example.com', five: 12, week: 40 }, B: { email: 'side@example.com', five: 20, week: 30 } })
  const s = await serve({ ...api.env, AGENTVILLE_NETWORK_ID: 'gw:0a:0b:0c:0d:0e:0f' }) // a fake network
  const credFile = path.join(s.home.home, '.credentials.json')
  fs.writeFileSync(credFile, api.cred('A'), { mode: 0o600 })
  try {
    await page.goto(s.url)
    await page.locator('#btn-account').click()
    await menu(page).getByRole('button', { name: 'Save' }).click()
    await menu(page).getByRole('button', { name: /Add account/ }).click()
    fs.writeFileSync(credFile, api.cred('B'), { mode: 0o600 })
    await menu(page).locator('#acct-add-label').fill('Side')
    await menu(page).getByRole('button', { name: "I've logged in" }).click()
    const side = menu(page).locator('.acct-row', { hasText: 'Side' })
    await expect(side).toBeVisible()
    await expect(menu(page).locator('.acct-net')).toContainText('Not the work Wi-Fi · quarantine accounts come first')

    await side.getByRole('button', { name: 'Make Side a quarantine account' }).click()
    await expect(side.locator('.acct-badge.q')).toHaveText('Quarantine')
    await expect(side.getByRole('button', { name: 'Switch to Side' })).toBeVisible() // fine off the work Wi-Fi

    await menu(page).getByRole('button', { name: 'This is the work Wi-Fi' }).click()
    await expect(menu(page).locator('.acct-net')).toContainText('Work Wi-Fi · quarantine accounts are off limits here')
    await expect(side).toContainText('Not on the work Wi-Fi')
    await expect(side.getByRole('button', { name: 'Switch to Side' })).toHaveCount(0)
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-account-quarantine.png` })

    await side.getByRole('button', { name: 'Make Side a regular account' }).click()
    await expect(side.locator('.acct-badge.q')).toHaveCount(0)
    await expect(side.getByRole('button', { name: 'Switch to Side' })).toBeVisible()
    await menu(page).getByRole('button', { name: 'Not the work Wi-Fi' }).click()
    await expect(menu(page).getByRole('button', { name: 'This is the work Wi-Fi' })).toBeVisible()
  } finally { await s.stop(); await api.close() }
})
