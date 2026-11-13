// Engine v2 render: per-column depth slicing (design §3.2, R2). Pure math, synthetic sprites only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sliceSprite } from '../web/src/engine/render/slice.js'
import { sortKey, LAYER } from '../web/src/engine/render/depth.js'
import { toScreen } from '../web/src/engine/core/coords.js'

const IMG = { width: 512, height: 512, tag: 'img' }
const obj = (o) => ({ id: 'o', kind: 'building', model: 'm', tx: 0, ty: 0, w: 1, h: 1, z: 0, walk: 'block', styleKey: '', variant: 0, ...o })
// a sprite whose image is placed so that image px (px, py) lands on world screen (sx0 + px, sy0 + py)
const spriteAt = (o, sx0, sy0, bounds) => {
  const p = toScreen(o.tx, o.ty, 0)
  return { img: IMG, bounds, pivot: { x: p.sx - sx0, y: p.sy - sy0 } }
}
// brute force: depth of strip k = max(x+y) over footprint cells whose diamond overlaps [16k, 16k+16)
const bruteDepth = (o, k) => {
  let best = -Infinity
  for (let y = o.ty; y < o.ty + o.h; y++) for (let x = o.tx; x < o.tx + o.w; x++) {
    const c = x - y; if (c === k || c === k + 1) best = Math.max(best, x + y)
  }
  return best
}

test('1x1 block: two 16 px slices at the tile half-diagonals, depth x+y, pivot on the north corner', () => {
  const o = obj({ tx: 3, ty: 1 })            // col 2, diag 4; north corner at (32, 32)
  const sp = { img: IMG, bounds: { x: 0, y: 0, w: 32, h: 40 }, pivot: { x: 16, y: 24 } }
  const s = sliceSprite(o, sp)
  assert.equal(s.length, 2)
  assert.deepEqual(s.map(q => q.col), [1, 2])
  assert.deepEqual(s.map(q => q.depth), [4, 4])
  assert.deepEqual(s.map(q => [q.sx, q.sw, q.dx]), [[0, 16, 16], [16, 16, 32]])
  for (const q of s) {
    assert.equal(q.sy, 0); assert.equal(q.sh, 40); assert.equal(q.dy, 32 - 24); assert.equal(q.img, IMG)
    assert.equal(q.key, sortKey(q.depth, 0, LAYER.OBJECT, q.col))
  }
})

test('slices cover exactly the true bounds and are aligned to 16 px strips', () => {
  const o = obj({ tx: 5, ty: 2, w: 3, h: 2 })
  const sp = spriteAt(o, -7, -50, { x: 4, y: 3, w: 75, h: 60 })   // world x [-3, 72)
  const s = sliceSprite(o, sp)
  assert.equal(s[0].dx, -3); assert.equal(s.at(-1).dx + s.at(-1).sw, 72)
  for (let i = 0; i < s.length; i++) {
    const q = s[i]
    assert.ok(q.sw > 0 && q.sw <= 16)
    assert.ok(q.dx >= q.col * 16 && q.dx + q.sw <= q.col * 16 + 16)
    assert.equal(q.sx, q.dx - -7)                   // source x maps back through the pivot
    assert.equal(q.sy, 3); assert.equal(q.sh, 60); assert.equal(q.dy, -50 + 3)
    if (i) assert.equal(q.dx, s[i - 1].dx + s[i - 1].sw)
  }
  assert.deepEqual(s.map(q => q.col), [-1, 0, 1, 2, 3, 4])
})

test('depth per column = max(x+y) of the footprint cells on that column (brute force)', () => {
  for (const [w, h] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 2], [2, 5], [4, 4], [6, 1]]) {
    const o = obj({ tx: 7, ty: -3, w, h })
    const c0 = o.tx - o.ty, cMin = c0 - (h - 1), cMax = c0 + (w - 1)
    const sp = spriteAt(o, (cMin - 1) * 16, 0, { x: 0, y: 0, w: (cMax - cMin + 2) * 16, h: 10 })
    const s = sliceSprite(o, sp)
    assert.equal(s.length, cMax - cMin + 2, `${w}x${h}`)
    for (const q of s) assert.equal(q.depth, bruteDepth(o, q.col), `${w}x${h} col ${q.col}`)
  }
})

test('tall objects: a spire above the footprint keeps the depth of its own column', () => {
  const o = obj({ tx: 0, ty: 0, w: 2, h: 2 })      // cols -1..1
  const sp = spriteAt(o, -32, -200, { x: 0, y: 0, w: 64, h: 232 })
  const s = sliceSprite(o, sp)
  assert.deepEqual(s.map(q => [q.col, q.depth]), [[-2, 1], [-1, 2], [0, 2], [1, 1]])
})

test('overhang beyond the footprint clamps to the nearest footprint column', () => {
  const o = obj({ kind: 'tree', tx: 4, ty: 4 })     // col 0, strips -1 and 0, depth 8
  const sp = spriteAt(o, -40, -60, { x: 0, y: 0, w: 80, h: 70 })
  const s = sliceSprite(o, sp)
  assert.deepEqual(s.map(q => q.col), [-3, -2, -1, 0, 1, 2])
  for (const q of s) assert.equal(q.depth, 8)
})

test('slices outside the true bounds are skipped', () => {
  const o = obj({ tx: 0, ty: 0, w: 3, h: 3 })
  const sp = spriteAt(o, -48, 0, { x: 40, y: 2, w: 10, h: 5 })    // world x [-8, 2): strips -1 and 0 only
  const s = sliceSprite(o, sp)
  assert.deepEqual(s.map(q => [q.col, q.dx, q.sw]), [[-1, -8, 8], [0, 0, 2]])
  assert.deepEqual(sliceSprite(o, { img: IMG, bounds: { x: 0, y: 0, w: 0, h: 9 }, pivot: { x: 0, y: 0 } }), [])
  assert.deepEqual(sliceSprite(o, null), [])
})

test('the image is passed through untouched; bounds default to the whole image', () => {
  const img = { width: 32, height: 16 }
  const s = sliceSprite(obj({}), { img, pivot: { x: 16, y: 0 } })
  assert.equal(s.length, 2); assert.ok(s.every(q => q.img === img))
  assert.deepEqual(s.map(q => [q.sx, q.sy, q.sw, q.sh]), [[0, 0, 16, 16], [16, 0, 16, 16]])
})

test('floor objects and decals sort on the ground-prop layer', () => {
  const o = obj({ kind: 'dock', walk: 'floor' })
  const s = sliceSprite(o, spriteAt(o, -16, 0, { x: 0, y: 0, w: 32, h: 16 }))
  for (const q of s) assert.equal(q.key, sortKey(q.depth, 0, LAYER.GROUND_PROP, q.col))
})

test('edge runs: one slice per run tile, each 16 px, depth of its own tile', () => {
  // x-run, side N: tile i edge goes north corner (tx+i,ty) -> east corner: strip (tx+i-ty)
  const o = obj({ kind: 'prop', walk: 'edge', tx: 2, ty: 1, w: 4, h: 1, run: { dir: 'x', len: 4, side: 'N' } })
  const p = toScreen(2, 1)
  const s = sliceSprite(o, spriteAt(o, p.sx, p.sy - 20, { x: 0, y: 0, w: 64, h: 52 }))
  assert.equal(s.length, 4)
  assert.deepEqual(s.map(q => [q.col, q.depth, q.sw]), [[1, 3, 16], [2, 4, 16], [3, 5, 16], [4, 6, 16]])
  // y-run, side W: tile (tx, ty+i) W edge lies in strip col-1
  const y = obj({ kind: 'prop', walk: 'edge', tx: 0, ty: 0, w: 1, h: 3, run: { dir: 'y', len: 3, side: 'W' } })
  const sy = sliceSprite(y, spriteAt(y, -48, -20, { x: 0, y: 0, w: 48, h: 60 }))
  assert.deepEqual(sy.map(q => [q.col, q.depth]), [[-3, 2], [-2, 1], [-1, 0]])
})

test('edge runs: S and E sides belong to the front neighbour (fence never draws over the tile behind)', () => {
  const s = obj({ kind: 'prop', walk: 'edge', tx: 0, ty: 0, w: 2, h: 1, run: { dir: 'x', len: 2, side: 'S' } })
  // S edge of (x,0) = N edge of (x,1): strip x-1, depth x+1
  const ss = sliceSprite(s, spriteAt(s, -16, 0, { x: 0, y: 0, w: 32, h: 30 }))
  assert.deepEqual(ss.map(q => [q.col, q.depth]), [[-1, 1], [0, 2]])
  const e = obj({ kind: 'prop', walk: 'edge', tx: 0, ty: 0, w: 1, h: 2, run: { dir: 'y', len: 2, side: 'E' } })
  // E edge of (0,y) = W edge of (1,y): strip -y, depth 1+y
  const se = sliceSprite(e, spriteAt(e, -16, 0, { x: 0, y: 0, w: 32, h: 30 }))
  assert.deepEqual(se.map(q => [q.col, q.depth]), [[-1, 2], [0, 1]])
  // an actor on the fence's own tile (behind it) sorts under, one on the front tile sorts over
  const fence = ss[1]
  assert.ok(sortKey(1, 3, LAYER.ACTOR, 0) < fence.key)
  assert.ok(sortKey(2, 0, LAYER.ACTOR, 0) > fence.key)
})

test('edge runs: overhang (posts) widens the end slices, count stays one per tile', () => {
  const o = obj({ kind: 'prop', walk: 'edge', tx: 0, ty: 0, w: 3, h: 1, run: { dir: 'x', len: 3, side: 'N' } })
  const s = sliceSprite(o, spriteAt(o, -3, -10, { x: 0, y: 0, w: 54, h: 40 }))   // world x [-3, 51)
  assert.equal(s.length, 3)
  assert.deepEqual(s.map(q => [q.dx, q.sw]), [[-3, 19], [16, 16], [32, 19]])
})

test('edge runs: obj.dir/obj.len fallback and a run derived from w x h', () => {
  const a = obj({ kind: 'prop', walk: 'edge', tx: 0, ty: 0, w: 2, h: 1, dir: 'x', len: 2 })
  const b = obj({ kind: 'prop', walk: 'edge', tx: 0, ty: 0, w: 2, h: 1 })
  const sp = spriteAt(a, 0, 0, { x: 0, y: 0, w: 32, h: 20 })
  assert.deepEqual(sliceSprite(a, sp).map(q => [q.col, q.depth]), [[0, 0], [1, 1]])
  assert.deepEqual(sliceSprite(b, sp).map(q => [q.col, q.depth]), [[0, 0], [1, 1]])
})

test('neighbour houses: the front house wins every shared column (RC4)', () => {
  const back = obj({ tx: 0, ty: 0, w: 2, h: 2 }), front = obj({ tx: 2, ty: 0, w: 2, h: 2 })
  const sb = sliceSprite(back, spriteAt(back, -48, -80, { x: 0, y: 0, w: 96, h: 112 }))
  const sf = sliceSprite(front, spriteAt(front, -16, -64, { x: 0, y: 0, w: 96, h: 112 }))
  for (const f of sf) for (const b of sb) if (f.col === b.col) assert.ok(f.key > b.key, `col ${f.col}`)
})
