// Road graph: the coarse level of navigation (design §2.2). Pure, no DOM.
//
// Built once per world version from the grid `road` layer (core/grid.js ROAD classes):
//   1. mask   = road tiles that are walkable (road > 0, not blocked)
//   2. skeleton: Zhang-Suen thinning of the mask, so 2-wide streets and plazas become 1-tile centre lines;
//      a mask component that thins to nothing keeps one tile, so no road region is lost
//   3. nodes  = skeleton junctions (3+ links), ends (0-1 links), the tile nearest each plaza centre (world.square),
//      and every door's nearest road tile (a short spur edge joins it to the skeleton when it is off the centre line)
//   4. edges  = skeleton chains between nodes: tile polylines (every step legal under grid.canStep), Float64
//      lengths (1 per orthogonal step, √2 per diagonal), class = the lowest road class on the chain's interior
//      tiles (endpoints excluded, they sit on junctions), cost = length × CLASS_COST[class]
//   5. bridges: a skeleton end within BRIDGE_RADIUS walkable steps of another, still separate road component gets a
//      short PATH-class edge across the gap (mods such as agentville.base stop block paths a tile short of the ring
//      road; without this the graph falls apart into one island per block)
// Node ids are 0..n-1 in row-major tile order (ty, then tx), so they are stable for the same grid.
//
// Performance: the build runs once per world version, often before the JIT has warmed up, so each step is a small
// module-level function over typed arrays (no per-build closures in hot loops, no string keys, no per-tile temporary
// arrays), and the scratch arrays are shared between steps where their lifetimes do not overlap.
import { ROAD } from '../core/grid.js';

/** Cost per tile of road by class; the minimum (1) keeps the A* heuristic admissible. */
export const CLASS_COST = [Infinity, 1.25, 1.1, 1, 1];
/** Carts (`roadsOnly`) use only edges of this class or bigger. */
export const CART_MIN_CLASS = ROAD.LANE;
/** Doors farther than this many steps from any road get no node (listed in graph.unreached). */
export const DOOR_RADIUS = 12;
/** Gaps of at most this many steps between separate road components are bridged by a PATH edge. */
export const BRIDGE_RADIUS = 3;

const D8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];   // orthogonal first
const D8X = Int8Array.from(D8, d => d[0]), D8Y = Int8Array.from(D8, d => d[1]);
const OPP8 = [2, 3, 0, 1, 6, 7, 4, 5];   // D8 index of the reverse step
const DIR8 = new Int8Array(9).fill(-1);   // (dy + 1) * 3 + (dx + 1) -> D8 index
D8.forEach(([dx, dy], k) => { DIR8[(dy + 1) * 3 + dx + 1] = k; });
const POP8 = Uint8Array.from({ length: 256 }, (_, b) => { let c = 0; for (; b; b &= b - 1) c++; return c; });
const SQRT2 = Math.SQRT2;
const E_N = 1, E_E = 2, E_S = 4, E_W = 8;   // core/grid.js EDGE bits

// node kinds: rank + 1 as stored per tile (0 = no node); a tile's kind only ever rises, except that a 'keep' sets a
// kind only on a tile with none
const KIND = ['node', 'end', 'junction', 'plaza', 'door'];
const K_NODE = 1, K_END = 2, K_JUNCTION = 3, K_PLAZA = 4, K_DOOR = 5;

// Zhang-Suen deletion tables, one per sub-iteration, indexed by the 8-neighbour code p2..p9 (bit 0 = p2 = north,
// clockwise). Same tests as the textbook rule: 2 <= B <= 6, A == 1, and the pass's two products zero.
const ZS = [0, 1].map(pass => Uint8Array.from({ length: 256 }, (_, c) => {
  const p = k => (c >> k) & 1;
  const p2 = p(0), p3 = p(1), p4 = p(2), p5 = p(3), p6 = p(4), p7 = p(5), p8 = p(6), p9 = p(7);
  const B = POP8[c];
  if (B < 2 || B > 6) return 0;
  const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
  let A = 0;
  for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
  if (A !== 1) return 0;
  if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) return 0;
  return 1;
}));

/**
 * @param {{ grid: import('../core/grid.js').WorldGrid, objects?: Iterable|{values(): Iterable}, square?: {x,y,w,h}|null }} world
 * @returns {RoadGraph}
 */
export function buildRoadGraph(world) {
  const grid = world?.grid;
  if (!grid || !grid.road) throw new Error('engine: buildRoadGraph needs a world with a grid');
  const n = grid.w * grid.h;
  const G = new Build(grid);

  // 1. mask, as a padded image (W = w + 2, a zero border, for bounds-check-free neighbour scans) plus the list of its
  // tiles' padded indices in row-major order (mP)
  scanMask(G);
  const mP = G.mAll.subarray(0, G.maskCount);

  // 2. skeleton (padded); every mask component keeps a tile; back to grid indices (sk, ascending; skP padded)
  // one scratch queue/stack for every search below: none holds more than the mask's tiles, or 25x25 for a door search
  G.queue = new Int32Array(G.maskCount + 1024);
  const scratchP = new Uint8Array(G.maskP.length);   // zero; thin() hands it back zeroed, keepComponents() then uses it
  const skelP = thin(G.maskP, mP, G.W, scratchP);
  keepComponents(G.maskP, skelP, mP, G.W, G.queue, scratchP);
  const ns = skeletonTiles(G, mP, skelP);
  const sk = G.sk;
  linkSkeleton(G, skelP);

  // 3. nodes
  const kind = G.kind = new Uint8Array(n);
  markEnds(sk, G.links, kind);
  // the thinning scratch image is done with: it becomes a zeroed per-tile mark (vis) for every search below, each of
  // which clears what it marked; prev needs no clearing (a search writes every entry it reads) and takes over the
  // mask list's buffer, which is done with too
  G.vis = scratchP.fill(0);
  G.prev = G.mAll;
  const nc = markLoops(G);

  // plaza centre
  const sq = world.square;
  if (sq && Number.isFinite(sq.x) && sq.w > 0 && sq.h > 0) {
    const best = plazaTile(G, sq);
    if (best >= 0 && kind[best] < K_PLAZA) kind[best] = K_PLAZA;
  }

  // doors (objects with a door at finite tile coordinates). The result does not depend on the order they come in (a
  // road tile's path to the skeleton is the same whichever door reaches it, kinds only ever rise, and edges are sorted
  // later), except for the order of ids, so each door tile's ids and the unreached ids are sorted by id at the end.
  const doorsAt = new Map(), spurs = [], unreached = [];
  const doors = doorObjects(world.objects);
  for (let k = 0; k < doors.length; k++) {
    const o = doors[k];
    const r = nearestRoad(G, o.door.tx, o.door.ty);
    if (r < 0) { unreached.push(o.id); continue; }
    const list = doorsAt.get(r);
    if (list) { list.push(o.id); continue; }   // a road tile already joined (its path to the skeleton is fixed)
    const path = nearestSkel(G, r);
    if (!path) { unreached.push(o.id); continue; }
    kind[r] = K_DOOR;
    doorsAt.set(r, [o.id]);
    const s = path[path.length - 1];
    if (s !== r) { if (!kind[s]) kind[s] = K_JUNCTION; spurs.push(path); }
  }
  for (const list of doorsAt.values()) if (list.length > 1) list.sort(byId);
  if (unreached.length > 1) unreached.sort(byId);

  // bridges between separate skeleton components
  const bridges = nc > 1 ? bridgeComponents(G, nc) : [];

  // node ids: row-major tile order (skeleton nodes come out of sk already sorted; door tiles off the skeleton join them)
  let N = 0, offSkel = 0;
  for (let q = 0; q < ns; q++) if (kind[sk[q]]) N++;
  for (const i of doorsAt.keys()) if (!G.skel[i]) offSkel++;
  const order = new Int32Array(N + offSkel);
  for (let q = 0, k = 0; q < ns; q++) if (kind[sk[q]]) order[k++] = sk[q];
  if (offSkel) {
    let k = N;
    for (const i of doorsAt.keys()) if (!G.skel[i]) order[k++] = i;
    order.sort();
  }
  N += offSkel;
  const idOf = new Int32Array(n);   // node id + 1 by tile (0 = no node)
  const nodes = makeNodes(G, order, idOf, doorsAt);

  // 4. edges
  const P = walkChains(G, order);
  addPaths(P, spurs, 0);
  addPaths(P, bridges, 1);
  const edges = makeEdges(G, P, idOf, N);

  return makeGraph(grid, nodes, edges, unreached, idOf);
}

// Per-build state shared by the steps below (one shape, so every step's property loads stay monomorphic).
class Build {
  constructor(grid) {
    const w = grid.w, h = grid.h;
    this.ox = grid.ox; this.oy = grid.oy; this.w = w; this.h = h; this.n = w * h; this.W = w + 2;
    this.road = grid.road; this.occ = grid.occ; this.cost = grid.cost; this.eg = grid.edges;
    this.DO = Int32Array.from(D8, d => d[1] * w + d[0]);   // D8 order, grid-local index offsets
    this.maskP = null; this.mAll = null; this.maskCount = 0;
    this.skel = null; this.sk = null; this.skP = null; this.links = null; this.kind = null;
    this.queue = null; this.vis = null; this.prev = null;
  }
}

// Local, index-based copy of WorldGrid.canStep (same rule: 8-way, both L routes legal for a diagonal, edges checked
// on both sides, outside = blocked). Coordinates here are grid-local (0..w-1, 0..h-1).
function orthStep(G, x, y, dx, dy) {
  const w = G.w, h = G.h, bx = x + dx, by = y + dy;
  if (bx < 0 || by < 0 || bx >= w || by >= h) return false;
  const b = by * w + bx;
  if (!(G.occ[b] === 0 && G.cost[b] !== 255)) return false;
  const eg = G.eg;
  if (!eg) return true;
  const ea = x >= 0 && y >= 0 && x < w && y < h ? eg[y * w + x] : 0, eb = eg[b];
  if ((ea | eb) === 0) return true;
  if (dx > 0) return !(ea & E_E) && !(eb & E_W);
  if (dx < 0) return !(ea & E_W) && !(eb & E_E);
  if (dy > 0) return !(ea & E_S) && !(eb & E_N);
  return !(ea & E_N) && !(eb & E_S);
}
function xyStep(G, x, y, dx, dy) {
  return dx === 0 || dy === 0
    ? orthStep(G, x, y, dx, dy)
    : orthStep(G, x, y, dx, 0) && orthStep(G, x + dx, y, 0, dy) && orthStep(G, x, y, 0, dy) && orthStep(G, x, y + dy, dx, 0);
}
// xyStep from tile c in D8 direction k, for a target inside the grid: the common case (no edge bits on the tiles
// involved) without coordinates; anything else goes to xyStep
function stepK(G, c, k) {
  const occ = G.occ, cost = G.cost, eg = G.eg, j = c + G.DO[k];
  if (occ[j] !== 0 || cost[j] === 255) return false;
  if (k < 4) return !eg || (eg[c] | eg[j]) === 0 || xyStep(G, c % G.w, (c / G.w) | 0, D8X[k], D8Y[k]);
  const a = c + D8X[k], b = c + D8Y[k] * G.w;
  if (occ[a] !== 0 || cost[a] === 255 || occ[b] !== 0 || cost[b] === 255) return false;
  return !eg || (eg[c] | eg[a] | eg[b] | eg[j]) === 0 || xyStep(G, c % G.w, (c / G.w) | 0, D8X[k], D8Y[k]);
}

function scanMask(G) {
  const { w, n, W, road, occ, cost } = G;
  const maskP = new Uint8Array(W * (G.h + 2)), mAll = new Int32Array(n);
  let count = 0;
  // most tiles are not road: a Uint8 road layer is skipped four tiles at a time where all four are zero
  const r32 = road instanceof Uint8Array && (road.byteOffset & 3) === 0 ? new Uint32Array(road.buffer, road.byteOffset, n >> 2) : null;
  const n4 = r32 ? r32.length << 2 : 0;
  for (let i = 0, y = 0, rowEnd = w; i < n;) {
    if (i < n4 && (i & 3) === 0 && r32[i >> 2] === 0) { i += 4; continue; }
    if (road[i] > 0 && occ[i] === 0 && cost[i] !== 255) {
      while (i >= rowEnd) { y++; rowEnd += w; }
      const q = i + 2 * y + W + 1;
      maskP[q] = 1; mAll[count++] = q;
    }
    i++;
  }
  G.maskP = maskP; G.mAll = mAll; G.maskCount = count;
}

// Zhang-Suen thinning (parallel sub-iterations, so the result does not depend on scan order) of a padded mask (a
// zero border, so neighbour codes need no bounds checks) whose tiles are listed in mP. Each sub-iteration only re-tests
// pixels whose neighbourhood changed since that sub-iteration last tested them (an unchanged neighbourhood gives the
// same verdict), which yields exactly the textbook result in a fraction of the work. Returns the padded skeleton.
// mark: a zeroed scratch image, zero again on return (every queued pixel is dequeued before the last, idle round ends).
function thin(maskP, mP, W, mark) {
  const img = maskP.slice(), count = mP.length, z0 = ZS[0], z1 = ZS[1];
  // the two sub-iterations' queues (mark: bit 1 = queued in L0, bit 2 = in L1) and a spare buffer a pass swaps in
  let L0 = new Int32Array(count), L1 = new Int32Array(count), spare = new Int32Array(count), n0 = 0, n1 = 0;
  const del = new Int32Array(count);
  const NB = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];   // p2..p9
  // code: each pixel's neighbour code, kept up to date as pixels are deleted (a deleted pixel clears its bit in each
  // neighbour's code once the pass's deletions are applied, the same moment the image changes)
  const code = new Uint8Array(img.length);
  // first queues: only the pixels each sub-iteration would delete as the mask stands (any other pixel keeps its verdict
  // until a neighbour goes, and then it is queued like any other)
  for (let q = 0; q < count; q++) {
    const p = mP[q];
    const c = img[p - W] | img[p - W + 1] << 1 | img[p + 1] << 2 | img[p + W + 1] << 3
      | img[p + W] << 4 | img[p + W - 1] << 5 | img[p - 1] << 6 | img[p - W - 1] << 7;
    code[p] = c;
    if (z0[c]) { L0[n0++] = p; mark[p] = 1; }
    if (z1[c]) { L1[n1++] = p; mark[p] |= 2; }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      // take this pass's queue; pixels re-queued meanwhile go into a fresh one
      let cur, m;
      if (pass === 0) { cur = L0; m = n0; L0 = spare; n0 = 0; } else { cur = L1; m = n1; L1 = spare; n1 = 0; }
      spare = cur;
      const lut = pass === 0 ? z0 : z1, keepBits = pass === 0 ? 2 : 1;
      let nd = 0;
      for (let q = 0; q < m; q++) {
        const p = cur[q];
        mark[p] &= keepBits;
        if (img[p] && lut[code[p]]) del[nd++] = p;
      }
      if (!nd) continue;
      changed = true;
      for (let q = 0; q < nd; q++) img[del[q]] = 0;
      for (let q = 0; q < nd; q++) {
        const p = del[q];
        for (let k = 0; k < 8; k++) {
          const r = p + NB[k];
          if (!img[r]) continue;
          code[r] &= ~(1 << ((k + 4) & 7));   // p is r's neighbour in the opposite direction
          const mk = mark[r];
          if (mk === 3) continue;
          if (!(mk & 1)) L0[n0++] = r;
          if (!(mk & 2)) L1[n1++] = r;
          mark[r] = 3;
        }
      }
    }
  }
  return img;
}

// Every 8-connected mask component keeps at least one skeleton tile (thinning erases 2x2 blobs entirely): its lowest
// tile (padding keeps row-major order). Only components made entirely of thinned-away tiles need it, so a BFS starts
// from each thinned-away tile not yet seen and stops as soon as it meets a skeleton tile or a tile an earlier search
// saw (whose component is known to keep one); a search that runs dry covered a whole skeleton-less component.
function keepComponents(maskP, skelP, mP, W, queue, seen) {
  // seen (zeroed scratch): 2 = reached by the current search, 1 = by an earlier one
  const OFF = [-W, 1, W, -1, -W + 1, W + 1, W - 1, -W - 1];   // D8 order, padded
  for (let k = 0; k < mP.length; k++) {
    const s = mP[k];
    if (skelP[s] || seen[s]) continue;
    let qh = 0, qt = 0, lo = s, kept = false;
    queue[qt++] = s; seen[s] = 2;
    search: while (qh < qt) {
      const c = queue[qh++];
      for (let d = 0; d < 8; d++) {
        const j = c + OFF[d];
        if (!maskP[j] || seen[j] === 2) continue;
        if (skelP[j] || seen[j]) { kept = true; break search; }
        seen[j] = 2; queue[qt++] = j;
        if (j < lo) lo = j;
      }
    }
    for (let m = 0; m < qt; m++) seen[queue[m]] = 1;
    if (!kept) skelP[lo] = 1;
  }
}

// The skeleton's tiles in grid indices (G.sk, ascending), their padded indices (G.skP) and a per-tile flag (G.skel).
function skeletonTiles(G, mP, skelP) {
  const W = G.W, count = mP.length;
  const skel = new Uint8Array(G.n), skAll = new Int32Array(count), skPAll = new Int32Array(count);
  let ns = 0;
  for (let k = 0, y = 0, rowEnd = 2 * W; k < count; k++) {
    const q = mP[k];
    if (!skelP[q]) continue;
    while (q >= rowEnd) { y++; rowEnd += W; }
    const i = q - W - 1 - 2 * y;
    skAll[ns] = i; skPAll[ns++] = q; skel[i] = 1;
  }
  G.skel = skel; G.sk = skAll.subarray(0, ns); G.skP = skPAll.subarray(0, ns);
  return ns;
}

// links as D8 bit sets: orthogonal links, plus a diagonal only when no skeleton tile already joins the two
// orthogonally (kills the 3-tile triangles thinning leaves at bends); every link is a legal grid step, and links are
// kept symmetric: a link needs the step both ways (canStep is symmetric for free tiles, but be safe; the candidates
// already are, and so is stepK's common case, so only an edge-bit case asks for the step back).
function linkSkeleton(G, skelP) {
  const sk = G.sk, skP = G.skP, W = G.W, w = G.w, DO = G.DO, eg = G.eg, occ = G.occ, cost = G.cost;
  const links = new Uint8Array(G.n);
  for (let q = 0; q < sk.length; q++) {
    const i = sk[q], p = skP[q];
    const s0 = skelP[p - W], s1 = skelP[p + 1], s2 = skelP[p + W], s3 = skelP[p - 1];
    const cand = s0 | s1 << 1 | s2 << 2 | s3 << 3
      | (skelP[p - W + 1] && !s1 && !s0 ? 16 : 0) | (skelP[p + W + 1] && !s1 && !s2 ? 32 : 0)
      | (skelP[p + W - 1] && !s3 && !s2 ? 64 : 0) | (skelP[p - W - 1] && !s3 && !s0 ? 128 : 0);
    if (!cand) continue;
    let bits = 0;
    for (let b = cand, k = 0; b; b >>= 1, k++) {
      if (!(b & 1)) continue;
      // both ends are skeleton tiles, so free: the common case needs no edge bits on the tiles involved and, for a
      // diagonal, its two corner tiles free; the rest asks stepK both ways
      const j = i + DO[k];
      let fast = !eg || (eg[i] | eg[j]) === 0;
      if (k >= 4) {
        const a = i + D8X[k], c = i + D8Y[k] * w;
        if (occ[a] !== 0 || cost[a] === 255 || occ[c] !== 0 || cost[c] === 255) continue;
        fast = fast && (!eg || (eg[a] | eg[c]) === 0);
      }
      if (fast || (stepK(G, i, k) && stepK(G, j, OPP8[k]))) bits |= 1 << k;
    }
    links[i] = bits;
  }
  G.links = links;
}

function markEnds(sk, links, kind) {
  for (let q = 0; q < sk.length; q++) {
    const i = sk[q], c = POP8[links[i]];
    if (c >= 3) kind[i] = K_JUNCTION; else if (c <= 1) kind[i] = K_END;
  }
}

// Skeleton components (ascending start tile, so each component's start is its lowest tile); node-less loops get one
// node at that lowest tile. Returns the number of components.
function markLoops(G) {
  const sk = G.sk, links = G.links, kind = G.kind, vis = G.vis, stack = G.queue, DO = G.DO;
  let nc = 0;
  for (let q = 0; q < sk.length; q++) {
    const s0 = sk[q];
    if (vis[s0]) continue;
    nc++;
    let top = 0, has = false;
    stack[top++] = s0; vis[s0] = 1;
    while (top) {
      const c = stack[--top];
      if (kind[c]) has = true;
      for (let b = links[c], k = 0; b; b >>= 1, k++) if (b & 1) { const j = c + DO[k]; if (!vis[j]) { vis[j] = 1; stack[top++] = j; } }
    }
    if (!has && kind[s0] < K_NODE) kind[s0] = K_NODE;
  }
  for (let q = 0; q < sk.length; q++) vis[sk[q]] = 0;
  return nc;
}

// The skeleton tile inside the square nearest its centre (ties: first in row-major order), or -1.
function plazaTile(G, sq) {
  const { ox, oy, w, h, skel } = G;
  const cx = sq.x + (sq.w - 1) / 2, cy = sq.y + (sq.h - 1) / 2;
  let best = -1, bd = Infinity;
  if (Number.isFinite(sq.y) && Number.isFinite(sq.w) && Number.isFinite(sq.h)) {
    // scan only the square's tiles, row-major (the same tiles, in the same order, as a scan of the whole skeleton)
    const x0 = Math.max(Math.ceil(sq.x), ox), x1 = sq.x + sq.w, y0 = Math.max(Math.ceil(sq.y), oy), y1 = sq.y + sq.h;
    for (let y = y0; y < y1 && y < oy + h; y++) {
      for (let x = x0; x < x1 && x < ox + w; x++) {
        const i = (y - oy) * w + (x - ox);
        if (!skel[i]) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
  } else {
    const sk = G.sk;
    for (let q = 0; q < sk.length; q++) {
      const i = sk[q], x = ox + (i % w), y = oy + ((i / w) | 0);
      if (x < sq.x || y < sq.y || x >= sq.x + sq.w || y >= sq.y + sq.h) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}

// The objects with a door at finite tile coordinates, in the order the world lists them.
function doorObjects(objects) {
  const list = [];
  if (!objects) return list;
  if (Array.isArray(objects)) {
    for (let k = 0; k < objects.length; k++) { const o = objects[k]; if (o && o.door && Number.isFinite(o.door.tx) && Number.isFinite(o.door.ty)) list.push(o); }
  } else if (objects instanceof Map && objects.values === Map.prototype.values && objects.forEach === Map.prototype.forEach) {
    objects.forEach(pushDoor, list);   // the same values in the same order, without an iterator result per object
  } else {
    for (const o of typeof objects.values === 'function' ? objects.values() : objects) pushDoor.call(list, o);
  }
  return list;
}
function pushDoor(o) { if (o && o.door && Number.isFinite(o.door.tx) && Number.isFinite(o.door.ty)) this.push(o); }

function byId(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// BFS from a door over walkable tiles (legal 8-way steps), up to DOOR_RADIUS steps; first road tile found, or -1.
function nearestRoad(G, x0, y0) {
  const { w, h, W, maskP, vis, queue } = G;
  const lx = x0 - G.ox, ly = y0 - G.oy;
  if (!(lx >= 0 && ly >= 0 && lx < w && ly < h)) return -1;
  const s = ly * w + lx;
  if (maskP[s + 2 * ((s / w) | 0) + W + 1] === 1) return s;
  vis[s] = 1;
  let qh = 0, qt = 0, hit = -1;
  queue[qt++] = s;
  search: for (let d = 1; d <= DOOR_RADIUS && qh < qt; d++) {
    const end = qt;
    for (; qh < end; qh++) {
      const c = queue[qh], x = c % w, y = (c / w) | 0;
      for (let k = 0; k < 8; k++) {
        const X = x + D8X[k], Y = y + D8Y[k];
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (vis[j] || !stepK(G, c, k)) continue;
        if (maskP[(Y + 1) * W + X + 1] === 1) { hit = j; break search; }
        vis[j] = 1;
        queue[qt++] = j;
      }
    }
  }
  for (let m = 0; m < qt; m++) vis[queue[m]] = 0;
  return hit;
}

// BFS inside the mask to the nearest skeleton tile; returns the tile path from..skel, or null.
function nearestSkel(G, from) {
  const { w, h, W, maskP, skel, vis, prev, queue } = G;
  if (skel[from]) return [from];
  vis[from] = 1; prev[from] = -1;
  let qh = 0, qt = 0, hit = -1;
  queue[qt++] = from;
  search: while (qh < qt) {
    const c = queue[qh++], x = c % w, y = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const X = x + D8X[k], Y = y + D8Y[k];
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      const j = Y * w + X;
      if (maskP[(Y + 1) * W + X + 1] !== 1 || vis[j] || !stepK(G, c, k)) continue;
      vis[j] = 1; prev[j] = c;
      if (skel[j]) { hit = j; break search; }
      queue[qt++] = j;
    }
  }
  for (let m = 0; m < qt; m++) vis[queue[m]] = 0;
  if (hit < 0) return null;
  vis[hit] = 0;
  const p = [hit];
  for (let m = prev[hit]; m !== -1; m = prev[m]) p.push(m);
  return p.reverse();
}

// Bridges between separate skeleton components (union-find over components, ends in tile order: deterministic).
function bridgeComponents(G, nc) {
  const { w, h, sk, links, kind, skel, vis, prev, DO } = G, queue = G.queue;
  // component of every skeleton tile, numbered from 1 in the order markLoops() found them
  const comp = new Int32Array(G.n);
  for (let q = 0, cid = 0; q < sk.length; q++) {
    const s0 = sk[q];
    if (comp[s0]) continue;
    cid++;
    let top = 0;
    queue[top++] = s0; comp[s0] = cid;
    while (top) {
      const c = queue[--top];
      for (let b = links[c], k = 0; b; b >>= 1, k++) if (b & 1) { const j = c + DO[k]; if (!comp[j]) { comp[j] = cid; queue[top++] = j; } }
    }
  }
  const uf = new Int32Array(nc + 1);
  for (let k = 0; k <= nc; k++) uf[k] = k;
  const find = k => { while (uf[k] !== k) { uf[k] = uf[uf[k]]; k = uf[k]; } return k; };
  const bridges = [];
  for (let q = 0; q < sk.length; q++) {
    const i = sk[q];
    if (POP8[links[i]] > 1) continue;
    const home = find(comp[i]);
    // BFS over walkable non-skeleton tiles (legal steps) to the nearest skeleton tile of another component
    vis[i] = 1; prev[i] = -1;
    let qh = 0, qt = 0, hit = -1;
    queue[qt++] = i;
    for (let d = 1; d <= BRIDGE_RADIUS && qh < qt && hit < 0; d++) {
      const end = qt;
      for (; qh < end && hit < 0; qh++) {
        const c = queue[qh], x = c % w, y = (c / w) | 0;
        for (let k = 0; k < 8; k++) {
          const X = x + D8X[k], Y = y + D8Y[k];
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const j = Y * w + X;
          if (vis[j] || !stepK(G, c, k)) continue;
          if (skel[j]) { if (find(comp[j]) !== home) { prev[j] = c; hit = j; break; } continue; }
          vis[j] = 1; prev[j] = c; queue[qt++] = j;
        }
      }
    }
    for (let m = 0; m < qt; m++) vis[queue[m]] = 0;
    if (hit < 0) continue;
    const path = [];
    for (let m = hit; m !== -1; m = prev[m]) path.push(m);
    path.reverse();
    uf[find(comp[hit])] = home;
    if (!kind[i]) kind[i] = K_END;
    if (!kind[hit]) kind[hit] = K_JUNCTION;
    bridges.push(path);
  }
  return bridges;
}

function makeNodes(G, order, idOf, doorsAt) {
  const { ox, oy, w, kind } = G, N = order.length;
  const nodes = new Array(N);
  for (let id = 0; id < N; id++) {
    const i = order[id], kd = kind[i];
    idOf[i] = id + 1;
    const nd = { id, x: ox + (i % w), y: oy + ((i / w) | 0), kind: KIND[kd - 1] };
    if (kd === K_DOOR) nd.doors = doorsAt.get(i);   // a door tile is exactly a tile of kind 'door'
    nodes[id] = nd;
  }
  return nodes;
}

// Raw edge paths, all in one buffer: path r is P.pb[P.pS[r] .. P.pS[r + 1]), P.br[r] = 1 for a bridge.
class Paths {
  constructor(cap) { this.pb = new Int32Array(cap); this.pl = 0; this.pS = new Int32Array(1024); this.br = new Uint8Array(1024); this.R = 0; }
  room(need) {
    if (need > this.pb.length) { const b = new Int32Array(Math.max(need, this.pb.length * 2)); b.set(this.pb.subarray(0, this.pl)); this.pb = b; }
  }
  end(bridge) {   // close the path written since the last end()
    if (this.R + 2 > this.pS.length) {
      const s = new Int32Array(this.pS.length * 2); s.set(this.pS); this.pS = s;
      const b = new Uint8Array(this.br.length * 2); b.set(this.br); this.br = b;
    }
    this.br[this.R++] = bridge; this.pS[this.R] = this.pl;
  }
}

function addPaths(P, paths, bridge) {
  for (const p of paths) {
    P.room(P.pl + p.length);
    const pb = P.pb;
    for (let k = 0; k < p.length; k++) pb[P.pl++] = p[k];
    P.end(bridge);
  }
}

// Walk skeleton chains between nodes (used: a D8 bit per tile for each link already walked from it).
function walkChains(G, order) {
  const { n, w, links, kind, skel, DO } = G;
  const used = G.vis;   // zero: every search cleared its marks
  const P = new Paths(G.sk.length + 4096);
  for (let o = 0; o < order.length; o++) {
    const s = order[o];
    if (!skel[s]) continue;   // a door tile off the skeleton: only spur edges
    for (let b = links[s], k = 0; b; b >>= 1, k++) {
      if (!(b & 1) || (used[s] >> k) & 1) continue;
      const first = s + DO[k], p0 = P.pl;
      P.room(p0 + 2);
      let pb = P.pb, pl = p0;
      pb[pl++] = s; pb[pl++] = first;
      let pv = s, cur = first, ok = true;
      while (!kind[cur]) {
        let nx = -1;
        for (let lb = links[cur], m = 0; lb; lb >>= 1, m++) if (lb & 1) { const j = cur + DO[m]; if (j !== pv) { nx = j; break; } }
        if (nx < 0) { ok = false; break; }
        pv = cur; cur = nx;
        if (pl === pb.length) { P.pl = pl; P.room(pl + 1); pb = P.pb; P.pl = p0; }   // (committed only by end())
        pb[pl++] = cur;
        if (pl - p0 > n) { ok = false; break; }
      }
      used[s] |= 1 << k;
      if (!ok) continue;
      const back = pb[pl - 2];
      used[cur] |= 1 << DIR8[((back / w | 0) - (cur / w | 0) + 1) * 3 + (back % w) - (cur % w) + 1];
      if (cur === s) continue;   // a loop back to the same node never shortens a route
      P.pl = pl;
      P.end(0);
    }
  }
  return P;
}

// Edges from the raw paths: end node ids (a <= b, the path read backwards when its first end has the larger id),
// Float64 length summed in that reading order, class, cost and polyline; sorted by (a, b, cost, poly), ids in order.
function makeEdges(G, P, idOf, N) {
  const { ox, oy, w, road } = G, pb = P.pb, pS = P.pS, R = P.R;
  const EA = new Int32Array(R), EB = new Int32Array(R), EL = new Float64Array(R), EC = new Uint8Array(R), ECost = new Float64Array(R);
  const EP = new Array(R);
  let inRange = true;
  for (let r = 0; r < R; r++) {
    const st = pS[r], en = pS[r + 1], L = en - st;
    let a = idOf[pb[st]] - 1, b = idOf[pb[en - 1]] - 1;
    const fwd = !(a > b);
    if (!fwd) { const t = a; a = b; b = t; }
    const poly = new Float32Array(L * 2);
    let length = 0, cls = ROAD.MAIN;
    const i0 = fwd ? pb[st] : pb[en - 1];
    let px = i0 % w, py = (i0 / w) | 0;
    poly[0] = ox + px + 0.5; poly[1] = oy + py + 0.5;
    for (let k = 1; k < L; k++) {
      const i = fwd ? pb[st + k] : pb[en - 1 - k], x = i % w, y = (i / w) | 0;
      length += (x !== px && y !== py) ? SQRT2 : 1;
      poly[2 * k] = ox + x + 0.5; poly[2 * k + 1] = oy + y + 0.5;
      px = x; py = y;
    }
    const lo = L > 2 ? st + 1 : st, hi = L > 2 ? en - 1 : en;   // interior tiles, or all of a 1-step path
    for (let k = lo; k < hi; k++) { const c = road[pb[k]]; if (c < cls) cls = c; }
    if (cls < ROAD.PATH) cls = ROAD.PATH;   // a bridge across off-road tiles counts as a footpath
    EA[r] = a; EB[r] = b; EL[r] = length; EC[r] = cls; ECost[r] = length * CLASS_COST[cls]; EP[r] = poly;
    if (a < 0 || a >= N) inRange = false;
  }
  // stable sort: a counting sort on a, then each a's (small) run by the rest
  const less = (r, s) => EB[r] - EB[s] || ECost[r] - ECost[s] || cmpPoly(EP[r], EP[s]);
  const rank = new Int32Array(R);
  if (inRange) {
    const at = new Int32Array(N + 1);
    for (let r = 0; r < R; r++) at[EA[r] + 1]++;
    for (let k = 0; k < N; k++) at[k + 1] += at[k];
    const fill = at.slice(0, N);
    for (let r = 0; r < R; r++) rank[fill[EA[r]]++] = r;
    for (let k = 0; k < N; k++) {
      const lo = at[k], hi = at[k + 1];
      if (hi - lo < 2) continue;
      if (hi - lo <= 32) {
        for (let u = lo + 1; u < hi; u++) {   // insertion sort (stable)
          const v = rank[u];
          let t = u - 1;
          while (t >= lo && less(rank[t], v) > 0) { rank[t + 1] = rank[t]; t--; }
          rank[t + 1] = v;
        }
      } else rank.set(Array.from(rank.subarray(lo, hi)).sort(less), lo);
    }
  } else {
    rank.set(Array.from({ length: R }, (_, r) => r).sort((r, s) => EA[r] - EA[s] || less(r, s)));
  }
  const edges = new Array(R), br = P.br;
  for (let k = 0; k < R; k++) {
    const r = rank[k];
    const e = { id: k, a: EA[r], b: EB[r], length: EL[r], cls: EC[r], cost: ECost[r], poly: EP[r] };
    if (br[r]) e.bridge = true;   // crosses off-road tiles (step 5)
    edges[k] = e;
  }
  return edges;
}

function cmpPoly(p, q) {
  if (p.length !== q.length) return p.length - q.length;
  for (let k = 0; k < p.length; k++) if (p[k] !== q[k]) return p[k] - q[k];
  return 0;
}

// The graph object and its queries. Kept apart from the build so that its closures hold only what they use.
function makeGraph(grid, nodes, edges, unreached, idOf) {
  const { ox, oy, w, h } = grid, N = nodes.length, R = edges.length;
  // the graph as flat arrays (CSR) for route(): each node's incident edges in edge-id order; out[] holds the same ids
  const adjAt = new Int32Array(N + 1);
  for (let k = 0; k < R; k++) { adjAt[edges[k].a + 1]++; adjAt[edges[k].b + 1]++; }
  for (let i = 0; i < N; i++) adjAt[i + 1] += adjAt[i];
  const M = adjAt[N], fill = adjAt.slice(0, N);
  const adjTo = new Int32Array(M), adjCost = new Float64Array(M), adjCart = new Uint8Array(M), adjEdge = new Int32Array(M);
  for (let k = 0; k < R; k++) {
    const e = edges[k], a = e.a, b = e.b, c = e.cost, cart = e.cls >= CART_MIN_CLASS ? 1 : 0;
    let t = fill[a]++;
    adjEdge[t] = k; adjTo[t] = b; adjCost[t] = c; adjCart[t] = cart;
    t = fill[b]++;
    adjEdge[t] = k; adjTo[t] = a === b ? b : a; adjCost[t] = c; adjCart[t] = cart;
  }
  const out = new Array(N), cartOk = new Uint8Array(N), NX = new Float64Array(N), NY = new Float64Array(N);
  const doorNode = new Map();
  for (let i = 0; i < N; i++) {
    const list = [];
    for (let t = adjAt[i], end = adjAt[i + 1]; t < end; t++) { list.push(adjEdge[t]); if (adjCart[t]) cartOk[i] = 1; }
    out[i] = list;
    const nd = nodes[i];
    NX[i] = nd.x; NY[i] = nd.y;
    if (nd.doors) for (const d of nd.doors) doorNode.set(d, i);
  }
  const edgeOk = (e, roadsOnly) => !roadsOnly || e.cls >= CART_MIN_CLASS;
  const at = (x, y) => { const lx = x - ox, ly = y - oy; return lx >= 0 && ly >= 0 && lx < w && ly < h ? ly * w + lx : -1; };

  const S = { gen: 0, g: new Float64Array(N), prev: new Int32Array(N), seen: new Uint32Array(N), closed: new Uint32Array(N), heap: new Heap(N) };
  /** A* over the graph (Float64 costs, binary heap). @returns {number[]|null} node ids from..to */
  function route(from, to, { roadsOnly = false } = {}) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= N || to >= N) return null;
    if (from === to) return [from];
    // scratch reused across calls (generation stamps instead of clearing): no per-call O(N) allocation
    if (++S.gen === 0xffffffff) { S.seen.fill(0); S.closed.fill(0); S.gen = 1; }
    const gen = S.gen, g = S.g, prev = S.prev, seen = S.seen, closed = S.closed, heap = S.heap;
    heap.size = 0;
    const Tx = NX[to], Ty = NY[to];
    g[from] = 0; prev[from] = -1; seen[from] = gen; heap.push(from, Math.hypot(NX[from] - Tx, NY[from] - Ty));
    let found = false;
    while (heap.size) {
      const c = heap.pop();
      if (closed[c] === gen) continue;
      if (c === to) { found = true; break; }
      closed[c] = gen;
      const gc = g[c];
      for (let k = adjAt[c], end = adjAt[c + 1]; k < end; k++) {
        if (roadsOnly && !adjCart[k]) continue;
        const o = adjTo[k];
        if (closed[o] === gen) continue;
        const d = gc + adjCost[k];
        if (seen[o] !== gen || d < g[o]) { seen[o] = gen; g[o] = d; prev[o] = c; heap.push(o, d + Math.hypot(NX[o] - Tx, NY[o] - Ty)); }
      }
    }
    if (!found) return null;
    const ids = [];
    for (let k = to; k !== -1; k = prev[k]) ids.push(k);
    return ids.reverse();
  }

  /** Tile-centre polyline (x,y pairs) of a route, cheapest eligible edge between each pair of nodes. */
  function polyline(ids, { roadsOnly = false } = {}) {
    if (!ids || !ids.length) return new Float32Array(0);
    const pts = [nodes[ids[0]].x + 0.5, nodes[ids[0]].y + 0.5];
    for (let k = 1; k < ids.length; k++) {
      const a = ids[k - 1], b = ids[k];
      let best = null;
      for (const eid of out[a]) {
        const e = edges[eid];
        if (!edgeOk(e, roadsOnly) || !((e.a === a && e.b === b) || (e.a === b && e.b === a))) continue;
        if (!best || e.cost < best.cost) best = e;
      }
      if (!best) return null;
      const p = best.poly, m = p.length / 2, fwd = best.a === a;
      for (let q = 1; q < m; q++) { const j = fwd ? q : m - 1 - q; pts.push(p[2 * j], p[2 * j + 1]); }
    }
    return Float32Array.from(pts);
  }

  /** Nearest node by straight-line distance (ties: lower id); roadsOnly: only nodes on a cart road. */
  function nearestNode(x, y, { roadsOnly = false } = {}) {
    let best = null, bd = Infinity;
    for (const nd of nodes) {
      if (roadsOnly && !cartOk[nd.id]) continue;
      const d = (nd.x - x) ** 2 + (nd.y - y) ** 2;
      if (d < bd) { bd = d; best = nd.id; }
    }
    return best;
  }

  return {
    version: grid.version, nodes, edges, unreached,
    nearestNode, route, polyline,
    /** node id at a tile, or null */ nodeAt: (x, y) => { const i = at(x, y); return i >= 0 && idOf[i] > 0 ? idOf[i] - 1 : null; },
    /** node id for a door object's id, or null */ doorNode: id => doorNode.get(id) ?? null,
    /** edge ids touching a node */ edgesOf: id => out[id] || [],
  };
}

// Binary min-heap of (id, priority) over typed arrays; duplicates allowed (lazy deletion by the caller).
class Heap {
  constructor(cap) { this.ids = new Int32Array(Math.max(16, cap * 2)); this.pri = new Float64Array(this.ids.length); this.size = 0; }
  push(id, p) {
    if (this.size === this.ids.length) { const i2 = new Int32Array(this.size * 2), p2 = new Float64Array(this.size * 2); i2.set(this.ids); p2.set(this.pri); this.ids = i2; this.pri = p2; }
    let k = this.size++;
    const { ids, pri } = this;
    while (k > 0) { const q = (k - 1) >> 1; if (pri[q] <= p) break; ids[k] = ids[q]; pri[k] = pri[q]; k = q; }
    ids[k] = id; pri[k] = p;
  }
  pop() {
    const { ids, pri } = this, top = ids[0], n = --this.size;
    if (n > 0) {
      const id = ids[n], p = pri[n];
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        if (l >= n) break;
        const m = l + 1 < n && pri[l + 1] < pri[l] ? l + 1 : l;
        if (pri[m] >= p) break;
        ids[k] = ids[m]; pri[k] = pri[m]; k = m;
      }
      ids[k] = id; pri[k] = p;
    }
    return top;
  }
}
