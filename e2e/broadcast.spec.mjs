// "Message agents…": filters, the live preview, the confirm step and per-agent results. The sessions
// are fake: unix sockets owned by this test under a AGENTVILLE_FLEET_SOCKET_ROOT the server is pinned to,
// and a fixture HOME. One fixture session plays the dashboard's own (AGENTVILLE_SELF_SESSION).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { test, expect } from './fixtures.mjs'
import AxeBuilder from '@axe-core/playwright'
import { IDS, claudeId, prepareHome, startServer, tmpDir, nextPort } from './helpers.mjs'

const SHOTS = '/tmp/vshots'
fs.mkdirSync(SHOTS, { recursive: true })
let s, env, sockRoot, peers, frames

const transcriptOf = (sid) => {
  const projects = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects')
  for (const dir of fs.readdirSync(projects)) {
    const f = path.join(projects, dir, `${sid}.jsonl`)
    if (fs.existsSync(f)) return f
  }
}
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
  peers[key] = srv
  fs.writeFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'sessions', `${sid.slice(0, 8)}.json`),
    JSON.stringify({ pid: 1, sessionId: sid, kind: 'bg', status: 'idle', messagingSocketPath: sock, peerProtocol: 1 }))
  return new Promise((r) => srv.listen(sock, r))
}

test.beforeEach(async () => {
  env = prepareHome(tmpDir('broadcast'))
  sockRoot = fs.mkdtempSync('/tmp/vbe-') // short: unix socket paths are limited to ~104 bytes
  peers = {}
  frames = {}
  await peer('boss')
  await peer('leadBlocked')
  await peer('soloTurn', false) // takes the message but never writes a receipt
  await peer('leadCi') // the dashboard's own session
  s = await startServer({ ...env, AGENTVILLE_FLEET_SOCKET_ROOT: sockRoot, AGENTVILLE_SELF_SESSION: IDS.leadCi }, nextPort())
})
test.afterEach(async () => {
  await s?.stop()
  for (const p of Object.values(peers)) p.close()
  fs.rmSync(sockRoot, { recursive: true, force: true })
})

const shot = (page, testInfo, name) => page.screenshot({ path: `${SHOTS}/broadcast-${testInfo.project.name}-${name}.png` })
async function openSheet(page) {
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await page.locator('#view-team').click()
  await page.locator('#btn-msg').click()
  const sheet = page.locator('#broadcast')
  await expect(sheet.locator('h2')).toHaveText('Message agents')
  return sheet
}
const row = (sheet, k) => sheet.locator(`#bc-list [data-bc-id="${claudeId(k)}"]`)

test('filter, preview, confirm the exact text and recipients, then per-agent results', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const sheet = await openSheet(page)
  // Everyone: the three reachable sessions; the rest greyed out with the reason, not counted.
  await expect(sheet.locator('[data-bc="everyone"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(sheet.locator('#bc-list .bcrow')).toHaveCount(3)
  await expect(sheet.locator('#bc-count')).toHaveText('3 agents will get it')
  await sheet.locator('#bc-off summary').click()
  await expect(sheet.locator(`#bc-off [data-bc-id="${claudeId('leadCi')}"] .why`)).toHaveText('This is the session Agentville is running in.')
  await expect(sheet.locator(`#bc-off [data-bc-id="codex:${IDS.codexTurn}"] .why`)).toContainText('Codex')
  await expect(sheet.locator(`#bc-off [data-bc-id="${claudeId('soloError')}"] .why`)).toContainText('Not running')
  // Rank Lead: only the reachable lead (the dashboard's own session is a lead too, but greyed out).
  await sheet.locator('[data-bc-f="ranks"][data-v="lead"]').click()
  await expect(sheet.locator('#bc-list .bcrow')).toHaveCount(1)
  await expect(row(sheet, 'leadBlocked')).toBeVisible()
  // OR within a kind: Lead or Boss.
  await sheet.locator('[data-bc-f="ranks"][data-v="boss"]').click()
  await expect(sheet.locator('#bc-count')).toHaveText('2 agents will get it')
  // AND across kinds: Lead/Boss that need you.
  await sheet.locator('[data-bc-f="statuses"][data-v="stalled"]').click()
  await expect(sheet.locator('#bc-list .bcrow')).toHaveCount(1)
  await expect(row(sheet, 'leadBlocked')).toBeVisible()
  // Name, any case.
  const names = Object.fromEntries((await (await page.request.get(`${s.url}/api/agents`)).json()).agents.map((a) => [a.id, a.name]))
  await sheet.locator('[data-bc="everyone"]').click()
  await sheet.locator('#bc-name').fill(names[claudeId('boss')].slice(1, 6).toUpperCase())
  await expect(row(sheet, 'boss')).toBeVisible()
  await sheet.locator('[data-bc="everyone"]').click()
  await expect(sheet.locator('#bc-name')).toHaveValue('')
  await expect(sheet.locator('#bc-list .bcrow')).toHaveCount(3)
  if (testInfo.project.name === 'desktop') {
    const axe = await new AxeBuilder({ page }).include('#broadcast').analyze()
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
  }
  // House rule: never a disabled button; it says what's missing.
  await sheet.locator('[data-bc="review"]').click()
  await expect(sheet.locator('#bc-err')).toHaveText('Write the message first.')
  const text = 'Please pull main, rebase your branch, and tell me if anything conflicts.'
  await sheet.locator('#bc-text').fill(text)
  await shot(page, testInfo, 'compose')
  await sheet.locator('[data-bc="review"]').click()
  // The confirm step: the exact frame text, the exact recipients and the count.
  await expect(sheet.locator('h2')).toHaveText('Send this to 3 agents?')
  await expect(sheet.locator('#bc-sent')).toHaveText(`<cross-session-message from-name="Agentville">\n${text}\n</cross-session-message>`, { useInnerText: false })
  await expect(sheet.locator('#bc-recipients .bcrow')).toHaveCount(3)
  expect(frames.boss, 'nothing is sent before the confirm').toHaveLength(0)
  await shot(page, testInfo, 'confirm')
  await sheet.locator('[data-bc="send"]').click()
  await expect(sheet.locator(`#bc-results [data-bc-id="${claudeId('boss')}"] [data-bc-stat]`)).toHaveText('Delivered')
  await expect(sheet.locator(`#bc-results [data-bc-id="${claudeId('leadBlocked')}"] [data-bc-stat]`)).toHaveText('Delivered')
  await expect(sheet.locator(`#bc-results [data-bc-id="${claudeId('soloTurn')}"] [data-bc-stat]`)).toHaveText('Sent, waiting for receipt…')
  await expect(sheet.locator('h2')).toHaveText('Delivered to 2 of 3', { timeout: 20_000 })
  await expect(sheet.locator(`#bc-results [data-bc-id="${claudeId('soloTurn')}"] [data-bc-stat]`)).toHaveText('Sent (no receipt in 10 s)')
  await expect(sheet.locator('.lede')).toHaveText('1 sent without a receipt.')
  await shot(page, testInfo, 'results')
  for (const k of ['boss', 'leadBlocked', 'soloTurn']) expect(frames[k].map((f) => f.message.content)).toEqual([`<cross-session-message from-name="Agentville">\n${text}\n</cross-session-message>`])
  expect(frames.leadCi).toHaveLength(0)
  await sheet.locator('[data-bc="close"]').click()
  await expect(sheet).toBeHidden()
})

test('unticked agents get nothing; a set that changes after review must be confirmed again', async ({ page }, testInfo) => {
  const sheet = await openSheet(page)
  await row(sheet, 'soloTurn').locator('input[type="checkbox"]').uncheck()
  await expect(sheet.locator('#bc-count')).toHaveText('2 agents will get it')
  await sheet.locator('#bc-text').fill('Heads up: the network drops at noon.')
  await sheet.locator('[data-bc="review"]').click()
  await expect(sheet.locator('h2')).toHaveText('Send this to 2 agents?')
  // The lead's session goes away: the next poll sees a different set.
  await new Promise((r) => peers.leadBlocked.close(r))
  await expect(sheet.locator('#bc-changed')).toBeVisible({ timeout: 10_000 })
  await expect(sheet.locator('[data-bc="send"]')).toHaveCount(0)
  await shot(page, testInfo, 'changed')
  await sheet.locator('[data-bc="review"]').click()
  await expect(sheet.locator('h2')).toHaveText('Send this to 1 agent?')
  await sheet.locator('[data-bc="send"]').click()
  await expect(sheet.locator('h2')).toHaveText('Delivered to 1 of 1')
  expect(frames.boss).toHaveLength(1)
  expect(frames.soloTurn).toHaveLength(0)
  expect(frames.leadBlocked).toHaveLength(0)
})

test('the Fleet menu opens it too; outside Team the toolbar button is hidden', async ({ page }, testInfo) => {
  await page.goto(s.url)
  await expect(page.locator('#conn')).toHaveText(/Live/)
  await expect(page.locator('#btn-msg')).toBeHidden()
  await page.locator('#view-team').click()
  await expect(page.locator('#btn-msg')).toBeVisible()
  // It sits in the toolbar, inside the panel, without pushing anything off the edge.
  const panel = await page.locator('#panel .pbody').boundingBox()
  const b = await page.locator('#btn-msg').boundingBox()
  expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width + 1)
  await page.locator('#panel .phead').screenshot({ path: `${SHOTS}/broadcast-${testInfo.project.name}-toolbar.png` })
  await page.locator('#view-status').click()
  await page.locator('#btn-fleet').click()
  await page.locator('#pop-fleet [data-broadcast="open"]').click()
  await expect(page.locator('#broadcast h2')).toHaveText('Message agents')
})
