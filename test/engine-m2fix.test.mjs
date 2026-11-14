// M2FIX regressions: sprite streaming (placeholders cached, failed models cached, style-free prop keys), actor art
// (classic sheet looks, facing and rows), classic props scaled to engine scale. Fakes only; no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { SpriteCache, spriteKey, placeholder } from '../web/src/engine/render/sprites.js';
import { setCanvasFactory } from '../web/src/engine/art/raster.js';
import { lookOf, rowOf, colOf, createActorArt, LOOKS, NINJAS, BOSS } from '../web/src/engine/render/actor-art.js';

// a minimal canvas-like for placeholder() and upscale()
function fakeCanvas(w, h) {
  const ctx = { fillStyle: '', imageSmoothingEnabled: true, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, drawImage: (...a) => { ctx.draws.push(a); }, draws: [],
    save() {}, restore() {}, translate() {}, scale() {}, fillRect() {}, ellipse() {}, globalAlpha: 1, globalCompositeOperation: '' };
  return { width: w, height: h, getContext: () => ctx, ctx };
}
let made = 0;
setCanvasFactory((w, h) => { made++; return fakeCanvas(w, h); });

const gfx = () => ({ ops: [], begin() {}, clear() {}, end() {}, image(img, ...r) { this.ops.push([img, ...r]); }, rect() {}, poly() {}, setComposite() {}, size: () => ({ w: 800, h: 600 }) });
const stubs = {
  createGround: () => ({ drawChunks() {}, chunkKeys: () => [], invalidate() {} }),
  createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }),
  createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }),
  createActorArt: null,
};
const frame = (o = {}) => ({ cam: { x: 0, y: 0, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t: 0, night: 0, mode: 'town', ...o });
const obj = (id, model, tx, ty, extra = {}) => ({ id, kind: 'prop', model, tx, ty, w: 1, h: 1, z: 10, walk: 'block', styleKey: 'village-' + id, variant: 0, project: 'p' + id, ...extra });

test('placeholders are shared per footprint and height (no canvas per call)', () => {
  const cache = new SpriteCache({});
  const g = gfx();
  // art never loads: everything stays a placeholder
  const r = createRenderer({ canvas: {}, gfx: g, mod: {}, deps: { ...stubs, cache, loadClassicArt: () => new Promise(() => {}) } });
  const objects = [];
  for (let i = 0; i < 40; i++) objects.push(obj('o' + i, 'bush', i % 8, (i / 8) | 0));
  made = 0;
  r.setWorld({ version: 1, objects: new Map(objects.map(o => [o.id, o])), villages: [] });
  for (let i = 0; i < 5; i++) r.draw(frame());
  assert.ok(made <= 2, `placeholder canvases made: ${made}`);
  assert.equal(r.stats().pending, 40);
});

test('a model the art cannot draw is cached once (as its placeholder), not retried every frame', async () => {
  let calls = 0;
  const cache = new SpriteCache({});
  const r = createRenderer({ canvas: {}, gfx: gfx(), mod: {}, deps: { ...stubs, cache, placeholder, loadClassicArt: async () => {}, rasterize: () => { calls++; return null; } } });
  r.setWorld({ version: 1, objects: new Map([['a', obj('a', 'nosuch', 0, 0)], ['b', obj('b', 'nosuch', 1, 0)]]), villages: [] });
  await new Promise(res => setTimeout(res, 0));
  for (let i = 0; i < 10; i++) r.draw(frame());
  assert.equal(calls, 1, 'one raster attempt for the shared key');
  assert.equal(r.stats().pending, 0, 'nothing left pending');
  assert.equal(r.stats().failed, 1);
});

test('prop sprite keys ignore the settlement style unless the art reads it; buildings keep it', async () => {
  const seen = [];
  const cache = { get: (k, make) => { seen.push(k); return null; }, pump() {}, stats: () => ({ queued: 0 }) };
  const r = createRenderer({ canvas: {}, gfx: gfx(), mod: {}, deps: { ...stubs, cache, spriteKey, loadClassicArt: async () => {}, rasterize: () => null } });
  r.setWorld({ version: 1, villages: [], objects: new Map([
    ['t1', obj('t1', 'tree', 0, 0)], ['t2', obj('t2', 'tree', 1, 0)],
    ['s1', obj('s1', 'stall', 2, 0)], ['s2', obj('s2', 'stall', 3, 0)],
    ['h1', obj('h1', 'cottage', 4, 0, { kind: 'building' })], ['h2', obj('h2', 'cottage', 5, 0, { kind: 'building' })],
  ]) });
  r.draw(frame()); // chunks build lazily on first visible frame
  const distinct = m => new Set(seen.filter(k => JSON.parse(k)[0] === m)).size;
  assert.equal(distinct('tree'), 1);
  assert.equal(distinct('stall'), 2);
  assert.equal(distinct('cottage'), 2);
});

test('the art gets the settlement style object, not the key string', async () => {
  const styles = [];
  const cache = new SpriteCache({});
  const style = { key: 'k1', family: 2, accent: '#123456' };
  const r = createRenderer({ canvas: {}, gfx: gfx(), mod: {}, deps: { ...stubs, cache, loadClassicArt: async () => {},
    rasterize: (m, st) => { styles.push([m, st]); return { img: fakeCanvas(8, 8), bounds: { x: 0, y: 0, w: 8, h: 8 }, pivot: { x: 4, y: 8 }, anchors: {} }; } } });
  // injected rasterize keeps the old string fallback; use the real one's contract through villages
  r.setWorld({ version: 1, villages: [{ name: 'pa', style }], objects: new Map([['a', obj('a', 'cottage', 0, 0, { kind: 'building', project: 'pa' })], ['b', obj('b', 'tree', 1, 0, { project: 'pa' })]]) });
  await new Promise(res => setTimeout(res, 0));
  r.draw(frame());
  assert.deepEqual(styles.find(s => s[0] === 'cottage')[1], style);
  assert.equal(styles.find(s => s[0] === 'tree')[1], null);
});

test('actor looks follow the classic rules', () => {
  assert.equal(lookOf({ kind: 'agent', id: 'a', input: { role: 'boss' } }), BOSS);
  assert.ok(NINJAS.includes(lookOf({ kind: 'agent', id: 'a', input: { role: 'sub', parent: 'b' } })));
  assert.equal(lookOf({ kind: 'agent', id: 'x', input: { role: 'sub', parent: 'b' } }), lookOf({ kind: 'agent', id: 'y', input: { role: 'sub', parent: 'b' } }), 'subs of one parent share a ninja');
  assert.ok(LOOKS.includes(lookOf({ kind: 'agent', id: 'a', input: { role: 'worker' } })));
  assert.equal(lookOf({ kind: 'folk', id: 'f', look: { seed: 3 } }), LOOKS[3]);
  assert.equal(lookOf({ kind: 'critter', species: 'cat' }), 'Cat');
  assert.equal(lookOf({ kind: 'cart' }), null);
});

test('actor frames: facing column and walk / hammer rows', () => {
  assert.deepEqual([0, 1, 2, 3].map(face => colOf({ face })), [0, 2, 1, 3], 'SE down, SW left, NW up, NE right');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(frame => rowOf({ anim: 'walk', frame })), [0, 1, 2, 3, 0, 1]);
  assert.deepEqual([0, 1, 2].map(frame => rowOf({ anim: 'hammer', frame })), [0, 4, 0]);
  assert.equal(rowOf({ anim: 'idle', frame: 7 }), 0);
});

test('actor art: engine-scale stickers, cached per look/facing/row, feet pivot', async () => {
  const sheet = { width: 64, height: 112 };
  const art = createActorArt({ base: '/x/', loadImage: async () => sheet, createCanvas: fakeCanvas });
  assert.equal(art.frame({ kind: 'folk', id: 'f', look: { seed: 0 } }), null, 'null before the sheets load');
  await art.load();
  const a = { kind: 'folk', id: 'f', look: { seed: 0 }, anim: 'walk', frame: 1, face: 3 };
  const f1 = art.frame(a), f2 = art.frame({ ...a });
  assert.equal(f1, f2);
  assert.equal(f1.img.width, 25, '20 px sticker x 1.25');
  assert.ok(f1.pivot.y > f1.img.height * 0.7 && Math.abs(f1.pivot.x - f1.img.width / 2) <= 1);
  art.frame({ ...a, frame: 2 });
  assert.equal(art.stats().frames, 2);
});

test('renderer draws agents and townsfolk with actor art, not raster', () => {
  let rasterActor = 0;
  const g = gfx();
  const sticker = { img: { width: 25, height: 27, tag: 'st' }, pivot: { x: 12, y: 22 } };
  const r = createRenderer({ canvas: {}, gfx: g, mod: {}, deps: { ...stubs, cache: new SpriteCache({}), loadClassicArt: async () => {},
    rasterize: m => { if (String(m).startsWith('actor')) rasterActor++; return null; },
    createActorArt: () => ({ load() {}, frame: a => (a.kind === 'cart' ? null : sticker), ready: true }) } });
  r.setWorld({ version: 1, villages: [], objects: new Map() });
  r.draw(frame({ actors: [{ id: 'a', kind: 'agent', x: 0.5, y: 0.5, flags: 1 }, { id: 'f', kind: 'folk', x: 1.5, y: 0.5, flags: 1 }] }));
  assert.equal(g.ops.filter(o => o[0] === sticker.img).length, 2);
  assert.equal(rasterActor, 0);
});
