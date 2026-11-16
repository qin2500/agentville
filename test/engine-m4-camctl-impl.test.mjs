// M4 P1 implementation tests: camera-ctl.js and input-ctl.js (no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraCtl, isActive } from '../web/src/engine/camera-ctl.js';
import { attachInput, villageAtTile, bindZoomButtons } from '../web/src/engine/input-ctl.js';
import { pick } from '../web/src/engine/render/pick.js';
import { cssToWorld } from '../web/src/engine/camera.js';

const VP = { w: 1440, h: 900 };
const LAND = { ox: 0, oy: 0, w: 20, h: 20 };
function mk(over = {}) {
  let t = 0; const saved = new Map(), vp = { ...VP };
  const c = createCameraCtl({ vp: () => vp, store: { set: (k, v) => saved.set(k, v) }, key: 'cam', reduceMotion: false, now: () => t, ...over });
  c.setRects(LAND, LAND);
  return { c, saved, vp, clock: n => { t = n; } };
}

test('[camera.zoom-levels] zoom steps walk 1..4 and ignore invalid zooms', () => {
  const { c } = mk(); c.set({ v: 2, x: 10, y: 10, z: 1 });
  assert.ok(c.zoomStep(1)); assert.equal(c.cam.z, 2);
  c.zoomStep(1); c.zoomStep(1); c.zoomStep(1); assert.equal(c.cam.z, 4);
  assert.equal(c.setZoom(5), false);
});

test('[camera.map-fit] zooming out of 1x lands on a Map level that fits the town', () => {
  const { c } = mk(); c.set({ v: 2, x: 10, y: 10, z: 1 });
  c.zoomStep(-1); assert.ok(c.cam.z < 1);
  const z = c.cam.z; c.zoomStep(-1); assert.equal(c.cam.z, z);
  c.zoomStep(1); assert.equal(c.cam.z, 1);
});

test('[camera.home-fit] home fits the focus rect centred', () => {
  const { c } = mk(); assert.ok(c.home({ animate: false }));
  assert.ok(Math.abs(c.cam.x - 10) < 1e-9 && Math.abs(c.cam.y - 10) < 1e-9); assert.ok(c.cam.z >= 1);
});

test('[camera.fit-waits-hidden] a zero-width viewport defers the fit until it has a size', () => {
  const { c, vp } = mk(); vp.w = 0; vp.h = 0;
  assert.equal(c.home({ animate: false }), false);
  c.set({ v: 2, x: 10, y: 10, z: 4 }); c.userMoved = false;
  vp.w = 1440; vp.h = 900; c.onResize();
  assert.equal(c.cam.z, 2);
});

test('[camera.auto-refit] resize refits until the user moves', () => {
  const { c, vp } = mk(); c.home({ animate: false });
  vp.w = 500; vp.h = 400; c.onResize(); const z1 = c.cam.z;
  assert.ok(z1 <= 2);
  c.panBy(30, 0); const x = c.cam.x; vp.w = 1440; vp.h = 900; c.onResize();
  assert.equal(c.cam.x, x);
});

test('[camera.refit-after-peek] a smaller box refits to a smaller zoom while the camera is unmoved', () => {
  const { c, vp } = mk(); c.home({ animate: false }); const big = c.cam.z;
  vp.w = 300; vp.h = 200; c.onResize(); assert.ok(c.cam.z < big);
});

test('[camera.wheel-anchor] wheel needs >80 accumulated delta and keeps the pointer world point fixed', () => {
  const { c } = mk(); c.set({ v: 2, x: 10, y: 10, z: 1 });
  const a = { x: 300, y: 200 }, before = cssToWorld(c.cam, VP, a.x, a.y);
  assert.equal(c.wheel(-50, a), false); assert.equal(c.cam.z, 1);
  assert.equal(c.wheel(-50, a), true); assert.equal(c.cam.z, 2);
  const after = cssToWorld(c.cam, VP, a.x, a.y);
  assert.ok(Math.abs(before.tx - after.tx) < 1e-6 && Math.abs(before.ty - after.ty) < 1e-6);
  c.wheel(100, a); assert.equal(c.cam.z, 1);
});

test('[camera.clamp-land] pan never leaves land + 10 tiles', () => {
  const { c } = mk(); c.set({ v: 2, x: 10, y: 10, z: 2 });
  c.panBy(-100000, -100000); assert.ok(c.cam.x <= 30 && c.cam.y <= 30 && c.cam.x >= -10 && c.cam.y >= -10);
  c.panBy(100000, 100000); assert.ok(c.cam.x >= -10 && c.cam.y >= -10);
  assert.ok(c.cam.x === -10 || c.cam.y === -10);
});

test('[camera.persisted] user moves write { v: 2, x, y, z } to the store', () => {
  const { c, saved } = mk(); c.set({ v: 2, x: 10, y: 10, z: 1 }); c.zoomStep(1);
  assert.deepEqual(saved.get('cam'), { v: 2, x: c.cam.x, y: c.cam.y, z: 2 });
});

test('[camera.tween-300ms] centerOn tweens over 300 ms, ending exactly on target', () => {
  const { c, clock } = mk(); c.set({ v: 2, x: 5, y: 5, z: 2 });
  clock(1000); c.centerOn({ x: 15, y: 15 });
  assert.ok(c.tweening);
  assert.equal(c.tick(1150), true); assert.ok(c.cam.x > 5 && c.cam.x < 15);
  assert.equal(c.tick(1300), false); assert.equal(c.cam.x, 15); assert.equal(c.tweening, false);
});

test('[camera.reduced-motion-instant] reduced motion jumps with no tween', () => {
  const { c } = mk({ reduceMotion: () => true }); c.set({ v: 2, x: 5, y: 5, z: 2 });
  c.centerOn({ x: 15, y: 15 }); assert.equal(c.tweening, false); assert.equal(c.cam.x, 15);
});

test('[camera.center-on-selected] centerOn with zoomIn leaves Map for 2x', () => {
  const { c } = mk({ reduceMotion: true }); c.set({ v: 2, x: 10, y: 10, z: 0.5 });
  c.centerOn({ x: 4, y: 6 }, { zoomIn: true }); assert.equal(c.cam.z, 2); assert.equal(c.cam.x, 4);
});

test('[camera.terminal-save-restore] get() reports a tween as done and set() restores it', () => {
  const { c } = mk(); c.set({ v: 2, x: 5, y: 5, z: 2 }); c.centerOn({ x: 12, y: 12 });
  const g = c.get(); assert.deepEqual(g, { v: 2, x: 12, y: 12, z: 2 });
  const o = mk().c; o.set(g); assert.deepEqual(o.get(), g);
  o.set({ x: 1, y: 1, z: 4 }); assert.equal(o.cam.z, 4); assert.equal(o.cam.x, 12);   // classic camera: zoom only
});

test('[camera.zoom-buttons] bindZoomButtons wires +, - to zoomStep', () => {
  const { c } = mk(); c.set({ v: 2, x: 10, y: 10, z: 2 });
  const els = {}; const doc = { getElementById: id => (els[id] = { cbs: [], addEventListener(n, f) { this.cbs.push(f); } }) };
  bindZoomButtons(doc, c); els['zoom-in'].cbs[0](); assert.equal(c.cam.z, 3); els['zoom-out'].cbs[0](); assert.equal(c.cam.z, 2);
});

test('[camera.reset-button] reset refits and clears userMoved', () => {
  const { c } = mk({ reduceMotion: true }); c.home({ animate: false }); c.panBy(80, 0); assert.ok(c.userMoved);
  c.reset(); assert.equal(c.userMoved, false); assert.ok(Math.abs(c.cam.x - 10) < 1e-9);
});

test('[camera.keys] + = - 0 drive zoom and reset', () => {
  const { c } = mk({ reduceMotion: true }); c.set({ v: 2, x: 10, y: 10, z: 2 });
  assert.ok(c.key('+')); assert.equal(c.cam.z, 3); c.key('-'); assert.equal(c.cam.z, 2);
  c.key('='); assert.equal(c.cam.z, 3); c.key('0'); assert.equal(c.userMoved, false); assert.equal(c.key('x'), false);
});

test('[loop.visibility-rules] hidden, full panel and zero width stop the loop; peek and village-only count as visible', () => {
  assert.equal(isActive({ width: 800 }), true);
  assert.equal(isActive({ hidden: true, width: 800 }), false);
  assert.equal(isActive({ panel: 'full', width: 800 }), false);
  assert.equal(isActive({ panel: 'full', peek: true, width: 800 }), true);
  assert.equal(isActive({ panel: 'full', villageOnly: true, width: 800 }), true);
  assert.equal(isActive({ width: 0 }), false);
});

// ---------- input ----------
function rig({ z = 2, hitsList, resolve, demo = () => false, ord = ['a', 'b', 'c'] } = {}) {
  const { c } = mk({ reduceMotion: true }); c.set({ v: 2, x: 10, y: 10, z });
  const L = {}; const cv = { addEventListener(n, f) { L[n] = f; }, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} };
  const log = [], events = [], changes = []; let sel = null;
  const hits = hitsList || [{ id: 's1', kind: 'agent', rect: [100, 100, 140, 160] }, { id: 's2', kind: 'house', rect: [300, 300, 400, 400] }, { id: 'sd', kind: 'dock', rect: [600, 600, 700, 700] }];
  const res = resolve || (h => (h.kind === 'agent' ? { id: 'A1' } : h.kind === 'house' ? { id: 'H1', house: true } : { panel: 'link:http://pr' }));
  const timers = { q: [], setTimeout(f) { this.q.push(f); return this.q.length; }, clearTimeout(i) { if (i) this.q[i - 1] = null; } };
  const app = { select: (...a) => log.push(['select', ...a]), activate: (...a) => log.push(['activate', ...a]), menu: (...a) => log.push(['menu', ...a]) };
  const api = attachInput({ cv, host: null, camera: c, getHits: () => hits, pick, resolve: res, villageAt: (x, y) => (x < 50 ? { name: 'V', x: 3, y: 4 } : null),
    order: () => ord, screenAt: id => ({ x: 111, y: 222, id }), selected: () => sel, app, isDemoId: demo, onChange: s => changes.push(s), emit: (n, d) => events.push([n, d]), timers });
  const ev = (o = {}) => ({ button: 0, clientX: 0, clientY: 0, pointerId: 1, pointerType: 'mouse', preventDefault() { this.prevented = true; }, ...o });
  return { c, L, log, events, changes, api, timers, ev, setSel: v => { sel = v; } };
}
const click = (r, x, y) => { r.L.pointerdown(r.ev({ clientX: x, clientY: y })); r.L.pointerup(r.ev({ clientX: x, clientY: y })); };

test('[inp.click-select] click selects the resolved id; empty ground deselects; no pan', () => {
  const r = rig(); click(r, 110, 110); click(r, 900, 20);
  assert.deepEqual(r.log, [['select', 'A1', { fromVillage: true, pan: false }], ['select', null, { fromVillage: true, pan: false }]]);
});

test('[camera.drag-pan-threshold] under 4 px is a click, over it pans and does not select', () => {
  const r = rig();
  r.L.pointerdown(r.ev({ clientX: 500, clientY: 500 })); r.L.pointermove(r.ev({ clientX: 503, clientY: 500 })); r.L.pointerup(r.ev({ clientX: 503, clientY: 500 }));
  assert.equal(r.log.length, 1);
  const x0 = r.c.cam.x;
  r.L.pointerdown(r.ev({ clientX: 500, clientY: 500 })); r.L.pointermove(r.ev({ clientX: 540, clientY: 500 })); r.L.pointerup(r.ev({ clientX: 540, clientY: 500 }));
  assert.equal(r.log.length, 1); assert.notEqual(r.c.cam.x, x0); assert.ok(r.c.userMoved);
});

test('[inp.double-click-terminal] dblclick on a villager activates it; demo ids do not', () => {
  const r = rig(); r.L.dblclick(r.ev({ clientX: 110, clientY: 110 }));
  assert.deepEqual(r.log, [['activate', 'A1', { x: 110, y: 110 }]]);
  const d = rig({ demo: () => true }); d.L.dblclick(d.ev({ clientX: 110, clientY: 110 })); assert.equal(d.log.length, 0);
});

test('[inp.right-click-long-press-menu] right-click and touch long-press open the menu; mouse press does not', () => {
  const r = rig(); const e = r.ev({ clientX: 110, clientY: 110 }); r.L.contextmenu(e);
  assert.ok(e.prevented); assert.deepEqual(r.log[0], ['menu', 'A1', { x: 110, y: 110 }]);
  const k = r.ev({ clientX: 0, clientY: 0 }); r.L.contextmenu(k); // keyboard-origin: no hit at 0,0 -> ignored
  r.L.pointerdown(r.ev({ clientX: 110, clientY: 110, pointerType: 'touch' })); r.timers.q.at(-1)();
  assert.deepEqual(r.log.at(-1), ['menu', 'A1', { x: 110, y: 110 }]);
  r.L.pointerup(r.ev({ clientX: 110, clientY: 110, pointerType: 'touch' })); assert.equal(r.log.length, 2);
  const m = rig(); m.L.pointerdown(m.ev({ clientX: 110, clientY: 110 })); assert.equal(m.timers.q.length, 0);
});

test('[inp.keyboard-cycle-by-bucket] arrows cycle the supplied order, wrapping, and centre the camera', () => {
  const r = rig(); const e = r.ev({ key: 'ArrowRight' });
  r.L.keydown(e); assert.equal(r.api.cursor, 'a'); r.L.keydown(r.ev({ key: 'ArrowLeft' })); assert.equal(r.api.cursor, 'c');
  r.L.keydown(r.ev({ key: 'ArrowRight' })); assert.equal(r.api.cursor, 'a'); assert.ok(e.prevented);
  assert.ok(r.changes.length >= 3);
  r.L.blur(); assert.equal(r.api.cursor, null);
});

test('[inp.keyboard-enter-select] Enter selects the cursor', () => {
  const r = rig(); r.L.keydown(r.ev({ key: 'Enter' })); assert.equal(r.log.length, 0);
  r.L.keydown(r.ev({ key: 'ArrowRight' })); r.L.keydown(r.ev({ key: 'Enter' }));
  assert.deepEqual(r.log, [['select', 'a', { fromVillage: true }]]);
});

test('[inp.keyboard-menu-keys] ContextMenu and Shift-F10 open the menu at the cursor or selection', () => {
  const r = rig(); r.setSel('b'); r.L.keydown(r.ev({ key: 'ContextMenu' })); r.L.keydown(r.ev({ key: 'F10', shiftKey: true })); r.L.keydown(r.ev({ key: 'F10' }));
  assert.deepEqual(r.log.map(l => l[1]), ['b', 'b']);
});

test('[inp.hover-cursor-state] hover tracks the id (not houses) and reports a pointer cursor; leave clears', () => {
  const r = rig(); r.L.pointermove(r.ev({ clientX: 110, clientY: 110 }));
  assert.equal(r.api.hover, 'A1'); assert.equal(r.changes.at(-1).cursorStyle, 'pointer');
  r.L.pointermove(r.ev({ clientX: 310, clientY: 310 })); assert.equal(r.api.hover, null); assert.equal(r.changes.at(-1).cursorStyle, 'pointer');
  r.L.pointermove(r.ev({ clientX: 900, clientY: 20 })); assert.equal(r.changes.at(-1).cursorStyle, '');
  r.L.pointermove(r.ev({ clientX: 110, clientY: 110 })); r.L.pointerleave(); assert.equal(r.api.hover, null);
});

test('[inp.map-click-zooms-village] on Map a click on a village centres it at 2x; hover reports its name', () => {
  const r = rig({ z: 0.5 }); r.L.pointermove(r.ev({ clientX: 20, clientY: 20 })); assert.equal(r.api.hoverVil, 'V');
  click(r, 20, 20); assert.equal(r.c.cam.z, 2); assert.equal(r.c.cam.x, 3); assert.equal(r.log.length, 0);
});

test('[inp.dock-ship-click-va-dock] a dock/ship click (a host panel hit) opens the panel with the ship href', () => {
  const r = rig(); click(r, 650, 650);
  assert.deepEqual(r.events, [['va:panel', { href: 'http://pr' }]]); assert.equal(r.log.length, 0);
});

test('[camera.wheel-anchor] the wheel listener forwards deltas and prevents scroll', () => {
  const r = rig({ z: 1 }); const e = r.ev({ deltaY: -120, clientX: 200, clientY: 200 }); r.L.wheel(e);
  assert.ok(e.prevented); assert.equal(r.c.cam.z, 2);
});

test('villageAtTile pads the block by one tile', () => {
  const vs = [{ name: 'A', block: { x: 5, y: 5, w: 4, h: 4 } }];
  assert.equal(villageAtTile(vs, 4, 4)?.name, 'A'); assert.equal(villageAtTile(vs, 9, 9)?.name, 'A');
  assert.equal(villageAtTile(vs, 10, 5), null); assert.equal(villageAtTile(vs, 3, 5, 0), null);
});
