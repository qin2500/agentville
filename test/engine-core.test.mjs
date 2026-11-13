// Engine v2 core: coords, rng, grid, objects, cover (design §1.1, §1.2, §2.4, §3.2). Pure, no DOM.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toScreen, toTile, makeProjection, col, diag, TILE_W, TILE_H } from '../web/src/engine/core/coords.js'
import { hash, rng, rand } from '../web/src/engine/core/rng.js'
import { WorldGrid, LAYOUT_GROUND, EDGE, ROAD, COST_BLOCKED, makeCostFn } from '../web/src/engine/core/grid.js'
import { TERRAIN, GROUND_EXT } from './support/fantasy-codes.mjs'
import { ObjectStore, footprintTiles, edgeRunTiles, validateObject, WALK } from '../web/src/engine/core/objects.js'
import { GROUND } from '../web/src/city-plan.js'
import { TERRAIN_TABLE } from '../mods/agentville.fantasy/terrain.js'
import { computeCover, COVER_MIN } from '../web/src/engine/world/cover.js'

const costFn = makeCostFn(TERRAIN_TABLE)
const obj = (o) => ({ id: 'o', kind: 'prop', model: 'm', tx: 0, ty: 0, w: 1, h: 1, z: 0, walk: 'block', styleKey: '', variant: 0, ...o })

// ---------- coords ----------
test('toScreen: tile index is its north corner, 32x16 diamond', () => {
  assert.deepEqual(toScreen(0, 0), { sx: 0, sy: 0 })
  assert.deepEqual(toScreen(1, 0), { sx: 16, sy: 8 })    // east corner of tile 0,0
  assert.deepEqual(toScreen(0, 1), { sx: -16, sy: 8 })   // west corner
  assert.deepEqual(toScreen(1, 1), { sx: 0, sy: 16 })    // south corner
  assert.deepEqual(toScreen(3, 5, 20), { sx: -32, sy: 44 })
  assert.equal(TILE_W, 32); assert.equal(TILE_H, 16)
  assert.equal(col(3, 5), -2); assert.equal(diag(3, 5), 8)
})

test('toScreen: integers in, integers out at 1x', () => {
  for (let tx = -20; tx <= 20; tx += 3) for (let ty = -20; ty <= 20; ty += 7) for (const z of [0, 5, 37]) {
    const { sx, sy } = toScreen(tx, ty, z)
    assert.ok(Number.isInteger(sx) && Number.isInteger(sy))
  }
})

test('toTile is the exact inverse of toScreen at z = 0 (floats)', () => {
  const r = rng(7)
  for (let k = 0; k < 500; k++) {
    const tx = (r() - 0.5) * 400, ty = (r() - 0.5) * 400
    const { sx, sy } = toScreen(tx, ty)
    const t = toTile(sx, sy)
    assert.ok(Math.abs(t.tx - tx) < 1e-9 && Math.abs(t.ty - ty) < 1e-9)
  }
  for (let tx = -5; tx <= 5; tx++) for (let ty = -5; ty <= 5; ty++) {
    const { sx, sy } = toScreen(tx, ty)
    assert.deepEqual(toTile(sx, sy), { tx, ty })   // exact, and no -0
  }
  assert.deepEqual(toTile(0, 8), { tx: 0.5, ty: 0.5 })   // tile centre
})

test('makeProjection: scale 1 is the module functions, 0.8 scales everything', () => {
  const p1 = makeProjection(1)
  assert.equal(p1.toScreen, toScreen); assert.equal(p1.toTile, toTile)
  assert.equal(p1.TILE_W, 32); assert.equal(p1.TILE_H, 16)
  const p = makeProjection(0.8)
  assert.ok(Math.abs(p.TILE_W - 25.6) < 1e-9 && Math.abs(p.TILE_H - 12.8) < 1e-9)
  const s = p.toScreen(3, 1, 10)
  assert.ok(Math.abs(s.sx - 25.6) < 1e-9 && Math.abs(s.sy - (32 - 10) * 0.8) < 1e-9)
  const r = rng(3)
  for (let k = 0; k < 100; k++) {
    const tx = (r() - 0.5) * 100, ty = (r() - 0.5) * 100
    const q = p.toScreen(tx, ty), t = p.toTile(q.sx, q.sy)
    assert.ok(Math.abs(t.tx - tx) < 1e-9 && Math.abs(t.ty - ty) < 1e-9)
  }
  assert.throws(() => makeProjection(0))
})

// ---------- rng ----------
test('hash is byte-identical to classic world.js hash', () => {
  const src = readFileSync(new URL('../web/src/world.js', import.meta.url), 'utf8')
  const line = src.split('\n').find(l => l.startsWith('export const hash ='))
  const mine = readFileSync(new URL('../web/src/engine/core/rng.js', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('export const hash ='))
  assert.equal(mine, line)
  assert.equal(hash(''), 2166136261)
  assert.equal(hash('a'), 0xe40c292c)
})

test('rng: seeded, deterministic, in [0, 1), roughly uniform', () => {
  const a = rng(42), b = rng(42), c = rng(43)
  const xs = Array.from({ length: 1000 }, a)
  assert.deepEqual(xs.slice(0, 50), Array.from({ length: 50 }, b))
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, c))
  assert.ok(xs.every(x => x >= 0 && x < 1))
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  assert.ok(Math.abs(mean - 0.5) < 0.05)
  assert.deepEqual(Array.from({ length: 3 }, rng('town')), Array.from({ length: 3 }, rng(hash('town'))))
})

test('rand: stateless, key-sensitive, in [0, 1)', () => {
  assert.equal(rand(1, 'tree', 3, 4), rand(1, 'tree', 3, 4))
  assert.notEqual(rand(1, 'tree', 3, 4), rand(1, 'tree', 4, 3))
  assert.notEqual(rand(1, 'tree', 3, 4), rand(2, 'tree', 3, 4))
  const seen = new Set()
  for (let i = 0; i < 2000; i++) { const v = rand(9, 'k', i); assert.ok(v >= 0 && v < 1); seen.add(v) }
  assert.ok(seen.size > 1990)
})

test('engine core modules never use Math.random', () => {
  for (const f of ['core/coords.js', 'core/rng.js', 'core/grid.js', 'core/objects.js', 'world/cover.js']) {
    const src = readFileSync(new URL(`../web/src/engine/${f}`, import.meta.url), 'utf8')
    assert.ok(!/Math\.random\s*\(/.test(src), f)
  }
})

// ---------- objects ----------
test('ObjectStore numbers from 1, never reuses numbers, keeps Map semantics', () => {
  const s = new ObjectStore()
  assert.ok(s instanceof Map)
  const a = obj({ id: 'a' }), b = obj({ id: 'b' })
  assert.equal(s.add(a), 1); assert.equal(s.add(b), 2)
  assert.equal(s.numOf('a'), 1); assert.equal(s.byNum(2), b)
  assert.equal(s.add({ ...a, tx: 5 }), 1, 'replacing an id keeps its number')
  assert.equal(s.byNum(1).tx, 5)
  assert.equal(s.delete('a'), true); assert.equal(s.delete('a'), false)
  assert.equal(s.numOf('a'), 0); assert.equal(s.byNum(1), undefined)
  assert.equal(s.add(obj({ id: 'c' })), 3)
  assert.equal(s.add(obj({ id: 'a' })), 4, 'a re-added id gets a fresh number')
  s.set('d', obj({ id: 'd' })); assert.equal(s.numOf('d'), 5)
  assert.equal(s.size, 4)
  const t = new ObjectStore([['x', obj({ id: 'x' })]]); assert.equal(t.numOf('x'), 1)
})

test('footprintTiles and edgeRunTiles', () => {
  assert.deepEqual(footprintTiles(obj({ tx: 2, ty: 3, w: 2, h: 2 })), [[2, 3], [3, 3], [2, 4], [3, 4]])
  assert.deepEqual(edgeRunTiles(obj({ tx: 1, ty: 1, walk: 'edge', run: { dir: 'x', len: 3, side: 'S' } })),
    [{ tx: 1, ty: 1, side: 'S' }, { tx: 2, ty: 1, side: 'S' }, { tx: 3, ty: 1, side: 'S' }])
  assert.deepEqual(edgeRunTiles(obj({ tx: 1, ty: 1, walk: 'edge', run: { dir: 'y', len: 2, side: 'W' } })),
    [{ tx: 1, ty: 1, side: 'W' }, { tx: 1, ty: 2, side: 'W' }])
})

test('validateObject', () => {
  assert.deepEqual(validateObject(obj()), [])
  assert.deepEqual(validateObject(obj({ walk: 'edge', run: { dir: 'x', len: 2, side: 'N' } })), [])
  assert.ok(validateObject(obj({ walk: 'edge' })).length)
  assert.ok(validateObject(obj({ walk: 'edge', run: { dir: 'z', len: 0, side: 'Q' } })).length >= 3)
  assert.ok(validateObject(obj({ w: 1.5 })).length)
  assert.ok(validateObject(obj({ walk: 'fly' })).length)
  assert.ok(validateObject(obj({ kind: 'castle' })).length)
  assert.ok(validateObject(obj({ id: '' })).length)
  assert.ok(validateObject(obj({ door: { tx: 1, ty: 1, face: 'N' } })).length)
  assert.ok(validateObject(null).length)
  assert.equal(WALK.EDGE, 'edge')
})

// ---------- grid ----------
const grid = (w = 10, h = 10, ox = 0, oy = 0) => {
  const g = new WorldGrid({ ox, oy, w, h })
  g.terrain.fill(TERRAIN.GRASS); g.ground.fill(GROUND.STREET); g.bakeCost(null, costFn)
  return g
}

test('WorldGrid layers, idx, defaults outside', () => {
  const g = new WorldGrid({ ox: -5, oy: 3, w: 4, h: 2 })
  for (const k of ['terrain', 'ground', 'road', 'edges', 'cost', 'cover', 'slots']) { assert.ok(g[k] instanceof Uint8Array); assert.equal(g[k].length, 8) }
  assert.ok(g.lot instanceof Int32Array && g.occ instanceof Int32Array)
  assert.ok(g.lot.every(v => v === -1))
  assert.equal(g.idx(-5, 3), 0); assert.equal(g.idx(-2, 4), 7); assert.equal(g.idx(-1, 4), -1); assert.equal(g.idx(-5, 2), -1)
  assert.equal(g.inBounds(-3, 4), true); assert.equal(g.inBounds(0, 0), false)
  assert.equal(g.get('terrain', 99, 99), TERRAIN.SEA_DEEP)
  assert.equal(g.get('cost', 99, 99), 255)
  assert.equal(g.get('lot', 99, 99), -1)
  assert.equal(g.get('occ', 99, 99), 0); assert.equal(g.get('edges', 99, 99), 0)
  assert.equal(g.set('road', 99, 99, 1), false)
  g.set('road', -4, 3, ROAD.MAIN); assert.equal(g.get('road', -4, 3), 4); assert.equal(g.road[1], 4)
})

test('version bumps on stamp, unstamp and set of occ or edges', () => {
  const g = grid(); let v = g.version
  g.set('occ', 1, 1, 9); assert.ok(g.version > v); v = g.version
  g.set('edges', 1, 1, EDGE.N); assert.ok(g.version > v); v = g.version
  g.set('road', 1, 1, 1); assert.equal(g.version, v)
  g.stamp(obj({ tx: 4, ty: 4 }), 3); assert.ok(g.version > v); v = g.version
  g.unstamp(obj({ tx: 4, ty: 4 }), 3); assert.ok(g.version > v); v = g.version
  g.stamp(obj({ walk: 'edge', tx: 6, ty: 6, run: { dir: 'x', len: 1, side: 'N' } }), 4); assert.ok(g.version > v)
})

test('stamp block: occ on footprint; conflicts refuse without stamping; unstamp only clears own number', () => {
  const g = grid()
  const a = obj({ id: 'a', tx: 2, ty: 2, w: 2, h: 2 })
  assert.deepEqual(g.stamp(a, 1), { ok: true, conflicts: [] })
  for (const [x, y] of footprintTiles(a)) assert.equal(g.get('occ', x, y), 1)
  assert.equal(g.canPlace(a), false)
  const b = obj({ id: 'b', tx: 3, ty: 3, w: 2, h: 2 })
  const v = g.version
  const r = g.stamp(b, 2)
  assert.equal(r.ok, false); assert.deepEqual(r.conflicts, [1])
  assert.equal(g.get('occ', 4, 4), 0, 'nothing stamped on conflict'); assert.equal(g.version, v)
  const out = g.stamp(obj({ tx: 9, ty: 9, w: 2, h: 1 }), 5)
  assert.equal(out.ok, false); assert.deepEqual(out.conflicts, [-1]); assert.equal(g.get('occ', 9, 9), 0)
  assert.equal(g.stamp(a, 1).ok, true, 're-stamping the same number is idempotent')
  g.set('occ', 3, 3, 7)   // someone else took a tile
  g.unstamp(a, 1)
  assert.equal(g.get('occ', 2, 2), 0); assert.equal(g.get('occ', 3, 3), 7)
  assert.equal(g.canPlace(obj({ tx: 0, ty: 0, w: 2, h: 2 })), true)
  assert.equal(g.canPlace(obj({ tx: 9, ty: 0, w: 2, h: 1 })), false)
})

test('floor objects have no grid effect', () => {
  const g = grid()
  const r = g.stamp(obj({ walk: 'floor', tx: 1, ty: 1, w: 3, h: 3 }), 1)
  assert.equal(r.ok, true)
  assert.ok(g.occ.every(v => v === 0) && g.edges.every(v => v === 0))
})

test('edge runs are symmetric: the edge bit and its opposite on the neighbour', () => {
  const g = grid()
  const f = obj({ walk: 'edge', tx: 2, ty: 5, run: { dir: 'x', len: 3, side: 'S' } })
  assert.equal(g.canPlace(f), true)
  assert.equal(g.stamp(f, 1).ok, true)
  for (let x = 2; x < 5; x++) {
    assert.equal(g.get('edges', x, 5), EDGE.S); assert.equal(g.get('edges', x, 6), EDGE.N)
    assert.equal(g.get('occ', x, 5), 0, 'edge objects never take occ')
  }
  assert.equal(g.get('edges', 5, 5), 0)
  for (const [side, bit, nx, ny, opp] of [['N', EDGE.N, 0, -1, EDGE.S], ['E', EDGE.E, 1, 0, EDGE.W], ['W', EDGE.W, -1, 0, EDGE.E]]) {
    const h = grid()
    h.stamp(obj({ walk: 'edge', tx: 4, ty: 4, run: { dir: 'y', len: 1, side } }), 1)
    assert.equal(h.get('edges', 4, 4), bit); assert.equal(h.get('edges', 4 + nx, 4 + ny), opp)
  }
  g.unstamp(f, 1)
  assert.ok(g.edges.every(v => v === 0))
})

test('overlapping edge runs unstamp exactly', () => {
  const g = grid()
  const f1 = obj({ id: 'f1', walk: 'edge', tx: 2, ty: 2, run: { dir: 'x', len: 3, side: 'S' } })
  const f2 = obj({ id: 'f2', walk: 'edge', tx: 3, ty: 3, run: { dir: 'x', len: 1, side: 'N' } })   // same edge as f1's middle
  g.stamp(f1, 1); g.stamp(f2, 2)
  g.unstamp(f1, 1)
  assert.equal(g.get('edges', 3, 2), EDGE.S); assert.equal(g.get('edges', 3, 3), EDGE.N)
  assert.equal(g.get('edges', 2, 2), 0)
  g.unstamp(f2, 2)
  assert.ok(g.edges.every(v => v === 0))
})

test('edge run on the grid border stamps the inside half; a run outside is refused', () => {
  const g = grid(4, 4)
  assert.equal(g.stamp(obj({ walk: 'edge', tx: 0, ty: 0, run: { dir: 'x', len: 2, side: 'N' } }), 1).ok, true)
  assert.equal(g.get('edges', 0, 0), EDGE.N)
  const r = g.stamp(obj({ walk: 'edge', tx: 3, ty: 0, run: { dir: 'x', len: 2, side: 'S' } }), 2)
  assert.equal(r.ok, false); assert.equal(g.get('edges', 3, 0), 0)
})

test('canStep: orthogonal and diagonal, blocked tiles, edges, no corner cutting', () => {
  const g = grid()
  assert.equal(g.canStep(5, 5, 6, 5), true)
  assert.equal(g.canStep(5, 5, 6, 6), true)
  assert.equal(g.canStep(5, 5, 5, 5), false)
  assert.equal(g.canStep(5, 5, 7, 5), false)
  assert.equal(g.canStep(0, 0, -1, 0), false, 'off the grid')
  // a blocked tile at (6,5)
  g.stamp(obj({ tx: 6, ty: 5 }), 1)
  assert.equal(g.canStep(5, 5, 6, 5), false)
  assert.equal(g.canStep(5, 5, 6, 6), false, 'diagonal past a blocked tile')
  assert.equal(g.canStep(5, 5, 6, 4), false)
  assert.equal(g.canStep(5, 5, 4, 6), true)
  // cost 255 blocks too
  g.ground[g.idx(2, 2)] = GROUND.GARDEN; g.bakeCost(null, costFn)
  assert.equal(g.isBlocked(2, 2), true)
  assert.equal(g.canStep(1, 1, 2, 2), false); assert.equal(g.canStep(1, 2, 2, 1), false)
  assert.equal(g.canStep(1, 2, 2, 2), false)
})

test('canStep: edges block the crossing in both directions and diagonal corner cuts past them', () => {
  const g = grid()
  g.stamp(obj({ walk: 'edge', tx: 3, ty: 3, run: { dir: 'x', len: 1, side: 'E' } }), 1)   // wall between (3,3) and (4,3)
  assert.equal(g.canStep(3, 3, 4, 3), false); assert.equal(g.canStep(4, 3, 3, 3), false)
  assert.equal(g.canStep(3, 3, 3, 4), true)
  assert.equal(g.canStep(3, 3, 4, 4), false, 'diagonal past an edge from its own tile')
  assert.equal(g.canStep(3, 4, 4, 3), false, 'diagonal whose route crosses the edge')
  assert.equal(g.canStep(3, 2, 4, 3), false)
  assert.equal(g.canStep(4, 3, 3, 4), false)
  assert.equal(g.canStep(3, 4, 4, 5), true, 'away from the edge')
  // a lane beside a fence stays open
  assert.equal(g.canStep(3, 2, 3, 3), true); assert.equal(g.canStep(4, 2, 4, 3), true)
  // a one-sided hand-set bit still blocks
  const h = grid(); h.set('edges', 5, 5, EDGE.S)
  assert.equal(h.canStep(5, 6, 5, 5), false)
})

test('bakeCost follows the cost table', () => {
  const g = new WorldGrid({ ox: 0, oy: 0, w: 40, h: 4 })
  const put = (x, terrain, ground, lot = -1, road = 0) => { const i = g.idx(x, 0); g.terrain[i] = terrain; g.ground[i] = ground; g.lot[i] = lot; g.road[i] = road }
  const G = GROUND, T = TERRAIN, X = GROUND_EXT
  const cases = [
    [T.GRASS, G.STREET, 0, 1], [T.GRASS, G.LANE, 0, 1], [T.GRASS, G.PLAZA, 0, 1], [T.GRASS, G.MARKET, 0, 1], [T.GRASS, G.BRIDGE, 0, 1],
    [T.GRASS, X.RING, -1, 1], [T.GRASS, X.SQUARE, -2, 1], [T.GRASS, X.ROAD, -1, 1], [T.SHORE, X.DOCK, -3, 1],
    [T.GRASS, G.YARD, 0, 2], [T.GRASS, G.GRASS, 0, 3], [T.GRASS, G.LAWN, 0, 4],
    [T.GRASS, G.GARDEN, 0, 255], [T.GRASS, G.FIELD, 0, 255], [T.GRASS, G.ORCHARD, 0, 255], [T.GRASS, G.PASTURE, 0, 255],
    [T.GRASS, G.WATER, 0, 255], [T.GRASS, G.WALL, 0, 255], [T.GRASS, G.FLOWERS, 0, 255],
    [T.GRASS, G.NONE, 0, 255], [T.GRASS, G.NONE, -1, 3], [T.SHORE, G.NONE, -1, 3], [T.FOREST_FLOOR, G.NONE, -1, 255],
    [T.SEA, G.NONE, -1, 255], [T.SEA_DEEP, G.NONE, -1, 255], [T.SEA, X.DOCK, -3, 1], [T.SEA, G.BRIDGE, 0, 1], [T.SEA, G.STREET, 0, 255],
    [T.GRASS, 20, 0, 255],   // unknown ground
  ]
  cases.forEach(([t, gr, lot], x) => put(x, t, gr, lot))
  put(cases.length, T.GRASS, G.NONE, -1, ROAD.PATH)   // a wild path
  g.bakeCost(null, costFn)
  cases.forEach(([t, gr, lot, want], x) => assert.equal(g.cost[g.idx(x, 0)], want, `case ${x}: terrain ${t} ground ${gr} lot ${lot}`))
  assert.equal(g.get('cost', cases.length, 0), 1)
  // occ wins over everything; bakeCost(rect) only touches the rect
  g.occ[g.idx(0, 0)] = 3; g.occ[g.idx(1, 0)] = 4
  g.bakeCost({ ox: 0, oy: 0, w: 1, h: 1 }, costFn)
  assert.equal(g.get('cost', 0, 0), COST_BLOCKED); assert.equal(g.get('cost', 1, 0), 1)
  g.bakeCost({ x: -5, y: -5, w: 100, h: 100 }, costFn); assert.equal(g.get('cost', 1, 0), 255)
  // a missing cost function is an error, never a silent fantasy default
  assert.throws(() => g.bakeCost(), /cost function/)
  assert.throws(() => makeCostFn(null), /TerrainTable/)
})

test('engine ground codes are reserved at 200+ and the fantasy table never uses them', () => {
  assert.deepEqual({ ...LAYOUT_GROUND }, { EDGE: 200, VENUE: 201, HUB: 202, ROUTE: 203 })
  for (const c of Object.values(LAYOUT_GROUND)) assert.ok(c >= 200 && c <= 255)
  for (const t of TERRAIN_TABLE.types) assert.ok(t.code >= 0 && t.code <= 199, t.name)
})

test('fantasy terrain table reproduces the old costs code by code', () => {
  const OLD = { [GROUND.STREET]: 1, [GROUND.LANE]: 1, [GROUND.PLAZA]: 1, [GROUND.MARKET]: 1, [GROUND.BRIDGE]: 1, [GROUND.YARD]: 2, [GROUND.GRASS]: 3, [GROUND.LAWN]: 4,
    [GROUND.GARDEN]: 255, [GROUND.FIELD]: 255, [GROUND.ORCHARD]: 255, [GROUND.PASTURE]: 255, [GROUND.WATER]: 255, [GROUND.WALL]: 255, [GROUND.FLOWERS]: 255 }
  for (const [code, want] of Object.entries(OLD)) assert.equal(costFn(TERRAIN.GRASS, +code, 0, 0, 0), want, `ground ${code}`)
  for (const code of Object.values(GROUND_EXT)) assert.equal(costFn(TERRAIN.GRASS, code, 0, -1, 0), 1)
  assert.equal(TERRAIN_TABLE.wildCost, 3)
  assert.equal(TERRAIN_TABLE.types.length, 16)
  for (const t of TERRAIN_TABLE.types) assert.equal(TERRAIN_TABLE.byName[t.name], t.code)
  for (const code of Object.keys(GROUND)) assert.ok(TERRAIN_TABLE.byName[code.toLowerCase()] === GROUND[code], code)
  // wild land, occupancy and sea
  assert.equal(costFn(TERRAIN.GRASS, 0, 0, -1, 0), 3); assert.equal(costFn(TERRAIN.SHORE, 0, 0, -1, 0), 3)
  assert.equal(costFn(TERRAIN.FOREST_FLOOR, 0, 0, -1, 0), 255); assert.equal(costFn(TERRAIN.SEA, 0, 0, -1, 0), 255)
  assert.equal(costFn(TERRAIN.GRASS, GROUND.LAWN, 0, 0, 1), 255)
  assert.equal(costFn(TERRAIN.SEA, GROUND.BRIDGE, 0, 0, 0), 1); assert.equal(costFn(TERRAIN.SEA, GROUND_EXT.DOCK, 0, -3, 0), 1)
  assert.equal(costFn(TERRAIN.SEA, GROUND.STREET, 0, 0, 0), 255)
  // tags the adapter reads
  const tag = (n, t) => TERRAIN_TABLE.types.find(x => x.name === n).tags.includes(t)
  for (const n of ['street', 'lane', 'plaza', 'market']) assert.ok(tag(n, 'street') && tag(n, 'walk'), n)
  assert.ok(tag('yard', 'walk') && !tag('yard', 'street') && tag('bridge', 'walk') && tag('water', 'water'))
})

test('a toy mod with a different terrain table gets its own costs', () => {
  const toy = { types: [{ code: 1, name: 'moss', cost: 7, tags: ['walk'] }, { code: 2, name: 'plank', cost: 2, tags: ['walk', 'over-water'] }, { code: 3, name: 'ice', cost: 9, tags: [] }],
    byName: { moss: 1, plank: 2, ice: 3 }, wildCost: 6,
    // its own terrain classes, on the same codes as fantasy's so the cases below read alike (C1: no engine fallback)
    classes: [{ code: 0, name: 'deep', water: true }, { code: 1, name: 'pond', water: true }, { code: 2, name: 'bank', wild: true }, { code: 3, name: 'moor', wild: true }] }
  const f = makeCostFn(toy)
  assert.equal(f(TERRAIN.GRASS, 1, 0, 0, 0), 7); assert.equal(f(TERRAIN.GRASS, 3, 0, 0, 0), 9)
  assert.equal(f(TERRAIN.GRASS, 9, 0, 0, 0), 255, 'codes the toy does not declare are impassable')
  assert.equal(f(TERRAIN.GRASS, 0, 0, -1, 0), 6); assert.equal(f(TERRAIN.SHORE, 0, 0, -1, 0), 6)
  assert.equal(f(TERRAIN.SEA, 2, 0, 0, 0), 2); assert.equal(f(TERRAIN.SEA, 1, 0, 0, 0), 255)
  assert.equal(f(TERRAIN.GRASS, GROUND_EXT.RING, 0, -1, 0), 1)
  const g = new WorldGrid({ ox: 0, oy: 0, w: 2, h: 1 }); g.terrain.fill(TERRAIN.GRASS); g.ground[0] = 1; g.bakeCost(null, f)
  assert.equal(g.cost[0], 7)
  // a table without classes has no water and no wild land (no engine default)
  const bare = makeCostFn({ ...toy, classes: undefined })
  assert.equal(bare(TERRAIN.GRASS, 0, 0, -1, 0), 255); assert.equal(bare(TERRAIN.SEA, 1, 0, 0, 0), 7)
})

// ---------- cover ----------
const bld = (o) => obj({ kind: 'building', model: 'timber', ...o })
const coverGrid = (w = 40, h = 40) => new WorldGrid({ ox: 0, oy: 0, w, h })

test('cover: a tile directly behind a tall building is hidden; tiles beside, in front and under it are not', () => {
  const g = coverGrid(), store = new ObjectStore()
  store.add(bld({ id: 'tall', tx: 10, ty: 10, w: 2, h: 2, z: 60 }))
  computeCover(g, store)
  assert.equal(g.get('cover', 9, 9), 100, 'directly behind the north corner')
  assert.ok(g.get('cover', 10, 9) >= COVER_MIN && g.get('cover', 9, 10) >= COVER_MIN, 'behind the back walls')
  assert.equal(g.get('cover', 13, 9), 0, 'beside, past the east corner')
  assert.equal(g.get('cover', 9, 13), 0, 'beside, past the west corner')
  assert.equal(g.get('cover', 12, 12), 0, 'in front')
  assert.equal(g.get('cover', 11, 11), 0, 'own footprint')
  assert.equal(g.get('cover', 10, 10), 0, 'own footprint')
  assert.ok(g.cover.every(v => v === 0 || (v >= COVER_MIN && v <= 100)))
})

test('cover: a low building hides nothing; only buildings occlude', () => {
  const g = coverGrid(), store = new ObjectStore()
  store.add(bld({ id: 'low', tx: 10, ty: 10, w: 2, h: 2, z: 4 }))
  store.add(obj({ id: 'tree', kind: 'tree', tx: 20, ty: 20, w: 1, h: 1, z: 80 }))
  store.add(obj({ id: 'statue', kind: 'prop', tx: 25, ty: 25, w: 1, h: 1, z: 80 }))
  assert.equal(computeCover(g, store), 0)
  assert.ok(g.cover.every(v => v === 0))
})

test('cover: recompute clears stale values', () => {
  const g = coverGrid(), store = new ObjectStore()
  store.add(bld({ id: 'tall', tx: 10, ty: 10, w: 2, h: 2, z: 60 }))
  computeCover(g, store); assert.ok(g.get('cover', 9, 9) > 0)
  store.delete('tall'); computeCover(g, store)
  assert.ok(g.cover.every(v => v === 0))
})

test('cover: boundsOf overrides the prism; threshold and union of occluders', () => {
  // tile (5,5): feet at (0, 88), box x [-8, 8], y [64, 88]
  const g = coverGrid(), b1 = bld({ id: 'b1', tx: 8, ty: 8 }), b2 = bld({ id: 'b2', tx: 9, ty: 9 })
  const run = (bounds) => { computeCover(g, [b1, b2], { boundsOf: o => bounds[o.id] ?? null }); return g.get('cover', 5, 5) }
  assert.equal(run({ b1: { x0: -8, x1: 0, y0: 0, y1: 200 }, b2: { x0: 900, x1: 901, y0: 0, y1: 1 } }), 50)
  assert.equal(run({ b1: { x0: -8, x1: -3, y0: 0, y1: 200 }, b2: { x0: 900, x1: 901, y0: 0, y1: 1 } }), 0, '31% is under COVER_MIN')
  assert.equal(run({ b1: { x0: -8, x1: 2, y0: 0, y1: 200 }, b2: { x0: -2, x1: 8, y0: 0, y1: 200 } }), 100, 'overlapping halves union to 100')
  assert.equal(run({ b1: { x0: -8, x1: -3, y0: 0, y1: 200 }, b2: { x0: -8, x1: -3, y0: 0, y1: 200 } }), 0, 'the same strip twice is not double counted')
  assert.equal(run({ b1: { x0: -8, x1: -3, y0: 0, y1: 200 }, b2: { x0: 3, x1: 8, y0: 0, y1: 200 } }), 63, 'two separate strips add')
  assert.equal(run({ b1: { x0: -100, x1: 100, y0: 76, y1: 200 }, b2: null }), 50, 'bottom half of the box')
})

// Brute force: point-in-convex-hexagon at pixel centres, against the prism silhouette.
function bruteCover(o, a, b) {
  const { tx, ty, w, h, z } = o, P = (x, y, zz = 0) => [(x - y) * 16, (x + y) * 8 - zz]
  const hull = [P(tx, ty + h), P(tx + w, ty + h), P(tx + w, ty), P(tx + w, ty, z), P(tx, ty, z), P(tx, ty + h, z)]
  // counter-clockwise order on screen (y down): W, S, E, E', N', W'
  const inside = (x, y) => hull.every((p, k) => { const q = hull[(k + 1) % hull.length]; return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]) <= 0 })
  const fx = (a - b) * 16, fy = (a + b + 1) * 8
  let n = 0
  for (let px = 0; px < 16; px++) for (let py = 0; py < 24; py++) if (inside(fx - 8 + px + 0.5, fy - 24 + py + 0.5)) n++
  return Math.round(100 * n / 384)
}

test('cover: prism estimate matches a brute-force rasterised hull', () => {
  const r = rng(11)
  for (let k = 0; k < 40; k++) {
    const o = bld({ id: 'b', tx: 15, ty: 15, w: 1 + Math.floor(r() * 5), h: 1 + Math.floor(r() * 5), z: Math.floor(r() * 120) })
    const g = coverGrid()
    computeCover(g, [o])
    const depth = o.tx + o.w - 1 + o.ty + o.h - 1
    for (let a = 5; a < 25; a++) for (let b = 5; b < 25; b++) {
      const own = a >= o.tx && a < o.tx + o.w && b >= o.ty && b < o.ty + o.h
      let want = own || a + b >= depth ? 0 : bruteCover(o, a, b)
      if (want < COVER_MIN) want = 0
      const got = g.get('cover', a, b)
      assert.ok(Math.abs(got - want) <= 5 || (Math.min(got, want) === 0 && Math.max(got, want) <= COVER_MIN + 5),
        `b ${o.w}x${o.h} z${o.z} tile ${a},${b}: got ${got} want ${want}`)
    }
  }
})

test('cover: 300x300 grid with ~2,000 buildings is fast', () => {
  const g = new WorldGrid({ ox: -150, oy: -150, w: 300, h: 300 })
  const r = rng(5), list = []
  for (let y = -148; y < 140 && list.length < 2000; y += 6) for (let x = -148; x < 140 && list.length < 2000; x += 6)
    list.push(bld({ id: `b${list.length}`, tx: x, ty: y, w: 2 + Math.floor(r() * 4), h: 2 + Math.floor(r() * 4), z: 20 + Math.floor(r() * 80) }))
  assert.ok(list.length >= 2000)
  computeCover(g, list)   // warm up
  const t0 = performance.now(); const n = computeCover(g, list); const ms = performance.now() - t0
  assert.ok(n > 0)
  assert.ok(ms < 100, `computeCover took ${ms.toFixed(1)} ms`)
  console.log(`# computeCover 300x300, ${list.length} buildings: ${ms.toFixed(1)} ms, ${n} covered tiles`)
})
