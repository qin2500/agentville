import './support/ensure-mods-index.mjs';
// M6 P1: the generic paper-doll system (web/src/engine/art/doll.js) and its actor-art wiring (render/actor-art.js):
// outline/border, pivot and head, 4 facings, determinism, bounded cache, anims, and the sheet fallback path.
// The parts below are tiny TEST parts, not world art. Pure node: raw RGBA frames (no canvas).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoll, lookKey, animFrame, parseColour, PAD } from '../web/src/engine/art/doll.js';
import { createActorArt, createSeenOrder, folkPref, lookOf, LOOKS, NINJAS, BOSS, FOLK_KEY } from '../web/src/engine/render/actor-art.js';
const { resolveMod, resolveWith } = await import('../web/src/engine/mod/registry.js');

const INK = [20, 15, 28];
// TEST parts: a body (asymmetric: a 2px tool on the right in front view), a head that differs front/back, legs that
// do not bob, and a pixel-rows hat.
const PARTS = {
  legs: { layer: 0, bob: false, draw(g, facing, anim, f) { const s = anim === 'walk' && f % 2 ? 1 : 0; g.rect(5 + s, 18, 2, 6, 'legs'); g.rect(9 - s, 18, 2, 6, 'legs'); } },
  body: { layer: 1, draw(g, facing) { g.rect(4, 10, 8, 8, 'cloth'); g.rect(facing === 0 ? 12 : 2, 12, 2, 4, '#c08040'); } },
  head: { layer: 2, draw(g, facing) { g.rect(5, 4, 6, 6, 'skin'); if (facing === 0) { g.px(6, 6, '#000'); g.px(9, 6, '#000'); } else g.rect(5, 4, 6, 3, 'hair'); } },
  hat: { layer: 3, x: 4, y: 2, rows: ['..aaaa..', 'aaaaaaaa'], keys: { a: 'hat' } },
};
const ANIMS = { idle: { frames: 2, bob: [0, 1] }, walk: { frames: 4, bob: [0, -1, 0, -1] }, hammer: { frames: 2 } };
const LOOK = Object.freeze({ parts: ['legs', 'body', 'head'], extras: ['hat'], palette: { legs: '#334455', cloth: '#3a6ea5', skin: '#e0b090', hair: '#5a3a1a', hat: '#a03030' } });
const mk = (o = {}) => createDoll({ parts: PARTS, anims: ANIMS, ...o });

const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];
const rgbAt = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
const isInk = (img, x, y) => alphaAt(img, x, y) === 255 && rgbAt(img, x, y).every((v, i) => v === INK[i]);
const same = (a, b) => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);
const mirrored = img => { const o = new Uint8ClampedArray(img.data.length); for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) o.set(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4), (y * img.width + img.width - 1 - x) * 4); return { width: img.width, height: img.height, data: o }; };

test('1 px border: figure pixels never touch transparency; the ink ring is 1 px; the edge of the image is clear', () => {
  const d = mk({ rim: false, shadow: false });
  for (const facing of [0, 1, 2, 3]) {
    const { img } = d.frame(LOOK, facing, 'walk', 1);
    assert.equal(img.width, 16 + 2 * PAD); assert.equal(img.height, 24 + 2 * PAD);
    let fig = 0, ink = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const a = alphaAt(img, x, y);
      if (x === 0 || y === 0 || x === img.width - 1 || y === img.height - 1) assert.equal(a, 0, `edge ${x},${y} clear`);
      if (!a) continue;
      if (isInk(img, x, y)) {
        ink++;
        const n4 = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => alphaAt(img, x + dx, y + dy) && !isInk(img, x + dx, y + dy));
        assert.ok(n4.length > 0, `ink ${x},${y} touches the figure`);
        continue;
      }
      fig++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.ok(alphaAt(img, x + dx, y + dy) > 0, `figure ${x},${y} is outlined`);
    }
    assert.ok(fig > 100 && ink > 30, `facing ${facing}: ${fig} figure px, ${ink} ink px`);
  }
});

test('rim: a light ring outside the ink; selected makes it white; the shadow sits under the feet', () => {
  const d = mk();
  const plain = d.frame(LOOK, 0, 'idle', 0).img, sel = d.frame(LOOK, 0, 'idle', 0, { selected: true }).img;
  assert.ok(!same(plain, sel));
  // the pixel left of the leftmost ink on the head row is rim
  const y = PAD + 6;
  let x0 = 0; while (!isInk(sel, x0, y)) x0++;
  assert.deepEqual([...sel.data.slice((y * sel.width + x0 - 1) * 4, (y * sel.width + x0) * 4)], [255, 255, 255, 255]);
  assert.ok(alphaAt(plain, x0 - 1, y) > 0 && alphaAt(plain, x0 - 1, y) < 255);
});

test('pivot is the feet point and head the top of the figure, both inside the image', () => {
  const d = mk({ rim: false, shadow: false });
  for (const facing of [0, 1, 2, 3]) for (const [anim, f] of [['idle', 0], ['walk', 1], ['hammer', 0]]) {
    const fr = d.frame(LOOK, facing, anim, f);
    const { img, pivot, head } = fr;
    for (const p of [pivot, head]) assert.ok(p.x >= 0 && p.x <= img.width && p.y >= 0 && p.y <= img.height, JSON.stringify(p));
    assert.equal(pivot.x, img.width / 2, 'pivot centred');
    assert.ok(head.y < pivot.y - 12, 'head well above the feet');
    // the row just above the pivot holds figure (the soles); the head row is the first opaque non-ink row
    let soles = 0; for (let x = 0; x < img.width; x++) if (alphaAt(img, x, pivot.y - 1) && !isInk(img, x, pivot.y - 1)) soles++;
    assert.ok(soles > 0, 'feet on the pivot row');
    let top = img.height; for (let y = 0; y < img.height && top === img.height; y++) for (let x = 0; x < img.width; x++) if (alphaAt(img, x, y) && !isInk(img, x, y)) { top = y; break; }
    assert.equal(head.y, top);
  }
});

test('4 facings differ; SW mirrors SE and NE mirrors NW', () => {
  const d = mk();
  const F = [0, 1, 2, 3].map(f => d.frame(LOOK, f, 'idle', 0).img);
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) assert.ok(!same(F[i], F[j]), `facing ${i} vs ${j}`);
  assert.ok(same(F[1], mirrored(F[0])));
  assert.ok(same(F[3], mirrored(F[2])));
  assert.equal(d.frame(LOOK, 5, 'idle', 0), d.frame(LOOK, 1, 'idle', 0), 'facing wraps mod 4');
});

test('deterministic: two dolls draw identical bytes; a repeat call is a cache hit', () => {
  const a = mk(), b = mk();
  for (const facing of [0, 1, 2, 3]) for (let f = 0; f < 4; f++) assert.ok(same(a.frame(LOOK, facing, 'walk', f).img, b.frame({ ...LOOK }, facing, 'walk', f).img));
  const r = a.stats().renders;
  assert.equal(a.frame(LOOK, 2, 'walk', 3), a.frame(LOOK, 2, 'walk', 3));
  assert.equal(a.stats().renders, r);
  assert.equal(lookKey(LOOK), lookKey({ palette: { ...LOOK.palette }, extras: ['hat'], parts: ['legs', 'body', 'head'] }), 'palette order does not matter');
});

test('anims: bob moves the bob-able parts only, frames wrap, unknown anim draws as idle', () => {
  const d = mk({ rim: false, shadow: false });
  const w0 = d.frame(LOOK, 0, 'walk', 0), w1 = d.frame(LOOK, 0, 'walk', 1);
  assert.equal(w1.head.y, w0.head.y - 1, 'walk frame 1 bobs up 1 px');
  assert.equal(d.frame(LOOK, 0, 'walk', 4), w0, 'frame 4 of a 4-frame walk is frame 0');
  assert.equal(d.frame(LOOK, 0, 'enter', 0), d.frame(LOOK, 0, 'idle', 0));
  assert.deepEqual(animFrame(ANIMS, 'nope', 3), { name: 'idle', i: 1, bob: 1 });
  assert.deepEqual(animFrame({}, 'walk', 7), { name: 'idle', i: 0, bob: 0 });
  assert.deepEqual(parseColour('#abc'), [170, 187, 204, 255]);
  assert.equal(parseColour('red'), null);
});

test('missing parts and palette slots are skipped and reported, never thrown', () => {
  const d = mk();
  const fr = d.frame({ parts: ['body', 'nope'], palette: {} }, 0, 'idle', 0);
  assert.ok(fr.img.width > 0);
  const m = d.stats().missing;
  assert.ok(m.includes('part:nope') && m.includes('slot:cloth'), m.join());
  assert.equal(d.frame(null, 0, 'idle', 0), null);
});

test('cache is an LRU bounded by frames and by bytes', () => {
  const d = mk({ maxFrames: 5 });
  const looks = Array.from({ length: 6 }, (_, i) => ({ ...LOOK, palette: { ...LOOK.palette, cloth: `#1020${(i * 16 + 16).toString(16).padStart(2, '0')}` } }));
  const first = d.frame(looks[0], 0, 'idle', 0);
  for (const l of looks) for (const f of [0, 1, 2, 3]) { d.frame(l, f, 'idle', 0); assert.ok(d.stats().frames <= 5); }
  assert.ok(d.stats().evicted >= 19);
  assert.notEqual(d.frame(looks[0], 0, 'idle', 0), first, 'the oldest frame was evicted and is redrawn');
  // LRU, not FIFO: a touched frame survives
  const keep = d.frame(looks[1], 0, 'idle', 0);
  for (const f of [1, 2, 3]) { d.frame(looks[2], f, 'idle', 0); d.frame(looks[1], 0, 'idle', 0); }
  assert.equal(d.frame(looks[1], 0, 'idle', 0), keep);
  const per = (16 + 2 * PAD) * (24 + 2 * PAD) * 4;
  const small = mk({ maxBytes: per * 3 });
  for (const l of looks) small.frame(l, 0, 'idle', 0);
  assert.ok(small.stats().frames <= 3 && small.stats().bytes <= per * 3);
  const big = mk();
  for (let i = 0; i < 300; i++) big.frame({ ...LOOK, palette: { ...LOOK.palette, hat: `#${(i * 997).toString(16).padStart(6, '0').slice(-6)}` } }, i & 3, 'walk', i);
  assert.ok(big.stats().bytes <= 6 * 1024 * 1024);
});

// ---- actor-art: doll vs sheet fallback

function memStore(init = {}) { const m = new Map(Object.entries(init)); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, structuredClone(v)), m }; }
function fakeCanvas(w, h) {
  const ctx = { fillStyle: '', imageSmoothingEnabled: true, globalAlpha: 1, globalCompositeOperation: '', beginPath() {}, ellipse() {}, fill() {}, fillRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, scale() {} };
  return { width: w, height: h, getContext: () => ctx };
}
const sheetDeps = () => ({ base: '/x/', loadImage: async () => ({ width: 64, height: 112 }), createCanvas: fakeCanvas, search: '', store: memStore() });
const lookOfDoll = view => (view.kind === 'critter' ? null : { parts: view.role === 'boss' ? ['legs', 'body', 'head', 'hat'] : ['legs', 'body', 'head'], palette: LOOK.palette });
const dollMod = (extra = {}) => ({ id: 'test.doll', actors: { parts: PARTS, anims: ANIMS, lookOf: lookOfDoll, fallback: { looks: ['A', 'B'], subs: ['S'], boss: 'K', critters: { cat: 'Cat' } }, ...extra } });

test('default world: the sheet names come from the mod (fallback data), and the fantasy world draws paper dolls over them', () => {
  const fantasy = resolveMod('agentville.fantasy');
  assert.ok(Object.isFrozen(fantasy.actors) && Array.isArray(fantasy.actors.fallback.looks));
  assert.deepEqual([...LOOKS], [...fantasy.actors.fallback.looks]);
  assert.deepEqual([...NINJAS], [...fantasy.actors.fallback.subs]);
  assert.equal(BOSS, fantasy.actors.fallback.boss);
  assert.equal(createActorArt({ mod: fantasy, ...sheetDeps() }).mode, 'doll', 'the fantasy world ships parts + lookOf');
  assert.equal(createActorArt({ mod: fantasy, folk: 'ninja', ...sheetDeps() }).mode, 'sheet', '?folk=ninja forces the sheets');
  // a world with no actors key (the base world) still draws the default world's sheets
  const baseArt = createActorArt({ mod: resolveMod('agentville.base'), ...sheetDeps() });
  assert.equal(baseArt.mode, 'sheet');
  assert.equal(baseArt.lookOf({ kind: 'agent', id: 'z', input: { role: 'boss' } }), BOSS);
});

test('a child world adds parts + lookOf over the parent: they merge, and the doll draws its people', async () => {
  const child = { id: 'test.child', name: 'c', version: '1.0.0', apiVersion: 1, extends: 'agentville.fantasy', actors: { parts: PARTS, anims: ANIMS, lookOf: lookOfDoll } };
  const m = resolveWith([child], 'test.child');
  assert.deepEqual([...m.actors.fallback.looks], [...LOOKS], 'fallback inherited');
  assert.equal(typeof m.actors.lookOf, 'function');
  const art = createActorArt({ mod: m, ...sheetDeps() });
  assert.equal(art.mode, 'doll');
  const fr = art.frame({ kind: 'agent', id: 'a1', face: 1, anim: 'walk', frame: 1, input: { role: 'worker' } });
  assert.ok(fr && fr.head && fr.img.width === 16 + 2 * PAD);
  assert.equal(art.frame({ kind: 'critter', species: 'cat' }), null, 'lookOf null -> sheet fallback (not loaded yet)');
  await art.load();
  assert.ok(art.frame({ kind: 'critter', species: 'cat', face: 0, anim: 'idle' })?.img, 'critter drawn from the sheet');
  assert.ok(art.stats().looks > 0);
});

test('fallback: ?folk=ninja, the va.engine2.folk key, and a throwing lookOf all give the sheets', async () => {
  assert.equal(folkPref({ search: '?engine=2&folk=ninja', store: memStore() }), 'ninja');
  assert.equal(folkPref({ search: '', store: memStore({ [FOLK_KEY]: 'ninja' }) }), 'ninja');
  assert.equal(folkPref({ search: '?folk=doll', store: memStore() }), null);
  assert.equal(createActorArt({ mod: dollMod(), ...sheetDeps() }).mode, 'doll');
  assert.equal(createActorArt({ mod: dollMod(), ...sheetDeps(), search: '?folk=ninja' }).mode, 'sheet');
  assert.equal(createActorArt({ mod: dollMod(), ...sheetDeps(), store: memStore({ [FOLK_KEY]: 'ninja' }) }).mode, 'sheet');
  assert.equal(createActorArt({ mod: dollMod({ parts: {} }), ...sheetDeps() }).mode, 'sheet', 'no parts');
  let calls = 0;
  const warn = console.warn; console.warn = () => {};
  try {
    const art = createActorArt({ mod: dollMod({ lookOf: () => { calls++; throw new Error('boom'); } }), ...sheetDeps() });
    await art.load();
    const a = { kind: 'agent', id: 'a1', face: 0, anim: 'idle', frame: 0, input: { role: 'worker' } };
    const fr = art.frame(a);
    assert.equal(art.mode, 'sheet');
    assert.ok(fr?.img, 'the throwing actor is drawn from the sheet at once');
    assert.equal(art.lookOf(a), 'A', 'the mod fallback names');
    art.frame({ ...a, id: 'a2' });
    assert.equal(calls, 1, 'lookOf is not called again this session');
  } finally { console.warn = warn; }
});

test('looks are computed once per actor and see a frozen view with the seen ordinal and the style', () => {
  const seenViews = [], styles = [];
  const style = { key: 's1' };
  const art = createActorArt({ mod: dollMod({ lookOf: (v, s) => { seenViews.push(v); styles.push(s); return lookOfDoll(v); } }), ...sheetDeps(), styleOf: p => (p === 'pa' ? style : null) });
  const a = { kind: 'agent', id: 'x', project: 'pa', face: 0, anim: 'walk', frame: 0, input: { role: 'worker' } };
  art.frame(a); art.frame({ ...a, frame: 1 }); art.frame({ ...a, face: 2 });
  assert.equal(seenViews.length, 1);
  assert.ok(Object.isFrozen(seenViews[0]));
  assert.equal(seenViews[0].seen, 0); assert.equal(styles[0], style);
  art.frame({ ...a, id: 'y' });
  assert.equal(seenViews[1].seen, 1, 'second agent seen -> ordinal 1');
  art.frame({ ...a, input: { role: 'boss' } });
  assert.equal(seenViews.length, 3, 'a role change recomputes the look');
  art.frame({ kind: 'folk', id: 'f', look: { seed: 42 }, face: 0, anim: 'idle', frame: 0 });
  assert.equal(seenViews[3].seen, 42);
});

test('seen ordinals: stable across reloads, batch order, trimming keeps the remaining ordinals', () => {
  const store = memStore();
  const s1 = createSeenOrder({ store, max: 4 });
  s1.note(['a', 'b', 'c']);
  assert.deepEqual(['a', 'b', 'c'].map(s1.of), [0, 1, 2]);
  assert.equal(s1.of('d'), 3);
  const s2 = createSeenOrder({ store, max: 4 });
  assert.deepEqual(['d', 'a'].map(s2.of), [3, 0], 'persisted');
  s2.of('e'); s2.of('f');
  const s3 = createSeenOrder({ store, max: 4 });
  assert.equal(s3.size, 4);
  assert.deepEqual(['c', 'd', 'e', 'f'].map(s3.of), [2, 3, 4, 5], 'oldest trimmed, ordinals unchanged');
  assert.equal(s3.of('a'), 6, 'a trimmed id is new again');
  // sheet looks follow the first-seen order (classic va.seen): first agent -> looks[0], second -> looks[1]
  const art = createActorArt({ mod: dollMod(), ...sheetDeps(), folk: 'ninja' });
  art.noteSeen(['q', 'p']);
  assert.equal(art.lookOf({ kind: 'agent', id: 'q', input: {} }), 'A');
  assert.equal(art.lookOf({ kind: 'agent', id: 'p', input: {} }), 'B');
  assert.equal(lookOf({ kind: 'agent', id: 'p', seen: 1, input: {} }), LOOKS[1]);
});
