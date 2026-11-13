// Renderer (R8) composition tests with injected fakes. Written from the COMMON.md seams, not from the other modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { toScreen } from '../web/src/engine/core/coords.js';

const LAYER = { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 };
const sortKey = (d, s, l, c) => ((d * 4 + s) * 8 + l) * 4096 + (c + 2048);
const mergeSorted = lists => lists.flat().sort((a, b) => a.key - b.key);

function mk({ objects = [], night = 0, selected = false } = {}) {
  const calls = { ops: [], pools: [], rasterized: 0, fade: 0, occ: 0 };
  const gfx = {
    begin: () => calls.ops.push('begin'), clear: () => calls.ops.push('clear'), end: () => calls.ops.push('end'),
    image: (img, ...r) => calls.ops.push(['image', img.tag, ...r]), rect: () => calls.ops.push('rect'), poly: () => calls.ops.push('poly'),
    setComposite() {}, size: () => ({ w: 800, h: 600 }),
  };
  const ready = new Set();
  class SpriteCache {
    constructor() { this.m = new Map(); }
    get(key, make) { // a hit returns the same entry (SpriteCache contract)
      if (!ready.has(key)) return null;
      if (!this.m.has(key)) { make(); this.m.set(key, { img: { tag: key, width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }); }
      return this.m.get(key);
    }
    pump() {}
  }
  const deps = {
    LAYER, sortKey, mergeSorted, SpriteCache,
    spriteKey: o => `${o.model}|${o.styleKey}|${o.variant}`,
    placeholder: o => ({ img: { tag: 'ph:' + o.id, width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }),
    sliceSprite: (obj, sp) => {
      const p = toScreen(obj.tx, obj.ty);
      const depth = obj.tx + obj.w - 1 + obj.ty + obj.h - 1;
      return [{ key: sortKey(depth, 0, LAYER.OBJECT, obj.tx - obj.ty), col: obj.tx - obj.ty, depth, sx: 0, sy: 0, sw: 16, sh: 32, dx: p.sx, dy: p.sy - 32, img: sp.img }];
    },
    rasterize: () => { calls.rasterized++; return {}; },
    artView: o => Object.freeze({ id: o.id, kind: o.kind, model: o.model, tx: o.tx, ty: o.ty, w: o.w, h: o.h, z: o.z, styleKey: o.styleKey, variant: o.variant }),
    createGround: () => ({ drawChunks: () => calls.ops.push('ground'), chunkKeys: () => [], invalidate() {} }),
    createLighting: () => ({ setTime: t => calls.ops.push(['time', t]), lights: () => [], draw: () => calls.ops.push('light') }),
    createXray: () => ({ occluded: a => a.occ === true, fadeFor: () => { calls.fade++; return 0.35; }, draw: (g, c, as) => calls.ops.push(['xray', as.length]) }),
    effects: { draw: () => calls.ops.push('effects') },
    badges: { draw: () => calls.ops.push('badges') },
  };
  const world = { objects: new Map(objects.map(o => [o.id, o])), version: 1 };
  const slice = deps.sliceSprite;
  deps.sliceSprite = (obj, sp) => { (calls.sliced[obj.id] = (calls.sliced[obj.id] || 0) + 1); return slice(obj, sp); };
  calls.sliced = {};
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld(world);
  return { r, calls, ready, deps, world };
}
const bld = (id, tx, ty, extra = {}) => ({ id, kind: 'building', model: 'cottage', tx, ty, w: 1, h: 1, z: 20, walk: 'block', styleKey: 's', variant: 0, ...extra });
const frame = (o = {}) => ({ cam: { x: 0, y: 0, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t: 0, night: 0, mode: 'town', ...o });
const actor = (id, x, y, extra = {}) => ({ id, kind: 'agent', x, y, face: 0, anim: 'idle', frame: 0, look: {}, flags: 0, ...extra });
const drawnImages = calls => calls.ops.filter(o => Array.isArray(o) && o[0] === 'image').map(o => o[1]);

test('layer order: clear, ground, world, effects, light (night only), badges, end', () => {
  const { r, calls } = mk({ objects: [bld('b1', 0, 0)] });
  r.draw(frame({ night: 0.8 }));
  const names = calls.ops.map(o => Array.isArray(o) ? o[0] : o).filter(n => n !== 'time');
  assert.deepEqual(names.filter(n => n !== 'image'), ['begin', 'clear', 'ground', 'effects', 'light', 'badges', 'end']);
  assert.ok(names.indexOf('image') > names.indexOf('ground') && names.indexOf('image') < names.indexOf('effects'));
  const day = mk({ objects: [bld('b1', 0, 0)] });
  day.r.draw(frame());
  assert.ok(!day.calls.ops.includes('light'));
});

test('draw order is back to front and actors interleave by depth', () => {
  const { r, calls, ready } = mk({ objects: [bld('far', 0, 0), bld('near', 4, 4)] });
  ready.add('cottage|s|0');
  const hits = r.draw(frame({ actors: [actor('mid', 2.5, 2.5)] }));
  assert.equal(drawnImages(calls).length, 3);
  assert.deepEqual(hits.map(h => h.id), ['near', 'mid', 'far'], 'hits are front to back');
});

test('hits: kinds, css rects, props excluded', () => {
  const { r } = mk({ objects: [bld('h', 0, 0), { ...bld('p', 1, 0), kind: 'prop' }, { ...bld('d', 0, 1), kind: 'venue' }] });
  const hits = r.draw(frame({ actors: [actor('a', 0, 0)] }));
  assert.deepEqual(hits.map(h => h.kind).sort(), ['agent', 'dock', 'house']);
  for (const h of hits) { assert.equal(h.rect.length, 4); assert.ok(h.rect[2] > h.rect[0] && h.rect[3] > h.rect[1]); }
  const hh = hits.find(h => h.id === 'h');
  assert.ok(hh.rect[0] >= 380 && hh.rect[0] <= 400, 'tile 0,0 sits at the view centre');
});

test('culling: off-screen chunks and actors are not drawn', () => {
  const { r, calls, ready } = mk({ objects: [bld('on', 0, 0), bld('off', 200, 200)] });
  ready.add('cottage|s|0');
  const hits = r.draw(frame({ actors: [actor('gone', 300, 300)] }));
  assert.deepEqual(hits.map(h => h.id), ['on']);
  assert.equal(drawnImages(calls).length, 1);
});

test('missing sprite draws the placeholder, then upgrades once the cache has it', () => {
  const { r, calls, ready } = mk({ objects: [bld('b', 0, 0)] });
  r.draw(frame());
  assert.ok(drawnImages(calls)[0].startsWith('ph:'));
  ready.add('cottage|s|0'); calls.ops.length = 0;
  r.draw(frame());
  assert.equal(drawnImages(calls)[0], 'cottage|s|0');
});

test('art code only sees artView objects', () => {
  const { r, calls, deps } = mk({ objects: [bld('b', 0, 0, { data: { agentId: 'secret' } })] });
  const seen = [];
  deps.placeholder = o => { seen.push(o); return { img: { tag: 'x', width: 1, height: 1 }, slices: [] }; };
  const r2 = createRenderer({ canvas: {}, gfx: { begin() {}, clear() {}, end() {}, image() {}, rect() {}, poly() {} }, mod: {}, deps });
  r2.setWorld({ objects: new Map([['b', bld('b', 0, 0, { data: { agentId: 'secret' } })]]) });
  r2.draw(frame()); // chunks build lazily on first visible frame
  assert.ok(seen.length && seen.every(o => Object.isFrozen(o) && !('data' in o)));
  void r; void calls;
});

test('x-ray gets only occluded actors; building fade only when someone is selected', () => {
  const { r, calls } = mk({ objects: [bld('b', 0, 0)] });
  r.draw(frame({ actors: [actor('a', 0, 0, { occ: true }), actor('c', 1, 1)] }));
  assert.deepEqual(calls.ops.find(o => Array.isArray(o) && o[0] === 'xray'), ['xray', 1]);
  assert.equal(calls.fade, 0);
  r.draw(frame({ actors: [actor('s', 0, 0, { selected: true })] }));
  assert.ok(calls.fade > 0);
});

test('Map LOD: no sprite slices, actors become dots', () => {
  const { r, calls, ready } = mk({ objects: [bld('b', 0, 0)] });
  ready.add('cottage|s|0');
  r.draw(frame({ cam: { x: 0, y: 0, z: 0.25 }, actors: [actor('a', 0, 0)] }));
  assert.equal(drawnImages(calls).length, 0);
  assert.ok(calls.ops.includes('rect') && calls.ops.includes('poly'));
});

test('draw before setWorld returns no hits', () => {
  const r = createRenderer({ canvas: {}, gfx: {}, mod: {}, deps: { SpriteCache: class {} } });
  assert.deepEqual(r.draw(frame()), []);
});

test('slices are cached per object id per world version, not per sprite', () => {
  // two objects share one sprite key (same look) but sit at different places: each gets its own slices
  const { r, calls, ready, world } = mk({ objects: [bld('a', 0, 0), bld('b', 2, 0), { ...bld('late', 1, 1), model: 'mill' }] });
  ready.add('cottage|s|0');
  r.draw(frame());                     // a, b upgrade from placeholder: their chunk is rebuilt once
  const after1 = { ...calls.sliced };
  ready.add('mill|s|0');
  r.draw(frame());                     // 'late' arrives: chunk rebuilt again, a and b reuse their cached slices
  assert.equal(calls.sliced.a, after1.a, 'a not re-sliced when another sprite arrives');
  assert.equal(calls.sliced.b, after1.b);
  assert.equal(calls.sliced.late, after1.late + 1);
  r.draw(frame());
  assert.deepEqual(calls.sliced, { ...after1, late: after1.late + 1 }, 'steady state slices nothing');
  const imgs = drawnImages(calls).slice(-3);
  assert.equal(imgs.filter(t => t === 'cottage|s|0').length, 2, 'both cottages drawn from the shared sprite');
  // same version again: still cached; a new version (objects may have moved): re-sliced
  r.setWorld(world);
  r.draw(frame());
  assert.equal(calls.sliced.a, after1.a);
  r.setWorld({ ...world, version: 2, objects: new Map([['a', bld('a', 3, 0)]]) });
  r.draw(frame());
  assert.equal(calls.sliced.a, after1.a + 1);
});

test('actor on the tile centre just behind a building is drawn before it (real depth.js keys)', async () => {
  const D = await import('../web/src/engine/render/depth.js');
  const { r, calls, ready, deps } = mk({ objects: [bld('house', 3, 3)] });
  void deps; ready.add('cottage|s|0');
  // sliceSprite fake: one slice at the cell's depth (6); actor feet at the centre of (3, 2), directly behind
  const hits = r.draw(frame({ actors: [actor('behind', 3.5, 2.5), actor('front', 3.5, 4.5)] }));
  assert.deepEqual(hits.map(h => h.id), ['front', 'house', 'behind']);
  assert.ok(D.feetKey(3.5, 2.5) < D.sortKey(6, 0, D.LAYER.OBJECT, 0));
  void calls;
});
