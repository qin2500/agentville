// Shared pixel helpers for the PA2 props (bush, rock, hedge). Engine scale: view = ((dx - dy), (dx + dy) / 2 - z).
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = rgb('#2a1c4a'), WARM = rgb('#fff0b0'), OUTLINE = rgb('#1d1233');
export const dk = (c, k) => mix(c, SHADE, k);
export const lt = (c, k) => mix(c, WARM, k);
export const jit = (c, n) => (n > 0 ? lt(c, n) : dk(c, -n));
/** 5-tone ramp: [deep shadow, shadow, base, light, highlight]. */
export const ramp = c => { c = typeof c === 'string' ? rgb(c) : c; return [dk(c, 0.5), dk(c, 0.25), c, lt(c, 0.2), lt(c, 0.42)]; };
export const rgbOf = rgb;
export const h2 = (a, b, seed = 0) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(seed | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };

export class Surf {
  constructor(ext) {
    this.x0 = ext[0]; this.y0 = ext[1]; this.w = ext[2] - ext[0]; this.h = ext[3] - ext[1];
    this.d = new Uint8ClampedArray(this.w * this.h * 4);
  }
  set(x, y, c) {
    x = Math.round(x) - this.x0; y = Math.round(y) - this.y0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = 255;
  }
  P(wx, wy, z = 0) { return [wx - wy, (wx + wy) / 2 - z]; }
  poly(pts, c) {
    let y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const n = pts.length, fn = typeof c === 'function';
    for (let y = Math.ceil(y0 - 0.5); y <= Math.floor(y1 - 0.5); y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k] - 0.5); x <= Math.ceil(xs[k + 1] - 0.5) - 1; x++) {
          const col = fn ? c(x, y) : c;
          if (col) this.set(x, y, col);
        }
      }
    }
  }
  wpoly(pts, c) { this.poly(pts.map(p => this.P(p[0], p[1], p[2])), c); }
  ell(cx, cy, rx, ry, c) {
    const fn = typeof c === 'function';
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
      if (u * u + v * v > 1) continue;
      const col = fn ? c(x, y, u, v) : c;
      if (col) this.set(x, y, col);
    }
  }
  /** Iso box: +y face (lit), +x face (shade), top. tex(face, x, y, base) -> colour. */
  box(x0, y0, x1, y1, z0, z1, R, tex) {
    const fc = (f, base) => (tex ? (x, y) => tex(f, x, y, base) : base);
    this.wpoly([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], fc('l', R[2]));
    this.wpoly([[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]], fc('r', R[1]));
    this.wpoly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], fc('t', R[3]));
  }
  alpha(x, y) {
    x -= this.x0; y -= this.y0;
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.d[(y * this.w + x) * 4 + 3] > 0;
  }
  /** Tinted 1px outline around the silhouette (stays inside the surface). */
  outline() {
    const { w, h, d } = this, add = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3]) continue;
      let best = -1, lum = 1e9;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const i = (ny * w + nx) * 4;
        if (!d[i + 3]) continue;
        const l = d[i] + d[i + 1] + d[i + 2];
        if (l < lum) { lum = l; best = i; }
      }
      if (best >= 0) add.push([x, y, mix(OUTLINE, [d[best], d[best + 1], d[best + 2]], 0.22)]);
    }
    for (const [x, y, c] of add) { const i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
  }
  /** Blit to g with the foot point at (fx, fy). */
  blit(g, fx, fy) {
    const img = typeof g.createImageData === 'function' ? g.createImageData(this.w, this.h) : { data: new Uint8ClampedArray(this.w * this.h * 4), width: this.w, height: this.h };
    img.data.set(this.d);
    g.putImageData(img, Math.round(fx) + this.x0, Math.round(fy) + this.y0);
  }
}
