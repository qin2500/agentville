// M3 integration: rebuild cost (rules memo key, nav reuse key, renderer caches that survive setWorld). Pure node, no DOM.
import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rulesKey, navKey, gridHash, createBuildCache } from '../web/src/engine/world/cache.js';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { toScreen } from '../web/src/engine/core/coords.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';

const { buildWorld } = await import('../web/src/engine/world/build.js');
const { runRules } = await import('../web/src/engine/world/rules-phase.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');

const SEED = 7;
const fx = loadFixture('citydemo.json');
const inputOf = (frame, now = frame.now) => toWorldInput(viewFromFixture(frame, { now }), { seed: SEED, salt: '7' });

test('rulesKey: ignores the clock, follows every input the rules phase reads', () => {
  const mod = resolveMod(), { input } = inputOf(fx), persisted = { v: 1, seed: SEED, blocks: {}, lots: {} };
  const bc = createBuildCache(), k = o => rulesKey({ input, persisted, mod, seed: SEED, now: fx.now, ...o }, bc);
  const neq = (a, b, m) => assert.ok(a !== b, m);   // keys are long: no diff dumps
  assert.equal(k(), k({ now: fx.now + 5000 }), 'now alone does not change the key');
  neq(k(), k({ seed: 8 }));
  neq(k(), k({ forcedTier: 2 }));
  neq(k(), k({ forcedStyle: 1 }));
  const less = { ...input, agents: input.agents.slice(1) };
  neq(k(), k({ input: less }));
  const restatus = { ...input, agents: input.agents.map((a, i) => (i ? a : { ...a, status: a.status === 'resting' ? 'working' : 'resting' })) };
  neq(k(), k({ input: restatus }));
  neq(k(), k({ persisted: { ...persisted, blocks: { x: { gt: 1, tier: 1, cap: 4 } } } }));
  // held lots: an item inside the hold window counts, the same item after the window does not
  const lots = { p: { tier: 1, a: { 'home:z': 1 }, h: { 'home:z': fx.now - 1000 } } };
  const P = { ...persisted, lots };
  neq(k({ persisted: P }), k({ persisted: P, now: fx.now + 864e5 }), 'a hold expiring changes the key');
  neq(k(), k({ mod: { ...mod } }), 'another mod object');
});

test('memoised rules: a build from rules computed for an earlier poll equals a build from fresh rules', () => {
  const mod = resolveMod();
  const p1 = { v: 1, seed: SEED, blocks: {}, lots: {} }, p2 = { v: 1, seed: SEED, blocks: {}, lots: {} };
  const a = inputOf(fx), b = inputOf(fx, fx.now + 2000);
  const optsA = { now: fx.now, seed: SEED, serverId: a.serverId };
  const rules = runRules(a.input, p1, mod, optsA);
  const w1 = buildWorld(a.input, p1, { mod, ...optsA, rules });
  const again = buildWorld(b.input, p1, { mod, now: fx.now + 2000, seed: SEED, serverId: b.serverId, rules });   // reused rules
  buildWorld(a.input, p2, { mod, ...optsA });
  const fresh = buildWorld(b.input, p2, { mod, now: fx.now + 2000, seed: SEED, serverId: b.serverId });
  const objs = w => [...w.objects.values()].map(o => JSON.stringify(o)).sort();
  assert.deepEqual(objs(again), objs(fresh));
  assert.equal(again.sig, fresh.sig);
  assert.equal(gridHash(again.grid), gridHash(fresh.grid));
  assert.equal(objs(w1).length, objs(again).length);
});

test('navKey: equal for an identical rebuild, different when the grid or an object door changes', () => {
  const mod = resolveMod(), { input, serverId } = inputOf(fx);
  const build = () => buildWorld(input, { v: 1, seed: SEED, blocks: {}, lots: {} }, { mod, now: fx.now, seed: SEED, serverId });
  const w1 = build(), w2 = build();
  assert.equal(navKey(w1), navKey(w2));
  const g = w2.grid, i = g.cost.findIndex(c => c < 255);
  g.cost[i] = 255;
  assert.notEqual(navKey(w1), navKey(w2), 'grid content');
  g.cost[i] = w1.grid.cost[i];
  assert.equal(navKey(w1), navKey(w2));
  const o = [...w2.objects.values()].find(x => x.door);
  o.door = { ...o.door, tx: o.door.tx + 1 };
  assert.notEqual(navKey(w1), navKey(w2), 'object door');
});

// ---- renderer caches across setWorld (injected fakes)
function mkRenderer() {
  const calls = { sliced: {}, grounds: [] };
  const sortKey = (d, s, l, c) => ((d * 4 + s) * 8 + l) * 4096 + (c + 2048);
  const entries = new Map();
  class SpriteCache {
    get(key, make) { if (!entries.has(key)) { make(); entries.set(key, { img: { width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }); } return entries.get(key); }
    pump() {}
  }
  const deps = {
    sortKey, mergeSorted: ls => ls.flat().sort((a, b) => a.key - b.key), SpriteCache, loadClassicArt: null,
    spriteKey: o => `${o.model}|${o.styleKey}|${o.variant}`,
    sliceSprite: (obj, sp) => {
      calls.sliced[obj.id] = (calls.sliced[obj.id] || 0) + 1;
      const p = toScreen(obj.tx, obj.ty);
      return [{ key: sortKey(obj.tx + obj.ty, 0, 1, obj.tx - obj.ty), sx: 0, sy: 0, sw: 16, sh: 32, dx: p.sx, dy: p.sy - 32, img: sp.img }];
    },
    rasterize: () => ({ img: {} }), artView: o => o, createActorArt: null,
    createGround: o => { calls.grounds.push(o.cache); return { drawChunks: () => ({ pending: 1 }) }; },
    createLighting: () => { calls.lightings = (calls.lightings || 0) + 1; return { setTime() {}, lights: () => [], draw() {} }; },
    createXray: () => ({ occluded: () => false, draw() {} }),
  };
  const gfx = { begin() {}, clear() {}, end() {}, image() {}, rect() {}, poly() {}, silhouette() {} };
  return { r: createRenderer({ gfx, mod: {}, deps }), calls };
}
const bld = (id, tx, ty, extra = {}) => ({ id, kind: 'building', model: 'cottage', tx, ty, w: 1, h: 1, z: 20, walk: 'block', styleKey: 's', variant: 0, ...extra });
const worldOf = (objs, version) => ({ version, grid: new WorldGrid({ ox: 0, oy: 0, w: 8, h: 8 }), objects: new Map(objs.map(o => [o.id, o])), villages: [] });
const frame = { cam: { x: 0, y: 0, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [] };

test('renderer: slices survive setWorld for unchanged objects (any version); a moved object re-slices; one ground cache, one lighting', () => {
  const { r, calls } = mkRenderer();
  r.setWorld(worldOf([bld('a', 0, 0), bld('b', 2, 0)], 1));
  r.draw(frame);
  assert.deepEqual(calls.sliced, { a: 1, b: 1 });
  r.setWorld(worldOf([bld('a', 0, 0), bld('b', 3, 0)], 99));   // new version, new object instances, b moved
  r.draw(frame);
  assert.deepEqual(calls.sliced, { a: 1, b: 2 });
  r.setWorld(worldOf([bld('a', 0, 0, { variant: 1 })], 100));     // a restyled: new sprite entry
  r.draw(frame);
  assert.equal(calls.sliced.a, 2);
  assert.equal(calls.grounds.length, 3);
  assert.ok(calls.grounds[0] && calls.grounds.every(c => c === calls.grounds[0]), 'the same ground cache every setWorld');
  assert.equal(calls.lightings, 1);
  assert.equal(r.stats().groundPending, 1);
});
