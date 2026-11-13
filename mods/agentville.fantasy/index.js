// agentville.fantasy: the default world (today's fantasy village) as a bundled, trusted mod (village-mods.md §2, §6.1).
// OWNER: MOD0-X. Imports only its own files, classic pure modules (city-plan.js, styles-pool.js, important.js) and nothing
// from web/src/engine except api.js constants.
//   behaviour, represent: declarative data (deep-merged and frozen by the registry like rules/terrain/objects).
//   ambient: CODE (behaviour modules + a spawn function), hooks-like; it runs in-process today because this mod is
//            bundled and trusted, and must move behind the sandbox with the other hooks (MOD-2).
import { RULES, HOOKS } from './rules.js';
import { TERRAIN_TABLE } from './terrain.js';
import { OBJECT_TYPES } from './objects.js';
import { BEHAVIOUR, POSES, CUES } from './represent.js';
import { REPRESENT } from './represent-pr.js';
import { layout } from './layout/index.js';
import { scatter } from './scatter.js';
import { VENUES } from './venues.js';
import { PERSIST } from './persist.js';
import townsfolk, { spawnTownsfolk } from './ambient/townsfolk.js';
import cart, { spawnCarts } from './ambient/cart.js';
import critter, { spawnCritters } from './ambient/critter.js';

/** Every ambient actor spec for a world; r(...keys) is the sim's stateless ambient rand. */
function spawn(world, r) {
  return [...spawnTownsfolk(world, r), ...spawnCarts(world, r), ...spawnCritters(world, r)];
}

export const AMBIENT = Object.freeze({ behaviours: Object.freeze({ folk: townsfolk, cart, critter }), spawn });

export default {
  id: 'agentville.fantasy', name: 'Agentville Fantasy', version: '1.0.0', apiVersion: 1, extends: 'agentville.base',
  rules: RULES, terrain: TERRAIN_TABLE, objects: OBJECT_TYPES, hooks: { ...HOOKS, layout, scatter },
  behaviour: BEHAVIOUR, represent: { ...REPRESENT, poses: POSES, cues: CUES }, venues: VENUES, persist: PERSIST, ambient: AMBIENT,
};
