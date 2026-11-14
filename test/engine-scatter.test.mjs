import './support/ensure-mods-index.mjs';
// scatterWild uses stateless rand(seed, mod.id, 'scatter', x, y, k) draws (no per-tile RNG stream).
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { scatterWild } = await import('../web/src/engine/world/scatter.js');
const { WorldGrid } = await import('../web/src/engine/core/grid.js');
const { TERRAIN } = await import('./support/fantasy-codes.mjs');
const { ObjectStore } = await import('../web/src/engine/core/objects.js');
const { OBJECT_TYPES } = await import('../mods/agentville.fantasy/objects.js');
const { scatter } = await import('../mods/agentville.fantasy/scatter.js');
const { TERRAIN_TABLE } = await import('../mods/agentville.fantasy/terrain.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

const mod = { id: 'toy', objects: OBJECT_TYPES, terrain: TERRAIN_TABLE, hooks: { scatter } };   // classes say what grows
const run = (seed, m = mod) => {
  const grid = new WorldGrid({ ox: 0, oy: 0, w: 60, h: 60 }), store = new ObjectStore();
  grid.terrain.fill(TERRAIN.GRASS);
  const n = scatterWild(grid, store, {}, seed, m);
  return { n, sig: [...store.values()].map(o => `${o.id}:${o.model}:${o.variant}`).join('|') };
};

test('same seed gives identical objects, different seeds differ', () => {
  const a = run(5), b = run(5), c = run(6);
  assert.ok(a.n > 20);
  assert.equal(a.sig, b.sig);
  assert.notEqual(a.sig, c.sig);
});

test('a mod without a scatter hook gets no scatter from scatterWild', () => {
  assert.equal(scatterWild(new WorldGrid({ ox: 0, oy: 0, w: 4, h: 4 }), new ObjectStore(), {}, 1, { id: 'x', objects: OBJECT_TYPES }), 0);
});

const wildCount = f => {
  const fx = loadFixture(f + '.json');
  const t = performance.now();
  const w = buildWorld(viewFromFixture(fx), { v: 1, seed: 7, blocks: {}, lots: {} }, { now: fx.now, seed: 7 });
  return { n: [...w.objects.values()].filter(o => o.data?.wild).length, ms: performance.now() - t };
};

test('density on citydemo stays within 15% of the per-tile-stream count', () => {
  const OLD = 228;   // wild objects on citydemo (seed 7) measured at 554bbbf with streamFor per tile
  const { n } = wildCount('citydemo');
  assert.ok(Math.abs(n - OLD) <= OLD * 0.15, `wild count ${n} vs old ${OLD}`);
});

test('stress fixture build timing (reported, not asserted)', () => {
  const { n, ms } = wildCount('stress');
  console.log(`# stress: ${n} wild objects, buildWorld ${Math.round(ms)}ms`);
  assert.ok(n > 0);
});
