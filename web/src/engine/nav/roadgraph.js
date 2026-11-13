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
  const { ox, oy, w, h } = grid, n = w * h;
  const road = grid.road, occ = grid.occ, cost = grid.cost, eg = grid.edges;
  const at = (x, y) => { const lx = x - ox, ly = y - oy; return lx >= 0 && ly >= 0 && lx < w && ly < h ? ly * w + lx : -1; };
  const tx = i => ox + (i % w), ty = i => oy + ((i / w) | 0);

  // Local, index-based copy of WorldGrid.canStep (same rule: 8-way, both L routes legal for a diagonal, edges checked
  // on both sides, outside = blocked). Coordinates here are grid-local (0..w-1, 0..h-1).
  const free = i => occ[i] === 0 && cost[i] !== 255;
  const orth = (x, y, dx, dy) => {
    const bx = x + dx, by = y + dy;
    if (bx < 0 || by < 0 || bx >= w || by >= h) return false;
    const b = by * w + bx;
    if (!free(b)) return false;
    if (!eg) return true;
    const ea = x >= 0 && y >= 0 && x < w && y < h ? eg[y * w + x] : 0, eb = eg[b];
    if ((ea | eb) === 0) return true;
    if (dx > 0) return !(ea & E_E) && !(eb & E_W);
    if (dx < 0) return !(ea & E_W) && !(eb & E_E);
    if (dy > 0) return !(ea & E_S) && !(eb & E_N);
    return !(ea & E_N) && !(eb & E_S);
  };
  const step = (x, y, dx, dy) => (dx === 0 || dy === 0
    ? orth(x, y, dx, dy)
    : orth(x, y, dx, 0) && orth(x + dx, y, 0, dy) && orth(x, y, 0, dy) && orth(x, y + dy, dx, 0));

  // 1. mask, as a padded image (W = w + 2, a zero border, for bounds-check-free neighbour scans) plus the list of its
  // tiles' padded indices in row-major order (mP)
  const W = w + 2, PN = W * (h + 2), pad = i => i + 2 * ((i / w) | 0) + W + 1;
  const maskP = new Uint8Array(PN), mAll = new Int32Array(n);
  let maskCount = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0, q = (y + 1) * W + 1; x < w; x++, i++, q++) {
      if (road[i] > 0 && occ[i] === 0 && cost[i] !== 255) { maskP[q] = 1; mAll[maskCount++] = q; }
    }
  }
  const mP = mAll.subarray(0, maskCount);
  const unpad = q => q - W - 1 - 2 * (((q / W) | 0) - 1);
  const isMask = i => maskP[pad(i)] === 1;

  // 2. skeleton (padded); every mask component keeps a tile; back to grid indices
  const OFF = [-W, 1, W, -1, -W + 1, W + 1, W - 1, -W - 1];   // D8 order, padded
  const skelP = thin(maskP, mP, W);
  const stack = new Int32Array(Math.max(n, PN));
  keepComponents(maskP, skelP, mP, OFF, stack);
  const skel = new Uint8Array(n);
  let ns = 0;
  for (let k = 0; k < maskCount; k++) if (skelP[mP[k]]) ns++;
  const sk = new Int32Array(ns);
  for (let k = 0, q = 0; k < maskCount; k++) if (skelP[mP[k]]) { const i = unpad(mP[k]); sk[q++] = i; skel[i] = 1; }

  // links as D8 bit sets: orthogonal links, plus a diagonal only when no skeleton tile already joins the two
  // orthogonally (kills the 3-tile triangles thinning leaves at bends); every link is a legal grid step, and links are
  // kept symmetric (canStep is symmetric for free tiles, but be safe).
  const raw8 = new Uint8Array(n);
  for (let q = 0; q < ns; q++) {
    const i = sk[q], p = pad(i);
    const s0 = skelP[p + OFF[0]], s1 = skelP[p + OFF[1]], s2 = skelP[p + OFF[2]], s3 = skelP[p + OFF[3]];
    const cand = s0 | s1 << 1 | s2 << 2 | s3 << 3
      | (skelP[p + OFF[4]] && !s1 && !s0 ? 16 : 0) | (skelP[p + OFF[5]] && !s1 && !s2 ? 32 : 0)
      | (skelP[p + OFF[6]] && !s3 && !s2 ? 64 : 0) | (skelP[p + OFF[7]] && !s3 && !s0 ? 128 : 0);
    if (!cand) continue;
    const x = i % w, y = (i / w) | 0;
    let bits = 0;
    for (let b = cand, k = 0; b; b >>= 1, k++) if (b & 1 && step(x, y, D8X[k], D8Y[k])) bits |= 1 << k;
    raw8[i] = bits;
  }
  const links = new Uint8Array(n);
  const nb = (i, k) => i + D8Y[k] * w + D8X[k];
  for (let q = 0; q < ns; q++) {
    const i = sk[q], r = raw8[i];
    let bits = 0;
    for (let b = r, k = 0; b; b >>= 1, k++) if (b & 1 && (raw8[nb(i, k)] >> OPP8[k]) & 1) bits |= 1 << k;
    links[i] = bits;
  }

  // 3. nodes: kind rank + 1 by tile index (0 = no node)
  const kind = new Uint8Array(n);
  const force = (i, k) => { const r = RANK[k] + 1; if (kind[i] < r) kind[i] = r; };
  const keep = (i, k) => { if (!kind[i]) kind[i] = RANK[k] + 1; };   // force(i, kind(i) || k)
  for (let q = 0; q < ns; q++) {
    const i = sk[q], c = POP8[links[i]];
    if (c >= 3) force(i, 'junction'); else if (c <= 1) force(i, 'end');
  }
  // skeleton components (ascending start tile, so each component's start is its lowest tile); node-less loops get one
  // node at that lowest tile
  const comp = new Int32Array(n).fill(-1);
  let nc = 0;
  for (let q = 0; q < ns; q++) {
    const s0 = sk[q];
    if (comp[s0] >= 0) continue;
    let top = 0, has = false;
    stack[top++] = s0; comp[s0] = nc;
    while (top) {
      const c = stack[--top];
      if (kind[c]) has = true;
      for (let b = links[c], k = 0; b; b >>= 1, k++) if (b & 1) { const j = nb(c, k); if (comp[j] < 0) { comp[j] = nc; stack[top++] = j; } }
    }
    if (!has) force(s0, 'node');
    nc++;
  }

  // BFS scratch shared by the door and bridge searches (generation stamps, no clearing)
  const seen = new Uint32Array(n), prev = new Int32Array(n), queue = stack;
  let gen = 0;

  const nearestSkel = (from) => {   // BFS inside the mask to the nearest skeleton tile; returns tile path from..skel
    if (skel[from]) return [from];
    const g0 = ++gen;
    seen[from] = g0; prev[from] = -1;
    let qh = 0, qt = 0;
    queue[qt++] = from;
    while (qh < qt) {
      const c = queue[qh++], x = c % w, y = (c / w) | 0;
      for (let k = 0; k < 8; k++) {
        const dx = D8X[k], dy = D8Y[k], X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (!isMask(j) || seen[j] === g0 || !step(x, y, dx, dy)) continue;
        seen[j] = g0; prev[j] = c;
        if (skel[j]) { const p = [j]; for (let m = c; m !== -1; m = prev[m]) p.push(m); return p.reverse(); }
        queue[qt++] = j;
      }
    }
    return null;
  };
  // BFS from a door over walkable tiles (legal 8-way steps), up to DOOR_RADIUS steps; first road tile found.
  const nearestRoad = (x0, y0) => {
    const s = at(x0, y0);
    if (s < 0) return -1;
    if (isMask(s)) return s;
    const g0 = ++gen;
    seen[s] = g0;
    let qh = 0, qt = 0;
    queue[qt++] = s;
    for (let d = 1; d <= DOOR_RADIUS && qh < qt; d++) {
      const end = qt;
      for (; qh < end; qh++) {
        const c = queue[qh], x = c % w, y = (c / w) | 0;
        for (let k = 0; k < 8; k++) {
          const dx = D8X[k], dy = D8Y[k], X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const j = Y * w + X;
          if (seen[j] === g0 || !step(x, y, dx, dy)) continue;
          seen[j] = g0;
          if (isMask(j)) return j;
          queue[qt++] = j;
        }
      }
    }
    return -1;
  };

  // plaza centre
  const sq = world.square;
  if (sq && Number.isFinite(sq.x) && sq.w > 0 && sq.h > 0) {
    const cx = sq.x + (sq.w - 1) / 2, cy = sq.y + (sq.h - 1) / 2;
    let best = -1, bd = Infinity;
    for (let q = 0; q < ns; q++) {
      const i = sk[q], x = tx(i), y = ty(i);
      if (x < sq.x || y < sq.y || x >= sq.x + sq.w || y >= sq.y + sq.h) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) force(best, 'plaza');
  }

  // doors
  const doorsAt = new Map(), spurs = [], unreached = [];
  const objs = objectList(world.objects).filter(o => o && o.door && Number.isFinite(o.door.tx) && Number.isFinite(o.door.ty))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const spurDone = new Set();
  for (const o of objs) {
    const r = nearestRoad(o.door.tx, o.door.ty);
    if (r < 0) { unreached.push(o.id); continue; }
    const path = nearestSkel(r);
    if (!path) { unreached.push(o.id); continue; }
    force(r, 'door');
    if (!doorsAt.has(r)) doorsAt.set(r, []);
    doorsAt.get(r).push(o.id);
    const s = path[path.length - 1];
    if (s !== r) { keep(s, 'junction'); if (!spurDone.has(r)) { spurDone.add(r); spurs.push(path); } }
  }

  // bridges between separate skeleton components (union-find over components, ends in tile order: deterministic)
  const bridges = [];
  if (nc > 1) {
    const uf = Int32Array.from({ length: nc }, (_, k) => k);
    const find = k => { while (uf[k] !== k) { uf[k] = uf[uf[k]]; k = uf[k]; } return k; };
    for (let q = 0; q < ns; q++) {
      const i = sk[q];
      if (POP8[links[i]] > 1) continue;
      const home = find(comp[i]);
      // BFS over walkable non-skeleton tiles (legal steps) to the nearest skeleton tile of another component
      const g0 = ++gen;
      seen[i] = g0; prev[i] = -1;
      let qh = 0, qt = 0, hit = -1;
      queue[qt++] = i;
      for (let d = 1; d <= BRIDGE_RADIUS && qh < qt && hit < 0; d++) {
        const end = qt;
        for (; qh < end && hit < 0; qh++) {
          const c = queue[qh], x = c % w, y = (c / w) | 0;
          for (let k = 0; k < 8; k++) {
            const dx = D8X[k], dy = D8Y[k], X = x + dx, Y = y + dy;
            if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
            const j = Y * w + X;
            if (seen[j] === g0 || !step(x, y, dx, dy)) continue;
            if (skel[j]) { if (find(comp[j]) !== home) { prev[j] = c; hit = j; break; } continue; }
            seen[j] = g0; prev[j] = c; queue[qt++] = j;
          }
        }
      }
      if (hit < 0) continue;
      const path = [];
      for (let m = hit; m !== -1; m = prev[m]) path.push(m);
      path.reverse();
      uf[find(comp[hit])] = home;
      keep(i, 'end');
      keep(hit, 'junction');
      bridges.push(path);
    }
  }

  // node ids: row-major tile order
  const order = [];
  for (let q = 0; q < ns; q++) if (kind[sk[q]]) order.push(sk[q]);
  for (const i of doorsAt.keys()) if (!skel[i]) order.push(i);   // door tiles off the skeleton
  order.sort((a, b) => a - b);
  const idOf = new Int32Array(n).fill(-1);
  order.forEach((i, k) => { idOf[i] = k; });
  const nodes = order.map((i, id) => {
    const nd = { id, x: tx(i), y: ty(i), kind: KIND[kind[i] - 1] };
    if (doorsAt.has(i)) nd.doors = doorsAt.get(i);
    return nd;
  });

  // 4. edges: walk skeleton chains between nodes (used: a D8 bit per tile for each link already walked from it)
  const raw = [], used = new Uint8Array(n);
  for (const s of order) {
    if (!skel[s]) continue;   // a door tile off the skeleton: only spur edges
    for (let b = links[s], k = 0; b; b >>= 1, k++) {
      if (!(b & 1) || (used[s] >> k) & 1) continue;
      const first = nb(s, k);
      const path = [s, first];
      let pv = s, cur = first, ok = true;
      while (!kind[cur]) {
        let nx = -1;
        for (let lb = links[cur], m = 0; lb; lb >>= 1, m++) if (lb & 1) { const j = nb(cur, m); if (j !== pv) { nx = j; break; } }
        if (nx < 0) { ok = false; break; }
        pv = cur; cur = nx; path.push(cur);
        if (path.length > n) { ok = false; break; }
      }
      used[s] |= 1 << k;
      if (!ok) continue;
      const back = path[path.length - 2];
      used[cur] |= 1 << DIR8[((back / w | 0) - (cur / w | 0) + 1) * 3 + (back % w) - (cur % w) + 1];
      if (cur === s) continue;   // a loop back to the same node never shortens a route
      raw.push(path);
    }
  }
  for (const p of spurs) raw.push(p);
  for (const p of bridges) raw.push(p);

  const bridgeSet = new Set(bridges);
  const edges = raw.map(p => {
    const bridge = bridgeSet.has(p);
    let a = idOf[p[0]], b = idOf[p[p.length - 1]];
    if (a > b) { p = p.slice().reverse(); [a, b] = [b, a]; }
    let length = 0, cls = ROAD.MAIN;
    for (let k = 1; k < p.length; k++) length += (tx(p[k]) !== tx(p[k - 1]) && ty(p[k]) !== ty(p[k - 1])) ? SQRT2 : 1;
    const inner = p.length > 2 ? p.slice(1, -1) : p;
    for (const i of inner) if (road[i] < cls) cls = road[i];
    if (cls < ROAD.PATH) cls = ROAD.PATH;   // a bridge across off-road tiles counts as a footpath
    const poly = new Float32Array(p.length * 2);
    p.forEach((i, k) => { poly[2 * k] = tx(i) + 0.5; poly[2 * k + 1] = ty(i) + 0.5; });
    const e = { id: 0, a, b, length, cls, cost: length * CLASS_COST[cls], poly };
    if (bridge) e.bridge = true;   // crosses off-road tiles (step 5)
    return e;
  }).sort((e, f) => e.a - f.a || e.b - f.b || e.cost - f.cost || cmpPoly(e.poly, f.poly));
  edges.forEach((e, k) => { e.id = k; });

  const out = nodes.map(() => []);
  for (const e of edges) { out[e.a].push(e.id); out[e.b].push(e.id); }
  const doorNode = new Map();
  for (const nd of nodes) for (const d of nd.doors || []) doorNode.set(d, nd.id);
  const cartOk = nodes.map(nd => out[nd.id].some(eid => edges[eid].cls >= CART_MIN_CLASS));
  const edgeOk = (e, roadsOnly) => !roadsOnly || e.cls >= CART_MIN_CLASS;

  // the graph as flat arrays (CSR) for route(): each node's incident edges in edge-id order, like out[]
  const N = nodes.length, NX = new Float64Array(N), NY = new Float64Array(N), adjAt = new Int32Array(N + 1);
  nodes.forEach((nd, i) => { NX[i] = nd.x; NY[i] = nd.y; adjAt[i + 1] = adjAt[i] + out[i].length; });
  const adjTo = new Int32Array(adjAt[N]), adjCost = new Float64Array(adjAt[N]), adjCart = new Uint8Array(adjAt[N]);
  for (let i = 0; i < N; i++) {
    let k = adjAt[i];
    for (const eid of out[i]) { const e = edges[eid]; adjTo[k] = e.a === i ? e.b : e.a; adjCost[k] = e.cost; adjCart[k++] = e.cls >= CART_MIN_CLASS ? 1 : 0; }
  }
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
    /** node id at a tile, or null */ nodeAt: (x, y) => { const i = at(x, y); return i >= 0 && idOf[i] >= 0 ? idOf[i] : null; },
    /** node id for a door object's id, or null */ doorNode: id => doorNode.get(id) ?? null,
    /** edge ids touching a node */ edgesOf: id => out[id] || [],
  };
}

const RANK = { node: 0, end: 1, junction: 2, plaza: 3, door: 4 };
const KIND = Object.keys(RANK);

function objectList(objects) {
  if (!objects) return [];
  if (Array.isArray(objects)) return objects;
  if (typeof objects.values === 'function') return [...objects.values()];
  return [...objects];
}

function cmpPoly(p, q) {
  if (p.length !== q.length) return p.length - q.length;
  for (let k = 0; k < p.length; k++) if (p[k] !== q[k]) return p[k] - q[k];
  return 0;
}

// Zhang-Suen thinning (parallel sub-iterations, so the result does not depend on scan order) of a padded mask (a
// zero border, so neighbour codes need no bounds checks) whose tiles are listed in mP. Each sub-iteration only re-tests
// pixels whose neighbourhood changed since that sub-iteration last tested them (an unchanged neighbourhood gives the
// same verdict), which yields exactly the textbook result in a fraction of the work. Returns the padded skeleton.
function thin(maskP, mP, W) {
  const img = maskP.slice(), count = mP.length;
  const lists = [mP.slice(), mP.slice()], len = [count, count];
  const inL = [maskP.slice(), maskP.slice()];
  const NB = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1];   // p2..p9
  const cur = new Int32Array(count), del = new Int32Array(count);
  for (let changed = true; changed;) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const L = lists[pass], lut = ZS[pass], mark = inL[pass], m = len[pass];
      cur.set(L.subarray(0, m)); len[pass] = 0;   // take this pass's list; re-queued pixels go into a fresh one
      let nd = 0;
      for (let q = 0; q < m; q++) {
        const p = cur[q];
        mark[p] = 0;
        if (!img[p]) continue;
        const c = img[p - W] | img[p - W + 1] << 1 | img[p + 1] << 2 | img[p + W + 1] << 3
          | img[p + W] << 4 | img[p + W - 1] << 5 | img[p - 1] << 6 | img[p - W - 1] << 7;
        if (lut[c]) del[nd++] = p;
      }
      if (!nd) continue;
      changed = true;
      for (let q = 0; q < nd; q++) img[del[q]] = 0;
      const L0 = lists[0], L1 = lists[1], m0 = inL[0], m1 = inL[1];
      for (let q = 0; q < nd; q++) {
        const p = del[q];
        for (let k = 0; k < 8; k++) {
          const r = p + NB[k];
          if (!img[r]) continue;
          if (!m0[r]) { m0[r] = 1; L0[len[0]++] = r; }
          if (!m1[r]) { m1[r] = 1; L1[len[1]++] = r; }
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
function keepComponents(maskP, skelP, mP, OFF, queue) {
  const seen = new Int32Array(maskP.length);   // the search (1, 2, ...) that reached a tile
  let id = 0;
  for (let k = 0; k < mP.length; k++) {
    const s = mP[k];
    if (skelP[s] || seen[s]) continue;
    let qh = 0, qt = 0, lo = s, kept = false;
    queue[qt++] = s; seen[s] = ++id;
    search: while (qh < qt) {
      const c = queue[qh++];
      for (let d = 0; d < 8; d++) {
        const j = c + OFF[d];
        if (!maskP[j] || seen[j] === id) continue;
        if (skelP[j] || seen[j]) { kept = true; break search; }
        seen[j] = id; queue[qt++] = j;
        if (j < lo) lo = j;
      }
    }
    if (!kept) skelP[lo] = 1;
  }
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
