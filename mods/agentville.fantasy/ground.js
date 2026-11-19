// agentville.fantasy ground art (M6 P3): per-settlement paving at the true 32x16 tile. mod.ground.renderTile(code, nb, style).
// The classic paving looks (web/src/ground-art.js paintGround, imported, not forked) are painted top-down into a 16x16
// software buffer, then mapped onto the exact pixel diamond the engine ground uses (row r is 4r+2 px wide), so tiles
// partition the plane with no seams. Only paved codes (street, lane, plaza, market) with a paving style are drawn; every
// other tile returns null and the engine paints its flat colour as before.
//   style: the project's StyleTuple (style.js) as a plain object, taken from `nb.style` (per-settlement, set by the chunk baker)
//   or from `style` itself when that is an object. A string style (the engine's 'default' | 'night' view style) draws nothing.
import { paintGround, GROUND_CODES } from '../../web/src/ground-art.js';
import { PAINTER_KIND } from './style-rules.js';

const { STREET, LANE, PLAZA, MARKET } = GROUND_CODES;
const PAVE_CODES = new Set([STREET, LANE, PLAZA, MARKET, 6, 13]);   // what ground-art counts as paved (yard, bridge too)
const TW = 32, TH = 16, SRC = 16;

const parseHex = c => {
  if (typeof c !== 'string' || c[0] !== '#') return null;
  const h = c.length === 4 ? c.slice(1).replace(/./g, m => m + m) : c.slice(1);
  if (h.length !== 6) return null;
  const n = parseInt(h, 16); return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

/** Effective classic painter kind: the street pattern picks the weave on hard paving; earth and gravel stay loose. */
function painterKind(s) {
  const mat = s.street?.paving, kind = PAINTER_KIND[mat] ?? s.paving?.kind;
  if (kind === 'earth') return 'earth';
  if (s.street?.pattern === 'herringbone') return 'brick';
  if (s.street?.pattern === 'fan') return 'cobble';
  return kind;
}

// ---- water and the venue quayside (M6 cove polish). Both are painted per pixel at the true 32x16 tile, no style needed.
// Water: the classic sea tones (world.js SEA_MID / SEA_DEEP), with an ordered-dither (Bayer 4x4) band across every
// deep/shallow boundary so the shoreline steps like classic's instead of cutting one straight line. Deterministic: the
// dither depends only on the pixel's place in its tile and on the four neighbours' terrain (nb.tn/te/ts/tw).
const VENUE_GROUND = 201;                       // LAYOUT_GROUND.VENUE (engine-reserved): a venue site's deck/yard ground
const T_DEEP = 0, T_SEA = 1, T_SHORE = 2, T_GRASS = 3;
const SEA_DEEP = [0x1b, 0x4a, 0x7a], SEA_MID = [0x2a, 0x7f, 0xae], SEA_RIM = [0x4a, 0x9a, 0xc4];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
const isWater = t => t === T_DEEP || t === T_SEA;
const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** Visit every pixel of the 32x16 diamond: fn(x, y, a, b) with a, b in 0..1 along +tx (east) and +ty (south). */
function eachPixel(fn) {
  for (let r = 0; r < TH; r++) {
    const half = (r < TH / 2 ? 4 * r + 2 : 4 * (TH - 1 - r) + 2) / 2;
    for (let x = TW / 2 - half; x < TW / 2 + half; x++) {
      const dx = x + 0.5 - TW / 2, dy = r + 0.5;
      fn(x, r, Math.min(1, Math.max(0, (dx / 16 + dy / 8) / 2)), Math.min(1, Math.max(0, (dy / 8 - dx / 16) / 2)));
    }
  }
}
const put = (out, x, y, c) => { const i = (y * TW + x) * 4; out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255; };
/** Distance (0..1) of the pixel to each tile side: [n, e, s, w]. */
const sides = (a, b) => [b, 1 - a, 1 - b, a];

/** Water tile: base tone by class, dithered toward the neighbour's tone near each side that differs, a pale rim where it meets land. */
function waterPixels(nb) {
  const t = nb.terrain, base = t === T_DEEP ? SEA_DEEP : SEA_MID, nt = [nb.tn, nb.te, nb.ts, nb.tw];
  const out = new Uint8ClampedArray(TW * TH * 4);
  eachPixel((x, y, a, b) => {
    const d = sides(a, b);
    let col = base, pOther = 0, other = null, rim = 0;
    for (let k = 0; k < 4; k++) {
      const q = nt[k];
      if (isWater(q) && q !== t) { const p = Math.max(0, 0.62 - d[k] * 1.05); if (p > pOther) { pOther = p; other = q === T_DEEP ? SEA_DEEP : SEA_MID; } }
      else if (!isWater(q) && q >= 0 && t === T_SEA) rim = Math.max(rim, Math.max(0, 0.5 - d[k] * 1.3));
    }
    if (other && bayer(x, y) < pOther) col = other;
    if (rim > 0 && bayer(x + 2, y + 1) < rim) col = SEA_RIM;
    else if (t === T_SEA && col === SEA_MID && ((x * 7 + y * 13) & 31) === 0) col = mix3(SEA_MID, SEA_RIM, 0.6);   // sparse fixed glints
    put(out, x, y, col);
  });
  return out;
}

// Quayside: cobbled shingle (warm stone with pale pebbles and dark joints) that dithers into a grass verge where it meets
// grass and into plank where it meets water.
const COB = [[0x9a, 0x8c, 0x74], [0xa8, 0x9a, 0x80], [0x88, 0x7a, 0x64], [0x74, 0x68, 0x54]];
const GRASS_V = [[0x5f, 0x8a, 0x3c], [0x6c, 0x98, 0x44], [0x50, 0x7a, 0x34]];
const PLANK = [[0x8a, 0x62, 0x3a], [0x7a, 0x54, 0x30], [0x5c, 0x3e, 0x24]];
function quayPixels(nb) {
  const out = new Uint8ClampedArray(TW * TH * 4);
  const nt = [nb.tn, nb.te, nb.ts, nb.tw], ng = [nb.n, nb.e, nb.s, nb.w];
  const wet = isWater(nb.terrain);
  eachPixel((x, y, a, b) => {
    const d = sides(a, b);
    // cobble: a staggered course grid in tile-local screen px, a pebble tone per cell from a hash of its cell
    const row = y >> 1, off = (row & 1) * 3, cx = (x + off) >> 2;
    const cell = (cx * 73 + row * 151) & 7;
    let col = COB[cell === 0 ? 1 : cell === 5 ? 2 : 0];
    if ((x + off) % 4 === 3 || y % 2 === 1 && cell === 3) col = COB[3];
    if (wet) { const pl = (x + (y >> 2) * 5) % 8 === 7 ? PLANK[2] : PLANK[((y >> 1) + (x >> 3)) & 1]; col = pl; }
    let pv = 0;
    for (let k = 0; k < 4; k++) {
      const q = nt[k], g = ng[k];
      if (g === 0 && (q === T_GRASS || q === T_SHORE)) pv = Math.max(pv, Math.max(0, 0.6 - d[k] * 1.2));
    }
    if (pv > 0 && bayer(x, y) < pv) col = GRASS_V[(x + y * 3) % 5 === 0 ? 1 : (x * 5 + y) % 7 === 0 ? 2 : 0];
    put(out, x, y, col);
  });
  return out;
}


// ---- the countryside (M7 dress): wild grass, forest floor, meadow, bloom meadow and footpath, painted per pixel with an ordered
// dither (Bayer) instead of one flat colour, so the gaps between blocks read as turf with tufts, flowers and trodden trails
// rather than bare slabs. Terrain classes come from terrain.js (5 meadow, 6 bloom-meadow, 7 footpath). Only (tx & 7, ty & 7)
// and the four neighbours' terrain matter, so a class has 64 looks per neighbourhood and the memo stays small. Deterministic.
const T_FOREST = 4, T_MEADOW = 5, T_BLOOM = 6, T_PATH = 7, T_TALL = 8, T_GOLD = 9, T_ROSE = 10, T_VIOLET = 11;
const DRIFT_SETS = { [T_GOLD]: [[0xf8, 0xd8, 0x3c], [0xff, 0xf0, 0x8a], [0xe8, 0xa8, 0x20]], [T_ROSE]: [[0xf0, 0x6a, 0x8c], [0xff, 0xb4, 0xc8], [0xd8, 0x44, 0x6c]], [T_VIOLET]: [[0xa0, 0x80, 0xf0], [0xd0, 0xc0, 0xff], [0x7a, 0x5a, 0xd0]] };
const COUNTRY = new Set([T_GRASS, T_FOREST, T_MEADOW, T_BLOOM, T_PATH, T_TALL, T_GOLD, T_ROSE, T_VIOLET]);
const TURF = {
  [T_GRASS]: [[0x5f, 0x8a, 0x3c], [0x68, 0x93, 0x40], [0x56, 0x80, 0x36]],
  [T_FOREST]: [[0x2f, 0x5a, 0x2a], [0x37, 0x63, 0x2d], [0x27, 0x4e, 0x24]],
  [T_MEADOW]: [[0x6a, 0x9a, 0x44], [0x8a, 0xb8, 0x56], [0x4c, 0x7e, 0x34]],
  [T_BLOOM]: [[0x70, 0xa0, 0x48], [0x8a, 0xb6, 0x58], [0x58, 0x8c, 0x3c]],
  [T_PATH]: [[0xa0, 0x88, 0x58], [0xb4, 0x9c, 0x6a], [0x86, 0x70, 0x46]],
  [T_TALL]: [[0x4c, 0x7e, 0x34], [0x62, 0x94, 0x3c], [0x3a, 0x6a, 0x2c]],
  [T_GOLD]: [[0x5e, 0x8c, 0x3a], [0x72, 0x9c, 0x42], [0x4e, 0x7c, 0x32]],
  [T_ROSE]: [[0x5e, 0x8c, 0x3a], [0x72, 0x9c, 0x42], [0x4e, 0x7c, 0x32]],
  [T_VIOLET]: [[0x5e, 0x8c, 0x3a], [0x72, 0x9c, 0x42], [0x4e, 0x7c, 0x32]],
};
const WILD_PETALS = [[0xf5, 0xcf, 0x4f], [0xfb, 0xf6, 0xea], [0xef, 0x93, 0xcc], [0x9f, 0x7f, 0xf0], [0xec, 0x5f, 0x74]];
function countryPixels(nb) {
  const t = nb.terrain, hx = Number.isFinite(nb.tx) ? nb.tx & 7 : 0, hy = Number.isFinite(nb.ty) ? nb.ty & 7 : 0;
  const tones = TURF[t], nt = [nb.tn, nb.te, nb.ts, nb.tw];
  const out = new Uint8ClampedArray(TW * TH * 4);
  eachPixel((x, y, a, b) => {
    const d = sides(a, b);
    // base: dithered between the class's mid and light tones (denser light on meadow), dark flecks for tufts
    const n = (x * 7 + y * 13 + hx * 5 + hy * 11) & 15;
    let col = tones[bayer(x + hx, y + hy * 2) < 0.34 ? 1 : n < 3 ? 2 : 0];
    // the edge toward a neighbour of another countryside class dithers into its tone (the soft edge, instead of a straight cut)
    let best = 0, other = null;
    for (let k = 0; k < 4; k++) {
      const q = nt[k];
      if (q === t || !COUNTRY.has(q)) continue;
      const p = Math.max(0, 0.55 - d[k] * 1.1);
      if (p > best) { best = p; other = TURF[q]; }
    }
    if (other && bayer(x + 2, y + 1) < best) col = other[0];
    put(out, x, y, col);
  });
  if (t === T_TALL) {   // long-grass blades: short light strokes with a dark foot, and a few seed heads
    const h = fnv(`tl|${hx},${hy}`);
    for (let i = 0; i < 7; i++) {
      const r = fnv(`t${i}|${hx},${hy}`), y = 3 + (r % 9), half = (y < 8 ? 4 * y + 2 : 4 * (15 - y) + 2) / 2, x = Math.floor(16 - half) + 2 + ((r >>> 8) % Math.max(1, Math.floor(2 * half) - 5));
      put(out, x, y, TURF[T_TALL][1]); put(out, x, y - 1, [0x8c, 0xc0, 0x58]); put(out, x, y + 1, TURF[T_TALL][2]);
      if ((r >>> 20) % 5 === 0) put(out, x + 1, y - 1, [0xd8, 0xc8, 0x78]);
    }
    void h;
  }
  if (DRIFT_SETS[t]) {   // a flower drift: a dense scatter of 2px blooms in one colour family, pale hearts
    const set = DRIFT_SETS[t];
    for (let i = 0; i < 18; i++) {
      const r = fnv(`d${i}|${t}|${hx},${hy}`), y = 2 + (r % 12), half = (y < 8 ? 4 * y + 2 : 4 * (15 - y) + 2) / 2, x = Math.floor(16 - half) + 1 + ((r >>> 8) % Math.max(1, Math.floor(2 * half) - 3));
      const c = set[(r >>> 16) % 3];
      put(out, x, y, c); put(out, x + 1, y, c); if (y > 0 && (r >>> 20) & 1) put(out, x, y - 1, set[1]);
    }
  }
  if (t === T_BLOOM || t === T_MEADOW) {
    const h = fnv(`wild|${t}|${hx},${hy}`), n = t === T_BLOOM ? 5 + (h & 3) : 1 + (h & 1);
    for (let i = 0; i < n; i++) {
      const r = fnv(`w${i}|${t}|${hx},${hy}`), y = 3 + (r % 10), half = (y < 8 ? 4 * y + 2 : 4 * (15 - y) + 2) / 2;
      const x = Math.floor(16 - half) + 2 + ((r >>> 8) % Math.max(1, Math.floor(2 * half) - 5));
      put(out, x, y, WILD_PETALS[(r >>> 16) % WILD_PETALS.length]);
      if (t === T_BLOOM || (r >>> 20) & 1) put(out, x + 1, y, WILD_PETALS[(r >>> 22) % WILD_PETALS.length]);
    }
  }
  if (t === T_PATH) {   // pale pebbles on the trodden earth
    const h = fnv(`pb|${hx},${hy}`);
    for (let i = 0; i < 3; i++) { const r = (h >>> (i * 8)) & 255, y = 4 + (r % 8), x = 10 + ((r >>> 3) % 12); if (out[(y * TW + x) * 4 + 3]) put(out, x, y, [0xb4, 0xa4, 0x84]); }
  }
  return out;
}

// Flower bed: a mown-grass base with a few dithered tufts, and 5 to 8 small blossoms (a 2px bloom, pale heart) scattered by a
// hash of the tile's place. Petal tones follow classic iso.js FLOWERS. Only (tx & 7, ty & 7) matters, so a bed has 64 looks.
const FLOWERS_CODE = GROUND_CODES.FLOWERS;
const PETALS = [[0xec, 0x5f, 0x74], [0xf5, 0xcf, 0x4f], [0xef, 0x93, 0xcc], [0xfb, 0xf6, 0xea], [0x9f, 0x7f, 0xf0]];
const BED = [[0x5f, 0x8a, 0x3c], [0x6c, 0x98, 0x44], [0x50, 0x7a, 0x34]], HEART = [0xf3, 0xc2, 0x4a];
function flowerPixels(nb) {
  const out = new Uint8ClampedArray(TW * TH * 4);
  const hx = Number.isFinite(nb?.tx) ? nb.tx & 7 : 0, hy = Number.isFinite(nb?.ty) ? nb.ty & 7 : 0;
  eachPixel((x, y) => put(out, x, y, BED[(x * 5 + y * 3) % 7 === 0 ? 2 : (x + y * 2) % 5 === 0 ? 1 : 0]));
  const h = fnv(`bloom|${hx},${hy}`), n = 5 + (h & 3);
  for (let i = 0; i < n; i++) {
    const r = fnv(`b${i}|${hx},${hy}`), y = 2 + (r % 12), half = (y < 8 ? 4 * y + 2 : 4 * (15 - y) + 2) / 2;
    const x = Math.floor(16 - half) + 1 + ((r >>> 8) % Math.max(1, Math.floor(2 * half) - 3));
    const col = PETALS[(r >>> 16) % PETALS.length];
    put(out, x, y, col); put(out, x + 1, y, col);
    if (y > 0) put(out, x, y - 1, HEART);
  }
  return out;
}

/** The tile's pixels, { w: 32, h: 16, data: Uint8ClampedArray RGBA } or null when there is nothing to paint. Pure. */
export function tilePixels(code, nb, style) {
  if (code === VENUE_GROUND) return { w: TW, h: TH, data: quayPixels(nb || {}) };
  if (code === FLOWERS_CODE) return { w: TW, h: TH, data: flowerPixels(nb || {}) };
  if (code === 0 && isWater(nb?.terrain) && nb.tn !== undefined) return { w: TW, h: TH, data: waterPixels(nb) };
  if (code === 0 && COUNTRY.has(nb?.terrain) && nb.tn !== undefined) return { w: TW, h: TH, data: countryPixels(nb) };
  const s = nb?.style && typeof nb.style === 'object' ? nb.style : style && typeof style === 'object' ? style : null;
  const pv = s?.paving;
  if (!s || !pv || !PAVE_CODES.has(code) || code === 6 || code === 13 || !pv.base || !pv.joint) return null;
  const kind = painterKind(s);
  if (!kind) return null;
  const at = (a, b) => (a === 0 && b === -1 ? nb?.n : a === 1 && b === 0 ? nb?.e : a === 0 && b === 1 ? nb?.s : nb?.w) ?? 1;
  const hard = kind !== 'earth';
  const near = hard && s.street?.kerb === false ? (a, b) => { const c = at(a, b); return PAVE_CODES.has(c) ? c : STREET; } : at;
  const h = fnv(`${code}|${nb?.n},${nb?.e},${nb?.s},${nb?.w}|${pv.base}`);
  const tx = Number.isFinite(nb?.tx) ? nb.tx : h & 0xffff, ty = Number.isFinite(nb?.ty) ? nb.ty : (h >>> 16);

  const src = new Uint8ClampedArray(SRC * SRC * 4);
  const g = {
    fillStyle: '#000000',
    fillRect(x, y, w, hh) {
      const c = parseHex(this.fillStyle); if (!c) return;
      for (let yy = Math.max(0, y); yy < Math.min(SRC, y + hh); yy++) for (let xx = Math.max(0, x); xx < Math.min(SRC, x + w); xx++) {
        const i = (yy * SRC + xx) * 4; src[i] = c[0]; src[i + 1] = c[1]; src[i + 2] = c[2]; src[i + 3] = 255;
      }
    },
  };
  paintGround(g, code, tx, ty, 0, 0, near, { paving: { kind, base: pv.base, joint: pv.joint } });

  const out = new Uint8ClampedArray(TW * TH * 4);
  for (let r = 0; r < TH; r++) {
    const half = (r < TH / 2 ? 4 * r + 2 : 4 * (TH - 1 - r) + 2) / 2;
    for (let x = TW / 2 - half; x < TW / 2 + half; x++) {
      const dx = x + 0.5 - TW / 2, dy = r + 0.5, a = (dx / 16 + dy / 8) / 2, b = (dy / 8 - dx / 16) / 2;
      const sx = Math.min(SRC - 1, Math.max(0, Math.floor(a * SRC))), sy = Math.min(SRC - 1, Math.max(0, Math.floor(b * SRC)));
      const si = (sy * SRC + sx) * 4, di = (r * TW + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return { w: TW, h: TH, data: out };
}

const makeCanvas = (w, h) => {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  } catch { /* no canvas */ }
  return null;
};
const memo = new Map(), MEMO_MAX = 2048;

/** mod.ground.renderTile: a 32x16 bitmap, or null (no canvas, nothing to paint). Memoised by what the pixels depend on. */
export function renderTile(code, nb, style) {
  const s = nb?.style && typeof nb.style === 'object' ? nb.style : style && typeof style === 'object' ? style : null;
  const bed = code === FLOWERS_CODE;
  const country = code === 0 && COUNTRY.has(nb?.terrain) && nb.tn !== undefined;
  const plain = bed || country || code === VENUE_GROUND || (code === 0 && isWater(nb?.terrain) && nb.tn !== undefined);
  if (!s?.paving && !plain) return null;
  const k = bed ? `f|${(nb?.tx ?? 0) & 7},${(nb?.ty ?? 0) & 7}` : country ? `c|${nb.terrain}|${nb.tn},${nb.te},${nb.ts},${nb.tw}|${nb.tx & 7},${nb.ty & 7}` : plain ? `p${code}|${nb.terrain}|${nb.tn},${nb.te},${nb.ts},${nb.tw}|${nb.n},${nb.e},${nb.s},${nb.w}` : `${code}|${nb?.n},${nb?.e},${nb?.s},${nb?.w}|${nb?.tx ?? ''},${nb?.ty ?? ''}|${s.paving.kind},${s.paving.base},${s.paving.joint}|${s.street?.paving},${s.street?.pattern},${s.street?.kerb}`;
  if (memo.has(k)) { const v = memo.get(k); memo.delete(k); memo.set(k, v); return v; }
  const px = tilePixels(code, nb, style);
  let bmp = null;
  if (px) {
    const c = makeCanvas(px.w, px.h), x = c?.getContext?.('2d', { willReadFrequently: true });
    if (x) { const id = x.createImageData(px.w, px.h); id.data.set(px.data); x.putImageData(id, 0, 0); bmp = c; }
  }
  memo.set(k, bmp); if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return bmp;
}

/** `reads`: the style fields renderTile draws; the engine keys its tile memo and chunk hash on only these. */
export const ground = { renderTile, reads: ['paving', 'street'] };
export default ground;
