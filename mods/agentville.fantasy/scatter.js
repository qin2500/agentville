// agentville.fantasy scatter hook (api.js ScatterTile -> ScatterPick): the forest-floor recolour, the coast test, the park and
// density curve, bushes and the rare big tree. Arithmetic and draw keys (k0 tree?, k1 which tree, k2 bush?, k3 which bush) are
// the pre-MOD-4c engine's, unchanged. The engine supplies dist/park/canPlace and runs the lattice, 2x2-free and cover checks.
import { OBJECT_TYPES } from './objects.js';
import { CLASSES } from './terrain.js';

const { trees: TREES, bushes: BUSHES, forestDist: FOREST_DIST = 5 } = OBJECT_TYPES.scatter;
const GROWS = new Set(CLASSES.filter(c => c.grows).map(c => c.code));
const GRASS = CLASSES.find(c => c.name === 'grass').code, FOREST_FLOOR = CLASSES.find(c => c.name === 'forest-floor').code;
const COAST = [[3, 0], [-3, 0], [0, 3], [0, -3]];
const nT = TREES.length;

export const scatter = (tile, draw) => {
  const v = tile.dist - 2;
  const out = {};
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
