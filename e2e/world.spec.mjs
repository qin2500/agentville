// World v3 (docs/ARCHITECTURE.md, "The village"): one compact town of neighbourhoods. The camera stays over the world,
// placements survive polls, growth and projects coming and going, quiet projects fold away (and come
// back in place), PR buildings show their state, Map zoom shows a badge per neighbourhood, flags flap
// without blinking, walkers face where they walk, and the fallback keeps all of it.
// `?debug` exposes window.villageDebug(); /api/agents is rewritten in flight to drive the data.
import { test, expect, startDocked } from './fixtures.mjs'
import { SHOTS, clearOverrides, nextPort, prepareBigHome, startServer, tmpDir } from './helpers.mjs'

test.beforeEach(async ({ request, page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the docked panel covers the village on a phone')
  await clearOverrides(request)
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
})

const dbg = (page) => page.evaluate(() => window.villageDebug())
// Rewrites demo-app's `projects` entry on every poll; `edit` can be swapped mid-test.
async function withProjects(page, edit) {
  const ctl = { edit }
  await page.route('**/api/agents*', async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    const p = json.projects?.find((x) => x.name === 'demo-app')
    if (p) ctl.edit(p)
    await route.fulfill({ response, json })
  })
  return ctl
}
// Rewrites the whole payload on every poll; `edit` can be swapped mid-test.
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
// A copy of a fixture agent moved to another project (its own solo, no parent, no PRs).
const clone = (a, id, project, bucket, agoMs) => ({ ...a, id, name: `${project} ${id.slice(-2)}`, project, bucket, severity: bucket === 'stalled' ? 'attention' : null,
  parentId: null, role: 'solo', prs: [], hidden: false, live: bucket !== 'resting', lastActivityAt: Date.now() - agoMs, since: Date.now() - agoMs })
const DAY = 864e5
const blocks = (d) => Object.fromEntries(d.villages.map((v) => [v.name, [v.block.x, v.block.y]]))
const pos = (d) => new Map(d.items.map((it) => [it.id, [it.x, it.y]]))
const ready = async (page) => {
  await expect(page.locator('#cv')).toHaveAttribute('data-art', /ready|failed/)
  await expect.poll(async () => (await dbg(page)).villages?.length ?? 0).toBeGreaterThan(0)
}
const zoomTo = async (page, z) => {
  await page.locator('#cv').focus()
  const at = async () => Math.max(0.5, (await dbg(page)).zoom) // Map is a fit level below 1×
  for (let i = 0; i < 6 && (await at()) !== z; i++) await page.keyboard.press((await at()) > z ? '-' : '+')
  expect(await at()).toBe(z)
}

test('the camera is clamped to the world bounds at every zoom', async ({ page }) => {
  await page.goto('/?debug&night=0')
  await ready(page)
  const cv = await page.locator('#cv').boundingBox()
  for (const z of [1, 2, 4]) {
    await zoomTo(page, z)
    for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      // Drag far past the edge, several times over.
      for (let i = 0; i < 4; i++) {
        await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2)
        await page.mouse.down()
        await page.mouse.move(cv.x + cv.width / 2 + dx * 600, cv.y + cv.height / 2 + dy * 600, { steps: 4 })
        await page.mouse.up()
      }
      const d = await dbg(page)
      const [x0, y0, x1, y1] = d.bounds.map((b) => b * 16)
      const { bw, bh } = d.view
      if (z === 4) expect(x1 - x0, 'the world is wider than the view at 4×').toBeGreaterThan(bw)
      if (x1 - x0 >= bw) {
        expect(d.cam.x - bw / 2).toBeGreaterThanOrEqual(x0 - 1)
        expect(d.cam.x + bw / 2).toBeLessThanOrEqual(x1 + 1)
      }
      if (y1 - y0 >= bh) {
        expect(d.cam.y - bh / 2).toBeGreaterThanOrEqual(y0 - 1)
        expect(d.cam.y + bh / 2).toBeLessThanOrEqual(y1 + 1)
      }
    }
  }
  // The position is remembered across a reload.
  const before = (await dbg(page)).cam
  await page.reload()
  await ready(page)
  const after = (await dbg(page)).cam
  expect(Math.abs(after.x - before.x)).toBeLessThan(2)
  expect(Math.abs(after.y - before.y)).toBeLessThan(2)
})

test('placements are stable across polls and survive growth', async ({ page }) => {
  let extra = 0
  await withProjects(page, (p) => {
    for (let i = 0; i < extra; i++) p.prs.push({ id: String(500 + i), href: `https://github.com/example/demo-app/pull/${500 + i}`, agentIds: [], live: false })
    p.agentsEver = (p.agentsEver || 0) + extra * 3
  })
  await page.goto('/?debug&night=0')
  await ready(page)
  const first = await dbg(page)
  await page.waitForTimeout(4500) // two more polls
  expect(pos(await dbg(page))).toEqual(pos(first))

  extra = 8
  const growth0 = first.villages.find((v) => v.name === 'demo-app').growth
  await expect.poll(async () => (await dbg(page)).villages.find((v) => v.name === 'demo-app').growth, { timeout: 8000 }).toBeGreaterThan(growth0 + 20)
  const grown = await dbg(page)
  const now = pos(grown)
  for (const [id, xy] of pos(first)) if (now.has(id)) expect(now.get(id), `${id} moved`).toEqual(xy)
  expect(grown.items.filter((it) => it.kind === 'pr' && /#50\d$/.test(it.id))).toHaveLength(3) // PR_DONE_CAP: the newest finished PRs
  // Decor tiers are capped (DECOR_CAP) so a busy neighbourhood never sprawls: growth adds, never removes.
  expect(grown.items.filter((it) => it.kind === 'decor').length).toBeGreaterThanOrEqual(first.items.filter((it) => it.kind === 'decor').length)

  // Placements persist: a reload lays the world out the same way.
  await page.reload()
  await ready(page)
  await expect.poll(async () => (await dbg(page)).items.length).toBe(grown.items.length)
  const reloaded = pos(await dbg(page))
  for (const [id, xy] of now) expect(reloaded.get(id), `${id} moved on reload`).toEqual(xy)
})

test('PR buildings: live PRs are under construction, the rest are finished, in the same spot', async ({ page }) => {
  let live = true
  await withProjects(page, (p) => {
    p.prs = [
      { id: '101', href: 'https://github.com/example/demo-app/pull/101', agentIds: [], live },
      { id: '99', href: 'https://github.com/example/demo-app/pull/99', agentIds: [], live: false },
    ]
  })
  await page.goto('/?debug&night=0')
  await ready(page)
  const site = async (n) => (await dbg(page)).items.find((it) => it.id.startsWith('pr:demo-app#') && it.id.endsWith(`#${n}`))
  await expect.poll(async () => (await site('101'))?.building).toBe(true)
  expect((await site('99')).building).toBe(false)
  const at = await site('101')
  live = false
  await expect.poll(async () => (await site('101')).building, { timeout: 8000 }).toBe(false)
  const done = await site('101')
  expect([done.x, done.y]).toEqual([at.x, at.y])
  // One of the 11 PR building types, chosen by the PR id: it doesn't change when the PR finishes.
  expect(done.look).toBe(at.look)
})

for (const fallback of [false, true]) {
  test(`Map zoom shows one aggregate badge per village${fallback ? ' (procedural fallback)' : ''}`, async ({ page }) => {
    if (fallback) await page.route('**/assets/ninja-adventure/**', (r) => r.abort())
    await page.goto('/?debug&night=0')
    await expect(page.locator('#cv')).toHaveAttribute('data-art', fallback ? 'failed' : 'ready')
    await ready(page)
    await zoomTo(page, 0.5)
    const counts = await page.evaluate(async () => (await (await fetch('/api/agents')).json()).agents)
    const want = new Map()
    for (const a of counts) {
      if (a.hidden || (a.bucket !== 'stalled' && a.bucket !== 'waiting')) continue
      const c = want.get(a.project || '—') || { need: 0, error: 0, wait: 0 }
      c[a.bucket === 'waiting' ? 'wait' : a.severity === 'error' ? 'error' : 'need']++
      want.set(a.project || '—', c)
    }
    expect(want.size).toBeGreaterThan(0)
    await expect.poll(async () => (await dbg(page)).clusters.length).toBeGreaterThan(0)
    const got = (await dbg(page)).clusters
    for (const c of got) expect({ need: c.need, error: c.error, wait: c.wait }).toEqual(want.get(c.name))
    // Village signs at Map zoom, no agent tags.
    await expect(page.locator('#labels .sign').first()).toBeVisible()
    await expect(page.locator('#labels .tag')).toHaveCount(0)
  })
}

test('one town: no water between neighbourhoods, the active town fits one 1440×900 screen, crews and tags never overlap', async ({ browser }) => {
  const s = await startServer(prepareBigHome(tmpDir('world-big'), 160), nextPort())
  // Reduced motion: positions are settled (a carrier's shuffle may brush a neighbour mid-step).
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await startDocked(page)
  try {
    await page.goto(`${s.url}/?debug&night=0`)
    await ready(page)
    const d = await dbg(page)
    expect(d.villages.length).toBeGreaterThan(10)
    // One land mass: every tile in the box spanning all neighbourhoods and the square is land.
    expect(d.townWater).toBe(0)
    // Neighbourhoods never overlap, and a 2-tile street (their two ring roads) always separates them.
    const rs = [d.square, ...d.villages.map((v) => v.block)]
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const [a, b] = [rs[i], rs[j]]
      expect(a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2, `blocks ${i} and ${j} touch`).toBe(false)
    }
    // Every building stands inside its own neighbourhood's block.
    const at = new Map(d.villages.map((v) => [v.name, v.block]))
    for (const it of d.items.filter((i) => i.kind !== 'decor')) {
      const b = at.get(it.village)
      expect(it.x >= b.x && it.y >= b.y && it.x + it.w <= b.x + b.w && it.y + it.h <= b.y + b.h, `${it.id} is outside ${it.village}`).toBe(true)
    }
    // Compact: the neighbourhoods fill a good share of the town box (no island gaps, no sprawl).
    const [tx0, ty0, tx1, ty1] = d.town
    const filled = d.villages.reduce((a, v) => a + v.block.w * v.block.h, 0) / ((tx1 - tx0 + 1) * (ty1 - ty0 + 1))
    expect(filled).toBeGreaterThan(0.55) // blocks shrink to what they hold, leaving a little street between them
    // The default view shows the whole active town without panning.
    const cv = await page.locator('#cv').boundingBox()
    const scale = d.zoom
    expect([0.5, 1, 2]).toContain(scale)
    const left = (tx0 * 16 - d.view.vx) * d.view.k * d.view.px, top = (ty0 * 16 - d.view.vy) * d.view.k * d.view.px
    const right = ((tx1 + 1) * 16 - d.view.vx) * d.view.k * d.view.px, bottom = ((ty1 + 1) * 16 - d.view.vy) * d.view.k * d.view.px
    expect(left, 'town starts inside the view').toBeGreaterThanOrEqual(-1)
    expect(top).toBeGreaterThanOrEqual(-1)
    expect(right, 'town ends inside the view').toBeLessThanOrEqual(cv.width + 1)
    expect(bottom).toBeLessThanOrEqual(cv.height + 1)
    await page.screenshot({ path: `${SHOTS}/world-big-default.png` })

    await zoomTo(page, 2)
    const z = await dbg(page)
    // 2×: villagers never stack, and no tag covers another agent's badge.
    const hits = z.hits
    for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
      const [a, b] = [hits[i], hits[j]]
      const ox = Math.min(a.x + 16, b.x + 16) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      expect(ox > 4 && oy > 4, `${a.id} and ${b.id} overlap`).toBe(false)
    }
    const tags = await page.locator('#labels .tag').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, e.dataset.key] }))
    expect(z.badges.length).toBeGreaterThan(0)
    // Building agents get a bubble too (the hammer), not just stalled and waiting ones.
    const hammering = z.hits.filter((h) => h.pose === 'hammer').map((h) => h.id)
    expect(hammering.length).toBeGreaterThan(0)
    for (const id of hammering) expect(z.badges.some((b) => b.id === id), `${id} has a building bubble`).toBe(true)
    for (const b of z.badges) for (const [l, t, r, bt, key] of tags) {
      if (key === `t:${b.id}`) continue // its own badge
      const [bl, btp, br, bb] = [b.l + cv.x, b.t + cv.y, b.r + cv.x, b.b + cv.y]
      expect(l < br - 1 && r > bl + 1 && t < bb - 1 && bt > btp + 1, `tag ${key} covers ${b.id}'s badge`).toBe(false)
    }
    await zoomTo(page, 0.5)
    const m = await dbg(page)
    expect([0.5, 0.25, 0.125]).toContain(m.zoom)
    // Each neighbourhood's name and counts are one plate; plates never overlap each other.
    await expect(page.locator('#labels .sign.plate').first()).toBeVisible()
    expect((await page.locator('#labels .sign.plate b').allTextContents()).sort()).toEqual(m.clusters.map((c) => c.name).sort())
    for (let i = 0; i < m.clusters.length; i++) for (let j = i + 1; j < m.clusters.length; j++) {
      const [a, b] = [m.clusters[i], m.clusters[j]]
      expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
    }
    await page.screenshot({ path: `${SHOTS}/world-map.png` })
  } finally { await page.close(); await s.stop() }
})

test('quiet projects fold away with a note; the toggle brings them back in the same place', async ({ page }) => {
  // Two quiet projects (every agent resting, nothing for days) next to the live fixture projects.
  await withPayload(page, (j) => {
    const base = j.agents.find((a) => a.project === 'demo-app')
    j.agents.push(clone(base, 'quiet-a-01', 'old-alpha', 'resting', 3 * DAY), clone(base, 'quiet-a-02', 'old-alpha', 'resting', 4 * DAY),
      clone(base, 'quiet-b-01', 'old-beta', 'resting', 9 * DAY))
  })
  await page.goto('/?debug&night=0')
  await ready(page)
  const names = async () => (await dbg(page)).villages.map((v) => v.name).sort()
  await expect.poll(names).toEqual(['codex-app', 'demo-app'])
  const note = page.locator('#quiet-note')
  await expect(note).toBeVisible()
  await expect(note).toContainText('2 quiet projects hidden')
  // The list still shows every agent, quiet projects included.
  await page.locator('#list .resting-toggle').click()
  await expect(page.locator('#list .row[data-id="quiet-b-01"]')).toBeVisible()
  await page.locator('#list .resting-toggle').click()
  const before = await dbg(page)

  // "Show" brings them in, without moving anything already there.
  await note.getByRole('button', { name: 'Show' }).click()
  await expect.poll(names).toEqual(['codex-app', 'demo-app', 'old-alpha', 'old-beta'])
  await expect(note).toBeHidden()
  const shown = await dbg(page)
  for (const [id, xy] of pos(before)) expect(pos(shown).get(id), `${id} moved`).toEqual(xy)
  expect(shown.townWater).toBe(0)
  const quietBlocks = blocks(shown)

  // Settings → Hide quiet projects: they fold away again; the note is back.
  await page.locator('#btn-settings').click()
  const box = page.getByLabel('Hide quiet projects')
  await expect(box).not.toBeChecked()
  await box.check()
  await expect.poll(names).toEqual(['codex-app', 'demo-app'])
  await expect(note).toContainText('2 quiet projects hidden')
  for (const [id, xy] of pos(before)) expect(pos(await dbg(page)).get(id), `${id} moved`).toEqual(xy)
  // …and back on: the same blocks, the same buildings in them.
  await box.uncheck()
  await expect.poll(names).toEqual(['codex-app', 'demo-app', 'old-alpha', 'old-beta'])
  const again = await dbg(page)
  expect(blocks(again)).toEqual(quietBlocks)
  for (const [id, xy] of pos(shown)) expect(pos(again).get(id), `${id} moved`).toEqual(xy)
  // The choice persists.
  await page.reload()
  await ready(page)
  await expect.poll(names).toEqual(['codex-app', 'demo-app', 'old-alpha', 'old-beta'])
})

test('a project coming and going never moves anything else, and comes back to its own block', async ({ page }) => {
  let extra = true
  await withPayload(page, (j) => {
    const base = j.agents.find((a) => a.project === 'demo-app')
    if (extra) j.agents.push(clone(base, 'new-x-0001', 'new-x', 'building', 0), clone(base, 'new-x-0002', 'new-x', 'stalled', 0))
  })
  await page.goto('/?debug&night=0')
  await ready(page)
  await expect.poll(async () => (await dbg(page)).villages.map((v) => v.name)).toContain('new-x')
  const first = await dbg(page)
  const where = blocks(first)['new-x']
  extra = false // it goes quiet and drops out of the payload entirely
  await expect.poll(async () => (await dbg(page)).villages.map((v) => v.name), { timeout: 8000 }).not.toContain('new-x')
  const gone = await dbg(page)
  for (const [id, xy] of pos(gone)) expect(pos(first).get(id), `${id} moved`).toEqual(xy)
  extra = true
  await expect.poll(async () => (await dbg(page)).villages.map((v) => v.name), { timeout: 8000 }).toContain('new-x')
  const back = await dbg(page)
  expect(blocks(back)['new-x']).toEqual(where)
  for (const [id, xy] of pos(first)) expect(pos(back).get(id), `${id} moved`).toEqual(xy)
})

test('flags flap through all four frames and never drop off the canvas', async ({ page }) => {
  await page.goto('/?debug&night=0')
  await ready(page)
  await zoomTo(page, 2)
  // Flags left of x = 0 used to blink (a negative frame index); make sure some are in view.
  await page.waitForTimeout(300)
  const samples = []
  for (let i = 0; i < 14; i++) {
    samples.push(await page.evaluate(() => { const d = window.villageDebug(); return { badges: d.badges, view: d.view, flags: d.flagCheck() } }))
    await page.waitForTimeout(130)
  }
  const frames = new Map()
  let checked = 0, negative = 0
  for (const { flags, badges, view } of samples) {
    const s = view.k * view.px
    expect(flags.length).toBeGreaterThan(0)
    for (const f of flags) {
      expect(f.frame).toBeGreaterThanOrEqual(0)
      expect(f.frame).toBeLessThan(4)
      if (f.x < 0) negative++
      if (!frames.has(f.id)) frames.set(f.id, new Set())
      frames.get(f.id).add(f.frame)
      // A badge (screen space, drawn last) may legitimately cover a flag; skip those.
      const l = (f.x - view.vx) * s, t = (f.y - view.vy) * s, r = l + 16 * s, b2 = t + 16 * s
      if (badges.some((b) => b.l < r && b.r > l && b.t < b2 && b.b > t)) continue
      checked++
      expect(f.matched / f.opaque, `flag ${f.id} frame ${f.frame} is missing from the canvas`).toBeGreaterThan(0.3)
    }
  }
  expect(checked).toBeGreaterThan(20)
  expect(negative, 'some flags in view sit left of x = 0').toBeGreaterThan(0)
  // Every flag animates (at least two frames over ~1.8 s), and they are not all in step.
  for (const [id, set] of frames) expect(set.size, `${id} never changed frame`).toBeGreaterThan(1)
  const last = samples.at(-1).flags
  expect(new Set(last.map((f) => f.frame)).size).toBeGreaterThan(1)
})

test('chickens, the cat and crate carriers face the way they walk', async ({ page }) => {
  await page.goto('/?debug&night=0')
  await ready(page)
  await zoomTo(page, 2)
  const seen = new Map()
  let pairs = 0
  const kinds = new Set()
  for (let i = 0; i < 40; i++) {
    const { walkers } = await page.evaluate(() => window.villageDebug())
    for (const w of walkers) {
      kinds.add(w.kind)
      const prev = seen.get(w.id)
      // Consecutive frames only (< 0.3 s apart): strollers pause ≥ 1 s and carriers 0.7 s before
      // turning, so any movement between two such frames is the way the sprite must face.
      if (prev && w.t - prev.t > 0 && w.t - prev.t < 0.3 && w.x !== prev.x) {
        pairs++
        expect(w.facing, `${w.kind} ${w.id} moved ${w.x > prev.x ? 'right' : 'left'} but faces ${w.facing}`).toBe(w.x > prev.x ? 'R' : 'L')
      }
      if (prev && w.t !== prev.t && !w.moving && !prev.moving) expect(w.x, `${w.id} slid while standing`).toBe(prev.x)
      seen.set(w.id, w)
    }
    await page.waitForTimeout(110)
  }
  expect(kinds.has('chicken')).toBe(true)
  expect(kinds.has('cat')).toBe(true)
  expect(pairs, 'saw walkers actually walking').toBeGreaterThan(5)
})
