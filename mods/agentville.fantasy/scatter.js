// agentville.fantasy scatter hook (api.js ScatterTile -> ScatterPick): the forest-floor recolour, the coast test, the park and
// density curve, bushes and the rare big tree. Arithmetic and draw keys (k0 tree?, k1 which tree, k2 bush?, k3 which bush) are
// the pre-MOD-4c engine's, unchanged. The engine supplies dist/park/canPlace and runs the lattice, 2x2-free and cover checks.
//
// M7 dress: the countryside round the towns. Growth room leaves gaps up to ~16 tiles wide between blocks, and the
// belt used to leave them either bare flat grass (within 4 tiles of a block) or solid forest (further in). Within the BFS reach
// (tile.dist 1..8) a smooth hash-noise now splits the land into meadow and wood: meadow gets its own ground (dithered, with
// wildflower patches and the odd winding footpath, painted by ground.js), a few tree copses and lone trees; wood keeps the old
// forest-belt behaviour. All of it is cosmetic: terrain recolours and wild objects, recomputed on every build, so a block that
// grows into a gap simply takes the tiles (the engine never scatters on built tiles nor beside them, and never on a road).
// Deterministic per tile: the noise is a fixed integer hash of the tile, the draws are the engine's stateless ones.
import { OBJECT_TYPES } from './objects.js';
import { CLASSES } from './terrain.js';

const { trees: TREES, bushes: BUSHES, forestDist: FOREST_DIST = 5 } = OBJECT_TYPES.scatter;
const GROWS = new Set(CLASSES.filter(c => c.grows).map(c => c.code));
const cls = n => CLASSES.find(c => c.name === n).code;
const GRASS = cls('grass'), FOREST_FLOOR = cls('forest-floor'), MEADOW = cls('meadow'), BLOOM = cls('bloom-meadow'), FOOTPATH = cls('footpath'), TALL = cls('tall-grass'), DRIFTS = [cls('drift-gold'), cls('drift-rose'), cls('drift-violet')];
const COAST = [[3, 0], [-3, 0], [0, 3], [0, -3]];
const nT = TREES.length;

/** Integer lattice hash -> 0..1 (fixed, seedless: the countryside of a tile never changes). */
const lat = (x, y, s) => { let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b1); h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
/** Smooth value noise 0..1 with a feature size of `sc` tiles. */
const noise = (x, y, sc, s) => {
  const fx = x / sc, fy = y / sc, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
  const a = lat(x0, y0, s), b = lat(x0 + 1, y0, s), c = lat(x0, y0 + 1, s), d = lat(x0 + 1, y0 + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const REACH = 8;   // the engine's BFS reaches 8 tiles from built land; tile.dist 9 means "further"

export const scatter = (tile, draw) => {
  const v = tile.dist - 2;
  const out = {};
  const x = tile.x, y = tile.y, near = tile.dist >= 1 && tile.dist <= REACH;
  // meadow where the field noise clears a bar that rises with distance (nearer the town: more open; the gap's middle: copses and wood)
  const meadow = near && !tile.park && tile.terrain === GRASS && noise(x, y, 11, 1) > 0.3 + 0.06 * (tile.dist - 2);
  if (meadow) {
    // wildflower drifts (a few tiles across, one colour each), long-grass tufts, and a feature tile in every aligned 2x2 so no 4x4 of
    // the meadow is ever plain (all painted into the ground: no objects)
    const drift = noise(x, y, 4, 2) > 0.54, tall = noise(x, y, 3, 8) > 0.6 || Math.floor(lat(x >> 1, y >> 1, 11) * 4) === (x & 1) + 2 * (y & 1);
    const pale = !drift && noise(x, y, 5, 12) > 0.8;
    // a winding trail: a line (spacing 29 tiles, 2.2 wide) bent by slow noise, one family along each axis, only some lines exist; runs
    // right up to a block's edge so it reads as a track between the towns, long and continuous
    const trailOn = (u, s) => { const m = ((u % 29) + 29) % 29; return m < 2.2 && lat(Math.floor(u / 29), 0, s) < 0.5; };
    const trail = tile.dist >= 1 && (trailOn(x + 9 * noise(x, y, 13, 3), 5) || trailOn(y + 9 * noise(x, y, 13, 6), 7));
    out.terrain = trail ? FOOTPATH : drift ? DRIFTS[Math.min(2, Math.floor(noise(x, y, 19, 9) * 3))] : pale ? BLOOM : tall ? TALL : MEADOW;
    if (tile.canPlace && !trail) {
      const copse = noise(x, y, 6, 4) > 0.6;   // a clump of mixed trees; elsewhere a tree stands alone now and then
      const p = copse ? 0.6 : 0.08;
      if (draw(0) < p) { const t = Math.floor(draw(1) * (nT - 1)); const pick = TREES[copse && draw(4) < 0.25 ? 0 : t % (nT - 1)]; out.model = pick[0]; out.variant = pick[1]; }
      else if (draw(2) < (tall ? 0.2 : 0.04)) { const b = BUSHES[Math.floor(draw(3) * 2)]; out.model = b[0]; out.variant = b[1]; }   // bush clumps in the long grass
      else if (draw(6) < 0.012) { out.model = 'rock'; out.variant = 0; }
      else if (drift && draw(3) < 0.08) { out.model = draw(7) < 0.5 ? 'clover' : 'sunflower'; out.variant = 0; }
    } else if (trail && tile.canPlace && draw(5) < 0.012) { out.model = 'signpost'; out.variant = 0; }
    return out;
  }
  // parity: world.forest-belt
  if (v >= FOREST_DIST - 2 && tile.terrain === GRASS) out.terrain = FOREST_FLOOR;
  if (tile.canPlace) {
    const coast = COAST.some(([a, b]) => !GROWS.has(tile.terrainAt(a, b)));
    const p = tile.park ? 0.35 : Math.min(0.9, Math.max(0, (v + 1) / 5) * 0.8 + (coast ? 0.25 : 0));
    let pick = null;
    if (draw(0) < p) { const t = Math.floor(draw(1) * nT); pick = TREES[t === nT - 1 && v > 4 ? nT - 1 : t % (nT - 1)]; }
    else if (draw(2) < 1 / 9) pick = BUSHES[Math.floor(draw(3) * BUSHES.length)];
    if (pick) { out.model = pick[0]; out.variant = pick[1]; }
  }
  return out.terrain === undefined && out.model === undefined ? null : out;
};
