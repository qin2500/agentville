// M7 map view: the Map LOD ground settles (no LRU thrash), is sampled from the real chunk art, and pending chunks draw
// flat only inside the grid. Regression for the six-styles overview (stray grey chunk on the sea, flat quadrants on the
// land, hard-edged sea slabs, groundPending never 0 so the capture tool waited out its 30 s timeout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from '../web/src/engine/render/ground.js';
import { createGroundCache } from '../web/src/engine/render/ground-cache.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';

const mkCanvas = log => (w, h) => {
  const ops = [], props = {};
  const ctx = new Proxy(props, { get: (t, k) => k === 'drawImage' ? (...a) => ops.push(['drawImage', ...a]) : k === 'fillRect' ? (...a) => ops.push(['fillRect', t.fillStyle, ...a]) : (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
  const cv = { w, h, ops, props, getContext: () => ctx }; log?.push(cv); return cv;
};
const mkGfx = () => { const calls = []; return { calls, image: (...a) => calls.push(['image', ...a]), poly: (...a) => calls.push(['poly', ...a]) }; };
const mkWorld = (w, h, { ox = 0, oy = 0, terrain = 3, mod = {} } = {}) => {
  const grid = new WorldGrid({ ox, oy, w, h });
  grid.terrain.fill(terrain);
  return { version: 1, grid, mod: { terrain: { types: [] }, ...mod } };
};

test('map zoom over more chunks than the cache holds: pending drains to 0 and stays there (no eviction thrash)', () => {
  // 160x160 tiles = 100 chunks, all on screen at z 0.25 in a 1536x1020 view; the cache holds 64 by default
  const cache = createGroundCache({ budgetMs: Infinity }), g = createGround({ world: mkWorld(160, 160), cache, createCanvas: mkCanvas() });
  const cam = { x: 80, y: 80, z: 0.25 }, view = { cssW: 1536, cssH: 1020 };
  assert.ok(g.chunkKeys(view, cam, true).length > cache.maxChunks, 'the view must hold more chunks than maxChunks');
  let r, n = 0;
  do r = g.drawChunks(mkGfx(), cam, view); while (r.pending > 0 && ++n < 200);
  assert.equal(r.pending, 0, `still pending after ${n} frames`);
  for (let i = 0; i < 5; i++) { const s = g.drawChunks(mkGfx(), cam, view); assert.equal(s.pending, 0); assert.equal(s.baked, 0, 'a settled view re-bakes nothing'); }
  assert.ok(cache.stats().chunks >= 100);
});

test('same at 1x chunks (z 0.5): a view larger than the cache settles', () => {
  const cache = createGroundCache({ budgetMs: Infinity }), g = createGround({ world: mkWorld(160, 160), cache, createCanvas: mkCanvas() });
  const cam = { x: 80, y: 80, z: 0.5 }, view = { cssW: 1536, cssH: 1020 };
  assert.ok(g.chunkKeys(view, cam).length > cache.maxChunks);
  let r, n = 0;
  do r = g.drawChunks(mkGfx(), cam, view); while (r.pending > 0 && ++n < 200);
  assert.equal(r.pending, 0);
  assert.equal(g.drawChunks(mkGfx(), cam, view).baked, 0);
});

test('unpinned chunks are still evicted once the view moves on', () => {
  const cache = createGroundCache({ maxChunks: 4, bakesPerFrame: 99, budgetMs: Infinity }), g = createGround({ world: mkWorld(400, 400), cache, createCanvas: mkCanvas() });
  const view = { cssW: 600, cssH: 300 };
  g.drawChunks(mkGfx(), { x: 20, y: 20, z: 1 }, view);
  g.drawChunks(mkGfx(), { x: 300, y: 300, z: 1 }, view);
  const s = cache.stats();
  assert.ok(s.chunks <= Math.max(4, s.pinned) && s.evictions > 0, JSON.stringify(s));
});

test('a pending chunk draws flat only over the grid: clipped to it, never the grey unknown colour', () => {
  // grid 20x20 at (8,8): each of its 4 chunks overlaps it only partly (chunk (1,1)'s centre tile (24,24) is on it, chunk
  // (0,0)'s centre (8,8) is its corner), so a whole-chunk diamond would hang off the grid onto the sea
  const g = createGround({ world: mkWorld(20, 20, { ox: 8, oy: 8 }), cache: createGroundCache({ bakesPerFrame: 0, budgetMs: Infinity }), createCanvas: mkCanvas() });
  const gfx = mkGfx(), r = g.drawChunks(gfx, { x: 18, y: 18, z: 1 }, { cssW: 1e5, cssH: 1e5 });
  const polys = gfx.calls.filter(c => c[0] === 'poly');
  assert.equal(r.pending, 4); assert.equal(polys.length, 4);
  const toTile = (x, y) => [(x / 16 + y / 8) / 2, (y / 8 - x / 16) / 2];   // inverse of (tx - ty) * 16, (tx + ty) * 8
  for (const [, pts, col] of polys) {
    assert.notEqual(col, '#808080', 'no grey unknown chunk');
    for (const [x, y] of pts) { const [tx, ty] = toTile(x, y); assert.ok(tx >= 8 && tx <= 28 && ty >= 8 && ty <= 28, `corner ${tx},${ty} off the grid`); }
  }
  // the quads tile the grid exactly: their tile-area sum is the grid's 400 tiles
  const area = polys.reduce((s, [, p]) => s + Math.abs(p.reduce((a, [x, y], i) => { const [u, v] = p[(i + 1) % p.length]; return a + x * v - u * y; }, 0)) / 2, 0);
  assert.equal(area, 400 * 16 * 16);
});

test('Map LOD is sampled (nearest, no smoothing) from the real 1x bake, mod tile art included', () => {
  const bmp = { tile: 1 }, log = [];
  const world = mkWorld(16, 16, { terrain: 0, mod: { ground: { renderTile: () => bmp } } });
  const g = createGround({ world, cache: createGroundCache({ bakesPerFrame: 99, budgetMs: Infinity }), createCanvas: mkCanvas(log) });
  const r = g.drawChunks(mkGfx(), { x: 8, y: 8, z: 0.25 }, { cssW: 800, cssH: 400 });
  assert.equal(r.mode, 'map'); assert.equal(r.pending, 0);
  const scratch = log.find(c => c.w === 512 && c.h === 256), lod = log.find(c => c.w === 128 && c.h === 64);
  assert.ok(scratch && lod);
  assert.ok(scratch.ops.some(o => o[0] === 'drawImage' && o[1] === bmp), 'the 1x bake draws the mod tile art');
  assert.ok(lod.ops.some(o => o[0] === 'drawImage' && o[1] === scratch && o[8] === 128 && o[9] === 64), 'the LOD is the 1x bake scaled to 1/4');
  assert.equal(lod.props.imageSmoothingEnabled, false);
  assert.ok(!lod.ops.some(o => o[0] === 'fillRect'), 'no flat class-colour fills at map zoom');
});
