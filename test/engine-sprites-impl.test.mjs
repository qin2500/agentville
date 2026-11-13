import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpriteCache, spriteKey, batchMisses, placeholder } from '../web/src/engine/render/sprites.js';
import { setCanvasFactory } from '../web/src/engine/art/raster.js';

const entry = (bytes = 100) => ({ img: { width: 5, height: 5 }, bounds: { x: 0, y: 0, w: 4, h: 4 }, pivot: { x: 2, y: 4 }, slices: [], anchors: {}, bytes });
const clock = () => { const c = { t: 0, now: () => c.t }; return c; };
const BASE = { model: 'hedge', styleKey: 's', variant: 0, w: 1, h: 1 };

test('null make is not cached; next get calls make again', () => {
  const cache = new SpriteCache({ now: clock().now });
  let n = 0;
  assert.equal(cache.get('k', () => { n++; return null; }), null);
  assert.equal(cache.get('k', () => { n++; return entry(); }) !== null, true);
  assert.equal(n, 2);
});

test('hit returns identical entry and touches lastUsed', () => {
  const c = clock(); const cache = new SpriteCache({ now: c.now });
  const a = cache.get('k', () => entry());
  c.t = 500;
  const b = cache.get('k', () => assert.fail('no rebuild'));
  assert.equal(a, b); assert.equal(b.lastUsed, 500);
});

test('bytes default to width*height*4', () => {
  const cache = new SpriteCache({ now: clock().now });
  const e = cache.get('k', () => ({ img: { width: 10, height: 3 } }));
  assert.equal(e.bytes, 120);
});

test('spriteKey includes dir and len; absent fields keep equality', () => {
  assert.notEqual(spriteKey({ ...BASE, dir: 'x', len: 3 }), spriteKey({ ...BASE, dir: 'y', len: 3 }));
  assert.notEqual(spriteKey({ ...BASE, dir: 'x', len: 3 }), spriteKey({ ...BASE, dir: 'x', len: 4 }));
  assert.equal(spriteKey({ ...BASE }), spriteKey({ ...BASE, dir: undefined, len: undefined, lit: false }));
  assert.equal(spriteKey({ len: 2, ...BASE, dir: 'x' }), spriteKey({ dir: 'x', ...BASE, len: 2 }));
});

test('budget exhausted queues (null); pump builds within budget using injected clock', () => {
  const c = clock(); const cache = new SpriteCache({ now: c.now, budgetMs: 6 });
  const make = () => { c.t += 4; return entry(10); };
  const r = ['a', 'b', 'c', 'd', 'e'].map(k => cache.get(k, make));
  assert.ok(r[0] && r[1]); assert.equal(r[2], null);
  assert.equal(cache.stats().queued, 3);
  assert.equal(cache.pump(5), 2); // builds at elapsed 0 and 4
  assert.equal(cache.pump(100), 1);
  assert.ok(cache.get('c', () => assert.fail('built by pump')));
});

test('batchMisses passes parsed fields and enforces 512x768', async () => {
  const seen = [];
  const render = (model, variant, style, opts) => { seen.push([model, variant, style, opts]); const big = model === 'big'; return { bitmap: { width: big ? 600 : 64, height: 64 }, pivot: { x: 1, y: 1 } }; };
  const ok = spriteKey({ ...BASE, dir: 'y', len: 4 }), big = spriteKey({ ...BASE, model: 'big' });
  const m = await batchMisses([ok, big], render);
  assert.ok(m.get(ok)); assert.ok(!m.has(big));
  assert.equal(seen[0][0], 'hedge'); assert.equal(seen[0][3].len, 4); assert.equal(seen[0][3].dir, 'y');
  assert.equal(m.get(ok).bytes, 64 * 64 * 4);
});

test('placeholder draws a box with north-corner pivot via the canvas factory', () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls.push(k); }), set: (t, k, v) => { t[k] = v; return true; } });
  setCanvasFactory((w, h) => ({ width: w, height: h, getContext: () => ctx }));
  try {
    const e = placeholder({ w: 3, h: 2, z: 20 });
    assert.equal(e.pivot.x, 2 + 2 * 16); assert.equal(e.pivot.y, 2 + 20);
    assert.equal(e.img.width, (3 + 2) * 16 + 4); assert.equal(e.img.height, 20 + 5 * 8 + 4);
    assert.ok(calls.includes('fill')); assert.equal(e.bytes, e.img.width * e.img.height * 4);
    assert.ok(e.bounds.x + e.bounds.w <= e.img.width && e.bounds.y + e.bounds.h <= e.img.height);
  } finally { setCanvasFactory(null); }
});
