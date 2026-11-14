import './support/ensure-mods-index.mjs';
// Sim invariants for the v2 engine (design docs/village-engine-v2.md §4, invariant 4 walk-through over 600 ticks, D4).
// Written from the spec, not the implementation. sim/world-sim.js and nav/index.js are imported lazily; tests skip when missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { ANIMS } = await import('../web/src/engine/sim/actor.js');

const SEED = 7, DT = 0.05, TICKS = 600;
const SIM = new URL('../web/src/engine/sim/world-sim.js', import.meta.url);
const NAV = new URL('../web/src/engine/nav/index.js', import.meta.url);
const missing = !fs.existsSync(SIM) || !fs.existsSync(NAV) ? 'sim/world-sim.js or nav/index.js not present on this branch yet' : false;
const fx = loadFixture('citydemo.json');
const skip = missing || (fx ? false : 'e2e/fixtures/engine/citydemo.json not present');

// The registry's resolved mod does not carry behaviour/represent/ambient yet (registry.js resolveMod builds the object
// field by field); fill them from the fantasy mod so the sim runs the real declarative tables and ambient life.
function fantasyMod() {
  const m = resolveMod();
  return { ...m, behaviour: m.behaviour ?? fantasy.behaviour, represent: m.represent ?? fantasy.represent, ambient: m.ambient ?? fantasy.ambient };
}

async function make(seed = SEED, mutate) {
  const { createSim } = await import(SIM.href), { createNav } = await import(NAV.href);
  const view = viewFromFixture(fx);
  const { input, serverId } = toWorldInput(view, { seed, salt: String(seed) });
  const world = buildWorld(input, { v: 1, seed, blocks: {}, lots: {} }, { now: fx.now, seed, serverId });
  const nav = createNav(world);
  const sim = createSim({ world, nav, seed, mod: fantasyMod(), serverId, clock: { dayLength: 60, phase0: 0.3 } });
  sim.applySnapshot(mutate ? mutate(input) : input);
  return { sim, world, input };
}
const agentsOf = sim => [...sim.actors.values()].filter(a => a.kind === 'agent');
const ambientOf = sim => [...sim.actors.values()].filter(a => a.kind !== 'agent');
const tileOf = a => [Math.floor(a.x), Math.floor(a.y)];
const snap = sim => [...sim.actors.values()].map(a => `${a.id}:${a.x.toFixed(4)},${a.y.toFixed(4)}`).sort().join('|');
const run = (sim, n, each) => { for (let i = 0; i < n; i++) { sim.tick(DT); each?.(i); } };

test('actors of kind agent equal the agent count', { skip }, async () => {
  const { sim, input } = await make();
  run(sim, 1);
  assert.equal(agentsOf(sim).length, input.agents.length);
});

test('inv4: over 600 ticks no agent stands on cost 255 or inside a building footprint', { skip }, async () => {
  const { sim, world } = await make();
  const g = world.grid;
  const blockers = [...world.objects.values()].filter(o => o.walk === 'block');
  const inside = (o, x, y) => x >= o.tx && y >= o.ty && x < o.tx + o.w && y < o.ty + o.h;
  run(sim, TICKS, i => {
    for (const a of agentsOf(sim)) {
      const [tx, ty] = tileOf(a);
      assert.ok(g.inBounds(tx, ty), `tick ${i}: ${a.id} left the grid at ${a.x},${a.y}`);
      assert.ok(g.get('cost', tx, ty) < 255, `tick ${i}: ${a.id} on cost-255 tile ${tx},${ty}`);
      assert.equal(g.get('occ', tx, ty), 0, `tick ${i}: ${a.id} on occ tile ${tx},${ty}`);
      const hit = blockers.find(o => inside(o, tx, ty));
      assert.ok(!hit, `tick ${i}: ${a.id} inside footprint of ${hit?.id}`);
    }
  });
});

test('stalled and error agents never move after placement', { skip }, async () => {
  const { sim, input } = await make();
  const fixed = new Set(input.agents.filter(a => a.status === 'stalled' || a.status === 'error').map(a => a.id));
  assert.ok(fixed.size > 0, 'fixture has stalled/error agents');
  run(sim, 1);                                   // placement
  const start = new Map();
  for (const a of agentsOf(sim)) if (fixed.has(a.agentId ?? a.id)) start.set(a.id, [a.x, a.y]);
  assert.ok(start.size > 0, 'stalled/error actors exist');
  run(sim, TICKS, i => {
    for (const [id, [x, y]] of start) {
      const a = sim.actors.get(id);
      assert.ok(a.x === x && a.y === y, `tick ${i}: ${id} moved from ${x},${y} to ${a.x},${a.y}`);
    }
  });
});

test('same seed gives identical actor positions after 600 ticks', { skip }, async () => {
  const A = await make(), B = await make();
  run(A.sim, TICKS); run(B.sim, TICKS);
  assert.equal(snap(A.sim), snap(B.sim));
});

test('waiting -> building: the actor reaches its work place (or fades) within 2 s of sim time', { skip }, async () => {
  const { sim, input } = await make();
  const victim = input.agents.find(a => a.status === 'waiting' && !a.prs.length) || input.agents.find(a => a.status === 'waiting');
  assert.ok(victim, 'fixture has a waiting agent');
  run(sim, 40);                                  // settle on the bench
  const actor = () => agentsOf(sim).find(a => (a.agentId ?? a.id) === victim.id);
  const before = [actor().x, actor().y];
  const next = { ...input, agents: input.agents.map(a => (a.id === victim.id ? { ...a, status: 'working' } : a)) };
  sim.applySnapshot(next);
  let reacted = false;
  run(sim, 40, () => {                           // 40 x 50 ms = 2 s
    const a = actor();
    const moved = Math.hypot(a.x - before[0], a.y - before[1]) > 0.25;
    const faded = (a.flags & 16) !== 0 || a.fade != null || a.alpha < 1;
    if (moved || faded || a.anim === 'walk' || a.anim === 'hammer') reacted = true;
  });
  assert.ok(reacted, 'actor did not walk, hammer or fade within 2 s of the status change');
  run(sim, 100);                                 // 5 s more: it has arrived or teleported by now
  const a = actor();
  assert.ok(Math.hypot(a.x - before[0], a.y - before[1]) > 0.25 || a.anim === 'hammer', 'actor is still at its old place');
});

test('ambient life spawns from the fantasy mod: folk, carts and critters', { skip }, async () => {
  const { sim } = await make();
  const kinds = new Set(ambientOf(sim).map(a => a.kind));
  for (const k of ['folk', 'critter']) assert.ok(kinds.has(k), `no ${k} spawned`);
  assert.ok(kinds.has('cart') || !fx, 'carts spawn in a town of tier >= 2');
});

test('inv4 (ambient): over 600 ticks folk, carts and critters never stand on blocked tiles, and some of them move', { skip }, async () => {
  const { sim, world } = await make();
  const g = world.grid;
  const blockers = [...world.objects.values()].filter(o => o.walk === 'block');
  const inside = (o, x, y) => x >= o.tx && y >= o.ty && x < o.tx + o.w && y < o.ty + o.h;
  const start = new Map(ambientOf(sim).map(a => [a.id, [a.x, a.y]]));
  assert.ok(start.size > 0, 'ambient actors exist');
  const check = i => {
    for (const a of ambientOf(sim)) {
      if (a.flags & 8) continue;                     // indoors: not standing anywhere
      const [tx, ty] = tileOf(a);
      assert.ok(g.inBounds(tx, ty), `tick ${i}: ${a.id} left the grid at ${a.x},${a.y}`);
      assert.ok(g.get('cost', tx, ty) < 255, `tick ${i}: ${a.id} on cost-255 tile ${tx},${ty}`);
      assert.equal(g.get('occ', tx, ty), 0, `tick ${i}: ${a.id} on occ tile ${tx},${ty}`);
      const hit = blockers.find(o => inside(o, tx, ty));
      assert.ok(!hit, `tick ${i}: ${a.id} inside footprint of ${hit?.id}`);
    }
  };
  check(-1);
  run(sim, TICKS, check);
  const moved = ambientOf(sim).filter(a => { const s = start.get(a.id); return s && (s[0] !== a.x || s[1] !== a.y); });
  assert.ok(moved.length > 0, 'no ambient actor moved in 30 s');
});

test('every actor shows only §4.1 anim values; carts stay on road tiles', { skip }, async () => {
  const { sim, world } = await make();
  const ok = new Set(ANIMS);
  run(sim, TICKS, i => {
    for (const a of sim.actors.values()) {
      assert.ok(ok.has(a.anim), `tick ${i}: ${a.id} anim ${a.anim}`);
      if (a.kind === 'cart') assert.ok(world.grid.get('road', ...tileOf(a)) >= 2, `tick ${i}: ${a.id} off road at ${a.x},${a.y}`);
    }
  });
});

test('determinism holds with ambient actors (positions, anims, facings)', { skip }, async () => {
  const A = await make(), B = await make();
  run(A.sim, TICKS); run(B.sim, TICKS);
  const full = sim => [...sim.actors.values()].map(a => `${a.id}:${a.x.toFixed(4)},${a.y.toFixed(4)},${a.anim},${a.face},${a.state}`).sort().join('|');
  assert.equal(full(A.sim), full(B.sim));
});
