// Acting on one agent: reply / message from the inspector, changed files and PR status, start /
// stop / fork, notifications toggles and conversation search. Everything is fake: inbox sockets
// owned by this test under AGENTVILLE_FLEET_SOCKET_ROOT, a stub `claude` (test/fixtures/bin/claude-bg)
// that only records its argv and writes fake job folders, and a temp git repo as the project.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './fixtures.mjs'
import { SHOTS, IDS, claudeId, prepareHome, startServer, tmpDir, nextPort, inspect } from './helpers.mjs'
import { ASK } from '../test/fixtures/make-home.mjs'

const STUB = fileURLToPath(new URL('../test/fixtures/bin/claude-bg', import.meta.url))
let s, env, sockRoot, peers, frames, cwd
const isMobile = (ti) => ti.project.name === 'mobile'
const shot = (page, ti, name) => page.screenshot({ path: `${SHOTS}/${ti.project.name}-${name}.png` })
/** Leave the open inspector (docked, it replaces the list), then open another agent's. */
async function reinspect(page, id) {
  const back = page.locator('#drawer [data-act="back"]')
  if (await back.isVisible()) await back.click()
  await inspect(page, id)
}
const runs = () => { const f = path.join(env.dir, 'claude-bg.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [] }

function peer(key) {
  const sid = IDS[key]
  const sock = path.join(sockRoot, `${key}.sock`)
  frames[key] = []
  const file = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app', `${sid}.jsonl`)
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => { buf += d })
    c.on('end', () => {
      for (const line of buf.split('\n').filter(Boolean)) {
        const f = JSON.parse(line)
        frames[key].push(f)
        fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'peer', msg_id: f.msg_id } }) + '\n')
      }
    })
  })
  peers.push(srv)
  const reg = path.join(env.AGENTVILLE_CLAUDE_HOME, 'sessions', `${sid.slice(0, 8)}.json`)
  fs.writeFileSync(reg, JSON.stringify({ ...JSON.parse(fs.readFileSync(reg, 'utf8')), status: 'idle', messagingSocketPath: sock, peerProtocol: 1 }))
  return new Promise((r) => srv.listen(sock, r))
}

/** The fixture project as a git checkout: a feature branch with commits plus uncommitted work. */
function gitProject(dir) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', '-C', dir, ...args], { stdio: 'pipe' })
  const lines = (n, t) => Array.from({ length: n }, (_, i) => `${t} ${i}`).join('\n') + '\n'
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'api.js'), lines(40, 'api'))
  fs.writeFileSync(path.join(dir, 'README.md'), lines(10, 'readme'))
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base')
  git('checkout', '-qb', 'api-v2')
  fs.writeFileSync(path.join(dir, 'src', 'api.js'), lines(30, 'api') + lines(120, 'v2'))
  fs.writeFileSync(path.join(dir, 'src', 'routes.js'), lines(64, 'route'))
  git('add', '.'); git('commit', '-qm', 'v2')
  fs.writeFileSync(path.join(dir, 'README.md'), lines(8, 'readme') + lines(4, 'docs'))
  fs.writeFileSync(path.join(dir, 'src', 'api.test.js'), lines(12, 'test'))
}

test.beforeEach(async () => {
  const dir = tmpDir('agents')
  env = { ...prepareHome(dir), dir }
  cwd = path.join(dir, 'work', 'demo-app')
  gitProject(cwd)
  // A session that linked a PR, and the PR status cache entry for it.
  fs.appendFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app', `${IDS.soloTurn}.jsonl`), JSON.stringify({ type: 'pr-link', sessionId: IDS.soloTurn, prNumber: 102, prUrl: 'https://github.com/example/demo-app/pull/102', prRepository: 'example/demo-app', timestamp: new Date().toISOString() }) + '\n')
  const cache = path.join(env.AGENTVILLE_CLAUDE_HOME, 'gh-pr-status-cache.json')
  fs.writeFileSync(cache, JSON.stringify({ ...JSON.parse(fs.readFileSync(cache, 'utf8')), 'https://github.com/example/demo-app/pull/102': { number: 102, title: '', state: 'DRAFT', checks: { passed: 4, failed: 0, pending: 3 }, review: null, additions: 1, deletions: 0 } }))
  // An old, resting conversation known only by names written late in its file.
  const oldSid = 'eeeeeeee-0000-4000-8000-0000000000e1'
  const ts = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const old = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app', `${oldSid}.jsonl`)
  fs.writeFileSync(old, [{ type: 'user', sessionId: oldSid, cwd, uuid: 'o', timestamp: ts, message: { role: 'user', content: 'Old prompt' } },
    { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'agent-name', agentName: 'invoice-bot', sessionId: oldSid }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.utimesSync(old, new Date(ts), new Date(ts))
  sockRoot = fs.mkdtempSync('/tmp/vag-')
  peers = []
  frames = {}
  await peer('leadBlocked')
  await peer('soloTurn')
  s = await startServer({ ...env, AGENTVILLE_FLEET_SOCKET_ROOT: sockRoot, AGENTVILLE_CLAUDE_BIN: STUB, AGENTVILLE_FAKE_CLAUDE_LOG: path.join(dir, 'claude-bg.log') }, nextPort())
})
test.afterEach(async () => {
  await s?.stop()
  for (const p of peers) p.close()
  fs.rmSync(sockRoot, { recursive: true, force: true })
})

test.describe('expanded Team view', () => {
  test.use({ firstRun: true })
  test('cards carry change and PR-state chips; failing checks are amber, not red', async ({ page }, ti) => {
    test.skip(isMobile(ti), 'desktop layout')
    await page.goto(s.url)
    const lead = page.locator(`#list .row[data-id="${claudeId('leadBuilding')}"]`)
    await expect(lead.locator('.chip.chg')).toHaveText('Changes: +188 −12 · 4 files', { timeout: 15_000 })
    const pr = lead.locator('.chip[data-href$="/pull/101"]')
    await expect(pr).toHaveClass(/pr-open/)
    await expect(pr).toHaveClass(/pr-failing/)
    await expect(pr).toHaveAttribute('title', 'Open PR #101 (Open, 1 check failing, Review required) in a new tab')
    expect(await pr.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(242, 184, 75)') // --stalled amber
    await expect(page.locator('#btn-new')).toBeVisible()
    await shot(page, ti, 'agents-team-chips')
  })
})

test('reply: the question, the prefilled suggested reply, the exact text, then Delivered', async ({ page }, ti) => {
  await page.goto(s.url)
  await inspect(page, claudeId('leadBlocked'))
  const d = page.locator('#drawer')
  await expect(d.locator('.ask h4')).toHaveText('DB Lead is asking')
  await expect(d.locator('.ask .needs')).toHaveText(ASK.needs)
  await expect(d.locator('#msg-box')).toHaveValue(ASK.suggestedReply)
  await expect(d.locator('.ask .helper').last()).toContainText('cross-session-message')
  // House rule: an empty box explains instead of disabling the button.
  await d.locator('#msg-box').fill('   ')
  await d.locator('[data-ins="msgpreview"]').click()
  await expect(d.locator('#msg-err')).toHaveText('Write a message first.')
  await d.locator('#msg-box').fill('Use knex. Keep the old migrations.')
  await d.locator('[data-ins="msgpreview"]').click()
  await expect(d.locator('#msg-preview')).toHaveText('<cross-session-message from-name="Agentville">\nUse knex. Keep the old migrations.\n</cross-session-message>')
  expect(frames.leadBlocked).toHaveLength(0)
  if (!isMobile(ti)) {
    const axe = await new AxeBuilder({ page }).include('#drawer').analyze()
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([])
  }
  await shot(page, ti, 'agents-reply-preview')
  await d.locator('[data-ins="msgsend"]').click()
  await expect(d.locator('.msgstat')).toContainText('Delivered')
  expect(frames.leadBlocked.map((f) => f.message.content)).toEqual(['<cross-session-message from-name="Agentville">\nUse knex. Keep the old migrations.\n</cross-session-message>'])
})

test('message: collapsed by default for a live session; Codex says why', async ({ page }) => {
  await page.goto(s.url)
  await inspect(page, claudeId('soloTurn'))
  const d = page.locator('#drawer')
  const toggle = d.locator('[data-ins="msgtoggle"]')
  await expect(toggle).toHaveText('Message Explain the build')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(d.locator('#msg-box')).toHaveCount(0)
  await toggle.click()
  await expect(d.locator('#msg-box')).toBeFocused()
  await d.locator('#msg-box').fill('Also update the docs')
  await d.locator('#msg-box').press('Control+Enter') // goes to the preview, never straight to sending
  await expect(d.locator('#msg-preview')).toContainText('Also update the docs')
  await d.locator('[data-ins="msgsend"]').click()
  await expect(d.locator('.msgstat')).toContainText('Delivered')
  await reinspect(page, `codex:${IDS.codexTurn}`)
  await expect(d.locator('.facts')).toContainText('Codex')
  await d.locator('[data-ins="msgtoggle"]').click()
  await expect(d.locator('.composebox')).toContainText("Codex threads can't be messaged from here. Reply in Codex.")
})

test('inspector: changed files (paths and counts only) and each PR with checks and review', async ({ page }, ti) => {
  await page.goto(s.url)
  await inspect(page, claudeId('leadBuilding'))
  const d = page.locator('#drawer')
  await expect(d.locator('#chg-h')).toHaveText('Changes +188 −12 · 4 files', { timeout: 15_000 })
  await expect(d.locator('.chg .helper')).toHaveText('Against main · on api-v2 · paths and line counts only')
  await expect(d.locator('.chg .files li')).toHaveText([/^README\.md\s*\+4\s*−2$/, /^src\/api\.js\s*\+120\s*−10$/, /^src\/api\.test\.js\s*new, untracked$/, /^src\/routes\.js\s*\+64\s*−0$/])
  await expect(d.locator('.chg')).not.toContainText('v2 0') // never file content
  await expect(d.locator('.prs li')).toHaveText([/^#101\s*Open\s*Checks: 1 failed, 2 pending, 7 passed\s*Review required$/])
  await shot(page, ti, 'agents-inspector-changes')
})

test('new agent: the sheet shows the exact command, starts once, and the agent appears', async ({ page }, ti) => {
  await page.goto(s.url)
  await page.locator('#view-team').click()
  await page.locator('#btn-new').click()
  const sh = page.locator('#newagent')
  await expect(sh.locator('h2')).toHaveText('New agent')
  // Never disabled for bad input: an empty prompt is explained.
  await sh.locator('[data-na="review"]').click()
  await expect(sh.locator('#na-err')).toHaveText('Write a prompt for the new agent.')
  await expect(sh.locator('[name="prompt"]')).toBeFocused()
  await sh.locator('[name="prompt"]').fill('Write the release notes for v2')
  await sh.locator('[name="aname"]').fill('Release notes')
  await sh.locator('[name="model"]').selectOption('sonnet')
  await sh.locator('[name="effort"]').selectOption('high')
  await sh.locator('[name="mode"]').selectOption('acceptEdits')
  await sh.locator('[name="worktree"]').check()
  if (!isMobile(ti)) {
    const axe = await new AxeBuilder({ page }).include('#newagent').analyze()
    expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([])
  }
  await shot(page, ti, 'agents-new-form')
  await sh.locator('[data-na="review"]').click()
  await expect(sh.locator('#na-cmd')).toHaveText("claude --bg '--name=Release notes' --model=sonnet --effort=high --permission-mode=acceptEdits --worktree -- 'Write the release notes for v2'")
  expect(runs()).toHaveLength(0)
  await shot(page, ti, 'agents-new-confirm')
  await sh.locator('[data-na="start"]').click()
  await expect(sh.locator('h2')).toHaveText('Started Release notes')
  await expect(sh.locator('[data-na="show"]')).toBeVisible({ timeout: 10_000 })
  expect(runs().map((r) => r.argv)).toEqual([['--bg', '--name=Release notes', '--model=sonnet', '--effort=high', '--permission-mode=acceptEdits', '--worktree', '--', 'Write the release notes for v2']])
  await sh.locator('[data-na="show"]').click()
  await expect(page.locator('#drawer h3')).toHaveText('Release notes')
})

test('stop job and fork: confirm shows the command; interactive sessions are refused with the reason', async ({ page }) => {
  await page.goto(s.url)
  await inspect(page, claudeId('leadCi'))
  const d = page.locator('#drawer')
  await d.locator('[data-act="stop"]').click()
  await expect(d.locator('#act-cmd')).toHaveText(`claude stop ${IDS.leadCi.slice(0, 8)}`)
  await expect(d.locator('.actbox')).toContainText(`claude attach ${IDS.leadCi.slice(0, 8)} opens it again`)
  expect(runs()).toHaveLength(0)
  await d.locator('[data-ins="actrun"]').click()
  await expect(d.locator('.msgstat')).toContainText('Stopped')
  expect(runs().map((r) => r.argv)).toEqual([['stop', IDS.leadCi.slice(0, 8)]])

  await reinspect(page, claudeId('soloTurn'))
  await expect(d.locator('h3')).toHaveText('Explain the build')
  await d.locator('[data-act="stop"]').click()
  await expect(d.locator('.actbox .err')).toContainText('This is an interactive session, not a background job.')
  await d.locator('[data-act="fork"]').click()
  await d.locator('#fork-name').fill('Explain, take two')
  await d.locator('[data-ins="actreview"]').click()
  await expect(d.locator('#act-cmd')).toHaveText(`claude --resume ${IDS.soloTurn} --fork-session --bg '--name=Explain, take two'`)
  await d.locator('[data-ins="actrun"]').click()
  await expect(d.locator('.msgstat')).toContainText('Forked')
  expect(runs().at(-1).argv).toEqual(['--resume', IDS.soloTurn, '--fork-session', '--bg', '--name=Explain, take two'])
  await expect(d.locator('[data-ins="actgoto"]')).toBeVisible({ timeout: 10_000 })
})

test('search: conversation names, resting ones included, open the agent; settings offer the notifications', async ({ page }) => {
  await page.goto(s.url)
  await page.locator('#q').fill('invoice')
  const res = page.locator('#list .sec.conv')
  await expect(res.locator('h2')).toHaveText('Conversations by name · 1')
  await expect(res.locator('.convrow .cn')).toHaveText('invoice-bot')
  await expect(res.locator('.convrow .cm')).toHaveText('demo-app · 3d ago · now “Old prompt”')
  await res.locator('.convrow').click()
  await expect(page.locator('#drawer h3')).toHaveText('Old prompt')
  await page.locator('#btn-settings').click()
  for (const k of ['input', 'finished', 'checks']) await expect(page.locator(`#pop-settings [data-set="notify-${k}"]`)).not.toBeChecked()
})
