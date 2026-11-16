// Village engine v2 (?engine=2): the assertions of village.spec.mjs and world.spec.mjs ported to the new
// engine, plus the Settings toggle. Every title carries [<parity id>] from docs/engine-parity.json.
// The engine exposes (with ?debug) the classic villageDebug() shape: view {vx:0,vy:0,k:1,px:1,bw,bh}, hits and
// badges in canvas css px, clusters, items in tiles (+ wet), townWater, outdoors, homes, iso:true.
// Classic-only probes are replaced: depthCheck()/flagCheck() are covered by invariants 4-6
// (test/engine-inv4, test/engine-depth, test/engine-art), so those tests are skipped with a pointer.
import { test, expect, startDocked } from './fixtures.mjs'
import { cssToWorld } from '../web/src/engine/camera.js'
import { SHOTS, claudeId, clearOverrides, nextPort, prepareBigHome, startServer, tmpDir, row } from './helpers.mjs'
import { ENGINE, eng, dbg, engineReady, layoutReady, zoomTo, enginePoint, boundsRect, pos, blocks, checkEnginePlacement } from './engine-helpers.mjs'

test.beforeEach(async ({ request, page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the docked panel covers the village on a phone')
  await clearOverrides(request)
  await page.goto(`/?engine=${ENGINE}`)
  await page.evaluate(() => localStorage.clear())
})

async function withPayload(page, edit) {
  const ctl = { edit }
  await page.route('**/api/agents*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    ctl.edit(json)
    await route.fulfill({ response, json })
  })
  return ctl
}
const withProjects = (page, edit) => withPayload(page, (j) => { const p = j.projects?.find((x) => x.name === 'demo-app'); if (p) edit(p) })
const clone = (a, id, project, bucket, agoMs) => ({ ...a, id, name: `${project} ${id.slice(-2)}`, project, bucket, severity: bucket === 'stalled' ? 'attention' : null,
  parentId: null, role: 'solo', prs: [], hidden: false, live: bucket !== 'resting', lastActivityAt: Date.now() - agoMs, since: Date.now() - agoMs })
const DAY = 864e5

// ---------------------------------------------------------------- village.spec
for (const night of ['0', '1']) {
  test(`[test.e2e-world-village-on-engine2] [debug.night-param] [aria.dataset-art-villages-zoom] engine sprite art renders (${night === '1' ? 'night' : 'day'}), stalled tags stay legible`, async ({ page }) => {
    await page.goto(eng(`night=${night}`))
    await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
    await expect(page.locator('#cv')).toHaveAttribute('data-engine', /.+/)
    await engineReady(page)
    await zoomTo(page, 1) // the town fits only at Map 0.5, where tags are hidden by design
    await expect(page.locator('#labels .tag.st').first()).toBeVisible()
    await expect(page.locator('#labels .sign', { hasText: 'demo-app' })).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/engine-village-${night === '1' ? 'night' : 'day'}.png` })
  })
}

test('[test.e2e-world-village-on-engine2] [vil.selection-marker-rims] [inp.click-select] selecting a row marks its villager; clicking a villager selects its row', async ({ page }) => {
  await page.goto(eng())
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await row(page, claudeId('leadCi')).click()
  await expect(page.locator('#labels .tag.sel')).toHaveText('CI Lead')
  await page.screenshot({ path: `${SHOTS}/engine-village-art-selected.png` })
  await page.keyboard.press('Escape')
  await expect(page.locator('#labels .tag.st', { hasText: 'DB Lead' })).toBeVisible()
  const p = await enginePoint(page, claudeId('leadBlocked'))
  await page.mouse.click(p.x, p.y)
  await expect(row(page, claudeId('leadBlocked'))).toHaveAttribute('aria-current', 'true')
  const cv = await page.locator('#cv').boundingBox() // empty ground in the corner deselects
  const spot = await page.evaluate(({ w, h }) => { // a truly empty point: pick() is null there
    const d = window.villageDebug()
    for (let gy = 6; gy < h; gy += 24) for (let gx = 6; gx < w; gx += 24) if (d.pick(gx, gy) == null) return { x: gx, y: gy }
    return null
  }, { w: cv.width, h: cv.height })
  expect(spot, 'an empty point on the canvas').not.toBeNull()
  await page.mouse.click(cv.x + spot.x, cv.y + spot.y)
  await expect(page).not.toHaveURL(/#agent=/)
  await expect(page.locator('#list .row[aria-current="true"]')).toHaveCount(0)
})

test('[test.e2e-world-village-on-engine2] [debug.villagedebug] the isometric view, the only one: no black patches, villagers still clickable, no view toggle', async ({ page }) => {
  await page.goto(eng())
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await expect.poll(() => page.evaluate(() => window.villageDebug().iso)).toBe(true)
  await expect(page.locator('#view-toggle')).toHaveCount(0)
  const dark = () => page.evaluate(() => { const c = document.getElementById('cv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 80) n++; return n / (d.length / 4) })
  await page.waitForTimeout(500)
  expect(await dark()).toBeLessThan(0.025)
  const p = await enginePoint(page, claudeId('leadBlocked'))
  await page.mouse.click(p.x, p.y)
  await expect(row(page, claudeId('leadBlocked'))).toHaveAttribute('aria-current', 'true')
  await page.screenshot({ path: `${SHOTS}/engine-village-iso.png` })
  await page.goto(eng('night=1'))
  await expect.poll(() => page.evaluate(() => window.villageDebug().iso)).toBe(true)
  await page.screenshot({ path: `${SHOTS}/engine-village-iso-night.png` })
})

test('[test.e2e-world-village-on-engine2] [test.items-wet-zero] [test.townwater-zero] every item is dry and the town has no water; zoom keeps it so', async ({ page }) => {
  await page.goto(eng())
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await page.waitForTimeout(400)
  const d = await checkEnginePlacement(page)
  expect(d.hits.length).toBeGreaterThan(5)
  expect(d.items.length).toBeGreaterThan(0)
  for (let i = 0; i < 2; i++) {
    await page.locator('#cv').focus()
    await page.keyboard.press('+')
    await page.waitForTimeout(300)
    await checkEnginePlacement(page)
  }
  await page.screenshot({ path: `${SHOTS}/engine-village-iso-close.png` })
})

// The engine's depth check (replaces classic depthCheck(): invariants 4-6 are unit-tested in test/engine-inv4, engine-depth and
// engine-art). Here, in the real app: the feet of every villager are mapped back to a world tile through the live camera, and
// nobody stands inside a building's footprint (a door sits on its south edge, so the footprint is shrunk by a quarter tile);
// a villager hidden behind a house is drawn behind it (occluded), keeps a hit area and is still clickable.
async function checkEngineDepth(page) {
  await layoutReady(page)
  const d = await page.evaluate(() => { const d = window.villageDebug(); return { items: d.items, hits: d.hits, cam: d.cam, view: d.view } })
  const vp = { w: d.view.bw, h: d.view.bh }, fps = d.items.filter((it) => it.kind !== 'decor'), E = 0.25
  expect(fps.length, 'buildings to check against').toBeGreaterThan(0)
  let onScreen = 0
  for (const h of d.hits.filter((x) => x.id && x.pose !== undefined)) {
    const foot = { x: h.x + h.w / 2, y: h.y + h.h - 3 }
    if (foot.x < 0 || foot.y < 0 || foot.x > vp.w || foot.y > vp.h) continue
    onScreen++
    const t = cssToWorld(d.cam, vp, foot.x, foot.y)
    const inside = fps.find((it) => t.tx > it.x + E && t.tx < it.x + it.w - E && t.ty > it.y + E && t.ty < it.y + it.h - E)
    expect(inside?.id, `${h.id} stands inside a building (tile ${t.tx.toFixed(2)}, ${t.ty.toFixed(2)})`).toBeUndefined()
  }
  return { ...d, onScreen }
}

test('[test.depth-check-replaced] depth check on the engine: nobody stands inside a building at every zoom, and a villager behind a house is still clickable', async ({ page }) => {
  await page.goto(eng())
  await engineReady(page)
  await layoutReady(page)
  await page.waitForTimeout(400)
  for (let i = 0; i < 3; i++) {
    if (i) { await page.locator('#cv').focus(); await page.keyboard.press('+'); await page.waitForTimeout(400) }
    const d = await checkEngineDepth(page)
    if (i === 2) expect(d.onScreen, 'villagers in view at 2x').toBeGreaterThan(0)
  }
  const { hits } = await dbg(page)
  const hidden = hits.find((h) => h.id && h.pose !== undefined && h.occluded)
  if (hidden) {
    const p = await enginePoint(page, hidden.id)
    if (p) {
      await page.mouse.click(p.x, p.y)
      await expect(row(page, hidden.id)).toHaveAttribute('aria-current', 'true')
    }
  }
})

test('[world.persisted-layout] a saved lot from another neighbourhood is not reused (engine keeps its own layout store)', async ({ page }) => {
  test.skip(true, 'classic seeds va.world5; the engine persists va.engine2.world.<mod> (world/persist.js). Covered by test/engine-persist; no e2e seam to seed a foreign lot.')
})

test('[test.e2e-world-village-on-engine2] [test.townwater-zero] [test.items-wet-zero] big home: land holds at every zoom', async ({ browser }) => {
  const s = await startServer(prepareBigHome(tmpDir('engine-big-iso'), 160), nextPort())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await startDocked(page)
  try {
    await page.goto(`${s.url}${eng()}`)
    await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
    await page.waitForTimeout(400)
    for (let i = 0; i < 3; i++) {
      if (i) { await page.locator('#cv').focus(); await page.keyboard.press('+'); await page.waitForTimeout(300) }
      await checkEnginePlacement(page)
    }
    await page.screenshot({ path: `${SHOTS}/engine-wide-village-iso.png` })
  } finally { await page.close(); await s.stop() }
})

test('[test.e2e-world-village-on-engine2] [aria.dataset-art-villages-zoom] paper dolls need no sticker sheets: blocked sheets still give data-art=ready', async ({ page }) => {
  await page.route('**/assets/ninja-adventure/**', (r) => r.abort())
  await page.goto(eng(''))
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
  await engineReady(page)
})

test('[test.e2e-world-village-on-engine2] [aria.dataset-art-villages-zoom] missing sprite sheets fall back to the procedural village (data-art=failed)', async ({ page }) => {
  // The sticker sheets only matter on the ?folk=ninja path since M6 (paper dolls are code-drawn and never fail).
  await page.route('**/assets/ninja-adventure/**', (r) => r.abort())
  await page.goto(eng('folk=ninja'))
  await expect(page.locator('#cv')).toHaveAttribute('data-art', 'failed')
  await expect(page.locator('#cv')).toHaveAttribute('data-engine', /.+/)
  await engineReady(page)
  await zoomTo(page, 1) // the town fits only at Map 0.5, where tags are hidden by design
  await expect(page.locator('#labels .tag.st').first()).toBeVisible()
  await row(page, claudeId('leadCi')).click()
  await expect(page.locator('#labels .tag.sel')).toHaveText('CI Lead')
})

test('[test.e2e-world-village-on-engine2] [lbl.dom-labels-priority-slide] big home: 2560px overview at 2x (tags not stacked)', async ({ browser }) => {
  const s = await startServer(prepareBigHome(tmpDir('engine-big'), 160), nextPort())
  const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } })
  await startDocked(page)
  try {
    await page.goto(`${s.url}/?engine=${ENGINE}&night=0`)
    await expect(page.locator('#cv')).toHaveAttribute('data-art', 'ready')
    await page.locator('#zoom-out').click()
    await page.waitForTimeout(500)
    const boxes = await page.locator('#labels .tag').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.top, r.right, r.bottom]))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]]
      expect(a[0] < b[2] - 1 && a[2] > b[0] + 1 && a[1] < b[3] - 1 && a[3] > b[1] + 1, `tags ${i} and ${j} overlap`).toBe(false)
    }
    await page.screenshot({ path: `${SHOTS}/engine-wide-village.png` })
  } finally { await page.close(); await s.stop() }
})

// ---------------------------------------------------------------- world.spec
test('[test.e2e-world-village-on-engine2] [camera.clamp-land] [camera.persisted] the camera is clamped to the world bounds (+10 tiles) at every zoom, and remembered', async ({ page }) => {
  await page.goto(eng())
  await engineReady(page)
  const cv = await page.locator('#cv').boundingBox()
  const PAD = 10
  for (const z of [1, 2, 4]) {
    await zoomTo(page, z)
    for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      for (let i = 0; i < 4; i++) {
        await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2)
        await page.mouse.down()
        await page.mouse.move(cv.x + cv.width / 2 + dx * 600, cv.y + cv.height / 2 + dy * 600, { steps: 4 })
        await page.mouse.up()
      }
      const d = await dbg(page)
      const r = boundsRect(d.bounds)
      expect(d.cam.x, `cam.x at ${z}x`).toBeGreaterThanOrEqual(r.ox - PAD - 0.01)
      expect(d.cam.x).toBeLessThanOrEqual(r.ox + r.w + PAD + 0.01)
      expect(d.cam.y).toBeGreaterThanOrEqual(r.oy - PAD - 0.01)
      expect(d.cam.y).toBeLessThanOrEqual(r.oy + r.h + PAD + 0.01)
    }
  }
  // setCamera is tile based ({v:2,x,y,z}) and also clamped.
  await page.evaluate(() => window.villageSetCamera({ v: 2, x: 1e5, y: -1e5, z: 2 }))
  await page.waitForTimeout(200)
  const far = await dbg(page), r = boundsRect(far.bounds)
  expect(far.cam.x).toBeLessThanOrEqual(r.ox + r.w + PAD + 0.01)
  expect(far.cam.y).toBeGreaterThanOrEqual(r.oy - PAD - 0.01)
  // The position is remembered across a reload.
  await page.evaluate(() => window.villageSetCamera({ v: 2, x: 20, y: 20, z: 2 }))
  await page.keyboard.press('Escape')
  const before = (await dbg(page)).cam
  await page.reload()
  await engineReady(page)
  const after = (await dbg(page)).cam
  expect(Math.abs(after.x - before.x)).toBeLessThan(0.5)
  expect(Math.abs(after.y - before.y)).toBeLessThan(0.5)
  expect(after.z).toBe(before.z)
})

test('[test.e2e-world-village-on-engine2] [world.persisted-layout] placements are stable across polls and survive growth and reload', async ({ page }) => {
  let extra = 0
  await withProjects(page, (p) => {
    for (let i = 0; i < extra; i++) p.prs.push({ id: String(500 + i), href: `https://github.com/example/demo-app/pull/${500 + i}`, agentIds: [], live: false })
    p.agentsEver = (p.agentsEver || 0) + extra * 3
  })
  await page.goto(eng())
  await engineReady(page)
  await layoutReady(page)
  const first = await dbg(page)
  await page.waitForTimeout(4500) // two more polls
  expect(pos(await dbg(page))).toEqual(pos(first))
  extra = 8
  await expect.poll(async () => (await dbg(page)).items.filter((it) => it.kind === 'pr' && /50\d$/.test(it.id)).length, { timeout: 8000 }).toBe(3) // settled at the cap
  const grown = await dbg(page)
  const now = pos(grown)
  // A project that kept its tier and capacity keeps every item on its exact tile. One that re-planned (tier or capacity
  // changed) grows in place and NESTS its old plan (design §1.4: growth is visible and permanent): the new
  // block covers the old one, and every old item keeps its tile relative to the others: all of a village's old items move
  // by one shift, (0, 0) when the block could be placed at old origin - nest offset, else the block's minimal move.
  const vOf = (d) => new Map(d.villages.map((v) => [v.name, v]))
  const v0 = vOf(first), v1 = vOf(grown)
  const replanned = (n) => v0.get(n)?.tier !== v1.get(n)?.tier || v0.get(n)?.cap !== v1.get(n)?.cap
  expect(replanned('demo-app'), 'the growth re-planned demo-app').toBe(true)
  for (const [n, a] of v0) {
    const b = v1.get(n)?.block
    if (!replanned(n)) { expect(b, `${n} block kept`).toEqual(a.block); continue }
    expect(b.x <= a.block.x && b.y <= a.block.y && b.x + b.w >= a.block.x + a.block.w && b.y + b.h >= a.block.y + a.block.h, `${n} grew in place`).toBe(true)
  }
  const shifts = new Map()
  let kept = 0
  for (const it of first.items) {
    if (!now.has(it.id)) continue
    const [x, y] = now.get(it.id)
    if (!replanned(it.village)) { expect([x, y], `${it.id} moved`).toEqual([it.x, it.y]); continue }
    const b = v1.get(it.village).block
    expect(it.x >= b.x && it.y >= b.y && it.x < b.x + b.w && it.y < b.y + b.h, `${it.id}'s old tile is inside the grown ${it.village} block`).toBe(true)
    if (!shifts.has(it.village)) shifts.set(it.village, new Set())
    shifts.get(it.village).add(`${x - it.x},${y - it.y}`)
    kept++
  }
  expect(kept, 'old items of the re-planned village still stand').toBeGreaterThan(20)
  for (const [n, s] of shifts) expect([...s], `${n}: every old item kept its tile relative to the others (one shift)`).toHaveLength(1)
  expect(grown.items.filter((it) => it.kind === 'pr' && /50\d$/.test(it.id)), '[lots.pr-caps] the newest finished PRs only').toHaveLength(3)
  // Decor never shrinks, re-plan or not (nested growth: a tier-up only adds; it was 69 -> 54 here before M6), and every old
  // decor item is still there.
  const decorOf = (d, n) => d.items.filter((it) => it.kind === 'decor' && it.village === n)
  for (const n of v0.keys()) {
    expect(decorOf(grown, n).length, `${n} decor`).toBeGreaterThanOrEqual(decorOf(first, n).length)
    for (const it of decorOf(first, n)) expect(now.has(it.id), `${n}: decor ${it.id} kept`).toBe(true)
  }
  await page.reload()
  await engineReady(page)
  await expect.poll(async () => (await dbg(page)).items.length).toBe(grown.items.length)
  const reloaded = pos(await dbg(page))
  for (const [id, xy] of now) expect(reloaded.get(id), `${id} moved on reload`).toEqual(xy)
})

test('[test.e2e-world-village-on-engine2] [bld.pr-building-site] [lots.pr-caps] PR buildings: live PRs are under construction, the rest finished, in the same spot', async ({ page }) => {
  let live = true
  await withProjects(page, (p) => {
    p.prs = [
      { id: '101', href: 'https://github.com/example/demo-app/pull/101', agentIds: [], live },
      { id: '99', href: 'https://github.com/example/demo-app/pull/99', agentIds: [], live: false },
    ]
  })
  await page.goto(eng())
  await engineReady(page)
  const site = async (n) => (await dbg(page)).items.find((it) => it.kind === 'pr' && it.id.endsWith(`#${n}`))
  await expect.poll(async () => (await site('101'))?.building).toBe(true)
  expect((await site('99')).building).toBe(false)
  const at = await site('101')
  live = false
  await expect.poll(async () => (await site('101')).building, { timeout: 8000 }).toBe(false)
  const done = await site('101')
  expect([done.x, done.y]).toEqual([at.x, at.y])
})

for (const fallback of [false, true]) {
  test(`[test.e2e-world-village-on-engine2] [lbl.map-plates-counts] [lbl.village-signs] Map zoom shows one aggregate badge per village${fallback ? ' (procedural fallback)' : ''}`, async ({ page }) => {
    if (fallback) await page.route('**/assets/ninja-adventure/**', (r) => r.abort())
    await page.goto(eng(fallback ? 'night=0&folk=ninja' : undefined))   // sheets only matter on the sticker path (M6 dolls are code-drawn)
    await expect(page.locator('#cv')).toHaveAttribute('data-art', fallback ? 'failed' : 'ready')
    await engineReady(page)
    await zoomTo(page, 0.5)
    const agents = await page.evaluate(async () => (await (await fetch('/api/agents')).json()).agents)
    const want = new Map()
    for (const a of agents) {
      if (a.hidden || (a.bucket !== 'stalled' && a.bucket !== 'waiting')) continue
      const c = want.get(a.project || '—') || { need: 0, error: 0, wait: 0 }
      c[a.bucket === 'waiting' ? 'wait' : a.severity === 'error' ? 'error' : 'need']++
      want.set(a.project || '—', c)
    }
    expect(want.size).toBeGreaterThan(0)
    await expect.poll(async () => (await dbg(page)).clusters.length).toBeGreaterThan(0)
    for (const c of (await dbg(page)).clusters) expect({ need: c.need, error: c.error, wait: c.wait }).toEqual(want.get(c.name))
    await expect(page.locator('#labels .sign').first()).toBeVisible()
    await expect(page.locator('#labels .tag')).toHaveCount(0)
  })
}

test('[test.e2e-world-village-on-engine2] [world.project-blocks-compact] [world.shared-streets-2-wide] [test.townwater-zero] one town: no water, blocks apart, buildings inside their block, crews and tags never overlap', async ({ browser }) => {
  const s = await startServer(prepareBigHome(tmpDir('engine-world-big'), 160), nextPort())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await startDocked(page)
  try {
    await page.goto(`${s.url}${eng()}`)
    await engineReady(page)
    await layoutReady(page)
    const d = await dbg(page)
    expect(d.villages.length).toBeGreaterThan(10)
    expect(d.townWater).toBe(0)
    for (const it of d.items) expect(it.wet, `${it.id} wet`).toBe(0)
    const rs = [d.square, ...d.villages.map((v) => v.block)]
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const [a, b] = [rs[i], rs[j]]
      expect(a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2, `blocks ${i} and ${j} touch`).toBe(false)
    }
    const at = new Map(d.villages.map((v) => [v.name, v.block]))
    for (const it of d.items.filter((i) => i.kind !== 'decor')) {
      const b = at.get(it.village)
      expect(it.x >= b.x && it.y >= b.y && it.x + it.w <= b.x + b.w && it.y + it.h <= b.y + b.h, `${it.id} is outside ${it.village}`).toBe(true)
    }
    expect([0.5, 0.25, 0.125, 1, 2]).toContain(d.zoom) // the default view is a fit level
    await page.screenshot({ path: `${SHOTS}/engine-world-big-default.png` })

    await zoomTo(page, 2)
    const z = await dbg(page)
    const cv = await page.locator('#cv').boundingBox()
    const hits = z.hits
    for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
      const [a, b] = [hits[i], hits[j]]
      const ox = Math.min(a.x + 16, b.x + 16) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      expect(ox > 4 && oy > 4, `${a.id} and ${b.id} overlap`).toBe(false)
    }
    const tags = await page.locator('#labels .tag').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, e.dataset.key] }))
    expect(z.badges.length).toBeGreaterThan(0)
    const hammering = z.hits.filter((h) => h.pose === 'hammer').map((h) => h.id)
    expect(hammering.length, '[vil.pose-hammer-sparks-badge]').toBeGreaterThan(0)
    for (const id of hammering) expect(z.badges.some((b) => b.id === id), `${id} has a building bubble`).toBe(true)
    for (const b of z.badges) for (const [l, t, r, bt, key] of tags) {
      if (key === `t:${b.id}`) continue
      const [bl, btp, br, bb] = [b.l + cv.x, b.t + cv.y, b.r + cv.x, b.b + cv.y]
      expect(l < br - 1 && r > bl + 1 && t < bb - 1 && bt > btp + 1, `tag ${key} covers ${b.id}'s badge`).toBe(false)
    }
    await zoomTo(page, 0.5)
    const m = await dbg(page)
    expect([0.5, 0.25, 0.125]).toContain(m.zoom)
    await expect(page.locator('#labels .sign.plate').first()).toBeVisible()
    expect((await page.locator('#labels .sign.plate b').allTextContents()).sort()).toEqual(m.clusters.map((c) => c.name).sort())
    for (let i = 0; i < m.clusters.length; i++) for (let j = i + 1; j < m.clusters.length; j++) {
      const [a, b] = [m.clusters[i], m.clusters[j]]
      expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
    }
    await page.screenshot({ path: `${SHOTS}/engine-world-map.png` })
  } finally { await page.close(); await s.stop() }
})

test('[test.e2e-world-village-on-engine2] [world.quiet-projects-hidden] [world.quiet-note-show] quiet projects fold away with a note; the toggle brings them back in the same place', async ({ page }) => {
  await withPayload(page, (j) => {
    const base = j.agents.find((a) => a.project === 'demo-app')
    j.agents.push(clone(base, 'quiet-a-01', 'old-alpha', 'resting', 3 * DAY), clone(base, 'quiet-a-02', 'old-alpha', 'resting', 4 * DAY),
      clone(base, 'quiet-b-01', 'old-beta', 'resting', 9 * DAY))
  })
  await page.goto(eng())
  await engineReady(page)
  const names = async () => (await dbg(page)).villages.map((v) => v.name).sort()
  await expect.poll(names).toEqual(['codex-app', 'demo-app'])
  const note = page.locator('#quiet-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('2 quiet projects hidden')
  await page.locator('#q').fill('old-beta')
  await expect(page.locator('#list .row[data-id="quiet-b-01"]')).toBeVisible()
  await page.locator('#q').fill('')
  const before = await dbg(page)
  await note.getByRole('button', { name: 'Show' }).click()
  await expect.poll(names).toEqual(['codex-app', 'demo-app', 'old-alpha', 'old-beta'])
  await expect(note).toBeHidden()
  const shown = await dbg(page)
  for (const [id, xy] of pos(before)) expect(pos(shown).get(id), `${id} moved`).toEqual(xy)
  expect(shown.townWater).toBe(0)
  const quietBlocks = blocks(shown)
  await page.locator('#btn-settings').click()
  const box = page.getByLabel('Hide quiet projects')
  await expect(box).not.toBeChecked()
  await box.check()
  await expect.poll(names).toEqual(['codex-app', 'demo-app'])
  await expect(note).toContainText('2 quiet projects hidden')
  for (const [id, xy] of pos(before)) expect(pos(await dbg(page)).get(id), `${id} moved`).toEqual(xy)
  await box.uncheck()
  await expect.poll(names).toEqual(['codex-app', 'demo-app', 'old-alpha', 'old-beta'])
  const again = await dbg(page)
  expect(blocks(again)).toEqual(quietBlocks)
  for (const [id, xy] of pos(shown)) expect(pos(again).get(id), `${id} moved`).toEqual(xy)
  await page.reload()
  await engineReady(page)
  await expect.poll(names).toEqual(['codex-app', 'demo-app', 'old-alpha', 'old-beta'])
})

test('[test.e2e-world-village-on-engine2] [world.vanished-hold-12h] [world.persisted-layout] a project coming and going never moves anything else, and comes back to its own block', async ({ page }) => {
  let extra = true
  await withPayload(page, (j) => {
    const base = j.agents.find((a) => a.project === 'demo-app')
    if (extra) j.agents.push(clone(base, 'new-x-0001', 'new-x', 'building', 0), clone(base, 'new-x-0002', 'new-x', 'stalled', 0))
  })
  await page.goto(eng())
  await engineReady(page)
  await expect.poll(async () => (await dbg(page)).villages.map((v) => v.name)).toContain('new-x')
  const first = await dbg(page)
  const where = blocks(first)['new-x']
  extra = false
  await expect.poll(async () => (await dbg(page)).villages.map((v) => v.name), { timeout: 8000 }).not.toContain('new-x')
  const gone = await dbg(page)
  for (const [id, xy] of pos(gone)) expect(pos(first).get(id), `${id} moved`).toEqual(xy)
  extra = true
  await expect.poll(async () => (await dbg(page)).villages.map((v) => v.name), { timeout: 8000 }).toContain('new-x')
  const back = await dbg(page)
  expect(blocks(back)['new-x']).toEqual(where)
  for (const [id, xy] of pos(first)) expect(pos(back).get(id), `${id} moved`).toEqual(xy)
})

test.skip('[style.flags-on-ridges] flags flap through all four frames and never drop off the canvas (classic flagCheck probe)', () => {
  // Replaced by invariants 4-6: test/engine-art (banner and flag sprites), test/engine-depth. No flagCheck() on the engine.
})

test('[test.e2e-world-village-on-engine2] [amb.chickens-hamlet-village] chickens, the cat and crate carriers face the way they walk', async ({ page }) => {
  await page.goto(eng())
  await engineReady(page)
  await zoomTo(page, 2)
  const seen = new Map()
  let pairs = 0
  const kinds = new Set()
  // Critters idle for 2-12 s between short wanders, so a fixed 40 samples (~5 s) can land on a quiet stretch (flaky "saw walkers
  // actually walking"). Sample at least 40 times, then keep going until enough walking pairs are seen (cap ~25 s of the 45 s budget).
  for (let i = 0; i < 200 && (i < 40 || pairs <= 5); i++) {
    const { walkers } = await dbg(page)
    expect(Array.isArray(walkers), 'villageDebug().walkers [{id,kind,x,t,facing,moving}]').toBe(true)
    for (const w of walkers) {
      kinds.add(w.kind)
      const prev = seen.get(w.id)
      // only assert where it moved the same way over two consecutive intervals, moving in both
      if (prev && prev.dir && w.t - prev.t > 0 && w.t - prev.t < 0.3 && Math.abs(w.x - prev.x) > 1 && w.moving && prev.moving && Math.sign(w.x - prev.x) === prev.dir && w.facing === prev.facing) {
        pairs++
        expect(w.facing, `${w.kind} ${w.id} moved ${w.x > prev.x ? 'right' : 'left'} but faces ${w.facing}`).toBe(w.x > prev.x ? 'R' : 'L')
      }
      if (prev && w.t !== prev.t && !w.moving && !prev.moving) expect(w.x, `${w.id} slid while standing`).toBe(prev.x)
      const ok = prev && w.t - prev.t > 0 && w.t - prev.t < 0.3 && w.x !== prev.x
      seen.set(w.id, { ...w, dir: ok ? Math.sign(w.x - prev.x) : 0 })
    }
    await page.waitForTimeout(110)
  }
  expect(kinds.has('chicken')).toBe(true)
  expect(kinds.has('cat')).toBe(true)
  expect(pairs, 'saw walkers actually walking').toBeGreaterThan(5)
})

// ---------------------------------------------------------------- Settings toggle
// Fresh storage (the config pins classic through va.engine = 1): what a person who never touched the setting gets.
test.describe('the engine setting', () => {
  test.use({ storageState: { cookies: [], origins: [] } })
  const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('va.engine')))
  const classicLoaded = async (page) => { await expect(page.locator('#cv')).toHaveAttribute('data-art', /ready|failed/); expect((await dbg(page)).engine).toBeUndefined() }

  test('Settings: the new engine is the default; classic is an Advanced checkbox (closed by default) that stores va.engine=1 and reloads', async ({ page }) => {
    await page.goto('/?debug')
    await page.evaluate(() => localStorage.removeItem('va.engine'))
    await page.goto('/?debug')
    await engineReady(page)
    expect((await dbg(page)).engine, 'fresh storage runs the new engine').toBe(2)
    expect(await stored(page), 'nothing stored by merely opening the app').toBeNull()
    await page.locator('#btn-settings').click()
    const pop = page.locator('#pop-settings')
    await expect(pop).toBeVisible()
    await expect(pop.locator('[data-set="engine"]:not(details *)'), 'no engine control outside Advanced').toHaveCount(0)
    await expect(pop.getByLabel('Village engine')).toHaveCount(0)
    const adv = pop.locator('details.settings-advanced')
    await expect(adv).toHaveCount(1)
    expect(await adv.evaluate(d => d.open), 'collapsed by default').toBe(false)
    await adv.locator('summary').click()
    const box = adv.getByLabel('Use classic village (old engine)')
    await expect(box).not.toBeChecked()
    await Promise.all([page.waitForEvent('load'), box.click()]) // the choice reloads the app
    expect(await stored(page)).toBe(1)
    await classicLoaded(page)
    // And back: the checkbox reads the stored value; unticking reloads onto the new engine.
    await page.locator('#btn-settings').click()
    const adv2 = page.locator('#pop-settings details.settings-advanced')
    await adv2.locator('summary').click()
    await expect(adv2.getByLabel('Use classic village (old engine)')).toBeChecked()
    await Promise.all([page.waitForEvent('load'), adv2.getByLabel('Use classic village (old engine)').click()])
    expect(await stored(page)).toBe(2)
    await engineReady(page)
    expect((await dbg(page)).engine).toBe(2)
  })

  test('?engine=1 forces classic and ?engine=2 forces the new engine, whatever the setting says, and neither changes it', async ({ page }) => {
    await page.goto('/?debug&engine=1')
    await classicLoaded(page)
    expect(await stored(page), '?engine=1 on fresh storage stores nothing').toBeNull()
    await page.evaluate(() => localStorage.setItem('va.engine', '2'))
    await page.goto('/?debug&engine=1')
    await classicLoaded(page)
    expect(await stored(page)).toBe(2)
    await page.evaluate(() => localStorage.setItem('va.engine', '1'))
    await page.goto('/?debug&engine=2')
    await engineReady(page)
    expect((await dbg(page)).engine).toBe(2)
    expect(await stored(page)).toBe(1)
    await page.goto('/?debug') // no param: the stored Classic choice holds
    await classicLoaded(page)
  })
})

test('[test.townwater-zero] [test.items-wet-zero] the default fixture: townWater is 0 and every item is dry', async ({ page }) => {
  await page.goto(eng())
  await engineReady(page)
  await layoutReady(page)
  const d = await dbg(page)
  expect(d.townWater).toBe(0)
  expect(d.items.length).toBeGreaterThan(0)
  expect(d.items.every((it) => it.wet === 0)).toBe(true)
  expect(d.outdoors, 'outdoors exposed').toBeDefined()
  expect(d.homes, 'homes exposed').toBeDefined()
})

test('[debug.dockdemo] ?dockdemo=1 on the new engine: the demo PRs reach the berths (classic village.js parity)', async ({ page }) => {
  // parity: debug.dockdemo
  const berthed = async (q) => {
    await page.goto(eng(q))
    await engineReady(page)
    await layoutReady(page)
    return page.evaluate(() => JSON.stringify(window.villageDebug().berths ?? {}))
  }
  const plain = await berthed('night=0')
  await expect.poll(async () => { const s = await berthed('night=0&dockdemo=1'); return s.length > plain.length && s !== plain }, { timeout: 15000 }).toBe(true)
})
