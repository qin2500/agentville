// Map-zoom actor atlas (design §3.5, render/actor-atlas.js): every villager at Map zoom draws from one pre-scaled page
// per device scale, found by its frame key, so a frame never composes a doll and every actor shares one image. Spec:
// a key made once is a lookup after; the pre-scale is nearest-neighbour (smoothing off) into its own slot of a page;
// a full page starts over and says so; frame keys are equal exactly when the frames are the same pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorAtlas } from '../web/src/engine/render/actor-atlas.js';
import { createDoll } from '../web/src/engine/art/doll.js';

function fakeCanvases(log = []) {
  return (w, h) => {
    const ops = [], props = {};
    const ctx = new Proxy(props, {
      get: (t, k) => k === 'drawImage' ? (...a) => ops.push(['drawImage', a[0]?.tag, ...a.slice(1)])
        : k === 'setTransform' ? (...a) => ops.push(['setTransform', ...a]) : (k in t ? t[k] : () => {}),
      set: (t, k, v) => (t[k] = v, true),
    });
    const cv = { width: w, height: h, tag: `page${log.length}`, ops, props, getContext: () => ctx };
    log.push(cv);
    return cv;
  };
}
const fr = (tag, w = 20, h = 28) => ({ img: { tag, width: w, height: h }, pivot: { x: 10, y: 26 }, head: { x: 10, y: 3 } });

test('a frame is pre-scaled once per scale, nearest-neighbour, into its own slot of one page', () => {
  const log = [], at = createActorAtlas({ createCanvas: fakeCanvases(log), size: 64 });
  assert.equal(at.get('k1', 0.25), null);
  const s1 = at.put('k1', 0.25, fr('a')), s2 = at.put('k2', 0.25, fr('b'));
  assert.equal(log.length, 1, 'one page for the scale');
  assert.equal(log[0].props.imageSmoothingEnabled, false, 'the same nearest sample as the camera transform');
  assert.equal(s1.img, log[0]); assert.equal(s2.img, log[0]);
  assert.deepEqual([s1.sw, s1.sh], [5, 7], 'device px: ceil(w × s), ceil(h × s)');
  assert.ok(s2.sx >= s1.sx + s1.sw + 1 || s2.sy >= s1.sy + s1.sh + 1, 'slots never touch');
  assert.deepEqual([s1.w, s1.h, s1.pivot, s1.head], [20, 28, { x: 10, y: 26 }, { x: 10, y: 3 }], 'the 1x frame geometry (hits, marks)');
  const draws = log[0].ops.filter(o => o[0] === 'drawImage');
  assert.deepEqual(draws.map(o => o[1]), ['a', 'b']);
  assert.equal(at.get('k1', 0.25), s1, 'a lookup after');
  at.put('k1', 0.125, fr('a'));
  assert.equal(log.length, 2, 'one page per scale');
  assert.equal(at.get('k1', 0.25), s1);
});

test('a full page starts over: its old slots are gone and resets counts it', () => {
  const at = createActorAtlas({ createCanvas: fakeCanvases(), size: 18 });
  const r0 = at.resets;
  for (let i = 0; i < 6; i++) at.put('k' + i, 0.25, fr('f' + i));   // 5x7 slots and 1 px gaps on an 18 px page: 4 fit
  assert.equal(at.resets, r0 + 1);
  assert.equal(at.get('k0', 0.25), null, 'a slot from before the reset is not handed out');
  assert.ok(at.get('k5', 0.25));
  assert.equal(at.put('huge', 0.25, fr('x', 200, 200)), null, 'wider than a page: drawn directly instead');
});

test('no canvas: no slots (the renderer draws each frame directly)', () => {
  const at = createActorAtlas({ createCanvas: () => null });
  assert.equal(at.put('k', 0.25, fr('a')), null);
});

test('doll frameKey: equal keys exactly when frame() gives the same frame, made without composing', () => {
  const PARTS = { body: { layer: 0, draw: g => g.rect?.(4, 4, 8, 16, 'skin') } };
  const doll = createDoll({ parts: PARTS, anims: { idle: { frames: 1 }, walk: { frames: 4 } } });
  const look = { parts: ['body'], palette: { skin: '#c89f7a' } }, same = { parts: ['body'], palette: { skin: '#c89f7a' } };
  const other = { parts: ['body'], palette: { skin: '#203040' } };
  const k = (l, f, a, i, sel = false) => doll.frameKey(l, f, a, i, { selected: sel });
  const r0 = doll.stats().renders;
  assert.equal(k(look, 0, 'walk', 1), k(same, 0, 'walk', 1), 'same look content, same key');
  assert.equal(k(look, 0, 'walk', 1), k(look, 0, 'walk', 5), 'frames wrap with the anim');
  assert.equal(k(look, 0, 'nosuch', 3), k(look, 0, 'idle', 0), 'an unknown anim is idle');
  const keys = [k(look, 0, 'walk', 1), k(look, 1, 'walk', 1), k(look, 0, 'walk', 2), k(look, 0, 'idle', 0), k(look, 0, 'walk', 1, true), k(other, 0, 'walk', 1)];
  assert.equal(new Set(keys).size, keys.length, 'facing, frame, anim, selection and look all count');
  assert.equal(doll.stats().renders, r0, 'no frame composed');
  assert.equal(k(null, 0, 'idle', 0), null);
});
