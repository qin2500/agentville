// Ground cache + bake budget (m3-ground). Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from '../web/src/engine/render/ground.js';
import { createGroundCache } from '../web/src/engine/render/ground-cache.js';
import { createLighting } from '../web/src/engine/render/lighting.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';

const mkCanvas = log => (w, h) => {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
  const cv = { width: w, height: h, getContext: () => ctx }; log?.push(cv); return cv;
};
const mkGfx = () => { const calls = []; return { calls, image: (...a) => calls.push(['image', ...a]), poly: (...a) => calls.push(['poly', ...a]) }; };
const mkWorld = (n = 64) => {
  const grid = new WorldGrid({ ox: 0, oy: 0, w: n, h: n });
  grid.terrain.fill(3);
  return { version: 1, grid, mod: { terrain: { types: [{ code: 5, color: '#abcdef' }] } } };
};
const BIG = { cssW: 1e5, cssH: 1e5 };

// budgetMs: Infinity removes the wall-clock budget so only the bakesPerFrame cap (default 2) is under test
test('at most bakesPerFrame bakes per drawChunks; pending drains to 0; flat diamonds meanwhile', () => {
  const log = [], g = createGround({ world: mkWorld(), cache: createGroundCache({ budgetMs: Infinity }), createCanvas: mkCanvas(log) }), gfx = mkGfx();
  const cam = { x: 32, y: 32, z: 1 };
  let r = g.drawChunks(gfx, cam, BIG);
  assert.equal(r.baked, 2); assert.equal(log.length, 2); assert.equal(r.pending, 16 - 2);
  assert.equal(gfx.calls.filter(c => c[0] === 'poly').length, 14);
  for (let i = 0; i < 10 && r.pending; i++) { r = g.drawChunks(mkGfx(), cam, BIG); assert.ok(r.baked <= 2); }
  assert.equal(r.pending, 0); assert.equal(log.length, 16);
  assert.equal(g.drawChunks(mkGfx(), cam, BIG).baked, 0);
});

test('cache never exceeds its bounds (soft by the chunks one frame shows) while panning a big world', () => {
  const cache = createGroundCache({ maxChunks: 8 }), world = mkWorld(400);
  const g = createGround({ world, cache, createCanvas: mkCanvas() });
  for (let i = 0; i < 120; i++) {
    g.drawChunks(mkGfx(), { x: i * 3, y: i * 3, z: 1 }, { cssW: 600, cssH: 300 });
    const s = cache.stats();
    assert.ok(s.chunks <= Math.max(8, s.pinned) && s.bytes <= Math.max(s.maxBytes, s.pinned * 512 * 256 * 4), JSON.stringify(s));
  }
  assert.ok(cache.stats().evictions > 0);
  const byt = createGroundCache({ maxBytes: 600_000, maxChunks: 100 });
  for (let i = 0; i < 10; i++) byt.put('k' + i, { w: 512, h: 256 });
  assert.ok(byt.stats().bytes <= 600_000 && byt.stats().chunks === 1);
});

test('keys are content: an ownership-only rebuild (version bump, same ground) re-bakes nothing; a ground edit re-bakes its chunks', () => {
  const log = [], world = mkWorld(), g = createGround({ world, cache: createGroundCache({ bakesPerFrame: 99, budgetMs: Infinity }), createCanvas: mkCanvas(log) });
  const cam = { x: 32, y: 32, z: 1 };
  g.drawChunks(mkGfx(), cam, BIG); const n = log.length;
  const k0 = g.chunkKeys(BIG, cam).map(c => c.key);
  world.version = 7;
  assert.deepEqual(g.chunkKeys(BIG, cam).map(c => c.key), k0);
  assert.equal(g.drawChunks(mkGfx(), cam, BIG).baked, 0); assert.equal(log.length, n);
  world.grid.ground[1] = 5; world.version = 8;   // tile (1,0): chunk 0,0 only
  assert.equal(g.drawChunks(mkGfx(), cam, BIG).baked, 1);
  world.grid.ground[16 * 64 + 16 + 0] = 5; world.grid.ground[15 * 64 + 16] = 5; world.version = 9;   // edge tile: neighbours via the ring
  assert.ok(g.drawChunks(mkGfx(), cam, BIG).baked >= 2);
});

test('Map LOD bakes per chunk at 1/4 scale and hits the cache on the second frame', () => {
  // no wall-clock budget: under a loaded full suite the default bake budget left chunks pending
  const log = [], cache = createGroundCache({ bakesPerFrame: 99, budgetMs: Infinity }), g = createGround({ world: mkWorld(), cache, createCanvas: mkCanvas(log) });
  const cam = { x: 32, y: 32, z: 0.2 }, gfx = mkGfx();
  const a = g.drawChunks(gfx, cam, { cssW: 2000, cssH: 1000 });
  assert.equal(a.mode, 'map'); assert.ok(a.baked > 0 && a.pending === 0);
  const lods = log.filter(c => c.width !== 512);
  assert.ok(lods.length === a.baked && lods.every(c => c.width === 128 && c.height === 64));
  assert.equal(log.length - lods.length, 1, 'one reused 1x scratch canvas for the bakes the LOD samples');
  assert.ok(gfx.calls.every(c => c[0] === 'image'));
  const b = g.drawChunks(mkGfx(), cam, { cssW: 2000, cssH: 1000 });
  assert.equal(b.baked, 0); assert.equal(b.chunks, a.chunks);
});

test('lantern actors (fx includes lantern) add a light, by day too', () => {
  const l = createLighting({ world: { objects: new Map() }, createCanvas: mkCanvas() });
  const out = l.lights([], [{ id: 'a', x: 3, y: 3, fx: ['lantern'] }, { id: 'b', x: 4, y: 4, fx: ['spark'] }, { id: 'c', x: 5, y: 5 }]);
  assert.equal(out.length, 1); assert.equal(out[0].id, 'a'); assert.equal(out[0].kind, 'lantern');
});
