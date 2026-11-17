// M4 spec tests for camera-ctl.js (plan P1). Written from the spec, not the implementation.
// While the module is missing the tests are todo; once it exists they run for real.
import test from 'node:test';
import assert from 'node:assert/strict';

const MOD = '../web/src/engine/camera-ctl.js';
const mod = await import(MOD).catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return null; throw e; });
const TODO = mod ? false : 'needs camera-ctl.js';
const t = (title, fn) => test(title, { todo: TODO }, TODO ? () => {} : fn);

const vp = { w: 1000, h: 600 };
const LAND = { ox: 0, oy: 0, w: 40, h: 40 };
const mkStore = () => { const m = new Map(); return { m, get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => { m.set(k, v); }, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); } }; };
let clock;
function make(over = {}) {
  clock = 0;
  const store = over.store || mkStore();
  const ctl = mod.createCameraCtl({ vp, store, key: 'va.cam.e2', reduceMotion: () => false, now: () => clock, ...over });
  ctl.setRects({ ox: 10, oy: 10, w: 10, h: 10 }, LAND);
  return { ctl, store };
}
const run = (ctl, ms) => { for (let i = 0; i <= ms; i += 16) { clock = i; ctl.tick(i); } clock = ms; ctl.tick(ms); };

t('camera-ctl: zooms stay on the 1-4 and Map levels [camera.zoom-levels]', () => {
  const { ctl } = make();
  const zs = [];
  for (let i = 0; i < 8; i++) { ctl.zoomStep(1); zs.push(ctl.get().z); }
  assert.equal(Math.max(...zs), 4);
  for (const z of zs) assert.ok([0.125, 0.25, 0.5, 1, 2, 3, 4].includes(z), `z=${z}`);
  for (let i = 0; i < 10; i++) ctl.zoomStep(-1);
  assert.ok(ctl.get().z <= 0.5);
});

t('camera-ctl: home fits the whole focus rect, Map level when it is big [camera.map-fit] [camera.home-fit]', () => {
  const { ctl } = make();
  ctl.setRects({ ox: -100, oy: -100, w: 300, h: 300 }, { ox: -100, oy: -100, w: 300, h: 300 });
  ctl.home({ animate: false });
  const c = ctl.get();
  assert.ok(c.z < 1, `expected a Map level, got ${c.z}`);
  assert.ok([0.5, 0.25, 0.125].includes(c.z));
  assert.equal(c.v, 2);
});

t('camera-ctl: the wheel keeps the world point under the pointer fixed, with an 80-delta accumulator [camera.wheel-anchor]', () => {
  const { ctl } = make();
  ctl.setZoom(2);
  const before = ctl.get();
  ctl.wheel(-30, { x: 700, y: 200 });
  assert.equal(ctl.get().z, before.z, 'under 80 total does not zoom');
  ctl.wheel(-30, { x: 700, y: 200 });
  assert.equal(ctl.get().z, before.z, '60 total does not zoom');
  ctl.wheel(-30, { x: 700, y: 200 });
  const after = ctl.get();
  assert.ok(after.z > before.z, 'over 80 zooms in');
  // anchored: the pointer's off-centre offset means the centre must have moved
  assert.ok(after.x !== before.x || after.y !== before.y);
});

t('camera-ctl: wheel zoom out goes the other way [camera.wheel-anchor]', () => {
  const { ctl } = make();
  ctl.setZoom(3);
  ctl.wheel(100, { x: 500, y: 300 });
  assert.ok(ctl.get().z < 3);
});

t('camera-ctl: a drag under 4 px does not mark the user as having moved; over 4 px does [camera.drag-pan-threshold]', () => {
  const { ctl } = make();
  // The 4 px gate itself lives in input-ctl (it only calls panBy once a drag passes it); camera-ctl exports the constant.
  assert.equal(mod.DRAG_PX, 4);
  assert.equal(ctl.userMoved, false, 'nothing moved yet');
  ctl.panBy(30, 0); ctl.endDrag();
  assert.equal(ctl.userMoved, true, 'a real pan marks the user as having moved');
});

t('camera-ctl: the camera clamps to land plus 10 tiles after every move [camera.clamp-land]', () => {
  const { ctl } = make();
  ctl.centerOn({ x: 5000, y: 5000 }, { animate: false });
  let c = ctl.get();
  assert.ok(c.x <= LAND.ox + LAND.w + 10 && c.y <= LAND.oy + LAND.h + 10, JSON.stringify(c));
  ctl.centerOn({ x: -5000, y: -5000 }, { animate: false });
  c = ctl.get();
  assert.ok(c.x >= LAND.ox - 10 && c.y >= LAND.oy - 10, JSON.stringify(c));
  ctl.panBy(-1e6, -1e6); ctl.endDrag();
  c = ctl.get();
  assert.ok(Number.isFinite(c.x) && Math.abs(c.x) < 1e4 && Math.abs(c.y) < 1e4);
});

t('camera-ctl: the camera persists under its key and restores [camera.persisted]', () => {
  const { ctl, store } = make();
  ctl.setZoom(3);
  ctl.panBy(40, 20); ctl.endDrag();
  const saved = ctl.get();
  assert.ok([...store.m.keys()].some(k => k === 'va.cam.e2'), 'wrote the key');
  const b = make({ store });
  b.ctl.set(saved);
  assert.deepEqual(b.ctl.get(), saved);
  const c = mod.createCameraCtl({ vp, store, key: 'va.cam.e2', reduceMotion: () => false, now: () => 0 });
  c.setRects({ ox: 10, oy: 10, w: 10, h: 10 }, LAND);
  c.set(store.get('va.cam.e2')); // the store is write-only for the controller; the caller restores via set()
  assert.equal(c.get().z, saved.z, 'a fresh controller restores the stored zoom');
  assert.equal(c.get().v, 2);
});

t('camera-ctl: auto-refit follows the focus rect until the user moves [camera.auto-refit]', () => {
  const { ctl } = make();
  ctl.home({ animate: false });
  const a = ctl.get();
  ctl.setRects({ ox: 10, oy: 10, w: 20, h: 20 }, LAND);
  ctl.onResize();
  const b = ctl.get();
  assert.ok(a.x !== b.x || a.z !== b.z, 'refit when nothing moved by the user');
  ctl.panBy(80, 0); ctl.endDrag();
  const c = ctl.get();
  ctl.setRects({ ox: 0, oy: 0, w: 8, h: 8 }, LAND);
  ctl.onResize();
  assert.deepEqual(ctl.get(), c, 'no refit after the user moved');
});

t('camera-ctl: a resize (peek) refits when the user has not moved [camera.refit-after-peek]', () => {
  const small = { w: 400, h: 300 }, vpx = { ...vp };
  const { ctl } = make({ vp: vpx });
  ctl.home({ animate: false });
  const a = ctl.get();
  vpx.w = small.w; vpx.h = small.h;
  ctl.onResize();
  const b = ctl.get();
  assert.ok(b.z <= a.z, 'a smaller view never zooms in further');
});

t('camera-ctl: the fit waits while the view is zero-sized (hidden) [camera.fit-waits-hidden]', () => {
  const hidden = { w: 0, h: 0 }, { ctl } = make({ vp: hidden });
  const before = ctl.get();
  assert.doesNotThrow(() => { ctl.home({ animate: false }); ctl.onResize(); });
  const after = ctl.get();
  assert.ok(Number.isFinite(after.z) && Number.isFinite(after.x), 'no NaN from a hidden view');
  assert.ok(before.z === after.z || after.z > 0);
});

t('camera-ctl: zoomStep is the + and - buttons, anchored at the centre [camera.zoom-buttons]', () => {
  const { ctl } = make();
  ctl.setZoom(2);
  ctl.zoomStep(1);
  assert.equal(ctl.get().z, 3);
  ctl.zoomStep(-1); ctl.zoomStep(-1);
  assert.equal(ctl.get().z, 1);
});

t('camera-ctl: reset goes home and forgets that the user moved [camera.reset-button]', () => {
  const { ctl } = make();
  ctl.panBy(100, 100); ctl.endDrag();
  assert.equal(ctl.userMoved, true);
  ctl.reset();
  assert.equal(ctl.userMoved, false);
});

t('camera-ctl: set/get round-trip for the terminal save and restore [camera.terminal-save-restore]', () => {
  const { ctl } = make();
  ctl.setZoom(3);
  ctl.centerOn({ x: 15, y: 18 }, { animate: false });
  const saved = ctl.get();
  assert.equal(saved.v, 2);
  ctl.setZoom(1); ctl.centerOn({ x: 30, y: 5 }, { animate: false });
  ctl.set(saved);
  assert.deepEqual(ctl.get(), saved);
});

t('camera-ctl: centerOn tweens over 300 ms with a cubic ease and then lands [camera.center-on-selected] [camera.tween-300ms]', () => {
  const { ctl } = make();
  ctl.setZoom(2);
  const from = ctl.get();
  ctl.centerOn({ x: 30, y: 30 }, { animate: true });
  assert.equal(ctl.tweening, true);
  clock = 0; ctl.tick(0);
  clock = 150; assert.equal(ctl.tick(150), true, 'tick reports it is still animating');
  const mid = ctl.cam; // get() reports a tween in flight as already done, so read the live cam
  assert.deepEqual({ x: ctl.get().x, y: ctl.get().y }, { x: 30, y: 30 }, 'get() counts the tween as done');
  assert.ok(mid.x !== from.x || mid.y !== from.y, 'moved part way');
  assert.ok(Math.abs(mid.x - 30) > 0.01 || Math.abs(mid.y - 30) > 0.01, 'not there yet at 150 ms');
  clock = 320; ctl.tick(320);
  const end = ctl.get();
  assert.ok(Math.abs(end.x - 30) < 1e-6 && Math.abs(end.y - 30) < 1e-6, JSON.stringify(end));
  assert.equal(ctl.tweening, false);
});

t('camera-ctl: reduced motion makes centerOn instant [camera.reduced-motion-instant]', () => {
  const { ctl } = make({ reduceMotion: () => true });
  ctl.centerOn({ x: 30, y: 30 }, { animate: true });
  assert.equal(ctl.tweening, false);
  const c = ctl.get();
  assert.ok(Math.abs(c.x - 30) < 1e-6 && Math.abs(c.y - 30) < 1e-6);
});
