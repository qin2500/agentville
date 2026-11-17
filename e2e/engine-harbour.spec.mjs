// Engine v2 M5 harbour, headless. Spec: docs/village-engine-v2.md 4.4 and 7.2 (Harbour). Expected to fail until M5 integration.
// The engine reads frozen fixtures (e2e/fixtures/engine/<name>.json) from the art-pass vite server, so this spec starts its
// own on a private port (never a visible window; the playwright webServer is not used for these pages).
// Query: ?mock&engine=2&debug&night=N&fixture=<name>&t=<s>&dockdemo=1&total=0 (total=0: the lifetime floor off, so the tier is the load's).
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import net from 'node:net'

let vite, base
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }); s.on('error', rej) })

test.beforeAll(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}/`
  vite = spawn('node_modules/.bin/vite', ['-c', 'tools/artpass/vite.config.mjs'], { env: { ...process.env, ARTPASS_PORT: String(port) }, stdio: 'ignore' })
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base)).ok) return } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 500)) }
  throw new Error('art-pass vite server did not start')
})
test.afterAll(() => { vite?.kill() })

const url = (fixture, q = '', night = 0) => `${base}?mock&engine=2&debug&night=${night}&fixture=${fixture}&t=120${q ? '&' + q : ''}`
const ready = async page => {
  // village-only before the first frame: the engine draws only while the village is on screen (the default panel may hide it)
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.body.classList.add('village-only')))
  await page.goto(page._u)
  await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 60000 })
}
const open = async (page, fixture, q, night) => { page._u = url(fixture, q, night); await ready(page); return () => page.evaluate(() => window.villageDebug().dock) }
const count = v => (Array.isArray(v) ? v.length : Number.isFinite(v) ? v : (v && typeof v === 'object' ? Object.keys(v).length : 0))
const BASE_Q = 'dockdemo=1&total=0'   // the load alone decides the tier

// pier berths per tier (classic LAYOUT: units 4/4/5/6 per lane, a sloop takes 2): 4, 12, 16, 30
const CASES = [['harbour-3', 1, 4, 3], ['harbour-6', 2, 12, 6], ['harbour-10', 3, 16, 10], ['harbour', 4, 30, 16]]
for (const [fixture, tier, pierBerths, loading] of CASES) {
  test(`[har.tiers-1-4-by-prs-loading] ${fixture}: tier ${tier}, ${pierBerths}+ berths, ${loading} ships`, async ({ page }) => {
    const dock = await open(page, fixture, BASE_Q)
    const d = await dock()
    expect(d, 'debug().dock exists').toBeTruthy()
    expect(d.tier).toBe(tier)
    expect(count(d.berths)).toBeGreaterThanOrEqual(pierBerths)
    expect(count(d.sails), 'one sail per loading PR').toBe(loading)
  })
}

test('[har.shrink-hysteresis-10min] the harbour follows lifetime PRs sailed: harbour-3 with total 123 is tier 4 and never shrinks', async ({ page }) => {
  const dock = await open(page, 'harbour-3', 'dockdemo=1')   // fixture total 123 -> lifetime tier 4
  expect((await dock()).tier).toBe(4)
})

test('[har.berths-and-at-anchor] more ships than pier berths lie at anchor', async ({ page }) => {
  const dock = await open(page, 'harbour', BASE_Q + '&level=1')
  const d = await dock()
  expect(d.tier).toBe(4)
  expect(count(d.berths)).toBeGreaterThan(0)
})

test('[har.dock-debug] debug().dock carries tier, rect, berths, sails, walkers', async ({ page }) => {
  const dock = await open(page, 'harbour-6', BASE_Q)
  const d = await dock()
  for (const k of ['tier', 'rect', 'berths', 'sails', 'walkers']) expect(d, `dock.${k}`).toHaveProperty(k)
})

test('[har.dock-tags] [lbl.ship-pr-tags] [inp.dock-ship-click-va-dock] clicking a ship fires va:dock naming its PR (the href never enters the world)', async ({ page }) => {
  await open(page, 'harbour-6', BASE_Q)
  await page.evaluate(() => { window.__dock = []; window.addEventListener('va:dock', e => window.__dock.push(e.detail ?? null)) })
  const hit = await page.evaluate(() => (window.villageDebug().hits || []).find(h => h.kind === 'ship') || null)
  expect(hit, 'a ship (not pier dock) hit area exists').toBeTruthy()
  const cv = await page.locator('#cv').boundingBox()
  await page.mouse.click(cv.x + (hit.cx ?? hit.x), cv.y + (hit.cy ?? hit.y))
  await expect.poll(() => page.evaluate(() => window.__dock.length)).toBeGreaterThan(0)
  const detail = await page.evaluate(() => window.__dock[0])
  // the click names the ship's own PR (classic: va:dock { href } of the ship): the fixture's dock hrefs end /pull/<n>
  const n = hit.id.split('#').pop()
  expect(detail?.href).toMatch(new RegExp(`/pull/${n}$`))
})

test('[har.dock-panel-summary] clicking a ship opens the dock sheet with loading, delivered today, delivered in all and the level', async ({ page }) => {
  await open(page, 'harbour-6', BASE_Q)
  const hit = await page.evaluate(() => (window.villageDebug().hits || []).find(h => h.kind === 'ship') || null)
  expect(hit, 'a ship (not pier dock) hit area exists').toBeTruthy()
  const cv = await page.locator('#cv').boundingBox()
  await page.mouse.click(cv.x + (hit.cx ?? hit.x), cv.y + (hit.cy ?? hit.y))
  const lede = page.locator('dialog.docksheet .lede')
  await expect(page.locator('dialog.docksheet')).toHaveAttribute('open', '')   // (village-only hides the sheet's box, so not toBeVisible)
  await expect(lede).toHaveText(/^\d+ loading · \d+ delivered today · \d+ delivered in all · Dock level \d+$/)
})

test('[lbl.ship-pr-tags] ship tags show at zoom 3', async ({ page }) => {
  await open(page, 'harbour-6', BASE_Q)
  await page.evaluate(() => window.villageSetCamera({ v: 2, ...(() => { const v = window.villageDebug().venues?.dock; return { x: v?.tx ?? 0, y: v?.ty ?? 0 } })(), z: 3 }))
  await expect.poll(() => page.evaluate(() => (window.villageDebug().labels || []).filter(l => l.key?.startsWith('p:token:') && l.cls === 'tag prt' && /#\d+/.test(l.text || '')).length), { timeout: 10000 }).toBeGreaterThan(0)
})

test('[har.lighthouse-sweep] [har.beacon] [har.level-touches] night: light pools stand at the dock', async ({ page }) => {
  await open(page, 'harbour', BASE_Q, 1)
  const lights = await page.evaluate(() => { const d = window.villageDebug(); return d.lights ?? d.dock?.lights ?? null })
  expect(lights, 'debug exposes the night lights').toBeTruthy()
  const dockRect = await page.evaluate(() => window.villageDebug().dock?.rect)
  expect(dockRect).toBeTruthy()
  const near = (Array.isArray(lights) ? lights : Object.values(lights)).filter(l => {
    const x = l.tx ?? l.x, y = l.ty ?? l.y, r = dockRect
    return x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4
  })
  expect(near.length).toBeGreaterThan(0)
})
