// The harbour (owner, 2026-11-11: "a cute little dock on our island"; 2026-11-12: "make the port scale
// with how many PRs we are handling … in a more interesting way"). Each PR being shipped is a boat at a
// berth; villagers walk crates there from town (dock-walk.js) while checks pass and review lands, and
// when the PR merges the boat casts off and sails out to sea.
//
// The port grows in character with the PRs in flight (the loading count, with a hysteresis: it grows at
// once and shrinks only after SHRINK_MS of needing less):
//   tier 1 (1–3)   a single wooden jetty off the beach;
//   tier 2 (4–7)   a stone quay along the shore with three wooden finger piers, a fenced crate yard on
//                  land where crates pile up with the cargo still waiting, channel buoys, two cranes;
//   tier 3 (8–12)  a fourth pier, a curved stone breakwater round the basin with a lighthouse at its tip
//                  (it sweeps a beam at night) and a beacon on the east mole, a row of warehouses on the
//                  quay, a crane on every pier, and a tug that escorts each departing ship out of the mouth;
//   tier 4 (13+)   a fifth pier and longer piers (the basin and breakwater move out to sea), rowboats
//                  pottering about the basin, and gulls wheeling overhead.
// Boats come in three classes by PR size (`size: { additions, deletions, files }`, missing = medium): a
// dinghy (< 50 lines), a sloop, and a two-masted brig (> 500 lines or > 20 files) that needs a long
// berth; brigs take the pier-head berths. PRs that find no berth ride at anchor outside.
// Lifetime `level` (1–5) still adds its touches: lamps on the pier heads (2+), the warehouse (3+), the
// crane (4+, tier 1; the quay has its own from tier 2) and the flag (5).
//
// world.js reserves the site (the cove is cut wide enough for tier 4, so the village never reshuffles
// when the tier changes) and calls this file for the art. Everything is drawn in code: models are flat
// faces in world px (x east, y south, z up), rasterised pixel-exact into cached canvases like iso.js
// does, so they stay crisp at every zoom. Static pieces are cached per site, tier and level.
// Data: `S.dock` (see dockData).
import { T, ISO, isoP, isoInv, hash, ACCENT } from './world.js';
import { store } from './ui.js';
import { createWalkers, line } from './dock-walk.js';

export const clampLevel = l => Math.min(5, Math.max(1, Math.round(+l) || 1));
const Q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const DEMO = Q.get('dockdemo') === '1';
const DEMO_N = (n => (Number.isFinite(n) ? Math.max(0, Math.min(40, n)) : 3))(Number.parseInt(Q.get('prs') ?? '3', 10));
const DEMO_LV = clampLevel(Q.get('level') ?? 4);

const DECK = 4, QZ = 6, BWZ = 8;   // heights: pier deck, quay, breakwater
const U = 26;                       // a berth unit along a pier (a dinghy takes 1, a sloop 2, a brig 3)
const PITCH = 112, PW = 32;         // finger pier spacing and width
const FRESH_MS = 10 * 60e3;         // a sail older than this when first seen isn't animated; a queued one waits at most this long
const STAGGER_MS = 6000;            // several sails at once cast off one by one, this far apart
const SHRINK_MS = 10 * 60e3;        // the harbour shrinks only after needing a smaller tier this long

export const SHIPS = {
  dinghy: { L: 26, half: 6, Z: 5, n: 1, crates: 1, spots: [[2.6, 16, 0]], mast: [0, 9.6, 27] },
  sloop: { L: 46, half: 9, Z: 8, n: 2, crates: 4, spots: [[-4, 30, 0], [4, 30, 0], [0, 37, 0], [0, 30, 1]], mast: [0, 22, 46] },
  cargo: { L: 72, half: 12, Z: 10, n: 3, crates: 6, spots: [[-4.5, 18.5, 0], [4.5, 18.5, 0], [-4.5, 26, 0], [4.5, 26, 0], [-4.5, 18.5, 1], [4.5, 26, 1]], mast: [0, 31, 62] },
};
/** A PR's boat by its size: small (< 50 lines) a dinghy, large (> 500 lines or > 20 files) a brig. */
export function shipClass(size) {
  if (!size || typeof size !== 'object') return 'sloop';
  const lines = (+size.additions || 0) + (+size.deletions || 0), files = +size.files || 0;
  return lines > 500 || files > 20 ? 'cargo' : lines < 50 ? 'dinghy' : 'sloop';
}

// ---------- tiers ----------
export const tierFor = n => (n <= 3 ? 1 : n <= 7 ? 2 : n <= 12 ? 3 : 4);
let held = { tier: 1, low: 0 };
/** The harbour's tier for the PRs loading now: grows at once, shrinks after SHRINK_MS of needing less. */
export function harbourTier(data, now = Date.now()) {
  const need = tierFor((data?.loading || []).length);
  if (need >= held.tier) held = { tier: need, low: 0 };
  else if (!held.low) held.low = now;
  else if (now - held.low > SHRINK_MS) held = { tier: need, low: 0 };
  return held.tier;
}

// ---------- geometry ----------
const LAYOUT = [null, { piers: [0], units: 4 }, { piers: [-1, 0, 1], units: 4 }, { piers: [-2, -1, 0, 1], units: 5 }, { piers: [-2, -1, 0, 1, 2], units: 6 }];
const geoms = new Map();
/**
 * Where everything stands, in world px. D is the site from layout(): `cx` the main pier's west tile
 * column (under the town square), `foot` the shore row, `sea` the first water row. Piers point south;
 * each side of a pier is a lane of `units` berth units from `y0` (its quay end) outwards. A ship at a
 * slot { lane, u0, cls } lies along its lane, bow out to sea.
 */
export function harbourGeom(D, tier, level) {
  const tr = Math.min(4, Math.max(1, tier | 0 || 1)), lv = clampLevel(level), key = `${D.cx},${D.foot},${tr},${lv}`;
  if (geoms.has(key)) return geoms.get(key);
  const Lt = LAYOUT[tr], OX = D.cx * T, Yf = D.foot * T, Ys = D.sea * T, QF = Ys + 32, quay = tr >= 2;
  const y0 = quay ? QF + 4 : Ys + 6, Y1 = y0 + Lt.units * U;
  const piers = Lt.piers.map(k => ({ k, X0: OX + k * PITCH, X1: OX + k * PITCH + PW, Y0: quay ? QF : Yf + 2, Y1 }));
  const lanes = [];
  for (const p of piers) for (const side of [-1, 1]) {
    lanes.push({ id: `${p.k}${side < 0 ? 'w' : 'e'}`, pier: p, side, edge: side < 0 ? p.X0 - 7 : p.X1 + 7, walk: side < 0 ? p.X0 + 9 : p.X1 - 9, fair: side < 0 ? p.X0 - 40 : p.X1 + 40, y0, units: Lt.units });
  }
  lanes.sort((a, b) => Math.abs(a.pier.k) - Math.abs(b.pier.k) || a.pier.k - b.pier.k || a.side - b.side); // the main pier first
  const Xmin = piers[0].X0, Xmax = piers[piers.length - 1].X1;
  const G = { key, tier: tr, lv, D, OX, Yf, Ys, QF, QL: QF - 9, y0, Y1, piers, lanes, laneById: new Map(lanes.map(l => [l.id, l])), sheds: [], cranes: [], buoys: [], lamps: [] };
  if (quay) {
    G.quay = { x0: Xmin - 64, x1: Xmax + 64, y0: Yf + 4, y1: QF };
    G.yard = { x0: OX + 3 * T, y0: Yf - 3 * T + 3, x1: OX + 7 * T - 6, y1: Yf - 1 };
    G.yardTile = [D.cx + 3, D.foot - 1];
    G.yardPick = [(D.cx + 3) * T + 8, (D.foot - 1) * T + 8];
    G.cranes = (tr === 2 ? piers.filter(p => p.k) : piers).map(p => ({ bx: p.X0 + 10, by: y0 + 24, z0: DECK, tipX: p.X1 + 16 }));
  }
  if (tr >= 3) {
    const BL = Y1 + 26, yb = Y1 + 66, hw = 9, R = 44, xw = Xmin - 72, mouth = Xmax + 72, tip = mouth - 30, xe = mouth + 38;
    const arc = [];
    for (let i = 0; i <= 6; i++) { const a = Math.PI - (i / 6) * (Math.PI / 2); arc.push([xw + R + R * Math.cos(a), yb - R + R * Math.sin(a)]); }
    const segs = [...armSegs([[xw, QF - 4], ...arc, [tip, yb]], hw, 1), ...armSegs([[xe, QF - 4], [xe, yb + 4]], hw, -1)];
    G.bw = { BL, yb, hw, xw, mouth, tip, xe, segs, light: [tip, yb, BWZ + 48], beacon: [xe, yb + 6, BWZ + 18] };
    G.quay.x0 = xw - hw - 2; G.quay.x1 = xe + hw + 2;
    G.tugIdle = [tip - 74, yb - hw - 14];
    G.buoys = [[mouth - 24, yb + 38, 'r'], [mouth + 24, yb + 38, 'g'], [mouth - 30, yb + 96, 'r'], [mouth + 30, yb + 96, 'g']];
    G.anchor = [];
    for (let x = xw + 30; x < tip - 30; x += 46) G.anchor.push([x, yb + 70]);
  } else {
    const ay = Y1 + 66;
    G.anchor = [...piers.map(p => [p.X0 + 16, ay]), [Xmin - 96, ay], [Xmax + 96, ay - 8], [Xmin - 200, ay + 6], [Xmax + 200, ay]];
    if (quay) { const fairs = [...new Set(lanes.map(l => l.fair))].sort((a, b) => a - b); for (const x of fairs) G.buoys.push([x - 21, Y1 + 24, 'r'], [x + 21, Y1 + 24, 'g']); }
  }
  // The warehouses stand on the quay between the piers (not by the yard): one (the level's) at tier 2,
  // a row from tier 3. The west end of the quay gets one too.
  if (quay) {
    const gaps = [[G.quay.x0 + 4, Xmin - 12]];
    for (let i = 0; i + 1 < piers.length; i++) if (piers[i].k !== 0) gaps.push([piers[i].X1 + 9, piers[i + 1].X0 - 9]);
    const want = tr >= 3 ? gaps : lv >= 3 ? gaps.filter(g => g[0] > Xmin).slice(-1) : [];
    want.forEach(([a, b], i) => G.sheds.push({ r: [a, Yf + 5, b, QF - 19], z0: QZ, roof: i % ROOFS.length }));
    G.lamps.push([G.quay.x0 + 6, QF - 4, QZ], [OX - 8, QF - 4, QZ], [G.quay.x1 - 6, QF - 4, QZ]);
  }
  if (lv >= 2) for (const p of piers) { G.lamps.push([p.X0 + 3, p.Y1 - 4, DECK]); if (lv >= 5) G.lamps.push([p.X1 - 3, p.Y1 - 4, DECK]); }
  if (lv >= 5) G.flag = quay ? [OX - 18, Yf + 12, QZ] : [piers[0].X1 + 6, piers[0].Y0 + 8, 0];
  // Walkers stand on the quay (QZ), a pier deck (DECK) or the land (0).
  G.zAt = (x, y) => {
    const q = G.quay;
    if (q && x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1) return QZ;
    for (const p of piers) if (x >= p.X0 - 1 && x <= p.X1 + 1 && y >= p.Y0 && y <= p.Y1) return DECK;
    return 0;
  };
  geoms.set(key, G);
  return G;
}
/** The harbour for this data: its tier (with the hysteresis) and the data's lifetime level. */
export const harbourFor = (D, data, now = Date.now()) => harbourGeom(D, harbourTier(data, now), data?.level);

// A breakwater arm as quads along its centreline (each joint overlapped a little), `out` = which side is the sea.
function armSegs(pts, hw, out) {
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], len = Math.hypot(bx - ax, by - ay), dx = (bx - ax) / len, dy = (by - ay) / len;
    const e = i + 2 < pts.length ? 2 : 0, s = i ? 2 : 0, nx = -dy * out, ny = dx * out; // n: towards the sea
    const A = [ax - dx * s, ay - dy * s], B = [bx + dx * e, by + dy * e];
    const quad = [[A[0] + nx * hw, A[1] + ny * hw], [B[0] + nx * hw, B[1] + ny * hw], [B[0] - nx * hw, B[1] - ny * hw], [A[0] - nx * hw, A[1] - ny * hw]];
    const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
    segs.push({ quad, a: A, b: B, n: [nx, ny], len: len + s + e, fx0: Math.min(...xs), fy0: Math.min(...ys), fx1: Math.max(...xs), fy1: Math.max(...ys) });
  }
  return segs;
}

/** Where a slot's ship lies: its centre line x and its middle cy (it points south). */
export function slotPos(G, slot) {
  const l = G.laneById.get(slot.lane), S = SHIPS[slot.cls] || SHIPS.sloop;
  return l ? { x: l.edge + l.side * S.half, cy: l.y0 + (slot.u0 + S.n / 2) * U } : null;
}
/** Plain berth positions for the fallback renderer: the first n slots as sloops ({ x, y } stern). */
export function previewSlots(G, n) {
  const out = [];
  for (let u = 0; u + 2 <= (G.lanes[0]?.units || 0) && out.length < n; u += 2) for (const l of G.lanes) if (out.length < n) { const p = slotPos(G, { lane: l.id, u0: u, cls: 'sloop' }); out.push({ x: p.x, y: p.cy - 23 }); }
  return out;
}
/** The tiles the camera's "whole town" fit should include: the harbour at its current size. */
export function dockRect(D, G) {
  if (!G) return [D.cx - 3, D.foot - 3, D.cx + 4, D.sea + 4];
  const x0 = G.quay ? G.quay.x0 : G.piers[0].X0 - 48, x1 = G.quay ? G.quay.x1 : G.piers[G.piers.length - 1].X1 + 48, y1 = G.bw ? G.bw.yb + 18 : G.Y1 + 24;
  return [Math.floor(x0 / T), D.foot - 3, Math.floor(x1 / T), Math.floor(y1 / T)];
}

/** 0–1: checks passed (80%) and an approving review (20%); with no checks, it fills slowly from `since`. */
export function progress(p, now = Date.now()) {
  const c = p.checks || {}, n = (c.passed || 0) + (c.failed || 0) + (c.pending || 0);
  const base = n ? (c.passed || 0) / n : p.since ? Math.min(0.95, 1 - Math.exp(-Math.max(0, now - p.since) / 12e5)) : 0;
  return Math.min(1, base * 0.8 + (p.review === 'approved' ? 0.2 : 0));
}

// ---------- ?dockdemo=1 ----------
// `prs` PRs loading (default 3; `&prs=12` shows tier 3, `&prs=16` tier 4) at staggered progress, of mixed
// sizes, lifetime level `&level=` (default 4), and one sails every 20 s (the oldest, nearly full). It
// replaces S.dock for the whole page, so the click panel shows the same ships. Two in three belong to
// resting agents when there are any (so they walk crates down); the rest to nobody on the map (a
// townsperson walks theirs).
const BORN = Date.now();
const DEMO_SIZES = [{ additions: 14, deletions: 3, files: 1 }, { additions: 180, deletions: 40, files: 6 }, { additions: 920, deletions: 210, files: 31 }, { additions: 64, deletions: 12, files: 4 }, { additions: 22, deletions: 9, files: 2 }, { additions: 340, deletions: 120, files: 12 }, { additions: 610, deletions: 80, files: 18 }];
export const dockDemo = () => DEMO;
export function demoDock(now = Date.now(), resting = []) {
  const E = 20000, e = Math.floor(now / E), N = DEMO_N, repos = ['agentville', 'lighthouse', 'harbour'], names = ['Ada', 'Bo', 'Cy'];
  const owners = [...resting].sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 2);
  const m3 = n => ((n % 3) + 3) % 3;
  const pr = n => { const repo = repos[m3(n)], who = m3(n) ? owners[m3(n) - 1] : null, id = 400 + (((n % 600) + 600) % 600); return { id, repo, href: `https://github.com/demo/${repo}/pull/${id}`, agentId: who?.id ?? null, agentName: who?.name ?? names[m3(n)], size: DEMO_SIZES[((n % 7) + 7) % 7] }; };
  const loading = Array.from({ length: N }, (_, i) => {
    const n = e + i + 1, since = (n - N) * E, k = Math.min(1, Math.max(0, (now - since) / (N * E))), total = 6, passed = Math.min(total, Math.floor(k * 7));
    return { ...pr(n), state: 'open', checks: { passed, failed: 0, pending: total - passed }, review: k > 0.72 ? 'approved' : 'pending', since };
  });
  // Sails since the page opened are fresh (animated); older history is an hour old (shown in the panel only).
  const sailed = [0, 1, 2, 3, 4].map(i => { const n = e - i, at = n * E >= BORN ? n * E : BORN - 36e5 - i * 6e4; return { ...pr(n), at }; });
  return { loading, sailed, total: 120 + (e % 1000), level: DEMO_LV };
}
/** What the dock shows: the demo, or the server's `S.dock` (undefined while loading: an empty dock). */
export const dockData = S => (DEMO ? demoDock() : S.dock) || { loading: [], sailed: [], total: 0, level: 1 };
/** A short signature of what's at the dock, for the village's redraw-on-change check. */
export const dockSig = d => d ? [d.level, (d.loading || []).map(p => [p.href, p.checks?.passed, p.checks?.failed, p.checks?.pending, p.review, shipClass(p.size)]), (d.sailed || []).map(s => s.href)] : null;

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
const C3 = c => [c[0], c[1], c[2]];
/** A square pyramid roof's two visible faces (south, east) over (x0, y0)–(x1, y1) at z, apex at za. */
function pyramid(ops, x0, y0, x1, y1, z, za, south, east) {
  const ap = [(x0 + x1) / 2, (y0 + y1) / 2, za];
  ops.push({ pts: [[x0, y1, z], [x1, y1, z], ap], c: south });
  ops.push({ pts: [[x1, y0, z], [x1, y1, z], ap], c: east });
}

// ---------- palette (iso.js's woods and stone, hue-shifted shadows) ----------
const SHADOW = '#141e32';
const PLANK = ['#b98a5a', '#a97c4e', '#c29465'].map(hex), SEAM = hex('#6e4a30'), TRIM = hex('#8a5e3a'), NAIL = hex('#4e3426');
const WOOD = ['#8a5e3a', '#6e4a30'], POST = ['#7a5236', '#5e3d27', '#4a3020'], IRON = ['#6a6874', '#4a4856', '#3a3846'];
const STONE = ['#b8b0a2', '#a39a8c', '#8a8276'], FLAGS = ['#bdb5a6', '#b3ab9c', '#c4bcad', '#aea595'].map(hex), MORTAR = hex('#8f8678'), KERB = hex('#cfc8b9');
const COBBLE = ['#9c9384', '#8f8778', '#a69d8e'].map(hex), ALGAE = '#4d5e4e', STONE_M = '#7c7468';
const HULL = ['#6a4630', '#563824'], CABIN = ['#e3d2a8', '#bfa77e'], ROOF = ['#b5523b', '#8e3d33'];
const ROOFS = [['#b5523b', '#8e3d33'], ['#3f6b8c', '#2e5069'], ['#6b8a3f', '#4f6a2c'], ['#8c5a9a', '#6a4276'], ['#c08a3e', '#966a2c']];
const SHIPDECK = ['#c8975f', '#bb8a55'].map(hex), DSEAM = hex('#7a4f2e'), RAIL = hex('#8a5a36'), FLOOR = hex('#5e3d27'), THWART = hex('#b08050'), HATCH = hex('#4a3020'), HATCH_L = hex('#6a4630');
const GLASS = '#3d5687', SAIL = '#f3ead2', SAIL_SH = '#d9caa4', MAST = ['#7a5236', '#6a4630', '#563824'];
const shade = (c, k) => { const a = hex(c), s = hex('#2a1c4a'); return a.map((v, i) => Math.round(v + (s[i] - v) * k)); };
const BUOY = { r: ['#d8433a', '#b0352e', '#8e2a25'], g: ['#3a9a55', '#2e7a44', '#235e35'] };
const LIGHT = { r: '#ff6a5a', g: '#7dff9a' };

// ---------- the harbour's ground: jetty, or quay + finger piers + crate yard ----------
function planks(X0, Y0, X1, pitch = 5, seam = 1.3) { // a seam >1 view px wide never drops a pixel
  return (x, y) => {
    const u = x - X0, v = y - Y0, m = ((v % pitch) + pitch) % pitch;
    if (u < 1.2 || u > X1 - X0 - 1.2) return TRIM;
    if (m < seam) return SEAM;
    if (((u > 3 && u < 4.4) || (u > X1 - X0 - 4.4 && u < X1 - X0 - 3)) && m > seam + 0.6 && m < seam + 2) return NAIL;
    return PLANK[hash(Math.floor(v / pitch) * 31 + X0) % 3];
  };
}
function pierOps(ops, p, G) {
  const { X0, X1, Y0, Y1 } = p;
  box(ops, X0, Y0, 1, X1, Y1, DECK, planks(X0, Y0, X1), WOOD[0], WOOD[1]);
  // Pilings every 24 px down each side and at the end, poking a little above the deck.
  const posts = [];
  for (let y = Y0 + 12; y < Y1 - 8; y += 24) posts.push([X0 - 1, y], [X1 - 2, y]);
  posts.push([X0 - 1, Y1 - 3], [X1 - 2, Y1 - 3]);
  for (const [x, y] of posts) box(ops, x, y, x < X0 ? DECK : -1, x + 3, y + 3, DECK + 3, POST[0], POST[1], POST[2]);
  // A bollard every second berth unit, each side.
  for (const l of G.lanes) if (l.pier === p) for (let u = 0; u < l.units; u += 2) { const x = l.side < 0 ? X0 + 2 : X1 - 6, y = l.y0 + u * U + 22; box(ops, x, y, DECK, x + 4, y + 4, DECK + 4, IRON[0], IRON[1], IRON[2]); }
}
function quayOps(ops, G) {
  const q = G.quay, z = QZ;
  // Flagstones in courses, a lighter kerb along the water's edge.
  const top = (x, y) => {
    if (y > q.y1 - 3) return KERB;
    const row = Math.floor((y - q.y0) / 8), xo = x - q.x0 + (row % 2) * 6, m = ((y - q.y0) % 8 + 8) % 8, n = ((xo % 12) + 12) % 12;
    if (m < 0.9 || n < 0.9) return MORTAR;
    return FLAGS[hash(row * 977 + Math.floor(xo / 12)) % FLAGS.length];
  };
  box(ops, q.x0, q.y0, -1, q.x1, q.y1, z, top, STONE[1], STONE[2]);
  // The sea wall: weed at the waterline, then coursed blocks.
  ops.push({ pts: [[q.x0, q.y1 + 0.02, -1], [q.x1, q.y1 + 0.02, -1], [q.x1, q.y1 + 0.02, 1.2], [q.x0, q.y1 + 0.02, 1.2]], c: ALGAE });
  ops.push({ pts: [[q.x1 + 0.02, q.y0, -1], [q.x1 + 0.02, q.y1, -1], [q.x1 + 0.02, q.y1, 1.2], [q.x1 + 0.02, q.y0, 1.2]], c: shade(ALGAE, 0.3) });
  ops.push({ pts: [[q.x0, q.y1 + 0.03, 3.4], [q.x1, q.y1 + 0.03, 3.4], [q.x1, q.y1 + 0.03, 4.1], [q.x0, q.y1 + 0.03, 4.1]], c: STONE_M });
  for (let x = q.x0 + 8; x < q.x1 - 2; x += 14) for (const [za, zb, o] of [[1.2, 3.4, 0], [4.1, z, 7]]) ops.push({ pts: [[x + o, q.y1 + 0.04, za], [x + o + 0.9, q.y1 + 0.04, za], [x + o + 0.9, q.y1 + 0.04, zb], [x + o, q.y1 + 0.04, zb]], c: STONE_M });
  // Iron bollards along the edge, between the piers.
  for (let x = q.x0 + 14; x < q.x1 - 8; x += 28) { if (G.piers.some(p => x > p.X0 - 8 && x < p.X1 + 4)) continue; box(ops, x, q.y1 - 7, z, x + 4, q.y1 - 3, z + 4, IRON[0], IRON[1], IRON[2]); }
}
function yardOps(ops, G) {
  const y = G.yard;
  const cob = (x, yy) => { const i = Math.floor((x - y.x0) / 5), j = Math.floor((yy - y.y0) / 4), m = ((yy - y.y0) % 4 + 4) % 4, n = ((x - y.x0 + (j % 2) * 2.5) % 5 + 5) % 5; return m < 0.8 || n < 0.8 ? hex(STONE_M) : COBBLE[hash(i * 53 + j) % 3]; };
  ops.push({ pts: rect(y.x0 + 2, y.y0 + 2, y.x1 + 4, y.y1 + 3, 0), c: SHADOW, a: 0.25 });
  box(ops, y.x0, y.y0, 0, y.x1, y.y1, 1, cob, STONE[2], STONE[2]);
  // A post-and-rail fence round the back and the far side; the quay side is open.
  for (let x = y.x0; x <= y.x1 - 2; x += 8) box(ops, x, y.y0, 1, x + 2, y.y0 + 2, 8, POST[0], POST[1], POST[2]);
  box(ops, y.x0, y.y0 + 0.5, 5.5, y.x1, y.y0 + 1.5, 6.6, WOOD[0], WOOD[0], WOOD[1]);
  for (let yy = y.y0 + 8; yy <= y.y1 - 2; yy += 8) box(ops, y.x1 - 2, yy, 1, y.x1, yy + 2, 8, POST[0], POST[1], POST[2]);
  box(ops, y.x1 - 1.5, y.y0, 5.5, y.x1 - 0.5, y.y1, 6.6, WOOD[0], WOOD[0], WOOD[1]);
}
function groundArt(G, hl) {
  const ops = [];
  if (!G.quay) { // tier 1: the lone jetty off the beach
    const p = G.piers[0];
    ops.push({ pts: rect(p.X0 + 2, p.Y0 + 3, p.X1 + 5, p.Y1 + 4, 0), c: SHADOW, a: 0.3 }); // its shadow on the water, cast east
    pierOps(ops, p, G);
    return rasterize(ops, hl ? HL : INK);
  }
  const q = G.quay;
  ops.push({ pts: rect(q.x0 + 3, q.y0 + 2, q.x1 + 6, q.y1 + 5, 0), c: SHADOW, a: 0.3 });
  for (const p of G.piers) ops.push({ pts: rect(p.X0 + 2, p.Y0 + 3, p.X1 + 5, p.Y1 + 4, 0), c: SHADOW, a: 0.3 });
  yardOps(ops, G);
  quayOps(ops, G);
  for (const p of G.piers) pierOps(ops, p, G); // after the quay: each pier steps down off its edge
  return rasterize(ops, hl ? HL : INK);
}

// ---------- the breakwater, the lighthouse and the beacon ----------
function segArt(sg, hl) {
  const ops = [], q = sg.quad, [nx, ny] = sg.n, seaward = nx + ny > 0; // does the sea side face the viewer?
  ops.push({ pts: q.map(([x, y]) => [x + 3, y + 2, 0]), c: SHADOW, a: 0.3 });
  // Rubble along the sea side: behind the wall first if that side faces away, in front if it faces us.
  const dx = (sg.b[0] - sg.a[0]) / sg.len, dy = (sg.b[1] - sg.a[1]) / sg.len, rubble = [];
  for (let s = 2; s < sg.len - 2; s += 6.5) {
    const h = hash(`${Math.round(sg.a[0] + dx * s)},${Math.round(sg.a[1] + dy * s)}`), r = 2.5 + (h % 4), off = 9 + (h >>> 3) % 3;
    const cx = sg.a[0] + dx * s + nx * off, cy = sg.a[1] + dy * s + ny * off, c = STONE[(h >>> 5) % 3];
    rubble.push(o => box(o, cx - r, cy - r, -1, cx + r, cy + r, 1.5 + (h >>> 7) % 4, c, shade(c, 0.25), shade(c, 0.4)));
  }
  if (!seaward) rubble.forEach(f => f(ops));
  // The wall's faces the viewer can see, back to front, then its paved top.
  const poly = (() => { let a = 0; for (let i = 0; i < 4; i++) { const [x0, y0] = q[i], [x1, y1] = q[(i + 1) % 4]; a += x0 * y1 - x1 * y0; } return a > 0 ? q : [...q].reverse(); })();
  const faces = [];
  for (let i = 0; i < 4; i++) {
    const a = poly[i], b = poly[(i + 1) % 4], fx = b[1] - a[1], fy = -(b[0] - a[0]);
    if (fx + fy <= 0) continue;
    const lit = fy >= fx, c = lit ? STONE[1] : STONE[2];
    faces.push({ k: a[0] + a[1] + b[0] + b[1], ops: [
      { pts: [[...a, -1], [...b, -1], [...b, BWZ], [...a, BWZ]], c },
      { pts: [[...a, -1], [...b, -1], [...b, 1.4], [...a, 1.4]], c: lit ? ALGAE : shade(ALGAE, 0.3) },
      { pts: [[...a, 4.4], [...b, 4.4], [...b, 5.1], [...a, 5.1]], c: STONE_M },
    ] });
  }
  for (const fc of faces.sort((p, r) => p.k - r.k)) ops.push(...fc.ops);
  const top = (x, y) => { const i = Math.floor(x / 9), j = Math.floor(y / 9), m = ((x % 9) + 9) % 9, n = ((y % 9) + 9) % 9; return m < 0.9 || n < 0.9 ? MORTAR : FLAGS[hash(i * 131 + j * 7) % FLAGS.length]; };
  ops.push({ pts: poly.map(([x, y]) => [x, y, BWZ]), c: top, z: BWZ });
  if (seaward) rubble.forEach(f => f(ops));
  return rasterize(ops, hl ? HL : INK);
}
function lighthouseArt(x, y, hl) {
  const ops = [], z = BWZ, RED = ['#c8423a', '#a3352f', '#842a26'], WHITE = ['#f3eee2', '#dcd4c4', '#c2b8a6'];
  ops.push({ pts: rect(x - 9, y - 9, x + 22, y + 16, 0), c: SHADOW, a: 0.3 });
  const plat = (px, py) => { const i = Math.floor(px / 6), j = Math.floor(py / 6), m = ((px % 6) + 6) % 6, n = ((py % 6) + 6) % 6; return m < 0.8 || n < 0.8 ? MORTAR : FLAGS[hash(i * 17 + j * 3) % 4]; };
  box(ops, x - 13, y - 13, -1, x + 13, y + 13, z, plat, STONE[1], STONE[2]);
  ops.push({ pts: [[x - 13, y + 13.02, -1], [x + 13, y + 13.02, -1], [x + 13, y + 13.02, 1.4], [x - 13, y + 13.02, 1.4]], c: ALGAE });
  ops.push({ pts: [[x + 13.02, y - 13, -1], [x + 13.02, y + 13, -1], [x + 13.02, y + 13, 1.4], [x + 13.02, y - 13, 1.4]], c: shade(ALGAE, 0.3) });
  box(ops, x - 8, y - 8, z, x + 8, y + 8, z + 4, STONE[0], STONE[1], STONE[2]); // plinth
  for (let i = 0; i < 6; i++) { const c = i % 2 ? RED : WHITE, w = 6.5 - i * 0.45; box(ops, x - w, y - w, z + 4 + i * 6, x + w, y + w, z + 10 + i * 6, c[0], c[1], c[2]); }
  ops.push({ pts: [[x - 2, y + 6.55, z + 4], [x + 2, y + 6.55, z + 4], [x + 2, y + 6.55, z + 10], [x - 2, y + 6.55, z + 10]], c: '#4a3020' }); // the keeper's door
  ops.push({ pts: [[x - 1, y + 5.2, z + 22], [x + 1, y + 5.2, z + 22], [x + 1, y + 5.2, z + 25], [x - 1, y + 5.2, z + 25]], c: GLASS }); // a slit window
  const zg = z + 40;
  box(ops, x - 8, y - 8, zg, x + 8, y + 8, zg + 2, IRON[0], IRON[1], IRON[2]); // the gallery
  for (const [a, b] of [[-8, 8], [8, 8], [8, -8]]) box(ops, x + a - (a > 0 ? 1 : 0), y + b - (b > 0 ? 1 : 0), zg + 2, x + a + (a > 0 ? 0 : 1), y + b + (b > 0 ? 0 : 1), zg + 5, IRON[1], IRON[1], IRON[2]);
  box(ops, x - 8, y + 7.2, zg + 4.4, x + 8, y + 8, zg + 5, IRON[1], IRON[1], IRON[2]);
  box(ops, x + 7.2, y - 8, zg + 4.4, x + 8, y + 8, zg + 5, IRON[1], IRON[1], IRON[2]);
  box(ops, x - 4.5, y - 4.5, zg + 2, x + 4.5, y + 4.5, zg + 10, '#2c3550', '#5a74a8', '#3d5687'); // the lantern room
  for (const o of [-1.5, 1.5]) { ops.push({ pts: [[x + o - 0.4, y + 4.55, zg + 2], [x + o + 0.4, y + 4.55, zg + 2], [x + o + 0.4, y + 4.55, zg + 10], [x + o - 0.4, y + 4.55, zg + 10]], c: IRON[2] }); ops.push({ pts: [[x + 4.55, y + o - 0.4, zg + 2], [x + 4.55, y + o + 0.4, zg + 2], [x + 4.55, y + o + 0.4, zg + 10], [x + 4.55, y + o - 0.4, zg + 10]], c: IRON[2] }); }
  pyramid(ops, x - 6, y - 6, x + 6, y + 6, zg + 10, zg + 17, RED[0], RED[2]);
  box(ops, x - 0.6, y - 0.6, zg + 16, x + 0.6, y + 0.6, zg + 20, IRON[0], IRON[1], IRON[2]);
  return rasterize(ops, hl ? HL : INK);
}
function beaconArt(x, y, hl) {
  const ops = [], z = BWZ, G2 = ['#3a9a55', '#2e7a44', '#235e35'], W2 = ['#f3eee2', '#dcd4c4', '#c2b8a6'];
  ops.push({ pts: rect(x - 7, y - 7, x + 14, y + 12, 0), c: SHADOW, a: 0.3 });
  box(ops, x - 10, y - 8, -1, x + 10, y + 10, z, STONE[0], STONE[1], STONE[2]);
  ops.push({ pts: [[x - 10, y + 10.02, -1], [x + 10, y + 10.02, -1], [x + 10, y + 10.02, 1.4], [x - 10, y + 10.02, 1.4]], c: ALGAE });
  for (let i = 0; i < 3; i++) { const c = i % 2 ? W2 : G2; box(ops, x - 3.5, y - 3.5, z + i * 4, x + 3.5, y + 3.5, z + 4 + i * 4, c[0], c[1], c[2]); }
  box(ops, x - 2.5, y - 2.5, z + 12, x + 2.5, y + 2.5, z + 16, '#2c3550', '#5a74a8', '#3d5687');
  pyramid(ops, x - 3.5, y - 3.5, x + 3.5, y + 3.5, z + 16, z + 20, G2[0], G2[2]);
  return rasterize(ops, hl ? HL : INK);
}

// ---------- sheds and cranes ----------
// The tier-1 warehouse (level 3+): a plank shed with a red gabled roof, west of the jetty's foot.
function shedRect(D) { return [(D.cx - 4) * T + 2, (D.foot - 1) * T + 3, (D.cx - 1) * T - 3, (D.foot + 1) * T - 5]; }
function shedArt([x0, y0, x1, y1], z0, roof, hl) {
  const ym = (y0 + y1) / 2, H = 16 + z0, R = 25 + z0, ops = [], [r0, r1] = ROOFS[roof] || ROOF;
  ops.push({ pts: rect(x0 + 3, y0 - 2, x1 + 8, y1 + 2, z0), c: SHADOW, a: 0.3 });
  ops.push({ pts: [[x1, y0, z0], [x1, y1, z0], [x1, y1, H], [x1, ym, R], [x1, y0, H]], c: WOOD[1] }); // east gable
  ops.push({ pts: [[x0, y1, z0], [x1, y1, z0], [x1, y1, H], [x0, y1, H]], c: WOOD[0] }); // south wall
  for (let z = z0 + 4; z < H; z += 4) ops.push({ pts: [[x0, y1 + 0.02, z], [x1, y1 + 0.02, z], [x1, y1 + 0.02, z + 0.9], [x0, y1 + 0.02, z + 0.9]], c: WOOD[1] }); // clapboards
  const dx = (x0 + x1) / 2;
  ops.push({ pts: [[dx - 8, y1 + 0.05, z0], [dx + 8, y1 + 0.05, z0], [dx + 8, y1 + 0.05, z0 + 12], [dx - 8, y1 + 0.05, z0 + 12]], c: '#4a3020' }); // the big door
  ops.push({ pts: [[dx - 0.6, y1 + 0.08, z0], [dx + 0.6, y1 + 0.08, z0], [dx + 0.6, y1 + 0.08, z0 + 12], [dx - 0.6, y1 + 0.08, z0 + 12]], c: '#2e1d14' });
  if (x1 - x0 > 44) for (const wx of [x0 + 6, x1 - 12]) ops.push({ pts: [[wx, y1 + 0.05, z0 + 6], [wx + 6, y1 + 0.05, z0 + 6], [wx + 6, y1 + 0.05, z0 + 11], [wx, y1 + 0.05, z0 + 11]], c: GLASS });
  ops.push({ pts: [[x0 - 2, y0 - 2, H - 1], [x1 + 2, y0 - 2, H - 1], [x1 + 2, ym, R + 0.5], [x0 - 2, ym, R + 0.5]], c: r1 });
  ops.push({ pts: [[x0 - 2, ym, R + 0.5], [x1 + 2, ym, R + 0.5], [x1 + 2, y1 + 2, H - 1], [x0 - 2, y1 + 2, H - 1]], c: r0 });
  for (let k = 1; k < 4; k++) { const y = ym + (y1 + 2 - ym) * k / 4, z = R + 0.5 - (R + 1.5 - H) * k / 4; ops.push({ pts: [[x0 - 2, y, z], [x1 + 2, y, z], [x1 + 2, y + 0.9, z - 0.5], [x0 - 2, y + 0.9, z - 0.5]], c: shade(r0, 0.25) }); } // shingle courses
  return rasterize(ops, hl ? HL : INK);
}
// The tier-1 crane (level 4+): a stone footing on the east bank, a post and a jib out over the water.
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
// A pier crane (tier 2+): the footing and post in the middle of the pier near the quay, and (a separate
// part, so it sorts over a ship under it) the jib out east over the first berth.
const JZ = 46;
function pierCraneArt(c, hl) {
  const { bx, by, z0 } = c, ops = [];
  ops.push({ pts: rect(bx + 2, by + 2, bx + 15, by + 14, z0), c: SHADOW, a: 0.3 });
  box(ops, bx, by, z0, bx + 12, by + 12, z0 + 4, STONE[0], STONE[1], STONE[2]);
  box(ops, bx - 5, by + 3, z0 + JZ - 4, bx + 3, by + 9, z0 + JZ + 3, IRON[0], IRON[1], IRON[2]); // counterweight
  box(ops, bx + 4, by + 4, z0 + 4, bx + 8, by + 8, z0 + JZ + 1, MAST[0], MAST[1], MAST[2]);
  ops.push({ pts: [[bx + 8, by + 8, z0 + 28], [bx + 20, by + 8, z0 + JZ - 2], [bx + 20, by + 8, z0 + JZ - 0.5], [bx + 8, by + 8, z0 + 29.8]], c: MAST[2] }); // a brace
  return rasterize(ops, hl ? HL : INK);
}
function jibArt(c, hl) {
  const { bx, by, z0, tipX } = c, ops = [];
  box(ops, bx + 3, by + 5, z0 + JZ - 1, tipX + 1, by + 7, z0 + JZ + 2, MAST[0], MAST[1], MAST[2]);
  return rasterize(ops, hl ? HL : INK);
}
function buoyArt(col) {
  const ops = [], c = BUOY[col];
  ops.push({ pts: rect(-1, -1, 6, 5, 0), c: SHADOW, a: 0.3 });
  box(ops, -3, -3, -1, 3, 3, 3, c[0], c[1], c[2]);
  box(ops, -3, -3, 3, 3, 3, 4.5, '#f3eee2', '#dcd4c4', '#c2b8a6');
  pyramid(ops, -3, -3, 3, 3, 4.5, 11, c[1], c[2]);
  box(ops, -0.7, -0.7, 10.5, 0.7, 0.7, 13, IRON[0], IRON[1], IRON[2]);
  return rasterize(ops, INK);
}

// ---------- boats ----------
// Models are built in the boat's own frame (x across, y from the stern at 0 to the bow at L, z up) and
// turned to a heading: S (out to sea, how every moored boat lies), E, W or N. Parts are listed stern to
// bow, which is back to front for S and E; only symmetrical boats (the rowboat and the tug, whose
// wheelhouse holds its funnel) ever head W or N.
const HEAD = { S: (x, y) => [x, y], E: (x, y) => [y, -x], W: (x, y) => [-y, x], N: (x, y) => [-x, -y] };
const HEADINV = { S: (X, Y) => [X, Y], E: (X, Y) => [-Y, X], W: (X, Y) => [Y, -X], N: (X, Y) => [-X, -Y] };
function modeler(h) {
  const M = HEAD[h], back = HEADINV[h], ops = [];
  const P = ([x, y, z]) => { const [X, Y] = M(x, y); return [X, Y, z]; };
  return {
    ops,
    poly(pts, c) { ops.push({ pts: pts.map(P), c }); },
    flat(pts, z, c) { ops.push({ pts: pts.map(([x, y]) => P([x, y, z])), c: typeof c === 'function' ? (X, Y) => c(...back(X, Y)) : c, z }); },
    box(x0, y0, z0, x1, y1, z1, top, south, east) {
      const a = M(x0, y0), b = M(x1, y1);
      box(ops, Math.min(a[0], b[0]), Math.min(a[1], b[1]), z0, Math.max(a[0], b[0]), Math.max(a[1], b[1]), z1, top, south, east);
    },
    /** The hull: deck outline at Z down to a narrower waterline; `bands` [[depth 0–1, colour], …] from the rail down. */
    hull(L, half, Z, taper, bands) {
      const deck = [[-half, 1], [half, 1], [half, taper], [0, L], [-half, taper]];
      const wl = [[-half + 2, 3], [half - 2, 3], [half - 2, taper], [0, L - 3], [-half + 2, taper]];
      const Dk = deck.map(p => M(...p)), Wl = wl.map(p => M(...p));
      ops.push({ pts: Wl.map(([x, y]) => [x + 3, y + 2, 0]), c: SHADOW, a: 0.3 });
      const lv = [0, ...bands.map(b => b[0])], rings = lv.map(f => Dk.map((p, i) => [p[0] + (Wl[i][0] - p[0]) * f, p[1] + (Wl[i][1] - p[1]) * f]));
      const faces = [];
      for (let i = 0; i < 5; i++) {
        const j = (i + 1) % 5, a = Dk[i], b = Dk[j], nx = b[1] - a[1], ny = -(b[0] - a[0]);
        if (nx + ny <= 0) continue;
        const lit = ny >= nx;
        faces.push({ k: a[0] + a[1] + b[0] + b[1], ops: bands.map(([, c], k) => {
          const r0 = rings[k], r1 = rings[k + 1], z0 = Z * (1 - lv[k]), z1 = Z * (1 - lv[k + 1]);
          return { pts: [[...r0[i], z0], [...r0[j], z0], [...r1[j], z1], [...r1[i], z1]], c: lit ? c : shade(c, 0.3) };
        }) });
      }
      for (const fc of faces.sort((p, q) => p.k - q.k)) ops.push(...fc.ops);
      return deck;
    },
  };
}
const sailPlane = (m, y, x0, x1, za, zb, c) => m.poly([[x0, y, za], [x1, y, za], [x1, y, zb], [x0, y, zb]], c);
function sloop(m, accent) {
  const L = 46, half = 9, Z = 8, taper = 31, pitch = 4.5, seam = 1.3;
  const deck = m.hull(L, half, Z, taper, [[0.4, accent], [1, HULL[0]]]);
  const edge = y => (y < taper ? half : half * (L - y) / (L - taper));
  m.flat(deck, Z, (x, y) => (Math.abs(x) > edge(y) - 1.4 || y < 2.4 ? RAIL : ((x + 20) % pitch) < seam ? DSEAM : SHIPDECK[Math.floor((x + 20) / pitch) % 2]));
  m.box(-6, 3, Z, 6, 12, Z + 9, ROOF[0], CABIN[0], CABIN[1]); // the deckhouse aft
  m.poly([[-2, 12.05, Z + 2], [2, 12.05, Z + 2], [2, 12.05, Z + 6], [-2, 12.05, Z + 6]], GLASS);
  m.box(-1, 21, Z, 1, 23, Z + 38, MAST[0], MAST[1], MAST[2]);
  m.box(-12, 21.6, Z + 33, 12, 22.4, Z + 34.5, MAST[0], MAST[1], MAST[2]); // the yard
  // A square sail facing the bow, striped in the accent.
  sailPlane(m, 23.6, -11, 11, Z + 11, Z + 12, SAIL_SH); sailPlane(m, 23.6, -11, 11, Z + 12, Z + 19, SAIL); sailPlane(m, 23.6, -11, 11, Z + 19, Z + 24, accent); sailPlane(m, 23.6, -11, 11, Z + 24, Z + 32.5, SAIL);
  m.box(-0.8, L - 2, Z + 0.5, 0.8, L + 7, Z + 2, MAST[0], MAST[1], MAST[2]); // bowsprit
}
function dinghy(m, accent) {
  const L = 26, half = 6, Z = 5, taper = 17;
  const deck = m.hull(L, half, Z, taper, [[0.45, accent], [1, HULL[0]]]);
  const edge = y => (y < taper ? half : half * (L - y) / (L - taper));
  m.flat(deck, Z, (x, y) => (Math.abs(x) > edge(y) - 1.3 || y < 2.2 ? RAIL : (y > 5.5 && y < 7.2) || (y > 12.5 && y < 14.2) ? THWART : FLOOR));
  m.box(-0.7, 9, Z, 0.7, 10.4, Z + 22, MAST[0], MAST[1], MAST[2]);
  m.box(-0.5, 10.4, Z + 2.4, 0.5, 21, Z + 3.4, MAST[0], MAST[1], MAST[2]); // the boom
  // A leg-of-mutton sail along the boat (it faces the viewer from the east), an accent band at its foot.
  m.poly([[0.8, 10.5, Z + 3.4], [0.8, 10.5, Z + 22], [0.8, 21, Z + 3.4]], SAIL);
  m.poly([[0.85, 10.5, Z + 3.4], [0.85, 10.5, Z + 6.5], [0.85, 19.2, Z + 3.4]], accent);
}
function brig(m, accent) {
  const L = 72, half = 12, Z = 10, taper = 50, pitch = 4.5, seam = 1.3;
  const deck = m.hull(L, half, Z, taper, [[0.26, accent], [0.42, '#efe4c8'], [1, HULL[1]]]);
  const edge = y => (y < taper ? half : half * (L - y) / (L - taper));
  m.flat(deck, Z, (x, y) => {
    if (Math.abs(x) > edge(y) - 1.6 || y < 2.6) return RAIL;
    if (y > 15.5 && y < 29 && Math.abs(x) < 8.5) return Math.abs(x) > 7.5 || y < 16.5 || y > 28 ? HATCH_L : ((y - 15.5) % 4.5) < 0.9 ? HATCH_L : HATCH; // the cargo hatch
    return ((x + 24) % pitch) < seam ? DSEAM : SHIPDECK[Math.floor((x + 24) / pitch) % 2];
  });
  m.box(-9, 3, Z, 9, 13, Z + 9, ROOF[1], CABIN[0], CABIN[1]); // the deckhouse aft
  for (const x of [-6, 2.5]) m.poly([[x, 13.05, Z + 3], [x + 3.5, 13.05, Z + 3], [x + 3.5, 13.05, Z + 6.5], [x, 13.05, Z + 6.5]], GLASS);
  m.box(-4, 5, Z + 9, 4, 10, Z + 13, ROOF[0], CABIN[0], CABIN[1]); // the wheelhouse on top
  // Mainmast: course and topsail, the course striped in the accent.
  m.box(-1.3, 30, Z, 1.3, 32.6, Z + 52, MAST[0], MAST[1], MAST[2]);
  m.box(-15, 30.8, Z + 45, 15, 31.8, Z + 46.5, MAST[0], MAST[1], MAST[2]);
  m.box(-12, 30.8, Z + 33.5, 12, 31.8, Z + 35, MAST[0], MAST[1], MAST[2]);
  sailPlane(m, 33.7, -13.5, 13.5, Z + 13, Z + 14, SAIL_SH); sailPlane(m, 33.7, -13.5, 13.5, Z + 14, Z + 21, SAIL); sailPlane(m, 33.7, -13.5, 13.5, Z + 21, Z + 25, accent); sailPlane(m, 33.7, -13.5, 13.5, Z + 25, Z + 32.5, SAIL);
  sailPlane(m, 33.7, -10.5, 10.5, Z + 36, Z + 44.5, SAIL);
  // Foremast.
  m.box(-1.2, 52, Z, 1.2, 54.4, Z + 44, MAST[0], MAST[1], MAST[2]);
  m.box(-12, 52.6, Z + 38.5, 12, 53.6, Z + 40, MAST[0], MAST[1], MAST[2]);
  sailPlane(m, 55.5, -11, 11, Z + 12, Z + 13, SAIL_SH); sailPlane(m, 55.5, -11, 11, Z + 13, Z + 20, SAIL); sailPlane(m, 55.5, -11, 11, Z + 20, Z + 24, accent); sailPlane(m, 55.5, -11, 11, Z + 24, Z + 37.5, SAIL);
  m.box(-1, L - 2, Z + 1, 1, L + 11, Z + 3, MAST[0], MAST[1], MAST[2]); // bowsprit
}
function shipArt(cls, accent, head, hl) {
  const m = modeler(head);
  (cls === 'dinghy' ? dinghy : cls === 'cargo' ? brig : sloop)(m, accent);
  return rasterize(m.ops, hl ? HL : INK);
}
// The tug (tier 3+): a red hull, a white wheelhouse with its funnel on top (so it reads from any heading).
const TUG = { L: 24, half: 7 };
function tugArt(head, hl) {
  const m = modeler(head), L = 24, half = 7, Z = 5, taper = 15;
  const deck = m.hull(L, half, Z, taper, [[0.45, '#c23b2e'], [1, '#2e2a33']]);
  const edge = y => (y < taper ? half : half * (L - y) / (L - taper));
  m.flat(deck, Z, (x, y) => (Math.abs(x) > edge(y) - 1.3 || y < 2.2 ? hex('#8e2a25') : hex('#5d5964')));
  m.box(-4.5, 5, Z, 4.5, 14, Z + 8, '#3d3a44', '#ece6d6', '#cdc5b2');
  m.poly([[-3, 14.05, Z + 4], [3, 14.05, Z + 4], [3, 14.05, Z + 6.5], [-3, 14.05, Z + 6.5]], GLASS);
  m.box(-1.8, 8, Z + 8, 1.8, 11.6, Z + 11, '#2a2730', '#2a2730', '#1e1c24');
  m.box(-1.8, 8, Z + 11, 1.8, 11.6, Z + 12.5, '#f2b134', '#f2b134', '#c98e22');
  m.box(-1.8, 8, Z + 12.5, 1.8, 11.6, Z + 14, '#2a2730', '#2a2730', '#1e1c24');
  m.box(-2, L - 3.5, 0.5, 2, L - 0.5, Z, '#1d1a20', '#1d1a20', '#141216'); // the bow fender
  return rasterize(m.ops, hl ? HL : INK);
}
// The rowboat: tied up at the main pier head, and (tier 4) rowing about the basin; `fr` is the oar stroke.
const ROW = { L: 23, half: 6 };
function rowboatArt(head, fr, hl) {
  const m = modeler(head), L = 23, half = 6, Z = 4, taper = 15;
  const deck = m.hull(L, half, Z, taper, [[0.4, WOOD[0]], [1, HULL[0]]]);
  const edge = y => (y < taper ? half : half * (L - y) / (L - taper));
  m.flat(deck, Z, (x, y) => (Math.abs(x) > edge(y) - 1.4 || y < 2.4 ? RAIL : (y > 7 && y < 8.8) || (y > 12.5 && y < 14.2) ? THWART : FLOOR));
  if (fr != null) for (const s of [-1, 1]) {
    const a = [s * 5, 10.5], b = [s * 14, 10.5 + (fr ? -4.5 : 4.5)], len = Math.hypot(b[0] - a[0], b[1] - a[1]), px = -(b[1] - a[1]) / len * 0.7, py = (b[0] - a[0]) / len * 0.7;
    m.flat([[a[0] + px, a[1] + py], [b[0] + px, b[1] + py], [b[0] - px, b[1] - py], [a[0] - px, a[1] - py]], Z + 0.8, '#c49a66');
  }
  return rasterize(m.ops, hl ? HL : INK);
}

// An 8×8 crate (the pack's ui/Crate.png is 16 px: too big for a deck this size), a pennant per colour, gulls.
function glyph(map, pal) {
  const c = document.createElement('canvas'); c.width = map[0].length; c.height = map.length;
  const g = c.getContext('2d');
  map.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
}
let CRATE = null, GULLS = null;
const crate = () => (CRATE ||= glyph(['.oooooo.', 'oLLLLLLo', 'oDmmmmDo', 'omDmmDmo', 'ommDDmmo', 'omDmmDmo', 'oDmmmmDo', 'oooooooo'],
  { o: '#2a1a14', L: '#e0b070', m: '#b07a42', D: '#7a4f2e' }));
const gulls = () => (GULLS ||= [
  glyph(['o.....o', 'wo...ow', '.wwoww.', '...o...'], { o: '#1d1233', w: '#f4f1ea' }),
  glyph(['.......', 'ooo.ooo', 'wwwowww', '...o...'], { o: '#1d1233', w: '#f4f1ea' }),
]);
const pennants = new Map();
const pennant = (color, fr) => {
  const k = `${color}|${fr}`;
  if (!pennants.has(k)) pennants.set(k, glyph(fr ? ['ooooo..', 'occcooo', 'occccco', 'ooooooo'] : ['oooooo.', 'occccoo', 'occco..', 'ooo....'], { o: '#1d1233', c: color }));
  return pennants.get(k);
};
const headOf = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : dy < 0 ? 'N' : 'S');
const rnd = s => (hash(s) % 10000) / 10000;

// ---------- the harbour in a frame ----------
/** H: the renderer's helpers { drawLamp, flagSheet }. */
export function createDockArt(H) {
  const KEY = DEMO ? 'va.dock.sailed.demo' : 'va.dock.sailed';
  const seen = new Set(store.get(KEY, []));
  const slotOf = new Map(), lastSlot = new Map(), clsOf = new Map(); // href → slot: loading now / when last seen loading; href → boat class
  let sails = [], nextCast = 0, tug = null, lastT = null;
  const arts = new Map(), art = (k, make) => { if (!arts.has(k)) arts.set(k, make()); return arts.get(k); };
  let hits = [], lights = [], tags = [], parts = [], ground = [], wakes = [], walking = [], sky = [];
  const walkers = createWalkers();

  // Berths. A loading PR keeps its slot while it loads; a newly merged PR casts off from the slot it was
  // loading at (or a free one, if this page never saw it load); a new PR takes a free run of berth units
  // its boat fits: a brig the pier heads first, the rest from the quay end out. PRs that don't fit ride
  // at anchor outside until a berth frees up.
  function step(data, now, still, G) {
    const sailed = data.sailed || [], gone = new Set(sailed.map(s => s.href));
    const loading = (data.loading || []).filter(p => p.href && !gone.has(p.href))
      .sort((a, b) => (a.since || 0) - (b.since || 0) || String(a.href).localeCompare(String(b.href)));
    const live = new Set(loading.map(p => p.href));
    for (const p of loading) { clsOf.delete(p.href); clsOf.set(p.href, shipClass(p.size)); }
    while (clsOf.size > 400) clsOf.delete(clsOf.keys().next().value);
    const fits = s => { const l = s && G.laneById.get(s.lane); return !!l && s.u0 >= 0 && s.u0 + SHIPS[s.cls].n <= l.units; };
    for (const [h, s] of slotOf) if (!live.has(h) || !fits(s) || s.cls !== clsOf.get(h)) slotOf.delete(h);
    let dirty = false;
    for (const s of sailed) {
      if (!s.href || seen.has(s.href)) continue;
      seen.add(s.href); dirty = true;
      if (still || now - (s.at || 0) > FRESH_MS) continue; // old news (first load), or motion is off: just mark it seen
      sails.push({ href: s.href, id: s.id, repo: s.repo, cls: clsOf.get(s.href) || shipClass(s.size), want: lastSlot.get(s.href), slot: null, t0: null, queued: now });
    }
    if (dirty) store.set(KEY, [...seen].slice(-400));
    if (still) sails = [];
    sails = sails.filter(s => (s.t0 == null ? now - s.queued < FRESH_MS : now - s.t0 < (s.path ? s.path.dur * 1000 : 16000) && fits(s.slot)));
    const occ = new Map();
    const take = s => { const l = G.laneById.get(s.lane); let a = occ.get(s.lane); if (!a) occ.set(s.lane, (a = new Uint8Array(l.units))); for (let u = s.u0; u < s.u0 + SHIPS[s.cls].n; u++) a[u] = 1; };
    const freeRun = (l, u0, n) => { if (u0 < 0 || u0 + n > l.units) return false; const a = occ.get(l.id); if (a) for (let u = u0; u < u0 + n; u++) if (a[u]) return false; return true; };
    const mk = (l, u0, cls) => ({ lane: l.id, u0, cls, key: `${l.id}:${u0}` });
    const find = (cls, want) => {
      const n = SHIPS[cls].n;
      if (want && want.cls === cls) { const l = G.laneById.get(want.lane); if (l && freeRun(l, want.u0, n)) return mk(l, want.u0, cls); }
      if (cls === 'cargo') for (const l of G.lanes) if (freeRun(l, l.units - n, n)) return mk(l, l.units - n, cls);
      for (let u = 0; u < (G.lanes[0]?.units || 0); u++) for (const l of G.lanes) if (freeRun(l, u, n)) return mk(l, u, cls);
      return null;
    };
    for (const s of slotOf.values()) take(s);
    for (const s of sails) if (s.t0 != null) take(s.slot);
    for (const s of sails) if (s.t0 == null) { if (now < nextCast) break; const sl = find(s.cls, s.want); if (!sl) continue; s.slot = sl; s.t0 = now; nextCast = now + STAGGER_MS; take(sl); }
    for (const p of loading) if (!slotOf.has(p.href)) { const sl = find(clsOf.get(p.href), lastSlot.get(p.href)); if (sl) { slotOf.set(p.href, sl); take(sl); } }
    for (const [h, s] of slotOf) { lastSlot.delete(h); lastSlot.set(h, s); }
    while (lastSlot.size > 200) lastSlot.delete(lastSlot.keys().next().value);
    const berthed = [], anchored = [];
    for (const p of loading) { const s = slotOf.get(p.href); if (s) berthed.push({ p, slot: s, berth: s.key, cls: s.cls, ...slotPos(G, s) }); else anchored.push({ p, cls: clsOf.get(p.href) }); }
    return { berthed, anchored: anchored.slice(0, G.anchor.length), sails: sails.filter(s => s.t0 != null) };
  }

  // A departing ship's course: out of its berth into the fairway, then (inside a breakwater) down to the
  // basin lane, along it to the mouth, and out to sea, far enough to leave the view (fixed when it casts off).
  function course(G, s, f) {
    const at = slotPos(G, s.slot), lane = G.laneById.get(s.slot.lane), S = SHIPS[s.cls];
    const pts = [[at.x, at.cy], [lane.fair, at.cy]];
    if (G.bw) pts.push([lane.fair, G.bw.BL], [G.bw.mouth, G.bw.BL]);
    const [ex, ey] = pts[pts.length - 1], [X, Y] = isoP(ex, ey);
    const fy = f.vy + f.bh - (Y - 70), fx = X + 60 - f.vx;
    const far = Math.min(4000, Math.max(120, Math.min(fy / (ISO / 2), fx / ISO) + S.L + 24));
    pts.push([ex, ey + far]);
    const ln = line(pts), a = Math.abs(lane.fair - at.x), inner = ln.len - far - a;
    return { ln, a, sBL: G.bw ? a + Math.abs(G.bw.BL - at.cy) : 0, sMouth: ln.len - far, dur: Math.min(17, 7.5 + Math.max(0, inner) / 45) };
  }

  /** Lay out this frame's harbour: the ground layer (quay, piers, wakes), the upright parts for the depth sort, hits. */
  function frame(f, W) {
    hits = []; lights = []; tags = []; parts = []; ground = []; wakes = []; walking = []; sky = [];
    const D = W.dock;
    if (!D) return;
    const { t, still } = f, data = f.dock || {}, now = Date.now(), G = harbourFor(D, data, now), night = f.night || 0;
    const dt = lastT == null ? 0 : Math.min(0.5, Math.max(0, t - lastT));
    lastT = t;
    const V = (x, y, z = 0) => { const [X, Y] = isoP(x, y); return [X, Y - z]; };
    const hlDock = f.dockHover === 'dock', f8 = Math.floor(t * 8);
    // isoSort's fields: the ground footprint (world px; a point for anything upright) and the screen rect.
    const pt = (d, fx, fy, sx0, sy0, sx1, sy1) => Object.assign(d, { fx0: fx, fx1: fx, fy0: fy, fy1: fy, sx0, sy0, sx1, sy1 });
    const area = (d, fx0, fy0, fx1, fy1, a) => Object.assign(d, { fx0, fy0, fx1, fy1, sx0: a.ox, sy0: a.oy, sx1: a.ox + a.w, sy1: a.oy + a.h });
    const solid = (a, key = 'dock') => hits.push({ key, x: a.ox, y: a.oy, w: a.w, h: a.h, art: a });
    const A = (name, make) => art(`${G.key}|${name}|${hlDock}`, () => make(hlDock));
    const bob = (seed, rate = 1.5) => (still ? 0 : (Math.floor(t * rate + rnd(seed) * 2) % 2));

    // The ground: the jetty, or the quay with its piers and the crate yard.
    const g = A('ground', hl => groundArt(G, hl));
    ground.push(g); solid(g);
    // Tier 1's level touches: the warehouse and crane on the bank.
    if (G.tier === 1 && G.lv >= 3) { const a = A('shed', hl => shedArt(shedRect(D), 0, 0, hl)), [x0, y0, x1, y1] = shedRect(D); parts.push(area({ dk: 'art', a }, x0, y0, x1, y1, a)); solid(a); }
    if (G.tier === 1 && G.lv >= 4) {
      const a = A('crane', hl => craneArt(D, hl)), [bx, by] = craneAt(D);
      const tip = V(bx + 6, D.sea * T + 1, 38), sway = still ? 0 : Math.round(Math.sin(t * 1.3) * 1.2);
      parts.push(area({ dk: 'art', a, rope: [Math.round(tip[0]), Math.round(tip[1]), sway] }, bx, by - 6, bx + 12, D.sea * T + 2, a));
      solid(a);
    }
    G.sheds.forEach((s, i) => { const a = A(`shed${i}`, hl => shedArt(s.r, s.z0, s.roof, hl)); parts.push(area({ dk: 'art', a }, s.r[0], s.r[1], s.r[2], s.r[3], a)); solid(a); });
    G.cranes.forEach((c, i) => {
      const a = A(`crane${i}`, hl => pierCraneArt(c, hl)), j = A(`jib${i}`, hl => jibArt(c, hl));
      parts.push(area({ dk: 'art', a }, c.bx, c.by, c.bx + 12, c.by + 12, a)); solid(a);
      const tip = V(c.tipX - 1, c.by + 6, c.z0 + JZ - 1), sway = still ? 0 : Math.round(Math.sin(t * 1.1 + i * 1.7) * 1.2);
      parts.push(pt({ dk: 'art', a: j, rope: [Math.round(tip[0]), Math.round(tip[1]), sway] }, c.tipX + 10, c.by + 22, j.ox, j.oy, j.ox + j.w, Math.max(j.oy + j.h, Math.round(tip[1]) + 24)));
      solid(j);
    });
    // The breakwater (each length of it sorts on its own), the lighthouse at its tip, the beacon on the mole.
    if (G.bw) {
      const B = G.bw;
      B.segs.forEach((sg, i) => { const a = A(`bw${i}`, hl => segArt(sg, hl)); parts.push(area({ dk: 'art', a }, sg.fx0, sg.fy0, sg.fx1, sg.fy1, a)); solid(a); });
      const lh = A('lighthouse', hl => lighthouseArt(B.tip, B.yb, hl)), bc = A('beacon', hl => beaconArt(B.xe, B.yb + 6, hl));
      const beam = still ? 0 : t * 0.9, [LX, LY] = V(...B.light).map(Math.round), [BX, BY] = V(...B.beacon).map(Math.round);
      const blink = still || Math.floor(t * 0.8) % 2 === 0;
      parts.push(area({ dk: 'art', a: lh, lamp: [LX, LY, Math.cos(beam)] }, B.tip - 13, B.yb - 13, B.tip + 13, B.yb + 13, lh)); solid(lh);
      parts.push(area({ dk: 'art', a: bc, lamp: blink ? [BX, BY, -2, LIGHT.g] : null }, B.xe - 10, B.yb - 2, B.xe + 10, B.yb + 16, bc)); solid(bc);
      if (night > 0) {
        lights.push([LX, LY, 30, 1]);
        if (blink) lights.push([BX, BY, 14, 0]);
        // The beam: pools of light swept round the lantern, foreshortened like the ground.
        if (!still) for (const d of [14, 30, 50, 74, 102, 134, 170]) lights.push([LX + Math.cos(beam) * d * 1.3, LY + Math.sin(beam) * d * 0.65, 9 + d * 0.3, 0]);
      }
    }
    // Lamps (the street lamp's own drawing) and the flag.
    for (const [x, y, z] of G.lamps) { const [X, Y] = V(x, y, z).map(Math.round); parts.push(pt({ lamp: 1, x: X, y: Y }, x, y, X - 3, Y - 24, X + 3, Y)); lights.push([X, Y - 19, 48, 1]); }
    if (G.flag) { const [fx, fy, fz] = G.flag, [X, Y] = V(fx, fy, fz).map(Math.round); parts.push(pt({ dk: 'flag', x: X, y: Y, fr: still ? 0 : (Math.floor(t * 4) + 1) % 4 }, fx, fy, X - 2, Y - 40, X + 16, Y)); }
    // Channel buoys: they bob, and blink red and green after dark.
    G.buoys.forEach(([x, y, col], i) => {
      const a = art(`buoy|${col}`, () => buoyArt(col)), [X, Y0] = V(x, y).map(Math.round), Y = Y0 + bob(`buoy${i}`, 0.9);
      const on = !still && Math.floor(t * 0.7 + i * 0.37) % 2 === 0;
      parts.push(pt({ dk: 'art', a: { ...a, ox: X + a.ox, oy: Y + a.oy }, lamp: night > 0.35 && on ? [X, Y - 12, -1, LIGHT[col]] : null }, x, y, X + a.ox, Y + a.oy, X + a.ox + a.w, Y + a.oy + a.h));
      if (night > 0 && on) lights.push([X, Y - 12, 9, 0]);
      wakes.push(...ripples(V, x - 2, y - 6, 3, 8, f8, `buoy${i}`, still));
    });

    // Boats.
    const boat = (o) => {
      const { key, cls, cx, cy, head = 'S', accent, alpha = 1, a } = o, S = o.dims || SHIPS[cls];
      const [fx, fy] = HEAD[head](0, 1), sx = cx - fx * S.L / 2, sy = cy - fy * S.L / 2;
      const [X, Y] = V(sx, sy).map(Math.round), ay = Y + (o.moving ? 0 : bob(key));
      const d = { dk: 'ship', a, ax: X, ay, alpha, crates: o.crates || 0, spots: o.spots, deckZ: o.deckZ || 0, pen: o.pen, mast: o.mast, fr: still ? 0 : (f8 >> 1) % 2, head, smoke: o.smoke, rower: o.rower, t };
      const along = head === 'S' || head === 'N';
      parts.push(area(d, along ? cx - S.half : cx - S.L / 2, along ? cy - S.L / 2 : cy - S.half, along ? cx + S.half : cx + S.L / 2, along ? cy + S.L / 2 : cy + S.half, { ox: X + a.ox, oy: ay + a.oy - 10, w: a.w, h: a.h + 10 }));
      hits.push({ key: o.hit || key, x: X + a.ox, y: ay + a.oy, w: a.w, h: a.h, art: a });
      if (f.zoom >= 3 && o.id != null) { const [TX, TY] = V(cx, cy).map(Math.round); tags.push({ key: `d:${key}`, text: `#${o.id}`, x: TX, y: TY + 12 + (ay - Y) }); }
    };
    const ship = (o) => {
      const hl = f.dockHover === o.key, head = o.head || 'S', S = SHIPS[o.cls];
      boat({ ...o, head, a: art(`ship|${o.cls}|${o.accent}|${head}|${hl}`, () => shipArt(o.cls, o.accent, head, hl)), spots: o.cls === 'dinghy' && head !== 'S' ? [] : S.spots, deckZ: S.Z, mast: S.mast });
    };
    const accentOf = p => ACCENT[hash(p.repo || p.href) % ACCENT.length];
    const penOf = p => ((p.checks?.failed || 0) > 0 ? '#e5383b' : p.review === 'approved' ? '#2f9e5b' : '#f4efe4');
    // The rowboat, always tied up at the main pier head.
    {
      const p0 = G.piers.find(p => p.k === 0), x = (p0.X0 + p0.X1) / 2, y = p0.Y1 + 3;
      boat({ key: 'rowboat', hit: 'dock', cx: x, cy: y + ROW.L / 2, dims: ROW, a: A('rowboat', hl => rowboatArt('S', null, hl)) });
      wakes.push(...ripples(V, x, y, 6, 20, f8, 'rowboat', still));
    }
    const { berthed, anchored, sails: out } = step(data, now, still, G);
    let waiting = 0;
    for (const b of berthed) {
      const { p, cls, x, cy } = b, S = SHIPS[cls], crates = Math.round(progress(p, now) * S.crates), key = `ship:${p.href}`;
      waiting += S.crates - crates;
      ship({ key, cls, cx: x, cy, accent: accentOf(p), crates, pen: penOf(p), id: p.id });
      wakes.push(...ripples(V, x, cy - S.L / 2, S.half, S.L - 10, f8, key, still));
    }
    anchored.forEach(({ p, cls }, i) => {
      const [x, cy] = G.anchor[i], S = SHIPS[cls], crates = Math.round(progress(p, now) * S.crates), key = `ship:${p.href}`;
      waiting += S.crates - crates;
      ship({ key, cls, cx: x, cy, accent: accentOf(p), crates, pen: penOf(p), id: p.id });
      wakes.push(...ripples(V, x, cy - S.L / 2, S.half, S.L - 10, f8, key, still));
    });
    // The crate yard: the cargo still to load, stacked up to three high.
    if (G.yard) {
      const y = G.yard, n = Math.min(27, waiting), cols = [y.x0 + 22, y.x0 + 33, y.x0 + 44], rows = [y.y0 + 10, y.y0 + 22, y.y0 + 34];
      for (let i = 0; i < 9 && i * 3 < n; i++) {
        const wx = cols[i % 3], wy = rows[Math.floor(i / 3)], h = Math.min(3, n - i * 3), [X, Y] = V(wx, wy, 1).map(Math.round);
        parts.push(pt({ dk: 'stack', x: X, y: Y, n: h }, wx, wy, X - 4, Y - 8 - h * 6, X + 4, Y + 1));
      }
    }
    // The walkers carrying crates down from town (the renderer's villager drawing, reused).
    for (const w of walkers.step({ W, G, agents: f.agents, ships: berthed, t, still })) {
      const sx = (w.dx - w.dy) * ISO, dir = sx > 0 ? 3 : sx < 0 ? 2 : 0, [X, Y] = V(w.x, w.y, w.z).map(Math.round), left = X - 8;
      const v = { a: w.agent || { id: w.id, role: 'solo', bucket: 'dock', name: '' }, look: w.look, pose: w.carry ? 'carry' : 'stand', phase: rnd(w.id), own: false };
      const vd = { v, ghost: false, walker: true, left, feet: Y, top: Y - 18, dir, row: w.moving ? Math.floor(t * 8) % 4 : 0, bob: 0, moving: w.moving };
      parts.push(pt({ vd }, w.x, w.y, left - 2, Y - 32, left + 18, Y + 3));
      // A click selects the agent, as at home; a townsperson's opens its ship's PR.
      hits.push({ key: w.agentId != null ? `agent:${w.agentId}` : `ship:${w.href}`, x: left - 1, y: Y - 26, w: 18, h: 27 });
      walking.push({ id: w.id, kind: 'porter', x: left, y: Y, facing: dir === 3 ? 'R' : 'L', moving: w.moving, t });
    }
    // Sailing: ease out sideways from the berth, then along the course, faster and faster, fading at the end.
    let escort = null;
    for (const s of out) {
      if (!s.path) s.path = course(G, s, f);
      const P = s.path, el = (now - s.t0) / 1000, R = P.ln.len - P.a, e1 = Math.min(1, el / 2.2), q = Math.max(0, (el - 1.6) / (P.dur - 1.6));
      s.cur = Math.min(P.ln.len, P.a * e1 * e1 * (3 - 2 * e1) + R * q * q);
      const at = P.ln.at(s.cur), head = s.cur < P.a - 0.5 ? 'S' : headOf(at.dx, at.dy), key = `ship:${s.href}`;
      ship({ key, cls: s.cls, cx: at.x, cy: at.y, head, accent: ACCENT[hash(s.repo || s.href) % ACCENT.length], crates: SHIPS[s.cls].crates, pen: '#2f9e5b', moving: true, alpha: el > P.dur - 0.8 ? Math.max(0, 1 - (el - (P.dur - 0.8)) / 0.8) : 1, id: s.id });
      const speed = el < 1.6 ? 0 : 2 * R * q / (P.dur - 1.6);
      wakes.push(...wake(V, at.x, at.y, head, SHIPS[s.cls], speed, f8, still));
      if (G.bw && !escort && s.cur < P.sMouth + 90) escort = s;
    }
    // The tug waits inside the breakwater; it runs out ahead of a departing ship once it reaches the
    // basin lane, sees it out past the mouth, and comes back in.
    if (G.tugIdle) {
      if (!tug || still) tug = { x: G.tugIdle[0], y: G.tugIdle[1], head: 'W', moving: false };
      let goal = G.tugIdle, fast = false;
      if (escort && escort.cur >= escort.path.sBL - 24) { const q = escort.path.ln.at(Math.min(escort.path.ln.len, escort.cur + SHIPS[escort.cls].L / 2 + TUG.L / 2 + 6)); goal = [q.x, q.y]; fast = true; }
      else if (tug.y > G.bw.yb - 4) goal = [G.bw.mouth, G.bw.BL + 8]; // outside: back in through the mouth first
      const dx = goal[0] - tug.x, dy = goal[1] - tug.y, dist = Math.hypot(dx, dy), stepL = (fast ? 150 : 34) * dt;
      tug.moving = dist > 0.5;
      if (dist <= stepL || (fast && dist < 3)) { tug.x = goal[0]; tug.y = goal[1]; } else { tug.x += dx / dist * stepL; tug.y += dy / dist * stepL; }
      if (dist > 1.5) tug.head = headOf(dx, dy);
      else if (!fast && goal === G.tugIdle) tug.head = 'W';
      const hl = f.dockHover === 'dock';
      boat({ key: 'tug', hit: 'dock', cx: tug.x, cy: tug.y, head: tug.head, dims: TUG, moving: tug.moving, smoke: true, a: art(`tug|${tug.head}|${hl}`, () => tugArt(tug.head, hl)) });
      if (tug.moving) wakes.push(...wake(V, tug.x, tug.y, tug.head, TUG, fast ? 60 : 20, f8, still));
      else wakes.push(...ripples(V, tug.x - 12, tug.y - 3, 4, 18, f8, 'tug', still));
    }
    // Tier 4: rowboats about the basin, and gulls overhead.
    if (G.tier >= 4 && G.bw) {
      const B = G.bw, west = G.lanes.reduce((m, l) => (l.fair < m.fair ? l : m)), hl = f.dockHover === 'dock';
      const rows = [
        { id: 'row1', a: [B.xw + 40, B.BL + 15], b: [B.tip - 70, B.BL + 15], period: 46 },
        { id: 'row2', a: [west.fair, G.y0 + 16], b: [west.fair, G.Y1 - 6], period: 32 },
      ];
      for (const r of rows) {
        const ph = still ? 0.25 : ((t / r.period + rnd(r.id)) % 1), k = ph < 0.5 ? ph * 2 : 2 - ph * 2, e = Math.min(1, Math.max(0, (k - 0.08) / 0.84)), s = e * e * (3 - 2 * e);
        const x = r.a[0] + (r.b[0] - r.a[0]) * s, y = r.a[1] + (r.b[1] - r.a[1]) * s, fwd = ph < 0.5 ? 1 : -1, moving = !still && e > 0 && e < 1;
        const head = headOf((r.b[0] - r.a[0]) * fwd, (r.b[1] - r.a[1]) * fwd), fr = moving ? Math.floor(t * 2.4) % 2 : 0;
        boat({ key: r.id, hit: 'dock', cx: x, cy: y, head, dims: ROW, moving: true, rower: true, a: art(`row|${head}|${fr}|${hl}`, () => rowboatArt(head, fr, hl)) });
        if (moving) wakes.push(...wake(V, x, y, head, ROW, 14, f8, still));
      }
      if (!still) {
        const cx = (B.xw + B.xe) / 2, cy = (G.Yf + B.yb) / 2;
        for (let i = 0; i < 5; i++) {
          const r = 70 + i * 26, w = (i % 2 ? -1 : 1) * (0.22 + i * 0.03), a = t * w + i * 1.9, z = 62 + i * 9 + Math.sin(t * 0.7 + i) * 4;
          const [X, Y] = V(cx + Math.cos(a) * r * 1.4, cy + Math.sin(a) * r * 0.7, z).map(Math.round);
          sky.push([X - 3, Y - 2, Math.floor(t * 3 + i * 1.3) % 3 === 0 ? 0 : 1]);
        }
      }
    }
  }

  // Foam: a V trailing a boat underway (longer the faster it goes), a little at the bow, and ripples
  // along a moored hull. (x, y) is the boat's middle.
  function wake(V, x, y, head, S, speed, f8, still) {
    const out = [], n = Math.min(7, 2 + Math.floor(speed / 12)), [fx, fy] = HEAD[head](0, 1), [sx, sy] = HEAD[head](1, 0);
    const bx = x - fx * S.L / 2, by = y - fy * S.L / 2;
    for (let j = 0; j < n; j++) for (const sd of [-1, 1]) {
      if (!still && (f8 + j) % 4 === 0) continue;
      const [X, Y] = V(bx + sd * sx * (3 + j * 2.4) - fx * (1 + j * 4.5), by + sd * sy * (3 + j * 2.4) - fy * (1 + j * 4.5));
      out.push([Math.round(X), Math.round(Y), j < 2 ? 4 : 3, j > 4 ? 0.5 : 0.9]);
    }
    for (const sd of [-1, 1]) { const [X, Y] = V(x + fx * (S.L / 2 - 6) + sd * sx * 5, y + fy * (S.L / 2 - 6) + sd * sy * 5); out.push([Math.round(X), Math.round(Y), 2, 0.8]); }
    return out;
  }
  function ripples(V, x, y, half, len, f8, seed, still) {
    const out = [], o = Math.floor(rnd(seed) * 8);
    for (const sd of [-1, 1]) for (let j = 0; j < 2; j++) {
      const k = still ? j * 2 : (f8 + o + j * 3) % 6;
      if (k > 3) continue;
      const [X, Y] = V(x + sd * (half + 2), y + 6 + ((j * 17 + k * 5 + o) % Math.max(1, len)));
      out.push([Math.round(X), Math.round(Y), 3, 0.5]);
    }
    return out;
  }

  /** The ground layer, drawn right after the terrain: the harbour's flat parts and the foam on the water. */
  function drawGround(ctx) {
    for (const a of ground) ctx.drawImage(a.img, a.ox, a.oy);
    ctx.fillStyle = '#e9fbff';
    for (const [x, y, w, al] of wakes) { ctx.globalAlpha = al; ctx.fillRect(x, y, w, 1); }
    ctx.globalAlpha = 1;
  }
  /** Over everything (before the night veil): the gulls. */
  function drawSky(ctx) {
    if (!sky.length) return;
    const gl = gulls();
    for (const [x, y, fr] of sky) ctx.drawImage(gl[fr], x, y);
  }
  /** An upright part in the depth-sorted list (villager-shaped parts are drawn by the renderer). */
  function draw(ctx, d, f) {
    if (d.dk === 'art') {
      ctx.drawImage(d.a.img, d.a.ox, d.a.oy);
      if (d.rope) { // a crane's hook: a crate swinging on its rope
        const [x, y, s] = d.rope;
        ctx.fillStyle = '#3a2a22'; ctx.fillRect(x, y, 1, 14); ctx.fillRect(x + Math.sign(s), y + 10, 1, 6);
        ctx.drawImage(crate(), x - 4 + s, y + 15);
      }
      if (d.lamp) { // the lighthouse's lantern (flashing as the beam swings past), or a beacon / buoy light
        const [x, y, c, col] = d.lamp, lit = (f.night || 0) > 0.35;
        if (c >= -1) {
          if (!lit) { ctx.fillStyle = '#ffd27a'; ctx.fillRect(x - 1, y - 1, 2, 3); }
          else { ctx.fillStyle = '#fff4c2'; ctx.fillRect(x - 2, y - 3, 4, 6); if (c > 0.82) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 3, y - 2, 6, 4); ctx.fillRect(x - 1, y - 5, 2, 10); } }
        } else if (col) { ctx.fillStyle = col; ctx.fillRect(x - 1, y - 1, 2, 2); }
      }
    } else if (d.dk === 'ship') {
      ctx.globalAlpha = d.alpha;
      ctx.drawImage(d.a.img, d.ax + d.a.ox, d.ay + d.a.oy);
      const at = (lx, ly, z) => { const [wx, wy] = HEAD[d.head](lx, ly); return [d.ax + Math.round((wx - wy) * ISO), d.ay + Math.round((wx + wy) * ISO / 2 - z)]; };
      if (d.spots) {
        // Cargo stowed as it's loaded; the pennant at the masthead says how it's going.
        for (let i = 0; i < Math.min(d.crates, d.spots.length); i++) { const [lx, ly, l] = d.spots[i], [X, Y] = at(lx, ly, d.deckZ); ctx.drawImage(crate(), X - 4, Y - 7 - l * 6); }
      }
      if (d.mast && d.pen) { const [mx, my] = at(d.mast[0], d.mast[1], d.mast[2]); ctx.drawImage(pennant(d.pen, d.fr), mx, my - 1); }
      if (d.rower) { const [X, Y] = at(0, 9.5, 4); ctx.fillStyle = '#1d1233'; ctx.fillRect(X - 2, Y - 8, 5, 8); ctx.fillStyle = '#3f6b8c'; ctx.fillRect(X - 1, Y - 5, 3, 4); ctx.fillStyle = '#e8b48a'; ctx.fillRect(X - 1, Y - 7, 3, 2); }
      if (d.smoke && (d.t || 0) > 0) { // the tug's funnel: puffs drifting up and off
        const [X, Y] = at(0, 9.8, 19);
        ctx.fillStyle = '#d9d4cc';
        for (let i = 0; i < 3; i++) { const k = ((d.t * 0.8 + i / 3) % 1), s = k < 0.5 ? 2 : 3; ctx.globalAlpha = d.alpha * (1 - k) * 0.85; ctx.fillRect(Math.round(X + k * 8 - 1), Math.round(Y - k * 14), s, s); }
      }
      ctx.globalAlpha = 1;
    } else if (d.dk === 'stack') {
      for (let i = 0; i < d.n; i++) ctx.drawImage(crate(), d.x - 4, d.y - 7 - i * 6);
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
    frame, drawGround, drawSky, draw, hit,
    get parts() { return parts; }, get lights() { return lights; }, get tags() { return tags; },
    get walking() { return walking; },
    debug: () => ({ tier: held.tier, berths: [...slotOf].map(([h, s]) => [h, s.key, s.cls]), sails: sails.map(s => ({ href: s.href, slot: s.slot?.key, t0: s.t0, cur: s.cur && Math.round(s.cur) })), tug: tug && { x: Math.round(tug.x), y: Math.round(tug.y), head: tug.head }, parts: parts.length, walkers: walkers.debug() }),
  };
}
