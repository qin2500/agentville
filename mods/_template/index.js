// Your world. Copy of mods/_template, made by `node tools/mod.mjs new <id>`.
// Rules for this folder (docs/make-your-own-world.md):
//   - import engine code ONLY from '#agentville/mod'. Never from web/src/engine/** and never from another mod.
//   - keep hooks pure: no Math.random, no Date.now, no DOM. Use ctx.rng(stream), ctx.hash(s) and ctx.time.now.
//   - you own everything in mods/<your-id>/**.
import { API_VERSION } from '#agentville/mod';

// Data keys (rules, terrain, objects, behaviour, represent, venues) merge deeply over the mod you extend.
// Arrays replace. Leave a key out to inherit it.
const rules = {
  // layout: { accents: ['#e06666', '#6fa8dc'] },   // example: your own accent colours
};

// Hooks. Each one below calls the mod you extend, so a fresh copy behaves exactly like its parent.
// Replace one body at a time, rebuild with `node tools/mod.mjs check <id>`, and look at it with `shots`.
const hooks = {
  // How fast a project grows. Number in, number out.
  growth: (project, ctx) => ctx.parent.growth(project, ctx),
  // Which tier (0, 1, 2 ...) a growth score earns. prevTier lets you add hysteresis.
  tier: (growth, prevTier, ctx) => ctx.parent.tier(growth, prevTier, ctx),
  // How many lots a settlement of this tier gets for `need` items.
  capacity: (tier, need, ctx) => ctx.parent.capacity(tier, need, ctx),
  // Which homes and PR sites a project asks for: [{ item, owner, rank, agent?, pr?, building? }].
  lots: (project, agents, prs, ctx) => ctx.parent.lots(project, agents, prs, ctx),
  // How many crowns (boss slots) a project shows.
  crowns: (project, agents, ctx) => ctx.parent.crowns(project, agents, ctx),
  // The plan of one settlement: ground, lots, props, buildings. Hand-write this one to change the town shape.
  planSettlement: (req, ctx) => ctx.parent.planSettlement(req, ctx),
  // A per-project look; only `accent` is read by the engine, the rest is yours to feed your art.
  style: (projectKey, ctx, preset) => ctx.parent.style(projectKey, ctx, preset),

  // The land round the settlements: bounds, camera focus, terrain classes, roads, venue sites (LayoutResult in
  // web/src/engine/mod/api.js). Runs only when a block moves; ctx.time is not given. See docs/make-your-own-world.md.
  layout: (input, ctx) => ctx.parent.layout(input, ctx),

  // Wild decoration (trees, rocks ...) per tile. Ask first: ctx.api.has('scatter.at').
  // scatter: (tile, draw, ctx) => null,   // draw(k): a stable random number in [0, 1) for this tile
};

export default {
  id: 'example.template',          // reverse-DNS, not agentville.*; `tools/mod.mjs new` rewrites this
  name: 'Example Template',        // shown in the world picker
  version: '0.1.0',
  apiVersion: API_VERSION,
  extends: 'agentville.base',      // or 'agentville.fantasy' to start from the full village
  rules,
  hooks,
};
