// M7 noph: nothing shows as a placeholder box or flat ground during or after a camera move.
// Rule: while a moving view rasters nothing, each sprite draws the nearest raster the engine holds (an evicted
// sprite the object still holds goes back into the cache as it is; else the other lit variant or the object's last
// sprite, drawn until the real one is built); a placeholder only for a sprite never rastered at any key, and only until
// the next frame builds it. Ground draws another bake of the chunk (the other LOD, an older bake) scaled, never flat
// once any bake exists. Actors are never deferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { SpriteCache } from '../web/src/engine/render/sprites.js';
import { createGroundCache } from '../web/src/engine/render/ground-cache.js';
import { createGround } from '../web/src/engine/render/ground.js';
import { toScreen } from '../web/src/engine/core/coords.js';

let imgN = 0;
const ent = (bytes = 100) => ({ img: { width: 4, height: 4, n: ++imgN }, bounds: { x: 0, y: 0, w: 4, h: 4 }, pivot: { x: 2, y: 4 }, anchors: {}, bytes });

// ---- SpriteCache.adopt ----
test('adopt: an evicted entry goes back as the same object, its bytes counted, no make()', () => {
  let t = 0;
  const c = new SpriteCache({ maxBytes: 1000, now: () => t, budgetMs: 1e9 });
  const e = c.get('a', () => ent());
  c.map.delete('a'); c.bytes -= e.bytes;                       // evicted; the caller still holds e
  t = 5;
  assert.equal(c.adopt('a', e), true);
  assert.equal(c.get('a', () => { throw new Error('no make'); }), e);
  assert.equal(c.bytes, 100); assert.equal(e.lastUsed, 5); assert.equal(e.pre, false);
  assert.equal(c.adopt('a', e), false, 'already cached');
  assert.equal(c.stats().adopted, 1);
});

test('adopt as a prefetched entry only into free room', () => {
  let t = 0;
  const c = new SpriteCache({ maxBytes: 200, now: () => t, budgetMs: 1e9 });
  c.get('v1', () => ent()); c.get('v2', () => ent());           // the view fills the cap
  const e = ent();
  assert.equal(c.adopt('x', e, true), false);
  assert.ok(!c.map.has('x') && c.bytes === 200);
  assert.equal(c.adopt('x', e), true, 'for the view it goes in (over the cap, as a build would)');
});

// ---- renderer rig ----
const LAYER = { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 };
const sortKey = (d, s, l, c) => ((d * 4 + s) * 8 + l) * 4096 + (c + 2048);
function rig({ objects, actorArt = null, cartArt = true }) {
  let t = 0;
  const clock = { get t() { return t; }, set t(v) { t = v; } };
  const cache = new SpriteCache({ maxBytes: 1 << 20, now: () => t, budgetMs: 1e9 });
  const rasters = [], images = [];
  const gfx = { begin() {}, clear() {}, end() {}, image(img) { images.push(img); }, rect() {}, poly() {}, setComposite() {}, size: () => ({ w: 1600, h: 1200 }) };
  const deps = {
    LAYER, sortKey, mergeSorted: lists => lists.flat().sort((a, b) => a.key - b.key), cache, loadClassicArt: undefined,
    spriteKey: o => `${o.model}|${o.variant}|${o.lit ? 1 : 0}|${o.crown ? 1 : 0}`,
    placeholder: () => ({ ...ent(), placeholder: true }),
    sliceSprite: (obj, sp) => { const p = toScreen(obj.tx, obj.ty); return [{ key: sortKey(obj.tx + obj.ty, 0, 1, 0), sx: 0, sy: 0, sw: 4, sh: 4, dx: p.sx, dy: p.sy, img: sp.img }]; },
    rasterize: (model, style, o) => { rasters.push(o.obj?.id ?? model); return model === 'cart' && !cartArt ? null : ent(); },
    artView: o => ({ ...o }),
    createGround: () => ({ drawChunks() { return { pending: 0 }; } }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }),
    createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }),
    ...(actorArt ? { createActorArt: () => actorArt } : {}),
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps, debug: true });
  const setWorld = objs => r.setWorld({ objects: new Map(objs.map(o => [o.id, o])), version: 1 });
  setWorld(objects);
  return { r, cache, rasters, images, clock, setWorld };
}
const obj = (id, tx, ty, o = {}) => ({ id, kind: 'building', model: 'm', tx, ty, w: 1, h: 1, z: 10, styleKey: 's', variant: id.length, ...o });
const view = { cssW: 1600, cssH: 1200, dpr: 1 };
let camX = 0;
// every call is a new camera: the view moved, so the frame rasters nothing (a pan step)
const moved = (o = {}) => ({ cam: { x: (camX += 0.5), y: 0, z: 2 }, view, actors: [], night: 0, mode: 'town', ...o });
const delta = (r, before) => { const d = r.stats().draws; return Object.fromEntries(Object.keys(d).map(k => [k, d[k] - (before?.[k] ?? 0)])); };

test('moving: a sprite the cache evicted but the object still holds is put back, never re-rastered or drawn as a box', () => {
  const { r, cache, rasters, clock } = rig({ objects: [obj('a', 0, 0), obj('bb', 2, 0)] });
  r.draw(moved());
  assert.deepEqual(rasters.sort(), ['a', 'bb']);
  const held = cache.map.get([...cache.map.keys()].find(k => k.startsWith('m|1|')));
  for (const [k, e] of [...cache.map]) { cache.map.delete(k); cache.bytes -= e.bytes; }   // LRU pressure took both
  clock.t = 5000;                                              // the next frame's sprite check runs
  const d0 = r.stats().draws;
  r.draw(moved());
  assert.equal(rasters.length, 2, 'no raster');
  assert.equal(delta(r, d0).placeholder, 0);
  assert.equal(cache.map.get([...cache.map.keys()].find(k => k.startsWith('m|1|'))), held, 'the same entry is cached again');
  assert.equal(r.stats().pending, 0, 'real sprites: nothing pending');
});

test('moving: after a world rebuild an evicted sprite is still put back (no box, no raster)', () => {
  const objs = [obj('a', 0, 0)];
  const { r, cache, rasters, setWorld } = rig({ objects: objs });
  r.draw(moved());
  for (const [k, e] of [...cache.map]) { cache.map.delete(k); cache.bytes -= e.bytes; }
  setWorld(objs.map(o => ({ ...o })));
  const d0 = r.stats().draws;
  r.draw(moved());
  assert.equal(rasters.length, 1);
  assert.equal(delta(r, d0).placeholder, 0);
});

test('moving at dusk: the lit sprite is not built yet, the day sprite draws (soft), never a box', () => {
  const { r, rasters } = rig({ objects: [obj('a', 0, 0)] });
  r.draw(moved());
  const d0 = r.stats().draws;
  r.draw(moved({ night: 1 }));
  assert.equal(rasters.length, 1, 'the lit variant is not rastered in a moving frame');
  const d = delta(r, d0);
  assert.equal(d.placeholder, 0); assert.ok(d.soft > 0, 'drawn from the day sprite');
  assert.ok(r.stats().pending > 0, 'still pending: the lit sprite replaces it once built');
});

test('moving: a restyled object (a new sprite key) draws its last sprite until the new one is built', () => {
  const objs = [obj('a', 0, 0)];
  const { r, rasters, setWorld, images } = rig({ objects: objs });
  r.draw(moved());
  const old = images.at(-1);
  setWorld([{ ...objs[0], crown: true }]);                     // same slice inputs, another sprite key
  const d0 = r.stats().draws, n = images.length;
  r.draw(moved());
  assert.equal(rasters.length, 1);
  assert.equal(delta(r, d0).placeholder, 0);
  assert.ok(images.slice(n).includes(old), 'the previous raster is drawn');
  r.rasterIdle(1e9);                                           // built between frames
  r.draw(moved());
  assert.equal(rasters.length, 2);
  assert.equal(r.stats().pending, 0);
});

test('moving: a sprite never rastered at any key is a box until the next idle slice builds it (never inside a frame)', () => {
  const { r, rasters } = rig({ objects: [obj('a', 0, 0)] });
  r.draw(moved());
  const { r: r2, rasters: ras2 } = rig({ objects: [obj('a', 0, 0), obj('far', 70, 0)] });
  r2.draw(moved());                                            // 2x at the origin: 'far' is off screen
  assert.deepEqual(ras2, ['a']);
  const d0 = r2.stats().draws;
  r2.draw({ ...moved(), cam: { x: 70, y: 0, z: 2 } });         // a jump onto it: nothing cached for it at all
  assert.equal(ras2.length, 1, 'no raster inside the frame that first needs it');
  assert.ok(delta(r2, d0).placeholder > 0);
  const d1 = r2.stats().draws;
  r2.draw({ ...moved(), cam: { x: 70.5, y: 0, z: 2 } });       // still moving, nothing built between: still nothing in-frame
  assert.equal(ras2.length, 1);
  assert.ok(r2.rasterIdle(1e9) > 0, 'built between frames');
  const d2 = r2.stats().draws;
  r2.draw({ ...moved(), cam: { x: 71, y: 0, z: 2 } });
  assert.deepEqual(ras2, ['a', 'far']);
  assert.equal(delta(r2, d2).placeholder, 0);
  assert.ok(delta(r2, d1).placeholder > 0);
  assert.equal(rasters.length, 1);
});

// ---- actors: always full quality ----
test('actors are never deferred: an agent draws its art and a cart is rastered even in a moving frame', () => {
  const frameImg = { width: 20, height: 22, agent: true };
  const actorArt = { load() {}, ready: true, frame: a => (a.kind === 'agent' ? { img: frameImg, pivot: { x: 10, y: 18 } } : null), stats: () => ({ looks: 1 }) };
  const { r, rasters, images, cache } = rig({ objects: [obj('a', 0, 0)], actorArt });
  r.draw(moved());
  const actors = [{ id: 'ag', kind: 'agent', x: 0.5, y: 0.5 }, { id: 'c1', kind: 'cart', x: 1.5, y: 0.5, face: 0 }];
  const d0 = r.stats().draws, n = images.length;
  r.draw(moved({ actors }));
  assert.ok(images.slice(n).includes(frameImg), 'the agent draws its own frame');
  assert.ok(rasters.includes('cart'), 'the cart sprite is built inside the moving frame');
  assert.ok([...cache.map.keys()].some(k => k.startsWith('cart|')));
  assert.equal(delta(r, d0).placeholder, 0, 'no actor drawn as a box');
});

// ---- ground ----
const mkWorld = (w, h) => ({ grid: { ox: 0, oy: 0, w, h, ground: new Uint8Array(w * h), terrain: new Uint8Array(w * h), road: null, version: 1 }, villages: [] });
let cvN = 0;
const mkCanvas = (w, h) => ({ width: w, height: h, n: ++cvN, getContext: () => ({ drawImage() {}, fillRect() {}, clearRect() {}, set fillStyle(v) {}, set imageSmoothingEnabled(v) {} }) });
const rec = () => { const g = { images: [], polys: 0, image(img, ...a) { g.images.push({ img, a }); }, poly() { g.polys++; }, rect() {} }; return g; };
const V = { cssW: 1440, cssH: 900 };

test('ground, moving at street zoom: a chunk with only a Map LOD bake draws that bake scaled up, never flat', () => {
  const cache = createGroundCache({ maxChunks: 64, bakesPerFrame: 9999, budgetMs: Infinity });
  const g = createGround({ world: mkWorld(200, 200), cache, createCanvas: mkCanvas });
  g.drawChunks(rec(), { x: 100, y: 100, z: 0.125 }, V);        // Map zoom baked the LOD of everything
  const gx = rec(), r = g.drawChunks(gx, { x: 100, y: 100, z: 1 }, { ...V, maxBakes: 0 });
  assert.equal(r.flat, 0); assert.equal(gx.polys, 0, 'no flat quad');
  assert.ok(r.soft > 0 && r.pending === r.soft, 'drawn from the LOD, still pending its own bake');
  const lod = gx.images[0];
  assert.equal(lod.a[2], 128, 'the 128x64 LOD bitmap'); assert.equal(lod.a[6], 512, 'stretched to the 512 px chunk');
});

test('ground at Map zoom: a chunk whose 1x bake is cached gets its LOD sampled from it, whatever the bake cap', () => {
  const cache = createGroundCache({ maxChunks: 64, bakesPerFrame: 0, budgetMs: Infinity });
  const g = createGround({ world: mkWorld(40, 40), cache, createCanvas: mkCanvas });
  const n1 = g.drawChunks(rec(), { x: 20, y: 20, z: 1 }, { ...V, maxBakes: 99 }).baked;
  assert.equal(n1, 9, 'the whole 3x3-chunk world at 1x');
  const gx = rec(), r = g.drawChunks(gx, { x: 20, y: 20, z: 0.125 }, { ...V, maxBakes: 0 });
  assert.equal(r.flat, 0); assert.equal(r.pending, 0); assert.equal(gx.polys, 0);
  assert.equal(r.baked, 9, 'all nine sampled from their 1x bakes');
});

test('ground: an older bake of the chunk stands in after its content changed (no flat while the new one waits)', () => {
  const cache = createGroundCache({ maxChunks: 64, bakesPerFrame: 9999, budgetMs: Infinity });
  const world = mkWorld(40, 40), g = createGround({ world, cache, createCanvas: mkCanvas });
  const cam = { x: 20, y: 20, z: 1 };
  g.drawChunks(rec(), cam, V);
  world.grid.ground.fill(3); world.grid.version = 2;          // every chunk's content hash changes
  const gx = rec(), r = g.drawChunks(gx, cam, { ...V, maxBakes: 0 });
  assert.equal(r.flat, 0); assert.equal(gx.polys, 0);
  assert.equal(r.soft, 9);
});

test('ground: with no bake at all, a moving view bakes a chunk that was flat last frame (rescue)', () => {
  const cache = createGroundCache({ maxChunks: 64, bakesPerFrame: 9999, budgetMs: Infinity });
  const g = createGround({ world: mkWorld(40, 40), cache, createCanvas: mkCanvas });
  const cam = { x: 20, y: 20, z: 1 }, mv = { ...V, maxBakes: 0, rescue: 1 };
  const a = g.drawChunks(rec(), cam, mv);
  assert.equal(a.flat, 9, 'nothing baked anywhere yet: flat (the cold case)');
  const b = g.drawChunks(rec(), cam, mv);
  assert.equal(b.baked, 1); assert.equal(b.flat, 8);
});

test('prefetch: a chunk an earlier view built with sprites still pending is prefetched too (no box on the way back)', () => {
  const objs = [obj('a', 0, 0), obj('bbb', 60, 0)];
  const { r, rasters, cache } = rig({ objects: objs });
  r.draw({ ...moved(), cam: { x: 300, y: 300, z: 2 } });       // far away, nothing there
  r.draw({ ...moved(), cam: { x: 60, y: 0, z: 2 } });          // a view over 'bbb' that rasters nothing (moving)
  assert.ok(!rasters.includes('bbb'), 'bbb left pending in its built chunk');
  for (const k of [...cache.queue.keys()]) cache.queue.delete(k);   // the view moved on before the queue ran
  const home = { cam: { x: 0, y: 0, z: 2 }, view, actors: [], night: 0, mode: 'town' };
  r.draw(home); r.rasterIdle(1e9); r.draw(home); r.draw(home); // home view settled (holds still)
  for (let i = 0; i < 100 && r.wantsPrefetch(); i++) if (!r.prefetchIdle(1e9).more) break;
  assert.ok(rasters.includes('bbb'), `prefetched: ${rasters}`);
  const d0 = r.stats().draws;
  r.draw({ ...moved(), cam: { x: 30, y: 0, z: 2 } });           // pan back towards it
  r.draw({ ...moved(), cam: { x: 60, y: 0, z: 2 } });
  assert.equal(delta(r, d0).placeholder, 0);
});
