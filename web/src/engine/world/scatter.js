// Wild trees and bushes as objects (design §1.3 step 5). Pure.
// MECHANISM only (MOD-4c): the BFS distance from built tiles, the lattice / 2x2-free / cover checks, the stateless draws and
// object creation. WHAT grows (density curve, park, coast, recolour, models) is the mod's hooks.scatter(tile, draw, ctx).
// A mod without hooks.scatter gets no scatter. Nothing wild grows in a plot (its plan fills it), on a road or on a venue site.
import { LOT } from '../core/grid.js';
import { rand } from '../core/rng.js';
import { footprintFor } from './footprints.js';

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Adds wild objects (ids 'tree:<tx>,<ty>') by asking mod.hooks.scatter about every unbuilt tile whose terrain class `grows`
 * (mod.terrain.classes; a table without classes grows nothing). The hook may recolour (pick.terrain)
 * and, only when tile.canPlace, name a model. Skips tiles with cover > 0 when the cover layer has been computed.
 * @param {*} [ctx] passed to the hook as its third argument
 * @returns {number} objects added (0 when the mod has no scatter hook) */
export function scatterWild(grid, objects, sites, seed, mod, ctx) {
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
  const dist = new Int16Array(w * h).fill(-1), q = [];
  for (let i = 0; i < w * h; i++) if (built(i)) { dist[i] = 0; q.push(i); }
  for (let k = 0; k < q.length; k++) {
    const d = dist[q[k]];
    if (d > 8) continue;
    const x = q[k] % w, y = (q[k] / w) | 0;
    for (const [a, b] of N4) {
      const nx = x + a, ny = y + b;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (dist[j] < 0) { dist[j] = d + 1; q.push(j); }
    }
  }
  const inPark = (x, y) => (sites?.parks || []).some(r => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
  let added = 0;
  for (let y = oy; y < oy + h; y++) for (let x = ox; x < ox + w; x++) {
    const i = I(x, y);
    if (!grows(grid.terrain[i]) || built(i)) continue;
    const nb = j => j >= 0 && built(j);
    const canPlace = !(x % lattice || y % lattice)
      && !(nb(inb(x + 1, y) ? I(x + 1, y) : -1) || nb(inb(x, y + 1) ? I(x, y + 1) : -1) || nb(inb(x + 1, y + 1) ? I(x + 1, y + 1) : -1))
      && !(grid.cover && grid.cover[i] > 0);
    // stateless draws keyed by tile (k = which draw): a tree does not move when its neighbours change, and no per-tile stream is built
    const draw = k => rand(seed, mod.id, 'scatter', x, y, k);
    const tile = { x, y, dist: dist[i] < 0 ? 9 : dist[i], park: inPark(x, y), terrain: grid.terrain[i], terrainAt: (dx, dy) => terrainAt(x + dx, y + dy), canPlace };
    const pick = hook(tile, draw, ctx);
    if (!pick) continue;
    if (Number.isInteger(pick.terrain) && pick.terrain >= 0 && pick.terrain <= 15) grid.terrain[i] = pick.terrain;
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
  return added;
}
