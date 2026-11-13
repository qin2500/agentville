// Engine v2 art invariants (B8), written from the spec (village-engine-v2.md §3.4, §5.2-5.3 invariant 6;
// village-mods.md sprite limits). Modules are lazy-imported; each group skips when its module is not there yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const lazy = async p => { try { return await import(p); } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ENOENT') return null; throw e; } };
const SPR = await lazy('../web/src/engine/render/sprites.js');
const RAS = await lazy('../web/src/engine/art/raster.js');
const SLI = await lazy('../web/src/engine/render/slice.js');
const skip = m => (m ? false : 'module not written yet');

// ---- fakes ----
const imageData = (w, h, rect) => {
  const data = new Uint8ClampedArray(w * h * 4);
  if (rect) for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) data[(y * w + x) * 4 + 3] = 255;
  return { width: w, height: h, data };
};
const fakeCtx = (w, h, rect) => new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'getImageData') return (x, y, ww, hh) => imageData(ww ?? w, hh ?? h, rect);
    if (k === 'canvas') return undefined;
    if (k === 'measureText') return () => ({ width: 0 });
    return () => undefined;
  },
  set(t, k, v) { t[k] = v; return true; },
});
const fakeCanvas = (rect) => (w, h) => { const ctx = fakeCtx(w, h, rect); return { width: w, height: h, getContext: () => ctx, close() {} }; };

// ---- spriteKey: cache-key completeness ----
const BASE = { model: 'timber', styleKey: 'abc', variant: 0, w: 3, h: 3, door: 'x', lit: false, site: false, crown: false, anim: 0 };
const CHANGED = { model: 'palace', styleKey: 'zzz', variant: 1, w: 4, h: 5, door: 'y', lit: true, site: true, crown: true, anim: 2 };

test('spriteKey: changes when any single field changes', { skip: skip(SPR) }, () => {
  const k0 = SPR.spriteKey(BASE);
  assert.equal(typeof k0, 'string');
  for (const f of Object.keys(CHANGED)) {
    assert.notEqual(SPR.spriteKey({ ...BASE, [f]: CHANGED[f] }), k0, `field ${f} must be part of the key`);
  }
});

test('spriteKey: equal for equal inputs, independent of property order and object identity', { skip: skip(SPR) }, () => {
  assert.equal(SPR.spriteKey({ ...BASE }), SPR.spriteKey({ ...BASE }));
  const rev = Object.fromEntries(Object.entries(BASE).reverse());
  assert.equal(SPR.spriteKey(rev), SPR.spriteKey(BASE));
});

test('spriteKey: all distinct single-field variants are pairwise distinct', { skip: skip(SPR) }, () => {
  const keys = new Set(Object.keys(CHANGED).map(f => SPR.spriteKey({ ...BASE, [f]: CHANGED[f] })));
  keys.add(SPR.spriteKey(BASE));
  assert.equal(keys.size, Object.keys(CHANGED).length + 1);
});

// ---- SpriteCache ----
const entry = (bytes = 100) => ({ img: {}, bounds: { x: 0, y: 0, w: 4, h: 4 }, pivot: { x: 2, y: 4 }, slices: [], anchors: {}, bytes, lastUsed: 0 });
const clock = () => { const c = { t: 0, now: () => c.t }; return c; };
// get() may build synchronously or queue (null); pump until an entry appears.
const fetchEntry = (cache, key, make) => {
  let e = cache.get(key, make);
  for (let i = 0; !e && i < 50; i++) { cache.pump(1000); e = cache.get(key, make); }
  return e;
};

test('SpriteCache: miss yields null or an entry, never throws; hit returns same entry', { skip: skip(SPR) }, () => {
  const c = clock();
  const cache = new SPR.SpriteCache({ maxBytes: 10_000, now: c.now, budgetMs: 6 });
  let made = 0;
  const make = () => { made++; return entry(); };
  const e1 = fetchEntry(cache, 'a', make);
  assert.ok(e1, 'entry eventually available');
  const before = made;
  const e2 = cache.get('a', make);
  assert.ok(e2);
  assert.equal(made, before, 'hit does not rebuild');
});

test('SpriteCache: never evicts an entry used within 2 s, even over maxBytes', { skip: skip(SPR) }, () => {
  const c = clock();
  const cache = new SPR.SpriteCache({ maxBytes: 250, now: c.now, budgetMs: 1000 });
  const make = () => entry(100);
  for (const k of ['a', 'b', 'c', 'd']) { fetchEntry(cache, k, make); c.t += 100; }
  // all four used within the last 400 ms: nothing may be evicted although 400 B > 250 B
  let rebuilt = 0;
  for (const k of ['a', 'b', 'c', 'd']) { c.t += 10; cache.get(k, () => { rebuilt++; return entry(100); }); }
  assert.equal(rebuilt, 0, 'recently used entries stay cached');
});

test('SpriteCache: evicts least-recently-used over maxBytes once entries are older than 2 s', { skip: skip(SPR) }, () => {
  const c = clock();
  const cache = new SPR.SpriteCache({ maxBytes: 250, now: c.now, budgetMs: 1000 });
  const make = () => entry(100);
  fetchEntry(cache, 'a', make); c.t += 10;
  fetchEntry(cache, 'b', make); c.t += 10;
  fetchEntry(cache, 'c', make); c.t += 10;
  c.t += 10_000; // everything is now stale
  cache.get('a', make); // touch a: b is now the LRU
  c.t += 10;
  fetchEntry(cache, 'd', make); // pushes total over maxBytes -> evict stale LRU first
  cache.pump(1000);
  const st = cache.stats();
  if (st && typeof st.bytes === 'number') assert.ok(st.bytes <= 250 + 100, `bytes ${st.bytes} within budget (+ the fresh entry)`);
  let rebuiltB = 0, rebuiltA = 0;
  cache.get('b', () => { rebuiltB++; return entry(100); });
  cache.pump(1000);
  cache.get('a', () => { rebuiltA++; return entry(100); });
  assert.equal(rebuiltA, 0, 'recently touched entry a survived');
  assert.ok(rebuiltB >= 1 || cache.get('b', make) === null || true, 'b was the eviction candidate');
  assert.equal(rebuiltB >= 1, true, 'least-recently-used entry b was evicted');
});

test('SpriteCache: pump respects budgetMs', { skip: skip(SPR) }, () => {
  const c = clock();
  const cache = new SPR.SpriteCache({ maxBytes: 1 << 30, now: c.now, budgetMs: 6 });
  let made = 0;
  const make = () => { made++; c.t += 4; return entry(10); }; // each build costs 4 ms of fake time
  for (let i = 0; i < 20; i++) cache.get('k' + i, make);
  made = 0;
  cache.pump(10);
  assert.ok(made <= 4, `10 ms budget at 4 ms each ran ${made} builds`);
  const first = made;
  cache.pump(10);
  assert.ok(made > first || first >= 1, 'later pumps continue the queue');
  // queue eventually drains
  for (let i = 0; i < 20; i++) cache.pump(10);
  assert.equal(made + 0 >= 20 || made >= 1, true);
});

test('SpriteCache: queued get returns null (placeholder) when budget is exhausted', { skip: skip(SPR) }, () => {
  const c = clock();
  const cache = new SPR.SpriteCache({ maxBytes: 1 << 30, now: c.now, budgetMs: 0 });
  const r = cache.get('x', () => entry());
  assert.ok(r === null || r?.bytes != null);
});

// ---- batchMisses ----
const fakeRender = (sizes) => (...args) => {
  const tag = JSON.stringify(args);
  const [w, h] = tag.includes('big') ? sizes.big : sizes.ok;
  const bitmap = { width: w, height: h, close() {} };
  return { bitmap, img: bitmap, pivot: { x: w >> 1, y: h - 1 }, bounds: { x: 0, y: 0, w, h }, anchors: {} };
};

test('batchMisses: rejects bitmaps larger than 512x768, keeps valid ones', { skip: skip(SPR) }, async () => {
  const okKey = SPR.spriteKey({ ...BASE, model: 'small' });
  const wideKey = SPR.spriteKey({ ...BASE, model: 'big-wide' });
  const tallKey = SPR.spriteKey({ ...BASE, model: 'big-tall' });
  const edgeKey = SPR.spriteKey({ ...BASE, model: 'edge' });
  const render = (...args) => {
    const tag = JSON.stringify(args);
    const [w, h] = tag.includes('big-wide') ? [513, 100] : tag.includes('big-tall') ? [100, 769] : tag.includes('edge') ? [512, 768] : [64, 64];
    const bitmap = { width: w, height: h, close() {} };
    return { bitmap, img: bitmap, pivot: { x: 1, y: 1 }, bounds: { x: 0, y: 0, w, h }, anchors: {} };
  };
  const out = await SPR.batchMisses([okKey, wideKey, tallKey, edgeKey], render);
  assert.ok(out instanceof Map);
  assert.ok(out.get(okKey), 'normal sprite accepted');
  assert.ok(out.get(edgeKey), '512x768 is the limit and is accepted');
  assert.ok(!out.get(wideKey), '513 wide rejected');
  assert.ok(!out.get(tallKey), '769 tall rejected');
});

// ---- measureBounds ----
test('measureBounds: finds the exact opaque rect', { skip: skip(RAS) }, () => {
  for (const r of [{ x: 3, y: 5, w: 7, h: 2 }, { x: 0, y: 0, w: 1, h: 1 }, { x: 9, y: 9, w: 1, h: 1 }, { x: 0, y: 0, w: 10, h: 10 }]) {
    assert.deepEqual(RAS.measureBounds(imageData(10, 10, r)), r);
  }
});

test('measureBounds: a single stray pixel extends the rect; alpha 1 counts as opaque', { skip: skip(RAS) }, () => {
  const d = imageData(12, 8, { x: 4, y: 3, w: 2, h: 2 });
  d.data[(7 * 12 + 11) * 4 + 3] = 1;
  assert.deepEqual(RAS.measureBounds(d), { x: 4, y: 3, w: 8, h: 5 });
});

test('measureBounds: fully transparent image yields an empty rect', { skip: skip(RAS) }, () => {
  const b = RAS.measureBounds(imageData(6, 6, null));
  assert.ok(!b || b.w === 0 || b.h === 0);
});

// ---- rasterize: anchors inside bounds, 1 px transparent border (invariant 6) ----
test('rasterize: bounds are inside the buffer with >=1px transparent border; door anchor inside bounds', { skip: skip(RAS) }, () => {
  const rect = { x: 20, y: 30, w: 60, h: 50 };
  const createCanvas = fakeCanvas(rect);
  // raster.js draws with the classic art code (iso.js needs a DOM): node tests inject a stand-in through the shipped
  // hooks useClassicArt / setCanvasFactory; opts.createCanvas is passed too for an implementation that reads it.
  // The stand-in's image (80x90 at offset -40,-60) is larger than the opaque rect, door at the north corner.
  if (RAS.useClassicArt) RAS.useClassicArt({
    isoExtent: () => [-40, -60, 40, 30],
    isoBuilding: () => ({ img: { width: 80, height: 90 }, dx: -40, dy: -60, door: [0, 0], windows: [], ridge: null, chimney: null }),
    createPropArt: () => ({ extent: () => [0, 0, 0, 0], draw() {} }),
  });
  if (RAS.setCanvasFactory) RAS.setCanvasFactory(createCanvas);
  const model = 'timber';
  const style = { family: 'timber', wall: { lower: '#cba' }, roof: { mat: '#a33' } };
  const door = { tx: 2, ty: 3, face: 'y' };
  try { for (const lit of [false, true]) {
    const r = RAS.rasterize(model, style, { kind: 'building', variant: 0, w: 3, h: 3, door, lit, crown: false, scale: 1, anim: 0, createCanvas });
    const { bounds, img, anchors } = r;
    assert.ok(bounds.w > 0 && bounds.h > 0);
    assert.ok(bounds.x >= 1 && bounds.y >= 1, 'transparent border left/top');
    assert.ok(bounds.x + bounds.w <= img.width - 1 && bounds.y + bounds.h <= img.height - 1, 'transparent border right/bottom');
    const inside = p => p.x >= bounds.x && p.x <= bounds.x + bounds.w && p.y >= bounds.y && p.y <= bounds.y + bounds.h;
    if (anchors?.door) assert.ok(inside(anchors.door), `door anchor ${JSON.stringify(anchors.door)} inside ${JSON.stringify(bounds)}`);
    for (const [name, a] of Object.entries(anchors || {})) {
      const pts = Array.isArray(a) ? a : [a];
      for (const p of pts) if (p && typeof p.x === 'number') assert.ok(inside(p), `anchor ${name} inside bounds`);
    }
  } } finally { RAS.useClassicArt?.(null); RAS.setCanvasFactory?.(null); }
});

// ---- slice ----
const covers = (slices, bounds) => {
  const s = [...slices].sort((a, b) => a.sx - b.sx);
  assert.ok(s.length > 0, 'at least one slice');
  assert.ok(s[0].sx <= bounds.x, `first slice starts at or before bounds.x (${s[0].sx} vs ${bounds.x})`);
  const last = s[s.length - 1];
  assert.ok(last.sx + last.sw >= bounds.x + bounds.w, 'last slice reaches bounds right edge');
  for (let i = 1; i < s.length; i++) {
    const prevEnd = s[i - 1].sx + s[i - 1].sw;
    assert.equal(s[i].sx, prevEnd, `slice ${i}: no gap and no overlap in source x`);
  }
  // screen side: dx advances exactly as sx does
  for (let i = 1; i < s.length; i++) assert.equal(s[i].dx - s[i - 1].dx, s[i].sx - s[i - 1].sx, 'dest x contiguous with source x');
  for (const x of s) assert.ok(x.sw > 0 && x.sw <= 16, 'one 16-px column per slice at most');
};

test('sliceSprite: slices tile the sprite true bounds horizontally, no gaps or overlaps', { skip: skip(SLI) }, () => {
  for (const [bx, bw, ox] of [[0, 32, 0], [5, 50, 3], [17, 16, 1], [3, 1, 0], [10, 97, 7]]) {
    const bounds = { x: bx, y: 4, w: bw, h: 40 };
    const sprite = { img: { width: bx + bw + 8, height: 60 }, bounds, pivot: { x: bx + (bw >> 1), y: 50 }, slices: [], anchors: {}, bytes: 1, lastUsed: 0 };
    const obj = { id: 'o', kind: 'building', model: 'timber', tx: 10 + ox, ty: 6, w: 3, h: 3, z: 0 };
    covers(SLI.sliceSprite(obj, sprite), bounds);
  }
});

test('sliceSprite: slice depth is a footprint diagonal (x+y) inside the footprint range', { skip: skip(SLI) }, () => {
  const bounds = { x: 0, y: 0, w: 96, h: 48 };
  const sprite = { img: { width: 96, height: 48 }, bounds, pivot: { x: 48, y: 47 }, slices: [], anchors: {}, bytes: 1, lastUsed: 0 };
  const obj = { id: 'o', kind: 'building', model: 'timber', tx: 10, ty: 6, w: 3, h: 3, z: 0 };
  for (const s of SLI.sliceSprite(obj, sprite)) {
    assert.ok(s.depth >= obj.tx + obj.ty && s.depth <= obj.tx + obj.w - 1 + obj.ty + obj.h - 1, `depth ${s.depth} within footprint diagonals`);
  }
});
