// Per-column depth slicing of static object sprites (design §3.2). Pure math, no DOM; `img` passes through.
//
// sliceSprite(obj, sprite) -> Slice[]  (left to right on screen)
//   Slice = { key, col, depth, sx, sy, sw, sh, dx, dy, img }
//   - sx, sy, sw, sh: source rect inside sprite.img (sprite px = 1x screen px).
//   - dx, dy: 1x WORLD screen px of the rect's top-left (camera not applied). Draw size = sw x sh.
//   - col: the screen strip index k; strip k covers world sx in [16k, 16k + 16). Strip boundaries are the tile
//     half-diagonals: tile (tx, ty) with col c = tx - ty spans strips c - 1 (left half) and c (right half).
//   - depth: for a block/floor object, max(x + y) over the footprint cells whose diamond lies in strip k
//     (cells with col k or k + 1). Strips the sprite overhangs beyond the footprint clamp to the nearest
//     footprint strip, so tall or wide art (a spire, a canopy, an eave) keeps the depth of its own footprint.
//   - key: sortKey(depth, 0, layer, col) from ./depth.js; layer GROUND_PROP for walk 'floor' or kind 'decal',
//     else OBJECT.
// Placement: sprite.pivot (sprite px) lands on toScreen(obj.tx, obj.ty, 0), the footprint origin's north corner.
// Only the sprite's true opaque bounds (sprite.bounds, else the whole img) are sliced; empty strips are skipped.
//
// Edge runs (walk 'edge': obj.run { dir, len, side }, or obj.dir/obj.len/obj.side, else derived from w x h):
// exactly one slice per run tile. Each tile's edge lies in one strip. A side S or E edge is the N or W edge
// of the neighbour tile (x, y+1) or (x+1, y); a N edge lies in strip col, a W edge in strip col - 1; the
// slice's depth is x + y of that (normalised) tile, so an actor on the tile in front of the fence draws over it
// and an actor behind it is covered. Art overhanging past the run's ends (posts) widens the end slices.
import { toScreen } from '../core/coords.js'
import { sortKey, LAYER } from './depth.js'

const STRIP = 16

/** The edge run of an edge object, normalised: { dir, len, side } or null. */
export function runOf(obj) {
  const r = obj.run || (obj.len != null || obj.dir != null ? { dir: obj.dir, len: obj.len, side: obj.side } : null)
  const dir = r?.dir ?? (obj.h > 1 && !(obj.w > 1) ? 'y' : 'x')
  const len = r?.len ?? (dir === 'x' ? obj.w : obj.h)
  if (!(len >= 1)) return null
  const side = r?.side ?? (dir === 'x' ? 'N' : 'W')
  return { dir, len: Math.floor(len), side }
}

/** Per run tile: { strip, depth } (one entry per tile, in run order). */
export function runStrips(obj) {
  const r = runOf(obj); if (!r) return []
  const out = []
  for (let i = 0; i < r.len; i++) {
    let x = obj.tx + (r.dir === 'x' ? i : 0), y = obj.ty + (r.dir === 'y' ? i : 0), side = r.side
    if (side === 'S') { y += 1; side = 'N' } else if (side === 'E') { x += 1; side = 'W' }
    out.push({ strip: side === 'N' ? x - y : x - y - 1, depth: x + y })
  }
  return out
}

/** depth of strip k for a w x h footprint at (tx, ty): max x + y over cells with col k or k+1, clamped to the footprint. */
export function blockStripDepth(obj, k) {
  const w = Math.max(1, obj.w | 0), h = Math.max(1, obj.h | 0)
  const c0 = obj.tx - obj.ty, cMin = c0 - (h - 1), cMax = c0 + (w - 1)
  k = Math.min(Math.max(k, cMin - 1), cMax)
  let best = -Infinity
  for (const c of [k, k + 1]) {
    if (c < cMin || c > cMax) continue
    // cells (x, y) with x - y = c in the rect: x = y + c; frontmost = largest x (then y = x - c)
    const ox = Math.min(w - 1, (h - 1) + (c - c0)), oy = ox - (c - c0)   // offsets inside the footprint
    if (ox < 0 || oy < 0 || oy > h - 1) continue
    best = Math.max(best, (obj.tx + ox) + (obj.ty + oy))
  }
  return best
}

/** @returns {Array<{ key, col, depth, sx, sy, sw, sh, dx, dy, img }>} */
export function sliceSprite(obj, sprite) {
  if (!obj || !sprite) return []
  const img = sprite.img
  const b = sprite.bounds || { x: 0, y: 0, w: img?.width | 0, h: img?.height | 0 }
  if (!(b.w > 0 && b.h > 0)) return []
  const piv = sprite.pivot || { x: 0, y: 0 }
  const o = toScreen(obj.tx, obj.ty, 0)
  const offX = o.sx - piv.x, offY = o.sy - piv.y          // world sx = offX + image px
  const X0 = offX + b.x, X1 = X0 + b.w                       // world screen x range of the true bounds
  const layer = (obj.walk === 'floor' || obj.kind === 'decal') ? LAYER.GROUND_PROP : LAYER.OBJECT
  const sy = b.y, sh = b.h, dy = offY + b.y
  const make = (k, depth, L, R) => ({ key: sortKey(depth, 0, layer, k), col: k, depth, sx: L - offX, sy, sw: R - L, sh, dx: L, dy, img })

  if (obj.walk === 'edge') {
    const tiles = runStrips(obj)
    if (!tiles.length) return []
    // order tiles by strip; the leftmost/rightmost absorb any overhang
    const ord = tiles.map((t, i) => ({ ...t, i })).sort((a, c) => a.strip - c.strip || a.i - c.i)
    const out = []
    for (let j = 0; j < ord.length; j++) {
      const t = ord[j]
      let L = t.strip * STRIP, R = L + STRIP
      if (j === 0) L = Math.min(L, X0)
      if (j === ord.length - 1) R = Math.max(R, X1)
      L = Math.max(L, X0); R = Math.min(R, X1)
      if (R > L) out.push(make(t.strip, t.depth, L, R))
    }
    return out
  }

  const out = []
  for (let k = Math.floor(X0 / STRIP); k * STRIP < X1; k++) {
    const L = Math.max(k * STRIP, X0), R = Math.min(k * STRIP + STRIP, X1)
    if (R > L) out.push(make(k, blockStripDepth(obj, k), L, R))
  }
  return out
}
