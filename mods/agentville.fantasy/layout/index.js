// agentville.fantasy layout hook (api.js LayoutResult): the island, ring roads, roads to the square and the harbour.
// Pure in `input` (the engine caches the result; ctx.time is not given). Moved from the engine's
// world/sites.js: geoFast + sitesOfRaster + the per-tile pass of stampRaster, byte-identical to the old built-in layout.
//   roads.js  the raster, block footprints, ring roads, A* roads to the square
//   dock.js   the harbour site, waterfront clearing, footpath, bounds for the harbour, the `dock` venue site
//   land.js   the island, specks and lakes, the distance over the sea, wave glints
//   terrain-rule.js  the per-tile sea/shore rule (terrain classes; owned by the terrain piece)
import { ROAD, LAYOUT_GROUND, LOT, inRect } from '#agentville/mod';
import { RULES } from '../rules.js';
import { createTown, stampBlocks, buildRoads, PATH, RING, LANE, FOOT, LAND, DOCKC } from './roads.js';
import { buildLand } from './land.js';
import { dockSite, dockShore, dockVenue } from './dock.js';
import { terrainAt } from './terrain-rule.js';

export { SEA_MARGIN } from './land.js';

const DEFAULT_PATHS = new Set(RULES.layout.paths);
const PATHS = new WeakMap();
/** The plan ground codes the roads treat as existing path: input.paths (the engine's, from the resolved mod's rules /
 *  terrain tags) or this mod's RULES.layout.paths. */
function pathsOf(input) {
  const p = input.paths;
  if (!p) return DEFAULT_PATHS;
  if (p instanceof Set) return p;
  let s = PATHS.get(p);
  if (!s) PATHS.set(p, s = new Set(p));
  return s;
}

/** @param {import('#agentville/mod').LayoutInput & { paths?: number[] }} input @returns {object} LayoutResult */
export function layout(input) {
  const { settlements, square } = input;
  const G = createTown(settlements, square);
  stampBlocks(G, settlements, pathsOf(input));
  buildRoads(G, settlements);
  const D = G.dock = dockSite(G);
  buildLand(G);
  dockShore(G);
  const { R, inBlock, seaDist, town } = G, { ox, oy, w, h, n, at, flags: F } = R;

  // the tiles: terrain everywhere (outside the raster is deep sea, `outside`), and outside blocks the ground, road
  // class and lot, with precedence square > ring > road to the square > dock footpath > dock clearing.
  const terrain = new Uint8Array(n), ground = new Uint8Array(n), road = new Uint8Array(n), lot = new Int8Array(n);
  const r = {
    isLand: (x, y) => { const t = at(x, y); return t >= 0 && (F[t] & LAND) !== 0; },
    isPath: (x, y) => { const t = at(x, y); return t >= 0 && (F[t] & PATH) !== 0; },
    seaDist: (x, y) => { const t = at(x, y); return t >= 0 ? seaDist[t] : -1; },
  };
  for (let i = 0, y = oy; y < oy + h; y++) for (let x = ox; x < ox + w; x++, i++) {
    terrain[i] = terrainAt(r, x, y);
    if (inBlock[i] >= 0) continue;
    const f = F[i];
    if (inRect(square, x, y)) { ground[i] = LAYOUT_GROUND.HUB; road[i] = ROAD.MAIN; lot[i] = LOT.HUB; continue; }
    if (f & RING) { ground[i] = LAYOUT_GROUND.EDGE; road[i] = ROAD.STREET; }
    else if (f & LANE) { ground[i] = LAYOUT_GROUND.ROUTE; road[i] = ROAD.LANE; }
    else if (f & FOOT) { ground[i] = LAYOUT_GROUND.ROUTE; road[i] = ROAD.PATH; }
    else if (f & DOCKC) ground[i] = LAYOUT_GROUND.VENUE;
    if (f & DOCKC) lot[i] = LOT.VENUE;
  }

  const [bx0, by0, bx1, by1] = G.bounds, [tx0, ty0, tx1, ty1] = town;
  return {
    bounds: { ox: bx0, oy: by0, w: bx1 - bx0, h: by1 - by0 },
    // the camera fit: the town proper with its ring roads (what the engine's townRect made of classic W.town)
    focus: { ox: tx0 - 1, oy: ty0 - 1, w: tx1 - tx0 + 3, h: ty1 - ty0 + 3 },
    tiles: { ox, oy, w, h, terrain, ground, road, lot },
    outside: 0,   // deep sea
    venues: { dock: dockVenue(D) },
    // town: [x0, y0, x1, y1] inclusive tiles (classic W.town); dock: the classic dock record (world.dock); waves: glints
    data: { dock: { ...D }, town: [...town], waves: G.waves },
  };
}
