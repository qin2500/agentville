// The layout memo owns its data: a mod that reuses and mutates its own buffers must not corrupt the cached world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSettlements, placeBlocks } from '../web/src/engine/world/sites.js';
import { runLayout } from '../web/src/engine/world/layout.js';
import { createBuildCache } from '../web/src/engine/world/cache.js';
import { resolveMod, modCtx } from '../web/src/engine/mod/registry.js';
import { toWorldInput } from '../web/src/engine/mod/input.js';
import { viewFromFixture, loadFixture } from './engine-support/world-views.mjs';

const SEED = 7;
const base = resolveMod();
const fresh = () => ({ v: 1, seed: SEED, blocks: {}, lots: {} });

function placedFor(mod, cache) {
  const fx = loadFixture('citydemo.json');
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: SEED, salt: String(SEED), env: { reduceMotion: false, zoom: 1 } });
  const ctxFor = k => modCtx(mod, { seed: SEED, now: fx.now, projectKey: k });
  const { settlements } = planSettlements(input, fresh(), mod, { now: fx.now, serverId, ctxFor });
  return placeBlocks(settlements, fresh(), mod, { now: fx.now, ctxFor, seed: SEED, cache });
}

/** A toy mod whose layout returns the SAME typed arrays and data object on every call. */
function reusingMod(dataOf) {
  const bufs = { terrain: new Uint8Array(16).fill(3), ground: new Uint8Array(16), road: new Uint8Array(16), lot: new Int8Array(16) };
  const data = dataOf?.();
  const layout = input => {
    const sq = input.square;
    const bounds = { ox: sq.x - 20, oy: sq.y - 20, w: 400, h: 400 };
    return { bounds, tiles: { ox: bounds.ox, oy: bounds.oy, w: 4, h: 4, ...bufs }, outside: 1, data };
  };
  return { mod: { ...base, id: 'toy.reuse', hooks: { ...base.hooks, layout } }, bufs, data };
}

test('the cached world is not aliased to the mod buffers', () => {
  const { mod, bufs, data } = reusingMod(() => ({ n: { v: 1 } }));
  const cache = createBuildCache(), placed = placedFor(mod, cache);
  const a = runLayout(placed, mod, { seed: SEED, cache });
  assert.deepEqual([...a.tiles.terrain], new Array(16).fill(3));
  bufs.terrain.fill(9); bufs.lot.fill(2); data.n.v = 99;          // the mod reuses its buffers between calls
  assert.notEqual(a.tiles.terrain, bufs.terrain);
  assert.deepEqual([...a.tiles.terrain], new Array(16).fill(3), 'first result untouched');
  assert.equal(a.data.n.v, 1);
  const b = runLayout(placed, mod, { seed: SEED, cache });         // cache hit: still the original copy
  assert.equal(b.tiles, a.tiles);
  assert.deepEqual([...b.tiles.terrain], new Array(16).fill(3));
  assert.equal(b.data.n.v, 1);
  assert.equal([...b.tiles.lot].every(v => v === 0), true);
});

test('a second uncached call returns its own copy, not the first', () => {
  const { mod, bufs } = reusingMod();
  const placed = placedFor(mod, null);
  const a = runLayout(placed, mod, { seed: SEED });
  bufs.terrain.fill(5);
  const b = runLayout(placed, mod, { seed: SEED });
  assert.deepEqual([...a.tiles.terrain], new Array(16).fill(3));
  assert.deepEqual([...b.tiles.terrain], new Array(16).fill(5));
});

test('non-clonable data is dropped with a lint entry', () => {
  const { mod } = reusingMod(() => ({ f() {} }));
  const sites = runLayout(placedFor(mod, null), mod, { seed: SEED });
  assert.equal(sites.data, null);
  assert.ok(sites.lint.some(l => l.kind === 'layout' && l.reason === 'data is not structured-clonable'));
});

test('a mod without hooks.layout throws an error naming the mod id (no chain fallback)', () => {
  const mod = { ...base, id: 'toy.nolayout', hooks: {} };
  const placed = placedFor(base, null);
  assert.throws(() => runLayout(placed, mod, { seed: SEED }), /toy\.nolayout.*hooks\.layout/);
});
