// Prop art: plank crate. v: 0 plain, 1 open with apples, 2 darker with rope, 3 lid ajar.
// Original pixel art (PA3). Tiny pixel-buffer kit: flat faces rasterised with exact pixel rules, 5-tone ramps
// (shadow toward indigo, highlight toward warm yellow), light from the front left, 1px tinted outline.
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = rgb('#2a1c4a'), WARM = rgb('#fff0b0'), OUTL = rgb('#1d1233');
const dk = (c, k) => mix(c, SHADE, k), lt = (c, k) => mix(c, WARM, k);
const ramp = c => { c = typeof c === 'string' ? rgb(c) : c; return [dk(c, 0.5), dk(c, 0.25), c, lt(c, 0.2), lt(c, 0.42)]; };
const hh = (a, b) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
const W = 72, H = 72, OX = 36, OY = 52;
const P = (wx, wy, z = 0) => [(wx - wy), (wx + wy) * 0.5 - z];
class Surf {
  constructor() { this.d = new Uint8ClampedArray(W * H * 4); }
  set(x, y, c) {
    x = Math.round(x) + OX; y = Math.round(y) + OY;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4; this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = 255;
  }
  get(x, y) { x += OX; y += OY; if (x < 0 || y < 0 || x >= W || y >= H) return null; const i = (y * W + x) * 4; return this.d[i + 3] ? [this.d[i], this.d[i + 1], this.d[i + 2]] : null; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  poly(pts, c) {
    let y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const n = pts.length, fn = typeof c === 'function';
    for (let y = Math.ceil(y0 - 0.5); y <= Math.floor(y1 - 0.5); y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0])); }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x <= Math.ceil(xs[k + 1] - 0.5) - 1; x++) { const col = fn ? c(x, y) : c; if (col) this.set(x, y, col); }
    }
  }
  wpoly(pts, c) { this.poly(pts.map(p => P(p[0], p[1], p[2])), c); }
  ell(cx, cy, rx, ry, c) {
    const fn = typeof c === 'function';
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
      if (u * u + v * v > 1) continue;
      const col = fn ? c(x, y, u, v) : c; if (col) this.set(x, y, col);
    }
  }
  /** Iso box; faces +y (lit, 'l'), +x (shade, 'r'), top 't'. tex(face, x, y, base) -> colour. */
  box(x0, y0, x1, y1, z0, z1, R, tex) {
    const fc = (f, base) => (tex ? (x, y) => tex(f, x, y, base) : base);
    this.wpoly([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], fc('l', R[2]));
    this.wpoly([[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]], fc('r', R[1]));
    this.wpoly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], fc('t', R[3]));
  }
  line(a, b, c) {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) | 0 || 1;
    for (let i = 0; i <= n; i++) this.set(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, c);
  }
  /** 1px outline in a darkened tint of the neighbouring colour, then crop to the opaque bounds. */
  finish() {
    const add = [];
    for (let y = -OY - 1; y < H - OY + 1; y++) for (let x = -OX - 1; x < W - OX + 1; x++) {
      if (this.get(x, y)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = this.get(x + dx, y + dy); if (n) { add.push([x, y, mix(n, OUTL, 0.7)]); break; } }
    }
    for (const [x, y, c] of add) this.set(x, y, c);
    return this;
  }
  blit(g, fx, fy) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (this.d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, im = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = ((y + y0) * W + x + x0) * 4, o = (y * w + x) * 4; for (let k = 0; k < 4; k++) im.data[o + k] = this.d[s + k]; }
    g.putImageData(im, fx + x0 - OX, fy + y0 - OY);
  }
}
const TONE = c => Math.max(0, Math.min(4, c));

export const name = 'crate';
export const frames = 1;
export function extent() { return [-14, -20, 14, 10]; }

const WOODS = [ramp('#b07a48'), ramp('#c08c58'), ramp('#8a5e3a'), ramp('#a87848')];
const DARK = ramp('#5a3a28'), APPLE = ramp('#c8503e'), LEAF = ramp('#5b9a3c'), ROPE = ramp('#d9c9a0');

export function draw(g, p, fx, fy) {
  const v = ((p && p.v) | 0) % 4, s = new Surf(), R = WOODS[v];
  const a = 4, z = 7;
  const tex = (f, x, y, base) => {
    if (f === 't') return v === 1 ? DARK[1] : ((x - y) & 3) === 0 ? dk(base, 0.25) : base;
    const k = (y & 3) === 3 ? dk(base, 0.3) : base; // plank seams (horizontal)
    return (hh(x >> 1, y >> 2) & 15) === 0 ? lt(k, 0.15) : k;
  };
  s.box(-a, -a, a, a, 0, z, R, tex);
  if (v === 1) { // open: inner rim + apples
    s.ell(0, P(0, 0, z)[1], 5, 3, (x, y, u, w) => ((x * 3 + y) & 3) === 0 ? APPLE[4] : (hh(x, y) & 1) ? APPLE[2] : APPLE[1]);
    s.set(-1, P(0, 0, z)[1] - 2, LEAF[3]); s.set(1, P(0, 0, z)[1] - 1, LEAF[2]);
  }
  // corner posts and cross brace on the lit face
  const post = (wx, wy, c) => s.line(P(wx, wy, 0), P(wx, wy, z), c);
  post(-a, a, R[4]); post(a, a, R[0]); post(a, -a, R[0]);
  const L = P(-a, a, 1), Rr = P(a, a, z - 1); // diagonal brace across the +y face
  s.line([L[0] + 1, L[1]], [Rr[0] - 1, Rr[1]], dk(R[2], 0.35));
  const top1 = P(-a, a, z), top2 = P(a, a, z), top3 = P(a, -a, z);
  s.line(top1, top2, R[4]); s.line(top2, top3, R[3]);
  if (v === 2) { const r0 = P(-a, a, 3), r1 = P(a, a, 3); s.line(r0, r1, ROPE[2]); s.set(r1[0], r1[1] + 1, ROPE[1]); s.set(r1[0] - 1, r1[1] + 2, ROPE[3]); }
  if (v === 3) { // lid plank slid aside
    s.wpoly([[-a - 1, -a + 3, z + 2], [a + 1, -a + 3, z + 2], [a + 1, -a + 7, z + 2], [-a - 1, -a + 7, z + 2]], R[3]);
    s.line(P(-a - 1, -a + 7, z + 2), P(a + 1, -a + 7, z + 2), R[4]);
  }
  s.finish().blit(g, fx, fy);
}
