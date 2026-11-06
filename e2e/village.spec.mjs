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

test('the isometric (2.5D) view: same village, villagers still clickable, and the choice sticks', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'village is behind the panel on mobile')
  await page.goto('/?night=0&debug')
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  // Nothing drawn black behind the buildings (a bug once stacked dark patches there): ink outlines
  // and shadows are ~1.5% of the canvas, the black patches made it ~3.5%.
  const dark = () => page.evaluate(() => { const c = document.getElementById('cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 80) n++; return n / (d.length / 4) })
  await page.waitForTimeout(500)
  expect(await dark()).toBeLessThan(0.025)
  const btn = page.locator('#view-toggle')
  await expect(btn).toHaveText('2D') // automation opens top-down unless asked
  await btn.click()
  await expect(btn).toHaveText('2.5D')
  await expect(btn).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => window.villageDebug().iso)).toBe(true)
  await page.waitForTimeout(500)
  expect(await dark()).toBeLessThan(0.025)
  // Every villager is still drawn, and a click on one still selects its row.
  const p = await villagerPoint(page, claudeId('leadBlocked'))
  await page.mouse.click(p.x, p.y)
  await expect(row(page, claudeId('leadBlocked'))).toHaveAttribute('aria-current', 'true')
  await page.screenshot({ path: `${SHOTS}/desktop-village-iso.png` })
  await page.goto('/?night=1&debug')
  await expect(page.locator('#view-toggle')).toHaveText('2.5D') // remembered
  await page.screenshot({ path: `${SHOTS}/desktop-village-iso-night.png` })
  await page.locator('#cv').focus()
  await page.keyboard.press('i') // I toggles back
  await expect(page.locator('#view-toggle')).toHaveText('2D')
  await page.evaluate(() => localStorage.removeItem('va.iso'))
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
