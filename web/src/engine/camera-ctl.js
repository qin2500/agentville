// Engine camera controller (M4 P1). Pure and DOM-free: vp, store, now and reduceMotion are injected so node tests run it.
// Camera = { x, y, z } (float tiles at the view centre, zoom). Maths come from camera.js; this adds state, tween, clamp, persistence.
import { ZOOMS, MAP_ZOOMS, tileRectScreen, fitCamera, stepZoom, zoomAt, clampCamera, cssToWorld } from './camera.js';

const TWEEN_MS = 300;       // parity: camera.tween-300ms
const DRAG_PX = 4;          // parity: camera.drag-pan-threshold (the threshold itself is applied by input-ctl; exported for it)
const WHEEL_STEP = 80;
const CLAMP_PAD = 10;       // parity: camera.clamp-land
export { DRAG_PX };

/** parity: loop.visibility-rules. The village draws unless hidden, zero-width, or under a full panel (peek and village-only count as visible). */
export function isActive({ hidden = false, panel = '', peek = false, villageOnly = false, width = 1 } = {}) {
  return !hidden && (panel !== 'full' || !!peek || !!villageOnly) && width > 0;
}

export function createCameraCtl({ vp, store, key, reduceMotion = false, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) } = {}) {
  const view = () => (typeof vp === 'function' ? vp() : vp) || { w: 0, h: 0 };
  const reduce = () => (typeof reduceMotion === 'function' ? !!reduceMotion() : !!reduceMotion);
  let cam = { x: 0, y: 0, z: 2 }, focus = null, bounds = null;
  let userMoved = false, tween = null, homeLater = false, wheelAcc = 0;

  // parity: camera.persisted
  const remember = () => { userMoved = true; persist(); };
  const persist = () => { try { store?.set?.(key, { v: 2, ...ctl.get() }); } catch { /* storage may be unavailable */ } };

  // parity: camera.clamp-land (land + 10 tiles); on Map the camera is a fit level, centred on the town
  function clamp(c) {
    let o = bounds ? clampCamera(c, bounds, CLAMP_PAD) : c;
    if (o.z < 1 && focus) { const f = fitCamera(focus, view()); o = { ...o, x: f.x, y: f.y }; }
    return o;
  }
  // Map level that shows the whole town: the largest of 1/2, 1/4, 1/8 that fits.
  function mapLevel() {
    if (!focus) return MAP_ZOOMS[0];
    const vpt = view(), [x0, y0, x1, y1] = tileRectScreen(focus), w = x1 - x0 + 48, h = y1 - y0 + 48;
    return MAP_ZOOMS.find(k => w * k <= vpt.w && h * k <= vpt.h) ?? MAP_ZOOMS.at(-1);
  }
  function panTo(x, y, animate) {
    const t = clamp({ ...cam, x, y });
    if (!animate || reduce()) { cam = t; tween = null; }   // parity: camera.reduced-motion-instant
    else tween = { t0: now(), x0: cam.x, y0: cam.y, x1: t.x, y1: t.y };
  }

  const ctl = {
    get cam() { return cam; },
    get userMoved() { return userMoved; },
    set userMoved(v) { userMoved = !!v; },
    get tweening() { return !!tween; },
    /** focus: tile rect the home fit shows; bounds: land tile rect the camera clamps to (+10). */
    setRects(f, b) { focus = f || null; bounds = b || null; cam = clamp(cam); },
    // parity: camera.home-fit, camera.map-fit
    home({ animate = true } = {}) {
      if (!focus) return false;
      const v = view();
      if (!v.w) { homeLater = true; return false; }   // parity: camera.fit-waits-hidden
      homeLater = false;
      const f = fitCamera(focus, v);
      cam = { ...cam, z: f.z };
      panTo(f.x, f.y, animate);
      return true;
    },
    // parity: camera.auto-refit, camera.refit-after-peek: until the user moves, a resize refits; a deferred fit runs on first size.
    onResize() {
      if (view().w && (homeLater || !userMoved)) ctl.home({ animate: false });
      else cam = clamp(cam);
      return true;
    },
    // parity: camera.zoom-levels
    setZoom(z, anchor) {
      if (!ZOOMS.includes(z)) return false;
      if (z < 1) { if (cam.z < 1) return false; z = mapLevel(); }
      if (z === cam.z) return false;
      tween = null;
      cam = clamp(zoomAt(cam, view(), z, anchor));
      remember();
      return true;
    },
    // parity: camera.zoom-buttons
    zoomStep(dir, anchor) { return ctl.setZoom(stepZoom(cam.z, dir), anchor); },
    // parity: camera.wheel-anchor: 80-delta accumulator, one step per crossing, anchored at the pointer
    wheel(deltaY, anchor) {
      wheelAcc += deltaY;
      if (Math.abs(wheelAcc) <= WHEEL_STEP) return false;
      const dir = wheelAcc < 0 ? 1 : -1;
      wheelAcc = 0;
      return ctl.zoomStep(dir, anchor);
    },
    /** Drag pan: the world follows the pointer by (dx, dy) CSS px. Persisted by endDrag(). */
    panBy(dx, dy) {
      tween = null;
      const v = view(), a = cssToWorld(cam, v, v.w / 2, v.h / 2), b = cssToWorld(cam, v, v.w / 2 - dx, v.h / 2 - dy);
      cam = clamp({ ...cam, x: cam.x + (b.tx - a.tx), y: cam.y + (b.ty - a.ty) });
      userMoved = true;
    },
    endDrag() { cam = clamp(cam); remember(); },
    // parity: camera.center-on-selected, camera.tween-300ms
    centerOn({ x, y }, { animate = true, zoomIn = false } = {}) {
      if (zoomIn && cam.z < 1) cam = { ...cam, z: 2 };
      panTo(x, y, animate);
    },
    /** Advance the tween to nowMs; true while it still needs frames. */
    tick(nowMs) {
      if (!tween) return false;
      const p = Math.min(1, (nowMs - tween.t0) / TWEEN_MS), e = 1 - (1 - p) ** 3;
      cam = clamp({ ...cam, x: tween.x0 + (tween.x1 - tween.x0) * e, y: tween.y0 + (tween.y1 - tween.y0) * e });
      if (p >= 1) tween = null;
      return !!tween;
    },
    // parity: camera.terminal-save-restore: get() counts a tween in flight as done
    get() { return { v: 2, x: tween ? tween.x1 : cam.x, y: tween ? tween.y1 : cam.y, z: cam.z }; },
    /** Accepts { v: 2, x, y, z }; a classic camera (world px) only restores the zoom level. */
    set(c) {
      if (!c) return;
      if (c.v === 2 && Number.isFinite(+c.x) && Number.isFinite(+c.y)) cam = { x: +c.x, y: +c.y, z: ZOOMS.includes(c.z) ? c.z : cam.z };
      else if (ZOOMS.includes(c.z)) cam = { ...cam, z: c.z };
      else return;
      tween = null; cam = clamp(cam); userMoved = true;
    },
    // parity: camera.reset-button
    reset() { userMoved = false; ctl.home({ animate: true }); persist(); },
    // parity: camera.keys: + = - 0
    key(k) {
      if (k === '+' || k === '=') { ctl.zoomStep(1); return true; }
      if (k === '-') { ctl.zoomStep(-1); return true; }
      if (k === '0') { ctl.reset(); return true; }
      return false;
    },
    /** CSS px in the viewport -> tile point on the ground plane. */
    cssToTile(x, y) { const w = cssToWorld(cam, view(), x, y); return { x: w.tx, y: w.ty }; },
  };
  return ctl;
}
