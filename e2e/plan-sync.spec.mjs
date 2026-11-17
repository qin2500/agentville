// Town plan sync end to end (web/src/plan-sync.js, server/world-plan.mjs): its own server with world-plan sync ON (the shared
// e2e server runs with it off). Two windows are two browser contexts, because a context is what owns a localStorage.
//   1. the town the first window saves is mirrored to the server,
//   2. a fresh window adopts it,
//   3. a window with a different, never-synced town keeps its own and offers the two choices in Settings, and
//   4. nothing switches by itself; only a click does.
import { test, expect } from './fixtures.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { prepareBigHome, startServer, tmpDir, nextPort } from './helpers.mjs'
import { engineReady, layoutReady } from './engine-helpers.mjs'

test.describe.configure({ mode: 'serial' })

let s, home
test.beforeAll(async () => { home = prepareBigHome(tmpDir('plan-sync'), 40); s = await startServer({ ...home, AGENTVILLE_WORLD_PLAN: '1' }, nextPort()) })
/** A new session in a new project: every open village rebuilds (and saves its layout) on its next poll. */
function addProject(name) {
  const sid = `f${String(Date.now()).slice(-7)}-0000-4000-8000-000000000000`, ts = new Date().toISOString()
  const folder = path.join(home.AGENTVILLE_CLAUDE_HOME, 'projects', `-work-${name}`)
  fs.mkdirSync(folder, { recursive: true })
  const recs = [{ type: 'user', sessionId: sid, cwd: `/work/${name}`, uuid: `${sid}-u`, timestamp: ts, message: { role: 'user', content: `New work in ${name}` } },
    { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }]
  fs.writeFileSync(path.join(folder, `${sid}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.writeFileSync(path.join(home.AGENTVILLE_CLAUDE_HOME, 'sessions', `${sid.slice(0, 8)}.json`), JSON.stringify({ pid: 1, sessionId: sid, kind: 'interactive' }))
}
test.afterAll(async () => { await s?.stop() })

// The engine refreshes each block's `seen` stamp on every load, so equal towns are compared without it.
const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'seen' ? undefined : x)))
const OTHER = 'Use the town saved by your other window'
const plan = async () => (await fetch(`${s.url}/api/world-plan`)).json()
const layoutKey = (page) => page.evaluate(() => Object.keys(localStorage).find((k) => /^va\.engine2\.world(\.[a-z0-9.-]+)?$/.test(k) && !k.endsWith('.demo')) ?? null)
const local = (page, k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), k)
const backups = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('va.worldplan.backup.')))

async function open(browser, init) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  if (init) await ctx.addInitScript(init.fn, init.arg)
  const page = await ctx.newPage()
  await page.addInitScript(() => { try { if (localStorage.getItem('va.panel') === null) localStorage.setItem('va.panel', '"docked"'); localStorage.setItem('va.planSync', 'true') } catch {} })
  await page.goto(`${s.url}/?engine=2&debug&night=0`)
  await engineReady(page)
  await layoutReady(page)
  return { ctx, page }
}

let key, saved
test('the town the first window saves is mirrored to the server', async ({ browser }) => {
  const { ctx, page } = await open(browser)
  try {
    key = await layoutKey(page)
    expect(key, 'the engine saved a layout').toMatch(/^va\.engine2\.world/)
    await expect.poll(async () => (await plan()).keys?.[key]?.rev ?? 0, { timeout: 20_000 }).toBeGreaterThan(0)
    saved = (await plan()).keys[key]
    expect(norm(saved.value)).toEqual(norm(await local(page, key)))
    expect(await backups(page), 'the first window has nothing to choose').toEqual([])
  } finally { await ctx.close() }
})

test('a fresh window adopts the saved town and shows no conflict', async ({ browser }) => {
  const { ctx, page } = await open(browser)
  try {
    expect(norm(await local(page, key))).toEqual(norm(saved.value))
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('va.worldplan.revs'))))[key].rev).toBeGreaterThanOrEqual(saved.rev)
    expect(await backups(page)).toEqual([])
    await page.locator('#btn-settings').click()
    await expect(page.locator('.plan-conflict')).toHaveCount(0)
    await page.waitForTimeout(2500) // let the load's own `seen` refresh reach the server before the next window starts
  } finally { await ctx.close() }
})

// Two windows open at once, each reloaded: every load re-stamps the blocks' `seen`, but that is the same town
// (plan-sync.js townKey). Neither window gets a backup, the Settings choice or the toast, and the server rev rises by at
// most one `seen` refresh per window (SEEN_PUSH_MS), not once per load.
test('two windows open at once and reloading stay one town: no choice, no toast, no PUT per load', async ({ browser }) => {
  saved = (await plan()).keys[key]
  const a = await open(browser), b = await open(browser)
  try {
    for (let i = 0; i < 2; i++) {
      for (const w of [a, b]) { await w.page.reload(); await engineReady(w.page); await layoutReady(w.page) }
      await a.page.waitForTimeout(2000) // past the mirror's 1.5 s debounce: a per-load push would have landed
    }
    for (const { page } of [a, b]) {
      expect(await backups(page), 'no 409 on the same town').toEqual([])
      await expect(page.getByText('Another window saved a different town')).toHaveCount(0)
      await page.locator('#btn-settings').click()
      await expect(page.locator('.plan-conflict')).toHaveCount(0)
    }
    const now = (await plan()).keys[key]
    expect(norm(now.value)).toEqual(norm(saved.value))
    expect(now.rev - saved.rev, 'at most one seen refresh per window').toBeLessThanOrEqual(2)
  } finally { await a.ctx.close(); await b.ctx.close() }
})

// A different town this window made on its own (never synced): the layout plus a marker the engine passes through.
const conflicting = { fn: ({ k, value }) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem(k, JSON.stringify({ ...value, marker: 'this-window' })) }, get arg() { return { k: key, value: saved.value } } }

test('a conflicting local town: Settings offers both choices and nothing switches', async ({ browser }) => {
  saved = (await plan()).keys[key]
  const { ctx, page } = await open(browser, conflicting)
  try {
    expect(await backups(page), 'the server copy is kept aside').toEqual([`va.worldplan.backup.${key}`])
    await page.locator('#btn-settings').click()
    const note = page.locator('.plan-conflict')
    await expect(note).toBeVisible()
    await expect(note.getByRole('button', { name: OTHER })).toBeVisible()
    await expect(note.getByRole('button', { name: 'Keep this one' })).toBeVisible()
    // Not switched: this window still holds its own town, and the server still holds the saved one.
    expect((await local(page, key)).marker).toBe('this-window')
    await page.waitForTimeout(2500) // longer than the mirror's debounce: a stray push would show by now
    expect((await plan()).keys[key]).toEqual(saved)
  } finally { await ctx.close() }
})

test('"Use the town saved by your other window" switches this window to the server town', async ({ browser }) => {
  saved = (await plan()).keys[key]
  const { ctx, page } = await open(browser, conflicting)
  try {
    await page.locator('#btn-settings').click()
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: OTHER }).click()])
    await engineReady(page)
    expect((await local(page, key)).marker).toBeUndefined()
    expect(norm(await local(page, key))).toEqual(norm(saved.value))
    expect(await backups(page)).toEqual([])
    await page.waitForTimeout(2500)
  } finally { await ctx.close() }
})

test('"Keep this one" saves this window\'s town to the server', async ({ browser }) => {
  saved = (await plan()).keys[key]
  const { ctx, page } = await open(browser, conflicting)
  try {
    await page.locator('#btn-settings').click()
    await page.getByRole('button', { name: 'Keep this one' }).click()
    await expect.poll(async () => (await plan()).keys[key].value.marker).toBe('this-window')
    expect((await plan()).keys[key].rev).toBeGreaterThan(saved.rev)
    // the page drops its backup after it reads the server's reply, a moment after the server has the town
    await expect.poll(() => backups(page)).toEqual([])
  } finally { await ctx.close() }
})

// Two tabs of ONE context share one localStorage (M7 review must-fix 1). Tab 1 shows the saved town; another window
// then saves a different town; tab 2 (same context) adopts it, which moves the shared revs. A new project makes tab 1
// rebuild and save its own, older town. Its push is based on the rev tab 1 itself synced, so the server refuses it
// (409): tab 1 goes stale with the Settings choice, the other window's town stays on the server, nothing switches.
test('two tabs of one browser: the tab still showing the older town never pushes over the newer one', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await ctx.addInitScript(() => { try { if (localStorage.getItem('va.panel') === null) localStorage.setItem('va.panel', '"docked"'); localStorage.setItem('va.planSync', 'true') } catch {} })
  try {
    const page1 = await ctx.newPage()
    const tab1Puts = []
    page1.on('response', (r) => { if (r.request().method() === 'PUT' && r.url().endsWith('/api/world-plan')) tab1Puts.push(r.status()) })
    await page1.goto(`${s.url}/?engine=2&debug&night=0`)
    await engineReady(page1); await layoutReady(page1)
    key ??= await layoutKey(page1) // (when run on its own)
    await expect.poll(async () => (await plan()).keys?.[key]?.rev ?? 0, { timeout: 20_000 }).toBeGreaterThan(0)
    await page1.waitForTimeout(2500) // tab 1's own push or `seen` refresh, if any, lands first
    const base = (await plan()).keys[key]
    // Another window saves a different town.
    const other = { ...base.value, marker: 'other-window' }
    const elsewhere = await browser.newContext() // its own browser storage: a page on the app's origin, no village
    try {
      const w = await elsewhere.newPage()
      await w.goto(`${s.url}/api/agents`)
      const status = await w.evaluate(async (body) => (await fetch('/api/world-plan', { method: 'PUT', headers: { 'content-type': 'application/json' }, body })).status,
        JSON.stringify({ key, value: other, baseRev: base.rev }))
      expect(status).toBe(200)
    } finally { await elsewhere.close() }
    const theirs = (await plan()).keys[key]
    // Tab 2 of the same browser starts: it adopts the newer town (the shared revs move to its rev).
    const page2 = await ctx.newPage()
    await page2.goto(`${s.url}/?engine=2&debug&night=0`)
    await engineReady(page2); await layoutReady(page2)
    expect((await local(page2, key)).marker, 'tab 2 adopted the newer town').toBe('other-window')
    // Tab 2 goes to the background (its polls slow to 15 s), so tab 1 is the one that rebuilds and saves next.
    await page2.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }) })
    await page1.waitForTimeout(2500) // tab 2's last 2 s poll has run and the next is 15 s away
    tab1Puts.length = 0
    addProject('two-tabs') // tab 1 rebuilds on its next poll and saves its own (older) town
    await expect.poll(() => tab1Puts.length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(tab1Puts, "tab 1's push is based on the rev tab 1 synced: refused").toEqual(tab1Puts.map(() => 409))
    await expect.poll(() => backups(page1)).toEqual([`va.worldplan.backup.${key}`])
    const now = (await plan()).keys[key]
    expect(now.rev, "nothing was pushed over the other window's town").toBe(theirs.rev)
    expect(now.value.marker).toBe('other-window')
    // Tab 1 is offered the choice in Settings; nothing switched by itself.
    await page1.locator('#btn-settings').click()
    await expect(page1.locator('.plan-conflict').getByRole('button', { name: OTHER })).toBeVisible()
    await expect(page1.locator('.plan-conflict').getByRole('button', { name: 'Keep this one' })).toBeVisible()
    // Tab 2 is up to date: no note there, although the backup sits in the localStorage both tabs share.
    await page2.locator('#btn-settings').click()
    await expect(page2.locator('#pop-settings')).toBeVisible()
    await expect(page2.locator('.plan-conflict')).toHaveCount(0)
    // Tab 2 writes the shared localStorage last; "Keep this one" in tab 1 must still push tab 1's own town.
    await page2.evaluate(({ k, v }) => localStorage.setItem(k, JSON.stringify(v)), { k: key, v: other })
    const kept = page1.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/world-plan'))
    await page1.locator('.plan-conflict').getByRole('button', { name: 'Keep this one' }).click()
    const sent = JSON.parse((await kept).postData())
    expect(sent.value.marker, "tab 1's own town, not tab 2's write").not.toBe('other-window')
    expect(sent.value.blocks, 'tab 1 laid out the new project').toHaveProperty('two-tabs')
    await expect.poll(async () => (await plan()).keys[key].rev).toBeGreaterThan(theirs.rev)
    expect(norm((await plan()).keys[key].value)).toEqual(norm(sent.value))
    expect(norm(await local(page1, key)), 'localStorage holds the kept town').toEqual(norm(sent.value))
    await expect(page1.locator('.plan-conflict')).toHaveCount(0)
    expect(await backups(page1)).toEqual([])
  } finally { await ctx.close() }
})

// Opt-in (default off): a window that never turned sync on makes no /api/world-plan request, even with the server ready
// for it, and Settings shows the toggle (unchecked) but no conflict note.
test('sync off by default: no /api/world-plan request and no conflict note', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  const hits = []
  page.on('request', (r) => { if (r.url().includes('/api/world-plan')) hits.push(r.method()) })
  try {
    await page.addInitScript(() => { try { if (localStorage.getItem('va.panel') === null) localStorage.setItem('va.panel', '"docked"') } catch {} })
    await page.goto(`${s.url}/?engine=2&debug&night=0`)
    await engineReady(page); await layoutReady(page)
    await page.waitForTimeout(2500)
    await page.locator('#btn-settings').click()
    await expect(page.locator('[data-set="plansync"]')).not.toBeChecked()
    await expect(page.locator('.plan-conflict')).toHaveCount(0)
    expect(hits, 'nothing asked the world-plan endpoint').toEqual([])
  } finally { await ctx.close() }
})
