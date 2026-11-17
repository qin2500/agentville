// M4 spec tests for input-ctl.js (plan P1), behaviour mirrored from classic web/src/village.js:430-490.
// While the module is missing the tests are todo; once it exists they run for real.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const MOD = '../web/src/engine/input-ctl.js';
const mod = await import(MOD).catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
const TODO = mod ? false : 'needs input-ctl.js';
const t = (title, fn) => test(title, { todo: TODO }, TODO ? () => {} : fn);

if (!globalThis.window) globalThis.window = new EventTarget();
const classList = () => { const s = new Set(); return { add: x => s.add(x), remove: x => s.delete(x), toggle: (x, on) => { (on ?? !s.has(x)) ? s.add(x) : s.delete(x); }, contains: x => s.has(x), s }; };
function fakeEl() {
  const el = new EventTarget();
  el.classList = classList(); el.attrs = {};
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 });
  el.setAttribute = (k, v) => { el.attrs[k] = v; }; el.focus = () => {}; el.setPointerCapture = () => {}; el.releasePointerCapture = () => {};
  el.clientWidth = 1000; el.clientHeight = 600; el.style = {};
  return el;
}
const ev = (type, props = {}) => { const e = new Event(type, { cancelable: true, bubbles: true }); Object.assign(e, { clientX: 0, clientY: 0, button: 0, pointerId: 1, deltaY: 0, shiftKey: false, ...props }); return e; };

// Targets: agent a at x<100, agent b at 100..200, a village at 300..400, the dock at 500..600.
const where = x => x < 100 ? { raw: 'a' } : x < 200 ? { raw: 'b' } : x >= 300 && x < 400 ? { raw: 'v' } : x >= 500 && x < 600 ? { raw: 'd' } : null;
function setup(over = {}) {
  const cv = fakeEl(), host = fakeEl(), calls = [], changes = [];
  const app = { select: (...a) => calls.push(['select', ...a]), activate: (...a) => calls.push(['activate', ...a]), menu: (...a) => calls.push(['menu', ...a]) };
  const camera = { panBy: (...a) => calls.push(['panBy', ...a]), endDrag: () => calls.push(['endDrag']), wheel: (...a) => calls.push(['wheel', ...a]), zoomStep: (...a) => calls.push(['zoomStep', ...a]), setZoom: (...a) => calls.push(['setZoom', ...a]), centerOn: (...a) => calls.push(['centerOn', ...a]), get: () => ({ v: 2, x: 0, y: 0, z: 1 }), cam: { x: 0, y: 0, z: 1 }, cssToTile: (x, y) => ({ x: x / 10, y: y / 10 }) };
  const input = mod.attachInput({
    cv, host, camera, app,
    getHits: () => [],
    pick: (hits, x, y, opts) => where(x),
    resolve: hit => hit ? (hit.raw === 'v' ? { village: { name: 'Oak', cx: 5, cy: 5 } } : hit.raw === 'd' ? { panel: 'venue' } : { id: hit.raw }) : null,
    villageAt: x => (x >= 300 && x < 400 ? { name: 'Oak' } : null),
    order: () => ['a', 'b', 'c'], screenAt: id => ({ x: 10, y: 20, id }), isDemoId: id => id === 'demo',
    onChange: c => changes.push(c), ...over,
  });
  return { cv, host, calls, changes, input, camera, app };
}
const click = (cv, x, y = 10, o = {}) => { cv.dispatchEvent(ev('pointerdown', { clientX: x, clientY: y, ...o })); cv.dispatchEvent(ev('pointerup', { clientX: x, clientY: y, ...o })); };
const sel = calls => calls.filter(c => c[0] === 'select');

t('input: a click selects the agent under the pointer; empty ground clears [inp.click-select]', () => {
  const { cv, calls } = setup();
  click(cv, 50);
  assert.deepEqual(sel(calls)[0].slice(0, 2), ['select', 'a']);
  assert.equal(sel(calls)[0][2]?.fromVillage, true);
  click(cv, 700);
  assert.equal(sel(calls).at(-1)[1], null);
});

t('input: a demo villager opens nothing [inp.click-select]', () => {
  const { cv, calls } = setup({ pick: () => ({ raw: 'demo' }) });
  click(cv, 50);
  assert.equal(sel(calls).length, 0);
});

t('input: a drag past 4 px pans and does not select; under 4 px is a click [camera.drag-pan-threshold] [inp.click-select]', () => {
  const { cv, calls } = setup();
  cv.dispatchEvent(ev('pointerdown', { clientX: 50, clientY: 10 }));
  cv.dispatchEvent(ev('pointermove', { clientX: 52, clientY: 11 }));
  cv.dispatchEvent(ev('pointerup', { clientX: 52, clientY: 11 }));
  assert.equal(sel(calls).length, 1, 'tiny wiggle still selects');
  calls.length = 0;
  cv.dispatchEvent(ev('pointerdown', { clientX: 50, clientY: 10 }));
  cv.dispatchEvent(ev('pointermove', { clientX: 80, clientY: 10 }));
  cv.dispatchEvent(ev('pointerup', { clientX: 80, clientY: 10 }));
  assert.ok(calls.some(c => c[0] === 'panBy'), 'panned the camera');
  assert.ok(calls.some(c => c[0] === 'endDrag'));
  assert.equal(sel(calls).length, 0);
});

t('input: the wheel goes to the camera at the pointer and is not left to scroll the page [camera.wheel-anchor]', () => {
  const { cv, calls } = setup();
  const e = ev('wheel', { clientX: 300, clientY: 200, deltaY: -120 });
  cv.dispatchEvent(e);
  const w = calls.find(c => c[0] === 'wheel');
  assert.ok(w, 'camera.wheel called');
  assert.equal(w[1], -120);
  assert.equal(e.defaultPrevented, true);
});

t('input: double-click opens the terminal via app.activate with the pointer position [inp.double-click-terminal]', () => {
  const { cv, calls } = setup();
  cv.dispatchEvent(ev('dblclick', { clientX: 50, clientY: 10 }));
  const a = calls.find(c => c[0] === 'activate');
  assert.equal(a?.[1], 'a');
  assert.deepEqual({ x: a[2].x, y: a[2].y }, { x: 50, y: 10 });
});

t('input: double-click on a village, the ground or a demo villager activates nothing [inp.double-click-terminal]', () => {
  const { cv, calls } = setup();
  cv.dispatchEvent(ev('dblclick', { clientX: 350, clientY: 10 }));
  cv.dispatchEvent(ev('dblclick', { clientX: 700, clientY: 10 }));
  assert.equal(calls.filter(c => c[0] === 'activate').length, 0);
});

t('input: right-click opens the menu at the pointer [inp.right-click-long-press-menu]', () => {
  const { cv, calls } = setup();
  const e = ev('contextmenu', { clientX: 150, clientY: 30, button: 2 });
  cv.dispatchEvent(e);
  const m = calls.find(c => c[0] === 'menu');
  assert.equal(m?.[1], 'b');
  assert.equal(e.defaultPrevented, true);
});

t('input: a long press opens the menu and the release afterwards does not select [inp.right-click-long-press-menu]', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { cv, calls } = setup();
    cv.dispatchEvent(ev('pointerdown', { clientX: 50, clientY: 10, pointerType: 'touch' }));
    mock.timers.tick(1500);
    assert.ok(calls.some(c => c[0] === 'menu' && c[1] === 'a'), 'menu opened');
    cv.dispatchEvent(ev('pointerup', { clientX: 50, clientY: 10, pointerType: 'touch' }));
    assert.equal(sel(calls).length, 0, 'no select after the long press');
  } finally { mock.timers.reset(); }
});

t('input: arrow keys cycle the cursor through the bucket order and wrap [inp.keyboard-cycle-by-bucket]', () => {
  const { cv, changes, input } = setup();
  const press = key => cv.dispatchEvent(ev('keydown', { key }));
  press('ArrowRight'); assert.equal(input.cursor, 'a');
  press('ArrowRight'); assert.equal(input.cursor, 'b');
  press('ArrowRight'); press('ArrowRight'); assert.equal(input.cursor, 'a', 'wraps');
  press('ArrowLeft'); assert.equal(input.cursor, 'c', 'wraps backwards');
  assert.ok(changes.length > 0 && changes.at(-1).cursor === 'c');
});

t('input: arrow keys centre the camera on the cursor agent [inp.keyboard-cycle-by-bucket]', () => {
  const { cv, calls } = setup();
  cv.dispatchEvent(ev('keydown', { key: 'ArrowRight' }));
  assert.ok(calls.some(c => c[0] === 'centerOn'));
});

t('input: Enter selects the cursor agent; with no cursor it does nothing [inp.keyboard-enter-select]', () => {
  const { cv, calls } = setup();
  cv.dispatchEvent(ev('keydown', { key: 'Enter' }));
  assert.equal(sel(calls).length, 0);
  cv.dispatchEvent(ev('keydown', { key: 'ArrowRight' }));
  cv.dispatchEvent(ev('keydown', { key: 'Enter' }));
  assert.deepEqual(sel(calls)[0].slice(0, 2), ['select', 'a']);
});

t('input: ContextMenu and Shift-F10 open the menu at the agent screen spot [inp.keyboard-menu-keys]', () => {
  const { cv, calls } = setup();
  cv.dispatchEvent(ev('keydown', { key: 'ArrowRight' }));
  cv.dispatchEvent(ev('keydown', { key: 'ContextMenu' }));
  cv.dispatchEvent(ev('keydown', { key: 'F10', shiftKey: true }));
  cv.dispatchEvent(ev('keydown', { key: 'F10', shiftKey: false }));
  const menus = calls.filter(c => c[0] === 'menu');
  assert.equal(menus.length, 2, 'plain F10 does not open it');
  assert.equal(menus[0][1], 'a');
  assert.equal(menus[0][2].x, 10);
});

t('input: hovering reports the agent and a hover cursor; leaving clears it [inp.hover-cursor-state]', () => {
  const { cv, host, changes, input } = setup();
  cv.dispatchEvent(ev('pointermove', { clientX: 150, clientY: 10 }));
  assert.equal(input.hover, 'b');
  assert.ok(changes.some(c => c.hover === 'b'));
  assert.equal(host.classList.contains('hovering'), true);
  cv.dispatchEvent(ev('pointerleave'));
  assert.equal(input.hover, null);
  assert.equal(host.classList.contains('hovering'), false);
});

t('input: hovering a village reports hoverVil [inp.hover-cursor-state]', () => {
  const { cv, input } = setup();
  cv.dispatchEvent(ev('pointermove', { clientX: 350, clientY: 10 }));
  assert.equal(input.hoverVil, 'Oak');
});

t('input: blur drops the keyboard cursor [inp.hover-cursor-state]', () => {
  const { cv, input } = setup();
  cv.dispatchEvent(ev('keydown', { key: 'ArrowRight' }));
  assert.equal(input.cursor, 'a');
  cv.dispatchEvent(ev('blur'));
  assert.equal(input.cursor, null);
});

t('input: clicking a village centres and zooms in [inp.map-click-zooms-village]', () => {
  const { cv, calls } = setup();
  click(cv, 350);
  assert.ok(calls.some(c => c[0] === 'centerOn' && c[2]?.zoomIn) || calls.some(c => c[0] === 'setZoom' && c[1] === 2), 'centred and zoomed in');
  assert.equal(sel(calls).length, 0, 'a village click selects no agent');
});

t('input: detach removes every listener', () => {
  const { cv, calls, input } = setup();
  input.detach();
  click(cv, 50);
  cv.dispatchEvent(ev('keydown', { key: 'ArrowRight' }));
  assert.equal(calls.length, 0);
});

t('input: villageAtTile finds the village whose block (plus 1 tile pad) holds the tile [inp.map-click-zooms-village]', () => {
  const vs = [{ name: 'A', plaza: { x: 10, y: 10, w: 4, h: 4 }, block: { x: 8, y: 8, w: 8, h: 8 } }, { name: 'B', plaza: { x: 40, y: 40, w: 4, h: 4 }, block: { x: 38, y: 38, w: 8, h: 8 } }];
  const f = (tx, ty, pad) => mod.villageAtTile(vs, tx, ty, pad)?.name ?? null;
  assert.equal(f(12, 12), 'A');
  assert.equal(f(42, 42), 'B');
  assert.equal(f(100, 100), null);
  assert.equal(f(7, 12), 'A', 'inside the 1 tile pad');
  assert.equal(f(5, 12), null, 'outside the pad');
});
