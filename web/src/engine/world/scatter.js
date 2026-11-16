// Wild trees and bushes as objects (design §1.3 step 5). Pure.
// MECHANISM only (MOD-4c): the BFS distance from built tiles, the lattice / 2x2-free / cover checks, the stateless draws and
// object creation. WHAT grows (density curve, park, coast, recolour, models) is the mod's hooks.scatter(tile, draw, ctx).
// A mod without hooks.scatter gets no scatter. Nothing wild grows in a plot (its plan fills it), on a road or on a venue site.
import { LOT } from '../core/grid.js';
import { rand } from '../core/rng.js';
import { footprintFor } from './footprints.js';
import { drainSync } from '../core/slices.js';

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Adds wild objects (ids 'tree:<tx>,<ty>') by asking mod.hooks.scatter about every unbuilt tile whose terrain class `grows`
 * (mod.terrain.classes; a table without classes grows nothing). The hook may recolour (pick.terrain)
 * and, only when tile.canPlace, name a model. Skips tiles with cover > 0 when the cover layer has been computed.
 * @param {*} [ctx] passed to the hook as its third argument
 * @returns {number} objects added (0 when the mod has no scatter hook) */
export function scatterWild(grid, objects, sites, seed, mod, ctx) {
  return drainSync(scatterWildSteps(grid, objects, sites, seed, mod, ctx));
}

const ROWS_PER_STEP = 48;
/** scatterWild as a step generator (PERF M7): the same work in the same order (the BFS, then the tiles row
 * by row), yielding after the BFS and every ROWS_PER_STEP rows so a sliced build hands the main thread back mid-scatter.
 * Returns the count scatterWild returns. */
export function* scatterWildSteps(grid, objects, sites, seed, mod, ctx) {
  const hook = mod?.hooks?.scatter;
  if (typeof hook !== 'function') return 0;
  const lattice = Math.max(1, mod.objects?.scatter?.lattice | 0 || 2);
  const classes = mod.terrain?.classes;
  const growsCode = new Set(Array.isArray(classes) ? classes.filter(c => c.grows).map(c => c.code) : []);
  const grows = t => growsCode.has(t);
  const { ox, oy, w, h } = grid;
  const I = (x, y) => (y - oy) * w + (x - ox);
  const inb = (x, y) => x >= ox && y >= oy && x < ox + w && y < oy + h;
  const built = i => grid.lot[i] !== LOT.WILD || grid.ground[i] !== 0 || grid.occ[i] !== 0;
  const terrainAt = (x, y) => inb(x, y) ? grid.terrain[I(x, y)] : 0;   // outside the grid is class 0
  // BFS distance (4-neighbour, up to 8) from anything built
  const lot = grid.lot, ground = grid.ground, occ = grid.occ, N = w * h;
  const dist = new Int16Array(N).fill(-1), q = new Int32Array(N);
  (() => {   // a plain function: a hot loop runs slower in a generator's body
    let qn = 0;
    for (let i = 0; i < N; i++) if (lot[i] !== LOT.WILD || ground[i] !== 0 || occ[i] !== 0) { dist[i] = 0; q[qn++] = i; }
    for (let k = 0; k < qn; k++) {
      const c = q[k], d = dist[c];
      if (d > 8) continue;
      const x = c % w, y = (c / w) | 0;
      if (x + 1 < w && dist[c + 1] < 0) { dist[c + 1] = d + 1; q[qn++] = c + 1; }
      if (x > 0 && dist[c - 1] < 0) { dist[c - 1] = d + 1; q[qn++] = c - 1; }
      if (y + 1 < h && dist[c + w] < 0) { dist[c + w] = d + 1; q[qn++] = c + w; }
      if (y > 0 && dist[c - w] < 0) { dist[c - w] = d + 1; q[qn++] = c - w; }
    }
  })();
  yield 'scatter-dist';
  const parks = sites?.parks || [];
  const inPark = (x, y) => { for (let k = 0; k < parks.length; k++) { const r = parks[k]; if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return true; } return false; };
  let added = 0;
  const terr = grid.terrain, modId = mod.id, x1 = ox + w, y1 = oy + h;
  // the rows, in bands between yields; each band is a plain function (a hot loop runs slower in a generator's body)
  const rows = (ya, yb) => {
    for (let y = ya; y < yb; y++) {
      for (let x = ox; x < x1; x++) {
        const i = (y - oy) * w + (x - ox);
        if (!growsCode.has(terr[i]) || lot[i] !== LOT.WILD || ground[i] !== 0 || occ[i] !== 0) continue;
        const canPlace = !(x % lattice || y % lattice)
          && !(inb(x + 1, y) && built(I(x + 1, y)) || inb(x, y + 1) && built(I(x, y + 1)) || inb(x + 1, y + 1) && built(I(x + 1, y + 1)))
          && !(grid.cover && grid.cover[i] > 0);
        // stateless draws keyed by tile (k = which draw): a tree does not move when its neighbours change, and no per-tile stream is built
        const draw = k => rand(seed, modId, 'scatter', x, y, k);
        const tile = { x, y, dist: dist[i] < 0 ? 9 : dist[i], park: inPark(x, y), terrain: terr[i], terrainAt: (dx, dy) => terrainAt(x + dx, y + dy), canPlace };
        const pick = hook(tile, draw, ctx);
        if (!pick) continue;
        if (Number.isInteger(pick.terrain) && pick.terrain >= 0 && pick.terrain <= 15) terr[i] = pick.terrain;
        if (!canPlace || !pick.model || typeof pick.model !== 'string') continue;
        const variant = pick.variant ?? 0;
        const fp = footprintFor({ kind: pick.model }, mod.objects);   // null: decal
        const obj = { id: `tree:${x},${y}`, kind: fp ? 'tree' : 'decal', model: pick.model, tx: x, ty: y, w: 1, h: 1, z: fp ? fp.z : 0, walk: fp ? 'block' : 'floor',
          styleKey: 'wild', variant, data: { wild: true } };
        const num = objects.add(obj);
        const r = grid.stamp(obj, num);
        if (r && r.ok === false) { objects.delete(obj.id); continue; }
        added++;
      }
    }
  };
  for (let y = oy; y < y1; y += ROWS_PER_STEP) {
    if (y > oy) yield 'scatter-rows';
    rows(y, Math.min(y + ROWS_PER_STEP, y1));
  }
  return added;
}
