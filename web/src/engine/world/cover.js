// The visible-tile mask (design §2.4, R12). OWNER: A2. Pure.
// grid.cover[i] = percent (0..100) of a standing actor's 16x24 px box at the tile centre hidden by objects drawn in
// front of it; 0 when under 35%. M1 estimates each building's silhouette from footprint + obj.z (a prism);
// M2 passes boundsOf(obj) -> { x0, y0, x1, y1 } (1x screen px, true opaque bounds) instead.
//
// Geometry (1x screen px, coords.js projection): the actor box of tile (a, b) has its feet at the tile centre
// (sx, sy) = ((a - b) * 16, (a + b + 1) * 8) and spans x in [sx - 8, sx + 8], y in [sy - 24, sy].
// An occluder is any kind 'building' whose depth (max tx + ty over its footprint) is greater than a + b, for tiles
// outside its own footprint. Its silhouette is convex: per screen x it covers one interval [top(x), bot(x)].
// Coverage is the union over occluders, measured per 1 px column (16 columns, sampled at pixel centres).
const BOX_W = 16, BOX_H = 24;
export const COVER_MIN = 35;
export const ACTOR_BOX = Object.freeze({ w: BOX_W, h: BOX_H });

// A silhouette as two piecewise-linear chains over [x0, x1]: top through (x0, t0) (tm, tmy) (x1, t1) and bottom
// through (x0, b0) (bm, bmy) (x1, b1).
function prism(o) {
  const tx = o.tx, ty = o.ty, w = o.w, h = o.h, z = o.z || 0;
  const Wx = (tx - ty - h) * 16, Wy = (tx + ty + h) * 8;   // west corner
  const Ex = (tx + w - ty) * 16, Ey = (tx + w + ty) * 8;   // east corner
  const Nx = (tx - ty) * 16, Ny = (tx + ty) * 8;           // north corner
  const Sx = (tx + w - ty - h) * 16, Sy = (tx + w + ty + h) * 8;   // south corner
  return { x0: Wx, x1: Ex, t0: Wy - z, tm: Nx, tmy: Ny - z, t1: Ey - z, b0: Wy, bm: Sx, bmy: Sy, b1: Ey };
}
function rectSil(r) {
  return { x0: r.x0, x1: r.x1, t0: r.y0, tm: r.x0, tmy: r.y0, t1: r.y0, b0: r.y1, bm: r.x0, bmy: r.y1, b1: r.y1 };
}
const lerp = (xa, ya, xb, yb, x) => (xb === xa ? Math.min(ya, yb) : ya + (yb - ya) * (x - xa) / (xb - xa));
const topAt = (s, x) => (x <= s.tm ? lerp(s.x0, s.t0, s.tm, s.tmy, x) : lerp(s.tm, s.tmy, s.x1, s.t1, x));
const botAt = (s, x) => (x <= s.bm ? lerp(s.x0, s.b0, s.bm, s.bmy, x) : lerp(s.bm, s.bmy, s.x1, s.b1, x));
const yMin = s => Math.min(s.t0, s.tmy, s.t1);
const yMax = s => Math.max(s.b0, s.bmy, s.b1);

/** Fill grid.cover. objects: an ObjectStore / Map of WorldObjects, or any iterable of them.
 *  opts.boundsOf(obj) -> { x0, y0, x1, y1 } | null (1x screen px) overrides the prism estimate.
 *  @returns {number} the number of covered tiles */
export function computeCover(grid, objects, { boundsOf } = {}) {
  const cover = grid.cover;
  cover.fill(0);
  const list = objects instanceof Map ? objects.values() : objects;
  const sils = [], depths = [], foots = [];
  // Per-tile linked lists of occluder indices.
  const head = new Int32Array(cover.length).fill(-1);
  let next = new Int32Array(1024), who = new Int32Array(1024), n = 0;
  for (const o of list) {
    if (!o || o.kind !== 'building') continue;
    const b = boundsOf ? boundsOf(o) : null;
    const s = b ? rectSil(b) : prism(o);
    if (!(s.x1 > s.x0)) continue;
    const k = sils.length;
    const depth = o.tx + o.w - 1 + o.ty + o.h - 1;
    sils.push(s); depths.push(depth); foots.push(o);
    const y0 = yMin(s), y1 = yMax(s);
    // Tiles whose box overlaps the silhouette's rect: column c = a - b, diagonal d = a + b (same parity).
    // box x [16c - 8, 16c + 8] overlaps (x0, x1) strictly: 16c + 8 > x0 and 16c - 8 < x1
    const cLo = Math.floor((s.x0 - 8) / 16) + 1, cHi = Math.ceil((s.x1 + 8) / 16) - 1;
    // box y [8(d+1) - 24, 8(d+1)] overlaps (y0, y1) strictly: 8(d+1) > y0 and 8(d+1) - 24 < y1
    const dLo = Math.floor(y0 / 8), dHi = Math.min(depth - 1, Math.ceil((y1 + 24) / 8) - 2);
    for (let d = dLo; d <= dHi; d++) {
      for (let c = cLo + (((cLo + d) % 2 + 2) % 2); c <= cHi; c += 2) {
        if (16 * c + 8 <= s.x0 || 16 * c - 8 >= s.x1 || 8 * (d + 1) <= y0 || 8 * (d + 1) - 24 >= y1) continue;
        const a = (c + d) / 2, bb = (d - c) / 2;
        const i = grid.idx(a, bb);
        if (i < 0) continue;
        if (a >= o.tx && a < o.tx + o.w && bb >= o.ty && bb < o.ty + o.h) continue;
        if (n === next.length) { const g = next.length * 2; const nn = new Int32Array(g); nn.set(next); next = nn; const nw = new Int32Array(g); nw.set(who); who = nw; }
        who[n] = k; next[n] = head[i]; head[i] = n; n++;
      }
    }
  }
  const W = grid.w, ox = grid.ox, oy = grid.oy;
  let los = new Float64Array(16), his = new Float64Array(16);
  let covered = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i] < 0) continue;
    const a = (i % W) + ox, b = ((i / W) | 0) + oy;
    const fx = (a - b) * 16, fy = (a + b + 1) * 8, top = fy - BOX_H;
    let sum = 0;
    for (let px = 0; px < BOX_W; px++) {
      const x = fx - 8 + px + 0.5;
      let m = 0;
      for (let e = head[i]; e >= 0; e = next[e]) {
        const s = sils[who[e]];
        if (x <= s.x0 || x >= s.x1) continue;
        const lo = Math.max(top, topAt(s, x)), hi = Math.min(fy, botAt(s, x));
        if (!(hi > lo)) continue;
        if (m === los.length) { const l2 = new Float64Array(m * 2); l2.set(los); los = l2; const h2 = new Float64Array(m * 2); h2.set(his); his = h2; }
        // insertion sort by lo (few occluders per tile)
        let j = m++;
        while (j > 0 && los[j - 1] > lo) { los[j] = los[j - 1]; his[j] = his[j - 1]; j--; }
        los[j] = lo; his[j] = hi;
      }
      if (m === 0) continue;
      let cl = los[0], ch = his[0];
      for (let j = 1; j < m; j++) {
        if (los[j] > ch) { sum += ch - cl; cl = los[j]; ch = his[j]; } else if (his[j] > ch) ch = his[j];
      }
      sum += ch - cl;
    }
    const pct = Math.round(100 * sum / (BOX_W * BOX_H));
    if (pct >= COVER_MIN) { cover[i] = Math.min(100, pct); covered++; }
  }
  return covered;
}
