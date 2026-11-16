// agentville.fantasy layout: one island round the town (specks and lakes cleaned up), the distance to land over the
// sea, and the wave glints. Pure. Moved from the engine's world/sites.js (geoFast's buildLand on
// the raster; classic world.js buildLand) unchanged, so the world is byte-identical.
import { hash, noise, flood4, distance4 } from '#agentville/mod';
import { E, LAND } from './roads.js';

/** Sea margin (tiles) round the land in `bounds`, at least (the design asks for >= 12). */
export const SEA_MARGIN = 12;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** classic buildLand on the town raster. Needs the dock site (the harbour cove is cut out of the land) and the roads
 *  (every path tile is land). Sets LAND, G.seaDist (0 on land, up to 13 over the sea), G.waves and G.bounds. */
export function buildLand(G) {
  const g = buildLandSteps(G);
  while (!g.next().done);
}

/** buildLand as a step generator (PERF M7): the same passes in the same order, yielding between them (layout.steps).
 *  The hot loops are plain arrow functions called in place: a loop runs slower in a generator's own body. */
export function* buildLandSteps(G) {
  const { R, town: [tx0, ty0, tx1, ty1], dock: D } = G, { at, n: N, flags: F } = R, X0 = R.ox, Y0 = R.oy, GW = R.w;
  const cand = new Uint8Array(N), seen = new Uint8Array(N), sea = new Uint8Array(N), land = new Uint8Array(N);
  // noise() is in [0, 1), so the reach 5 + noise * 4 is in [5, 9): inside the town box (d = 0) a tile is always a
  // candidate and 9 or more tiles out on an axis (d >= 9) the reach never gets there, so only the band between needs
  // the distance and the noise (the same test as before, without a noise lookup per tile of the town)
  (() => {
    for (let y = ty0 - E; y <= ty1 + E; y++) for (let x = tx0 - E; x <= tx1 + E; x++) {
      const ax = Math.max(tx0 - x, 0, x - tx1), ay = Math.max(ty0 - y, 0, y - ty1);
      if (x >= D.x0 && x <= D.x1 && y >= D.sea) continue;
      const reach = ax === 0 && ay === 0 ? true : ax >= 9 || ay >= 9 ? false : Math.hypot(ax, ay) <= 5 + noise(x, y, 6) * 4;
      if (reach || (x >= D.x0 && x <= D.x1 && y <= D.foot && y > ty1)) cand[at(x, y)] = 1;
    }
  })();
  for (const i of G.path) cand[i] = 1;
  yield;
  const s0 = at(tx0, ty0); seen[s0] = 1;
  flood4(R, [s0], seen, (x, y, j) => cand[j]);
  const ex0 = tx0 - E - 1, ex1 = tx1 + E + 1, ey0 = ty0 - E - 1, ey1 = ty1 + E + 1, sqq = [];
  for (let x = ex0; x <= ex1; x++) for (const y of [ey0, ey1]) { const i = at(x, y); if (!sea[i]) { sea[i] = 1; sqq.push(i); } }
  for (let y = ey0; y <= ey1; y++) for (const x of [ex0, ex1]) { const i = at(x, y); if (!sea[i]) { sea[i] = 1; sqq.push(i); } }
  flood4(R, sqq, sea, (x, y, j) => x >= ex0 && x <= ex1 && y >= ey0 && y <= ey1 && !seen[j]);
  yield;
  // parity: world.lakes-filled
  const order = [];
  (() => {
    for (let y = ty0 - E; y <= ty1 + E; y++) for (let x = tx0 - E; x <= tx1 + E; x++) { const i = at(x, y); if (seen[i] || !sea[i]) { land[i] = 1; order.push(i); } }
    // parity: world.no-one-tile-spits
    for (let pass = 0; pass < 2; pass++) for (const i of order) {
      if (!land[i]) continue;
      const x = X0 + i % GW, y = Y0 + (i / GW | 0);
      if (x >= tx0 && x <= tx1 && y >= ty0 && y <= ty1) continue;
      let n = 0; for (const [a, b] of N4) { const j = at(x + a, y + b); if (j >= 0 && land[j]) n++; }
      if (n <= 1) land[i] = 0;
    }
  })();
  yield;
  const dist = G.seaDist, dq = [];
  const [lx0, ly0, lx1, ly1] = (() => {
    let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
    for (const i of order) {
      if (!land[i]) continue;
      const x = X0 + i % GW, y = Y0 + (i / GW | 0);
      F[i] |= LAND;
      lx0 = Math.min(lx0, x); ly0 = Math.min(ly0, y); lx1 = Math.max(lx1, x); ly1 = Math.max(ly1, y);
      dist[i] = 0; dq.push(i);
    }
    return [lx0, ly0, lx1, ly1];
  })();
  // classic: W.bounds = land box + 10/11 tiles; this world keeps at least SEA_MARGIN of sea round the land.
  const M = Math.max(SEA_MARGIN, 10);
  G.bounds = [lx0 - M, ly0 - M, lx1 + M + 1, ly1 + M + 1];
  yield;
  distance4(R, dq, dist, 12);
  yield;
  for (const i of dq) if (dist[i] === 3) { const x = X0 + i % GW, y = Y0 + (i / GW | 0); if (hash(`${x},${y}`) % 3 === 0) G.waves.push([x, y]); }
}
