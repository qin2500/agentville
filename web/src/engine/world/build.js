// buildWorld: rules (every mod hook once, plain data: rules-phase.js) → settlements → sites → plans → stamp → lots → scatter → derived layers (design §1.3, village-mods.md §6.1.7).
// Pure, no DOM. The engine supplies the mechanics; every world rule comes from `mod`.
import { WorldGrid, makeCostFn } from '../core/grid.js';
import { ObjectStore } from '../core/objects.js';
import { planSettlements, placeBlocks } from './sites.js';
import { runLayout, stampLayout } from './layout.js';
import { runRules } from './rules-phase.js';
import { stampPlan } from './plan-adapter.js';
import { assignLots } from './lots.js';
import { scatterWild } from './scatter.js';
import { computeCover } from './cover.js';
import { buildVenues } from './venue.js';
import { resolveMod, modCtx } from '../mod/registry.js';

/** Mutates `persisted` (the caller saves it).
 * @param {import('../mod/api.js').WorldInput} input sanitised input (mod/input.js)
 * @param {{ mod?: object, now?: number, seed?: number, forcedTier?: number|null, forcedStyle?: number|null, serverId?: (opaque: string) => string,
 *   rules?: import('./rules-phase.js').RulesResult }} opts  rules: runRules(...) for this same input/persisted/now/seed (the caller
 *   computed it already, e.g. for the sig); when absent it is computed here. Either way no hook runs twice per rebuild.
 * @returns {World} { version, sig, mod, grid, objects: ObjectStore, villages, square, parks, venues, bounds, focus, layoutData, lint }
 *   (plus a COMPAT field that nav/index.js reads until its venue diff lands: the layout's data record of that name)
 *   venues: built here (world/venue.js) from the layout's frozen venue SITES (sites.venues), never written into them. */
export function buildWorld(input, persisted, { mod = resolveMod(), now, seed, forcedTier = null, forcedStyle = null, serverId = id => id, rules = null, cache = null } = {}) {
  now ??= input?.now ?? 0;
  seed ??= persisted?.seed ?? input?.seed ?? 0;
  persisted.lots ||= {};
  const ctxFor = projectKey => modCtx(mod, { seed, now, projectKey, forcedTier, forcedStyle });
  const opts = { now, seed, forcedTier, forcedStyle, serverId, ctxFor };
  rules ??= runRules(input, persisted, mod, opts);
  const { settlements, sig } = planSettlements(input, persisted, mod, opts, rules);
  // blocks (engine mechanism), then the mod's layout round them (hooks.layout, memoised in `cache`; world/layout.js)
  const placed = placeBlocks(settlements, persisted, mod, { now, ctxFor, seed, cache });
  const sites = runLayout(placed, mod, { seed, cache });
  const grid = new WorldGrid(sites.bounds);
  stampLayout(grid, sites);
  const objects = new ObjectStore(), lint = [...(rules.lint || []), ...sites.lint];
  for (const v of sites.villages) {
    const r = stampPlan(grid, objects, v.plan, v.origin, { mod, name: v.name, index: v.index, tier: v.tier, style: v.style, cache });
    lint.push(...r.lint);
  }
  // owners: who lives in which lot. Geometry is never touched.
  for (const v of sites.villages) {
    const { byLot, items } = assignLots(v, persisted.lots, now, mod);
    for (const [lotId, item] of byLot) {
      const o = objects.get(`lot:${v.name}:${lotId}`);
      if (!o) continue;
      const own = items.get(item);
      o.data = { item, ...own };
      // A crown estate is an L lot whose home belongs to a crowned agent (the boss); the mod may draw it as another model
      // while the crown lives there (mod.rules.crownModel).
      if (o.rank === 'L' && own.owner === 'home' && v.homes.find(a => a.id === own.agentId)?.crown) { o.crown = true; if (mod.rules?.crownModel) o.model = mod.rules.crownModel; }
    }
    for (const o of objects.values()) if (o.kind === 'building' && o.project === v.name && o.lot && o.id.startsWith('lot:') && !o.data) o.data = { item: null, owner: 'house' };
  }
  // venues (MOD-READY P6): every layout venue site whose kind the mod defines gets its level, plan, nodes and berths
  const venues = buildVenues({ grid, objects }, sites, input, mod, persisted, ctxFor(''), { seed });
  lint.push(...venues.lint);
  computeCover(grid, objects);                   // buildings only, so scatter can keep trees out of hidden tiles
  if (mod.hooks?.scatter) scatterWild(grid, objects, sites, seed, mod, ctxFor(null));   // wild scatter is optional: a mod without it gets bare wilds
  grid.bakeCost(null, makeCostFn(mod.terrain));
  computeCover(grid, objects);                   // final, with trees
  // anchors: people stand only where the grid lets them (walkable, free, visible); every door gets two stand slots
  const stands = (tx, ty) => grid.inBounds(tx, ty) && grid.get('occ', tx, ty) === 0 && grid.get('cost', tx, ty) < 255 && grid.get('cover', tx, ty) === 0;
  for (const o of objects.values()) {
    if (o.kind === 'building' && o.door && stands(o.door.tx, o.door.ty)) {
      o.anchors = { ...(o.anchors || {}), stand: [0, 1].map(sub => ({ tx: o.door.tx, ty: o.door.ty, sub, face: 0 })) };
    }
    if (!o.anchors) continue;
    for (const k of Object.keys(o.anchors)) {
      o.anchors[k] = o.anchors[k].filter(s => stands(s.tx, s.ty));
      if (!o.anchors[k].length) delete o.anchors[k];
    }
    if (!Object.keys(o.anchors).length) delete o.anchors;
  }
  for (const o of objects.values()) {
    if (o.kind !== 'building' || !o.door) continue;
    for (const k of [1, 2]) {
      const x = o.door.tx + k, y = o.door.ty + k;
      if (grid.get('cover', o.door.tx, o.door.ty) > 0 || grid.get('cover', x, y) > 0) {
        lint.push({ kind: 'covered-forecourt', id: o.id, project: o.project, reason: 'a door forecourt tile is hidden behind a building', from: [o.door.tx, o.door.ty] });
        break;
      }
    }
  }
  return { version: grid.version, sig, mod, grid, objects, villages: sites.villages, square: sites.square, parks: sites.parks,
    venues: venues.venues, bounds: sites.bounds, focus: sites.focus, layoutData: sites.data, lint };
}
