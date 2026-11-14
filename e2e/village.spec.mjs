// The village art (docs/DESIGN.md §11): sprite sheets load, day/night, selection both ways, the procedural
// fallback when the sheets are missing, and a 2560px big-home overview. Shared fixture server.
import { test, expect, startDocked } from './fixtures.mjs'
import { SHOTS, claudeId, clearOverrides, prepareBigHome, startServer, tmpDir, nextPort, row, villagerPoint } from './helpers.mjs'

const isMobile = (testInfo) => testInfo.project.name === 'mobile'

test.beforeEach(async ({ request }, testInfo) => {
  test.skip(isMobile(testInfo), 'the docked panel covers the village on a phone')
  await clearOverrides(request)
})

for (const night of ['0', '1']) {
  test(`sprite art renders (${night === '1' ? 'night' : 'day'}), stalled tags stay legible`, async ({ page }) => {
    await page.goto(`/?night=${night}`)
    await page.evaluate(() => localStorage.clear())
    await page.goto(`/?night=${night}`)
    await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
    await expect(page.locator('#labels .tag.st').first()).toBeVisible()
    await expect(page.locator('#labels .sign', { hasText: 'demo-app' })).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/desktop-village-${night === '1' ? 'night' : 'day'}.png` })
  })
}

test('selecting a row puts the marker on its villager; clicking a villager selects its row', async ({ page }) => {
  await page.goto('/?night=0&debug')
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await row(page, claudeId('leadCi')).click()
  await expect(page.locator('#labels .tag.sel')).toHaveText('CI Lead')
  await page.screenshot({ path: `${SHOTS}/desktop-village-art-selected.png` })
  await page.keyboard.press('Escape')
  await expect(page.locator('#labels .tag.st', { hasText: 'DB Lead' })).toBeVisible()
  const p = await villagerPoint(page, claudeId('leadBlocked'))
  await page.mouse.click(p.x, p.y)
  await expect(row(page, claudeId('leadBlocked'))).toHaveAttribute('aria-current', 'true')
  // Clicking empty ground (the road in the corner) still deselects.
  const cv = await page.locator('#cv').boundingBox()
  await page.mouse.click(cv.x + 6, cv.y + 6)
  await expect(page).not.toHaveURL(/#agent=/)
  await expect(page.locator('#list .row[aria-current="true"]')).toHaveCount(0)
})

test('the isometric (2.5D) view, the only one: no black patches, villagers still clickable, no view toggle', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'village is behind the panel on mobile')
  await page.goto('/?night=0&debug')
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await expect.poll(() => page.evaluate(() => window.villageDebug().iso)).toBe(true)
  // The top-down view and its toggle were removed.
  await expect(page.locator('#view-toggle')).toHaveCount(0)
  // Nothing drawn black behind the buildings (a bug once stacked dark patches there): ink outlines
  // and shadows are ~1.5% of the canvas, the black patches made it ~3.5%.
  const dark = () => page.evaluate(() => { const c = document.getElementById('cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 80) n++; return n / (d.length / 4) })
  await page.waitForTimeout(500)
  expect(await dark()).toBeLessThan(0.025)
  // Every villager is drawn, and a click on one still selects its row.
  const p = await villagerPoint(page, claudeId('leadBlocked'))
  await page.mouse.click(p.x, p.y)
  await expect(row(page, claudeId('leadBlocked'))).toHaveAttribute('aria-current', 'true')
  await page.screenshot({ path: `${SHOTS}/desktop-village-iso.png` })
  await page.goto('/?night=1&debug')
  await expect.poll(() => page.evaluate(() => window.villageDebug().iso)).toBe(true)
  await page.screenshot({ path: `${SHOTS}/desktop-village-iso-night.png` })
})

// The 2.5D view's depth and placement: nobody stands on a roof, nobody stands inside a building, no
// building stands in the sea. depthCheck() lists every villager whose feet land on a building's drawn
// pixels yet was drawn after it (i.e. on top of its roof); it must be empty at every zoom.
// `data-art=ready` only says the sprite sheets loaded. The world (and villageDebug().items) is laid out
// once the first /api/agents reply arrives, which on a big home can come later: wait for that too.
const layoutReady = (page) => page.waitForFunction(() => (window.villageDebug?.().items?.length || 0) > 0 && window.villageDebug().hits.length > 0)
async function checkIsoPlacement(page) {
  await layoutReady(page)
  const d = await page.evaluate(() => { const d = window.villageDebug(); return { items: d.items, hits: d.hits, depth: d.depthCheck(), iso: d.iso } })
  expect(d.iso).toBe(true)
  expect(d.depth, 'villagers drawn on top of a roof').toEqual([])
  for (const it of d.items) expect(it.wet, `${it.id} stands in the water`).toBe(0)
  const fps = d.items.filter((it) => it.kind !== 'decor')
  for (const h of d.hits) {
    const inside = fps.find((it) => h.wx > it.x * 16 && h.wx < (it.x + it.w) * 16 && h.wy > it.y * 16 && h.wy < (it.y + it.h) * 16)
    expect(inside?.id, `${h.id} stands inside a building`).toBeUndefined()
  }
  return d
}

test('the isometric view: nobody on a roof or inside a building, every building on land', async ({ page }) => {
  await page.goto('/?night=0&debug')
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await page.waitForTimeout(400)
  const d = await checkIsoPlacement(page)
  expect(d.hits.length).toBeGreaterThan(5)
  for (let i = 0; i < 2; i++) {
    await page.locator('#cv').focus()
    await page.keyboard.press('+')
    await page.waitForTimeout(300)
    await checkIsoPlacement(page)
  }
  // A villager behind a house is drawn behind it (showing through as a silhouette), and is still clickable.
  const hidden = await page.evaluate(() => window.villageDebug().hidden)
  if (hidden.length) {
    const p = await villagerPoint(page, hidden[0])
    if (p) {
      await page.mouse.click(p.x, p.y)
      await expect(row(page, hidden[0])).toHaveAttribute('aria-current', 'true')
    }
  }
  await page.screenshot({ path: `${SHOTS}/desktop-village-iso-close.png` })
})

test('a saved lot from another neighbourhood is not reused: the home moves into its own block, on land', async ({ page }) => {
  // An agent whose project changed keeps its id; its old lot (here far out to sea) must not be reused.
  const id = claudeId('leadCi')
  await page.addInitScript((id) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('va.world5', JSON.stringify({ blocks: { 'renamed-away': { x: 70, y: 70, w: 10, h: 8, acc: 0, seen: Date.now() } }, pos: { [`home:${id}`]: [72, 72, 4, 3, 1, 'renamed-away'] } }))
  }, id)
  await page.goto('/?night=0&debug')
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await layoutReady(page)
  const d = await page.evaluate(() => window.villageDebug())
  const it = d.items.find((i) => i.id === `home:${id}`)
  const b = d.villages.find((v) => v.name === it.village).block
  expect(it.x >= b.x && it.y >= b.y && it.x + it.w <= b.x + b.w && it.y + it.h <= b.y + b.h, 'inside its own block').toBe(true)
  await checkIsoPlacement(page)
})

test('big home in the isometric view: depth and land hold at every zoom', async ({ browser }) => {
  const s = await startServer(prepareBigHome(tmpDir('village-big-iso'), 160), nextPort())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await startDocked(page)
  try {
    await page.goto(`${s.url}/?night=0&debug`)
    await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
    await page.waitForTimeout(400)
    for (let i = 0; i < 3; i++) {
      if (i) { await page.locator('#cv').focus(); await page.keyboard.press('+'); await page.waitForTimeout(300) }
      await checkIsoPlacement(page)
    }
    await page.screenshot({ path: `${SHOTS}/wide-village-iso.png` })
  } finally { await page.close(); await s.stop() }
})

test('missing sprite sheets fall back to the procedural village', async ({ page }) => {
  await page.route('**/assets/ninja-adventure/**', (r) => r.abort())
  await page.goto('/')
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'failed')
  await expect(page.locator('#labels .tag.st').first()).toBeVisible()
  await row(page, claudeId('leadCi')).click()
  await expect(page.locator('#labels .tag.sel')).toHaveText('CI Lead')
})

test('big home: 2560px overview at 2× (crowd caps, tags not stacked)', async ({ browser }) => {
  const s = await startServer(prepareBigHome(tmpDir('village-big'), 160), nextPort())
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } })
  await startDocked(page)
  try {
    await page.goto(`${s.url}/?night=0`)
    await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
    await page.locator('#zoom-out').click()
    await page.waitForTimeout(500)
    // Placed tags never overlap each other.
    const boxes = await page.locator('#labels .tag').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.top, r.right, r.bottom]))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]]
      expect(a[0] < b[2] - 1 && a[2] > b[0] + 1 && a[1] < b[3] - 1 && a[3] > b[1] + 1, `tags ${i} and ${j} overlap`).toBe(false)
    }
    await page.screenshot({ path: `${SHOTS}/wide-village.png` })
  } finally { await page.close(); await s.stop() }
})
