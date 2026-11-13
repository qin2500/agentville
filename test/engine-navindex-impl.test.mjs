// nav/index.js (N5) against fake N1-N4, written from COMMON.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNav } from '../web/src/engine/nav/index.js'

function fakes() {
  const calls = []
  const astar = (g, a, b) => { calls.push([a, b]); if (b.x < 0) return null; return Float32Array.from([Math.floor(a.x) + 0.5, Math.floor(a.y) + 0.5, Math.floor(b.x) + 0.5, Math.floor(b.y) + 0.5]) }
  const nodes = [{ x: 10, y: 0 }, { x: 60, y: 0 }, { x: 100, y: 0 }]   // real roadgraph: integer tiles
  const buildRoadGraph = () => ({ nodes, edges: [], nearestNode: (x) => (x < 30 ? 0 : x < 80 ? 1 : 2), route: (a, b) => { const r = []; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) r.push(i); return a <= b ? r : r.reverse() } })
  let flowBuilt = 0
  const flowField = (g, targets) => { flowBuilt++; return { targets, dirAt: () => null, costAt: () => 0 } }
  const createSlots = () => ({ claim() {}, release() {}, nearestFree() {} })
  return { calls, deps: { astar, buildRoadGraph, flowField, createSlots }, get flowBuilt() { return flowBuilt } }
}
const world = { grid: { version: 1 }, square: { x: 0, y: 0, w: 4, h: 4 }, venues: { dock: { id: 'dock', kind: 'dock', tx: 5, ty: 9 } }, objects: new Map([['s1', { tx: 3, ty: 3, w: 2, h: 2 }]]) }

test('short trip (Manhattan <= 24, spec §2.2) uses straight A*', () => {
  const f = fakes(); const nav = createNav(world, f.deps)
  const p = nav.path({ x: 0, y: 0 }, { x: 14, y: 10 })
  assert.ok(p instanceof Float32Array); assert.equal(f.calls.length, 1)
})
test('long trip: A* leg, road polyline, A* leg, no duplicate joints', () => {
  const f = fakes(); const nav = createNav(world, f.deps)
  const p = nav.path({ x: 0, y: 0 }, { x: 100, y: 0 })
  assert.equal(f.calls.length, 2)
  const c = createNav(world, f.deps).path({ x: 0, y: 0 }, { x: 100, y: 0 }, { lanes: false })
  for (let i = 0; i < c.length; i++) assert.equal(c[i] % 1, 0.5, 'tile centres (graph node tiles + 0.5)')
  const pts = []; for (let i = 0; i < p.length; i += 2) pts.push(`${p[i]},${p[i + 1]}`)
  assert.equal(new Set(pts).size, pts.length)
  assert.deepEqual([p[p.length - 2], p[p.length - 1]], [100.5, 0.5])
})
test('unreachable leg falls back to one plain A*, which may also give null', () => {
  const f = fakes(); const nav = createNav(world, f.deps)
  assert.equal(nav.path({ x: 0, y: 0 }, { x: -50, y: 0 }), null)
})
test('roadsOnly skips A* entirely', () => {
  const f = fakes(); const nav = createNav(world, f.deps)
  const p = nav.path({ x: 0, y: 0 }, { x: 5, y: 0 }, { roadsOnly: true })
  assert.equal(f.calls.length, 0); assert.ok(p.length >= 2)
})
test('flowTo caches per destination with LRU of 8', () => {
  const f = fakes(); const nav = createNav(world, f.deps)
  assert.equal(nav.flowTo('square'), nav.flowTo('square')); assert.equal(f.flowBuilt, 1)
  nav.flowTo('dock'); nav.flowTo('s1')
  for (let i = 0; i < 8; i++) nav.flowTo({ x: i, y: i })
  const before = f.flowBuilt; nav.flowTo('square'); assert.equal(f.flowBuilt, before + 1)
  assert.equal(nav.flowTo('nope'), null)
})
test('slots is exposed', () => { assert.equal(typeof createNav(world, fakes().deps).slots.claim, 'function') })
test('budgeted requests are queued and served per tick', () => {
  const f = fakes(); const nav = createNav(world, { ...f.deps, budget: 2 })
  const t = [1, 2, 3, 4].map(i => nav.request({ x: 0, y: 0 }, { x: i, y: 1 }))
  assert.equal(nav.poll(t[0]), 'pending')
  nav.beginTick()
  assert.ok(nav.poll(t[0]) instanceof Float32Array); assert.ok(nav.poll(t[1]) instanceof Float32Array)
  assert.equal(nav.poll(t[2]), 'pending')
  nav.beginTick()
  assert.ok(nav.poll(t[3]) instanceof Float32Array)
})
test('missing module errors clearly only when used', () => {
  const nav = createNav(world, { astar: () => null })
  assert.equal(nav.path({ x: 0, y: 0 }, { x: 1, y: 1 }), null)
  assert.doesNotThrow(() => createNav(world, {}))
})

// ---- against the real modules on a small hand-built grid
import { WorldGrid, makeCostFn } from '../web/src/engine/core/grid.js'
import { componentLabels } from '../web/src/engine/nav/index.js'

function wallWorld() {
  // 60x20 grass with a full-height wall at x = 30 (occ), so the halves are separate components
  const g = new WorldGrid({ ox: 0, oy: 0, w: 60, h: 20 })
  for (let y = 0; y < 20; y++) for (let x = 0; x < 60; x++) g.set('terrain', x, y, 3)
  const costFn = () => 1
  g.bakeCost(null, costFn)
  for (let y = 0; y < 20; y++) g.set('occ', 30, y, 1)
  return { world: { grid: g, objects: new Map(), villages: [] }, g, costFn }
}

test('component labels: a wall splits the grid; nav.path rejects across it without searching', () => {
  const { world, g } = wallWorld()
  const lab = componentLabels(g)
  assert.notEqual(lab[5], 0); assert.notEqual(lab[5], lab[40]); assert.equal(lab[30], 0)
  let calls = 0
  const nav = createNav(world, { astar: (...a) => { calls++; return null } })
  assert.equal(nav.path({ x: 2, y: 2 }, { x: 50, y: 2 }), null)
  assert.equal(calls, 0, 'rejected before A*')
  assert.equal(nav.reachable({ x: 2, y: 2 }, { x: 20, y: 18 }), true)
})

test('component labels follow grid.version and cost bakes (bakeCost does not bump version)', () => {
  const { world, g, costFn } = wallWorld()
  const nav = createNav(world)
  assert.equal(nav.reachable({ x: 2, y: 2 }, { x: 50, y: 2 }), false)
  g.set('occ', 30, 5, 0)                       // bumps version: a gap in the wall
  assert.equal(nav.reachable({ x: 2, y: 2 }, { x: 50, y: 2 }), true)
  assert.ok(nav.path({ x: 2, y: 2 }, { x: 50, y: 2 }))
  g.bakeCost(null, (t, gr, r, l, occ, i) => 255)  // everything blocked; version unchanged
  assert.equal(nav.reachable({ x: 2, y: 2 }, { x: 50, y: 2 }), false)
  g.bakeCost(null, costFn)
  assert.equal(nav.reachable({ x: 2, y: 2 }, { x: 50, y: 2 }), true)
})

test('lane offsets keep right of travel and never leave the tile', () => {
  const { world, g } = wallWorld()
  g.set('occ', 30, 5, 0)
  const line = Float32Array.from([10.5, 5.5, 11.5, 5.5, 12.5, 5.5, 13.5, 5.5])
  const graph = { nodes: [{ x: 10, y: 5 }, { x: 13, y: 5 }], edges: [], nearestNode: x => (x < 12 ? 0 : 1), route: (a, b) => [a, b], polyline: () => line }
  const nav = createNav(world, { buildRoadGraph: () => graph, astar: (gr, a, b) => Float32Array.from([a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5]) })
  const p = nav.path({ x: 0, y: 5 }, { x: 40, y: 5 })
  const ys = []; for (let i = 0; i < p.length; i += 2) if (p[i] > 10.6 && p[i] < 13.4) ys.push(p[i + 1])
  assert.ok(ys.length >= 2); for (const y of ys) assert.equal(y, 5.75, 'heading +x, right is +y')
  const q = nav.path({ x: 0, y: 5 }, { x: 40, y: 5 }, { lanes: false })
  for (let i = 0; i < q.length; i += 2) assert.equal(q[i + 1], 5.5)
})
test('flowTo resolves a venue id via world.venues (anchor tile), not a special-cased dock', () => {
  const f = fakes(); const nav = createNav({ ...world, venues: { quay: { id: 'quay', kind: 'dock', tx: 7, ty: 2 } } }, f.deps)
  assert.ok(nav.flowTo('quay')); assert.equal(nav.flowTo('dock'), null)
  assert.equal(nav.flowTo('toString'), null)
})
