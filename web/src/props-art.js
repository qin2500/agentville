// Procedural pixel-art props for the isometric village (original art, drawn in code, cached canvases).
//
//   const art = createPropArt();
//   art.draw(ctx, { kind, v, dir, len }, x, y, t, night, style);  // (x, y) = foot point in VIEW px
//   art.extent({ kind, v, dir, len }, style) -> [sx0, sy0, sx1, sy1] relative to the foot point
//
// Every prop is modelled with a few flat faces (iso boxes, ellipse cylinders, domes) rasterised onto a
// tiny RGBA pixel buffer with exact pixel rules, so it is crisp at every integer zoom. Colours follow
// iso.js: 5-tone ramps, shadows toward indigo, highlights toward warm yellow, light from the front left,
// and a 1px outline tinted by the colour it outlines (never flat black). A world vector (dx, dy) in px
// maps to view ((dx - dy) * 0.8, (dx + dy) * 0.4); one tile is 16 world px; z is view px upward.
//
// Foot-point conventions: fountain = centre of its 2x2; stall = centre of its 2x1 (long side along x);
// fence = centre of the FIRST tile, running +x or +y for `len` tiles (posts on the tile borders, so
// neighbouring runs join); bridge = centre of its WATER tile, deck running along `dir`; the rest stand
// on their own centre.
const ISO = 0.8;

// ---------- colour ----------
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = rgb('#2a1c4a'), WARM = rgb('#fff0b0'), OUTLINE = rgb('#1d1233');
const dk = (c, k) => mix(c, SHADE, k), lt = (c, k) => mix(c, WARM, k);
const jit = (c, n) => (n > 0 ? lt(c, n) : dk(c, -n));
/** A 5-tone ramp: [deep shadow, shadow, base, light, highlight]. */
const ramp = c => { c = typeof c === 'string' ? rgb(c) : c; return [dk(c, 0.5), dk(c, 0.25), c, lt(c, 0.2), lt(c, 0.42)]; };
const h2 = (a, b, seed = 0) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(seed | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
const fr = x => x - Math.floor(x);

const STONE = ramp('#a39a8c'), STONE_W = ramp('#b3a590'), MARBLE = ramp('#cfc9bb'), SLATE = ramp('#7c8290');
const WOOD = ramp('#9a6a40'), WOOD_D = ramp('#6a4630'), WOOD_L = ramp('#c08c58'), PLANK = ramp('#b07a48');
const IRON = ramp('#3d4150'), STRAW = ramp('#dcba5a'), LEAF = ramp('#5b9a3c'), LEAF_D = ramp('#3f7a3a');
const SOIL = ramp('#7a5236'), CLOTH = ramp('#efe3c6'), WATER = [rgb('#2d5b93'), rgb('#3f78b0'), rgb('#5aa0d6'), rgb('#8cc8ec'), rgb('#e0f6fc')];
const GLASS = ramp('#3d5687'), LIT = [rgb('#c9702c'), rgb('#f0a346'), rgb('#ffcd68'), rgb('#ffe7a0'), rgb('#fff8dc')];
const AWNINGS = ['#c8503e', '#d8892f', '#e0b43e', '#b4604e', '#c9728a', '#7aa05a'].map(ramp);
// Optional per-project style (styles-pool.js): style.accent tints awnings, noticeboard roofs and maypole
// ribbons (mixed with the per-prop variety), style.lamp picks the lamp post look. Only these kinds read it.
const STYLED = new Set(['stall', 'maypole', 'lamppost', 'noticeboard']);
const sty = p => (p && p.style && typeof p.style === 'object' ? p.style : null);
const accentOf = p => { const s = sty(p); return s && typeof s.accent === 'string' && /^#[0-9a-f]{6}$/i.test(s.accent) ? rgb(s.accent) : null; };
const BLOOMS = [rgb('#ec5f74'), rgb('#f5cf4f'), rgb('#ef93cc'), rgb('#fbf6ea'), rgb('#9f7ff0'), rgb('#f0944a')];
const RIBBONS = ['#e0525e', '#f2c64a', '#4f9ad6', '#7cc25a', '#ef93cc', '#f0944a'].map(rgb);

// ---------- pixel surface ----------
class Surf {
  /** w x h px; (ox, oy) = where the foot point sits inside the buffer. */
  constructor(w, h, ox, oy) { this.w = w; this.h = h; this.ox = ox; this.oy = oy; this.d = new Uint8ClampedArray(w * h * 4); }
  set(x, y, c, a = 255) {
    x = Math.round(x) + this.ox; y = Math.round(y) + this.oy;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, d = this.d;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
  }
  has(x, y) { x += this.ox; y += this.oy; return x >= 0 && y >= 0 && x < this.w && y < this.h && this.d[(y * this.w + x) * 4 + 3] > 0; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  /** View point (relative to the foot) of world (wx, wy) at height z. */
  P(wx, wy, z = 0) { return [(wx - wy) * ISO, (wx + wy) * ISO / 2 - z]; }
  /** Fill a polygon of view points; pixel centres decide. `c` is a colour or fn(x, y) -> colour | null. */
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
  /** Polygon from world points [wx, wy, z]. */
  wpoly(pts, c) { this.poly(pts.map(p => this.P(p[0], p[1], p[2])), c); }
  /** Filled ellipse around view (cx, cy); `c` colour or fn(x, y, u, v) with u, v in -1..1. */
  ell(cx, cy, rx, ry, c) {
    const fn = typeof c === 'function';
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
      if (u * u + v * v > 1) continue;
      const col = fn ? c(x, y, u, v) : c;
      if (col) this.set(x, y, col);
    }
  }
  /** Shaded ball of view radius r. */
  ball(cx, cy, r, R) {
    this.ell(cx, cy, r, r, (x, y, u, v) => {
      const nz = Math.sqrt(Math.max(0, 1 - u * u - v * v)), l = -0.5 * u - 0.55 * v + 0.55 * nz;
      return R[l > 0.72 ? 4 : l > 0.45 ? 3 : l > 0.12 ? 2 : l > -0.25 ? 1 : 0];
    });
  }
  /**
   * Iso box. Visible faces: +y (lit), +x (half shade) and the top. Options: tex(face, x, y, c) -> colour,
   * top (colour override), cap (draw top only).
   */
  box(x0, y0, x1, y1, z0, z1, R, o = {}) {
    const tx = o.tex, fc = (f, base) => (tx ? (x, y) => tx(f, x, y, base) : base);
    if (!o.cap) {
      this.wpoly([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], fc('l', R[2]));
      this.wpoly([[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]], fc('r', R[1]));
    }
    this.wpoly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], o.top ? o.top : fc('t', R[3]));
  }
  /** Upright cylinder around world (cx, cy), radius r (world px), z0..z1. tex(x, y, c, u) -> colour. */
  cyl(cx, cy, r, z0, z1, R, o = {}) {
    const [vx, vt] = this.P(cx, cy, z1), vb = this.P(cx, cy, z0)[1], rx = r * ISO * Math.SQRT2, ry = r * ISO * Math.SQRT1_2;
    const top = o.top || R[3];
    for (let y = Math.floor(vt - ry); y <= Math.ceil(vb + ry); y++) for (let x = Math.floor(vx - rx); x <= Math.ceil(vx + rx); x++) {
      const u = (x + 0.5 - vx) / rx, yc = y + 0.5;
      if (Math.abs(u) > 1) continue;
      const e = ry * Math.sqrt(1 - u * u), inTop = yc >= vt - e && yc <= vt + e, inSide = yc > vt && yc <= vb + e;
      if (!inTop && !inSide) continue;
      if (inTop) { const w = typeof top === 'function' ? top(x, y, u, (yc - vt) / ry) : top; if (w) this.set(x, y, w); continue; }
      let c = R[u < -0.55 ? 3 : u < 0.05 ? 2 : u < 0.62 ? 1 : 0];
      if (o.tex) c = o.tex(x, y, c, u);
      this.set(x, y, c);
    }
  }
  /** Pixel-art dome / cone body: ellipse slices from the bottom up. fn(x, y, u, k) with k = height share. */
  dome(cx, cy, z0, r, H, pw, fn) {
    for (let z = 0; z <= H; z++) {
      const k = z / H, rr = r * Math.pow(Math.max(0, 1 - Math.pow(k, pw)), 1 / pw);
      if (rr < 0.4) break;
      const [vx, vy] = this.P(cx, cy, z0 + z);
      this.ell(vx, vy, rr * ISO * Math.SQRT2, rr * ISO * Math.SQRT1_2, (x, y, u, v) => fn(x, y, u, k, v));
    }
  }
  line(x0, y0, x1, y1, c) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) * 2;
    for (let i = 0; i <= n; i++) this.set(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, c);
  }
  /** Tinted 1px outline around the whole silhouette. */
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
  canvas() {
    const cv = document.createElement('canvas'); cv.width = this.w; cv.height = this.h;
    cv.getContext('2d').putImageData(new ImageData(this.d, this.w, this.h), 0, 0);
    return cv;
  }
}

// ---------- shared textures ----------
/** Stone blocks: courses of `ch` px, blocks `bw` px wide, offset every other row. */
const stoneTex = (seed, ch = 3, bw = 5) => (x, y, c) => {
  const row = Math.floor(y / ch), off = (row & 1) * (bw >> 1), col = Math.floor((x + off) / bw);
  if ((((y % ch) + ch) % ch) === ch - 1) return dk(c, 0.2);
  if ((((x + off) % bw) + bw) % bw === 0) return dk(c, 0.15);
  return jit(c, (h2(col, row, seed) % 5 - 2) * 0.035);
};
const plankTex = (seed, ph = 3) => (x, y, c) => {
  const row = Math.floor(y / ph);
  if ((((y % ph) + ph) % ph) === ph - 1) return dk(c, 0.22);
  return jit(c, (h2(row, 7, seed) % 5 - 2) * 0.04 + ((h2(x, row, seed) % 11 === 0) ? -0.08 : 0));
};
const faceTex = fn => (f, x, y, c) => (f === 't' ? c : fn(x, y, c));

// ---------- the props ----------
// Each builder gets (S, p, frame, lit). World coordinates are relative to the foot point.
const B = {};

B.fountain = (S, p, f) => {
  const seed = 11;
  S.cyl(0, 0, 13.5, 0, 7, STONE, { tex: stoneTex(seed, 3, 5), top: STONE[4] });
  // inner basin: back wall in shade, water surface 2px lower, ripples moving outward
  const cy = -7, rx = 11 * ISO * Math.SQRT2, ry = 11 * ISO * Math.SQRT1_2, wy = cy + 2;
  S.ell(0, cy, rx, ry, (x, y) => {
    const u = (x + 0.5) / (rx - 0.6), v = (y + 0.5 - wy) / (ry - 0.2);
    if (u * u + v * v > 1) return STONE[1];
    const d = Math.sqrt(u * u + v * v), ring = fr(d * 2.4 - f / 4);
    if (ring < 0.16) return WATER[3];
    if (h2(x, y, f + 3) % 23 === 0) return WATER[4];
    return (x + y) & 1 && d > 0.8 ? WATER[1] : WATER[2];
  });
  // pedestal, bowl, spout
  S.cyl(0, 0, 3, 5, 14, STONE_W, { tex: stoneTex(seed, 3, 4), top: STONE_W[4] });
  S.cyl(0, 0, 6.2, 12, 15.5, STONE_W, { tex: stoneTex(seed + 1, 3, 4), top: (x, y, u, v) => (u * u + v * v > 0.62 ? STONE_W[4] : WATER[2]) });
  S.cyl(0, 0, 1.3, 15, 22, STONE_W);
  S.ball(0, -24, 2.3, STONE_W);
  // jets falling from the spout into the bowl, droplets moving with the frame
  for (const dir of [-1, 1]) for (let i = 0; i < 5; i++) {
    const t = fr((i + f / 4) / 5);
    S.set(dir * 8.5 * t, -23 + (-5 * t + 11.5 * t * t) * 1.0, WATER[t < 0.55 ? 4 : 3]);
  }
  S.set(0, -22 - (f % 2), WATER[4]);
  // overflow sheets from the bowl lip to the basin
  for (const sx of [-6, -3, 3, 6]) for (let y = -11; y < -4; y++) if ((y + f + sx) % 3 !== 0) S.set(sx, y + 3, WATER[(y + f) & 1 ? 3 : 2]);
  // splash foam where the sheets land
  for (const sx of [-7, -4, 4, 7]) { S.set(sx, -3 + (f & 1), WATER[4]); S.set(sx + 1, -3, WATER[3]); }
};

B.well = (S) => {
  S.cyl(0, 0, 7.2, 0, 9, STONE, { tex: stoneTex(5, 3, 4), top: STONE[4] });
  S.ell(0, -9, 5.6 * ISO * Math.SQRT2 - 0.5, 5.6 * ISO * Math.SQRT1_2 - 0.2, (x, y, u, v) => (v < -0.2 ? STONE[0] : WATER[0]));
  // posts, crossbeam
  for (const y of [-6.5, 6.5]) S.box(-1, y - 1, 1, y + 1, 8, 24, WOOD, { tex: faceTex(plankTex(3, 4)) });
  S.box(-1.2, -8, 1.2, 8, 22, 24.5, WOOD_D);
  // little gable roof, ridge along y
  const e = 11, zr = 33, ze = 24;
  S.wpoly([[0, -9.5, zr], [0, 9.5, zr], [-e, 9.5, ze], [-e, -9.5, ze]], WOOD_D[1]);
  S.wpoly([[-e, 9.5, ze], [e, 9.5, ze], [0, 9.5, zr]], WOOD_D[1]);
  S.wpoly([[0, -9.5, zr], [0, 9.5, zr], [e, 9.5, ze], [e, -9.5, ze]], (x, y) => ((y + (x >> 1)) % 3 === 0 ? rgb('#9d4a37') : rgb('#b95a41')));
  S.wpoly([[e, 9.5, ze], [e, 9.5, ze - 1.4], [0, 9.5, zr - 1.4], [0, 9.5, zr]], rgb('#7e3a2f'));
  // rope and bucket
  const [bx, by] = S.P(0, 0, 0);
  for (let y = -25; y < -15; y++) S.set(bx, y, rgb('#d9c08a'));
  S.cyl(0, 0, 2.2, 8, 12.5, WOOD, { top: WOOD_D[1] });
  S.set(bx, -19, IRON[2]); S.set(bx - 2, -14, IRON[1]); S.set(bx + 2, -14, IRON[1]);
};

const GOODS = [
  (S, x, y, n) => { // apples in a crate
    S.rect(x - 4, y - 2, 9, 4, WOOD[2]); S.rect(x - 4, y + 1, 9, 1, WOOD_D[1]);
    for (let i = 0; i < 5; i++) { const c = i % 3 === 2 ? rgb('#8cc04a') : rgb('#d6453d'); S.rect(x - 4 + i * 2, y - 4 - (i & 1), 2, 2, c); S.set(x - 4 + i * 2, y - 4 - (i & 1), lt(c, 0.4)); }
  },
  (S, x, y, n) => { // bread loaves
    for (let i = 0; i < 3; i++) { const c = ramp('#c98a45'); S.ell(x - 4 + i * 4, y - 2 - (i === 1 ? 1 : 0), 2.4, 1.7, (X, Y, u, v) => (v < -0.3 ? c[4] : v < 0.4 ? c[2] : c[1])); S.set(x - 5 + i * 4, y - 3 - (i === 1 ? 1 : 0), c[0]); }
    S.rect(x - 6, y, 12, 1, CLOTH[2]);
  },
  (S, x, y, n) => { // cloth bolts
    const cols = [rgb('#4f7fc4'), rgb('#c4506a'), rgb('#e9b949'), rgb('#6aa86a')];
    for (let i = 0; i < 4; i++) { const r = ramp(cols[(i + n) % 4]); S.rect(x - 5 + i * 3, y - 6 + (i & 1), 3, 6 - (i & 1), r[2]); S.rect(x - 5 + i * 3, y - 6 + (i & 1), 1, 6 - (i & 1), r[3]); S.rect(x - 5 + i * 3 + 2, y - 6 + (i & 1), 1, 6 - (i & 1), r[1]); S.set(x - 4 + i * 3, y - 6 + (i & 1), r[4]); }
  },
  (S, x, y, n) => { // pottery
    const r = ramp('#c46a42'), g = ramp('#6a9a8a');
    for (const [dx, h, c] of [[-5, 5, r], [-1, 7, g], [3, 5, r], [6, 3, g]]) {
      S.ell(x + dx, y - h / 2 - 1, 2.2, h / 2 + 0.6, (X, Y, u) => c[u < -0.3 ? 3 : u < 0.4 ? 2 : 1]);
      S.rect(x + dx - 1, y - h - 2, 3, 1, c[0]);
    }
  },
  (S, x, y, n) => { // flower buckets
    for (const dx of [-5, 0, 5]) {
      S.rect(x + dx - 2, y - 2, 4, 3, WOOD[2]); S.rect(x + dx - 2, y, 4, 1, WOOD_D[1]);
      for (let i = 0; i < 5; i++) { const c = BLOOMS[(h2(dx, i, n) >>> 3) % 6]; const px = x + dx - 2 + (i % 3) * 2 - (i > 2 ? 1 : 0), py = y - 4 - (i & 1) - (i > 2 ? 1 : 0); S.rect(px, py, 2, 2, c); S.set(px, py, lt(c, 0.4)); S.set(px + 1, py + 2, LEAF[1]); }
    }
  },
  (S, x, y, n) => { // fish on a tray of ice
    S.rect(x - 6, y - 1, 13, 3, rgb('#bcd8e2')); S.rect(x - 6, y + 1, 13, 1, rgb('#7fa4b8'));
    for (let i = 0; i < 3; i++) { const fx = x - 5 + i * 4, c = i === 1 ? rgb('#cf8f6a') : rgb('#9fb4c4'); S.rect(fx, y - 3 - (i & 1), 4, 2, c); S.set(fx, y - 3 - (i & 1), lt(c, 0.5)); S.set(fx + 3, y - 3 - (i & 1), dk(c, 0.3)); S.set(fx + 1, y - 3 - (i & 1), OUTLINE); }
  },
];

B.stall = (S, p) => {
  const v = p.v | 0, acc = accentOf(p), vi = ((v % 6) + 6) % 6;
  // with a style the awning is the region's accent, nudged toward the per-stall colour so a row still varies
  const A = acc ? ramp(mix(acc, AWNINGS[vi][2], 0.12 + (vi % 3) * 0.1)) : AWNINGS[vi], goods = GOODS[((v % 6) + 6) % 6];
  const back = -6, front = 7;
  // back shelf with small crates, then the table
  S.box(-10, back - 0.5, 10, back + 1.5, 0, 21, WOOD_D, { tex: faceTex(plankTex(2, 3)) });
  for (const x of [-11, 11]) S.box(x - 1, back - 1, x + 1, back + 1, 0, 33, WOOD, { tex: faceTex(plankTex(4, 4)) });
  S.box(-10, 0, 10, 6, 0, 9, WOOD, { tex: faceTex(plankTex(6, 3)), top: (x, y) => (((x >> 1) + (y >> 1)) & 1 ? CLOTH[3] : CLOTH[2]) });
  const [gx, gy] = S.P(0, 3, 9);
  goods(S, gx - 2, gy + 1, p.v | 0);
  const [g2x, g2y] = S.P(-7, 2, 9);
  S.rect(g2x - 1, g2y - 2, 3, 2, WOOD_L[1]); S.set(g2x - 1, g2y - 2, WOOD_L[3]);
  // front posts
  for (const x of [-11, 11]) S.box(x - 1, front - 1, x + 1, front + 1, 0, 25, WOOD, { tex: faceTex(plankTex(5, 4)) });
  // striped awning, sloping down toward the viewer, with a scalloped valance
  const n = 8, xs = i => -13 + i * (26 / n);
  for (let i = 0; i < n; i++) {
    const c = i & 1 ? CLOTH : A, a = xs(i), b = xs(i + 1);
    S.wpoly([[a, back - 1, 35], [b, back - 1, 35], [b, front + 3, 26], [a, front + 3, 26]], (x, y) => (y % 5 === 0 ? c[2] : c[3]));
    S.wpoly([[a, front + 3, 26], [b, front + 3, 26], [b, front + 3, 23], [a, front + 3, 23]], c[1]);
    const [vx, vy] = S.P((a + b) / 2, front + 3, 23);
    S.ell(vx, vy, 1.7, 1.4, (x, y, u, w) => (w < 0 ? null : c[1]));
  }
  const [rx, ry] = S.P(0, back - 1, 35); S.rect(rx - 11, ry - 1, 22, 1, A[3]);
  
};

B.fence = (S, p) => {
  const L = Math.max(1, p.len | 0 || 1) * 16, ax = p.dir === 'y' ? 'y' : 'x';
  const bx = (s0, s1, w0, w1, z0, z1, R, o) => (ax === 'x' ? S.box(s0, w0, s1, w1, z0, z1, R, o) : S.box(w0, s0, w1, s1, z0, z1, R, o));
  const tex = faceTex(plankTex(9, 3));
  for (let s = -8; s <= L - 8; s += 16) { bx(s - 1.2, s + 1.2, -1.2, 1.2, 0, 10, WOOD, { tex }); bx(s - 1.2, s + 1.2, -1.2, 1.2, 10, 11, WOOD_L, { cap: false, top: WOOD_L[3] }); }
  for (const [z0, z1] of [[2.5, 4.5], [6.5, 8.5]]) bx(-8, L - 8, 1.2, 2.3, z0, z1, PLANK, { tex: faceTex((x, y, c) => (h2(x >> 2, z0, 3) % 7 === 0 ? dk(c, 0.15) : c)) });
};

B.haystack = (S, p) => {
  const n = p.v | 0;
  S.dome(0, 0, 0, 9, 17, 2.2, (x, y, u, k) => {
    const c = STRAW[u < -0.45 ? 3 : u < 0.1 ? 2 : u < 0.6 ? 1 : 0], hh = h2(x, (y >> 1), 4 + n);
    if (k > 0.35 && k < 0.42) return STRAW[0];
    return hh % 6 === 0 ? dk(c, 0.22) : hh % 9 === 1 ? lt(c, 0.25) : c;
  });
  S.ell(0, -17, 1.4, 0.8, STRAW[4]); S.rect(-1, -19, 1, 2, STRAW[3]); S.rect(1, -18, 1, 1, STRAW[2]);
  for (let i = 0; i < 5; i++) S.set(-8 + h2(i, n, 1) % 17, 4 + (i & 1), STRAW[3]);
};

B.woodpile = (S, p) => {
  const n = p.v | 0;
  // logs lie along y, so their cut ends face the viewer's left; the side shows bark
  S.box(-8, -5, 8, 5, 0, 9, WOOD_D, { tex: (f, x, y, c) => (f === 'r' ? ((y + 9) % 3 === 0 ? dk(c, 0.3) : jit(c, (h2(x, y >> 1, 2) % 5 - 2) * 0.05)) : f === 't' ? ((x + y * 2) % 4 === 0 ? dk(c, 0.2) : c) : c) });
  const [fx0, fy0] = S.P(-8, 5, 0);
  for (let row = 0; row < 3; row++) for (let i = 0; i < (row & 1 ? 5 : 6); i++) {
    const cx = fx0 + 1.5 + i * 2.7 + (row & 1) * 1.4, cy = fy0 + 4.5 - row * 2.8 + (cx - fx0) * 0.0;
    const y = cy + (cx - fx0) * 0.5 - 6 + 1;
    S.ell(cx, y, 1.6, 1.6, (X, Y, u, v) => (u * u + v * v > 0.5 ? rgb('#7a5236') : (h2(i, row, n) % 4 === 0 ? rgb('#e0b878') : rgb('#d9a866'))));
  }
  // chopping stump with an axe
  S.cyl(11, 4, 3.2, 0, 4, WOOD, { tex: plankTex(1, 5), top: rgb('#d9a866') });
  const [ax, ay] = S.P(11, 4, 4); S.line(ax - 1, ay - 5, ax + 1, ay - 1, WOOD_D[2]); S.rect(ax - 3, ay - 5, 3, 2, SLATE[3]); S.set(ax - 3, ay - 5, SLATE[4]);
};

B.bench = (S) => {
  for (const x of [-6.5, 6.5]) { S.box(x - 0.9, -2.2, x + 0.9, 2.2, 0, 5.5, IRON); S.box(x - 0.9, -3, x + 0.9, -2, 0, 12, IRON); }
  S.box(-9, -3.4, 9, -2.6, 7, 9.5, PLANK, { tex: faceTex(plankTex(2, 2)) });
  S.box(-9, -3.4, 9, -2.6, 10.5, 13, PLANK, { tex: faceTex(plankTex(3, 2)) });
  S.box(-9, -2.6, 9, 0, 5.5, 6.7, WOOD_L);
  S.box(-9, 0, 9, 2.6, 5.5, 6.7, WOOD_L);
  S.box(-9, 2.6, 9, 3.2, 5.2, 6.7, PLANK);
  for (const x of [-6.5, 6.5]) S.box(x - 0.9, 2, x + 0.9, 3, 0, 5.5, IRON);
};

B.statue = (S, p) => {
  const v = p.v | 0;
  S.box(-6.5, -6.5, 6.5, 6.5, 0, 3, STONE, { tex: faceTex(stoneTex(7, 3, 6)) });
  S.box(-5, -5, 5, 5, 3, 11, STONE_W, { tex: faceTex(stoneTex(8, 4, 5)) });
  S.box(-5.8, -5.8, 5.8, 5.8, 11, 13, STONE, { tex: faceTex(stoneTex(9, 2, 6)) });
  // robed figure: a tapering column of ellipse slices
  for (let z = 0; z < 15; z++) {
    const r = 3.6 - z * 0.07 + (z > 10 ? -(z - 10) * 0.25 : 0), [vx, vy] = S.P(0, 0, 13 + z);
    S.ell(vx, vy, r * ISO * Math.SQRT2, r * ISO * Math.SQRT1_2, (x, y, u) => MARBLE[(h2(x, z, 6) % 9 === 0) ? 1 : u < -0.4 ? 3 : u < 0.2 ? 2 : u < 0.65 ? 1 : 0]);
  }
  for (let i = 0; i < 6; i++) S.set(-4 + (h2(i, v, 2) % 9), -13 - (h2(i, v, 3) % 5), jit(ramp('#7aa05a')[2], -0.1));
  S.ball(0, -30.5, 2.6, MARBLE);
  // raised arm holding a scroll (v even) or a torch (v odd)
  S.line(2, -27, 5, -33, MARBLE[1]); S.set(5, -34, MARBLE[3]);
  if (v & 1) { S.rect(5, -37, 1, 3, WOOD_D[2]); S.set(5, -38, LIT[2]); S.set(5, -39, LIT[3]); S.set(4, -38, LIT[1]); }
  else { S.rect(4, -37, 3, 3, CLOTH[3]); S.rect(4, -37, 3, 1, CLOTH[4]); S.set(6, -35, CLOTH[1]); }
  for (let i = 0; i < 4; i++) S.set(-5 + i * 2, -2 + (i & 1), LEAF_D[2]);
};

B.noticeboard = (S, p) => {
  const n = p.v | 0;
  for (const x of [-8, 8]) S.box(x - 1, -1, x + 1, 1, 0, 25, WOOD, { tex: faceTex(plankTex(4, 4)) });
  S.box(-10, -1.2, 10, 1.4, 9, 22, WOOD_D, { tex: faceTex(plankTex(5, 4)) });
  const [bx, by] = S.P(0, 1.4, 15.5);
  S.rect(bx - 11, by - 5, 22, 10, rgb('#c9a06a')); S.rect(bx - 11, by - 5, 22, 1, rgb('#dfb982')); S.rect(bx - 11, by + 4, 22, 1, rgb('#9a7448'));
  for (let i = 0; i < 5; i++) {
    const px = bx - 10 + i * 4 + (h2(i, n, 1) % 2), py = by - 4 + (h2(i, n, 2) % 3), c = i % 3 === 1 ? rgb('#f2d9a0') : CLOTH[3];
    S.rect(px, py, 3, 4 + (h2(i, n, 3) % 2), c); S.set(px, py, lt(c, 0.5)); S.set(px + 1, py, i % 2 ? rgb('#d6453d') : IRON[2]); S.set(px + 1, py + 2, dk(c, 0.3)); S.set(px, py + 3, dk(c, 0.25));
  }
  // little shingled roof
  const roof = accentOf(p), R0 = roof ? ramp(mix(roof, rgb('#9d4a37'), 0.2)) : null;
  S.wpoly([[-12, 3, 24.5], [12, 3, 24.5], [12, 0, 28], [-12, 0, 28]], R0 ? R0[2] : rgb('#9d4a37'));
  S.wpoly([[-12, 3, 24.5], [12, 3, 24.5], [12, 3, 23.3], [-12, 3, 23.3]], R0 ? R0[0] : rgb('#6e342b'));
  S.wpoly([[-12, 0, 28], [12, 0, 28], [12, -3, 24.5], [-12, -3, 24.5]], R0 ? R0[1] : rgb('#7e3a2f'));
};

B.signpost = (S, p) => {
  const n = p.v | 0;
  S.cyl(0, 0, 4, 0, 1.5, STONE, { top: STONE[3] });
  S.box(-1.1, -1.1, 1.1, 1.1, 0, 27, WOOD, { tex: faceTex(plankTex(3, 4)) });
  const arrow = (z, dir, len, c) => {
    const t = dir * len, tip = t + dir * 3;
    S.wpoly([[0, 1.4, z + 2.8], [t, 1.4, z + 2.8], [tip, 1.4, z + 0.7], [t, 1.4, z - 1.5], [0, 1.4, z - 1.5]], (x, y) => (y % 4 === 0 ? dk(c[2], 0.2) : c[2]));
    S.wpoly([[0, 1.4, z + 2.8], [t, 1.4, z + 2.8], [t, 1.4, z + 3.3], [0, 1.4, z + 3.3]], c[3]);
    for (let i = 0; i < 4; i++) { const [px, py] = S.P(dir * (3 + i * 2.6), 1.4, z + 0.7); S.set(px, py, c[0]); }
  };
  arrow(21, 1, 10, PLANK); arrow(14, -1, 9, WOOD_L);
  S.rect(-1, -29, 2, 1, WOOD_D[2]); S.set(0, -30, WOOD[3]);
  void n;
};

B.beehive = (S, p) => {
  const v = p.v | 0;
  if (v & 1) { // box hive: stacked white supers on legs
    for (const [x, y] of [[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5], [3.5, 3.5]]) S.box(x - 0.7, y - 0.7, x + 0.7, y + 0.7, 0, 5, WOOD);
    S.box(-5, -4.5, 5, 4.5, 5, 6.5, WOOD);
    for (let i = 0; i < 2; i++) S.box(-4.5, -4, 4.5, 4, 6.5 + i * 5.5, 11.5 + i * 5.5, i ? ramp('#f2e9d2') : ramp('#e9dfc4'), { tex: faceTex((x, y, c) => (y % 3 === 0 ? dk(c, 0.15) : c)) });
    const [ex, ey] = S.P(0, 4, 8); S.rect(ex - 2, ey, 4, 1, IRON[0]);
    S.wpoly([[-5.5, 4.8, 18], [5.5, 4.8, 18], [5.5, 0, 22], [-5.5, 0, 22]], SLATE[2]);
    S.wpoly([[-5.5, 0, 22], [5.5, 0, 22], [5.5, -4.8, 18], [-5.5, -4.8, 18]], SLATE[1]);
    S.wpoly([[-5.5, 4.8, 18], [5.5, 4.8, 18], [5.5, 4.8, 17], [-5.5, 4.8, 17]], SLATE[0]);
  } else { // straw skep on a low bench
    for (const x of [-4.5, 4.5]) S.box(x - 0.8, -3, x + 0.8, 3, 0, 5, WOOD);
    S.box(-7, -4, 7, 4, 5, 6.6, WOOD_L, { tex: faceTex(plankTex(1, 3)) });
    S.dome(0, 0, 6.6, 5.8, 11, 2.0, (x, y, u, k) => {
      const band = Math.floor(y / 2) & 1, c = STRAW[u < -0.4 ? 3 : u < 0.2 ? 2 : u < 0.62 ? 1 : 0];
      return band ? dk(c, 0.12) : c;
    });
    const [ex, ey] = S.P(0, 5, 6.6); S.ell(ex, ey - 2, 1.4, 1.8, (x, y, u, w) => (w > 0.3 ? STRAW[0] : IRON[0]));
    S.rect(-1, -18, 2, 1, STRAW[3]);
  }
  const [bx, by] = S.P(7, 5, 12);
  S.set(bx, by, rgb('#f0c13a')); S.set(bx + 1, by, IRON[1]);
};

B.trough = (S, p) => {
  const n = p.v | 0;
  for (const x of [-7.5, 7.5]) S.box(x - 1, -3.5, x + 1, 3.5, 0, 6, WOOD_D);
  S.box(-10, -4, 10, 4, 3, 8, WOOD, { tex: faceTex(plankTex(2 + n, 3)), top: WOOD_L[3] });
  S.wpoly([[-9, -2.8, 8], [9, -2.8, 8], [9, 2.8, 8], [-9, 2.8, 8]], (x, y) => (h2(x, y, 3) % 13 === 0 ? WATER[3] : (x + y) & 1 ? WATER[2] : WATER[1]));
  S.wpoly([[-9, -2.8, 8], [9, -2.8, 8], [9, -2.8, 7.2], [-9, -2.8, 7.2]], WOOD_D[1]);
  for (let i = 0; i < 4; i++) S.set(-12 + h2(i, n, 5) % 24 * 0.8, 3 + (i & 1), STRAW[3]);
};

B.maypole = (S, p, f) => {
  const H = 58, acc = accentOf(p);
  // styled: alternate ribbons take the regional accent (and a lighter/darker kin of it), the rest keep the festive mix
  const ribc = i => (acc ? (i % 3 === 0 ? acc : i % 3 === 1 ? lt(acc, 0.3) : RIBBONS[i]) : RIBBONS[i]);
  S.cyl(0, 0, 9, 0, 2.2, STONE, { tex: stoneTex(12, 2, 5), top: STONE_W[3] });
  const rib = (i, back) => {
    const a = i * Math.PI / 3 + 0.5, depth = Math.cos(a) + Math.sin(a);
    if ((depth < 0) !== back) return;
    const c = ribc(i), sway = Math.sin((f / 4 + i / 6) * Math.PI * 2) * 2.2, R = 12.5;
    for (let k = 0; k <= 60; k++) {
      const s = k / 60, e = s * s * 0.35 + s * 0.65, w = sway * Math.sin(s * Math.PI * 0.9);
      const wx = R * Math.cos(a) * e - Math.sin(a) * w, wy = R * Math.sin(a) * e + Math.cos(a) * w;
      const z = (H - 6) * (1 - s) ** 1.15 + 2 + Math.sin(s * Math.PI) * 1.5;
      const [px, py] = S.P(wx, wy, z); S.set(px, py, s > 0.6 && ((k >> 2) & 1) ? lt(c, 0.25) : c); S.set(px + 1, py, dk(c, 0.2));
    }
  };
  for (let i = 0; i < 6; i++) rib(i, true);
  S.cyl(0, 0, 1.7, 2, H, WOOD_L, { tex: (x, y, c) => ((Math.floor((y + x * 1.2) / 3) & 1) ? rgb('#d6453d') : c), top: WOOD_L[4] });
  // wreath and pennants at the top
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2, [px, py] = [Math.cos(a) * 5.2, -H + 4 + Math.sin(a) * 2.4];
    S.rect(px - 1, py - 1, 2, 2, i % 3 === 0 ? BLOOMS[i % 6] : LEAF[i & 1 ? 2 : 1]);
  }
  S.ball(0, -H - 1, 2.2, ramp('#e9b949'));
  for (let i = 0; i < 6; i++) rib(i, false);
};

B.flowerbox = (S, p) => {
  const n = p.v | 0;
  S.box(-8, -3.4, 8, 3.4, 0, 5, WOOD, { tex: faceTex(plankTex(n + 4, 2)), top: SOIL[1] });
  S.box(-8.4, -3.8, 8.4, -3.2, 4, 5.2, WOOD_L, { cap: false });
  S.wpoly([[-7.2, -2.6, 5], [7.2, -2.6, 5], [7.2, 2.6, 5], [-7.2, 2.6, 5]], (x, y) => (h2(x, y, 1) % 3 === 0 ? SOIL[2] : SOIL[1]));
  const cols = [h2(n, 1) % 6, h2(n, 2) % 6, h2(n, 3) % 6];
  for (let i = 0; i < 12; i++) {
    const wx = -7 + i * 1.28, wy = -2 + (h2(i, n, 5) % 5) * 0.9, [px, py] = S.P(wx, wy, 5);
    const h = 2 + (h2(i, n, 6) % 4), c = BLOOMS[cols[i % 3]];
    S.rect(px, py - h, 1, h, LEAF[2]); S.set(px - 1, py - 2, LEAF[3]); S.set(px + 1, py - 1, LEAF[1]);
    S.rect(px - 1, py - h - 2, 3, 2, c); S.set(px - 1, py - h - 2, lt(c, 0.45)); S.set(px, py - h - 1, dk(c, 0.2));
  }
};

B.lamppost = (S, p, f, lit) => {
  const kind = sty(p) && sty(p).lamp;
  if (kind === 'lantern') return lampLantern(S, lit);
  if (kind === 'post') return lampPost(S, lit);
  S.box(-2.4, -2.4, 2.4, 2.4, 0, 2.5, IRON);
  S.box(-1.7, -1.7, 1.7, 1.7, 2.5, 4, IRON);
  S.cyl(0, 0, 0.9, 4, 18, IRON, { top: IRON[3] });
  // scrolled collar and bracket
  S.box(-1.7, -1.7, 1.7, 1.7, 13, 14.2, IRON);
  S.line(0, -14, 3, -17, IRON[2]); S.line(0, -14, -3, -17, IRON[2]);
  // lantern: glass box with iron frame, cap and finial
  S.box(-2.7, -2.7, 2.7, 2.7, 16, 18, IRON);
  const g = lit ? LIT : GLASS;
  S.box(-2.2, -2.2, 2.2, 2.2, 18, 22, g, { top: g[4] });
  if (lit) { const [cx, cy] = S.P(0, 2.2, 20); S.rect(cx - 1, cy - 1, 3, 2, LIT[4]); }
  S.set(S.P(-2.2, 2.2, 22)[0], S.P(-2.2, 2.2, 22)[1], IRON[3]);
  S.wpoly([[-3.4, 3.4, 22], [3.4, 3.4, 22], [0, 0, 25], [0, 0, 25]], IRON[2]);
  S.wpoly([[3.4, 3.4, 22], [3.4, -3.4, 22], [0, 0, 25]], IRON[1]);
  S.rect(0, -26, 1, 2, IRON[3]);
};

// lantern on a post: a wooden post with a bracket arm and a small lantern hanging from it
function lampLantern(S, lit) {
  S.box(-2, -2, 2, 2, 0, 2.5, STONE);
  S.cyl(0, 0, 1.3, 2.5, 25, WOOD, { top: WOOD[3] });
  S.box(-1.9, -1.9, 1.9, 1.9, 22, 24, WOOD_D);
  S.line(0, -23, 5, -23, WOOD_D[2]); S.line(0, -22, 4, -23, WOOD_D[1]);
  const g = lit ? LIT : GLASS;
  S.rect(4, -22, 1, 1, IRON[2]);
  S.rect(3, -21, 3, 1, IRON[2]); S.rect(3, -20, 3, 4, g[2]); S.set(3, -20, g[4]); S.set(5, -17, g[1]); S.rect(3, -16, 3, 1, IRON[2]);
  if (lit) S.rect(4, -19, 1, 2, LIT[4]);
}
// simple wooden post lamp: a short post topped with a boxed flame under a little cap
function lampPost(S, lit) {
  S.cyl(0, 0, 1.6, 0, 3, STONE, { top: STONE[3] });
  S.box(-1.1, -1.1, 1.1, 1.1, 3, 18, WOOD, { tex: faceTex(plankTex(3, 4)) });
  S.box(-2.6, -2.6, 2.6, 2.6, 18, 19, WOOD_D);
  const gg = lit ? LIT : [dk(rgb('#8d7b52'), 0.3), dk(rgb('#8d7b52'), 0.1), rgb('#8d7b52'), lt(rgb('#8d7b52'), 0.2), lt(rgb('#8d7b52'), 0.4)];
  S.box(-2, -2, 2, 2, 19, 22.5, gg, { top: gg[4] });
  S.wpoly([[-3, 3, 22.5], [3, 3, 22.5], [0, 0, 25.5], [0, 0, 25.5]], WOOD_D[2]);
  S.wpoly([[3, 3, 22.5], [3, -3, 22.5], [0, 0, 25.5]], WOOD_D[1]);
}

B.bridge = (S, p) => {
  const ax = p.dir === 'y' ? 'y' : 'x', HL = 10, DW = 4.6, WW = 6.6, step = 0.5;
  const W = (s, w, z) => (ax === 'x' ? [s, w, z] : [w, s, z]);
  const dh = s => 3 + 6.5 * (1 - (s / HL) ** 2), arch = s => (Math.abs(s) < 6.6 ? 6.6 * Math.sqrt(1 - (s / 6.6) ** 2) : -2), top = s => dh(s) + 2.5;
  const long = ax === 'x' ? STONE[2] : STONE[1], endc = ax === 'x' ? STONE[1] : STONE[2];
  const tex = (R, base) => (x, y) => { const c = base; return (y & 1) ? ((x >> 1) % 3 === 0 ? dk(c, 0.15) : c) : ((x >> 1) % 3 === 1 ? dk(c, 0.15) : jit(c, 0.04)); };
  const quad = (s0, s1, w, z0a, z0b, z1a, z1b, c) => S.wpoly([W(s0, w, z1a), W(s1, w, z1b), W(s1, w, z0b), W(s0, w, z0a)], c);
  // far wall: inner face (arch region in shade), its cap
  for (let s = -HL; s < HL; s += step) {
    const s1 = s + step, m = s + step / 2, a = Math.max(-2, arch(m));
    quad(s, s1, -DW, -2, -2, a, a, dk(long, 0.62));
    quad(s, s1, -DW, a, a, top(s), top(s1), tex(STONE, long));
  }
  for (let s = -HL; s < HL; s += step) S.wpoly([W(s, -WW, top(s)), W(s + step, -WW, top(s + step)), W(s + step, -DW, top(s + step)), W(s, -DW, top(s))], STONE[3]);
  // deck: cobbles
  for (let s = -HL; s < HL; s += step) {
    const m = Math.floor((s + HL) / 2);
    S.wpoly([W(s, -DW, dh(s)), W(s + step, -DW, dh(s + step)), W(s + step, DW, dh(s + step)), W(s, DW, dh(s))], (x, y) => ((m + (y >> 1)) & 1 ? STONE_W[3] : STONE_W[2]));
  }
  // near wall: outer face with the arch cut out, then its cap and the visible end
  for (let s = -HL; s < HL; s += step) {
    const s1 = s + step, m = s + step / 2, a = Math.max(-2, arch(m));
    quad(s, s1, WW, a, a, top(s), top(s1), tex(STONE, long));
    quad(s, s1, WW, top(s) - 0.001, top(s1) - 0.001, top(s) - 0.9, top(s1) - 0.9, STONE[1]);
  }
  for (let s = -HL; s < HL; s += step) S.wpoly([W(s, DW, top(s)), W(s + step, DW, top(s + step)), W(s + step, WW, top(s + step)), W(s, WW, top(s))], STONE[4]);
  for (const w of [[-WW, -DW], [DW, WW]]) S.wpoly([W(HL, w[0], top(HL)), W(HL, w[1], top(HL)), W(HL, w[1], -2), W(HL, w[0], -2)], endc);
  for (const w of [[-WW, -DW], [DW, WW]]) S.wpoly([W(HL, w[0], top(HL)), W(HL, w[1], top(HL)), W(HL, w[1], dh(HL) + 0.5), W(HL, w[0], dh(HL) + 0.5)], (x, y) => (y & 1 ? endc : dk(endc, 0.1)));
};

// ---------- sizes (view rect relative to the foot point; generous so nothing is clipped) ----------
const bb = (x0, y0, x1, y1, z0, z1) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) { const vx = (x - y) * ISO, vy = (x + y) * ISO / 2 - z; a = Math.min(a, vx); c = Math.max(c, vx); b = Math.min(b, vy); d = Math.max(d, vy); }
  return [Math.floor(a) - 2, Math.floor(b) - 2, Math.ceil(c) + 2, Math.ceil(d) + 2];
};
const SIZE = {
  fountain: () => [-19, -34, 19, 12],
  well: () => [-14, -37, 14, 8],
  stall: () => [-19, -43, 19, 9],
  fence: p => { const L = Math.max(1, p.len | 0 || 1) * 16; return p.dir === 'y' ? bb(-3, -8, 3, L - 8, 0, 12) : bb(-8, -3, L - 8, 3, 0, 12); },
  haystack: () => [-12, -23, 12, 8],
  woodpile: () => [-17, -22, 17, 12],
  bench: () => [-12, -19, 12, 8],
  statue: () => [-12, -43, 12, 9],
  noticeboard: () => [-14, -34, 14, 6],
  signpost: () => [-16, -35, 16, 8],
  beehive: () => [-10, -27, 10, 8],
  trough: () => [-14, -14, 14, 9],
  maypole: () => [-20, -70, 20, 14],
  flowerbox: () => [-12, -17, 12, 8],
  lamppost: () => [-8, -30, 8, 6],
  bridge: () => [-17, -24, 17, 14],
};
const FRAMES = { fountain: 4, maypole: 4 };
const FPS = { fountain: 5, maypole: 2.5 };
const GLOW = [-34, -48, 34, 18]; // lamppost halo rect (relative to the foot)

export function createPropArt() {
  const cache = new Map();
  const norm = (p, style) => ({ kind: p.kind, v: p.v | 0, dir: p.dir === 'y' ? 'y' : 'x', len: Math.max(1, p.len | 0 || 1), style: STYLED.has(p.kind) && style && typeof style === 'object' ? style : null });
  const rectOf = q => SIZE[q.kind](q);

  function build(q, frame, lit) {
    const [x0, y0, x1, y1] = rectOf(q), S = new Surf(x1 - x0 + 1, y1 - y0 + 1, -x0, -y0);
    B[q.kind](S, q, frame, lit);
    S.outline();
    return { cv: S.canvas(), ox: -x0, oy: -y0 };
  }
  let glow = null;
  function glowSprite() {
    if (glow) return glow;
    const w = GLOW[2] - GLOW[0] + 1, h = GLOW[3] - GLOW[1] + 1, cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), cx = -GLOW[0], cy = -GLOW[1] - 20;
    // stepped, dithered halo around the lantern: pixel-art friendly, no smooth gradient
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot((x + 0.5 - cx) / 1.0, (y + 0.5 - cy) / 0.55) / 30;
      if (d >= 1) continue;
      const lvl = d < 0.18 ? 3 : d < 0.4 ? 2 : d < 0.68 ? 1 : 0, edge = (x + y) & 1;
      const a = [0.05, 0.1, 0.17, 0.3][lvl] * (lvl === 0 && edge ? 0 : 1);
      if (a) { g.fillStyle = `rgba(255,190,100,${a})`; g.fillRect(x, y, 1, 1); }
    }
    return (glow = { cv, ox: -GLOW[0], oy: -GLOW[1] });
  }

  function get(p, t, night, style) {
    const q = norm(p, style);
    if (!B[q.kind]) return null;
    const nf = FRAMES[q.kind] || 1, frame = nf > 1 ? (((Math.floor((+t || 0) * FPS[q.kind])) % nf) + nf) % nf : 0;
    const lit = q.kind === 'lamppost' && !!night;
    const key = `${q.kind}|${q.v}|${q.dir}|${q.len}|${frame}|${lit ? 1 : 0}${q.style ? `|${q.style.key}` : ''}`;
    let e = cache.get(key);
    if (!e) { e = build(q, frame, lit); cache.set(key, e); }
    return { e, lit };
  }

  return {
    draw(ctx, p, x, y, t, night, style) {
      const r = get(p, t, night, style);
      if (!r) return;
      const fx = Math.round(x), fy = Math.round(y);
      ctx.drawImage(r.e.cv, fx - r.e.ox, fy - r.e.oy);
      if (r.lit) {
        const g = glowSprite(), prev = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(g.cv, fx - g.ox, fy - g.oy);
        ctx.globalCompositeOperation = prev;
      }
    },
    extent(p, style) {
      const q = norm(p, style);
      if (!SIZE[q.kind]) return [0, 0, 0, 0];
      const r = rectOf(q);
      return q.kind === 'lamppost' ? [GLOW[0], GLOW[1], GLOW[2] + 1, GLOW[3] + 1] : [r[0], r[1], r[2] + 1, r[3] + 1];
    },
  };
}
