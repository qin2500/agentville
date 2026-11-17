// Helpers for e2e/engine.spec.mjs: the village engine v2 (?engine=2) exposes the same villageDebug() shape
// as classic where the specs overlap (view {vx:0,vy:0,k:1,px:1,bw,bh}, hits in canvas css px, badges, clusters,
// items in tiles), so these only add the engine-specific bits. Nothing here touches classic code.
import { expect } from '@playwright/test'

/** A village URL on engine v2 with the debug exposures on. `q` is the rest of the query ("night=0", ...). */
// E2E_ENGINE=1 re-points the spec at classic, only to check the spec's own logic where the two overlap (never committed as a run).
export const ENGINE = process.env.E2E_ENGINE || '2'
export const eng = (q = 'night=0') => `/?engine=${ENGINE}&debug${q ? `&${q}` : ''}`
export const dbg = (page) => page.evaluate(() => window.villageDebug())
/** Art is loaded (ready) or has fallen back (failed), and the first /api/agents reply has been laid out. */
export async function engineReady(page, { art = /ready|failed/ } = {}) {
  await expect(page.locator('#cv')).toHaveAttribute('data-art', art)
  await expect.poll(async () => (await dbg(page)).villages?.length ?? 0).toBeGreaterThan(0)
}
/** Items and hits exist (the world is laid out and people are placed). */
export const layoutReady = (page) => page.waitForFunction(() => (window.villageDebug?.().items?.length || 0) > 0 && window.villageDebug().hits.length > 0)
/** Zoom with the keyboard to level z (1, 2, 3, 4; 0.5 = first Map level). Reads the engine camera's z. */
export async function zoomTo(page, z) {
  await page.locator('#cv').focus()
  const at = async () => Math.max(0.5, (await dbg(page)).zoom) // Map levels are fit levels below 1x
  for (let i = 0; i < 6 && (await at()) !== z; i++) await page.keyboard.press((await at()) > z ? '-' : '+')
  expect(await at()).toBe(z)
}
/** Where a villager stands on the page: hits are canvas css px already (view {vx:0,vy:0,k:1,px:1}). */
export async function enginePoint(page, id) {
  const at = () => page.evaluate((id) => {
    const d = window.villageDebug(), h = d.hits.find((x) => x.id === id), v = d.view, s = v.k * v.px
    return h && { x: (h.x + h.w / 2 - v.vx) * s, y: (h.y + h.h - 8 - v.vy) * s }
  }, id)
  let p = await at()
  for (let i = 0; i < 20; i++) { // wait out a camera pan
    await page.waitForTimeout(100)
    const q = await at()
    if (JSON.stringify(q) === JSON.stringify(p)) break
    p = q
  }
  if (!p) return null
  const cv = await page.locator('#cv').boundingBox()
  return { x: cv.x + p.x, y: cv.y + p.y }
}
/** The tile rect of the world, whichever shape debug().bounds has: {ox,oy,w,h}, {x,y,w,h} or [x0,y0,x1,y1]. */
export function boundsRect(b) {
  if (Array.isArray(b)) return { ox: b[0], oy: b[1], w: b[2] - b[0], h: b[3] - b[1] }
  return { ox: b.ox ?? b.x, oy: b.oy ?? b.y, w: b.w, h: b.h }
}
export const pos = (d) => new Map(d.items.map((it) => [it.id, [it.x, it.y]]))
export const blocks = (d) => Object.fromEntries(d.villages.map((v) => [v.name, [v.block.x, v.block.y]]))
/** The always-true placement checks that survive the move off classic: iso, every item dry, no town water, a crowd. */
export async function checkEnginePlacement(page) {
  await layoutReady(page)
  const d = await page.evaluate(() => { const d = window.villageDebug(); return { items: d.items, hits: d.hits, iso: d.iso, townWater: d.townWater } })
  expect(d.iso).toBe(true)
  expect(d.townWater, 'water inside the town').toBe(0)
  for (const it of d.items) expect(it.wet, `${it.id} stands in the water`).toBe(0)
  return d
}
