// TEST ONLY: the classic string-keyed fantasy layout (world.js route / buildRoads / dockSite / buildLand / dockShore and
// the classic draw rule), kept verbatim from the engine's old world/sites.js as the parity reference for the raster
// layout in mods/agentville.fantasy/layout/. OWNER: MOD-READY P1. Slow (string Sets): fixtures only.
//
//   referenceLayout(input, { paths }?) → LayoutResult   the same contract and the same tiles rect as the fantasy hook
//   geoSlow(settlements, square, walk: Set<number>) → W  the classic world record (string Sets: path, street, ring, lane,
//                                                          foot, land, seaDist, inBlock, dockClear; town, bounds, dock, waves)
import { hash } from '../../web/src/engine/core/rng.js';
import { noise } from '../../web/src/engine/mod/kit/layout.js';
import { ROAD } from '../../web/src/engine/core/grid.js';
import { TERRAIN, GROUND_EXT, LOT_SQUARE, LOT_DOCK } from './fantasy-codes.mjs';
import { RULES } from '../../mods/agentville.fantasy/rules.js';

export const SEA_MARGIN = 12;
const key = (x, y) => `${x},${y}`;
const unkey = k => k.split(',').map(Number);
const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

/** The classic string-keyed computation (fast: false): the reference the raster path must match. */
export function geoSlow(villages, SQUARE, WALK) {
  const W = { villages, square: SQUARE,
    fp: new Set(), path: new Set(), street: new Set(), ring: new Set(), lane: new Set(), foot: new Set(),
    land: new Set(), seaDist: new Map(), inBlock: new Map(), dockClear: new Set(), town: null, box: null, bounds: null, dock: null, waves: [] };
  // What placeVillage contributed that the roads read: footprints of every lot and civic building (route
  // never crosses them), the plan's walkable ground (W.path), and which tiles are inside a block.
  for (const v of W.villages) {
    const { block: b, plan: p } = v;
    for (let j = 0; j < p.h; j++) for (let i = 0; i < p.w; i++) {
      const k = key(b.x + i, b.y + j);
      W.inBlock.set(k, v.index);
      if (WALK.has(p.ground[j * p.w + i])) W.path.add(k);
    }
    for (const r of [...p.lots, ...(p.civic || [])]) for (let j = r.y; j < r.y + r.h; j++) for (let i = r.x; i < r.x + r.w; i++) W.fp.add(key(b.x + i, b.y + j));
  }
  buildRoads(W);
  W.dock = dockSite(W);
  buildLand(W);
  dockShore(W);
  return W;
}

// classic: route — A* over a noise cost field toward `aim`; existing paths are cheap, `avoid` is dear.
function route(W, from, isGoal, box, aim, avoid) {
  const [x0, y0, x1, y1] = box, Wd = x1 - x0 + 1, idx = (x, y) => (y - y0) * Wd + (x - x0);
  const dist = new Float64Array(Wd * (y1 - y0 + 1)).fill(Infinity), prev = new Int32Array(dist.length).fill(-1), heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  const h = (x, y) => Math.hypot(x - aim[0], y - aim[1]), done = new Uint8Array(dist.length);
  for (const [x, y] of from) { if (x < x0 || y < y0 || x > x1 || y > y1) continue; dist[idx(x, y)] = 0; push(h(x, y), idx(x, y)); }
  while (heap.length) {
    const [, i] = pop();
    if (done[i]) continue;
    done[i] = 1;
    const d = dist[i], x = x0 + i % Wd, y = y0 + Math.floor(i / Wd);
    if (isGoal(x, y)) {
      const out = []; let px = null, py = null;
      for (let k = i; k >= 0; k = prev[k]) {
        const X = x0 + k % Wd, Y = y0 + Math.floor(k / Wd);
        if (px !== null && px !== X && py !== Y) out.push(W.fp.has(key(X, py)) ? [px, Y] : [X, py]);
        out.push([X, Y]); px = X; py = Y;
      }
      return out;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < x0 || Y < y0 || X > x1 || Y > y1 || W.fp.has(key(X, Y))) continue;
      if (dx && dy && (W.fp.has(key(x + dx, y)) || W.fp.has(key(x, y + dy)))) continue;
      const k = key(X, Y);
      const c = (avoid?.has(k) ? 41 : W.path.has(k) ? 0.35 : 1 + 3 * noise(X, Y, 5) ** 2) * (dx && dy ? 1.42 : 1);
      const j = idx(X, Y);
      if (d + c < dist[j]) { dist[j] = d + c; prev[j] = i; push(d + c + h(X, Y), j); }
    }
  }
  return [];
}
// classic: buildRoads — a ring road round every block and a 2-wide road from each block to the square.
function buildRoads(W) {
  const SQUARE = W.square;
  const rects = [SQUARE, ...W.villages.map(v => v.block)];
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h));
  W.town = [x0 - 1, y0 - 1, x1, y1];
  W.box = [x0 - 14, y0 - 14, x1 + 14, y1 + 14];
  const street = k => { W.path.add(k); W.street.add(k); };
  for (let j = SQUARE.y; j < SQUARE.y + SQUARE.h; j++) for (let i = SQUARE.x; i < SQUARE.x + SQUARE.w; i++) W.path.add(key(i, j));
  for (const v of W.villages) {
    const b = v.block, ring = k => { street(k); W.ring.add(k); };
    for (let i = b.x - 1; i <= b.x + b.w; i++) { ring(key(i, b.y - 1)); ring(key(i, b.y + b.h)); }
    for (let j = b.y; j < b.y + b.h; j++) { ring(key(b.x - 1, j)); ring(key(b.x + b.w, j)); }
  }
  const sq = [SQUARE.x + SQUARE.w / 2, SQUARE.y + SQUARE.h / 2];
  for (const v of [...W.villages].sort((a, b) => Math.hypot(a.cx, a.cy) - Math.hypot(b.cx, b.cy))) {
    const b = v.block, ring = [];
    for (let i = b.x - 1; i <= b.x + b.w; i++) ring.push([i, b.y - 1], [i, b.y + b.h]);
    for (let j = b.y; j < b.y + b.h; j++) ring.push([b.x - 1, j], [b.x + b.w, j]);
    for (const [x, y] of route(W, ring, (x, y) => inRect(SQUARE, x, y), W.box, sq, W.inBlock)) {
      for (const [a, c] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const k = key(x + a, y + c); if (!W.inBlock.has(k)) { street(k); W.lane.add(k); } }
    }
  }
}
// classic: buildLand — one land mass round the town, a sandy shore and the sea; specks and lakes cleaned up.
function buildLand(W) {
  const [tx0, ty0, tx1, ty1] = W.town, E = 12, PAD = E + 15;
  const X0 = tx0 - PAD, Y0 = ty0 - PAD, GW = tx1 - tx0 + 1 + 2 * PAD, GH = ty1 - ty0 + 1 + 2 * PAD;
  const at = (x, y) => (x < X0 || y < Y0 || x >= X0 + GW || y >= Y0 + GH ? -1 : (y - Y0) * GW + (x - X0));
  const cand = new Uint8Array(GW * GH), seen = new Uint8Array(GW * GH), sea = new Uint8Array(GW * GH), land = new Uint8Array(GW * GH);
  for (let y = ty0 - E; y <= ty1 + E; y++) for (let x = tx0 - E; x <= tx1 + E; x++) {
    const d = Math.hypot(Math.max(tx0 - x, 0, x - tx1), Math.max(ty0 - y, 0, y - ty1));
    if (W.dock && x >= W.dock.x0 && x <= W.dock.x1 && y >= W.dock.sea) continue;
    if (d <= 5 + noise(x, y, 6) * 4 || (W.dock && x >= W.dock.x0 && x <= W.dock.x1 && y <= W.dock.foot && y > ty1)) cand[at(x, y)] = 1;
  }
  for (const k of W.path) { const [x, y] = unkey(k), i = at(x, y); if (i >= 0) cand[i] = 1; }
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const flood = (q, mark, ok) => { for (let h = 0; h < q.length; h++) { const i = q[h], x = X0 + i % GW, y = Y0 + (i / GW | 0); for (const [a, b] of N4) { const j = at(x + a, y + b); if (j >= 0 && !mark[j] && ok(x + a, y + b, j)) { mark[j] = 1; q.push(j); } } } };
  const s0 = at(tx0, ty0); seen[s0] = 1;
  flood([s0], seen, (x, y, j) => cand[j]);
  const ex0 = tx0 - E - 1, ex1 = tx1 + E + 1, ey0 = ty0 - E - 1, ey1 = ty1 + E + 1, sq = [];
  for (let x = ex0; x <= ex1; x++) for (const y of [ey0, ey1]) { const i = at(x, y); if (!sea[i]) { sea[i] = 1; sq.push(i); } }
  for (let y = ey0; y <= ey1; y++) for (const x of [ex0, ex1]) { const i = at(x, y); if (!sea[i]) { sea[i] = 1; sq.push(i); } }
  flood(sq, sea, (x, y, j) => x >= ex0 && x <= ex1 && y >= ey0 && y <= ey1 && !seen[j]);
  const order = [];
  for (let y = ty0 - E; y <= ty1 + E; y++) for (let x = tx0 - E; x <= tx1 + E; x++) { const i = at(x, y); if (seen[i] || !sea[i]) { land[i] = 1; order.push(i); } }
  for (let pass = 0; pass < 2; pass++) for (const i of order) {
    if (!land[i]) continue;
    const x = X0 + i % GW, y = Y0 + (i / GW | 0);
    if (x >= tx0 && x <= tx1 && y >= ty0 && y <= ty1) continue;
    let n = 0; for (const [a, b] of N4) { const j = at(x + a, y + b); if (j >= 0 && land[j]) n++; }
    if (n <= 1) land[i] = 0;
  }
  let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
  const dist = new Int8Array(GW * GH).fill(-1), dq = [];
  for (const i of order) {
    if (!land[i]) continue;
    const x = X0 + i % GW, y = Y0 + (i / GW | 0);
    W.land.add(key(x, y));
    lx0 = Math.min(lx0, x); ly0 = Math.min(ly0, y); lx1 = Math.max(lx1, x); ly1 = Math.max(ly1, y);
    dist[i] = 0; dq.push(i);
  }
  // classic: W.bounds = land box + 10/11 tiles; the engine keeps at least SEA_MARGIN of sea round the land.
  const M = Math.max(SEA_MARGIN, 10);
  W.bounds = [lx0 - M, ly0 - M, lx1 + M + 1, ly1 + M + 1];
  for (let h = 0; h < dq.length; h++) {
    const i = dq[h], dv = dist[i];
    if (dv > 12) continue;
    const x = X0 + i % GW, y = Y0 + (i / GW | 0);
    for (const [dx, dy] of N4) { const j = at(x + dx, y + dy); if (j >= 0 && dist[j] < 0) { dist[j] = dv + 1; dq.push(j); } }
  }
  for (const i of dq) {
    const x = X0 + i % GW, y = Y0 + (i / GW | 0), k = key(x, y);
    W.seaDist.set(k, dist[i]);
    if (dist[i] === 3 && hash(k) % 3 === 0) W.waves.push([x, y]);
  }
}
// classic: dockSite — the harbour cove under the square's column, cut for the biggest harbour from the start.
function dockSite(W) {
  const SQUARE = W.square;
  const cx = SQUARE.x + (SQUARE.w >> 1), foot = W.town[3] + 5;
  return { cx, foot, sea: foot + 1, x0: cx - 20, x1: cx + 24 };
}
// classic: dockShore — the waterfront clearing, a footpath from the harbour up to town, room to pan.
function dockShore(W) {
  const D = W.dock, top = W.town[3] + 1;
  for (let y = D.foot - 3; y <= D.sea + 12; y++) for (let x = D.x0 - 2; x <= D.x1 + 2; x++) { const k = key(x, y); if (W.land.has(k) && !W.inBlock.has(k)) W.dockClear.add(k); }
  const foot = k => { W.path.add(k); W.foot.add(k); };
  const from = [[D.cx, top], [D.cx + 1, top]];
  for (const [x, y] of route(W, from, (x, y) => W.path.has(key(x, y)), [D.cx - 14, W.town[1], D.cx + 15, top], [D.cx, W.town[3]], W.inBlock)) foot(key(x, y));
  for (let y = top; y <= D.foot; y++) { foot(key(D.cx, y)); foot(key(D.cx + 1, y)); }
  const b = W.bounds;
  W.bounds = [Math.min(b[0], D.x0 - 4), b[1], Math.max(b[2], D.x1 + 5), Math.max(b[3], D.sea + 28)];
}

// classic draw rule (the engine's stamp before MOD-READY): land → GRASS, or SHORE where it touches water (8-way) and is
// no path; water → SEA within 5.5 (seaDist + noise) of land, else SEA_DEEP.
function terrainOf(W, x, y) {
  const k = key(x, y);
  if (W.land.has(k)) {
    if (W.path.has(k)) return TERRAIN.GRASS;
    for (const [a, b] of N8) if (!W.land.has(key(x + a, y + b))) return TERRAIN.SHORE;
    return TERRAIN.GRASS;
  }
  const d = (W.seaDist.get(k) ?? 30) + noise(x, y, 3) * 1.8;
  return d < 5.5 ? TERRAIN.SEA : TERRAIN.SEA_DEEP;
}

/** The classic layout as a LayoutResult (api.js), tiles over buildLand's grid (town ± 27 tiles), outside = deep sea. */
export function referenceLayout(input, { paths } = {}) {
  const walk = new Set(paths ?? input.paths ?? RULES.layout.paths);
  const SQ = input.square;
  const W = geoSlow(input.settlements, SQ, walk);
  const [tx0, ty0, tx1, ty1] = W.town, PAD = 12 + 15;
  const ox = tx0 - PAD, oy = ty0 - PAD, w = tx1 - tx0 + 1 + 2 * PAD, h = ty1 - ty0 + 1 + 2 * PAD, n = w * h;
  const terrain = new Uint8Array(n), ground = new Uint8Array(n), road = new Uint8Array(n), lot = new Int8Array(n);
  for (let y = oy; y < oy + h; y++) for (let x = ox; x < ox + w; x++) {
    const i = (y - oy) * w + (x - ox), k = key(x, y);
    terrain[i] = terrainOf(W, x, y);
    if (W.inBlock.has(k)) continue;
    let g = 0, r = ROAD.NONE, l = 0;
    if (inRect(SQ, x, y)) { g = GROUND_EXT.SQUARE; r = ROAD.MAIN; l = LOT_SQUARE; }
    else if (W.ring.has(k)) { g = GROUND_EXT.RING; r = ROAD.STREET; }
    else if (W.lane.has(k)) { g = GROUND_EXT.ROAD; r = ROAD.LANE; }
    else if (W.foot.has(k)) { g = GROUND_EXT.ROAD; r = ROAD.PATH; }
    else if (W.dockClear.has(k)) g = GROUND_EXT.DOCK;
    if (!l && W.dockClear.has(k)) l = LOT_DOCK;
    ground[i] = g; road[i] = r; lot[i] = l;
  }
  const [bx0, by0, bx1, by1] = W.bounds, D = W.dock;
  return {
    bounds: { ox: bx0, oy: by0, w: bx1 - bx0, h: by1 - by0 },
    focus: { ox: tx0 - 1, oy: ty0 - 1, w: tx1 - tx0 + 3, h: ty1 - ty0 + 3 },
    tiles: { ox, oy, w, h, terrain, ground, road, lot },
    outside: TERRAIN.SEA_DEEP,
    venues: { dock: { kind: 'harbour', rect: { x: D.x0 - 2, y: D.foot - 3, w: D.x1 - D.x0 + 5, h: D.sea + 12 - (D.foot - 3) + 1 }, anchor: { tx: D.cx, ty: D.foot }, data: { ...D } } },
    data: { dock: { ...D }, town: [...W.town], waves: W.waves },
  };
}
