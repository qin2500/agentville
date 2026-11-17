import './support/ensure-mods-index.mjs';
// M3 ambient behaviour: carts reserve their way, townsfolk share flow fields, night lanterns, stable spawn ids, tier counts.
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { createSim } = await import('../web/src/engine/sim/world-sim.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { spawnTownsfolk, COUNT_BY_TIER, carriesLantern } = await import('../mods/agentville.fantasy/ambient/townsfolk.js');
const { spawnCarts } = await import('../mods/agentville.fantasy/ambient/cart.js');
const { spawnCritters } = await import('../mods/agentville.fantasy/ambient/critter.js');

const fx = loadFixture('citydemo.json');
const skip = fx ? false : 'citydemo.json missing';
const SEED = 7, DT = 0.05;
const mod = () => { const m = resolveMod(); return { ...m, behaviour: m.behaviour ?? fantasy.behaviour, represent: m.represent ?? fantasy.represent, ambient: m.ambient ?? fantasy.ambient }; };
function build(seed = SEED) {
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed, salt: String(seed) });
  const world = buildWorld(input, { v: 1, seed, blocks: {}, lots: {} }, { now: fx.now, seed, serverId });
  return { input, serverId, world };
}
const mk = (seed = SEED, clock = { dayLength: 60, phase0: 0.3 }) => {
  const { input, serverId, world } = build(seed);
  const nav = createNav(world);
  const sim = createSim({ world, nav, seed, mod: mod(), serverId, clock });
  sim.applySnapshot(input);
  return { sim, world, nav };
};
const rnd = (...k) => { let h = 2166136261; for (const c of k.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

test('carts never share a tile with a pedestrian over 600 ticks (citydemo)', { skip }, () => {
  for (const seed of [SEED, 3, 11]) run600(seed);
});
function run600(seed) {
  const { sim } = mk(seed);
  let cartTicks = 0, moving = 0;
  for (let i = 0; i < 600; i++) {
    sim.tick(DT);
    const peds = [...sim.actors.values()].filter(a => (a.kind === 'agent' || a.kind === 'folk') && !(a.flags & 8) && !(a.flags & 16) && !a.fade);
    for (const c of [...sim.actors.values()].filter(a => a.kind === 'cart')) {
      cartTicks++; if (c.path) moving++;
      for (const p of peds) assert.ok(Math.floor(p.x) !== Math.floor(c.x) || Math.floor(p.y) !== Math.floor(c.y), `tick ${i}: ${c.id} and ${p.id} share tile ${Math.floor(c.x)},${Math.floor(c.y)}`);
    }
  }
  assert.ok(cartTicks > 0, 'the fixture has carts');
}

test('a cart yields to a pedestrian within 2 cells ahead and resumes when it leaves', () => {
  const road = new Uint8Array(30 * 10); for (let x = 0; x < 30; x++) road[5 * 30 + x] = 2;
  const grid = { inBounds: (x, y) => x >= 0 && y >= 0 && x < 30 && y < 10, get: (l, x, y) => (l === 'road' ? road[y * 30 + x] : 0) };
  const cart = { x: 2.5, y: 5.5, path: Float32Array.from([3.5, 5.5, 4.5, 5.5, 5.5, 5.5, 6.5, 5.5]), pathI: 0, state: 'go', cart: {}, flags: 1 };
  const ped = { id: 'p', kind: 'folk', x: 4.5, y: 5.5, flags: 1 };
  return import('../mods/agentville.fantasy/ambient/cart.js').then(({ default: beh }) => {
    const ctx = { world: { grid }, actors: new Map([['p', ped]]), rand: () => 0.5, now: 0, night: false };
    cart.id = 'c'; cart.arrived = false;
    beh.update(cart, 0.05, ctx);
    assert.equal(cart.state, 'yield'); assert.equal(cart.path, undefined);
    ped.x = 20.5; ped.y = 1.5;
    beh.update(cart, 0.05, ctx);
    assert.equal(cart.state, 'go'); assert.ok(cart.path && cart.path.length === 8);
  });
});

test('lantern carriers: ~20% by stable id hash, fx only while night and outdoors', { skip }, () => {
  let n = 0; for (let i = 0; i < 4000; i++) if (carriesLantern(`folk:town${i % 40}:${i}`)) n++;
  assert.ok(n / 4000 > 0.17 && n / 4000 < 0.23, `share ${n / 4000}`);
  assert.equal(carriesLantern('folk:a:1'), carriesLantern('folk:a:1'));
  const { sim } = mk(SEED, { dayLength: 60, phase0: 0.3 });   // night = phase 0.75..1.1 -> 27 s .. 39 s
  let seenNight = 0, seenDay = 0;
  const folk = () => [...sim.actors.values()].filter(a => a.kind === 'folk');
  assert.ok(folk().length > 0);
  for (let i = 0; i < 1300; i++) {
    sim.tick(DT);
    const phase = (0.3 + (sim.now - DT) / 60) % 1, night = phase >= 0.75 || phase < 0.1;
    for (const a of folk()) {
      if (a.fx?.includes('lantern')) { assert.ok(night, `lantern by day: ${a.id} at ${i}`); assert.ok(carriesLantern(a.id)); assert.ok(!(a.flags & 8)); seenNight++; }
      else if (!night) seenDay++;
    }
  }
  assert.ok(seenNight > 0, 'someone carried a lantern at night');
  assert.ok(seenDay > 0);
});

test('spawn ids are identical across two builds and stable under village reordering', { skip }, () => {
  const ids = () => { const { world } = build(); const r = (...k) => rnd('ambient', ...k); return [...spawnTownsfolk(world, r), ...spawnCarts(world, r), ...spawnCritters(world, r)].map(s => s.id); };
  const a = ids(), b = ids();
  assert.deepEqual(a, b);
  assert.ok(a.length > 0 && new Set(a).size === a.length);
  const { world } = build(); const r = (...k) => rnd('ambient', ...k);
  const rev = { ...world, villages: [...world.villages].reverse() };
  const base = [...spawnTownsfolk(world, r), ...spawnCarts(world, r), ...spawnCritters(world, r)].map(s => s.id).sort();
  const flipped = [...spawnTownsfolk(rev, r), ...spawnCarts(rev, r), ...spawnCritters(rev, r)].map(s => s.id).sort();
  assert.deepEqual(flipped, base);
});

test('townsfolk count by tier is 2/5/10/18', { skip }, () => {
  assert.deepEqual(COUNT_BY_TIER, [2, 5, 10, 18]);
  const { world } = build();
  for (const v of world.villages) {
    const tier = Math.max(0, Math.min(3, v.tier ?? 0));
    const n = spawnTownsfolk(world, (...k) => rnd(...k)).filter(s => s.project === v.name).length;
    assert.ok(n === 0 || n === COUNT_BY_TIER[tier], `${v.name} tier ${tier}: ${n}`);
  }
});

test('townsfolk heading to the square ask ctx.nav.flowTo', { skip }, () => {
  const { sim, nav } = mk();
  const asked = []; const orig = nav.flowTo;
  nav.flowTo = d => { asked.push(d); return orig(d); };
  for (let i = 0; i < 1200; i++) sim.tick(DT);
  assert.ok(asked.includes('square'), 'flowTo(square) used');
});

// M3 review: a cart must never wait forever on a settled actor (bench sitter, chatting folk) that holds its road.
// Overlap is asserted only against stationary pedestrians (a walking folk stepping onto a cart tile is townsfolk.js; the baseline does it too).
const { makeSim: makeSimH, loadFixture: loadFx, advance: adv } = await import('./engine-support/sim-harness.mjs');
function maxYield(name, ticks = 6000) {
  const f = loadFx(name); if (!f) return null;
  const { sim } = makeSimH(f, { seed: 7 });
  const run = new Map(); let max = 0, carts = 0;
  for (let i = 0; i < ticks; i++) {
    adv(sim);
    const peds = [...sim.actors.values()].filter(a => (a.kind === 'agent' || a.kind === 'folk') && !(a.flags & 8) && !(a.flags & 16) && !a.fade);
    for (const c of sim.actors.values()) {
      if (c.kind !== 'cart') continue;
      if (i === 0) carts++;
      const r = c.state === 'yield' ? (run.get(c.id) || 0) + 1 : 0; run.set(c.id, r); if (r > max) max = r;
      for (const p of peds) if (Math.floor(p.x) === Math.floor(c.x) && Math.floor(p.y) === Math.floor(c.y) && c.path && !p.path) assert.fail(`tick ${i}: ${c.id} moving on ${p.id}'s tile`);
    }
  }
  return max * DT;
}
test('no cart yields for more than 10 s straight (busy)', () => {
  const m = maxYield('busy.json'); if (m == null) return;
  assert.ok(m <= 10, `max yield ${m}s`);
});
test('no cart yields for more than 10 s straight (stress)', { skip: process.env.ENGINE_SLOW ? false : 'set ENGINE_SLOW=1' }, () => {
  const m = maxYield('stress.json'); if (m == null) return;
  assert.ok(m <= 10, `max yield ${m}s`);
});
