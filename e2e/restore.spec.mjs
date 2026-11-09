// Restore after crash, in the browser. The "crash" is a fixture: a running-set snapshot from an
// earlier boot (AGENTVILLE_BOOT_TIME pins this one) whose agents have no live process now. Restarts go
// to the stub `claude` (test/fixtures/bin/claude-bg), and the crown agent's inbox is a unix socket
// owned by this test under AGENTVILLE_FLEET_SOCKET_ROOT. No real session is reachable.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './fixtures.mjs'
import { SHOTS, IDS, claudeId, prepareHome, startServer, tmpDir, nextPort, inspect, row } from './helpers.mjs'

const STUB = fileURLToPath(new URL('../test/fixtures/bin/claude-bg', import.meta.url))
const BOOT1 = Date.now() - 2 * 3600e3 // the boot that crashed
const BOOT2 = Date.now() - 15 * 60e3 // this one
const isMobile = (ti) => ti.project.name === 'mobile'
const shot = (page, ti, name) => page.screenshot({ path: `${SHOTS}/${ti.project.name}-${name}.png` })
const short = (k) => IDS[k].slice(0, 8)
let s, env, dir, sockRoot, peerSrv, frames

test.beforeEach(async () => {
  dir = tmpDir('restore')
  env = prepareHome(dir)
  const claude = env.AGENTVILLE_CLAUDE_HOME
  const cwd = path.join(dir, 'work', 'demo-app')
  fs.mkdirSync(env.AGENTVILLE_DATA_DIR, { recursive: true })
  // Before the crash: the boss (crown), DB Lead and the build question (both Important), CI Lead (Important, still up).
  const seen = Math.floor((BOOT2 - 20 * 60e3) / 60e3) * 60e3
  const e = (k, kind, name, role, important) => ({ kind, id: claudeId(k), ...(kind === 'job' && { short: short(k) }), sid: IDS[k], name, project: 'demo-app', cwd, role, important, seen })
  fs.writeFileSync(path.join(env.AGENTVILLE_DATA_DIR, 'restore.json'), JSON.stringify({ boot: BOOT1, at: seen, previous: null, dismissed: 0, running: [
    e('boss', 'job', 'Big Boss', 'boss', false), e('leadBlocked', 'job', 'DB Lead', 'lead', true), e('leadCi', 'job', 'CI Lead', 'lead', true),
    e('leadBuilding', 'job', 'API Lead', 'lead', false), e('soloTurn', 'session', 'Explain the build', 'solo', true),
  ] }))
  fs.writeFileSync(path.join(env.AGENTVILLE_DATA_DIR, 'overrides.json'), JSON.stringify({ [claudeId('leadBlocked')]: { important: true }, [claudeId('soloTurn')]: { important: true } }))
  // The crash took their processes (CI Lead came back by itself).
  for (const k of ['boss', 'leadBlocked', 'leadBuilding', 'soloTurn']) fs.rmSync(path.join(claude, 'sessions', `${short(k)}.json`), { force: true })
  // The boss's inbox once it is back: records each frame and writes the receipt the CLI would.
  sockRoot = fs.mkdtempSync('/tmp/vrs-')
  frames = []
  const transcript = path.join(claude, 'projects', '-work-demo-app', `${IDS.boss}.jsonl`)
  peerSrv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => { buf += d })
    c.on('end', () => {
      for (const line of buf.split('\n').filter(Boolean)) {
        const f = JSON.parse(line)
        frames.push(f)
        fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'peer', msg_id: f.msg_id } }) + '\n')
      }
    })
  })
  await new Promise((r) => peerSrv.listen(path.join(sockRoot, `${short('boss')}.sock`), r))
  s = await startServer({ ...env, AGENTVILLE_BOOT_TIME: String(BOOT2), AGENTVILLE_RESTORE_WAIT_MS: '4000', AGENTVILLE_FLEET_SOCKET_ROOT: sockRoot, AGENTVILLE_CLAUDE_BIN: STUB, AGENTVILLE_FAKE_CLAUDE_LOG: path.join(dir, 'claude-bg.log') }, nextPort())
})
test.afterEach(async () => {
  await s?.stop()
  peerSrv?.close()
  fs.rmSync(sockRoot, { recursive: true, force: true })
})
const runs = () => { const f = path.join(dir, 'claude-bg.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [] }

test('the notice names the restart; Dismiss hides it for this boot', async ({ page }) => {
  await page.goto(s.url)
  const nudge = page.locator('#nudge')
  await expect(nudge).toContainText('Your Mac restarted — 3 agents were running.', { timeout: 15_000 })
  await expect(nudge.locator('[data-restore="open"]')).toHaveText('Restore…')
  await nudge.locator('[data-restore="dismiss"]').click()
  await expect(nudge).toBeHidden()
  await page.reload()
  await expect(page.locator('#btn-fleet')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(nudge).toBeHidden()
  // Still in the Fleet menu.
  await page.locator('#btn-fleet').click()
  await expect(page.locator('#pop-fleet [data-restore="open"]')).toContainText('Restore after crash…')
})

test('sheet: lost crown and Important jobs checked, terminals to copy; confirm shows commands and the message; per-job results', async ({ page }, ti) => {
  await page.goto(s.url)
  await page.locator('#btn-fleet').click()
  const item = page.locator('#pop-fleet .menuitem').first()
  await expect(item).toContainText('Restore after crash…')
  await item.click()
  const sheet = page.locator('#sheet')
  await expect(sheet.locator('#sheet-title')).toHaveText('Restore after crash')
  const cards = sheet.locator('[data-restore-job]')
  await expect(cards).toHaveCount(2)
  await expect(sheet.locator(`[data-restore-job="${claudeId('boss')}"] .who`)).toContainText('Big Boss')
  await expect(sheet.locator(`[data-restore-job="${claudeId('boss')}"] .who small`)).toContainText('Boss · demo-app')
  await expect(sheet.locator(`[data-restore-job="${claudeId('leadBlocked')}"] .who small`)).toContainText('★ Important')
  await expect(sheet.locator('[data-restore-pick]:checked')).toHaveCount(2)
  await expect(sheet.locator(`[data-restore-job="${claudeId('boss')}"] .reach`)).toContainText('last seen')
  const ses = sheet.locator(`[data-restore-session="${claudeId('soloTurn')}"]`)
  await expect(ses.locator('code')).toContainText(`claude --resume ${IDS.soloTurn}`)
  await expect(ses.locator('button')).toHaveText('Copy resume command')
  await expect(sheet.locator('.menunote')).toContainText('1 still running, 1 not a crown agent or Important')
  await shot(page, ti, 'restore-sheet')
  if (!isMobile(ti)) {
    const axe = await new AxeBuilder({ page }).include('#sheet').analyze()
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([])
  }
  // Untick and re-tick: the button counts.
  await sheet.locator(`[data-restore-pick="${claudeId('leadBlocked')}"]`).uncheck()
  await expect(sheet.locator('[data-restore-act="review"]')).toHaveText('Review 1 agent…')
  await sheet.locator(`[data-restore-pick="${claudeId('leadBlocked')}"]`).check()
  await sheet.locator('[data-restore-act="review"]').click()
  // Confirm: exact commands, and the crown's message under the same confirm.
  await expect(sheet.locator(`[data-restore-cmd="${claudeId('boss')}"] code`).first()).toHaveText(`claude respawn ${short('boss')}`)
  await expect(sheet.locator(`[data-restore-cmd="${claudeId('leadBlocked')}"]`)).toContainText(`claude --bg --resume ${IDS.leadBlocked}`)
  await expect(sheet.locator('pre.msg')).toHaveText(/^You were restarted after the computer crashed\./)
  await expect(sheet.locator('h3', { hasText: 'Then sends this to' })).toContainText('Big Boss')
  await expect(sheet).not.toContainText('sk-ant-')
  expect(runs()).toHaveLength(0) // nothing runs before the confirm
  await shot(page, ti, 'restore-confirm')
  await sheet.locator('[data-restore-act="run"]').click()
  await expect(sheet.locator('#sheet-title')).toHaveText('Restore after crash: done', { timeout: 20_000 })
  await expect(sheet.locator(`[data-restore-job="${claudeId('boss')}"] .fstat`).first()).toHaveText('Restored')
  await expect(sheet.locator(`[data-restore-job="${claudeId('boss')}"]`)).toContainText('Message delivered')
  await expect(sheet.locator(`[data-restore-job="${claudeId('leadBlocked')}"] .fstat`).first()).toHaveText('Restored')
  await expect(sheet.locator(`[data-restore-job="${claudeId('leadBlocked')}"]`)).not.toContainText('Message')
  expect(runs().map((r) => r.argv)).toEqual([['respawn', short('boss')], ['respawn', short('leadBlocked')]])
  expect(frames).toHaveLength(1)
  await shot(page, ti, 'restore-done')
  await sheet.locator('[data-restore-act="close"]').click()
  // Both are back: the notice goes away.
  await expect(page.locator('#nudge')).not.toContainText('Your Mac restarted — 3', { timeout: 15_000 })
})

test('Important: a toggle in the inspector, a star on its row, kept on disk', async ({ page }) => {
  await page.goto(s.url)
  await inspect(page, claudeId('leadBlocked'))
  const btn = page.locator('#drawer [data-act="important"]')
  await expect(btn).toHaveText('★ Important')
  await expect(btn).toHaveAttribute('aria-pressed', 'true')
  const back = page.locator('#drawer [data-act="back"]')
  if (await back.isVisible()) await back.click()
  await inspect(page, claudeId('leadBuilding'))
  const b2 = page.locator('#drawer [data-act="important"]')
  await expect(b2).toHaveText('☆ Mark important')
  await b2.click()
  await expect(b2).toHaveText('★ Important')
  await expect(page.locator('#drawer h3 .star')).toBeVisible()
  const saved = JSON.parse(fs.readFileSync(path.join(env.AGENTVILLE_DATA_DIR, 'overrides.json'), 'utf8'))
  expect(saved[claudeId('leadBuilding')]).toEqual({ important: true })
  expect(saved[claudeId('leadBlocked')]).toEqual({ important: true }) // the others are untouched
  await b2.click()
  await expect(b2).toHaveText('☆ Mark important')
  expect(JSON.parse(fs.readFileSync(path.join(env.AGENTVILLE_DATA_DIR, 'overrides.json'), 'utf8'))[claudeId('leadBuilding')]).toBeUndefined()
  if (await back.isVisible()) await back.click()
  await expect(row(page, claudeId('leadBlocked')).locator('.star')).toBeVisible()
})
