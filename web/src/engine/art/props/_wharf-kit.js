// Shared kit for the waterside props built on the classic builders (vessel, tug, rowboat, lighthouse, beacon,
// warehouse, crane, buoy, quay, breakwater, crates). Rasters come from the classic art at projection scale 1.25
// (true 32x16 tile: 16 world px per tile), are cached, and are painted through the quay kit's pixel canvas.
import { canvasOf } from './_quay-kit.js';
import { classicArt, TILE_SCALE } from '../../../engine-art-bridge.js';

export { classicArt, TILE_SCALE };
export const SC = TILE_SCALE;
/** World px (16 per tile) to view px, scale 1: the 32x16 tile. */
export const proj = (wx, wy, z = 0) => [wx - wy, (wx + wy) / 2 - z];
/** Rotate a boat-frame point to a heading: S (default), E, W or N. */
export const turn = (h, x, y) => (h === 'E' ? [y, -x] : h === 'W' ? [-y, x] : h === 'N' ? [-x, -y] : [x, y]);
export const headOf = p => (p && typeof p.head === 'string' && 'SEWN'.includes(p.head) && p.head) || 'S';

const memo = new Map();
export const cached = (key, f) => { let v = memo.get(key); if (!v) { v = f(); memo.set(key, v); } return v; };

// Night: window glass and lantern panes (flat, exact classic colours) turn warm.
const GLOW = new Map([[0x3d5687, [255, 226, 140]], [0x5a74a8, [255, 236, 170]], [0x2c3550, [255, 214, 110]]]);
export function lightUp(r) {
  const d = new Uint8ClampedArray(r.data);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] !== 255) continue;
    const c = GLOW.get((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (c) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; }
  }
  return { ...r, data: d };
}
export const maybeLit = (r, lit) => (lit ? lightUp(r) : r);

/** A layer is { r: raster, ax, ay }: the raster's model origin sits at (ax, ay) view px from the foot. */
export function defineProp({ name, frames = 1, layers, anchors = () => ({}), bob = false }) {
  const pad = bob ? 1 : 0;
  const frameOf = (p, t) => (p && p.frame != null ? Math.abs(p.frame | 0) % frames : p && p.anim && frames > 1 ? Math.abs(Math.floor((t || 0) * 2)) % frames : 0);
  const extent = p => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let f = 0; f < frames; f++) for (const l of layers(p, false, f)) {
      x0 = Math.min(x0, l.r.ox - l.ax); y0 = Math.min(y0, l.r.oy - l.ay - pad);
      x1 = Math.max(x1, l.r.ox - l.ax + l.r.w); y1 = Math.max(y1, l.r.oy - l.ay + l.r.h);
    }
    return [x0, y0, x1, y1];
  };
  function draw(g, p, fx, fy, t, lit) {
    const f = frameOf(p, t), dy = bob ? -(f & 1) : 0, c = canvasOf(...extent(p));
    for (const l of layers(p, !!lit, f)) {
      const { r } = l, bx = r.ox - l.ax, by = r.oy - l.ay + dy;
      for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) {
        const k = (j * r.w + i) * 4;
        if (r.data[k + 3]) c.set(bx + i, by + j, [r.data[k], r.data[k + 1], r.data[k + 2]], r.data[k + 3]);
      }
    }
    c.flush(g, fx, fy);
  }
  return { name, frames, extent, draw, anchors };
}
export const pick = (arr, v) => arr[Math.abs(v | 0) % arr.length];
