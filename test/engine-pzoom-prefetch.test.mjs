// M7 pan/zoom: the next zoom step is pre-rastered in idle time and served from cache, within the sprite cache cap.
// Written from the spec: (1) SpriteCache.prefetch never evicts what the view uses, eviction takes stale entries first,
// then prefetched ones; (2) the renderer's idle prefetch covers the view one zoom step out (and nothing far away), so the
// step itself draws with no raster and no placeholder; (3) the ground keeps its street-zoom bakes across a Map visit
// and pre-bakes only into free room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, CHUNK } from '../web/src/engine/render/renderer.js';
import { SpriteCache, KEEP_MS } from '../web/src/engine/render/sprites.js';
import { createGroundCache } from '../web/src/engine/render/ground-cache.js';
import { createGround } from '../web/src/engine/render/ground.js';
import { toScreen } from '../web/src/engine/core/coords.js';

const ent = (bytes = 100) => ({ img: { width: 4, height: 4 }, bounds: { x: 0, y: 0, w: 4, h: 4 }, pivot: { x: 2, y: 4 }, anchors: {}, bytes });

// ---- SpriteCache.prefetch ----
test('prefetch: builds into free room as a prefetched entry; a get() makes it a used one', () => {
  let t = 0;
  const c = new SpriteCache({ maxBytes: 1000, now: () => t });
  assert.equal(c.prefetch('a', () => ent()), 'built');
  assert.equal(c.map.get('a').pre, true);
  assert.equal(c.prefetch('a', () => { throw new Error('not again'); }), 'hit');
  assert.equal(c.prefetch('x', () => null), 'failed');
  assert.equal(c.map.has('x'), false, 'a failed make is not cached');
  t = 50;
  const e = c.get('a', () => ent());
  assert.equal(e.pre, false); assert.equal(e.lastUsed, 50);
  const s = c.stats();
  assert.equal(s.prefetched, 1); assert.equal(s.preUsed, 1); assert.equal(s.preBytes, 0);
});

test('prefetch: never evicts a sprite the view used in the last 2 s; drops itself instead (full)', () => {
  let t = 0;
  const c = new SpriteCache({ maxBytes: 300, now: () => t, budgetMs: 1e9 });
  for (const k of ['v1', 'v2', 'v3']) c.get(k, () => ent());   // the view's sprites fill the cap
  t = 500;
  assert.equal(c.prefetch('next', () => ent()), 'full');
  assert.deepEqual([...c.map.keys()].sort(), ['v1', 'v2', 'v3']);
  assert.ok(c.bytes <= c.maxBytes);
  assert.equal(c.stats().preDropped, 1);
});

test('prefetch: evicts stale entries (not other prefetched ones) to make room', () => {
  let t = 0;
  const c = new SpriteCache({ maxBytes: 300, now: () => t, budgetMs: 1e9 });
  c.get('old', () => ent());
  t = 10; c.prefetch('p1', () => ent());
  t = KEEP_MS + 100;                                          // 'old' is stale now
  c.get('view', () => ent());
  assert.equal(c.prefetch('p2', () => ent()), 'built', 'stale old makes room');
  assert.equal(c.map.has('old'), false);
  assert.ok(c.map.has('p1') && c.map.has('p2') && c.map.has('view'));
  assert.equal(c.prefetch('p3', () => ent()), 'full', 'it never evicts another prefetched entry');
  assert.ok(c.map.has('p1') && c.map.has('p2'));
});

test('eviction for the view: stale entries first, then prefetched ones, never a used one', () => {
  let t = 0;
  const c = new SpriteCache({ maxBytes: 300, now: () => t, budgetMs: 1e9 });
  c.get('stale', () => ent());
  t = 100; c.prefetch('pre', () => ent());
  t = KEEP_MS + 200;
  c.get('v1', () => ent());
  c.get('v2', () => ent());                                   // over the cap: the stale entry goes first
  assert.deepEqual([...c.map.keys()].sort(), ['pre', 'v1', 'v2']);
  c.get('v3', () => ent());                                   // then the prefetched one, although it is newer
  assert.deepEqual([...c.map.keys()].sort(), ['v1', 'v2', 'v3']);
  assert.ok(c.bytes <= c.maxBytes);
});

test('trim: a cache left over the cap by sprites in use goes back under it once they are stale', () => {
  let t = 0;
  const c = new SpriteCache({ maxBytes: 300, now: () => t, budgetMs: 1e9 });
  for (const k of ['a', 'b', 'c', 'd', 'e']) c.get(k, () => ent());   // all in use: nothing may go
  assert.equal(c.bytes, 500);
  assert.equal(c.trim(), 0, 'used in the last 2 s: kept');
  t = KEEP_MS + 1; c.get('e', () => ent());                     // e still in use
  assert.equal(c.trim(), 2);
  assert.ok(c.bytes <= 300 && c.map.has('e'));
});

// ---- renderer idle prefetch ----
const LAYER = { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 };
const sortKey = (d, s, l, c) => ((d * 4 + s) * 8 + l) * 4096 + (c + 2048);
function rig({ objects, maxBytes = 1 << 20, ground = null }) {
  let t = 0;
  const clock = { get t() { return t; }, set t(v) { t = v; } };
  const cache = new SpriteCache({ maxBytes, now: () => t, budgetMs: 1e9 });
  const rasters = [];
  const gfx = { begin() {}, clear() {}, end() {}, image() {}, rect() {}, poly() {}, setComposite() {}, size: () => ({ w: 1600, h: 1200 }) };
  const deps = {
    LAYER, sortKey, mergeSorted: lists => lists.flat().sort((a, b) => a.key - b.key), cache, loadClassicArt: undefined,
    spriteKey: o => `${o.model}|${o.variant}|${o.lit ? 1 : 0}`,
    placeholder: () => ({ ...ent(), placeholder: true }),
    sliceSprite: (obj, sp) => { const p = toScreen(obj.tx, obj.ty); return [{ key: sortKey(obj.tx + obj.ty, 0, 1, 0), sx: 0, sy: 0, sw: 4, sh: 4, dx: p.sx, dy: p.sy, img: sp.img }]; },
    rasterize: (model, style, o) => { rasters.push(o.obj?.id ?? model); return ent(); },
    artView: o => ({ ...o }),
    createGround: () => ground ?? { drawChunks() {} },
    createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }),
    createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }),
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), version: 1 });
  return { r, cache, rasters, clock };
}
let vn = 0;
const obj = (id, tx, ty) => ({ id, kind: 'building', model: 'm', tx, ty, w: 1, h: 1, z: 10, styleKey: 's', variant: ++vn });
const view = { cssW: 1600, cssH: 1200, dpr: 1 };
const frame = (z, o = {}) => ({ cam: { x: 0, y: 0, z }, view, actors: [], night: 0, mode: z <= 0.25 ? 'map' : 'town', ...o });
const drain = r => { let n = 0; while (r.wantsPrefetch() && n++ < 100) if (!r.prefetchIdle(1e9).more) break; return n; };

// At 2x a 1600x1200 view shows chunks -3..2 (with the one-chunk ring); at 1x, -5..4. Tile (60, 0) is chunk (3, 0): drawn
// at 1x only. Tile (300, 300) is far outside both.
const WORLD = () => [obj('here', 0, 0), obj('next', 60, 0), obj('next2', 0, 60), obj('far', 300, 300)];

test('idle prefetch at 2x covers the 1x view (the next zoom step) and nothing far away', () => {
  const { r, rasters } = rig({ objects: WORLD() });
  r.draw(frame(2));
  assert.deepEqual(rasters, ['here']);
  assert.equal(r.wantsPrefetch(), true);
  drain(r);
  assert.ok(rasters.includes('next') && rasters.includes('next2'), `prefetched ${rasters}`);
  assert.ok(!rasters.includes('far'), 'nothing outside the next step and its pan margin');
  assert.equal(r.wantsPrefetch(), false, 'done for this view');
  assert.equal(r.stats().prefetch.done, true);
});

test('the zoom step after an idle prefetch draws from cache: no raster, no placeholder, prefetched entries become used', () => {
  const { r, rasters, cache } = rig({ objects: WORLD() });
  r.draw(frame(2));
  drain(r);
  const n = rasters.length, pre = cache.stats().preBytes;
  assert.ok(pre > 0);
  r.draw(frame(1));
  assert.equal(rasters.length, n, 'no raster in the zoom step frame');
  assert.equal(r.stats().pending, 0, 'no placeholder');
  assert.equal(cache.stats().preBytes, 0, 'the shown sprites are touched: no longer prefetched entries');
});

test('prefetch stays under the cache cap and never evicts the view sprites', () => {
  // room for the view's sprite and one more: one of the two next-step sprites fits, then prefetching stops
  const { r, cache, rasters } = rig({ objects: WORLD(), maxBytes: 200 });
  r.draw(frame(2));
  drain(r);
  assert.ok(cache.bytes <= cache.maxBytes, `${cache.bytes} <= ${cache.maxBytes}`);
  assert.ok([...cache.map.values()].some(e => !e.pre), 'the view sprite is still cached');
  assert.equal(rasters.filter(id => id === 'here').length, 1, 'the view sprite was never re-rastered');
  assert.equal(r.stats().prefetch.full, true);
  assert.equal(r.wantsPrefetch(), false);
});

test('no prefetch at Map zoom', () => {
  const { r } = rig({ objects: WORLD() });
  r.draw(frame(0.125));
  assert.equal(r.wantsPrefetch(), false);
  assert.equal(r.prefetchIdle(1e9).more, false);
});

test('a moved camera restarts the prefetch for the new view', () => {
  const { r, rasters } = rig({ objects: [...WORLD(), obj('east', 200, 0)] });
  r.draw(frame(2));
  drain(r);
  assert.ok(!rasters.includes('east'));
  const moved = { ...frame(2), cam: { x: 180, y: 0, z: 2 } };
  r.draw(moved);
  // a frame of a moving view rasters nothing: its sprites are built between frames, then the view shows them
  assert.equal(r.wantsPrefetch(), false, 'not while the view still has sprites to draw');
  r.rasterIdle(1e9);
  r.draw(moved);
  drain(r);
  assert.ok(rasters.includes('east'));
});

test('a moving view rasters nothing inside the frame; the sprites come between frames (rasterIdle)', () => {
  const { r, rasters } = rig({ objects: WORLD() });
  r.draw(frame(2));
  const n = rasters.length;
  r.draw(frame(1));                                           // a zoom step with nothing prefetched
  assert.equal(rasters.length, n, 'no raster in the step frame');
  assert.ok(r.stats().pending > 0, 'placeholders meanwhile');
  assert.ok(r.rasterIdle(1e9) > 0);
  r.draw(frame(1));
  assert.equal(r.stats().pending, 0);
});

// ---- ground ----
const mkWorld = (w, h) => ({ grid: { ox: 0, oy: 0, w, h, ground: new Uint8Array(w * h), terrain: new Uint8Array(w * h), road: null, version: 1 }, villages: [] });
const mkCanvas = () => (w, h) => ({ width: w, height: h, getContext: () => ({ drawImage() {}, fillRect() {}, clearRect() {}, set fillStyle(v) {}, set imageSmoothingEnabled(v) {} }) });
const gfx = () => ({ image() {}, poly() {}, rect() {} });

test('ground: a visit to Map zoom keeps the street-zoom bakes (LOD and 1x are bounded apart)', () => {
  const cache = createGroundCache({ maxChunks: 40, bakesPerFrame: 9999, budgetMs: Infinity });
  const g = createGround({ world: mkWorld(600, 600), cache, createCanvas: mkCanvas() });
  const v = { cssW: 1440, cssH: 900 }, street = { x: 300, y: 300, z: 1 };
  assert.ok(g.drawChunks(gfx(), street, v).baked > 0);   // 35 chunks: fits in 40
  const lod = g.drawChunks(gfx(), { x: 300, y: 300, z: 0.125 }, v);
  assert.ok(lod.baked > 40 * 16, 'the whole-world LOD is more chunks than both bounds');
  assert.equal(g.drawChunks(gfx(), street, v).baked, 0, 'back at 1x: nothing re-baked');
});

test('ground prebake: bakes the next view into free room only, never evicting', () => {
  const cache = createGroundCache({ maxChunks: 24, bakesPerFrame: 999, budgetMs: Infinity });
  const g = createGround({ world: mkWorld(600, 600), cache, createCanvas: mkCanvas() });
  const v = { cssW: 1440, cssH: 900 };
  g.drawChunks(gfx(), { x: 300, y: 300, z: 2 }, v);
  const before = cache.stats();
  let r, n = 0;
  do { r = g.prebake({ x: 300, y: 300, z: 1 }, v, 0); n += r.baked; } while (r.more);
  const after = cache.stats();
  assert.ok(n > 0 && before.chunks < 24, `${before.chunks} + ${n}`);
  assert.equal(after.evictions, before.evictions, 'no eviction');
  assert.equal(after.chunks, 24, 'filled the free room (the 1x view needs more than 24), no further');
  assert.equal(g.prebake({ x: 300, y: 300, z: 0.125 }, v, 0).baked, 0, 'Map LOD is never pre-baked');
});
