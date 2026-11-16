// R6 ground: chunk culling, lazy bake + caching, mod tile art, Map LOD, invalidate. Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from '../web/src/engine/render/ground.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';
import { createGroundCache } from '../web/src/engine/render/ground-cache.js';
// The renderer always hands the ground a createGroundCache() (budgeted path, M3): content-hashed keys, a per-frame bake
// budget and a baked Map LOD. These tests pin that behaviour; the cache-less legacy path is covered by gfx-poly-forms.
const budgeted = (o = {}) => createGroundCache(o);
const settle = (g, gfx, cam, view) => { let r, n = 0; do { r = g.drawChunks(gfx, cam, view); } while (r.pending > 0 && ++n < 100); return n + 1; };

const mkCanvas = log => (w, h) => {
  const ops = [];
  const ctx = new Proxy({}, { get: (t, k) => k === 'drawImage' ? (...a) => ops.push(['drawImage', ...a]) : k === 'fillRect' ? (...a) => ops.push(['fillRect', t.fillStyle, ...a]) : (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
  const cv = { w, h, ops, getContext: () => ctx }; log?.push(cv); return cv;
};
const mkGfx = () => { const calls = []; return { calls, image: (...a) => calls.push(['image', ...a]), poly: (...a) => calls.push(['poly', ...a]), rect: () => {} }; };
const mkWorld = (w = 40, h = 40, mod = {}) => {
  const grid = new WorldGrid({ ox: 0, oy: 0, w, h });
  grid.terrain.fill(3);
  return { version: 1, grid, mod: { terrain: { types: [{ code: 5, color: '#abcdef' }] }, ...mod } };
};
const VIEW = { cssW: 200, cssH: 100 };

test('culling: a small viewport sees few chunks; a huge one sees all of the grid', () => {
  const g = createGround({ world: mkWorld(), createCanvas: mkCanvas() });
  const few = g.chunkKeys(VIEW, { x: 20, y: 20, z: 1 });
  const all = g.chunkKeys({ cssW: 1e5, cssH: 1e5 }, { x: 20, y: 20, z: 1 });
  assert.ok(few.length >= 1 && few.length < 9, String(few.length));
  assert.equal(all.length, 9);   // 40 tiles -> 3x3 chunks
  assert.equal(g.chunkKeys(VIEW, { x: 5000, y: 5000, z: 1 }).length, 0);
});

test('bake is lazy, cached, keyed by chunk content and style (not world.version)', () => {
  const log = [], world = mkWorld(), g = createGround({ world, cache: budgeted({ bakesPerFrame: Infinity, budgetMs: Infinity }), createCanvas: mkCanvas(log) }), gfx = mkGfx();
  const cam = { x: 8, y: 8, z: 1 };
  assert.equal(log.length, 0);
  g.drawChunks(gfx, cam, VIEW);
  const n = log.length; assert.ok(n >= 1);
  assert.equal(gfx.calls.filter(c => c[0] === 'image').length, n);
  g.drawChunks(gfx, cam, VIEW); assert.equal(log.length, n, 'cached');
  world.version = 2; g.drawChunks(gfx, cam, VIEW); assert.equal(log.length, n, 'a new version with the same tiles reuses every chunk');
  world.grid.terrain[world.grid.idx(1, 1)] = 4; world.version = 3;
  g.drawChunks(gfx, cam, VIEW); assert.equal(log.length, n + 1, 'a changed tile rebakes only its chunk');
  g.drawChunks(gfx, cam, { ...VIEW, style: 'night' }); assert.ok(log.length > n + 1, 'style rebakes');
});

test('a ground rebuilt on the same cache (renderer.setWorld) reuses unchanged chunks', () => {
  const log = [], cache = budgeted({ bakesPerFrame: Infinity, budgetMs: Infinity }), cam = { x: 8, y: 8, z: 1 };
  createGround({ world: mkWorld(), cache, createCanvas: mkCanvas(log) }).drawChunks(mkGfx(), cam, VIEW);
  const n = log.length;
  const w2 = mkWorld(); w2.version = 9;
  createGround({ world: w2, cache, createCanvas: mkCanvas(log) }).drawChunks(mkGfx(), cam, VIEW);
  assert.equal(log.length, n);
});

test('fallback art: mod terrain colour for ground codes, fixed colours for engine codes 200-203', () => {
  const log = [], world = mkWorld(), grid = world.grid;
  grid.ground[0] = 5; grid.ground[1] = 202;
  createGround({ world, createCanvas: mkCanvas(log) }).drawChunks(mkGfx(), { x: 0, y: 0, z: 1 }, VIEW);
  const fills = log.flatMap(c => c.ops.filter(o => o[0] === 'fillRect').map(o => o[1]));
  assert.ok(fills.includes('#abcdef') && fills.includes('#e0c060'), fills.slice(0, 5).join());
});

test('mod.ground.renderTile is called with (code, neighbours, style) and its bitmap is drawn', () => {
  const calls = [], bmp = { bmp: 1 };
  const world = mkWorld(16, 16, { ground: { renderTile: (c, nb, s) => (calls.push([c, nb, s]), bmp) } });
  world.grid.ground[1] = 5;
  const log = [];
  createGround({ world, createCanvas: mkCanvas(log) }).drawChunks(mkGfx(), { x: 8, y: 8, z: 1 }, VIEW);
  assert.ok(calls.length > 0 && calls.length < 256, 'batched/memoised per distinct tile');
  const c5 = calls.find(c => c[0] === 5);
  assert.ok(c5 && c5[2] === 'default' && 'n' in c5[1] && 'e' in c5[1] && 's' in c5[1] && 'w' in c5[1]);
  assert.ok(log[0].ops.some(o => o[0] === 'drawImage' && o[1] === bmp));
});

test('Map LOD (zoom <= 0.25): baked quarter-scale chunk bitmaps, cached, no per-tile polygons', () => {
  const log = [], gfx = mkGfx(), g = createGround({ world: mkWorld(), cache: budgeted({ bakesPerFrame: Infinity, budgetMs: Infinity }), createCanvas: mkCanvas(log) });
  const cam = { x: 20, y: 20, z: 0.25 }, view = { cssW: 400, cssH: 200 };
  const r = g.drawChunks(gfx, cam, view);
  assert.equal(r.mode, 'map');
  const lods = log.filter(c => c.w !== 512);
  assert.ok(lods.length > 0 && lods.every(c => c.w === 128 && c.h === 64), 'LOD bitmaps are 1/4 of 512x256');
  assert.equal(log.length - lods.length, 1, 'sampled from one reused 1x scratch bake');
  assert.ok(gfx.calls.length > 0 && gfx.calls.every(c => c[0] === 'image'));
  const n = log.length; g.drawChunks(gfx, cam, view); assert.equal(log.length, n, 'cached');
});

test('bake budget: at most bakesPerFrame chunks per call; the rest draw flat and count as pending', () => {
  const log = [], gfx = mkGfx(), g = createGround({ world: mkWorld(), cache: budgeted({ bakesPerFrame: 2, budgetMs: Infinity }), createCanvas: mkCanvas(log) });
  const big = { cssW: 1e5, cssH: 1e5 }, cam = { x: 20, y: 20, z: 1 };
  const r = g.drawChunks(gfx, cam, big);
  assert.equal(log.length, 2); assert.equal(r.baked, 2); assert.equal(r.pending, 7);
  assert.equal(gfx.calls.filter(c => c[0] === 'poly').length, 7, 'pending chunks draw one flat diamond each');
  assert.equal(settle(g, gfx, cam, big), 4); assert.equal(log.length, 9);
});

test('invalidate(rect) drops only affected chunks; no rect drops all', () => {
  const log = [], g = createGround({ world: mkWorld(), cache: budgeted(), createCanvas: mkCanvas(log) }), gfx = mkGfx();
  const big = { cssW: 1e5, cssH: 1e5 }, cam = { x: 20, y: 20, z: 1 };
  settle(g, gfx, cam, big); assert.equal(log.length, 9, 'all 9 chunks, over several budgeted frames');
  g.invalidate({ ox: 2, oy: 2, w: 2, h: 2 });
  settle(g, gfx, cam, big); assert.equal(log.length, 10, 'only chunk 0,0');
  g.invalidate();
  settle(g, gfx, cam, big); assert.equal(log.length, 19);
});
