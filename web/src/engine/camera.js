// Engine camera (design §6.3). OWNER: A1. Pure: node tests import it.
// A camera is { x, y, z }: x, y are FLOAT TILES at the view centre, z the zoom (CSS px per 1x world px).
// Close-up zooms are the integers 1-4; Map levels are 1/2, 1/4, 1/8 (fit levels for the whole town).
import { toScreen, toTile } from './core/coords.js';

export const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 3, 4];
export const MAP_ZOOMS = [0.5, 0.25, 0.125];

/** World tile point → CSS px inside a viewport { w, h }. */
export function worldToCss(cam, vp, tx, ty, z = 0) {
  const p = toScreen(tx, ty, z), c = toScreen(cam.x, cam.y);
  return { x: (p.sx - c.sx) * cam.z + vp.w / 2, y: (p.sy - c.sy) * cam.z + vp.h / 2 };
}
/** CSS px inside a viewport → world tile point (ground plane). */
export function cssToWorld(cam, vp, x, y) {
  const c = toScreen(cam.x, cam.y);
  return toTile(c.sx + (x - vp.w / 2) / cam.z, c.sy + (y - vp.h / 2) / cam.z);
}
/** 1x screen rect [x0, y0, x1, y1] of a tile rect { ox, oy, w, h } (its four diamond corners). */
export function tileRectScreen(r) {
  const cs = [toScreen(r.ox, r.oy), toScreen(r.ox + r.w, r.oy), toScreen(r.ox, r.oy + r.h), toScreen(r.ox + r.w, r.oy + r.h)];
  return [Math.min(...cs.map(c => c.sx)), Math.min(...cs.map(c => c.sy)), Math.max(...cs.map(c => c.sx)), Math.max(...cs.map(c => c.sy))];
}
/** The camera that shows tile rect `r` whole: the largest close-up zoom that fits, else the largest Map level. */
export function fitCamera(r, vp, { margin = 24 } = {}) {
  const [x0, y0, x1, y1] = tileRectScreen(r), w = x1 - x0 + 2 * margin, h = y1 - y0 + 2 * margin;
  const z = [2, 1, ...MAP_ZOOMS].find(k => w * k <= vp.w && h * k <= vp.h) ?? MAP_ZOOMS.at(-1);
  const c = toTile((x0 + x1) / 2, (y0 + y1) / 2);
  return { x: c.tx, y: c.ty, z };
}
/** One zoom step in or out (dir ±1). Map levels collapse to one step: in from any Map level goes to 1x. */
export function stepZoom(z, dir) {
  if (dir > 0) return z < 1 ? 1 : Math.min(4, z + 1);
  return z > 1 ? z - 1 : z === 1 ? 0.5 : z;
}
/** Zoom to `z` keeping the world point under CSS `anchor` fixed. Returns a new camera. */
export function zoomAt(cam, vp, z, anchor) {
  if (!anchor) return { ...cam, z };
  const w = cssToWorld(cam, vp, anchor.x, anchor.y), next = { ...cam, z };
  const after = cssToWorld(next, vp, anchor.x, anchor.y);
  return { x: cam.x + (w.tx - after.tx), y: cam.y + (w.ty - after.ty), z };
}
/** Keep the view centre inside tile rect `r` grown by `pad` tiles. */
export function clampCamera(cam, r, pad = 10) {
  const x = Math.min(Math.max(cam.x, r.ox - pad), r.ox + r.w + pad), y = Math.min(Math.max(cam.y, r.oy - pad), r.oy + r.h + pad);
  return x === cam.x && y === cam.y ? cam : { ...cam, x, y };
}
