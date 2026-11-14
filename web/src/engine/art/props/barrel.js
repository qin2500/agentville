// Prop art: oak barrel, wood staves with two iron hoops. v: 0 plain, 1 open (water), 2 lidded, 3 apples.
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

export const name = 'barrel';
export const frames = 1;
export function extent() { return [-12, -22, 12, 10]; }

const WOODS = [ramp('#9a6a40'), ramp('#b07a48'), ramp('#8a5e3a'), ramp('#a87848')];
const IRON = ramp('#3d4150'), WATER = [rgb('#2d5b93'), rgb('#3f78b0'), rgb('#5aa0d6'), rgb('#8cc8ec'), rgb('#e0f6fc')], APPLE = ramp('#c8503e');

export function draw(g, p, fx, fy) {
  const v = ((p && p.v) | 0) % 4, s = new Surf(), R = WOODS[v];
  const top = -13, bot = -1; // body rows (view y), top ellipse centred at `top`
  const hw = y => 5.4 + 1.6 * Math.sin(Math.PI * (y - top) / (bot - top)); // bulge
  for (let y = top; y <= bot + 2; y++) {
    const t = Math.min(bot, y), w = hw(t) - (y > bot ? (y - bot) * 1.2 : 0);
    for (let x = Math.ceil(-w); x <= Math.floor(w - 0.5); x++) {
      const u = (x + 0.5) / w, stave = Math.floor((u + 1) * 4.5);
      let tone = u < -0.55 ? 3 : u < 0.05 ? 2 : u < 0.6 ? 1 : 0;
      let c = R[tone];
      if (Math.floor((u + 1) * 4.5 * 2) % 2 === 1 && Math.abs(u) < 0.95) c = R[Math.max(0, tone - 1)]; // stave seams
      if ((hh(stave, y >> 2) & 7) === 0 && (y & 1)) c = R[Math.min(4, tone + 1)];
      if (y === top + 3 || y === top + 4 || y === bot - 3 || y === bot - 2) c = IRON[u < -0.3 ? 3 : u < 0.4 ? 2 : 1];
      if (y === top + 3 && u < -0.3) c = IRON[4];
      s.set(x, y, c);
    }
  }
  // top ellipse
  const rx = hw(top) - 0.2, ry = 3.2;
  s.ell(0, top, rx, ry, (x, y, u, w) => {
    if (u * u + w * w > 0.72) return IRON[u < 0 ? 3 : 2]; // rim hoop
    if (v === 1) return WATER[w < -0.2 ? 3 : 2];
    if (v === 3) return ((x + y) & 1) ? APPLE[2] : (hh(x, y) & 3) === 0 ? APPLE[4] : APPLE[1];
    const plank = (x + 9) % 4 === 0 ? 0 : (u < -0.3 ? 3 : 2);
    return R[v === 2 ? plank + 0 : Math.max(0, plank - 1)];
  });
  if (v === 1) { s.set(-2, top - 1, WATER[4]); s.set(-1, top - 1, WATER[4]); }
  if (v === 2) { s.rect(-1, top - 1, 3, 1, IRON[3]); s.set(0, top - 2, IRON[4]); }
  // ground contact shade
  s.finish().blit(g, fx, fy);
}
