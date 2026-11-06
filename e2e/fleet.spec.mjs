// Fleet actions send straight into live Claude sessions' inboxes. Here those sessions are fake: unix
// sockets owned by this test process, under a AGENTVILLE_FLEET_SOCKET_ROOT the server is pinned to, so no
// real session is reachable. Each test gets its own server, fixture home and data dir.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import AxeBuilder from '@axe-core/playwright'
import { SHOTS, IDS, claudeId, prepareHome, startServer, tmpDir, nextPort } from './helpers.mjs'

const isMobile = (testInfo) => testInfo.project.name === 'mobile'
let s, env, sockRoot, peers, frames

const transcriptOf = (sid) => {
  const projects = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects')
  for (const dir of fs.readdirSync(projects)) {
    const f = path.join(projects, dir, `${sid}.jsonl`)
    if (fs.existsSync(f)) return f
  }
}
/** A fake inbox for `key`: records frames and writes the receipt the CLI would (when `ack`). */
function peer(key, ack = true) {
  const sid = IDS[key]
  const sock = path.join(sockRoot, `${key}.sock`)
  frames[key] = []
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => { buf += d })
    c.on('end', () => {
      for (const line of buf.split('\n').filter(Boolean)) {
        const f = JSON.parse(line)
        frames[key].push(f)
        if (ack) fs.appendFileSync(transcriptOf(sid), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'peer', msg_id: f.msg_id } }) + '\n')
      }
    })
  })
  peers.push(srv)
  fs.writeFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'sessions', `${sid.slice(0, 8)}.json`),
    JSON.stringify({ pid: 1, sessionId: sid, kind: 'bg', status: 'idle', messagingSocketPath: sock, peerProtocol: 1 }))
  return new Promise((r) => srv.listen(sock, r))
}

test.beforeEach(async () => {
  env = prepareHome(tmpDir('fleet'))
  sockRoot = fs.mkdtempSync('/tmp/vfe-') // short: unix socket paths are limited to ~104 bytes
  peers = []
  frames = {}
  await peer('boss')
  await peer('soloTurn')
  await peer('soloError')
  s = await startServer({ ...env, AGENTVILLE_FLEET_SOCKET_ROOT: sockRoot }, nextPort())
})
test.afterEach(async () => {
  await s?.stop()
  for (const p of peers) p.close()
  fs.rmSync(sockRoot, { recursive: true, force: true })
})

const openSheet = async (page, action) => {
  await page.locator('#btn-fleet').click()
  await page.locator(`#pop-fleet [data-fleet="${action}"]`).click()
  await expect(page.locator('#sheet .fcard').first()).toBeVisible()
}

test('reboot prep: sends to the selected agents, reports each, and pauses them', async ({ page }, testInfo) => {
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await openSheet(page, 'reboot')
  const sheet = page.locator('#sheet')
  await expect(sheet.locator('h2')).toHaveText('Prep for laptop reboot')
  await expect(sheet).toContainText("Sends straight into each selected agent's session")
  await expect(sheet.locator('.fcard').first()).toHaveAttribute('data-target', claudeId('boss')) // bosses first
  const boss = sheet.locator(`.fcard[data-target="${claudeId('boss')}"]`)
  await expect(boss.locator('.relays p')).toHaveText(/^Relays to \d+ agents$/)
  // Codex can't be messaged: listed, unticked, with the reason.
  const codex = sheet.locator(`.fcard[data-target="codex:${IDS.codexTurn}"]`)
  await expect(codex).toContainText("Can't be messaged: Codex")
  await expect(codex.locator('input[data-rcp]')).toBeDisabled()
  if (!isMobile(testInfo)) {
    const axe = await new AxeBuilder({ page }).include('#sheet').analyze()
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([])
  }
  // House rule: never disabled for bad input; it explains instead.
  for (const box of await sheet.locator('input[data-rcp]:not([disabled])').all()) await box.uncheck()
  await sheet.locator('[data-fleet-act="mark"]').click()
  await expect(sheet.locator('#err-none')).toHaveText('Pick at least one agent.')
  await boss.locator('input[data-rcp]').check()
  await expect(sheet.locator('[data-fleet-act="mark"]')).toHaveText('Send to 1 agent')
  await sheet.locator('[data-fleet-act="mark"]').click()
  await expect(sheet.locator('h2')).toHaveText('Prep for laptop reboot: sent')
  await expect(boss.locator('.fstat')).toHaveText('Delivered')
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-fleet-reboot.png` })
  expect(frames.boss).toHaveLength(1)
  expect(frames.boss[0].message.content).toMatch(/^<cross-session-message from-name="Agentville">\n\[Agentville · prep for laptop reboot\]/)
  expect(frames.boss[0].message.content).toMatch(/Forward this exact message to every lead/)
  expect(frames.soloTurn, 'unticked agents get nothing').toHaveLength(0)
  await sheet.locator('[data-fleet-act="close"]').click()
  await expect(page.locator('#btn-fleet')).toHaveText(/Fleet · Paused/)
})

test('continue: the menu counts erroring agents; sends exactly "continue" to them', async ({ page }) => {
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await page.locator('#btn-fleet').click()
  await expect(page.locator('#pop-fleet [data-fleet="continue"]')).toContainText('Send "continue" to 1 agent showing an error or restarted mid-task.')
  await page.locator('#pop-fleet [data-fleet="continue"]').click()
  const sheet = page.locator('#sheet')
  await expect(sheet.locator('h2')).toHaveText('Continue stuck agents')
  await expect(sheet.locator('#fleet-msg')).toHaveCount(0) // nothing to edit
  await expect(sheet.locator('.fcard')).toHaveCount(1)
  await sheet.locator('[data-fleet-act="mark"]').click()
  await expect(sheet.locator(`.fcard[data-target="${claudeId('soloError')}"] .fstat`)).toHaveText('Delivered')
  expect(frames.soloError.map((f) => f.message.content)).toEqual(['<cross-session-message from-name="Agentville">\ncontinue\n</cross-session-message>'])
  expect(frames.boss).toHaveLength(0)
})

test('editing the template changes what is sent; reset restores it', async ({ page }) => {
  await page.goto(s.url)
  await openSheet(page, 'offline')
  const sheet = page.locator('#sheet')
  for (const box of await sheet.locator('input[data-rcp]:not([disabled])').all()) await box.uncheck()
  await sheet.locator(`.fcard[data-target="${claudeId('soloTurn')}"] input[data-rcp]`).check()
  await sheet.locator('#fleet-msg').fill('Hold on, {name}: pause in {project}.')
  await expect(sheet.locator(`.fcard[data-target="${claudeId('soloTurn')}"] pre.msg`)).toHaveText(/^Hold on, Explain the build: pause in demo-app\./, { useInnerText: false })
  await sheet.locator('[data-fleet-act="mark"]').click()
  await expect(sheet.locator(`.fcard[data-target="${claudeId('soloTurn')}"] .fstat`)).toHaveText('Delivered')
  expect(frames.soloTurn[0].message.content).toContain('Hold on, Explain the build: pause in demo-app.')
})

test('without a usable socket root sending is unavailable and says why', async ({ page }) => {
  await s.stop()
  s = await startServer(env, nextPort()) // tests: no socket root means nothing can be sent
  await page.goto(s.url)
  await openSheet(page, 'offline')
  const sheet = page.locator('#sheet')
  await expect(sheet.locator('.lede')).toContainText("Sending isn't available here: Sending is disabled in tests")
  await expect(sheet.locator('[data-fleet-act="mark"]')).toBeDisabled()
})

test('after a prep, Resume is first in the Fleet menu and sends the resume message to the prepped agents', async ({ page }) => {
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await openSheet(page, 'offline')
  const sheet = page.locator('#sheet')
  for (const box of await sheet.locator('input[data-rcp]:not([disabled])').all()) await box.uncheck()
  await sheet.locator(`.fcard[data-target="${claudeId('soloTurn')}"] input[data-rcp]`).check()
  await sheet.locator('[data-fleet-act="mark"]').click()
  await expect(sheet.locator(`.fcard[data-target="${claudeId('soloTurn')}"] .fstat`)).toHaveText('Delivered')
  await sheet.locator('[data-fleet-act="close"]').click()
  await page.locator('#btn-fleet').click()
  const first = page.locator('#pop-fleet .menuitem').first()
  await expect(first).toHaveAttribute('data-fleet', 'resume')
  await expect(first).toContainText('from your internet-loss prep')
  await first.click()
  await expect(sheet.locator('h2')).toHaveText('Resume')
  await sheet.locator('[data-fleet-act="mark"]').click()
  await expect(sheet.locator(`.fcard[data-target="${claudeId('soloTurn')}"] .fstat`)).toHaveText('Delivered')
  expect(frames.soloTurn.at(-1).message.content).toContain('[Agentville · resume]')
  await sheet.locator('[data-fleet-act="close"]').click()
  await expect(page.locator('#btn-fleet')).not.toHaveText(/Paused/) // resume clears the pending prep
})
