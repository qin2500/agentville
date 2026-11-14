// Shared pixel kit for the waterside props (pier, bollard, skiff). Original; local copy of the railing kit plus helpers.
// ---- tiny pixel kit (local copy; coordinates are view px relative to the foot point) ----
export const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
export const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = hex('#2a1c4a'), WARM = hex('#fff0b0');
export const dk = (c, k) => mix(c, SHADE, k), lt = (c, k) => mix(c, WARM, k);
/** 5-tone ramp: deep shadow, shadow, base, light, highlight. */
export const ramp = c => { c = typeof c === 'string' ? hex(c) : c; return [dk(c, 0.5), dk(c, 0.25), c, lt(c, 0.2), lt(c, 0.42)]; };
export function canvasOf(x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, d = new Uint8ClampedArray(w * h * 4);
  return {
    w, h, d,
    set(x, y, c, a = 255) {
      x = Math.round(x) - x0; y = Math.round(y) - y0;
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
    },
    get(x, y) { x = Math.round(x) - x0; y = Math.round(y) - y0; return x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 0; },
    rect(x, y, rw, rh, c, a = 255) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) this.set(x + i, y + j, c, a); },
    /** 1px outline (tinted by the neighbour it touches, never flat black) around everything drawn so far. */
    outline(tint = 0.65) {
      const src = d.slice(), put = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (src[(y * w + x) * 4 + 3]) continue;
        for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + ax, ny = y + ay;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = (ny * w + nx) * 4;
          if (src[j + 3] === 255) { put.push([x, y, dk([src[j], src[j + 1], src[j + 2]], tint)]); break; }
        }
      }
      for (const [x, y, c] of put) this.set(x + x0, y + y0, c);
    },
    flush(g, fx, fy) {
      if (typeof g.createImageData === 'function' && typeof g.putImageData === 'function') {
        const img = g.createImageData(w, h);
        for (let i = 0; i < d.length; i++) img.data[i] = Math.round(d[i]);
        g.putImageData(img, fx + x0, fy + y0);
        return;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!d[i + 3]) continue;
        g.fillStyle = `rgb(${Math.round(d[i])},${Math.round(d[i + 1])},${Math.round(d[i + 2])})`;
        g.fillRect(fx + x0 + x, fy + y0 + y, 1, 1);
      }
    },
  };
}
export const hash = (a, b, s = 0) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(s | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
/** View point of world px (wx, wy) at height z about the foot point (tile centre): 16 world px per tile. */
export const view = (wx, wy, z = 0) => [Math.round(wx - wy), Math.round((wx + wy) / 2 - z)];
/** Bounding extent of world-space boxes [wx0, wy0, wx1, wy1, z0, z1], padded by 2. */
export function boxExtent(boxes) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [ax, ay, bx, by, z0, z1] of boxes) for (const wx of [ax, bx]) for (const wy of [ay, by]) for (const z of [z0, z1]) {
    const [x, y] = view(wx, wy, z); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return [x0 - 2, y0 - 2, x1 + 3, y1 + 3];
}
