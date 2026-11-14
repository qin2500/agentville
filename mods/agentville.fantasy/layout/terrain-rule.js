// agentville.fantasy: the per-tile sea/shore rule (today's stampRaster terrain branch in web/src/engine/world/sites.js,
// copied verbatim; only the raster lookups became the `r` callbacks and the TERRAIN codes come from CLASSES).
// r = { isLand(x, y), isPath(x, y), seaDist(x, y) -> tiles to land, or a negative/undefined value when unknown }.
import { noise } from '#agentville/mod';
import { CLASSES } from '../terrain.js';

const code = name => CLASSES.find(c => c.name === name).code;
const SEA_DEEP = code('deep-sea'), SEA = code('sea'), SHORE = code('shore'), GRASS = code('grass');
const N8F = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

/** Land → grass, or shore where it touches water (8-way) and is no path; water → sea within 5.5 (seaDist + noise)
 *  of land, else deep sea. */
export function terrainAt(r, x, y) {
  let ter;
  if (r.isLand(x, y)) {
    ter = GRASS;
    if (!r.isPath(x, y)) for (const [a, b] of N8F) if (!r.isLand(x + a, y + b)) { ter = SHORE; break; }
  } else {
    const s = r.seaDist(x, y);
    const d = (s >= 0 ? s : 30) + noise(x, y, 3) * 1.8;
    ter = d < 5.5 ? SEA : SEA_DEEP;
  }
  return ter;
}
