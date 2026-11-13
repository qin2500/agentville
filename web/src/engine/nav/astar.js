// Local grid A* (design §2.2, §2.5). OWNER: N1. Pure, no DOM.
//
// astar(grid, from, to, { maxNodes = 20000, costFn }) -> Float32Array | null
//   grid      a WorldGrid (core/grid.js) with a baked `cost` layer (bakeCost/makeCostFn). Tile i is blocked when
//             cost[i] == 255 or occ[i] != 0 (WorldGrid.isBlocked); `edges` bits block single tile sides.
//   from, to  { x, y } in float tiles (world positions); the tile is floor(x), floor(y).
//   maxNodes  cap on expanded nodes; exceeding it returns null.
//   costFn    optional override (tx, ty, base) -> number, where base is the baked cost of tile (tx, ty). A result
//             >= 255 or not finite blocks the tile (e.g. cart-reserved cells return base * 4).
// Moves: 8-way. A diagonal is legal only when both L-shaped orthogonal routes are legal (WorldGrid.canStep), so it
// never cuts a corner past a blocked tile or edge. Entering a tile costs its cost (min 1) x 1 or x SQRT2.
// Heuristic: octile distance (admissible since every step costs >= 1). Distances are Float64 (2026-10-22 bug).
// Result: tile-centre x,y pairs (tx + .5, ty + .5) from the start tile to the goal tile, with the interior points of
// straight runs (same step direction) removed. Each kept segment is a straight run of path steps, so it never
// crosses a blocked tile. from and to in the same tile -> one point. Goal blocked/outside -> null. The start tile
// itself is not checked (an actor standing on a blocked tile can still walk off it).
// Open list: binary heap over one interleaved Float64Array, lazy deletion; a costFn is memoised per tile per call. Scratch buffers are sized to the grid and reused per grid
// (generation stamps, no clearing between calls).
import { COST_BLOCKED, EDGE } from '../core/grid.js';

const SQRT2 = Math.SQRT2, OCT = SQRT2 - 2;
const E_N = EDGE.N, E_E = EDGE.E, E_S = EDGE.S, E_W = EDGE.W;

const scratchByGrid = new WeakMap();

function scratchFor(grid) {
  const n = grid.w * grid.h;
  let s = scratchByGrid.get(grid);
  if (s && s.n === n) return s;
  s = {
    n,
    gen: 0,
    // per tile, interleaved (stamp, g): stamp == 2*gen: open this call (g/parent valid), 2*gen+1: expanded
    rec: new Float64Array(2 * n),
    parent: new Int32Array(n),
    tcGen: null, tc: null,          // costFn calls memoised per call (allocated on first costFn use)
    // binary heap entries interleaved as (f, h, node) triples: one cache line per entry instead of three
    heap: new Float64Array(3 * 1024),
  };
  scratchByGrid.set(grid, s);
  return s;
}

/** @returns {Float32Array|null} */
export function astar(grid, from, to, opts = {}) {
  const maxNodes = opts.maxNodes ?? 20000, costFn = opts.costFn;
  const { w, h, ox, oy, cost, occ, edges } = grid;
  const fx = Math.floor(from.x) - ox, fy = Math.floor(from.y) - oy;
  const gx = Math.floor(to.x) - ox, gy = Math.floor(to.y) - oy;
  if (!(fx >= 0 && fy >= 0 && fx < w && fy < h && gx >= 0 && gy >= 0 && gx < w && gy < h)) return null;
  const start = fy * w + fx, goal = gy * w + gx;
  if (start === goal) return new Float32Array([fx + ox + 0.5, fy + oy + 0.5]);

  const s = scratchFor(grid);
  if (++s.gen >= 0x7fffffff) { s.rec.fill(0); if (s.tcGen) s.tcGen.fill(0); s.gen = 1; }
  const gen = s.gen, OPEN = 2 * gen, CLOSED = OPEN + 1, rec = s.rec, parent = s.parent;

  // tile step cost (>= 1), or 0 when blocked. A costFn is called at most once per tile per search.
  let tileCost;
  if (costFn) {
    if (!s.tcGen) { s.tcGen = new Uint32Array(s.n); s.tc = new Float64Array(s.n); }
    const tcGen = s.tcGen, tc = s.tc;
    tileCost = i => {
      if (tcGen[i] === gen) return tc[i];
      let v = 0;
      if (occ[i] === 0) {
        const b = cost[i];
        if (b !== COST_BLOCKED) {
          const c = costFn((i % w) + ox, ((i / w) | 0) + oy, b);
          v = c >= COST_BLOCKED || !(c < Infinity) ? 0 : c < 1 ? 1 : c;
        }
      }
      tcGen[i] = gen; tc[i] = v;
      return v;
    };
  } else {
    tileCost = i => {
      const b = cost[i];
      return occ[i] !== 0 || b === COST_BLOCKED ? 0 : b < 1 ? 1 : b;
    };
  }
  if (tileCost(goal) === 0) return null;

  let H = s.heap, size = 0;
  const push = (node, f, hv) => {
    if (3 * size === H.length) { const b = new Float64Array(H.length * 2); b.set(H); s.heap = H = b; }
    let k = size++;
    while (k > 0) {
      const p = (k - 1) >> 1, pf = H[3 * p];
      if (pf < f || (pf === f && H[3 * p + 1] <= hv)) break;
      H[3 * k] = pf; H[3 * k + 1] = H[3 * p + 1]; H[3 * k + 2] = H[3 * p + 2]; k = p;
    }
    H[3 * k] = f; H[3 * k + 1] = hv; H[3 * k + 2] = node;
  };
  const pop = () => {
    const top = H[2];
    const n = --size, lf = H[3 * n], lh = H[3 * n + 1], ln = H[3 * n + 2];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= n) break;
      const r = c + 1;
      let cf = H[3 * c];
      if (r < n) { const rf = H[3 * r]; if (rf < cf || (rf === cf && H[3 * r + 1] < H[3 * c + 1])) { c = r; cf = rf; } }
      if (lf < cf || (lf === cf && lh <= H[3 * c + 1])) break;
      H[3 * k] = cf; H[3 * k + 1] = H[3 * c + 1]; H[3 * k + 2] = H[3 * c + 2]; k = c;
    }
    H[3 * k] = lf; H[3 * k + 1] = lh; H[3 * k + 2] = ln;
    return top;
  };

  const hOf = (x, y) => {
    const ax = x > gx ? x - gx : gx - x, ay = y > gy ? y - gy : gy - y;
    return ax > ay ? ax + OCT * ay + ay : ay + OCT * ax + ax;   // max + (SQRT2 - 1) * min
  };
  // relax neighbour ni = (nx, ny) of cur at step cost `step` (> 0)
  let cur = -1, cg = 0;
  const relax = (ni, nx, ny, step) => {
    const st = rec[2 * ni];
    if (st === CLOSED) return;
    const ng = cg + step;
    if (st === OPEN && ng >= rec[2 * ni + 1]) return;
    rec[2 * ni] = OPEN; rec[2 * ni + 1] = ng; parent[ni] = cur;
    const hv = hOf(nx, ny);
    push(ni, ng + hv, hv);
  };

  rec[2 * start] = OPEN; rec[2 * start + 1] = 0; parent[start] = -1;
  push(start, hOf(fx, fy), hOf(fx, fy));
  let expanded = 0, found = false;
  while (size > 0) {
    cur = pop();
    if (rec[2 * cur] === CLOSED) continue;   // stale duplicate
    if (cur === goal) { found = true; break; }
    rec[2 * cur] = CLOSED;
    if (++expanded > maxNodes) return null;
    const cx = cur % w, cy = (cur / w) | 0, ec = edges[cur];
    const iE = cur + 1, iW = cur - 1, iS = cur + w, iN = cur - w;
    cg = rec[2 * cur + 1];
    // orthogonal steps (step cost, 0 = illegal): the target is inside and free, the crossed edge open on both sides
    const cE = cx + 1 < w && !(ec & E_E) && !(edges[iE] & E_W) ? tileCost(iE) : 0;
    const cW = cx > 0 && !(ec & E_W) && !(edges[iW] & E_E) ? tileCost(iW) : 0;
    const cS = cy + 1 < h && !(ec & E_S) && !(edges[iS] & E_N) ? tileCost(iS) : 0;
    const cN = cy > 0 && !(ec & E_N) && !(edges[iN] & E_S) ? tileCost(iN) : 0;
    // neighbour order E, W, S, N, SE, SW, NE, NW; a diagonal needs both L routes legal: (x then y) and (y then x)
    if (cE) relax(iE, cx + 1, cy, cE);
    if (cW) relax(iW, cx - 1, cy, cW);
    if (cS) relax(iS, cx, cy + 1, cS);
    if (cN) relax(iN, cx, cy - 1, cN);
    if (cS) {
      if (cE) {
        const d = iS + 1, ed = edges[d];
        if (!(edges[iE] & E_S) && !(ed & E_N) && !(edges[iS] & E_E) && !(ed & E_W)) { const c = tileCost(d); if (c) relax(d, cx + 1, cy + 1, c * SQRT2); }
      }
      if (cW) {
        const d = iS - 1, ed = edges[d];
        if (!(edges[iW] & E_S) && !(ed & E_N) && !(edges[iS] & E_W) && !(ed & E_E)) { const c = tileCost(d); if (c) relax(d, cx - 1, cy + 1, c * SQRT2); }
      }
    }
    if (cN) {
      if (cE) {
        const d = iN + 1, ed = edges[d];
        if (!(edges[iE] & E_N) && !(ed & E_S) && !(edges[iN] & E_E) && !(ed & E_W)) { const c = tileCost(d); if (c) relax(d, cx + 1, cy - 1, c * SQRT2); }
      }
      if (cW) {
        const d = iN - 1, ed = edges[d];
        if (!(edges[iW] & E_N) && !(ed & E_S) && !(edges[iN] & E_W) && !(ed & E_E)) { const c = tileCost(d); if (c) relax(d, cx - 1, cy - 1, c * SQRT2); }
      }
    }
  }
  if (!found) return null;

  // walk back, keeping only turning points (and the two ends)
  const pts = [];
  let node = goal, prevDir = -999;
  while (node !== -1) {
    const p = parent[node];
    // direction code from (dx, dy) in -1..1, not the index delta (which aliases on grids 2 tiles wide)
    const dir = p === -1 ? -998 : ((node % w) - (p % w) + 1) * 3 + (((node / w) | 0) - ((p / w) | 0) + 1);
    if (dir !== prevDir) pts.push(node);
    prevDir = dir;
    node = p;
  }
  // pts runs goal -> start; emit start -> goal
  const out = new Float32Array(pts.length * 2);
  for (let k = 0, j = pts.length - 1; j >= 0; j--, k += 2) {
    const i = pts[j];
    out[k] = (i % w) + ox + 0.5; out[k + 1] = ((i / w) | 0) + oy + 0.5;
  }
  return out;
}
