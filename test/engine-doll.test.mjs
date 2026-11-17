import './support/ensure-mods-index.mjs';
// M6 P5 spec tests for the paper-doll system (M6-PLAN P1, docs/village-mods.md "Actors"). Written from the spec with
// tiny TEST parts (no world art). Pure node: frames are raw RGBA { width, height, data } when no canvas factory is given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoll, MAX_FRAMES, MAX_BYTES } from '../web/src/engine/art/doll.js';
import { createActorArt } from '../web/src/engine/render/actor-art.js';

const INK = [1, 2, 3];
const PARTS = {
  legs: { layer: 0, bob: false, draw(g) { g.rect(5, 18, 2, 6, 'legs'); g.rect(9, 18, 2, 6, 'legs'); } },
  body: { layer: 1, draw(g, facing) { g.rect(4, 10, 8, 8, 'cloth'); g.rect(facing === 0 ? 12 : 2, 12, 2, 4, '#c08040'); } },
  head: { layer: 2, draw(g, facing) { g.rect(5, 4, 6, 6, 'skin'); if (facing === 0) { g.px(6, 6, '#000000'); g.px(9, 6, '#000000'); } else g.rect(5, 4, 6, 3, 'hair'); } },
};
const ANIMS = { idle: { frames: 2, bob: [0, 1] }, walk: { frames: 4, bob: [0, -1, 0, -1] } };
const LOOK = { parts: ['legs', 'body', 'head'], palette: { legs: '#334455', cloth: '#3a6ea5', skin: '#e0b090', hair: '#5a3a1a' } };
const mk = o => createDoll({ parts: PARTS, anims: ANIMS, outline: '#010203', ...o });
const px = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const isInk = p => p[3] === 255 && INK.every((v, i) => p[i] === v);
const mirror = img => { const o = new Uint8ClampedArray(img.data.length); for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) o.set(px(img, x, y), (y * img.width + img.width - 1 - x) * 4); return o; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test('1 px outline: every figure pixel is enclosed by opaque pixels; the ring is 1 px wide', () => {
  const d = mk({ rim: false, shadow: false });
  for (const f of [0, 1, 2, 3]) {
    const { img } = d.frame(LOOK, f, 'idle', 0);
    const W = img.width, H = img.height;
    let figure = 0, ink = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = px(img, x, y);
      if (!p[3]) continue;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) assert.fail(`pixel on the image edge ${x},${y}`);
      const nb = [px(img, x - 1, y), px(img, x + 1, y), px(img, x, y - 1), px(img, x, y + 1)];
      if (isInk(p)) { ink++; assert.ok(nb.some(n => n[3] && !isInk(n)), `ink ${x},${y} touches no figure pixel (ring wider than 1 px)`); }
      else { figure++; assert.ok(nb.every(n => n[3]), `figure pixel ${x},${y} touches transparency (no outline)`); }
    }
    assert.ok(figure > 50 && ink > 20, `facing ${f}: ${figure} figure, ${ink} ink`);
  }
});

test('pivot (feet) and head are inside the frame; head is above the pivot and on an opaque pixel column', () => {
  const d = mk();
  for (const f of [0, 1, 2, 3]) for (const anim of ['idle', 'walk']) {
    const fr = d.frame(LOOK, f, anim, 1);
    const { width: W, height: H } = fr.img;
    assert.ok(fr.pivot.x >= 0 && fr.pivot.x <= W && fr.pivot.y >= 0 && fr.pivot.y <= H, 'pivot inside');
    assert.ok(fr.head.x >= 0 && fr.head.x < W && fr.head.y >= 0 && fr.head.y < H, 'head inside');
    assert.ok(fr.head.y < fr.pivot.y, 'head above feet');
    assert.ok(Math.abs(fr.pivot.x - W / 2) <= 1, 'pivot centred');
  }
});

test('the 4 facings: front/back differ, SW mirrors SE, NE mirrors NW', () => {
  const d = mk();
  const [se, sw, nw, ne] = [0, 1, 2, 3].map(f => d.frame(LOOK, f, 'idle', 0).img);
  assert.ok(!eq(se.data, nw.data), 'SE and NW differ');
  assert.ok(!eq(se.data, sw.data), 'SE and SW differ (asymmetric figure)');
  assert.ok(!eq(nw.data, ne.data), 'NW and NE differ');
  assert.ok(!eq(sw.data, ne.data), 'SW and NE differ');
  assert.ok(eq(sw.data, mirror(se)), 'SW is SE mirrored');
  assert.ok(eq(ne.data, mirror(nw)), 'NE is NW mirrored');
});

test('determinism: two dolls, and repeated calls, give identical pixels; selection changes the frame', () => {
  const a = mk(), b = mk();
  for (const f of [0, 1, 2, 3]) {
    assert.ok(eq(a.frame(LOOK, f, 'walk', 2).img.data, b.frame(LOOK, f, 'walk', 2).img.data));
  }
  const one = a.frame(LOOK, 0, 'idle', 0);
  assert.equal(a.frame(LOOK, 0, 'idle', 0), one, 'cache hit returns the same frame');
  a.clear();
  assert.ok(eq(a.frame(LOOK, 0, 'idle', 0).img.data, one.img.data), 'redraw after clear is identical');
  assert.ok(!eq(a.frame(LOOK, 0, 'idle', 0, { selected: true }).img.data, one.img.data));
  assert.equal(a.frame(null, 0, 'idle', 0), null);
});

test('cache is bounded: LRU cap on frames (default 4096) and bytes (6 MB), least recently used goes first', () => {
  assert.equal(MAX_FRAMES, 4096);
  assert.equal(MAX_BYTES, 6 * 1024 * 1024);
  const cap = 8, d = mk({ maxFrames: cap });
  const look = i => ({ ...LOOK, palette: { ...LOOK.palette, cloth: `#${(0x100000 + i * 4097).toString(16)}` } });
  const first = d.frame(look(0), 0, 'idle', 0);
  for (let i = 1; i < 40; i++) { d.frame(look(i), 0, 'idle', 0); d.frame(look(0), 0, 'idle', 0); assert.ok(d.stats().frames <= cap, `frames ${d.stats().frames}`); }
  assert.equal(d.frame(look(0), 0, 'idle', 0), first, 'the touched frame survives (LRU, not FIFO)');
  assert.ok(d.stats().evicted > 0);
  const big = mk();
  for (let i = 0; i < 600; i++) big.frame(look(i), i & 3, 'walk', i);
  assert.ok(big.stats().frames <= MAX_FRAMES);
  assert.ok(big.stats().bytes <= MAX_BYTES, `bytes ${big.stats().bytes}`);
});

// ---- fallback to sheets ----
const memStore = (init = {}) => { const m = { ...init }; return { get: (k, d) => (k in m ? m[k] : d), set: (k, v) => { m[k] = v; } }; };
const fakeCanvas = (w, h) => ({ width: w, height: h, getContext: () => new Proxy({}, { get: (t, k) => (k === 'canvas' ? null : () => {}), set: () => true }) });
const deps = o => ({ base: '/x/', loadImage: async () => ({ width: 64, height: 112 }), createCanvas: fakeCanvas, search: '', store: memStore(), ...o });
const FALLBACK = { looks: ['SheetA', 'SheetB'], subs: ['SheetN'], boss: 'SheetBoss', critters: { cat: 'SheetCat' } };
const dollActors = (o = {}) => ({ parts: PARTS, anims: ANIMS, lookOf: () => ({ ...LOOK }), fallback: FALLBACK, ...o });
const AGENT = { kind: 'agent', id: 'a1', project: 'p', face: 0, anim: 'idle', frame: 0, input: {} };

test('actors present: the doll draws', async () => {
  const art = createActorArt({ mod: { actors: dollActors() }, ...deps() });
  await art.load();
  assert.equal(art.mode, 'doll');
  const fr = art.frame(AGENT);
  assert.ok(fr && fr.img && fr.pivot);
});

test('fallback to sheets: no actors key', async () => {
  const art = createActorArt({ mod: {}, ...deps() });
  await art.load();
  assert.equal(art.mode, 'sheet');
  assert.ok(art.frame(AGENT), 'the sheet still draws a person');
});

test('fallback to sheets: lookOf throws (and the village keeps drawing)', async () => {
  let calls = 0;
  const art = createActorArt({ mod: { actors: dollActors({ lookOf: () => { calls++; throw new Error('boom'); } }) }, ...deps() });
  await art.load();
  const warn = console.warn; console.warn = () => {};
  try { assert.ok(art.frame(AGENT), 'a frame is still returned'); } finally { console.warn = warn; }
  assert.equal(art.mode, 'sheet');
  assert.ok(calls >= 1);
});

test('fallback to sheets: ?folk=ninja forces sheets even with a working doll', async () => {
  const art = createActorArt({ mod: { actors: dollActors() }, ...deps({ search: '?engine=2&folk=ninja' }) });
  await art.load();
  assert.equal(art.mode, 'sheet');
  assert.ok(art.frame(AGENT));
  assert.equal(createActorArt({ mod: { actors: dollActors() }, ...deps({ search: '?folk=other' }) }).mode, 'doll');
});
