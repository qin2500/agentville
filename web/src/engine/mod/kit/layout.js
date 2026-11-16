// Layout kit for mods (re-exported by mod/public.js): raster, routing, noise, floods, distance fields, rect helpers.
// Pure, no DOM, no clock, no storage. Mechanism only: what a world looks like is the mod's.
// Moved out of world/sites.js (MOD-4a) with the arithmetic, draw keys and tie order unchanged, so a layout built on it
// is byte-identical to the old built-in one.
import { hash } from '../../core/rng.js';

const rnd = s => (hash(s) % 10000) / 10000;
const LATTICE = new Map(); // noise lattice values (pure in i, j): a memo, not state

const lat = (i, j) => { const k = i * 100003 + j; let r = LATTICE.get(k); if (r === undefined) { r = rnd(`n${i},${j}`); LATTICE.set(k, r); } return r; };
/** Smooth value noise in [0, 1): lattice values hash('n<i>,<j>') every `s` tiles, smoothstep-blended. Pure in (x, y, s). */
export function noise(x, y, s = 7) {
  const gx = Math.floor(x / s), gy = Math.floor(y / s), fx = x / s - gx, fy = y / s - gy;
  const a = lat(gx, gy), b = lat(gx + 1, gy), c = lat(gx, gy + 1), d = lat(gx + 1, gy + 1);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
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
  const { w, h, ox, oy } = R;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], cx = i % w, cy = (i / w | 0), x = ox + cx, y = oy + cy;
    let j;
    if (cx + 1 < w) { j = i + 1; if (!mark[j] && ok(x + 1, y, j)) { mark[j] = 1; queue.push(j); } }
    if (cx > 0) { j = i - 1; if (!mark[j] && ok(x - 1, y, j)) { mark[j] = 1; queue.push(j); } }
    if (cy + 1 < h) { j = i + w; if (!mark[j] && ok(x, y + 1, j)) { mark[j] = 1; queue.push(j); } }
    if (cy > 0) { j = i - w; if (!mark[j] && ok(x, y - 1, j)) { mark[j] = 1; queue.push(j); } }
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

const SCR = { busy: false, dist: new Float64Array(0), prev: new Int32Array(0), done: new Uint8Array(0), touched: new Int32Array(0) }, SCR_MAX = 1 << 24;
const DX = [1, -1, 0, 0, 1, -1, 1, -1], DY = [0, 0, 1, -1, 1, 1, -1, -1];
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
  const { at, flags: F } = R, Rw = R.w, Rox = R.ox, Roy = R.oy, Rh = R.h;
  let memo = R.memo.get(field);
  if (!memo) { memo = new Float64Array(R.n).fill(NaN); R.memo.set(field, memo); }
  const size = Wd * (y1 - y0 + 1);
  // scratch buffers reused across calls (only touched cells are reset); a re-entrant call (from field) allocates its own
  const own = SCR.busy || size > SCR_MAX, S = own ? null : SCR;
  let dist, prev, done, touched = null, tn = 0;
  if (own) { dist = new Float64Array(size).fill(Infinity); prev = new Int32Array(size).fill(-1); done = new Uint8Array(size); }
  else {
    if (SCR.dist.length < size) { const n = Math.max(size, SCR.dist.length * 2); SCR.dist = new Float64Array(n).fill(Infinity); SCR.prev = new Int32Array(n).fill(-1); SCR.done = new Uint8Array(n); SCR.touched = new Int32Array(n); }
    dist = SCR.dist; prev = SCR.prev; done = SCR.done; touched = SCR.touched; SCR.busy = true;
  }
  try {
  // binary heap (same sift rules as before, so pop order incl. ties is unchanged) on growable typed arrays
  let cap = 1024, hd = new Float64Array(cap), hi = new Int32Array(cap), hn = 0;
  const push = (d, i) => {
    if (hn === cap) { cap *= 2; const nd = new Float64Array(cap), ni = new Int32Array(cap); nd.set(hd); ni.set(hi); hd = nd; hi = ni; }
    let k = hn++;
    while (k) { const p = (k - 1) >> 1; if (hd[p] <= d) break; hd[k] = hd[p]; hi[k] = hi[p]; k = p; }
    hd[k] = d; hi[k] = i;
  };
  const fpAt = (x, y) => { const t = at(x, y); return t >= 0 && (F[t] & block) !== 0; };
  const ax = aim[0], ay = aim[1];
  for (const [x, y] of from) { if (x < x0 || y < y0 || x > x1 || y > y1) continue; { const ii = idx(x, y); if (touched && dist[ii] === Infinity) touched[tn++] = ii; dist[ii] = 0; } push(Math.hypot(x - ax, y - ay), idx(x, y)); }
  while (hn) {
    const i = hi[0];
    { const ld = hd[hn - 1], li = hi[hn - 1], n = --hn;
      if (n) { let k = 0;
        for (;;) { const l = 2 * k + 1, r = l + 1; let m = k, mv = ld; if (l < n && hd[l] < mv) { m = l; mv = hd[l]; } if (r < n && hd[r] < mv) m = r; if (m === k) break;
          hd[k] = hd[m]; hi[k] = hi[m]; k = m; }
        hd[k] = ld; hi[k] = li; } }
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
    for (let q = 0; q < 8; q++) {
      const dx = DX[q], dy = DY[q], X = x + dx, Y = y + dy;
      if (X < x0 || Y < y0 || X > x1 || Y > y1) continue;
      const rx = X - Rox, ry = Y - Roy, t = rx < 0 || ry < 0 || rx >= Rw || ry >= Rh ? -1 : ry * Rw + rx;
      if (t >= 0 && (F[t] & block)) continue;
      if (dx && dy && (fpAt(x + dx, y) || fpAt(x, y + dy))) continue;
      let base;
      if (t >= 0 && (F[t] & dear)) base = dearCost;
      else if (t >= 0 && (F[t] & cheap)) base = cheapCost;
      else if (t >= 0) { base = memo[t]; if (base !== base) base = memo[t] = field(X, Y); }
      else base = field(X, Y);
      const c = base * (dx && dy ? diag : 1);
      const j = (Y - y0) * Wd + (X - x0), nd = d + c;
      if (nd < dist[j]) { if (touched && dist[j] === Infinity) touched[tn++] = j; dist[j] = nd; prev[j] = i; push(nd + Math.hypot(X - ax, Y - ay), j); }
    }
  }
  return [];
  } finally { if (S) { for (let k = 0; k < tn; k++) { const c = touched[k]; dist[c] = Infinity; prev[c] = -1; done[c] = 0; } SCR.busy = false; } }
}
