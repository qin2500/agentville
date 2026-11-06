// Isometric buildings (the 2.5D view). Each building is modelled as a few flat faces (walls, gable ends,
// roof planes, chimney, steps, cupola) and rasterised pixel by pixel with a depth buffer: every screen
// pixel is a ray toward the viewer, the nearest face wins, and that face's material paints the pixel.
// Materials work in screen space (2:1 rows, whole-pixel columns), so plank lines, shingle courses and
// window frames land on exact pixels: crisp at every integer zoom, like the Ninja Adventure sprites.
// Then a 1px ink outline round the silhouette and a dark line wherever a nearer face overlaps a farther
// one (eaves over walls, a chimney against its roof). Each look is drawn once and cached.
//
// Coordinates: x, y are world px across the footprint (x0..x1 east, y0..y1 south); z is height in view
// px. View px are isoP(x, y) with z subtracted. A pixel's ray is ground point + t·(1, 1, ISO): larger t
// is nearer the viewer.
import { ISO, hash } from './world.js';

// Per look: wall height, roof rise, roof shape ('gable' | 'spire' | 'dome').
const KIND = {
  hall: { H: 32, R: 22, roof: 'gable' },
  houseA: { H: 20, R: 16, roof: 'gable' }, houseB: { H: 20, R: 16, roof: 'gable' }, houseC: { H: 20, R: 16, roof: 'gable' }, houseD: { H: 20, R: 16, roof: 'gable' },
  houseE: { H: 18, R: 14, roof: 'gable' }, houseF: { H: 18, R: 14, roof: 'gable' }, houseG: { H: 18, R: 14, roof: 'gable' }, houseH: { H: 18, R: 14, roof: 'gable' },
  cabin: { H: 16, R: 14, roof: 'gable' },
  towerWood: { H: 30, R: 20, roof: 'spire' }, towerGreen: { H: 30, R: 20, roof: 'spire' }, towerSand: { H: 28, R: 18, roof: 'spire' },
  towerDome: { H: 28, R: 14, roof: 'dome' }, towerRed: { H: 30, R: 20, roof: 'spire' }, towerWhite: { H: 30, R: 22, roof: 'spire' },
};
// Wall finishes: base colour, trim (frames, posts, beams) and texture.
const WALLS = {
  timber: { base: '#e8d8b4', trim: '#6b4429', tex: 'plaster', frame: true },
  white: { base: '#eee6d2', trim: '#56606e', tex: 'plaster' },
  planks: { base: '#bd8c5a', trim: '#5b3a24', tex: 'planks' },
  logs: { base: '#9c6b40', trim: '#4f321f', tex: 'logs' },
  stone: { base: '#bab3a5', trim: '#5f5a52', tex: 'stone' },
  brick: { base: '#bf7858', trim: '#55372a', tex: 'brick' },
};
const HOME_WALLS = ['timber', 'planks', 'white', 'logs', 'timber', 'planks'];
const PR_WALLS = ['stone', 'brick', 'stone'];

// ---------- colour ----------
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const INK = rgb('#140f1c'), CREAM = [255, 246, 226];
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const dk = (c, k) => mix(c, INK, k), lt = (c, k) => mix(c, CREAM, k);
const jit = (c, n) => (n > 0 ? lt(c, n) : dk(c, -n)); // a small per-board / per-shingle variation
const h2 = (a, b, seed = 0) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(seed | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
const GLASS = rgb('#2c3854'), GLASS_HI = rgb('#5a6a8e'), LIT = rgb('#ffcb62'), LIT_HI = rgb('#fff1bf'), GOLD = rgb('#e9b949');
const DOOR = rgb('#7a4a2a'), SILL = rgb('#c9a070'), FOOT = rgb('#8f8a86');
const FLOWERS = [rgb('#e0566a'), rgb('#f2c14e'), rgb('#e889c0'), rgb('#f4f0e6')], LEAF = rgb('#4f8a3a');

/** A building's screen rect in view px relative to isoP(x0, y0), without drawing it: [x0, y0, x1, y1]. */
export function isoExtent(it, T) {
  const s = ISO, K = KIND[it.look] || KIND.houseH, W = it.w * T, D = it.h * T;
  return [-D * s - 4, -(K.H + K.R + 34), W * s + 4, (W + D) * s / 2 + 4];
}
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const cache = new Map();

/** What a building looks like, decided once from its id (so it never changes between visits). */
function styleOf(it) {
  const h = hash(it.id), pr = it.kind === 'pr', K = KIND[it.look] || KIND.houseH;
  const st = { pr, hall: it.look === 'hall', roofShape: K.roof };
  if (st.hall) Object.assign(st, { wall: 'white', roof: 'tile', ridge: 'NS', frame: true, shutters: false, flowers: true, chimney: false, lamp: true });
  else if (pr) Object.assign(st, { wall: it.look === 'cabin' ? 'logs' : PR_WALLS[h % 3], roof: it.look === 'cabin' ? 'thatch' : 'slate', ridge: (h >>> 3) % 2 ? 'EW' : 'NS', chimney: true, sign: true, shutters: false, flowers: false });
  else {
    const wall = HOME_WALLS[h % HOME_WALLS.length];
    Object.assign(st, { wall, roof: ['shingle', 'tile', 'shingle'][(h >>> 4) % 3], chimney: (h >>> 6) % 3 !== 0, shutters: (h >>> 8) % 2 === 0, flowers: (h >>> 9) % 3 !== 0, lamp: (h >>> 10) % 2 === 0 });
    const W = it.w, D = it.h;
    st.ridge = W > D ? 'EW' : W < D ? 'NS' : (h >>> 11) % 2 ? 'EW' : 'NS';
    st.hip = st.ridge === 'EW' && W > D && (h >>> 12) % 3 === 0;
  }
  st.frame = st.frame ?? WALLS[st.wall].frame;
  st.tone = ((h >>> 14) % 5 - 2) * 0.04; // roof lightness wobble: neighbours differ a touch
  st.seed = h & 0xffff;
  return st;
}

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
  const s = ISO, K = KIND[it.look] || KIND.houseH, W = it.w * T, D = it.h * T, st = styleOf(it);
  const H = K.H, R = K.R, e = 3;
  const Q = (x, y, z = 0) => [(x - y) * s, (x + y) * s / 2 - z];
  const top = -(H + R + 40), left = Math.floor(-D * s) - 6, right = Math.ceil(W * s) + 6, bottom = Math.ceil((W + D) * s / 2) + 6;
  const w = right - left, h = bottom - top;
  const wall = WALLS[st.wall], WB = rgb(wall.base), TRIM = rgb(wall.trim);
  const accent = rgb(it.village.accent);
  // Roofs carry the neighbourhood's accent, pulled toward a warm earth tone so they sit a value step
  // below the status badges; PR workshops get a cooler, darker slate of the same hue.
  let RB = st.pr ? mix(mix(accent, rgb('#4a5060'), 0.42), INK, 0.08) : mix(accent, rgb('#5a3d2e'), 0.2);
  if (st.roof === 'thatch') RB = mix(rgb('#c9a35a'), accent, 0.12);
  RB = jit(RB, st.tone);
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

  // ---------- materials ----------
  // A wall texture at (col, z): col is whole screen px from the wall's left end, z is height in px.
  const wallTex = (col, z, cols, Hw, gable) => {
    let c = WB;
    if (z < 3 && !gable) { // stone footing
      c = FOOT; if (z < 1) return dk(c, 0.3);
      return (col + (z > 2 ? 2 : 0)) % 5 === 0 ? dk(c, 0.25) : jit(c, ((h2(col / 5 | 0, z | 0, 7) % 3) - 1) * 0.05);
    }
    const zi = Math.floor(z);
    switch (wall.tex) {
      case 'planks': {
        const row = Math.floor((zi - 3) / 3);
        if ((zi - 3) % 3 === 0) c = dk(c, 0.3);
        else { if ((col + row * 7) % 13 === 0) c = dk(c, 0.22); else c = jit(c, ((h2(row, (col + row * 7) / 13 | 0, st.seed) % 5) - 2) * 0.03); if ((zi - 3) % 3 === 2) c = lt(c, 0.06); }
        break;
      }
      case 'logs': {
        const r = (zi - 3) % 4;
        c = r === 0 ? dk(c, 0.4) : r === 3 ? lt(c, 0.1) : r === 1 ? dk(c, 0.1) : c;
        if (col <= 1 || col >= cols - 2) c = r === 0 ? dk(c, 0.2) : lt(WB, 0.25); // log ends at the corners
        break;
      }
      case 'stone': {
        const row = Math.floor((zi - 3) / 4), off = (row % 2) * 4;
        if ((zi - 3) % 4 === 0 || (col + off) % 8 === 0) c = lt(c, 0.22); // mortar
        else c = jit(c, ((h2(row, (col + off) / 8 | 0, st.seed) % 5) - 2) * 0.05);
        break;
      }
      case 'brick': {
        const row = Math.floor((zi - 3) / 3), off = (row % 2) * 3;
        if ((zi - 3) % 3 === 0 || (col + off) % 6 === 0) c = rgb('#d9c8b4');
        else c = jit(c, ((h2(row, (col + off) / 6 | 0, st.seed) % 5) - 2) * 0.05);
        break;
      }
      default: // plaster: a faint speckle
        if (h2(col, zi, st.seed) % 23 === 0) c = dk(c, 0.07);
    }
    if (gable && wall.tex === 'plaster') { c = rgb('#b58552'); if (col % 3 === 0) c = dk(c, 0.3); } // boarded gable
    return c;
  };
  // Openings and fittings painted over a wall: windows, the door, shutters, sills, a lamp, a sign.
  const fittings = [];
  const win = (face, cc, z0, wd = 6, ht = 7, round = false) => fittings.push({ face, kind: round ? 'round' : 'win', c0: cc - (wd >> 1), c1: cc - (wd >> 1) + wd - 1, z0, z1: z0 + ht - 1 });
  const paintFitting = (f, col, z) => {
    const zi = Math.floor(z);
    if (f.kind === 'round') {
      const cx = (f.c0 + f.c1) / 2, cz = (f.z0 + f.z1) / 2, d = (col - cx) ** 2 + (zi - cz) ** 2, r = (f.c1 - f.c0) / 2 + 0.5;
      if (d > r * r) return null;
      if (d > (r - 1.2) ** 2) return [TRIM, 0];
      if (Math.abs(col - cx) < 0.6 || Math.abs(zi - cz) < 0.6) return [TRIM, 0];
      return lit ? [col < cx && zi > cz ? LIT_HI : LIT, 1] : [col < cx && zi > cz ? GLASS_HI : GLASS, 0];
    }
    if (f.kind === 'win') {
      const { c0, c1, z0, z1 } = f;
      if (zi === z0 - 1 && col >= c0 - 1 && col <= c1 + 1) return [SILL, 0];
      if (st.flowers && zi === z0 - 2 && col >= c0 && col <= c1) return [(col - c0) % 2 ? LEAF : FLOWERS[(h2(col, f.z0, st.seed) >>> 3) % FLOWERS.length], 0];
      if (st.flowers && zi === z0 - 3 && col >= c0 && col <= c1) return [rgb('#6b4429'), 0];
      if (st.shutters && zi >= z0 && zi <= z1 && (col === c0 - 2 || col === c0 - 1 || col === c1 + 1 || col === c1 + 2)) {
        const sh = mix(accent, rgb('#3d4a3a'), 0.55);
        return [zi === ((z0 + z1) >> 1) || col === c0 - 2 || col === c1 + 2 ? dk(sh, 0.25) : sh, 0];
      }
      if (col < c0 || col > c1 || zi < z0 || zi > z1) return null;
      if (col === c0 || col === c1 || zi === z0 || zi === z1 || col === ((c0 + c1) >> 1) || zi === ((z0 + z1) >> 1) + 1) return [st.pr ? dk(TRIM, 0.1) : lt(TRIM, wall.tex === 'plaster' ? 0 : 0.15), 0];
      const hiPx = col === c0 + 1 && zi === z1 - 1;
      return lit ? [hiPx ? LIT_HI : LIT, 1] : [hiPx ? GLASS_HI : GLASS, 0];
    }
    if (f.kind === 'door') {
      const { c0, c1, z1, dbl } = f;
      const arch = (zi === z1 && (col <= c0 + 1 || col >= c1 - 1)) || (zi === z1 - 1 && (col === c0 || col === c1));
      if (col < c0 || col > c1 || zi < 0 || zi > z1) return null;
      if (arch) return null; // rounded top corners: the wall shows through
      if (col === c0 || col === c1 || zi >= z1 - (st.hall ? 1 : 0) || (zi === z1 - 1 && (col === c0 + 1 || col === c1 - 1))) return [dk(TRIM, 0.15), 0];
      const mid = (c0 + c1) >> 1;
      if (dbl && col === mid) return [dk(DOOR, 0.45), 0];
      if ((dbl ? [mid - 2, mid + 2] : [c1 - 2]).includes(col) && zi === Math.round(z1 * 0.45)) return [GOLD, 0];
      if (zi < 1) return [dk(DOOR, 0.35), 0];
      return [(col - c0) % 2 ? DOOR : dk(DOOR, 0.18), 0];
    }
    if (f.kind === 'lamp') {
      const { c0, z0 } = f;
      if (col < c0 || col > c0 + 2 || zi < z0 || zi > z0 + 4) return null;
      if (zi === z0 + 4 || zi === z0 || col !== c0 + 1) return [INK, 0];
      return [lit ? LIT_HI : rgb('#e8c27a'), lit ? 1 : 0];
    }
    if (f.kind === 'sign') { // a hanging board in the accent: a finished PR (a guild workshop)
      const { c0, z0 } = f;
      if (col < c0 || col > c0 + 6 || zi < z0 || zi > z0 + 6) return null;
      if (zi >= z0 + 5) return col === c0 + 1 || col === c0 + 5 ? [INK, 0] : null; // the chains
      if (zi === z0 || zi === z0 + 4 || col === c0 || col === c0 + 6) return [INK, 0];
      return [(zi === z0 + 2 && col >= c0 + 2 && col <= c0 + 4) ? CREAM : accent, 0];
    }
    return null;
  };
  // A wall face's material: texture, then fittings, then trim posts and the shadow under the eaves.
  const wallMat = (name, cols, Hw, shade, gable = false) => (q) => {
    const { col, z } = q;
    for (const f of fittings) if (f.face === name) { const p = paintFitting(f, col, z); if (p) return p[1] ? p : [dk(p[0], shade), 0]; }
    let c = wallTex(col, z, cols, Hw, gable);
    if (!gable && z >= 3) {
      if (st.frame && (col <= 1 || col >= cols - 2 || z >= Hw - 2 || (Math.floor(z) === 3) || (Hw > 24 && Math.floor(z) === 16))) c = TRIM;
      else if (st.frame && (col % 14 === 7) && !fittings.some(f => f.face === name && col >= f.c0 - 3 && col <= f.c1 + 3)) c = TRIM;
      else if (!st.frame && (col === 0 || col === cols - 1) && wall.tex !== 'logs') c = dk(TRIM, -0.1);
      if (z >= Hw - 2 && z < Hw && !st.frame) c = dk(c, 0.22); // under the eaves
    }
    return [dk(c, shade), 0];
  };
  // A roof face: courses of shingles / clay tiles / slates / thatch, a darker eave lip and ridge cap,
  // barge boards along the gable overhang.
  const roofMat = (shade, edge) => (q) => {
    const { col, row, rmax, P } = q;
    let c = RB;
    const r = row, mat = st.roof;
    if (edge && edge(P)) c = st.hall ? GOLD : dk(RB, 0.5);
    else if (r < 1.2) c = dk(RB, 0.5);
    else if (r > rmax - 1.5) c = dk(RB, 0.32);
    else if (mat === 'shingle') {
      const row3 = Math.floor(r / 3), rr = r - row3 * 3, off = (row3 & 1) * 3, sx = Math.floor((col + off) / 6);
      if ((col + off) % 6 === 0) c = dk(c, 0.26);
      else { c = jit(c, ((h2(row3, sx, st.seed) % 5) - 2) * 0.035); if (rr < 1) c = dk(c, 0.3); else if (rr >= 2) c = lt(c, 0.07); }
    } else if (mat === 'tile') {
      const row4 = Math.floor(r / 4), rr = r - row4 * 4, cc = (col + (row4 & 1) * 2) % 4;
      c = cc === 0 ? dk(c, 0.24) : cc === 1 ? lt(c, 0.12) : c;
      if (rr < 1) c = dk(c, 0.34);
    } else if (mat === 'slate') {
      const row3 = Math.floor(r / 3), rr = r - row3 * 3, off = (row3 % 3) * 2, sx = Math.floor((col + off) / 4);
      if ((col + off) % 4 === 0) c = dk(c, 0.22); else c = jit(c, ((h2(row3, sx, st.seed) % 7) - 3) * 0.04);
      if (rr < 1) c = dk(c, 0.3);
    } else { // thatch
      const v = h2(col, Math.floor(r / 2), st.seed) % 7;
      c = v === 0 ? dk(c, 0.22) : v === 1 ? lt(c, 0.12) : c;
      if (Math.floor(r) % 6 === 0) c = dk(c, 0.3);
    }
    return [dk(c, shade), 0];
  };

  // ---------- geometry ----------
  const out = { windows: [], door: null, ridge: null, chimney: null, finial: null };
  if (site) buildSite();
  else {
    const doorU = Math.min(W - 7, Math.max(7, it.doorX ?? W / 2)), colsS = Math.round(W * s), colsE = Math.round(D * s);
    // The door, on the south wall at the building's door x, with a stone step in front of it.
    const dh = st.hall ? 18 : Math.min(13, H - 6), dw = st.hall ? 11 : 7, dc = Math.round(doorU * s);
    fittings.push({ face: 'S', kind: 'door', c0: dc - (dw >> 1), c1: dc - (dw >> 1) + dw - 1, z1: dh, dbl: st.hall });
    out.door = Q(doorU, D, 0);
    if (st.lamp) fittings.push({ face: 'S', kind: 'lamp', c0: dc + (dw >> 1) + 2, z0: dh - 6 });
    if (st.hall && st.lamp) fittings.push({ face: 'S', kind: 'lamp', c0: dc - (dw >> 1) - 5, z0: dh - 6 });
    if (st.sign) fittings.push({ face: 'S', kind: 'sign', c0: dc + (dw >> 1) + 2, z0: dh - 9 });
    // Windows along each wall, spaced evenly in the stretches the door (and its lamp or sign) leave free;
    // the hall has two floors of them.
    const towerish = K.roof !== 'gable', wd = towerish ? 4 : 6, ht = towerish ? 6 : 7, pad = st.shutters ? 6 : 4;
    const rows = H > 24 ? [6, 20] : [Math.round(H * 0.42)];
    const fill = (a, b) => { const len = b - a, n = len < wd + 2 ? 0 : Math.max(1, Math.floor((len + 4) / (wd + 2 * pad + 4))); return Array.from({ length: n }, (_, i) => Math.round(a + len * (i + 0.5) / n)); };
    const gapL = dc - (dw >> 1) - (st.hall && st.lamp ? 8 : 3), gapR = dc + (dw >> 1) + (st.lamp || st.sign ? 10 : 3);
    for (const z0 of rows) {
      const nearDoor = z0 < dh + 3;
      const sCols = nearDoor ? [...fill(pad, gapL - pad), ...fill(gapR + pad, colsS - pad)] : fill(pad, colsS - pad);
      for (const c of sCols) win('S', c, z0, wd, ht);
      for (const c of fill(pad, colsE - pad)) win('E', c, z0, wd, ht);
    }
    for (const f of fittings) if (f.kind === 'win') {
      const cc = (f.c0 + f.c1) / 2, zc = (f.z0 + f.z1) / 2;
      out.windows.push(f.face === 'S' ? Q(cc / s, D, zc) : Q(W, D - cc / s, zc));
    }
    // Walls.
    face([[0, D, 0], [W, D, 0], [W, D, H], [0, D, H]], 'S', wallMat('S', colsS, H, 0), { col0: -D * s });
    face([[W, D, 0], [W, 0, 0], [W, 0, H], [W, D, H]], 'E', wallMat('E', colsE, H, 0.2), { col0: (W - D) * s });
    // The step: a stone slab in front of the door.
    const sw = st.hall ? 8 : 5;
    box(doorU - sw, doorU + sw, D, D + (st.hall ? 6 : 3), 0, 2, () => [FOOT, 0], () => [dk(FOOT, 0.25), 0], () => [lt(FOOT, 0.15), 0]);
    if (st.hall) box(doorU - sw + 2, doorU + sw - 2, D, D + 3, 2, 4, () => [lt(FOOT, 0.05), 0], () => [dk(FOOT, 0.2), 0], () => [lt(FOOT, 0.2), 0]);
    if (K.roof === 'gable') gableRoof();
    else if (K.roof === 'spire') { const ap = [W / 2, D / 2, H + R + 6]; pyramid(-e, W + e, -e, D + e, H - e * 0.5, ap); out.ridge = Q(...ap); }
    else dome();
  }

  function box(x0, x1, y0, y1, z0, z1, mS, mE, mT) {
    face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], 'S', mS);
    face([[x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1]], 'E', mE);
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 'S', mT);
  }
  function pyramid(x0, x1, y0, y1, z0, ap) {
    face([[x0, y1, z0], [x1, y1, z0], ap], 'S', roofMat(-0.04));
    face([[x1, y1, z0], [x1, y0, z0], ap], 'E', roofMat(0.16));
    face([[x0, y0, z0], [x1, y0, z0], ap], 'S', roofMat(0.3));
    face([[x0, y0, z0], [x0, y1, z0], ap], 'E', roofMat(0.3));
  }
  function dome() {
    const cx = W / 2, cy = D / 2, r = Math.min(W, D) / 2 + 2, z0 = H;
    // A flat stone roof with a darker rim, the dome sitting on it.
    face([[-1, -1, H], [W + 1, -1, H], [W + 1, D + 1, H], [-1, D + 1, H]], 'S', q => [q.P[0] < 1 || q.P[1] < 1 || q.P[0] > W - 1 || q.P[1] > D - 1 ? dk(FOOT, 0.2) : lt(FOOT, 0.1), 0]);
    faces.push({ sphere: [cx, cy, z0, r], mat: q => { const { P } = q; const zz = P[2] - z0, rowz = Math.floor(zz / 3); let c = RB; if (zz < 1.2) c = dk(RB, 0.5); else if (Math.floor(zz) % 3 === 0) c = dk(c, 0.25); else if ((q.col + rowz * 2) % 5 === 0) c = dk(c, 0.15); const lx = (P[0] - cx) - (P[1] - cy); return [lx > r * 0.35 ? dk(c, 0.18) : P[1] - cy > r * 0.2 && lx < 0 ? lt(c, 0.06) : c, 0]; } });
    out.ridge = Q(cx, cy, z0 + r);
  }
  // A roof over the box: a gable (ridge east–west or north–south, by the building's style) or a hip.
  function gableRoof() {
    const ridgeEW = st.ridge === 'EW';
    const half = (ridgeEW ? D : W) / 2, k = R / half, zr = H + R, zE = H - e * k;
    const colsS = Math.round(W * s), colsE = Math.round(D * s);
    if (ridgeEW) {
      const ym = D / 2;
      const barge = P => P[0] < -e + 1.3 || P[0] > W + e - 1.3;
      if (st.hip) {
        const xa = half, xb = W - half;
        face([[-e, D + e, zE], [W + e, D + e, zE], [xb, ym, zr], [xa, ym, zr]], 'S', roofMat(-0.04));
        face([[-e, -e, zE], [W + e, -e, zE], [xb, ym, zr], [xa, ym, zr]], 'S', roofMat(0.3));
        face([[W + e, D + e, zE], [W + e, -e, zE], [xb, ym, zr]], 'E', roofMat(0.16));
        face([[-e, D + e, zE], [-e, -e, zE], [xa, ym, zr]], 'E', roofMat(0.32));
        out.ridge = Q(xb, ym, zr);
      } else {
        face([[-e, -e, zE], [W + e, -e, zE], [W + e, ym, zr], [-e, ym, zr]], 'S', roofMat(0.3, barge));
        face([[W, 0, H], [W, D, H], [W, ym, zr]], 'E', wallMat('EG', colsE, H, 0.2, true), { col0: (W - D) * s }); // the east gable end
        face([[-e, D + e, zE], [W + e, D + e, zE], [W + e, ym, zr], [-e, ym, zr]], 'S', roofMat(-0.04, barge));
        out.ridge = Q(W * 0.72, ym, zr);
      }
      if (st.chimney) chimney(W * (st.seed % 2 ? 0.22 : 0.7), D * 0.22, zr);
    } else {
      const xm = W / 2;
      const barge = P => P[1] < -e + 1.3 || P[1] > D + e - 1.3;
      face([[-e, -e, zE], [-e, D + e, zE], [xm, D + e, zr], [xm, -e, zr]], 'E', roofMat(0.3, barge));
      face([[0, D, H], [W, D, H], [xm, D, zr]], 'S', wallMat('SG', colsS, H, 0, true), { col0: -D * s }); // the south gable end
      face([[W + e, -e, zE], [W + e, D + e, zE], [xm, D + e, zr], [xm, -e, zr]], 'E', roofMat(0.14, barge));
      out.ridge = Q(xm, D * 0.7, zr);
      if (st.hall) { // a round window high in the front gable, and a cupola with a gold finial on the ridge
        fittings.push({ face: 'SG', kind: 'round', c0: Math.round(colsS / 2) - 4, c1: Math.round(colsS / 2) + 4, z0: H + 5, z1: H + 13 });
        const cy = D * 0.45, zc = zr - 2;
        const white = () => [rgb('#eee6d2'), 0];
        const louvre = (base, sh) => q => [Math.floor(q.z) > zc + 2 && Math.floor(q.z) < zc + 7 && q.col > 1 && q.col < 5 ? dk(base, 0.6 + sh) : dk(base, sh), 0];
        box(xm - 4, xm + 4, cy - 4, cy + 4, zr - 8, zc + 9, louvre(rgb('#eee6d2'), 0), louvre(rgb('#eee6d2'), 0.2), white);
        const ap = [xm, cy, zc + 19];
        pyramid(xm - 6, xm + 6, cy - 6, cy + 6, zc + 9, ap);
        out.finial = Q(...ap);
        out.ridge = Q(xm, cy, zc + 24);
      } else if (st.chimney) chimney(W * 0.24, D * (st.seed % 2 ? 0.3 : 0.72), zr);
    }
  }
  function chimney(x, y, zr) {
    const B = st.pr ? rgb('#8f8a86') : rgb('#a0583c'), z1 = zr + 5;
    const bricks = sh => q => { const zi = Math.floor(q.z); const c = zi >= z1 - 1 ? dk(B, 0.35) : (zi % 3 === 0 || (q.col + (Math.floor(zi / 3) % 2) * 2) % 4 === 0) ? lt(B, 0.25) : B; return [dk(c, sh), 0]; };
    box(x - 3, x + 3, y - 3, y + 3, H - 2, z1, bricks(0), bricks(0.22), q => [q.P[0] > x - 2 && q.P[0] < x + 2 && q.P[1] > y - 2 && q.P[1] < y + 2 ? INK : dk(B, 0.1), 0]);
    out.chimney = Q(x, y, z1 + 1);
  }
  // A building site: a stone foundation and plank floor, framed walls to a ragged half height (all four
  // show, the roof isn't on yet), with corner posts and a roof truss drawn over the top.
  function buildSite() {
    const hw = Math.round(H * 0.45), wood = rgb('#c98a4a'), raw = rgb('#d9b07a');
    const cut = col => hw - (h2(Math.floor(col / 3), 0, st.seed) % 5);
    box(-2, W + 2, -2, D + 2, 0, 3, q => [Math.floor(q.z) < 1 ? dk(FOOT, 0.3) : (q.col % 5 === 0 ? dk(FOOT, 0.2) : FOOT), 0], q => [dk(Math.floor(q.z) < 1 ? dk(FOOT, 0.3) : FOOT, 0.2), 0], q => [(Math.floor(q.P[0] + q.P[1]) % 4 === 0) ? dk(raw, 0.25) : raw, 0]);
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
    if (f.sphere) {
      const [cx, cy, cz, r] = f.sphere, [X0, Y0] = Q(cx, cy, cz);
      for (let py = Math.max(0, Math.floor(Y0 - r * 1.3 - top)); py < Math.min(h, Math.ceil(Y0 + r - top)); py++) for (let px = Math.max(0, Math.floor(X0 - r * 1.3 - left)); px < Math.min(w, Math.ceil(X0 + r * 1.3 - left)); px++) {
        const X = left + px + 0.5, Y = top + py + 0.5, gx = (X / s + 2 * Y / s) / 2, gy = (2 * Y / s - X / s) / 2;
        const ox = gx - cx, oy = gy - cy, oz = -cz, b = 2 * (ox + oy + s * oz), c = ox * ox + oy * oy + oz * oz - r * r, disc = b * b - 4 * d2 * c;
        if (disc < 0) continue;
        const t = (-b + Math.sqrt(disc)) / (2 * d2);
        if (s * t < cz) continue;
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
  // Paint each pixel with its face's material.
  const col = new Uint8ClampedArray(N * 4), glow = new Uint8Array(N);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const j = py * w + px, i = fid[j];
    if (i < 0) continue;
    const f = faces[i], X = left + px + 0.5, Y = top + py + 0.5, t = depth[j];
    const gx = (X / s + 2 * Y / s) / 2, gy = (2 * Y / s - X / s) / 2, P = [gx + t, gy + t, s * t];
    // col: whole screen px from the face's left end; z: height; row: screen rows up from the face's eave.
    const q = { P, col: Math.floor(X - (f.col0 ?? f.left ?? 0)), z: P[2], row: f.sphere ? 0 : rowUp(f, X, Y), rmax: f.rmax };
    const [c, g] = f.mat(q);
    col[j * 4] = c[0]; col[j * 4 + 1] = c[1]; col[j * 4 + 2] = c[2]; col[j * 4 + 3] = 255; glow[j] = g;
  }
  // Ink: round the silhouette, and wherever a nearer face overlaps a farther one.
  const ink = new Uint8Array(N);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const j = py * w + px;
    if (fid[j] < 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || fid[y * w + x] < 0) { ink[j] = 2; break; }
      const k = y * w + x;
      if (fid[k] !== fid[j] && depth[k] > depth[j] + 1.2) ink[j] = Math.max(ink[j], 1);
    }
  }
  for (let j = 0; j < N; j++) if (ink[j]) {
    const c = ink[j] === 2 ? INK : dk([col[j * 4], col[j * 4 + 1], col[j * 4 + 2]], 0.6);
    col[j * 4] = c[0]; col[j * 4 + 1] = c[1]; col[j * 4 + 2] = c[2];
  }
  const c = canvas(w, h), g = c.getContext('2d');
  g.putImageData(new ImageData(col, w, h), 0, 0);
  // Site timber: posts, beams and the truss as whole-pixel lines (inked, then wood).
  if (out.lines) {
    const plot = (a, b, color, wd) => { const [x0, y0] = Q(...a), [x1, y1] = Q(...b), n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)))); g.fillStyle = color; for (let i = 0; i <= n; i++) g.fillRect(Math.round(x0 + (x1 - x0) * i / n - left) - (wd >> 1), Math.round(y0 + (y1 - y0) * i / n - top) - (wd >> 1), wd, wd); };
    for (const [a, b] of out.lines) plot(a, b, '#140f1c', 3);
    for (const [a, b] of out.lines) plot(a, b, '#c98a4a', 1);
  }
  if (out.finial) { const [x, y] = out.finial, X = Math.round(x - left), Y = Math.round(y - top); g.fillStyle = '#140f1c'; g.fillRect(X - 1, Y - 6, 3, 6); g.fillRect(X - 2, Y - 9, 5, 4); g.fillStyle = '#e9b949'; g.fillRect(X, Y - 6, 1, 5); g.fillRect(X - 1, Y - 8, 3, 2); }
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
