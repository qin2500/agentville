// Isometric buildings (the 2.5D view): a building is a box on its footprint, with two walls showing
// (south and east) and a roof, drawn in the art pack's palette with its 1px ink outline, the roof in the
// neighbourhood's accent. Each is drawn once at 1 view px per px into its own canvas, edges snapped to
// whole pixels (no soft antialiasing) so it scales up crisp like the sprites around it, and cached.
//
// Coordinates: x, y are world px across the footprint (x0..x1 east, y0..y1 south); z is height in view
// px. View px are isoP(x, y) with z subtracted.
import { ISO } from './world.js';

const INK = '#140f1c';
// Per look: wall height, roof rise, roof kind, wall and trim colours, windows per wall [south, east].
const KIND = {
  hall:   { H: 30, R: 24, roof: 'gable', wall: '#d9cdb4', trim: '#6b4429', win: [2, 2], timber: true },
  houseA: { H: 20, R: 16, roof: 'gable', wall: '#e6d6b2', trim: '#7a4a2a', win: [2, 1], timber: true },
  houseB: { H: 20, R: 16, roof: 'gable', wall: '#b9895a', trim: '#6b4429', win: [2, 1], planks: true },
  houseC: { H: 20, R: 16, roof: 'gable', wall: '#d8c9a8', trim: '#5b3a24', win: [1, 1], timber: true },
  houseD: { H: 20, R: 16, roof: 'gable', wall: '#c9b48c', trim: '#6b4429', win: [2, 1], planks: true },
  houseE: { H: 17, R: 13, roof: 'gable', wall: '#e2d2ae', trim: '#7a4a2a', win: [1, 1], timber: true },
  houseF: { H: 17, R: 14, roof: 'gable', wall: '#b07a48', trim: '#5b3a24', win: [1, 1], planks: true },
  houseG: { H: 16, R: 13, roof: 'gable', wall: '#c99a66', trim: '#5b3a24', win: [1, 1], planks: true },
  houseH: { H: 16, R: 13, roof: 'gable', wall: '#e9dcbc', trim: '#7a4a2a', win: [1, 1], timber: true },
  cabin:  { H: 15, R: 12, roof: 'gable', wall: '#a8703f', trim: '#4f321f', win: [1, 1], planks: true },
  towerWood:  { H: 34, R: 16, roof: 'spire', wall: '#b07a48', trim: '#5b3a24', win: [1, 1], planks: true },
  towerGreen: { H: 34, R: 16, roof: 'spire', wall: '#c8c1b2', trim: '#5f5a52', win: [1, 1], stone: true },
  towerSand:  { H: 32, R: 14, roof: 'spire', wall: '#dcc596', trim: '#7a5f3a', win: [1, 1], stone: true },
  towerDome:  { H: 30, R: 14, roof: 'dome', wall: '#d6d0c4', trim: '#5f5a52', win: [1, 1], stone: true },
  towerRed:   { H: 34, R: 16, roof: 'spire', wall: '#c8c1b2', trim: '#5f5a52', win: [1, 1], stone: true },
  towerWhite: { H: 34, R: 16, roof: 'spire', wall: '#ece6da', trim: '#6f6a60', win: [1, 1], stone: true },
};
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (c, to, k) => { const a = hex(c), b = hex(to); return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`; };
const dark = (c, k) => mix(c, '#140f1c', k), light = (c, k) => mix(c, '#ffffff', k);

const cache = new Map();
/**
 * The building for item `it` (footprint it.x, it.y, it.w, it.h in tiles, look, village accent). `lit`:
 * its windows glow (its agent is in). Returns { img, dx, dy, ... } where img is drawn at
 * isoP(x0, y0) + [dx, dy] in view px; windows, door, ridge and box are in view px relative to isoP(x0, y0).
 */
export function isoBuilding(it, T, lit) {
  const k = `${it.look}|${it.w}|${it.h}|${it.village.accent}|${lit ? 1 : 0}|${it.kind === 'pr' && it.building ? 'site' : ''}|${it.doorX}`;
  if (!cache.has(k)) cache.set(k, make(it, T, lit));
  return cache.get(k);
}

function make(it, T, lit) {
  const K = KIND[it.look] || KIND.houseH, W = it.w * T, D = it.h * T, site = it.kind === 'pr' && it.building;
  const s = ISO, Q = (x, y, z = 0) => [(x - y) * s, (x + y) * s / 2 - z];
  const H = site ? Math.round(K.H * 0.5) : K.H, R = K.R;
  const top = -(K.H + R + 22), left = Math.floor(-D * s) - 4, right = Math.ceil(W * s) + 4, bottom = Math.ceil((W + D) * s / 2) + 4;
  const c = canvas(right - left, bottom - top), g = c.getContext('2d');
  g.translate(-left, -top);
  g.lineJoin = 'miter';
  const poly = (pts, fill, stroke = INK) => {
    g.beginPath(); pts.forEach(([x, y, z], i) => { const [X, Y] = Q(x, y, z); i ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  };
  const line = (a, b, color, w = 1) => { g.beginPath(); g.moveTo(...Q(...a)); g.lineTo(...Q(...b)); g.strokeStyle = color; g.lineWidth = w; g.stroke(); };
  const accent = it.village.accent, wall = K.wall, wallS = wall, wallE = dark(wall, 0.22);
  // A stone footing, then the two walls that face the viewer.
  poly([[0, D, 0], [W, D, 0], [W, 0, 0], [W, 0, 2], [W, D, 2], [0, D, 2]], '#8f8a86');
  const faceS = [[0, D, 0], [W, D, 0], [W, D, H], [0, D, H]], faceE = [[W, D, 0], [W, 0, 0], [W, 0, H], [W, D, H]];
  poly(faceS, wallS); poly(faceE, wallE);
  // Wall texture: planks, stone courses or a timber frame, along each wall.
  if (K.planks) for (let z = 4; z < H; z += 4) { line([0, D, z], [W, D, z], dark(wallS, 0.18)); line([W, D, z], [W, 0, z], dark(wallE, 0.18)); }
  if (K.stone) for (let z = 5; z < H; z += 5) { line([0, D, z], [W, D, z], dark(wallS, 0.14)); line([W, D, z], [W, 0, z], dark(wallE, 0.14)); }
  if (K.timber && !site) {
    line([0, D, H - 1], [W, D, H - 1], K.trim, 2); line([W, D, H - 1], [W, 0, H - 1], dark(K.trim, 0.2), 2);
    for (const x of [1, W - 1]) line([x, D, 0], [x, D, H], K.trim, 2);
    line([W, 1, 0], [W, 1, H], dark(K.trim, 0.2), 2);
  }
  // Openings: the door on the south wall at the building's door x; windows spread along each wall.
  const out = { windows: [], door: null };
  const rect = (face, u0, u1, z0, z1, fill) => { // face 'S' runs x along y = D; 'E' runs y along x = W
    const P = face === 'S' ? (u, z) => [u, D, z] : (u, z) => [W, u, z];
    poly([P(u0, z0), P(u1, z0), P(u1, z1), P(u0, z1)], fill);
    const [X, Y] = Q(...P((u0 + u1) / 2, (z0 + z1) / 2));
    return [X, Y];
  };
  if (!site) {
    const dx = Math.min(W - 7, Math.max(7, it.doorX ?? W / 2)), dh = Math.min(13, H - 4);
    rect('S', dx - 4, dx + 4, 0, dh, '#3a2a22');
    out.door = Q(dx, D, 0);
    const glass = lit ? '#ffd27a' : '#34405c', wz0 = Math.round(H * 0.42), wz1 = Math.min(H - 3, wz0 + 7);
    const spots = (len, n, avoid) => { const r = []; for (let i = 0; i < n; i++) { let u = len * (i + 1) / (n + 1); if (avoid != null && Math.abs(u - avoid) < 10) u = avoid + (u < avoid ? -12 : 12); if (u > 5 && u < len - 5) r.push(u); } return r; };
    for (const u of spots(W, K.win[0], dx)) out.windows.push(rect('S', u - 3, u + 3, wz0, wz1, glass));
    for (const u of spots(D, K.win[1])) out.windows.push(rect('E', u - 3, u + 3, wz0, wz1, glass));
  }
  // The roof, back planes first.
  const e = 3, roofS = accent, roofN = dark(accent, 0.3), roofE = light(accent, 0.12), roofW = dark(accent, 0.38);
  const shingles = (a0, a1, b0, b1, color) => { for (let t = 0.25; t < 1; t += 0.25) line(lerp(a0, b0, t), lerp(a1, b1, t), color); };
  let ridge;
  if (site) { // a building site: corner posts, top beams and a roof truss, no roof yet
    const wood = '#c98a4a', hi = K.H;
    for (const [x, y] of [[0, 0], [W, 0], [0, D], [W, D]]) { line([x, y, 0], [x, y, hi], INK, 3); line([x, y, 0], [x, y, hi], wood, 1); }
    for (const [a, b] of [[[0, D, hi], [W, D, hi]], [[W, D, hi], [W, 0, hi]], [[0, 0, hi], [W, 0, hi]], [[0, 0, hi], [0, D, hi]]]) { line(a, b, INK, 3); line(a, b, wood, 1); }
    const ym = D / 2;
    for (const x of [0, W / 2, W]) { line([x, 0, hi], [x, ym, hi + R], INK, 3); line([x, D, hi], [x, ym, hi + R], INK, 3); line([x, 0, hi], [x, ym, hi + R], wood, 1); line([x, D, hi], [x, ym, hi + R], wood, 1); }
    line([0, ym, hi + R], [W, ym, hi + R], INK, 3); line([0, ym, hi + R], [W, ym, hi + R], wood, 1);
    ridge = Q(W / 2, ym, hi + R);
  } else if (K.roof === 'gable' && W >= D) { // ridge runs east-west
    const ym = D / 2, z = H + R;
    poly([[-e, -e, H], [W + e, -e, H], [W + e, ym, z], [-e, ym, z]], roofN);
    poly([[W, 0, H], [W, D, H], [W, ym, z]], wallE); // the east gable end
    poly([[-e, D + e, H], [W + e, D + e, H], [W + e, ym, z], [-e, ym, z]], roofS);
    shingles([-e, D + e, H], [W + e, D + e, H], [-e, ym, z], [W + e, ym, z], dark(roofS, 0.2));
    line([-e, ym, z], [W + e, ym, z], dark(accent, 0.45), 2);
    ridge = Q(W * 0.75, ym, z);
  } else if (K.roof === 'gable') { // ridge runs north-south
    const xm = W / 2, z = H + R;
    poly([[-e, -e, H], [-e, D + e, H], [xm, D + e, z], [xm, -e, z]], roofW);
    poly([[0, D, H], [W, D, H], [xm, D, z]], wallS); // the south gable end
    poly([[W + e, -e, H], [W + e, D + e, H], [xm, D + e, z], [xm, -e, z]], roofE);
    shingles([W + e, -e, H], [W + e, D + e, H], [xm, -e, z], [xm, D + e, z], dark(roofE, 0.2));
    line([xm, -e, z], [xm, D + e, z], dark(accent, 0.45), 2);
    ridge = Q(xm, D * 0.75, z);
  } else if (K.roof === 'dome') {
    const [cx, cy] = Q(W / 2, D / 2, H), rx = (W + D) * s / 2 * 0.62, ry = rx * 0.9;
    g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, Math.PI, 0); g.closePath(); g.fillStyle = roofS; g.fill(); g.strokeStyle = INK; g.lineWidth = 1; g.stroke();
    g.beginPath(); g.ellipse(cx - rx * 0.3, cy - ry * 0.5, rx * 0.25, ry * 0.2, 0, 0, 7); g.fillStyle = light(accent, 0.35); g.fill();
    ridge = [cx, cy - ry];
  } else { // a spire: a four-sided pyramid
    const apex = [W / 2, D / 2, H + R + 6];
    poly([[-e, -e, H], [W + e, -e, H], apex], roofN); poly([[-e, -e, H], [-e, D + e, H], apex], roofW);
    poly([[-e, D + e, H], [W + e, D + e, H], apex], roofS); poly([[W + e, D + e, H], [W + e, -e, H], apex], roofE);
    ridge = Q(...apex);
  }
  // Snap: every edge pixel fully on or off, as in the sprites.
  const im = g.getImageData(0, 0, c.width, c.height), px = im.data;
  for (let i = 3; i < px.length; i += 4) px[i] = px[i] >= 120 ? 255 : 0;
  g.putImageData(im, 0, 0);
  return { img: c, dx: left, dy: top, windows: out.windows, door: out.door, ridge, box: [left, top + 16, right - left, bottom - top - 16] };
}
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
