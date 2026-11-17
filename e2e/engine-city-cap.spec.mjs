// City cap (2026-11-17), headless: a big city at the cap (Settings -> Advanced, va.cityCap) plans at most the lot bucket
// that holds the cap, draws the free lots past it as greens, and screenshots it. Fixture: e2e/fixtures/engine/city-cap.json
// (one tier-3 city of 40 homes plus 2 long-idle ones, 60 subagents, 9 PRs; three small neighbours). Like the harbour spec it
// starts the art-pass vite server on a private port; never a visible window, never a real session.
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

async function open(page, cap) {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(c => { localStorage.setItem('va.cityCap', JSON.stringify(c)); document.addEventListener('DOMContentLoaded', () => document.body.classList.add('village-only')) }, cap)
  await page.goto(`${base}?mock&engine=2&debug&night=0&fixture=city-cap`)
  await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 60000 })
  const v = await page.evaluate(() => window.villageDebug().villages.find(x => x.name === 'citadel'))
  return { v, errors }
}

test('[city-cap] at the cap (40): the 47-lot plan, a screenshot of it', async ({ page }, info) => {
  const { v, errors } = await open(page, 40)
  expect(v.tier).toBe(3)
  expect(v.cap).toBe(47)
  expect(v.block.w * v.block.h).toBeLessThanOrEqual(58 * 43)
  await page.evaluate(b => window.villageSetCamera({ v: 2, x: b.x + b.w / 2, y: b.y + b.h / 2, z: 1 }), v.block)
  await page.waitForFunction(() => { const s = window.villageDebug?.().sprites; return !s || (!s.pending && !s.queued && !s.groundPending) }, null, { timeout: 30000, polling: 100 }).catch(() => {})
  await page.screenshot({ path: info.outputPath('city-cap-40.png') })
  expect(errors).toEqual([])
})

test('[city-cap] no cap (0): the same load plans the bigger 65-lot city', async ({ page }) => {
  const { v, errors } = await open(page, 0)
  expect(v.cap).toBe(65)
  expect(errors).toEqual([])
})
