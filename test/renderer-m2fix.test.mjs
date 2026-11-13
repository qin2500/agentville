// M2 renderer fixes: lights are drawn, decals are static, visible chunk sprites survive eviction, chunks build lazily.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, CHUNK } from '../web/src/engine/render/renderer.js';
import { SpriteCache } from '../web/src/engine/render/sprites.js';
import { toScreen } from '../web/src/engine/core/coords.js';

const LAYER = { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 };
const sortKey = (d, s, l, c) => ((d * 4 + s) * 8 + l) * 4096 + (c + 2048);
const mergeSorted = lists => lists.flat().sort((a, b) => a.key - b.key);
const ent = k => ({ img: { tag: k, width: 8, height: 8 }, bounds: { x: 0, y: 0, w: 8, h: 8 }, pivot: { x: 4, y: 8 }, slices: [], anchors: {} });

function mk({ objects, cache, lightingCalls = [], built = [] }) {
  const gfx = { begin() {}, clear() {}, end() {}, image() {}, rect() {}, poly() {}, setComposite() {}, size: () => ({ w: 800, h: 600 }) };
  const deps = {
    LAYER, sortKey, mergeSorted, cache, loadClassicArt: undefined,
    spriteKey: o => `${o.model}|${o.variant}`,
    placeholder: o => ({ ...ent('ph'), placeholder: true }),
    sliceSprite: (obj, sp) => { built.push(obj.id); const p = toScreen(obj.tx, obj.ty); return [{ key: sortKey(obj.tx + obj.ty, 0, 1, 0), sx: 0, sy: 0, sw: 8, sh: 8, dx: p.sx, dy: p.sy, img: sp.img }]; },
    rasterize: () => ent('r'),
    artView: o => ({ ...o }),
    createGround: () => ({ drawChunks() {} }),
    createLighting: () => ({ setTime() {}, lights: (o, a) => { lightingCalls.push(['lights', o.length]); return [{ id: 'L' }]; }, draw: (g, c, v, list) => lightingCalls.push(['draw', list]) }),
    createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }),
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), version: 1 });
  return r;
}
let vn = 0;
const obj = (id, tx, ty, kind = 'building') => ({ id, kind, model: 'm', tx, ty, w: 1, h: 1, z: 10, styleKey: 's', variant: ++vn });
const frame = (o = {}) => ({ cam: { x: 0, y: 0, z: 1 }, view: { cssW: 400, cssH: 300, dpr: 1 }, actors: [], night: 0, mode: 'town', ...o });

test('B2: the lights list is passed into lighting.draw', () => {
  const calls = [];
  const r = mk({ objects: [obj('a', 0, 0)], lightingCalls: calls });
  r.draw(frame({ night: 0.9 }));
  assert.deepEqual(calls.find(c => c[0] === 'draw')[1], [{ id: 'L' }]);
});

test('B4: decals draw as static objects', () => {
  const r = mk({ objects: [obj('d1', 0, 0, 'decal')] });
  r.draw(frame());
  assert.ok(r.stats().rasterN >= 0);
  const built = [];
  mk({ objects: [obj('d1', 0, 0, 'decal')], built }).draw(frame());
  assert.deepEqual(built, ['d1']);
});

test('B3: chunks build lazily on first visibility only', () => {
  const built = [];
  const far = CHUNK * 20;
  const r = mk({ objects: [obj('near', 0, 0), obj('far', far, far)], built });
  assert.deepEqual(built, [], 'nothing built at setWorld');
  r.draw(frame());
  assert.deepEqual(built, ['near']);
  r.draw(frame());
  assert.deepEqual(built, ['near'], 'no rebuild when nothing changed');
});

test('B3: sprites of drawn chunks survive eviction pressure', () => {
  let t = 0;
  const cache = new SpriteCache({ maxBytes: 8 * 8 * 4 * 3, now: () => t, budgetMs: 1e9 });
  const objs = [obj('a', 0, 0), obj('b', 1, 0)];
  const r = mk({ objects: objs, cache });
  r.draw(frame());
  const keys = objs.map(o => `m|${o.variant}`);
  for (const k of keys) assert.ok(cache.map.has(k));
  // time passes while the chunk stays on screen; unrelated sprites churn the cache
  for (let i = 0; i < 20; i++) {
    t += 1000;
    r.draw(frame());
    cache.get('other' + i, () => ent('o' + i));
  }
  for (const k of keys) assert.ok(cache.map.has(k), 'visible sprite ' + k + ' stays cached');
});
