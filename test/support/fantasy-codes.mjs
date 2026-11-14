// TEST ONLY: the fantasy world's code names, which the engine no longer carries (MOD-READY C1 removed grid.js TERRAIN,
// GROUND_EXT and LOT_SQUARE / LOT_DOCK). Terrain codes come from the fantasy mod's own terrain classes; the ground and
// lot names are the fantasy words for the engine's generic LAYOUT_GROUND / LOT codes.
import { LAYOUT_GROUND, LOT } from '../../web/src/engine/core/grid.js';
import { CLASSES } from '../../mods/agentville.fantasy/terrain.js';

const code = name => {
  const c = CLASSES.find(k => k.name === name);
  if (!c) throw new Error(`fantasy terrain class ${name} missing`);
  return c.code;
};
export const TERRAIN = Object.freeze({ SEA_DEEP: code('deep-sea'), SEA: code('sea'), SHORE: code('shore'), GRASS: code('grass'), FOREST_FLOOR: code('forest-floor') });
export const GROUND_EXT = Object.freeze({ RING: LAYOUT_GROUND.EDGE, DOCK: LAYOUT_GROUND.VENUE, SQUARE: LAYOUT_GROUND.HUB, ROAD: LAYOUT_GROUND.ROUTE });
export const LOT_WILD = LOT.WILD, LOT_SQUARE = LOT.HUB, LOT_DOCK = LOT.VENUE;
