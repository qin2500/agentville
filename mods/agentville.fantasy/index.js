// agentville.fantasy: the default world (today's fantasy village) as a bundled, trusted mod (village-mods.md §2, §6.1).
// Imports only its own files, classic pure modules (city-plan.js, styles-pool.js, important.js) and nothing
// from web/src/engine except api.js constants.
//   behaviour, represent: declarative data (deep-merged and frozen by the registry like rules/terrain/objects).
//   ambient: CODE (behaviour modules + a spawn function), hooks-like; it runs in-process today because this mod is
//            bundled and trusted, and must move behind the sandbox with the other hooks (MOD-2).
import { RULES, HOOKS } from './rules.js';
import { TERRAIN_TABLE } from './terrain.js';
import { OBJECT_TYPES } from './objects.js';
import { BEHAVIOUR, POSES, CUES, siteWorkAnchors } from './represent.js';
import { REPRESENT } from './represent-pr.js';
import { lightsFor, extraLights } from './lights.js';
import { layout } from './layout/index.js';
import { scatter } from './scatter.js';
import { VENUES } from './venues.js';
import { PERSIST } from './persist.js';
import { ACTORS as ACTORS_FALLBACK_DECL } from './actors-fallback.js';
import { FOLK_PARTS, FOLK_ANIMS } from './art/folk-parts.js';
import { lookOf as folkLookOf } from './art/looks.js';
import { ground } from './ground.js';
import { events } from './events.js';
import townsfolk, { spawnTownsfolk } from './ambient/townsfolk.js';
import cart, { spawnCarts } from './ambient/cart.js';
import critter, { spawnCritters } from './ambient/critter.js';
import ship, { tug, rowboat, gull, spawnHarbourLife } from './ambient/ship.js';
import porter, { spawnPorters } from './ambient/porter.js';

/** Every ambient actor spec for a world; r(...keys) is the sim's stateless ambient rand. 'token' actors (one ship per PR at
 *  a harbour berth) are made by the engine (sim/tokens.js), not here; their behaviour is ship.js. */
function spawn(world, r) {
  return [...spawnTownsfolk(world, r), ...spawnCarts(world, r), ...spawnCritters(world, r), ...spawnHarbourLife(world, r), ...spawnPorters(world, r)];
}

/** mod.actors: paper-doll folk (M6 P2) over the Ninja Adventure sticker fallback. */
export const ACTORS = Object.freeze({ parts: FOLK_PARTS, anims: FOLK_ANIMS, lookOf: folkLookOf, size: Object.freeze({ w: 16, h: 24 }), fallback: ACTORS_FALLBACK_DECL.fallback });

export const AMBIENT = Object.freeze({ behaviours: Object.freeze({ folk: townsfolk, cart, critter, token: ship, tug, rowboat, gull, porter }), spawn });

export default {
  id: 'agentville.fantasy', name: 'Agentville Fantasy', version: '1.0.0', apiVersion: 1, extends: 'agentville.base',
  features: ['prs.loading'],   // opt in: open PRs arrive as state 'loading' + live (the venues, level and represent.pr read it)
  rules: RULES, terrain: TERRAIN_TABLE, objects: OBJECT_TYPES, hooks: { ...HOOKS, layout, scatter },
  behaviour: BEHAVIOUR, represent: { ...REPRESENT, poses: POSES, cues: CUES }, venues: VENUES, persist: PERSIST, ambient: AMBIENT, ground,
  actors: ACTORS,
  events,   // M6 P4: world events (merge confetti, found banner + dust, tier-up scaffolds + cheers)
  siteWork: siteWorkAnchors,   // builders-cap-4-per-site: work anchors round a PR site (world/site-work.js); extras wait at the yard
  lightsFor, extraLights,   // night pools (lights.js): per-object seam for createLighting({ lightsFor }) + plaza/square/villager pools
};
