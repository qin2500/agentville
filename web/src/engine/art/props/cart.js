// Prop art: wooden hand cart (two wheels, handles), v picks load: 0 empty, 1 hay, 2 sacks, 3 crates.
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

export const name = 'cart';
export const frames = 1;
export function extent() { return [-30, -36, 34, 14]; }

const WOOD = [ramp('#9a6a40'), ramp('#8a5e3a'), ramp('#a87848'), ramp('#7f5636')];
const WOOD_D = ramp('#5a3a28'), IRON = ramp('#3d4150'), STRAW = ramp('#dcba5a'), SACK = ramp('#d9c9a0'), CRATE = ramp('#b07a48');

export function draw(g, p, fx, fy) {
  const v = ((p && p.v) | 0) % 4, s = new Surf(), R = WOOD[(((p && p.v) | 0) >> 2) % 4];
  const grain = (f, x, y, base) => ((hh(x, y >> 1) & 7) === 0 ? dk(base, 0.18) : (f === 'l' && (y & 3) === 0 ? dk(base, 0.1) : base));
  // far wheel (behind the bed) and far handle
  const wheel = (wx, wy, front) => {
    const [cx, cy] = P(wx, wy, 6);
    s.ell(cx, cy, 5, 6, (x, y, u, w) => (u * u + w * w > 0.55 ? IRON[front ? 2 : 1] : null));
    s.ell(cx, cy, 3.4, 4.4, (x, y, u, w) => (u * u + w * w > 0.7 ? WOOD_D[front ? 3 : 2] : (Math.abs(u) < 0.2 || Math.abs(w) < 0.2 || Math.abs(Math.abs(u) - Math.abs(w)) < 0.2 ? R[front ? 3 : 1] : R[front ? 2 : 0])));
    s.ell(cx, cy, 1, 1.2, IRON[front ? 4 : 2]);
  };
  s.line(P(-8, -6, 4), P(-8, -6, 0), WOOD_D[1]);
  wheel(-1, -7, false);
  const pole = (wy, c) => { for (let i = 0; i <= 12; i++) { const wx = 8 + i, z = 9 - i * 0.6; const [x, y] = P(wx, wy, z); s.set(x, y, c[i % 3 ? 2 : 3]); s.set(x, y + 1, c[1]); } };
  pole(-4, WOOD_D);
  // bed: floor plank block, then four board walls
  s.box(-9, -7, 9, 7, 6, 8, R, grain);
  const wall = (pts, base, f) => s.wpoly(pts, (x, y) => grain(f, x, y, base));
  wall([[-9, -7, 8], [9, -7, 8], [9, -7, 11], [-9, -7, 11]], R[1], 'r'); // back wall (inside faces show above)
  wall([[-9, -7, 8], [-9, 7, 8], [-9, 7, 11], [-9, -7, 11]], R[0], 'r');
  // load, drawn inside the bed before the front walls
  if (v === 0) s.wpoly([[-9, -7, 8], [9, -7, 8], [9, 7, 8], [-9, 7, 8]], (x, y) => ((x + y) & 1 ? R[0] : dk(R[1], 0.15)));
  if (v === 1) {
    const [cx, cy] = P(0, 0, 12);
    s.ell(cx, cy - 1, 11, 7, (x, y, u, w) => { const l = -0.4 * u - 0.7 * w, n = hh(x, y); return STRAW[TONE((l > 0.3 ? 4 : l > 0 ? 3 : l > -0.35 ? 2 : 1) + ((n & 7) === 0 ? 1 : (n & 7) === 1 ? -1 : 0))]; });
    for (let i = 0; i < 7; i++) { const a = hh(i, 3), x = cx - 8 + (a % 17), y = cy - 8 + (a >> 5) % 5; s.set(x, y, STRAW[4]); s.set(x + 1, y - 1, STRAW[3]); }
  }
  if (v === 2) {
    const sack = (wx, wy, z, k) => {
      const [cx, cy] = P(wx, wy, z);
      s.ell(cx, cy, 5, 5, (x, y, u, w) => { const l = -0.5 * u - 0.55 * w + 0.4; return SACK[l > 0.75 ? 4 : l > 0.35 ? 3 : l > -0.1 ? 2 : l > -0.5 ? 1 : 0]; });
      s.rect(cx - 1, cy - 6, 3, 2, SACK[k ? 3 : 2]); s.set(cx, cy - 4, WOOD_D[2]); s.set(cx + 1, cy - 4, WOOD_D[2]);
    };
    sack(-4, -2, 11, 0); sack(4, -2, 11, 1); sack(0, 4, 10, 1); sack(-1, 0, 15, 0);
  }
  if (v === 3) {
    const cr = (wx, wy, z, z2) => s.box(wx - 4, wy - 4, wx + 4, wy + 4, z, z2, CRATE, (f, x, y, b) => ((y & 3) === 0 ? dk(b, 0.2) : b));
    cr(-4, -2, 8, 15); cr(5, -2, 8, 14); cr(0, 3, 8, 13);
  }
  // front walls (near sides) and iron rim
  wall([[9, 7, 8], [9, -7, 8], [9, -7, 11], [9, 7, 11]], R[1], 'r');
  wall([[-9, 7, 8], [9, 7, 8], [9, 7, 11], [-9, 7, 11]], R[2], 'l');
  const t1 = P(-9, 7, 13), t2 = P(9, 7, 13), t3 = P(9, -7, 13);
  s.line(t1, t2, R[4]); s.line(t2, t3, R[3]);
  const b1 = P(-9, 7, 8), b2 = P(9, 7, 8); s.line(b1, b2, R[0]);
  for (const wx of [-9, 0, 9]) { const a = P(wx, 7, 8), b = P(wx, 7, 13); s.line(a, b, IRON[2]); }
  // near wheel and near handle
  wheel(-1, 8, true);
  pole(4, WOOD_D);
  s.finish().blit(g, fx, fy);
}
