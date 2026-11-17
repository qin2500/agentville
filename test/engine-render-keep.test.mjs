// M7 perf: the kept street view, the sprite-free Map view, the sprite queue cancel and the hit merge.
// Spec (M7 perf brief): a still view does no per-frame static work; Map zoom draws cached tiles (map-tiles.js); the kept draw
// gives the same hits as the full one; nothing about the result depends on which way a frame was drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { SpriteCache } from '../web/src/engine/render/sprites.js';
import { buildHits, mergeHits, sliceIndex } from '../web/src/engine/render/hits.js';
import { mergeSorted, sortKey, feetKey, LAYER } from '../web/src/engine/render/depth.js';
import { createGfx } from '../web/src/engine/render/gfx-canvas2d.js';
import { toScreen } from '../web/src/engine/core/coords.js';

// ---- a renderer over fakes, with a gfx that records and can keep layers
function mk({ objects = [], keep = true, pending = 0, readyAll = true } = {}) {
  const ops = [], gets = { n: 0, cancel: 0 };
  const gfx = {
    begin: () => ops.push('begin'), clear: () => ops.push('clear'), end: () => ops.push('end'),
    image: (img, ...r) => ops.push(['image', img.tag, ...r]), rect: () => ops.push('rect'), poly: () => ops.push('poly'),
    rects: (r, c) => ops.push(['rects', r.length / 4, c]), setComposite() {}, size: () => ({ w: 800, h: 600 }),
    ...(keep ? {
      saveLayer: name => { ops.push(['save', name]); return true; },
      drawLayer: name => { ops.push(['layer', name]); return true; },
      clipRects: rects => ops.push(['clip', rects.length]), unclip: () => ops.push('unclip'),
    } : {}),
  };
  class Cache {
    constructor() { this.m = new Map(); this.map = this.m; }
    get(key, make) {
      gets.n++;
      if (!readyAll) return null;
      if (!this.m.has(key)) { make(); this.m.set(key, { img: { tag: key, width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }); }
      return this.m.get(key);
    }
    pump() {}
    cancel() { gets.cancel++; return 0; }
    stats() { return { queued: 0 }; }
  }
  const deps = {
    SpriteCache: Cache,
    spriteKey: o => `${o.model}|${o.styleKey}|${o.variant}|${o.w}`,
    placeholder: o => ({ img: { tag: 'ph:' + o.id, width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }),
    sliceSprite: (obj, sp) => {
      const p = toScreen(obj.tx, obj.ty), depth = obj.tx + obj.w - 1 + obj.ty + obj.h - 1;
      return [{ key: sortKey(depth, 0, LAYER.OBJECT, obj.tx - obj.ty), col: obj.tx - obj.ty, depth, sx: 0, sy: 0, sw: 16, sh: 32, dx: p.sx, dy: p.sy - 32, img: sp.img }];
    },
    rasterize: () => ({}),
    artView: o => o,
    createGround: () => ({ drawChunks: () => { ops.push('ground'); return { pending }; }, chunkKeys: () => [], invalidate() {} }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw: () => ops.push('light') }),
    createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }),
    createActorArt: () => ({ frame: () => ({ img: { tag: 'actor', width: 16, height: 24 }, pivot: { x: 8, y: 24 } }), load() {} }),
    effects: { draw: () => ops.push('effects') },
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), version: 1, villages: [] });
  return { r, ops, gets };
}
const bld = (id, tx, ty) => ({ id, kind: 'building', model: 'cottage', tx, ty, w: 1, h: 1, z: 20, walk: 'block', styleKey: 's', variant: 0 });
const frame = (o = {}) => ({ cam: { x: 0, y: 0, z: 2 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t: 0, night: 0, mode: 'town', ...o });
const actor = (id, x, y) => ({ id, kind: 'agent', x, y, face: 0, anim: 'idle', frame: 0, look: {}, flags: 0 });
const town = () => [bld('a', 0, 0), bld('b', 3, 0), bld('c', 0, 3), bld('d', 4, 4), bld('e', -3, 2)];
const images = ops => ops.filter(o => Array.isArray(o) && o[0] === 'image').map(o => o[1]);
const strip = hs => hs.map(h => ({ id: h.id, kind: h.kind, rect: h.rect, key: h.key, occluded: !!h.occluded }));

test('a still street view: full while it moves, then kept as ground + static layers, then only the actors are redrawn', () => {
  const { r, ops } = mk({ objects: town() });
  const f = frame({ actors: [actor('p', 1.5, 1.5)] });
  r.draw(f);
  assert.equal(r.stats().way, 'full', 'a new camera draws everything');
  ops.length = 0;
  r.draw(f);
  assert.equal(r.stats().way, 'keep', 'the camera held still for a frame: keep the layers');
  assert.deepEqual(ops.filter(o => o[0] === 'save').map(o => o[1]), ['ground', 'static']);
  ops.length = 0;
  r.draw(f);
  assert.equal(r.stats().way, 'kept');
  assert.ok(!ops.includes('ground') && !ops.includes('clear'), 'no ground, no clear: the kept layer covers the view');
  assert.deepEqual(ops.filter(o => o[0] === 'layer').map(o => o[1]), ['static', 'ground'], 'static layer, then kept ground inside the clip');
  assert.ok(ops.some(o => o[0] === 'clip') && ops.includes('unclip'));
  const imgs = images(ops);
  assert.ok(imgs.includes('actor'), 'the actor is drawn');
  assert.ok(imgs.length < 1 + town().length, 'only the slices under the actor are redrawn, not the whole town');
});

test('the kept draw gives exactly the hits of the full draw (order, rects, keys)', () => {
  const f = frame({ actors: [actor('p', 1.5, 1.5), actor('q', 3.5, 0.5), actor('r', -2.5, 2.5)] });
  const kept = mk({ objects: town() }), full = mk({ objects: town(), keep: false });
  let hk, hf;
  for (let i = 0; i < 3; i++) { hk = kept.r.draw(f); hf = full.r.draw(f); }
  assert.equal(kept.r.stats().way, 'kept');
  assert.equal(full.r.stats().way, 'full');
  assert.deepEqual(strip(hk), strip(hf));
});

test('setKeep(false) always takes the full draw; a moving camera or pending sprite never keeps', () => {
  const a = mk({ objects: town() });
  a.r.setKeep(false);
  for (let i = 0; i < 3; i++) a.r.draw(frame());
  assert.equal(a.r.stats().way, 'full');
  const b = mk({ objects: town() });
  for (let i = 0; i < 4; i++) b.r.draw(frame({ cam: { x: i, y: 0, z: 2 } }));
  assert.equal(b.r.stats().way, 'full', 'each frame has a new camera');
  const c = mk({ objects: town(), readyAll: false });
  for (let i = 0; i < 3; i++) c.r.draw(frame());
  assert.equal(c.r.stats().way, 'full', 'placeholders still up: nothing is kept');
  const d = mk({ objects: town(), pending: 1 });
  for (let i = 0; i < 3; i++) d.r.draw(frame());
  assert.ok(!d.ops.some(o => o[0] === 'save'), 'a flat ground chunk is never kept');
});

test('Map zoom draws the static town from tiles (no footprint diamonds, no dots), actors as sprites, and keeps its layer', () => {
  const { r, ops } = mk({ objects: town() });
  const f = frame({ cam: { x: 0, y: 0, z: 0.25 }, mode: 'map', actors: [actor('p', 1.5, 1.5), actor('q', 2.5, 2.5)] });
  const h1 = r.draw(f);
  assert.deepEqual(h1.map(h => h.kind), ['agent', 'agent'], 'actor hits only');
  assert.ok(!ops.includes('poly'), 'no footprint diamonds');
  assert.ok(!ops.some(o => o[0] === 'rects'), 'no dot batch');
  assert.equal(images(ops).filter(t => t === 'actor').length, 2, 'both actors drawn as their sprite');
  ops.length = 0;
  const h2 = r.draw(f);
  assert.deepEqual(strip(h2), strip(h1));
});

test('SpriteCache.cancel drops the queue; the next get queues the job again', () => {
  let t = 0;
  const c = new SpriteCache({ now: () => t, budgetMs: 0 });
  assert.equal(c.get('a', () => ({ img: { width: 1, height: 1 } })), null, 'no budget: queued');
  assert.equal(c.stats().queued, 1);
  assert.equal(c.cancel(), 1);
  assert.equal(c.stats().queued, 0);
  c.get('a', () => ({ img: { width: 1, height: 1 } }));
  assert.equal(c.stats().queued, 1);
});

test('mergeHits of static and actor hit lists equals the hits of the merged draw list', () => {
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const toCss = (x, y) => [x, y];
  for (let round = 0; round < 50; round++) {
    const slices = [], actors = [];
    for (let i = 0; i < 30; i++) {
      const d = Math.floor(rnd() * 20), c = Math.floor(rnd() * 10) - 5;
      slices.push({ key: sortKey(d, 0, rnd() < 0.3 ? LAYER.GROUND_PROP : LAYER.OBJECT, c), oid: `s${i}`, hit: rnd() < 0.5 ? 'house' : null, sx: 0, sy: 0, sw: 16, sh: 24, dx: c * 16, dy: d * 8 - 24, img: {} });
    }
    for (let i = 0; i < 8; i++) {
      const x = rnd() * 10, y = rnd() * 10, p = toScreen(x, y);
      actors.push({ key: feetKey(x, y, LAYER.ACTOR), actor: { id: `a${i}` }, x, y, p, oid: `a${i}`, hit: 'agent', z: 0, w: 16, h: 24, pivot: { x: 8, y: 24 } });
    }
    slices.sort((a, b) => a.key - b.key); actors.sort((a, b) => a.key - b.key);
    const want = buildHits(mergeSorted([slices, actors]), toCss);
    const got = mergeHits(buildHits(slices, toCss), buildHits(actors, toCss, { index: sliceIndex(slices) }));
    assert.deepEqual(got.map(h => [h.id, h.key, !!h.occluded]), want.map(h => [h.id, h.key, !!h.occluded]));
  }
});

test('gfx: clipRects grows each rect to whole device px; saveLayer copies the canvas, drawLayer puts it back', () => {
  const calls = [];
  const ctxOf = tag => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([tag, k, ...a])), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = { width: 0, height: 0, clientWidth: 100, clientHeight: 50, getContext: () => ctxOf('main') };
  const made = [];
  const g = createGfx(canvas, { makeCanvas: (w, h) => { const c = { width: w, height: h, getContext: () => ctxOf('layer') }; made.push(c); return c; } });
  g.begin(1.5, { x: 0, y: 0, z: 1.5 });   // scale 2.25, fractional translation
  calls.length = 0;
  g.clipRects([[0.2, 0.2, 10.1, 4.9]]);
  const r = calls.find(c => c[0] === 'main' && c[1] === 'rect');
  assert.ok(r.slice(2).every(Number.isInteger), 'device px, whole');
  assert.ok(calls.some(c => c[1] === 'clip'));
  g.unclip();
  assert.equal(g.saveLayer('x'), true);
  assert.equal(made.length, 1);
  assert.ok(calls.some(c => c[0] === 'layer' && c[1] === 'drawImage' && c[2] === canvas), 'the layer copies the canvas');
  assert.equal(g.drawLayer('x'), true);
  assert.ok(calls.some(c => c[0] === 'main' && c[1] === 'drawImage' && c[2] === made[0]));
  assert.equal(g.drawLayer('nope'), false, 'an unknown layer draws nothing');
});

test('the renderer sprite cache is capped at 48 MB, and the LRU drops stale entries to the cap on the next build', async () => {
  const { SPRITE_CACHE_BYTES } = await import('../web/src/engine/render/renderer.js');
  assert.equal(SPRITE_CACHE_BYTES, 48 << 20);
  let t = 0;
  const big = () => ({ img: { width: 1024, height: 1024 } });   // 4 MB each
  const c = new SpriteCache({ maxBytes: SPRITE_CACHE_BYTES, now: () => t, budgetMs: 1e9 });
  for (let i = 0; i < 20; i++) c.get(`k${i}`, big);
  assert.ok(c.stats().bytes > SPRITE_CACHE_BYTES, 'entries used in the last 2 s are kept over the cap (no thrash)');
  t = 5000;
  c.get('fresh', big);
  assert.ok(c.stats().bytes <= SPRITE_CACHE_BYTES, 'once stale, they are dropped back to the cap');
  assert.ok(c.map.has('fresh'));
});
