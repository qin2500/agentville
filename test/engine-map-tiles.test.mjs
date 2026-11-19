// Map zoom (z <= 1/4) is the same village, just smaller (it used to
// draw a simplified version when zoomed far out). Spec: the static town at Map zoom is the street view's own draw (ground, accent edges,
// every sprite slice back to front) cached as tiles at the device scale; actors are their real sprites; nothing is
// simplified (no footprint diamonds, no dots, no dropped trees or props). Tiles are keyed by content, so a rebuilt
// world with the same content re-bakes nothing, a changed object re-bakes only the tiles it reaches, and a stale tile
// stands in for its own re-bake. Baking is budgeted and the layer is kept once every tile is fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { TILE, tileRange, tilesOf, tileRect, downSteps, sigHash, createMapTiles } from '../web/src/engine/render/map-tiles.js';
import { createTileStore, memoryBackend } from '../web/src/engine/render/map-tile-store.js';
import { mergeSorted, sortKey, LAYER } from '../web/src/engine/render/depth.js';
import { toScreen } from '../web/src/engine/core/coords.js';

// ---- pure helpers
test('tile lattice: ranges, rects and nearest-first order', () => {
  assert.deepEqual(tileRange([0, 0, TILE, TILE]), [0, 0, 0, 0]);
  assert.deepEqual(tileRange([-1, -1, TILE + 1, 2 * TILE]), [-1, -1, 1, 1]);
  assert.deepEqual(tileRect(1, -2), [TILE, -2 * TILE, 2 * TILE, -TILE]);
  const t = tilesOf([-TILE, -TILE, TILE, TILE]);
  assert.equal(t.length, 4);
  assert.ok(t.every((x, i) => i === 0 || x.d >= t[i - 1].d), 'sorted by distance to the centre');
});

test('downSteps halve to the target size (a box filter), last step exact', () => {
  const T = TILE;
  assert.deepEqual(downSteps(T / 2), [T / 2]);
  assert.deepEqual(downSteps(T / 4), [T / 2, T / 4]);
  assert.deepEqual(downSteps(T / 8), [T / 2, T / 4, T / 8]);
  assert.deepEqual(downSteps(T * 0.375), [T / 2, T * 0.375]);   // dpr 1.5 at 1/4
  assert.deepEqual(downSteps(T), []);
  assert.deepEqual(downSteps(2 * T), []);
});

test('sigHash is stable and content-sensitive', () => {
  assert.equal(sigHash('abc'), sigHash('abc'));
  assert.notEqual(sigHash('abc'), sigHash('abd'));
});

// ---- fake canvases: record drawImage calls and smoothing state
function fakeCanvasFactory(log = []) {
  return (w, h) => {
    const ops = [], props = {};
    const ctx = new Proxy(props, {
      get: (t, k) => k === 'drawImage' ? (...a) => ops.push(['drawImage', a[0]?.tag ?? a[0]?.width, ...a.slice(1)]) : (k in t ? t[k] : () => {}),
      set: (t, k, v) => (t[k] = v, true), has: (t, k) => k === 'imageSmoothingQuality' || k in t,
    });
    const cv = { width: w, height: h, tag: `cv${w}`, ops, props, getContext: () => ctx };
    log.push(cv);
    return cv;
  };
}

test('createMapTiles: a tile is box-filtered down by halving into a slot of a CPU-backed atlas page', () => {
  const log = [], q = TILE / 4, mt = createMapTiles({ createCanvas: fakeCanvasFactory(log), page: 4 * q });
  const src = { width: TILE, height: TILE, tag: 'src' };
  const e = mt.store(0, 0, 0.25, 's', src);
  assert.equal(e.size, q);
  const page = log.find(c => c.width === 4 * q), mid = log.find(c => c.width === TILE / 2);
  assert.ok(page && mid, 'one page, one halving scratch');
  assert.equal(e.img, page, 'the tile is a slot of the page, not a canvas of its own');
  assert.deepEqual(mid.ops.find(o => o[0] === 'drawImage').slice(1, 2), ['src']);
  const into = page.ops.find(o => o[0] === 'drawImage');
  assert.deepEqual(into.slice(6, 10), [e.sx, e.sy, q, q], 'the last halving step lands in the slot');
  assert.equal(page.props.imageSmoothingEnabled, true);
  assert.equal(page.props.imageSmoothingQuality, 'high');
  // 16 slots on the page: every tile shares it
  const more = Array.from({ length: 15 }, (_, i) => mt.store(i + 1, 0, 0.25, 's', src));
  assert.ok(more.every(x => x.img === page));
  assert.equal(new Set([e, ...more].map(x => `${x.sx},${x.sy}`)).size, 16, 'distinct slots');
  assert.equal(mt.stats().pages, 1);
});

test('createMapTiles: the page budget evicts the least recently used unpinned tile into its slot; sea tiles take none', () => {
  const q = TILE / 4, mt = createMapTiles({ createCanvas: fakeCanvasFactory(), page: 2 * q, maxBytes: (2 * q) ** 2 * 4 });   // one page, 4 slots
  const src = { width: TILE, height: TILE, tag: 'src' };
  for (let i = 0; i < 4; i++) mt.store(i, 0, 0.25, 's', src);
  mt.get(0, 0, 0.25);                       // 0 is recent now: 1 is the oldest
  mt.pin([mt.keyOf(2, 0, 0.25)]);
  const e = mt.store(9, 9, 0.25, 's', src);
  assert.ok(e);
  assert.equal(mt.peek(1, 0, 0.25), undefined, 'the least recently used went');
  assert.ok(mt.peek(0, 0, 0.25) && mt.peek(2, 0, 0.25));
  assert.equal(mt.stats().pages, 1);
  const sea = mt.store(5, 5, 0.25, 's', null);
  assert.equal(sea.img, null);
  assert.equal(mt.stats().land, 4, 'sea holds no slot');
  // a step out: a bake at 1/4 halved from the 1/2 one, read from its slot
  const mt2 = createMapTiles({ createCanvas: fakeCanvasFactory(), page: 4 * q });
  const big = mt2.store(7, 7, 0.5, 's', src);
  const small = mt2.store(7, 7, 0.125, 's', big.img, big.size, big.sx, big.sy);
  assert.equal(mt2.stats().pages, 2, 'one page per tile size');
  assert.equal(small.size, TILE / 8);
});

// ---- the renderer at Map zoom, over fakes
function mk({ objects = [], readyAll = true, extra = {} } = {}) {
  const ops = [], tileOps = [], canvases = [], sliced = {};
  const gfx = {
    begin: () => ops.push('begin'), clear: () => ops.push('clear'), end: () => ops.push('end'),
    image: (img, ...r) => ops.push(['image', img.tag, ...r]), rect: () => ops.push('rect'), poly: () => ops.push('poly'),
    rects: (r, c) => ops.push(['rects', r.length / 4, c]), setComposite() {}, size: () => ({ w: 800, h: 600 }),
    saveLayer: () => { ops.push('save'); return true; }, drawLayer: () => { ops.push('layer'); return true; },
    clipRects() {}, unclip() {},
  };
  const ready = { all: readyAll };
  class Cache {
    constructor() { this.m = new Map(); this.map = this.m; this.queue = new Map(); }
    get(key, make) {
      if (!ready.all) { this.queue.set(key, make); return null; }
      if (!this.m.has(key)) { make(); this.m.set(key, { img: { tag: key, width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }); }
      return this.m.get(key);
    }
    pump() { return 0; }
    cancel() { return 0; }
    stats() { return { queued: this.queue.size }; }
  }
  const deps = {
    SpriteCache: Cache, mergeSorted,
    spriteKey: o => `${o.model}|${o.styleKey}|${o.variant}|${o.w}|${o.lit ? 'L' : ''}`,
    placeholder: o => ({ img: { tag: 'ph:' + o.id, width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [], placeholder: true }),
    sliceSprite: (obj, sp) => {
      sliced[obj.id] = (sliced[obj.id] || 0) + 1;
      const p = toScreen(obj.tx, obj.ty), depth = obj.tx + obj.w - 1 + obj.ty + obj.h - 1;
      return [{ key: sortKey(depth, 0, LAYER.OBJECT, obj.tx - obj.ty), col: obj.tx - obj.ty, depth, sx: 0, sy: 0, sw: 16, sh: 32, dx: p.sx - 8, dy: p.sy - 32, img: sp.img }];
    },
    rasterize: () => ({}),
    artView: o => o,
    createCanvas: fakeCanvasFactory(canvases),
    createGfx: () => ({
      begin: () => tileOps.push('begin'), clear: () => tileOps.push('clear'), end() {}, poly() {},
      image: img => tileOps.push(['image', img.tag]),
    }),
    createGround: () => ({ drawChunks: (g) => { (g === gfx ? ops : tileOps).push('ground'); return { pending: 0 }; }, chunkKeys: () => [{ key: 'g0' }], invalidate() {},
      // land is the 1x px square |x|, |y| < 600 round the origin; a tile wholly outside it paints no ground tile
      paintRect: (g, r) => { tileOps.push('ground'); return r[0] < 600 && r[2] > -600 && r[1] < 600 && r[3] > -600 ? 1 : 0; } }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw: () => ops.push('light') }),
    createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }),
    createActorArt: () => ({ frame: () => ({ img: { tag: 'actor', width: 16, height: 24 }, pivot: { x: 8, y: 24 } }), load() {} }),
    effects: { draw: () => ops.push('effects') },
    ...extra,
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  const setWorld = objs => r.setWorld({ objects: new Map(objs.map(o => [o.id, o])), version: 1, villages: [] });
  setWorld(objects);
  return { r, ops, tileOps, canvases, sliced, ready, setWorld };
}
const bld = (id, tx, ty, model = 'cottage') => ({ id, kind: 'building', model, tx, ty, w: 1, h: 1, z: 20, walk: 'block', styleKey: 's', variant: 0 });
const tree = (id, tx, ty) => ({ id, kind: 'tree', model: 'oak', tx, ty, w: 1, h: 1, z: 30, walk: 'block', variant: 0 });
const frame = (o = {}) => ({ cam: { x: 0, y: 0, z: 0.25 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t: 0, night: 0, mode: 'map', ...o });
const actor = (id, x, y) => ({ id, kind: 'agent', x, y, face: 0, anim: 'idle', frame: 0, look: {}, flags: 0 });
const town = () => [bld('a', 0, 0), bld('b', 3, 0), tree('t', 0, 3), bld('d', 4, 4), tree('u', -3, 2)];
const tileImgs = ops => ops.filter(o => Array.isArray(o) && o[0] === 'image' && /^cv/.test(o[1]));

test('Map zoom tiles are the full town draw: ground, then every building and tree slice, back to front', () => {
  const { r, ops, tileOps, sliced, canvases } = mk({ objects: town() });
  const f = frame({ actors: [actor('p', 1.5, 1.5)] });
  r.draw(f);
  assert.ok(!tileOps.length, 'a frame bakes nothing: tiles are baked between frames');
  for (let i = 0; i < 200 && (i === 0 || r.stats().groundPending); i++) { r.rasterIdle(50); ops.length = 0; r.draw(f); }   // the last draw: the one that blits the settled tiles
  for (const id of ['a', 'b', 't', 'd', 'u']) assert.ok(sliced[id] >= 1, `${id} sliced at its real sprite`);
  const drawn = tileOps.filter(o => Array.isArray(o)).map(o => o[1]);
  for (const k of ['cottage|s|0|1|', 'oak|null|0|1|']) assert.ok(drawn.includes(k), `${k} drawn into a tile`);
  assert.ok(tileOps.indexOf('ground') < tileOps.findIndex(o => Array.isArray(o)), 'ground under the sprites');
  assert.ok(tileImgs(ops).length >= 1, 'the cached tiles are drawn on the view');
  assert.ok(!ops.includes('poly') && !ops.some(o => o[0] === 'rects'), 'no footprint diamonds, no dots');
  // the actor is its sprite: drawn from the actor atlas, a page its own sprite was pre-scaled into (actor-atlas.js)
  const pages = canvases.filter(c => c.ops.some(o => o[0] === 'drawImage' && o[1] === 'actor'));
  assert.ok(pages.length === 1 && ops.some(o => Array.isArray(o) && o[0] === 'image' && o[1] === pages[0].tag), 'the actor is its sprite');
  assert.equal(r.stats().groundPending, 0);
});

test('a still Map view keeps its tiled layer; a pan reuses the baked tiles', () => {
  const { r, ops, tileOps } = mk({ objects: town() });
  const f = frame();
  r.draw(f); for (let i = 0; i < 200 && r.stats().groundPending; i++) { r.rasterIdle(50); r.draw(f); }   // idle slices are budgeted: run until settled
  assert.ok(ops.includes('save'), 'every tile fresh: the layer is kept');
  ops.length = 0; tileOps.length = 0;
  r.draw(f);
  assert.ok(ops.includes('layer') && !tileImgs(ops).length, 'the kept layer, no tile blits');
  ops.length = 0;
  r.draw({ ...f, cam: { x: 1, y: 0, z: 0.25 } });
  assert.ok(tileImgs(ops).length >= 1, 'a moved camera blits the tiles again');
  assert.equal(tileOps.filter(o => o === 'begin').length, 0, 'and bakes none of them again');
});

test('a rebuilt world with the same content re-bakes nothing; a changed object re-bakes only the tiles it reaches', () => {
  const far = bld('far', 40, -40);   // tiles of its own (sx 1280), away from the others
  const { r, tileOps, setWorld } = mk({ objects: [...town(), far] });
  const f = frame({ view: { cssW: 1600, cssH: 800, dpr: 1 } });
  // a big view: signatures and bakes are spread over frames and idle slices (budgeted); run until it settles
  const settle = () => { r.draw(f); r.rasterIdle(50); r.draw(f); for (let i = 0; i < 400 && r.stats().groundPending; i++) { r.rasterIdle(50); r.draw(f); } assert.equal(r.stats().groundPending, 0); };
  settle();
  const baked0 = r.stats().mapTiles.bakes;
  assert.ok(baked0 > 2);
  setWorld([...town(), { ...far }]);
  tileOps.length = 0;
  settle();
  assert.equal(r.stats().mapTiles.bakes, baked0, 'same content: no bake');
  setWorld([...town(), { ...far, model: 'smithy' }]);
  settle();
  const rebaked = r.stats().mapTiles.bakes - baked0;
  assert.ok(rebaked >= 1 && rebaked <= 8 && rebaked * 20 < baked0, `only the far object's tiles re-bake (got ${rebaked})`);
});

test('until its sprites are built a tile is pending: the ground stands in, nothing is kept, then it fills in', () => {
  const { r, ops, ready } = mk({ objects: town(), readyAll: false });
  r.draw(frame());
  assert.ok(r.stats().groundPending > 0, 'tiles pending');
  assert.ok(ops.includes('ground'), 'the ground stands in under the missing tiles');
  assert.ok(!ops.includes('save'), 'a stand-in is never kept');
  ready.all = true;
  for (let i = 0; i < 200 && (i === 0 || r.stats().groundPending); i++) { r.rasterIdle(50); ops.length = 0; r.draw(frame()); }
  assert.equal(r.stats().groundPending, 0);
  assert.ok(ops.includes('save'));
});

test('dusk re-bakes the tiles with the lit sprites, the day tiles standing in meanwhile', () => {
  const { r, tileOps } = mk({ objects: town() });
  r.draw(frame()); for (let i = 0; i < 200 && r.stats().groundPending; i++) { r.rasterIdle(50); r.draw(frame()); }
  tileOps.length = 0;
  r.draw(frame({ night: 0.8 }));
  assert.ok(r.stats().groundPending > 0, 'stale at dusk: pending');
  r.rasterIdle(50);
  assert.ok(tileOps.some(o => Array.isArray(o) && /\|L$/.test(o[1])), 'lit building sprites in the re-baked tiles');
});

test('open-sea tiles (no ground tile, no sprite) are kept as empty entries: no bitmap, no blit, no bytes', () => {
  const { r, ops } = mk({ objects: town() });
  const f = frame({ view: { cssW: 1600, cssH: 1200, dpr: 1 } });
  r.draw(f); for (let i = 0; i < 50 && r.stats().groundPending; i++) { r.rasterIdle(50); r.draw(f); }
  assert.equal(r.stats().groundPending, 0);
  const st = r.stats();
  assert.ok(st.mapBake.sea > 0 && st.mapBake.baked > 0, JSON.stringify(st.mapBake));
  ops.length = 0;
  r.draw({ ...f, cam: { x: 0.5, y: 0, z: 0.25 } });
  assert.equal(tileImgs(ops).length, st.mapBake.baked, 'only land tiles are blitted');
  assert.equal(st.mapTiles.land, st.mapBake.baked, 'sea tiles hold no slot');
});

test('a step out to 1/8 halves the fresh 1/4 bakes instead of drawing the tiles again', () => {
  const { r, tileOps } = mk({ objects: town() });
  const settle = f => { r.draw(f); for (let i = 0; i < 50 && r.stats().groundPending; i++) { r.rasterIdle(50); r.draw(f); } };
  settle(frame());
  const baked = r.stats().mapBake.baked;
  tileOps.length = 0;
  settle(frame({ cam: { x: 0, y: 0, z: 0.125 }, view: { cssW: 400, cssH: 300, dpr: 1 } }));   // the same world rect
  assert.ok(r.stats().mapBake.derived > 0);
  assert.equal(r.stats().mapBake.baked, baked, 'no tile drawn again');
  assert.ok(!tileOps.some(o => Array.isArray(o)), 'no sprite drawn into a tile');
});

test('baked tiles persist: a new renderer on the same store reads them back and bakes none (the ring too)', async () => {
  const backend = memoryBackend(), sleep = ms => new Promise(r => setTimeout(r, ms));
  const store = () => createTileStore({ backend, salt: 't', flushMs: 0, encode: async e => ({ size: 10, tag: e.size }), decode: async b => ({ width: b.tag, tag: 'decoded' }) });
  const settle = async (r, f) => {
    r.draw(f);
    for (let i = 0; i < 400 && (r.stats().groundPending || i < 2); i++) { r.rasterIdle(50); r.draw(f); await sleep(0); }
    for (let i = 0; i < 400 && r.prefetchIdle(50).more; i++) await sleep(0);   // the ring, in idle time
    r.rasterIdle(50); r.draw(f);
  };
  const f = frame();
  const A = mk({ objects: town(), extra: { createTileStore: store } });
  const sa = A.r.stats().mapStore;
  assert.equal(sa?.state, 'opening');
  await sleep(0); await sleep(0);
  await settle(A.r, f);
  const baked = A.r.stats().mapTiles.bakes, saved = A.r.stats().mapStore.saves;
  assert.equal(A.r.stats().groundPending, 0);
  assert.ok(saved >= baked && baked > 0, `every bake saved (${saved} of ${baked})`);
  assert.ok(saved > A.r.stats().mapTiles.pinned, 'the ring round the view baked and saved too');
  await sleep(5);
  assert.ok(backend.data.size >= saved, 'written to the backend');
  const B = mk({ objects: town(), extra: { createTileStore: store } });
  await sleep(0); await sleep(0);
  await settle(B.r, f);
  assert.equal(B.r.stats().groundPending, 0);
  assert.equal(B.tileOps.filter(o => o === 'begin').length, 0, 'no tile drawn again');
  assert.ok(B.r.stats().mapBake.stored > 0 && B.r.stats().mapStore.loads > 0, 'read back from the store');
  assert.ok(tileImgs(B.ops).length >= 1, 'and blitted');
  // a changed object: its tiles miss the store (another signature) and bake; the rest still read back
  const C = mk({ objects: [...town().slice(1), { ...bld('a', 0, 0), model: 'smithy' }], extra: { createTileStore: store } });
  await sleep(0); await sleep(0);
  await settle(C.r, f);
  const cb = C.tileOps.filter(o => o === 'begin').length;
  assert.ok(cb >= 1 && cb < baked, `only the changed tiles bake (${cb} of ${baked})`);
});
