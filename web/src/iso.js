// Isometric buildings (the 2.5D view), in a cozy farm-sim pixel-art style (original art, drawn in code).
//
// Each building is modelled as flat faces (walls, gable ends, roof planes, chimney, porch, steps), round
// solids (barrels, pots, bushes, a dome) and a soft ground shadow, then rasterised pixel by pixel with a
// depth buffer: every screen pixel is a ray toward the viewer, the nearest surface wins, and that
// surface's material paints the pixel. Materials work in screen space (2:1 rows, whole-pixel columns), so
// clapboards, shingle courses, mortar and window frames land on exact pixels: crisp at every integer zoom.
//
// Colour: every material is a 5-tone ramp with hue shifting: shadows lean toward indigo, highlights
// toward warm yellow. Light comes from the front left (south-west, above): south faces are lit, east
// faces in half shade, and shadows fall east. Silhouettes get a 1px dark outline tinted by what it
// outlines (never flat black); a nearer face over a farther one gets a softer line.
//
// Each look is drawn once and cached: no per-frame cost beyond one drawImage.
//
// Coordinates: x, y are world px across the footprint (x0..x1 east, y0..y1 south); z is height in view
// px. View px are isoP(x, y) with z subtracted. A pixel's ray is ground point + t·(1, 1, ISO): larger t
// is nearer the viewer.
import { ISO, hash } from './world.js';

// ---------- colour ----------
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = rgb('#2a1c4a'), WARM = rgb('#fff0b0'), OUTLINE = rgb('#1d1233');
const dk = (c, k) => mix(c, SHADE, k), lt = (c, k) => mix(c, WARM, k); // hue-shifted: dark → indigo, light → warm yellow
const jit = (c, n) => (n > 0 ? lt(c, n) : dk(c, -n));
/** A 5-tone ramp: [deep shadow, shadow, base, light, highlight]. */
const ramp = c => [dk(c, 0.5), dk(c, 0.25), c, lt(c, 0.2), lt(c, 0.42)];
const h2 = (a, b, seed = 0) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(seed | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
const L = (() => { const v = [-0.55, 0.62, 0.56], n = Math.hypot(...v); return v.map(a => a / n); })(); // toward the light

const GLASS = ramp(rgb('#3d5687')), LIT = [rgb('#c9702c'), rgb('#f0a346'), rgb('#ffcd68'), rgb('#ffe7a0'), rgb('#fff8dc')];
const GOLD = rgb('#e9b949'), STONE = rgb('#a39a8c'), SOIL = rgb('#7a5236'), LEAF = rgb('#5b9a3c'), POT = rgb('#c46a42');
const WOOD = rgb('#9a6a40'), DARKWOOD = rgb('#6a4630'), BEAM = rgb('#6b4429');
const FLOWERS = [rgb('#ec5f74'), rgb('#f5cf4f'), rgb('#ef93cc'), rgb('#fbf6ea'), rgb('#9f7ff0')];

// Painted colour schemes, picked per building from its id: wall paint, trim, shutters and door.
const PAINT = {
  honey: rgb('#cf9d61'), sage: rgb('#93b088'), butter: rgb('#e9cc84'), sky: rgb('#8eabc2'), rose: rgb('#d9a08e'),
  cream: rgb('#ecdfc2'), barn: rgb('#b75a42'), mint: rgb('#a9cdb3'), lilac: rgb('#b9a6cc'),
};
const SCHEMES = [ // [wall, trim, shutters, door]
  ['honey', '#f3e7cd', '#4f7d4a', '#7a4a2a'], ['sage', '#f3e7cd', '#a8443c', '#6b4a8a'], ['butter', '#6a4630', '#3f6f8f', '#3f6f8f'],
  ['sky', '#f6efdf', '#c7623e', '#c7623e'], ['rose', '#f6efdf', '#46705f', '#46705f'], ['cream', '#6a4630', '#8a3f3f', '#8a3f3f'],
  ['barn', '#f3e7cd', '#3d5f78', '#3d5f78'], ['mint', '#f6efdf', '#b5683a', '#7a4a2a'], ['lilac', '#f6efdf', '#557a48', '#d1a447'],
];

// The archetypes: wall height H, roof rise R, eave overhang e.
const ARCH = {
  lodge: { H: 34, R: 22, e: 4 }, twostorey: { H: 30, R: 16, e: 3 }, cottage: { H: 21, R: 15, e: 3 },
  hut: { H: 17, R: 15, e: 4 }, workshop: { H: 24, R: 14, e: 3 }, tower: { H: 30, R: 20, e: 3 },
};
const LEADS = ['houseA', 'houseB', 'houseC', 'houseD'];

/** What a building looks like, decided once from its id (so it never changes between visits). */
function styleOf(it) {
  const h = hash(it.id), pr = it.kind === 'pr', look = it.look || 'houseH';
  const arch = look === 'hall' ? 'lodge' : look.startsWith('tower') ? 'tower' : pr ? 'workshop'
    : LEADS.includes(look) ? (h % 5 < 3 ? 'twostorey' : 'cottage') : (h % 3 === 0 ? 'hut' : 'cottage');
  const A = ARCH[arch], sc = SCHEMES[(h >>> 5) % SCHEMES.length];
  const st = { arch, pr, hall: arch === 'lodge', H: A.H, R: A.R, e: A.e, seed: h & 0xffff, roofShape: look === 'towerDome' ? 'dome' : arch === 'tower' ? 'spire' : 'gable' };
  st.paint = PAINT[sc[0]]; st.trim = rgb(sc[1]); st.shutter = rgb(sc[2]); st.doorC = rgb(sc[3]);
  const bit = n => (h >>> n) & 1;
  if (arch === 'lodge') Object.assign(st, { lower: 'stone', upper: 'timber', split: 15, roof: 'slate', ridge: 'NS', shutters: true, flowers: true, lamp: true, chimney: true, trim: rgb('#5a3a26'), paint: rgb('#efe3c6'), doorC: rgb('#7a4a2a'), shutter: rgb('#46705f') });
  else if (arch === 'twostorey') Object.assign(st, { lower: bit(7) ? 'stone' : 'clap', upper: ['clap', 'timber', 'shingleWall'][(h >>> 8) % 3], split: 14, roof: bit(10) ? 'tile' : 'shingle', shutters: true, flowers: bit(11) === 0, lamp: bit(12) === 1, chimney: true });
  else if (arch === 'cottage') Object.assign(st, { lower: ['clap', 'clap', 'timber', 'stone', 'logs'][(h >>> 7) % 5], roof: ['shingle', 'tile', 'shingle'][(h >>> 10) % 3], shutters: bit(11) === 0, flowers: (h >>> 12) % 3 !== 0, lamp: bit(14) === 1, chimney: (h >>> 15) % 3 !== 0 });
  else if (arch === 'hut') Object.assign(st, { lower: bit(7) ? 'logs' : 'clap', roof: 'thatch', shutters: bit(8) === 1, flowers: bit(9) === 1, lamp: false, chimney: bit(10) === 1, paint: bit(7) ? rgb('#a87447') : st.paint });
  else if (arch === 'workshop') Object.assign(st, { lower: bit(7) ? 'brick' : 'stone', upper: 'clap', split: 16, roof: bit(8) ? 'slate' : 'tile', shutters: false, flowers: false, lamp: false, chimney: true, sign: true, paint: rgb('#b88a5a'), trim: rgb('#5a3a26'), doorC: rgb('#8a5a34') });
  else Object.assign(st, { lower: bit(7) ? 'stone' : 'brick', roof: bit(8) ? 'slate' : 'shingle', shutters: false, flowers: false, lamp: false, chimney: false, sign: true });
  st.upper ??= st.lower; st.split ??= 99;
  if (st.lower === 'logs') st.paint = rgb('#a87447');
  if (st.lower === 'timber') st.paint = rgb('#efe3c6');
  if (!st.ridge) {
    const W = it.w, D = it.h;
    st.ridge = W > D ? 'EW' : W < D ? 'NS' : bit(16) ? 'EW' : 'NS';
    st.hip = arch === 'cottage' && st.ridge === 'EW' && W > D && (h >>> 17) % 3 === 0;
  }
  st.porch = arch === 'lodge' || ((arch === 'cottage' || arch === 'twostorey') && (h >>> 18) % 3 === 0);
  st.tone = ((h >>> 20) % 5 - 2) * 0.035; // roof lightness wobble: neighbours differ a touch
  st.props = (h >>> 22) & 0xff;
  return st;
}

/** A building's screen rect in view px relative to isoP(x0, y0), without drawing it: [x0, y0, x1, y1]. */
export function isoExtent(it, T) {
  const s = ISO, st = styleOf(it), W = it.w * T, D = it.h * T;
  return [-D * s - 8, -(st.H + st.R + 44), W * s + 8, (W + D) * s / 2 + 8];
}
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const cache = new Map();

/**
 * The building for item `it` (footprint it.x, it.y, it.w, it.h in tiles, look, village accent). `lit`:
 * its windows glow (its agent is in, or it is night). Returns { img, dx, dy, windows, door, ridge,
 * chimney, box }: img is drawn at isoP(x0, y0) + [dx, dy] in view px; the points and box are in view px
 * relative to isoP(x0, y0).
 */
export function isoBuilding(it, T, lit) {
  const site = it.kind === 'pr' && it.building;
  const k = `${it.id}|${it.look}|${it.w}|${it.h}|${it.village.accent}|${lit ? 1 : 0}|${site ? 'site' : ''}|${it.doorX}`;
  if (!cache.has(k)) { if (cache.size > 1500) cache.clear(); cache.set(k, make(it, T, lit, site)); }
  return cache.get(k);
}

function make(it, T, lit, site) {
  const s = ISO, W = it.w * T, D = it.h * T, st = styleOf(it);
  const H = st.H, R = st.R, e = st.e;
  const Q = (x, y, z = 0) => [(x - y) * s, (x + y) * s / 2 - z];
  const top = -(H + R + 44), left = Math.floor(-D * s) - 8, right = Math.ceil(W * s) + 8, bottom = Math.ceil((W + D) * s / 2) + 8;
  const w = right - left, h = bottom - top;
  const accent = rgb(it.village.accent);
  // Roofs carry the neighbourhood's accent (so a project's houses match), warmed toward an earthy tone
  // so they sit a value step below the status badges; workshops get a cooler slate of the same hue.
  let RB = st.pr ? mix(mix(accent, rgb('#4f5568'), 0.45), SHADE, 0.06) : mix(accent, rgb('#6a3d2c'), 0.22);
  if (st.roof === 'thatch') RB = mix(rgb('#d2aa5e'), accent, 0.1);
  if (st.roof === 'slate' && !st.pr) RB = mix(mix(accent, rgb('#4a5670'), 0.5), SHADE, 0.05);
  RB = jit(RB, st.tone);
  const TR = ramp(st.trim), DOOR = ramp(st.doorC), SHU = ramp(st.shutter), FOOT = ramp(STONE);
  const faces = [];
  const keyS = (x, y, z) => y * s - z, keyE = (x, y, z) => x * s - z; // Y − X/2 and Y + X/2 of a point
  // A planar face: its 3D outline, how its texture rows run (along x: 'S'; along y: 'E') and its material.
  const face = (pts, dir, mat, extra = {}) => {
    const [a, b, c] = pts, u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const key = dir === 'S' ? keyS : keyE, zs = pts.map(p => p[2]), lo = pts[zs.indexOf(Math.min(...zs))], hi = pts[zs.indexOf(Math.max(...zs))];
    const k0 = key(...lo), k1 = key(...hi);
    faces.push({ pts, n, c: n[0] * a[0] + n[1] * a[1] + n[2] * a[2], dir, mat, k0, sgn: k1 > k0 ? 1 : -1, rmax: Math.abs(k1 - k0), scr: pts.map(p => Q(...p)), ...extra });
  };
  const lightOf = N => N[0] * L[0] + N[1] * L[1] + N[2] * L[2];
  const byLight = (rp, N, bias = 0) => { const d = lightOf(N) + bias; return d > 0.62 ? rp[3] : d > 0.25 ? rp[2] : d > -0.15 ? rp[1] : rp[0]; };

  // ---------- wall textures ----------
  // A wall texture at (col, z): col is whole screen px from the wall's left end, z is height in px.
  const FOOT_H = 4;
  const P = ramp(st.paint);
  const wallTex = (tex, col, zi, cols, gable) => {
    switch (tex) {
      case 'clap': { // clapboard: 3-px boards, a lit top edge, a shadow line under each board's lap
        const r = ((zi - FOOT_H) % 3 + 3) % 3, row = Math.floor((zi - FOOT_H) / 3);
        let c = r === 0 ? P[1] : r === 2 ? lt(st.paint, 0.1) : P[2];
        const joint = (col + row * 11) % 17 === 0;
        if (joint && r !== 0) c = dk(st.paint, 0.2);
        else if (r !== 0 && h2(col, zi, st.seed) % 29 === 0) c = dk(st.paint, 0.12); // grain speck
        return c;
      }
      case 'shingleWall': { // cedar shakes on an upper floor: short staggered shingles
        const r = ((zi - FOOT_H) % 4 + 4) % 4, row = Math.floor((zi - FOOT_H) / 4), u = col + (row & 1) * 2;
        let c = jit(st.paint, ((h2(row, u >> 2, st.seed) % 5) - 2) * 0.04);
        if (r === 0) c = dk(c, 0.32); else if (u % 4 === 0) c = dk(c, 0.2); else if (r === 3) c = lt(c, 0.1);
        return c;
      }
      case 'logs': { // stacked logs with a rounded profile, log ends at the corners
        const r = ((zi - FOOT_H) % 4 + 4) % 4, base = st.paint;
        if (col <= 2 || col >= cols - 3) { // the crossed log ends: rings
          const end = rgb('#d7b07a');
          return r === 0 ? dk(base, 0.5) : (col === 1 || col === cols - 2) && (r === 1 || r === 2) ? dk(end, 0.25) : r === 3 ? lt(end, 0.15) : end;
        }
        let c = r === 0 ? dk(base, 0.45) : r === 1 ? dk(base, 0.12) : r === 2 ? base : lt(base, 0.18);
        if (r !== 0 && h2(col >> 1, zi, st.seed) % 23 === 0) c = dk(c, 0.15);
        return c;
      }
      case 'stone': { // fieldstone: rounded stones, each lit on its top edge, dark mortar
        const row = Math.floor((zi - FOOT_H) / 4), r = ((zi - FOOT_H) % 4 + 4) % 4, wv = 5 + (h2(row, 0, st.seed) % 3), u = col + row * 3;
        const cell = Math.floor(u / wv), cc = u - cell * wv, base = jit(rgb('#b3aa9a'), ((h2(row, cell, st.seed) % 5) - 2) * 0.05);
        if (r === 0 || cc === 0) return dk(base, 0.42);
        if (r === 3 && cc > 1) return lt(base, 0.2);
        if (cc === wv - 1 || r === 1) return dk(base, 0.12);
        return base;
      }
      case 'brick': {
        const row = Math.floor((zi - FOOT_H) / 3), r = ((zi - FOOT_H) % 3 + 3) % 3, off = (row % 2) * 3, base = jit(rgb('#b8644a'), ((h2(row, (col + off) / 6 | 0, st.seed) % 5) - 2) * 0.05);
        if (r === 0 || (col + off) % 6 === 0) return rgb('#d6c3ad');
        return r === 2 ? lt(base, 0.12) : base;
      }
      case 'boards': { // board-and-batten (gable ends)
        const c = st.lower === 'logs' ? rgb('#a87447') : mix(st.paint, WOOD, 0.35);
        return col % 4 === 0 ? dk(c, 0.3) : col % 4 === 1 ? lt(c, 0.12) : c;
      }
      default: { // plaster between timber frame
        let c = P[2];
        if (h2(col, zi, st.seed) % 19 === 0) c = dk(c, 0.06);
        else if (h2(col + 7, zi, st.seed) % 31 === 0) c = lt(c, 0.25);
        return c;
      }
    }
  };
  // Timber framing over plaster: rails, posts every so often and a brace in each panel.
  const timber = (col, zi, z0, z1, cols) => {
    if (zi === z0 || zi === z0 + 1 || zi >= z1 - 1) return true;
    const p = col % 12;
    if (p === 0 || p === 1) return true;
    const rel = (zi - z0) / Math.max(1, z1 - z0 - 1);
    if (cols > 20 && p > 1 && Math.abs((p - 2) / 9 - rel) < 0.09 && Math.floor(col / 12) % 2 === 0) return true;
    return false;
  };

  // ---------- fittings painted over walls ----------
  const fittings = [];
  const win = (face, cc, z0, wd = 7, ht = 8, round = false) => fittings.push({ face, kind: round ? 'round' : 'win', c0: cc - (wd >> 1), c1: cc - (wd >> 1) + wd - 1, z0, z1: z0 + ht - 1 });
  const glass = (col, zi, f) => { // panes: a diagonal sky reflection by day, warm light at night
    const dx = col - f.c0, dz = f.z1 - zi, diag = (dx + dz) % 7;
    if (lit) { const cx = (f.c0 + f.c1) / 2, cz = (f.z0 + f.z1) / 2, d = Math.abs(col - cx) / (f.c1 - f.c0 + 1) + Math.abs(zi - cz) / (f.z1 - f.z0 + 1); return [d < 0.25 ? LIT[4] : d < 0.45 ? LIT[3] : LIT[2], 1]; }
    return [diag === 2 || diag === 3 ? GLASS[4] : dz <= 1 ? GLASS[0] : dx <= 1 ? GLASS[1] : GLASS[2], 0];
  };
  const paintFitting = (f, col, zi) => {
    if (f.kind === 'round') {
      const cx = (f.c0 + f.c1) / 2, cz = (f.z0 + f.z1) / 2, d = (col - cx) ** 2 + (zi - cz) ** 2, r = (f.c1 - f.c0) / 2 + 0.5;
      if (d > r * r) return null;
      if (d > (r - 1.3) ** 2) return [TR[d > (r - 0.6) ** 2 ? 1 : 3], 0];
      if (Math.abs(col - cx) < 0.6 || Math.abs(zi - cz) < 0.6) return [TR[2], 0];
      return glass(col, zi, f);
    }
    if (f.kind === 'win') {
      const { c0, c1, z0, z1 } = f, mid = (c0 + c1) >> 1;
      if (zi === z1 + 1 && col >= c0 - 1 && col <= c1 + 1) return [TR[1], 0]; // lintel
      if (zi === z0 - 1 && col >= c0 - 1 && col <= c1 + 1) return [TR[3], 0]; // sill
      if (zi === z0 - 2 && col >= c0 - 1 && col <= c1 + 1 && !st.flowers) return [dk(TR[1], 0.2), 0]; // the sill's shadow
      if (st.flowers && col >= c0 - 1 && col <= c1 + 1) { // a window box, flowers spilling over its lip
        if (zi === z0 - 2) { const k = h2(col, f.z0, st.seed); return [k % 3 === 0 ? dk(LEAF, 0.2) : k % 3 === 1 ? LEAF : FLOWERS[(k >>> 4) % FLOWERS.length], 0]; }
        if (zi === z0 - 3) return [col === c0 - 1 || col === c1 + 1 ? dk(WOOD, 0.3) : lt(WOOD, 0.1), 0];
        if (zi === z0 - 4) return [dk(WOOD, 0.25), 0];
      }
      if (st.shutters && zi >= z0 && zi <= z1 && (col === c0 - 3 || col === c0 - 2 || col === c1 + 2 || col === c1 + 3)) {
        const outer = col === c0 - 3 || col === c1 + 3;
        return [outer ? SHU[1] : (zi - z0) % 2 ? SHU[2] : SHU[1], 0]; // louvred shutters
      }
      if (col < c0 || col > c1 || zi < z0 || zi > z1) return null;
      if (col === c0 || col === c1 || zi === z0 || zi === z1) return [col === c0 || zi === z1 ? TR[3] : TR[1], 0]; // frame, lit top-left
      if (col === mid || zi === ((z0 + z1) >> 1)) return [TR[2], 0]; // mullions
      return glass(col, zi, f);
    }
    if (f.kind === 'door') {
      const { c0, c1, z1, dbl, barn } = f; // the leaf is c0..c1 by 0..z1; the frame goes round it
      if (col < c0 - 1 || col > c1 + 1 || zi < 0 || zi > z1 + 1) return null;
      if (!barn && ((zi === z1 + 1 && (col <= c0 || col >= c1)) || (zi === z1 && (col === c0 - 1 || col === c1 + 1)))) return null; // a rounded head
      if (col === c0 - 1 || col === c1 + 1 || zi === z1 + 1 || (!barn && zi === z1 && (col === c0 || col === c1))) return [col === c0 - 1 || zi === z1 + 1 ? TR[3] : TR[1], 0];
      if (col === c0 || col === c1 || zi === z1) return [DOOR[0], 0]; // the reveal's shadow
      const mid = (c0 + c1) >> 1;
      if (barn) { // barn doors: a frame, an X brace on each leaf, planks between
        if (col === mid) return [DOOR[0], 0];
        const leaf0 = col < mid ? c0 + 1 : mid + 1, lw = col < mid ? mid - c0 - 2 : c1 - mid - 2, u = (col - leaf0) / Math.max(1, lw), v = (zi - 1) / Math.max(1, z1 - 2);
        if (zi === 1 || zi === z1 - 1 || col === leaf0 || col === leaf0 + lw) return [DOOR[3], 0];
        if (Math.abs(u - v) < 0.17 || Math.abs(u + v - 1) < 0.17) return [DOOR[3], 0];
        return [(col - leaf0) % 2 ? DOOR[2] : DOOR[1], 0];
      }
      if (dbl && col === mid) return [DOOR[0], 0];
      if ((dbl ? [mid - 2, mid + 2] : [c1 - 2]).includes(col) && zi === Math.round(z1 * 0.45)) return [GOLD, 0];
      if (!dbl && zi >= z1 - 4 && zi <= z1 - 3 && col >= c0 + 2 && col <= c1 - 2) return glass(col, zi, { c0: c0 + 2, c1: c1 - 2, z0: z1 - 4, z1: z1 - 3 }); // a little light
      if (zi === Math.round(z1 * 0.3) || zi === Math.round(z1 * 0.7)) return [DOOR[1], 0]; // ledges
      if (zi < 1) return [DOOR[0], 0];
      return [(col - c0) % 2 ? DOOR[2] : DOOR[3], 0];
    }
    if (f.kind === 'lamp') { // a wall lantern on a bracket
      const { c0, z0 } = f;
      if (zi === z0 + 6 && col >= c0 - 1 && col <= c0 + 1) return [dk(DARKWOOD, 0.3), 0]; // bracket arm
      if (col < c0 || col > c0 + 2 || zi < z0 || zi > z0 + 5) return null;
      if (zi === z0 + 5 || zi === z0 || col !== c0 + 1) return [zi === z0 + 5 ? dk(GOLD, 0.35) : dk(DARKWOOD, 0.4), 0];
      return [lit ? LIT[4] : rgb('#f0d08a'), lit ? 1 : 0];
    }
    if (f.kind === 'sign') { // a hanging board in the accent: a finished PR (a guild workshop)
      const { c0, z0 } = f;
      if (zi === z0 + 8 && col >= c0 - 1 && col <= c0 + 7) return [dk(DARKWOOD, 0.3), 0]; // the arm
      if (col < c0 || col > c0 + 6 || zi < z0 || zi > z0 + 7) return null;
      if (zi >= z0 + 6) return col === c0 + 1 || col === c0 + 5 ? [dk(DARKWOOD, 0.4), 0] : null; // the chains
      if (zi === z0 || zi === z0 + 5 || col === c0 || col === c0 + 6) return [dk(accent, 0.5), 0];
      if (zi === z0 + 4) return [lt(accent, 0.2), 0];
      return [(zi === z0 + 2 && col >= c0 + 2 && col <= c0 + 4) ? lt(accent, 0.7) : accent, 0];
    }
    if (f.kind === 'banner') { // a hanging banner in the accent (the lodge)
      const { c0, z0 } = f;
      if (col < c0 || col > c0 + 4 || zi < z0 || zi > z0 + 11) return null;
      if (zi === z0 + 11) return [dk(DARKWOOD, 0.3), 0];
      if (zi < z0 + 2 && (col === c0 + 2 || (zi === z0 && col !== c0 + 2))) return zi === z0 + 1 ? [dk(accent, 0.3), 0] : null; // a swallowtail
      if (col === c0 || col === c0 + 4) return [dk(accent, 0.3), 0];
      return [zi === z0 + 7 && col === c0 + 2 ? GOLD : col === c0 + 1 ? lt(accent, 0.15) : accent, 0];
    }
    return null;
  };
  // A wall face's material: texture by floor, timber posts, the stone foundation, fittings, eave shadow.
  const wallMat = (name, cols, shade, opt = {}) => (q) => {
    const { col, z } = q, zi = Math.floor(z), Hw = opt.H ?? H;
    let c, g = 0;
    for (const f of fittings) if (f.face === name) { const p = paintFitting(f, col, zi); if (p) { c = p[0]; g = p[1]; break; } }
    if (!c) {
      if (opt.gable) c = wallTex(st.lower === 'logs' ? 'logs' : 'boards', col, zi, cols, true);
      else if (zi < FOOT_H) { // the stone foundation course: rounded stones, a dark base where it meets the ground
        const u = col + 600, cell = Math.floor(u / 6), cc = u - cell * 6, b = jit(FOOT[2], ((h2(cell, 0, st.seed) % 5) - 2) * 0.06);
        c = zi === 0 || cc === 0 ? FOOT[0] : zi === 3 ? (cc === 1 ? b : lt(b, 0.22)) : zi === 1 ? dk(b, 0.14) : b;
      } else {
        const upper = zi >= st.split, tex = upper ? st.upper : st.lower;
        if (tex === 'timber' && timber(col, zi, upper ? st.split : FOOT_H, upper ? Hw : Math.min(st.split, Hw), cols)) c = col % 12 === 0 ? lt(BEAM, 0.12) : BEAM; // dark oak beams
        else c = wallTex(tex, col, zi, cols);
        if (zi === st.split || zi === st.split - 1) c = zi === st.split ? TR[3] : TR[1]; // the belt course between floors
        if (zi === FOOT_H) c = dk(c, 0.18); // contact shade on the foundation
        // Corner posts (not on log walls: the log ends do that).
        if (st.lower !== 'logs' && tex !== 'stone' && tex !== 'brick' && (col <= 1 || col >= cols - 2)) c = col === 0 || col === cols - 2 ? TR[3] : TR[1];
        if ((tex === 'stone' || tex === 'brick') && (col === 0 || col === cols - 1)) c = dk(c, 0.15);
      }
    }
    if (!g && opt.awn && col >= opt.awn[0] && col <= opt.awn[1] && zi >= opt.awn[2] - 4 && zi < opt.awn[2]) c = dk(c, 0.28); // under the porch roof
    if (!g && opt.eave && zi >= Hw - 6) c = dk(c, zi >= Hw - 3 ? 0.38 : 0.24); // shadow under the eaves
    return g ? [c, g] : [dk(c, shade), 0];
  };

  // ---------- roof materials ----------
  // u: screen px along the eave; r: screen rows up from the eave; rmax: rows at the ridge.
  const roofTex = (mat, u, r, rmax, base) => {
    const seed = st.seed;
    if (mat === 'shingle') { // chunky rounded shingles: a lit lip on each course, shadowed under the next
      const C = 4, Wd = 6, course = Math.floor(r / C), rr = r - course * C, uu = Math.floor(u) + (course & 1) * 3 + 600, cell = Math.floor(uu / Wd), cc = uu - cell * Wd;
      let c = jit(base, ((h2(course, cell, seed) % 5) - 2) * 0.035);
      if (rr < 1) c = cc === 0 || cc === Wd - 1 ? dk(c, 0.42) : lt(c, 0.24);
      else if (cc === 0) c = dk(c, 0.36);
      else if (rr < 2) c = lt(c, 0.06);
      else if (rr >= 3) c = dk(c, 0.2);
      if (h2(uu, Math.floor(r), seed) % 47 === 0) c = lt(c, 0.18);
      return c;
    }
    if (mat === 'tile') { // barrel tiles: rounded channels, a bright lip on every course
      const C = 5, course = Math.floor(r / C), rr = r - course * C, uu = Math.floor(u) + 600, cc = uu % 5;
      let c = jit(base, ((h2(course, uu / 5 | 0, seed) % 5) - 2) * 0.03);
      c = cc === 0 ? dk(c, 0.34) : cc === 1 ? lt(c, 0.26) : cc === 2 ? lt(c, 0.1) : cc === 4 ? dk(c, 0.12) : c;
      if (rr < 1) c = cc === 0 ? dk(c, 0.3) : lt(c, 0.2);
      else if (rr >= 4) c = dk(c, 0.22);
      return c;
    }
    if (mat === 'slate') { // thin staggered slates, cool and varied
      const C = 3, course = Math.floor(r / C), rr = r - course * C, uu = Math.floor(u) + (course % 3) * 2 + 600, cell = Math.floor(uu / 5), cc = uu - cell * 5;
      const v = h2(course, cell, seed) % 9;
      let c = jit(base, (v - 4) * 0.025);
      if (v === 0) c = mix(c, rgb('#6f86a6'), 0.2);
      if (cc === 0) c = dk(c, 0.34); else if (rr < 1) c = lt(c, 0.2); else if (rr >= 2) c = dk(c, 0.15);
      return c;
    }
    // thatch: layered bundles, each with a ragged lit lip and a shadow under the next; straw streaks
    const C = 4, course = Math.floor(r / C), rr = r - course * C, uu = Math.floor(u) + 600 + course * 2;
    const streak = h2(uu, course, seed) % 6, gap = h2(Math.floor(uu / 3), course, seed + 9) % 4 === 0 && uu % 3 === 0;
    let c = streak === 0 ? dk(base, 0.14) : streak === 1 ? lt(base, 0.14) : base;
    if (rr < 1) c = gap ? dk(base, 0.42) : lt(base, 0.3);
    else if (rr < 2) c = gap ? dk(base, 0.2) : lt(c, 0.12);
    else if (rr >= 3) c = dk(c, 0.26);
    return c;
  };
  // A roof face: the courses, a fascia board along the eave, barge boards up the gables, a ridge cap.
  const roofMat = (shade, edge, along = 'x', opt = {}) => (q) => {
    const { row: r, rmax, P } = q, mat = opt.mat ?? st.roof, base = opt.base ?? RB;
    const u = along === 'x' ? P[0] * s : -P[1] * s;
    let c;
    if (edge && edge(P)) c = st.hall ? (edge(P, 0.6) ? dk(GOLD, 0.2) : GOLD) : (edge(P, 0.6) ? TR[1] : TR[3]); // barge board
    else if (mat === 'thatch' && r < 2.5) c = r < 1 ? dk(base, 0.5) : h2(Math.floor(u), 1, st.seed) % 2 ? dk(base, 0.25) : lt(base, 0.1); // the thick, ragged eave
    else if (!opt.noCap && r > rmax - 3) { // ridge cap
      const rr = rmax - r;
      c = mat === 'thatch' ? (rr < 1.5 ? lt(base, 0.05) : dk(base, 0.3)) : rr < 1 ? lt(base, 0.32) : rr < 2 ? (Math.floor(u + 600) % 6 === 0 ? dk(base, 0.25) : lt(base, 0.08)) : dk(base, 0.38);
    } else c = roofTex(mat, u, r + 1, rmax, base);
    return [dk(c, shade), 0];
  };

  // ---------- solids ----------
  function box(x0, x1, y0, y1, z0, z1, mS, mE, mT) {
    face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], 'S', mS);
    face([[x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1]], 'E', mE);
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 'S', mT);
  }
  const flat = c => () => [c, 0];
  const cyl = (cx, cy, r, z0, z1, mat) => faces.push({ cyl: [cx, cy, r, z0, z1], mat });
  const ball = (cx, cy, cz, r, mat) => faces.push({ sphere: [cx, cy, cz, r], mat });
  // A barrel: staves lit by their facing, two hoops, a lid.
  const barrel = (x, y) => cyl(x, y, 2.6, 0, 7, q => {
    if (q.cap) { const d = Math.hypot(q.P[0] - x, q.P[1] - y); return [d > 1.9 ? dk(WOOD, 0.35) : h2(Math.floor(q.P[0] * 2), 0, 1) % 2 ? WOOD : lt(WOOD, 0.1), 0]; }
    const zi = Math.floor(q.z), hoop = zi === 1 || zi === 5;
    const c = byLight(ramp(hoop ? rgb('#6b6a72') : WOOD), q.N, 0.15);
    return [Math.floor(q.ang * 8) % 2 && !hoop ? dk(c, 0.1) : c, 0];
  });
  const crate = (x, y, sz = 5) => {
    const m = sh => q => { const zi = Math.floor(q.z), c = q.col <= 0 || q.col >= sz - 1 || zi <= 0 || zi >= sz - 1 ? DARKWOOD : zi % 2 ? WOOD : lt(WOOD, 0.12); return [dk(c, sh), 0]; };
    box(x, x + sz * 1.25, y, y + sz * 1.25, 0, sz, m(0), m(0.22), q => [((Math.floor(q.P[0]) + Math.floor(q.P[1])) % 3 === 0) ? dk(WOOD, 0.1) : lt(WOOD, 0.2), 0]);
  };
  const pot = (x, y, flowers) => {
    cyl(x, y, 2, 0, 3.5, q => [q.cap ? dk(SOIL, 0.3) : byLight(ramp(POT), q.N, 0.1), 0]);
    ball(x, y, 6, 3, q => { const k = h2(Math.floor(q.P[0] * 1.6), Math.floor(q.P[2] * 1.6), st.seed); if (flowers && k % 6 === 0 && lightOf(q.N) > 0) return [FLOWERS[(k >>> 5) % FLOWERS.length], 0]; return [byLight(ramp(LEAF), q.N, k % 4 === 0 ? 0.25 : 0), 0]; });
  };
  const bush = (x, y, r) => ball(x, y, r * 0.7, r, q => { const k = h2(Math.floor(q.P[0] * 1.4), Math.floor(q.P[2] * 1.4), st.seed + 3); if (k % 9 === 0 && lightOf(q.N) > 0.1) return [FLOWERS[(k >>> 5) % FLOWERS.length], 0]; return [byLight(ramp(dk(LEAF, 0.05)), q.N, k % 3 === 0 ? 0.2 : 0), 0]; });
  // The soft contact shadow and ambient occlusion round the footprint, falling east (away from the light).
  const groundShadow = () => face([[-1.5, -1.5, 0], [W + 5, -1.5, 0], [W + 5, D + 3.5, 0], [-1.5, D + 3.5, 0]], 'S', q => {
    const [x, y] = q.P, ex = x - W, sy = y - D;
    let a = 0;
    if (ex > 0 && y > -1 && y < D + 2) a = ex < 1.5 ? 0.42 : ex < 3.2 ? 0.28 : 0.14; // the east side, in its own shade
    if (sy > 0 && x < W + 2) a = Math.max(a, sy < 1.3 ? 0.36 : sy < 2.6 ? 0.2 : 0);
    if (x < 0 || y < 0) a = Math.max(a, 0.18);
    return [SHADE, 0, a];
  }, { soft: true });

  // The roof's thickness: a fascia board under each eave you can see, and barge boards up each gable
  // you can see (gold on the lodge). These are what make the roof read as chunky rather than paper.
  const TH = 2;
  const board = (sh, gold) => q => { const zi = Math.floor(q.z), rr = q.row; const rp = gold ? ramp(GOLD) : TR; return [dk(rr > TH - 1.2 ? rp[3] : rp[2], sh), 0]; };
  const fasciaS = (x0, x1, y, z, sh = 0) => st.roof !== 'thatch' && face([[x0, y, z - TH], [x1, y, z - TH], [x1, y, z], [x0, y, z]], 'S', board(sh));
  const fasciaE = (x, y0, y1, z, sh = 0.3) => st.roof !== 'thatch' && face([[x, y1, z - TH], [x, y0, z - TH], [x, y0, z], [x, y1, z]], 'E', board(sh));
  // A gable rake strip in the plane x = X (dir 'E') or y = Y (dir 'S'), from eave a to ridge m to eave b.
  const rake = (dir, pts, sh) => { for (let i = 0; i < pts.length - 1; i++) { const [a, b] = [pts[i], pts[i + 1]]; face([[...a.slice(0, 2), a[2] - TH], [...b.slice(0, 2), b[2] - TH], b, a], dir, board(sh, st.hall)); } };
  // ---------- geometry ----------
  const out = { windows: [], door: null, ridge: null, chimney: null, finial: null };
  const colsS = Math.round(W * s), colsE = Math.round(D * s);
  if (site) buildSite();
  else {
    groundShadow();
    const doorU = Math.min(W - 8, Math.max(8, it.doorX ?? W / 2)), dc = Math.round(doorU * s);
    const barn = st.arch === 'workshop';
    const dh = st.hall ? 18 : barn ? 16 : st.arch === 'hut' ? 10 : 13, dw = st.hall ? 11 : barn ? 15 : 7;
    fittings.push({ face: 'S', kind: 'door', c0: dc - (dw >> 1), c1: dc - (dw >> 1) + dw - 1, z1: dh, dbl: st.hall, barn });
    out.door = Q(doorU, D, 0);
    const lampR = st.lamp || st.hall;
    if (lampR) fittings.push({ face: 'S', kind: 'lamp', c0: dc + (dw >> 1) + 3, z0: dh - 7 });
    if (st.hall) fittings.push({ face: 'S', kind: 'lamp', c0: dc - (dw >> 1) - 5, z0: dh - 7 });
    if (st.sign) fittings.push({ face: 'S', kind: 'sign', c0: dc + (dw >> 1) + 3, z0: dh - 8 });
    // Windows along each wall, spaced evenly in the stretches the door (and its lamp or sign) leave free;
    // two-storey buildings get a second row.
    const towerish = st.arch === 'tower', wd = towerish ? 5 : 7, ht = towerish ? 7 : st.arch === 'hut' ? 6 : 8, pad = st.shutters ? 6 : 4;
    const rows = towerish ? [8, 19] : st.split < 99 ? [7, st.split + 3] : [st.arch === 'hut' ? 6 : 7];
    const fill = (a, b) => { const len = b - a, n = len < wd + 2 ? 0 : Math.max(1, Math.floor((len + 4) / (wd + (st.shutters ? 6 : 0) + 7))); return Array.from({ length: n }, (_, i) => Math.round(a + len * (i + 0.5) / n)); };
    const gapL = dc - (dw >> 1) - (st.hall ? 8 : 3), gapR = dc + (dw >> 1) + (lampR || st.sign ? 11 : 3);
    for (const z0 of rows) {
      const nearDoor = z0 < dh + 3;
      const sCols = st.hall && nearDoor ? [7, colsS - 8] : nearDoor ? [...fill(pad, gapL - pad), ...fill(gapR + pad, colsS - pad)] : fill(pad, colsS - pad);
      for (const c of sCols) win('S', c, z0, wd, ht);
      for (const c of fill(pad, colsE - pad)) win('E', c, z0, wd, ht);
    }
    if (st.hall) { // banners between the upper windows
      fittings.push({ face: 'S', kind: 'banner', c0: 4, z0: st.split + 5 }, { face: 'S', kind: 'banner', c0: colsS - 9, z0: st.split + 5 });
    }
    for (const f of fittings) if (f.kind === 'win') {
      const cc = (f.c0 + f.c1) / 2, zc = (f.z0 + f.z1) / 2;
      out.windows.push(f.face === 'S' ? Q(cc / s, D, zc) : Q(W, D - cc / s, zc));
    }
    // A porch roof over the door on some houses (and the lodge): a little shed roof on two posts.
    let awn = null;
    if (st.porch) {
      const half = st.hall ? 11 : 7, x0 = doorU - half, x1 = doorU + half, zt = dh + 5, zb = dh + 2, dep = st.hall ? 7 : 6;
      awn = [Math.round(x0 * s), Math.round(x1 * s), zt];
      face([[x0, D + dep, zb], [x1, D + dep, zb], [x1, D, zt], [x0, D, zt]], 'S', roofMat(-0.06, null, 'x', { noCap: true, mat: st.roof === 'thatch' ? 'shingle' : st.roof }));
      face([[x1, D + dep, zb], [x1, D, zt], [x1, D, zb]], 'E', flat(dk(TR[1], 0.2))); // its side
      const post = px => box(px - 0.8, px + 0.8, D + dep - 1.6, D + dep, 0, zb, q => [q.col === 0 ? TR[3] : TR[2], 0], flat(TR[1]), flat(TR[3]));
      post(x0 + 1); post(x1 - 1);
    }
    // Walls.
    const eaveS = st.roofShape !== 'gable' || st.ridge === 'EW', eaveE = st.roofShape !== 'gable' || st.ridge === 'NS';
    face([[0, D, 0], [W, D, 0], [W, D, H], [0, D, H]], 'S', wallMat('S', colsS, 0, { eave: eaveS, awn }), { col0: -D * s });
    face([[W, D, 0], [W, 0, 0], [W, 0, H], [W, D, H]], 'E', wallMat('E', colsE, 0.3, { eave: eaveE }), { col0: (W - D) * s });
    // The step in front of the door, and a doormat.
    const sw = st.hall ? 8 : barn ? 9 : 5;
    const stone = (sh) => q => { const k = h2(Math.floor(q.P[0] / 3), 0, st.seed); return [dk(jit(FOOT[2], (k % 3 - 1) * 0.06), sh), 0]; };
    box(doorU - sw, doorU + sw, D, D + (st.hall ? 7 : 3), 0, 2, stone(0.05), stone(0.3), q => [Math.floor(q.P[0] * s) % 5 === 0 ? FOOT[1] : FOOT[3], 0]);
    if (st.hall) box(doorU - sw + 2, doorU + sw - 2, D, D + 3.5, 2, 4, stone(0), stone(0.28), flat(FOOT[3]));
    if (!barn) { const mw = st.hall ? 5 : 3.5, mz = st.hall ? 4 : 2; box(doorU - mw, doorU + mw, D + 0.3, D + 2.6, mz, mz + 0.5, flat(dk(accent, 0.45)), flat(dk(accent, 0.5)), q => [Math.floor(q.P[0] * s) % 2 ? dk(mix(accent, rgb('#c9a070'), 0.5), 0.2) : mix(accent, rgb('#c9a070'), 0.5), 0]); }
    props(doorU, sw);
    if (st.roofShape === 'gable') gableRoof();
    else if (st.roofShape === 'spire') { const ap = [W / 2, D / 2, H + R + 8]; pyramid(-e, W + e, -e, D + e, H - e * 0.6, ap); out.ridge = Q(...ap); }
    else dome();
  }

  // Yard dressing in front of the house: a garden patch with a picket fence, a bench, barrels and crates,
  // potted plants by the door, a mailbox, a bush. Picked from the id; kept to the front strip (never
  // further out than a villager's yard row) and a few at a time, so the villagers stay the focus.
  function props(doorU, sw) {
    const p = st.props, zL = [3, doorU - sw - 5], zR = [doorU + sw + 5, W - 3];
    const room = z => z[1] - z[0];
    const used = [];
    const pick = (need) => { for (const z of [zR, zL]) if (!used.includes(z) && room(z) >= need) { used.push(z); return z; } return null; };
    if (st.arch === 'workshop' || st.arch === 'tower') {
      const z = pick(10); if (z) { barrel(z[1] - 3, D + 4); barrel(z[1] - 8.5, D + 3.4); crate(z[1] - 6, D + 0.5); }
      const z2 = pick(8); if (z2) { crate(z2[0], D + 1); if (p & 1) crate(z2[0] + 1, D + 1, 3.5); }
      return;
    }
    if (st.hall) {
      pot(doorU - sw - 3, D + 4, true); pot(doorU + sw + 3, D + 4, true);
      bush(4, D + 3, 3.2); bush(W - 4, D + 3, 3.2);
      return;
    }
    if (!st.porch && (p & 3) !== 0) { pot(doorU - sw - 2.5, D + 3, p & 4); if (p & 8) pot(doorU + sw + 2.5, D + 3, true); }
    if ((p >>> 4) % 3 === 0) { // a garden patch with a picket fence
      const z = pick(14);
      if (z) {
        const x0 = z[0], x1 = Math.min(z[1], x0 + 20), y0 = D + 1.5, y1 = D + 7.5;
        box(x0, x1, y0, y1, 0, 0.8, flat(dk(SOIL, 0.2)), flat(dk(SOIL, 0.35)), q => {
          const row = Math.floor((q.P[1] - y0) / 2), k = h2(Math.floor(q.P[0] * s), row, st.seed);
          if ((q.P[1] - y0) % 2 < 0.9) return [dk(SOIL, 0.25), 0];
          return [k % 3 === 0 ? lt(LEAF, 0.15) : k % 3 === 1 ? LEAF : lt(SOIL, 0.1), 0];
        });
        const pk = q => [Math.floor(q.z) >= 3 ? lt(rgb('#f2ead8'), 0.1) : rgb('#e4d8bf'), 0];
        for (let x = x0; x <= x1; x += 2.6) box(x, x + 1.1, y1, y1 + 1.1, 0, 4, pk, flat(rgb('#b9ab92')), flat(rgb('#fff6e0')));
        box(x0, x1 + 1.1, y1 + 0.2, y1 + 0.9, 1.8, 2.6, flat(rgb('#d9ccb2')), flat(rgb('#b9ab92')), flat(rgb('#f2ead8')));
      }
    }
    if ((p >>> 6) % 2 === 0) { // a bench against the wall
      const z = pick(12);
      if (z) {
        const x0 = z[0] + 1, x1 = x0 + 10;
        box(x0, x1, D + 0.5, D + 3.5, 3, 4, flat(dk(WOOD, 0.15)), flat(dk(WOOD, 0.3)), q => [Math.floor(q.P[1]) % 2 ? lt(WOOD, 0.15) : WOOD, 0]);
        for (const x of [x0 + 0.5, x1 - 1.8]) box(x, x + 1.3, D + 2, D + 3.3, 0, 3, flat(DARKWOOD), flat(dk(DARKWOOD, 0.2)), flat(DARKWOOD));
      }
    }
    if ((p >>> 5) % 2 === 1) { const z = pick(8); if (z) { barrel(z[1] - 3, D + 4); if (p & 2) crate(z[1] - 9, D + 1, 4); } }
    if ((p >>> 7) === 1 && doorU + 12 < W - 2 && !used.includes(zR)) { // a mailbox by the path
      const x = doorU + 11, y = D + 6.5;
      box(x - 0.6, x + 0.6, y - 0.6, y + 0.6, 0, 6, flat(WOOD), flat(dk(WOOD, 0.3)), flat(WOOD));
      box(x - 1.6, x + 1.6, y - 2.2, y + 1.2, 6, 8.5, flat(dk(accent, 0.1)), flat(dk(accent, 0.35)), flat(lt(accent, 0.2)));
    }
    if (!used.length) { const z = pick(6); if (z) bush(z === zL ? z[0] + 3 : z[1] - 3, D + 3, 2.8); }
  }
  function pyramid(x0, x1, y0, y1, z0, ap) {
    face([[x0, y1, z0], [x1, y1, z0], ap], 'S', roofMat(-0.04, null, 'x', { noCap: true }));
    face([[x1, y1, z0], [x1, y0, z0], ap], 'E', roofMat(0.18, null, 'y', { noCap: true }));
    face([[x0, y0, z0], [x1, y0, z0], ap], 'S', roofMat(0.3, null, 'x', { noCap: true }));
    face([[x0, y0, z0], [x0, y1, z0], ap], 'E', roofMat(0.3, null, 'y', { noCap: true }));
  }
  function dome() {
    const cx = W / 2, cy = D / 2, r = Math.min(W, D) / 2 + 2, z0 = H;
    // A flat stone roof with a parapet rim, the dome sitting on it.
    face([[-1, -1, H], [W + 1, -1, H], [W + 1, D + 1, H], [-1, D + 1, H]], 'S', q => [q.P[0] < 1 || q.P[1] < 1 || q.P[0] > W - 1 || q.P[1] > D - 1 ? FOOT[1] : FOOT[3], 0]);
    const DR = ramp(RB);
    ball(cx, cy, z0, r, q => {
      const zz = q.P[2] - z0, band = Math.floor(zz / 3), rib = Math.floor((q.ang * 12) % 12);
      let c = byLight(DR, q.N, 0.1);
      if (zz < 1.2) c = DR[0]; else if (Math.floor(zz) % 3 === 0) c = dk(c, 0.2); else if (rib % 3 === 0 && band % 2) c = dk(c, 0.1);
      return [c, 0];
    });
    out.ridge = Q(cx, cy, z0 + r);
  }
  // A roof over the box: a gable (ridge east–west or north–south, by the building's style) or a hip.
  function gableRoof() {
    const ridgeEW = st.ridge === 'EW';
    const half = (ridgeEW ? D : W) / 2, k = R / half, zr = H + R, zE = H - e * k;
    if (ridgeEW) {
      const ym = D / 2;
      const barge = (P, w = 1.1) => P[0] < -e + w || P[0] > W + e - w;
      if (st.hip) {
        const xa = half, xb = W - half;
        face([[-e, D + e, zE], [W + e, D + e, zE], [xb, ym, zr], [xa, ym, zr]], 'S', roofMat(-0.04, null, 'x'));
        face([[-e, -e, zE], [W + e, -e, zE], [xb, ym, zr], [xa, ym, zr]], 'S', roofMat(0.3, null, 'x'));
        face([[W + e, D + e, zE], [W + e, -e, zE], [xb, ym, zr]], 'E', roofMat(0.18, null, 'y', { noCap: true }));
        face([[-e, D + e, zE], [-e, -e, zE], [xa, ym, zr]], 'E', roofMat(0.32, null, 'y', { noCap: true }));
        out.ridge = Q(xb, ym, zr);
        fasciaS(-e, W + e, D + e, zE); fasciaE(W + e, -e, D + e, zE);
      } else {
        face([[-e, -e, zE], [W + e, -e, zE], [W + e, ym, zr], [-e, ym, zr]], 'S', roofMat(0.3, barge, 'x'));
        face([[W, 0, H], [W, D, H], [W, ym, zr]], 'E', wallMat('EG', colsE, 0.3, { gable: true }), { col0: (W - D) * s }); // the east gable end
        face([[-e, D + e, zE], [W + e, D + e, zE], [W + e, ym, zr], [-e, ym, zr]], 'S', roofMat(-0.04, barge, 'x'));
        fasciaS(-e, W + e, D + e, zE);
        rake('E', [[W + e, D + e, zE], [W + e, ym, zr], [W + e, -e, zE]], 0.3);
        out.ridge = Q(W * 0.72, ym, zr);
        if (H < 28 && colsE > 22) fittings.push({ face: 'EG', kind: 'round', c0: Math.round(colsE / 2) - 3, c1: Math.round(colsE / 2) + 3, z0: H + 3, z1: H + 9 });
      }
      if (st.chimney) chimney(W * (st.seed % 2 ? 0.22 : 0.7), D * 0.24, zr);
    } else {
      const xm = W / 2;
      const barge = (P, w = 1.1) => P[1] < -e + w || P[1] > D + e - w;
      face([[-e, -e, zE], [-e, D + e, zE], [xm, D + e, zr], [xm, -e, zr]], 'E', roofMat(0.3, barge, 'y'));
      face([[0, D, H], [W, D, H], [xm, D, zr]], 'S', wallMat('SG', colsS, 0, { gable: true }), { col0: -D * s }); // the south gable end
      face([[W + e, -e, zE], [W + e, D + e, zE], [xm, D + e, zr], [xm, -e, zr]], 'E', roofMat(0.16, barge, 'y'));
      fasciaE(W + e, -e, D + e, zE);
      rake('S', [[-e, D + e, zE], [xm, D + e, zr], [W + e, D + e, zE]], 0);
      out.ridge = Q(xm, D * 0.7, zr);
      if (st.hall) { // a round window high in the front gable, and a cupola with a gold finial on the ridge
        fittings.push({ face: 'SG', kind: 'round', c0: Math.round(colsS / 2) - 4, c1: Math.round(colsS / 2) + 4, z0: H + 5, z1: H + 13 });
        const cy = D * 0.45, zc = zr - 2;
        const WH = ramp(rgb('#efe3c6'));
        const louvre = (sh) => q => { const zi = Math.floor(q.z); return [dk(zi > zc + 2 && zi < zc + 7 && q.col > 1 && q.col < 5 ? ((zi % 2) ? WH[0] : WH[1]) : q.col === 0 ? WH[3] : WH[2], sh), 0]; };
        box(xm - 4, xm + 4, cy - 4, cy + 4, zr - 8, zc + 9, louvre(0), louvre(0.22), flat(WH[3]));
        const ap = [xm, cy, zc + 19];
        pyramid(xm - 6, xm + 6, cy - 6, cy + 6, zc + 9, ap);
        out.finial = Q(...ap);
        out.ridge = Q(xm, cy, zc + 24);
      } else {
        if (colsS > 22) fittings.push({ face: 'SG', kind: 'round', c0: Math.round(colsS / 2) - 3, c1: Math.round(colsS / 2) + 3, z0: H + 3, z1: H + 9 });
        if (st.chimney) chimney(W * 0.24, D * (st.seed % 2 ? 0.3 : 0.72), zr);
      }
    }
  }
  function chimney(x, y, zr) {
    const B = st.pr || st.hall || st.lower === 'stone' ? rgb('#9d9486') : rgb('#a95b3e'), z1 = zr + 5;
    const bricks = sh => q => {
      const zi = Math.floor(q.z), row = Math.floor(zi / 3), u = q.col + (row % 2) * 2;
      const c = zi % 3 === 0 || u % 4 === 0 ? dk(B, 0.28) : zi % 3 === 2 ? lt(B, 0.14) : B;
      return [dk(c, sh), 0];
    };
    box(x - 3, x + 3, y - 3, y + 3, H - 2, z1, bricks(0), bricks(0.24), flat(B));
    box(x - 4, x + 4, y - 4, y + 4, z1, z1 + 2, flat(lt(FOOT[2], 0.05)), flat(FOOT[1]), q => [q.P[0] > x - 2 && q.P[0] < x + 2 && q.P[1] > y - 2 && q.P[1] < y + 2 ? OUTLINE : FOOT[3], 0]); // the cap
    out.chimney = Q(x, y, z1 + 3);
  }
  // A building site: a stone foundation and plank floor, framed walls to a ragged half height (all four
  // show, the roof isn't on yet), with corner posts and a roof truss drawn over the top.
  function buildSite() {
    const hw = Math.round(H * 0.45), wood = rgb('#c98a4a'), raw = rgb('#dcb47c');
    const cut = col => hw - (h2(Math.floor(col / 3), 0, st.seed) % 5);
    groundShadow();
    box(-2, W + 2, -2, D + 2, 0, 3, q => [Math.floor(q.z) < 1 ? FOOT[0] : (q.col % 5 === 0 ? FOOT[1] : FOOT[2]), 0], q => [dk(Math.floor(q.z) < 1 ? FOOT[0] : FOOT[2], 0.2), 0], q => [(Math.floor(q.P[0] + q.P[1]) % 4 === 0) ? dk(raw, 0.25) : raw, 0]);
    const studs = sh => q => { const zi = Math.floor(q.z); const c = (q.col % 4 === 0 || zi === 4) ? dk(wood, 0.2) : (zi - 4) % 3 === 0 ? dk(raw, 0.15) : raw; return [dk(c, sh), 0]; };
    const keep = (P, col) => P[2] <= 3 + cut(col); // the ragged top: what isn't built yet is see-through
    face([[0, 0, 3], [W, 0, 3], [W, 0, 3 + hw], [0, 0, 3 + hw]], 'S', studs(0.12), { col0: 0, keep });
    face([[0, 0, 3], [0, D, 3], [0, D, 3 + hw], [0, 0, 3 + hw]], 'E', studs(0.3), { col0: -D * s, keep });
    face([[0, D, 3], [W, D, 3], [W, D, 3 + hw], [0, D, 3 + hw]], 'S', studs(0), { col0: -D * s, keep });
    face([[W, D, 3], [W, 0, 3], [W, 0, 3 + hw], [W, D, 3 + hw]], 'E', studs(0.2), { col0: (W - D) * s, keep });
    out.lines = [];
    const hi = H + 4, ym = D / 2;
    for (const [x, y] of [[0, 0], [W, 0], [0, D], [W, D]]) out.lines.push([[x, y, 3], [x, y, hi]]);
    out.lines.push([[0, D, hi], [W, D, hi]], [[W, D, hi], [W, 0, hi]], [[0, 0, hi], [W, 0, hi]], [[0, 0, hi], [0, D, hi]]);
    for (const x of [0, W / 2, W]) out.lines.push([[x, 0, hi], [x, ym, hi + R]], [[x, D, hi], [x, ym, hi + R]]);
    out.lines.push([[0, ym, hi + R], [W, ym, hi + R]]);
    out.ridge = Q(W / 2, ym, hi + R);
  }

  // ---------- rasterise ----------
  const N = w * h, depth = new Float32Array(N).fill(-Infinity), fid = new Int16Array(N).fill(-1);
  const d2 = 2 + s * s;
  faces.forEach((f, i) => {
    if (f.sphere || f.cyl) {
      const [cx, cy] = f.sphere || f.cyl, r = f.sphere ? f.sphere[3] : f.cyl[2];
      const zlo = f.sphere ? f.sphere[2] - r : f.cyl[3], zhi = f.sphere ? f.sphere[2] + r : f.cyl[4];
      const [X0, Y0] = Q(cx, cy, zlo), [, Y1] = Q(cx, cy, zhi);
      for (let py = Math.max(0, Math.floor(Y1 - r - top - 1)); py < Math.min(h, Math.ceil(Y0 + r - top + 1)); py++) for (let px = Math.max(0, Math.floor(X0 - r * 1.2 - left - 1)); px < Math.min(w, Math.ceil(X0 + r * 1.2 - left + 1)); px++) {
        const X = left + px + 0.5, Y = top + py + 0.5, gx = (X / s + 2 * Y / s) / 2, gy = (2 * Y / s - X / s) / 2;
        const ox = gx - cx, oy = gy - cy;
        let t = -Infinity;
        if (f.sphere) {
          const oz = -f.sphere[2], b = 2 * (ox + oy + s * oz), c = ox * ox + oy * oy + oz * oz - r * r, disc = b * b - 4 * d2 * c;
          if (disc < 0) continue;
          t = (-b + Math.sqrt(disc)) / (2 * d2);
          if (s * t < Math.max(0, f.sphere[2] - r * 0.15) && f.sphere[2] > r) continue;
          if (s * t < 0) continue;
        } else {
          const [, , , z0, z1] = f.cyl, tc = z1 / s; // the lid, then the side
          if ((ox + tc) ** 2 + (oy + tc) ** 2 <= r * r) t = tc;
          const disc = 4 * (ox + oy) ** 2 - 8 * (ox * ox + oy * oy - r * r);
          if (disc >= 0) { const ts = (-2 * (ox + oy) + Math.sqrt(disc)) / 4; if (s * ts >= z0 && s * ts <= z1 && ts > t) t = ts; }
          if (t === -Infinity) continue;
        }
        const j = py * w + px;
        if (t > depth[j]) { depth[j] = t; fid[j] = i; }
      }
      return;
    }
    const nd = f.n[0] + f.n[1] + f.n[2] * s;
    if (Math.abs(nd) < 1e-6) return;
    const xs = f.scr.map(p => p[0]), ys = f.scr.map(p => p[1]);
    const px0 = Math.max(0, Math.floor(Math.min(...xs) - left)), px1 = Math.min(w - 1, Math.ceil(Math.max(...xs) - left));
    const py0 = Math.max(0, Math.floor(Math.min(...ys) - top)), py1 = Math.min(h - 1, Math.ceil(Math.max(...ys) - top));
    f.left = Math.min(...xs);
    for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
      const X = left + px + 0.5, Y = top + py + 0.5;
      if (!inPoly(X, Y, f.scr)) continue;
      const gx = (X / s + 2 * Y / s) / 2, gy = (2 * Y / s - X / s) / 2;
      const t = (f.c - f.n[0] * gx - f.n[1] * gy) / nd;
      const j = py * w + px;
      if (t > depth[j] + 1e-4 && (!f.keep || f.keep([gx + t, gy + t, s * t], Math.floor(X - (f.col0 ?? f.left))))) { depth[j] = t; fid[j] = i; }
    }
  });
  // Paint each pixel with its surface's material.
  const col = new Uint8ClampedArray(N * 4), soft = new Uint8Array(N);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const j = py * w + px, i = fid[j];
    if (i < 0) continue;
    const f = faces[i], X = left + px + 0.5, Y = top + py + 0.5, t = depth[j];
    const gx = (X / s + 2 * Y / s) / 2, gy = (2 * Y / s - X / s) / 2, P = [gx + t, gy + t, s * t];
    // col: whole screen px from the face's left end; z: height; row: screen rows up from the face's eave.
    const q = { P, col: Math.floor(X - (f.col0 ?? f.left ?? 0)), z: P[2], row: f.sphere || f.cyl ? 0 : rowUp(f, X, Y), rmax: f.rmax };
    if (f.sphere) { const [cx, cy, cz, r] = f.sphere; q.N = [(P[0] - cx) / r, (P[1] - cy) / r, (P[2] - cz) / r]; q.ang = (Math.atan2(P[1] - cy, P[0] - cx) / (2 * Math.PI) + 1) % 1; }
    if (f.cyl) { const [cx, cy, r, , z1] = f.cyl; q.cap = P[2] >= z1 - 1e-3; q.N = q.cap ? [0, 0, 1] : [(P[0] - cx) / r, (P[1] - cy) / r, 0]; q.ang = (Math.atan2(P[1] - cy, P[0] - cx) / (2 * Math.PI) + 1) % 1; q.z = P[2]; }
    const [c, , a = 1] = f.mat(q);
    if (f.soft) { if (a <= 0) { fid[j] = -1; continue; } soft[j] = 1; }
    col[j * 4] = c[0]; col[j * 4 + 1] = c[1]; col[j * 4 + 2] = c[2]; col[j * 4 + 3] = Math.round(255 * a);
  }
  // Outline: round the silhouette (a dark tint of the colour it outlines), and a softer line wherever a
  // nearer face overlaps a farther one. Soft shadow pixels count as empty.
  const solid = j => fid[j] >= 0 && !soft[j];
  const ink = new Uint8Array(N);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const j = py * w + px;
    if (!solid(j)) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || !solid(y * w + x)) { ink[j] = 2; break; }
      const k = y * w + x;
      if (fid[k] !== fid[j] && depth[k] > depth[j] + 1.2) ink[j] = Math.max(ink[j], 1);
    }
  }
  for (let j = 0; j < N; j++) if (ink[j]) {
    const here = [col[j * 4], col[j * 4 + 1], col[j * 4 + 2]], c = ink[j] === 2 ? mix(here, OUTLINE, 0.74) : dk(here, 0.5);
    col[j * 4] = c[0]; col[j * 4 + 1] = c[1]; col[j * 4 + 2] = c[2];
  }
  const c = canvas(w, h), g = c.getContext('2d');
  g.putImageData(new ImageData(col, w, h), 0, 0);
  // Site timber: posts, beams and the truss as whole-pixel lines (outlined, then wood).
  if (out.lines) {
    const plot = (a, b, color, wd) => { const [x0, y0] = Q(...a), [x1, y1] = Q(...b), n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)))); g.fillStyle = color; for (let i = 0; i <= n; i++) g.fillRect(Math.round(x0 + (x1 - x0) * i / n - left) - (wd >> 1), Math.round(y0 + (y1 - y0) * i / n - top) - (wd >> 1), wd, wd); };
    for (const [a, b] of out.lines) plot(a, b, '#3a2418', 3);
    for (const [a, b] of out.lines) plot(a, b, '#d29454', 1);
  }
  if (out.finial) { const [x, y] = out.finial, X = Math.round(x - left), Y = Math.round(y - top); g.fillStyle = '#4a2f1a'; g.fillRect(X - 1, Y - 6, 3, 6); g.fillRect(X - 2, Y - 9, 5, 4); g.fillStyle = '#e9b949'; g.fillRect(X, Y - 6, 1, 5); g.fillRect(X - 1, Y - 8, 3, 2); g.fillStyle = '#fff1bf'; g.fillRect(X - 1, Y - 8, 1, 1); }
  // The tight box of what was drawn (hit testing, the selection outline).
  const im = g.getImageData(0, 0, w, h).data;
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) if (im[(py * w + px) * 4 + 3]) { if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py; }
  return { img: c, dx: left, dy: top, windows: out.windows, door: out.door, ridge: out.ridge, chimney: out.chimney, box: [left + bx0, top + by0, bx1 - bx0 + 1, by1 - by0 + 1], style: st };
}

// Screen rows up a face from its lowest edge (walls: height in px; roofs: courses up from the eave).
function rowUp(f, X, Y) {
  const key = f.dir === 'S' ? Y - X / 2 : Y + X / 2;
  return f.sgn * (key - f.k0);
}
function inPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
