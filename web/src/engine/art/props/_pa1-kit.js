// Shared pixel helpers for the PA1 tree props (tree, pine, sapling). Original art, same style rules as the classic
// props-art.js: 5-tone ramps (shadows toward indigo, highlights toward warm yellow), light from the front left, a 1px
// outline tinted by the colour it outlines. Pure and deterministic; no canvas needed until flush().
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = rgb('#2a1c4a'), WARM = rgb('#fff0b0'), OUTLINE = rgb('#1d1233');
export const dk = (c, k) => mix(c, SHADE, k);
export const lt = (c, k) => mix(c, WARM, k);
/** 5-tone ramp: [deep shadow, shadow, base, light, highlight]. */
export const ramp = c => { c = typeof c === 'string' ? rgb(c) : c; return [dk(c, 0.5), dk(c, 0.26), c, lt(c, 0.2), lt(c, 0.42)]; };
export const hash = (a, b, s = 0) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(s | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };

export class Buf {
  /** Covers view px [x0,x1) x [y0,y1) relative to the foot point. */
  constructor(x0, y0, x1, y1) { this.x0 = x0; this.y0 = y0; this.w = x1 - x0; this.h = y1 - y0; this.d = new Uint8ClampedArray(this.w * this.h * 4); }
  set(x, y, c, a = 255) {
    x = Math.round(x) - this.x0; y = Math.round(y) - this.y0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, d = this.d;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
  }
  has(x, y) { x -= this.x0; y -= this.y0; return x >= 0 && y >= 0 && x < this.w && y < this.h && this.d[(y * this.w + x) * 4 + 3] > 0; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  /** Union of discs [cx, cy, rx, ry]: each pixel takes colour fn(x, y, u, v, ballIndex) from the best-lit disc (highest l). */
  blobs(list, fn) {
    const seen = new Map();
    list.forEach(([cx, cy, rx, ry], bi) => {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry, q = u * u + v * v;
        if (q > 1) continue;
        const l = -0.5 * u - 0.55 * v + 0.55 * Math.sqrt(1 - q), k = x + ',' + y, o = seen.get(k);
        if (!o || l > o.l) seen.set(k, { x, y, u, v, l, bi });
      }
    });
    for (const s of seen.values()) { const c = fn(s.x, s.y, s.u, s.v, s.bi, s.l); if (c) this.set(s.x, s.y, c); }
  }
  /** Tinted 1px outline around the silhouette (4-neighbourhood). */
  outline() {
    const { w, h, d } = this, add = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3]) continue;
      let best = -1, lum = 1e9;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const i = (ny * w + nx) * 4;
        if (d[i + 3] !== 255) continue;
        const l = d[i] + d[i + 1] + d[i + 2];
        if (l < lum) { lum = l; best = i; }
      }
      if (best >= 0) add.push([x, y, mix(OUTLINE, [d[best], d[best + 1], d[best + 2]], 0.22)]);
    }
    for (const [x, y, c] of add) { const i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
  }
  /** Soft ground shadow (translucent) under everything already drawn: only fills empty pixels. */
  shadow(cx, cy, rx, ry) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
      if (u * u + v * v <= 1 && !this.has(x, y)) this.set(x, y, SHADE, u * u + v * v < 0.45 ? 96 : 56);
    }
  }
  /** Write into any canvas-like with createImageData/putImageData (foot point fx, fy). */
  flush(g, fx, fy) {
    const img = g.createImageData(this.w, this.h);
    img.data.set(this.d);
    g.putImageData(img, Math.round(fx) + this.x0, Math.round(fy) + this.y0);
  }
}
