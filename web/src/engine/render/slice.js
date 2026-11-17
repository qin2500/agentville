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
// Decks (obj.deck on a walk 'floor' object: a pier's planks, the quay; world/venue.js stamps their footprint as walkable
// ground) sort as ground: their slices' keys are sunk DECK_SINK depth rows, so they draw before every other slice and
// actor, in their own order among themselves. What stands on a deck (a person, a bollard, a lamp, a crane) or lies beside
// it (a moored hull, whose beam overhangs the planks) is drawn over it, as the classic art draws its piers in the
// ground layer under every upright. `depth` keeps the slice's real strip depth.
//
// Edge runs (walk 'edge': obj.run { dir, len, side }, or obj.dir/obj.len/obj.side, else derived from w x h):
// exactly one slice per run tile. Each tile's edge lies in one strip. A side S or E edge is the N or W edge
// of the neighbour tile (x, y+1) or (x+1, y); a N edge lies in strip col, a W edge in strip col - 1; the
// slice's depth is x + y of that (normalised) tile, so an actor on the tile in front of the fence draws over it
// and an actor behind it is covered. Art overhanging past the run's ends (posts) widens the end slices.
import { toScreen } from '../core/coords.js'
import { sortKey, LAYER } from './depth.js'

const STRIP = 16
/** Depth rows a deck's slices are sunk by (past any world's depth range: depth.js sizes worlds to +-4096). */
export const DECK_SINK = 1 << 20
/** True for a deck: a walk 'floor' object flagged deck (sorted as ground, see above). */
export const isDeck = obj => !!obj && obj.deck === true && obj.walk === 'floor'

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
  const sink = isDeck(obj) ? DECK_SINK : 0
  const sy = b.y, sh = b.h, dy = offY + b.y
  const make = (k, depth, L, R) => ({ key: sortKey(depth - sink, 0, layer, k), col: k, depth, sx: L - offX, sy, sw: R - L, sh, dx: L, dy, img })

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

// ---- hulls (actors longer than a tile: a vessel, a tug, a rowboat) ---------------------------------------------------------
// A hull drawn as one sprite at one depth (its middle) sorts wrong against the per-strip statics round it: a hull moored
// east of a pier had its bow under the next plank section, and every pier slice deeper than the hull's middle covered it.
// Sliced like a static: one piece per 16-px strip of the drawn sprite, each keyed by the frontmost point of the hull's keel
// (the segment through its feet along its heading, `len` tiles long) whose screen column lies in that strip. Strips the
// sprite overhangs beyond the keel (bowsprit, boom, the hull's beam, sails) clamp to the nearest keel strip, as statics do.
// Depth is in the actor convention (depth.js feetKey: a point (x, y) has depth x + y - 1), with the quarter-tile `sub`, so a
// hull on the centre of cell (a, b) ties a static on that cell and wins on layer, like any actor.

/**
 * @param {{ x: number, y: number, face: number, len: number }} hull feet (float tiles, tile centre at +.5), engine facing
 *   (0 E, 1 S, 2 W, 3 N: the keel runs along x for 0/2, along y for 1/3) and keel length in tiles
 * @param {number} X0 world screen x of the drawn sprite's left edge
 * @param {number} X1 its right edge (exclusive)
 * @returns {Array<{ key: number, col: number, depth: number, L: number, R: number }>} left to right; [] for an empty span
 */
export function sliceHull(hull, X0, X1, layer = LAYER.ACTOR) {
  if (!(X1 > X0)) return []
  const h = Math.max(0, +hull.len || 0) / 2, alongX = !((hull.face | 0) & 1)
  const ax = hull.x - (alongX ? h : 0), ay = hull.y - (alongX ? 0 : h), bx = hull.x + (alongX ? h : 0), by = hull.y + (alongX ? 0 : h)
  const cA = ax - ay, cB = bx - by, dA = ax + ay - 1, dB = bx + by - 1
  const cMin = Math.min(cA, cB), cMax = Math.max(cA, cB)
  const depAt = c => (cB === cA ? Math.max(dA, dB) : dA + (dB - dA) * (c - cA) / (cB - cA))
  const out = []
  for (let k = Math.floor(X0 / STRIP); k * STRIP < X1; k++) {
    const L = Math.max(k * STRIP, X0), R = Math.min(k * STRIP + STRIP, X1)
    if (!(R > L)) continue
    // the keel's part in this strip's columns [k, k + 1), else its nearest end
    let lo = Math.max(k, cMin), hi = Math.min(k + 1, cMax)
    if (lo > hi) lo = hi = k + 1 <= cMin ? cMin : cMax
    const depth = Math.max(depAt(lo), depAt(hi)), d = Math.floor(depth)
    const sub = Math.min(3, Math.floor((depth - d) * 4))
    out.push({ key: sortKey(d, sub, layer, k), col: k, depth, L, R })
  }
  return out
}
