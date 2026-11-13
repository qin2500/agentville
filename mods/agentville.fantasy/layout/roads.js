// agentville.fantasy layout: the town raster, the ring road round every block and the 2-wide roads to the square.
// OWNER: MOD-READY P1. Pure. Moved from the engine's world/sites.js (geoFast; classic world.js buildRoads) unchanged:
// same tile order, same A* (kit routeOnRaster) and the same costs, so the world is byte-identical.
import { createRaster, routeOnRaster, rectsBounds, inRect } from '#agentville/mod';

// Raster flag bits. FP: a lot or civic footprint (roads never cross it); PATH: walkable (plan walk ground, square,
// roads); STREET/RING/LANE/FOOT: road kinds; LAND; DOCKC: the waterfront clearing; INB: inside a block.
export const FP = 1, PATH = 2, STREET = 4, RING = 8, LANE = 16, FOOT = 32, LAND = 64, DOCKC = 128, INB = 256;
/** Route costs as classic route(): footprints block, block interiors are dear (41), paths cheap (0.35). */
export const ROUTE = Object.freeze({ block: FP, dear: INB, cheap: PATH });
/** Land reaches E tiles past the town; the raster adds 15 more for the sea and the harbour cove. */
export const E = 12, PAD = E + 15;

/** The layout state: the raster round the town plus the per-tile arrays every step shares.
 *  town = [x0, y0, x1, y1] inclusive tiles, ring roads included (classic W.town); box = where roads may route. */
export function createTown(settlements, square) {
  const { x0, y0, x1, y1 } = rectsBounds([square, ...settlements.map(v => v.block)]);
  const town = [x0 - 1, y0 - 1, x1, y1], box = [x0 - 14, y0 - 14, x1 + 14, y1 + 14];
  const [tx0, ty0, tx1, ty1] = town;
  const R = createRaster({ ox: tx0 - PAD, oy: ty0 - PAD, w: tx1 - tx0 + 1 + 2 * PAD, h: ty1 - ty0 + 1 + 2 * PAD });
  return { R, town, box, square, path: [], inBlock: new Int32Array(R.n).fill(-1), seaDist: new Int8Array(R.n).fill(-1),
    waves: [], dock: null, bounds: null };
}

/** What a placed plan contributes that the roads read: block tiles, the plan's walkable ground and the footprints. */
export function stampBlocks(G, settlements, walk) {
  const { R, inBlock } = G, { at, flags: F } = R;
  for (const v of settlements) {
    const { block: b, plan: p } = v;
    for (let j = 0; j < p.h; j++) for (let i = 0; i < p.w; i++) {
      const t = at(b.x + i, b.y + j);
      inBlock[t] = v.index;
      F[t] |= INB;
      if (walk.has(p.ground[j * p.w + i])) R.add(PATH, G.path, t);
    }
    for (const r of [...p.lots, ...(p.civic || [])]) for (let j = r.y; j < r.y + r.h; j++) for (let i = r.x; i < r.x + r.w; i++) { const t = at(b.x + i, b.y + j); if (t >= 0) F[t] |= FP; }
  }
}

/** classic buildRoads: the square is path, a ring road round every block, then (nearest block first) a 2-wide A* road
 *  from each ring to the square. */
export function buildRoads(G, settlements) {
  const { R, square: SQ, box, inBlock } = G, { at } = R;
  const street = i => { R.add(PATH, G.path, i); R.add(STREET, null, i); };
  for (let j = SQ.y; j < SQ.y + SQ.h; j++) for (let i = SQ.x; i < SQ.x + SQ.w; i++) R.add(PATH, G.path, at(i, j));
  for (const v of settlements) {
    const b = v.block, ring = i => { street(i); R.add(RING, null, i); };
    for (let i = b.x - 1; i <= b.x + b.w; i++) { ring(at(i, b.y - 1)); ring(at(i, b.y + b.h)); }
    for (let j = b.y; j < b.y + b.h; j++) { ring(at(b.x - 1, j)); ring(at(b.x + b.w, j)); }
  }
  const sq = [SQ.x + SQ.w / 2, SQ.y + SQ.h / 2];
  for (const v of [...settlements].sort((a, b) => Math.hypot(a.cx, a.cy) - Math.hypot(b.cx, b.cy))) {
    const b = v.block, ring = [];
    for (let i = b.x - 1; i <= b.x + b.w; i++) ring.push([i, b.y - 1], [i, b.y + b.h]);
    for (let j = b.y; j < b.y + b.h; j++) ring.push([b.x - 1, j], [b.x + b.w, j]);
    for (const [x, y] of routeOnRaster(R, ring, (x, y) => inRect(SQ, x, y), box, sq, ROUTE)) {
      for (const [a, c] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const t = at(x + a, y + c); if (!(t >= 0 && inBlock[t] >= 0)) { street(t); R.add(LANE, null, t); } }
    }
  }
}
