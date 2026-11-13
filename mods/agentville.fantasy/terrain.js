// agentville.fantasy terrain table: the city-plan GROUND codes with walk cost, tags and debug colour (village-mods.md §6.1.4).
// OWNER: MOD0-Y. Pure data. Shape: TerrainTable (web/src/engine/mod/api.js).
// Tags: 'street' paved through-route, 'walk' actors may stand, 'water', 'over-water' stays walkable over sea terrain.
// `road` (optional, engine road class 1 PATH / 2 LANE / 3 STREET) is what plan-adapter writes to the road layer;
// a walkable type without it gets PATH.
import { GROUND } from '../../web/src/city-plan.js';

const G = GROUND;
const t = (code, name, cost, color, tags = [], road) => ({ code, name, cost, color, tags, ...(road ? { road } : {}) });

export const TERRAIN_TABLE = {
  types: [
    t(G.NONE, 'none', 255, null),
    t(G.GRASS, 'grass', 3, '#5f8a3c'),
    t(G.STREET, 'street', 1, '#8a8278', ['street', 'walk'], 3),
    t(G.LANE, 'lane', 1, '#8a7353', ['street', 'walk'], 2),
    t(G.PLAZA, 'plaza', 1, '#b4aa98', ['street', 'walk']),
    t(G.MARKET, 'market', 1, '#b89a6a', ['street', 'walk']),
    t(G.YARD, 'yard', 2, '#9a7d52', ['walk']),
    t(G.FIELD, 'field', 255, '#c9a640'),
    t(G.ORCHARD, 'orchard', 255, '#5f8a3c'),
    t(G.GARDEN, 'garden', 255, '#6f9a44'),
    t(G.LAWN, 'lawn', 4, '#5f9e4a'),
    t(G.PASTURE, 'pasture', 255, '#6f8f44'),
    t(G.WATER, 'water', 255, '#3a7ab0', ['water']),
    t(G.BRIDGE, 'bridge', 1, '#a39a8c', ['walk', 'over-water']),
    t(G.WALL, 'wall', 255, '#7a746e'),
    t(G.FLOWERS, 'flowers', 255, '#c97aa0'),
  ],
  byName: {},
  wildCost: 3,
  classes: undefined,   // set below, from CLASSES
};
for (const ty of TERRAIN_TABLE.types) TERRAIN_TABLE.byName[ty.name] = ty.code;

/** Terrain classes (api.js TerrainClass): the terrain layer codes this mod's layout writes. Today's codes and debug
 *  colours, unchanged (core/grid.js TERRAIN). forest-floor is not wild: wild scatter grows on it but it costs 255, as today. */
export const CLASSES = [
  { code: 0, name: 'deep-sea', water: true, color: '#10305a' },
  { code: 1, name: 'sea', water: true, color: '#1d5a8c' },
  { code: 2, name: 'shore', wild: true, color: '#d8c78a' },
  { code: 3, name: 'grass', wild: true, grows: true, color: '#5f8a3c' },
  { code: 4, name: 'forest-floor', grows: true, color: '#2f5a2a' },
];
TERRAIN_TABLE.classes = CLASSES;
