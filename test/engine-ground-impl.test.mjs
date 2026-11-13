// R6 ground: chunk culling, lazy bake + caching, mod tile art, Map LOD, invalidate. Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from '../web/src/engine/render/ground.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';

const mkCanvas = log => (w, h) => {
  const ops = [];
  const ctx = new Proxy({}, { get: (t, k) => k === 'drawImage' ? (...a) => ops.push(['drawImage', ...a]) : k === 'fill' ? () => ops.push(['fill', t.fillStyle]) : (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
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

test('bake is lazy, cached, and keyed by world.version and style', () => {
  const log = [], world = mkWorld(), g = createGround({ world, createCanvas: mkCanvas(log) }), gfx = mkGfx();
  const cam = { x: 8, y: 8, z: 1 };
  assert.equal(log.length, 0);
  g.drawChunks(gfx, cam, VIEW);
  const n = log.length; assert.ok(n >= 1);
  assert.equal(gfx.calls.filter(c => c[0] === 'image').length, n);
  g.drawChunks(gfx, cam, VIEW); assert.equal(log.length, n, 'cached');
  world.version = 2; g.drawChunks(gfx, cam, VIEW); assert.equal(log.length, 2 * n, 'version rebakes');
  g.drawChunks(gfx, cam, { ...VIEW, style: 'night' }); assert.equal(log.length, 3 * n, 'style rebakes');
});

test('fallback art: mod terrain colour for ground codes, fixed colours for engine codes 200-203', () => {
  const log = [], world = mkWorld(), grid = world.grid;
  grid.ground[0] = 5; grid.ground[1] = 202;
  createGround({ world, createCanvas: mkCanvas(log) }).drawChunks(mkGfx(), { x: 0, y: 0, z: 1 }, VIEW);
  const fills = log.flatMap(c => c.ops.filter(o => o[0] === 'fill').map(o => o[1]));
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

test('Map LOD (zoom <= 0.25): flat tiles, no bake', () => {
  const log = [], gfx = mkGfx(), g = createGround({ world: mkWorld(), createCanvas: mkCanvas(log) });
  const r = g.drawChunks(gfx, { x: 20, y: 20, z: 0.25 }, { cssW: 400, cssH: 200 });
  assert.equal(log.length, 0);
  assert.ok(gfx.calls.length > 0 && gfx.calls.every(c => c[0] === 'poly'));
  assert.equal(r.mode, 'map');
});

test('invalidate(rect) drops only affected chunks; no rect drops all', () => {
  const log = [], g = createGround({ world: mkWorld(), createCanvas: mkCanvas(log) }), gfx = mkGfx();
  const big = { cssW: 1e5, cssH: 1e5 }, cam = { x: 20, y: 20, z: 1 };
  g.drawChunks(gfx, cam, big); assert.equal(log.length, 9);
  g.invalidate({ ox: 2, oy: 2, w: 2, h: 2 });
  g.drawChunks(gfx, cam, big); assert.equal(log.length, 10, 'only chunk 0,0');
  g.invalidate();
  g.drawChunks(gfx, cam, big); assert.equal(log.length, 19);
});
