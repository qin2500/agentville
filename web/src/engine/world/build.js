// buildWorld: rules (every mod hook once, plain data: rules-phase.js) → settlements → sites → plans → stamp → lots → scatter → derived layers (design §1.3, village-mods.md §6.1.7).
// Pure, no DOM. The engine supplies the mechanics; every world rule comes from `mod`.
import { WorldGrid, makeCostFn } from '../core/grid.js';
import { ObjectStore } from '../core/objects.js';
import { planSettlements, placeBlocks } from './sites.js';
import { runLayoutSteps, stampLayout } from './layout.js';
import { runRules } from './rules-phase.js';
import { stampPlan } from './plan-adapter.js';
import { assignLots } from './lots.js';
import { scatterWildSteps } from './scatter.js';
import { computeCover } from './cover.js';
import { buildVenues } from './venue.js';
import { addSiteWork } from './site-work.js';
import { resolveMod, modCtx } from '../mod/registry.js';
import { distinctPicks } from '../render/accent.js';
import { drainSync } from '../core/slices.js';

/** Mutates `persisted` (the caller saves it).
 * @param {import('../mod/api.js').WorldInput} input sanitised input (mod/input.js)
 * @param {{ mod?: object, now?: number, seed?: number, forcedTier?: number|null, forcedStyle?: number|null, serverId?: (opaque: string) => string,
 *   rules?: import('./rules-phase.js').RulesResult }} opts  rules: runRules(...) for this same input/persisted/now/seed (the caller
 *   computed it already, e.g. for the sig); when absent it is computed here. Either way no hook runs twice per rebuild.
 * @returns {World} { version, sig, mod, grid, objects: ObjectStore, villages, square, parks, venues, bounds, focus, layoutData, lint }
 *   (plus a COMPAT field that nav/index.js reads until its venue diff lands: the layout's data record of that name)
 *   venues: built here (world/venue.js) from the layout's frozen venue SITES (sites.venues), never written into them. */
export function buildWorld(input, persisted, opts) {
  return drainSync(buildWorldSteps(input, persisted, opts));
}

/** buildWorld as a step generator (PERF M7): the same work in the same order, with a `yield` between stages so
 * the cold build can run in slices (core/slices.js drainSliced, via world-steps.js). Drained at once it IS buildWorld.
 * Yield labels (for debugging only): 'rules' (only when it runs them), 'settlements', 'blocks', 'layout', 'stamp' (per
 * village), 'lots' (per village), 'venues', 'cover', 'scatter' (when the mod scatters), 'cost', 'cover-final', 'anchors'.
 * Returns the World. */
export function* buildWorldSteps(input, persisted, { mod = resolveMod(), now, seed, forcedTier = null, forcedStyle = null, serverId = id => id, rules = null, cache = null } = {}) {
  now ??= input?.now ?? 0;
  seed ??= persisted?.seed ?? input?.seed ?? 0;
  persisted.lots ||= {};
  const ctxFor = projectKey => modCtx(mod, { seed, now, projectKey, forcedTier, forcedStyle });
  const opts = { now, seed, forcedTier, forcedStyle, serverId, ctxFor };
  if (!rules) { rules = runRules(input, persisted, mod, opts); yield 'rules'; }
  const { settlements, sig } = planSettlements(input, persisted, mod, opts, rules);
  yield 'settlements';
  // blocks (engine mechanism), then the mod's layout round them (hooks.layout, memoised in `cache`; world/layout.js)
  const placed = placeBlocks(settlements, persisted, mod, { now, ctxFor, seed, cache });
  yield 'blocks';
  const sites = yield* runLayoutSteps(placed, mod, { seed, cache });
  applyStyleNeighbours(sites.villages, mod);
  const grid = new WorldGrid(sites.bounds);
  stampLayout(grid, sites);
  yield 'layout';
  const objects = new ObjectStore(), lint = [...(rules.lint || []), ...sites.lint];
  for (const v of sites.villages) {
    const r = stampPlan(grid, objects, v.plan, v.origin, { mod, name: v.name, index: v.index, tier: v.tier, style: v.style, cache });
    lint.push(...r.lint);
    yield 'stamp';
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
    yield 'lots';
  }
  // venues (MOD-READY P6): every layout venue site whose kind the mod defines gets its level, plan, nodes and berths
  const venues = buildVenues({ grid, objects }, sites, input, mod, persisted, ctxFor(''), { seed });
  lint.push(...venues.lint);
  yield 'venues';
  computeCover(grid, objects);                   // buildings only, so scatter can keep trees out of hidden tiles
  yield 'cover';
  if (mod.hooks?.scatter) { yield* scatterWildSteps(grid, objects, sites, seed, mod, ctxFor(null)); yield 'scatter'; }   // wild scatter is optional: a mod without it gets bare wilds
  grid.bakeCost(null, makeCostFn(mod.terrain));
  yield 'cost';
  computeCover(grid, objects);                   // final, with trees
  yield 'cover-final';
  addSiteWork(grid, objects, mod);
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
  yield 'anchors';
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

/** Optional mod hook `hooks.styleNeighbours(styles: Map<project, style>, blocks, distinctPicks) -> Map<project, style>`: lets a mod vary
 * adjacent blocks' styles once the layout has placed them. The engine injects its neighbour picker (render/accent.js); a throwing
 * hook or a bad answer leaves the styles as the rules phase made them. */
function applyStyleNeighbours(villages, mod) {
  const hook = mod.hooks?.styleNeighbours;
  if (typeof hook !== 'function') return;
  const withStyle = villages.filter(v => v.style && typeof v.style === 'object' && v.block);
  if (withStyle.length < 2) return;
  try {
    const out = hook(new Map(withStyle.map(v => [v.name, v.style])), withStyle.map(v => ({ name: v.name, x: v.block.x, y: v.block.y, w: v.block.w, h: v.block.h })), distinctPicks);
    if (out instanceof Map) for (const v of withStyle) { const s = out.get(v.name); if (s && typeof s === 'object') v.style = s; }
  } catch { /* keep the rules-phase styles */ }
}
