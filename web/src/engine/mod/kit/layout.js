// Layout kit for mods (re-exported by mod/public.js): raster, routing, noise, floods, distance fields, rect helpers.
// OWNER: MOD-READY P1. Pure, no DOM, no clock, no storage. Mechanism only: what a world looks like is the mod's.
// Moved out of world/sites.js (MOD-4a) with the arithmetic, draw keys and tie order unchanged, so a layout built on it
// is byte-identical to the old built-in one.
import { hash } from '../../core/rng.js';

const rnd = s => (hash(s) % 10000) / 10000;
const LATTICE = new Map(); // noise lattice values (pure in i, j): a memo, not state

/** Smooth value noise in [0, 1): lattice values hash('n<i>,<j>') every `s` tiles, smoothstep-blended. Pure in (x, y, s). */
export function noise(x, y, s = 7) {
  const gx = Math.floor(x / s), gy = Math.floor(y / s), fx = x / s - gx, fy = y / s - gy;
  const n = (i, j) => { const k = i * 100003 + j; let r = LATTICE.get(k); if (r === undefined) { r = rnd(`n${i},${j}`); LATTICE.set(k, r); } return r; }, sm = t => t * t * (3 - 2 * t);
  const a = n(gx, gy), b = n(gx + 1, gy), c = n(gx, gy + 1), d = n(gx + 1, gy + 1);
  return a + (b - a) * sm(fx) + (c - a) * sm(fy) + (a - b - c + d) * sm(fx) * sm(fy);
}

/** True when rects a and b come closer than `gap` tiles (rects are { x, y, w, h }). */
export const near = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
/** True when tile (x, y) is inside rect r. */
export const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
/** The bounding box of some rects: { x0, y0, x1, y1 } with x1/y1 exclusive (max of r.x + r.w). */
export function rectsBounds(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  return { x0, y0, x1, y1 };
}

/**
 * A flat tile raster over { ox, oy, w, h }: 16 flag bits per tile and, per bit, an insertion-order list of the tiles
 * that got it (so a layout can replay "the order classic added them" without string Sets).
 * @returns {{ ox: number, oy: number, w: number, h: number, n: number, flags: Uint16Array,
 *   at(x: number, y: number): number, x(i: number): number, y(i: number): number,
 *   has(i: number, bits: number): boolean, add(bit: number, list: number[]|null, i: number): void }}
 *   at() is -1 outside; add() sets `bit` once and pushes i to `list` the first time (throws on -1: an overflow).
 */
export function createRaster({ ox, oy, w, h }) {
  if (![ox, oy, w, h].every(Number.isInteger) || w <= 0 || h <= 0) throw new RangeError(`createRaster: bad rect ${JSON.stringify({ ox, oy, w, h })}`);
  const n = w * h, flags = new Uint16Array(n);
  const R = {
    ox, oy, w, h, n, flags, memo: new Map(),
    at: (x, y) => (x < ox || y < oy || x >= ox + w || y >= oy + h ? -1 : (y - oy) * w + (x - ox)),
    x: i => ox + i % w,
    y: i => oy + (i / w | 0),
    has: (i, bits) => i >= 0 && (flags[i] & bits) !== 0,
    add(bit, list, i) {
      if (i < 0) throw new RangeError('raster overflow');
      if (!(flags[i] & bit)) { flags[i] |= bit; if (list) list.push(i); }
    },
  };
  return R;
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** 4-way flood fill on a raster. `queue` holds the seeds (already marked) and grows in visit order; a neighbour j is
 *  taken when it is in the raster, unmarked and ok(x, y, j). Marks with 1. @returns the queue. */
export function flood4(R, queue, mark, ok) {
  const { at, w, ox, oy } = R;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h], x = ox + i % w, y = oy + (i / w | 0);
    for (const [a, b] of N4) { const j = at(x + a, y + b); if (j >= 0 && !mark[j] && ok(x + a, y + b, j)) { mark[j] = 1; queue.push(j); } }
  }
  return queue;
}
/** 4-way BFS distance on a raster. `dist` (a signed typed array, -1 = unknown) has the seeds at 0 and `queue` holds
 *  them; tiles up to max + 1 away get their distance. @returns the queue (every reached tile, in BFS order). */
export function distance4(R, queue, dist, max) {
  const { at, w, ox, oy } = R;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h], dv = dist[i];
    if (dv > max) continue;
    const x = ox + i % w, y = oy + (i / w | 0);
    for (const [dx, dy] of N4) { const j = at(x + dx, y + dy); if (j >= 0 && dist[j] < 0) { dist[j] = dv + 1; queue.push(j); } }
  }
  return queue;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const NOISE5 = (x, y) => 1 + 3 * noise(x, y, 5) ** 2;
/**
 * A* on a raster toward `aim` (8-way, a binary heap with a fixed tie order), from the `from` tiles to the first tile
 * where isGoal(x, y), inside `box` = [x0, y0, x1, y1] (inclusive). Tiles with a `block` flag are never entered and no
 * diagonal step cuts their corner; stepping on a `dear` tile costs dearCost, on a `cheap` one cheapCost, elsewhere
 * field(x, y) (memoised per raster and field) — times diag on a diagonal. The returned path runs goal → start with an
 * orthogonal tile inserted at every diagonal step (the one off the blocked side), as [x, y] pairs; [] when unreachable.
 * Flags are read live, so tiles a previous route marked `cheap` are cheap for the next one.
 * @param {ReturnType<typeof createRaster>} R
 * @param {{ block?: number, dear?: number, cheap?: number, dearCost?: number, cheapCost?: number, diag?: number,
 *   field?: (x: number, y: number) => number }} [opts] defaults: no flags, costs 41 / 0.35, diag 1.42, field 1 + 3·noise(x, y, 5)²
 */
export function routeOnRaster(R, from, isGoal, box, aim, { block = 0, dear = 0, cheap = 0, dearCost = 41, cheapCost = 0.35, diag = 1.42, field = NOISE5 } = {}) {
  const [x0, y0, x1, y1] = box, Wd = x1 - x0 + 1, idx = (x, y) => (y - y0) * Wd + (x - x0);
  const { at, flags: F } = R;
  let memo = R.memo.get(field);
  if (!memo) { memo = new Float64Array(R.n).fill(NaN); R.memo.set(field, memo); }
  const dist = new Float64Array(Wd * (y1 - y0 + 1)).fill(Infinity), prev = new Int32Array(dist.length).fill(-1);
  const hd = [], hi = [];
  const push = (d, i) => {
    hd.push(d); hi.push(i);
    let k = hd.length - 1;
    while (k) { const p = (k - 1) >> 1; if (hd[p] <= hd[k]) break; const td = hd[p]; hd[p] = hd[k]; hd[k] = td; const ti = hi[p]; hi[p] = hi[k]; hi[k] = ti; k = p; }
  };
  const fpAt = (x, y) => { const t = at(x, y); return t >= 0 && (F[t] & block) !== 0; };
  const h = (x, y) => Math.hypot(x - aim[0], y - aim[1]), done = new Uint8Array(dist.length);
  for (const [x, y] of from) { if (x < x0 || y < y0 || x > x1 || y > y1) continue; dist[idx(x, y)] = 0; push(h(x, y), idx(x, y)); }
  while (hd.length) {
    const i = hi[0];
    { const ld = hd.pop(), li = hi.pop(), n = hd.length;
      if (n) { hd[0] = ld; hi[0] = li; let k = 0;
        for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < n && hd[l] < hd[m]) m = l; if (r < n && hd[r] < hd[m]) m = r; if (m === k) break;
          const td = hd[m]; hd[m] = hd[k]; hd[k] = td; const ti = hi[m]; hi[m] = hi[k]; hi[k] = ti; k = m; } } }
    if (done[i]) continue;
    done[i] = 1;
    const d = dist[i], x = x0 + i % Wd, y = y0 + Math.floor(i / Wd);
    if (isGoal(x, y)) {
      const out = []; let px = null, py = null;
      for (let k = i; k >= 0; k = prev[k]) {
        const X = x0 + k % Wd, Y = y0 + Math.floor(k / Wd);
        if (px !== null && px !== X && py !== Y) out.push(fpAt(X, py) ? [px, Y] : [X, py]);
        out.push([X, Y]); px = X; py = Y;
      }
      return out;
    }
    for (const [dx, dy] of DIRS) {
      const X = x + dx, Y = y + dy;
      if (X < x0 || Y < y0 || X > x1 || Y > y1 || fpAt(X, Y)) continue;
      if (dx && dy && (fpAt(x + dx, y) || fpAt(x, y + dy))) continue;
      const t = at(X, Y);
      let base;
      if (t >= 0 && (F[t] & dear)) base = dearCost;
      else if (t >= 0 && (F[t] & cheap)) base = cheapCost;
      else if (t >= 0) { base = memo[t]; if (base !== base) base = memo[t] = field(X, Y); }
      else base = field(X, Y);
      const c = base * (dx && dy ? diag : 1);
      const j = idx(X, Y);
      if (d + c < dist[j]) { dist[j] = d + c; prev[j] = i; push(d + c + h(X, Y), j); }
    }
  }
  return [];
}
