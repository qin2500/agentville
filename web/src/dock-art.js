// The dock (owner, 2026-11-11): "a cute little dock on our island". A wooden pier runs out into a cove
// cut into the town's south shore; each PR being shipped is a little ship at a berth. A porter carries
// crates from the pier foot to its ship as checks pass and review lands (crates stack on the pier and on
// the deck), and when the PR merges the ship casts off and sails out of view. The pier grows with
// `level` (1–5): longer, more berths, then a lamp, a warehouse, a crane and a flag.
//
// world.js places it (the cove is cut in buildLand, so it never moves while the island stays the same
// size) and calls this file for the art. Everything is drawn in code (the asset pack has no boats):
// models are flat faces in world px (x east, y south, z up), rasterised pixel-exact into cached canvases
// like iso.js does, so they stay crisp at every zoom. The village is isometric only (owner, 2026-11-11).
// Data: `S.dock` (see dockData).
import { T, ISO, isoP, isoInv, hash, LOOKS, ACCENT } from './world.js';
import { store } from './ui.js';

export const BERTHS = [1, 2, 2, 3, 4];  // berths per level
const LEN = [4, 5, 6, 8, 9];             // pier length per level, in tiles past the shore
const DECK = 4;                          // the pier's deck height above the water
const SHIP_L = 46, SHIP_HALF = 9, SHIP_Z = 8;
const SAIL_MS = 7500;                    // casting off to out of view
const FRESH_MS = 10 * 60e3;              // a sail older than this when first seen isn't animated
const LANE = 14;                         // porter walking speed, world px/s
const DEMO = typeof location !== 'undefined' && new URLSearchParams(location.search).get('dockdemo') === '1';

export const clampLevel = l => Math.min(5, Math.max(1, Math.round(+l) || 1));
const rnd = s => (hash(s) % 10000) / 10000;

/**
 * Where everything stands, in world px. D is the site from layout(): `cx` the pier's west tile column,
 * `foot` the land row it starts on, `sea` the first water row. Berths alternate west, east, then the
 * next slot out along the pier; `x` is a ship's centre line and `y` its stern (ships point south, out).
 */
export function dockGeom(D, level) {
  const lv = clampLevel(level), X0 = D.cx * T, X1 = X0 + 2 * T, Y0 = D.foot * T + 2, Y1 = (D.sea + LEN[lv - 1]) * T;
  const berths = Array.from({ length: BERTHS[lv - 1] }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    return { i, side, x: side < 0 ? X0 - 7 - SHIP_HALF : X1 + 7 + SHIP_HALF, y: D.sea * T + 6 + (i >> 1) * 64 };
  });
  return { lv, X0, X1, Y0, Y1, berths };
}
/** The tiles the camera's "whole town" fit should include: the cove, the pier foot and the first berths. */
export const dockRect = D => [D.x0, D.foot - 1, D.x1, D.sea + 4];

/** 0–1: checks passed (80%) and an approving review (20%); with no checks, it fills slowly from `since`. */
export function progress(p, now = Date.now()) {
  const c = p.checks || {}, n = (c.passed || 0) + (c.failed || 0) + (c.pending || 0);
  const base = n ? (c.passed || 0) / n : p.since ? Math.min(0.95, 1 - Math.exp(-Math.max(0, now - p.since) / 12e5)) : 0;
  return Math.min(1, base * 0.8 + (p.review === 'approved' ? 0.2 : 0));
}

// ---------- ?dockdemo=1 ----------
// Three PRs loading at different progress, level 4, and one sails every 20 s (the oldest, nearly full).
// It replaces S.dock for the whole page, so the click panel shows the same ships.
const BORN = Date.now();
export const dockDemo = () => DEMO;
export function demoDock(now = Date.now()) {
  const E = 20000, e = Math.floor(now / E), repos = ['agentville', 'lighthouse', 'harbour'], names = ['Ada', 'Bo', 'Cy'];
  const pr = n => { const repo = repos[((n % 3) + 3) % 3]; return { id: 400 + (n % 600), repo, href: `https://github.com/demo/${repo}/pull/${400 + (n % 600)}`, agentId: null, agentName: names[((n % 3) + 3) % 3] }; };
  const loading = [1, 2, 3].map(j => {
    const n = e + j, since = (n - 3) * E, k = Math.min(1, Math.max(0, (now - since) / (3 * E))), total = 6, passed = Math.min(total, Math.floor(k * 7));
    return { ...pr(n), state: 'open', checks: { passed, failed: 0, pending: total - passed }, review: k > 0.72 ? 'approved' : 'pending', since };
  });
  // Sails since the page opened are fresh (animated); older history is an hour old (shown in the panel only).
  const sailed = [0, 1, 2, 3, 4].map(i => { const n = e - i, at = n * E >= BORN ? n * E : BORN - 36e5 - i * 6e4; return { ...pr(n), at }; });
  return { loading, sailed, total: 120 + (e % 1000), level: 4 };
}
/** What the dock shows: the demo, or the server's `S.dock` (undefined while loading: an empty dock). */
export const dockData = S => (DEMO ? demoDock() : S.dock) || { loading: [], sailed: [], total: 0, level: 1 };
/** A short signature of what's at the dock, for the village's redraw-on-change check. */
export const dockSig = d => d ? [d.level, (d.loading || []).map(p => [p.href, p.checks?.passed, p.checks?.failed, p.checks?.pending, p.review]), (d.sailed || []).map(s => s.href)] : null;

// ---------- a tiny rasteriser ----------
const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const INK = hex('#1d1233'), HL = hex('#eaf2ff'); // iso.js's outline; the selection white
const proj = (x, y, z) => [(x - y) * ISO, (x + y) * ISO / 2 - z];
const inv = (X, Y, z) => isoInv(X, Y + z);
const rect = (x0, y0, x1, y1, z) => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
/**
 * Fill each op's polygon (world px corners, projected) in order, pixel centres only (no anti-aliasing).
 * `c` is a colour, or for a flat (horizontal) op a function of the world point (x, y) at height `z`;
 * `a` < 1 is a translucent shadow, kept under whatever is opaque. Then a 1px outline round the
 * opaque silhouette. Returns { img, ox, oy, w, h, data }: the image sits at (ox, oy) in view px.
 */
function rasterize(ops, ink) {
  const P = ops.map(o => o.pts.map(p => proj(...p)));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pts of P) for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = Math.floor(x0) - 1; y0 = Math.floor(y0) - 1;
  const w = Math.ceil(x1) - x0 + 2, h = Math.ceil(y1) - y0 + 2, buf = new Uint8ClampedArray(w * h * 4);
  ops.forEach((o, n) => {
    const pts = P[n], fn = typeof o.c === 'function' ? o.c : null, fixed = fn ? null : typeof o.c === 'string' ? hex(o.c) : o.c, a = o.a ?? 1;
    const ya = Math.min(...pts.map(p => p[1])), yb = Math.max(...pts.map(p => p[1]));
    for (let r = Math.max(0, Math.floor(ya - y0) - 1); r <= Math.min(h - 1, Math.ceil(yb - y0)); r++) {
      const yc = y0 + r + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + (yc - ay) * (bx - ax) / (by - ay));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) for (let c = Math.max(0, Math.ceil(xs[i] - 0.5 - x0)); c <= Math.min(w - 1, Math.floor(xs[i + 1] - 0.5 - x0)); c++) {
        const j = (r * w + c) * 4;
        if (a < 1 && buf[j + 3]) continue;
        const col = fn ? fn(...inv(x0 + c + 0.5, yc, o.z ?? 0)) : fixed;
        if (!col) continue;
        const rgb = typeof col === 'string' ? hex(col) : col;
        buf[j] = rgb[0]; buf[j + 1] = rgb[1]; buf[j + 2] = rgb[2]; buf[j + 3] = Math.round(255 * a);
      }
    }
  });
  if (ink) {
    const src = buf.slice(), solid = (c, r) => c >= 0 && r >= 0 && c < w && r < h && src[(r * w + c) * 4 + 3] === 255;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      if (solid(c, r) || !(solid(c - 1, r) || solid(c + 1, r) || solid(c, r - 1) || solid(c, r + 1))) continue;
      const j = (r * w + c) * 4; buf[j] = ink[0]; buf[j + 1] = ink[1]; buf[j + 2] = ink[2]; buf[j + 3] = 255;
    }
  }
  const img = document.createElement('canvas'); img.width = w; img.height = h;
  img.getContext('2d').putImageData(new ImageData(buf, w, h), 0, 0);
  return { img, ox: x0, oy: y0, w, h, data: buf };
}
/** A box's three faces the viewer (from the south-east) can see: east, south, top. */
function box(ops, x0, y0, z0, x1, y1, z1, top, south, east) {
  ops.push({ pts: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], c: east });
  ops.push({ pts: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], c: south });
  ops.push({ pts: rect(x0, y0, x1, y1, z1), c: top, z: z1 });
}

// ---------- palette (iso.js's woods and stone, hue-shifted shadows) ----------
const SHADOW = '#141e32';
const PLANK = ['#b98a5a', '#a97c4e', '#c29465'].map(hex), SEAM = hex('#6e4a30'), TRIM = hex('#8a5e3a'), NAIL = hex('#4e3426');
const WOOD = ['#8a5e3a', '#6e4a30'], POST = ['#7a5236', '#5e3d27', '#4a3020'], IRON = ['#6a6874', '#4a4856', '#3a3846'];
const STONE = ['#b8b0a2', '#a39a8c', '#8a8276'], HULL = ['#6a4630', '#563824'], CABIN = ['#e3d2a8', '#bfa77e'], ROOF = ['#b5523b', '#8e3d33'];
const SHIPDECK = ['#c8975f', '#bb8a55'].map(hex), DSEAM = hex('#7a4f2e'), RAIL = hex('#8a5a36'), FLOOR = hex('#5e3d27'), THWART = hex('#b08050');
const GLASS = '#3d5687', SAIL = '#f3ead2', SAIL_SH = '#d9caa4', MAST = ['#7a5236', '#6a4630', '#563824'];
const shade = (c, k) => { const a = hex(c), s = hex('#2a1c4a'); return a.map((v, i) => Math.round(v + (s[i] - v) * k)); };

// ---------- models ----------
function pierArt(G, hl) {
  const { X0, X1, Y0, Y1 } = G, ops = [], pitch = 5, seam = 1.3; // a seam >1 view px wide never drops a pixel
  ops.push({ pts: rect(X0 + 2, Y0 + 3, X1 + 5, Y1 + 4, 0), c: SHADOW, a: 0.3 }); // its shadow on the water, cast east
  // Planks run across the pier; a stringer down each side, a pair of nails at each plank's ends.
  const planks = (x, y) => {
    const u = x - X0, v = y - Y0, m = ((v % pitch) + pitch) % pitch;
    if (u < 1.2 || u > X1 - X0 - 1.2) return TRIM;
    if (m < seam) return SEAM;
    if (((u > 3 && u < 4.4) || (u > X1 - X0 - 4.4 && u < X1 - X0 - 3)) && m > seam + 0.6 && m < seam + 2) return NAIL;
    return PLANK[hash(Math.floor(v / pitch)) % 3];
  };
  box(ops, X0, Y0, 1, X1, Y1, DECK, planks, WOOD[0], WOOD[1]);
  // Pilings every 24 px down each side and at the end, poking a little above the deck.
  const posts = [];
  for (let y = Y0 + 12; y < Y1 - 8; y += 24) posts.push([X0 - 1, y], [X1 - 2, y]);
  posts.push([X0 - 1, Y1 - 3], [X1 - 2, Y1 - 3]);
  for (const [x, y] of posts) box(ops, x, y, x < X0 ? DECK : -1, x + 3, y + 3, DECK + 3, POST[0], POST[1], POST[2]);
  for (const b of G.berths) { const x = b.side < 0 ? X0 + 2 : X1 - 6; box(ops, x, b.y + 21, DECK, x + 4, b.y + 25, DECK + 4, IRON[0], IRON[1], IRON[2]); } // a bollard at each berth
  return rasterize(ops, hl ? HL : INK);
}

// Ships point south (+y, out of the cove): stern at y = 0, bow at y = L. `small` is the rowboat.
function shipArt(accent, hl, small) {
  const L = small ? 23 : SHIP_L, half = small ? 6 : SHIP_HALF, Z = small ? 4 : SHIP_Z, taper = small ? 15 : 31;
  const deck = [[-half, 1], [half, 1], [half, taper], [0, L], [-half, taper]];
  const wl = [[-half + 2, 3], [half - 2, 3], [half - 2, taper], [0, L - 3], [-half + 2, taper]];
  const mid = deck.map((p, i) => [p[0] + (wl[i][0] - p[0]) * 0.4, p[1] + (wl[i][1] - p[1]) * 0.4]), zm = Z * 0.6;
  const ops = [{ pts: wl.map(([x, y]) => [x + 3, y + 2, 0]), c: SHADOW, a: 0.3 }];
  // Hull sides: a painted band (the repo's accent) over dark wood; only the faces turned to the viewer.
  const faces = [];
  for (let i = 0; i < deck.length; i++) {
    const j = (i + 1) % deck.length, a = deck[i], b = deck[j], nx = b[1] - a[1], ny = -(b[0] - a[0]);
    if (nx + ny <= 0) continue;
    const lit = ny >= nx, band = small ? WOOD[0] : accent;
    faces.push({ k: a[0] + a[1] + b[0] + b[1], ops: [
      { pts: [[...a, Z], [...b, Z], [...mid[j], zm], [...mid[i], zm]], c: lit ? band : shade(band, 0.3) },
      { pts: [[...mid[i], zm], [...mid[j], zm], [...wl[j], 0], [...wl[i], 0]], c: lit ? HULL[0] : HULL[1] },
    ] });
  }
  for (const fc of faces.sort((p, q) => p.k - q.k)) ops.push(...fc.ops);
  const pitch = 4.5, seam = 1.3;
  const edge = y => (y < taper ? half : half * (L - y) / (L - taper));
  const top = (x, y) => {
    if (Math.abs(x) > edge(y) - 1.4 || y < 2.4) return RAIL;
    if (small) return (y > 7 && y < 8.8) || (y > 12.5 && y < 14.2) ? THWART : FLOOR;
    return ((x + 20) % pitch) < seam ? DSEAM : SHIPDECK[Math.floor((x + 20) / pitch) % 2];
  };
  ops.push({ pts: deck.map(p => [...p, Z]), c: top, z: Z });
  if (!small) {
    box(ops, -6, 3, Z, 6, 12, Z + 9, ROOF[0], CABIN[0], CABIN[1]); // the deckhouse aft
    ops.push({ pts: [[-2, 12.05, Z + 2], [2, 12.05, Z + 2], [2, 12.05, Z + 6], [-2, 12.05, Z + 6]], c: GLASS });
    box(ops, -1, 21, Z, 1, 23, Z + 38, MAST[0], MAST[1], MAST[2]);
    box(ops, -12, 21.6, Z + 33, 12, 22.4, Z + 34.5, MAST[0], MAST[1], MAST[2]); // the yard
    // A square sail facing the bow, striped in the accent.
    const sail = (za, zb, c) => ops.push({ pts: [[-11, 23.6, za], [11, 23.6, za], [11, 23.6, zb], [-11, 23.6, zb]], c });
    sail(Z + 11, Z + 12, SAIL_SH); sail(Z + 12, Z + 19, SAIL); sail(Z + 19, Z + 24, accent); sail(Z + 24, Z + 32.5, SAIL);
    box(ops, -0.8, L - 2, Z + 0.5, 0.8, L + 7, Z + 2, MAST[0], MAST[1], MAST[2]); // bowsprit
  }
  return rasterize(ops, hl ? HL : INK);
}

// The warehouse (level 3+): a plank shed with a red gabled roof, west of the pier foot.
function shedRect(D) { return [(D.cx - 4) * T + 2, (D.foot - 1) * T + 3, (D.cx - 1) * T - 3, (D.foot + 1) * T - 5]; }
function shedArt(D, hl) {
  const [x0, y0, x1, y1] = shedRect(D), ym = (y0 + y1) / 2, H = 16, R = 25, ops = [];
  ops.push({ pts: rect(x0 + 3, y0 - 2, x1 + 8, y1 + 2, 0), c: SHADOW, a: 0.3 });
  ops.push({ pts: [[x1, y0, 0], [x1, y1, 0], [x1, y1, H], [x1, ym, R], [x1, y0, H]], c: WOOD[1] }); // east gable
  ops.push({ pts: [[x0, y1, 0], [x1, y1, 0], [x1, y1, H], [x0, y1, H]], c: WOOD[0] }); // south wall
  for (let z = 4; z < H; z += 4) ops.push({ pts: [[x0, y1 + 0.02, z], [x1, y1 + 0.02, z], [x1, y1 + 0.02, z + 0.9], [x0, y1 + 0.02, z + 0.9]], c: WOOD[1] }); // clapboards
  const dx = (x0 + x1) / 2;
  ops.push({ pts: [[dx - 8, y1 + 0.05, 0], [dx + 8, y1 + 0.05, 0], [dx + 8, y1 + 0.05, 12], [dx - 8, y1 + 0.05, 12]], c: '#4a3020' }); // the big door
  ops.push({ pts: [[dx - 0.6, y1 + 0.08, 0], [dx + 0.6, y1 + 0.08, 0], [dx + 0.6, y1 + 0.08, 12], [dx - 0.6, y1 + 0.08, 12]], c: '#2e1d14' });
  ops.push({ pts: [[x0 - 2, y0 - 2, H - 1], [x1 + 2, y0 - 2, H - 1], [x1 + 2, ym, R + 0.5], [x0 - 2, ym, R + 0.5]], c: ROOF[1] });
  ops.push({ pts: [[x0 - 2, ym, R + 0.5], [x1 + 2, ym, R + 0.5], [x1 + 2, y1 + 2, H - 1], [x0 - 2, y1 + 2, H - 1]], c: ROOF[0] });
  for (let k = 1; k < 4; k++) { const y = ym + (y1 + 2 - ym) * k / 4, z = R + 0.5 - (R + 1.5 - H) * k / 4; ops.push({ pts: [[x0 - 2, y, z], [x1 + 2, y, z], [x1 + 2, y + 0.9, z - 0.5], [x0 - 2, y + 0.9, z - 0.5]], c: shade('#b5523b', 0.25) }); } // shingle courses
  return rasterize(ops, hl ? HL : INK);
}

// The crane (level 4+): a stone footing on the east bank, a post and a jib out over the water.
const craneAt = D => [(D.cx + 3) * T + 4, D.foot * T + 2];
function craneArt(D, hl) {
  const [bx, by] = craneAt(D), tipY = D.sea * T + 2, ops = [];
  ops.push({ pts: rect(bx + 2, by + 2, bx + 16, by + 14, 0), c: SHADOW, a: 0.3 });
  box(ops, bx, by, 0, bx + 12, by + 12, 5, STONE[0], STONE[1], STONE[2]);
  box(ops, bx + 3, by - 6, 36, bx + 9, by + 3, 43, IRON[0], IRON[1], IRON[2]); // counterweight
  box(ops, bx + 4, by + 4, 5, bx + 8, by + 8, 42, MAST[0], MAST[1], MAST[2]);
  ops.push({ pts: [[bx + 8, by + 8, 26], [bx + 8, by + 22, 38], [bx + 8, by + 22, 39.5], [bx + 8, by + 8, 27.8]], c: MAST[2] }); // a brace
  box(ops, bx + 5, by + 3, 38, bx + 7, tipY, 41, MAST[0], MAST[1], MAST[2]);
  return rasterize(ops, hl ? HL : INK);
}

// An 8×8 crate (the pack's ui/Crate.png is 16 px: too big for a deck this size), and a pennant per colour.
function glyph(map, pal) {
  const c = document.createElement('canvas'); c.width = map[0].length; c.height = map.length;
  const g = c.getContext('2d');
  map.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
}
let CRATE = null;
const crate = () => (CRATE ||= glyph(['.oooooo.', 'oLLLLLLo', 'oDmmmmDo', 'omDmmDmo', 'ommDDmmo', 'omDmmDmo', 'oDmmmmDo', 'oooooooo'],
  { o: '#2a1a14', L: '#e0b070', m: '#b07a42', D: '#7a4f2e' }));
const pennants = new Map();
const pennant = (color, fr) => {
  const k = `${color}|${fr}`;
  if (!pennants.has(k)) pennants.set(k, glyph(fr ? ['ooooo..', 'occcooo', 'occccco', 'ooooooo'] : ['oooooo.', 'occccoo', 'occco..', 'ooo....'], { o: '#1d1233', c: color }));
  return pennants.get(k);
};

// ---------- the dock in a frame ----------
/** H: the renderer's helpers { drawLamp, flagSheet }. */
export function createDockArt(H) {
  const KEY = DEMO ? 'va.dock.sailed.demo' : 'va.dock.sailed';
  const seen = new Set(store.get(KEY, []));
  const berthOf = new Map(), lastBerth = new Map(); // href → berth: loading now / when last seen loading
  let sails = [];
  const arts = new Map(), art = (k, make) => { if (!arts.has(k)) arts.set(k, make()); return arts.get(k); };
  let hits = [], lights = [], tags = [], parts = [], ground = [], wakes = [];

  // Berths: a ship underway keeps its berth until it's gone; a loading PR keeps its berth while it
  // loads; a newly merged PR casts off from the berth it was loading at (or a free one, if this page
  // never saw it load); a new PR takes a free berth. PRs beyond the berths wait off-screen.
  function step(data, now, still, n) {
    const sailed = data.sailed || [], gone = new Set(sailed.map(s => s.href));
    const loading = (data.loading || []).filter(p => p.href && !gone.has(p.href))
      .sort((a, b) => (a.since || 0) - (b.since || 0) || String(a.href).localeCompare(String(b.href)));
    const live = new Set(loading.map(p => p.href));
    for (const [h, b] of berthOf) if (!live.has(h) || b >= n) berthOf.delete(h);
    let dirty = false;
    for (const s of sailed) {
      if (!s.href || seen.has(s.href)) continue;
      seen.add(s.href); dirty = true;
      if (still || now - (s.at || 0) > FRESH_MS) continue; // old news (first load), or motion is off: just mark it seen
      sails.push({ href: s.href, id: s.id, repo: s.repo, want: lastBerth.get(s.href), berth: null, t0: null, queued: now });
    }
    if (dirty) store.set(KEY, [...seen].slice(-400));
    if (still) sails = [];
    sails = sails.filter(s => (s.t0 == null ? now - s.queued < 30e3 : now - s.t0 < SAIL_MS));
    const used = new Set(berthOf.values());
    for (const s of sails) if (s.t0 != null) used.add(s.berth);
    const free = want => (want != null && want < n && !used.has(want) ? want : [...Array(n).keys()].find(b => !used.has(b)) ?? null);
    for (const s of sails) if (s.t0 == null) { const b = free(s.want); if (b == null) continue; s.berth = b; s.t0 = now; used.add(b); }
    for (const p of loading) if (!berthOf.has(p.href)) { const b = free(lastBerth.get(p.href)); if (b == null) break; berthOf.set(p.href, b); used.add(b); }
    for (const [h, b] of berthOf) { lastBerth.delete(h); lastBerth.set(h, b); }
    while (lastBerth.size > 200) lastBerth.delete(lastBerth.keys().next().value);
    return { loading: loading.filter(p => berthOf.has(p.href)).map(p => ({ p, berth: berthOf.get(p.href) })), sails: sails.filter(s => s.t0 != null) };
  }

  /** Lay out this frame's dock: the ground layer (pier, wakes), the upright parts for the depth sort, hits. */
  function frame(f, W) {
    hits = []; lights = []; tags = []; parts = []; ground = []; wakes = [];
    const D = W.dock;
    if (!D) return;
    const { t, still } = f, data = f.dock || {}, now = Date.now(), G = dockGeom(D, data.level);
    const V = (x, y, z = 0) => { const [X, Y] = isoP(x, y); return [X, Y - z]; };
    const hlDock = f.dockHover === 'dock', f8 = Math.floor(t * 8);
    // isoSort's fields: the ground footprint (world px; a point for anything upright) and the screen rect.
    const pt = (d, fx, fy, sx0, sy0, sx1, sy1) => Object.assign(d, { fx0: fx, fx1: fx, fy0: fy, fy1: fy, sx0, sy0, sx1, sy1 });
    const area = (d, fx0, fy0, fx1, fy1, a) => Object.assign(d, { fx0, fy0, fx1, fy1, sx0: a.ox, sy0: a.oy, sx1: a.ox + a.w, sy1: a.oy + a.h });

    const pier = art(`pier|${G.lv}|${hlDock}`, () => pierArt(G, hlDock));
    ground.push(pier);
    hits.push({ key: 'dock', x: pier.ox, y: pier.oy, w: pier.w, h: pier.h, art: pier });
    if (G.lv >= 3) { const a = art(`shed|${hlDock}`, () => shedArt(D, hlDock)), [x0, y0, x1, y1] = shedRect(D); parts.push(area({ dk: 'art', a }, x0, y0, x1, y1, a)); hits.push({ key: 'dock', x: a.ox, y: a.oy, w: a.w, h: a.h, art: a }); }
    if (G.lv >= 4) {
      const a = art(`crane|${hlDock}`, () => craneArt(D, hlDock)), [bx, by] = craneAt(D);
      const tip = V(bx + 6, D.sea * T + 1, 38), sway = still ? 0 : Math.round(Math.sin(t * 1.3) * 1.2);
      parts.push(area({ dk: 'art', a, rope: [Math.round(tip[0]), Math.round(tip[1]), sway] }, bx, by - 6, bx + 12, D.sea * T + 2, a));
      hits.push({ key: 'dock', x: a.ox, y: a.oy, w: a.w, h: a.h, art: a });
    }
    // Lamps at the pier head from level 2 (the street lamp's own drawing); the flag at 5.
    const lamps = G.lv >= 5 ? [[G.X0 + 3, G.Y1 - 4], [G.X1 - 3, G.Y1 - 4]] : G.lv >= 2 ? [[G.X0 + 3, G.Y1 - 4]] : [];
    for (const [x, y] of lamps) { const [X, Y] = V(x, y, DECK).map(Math.round); parts.push(pt({ lamp: 1, x: X, y: Y }, x, y, X - 3, Y - 24, X + 3, Y)); lights.push([X, Y - 19, 48, 1]); }
    if (G.lv >= 5) { const fx = G.X1 + 6, fy = G.Y0 + 8, [X, Y] = V(fx, fy).map(Math.round); parts.push(pt({ dk: 'flag', x: X, y: Y, fr: still ? 0 : (Math.floor(t * 4) + 1) % 4 }, fx, fy, X - 2, Y - 40, X + 16, Y)); }

    // The rowboat, always tied up at the pier head.
    const bob = (seed, rate = 1.5) => (still ? 0 : (Math.floor(t * rate + rnd(seed) * 2) % 2));
    {
      const a = art(`boat|${hlDock}`, () => shipArt(null, hlDock, true)), x = (G.X0 + G.X1) / 2, y = G.Y1 + 3;
      const [X, Y] = V(x, y).map(Math.round), by = Y + bob('rowboat', 1.1);
      parts.push(area({ dk: 'ship', a, ax: X, ay: by, alpha: 1 }, x - 6, y, x + 6, y + 23, { ox: X + a.ox, oy: by + a.oy, w: a.w, h: a.h }));
      hits.push({ key: 'dock', x: X + a.ox, y: by + a.oy, w: a.w, h: a.h, art: a });
      wakes.push(...ripples(V, x, y, 6, 20, f8, 'rowboat', still));
    }

    const { loading, sails } = step(data, now, still, G.berths.length);
    const piles = { [-1]: 0, 1: 0 };
    const ship = (o) => {
      const { key, x, y, accent, alpha = 1 } = o, hl = f.dockHover === key;
      const a = art(`ship|${accent}|${hl}`, () => shipArt(accent, hl, false));
      const [X, Y] = V(x, y).map(Math.round), ay = Y + (o.moving ? 0 : bob(key));
      const d = { dk: 'ship', a, ax: X, ay, alpha, crates: o.crates || 0, pen: o.pen, fr: still ? 0 : (f8 >> 1) % 2, V };
      parts.push(area(d, x - SHIP_HALF, y, x + SHIP_HALF, y + SHIP_L, { ox: X + a.ox, oy: ay + a.oy - 8, w: a.w, h: a.h + 8 }));
      hits.push({ key, x: X + a.ox, y: ay + a.oy, w: a.w, h: a.h, art: a });
      if (f.zoom >= 3 && o.id != null) tags.push({ key: `d:${key}`, text: `#${o.id}`, x: X, y: ay + 22 });
    };
    for (const { p, berth } of loading) {
      const b = G.berths[berth], prog = progress(p, now), c = p.checks || {}, key = `ship:${p.href}`;
      const accent = ACCENT[hash(p.repo || p.href) % ACCENT.length], crates = Math.round(prog * 4);
      const pen = (c.failed || 0) > 0 ? '#e5383b' : p.review === 'approved' ? '#2f9e5b' : '#f4efe4';
      ship({ key, x: b.x, y: b.y, accent, crates, pen, id: p.id });
      wakes.push(...ripples(V, b.x, b.y, SHIP_HALF, 36, f8, key, still));
      piles[b.side] += 4 - crates;
      // The porter: out along its side of the pier with a crate, back empty, until the ship is full.
      const lane = b.side < 0 ? G.X0 + 9 : G.X1 - 9, y0 = G.Y0 + 16, y1 = b.y + 18, span = y1 - y0, walk = span / LANE, leg = walk + 0.8;
      const done = prog >= 1, u = still || done ? walk / 2 : (t + rnd(p.href) * leg * 2) % (leg * 2), back = u >= leg, s = back ? u - leg : u, k = Math.min(1, s / walk);
      const wy = done ? y1 : back ? y1 - span * k : y0 + span * k, moving = !still && !done && s < walk;
      const look = f.agents?.get(p.agentId)?.look || LOOKS[hash(p.agentId || p.href) % LOOKS.length];
      const v = { a: { id: `dock:${p.href}`, role: 'solo', bucket: 'dock', name: p.agentName }, look, pose: done || back ? 'stand' : 'carry', phase: rnd(p.href), own: false };
      const [X, Y] = V(lane, wy, DECK).map(Math.round), left = X - 8;
      const vd = { v, ghost: false, left, feet: Y, top: Y - 18, dir: done ? (b.side < 0 ? 2 : 3) : back ? 1 : 0, row: moving ? Math.floor(t * 8) % 4 : 0, bob: 0, moving };
      parts.push(pt({ vd }, lane, wy, left - 2, Y - 32, left + 18, Y + 3));
      hits.push({ key, x: left - 1, y: Y - 26, w: 18, h: 27 });
    }
    for (const side of [-1, 1]) if (piles[side]) {
      const x = side < 0 ? G.X0 + 7 : G.X1 - 7, y = G.Y0 + 8, [X, Y] = V(x, y, DECK).map(Math.round);
      parts.push(pt({ dk: 'pile', n: Math.min(6, piles[side]), x: X, y: Y }, x, y, X - 12, Y - 24, X + 12, Y));
    }
    // Sailing: ease out sideways from the berth, then away south, faster and faster, off the edge of the
    // view (its distance is fixed when it casts off), fading over the last moment in case the view moved.
    for (const s of sails) {
      const b = G.berths[s.berth];
      if (!b) continue;
      const accent = ACCENT[hash(s.repo || s.href) % ACCENT.length], key = `ship:${s.href}`, el = (now - s.t0) / 1000;
      if (s.D == null) {
        const a = art(`ship|${accent}|false`, () => shipArt(accent, false, false)), [X, Y] = V(b.x + b.side * 24, b.y);
        const fy = f.vy + f.bh - (Y + a.oy), fx = X + a.ox + a.w - f.vx;
        s.D = Math.min(4000, Math.max(80, Math.min(fy / (ISO / 2), fx / ISO) + 24)); // off the bottom or the left edge
      }
      const out = Math.min(1, el / 2.2), dx = b.side * 24 * out * out * (3 - 2 * out), q = Math.max(0, (el - 0.8) / 6.7), dy = s.D * q * q;
      ship({ key, x: b.x + dx, y: b.y + dy, accent, crates: 4, pen: '#2f9e5b', moving: true, alpha: el > 6.7 ? Math.max(0, 1 - (el - 6.7) / 0.8) : 1, id: s.id });
      const speed = el < 0.8 ? 0 : 2 * s.D * q / 6.7;
      wakes.push(...wake(V, b.x + dx, b.y + dy, speed, f8, still));
    }
  }

  // Foam: a V trailing a ship underway (longer the faster it goes), and little ripples along a moored hull.
  function wake(V, x, y, speed, f8, still) {
    const out = [], n = Math.min(7, 2 + Math.floor(speed / 12));
    for (let j = 0; j < n; j++) for (const sd of [-1, 1]) {
      if (!still && (f8 + j) % 4 === 0) continue;
      const [X, Y] = V(x + sd * (3 + j * 2.4), y - 1 - j * 4.5);
      out.push([Math.round(X), Math.round(Y), j < 2 ? 4 : 3, j > 4 ? 0.5 : 0.9]);
    }
    for (const sd of [-1, 1]) { const [X, Y] = V(x + sd * 5, y + SHIP_L - 6); out.push([Math.round(X), Math.round(Y), 2, 0.8]); }
    return out;
  }
  function ripples(V, x, y, half, len, f8, seed, still) {
    const out = [], o = Math.floor(rnd(seed) * 8);
    for (const sd of [-1, 1]) for (let j = 0; j < 2; j++) {
      const k = still ? j * 2 : (f8 + o + j * 3) % 6;
      if (k > 3) continue;
      const [X, Y] = V(x + sd * (half + 2), y + 6 + ((j * 17 + k * 5 + o) % len));
      out.push([Math.round(X), Math.round(Y), 3, 0.5]);
    }
    return out;
  }

  /** The ground layer, drawn right after the terrain: the pier and the foam on the water. */
  function drawGround(ctx) {
    for (const a of ground) ctx.drawImage(a.img, a.ox, a.oy);
    ctx.fillStyle = '#e9fbff';
    for (const [x, y, w, al] of wakes) { ctx.globalAlpha = al; ctx.fillRect(x, y, w, 1); }
    ctx.globalAlpha = 1;
  }
  /** An upright part in the depth-sorted list (villager-shaped parts are drawn by the renderer). */
  function draw(ctx, d, f) {
    if (d.dk === 'art') {
      ctx.drawImage(d.a.img, d.a.ox, d.a.oy);
      if (d.rope) { // the crane's hook: a crate swinging on its rope
        const [x, y, s] = d.rope;
        ctx.fillStyle = '#3a2a22'; ctx.fillRect(x, y, 1, 14); ctx.fillRect(x + Math.sign(s), y + 10, 1, 6);
        ctx.drawImage(crate(), x - 4 + s, y + 15);
      }
    } else if (d.dk === 'ship') {
      ctx.globalAlpha = d.alpha;
      ctx.drawImage(d.a.img, d.ax + d.a.ox, d.ay + d.a.oy);
      if (d.V) {
        // Cargo forward of the mast, 2×2, as it's loaded; the pennant at the masthead says how it's going.
        const at = (lx, ly, z) => { const [ox, oy] = d.V(0, 0, 0), [X, Y] = d.V(lx, ly, z); return [d.ax + Math.round(X - ox), d.ay + Math.round(Y - oy)]; };
        const spots = [[-4, 30, 0], [4, 30, 0], [0, 37, 0], [0, 30, 1]];
        for (let i = 0; i < d.crates; i++) { const [lx, ly, l] = spots[i], [X, Y] = at(lx, ly, SHIP_Z); ctx.drawImage(crate(), X - 4, Y - 7 - l * 6); }
        const [mx, my] = at(0, 22, SHIP_Z + 38);
        ctx.drawImage(pennant(d.pen, d.fr), mx, my - 1);
      }
      ctx.globalAlpha = 1;
    } else if (d.dk === 'pile') {
      const c = crate(); // rows of 3, 2, 1, each nested on the one below
      let i = 0;
      for (let r = 0; r < 3 && i < d.n; r++) for (let k = 0; k < 3 - r && i < d.n; k++, i++) ctx.drawImage(c, d.x - 11 + r * 4 + k * 7, d.y - 8 - r * 6);
    } else if (d.dk === 'flag') {
      ctx.fillStyle = '#140f1c'; ctx.fillRect(d.x - 1, d.y - 38, 3, 38);
      ctx.fillStyle = '#c98a4a'; ctx.fillRect(d.x, d.y - 37, 1, 36);
      ctx.drawImage(H.flagSheet('#e4572e'), d.fr * 16, 0, 16, 16, d.x + 1, d.y - 40, 16, 16);
    }
  }
  /** The dock part under a view-px point (opaque pixels only, for drawn art): { key } or null. */
  function hit(x, y) {
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i], c = Math.floor(x - h.x), r = Math.floor(y - h.y);
      if (c < 0 || r < 0 || c >= h.w || r >= h.h) continue;
      if (!h.art || h.art.data[(r * h.w + c) * 4 + 3] > 0) return { key: h.key };
    }
    return null;
  }
  return {
    frame, drawGround, draw, hit,
    get parts() { return parts; }, get lights() { return lights; }, get tags() { return tags; },
    debug: () => ({ berths: [...berthOf], sails: sails.map(s => ({ href: s.href, berth: s.berth, t0: s.t0 })), parts: parts.length }),
  };
}
