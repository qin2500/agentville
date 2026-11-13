// Flow fields for crowds going to one shared destination (design §2.2, budgets §2.5). OWNER: N3. Pure, no DOM.
//
// flowField(grid, targets, { maxCost }) runs one multi-source Dijkstra outward from the targets over the WorldGrid
// `cost` layer. Walkers then read the field in O(1) per step: dirAt(x, y) is the next step, costAt(x, y) the cost left.
//
// Cost model (integers, the same units everywhere):
//   a step INTO tile b costs STEP * cost[b], STEP = 10 orthogonal, 14 diagonal (tile cost < 1 counts as 1).
//   costAt(target) = 0; costAt(t) = the cheapest walk cost from t to the nearest target.
// Moves follow WorldGrid.canStep: 8-way, a tile is free when occ == 0 and cost < 255, edges (fences) block the crossed
// side, and a diagonal is legal only when both L-shaped orthogonal routes are legal (no corner cutting).
// The search is bounded: tiles whose cost would exceed `maxCost` are never settled (costAt Infinity). With a finite
// maxCost the typed arrays only cover the targets' bounding box grown by floor(maxCost / 10) tiles.
// Fields are snapshots: `version` is grid.version at build time and `stale()` tells when the grid has changed.

export const STEP_ORTHO = 10, STEP_DIAG = 14;
const BLOCKED = 255;
const INF = 0x7fffffff;
const E = 2, N = 1, S = 4, W = 8;   // EDGE bits (core/grid.js)

// Neighbour order is the deterministic tie-break: orthogonals N, E, S, W, then diagonals NE, SE, SW, NW.
const NDX = Int8Array.of(0, 1, 0, -1, 1, 1, -1, -1);
const NDY = Int8Array.of(-1, 0, 1, 0, -1, 1, 1, -1);
const NSTEP = Int32Array.of(10, 10, 10, 10, 14, 14, 14, 14);
const DIRS = Array.from({ length: 8 }, (_, k) => Object.freeze({ dx: NDX[k], dy: NDY[k] }));
const HERE = Object.freeze({ dx: 0, dy: 0 });
const D_UNSET = 0, D_NONE = 9, D_HERE = 10;   // dir cache codes; 1..8 = DIRS[code - 1]

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

/**
 * @param {import('../core/grid.js').WorldGrid} grid
 * @param {{x:number,y:number}[]} targets tile coords (floats are floored); targets outside the grid or blocked are ignored
 * @param {{ maxCost?: number }} [opts] maxCost in cost units (10 per orthogonal step on a cost-1 tile); default unbounded
 * @returns {{ dirAt(x:number,y:number): {dx:number,dy:number}|null, costAt(x:number,y:number): number,
 *   version: number, stale(): boolean, reached: number, buildMs: number, region: {ox:number,oy:number,w:number,h:number} }}
 *   dirAt: null when the tile is outside the field, blocked or unreachable; {dx:0,dy:0} on a target; otherwise the
 *   step (frozen, shared object) to the neighbour with the lowest cost-to-go through it (cost of the step + costAt of the
 *   neighbour), ties broken by the lower costAt of the neighbour and then by the fixed order N,E,S,W,NE,SE,SW,NW.
 *   Following dirAt always lands on a tile with a strictly lower costAt, so it reaches a target.
 *   costAt: Infinity outside the field or when unreachable; 0 on a target.
 */
export function flowField(grid, targets, opts = {}) {
  const t0 = now();
  if (!grid || !grid.cost || !Number.isInteger(grid.w)) throw new Error('engine: flowField needs a WorldGrid');
  const maxCost = opts.maxCost == null ? Infinity : Number(opts.maxCost);
  if (!(maxCost >= 0)) throw new Error('engine: flowField maxCost must be a number >= 0');
  const GW = grid.w, GH = grid.h, gox = grid.ox, goy = grid.oy;
  const { cost, occ, edges } = grid;

  // Valid targets in grid-local coordinates.
  const tl = [];
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const t of targets || []) {
    if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
    const x = Math.floor(t.x) - gox, y = Math.floor(t.y) - goy;
    if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
    const i = y * GW + x;
    if (occ[i] !== 0 || cost[i] >= BLOCKED) continue;
    tl.push(x, y);
    if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y;
  }

  // Region (grid-local): the whole grid, or the targets' bbox grown by the farthest reachable tile distance.
  let rx0 = 0, ry0 = 0, rx1 = GW, ry1 = GH;
  if (!tl.length) { rx0 = ry0 = rx1 = ry1 = 0; }
  else if (Number.isFinite(maxCost)) {
    const R = Math.floor(maxCost / STEP_ORTHO);
    rx0 = Math.max(0, bx0 - R); ry0 = Math.max(0, by0 - R);
    rx1 = Math.min(GW, bx1 + R + 1); ry1 = Math.min(GH, by1 + R + 1);
  }
  const RW = rx1 - rx0, RH = ry1 - ry0, n = RW * RH;
  const dist = new Int32Array(n).fill(INF);
  const dirc = new Uint8Array(n);
  const limit = Number.isFinite(maxCost) ? Math.min(maxCost, INF - 1) : INF - 1;

  // Is the orthogonal step from grid-local (ax, ay) by (dx, dy) legal? Same rule as WorldGrid.canStep.
  const freeAt = (x, y) => {
    if (x < 0 || y < 0 || x >= GW || y >= GH) return false;
    const i = y * GW + x;
    return occ[i] === 0 && cost[i] < BLOCKED;
  };
  const ortho = (ax, ay, dx, dy) => {
    const bx = ax + dx, by = ay + dy;
    if (!freeAt(bx, by)) return false;
    const out = dx > 0 ? E : dx < 0 ? W : dy > 0 ? S : N;
    const back = dx > 0 ? W : dx < 0 ? E : dy > 0 ? N : S;
    if (ax >= 0 && ay >= 0 && ax < GW && ay < GH && (edges[ay * GW + ax] & out)) return false;
    return (edges[by * GW + bx] & back) === 0;
  };
  // Walker step a -> a + (dx, dy) (canStep semantics: the start tile is not checked).
  const canStep = (ax, ay, dx, dy) => (dx === 0 || dy === 0)
    ? ortho(ax, ay, dx, dy)
    : ortho(ax, ay, dx, 0) && ortho(ax + dx, ay, 0, dy) && ortho(ax, ay, 0, dy) && ortho(ax, ay + dy, dx, 0);

  // Binary min-heap of (key, local index) with lazy deletion, on growable typed arrays.
  let hk = new Int32Array(1024), hv = new Int32Array(1024), hn = 0;
  const push = (k, v) => {
    if (hn === hk.length) { const a = new Int32Array(hn * 2), b = new Int32Array(hn * 2); a.set(hk); b.set(hv); hk = a; hv = b; }
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] < k || (hk[p] === k && hv[p] <= v)) break;   // index tie-break keeps the order deterministic
      hk[i] = hk[p]; hv[i] = hv[p]; i = p;
    }
    hk[i] = k; hv[i] = v;
  };
  const pop = () => {   // returns the value; key is left in popKey
    const v = hv[0]; popKey = hk[0];
    const k = hk[--hn], x = hv[hn];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= hn) break;
      if (c + 1 < hn && (hk[c + 1] < hk[c] || (hk[c + 1] === hk[c] && hv[c + 1] < hv[c]))) c++;
      if (k < hk[c] || (k === hk[c] && x <= hv[c])) break;
      hk[i] = hk[c]; hv[i] = hv[c]; i = c;
    }
    hk[i] = k; hv[i] = x;
    return v;
  };
  let popKey = 0;

  for (let j = 0; j < tl.length; j += 2) {
    const li = (tl[j + 1] - ry0) * RW + (tl[j] - rx0);
    if (dist[li] !== 0) { dist[li] = 0; push(0, li); }
  }

  let reached = 0;
  while (hn > 0) {
    const li = pop(), d = popKey;
    if (d !== dist[li]) continue;   // stale entry
    reached++;
    const lx = li % RW, ly = (li - lx) / RW, cx = lx + rx0, cy = ly + ry0;
    const enter = Math.max(1, cost[cy * GW + cx]);   // what a walker pays to step into (cx, cy)
    for (let k = 0; k < 8; k++) {
      // Neighbour m = c - dir; the walker's step is m -> c, i.e. (dx, dy) = dir.
      const mx = cx - NDX[k], my = cy - NDY[k];
      if (mx < rx0 || my < ry0 || mx >= rx1 || my >= ry1) continue;
      const mi = (my - ry0) * RW + (mx - rx0);
      const nd = d + NSTEP[k] * enter;
      if (nd >= dist[mi] || nd > limit) continue;
      if (!freeAt(mx, my) || !canStep(mx, my, NDX[k], NDY[k])) continue;
      dist[mi] = nd; push(nd, mi);
    }
  }

  const version = grid.version;
  const local = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const lx = Math.floor(x) - gox - rx0, ly = Math.floor(y) - goy - ry0;
    return lx >= 0 && ly >= 0 && lx < RW && ly < RH ? ly * RW + lx : -1;
  };
  const costAt = (x, y) => {
    const i = local(x, y);
    return i < 0 || dist[i] === INF ? Infinity : dist[i];
  };
  const dirAt = (x, y) => {
    const i = local(x, y);
    if (i < 0) return null;
    let c = dirc[i];
    if (c === D_UNSET) {
      const d = dist[i];
      if (d === INF) c = D_NONE;
      else if (d === 0) c = D_HERE;
      else {
        const lx = i % RW, ly = (i - lx) / RW, ax = lx + rx0, ay = ly + ry0;
        let best = INF, bestN = INF; c = D_NONE;
        for (let k = 0; k < 8; k++) {
          const bx = ax + NDX[k], by = ay + NDY[k];
          if (bx < rx0 || by < ry0 || bx >= rx1 || by >= ry1) continue;
          const nd = dist[(by - ry0) * RW + (bx - rx0)];
          if (nd === INF || nd >= d) continue;
          const tot = nd + NSTEP[k] * Math.max(1, cost[by * GW + bx]);
          if (tot > best || (tot === best && nd >= bestN)) continue;
          if (!canStep(ax, ay, NDX[k], NDY[k])) continue;
          best = tot; bestN = nd; c = k + 1;
        }
      }
      dirc[i] = c;
    }
    return c === D_HERE ? HERE : c === D_NONE ? null : DIRS[c - 1];
  };

  return {
    dirAt, costAt, version, reached,
    stale: () => grid.version !== version,
    region: { ox: rx0 + gox, oy: ry0 + goy, w: RW, h: RH },
    buildMs: now() - t0,
  };
}
