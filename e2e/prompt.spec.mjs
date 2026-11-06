// An agent sitting in a dialog (here a permission prompt, as the CLI's live-session registry reports it)
// gets its own indicator: a purple "Needs a click" counter that filters to it, a purple row, a
// cursor bubble in the village and the tab title. Its own server and fixture home.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import { SHOTS, IDS, claudeId, prepareHome, startServer, tmpDir, nextPort } from './helpers.mjs'

let s
test.beforeEach(async () => {
  const env = prepareHome(tmpDir('prompt'))
  const sid = IDS.soloTurn
  // pid 1 is always alive (EPERM), so the session counts as live.
  fs.writeFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'sessions', `${sid.slice(0, 8)}.json`),
    JSON.stringify({ pid: 1, sessionId: sid, kind: 'bg', status: 'waiting', waitingFor: 'permission prompt' }))
  s = await startServer(env, nextPort())
})
test.afterEach(async () => { await s?.stop() })

test('an agent in a permission prompt shows as "Needs a click" everywhere', async ({ page }, testInfo) => {
  await page.goto(`${s.url}/?debug&night=0`)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  const chip = page.locator('#counters .counter.prompts')
  await expect(chip).toHaveText(/1\s*Needs a click/)
  await expect(page).toHaveTitle('(1 to click) Agentville')
  const row = page.locator(`.row[data-id="${claudeId('soloTurn')}"]`).first()
  await expect(row).toHaveClass(/sev-prompt/)
  await expect(row).toContainText('Needs a click: permission prompt')
  // The counter filters to just the agents waiting on a click, and toggles back.
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#panel .row:visible')).toHaveCount(1)
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'false')
  if (testInfo.project.name !== 'mobile') {
    // The village draws a bubble over it (badges are recorded per agent in the debug view).
    await page.locator('#cv').focus()
    for (let i = 0; i < 3 && (await page.evaluate(() => window.villageDebug().zoom)) < 2; i++) await page.keyboard.press('+')
    await expect.poll(() => page.evaluate((id) => window.villageDebug().badges.some((b) => b.id === id), claudeId('soloTurn'))).toBe(true)
    await page.waitForTimeout(1000)
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-prompt.png` })
  }
})
