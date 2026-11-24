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
/** Choose an item from a saved account row's right-click menu. */
async function rowMenu(page, row, item) {
  await row.click({ button: 'right' })
  await page.locator('#acctctx').getByRole('menuitem', { name: item, exact: true }).click()
}
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
    await rowMenu(page, side, 'Rename')
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
    await expect(menu(page).locator('.acct-row', { hasText: 'Side job' }).getByRole('button', { name: /Remove/ })).toHaveCount(0)
    await menu(page).locator('.acct-row', { hasText: 'Side job' }).click({ button: 'right' }) // the signed-in one can't be removed
    await expect(page.locator('#acctctx').getByRole('menuitem', { name: 'Remove' })).toHaveCount(0)
    await page.keyboard.press('Escape')
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

    await rowMenu(page, side, 'Quarantine')
    await expect(side.locator('.acct-badge.q')).toHaveText('Quarantine')
    await expect(side.getByRole('button', { name: 'Switch to Side' })).toBeVisible() // fine off the work Wi-Fi

    await menu(page).getByRole('button', { name: 'This is the work Wi-Fi' }).click()
    await expect(menu(page).locator('.acct-net')).toContainText('Work Wi-Fi · quarantine accounts are off limits here')
    await expect(side).toContainText('Not on the work Wi-Fi')
    await expect(side.getByRole('button', { name: 'Switch to Side' })).toHaveCount(0)
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-account-quarantine.png` })

    await rowMenu(page, side, 'Make regular')
    await expect(side.locator('.acct-badge.q')).toHaveCount(0)
    await expect(side.getByRole('button', { name: 'Switch to Side' })).toBeVisible()
    await menu(page).getByRole('button', { name: 'Not the work Wi-Fi' }).click()
    await expect(menu(page).getByRole('button', { name: 'This is the work Wi-Fi' })).toBeVisible()
  } finally { await s.stop(); await api.close() }
})

// The account row menu and hover, against a mocked accounts API (no real accounts, Keychain or network).
test('account rows: hover highlight, right-click menu, Low priority sends the PATCH and shows the badge', async ({ page }) => {
  const accounts = [
    { id: 'A', label: 'Work', email: 'work@example.com', subscriptionType: 'max', quarantine: false, lowPriority: false, active: true, signedIn: true },
    { id: 'B', label: 'Side', email: 'side@example.com', subscriptionType: 'pro', quarantine: false, lowPriority: false, active: false, signedIn: false },
  ]
  const patches = []
  await page.route('**/api/accounts', (route) => route.fulfill({ json: { active: 'A', pool: { available: false }, login: { id: 'A', present: true }, accounts, network: null, autoSwitch: null } }))
  await page.route('**/api/accounts/usage*', (route) => route.fulfill({ json: { accounts: [] } }))
  await page.route('**/api/accounts/B', async (route) => {
    const body = route.request().postDataJSON()
    patches.push({ method: route.request().method(), body })
    Object.assign(accounts[1], body)
    await route.fulfill({ json: { ok: true } })
  })
  const dir = '/tmp/va-acct-menu'
  fs.mkdirSync(dir, { recursive: true })
  const s = await startServer({ AGENTVILLE_DATA_DIR: tmpDir('acct-menu') }, nextPort())
  try {
    await page.goto(s.url)
    await page.locator('#btn-account').click()
    const row = menu(page).locator('.acct-row', { hasText: 'Side' })
    await expect(row).toBeVisible()
    await expect(row.getByRole('button', { name: /^(Quarantine|Rename|Remove)/ })).toHaveCount(0) // nothing inline any more

    await page.mouse.move(5, 5)
    await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeGreaterThan(40)
    const before = await row.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor }))
    const h0 = (await row.boundingBox()).height
    await row.hover()
    await expect.poll(() => row.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(before.bg)
    expect((await row.boundingBox()).height).toBe(h0) // no layout shift
    await page.screenshot({ path: `${dir}/row-hover.png` })

    await row.click({ button: 'right' })
    const ctx = page.locator('#acctctx')
    await expect(ctx.getByRole('menuitem')).toHaveText(['Rename', 'Quarantine', 'Low priority', 'Remove'])
    await expect(ctx).toBeVisible()
    await expect(ctx.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
    await page.screenshot({ path: `${dir}/menu-open.png` })
    await ctx.getByRole('menuitem', { name: 'Low priority' }).click()
    await expect(row.locator('.acct-badge.lp')).toHaveText('Low priority')
    expect(patches).toEqual([{ method: 'PATCH', body: { lowPriority: true } }])
    await expect(menu(page)).toBeVisible() // the Account menu stays open

    // Keyboard: Shift+F10 on the focused row, then the label flips.
    await row.focus()
    await page.keyboard.press('Shift+F10')
    await expect(ctx.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
    await expect(ctx.getByRole('menuitem', { name: 'Make regular priority' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(ctx).toBeHidden()
    await expect(row).toBeFocused()

    // The signed-in account has no Remove.
    await menu(page).locator('.acct-row', { hasText: 'Work' }).click({ button: 'right' })
    await expect(ctx.getByRole('menuitem', { name: 'Remove' })).toHaveCount(0)
  } finally { await s.stop() }
})

// Expired saved login: "Sign in again" only on that row, and it calls the same login route as Add account.
test('expired login shows Sign in again on that row only, and it starts the login', async ({ page }) => {
  const accounts = [
    { id: 'A', label: 'Work', email: 'work@example.com', subscriptionType: 'max', quarantine: false, lowPriority: false, active: true, signedIn: true },
    { id: 'B', label: 'Work', email: 'someone@example.com', subscriptionType: 'max', quarantine: false, lowPriority: false, active: false, signedIn: false },
    { id: 'C', label: 'Other', email: 'other@example.com', subscriptionType: 'pro', quarantine: false, lowPriority: false, active: false, signedIn: false },
  ]
  const starts = []
  await page.route('**/api/accounts', (route) => route.fulfill({ json: { active: 'A', pool: { available: false }, login: { id: 'A', present: true }, adding: starts.length > 0, accounts, network: null, autoSwitch: null } }))
  await page.route('**/api/accounts/usage*', (route) => route.fulfill({ json: { accounts: [
    { id: 'B', error: 'Login expired — sign in again' },
    { id: 'C', error: "Couldn't reach Anthropic" },
  ] } }))
  await page.route('**/api/accounts/add/start', (route) => { starts.push(route.request().method()); route.fulfill({ json: { command: 'claude auth login', opened: true, terminal: 'Terminal' } }) })
  const s = await startServer({ AGENTVILLE_DATA_DIR: tmpDir('acct-relogin') }, nextPort())
  try {
    await page.goto(s.url)
    await page.locator('#btn-account').click()
    const again = menu(page).getByRole('button', { name: /Sign in again/ })
    await expect(again).toHaveCount(1)
    await expect(menu(page).locator('.acct-row', { hasText: 'Work' }).getByRole('button', { name: /Sign in again/ })).toBeVisible()
    await again.click()
    await expect.poll(() => starts).toEqual(['POST'])
    await expect(menu(page)).toContainText('Sign in as someone@example.com')
  } finally { await s.stop() }
})
