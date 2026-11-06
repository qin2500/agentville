// The update prompt, against temp git repos and a fake GitHub API (test/fixtures/fake-github.mjs):
// never the real GitHub, never this repo's own checkout. One server per test.
import { test, expect } from './fixtures.mjs'
import AxeBuilder from '@axe-core/playwright'
import fs from 'node:fs'
import path from 'node:path'
import { SHOTS, nextPort, prepareHome, startServer, tmpDir } from './helpers.mjs'
import { makeRepos, fakeGithub } from '../test/fixtures/fake-github.mjs'

test.skip(process.platform === 'win32', 'the fixture uses a POSIX git setup')

async function serve({ dirty = false } = {}) {
  const root = tmpDir('update')
  const r = makeRepos(path.join(root, 'git'))
  r.publish('Add the update check\n\nA body nobody sees in the prompt')
  r.publish('Make the village bigger')
  if (dirty) fs.writeFileSync(path.join(r.install, 'app.txt'), 'my edit\n')
  const gh = await fakeGithub(r.origin)
  const s = await startServer({
    ...prepareHome(path.join(root, 'home')), ...gh.env, AGENTVILLE_UPDATE_DIR: r.install,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  }, nextPort())
  await fetch(`${s.url}/api/update?fresh`) // the first check, without waiting for the timer
  return { ...s, r, gh, close: async () => { await s.stop(); await gh.close() } }
}
const dialog = (page) => page.locator('#update')

test('prompts once per version: titles, Later, quiet Settings item, a newer version prompts again', async ({ page }, testInfo) => {
  const s = await serve()
  try {
    await page.goto(s.url)
    const d = dialog(page)
    await expect(d).toBeVisible()
    await expect(d.getByRole('heading', { name: 'Agentville update available' })).toBeFocused()
    await expect(d).toContainText('2 new changes on GitHub')
    await expect(d.locator('.upd-changes li')).toHaveCount(2)
    await expect(d.locator('.upd-changes li').first()).toContainText('Make the village bigger')
    await expect(d).toContainText('Add the update check')
    await expect(d).not.toContainText('A body nobody sees')
    await expect(d.getByRole('button', { name: 'Update now' })).toBeVisible()
    const axe = await new AxeBuilder({ page }).include('#update').analyze()
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([])
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-update-prompt.png` })

    await d.getByRole('button', { name: 'Later' }).click()
    await expect(d).toBeHidden()
    await page.reload()
    await expect(page.locator('#list .row').first()).toBeVisible()
    await page.waitForTimeout(1500) // the prompt would be up by now
    await expect(d).toBeHidden()

    // Still reachable, quietly, from Settings.
    await page.locator('#btn-settings').click()
    const item = page.locator('#pop-settings').getByRole('button', { name: /Update available/ })
    await expect(item).toContainText('2 new changes')
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-update-settings.png` })
    await item.click()
    await expect(d).toBeVisible()
    await page.keyboard.press('Escape') // Esc = Later
    await expect(d).toBeHidden()
    await expect(page.locator('#btn-settings')).toBeFocused()

    // A newer version on GitHub: one more prompt.
    s.r.publish('Fix the night sky')
    await fetch(`${s.url}/api/update?fresh`)
    await page.reload()
    await expect(d).toBeVisible()
    await expect(d).toContainText('3 new changes')
    await expect(d.locator('.upd-changes li').first()).toContainText('Fix the night sky')
    await d.getByRole('button', { name: 'Later' }).click()
    await expect(d).toBeHidden()
  } finally { await s.close() }
})

test('Update now fast-forwards the checkout, rebuilds, and (under test) asks for a restart', async ({ page }) => {
  const s = await serve()
  try {
    const latest = s.r.git(s.r.seed, 'rev-parse', 'HEAD')
    await page.goto(s.url)
    const d = dialog(page)
    await d.getByRole('button', { name: 'Update now' }).click()
    await expect(d.getByRole('heading', { name: 'Updated. Restart Agentville to use it.' })).toBeVisible({ timeout: 20_000 })
    await expect(d.getByRole('heading')).toBeFocused()
    expect(s.r.head()).toBe(latest)
    expect(fs.existsSync(path.join(s.r.install, 'built.txt'))).toBe(true)
    await d.getByRole('button', { name: 'Done' }).click()
    await expect(d).toBeHidden()
    // Up to date now: no Settings item.
    await page.locator('#btn-settings').click()
    await expect(page.locator('#pop-settings')).toBeVisible()
    await expect(page.locator('#pop-settings [data-update]')).toHaveCount(0)
  } finally { await s.close() }
})

test("can't update itself with local edits: says why and shows the commands", async ({ page }) => {
  const s = await serve({ dirty: true })
  try {
    await page.goto(s.url)
    const d = dialog(page)
    await expect(d).toContainText("Agentville can't update itself here: Your copy has local edits.")
    await expect(d.locator('.upd-cmd')).toContainText('git pull origin main')
    await expect(d.locator('.upd-cmd')).toContainText('./setup.sh')
    await expect(d.getByRole('button', { name: 'Update now' })).toHaveCount(0)
    const axe = await new AxeBuilder({ page }).include('#update').analyze()
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([])
    await d.getByRole('button', { name: 'Later' }).click()
    expect(s.r.git(s.r.install, 'status', '--porcelain', '--untracked-files=no')).not.toBe('')
  } finally { await s.close() }
})

test('Restarting… then the page reloads once the new server answers', async ({ page }) => {
  // The restart itself never runs under test; the page's side of it is faked here.
  const s = await serve()
  try {
    let startedAt = 1
    let real = null
    await page.route((u) => u.pathname === '/api/update', async (route) => {
      real ??= await (await route.fetch()).json()
      await route.fulfill({ json: { ...real, startedAt, ...(startedAt > 1 && { behindBy: 0, changes: [], canApply: false }) } })
    })
    await page.route((u) => u.pathname === '/api/update/apply', (route) => {
      setTimeout(() => { startedAt = 2 }, 2500)
      return route.fulfill({ json: { ok: true, steps: [], restarting: true } })
    })
    await page.goto(s.url)
    const d = dialog(page)
    await page.evaluate(() => { window.__beforeRestart = true })
    await d.getByRole('button', { name: 'Update now' }).click()
    await expect(d.getByRole('heading', { name: 'Restarting…' })).toBeVisible()
    await page.keyboard.press('Escape') // nothing to cancel: it stays up
    await expect(d).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__beforeRestart ?? null), { timeout: 15_000 }).toBeNull()
    await expect(page.locator('#list .row').first()).toBeVisible()
    await expect(d).toBeHidden()
  } finally { await s.close() }
})
