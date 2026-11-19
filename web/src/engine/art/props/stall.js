// Engine prop art: market stall (original pixel art, 2026-11-19). Seam: name, frames, extent, draw.
//
// Drawn natively at the engine's 32x16 scale. Until this module the stall was the classic props-art.js sprite (0.8
// projection) blown up 1.25x nearest-neighbour by the renderer, which doubled every fourth pixel row and column: the
// awning stripes stair-stepped unevenly, outlines went 1-2 px thick, and the stall did not match the 1px art beside it.
//
// The foot point is the centre of the 2x1 footprint (long side along x; world x -16..16, y -8..8). The counter faces +y
// (the viewer, south-west); the vendor anchor is the tile behind (objects.js), so the back is left open: posts and a low
// counter only, no back wall.
//
// p.v packs three independent looks (the fantasy mod's hooks.propVariants picks them so neighbouring stalls differ):
// with lo = v & 7, mid = (v >> 3) & 7, hi = v >> 6:
//   cloth = lo                     CLOTHS index (0 = the settlement accent when a style gives one)
//   goods = (mid + 3 * lo) & 7     what is on the counter (GOODS)
//   shape = (hi + lo + mid) % 3    0 striped sloping awning, 1 peaked pavilion with a pennant, 2 round hood
// so a bare plan variant 0..7 (no hook) still gives eight different stalls. stallLook(v) decodes it (the mod's
// variety.js encodes the same way: a mod may not import engine files).
// p.dir 'y' (a 1x2 footprint, counter facing +x) is the same drawing mirrored.
import { Surf, ramp, rgbOf, dk, lt, h2 } from './pa2-kit.js';

export const name = 'stall';
export const frames = 1;
const EXT = [-29, -53, 29, 14];
export function extent() { return EXT.slice(); }

/** Decode a stall variant into its three looks. */
export function stallLook(v) {
  v = Math.max(0, v | 0);
  const lo = v & 7, mid = (v >> 3) & 7, hi = v >> 6;
  return { cloth: lo, goods: (mid + 3 * lo) & 7, shape: (hi + lo + mid) % 3 };
}

// storybook cloths: crimson, saffron, teal, royal blue, plum, moss, terracotta, rose
const CLOTHS = ['#b8434a', '#dc9c34', '#3a8a86', '#4a66ae', '#8a4c8c', '#5f9446', '#c4653e', '#c66f8a'].map(ramp);
const CREAM = ['#a8906c', '#d2bb92', '#efe2c0', '#f7eed4', '#fffae8'].map(rgbOf), GOLD = ramp('#e2b444');
const WOOD = ramp('#9a6a40'), WOOD_D = ramp('#6a4630'), WOOD_L = ramp('#c08c58'), IRON = ramp('#3d4150');
const validAccent = s => s && typeof s === 'object' && typeof s.accent === 'string' && /^#[0-9a-f]{6}$/i.test(s.accent);

// ---------- helpers ----------
const plank = (f, x, y, c) => (f === 't' ? ((x + 2 * y) % 6 === 0 ? dk(c, 0.12) : c) : (y % 3 === 0 ? dk(c, 0.16) : (h2(x >> 2, y, 7) % 9 === 0 ? dk(c, 0.1) : c)));
/** A vertical face at fixed world y, columns x0..x1, from z0(x) up to z1(x); col(x, z) -> colour | null. */
function faceY(S, y, x0, x1, z0, z1, col) {
  for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) {
    const sx = x - y, base = (x + y) / 2;
    const top = Math.round(base - z1(x)), bot = Math.round(base - z0(x));
    for (let sy = top; sy < bot; sy++) { const c = col(x, base - sy - 0.5); if (c) S.set(sx, sy, c); }
  }
}
/** A vertical face at fixed world x, columns y0..y1 (the +x end of something). */
function faceX(S, x, y0, y1, z0, z1, col) {
  for (let y = Math.ceil(y0); y <= Math.floor(y1); y++) {
    const sx = x - y, base = (x + y) / 2;
    const top = Math.round(base - z1(y)), bot = Math.round(base - z0(y));
    for (let sy = top; sy < bot; sy++) { const c = col(y, base - sy - 0.5); if (c) S.set(sx, sy, c); }
  }
}
const post = (S, x, y, z1, R) => S.box(x - 0.5, y - 0.5, x + 0.5, y + 0.5, 0, z1, R, (f, X, Y, c) => (f === 'l' && Y % 4 === 0 ? dk(c, 0.1) : c));

// ---------- goods on the counter (top at z = TOP, depth y 1..7) ----------
const TOP = 10;
const GOODS = [
  (S, W) => { // produce baskets: apples, pears, oranges
    const fruit = [rgbOf('#c8383a'), rgbOf('#9cbc3c'), rgbOf('#e8902c')];
    for (let i = 0, x = -W + 4; x <= W - 4; x += 6, i++) {
      const [cx, cy] = S.P(x, 4, TOP);
      S.ell(cx, cy, 3.6, 2, (X, Y, u, w) => (w > 0.1 ? WOOD_L[w > 0.6 ? 1 : 2] : null));
      const F = ramp(fruit[i % 3]);
      for (const [dx, dy] of [[-2, -1], [0, -1], [2, -1], [-1, -2], [1, -2]]) { S.set(cx + dx, cy + dy, F[2]); S.set(cx + dx, cy + dy - 1, F[3]); }
      S.set(cx, cy - 3, F[4]);
    }
  },
  (S, W) => { // bread loaves and a round
    const B = ramp('#cf9452');
    for (let x = -W + 3; x <= W - 4; x += 5) {
      const [cx, cy] = S.P(x, 4, TOP);
      S.ell(cx, cy - 1, 3, 1.7, (X, Y, u, w) => B[w < -0.3 ? 4 : w < 0.3 ? 3 : 1]);
      S.set(cx - 1, cy - 2, B[0]); S.set(cx + 1, cy - 2, B[0]);
    }
  },
  (S, W) => { // bolts of cloth, standing in a row
    const cs = ['#4a66ae', '#b8434a', '#e6c65a', '#5f9446', '#8a4c8c', '#f0e4c4'];
    for (let i = 0, x = -W + 3; x <= W - 3; x += 3, i++) {
      const R = ramp(cs[i % cs.length]), [cx, cy] = S.P(x, 3, TOP), hgt = 5 + (i % 2);
      S.rect(cx - 1, cy - hgt, 3, hgt, R[2]); S.rect(cx - 1, cy - hgt, 1, hgt, R[3]); S.rect(cx + 1, cy - hgt, 1, hgt, R[1]); S.set(cx, cy - hgt, R[4]);
    }
  },
  (S, W) => { // pottery: jugs and urns
    const cs = [ramp('#c46a42'), ramp('#5f8f8a'), ramp('#d9c9a0')];
    for (let i = 0, x = -W + 3; x <= W - 3; x += 5, i++) {
      const R = cs[i % 3], [cx, cy] = S.P(x, 4, TOP), hgt = 4 + (i * 2) % 4;
      S.ell(cx, cy - hgt / 2, 2.2, hgt / 2 + 0.4, (X, Y, u) => R[u < -0.3 ? 3 : u < 0.4 ? 2 : 1]);
      S.rect(cx - 1, cy - hgt - 1, 2, 1, R[0]);
    }
  },
  (S, W) => { // flower buckets
    const blooms = ['#ec5f74', '#f5cf4f', '#ef93cc', '#fbf6ea', '#9f7ff0', '#f0944a'].map(rgbOf), leaf = ramp('#5b9a3c');
    for (let i = 0, x = -W + 4; x <= W - 4; x += 6, i++) {
      const [cx, cy] = S.P(x, 4, TOP);
      S.rect(cx - 2, cy - 2, 4, 3, WOOD[2]); S.rect(cx + 1, cy - 2, 1, 3, WOOD[1]);
      for (let k = 0; k < 6; k++) { const c = blooms[(h2(i, k, 5) >>> 3) % 6], bx = cx - 2 + (k % 3) * 2 - (k > 2 ? 1 : 0), by = cy - 4 - (k > 2 ? 1 : 0) - (k & 1); S.rect(bx, by, 2, 1, c); S.set(bx, by - 1, lt(c, 0.35)); S.set(bx + 1, by + 1, leaf[2]); }
    }
  },
  (S, W) => { // fish on a bed of ice
    const ice = ramp('#bcd8e2'), fish = [ramp('#9fb4c4'), ramp('#cf8f6a')];
    S.wpoly([[-W + 2, 2, TOP + 1], [W - 2, 2, TOP + 1], [W - 2, 6, TOP + 1], [-W + 2, 6, TOP + 1]], (x, y) => ((x + y) % 5 === 0 ? ice[4] : ice[3]));
    for (let i = 0, x = -W + 4; x <= W - 5; x += 4, i++) {
      const F = fish[i % 3 === 1 ? 1 : 0], [cx, cy] = S.P(x, 4, TOP + 1);
      S.rect(cx - 2, cy - 1, 5, 2, F[2]); S.rect(cx - 2, cy - 1, 5, 1, F[3]); S.set(cx + 3, cy - 1, F[1]); S.set(cx + 3, cy, F[1]); S.set(cx - 1, cy - 1, IRON[1]);
    }
  },
  (S, W) => { // potions: small glowing bottles with cork stoppers
    const cs = ['#d0485c', '#58b4d8', '#8ccf54', '#b070e0', '#f0b840'];
    for (let i = 0, x = -W + 3; x <= W - 3; x += 3, i++) {
      const R = ramp(cs[(i * 3) % cs.length]), [cx, cy] = S.P(x, 3 + (i & 1) * 2, TOP), tall = i % 3 === 0;
      S.rect(cx - 1, cy - 3, 3, 3, R[2]); S.set(cx - 1, cy - 3, R[4]); S.set(cx + 1, cy - 1, R[1]);
      S.set(cx, cy - 4, R[3]); if (tall) S.set(cx, cy - 5, R[3]);
      S.set(cx, cy - (tall ? 6 : 5), WOOD_L[3]);
    }
  },
  (S, W) => { // cheese wheels and a hanging string of sausages along the counter front
    const C = ramp('#e8c45a'), rind = ramp('#c8903a');
    for (let x = -W + 4; x <= W - 4; x += 6) {
      const [cx, cy] = S.P(x, 4, TOP);
      S.ell(cx, cy - 1, 3.4, 1.8, (X, Y, u, w) => (w < -0.1 ? C[3] : rind[2]));
      S.ell(cx, cy - 3, 3.4, 1.6, (X, Y, u, w) => C[w < 0 ? 4 : 3]);
    }
  },
];

// ---------- canopies ----------
/** A scalloped valance hanging from the front eave (y, z), one scallop per 4 px stripe. */
function valance(S, y, x0, x1, z, stripe) {
  const mid = x => { const k = (((x - x0) % 4) + 4) % 4; return k === 1 || k === 2; };
  faceY(S, y, x0, x1, x => z - 3 - (mid(x) ? 1 : 0), () => z, (x, zz) => { const R = stripe(x); return zz > z - 1 ? R[1] : zz < z - 3 ? R[1] : R[2]; });
}
/** 0: a striped awning sloping down toward the viewer (1:1 on screen, so the stripes are crisp 45 degree bands). */
function awning(S, W, C) {
  const ZB = 33, x0 = -W - 1, x1 = W + 1, yb = -8, yf = 10, zf = ZB - 0.5 * (yf - yb);  // 24
  const zAt = y => ZB - 0.5 * (y - yb);
  const stripe = x => (Math.floor((x - x0) / 4) & 1 ? CREAM : C);
  S.wpoly([[x0, yb, ZB], [x1, yb, ZB], [x1, yf, zf], [x0, yf, zf]], (sx, sy) => {
    // invert the plane: sy = 1.5x - sx - ZB + 4 + ... (pixel centre)
    const x = (sy + 0.5 + sx + 0.5 + ZB - 4) / 1.5, y = x - (sx + 0.5), R = stripe(x);
    return y < yb + 1.6 ? R[4] : y > yf - 2 ? R[2] : R[3];
  });
  // the +x end: a narrow hem down the sloping edge
  faceX(S, x1, yb, yf, y => zAt(y) - 2, y => zAt(y), () => C[1]);
  // scalloped valance along the front edge, one scallop per stripe
  valance(S, yf, x0, x1, zf, stripe);
}

/** 1: a peaked pavilion: ridge along x, the front slope 1:2 on screen (crisp steep stripes), a gable end and a pennant. */
function pavilion(S, W, C) {
  const ZR = 40, yr = -1, yf = 9, zf = ZR - 1.5 * (yf - yr), yb = -9, zb = ZR - 1.5 * (yr - yb), x0 = -W - 1, x1 = W + 1; // zf 25, zb 28
  const stripe = x => (Math.floor((x - x0) / 4) & 1 ? CREAM : C);
  // the back slope shows only as the gable's far edge; draw it first so the outline closes round it
  S.wpoly([[x0, yr, ZR], [x1, yr, ZR], [x1, yb, zb], [x0, yb, zb]], C[1]);
  // gable end (+x face): darker cloth with a centre seam
  const eave = y => zb + (zf - zb) * (y - yb) / (yf - yb);
  faceX(S, x1, yb, yf, y => eave(y) - 2, y => (y <= yr ? zb + (y - yb) * 1.5 : ZR - 1.5 * (y - yr)), (y, z) => (z < eave(y) ? C[1] : y === yr ? CREAM[1] : C[0]));
  // front slope
  S.wpoly([[x0, yr, ZR], [x1, yr, ZR], [x1, yf, zf], [x0, yf, zf]], (sx, sy) => {
    // plane z = ZR - 1.5 (y - yr): sy = x/2 + 2y - ZR + 1.5 yr ... solved for x with y = x - sx
    const px = sx + 0.5, py = sy + 0.5, x = (py + 2 * px + ZR + 1.5 * yr) / 2.5, y = x - px, R = stripe(x);
    return y < yr + 1.2 ? R[4] : y > yf - 1.5 ? R[2] : R[3];
  });
  // valance
  valance(S, yf, x0, x1, zf, stripe);
  // ridge cap and finials, a pennant on the near end
  for (let x = x0; x <= x1; x++) { const [sx, sy] = S.P(x, yr, ZR); S.set(sx, sy, GOLD[3]); }
  const [lx, ly] = S.P(x0, yr, ZR), [rx, ry] = S.P(x1, yr, ZR);
  S.set(lx, ly - 1, GOLD[2]); S.set(lx, ly - 2, GOLD[4]);
  S.rect(rx, ry - 9, 1, 9, WOOD_D[2]); S.set(rx, ry - 10, GOLD[4]);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4 - (i >> 1) - (i === 4 ? 1 : 0); j++) S.set(rx + 1 + i, ry - 9 + j + (i >> 1), i < 2 ? C[3] : C[2]);
}

/** 2: a round hood (a cloth vault along x) in one colour with cream trim bands at the ends and a hanging lantern. */
function hood(S, W, C) {
  const x0 = -W - 1, x1 = W + 1, R0 = 9, ZB = 25, zAt = y => ZB + Math.sqrt(Math.max(0, 1 - (y / R0) ** 2)) * 9;
  const band = x => x - x0 < 2 || x1 - x < 2;
  // strips from the back to the front, each overwriting the one behind
  for (let y = -R0; y < R0; y += 0.5) {
    const ya = y, yb = y + 0.5, za = zAt(ya), zb = zAt(yb), slope = (zb - za) / 0.5;   // + rising (back half), - falling (front)
    const tone = slope > 0.9 ? 1 : slope > -0.6 ? 4 : slope > -1.6 ? 3 : 2;
    S.wpoly([[x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb]], (sx, sy) => {
      const x = sx + 0.5 + (ya + yb) / 2;
      return (band(x) ? CREAM : C)[tone];
    });
  }
  // the +x end: a cream rim round the arch over a shaded end curtain
  faceX(S, x1, -R0, R0, () => ZB - 1, y => zAt(y), (y, z) => (z > zAt(y) - 1.5 ? CREAM[Math.abs(y) < R0 - 1 ? 2 : 1] : C[0]));
  // front hem
  faceY(S, R0, x0, x1, () => ZB - 2, () => ZB, x => (band(x) ? CREAM : C)[1]);
  // a small lantern under the front-right corner
  const [lx, ly] = S.P(x1 - 3, R0 - 1, ZB - 2);
  S.set(lx, ly, IRON[2]); S.set(lx, ly + 1, IRON[2]);
  S.rect(lx - 1, ly + 2, 3, 3, GOLD[3]); S.set(lx, ly + 3, GOLD[4]); S.rect(lx - 1, ly + 5, 3, 1, IRON[1]);
}
const CANOPY = [awning, pavilion, hood];
const HALF = [14, 13, 12];   // half-width by shape: the silhouettes of a row differ in width as well as roof

export function draw(g, p, fx, fy, t, lit, style) {
  const { cloth, goods, shape } = stallLook(p && p.v);
  const C = cloth === 0 && validAccent(style) ? ramp(style.accent) : CLOTHS[cloth];
  const W = HALF[shape], S = new Surf(EXT);
  S.rect = (x, y, w, h, c) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) S.set(x + i, y + j, c); };
  const zf = [24, 25, 23][shape], zb = [33, 28, 25][shape];
  // back posts (the back is open: the vendor stands behind the counter)
  post(S, -W, -6, zb, WOOD_D); post(S, W, -6, zb, WOOD_D);
  // a crate or sack of stock behind the counter on one side
  if (goods & 1) S.box(W - 8, -6, W - 3, -2, 0, 5, WOOD_L, plank); else { const [sx, sy] = S.P(-W + 5, -4, 0); S.ell(sx, sy - 3, 3.2, 3.4, (X, Y, u, w) => CREAM[u < -0.3 ? 3 : u < 0.4 ? 2 : 1]); S.rect(sx - 1, sy - 7, 2, 1, WOOD_D[2]); }
  // the counter: plank box, a cloth runner on top in the stall's colour
  // (plain linen under half the goods, so the wares never sit on cloth of their own colour)
  const RUN = goods & 2 ? CREAM : C;
  S.box(-W + 1, 1, W - 1, 7, 0, TOP, WOOD, (f, x, y, c) => (f === 't' ? ((x + y) & 1 ? RUN[3] : lt(RUN[3], 0.08)) : plank(f, x, y, c)));
  // the runner hangs over the front edge with a fringe
  faceY(S, 7.01, -W + 1, W - 1, x => TOP - 3 - ((x & 1) ? 0.6 : 0), () => TOP, (x, z) => (z > TOP - 1 ? RUN[3] : RUN[2]));
  GOODS[goods](S, W);
  // front posts
  post(S, -W, 8, zf, WOOD); post(S, W, 8, zf, WOOD);
  CANOPY[shape](S, W, C);
  if (p && p.dir === 'y') mirror(S);
  S.outline();
  S.blit(g, fx, fy);
}

/** Mirror the buffer about the foot point's column (a dir 'y' stall: the counter faces +x). */
function mirror(S) {
  const { w, h, d } = S, o = -S.x0;   // foot column index
  const src = d.slice();
  d.fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const m = 2 * o - x;
    if (m < 0 || m >= w) continue;
    const a = (y * w + x) * 4, b = (y * w + m) * 4;
    d[b] = src[a]; d[b + 1] = src[a + 1]; d[b + 2] = src[a + 2]; d[b + 3] = src[a + 3];
  }
}
