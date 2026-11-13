// World v3 (docs/ARCHITECTURE.md, "The village"): one compact town of project neighbourhoods around a central square, drawn
// with the v2 value structure (muted terrain, toned buildings, outlined agents, loud badges). Two halves:
//   layout()        pure placement: blocks, homes, PR sites, decor, streets, the land and the forest ring.
//                   Positions persist in localStorage (`va.world4`) and never move. Needs no images.
//   createRenderer  the sprite renderer (Ninja Adventure, CC0). village.js falls back to its own
//                   procedural drawing of the same layout if the sheets don't load.
import { store } from './ui.js';
import { isoBuilding, isoExtent } from './iso.js';
import { pinned, folds, stoppedNote } from './important.js';
import { createDockArt } from './dock-art.js';

const BASE = `${import.meta.env.BASE_URL}assets/ninja-adventure/`;
export const T = 16;
export const ZOOMS = [0.5, 1, 2, 3, 4];

// [sheet, x, y, w, h, doorX, windows]
export const R = {
  hall: ['house', 400, 224, 64, 80, 32, [[44, 52, 8, 10]]],
  houseA: ['house', 0, 0, 64, 48, 32, [[5, 34, 8, 10], [43, 34, 9, 10]]], houseD: ['house', 192, 0, 64, 48, 32, [[5, 34, 8, 10], [44, 34, 9, 10]]],
  houseC: ['house', 128, 0, 64, 48, 32, [[5, 34, 8, 10]]], houseB: ['house', 64, 0, 64, 48, 32, []],
  houseH: ['house', 416, 0, 48, 48, 24, [[4, 30, 6, 8], [38, 30, 6, 8]]], houseG: ['house', 368, 0, 48, 48, 24, [[37, 34, 6, 6]]],
  houseE: ['house', 256, 0, 48, 48, 24, [[4, 34, 8, 9], [36, 34, 8, 9]]], houseF: ['house', 304, 0, 64, 48, 40, [[23, 6, 8, 9]]],
  cabin: ['house', 304, 304, 48, 48, 24, [[18, 10, 12, 10]]],
  towerWood: ['towers', 0, 0, 32, 32, 16, []], towerGreen: ['towers', 96, 0, 32, 32, 16, []], towerSand: ['towers', 192, 0, 32, 32, 16, []],
  towerDome: ['towers', 288, 0, 32, 32, 16, []], towerRed: ['towers', 288, 32, 32, 32, 16, []], towerWhite: ['towers', 192, 64, 32, 32, 16, []],
  sand: ['water', 0, 80, 16, 16],
  lantern: ['element', 96, 48, 16, 32], scarecrow: ['element', 240, 0, 16, 16], hay: ['element', 208, 64, 48, 48],
  awning: ['house', 256, 256, 48, 32], produce: ['house', 304, 224, 32, 32], baskets: ['house', 256, 208, 48, 16],
  cart: ['element', 0, 48, 32, 32], laundry: ['element', 224, 40, 32, 24], barrel: ['element', 16, 0, 16, 16], crate: ['element', 0, 0, 16, 16],
  log: ['nature', 80, 128, 16, 16], block: ['nature', 64, 128, 16, 16],
  treeRound: ['nature', 256, 0, 32, 32], treeRound2: ['nature', 288, 0, 32, 32], pine: ['nature', 32, 0, 32, 32],
  treeBig: ['nature', 48, 288, 48, 48], treePink: ['nature', 0, 288, 48, 48], sapling: ['nature', 96, 128, 32, 32],
  bush: ['nature', 0, 160, 16, 16], bush2: ['nature', 16, 160, 16, 16], sunflower: ['nature', 0, 176, 16, 16],
  redflower: ['nature', 16, 176, 16, 16], clover: ['nature', 32, 176, 16, 16], tulip: ['nature', 48, 176, 16, 16], rock: ['nature', 240, 144, 16, 16],
  banner: ['house', 352, 320, 16, 32],
};
export const LOOKS = ['Villager2', 'Woman', 'OldMan', 'Villager4', 'Hunter', 'Princess', 'Villager3', 'Boy', 'Monk2', 'Villager5', 'OldMan3'];
export const NINJAS = ['NinjaBlue', 'NinjaRed', 'NinjaYellow', 'NinjaGreen', 'NinjaMasked', 'NinjaDark', 'NinjaLeaf', 'NinjaGray'];
const PR_LOOKS = ['houseE', 'cabin', 'towerWood', 'houseF', 'towerSand', 'houseG', 'towerDome', 'houseH', 'towerRed', 'towerWhite', 'towerGreen'];
export const ACCENT = ['#e4572e', '#2e86de', '#f2b134', '#9b59b6', '#16a085', '#e84393', '#27ae60', '#d35400'];
const DECOR = [['lanterns', 0], ['tree', 2], ['flowers', 4], ['field', 6], ['stall', 9], ['tree', 12], ['cart', 15], ['laundry', 18],
  ['stall', 22], ['field', 26], ['flowers', 30], ['tree', 34], ['barrels', 38], ['tree', 44], ['field', 50]];
const DECOR_SIZE = { lanterns: [5, 2], tree: [2, 2], flowers: [3, 1], field: [3, 3], stall: [3, 3], cart: [2, 2], laundry: [2, 2], barrels: [2, 1] };
// Compactness caps: a big, spread-out village is hard to take in at a glance.
// Each is per neighbourhood.
const RESTING_HOMES = 2; // the most recently active resting homes; more would sprawl
const PR_LIVE_CAP = 6;   // PRs under construction (builders hammer there)
const PR_DONE_CAP = 3;   // the newest finished PR buildings; older ones fall off the map
const DECOR_CAP = 3;     // decor never grows a block; it fills spare ground, up to this many
export const SQUARE = { x: -4, y: -3, w: 9, h: 5 }; // the central town square (tiles)
const GAP = 2;           // tiles between blocks: their two ring roads make one 2-wide street
const DAY = 864e5;
const HOLD_MS = DAY / 2;     // a building that vanished holds its ground this long, then frees it
const RESERVE_MS = 14 * DAY; // a hidden neighbourhood keeps its block this long before a newcomer may take it
export const SEA_MID = '#2a7fae', SEA_DEEP = '#1b4a7a';
// The village is drawn isometric (2.5D) only (owner, 2026-11-11: the top-down view is gone): the ground is
// the tile map turned 45° and squashed 2:1; buildings are boxes with walls and roofs drawn in that
// projection (iso.js); trees, lamps and villagers stand upright on their spot like the sprites they are.
// ISO is view px per world px along the ground. Layout stays in world px; "view px" are isoP of them.
export const ISO = 0.8;
export const isoP = (x, y) => [(x - y) * ISO, (x + y) * ISO / 2];
export const isoInv = (X, Y) => { const a = X / ISO, b = 2 * Y / ISO; return [(a + b) / 2, (b - a) / 2]; };
/** An upright thing standing on world point (x, y): its offset in iso. */
export const pointOffset = (x, y) => { const [X, Y] = isoP(x, y); return [Math.round(X - x), Math.round(Y - y)]; };
/** A villager stands on its own spot (its feet; the door when it is indoors or in the crowd). */
export const agentOffset = v => pointOffset(v.x ?? v.door, v.y ?? v.base + 12);
/** A building in the iso view: its drawing, and where it goes in view px. */
export function isoItem(it, lit) {
  it.doorX ??= R[it.look][5];
  const b = isoBuilding(it, T, lit), [ox, oy] = isoP(it.x * T, it.y * T);
  return { ...b, ox, oy, x: ox + b.dx, y: oy + b.dy };
}
/**
 * Painter's order for the iso view. Each drawable has a ground footprint (fx0, fy0)–(fx1, fy1) in world
 * px (a point for anything standing upright: a villager's feet, a lamp's foot) and a screen rect
 * (sx0, sy0)–(sx1, sy1) in view px. Wherever two screen rects overlap, the one further back on the
 * ground is drawn first: wholly west of or north of the other (the viewer looks from the south-east).
 * Buildings are boxes, so a villager in its yard sorts in front of the house and one behind a house
 * sorts behind it, whatever their screen y. A depth-first topological sort keeps those pairs; anything
 * else keeps the plain (x + y) order. Returns the list in draw order; each item's `occludes` lists the
 * overlapping things it hides (they were drawn before it).
 */
export function isoSort(list) {
  const n = list.length;
  for (const d of list) { d.k = d.fx0 + d.fx1 + d.fy0 + d.fy1; d.occludes = null; }
  list.sort((a, b) => a.k - b.k);
  const behind = (a, b) => { // is a behind b?
    const aBack = a.fx1 <= b.fx0 || a.fy1 <= b.fy0, bBack = b.fx1 <= a.fx0 || b.fy1 <= a.fy0;
    return aBack !== bBack ? aBack : a.k < b.k;
  };
  const before = Array.from({ length: n }, () => []); // before[i]: what must be drawn before list[i]
  const byX = list.map((_, i) => i).sort((i, j) => list[i].sx0 - list[j].sx0);
  for (let p = 0; p < n; p++) {
    const i = byX[p], a = list[i];
    for (let q = p + 1; q < n; q++) {
      const j = byX[q], b = list[j];
      if (b.sx0 >= a.sx1) break;
      if (b.sy0 >= a.sy1 || a.sy0 >= b.sy1) continue;
      const [back, front] = behind(a, b) ? [i, j] : [j, i];
      before[front].push(back);
      if (list[front].it && list[back].vd) (list[front].occludes ||= []).push(list[back]);
    }
  }
  const state = new Uint8Array(n), out = [];
  const visit = i => {
    if (state[i]) return; // done, or on the stack (a cycle: leave it where it is)
    state[i] = 1;
    for (const j of before[i]) visit(j);
    state[i] = 2;
    out.push(list[i]);
  };
  for (let i = 0; i < n; i++) visit(i);
  return out;
}
/** The box a building covers on screen, in view px: [x, y, w, h]. */
export function itemBox(it) {
  const b = isoItem(it, false);
  return [b.ox + b.box[0], b.oy + b.box[1], b.box[2], b.box[3]];
}
const KEY = 'va.world5'; // va.world4 had roomier lots: a fresh, tighter layout

export const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const rnd = s => (hash(s) % 10000) / 10000;
const key = (x, y) => `${x},${y}`;
const unkey = k => k.split(',').map(Number);
function noise(x, y, s = 7) {
  const gx = Math.floor(x / s), gy = Math.floor(y / s), fx = x / s - gx, fy = y / s - gy;
  const n = (i, j) => rnd(`n${i},${j}`), sm = t => t * t * (3 - 2 * t);
  const a = n(gx, gy), b = n(gx + 1, gy), c = n(gx, gy + 1), d = n(gx + 1, gy + 1);
  return a + (b - a) * sm(fx) + (c - a) * sm(fy) + (a - b - c + d) * sm(fx) * sm(fy);
}
// Rects (tiles): do a and b come closer than `gap` tiles?
const near = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// ---------------- layout ----------------
const saved = () => { const s = store.get(KEY, null); return s && s.blocks && s.pos ? s : { blocks: {}, pos: {} }; };

// What the world is made of this poll (only the projects the village shows). Cheap; its signature
// decides whether to re-run layout().
export function plan(agents, byId, projects) {
  const S = saved();
  const names = [...new Set(agents.map(a => a.project || '—'))];
  // An Important agent always keeps its own house and villager, whatever its rank or status.
  const hasHome = a => a.role === 'boss' || a.role === 'lead' || !a.parentId || !byId.has(a.parentId) || pinned(a);
  const villages = names.map(name => {
    const here = agents.filter(a => (a.project || '—') === name);
    const meta = (projects || []).find(p => p.name === name) || {};
    const owners = here.filter(hasHome);
    const awake = owners.filter(a => !folds(a)); // Important resting agents are never capped away
    const resting = owners.filter(folds).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)).slice(0, RESTING_HOMES);
    const homes = [...awake, ...resting];
    // PRs: the server's per-project history (outlives agents); else what agents list right now.
    const all = meta.prs?.length ? meta.prs.map(p => ({ id: String(p.id), live: !!p.live }))
      : [...new Map(here.flatMap(a => (a.prs || []).map(p => [String(p.id), { id: String(p.id), live: a.live && a.bucket !== 'resting' }]))).values()];
    const newest = (a, b) => (+b.id || 0) - (+a.id || 0);
    const prs = [...all.filter(p => p.live).sort(newest).slice(0, PR_LIVE_CAP), ...all.filter(p => !p.live).sort(newest).slice(0, PR_DONE_CAP)];
    const mb = (meta.transcriptBytes || 0) / 1e6;
    const growth = 3 * all.length + (meta.agentsEver || here.length) + Math.floor(Math.log2(mb + 1));
    const busy = awake.length * 10 + here.filter(a => a.bucket !== 'resting').length;
    return { name, homes, prs, growth, busy };
  });
  const items = villages.flatMap(v => [
    ...v.homes.map(a => `home:${a.id}:${a.role === 'boss' ? 'hall' : a.role === 'lead' ? 'L' : 'S'}`),
    ...v.prs.map(p => `pr:${v.name}#${p.id}:${p.live ? 1 : 0}`),
    `decor:${v.name}:${decorTier(v.growth)}`,
  ]);
  return { villages, sig: JSON.stringify([villages.map(v => v.name), items]), saved: S };
}
const decorTier = growth => Math.min(DECOR_CAP, DECOR.filter(([, at]) => growth >= at).length);

export function layout(P, now = Date.now()) {
  const S = P.saved;
  const W = { villages: [], items: [], occ: new Map(), fp: new Set(), path: new Set(), street: new Set(), land: new Set(), seaDist: new Map(),
    props: [], groundDecor: [], square: SQUARE, inBlock: new Map(), box: null, bounds: null, town: null };
  const shown = new Set(P.villages.map(v => v.name));
  const B = S.blocks;
  // A block is held while its project shows, or for RESERVE_MS after it was last shown. A lapsed block
  // is only taken when a newcomer needs that ground; it is then marked away and its project gets a new
  // block (same shape, everything inside shifted together) if it ever comes back.
  const held = n => B[n] && !B[n].away && (shown.has(n) || now - (B[n].seen || 0) < RESERVE_MS);
  const obstacles = self => [SQUARE, ...Object.keys(B).filter(n => n !== self && held(n)).map(n => B[n])];
  const evict = (r, self) => { for (const n of Object.keys(B)) if (n !== self && !held(n) && !B[n].away && near(r, B[n], GAP)) B[n].away = true; };
  // Score a spot by the town it makes: the side that limits zoom when the shown town (square + shown
  // blocks) is fitted to a landscape view (ASPECT ≈ the village pane at 1440×900), then nearness to the
  // square. The lower, the more of the town fits on one screen.
  const ASPECT = 1.25;
  const score = (r, self) => {
    let x0 = Math.min(r.x, SQUARE.x), y0 = Math.min(r.y, SQUARE.y), x1 = Math.max(r.x + r.w, SQUARE.x + SQUARE.w), y1 = Math.max(r.y + r.h, SQUARE.y + SQUARE.h);
    for (const n of shown) { const o = B[n]; if (n === self || !o || o.away) continue; x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h); }
    return Math.max((x1 - x0) / ASPECT, y1 - y0) + Math.hypot((r.x + r.w / 2) / ASPECT, r.y + r.h / 2) * 0.02;
  };
  // Ties go to the spot that shares the most street with what is already there (tight, no holes).
  const contact = (r, obs) => {
    let c = 0;
    for (const o of obs) {
      const ox = Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x), oy = Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y);
      if (oy > 0 && (r.x === o.x + o.w + GAP || o.x === r.x + r.w + GAP)) c += oy;
      if (ox > 0 && (r.y === o.y + o.h + GAP || o.y === r.y + r.h + GAP)) c += ox;
    }
    return c;
  };
  function findSpot(w, h, self) {
    const obs = obstacles(self);
    let best = null;
    for (let y = -90; y <= 90; y++) for (let x = -120; x <= 120; x++) {
      const r = { x, y, w, h };
      if (obs.some(o => near(r, o, GAP))) continue;
      const s = score(r, self) - contact(r, obs) * 0.05;
      if (!best || s < best[0]) best = [s, r];
    }
    return best[1];
  }

  // Each village's claims, in claim order (claim order only matters for new items).
  const claims = new Map();
  for (const pv of P.villages) {
    const q = [], name = pv.name;
    const claim = (id, look, yard, kind, extra) => { const r = R[look]; q.push([id, Math.ceil(r[3] / T), Math.ceil(r[4] / T), yard, kind, { look, ...extra }]); };
    for (const a of pv.homes) if (a.role === 'boss') claim(`home:${a.id}`, 'hall', 1, 'home', { agentId: a.id });
    for (const a of pv.homes) if (a.role === 'lead') claim(`home:${a.id}`, ['houseA', 'houseD', 'houseC', 'houseB'][hash(a.id) % 4], 1, 'home', { agentId: a.id });
    // Every lot has one yard row in front (its agent, a subagent crew, a builder crew) and a one-tile
    // side gap, and nothing behind: the yard row doubles as the lane. A crew that doesn't fit the row
    // stands in the crowd ("+N more").
    for (const a of pv.homes) if (a.role !== 'boss' && a.role !== 'lead') claim(`home:${a.id}`, ['houseH', 'houseG'][hash(a.id) % 2], 1, 'home', { agentId: a.id });
    for (const pr of [...pv.prs].reverse()) claim(`pr:${name}#${pr.id}`, PR_LOOKS[hash(pr.id) % PR_LOOKS.length], 1, 'pr', { pr: pr.id, building: pr.live });
    DECOR.slice(0, decorTier(pv.growth)).forEach(([kind], i) => { const [w, h] = DECOR_SIZE[kind]; q.push([`decor:${name}:${i}`, w, h, 0, 'decor', { decor: kind }]); });
    claims.set(name, q);
  }
  // Blocks: new neighbourhoods take the free spot nearest the square, busiest first, sized for what they
  // hold today (plus a little room). A returning one keeps its block.
  const size = pv => claims.get(pv.name).reduce((a, q) => a + (q[1] + 1) * (q[2] + q[3] + 1), 0);
  const order = [...P.villages].sort((a, b) => (B[a.name] && !B[a.name].away ? 0 : 1) - (B[b.name] && !B[b.name].away ? 0 : 1) || size(b) - size(a) || b.busy - a.busy || a.name.localeCompare(b.name));
  // Grow a block by a tile on the side that keeps the town most compact (never into another block).
  // Up is the last resort: the neighbourhood square sits at the top and rows of homes fill downwards.
  const grow = v => {
    const b = v.block, obs = obstacles(v.name);
    const opts = [[0, 0, 1, 0, 0], [0, 0, 0, 1, 0], [-1, 0, 1, 0, 0], [0, -1, 0, 1, 99]].map(([dx, dy, dw, dh, pen]) => ({ x: b.x + dx, y: b.y + dy, w: b.w + dw, h: b.h + dh, pen }))
      .filter(r => !obs.some(o => near(r, o, GAP))).sort((p, q) => score(p, v.name) + p.pen - score(q, v.name) - q.pen);
    if (!opts.length) return false;
    const { pen, ...r } = opts[0];
    Object.assign(b, r);
    evict(b, v.name);
    return true;
  };
  // One neighbourhood at a time: its block, then everything in it (growing the block while nothing
  // hems it in yet), then the next. Existing blocks go first, so they can still grow.
  const byName = new Map();
  for (const pv of order) {
    const name = pv.name, b = B[name];
    if (!b || b.away) {
      let w, h;
      if (b) ({ w, h } = b);
      else {
        let area = 7 * 5;
        for (const [, iw, ih, yard, kind] of claims.get(name)) area += (iw + 1) * (ih + yard) * (kind === 'decor' ? 0.5 : 1);
        area *= 1.1;
        w = Math.max(9, Math.round(Math.sqrt(area * 1.4))) + 2;
        h = Math.max(6, Math.ceil(area / (w - 2))) + 2;
      }
      const r = findSpot(w, h, name);
      if (b) { // came back after its block was taken: move everything it owns along with it
        for (const p of Object.values(S.pos)) if (p[5] === name) { p[0] += r.x - b.x; p[1] += r.y - b.y; }
        delete b.away;
        Object.assign(b, r);
      } else {
        const used = Object.keys(B).filter(n => held(n) && near(B[n], r, GAP + 4)).map(n => B[n].acc);
        const tally = i => Object.values(B).filter(o => o.acc === i).length;
        const acc = ACCENT.map((_, i) => i).filter(i => !used.includes(i)).sort((i, j) => tally(i) - tally(j) || i - j)[0] ?? 0;
        B[name] = { ...r, acc };
      }
      evict(B[name], name);
    }
    B[name].seen = now;
    const v = { ...pv, block: B[name], accent: ACCENT[B[name].acc % ACCENT.length] };
    byName.set(name, v);
    placeVillage(W, v, S, claims.get(name), grow, now);
  }
  for (const pv of P.villages) W.villages.push(byName.get(pv.name));
  for (const v of W.villages) for (let y = v.block.y; y < v.block.y + v.block.h; y++) for (let x = v.block.x; x < v.block.x + v.block.w; x++) W.inBlock.set(key(x, y), v);
  store.set(KEY, S);
  W.parks = Object.keys(B).filter(n => !shown.has(n) && held(n)).map(n => B[n]); // hidden neighbourhoods: their ground waits as park
  buildRoads(W);
  W.dock = dockSite(W);
  buildLand(W);
  dockShore(W);
  scatter(W);
  W.waves = [...W.seaDist].filter(([k, d]) => d === 3 && hash(k) % 3 === 0).map(([k]) => unkey(k));
  return W;
}

function placeVillage(W, v, S, queue, grow, now) {
  const { name } = v, b = v.block;
  // The neighbourhood's own square (sign, banner, lantern, chicken) sits at the top middle of the
  // block and never moves; homes fill rows below it like shelves, from the middle outwards.
  const pid = `plaza:${name}`;
  if (!S.pos[pid]) S.pos[pid] = [b.x + ((b.w - 5) >> 1), b.y + 2, 5, 3, 0, name];
  const [px, py] = S.pos[pid];
  v.plaza = { x: px, y: py, w: 5, h: 3 };
  v.cx = px + 2; v.cy = py + 1;
  for (let j = py - 1; j < py + 4; j++) for (let i = px - 1; i < px + 6; i++) W.occ.set(key(i, j), pid);
  for (let j = py; j < py + 3; j++) for (let i = px; i < px + 5; i++) W.path.add(key(i, j));
  // Inside the block's fence (its outer ring of tiles); an item's spare gap may sit on the fence.
  const free = (x, y, w, h) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (W.occ.has(key(i, j))) return false; return true; };
  const fits = (x, y, w, h) => x >= b.x + 1 && y >= b.y + 1 && x + w <= b.x + b.w && y + h <= b.y + b.h && free(x, y, w, h);
  const spots = (w, h) => {
    const out = [];
    for (let y = b.y + 1; y + h <= b.y + b.h; y++) for (let x = b.x + 1; x + w <= b.x + b.w; x++) out.push([x, y, (y - b.y) * 64 + Math.abs(x + w / 2 - v.cx - 0.5)]);
    return out.sort((p, q) => p[2] - q[2]);
  };
  // Last resort, when the block is hemmed in: the nearest free ground just outside it, clear of every
  // block, ring road and the square. Rare; nothing moves to make room.
  const annex = (w, h) => {
    const taken = (x, y) => W.occ.has(key(x, y)) || [SQUARE, ...Object.values(S.blocks).filter(o => !o.away)].some(o => x >= o.x - 2 && x < o.x + o.w + 2 && y >= o.y - 2 && y < o.y + o.h + 2);
    let best = null;
    for (let y = b.y - 24; y < b.y + b.h + 24; y++) for (let x = b.x - 24; x < b.x + b.w + 24; x++) {
      const d = Math.hypot(x + w / 2 - v.cx, y + h / 2 - v.cy);
      if (best && d >= best[2]) continue;
      let ok = true;
      for (let j = y; j < y + h && ok; j++) for (let i = x; i < x + w && ok; i++) if (taken(i, j)) ok = false;
      if (ok) best = [x, y, d];
    }
    return best;
  };
  const place = (id, w, h, yard, kind, extra) => {
    let p = S.pos[id];
    for (let tries = 0; !p && tries < 48; tries++) {
      const hit = spots(w + 1, h + yard).find(([x, y]) => fits(x, y, w + 1, h + yard));
      if (hit) p = S.pos[id] = [hit[0], hit[1], w, h, yard, name];
      else if (kind === 'decor') return null; // decor is the elastic part: it never grows a block
      else if (!grow(v)) { const a = annex(w + 1, h + yard); if (!a) return null; p = S.pos[id] = [a[0], a[1], w, h, yard, name]; }
    }
    if (!p) return null;
    p.length = 6; // present again: no longer counting down to release its ground
    for (let j = p[1]; j < p[1] + h + yard; j++) for (let i = p[0]; i < p[0] + w + 1; i++) W.occ.set(key(i, j), id);
    for (let j = p[1]; j < p[1] + h; j++) for (let i = p[0]; i < p[0] + w; i++) W.fp.add(key(i, j));
    const it = { id, kind, x: p[0], y: p[1], w, h, yard: p[4], village: v, ...extra };
    W.items.push(it);
    return it;
  };
  // A saved lot belongs to the neighbourhood that saved it. An agent whose project changed (renamed,
  // moved, regrouped) would otherwise be drawn at its old lot, which may be far outside today's town,
  // out at sea: it gets a new lot here instead.
  for (const q of queue) if (S.pos[q[0]] && S.pos[q[0]][5] !== name) delete S.pos[q[0]];
  // Saved items first; then hold the ground of saved items absent today (for HOLD_MS, then it is
  // freed); then new items take the first free fit. Nothing ever moves.
  const ids = new Set(queue.map(q => q[0]));
  for (const q of queue) if (S.pos[q[0]]) place(...q);
  for (const [id, p] of Object.entries(S.pos)) if (p[5] === name && !ids.has(id) && id !== pid) {
    if (p[6] == null) p[6] = now;
    if (now - p[6] > HOLD_MS) { delete S.pos[id]; continue; }
    for (let j = p[1]; j < p[1] + p[3] + p[4]; j++) for (let i = p[0]; i < p[0] + p[2] + 1; i++) W.occ.set(key(i, j), id);
  }
  for (const q of queue) if (!S.pos[q[0]]) place(...q);
  // A block shrinks back to what stands in it (plus its fence ring), so ground freed by buildings that
  // left doesn't stay as empty grass. It only shrinks from the right and the bottom: nothing moves.
  let x1 = v.plaza.x + v.plaza.w + 1, y1 = v.plaza.y + v.plaza.h + 1;
  for (const p of Object.values(S.pos)) if (p[5] === name) { x1 = Math.max(x1, p[0] + p[2] + 1); y1 = Math.max(y1, p[1] + p[3] + p[4]); }
  b.w = Math.min(b.w, Math.max(9, x1 - b.x + 1));
  b.h = Math.min(b.h, Math.max(6, y1 - b.y + 1));
}

// A* over a noise cost field toward `aim`; existing paths are cheap so new ones merge into them, and
// `avoid` (block interiors) is dear, so streets go round neighbourhoods rather than through them.
// ponytail: the heuristic overestimates on old paths, so routes are good rather than shortest.
function route(W, from, isGoal, box, aim, avoid) {
  const [x0, y0, x1, y1] = box, Wd = x1 - x0 + 1, idx = (x, y) => (y - y0) * Wd + (x - x0);
  const dist = new Float64Array(Wd * (y1 - y0 + 1)).fill(Infinity), prev = new Int32Array(dist.length).fill(-1), heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  const h = (x, y) => Math.hypot(x - aim[0], y - aim[1]), done = new Uint8Array(dist.length);
  for (const [x, y] of from) { if (x < x0 || y < y0 || x > x1 || y > y1) continue; dist[idx(x, y)] = 0; push(h(x, y), idx(x, y)); }
  while (heap.length) {
    const [, i] = pop();
    if (done[i]) continue;
    done[i] = 1;
    const d = dist[i], x = x0 + i % Wd, y = y0 + Math.floor(i / Wd);
    if (isGoal(x, y)) {
      const out = []; let px = null, py = null;
      for (let k = i; k >= 0; k = prev[k]) {
        const X = x0 + k % Wd, Y = y0 + Math.floor(k / Wd);
        if (px !== null && px !== X && py !== Y) out.push(W.fp.has(key(X, py)) ? [px, Y] : [X, py]);
        out.push([X, Y]); px = X; py = Y;
      }
      return out;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < x0 || Y < y0 || X > x1 || Y > y1 || W.fp.has(key(X, Y))) continue;
      if (dx && dy && (W.fp.has(key(x + dx, y)) || W.fp.has(key(x, y + dy)))) continue;
      const k = key(X, Y);
      const c = (W.path.has(k) ? 0.35 : (avoid?.has(k) ? 40 : 0) + 1 + 3 * noise(X, Y, 5) ** 2) * (dx && dy ? 1.42 : 1);
      const j = idx(X, Y);
      if (d + c < dist[j]) { dist[j] = d + c; prev[j] = i; push(d + c + h(X, Y), j); }
    }
  }
  return [];
}
// Streets: a ring road round every block (neighbours' rings make one 2-wide street) and a 2-wide road
// from each block to the square. Lanes: every door and each neighbourhood square join a street.
function buildRoads(W) {
  // The town spans every block, the square, and every lot (a lot annexed outside its block when the
  // block was hemmed in included), so the land always reaches under every building.
  const rects = [SQUARE, ...W.villages.map(v => v.block), ...W.items.map(it => ({ x: it.x, y: it.y, w: it.w + 1, h: it.h + it.yard }))];
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h));
  W.town = [x0 - 1, y0 - 1, x1, y1]; // inclusive tiles, ring roads included
  W.box = [x0 - 14, y0 - 14, x1 + 14, y1 + 14];
  const street = k => { W.path.add(k); W.street.add(k); };
  for (let j = SQUARE.y; j < SQUARE.y + SQUARE.h; j++) for (let i = SQUARE.x; i < SQUARE.x + SQUARE.w; i++) W.path.add(key(i, j));
  for (const v of W.villages) {
    const b = v.block;
    for (let i = b.x - 1; i <= b.x + b.w; i++) { street(key(i, b.y - 1)); street(key(i, b.y + b.h)); }
    for (let j = b.y; j < b.y + b.h; j++) { street(key(b.x - 1, j)); street(key(b.x + b.w, j)); }
  }
  const sq = [SQUARE.x + SQUARE.w / 2, SQUARE.y + SQUARE.h / 2];
  for (const v of [...W.villages].sort((a, b) => Math.hypot(a.cx, a.cy) - Math.hypot(b.cx, b.cy))) {
    const b = v.block, ring = [];
    for (let i = b.x - 1; i <= b.x + b.w; i++) ring.push([i, b.y - 1], [i, b.y + b.h]);
    for (let j = b.y; j < b.y + b.h; j++) ring.push([b.x - 1, j], [b.x + b.w, j]);
    for (const [x, y] of route(W, ring, (x, y) => inRect(SQUARE, x, y), W.box, sq, W.inBlock)) for (const [a, c] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (!W.inBlock.has(key(x + a, y + c))) street(key(x + a, y + c));
  }
  const lane = (v, from, aim) => {
    const b = v.block, vb = [Math.min(b.x, from[0]) - 2, Math.min(b.y, from[1]) - 2, Math.max(b.x + b.w, from[0]) + 1, Math.max(b.y + b.h, from[1]) + 1];
    for (const [x, y] of route(W, [from], (x, y) => inRect(v.plaza, x, y) || (W.path.has(key(x, y)) && Math.hypot(x - from[0], y - from[1]) > 2), vb, aim)) W.path.add(key(x, y));
  };
  for (const v of W.villages) { // the square's own lane to its ring, out through the side nearest the town square
    const b = v.block, p = v.plaza, dx = sq[0] - v.cx, dy = sq[1] - v.cy;
    const to = Math.abs(dx) * 0.8 > Math.abs(dy) ? [dx > 0 ? b.x + b.w : b.x - 1, p.y + 1] : [p.x + 2, dy > 0 ? b.y + b.h : b.y - 1];
    const from = [Math.min(Math.max(to[0], p.x), p.x + p.w - 1), Math.min(Math.max(to[1], p.y), p.y + p.h - 1)];
    for (const [x, y] of route(W, [from], (x, y) => W.street.has(key(x, y)), [b.x - 2, b.y - 2, b.x + b.w + 1, b.y + b.h + 1], to)) W.path.add(key(x, y));
  }
  for (const it of W.items) if (it.kind === 'home' || it.kind === 'pr') {
    const dx = it.x + Math.floor(R[it.look][5] / T), dy = it.y + it.h, v = it.village;
    it.doorTile = [dx, dy];
    lane(v, [dx, dy], [v.plaza.x + v.plaza.w / 2, v.plaza.y + v.plaza.h / 2]);
    W.path.add(key(dx, dy)); W.path.add(key(dx - 1, dy));
    if (it.kind === 'pr' && it.building) for (let j = it.y; j < it.y + it.h + 1; j++) for (let i = it.x - 1; i <= it.x + it.w; i++) W.path.add(key(i, j));
  }
}
// One land mass: the town box (blocks, streets, square) plus a 5–9 tile belt that the forest fills,
// with a sandy shore and the sea beyond, so zooming out never shows void. Inside the town box every
// tile is land; specks and lakes are cleaned up so the coast is one line.
function buildLand(W) {
  const [tx0, ty0, tx1, ty1] = W.town, E = 12, cand = new Set();
  for (let y = ty0 - E; y <= ty1 + E; y++) for (let x = tx0 - E; x <= tx1 + E; x++) {
    const d = Math.hypot(Math.max(tx0 - x, 0, x - tx1), Math.max(ty0 - y, 0, y - ty1));
    if (W.dock && x >= W.dock.x0 && x <= W.dock.x1 && y >= W.dock.sea) continue; // the dock's cove
    if (d <= 5 + noise(x, y, 6) * 4) cand.add(key(x, y));
  }
  for (const k of W.path) cand.add(k);
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const q = [key(tx0, ty0)], seen = new Set(q);
  for (let h = 0; h < q.length; h++) { const [x, y] = unkey(q[h]); for (const [a, b] of N4) { const k = key(x + a, y + b); if (cand.has(k) && !seen.has(k)) { seen.add(k); q.push(k); } } }
  // Water the outside sea can't reach is a lake: fill it.
  const sea = new Set(), sq = [];
  for (let x = tx0 - E - 1; x <= tx1 + E + 1; x++) for (const y of [ty0 - E - 1, ty1 + E + 1]) { sea.add(key(x, y)); sq.push(key(x, y)); }
  for (let y = ty0 - E - 1; y <= ty1 + E + 1; y++) for (const x of [tx0 - E - 1, tx1 + E + 1]) { sea.add(key(x, y)); sq.push(key(x, y)); }
  for (let h = 0; h < sq.length; h++) {
    const [x, y] = unkey(sq[h]);
    for (const [a, b] of N4) { const X = x + a, Y = y + b, k = key(X, Y); if (X < tx0 - E - 1 || X > tx1 + E + 1 || Y < ty0 - E - 1 || Y > ty1 + E + 1 || sea.has(k) || seen.has(k)) continue; sea.add(k); sq.push(k); }
  }
  for (let y = ty0 - E; y <= ty1 + E; y++) for (let x = tx0 - E; x <= tx1 + E; x++) { const k = key(x, y); if (seen.has(k) || !sea.has(k)) W.land.add(k); }
  for (let pass = 0; pass < 2; pass++) for (const k of [...W.land]) { // no 1-tile spits
    const [x, y] = unkey(k);
    if (x >= tx0 && x <= tx1 && y >= ty0 && y <= ty1) continue;
    if (N4.filter(([a, b]) => W.land.has(key(x + a, y + b))).length <= 1) W.land.delete(k);
  }
  let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
  for (const k of W.land) { const [x, y] = unkey(k); lx0 = Math.min(lx0, x); ly0 = Math.min(ly0, y); lx1 = Math.max(lx1, x); ly1 = Math.max(ly1, y); }
  W.bounds = [lx0 - 10, ly0 - 10, lx1 + 11, ly1 + 11];
  const dq = [];
  for (const k of W.land) { W.seaDist.set(k, 0); dq.push(k); }
  for (let h = 0; h < dq.length; h++) {
    const [x, y] = unkey(dq[h]), dv = W.seaDist.get(dq[h]);
    if (dv > 12) continue;
    for (const [dx, dy] of N4) { const k = key(x + dx, y + dy); if (!W.seaDist.has(k)) { W.seaDist.set(k, dv + 1); dq.push(k); } }
  }
}
// The dock (dock-art.js): a pier in a cove cut into the south shore, under the town square's column, so
// it sits close to town and never moves unless the town itself grows south. The cove (x0..x1, from row
// `sea` down) is open water all the way out; the pier starts on the land row `foot` just above it.
function dockSite(W) {
  const cx = SQUARE.x + (SQUARE.w >> 1), foot = W.town[3] + 2;
  return { cx, foot, sea: foot + 1, x0: cx - 5, x1: cx + 6 };
}
// A clearing round the cove (no forest in front of the ships) and a footpath from the pier to town.
function dockShore(W) {
  const D = W.dock;
  for (let y = D.foot - 1; y <= D.sea + 12; y++) for (let x = D.x0 - 2; x <= D.x1 + 2; x++) { const k = key(x, y); if (W.land.has(k) && !W.occ.has(k)) W.occ.set(k, 'dock'); }
  const from = [[D.cx, D.foot], [D.cx + 1, D.foot]];
  for (const [x, y] of route(W, from, (x, y) => W.path.has(key(x, y)), [D.cx - 14, W.town[1], D.cx + 15, D.foot], [D.cx, W.town[3]], W.inBlock)) W.path.add(key(x, y));
  for (const [x, y] of from) W.path.add(key(x, y));
}
function scatter(W) {
  const at = (r, x, y, extra = {}) => W.props.push({ r, x, y: y - R[r][4], base: y, ...extra });
  // The town square: a big tree in the middle and a lantern on each corner.
  const s = SQUARE;
  at('treeBig', (s.x + s.w / 2) * T - 24, (s.y + s.h - 1.2) * T, { tree: 1 });
  for (const [x, y] of [[s.x, s.y + 1], [s.x + s.w - 1, s.y + 1], [s.x, s.y + s.h], [s.x + s.w - 1, s.y + s.h]]) at('lantern', x * T, y * T, { light: 1 });
  for (const v of W.villages) { // each neighbourhood square: its banner, a lantern
    const p = v.plaza;
    at('banner', (p.x + p.w - 1) * T, (p.y + 1) * T + 4, { banner: v.accent });
    at('lantern', p.x * T, (p.y + 1) * T, { light: 1 });
  }
  for (const it of W.items) {
    if (it.kind !== 'decor') continue;
    const px = it.x * T, py = it.y * T, k = it.decor;
    if (k === 'lanterns') { at('lantern', px, py + 32, { light: 1 }); at('lantern', px + 64, py + 32, { light: 1 }); }
    if (k === 'tree') at(['treeRound', 'treeRound2', 'sapling'][hash(it.id) % 3], px, py + 32, { tree: 1 });
    if (k === 'flowers') ['sunflower', 'tulip', 'redflower'].forEach((f, i) => at(f, px + i * 16, py + 16));
    if (k === 'field') { W.groundDecor.push(['hay', px, py]); at('scarecrow', px + 16, py + 34); }
    if (k === 'stall') { at('awning', px, py + 32); at('produce', px + 8, py + 46); at('baskets', px, py + 48); }
    if (k === 'cart') at('cart', px, py + 32);
    if (k === 'laundry') at('laundry', px, py + 28);
    if (k === 'barrels') { at('barrel', px, py + 16); at('crate', px + 16, py + 16); }
  }
  // Street lamps: every block's corners and every few tiles along its edge, and one by each lane where it
  // leaves a block, so a neighbourhood is ringed with light at night.
  const lamps = new Set();
  for (const v of W.villages) {
    const b = v.block;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      const edgeX = x === b.x || x === b.x + b.w - 1, edgeY = y === b.y || y === b.y + b.h - 1, k = key(x, y);
      if ((!edgeX && !edgeY) || W.path.has(k) || W.fp.has(k) || W.occ.has(k)) continue;
      const corner = edgeX && edgeY, step = (x - b.x + y - b.y) % 8 === 0;
      const gate = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, c]) => W.path.has(key(x + a, y + c)) && (edgeX ? a === 0 : c === 0));
      if (!corner && !step && !gate) continue;
      if ([...lamps].some(l => { const [lx, ly] = unkey(l); return Math.abs(lx - x) + Math.abs(ly - y) < 5; })) continue;
      lamps.add(k);
      at('lantern', x * T, (y + 1) * T, { light: 1 });
    }
  }
  // District boundary: each block's outer ring of tiles, open wherever a lane crosses it and wherever
  // something stands on it, stays clear of trees (the iso ground draws it as a faint kerb line).
  const fence = new Set();
  for (const v of W.villages) {
    const b = v.block;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      const edgeX = x === b.x || x === b.x + b.w - 1, edgeY = y === b.y || y === b.y + b.h - 1, k = key(x, y);
      if ((!edgeX && !edgeY) || W.path.has(k) || W.fp.has(k) || lamps.has(k)) continue;
      fence.add(k);
    }
  }
  // Forest: denser the further from anything built or walked, so the town sits in a ring of woods.
  // Inside a neighbourhood only flowers and bushes grow; a hidden neighbourhood's block is a park.
  const dist = new Map(), q = [];
  for (const k of [...W.occ.keys(), ...W.path]) if (!dist.has(k)) { dist.set(k, 0); q.push(k); }
  for (let h = 0; h < q.length; h++) {
    const [x, y] = unkey(q[h]), d = dist.get(q[h]);
    if (d > 8) continue;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = key(x + a, y + b); if (!dist.has(k)) { dist.set(k, d + 1); q.push(k); } }
  }
  const park = (x, y) => W.parks.some(r => inRect(r, x, y));
  for (const k of W.land) {
    const [x, y] = unkey(k);
    if (x % 2 || y % 2 || W.occ.has(k) || W.path.has(k) || fence.has(k) || lamps.has(k) || lamps.has(key(x + 1, y)) || W.path.has(key(x + 1, y)) || W.path.has(key(x, y + 1)) || W.occ.has(key(x + 1, y + 1))) continue;
    const h = hash(`t${k}`), inside = W.inBlock.has(k) || W.inBlock.has(key(x + 1, y + 1));
    if (inside) { if ((h >>> 3) % 7 === 0) at(['bush', 'bush2', 'clover', 'sunflower', 'tulip'][(h >>> 5) % 5], x * T, y * T + 16, { wild: 1 }); continue; }
    const v = (dist.get(k) ?? 9) - 2;
    const coast = [[3, 0], [-3, 0], [0, 3], [0, -3]].some(([a, b]) => !W.land.has(key(x + a, y + b)));
    const p = park(x, y) ? 0.35 : Math.min(0.9, Math.max(0, (v + 1) / 5) * 0.8 + (coast ? 0.25 : 0));
    if ((h % 1000) / 1000 < p) at(['pine', 'treeRound', 'pine', 'treeRound2', 'treeBig', 'treePink'][h % 6 === 5 && v > 4 ? 5 : h % 5], x * T + ((h >>> 10) % 7) - 8, y * T + 24 + ((h >>> 14) % 5), { tree: 1, wild: 1 });
    else if ((h >>> 3) % 9 === 0) at(['bush', 'bush2', 'clover', 'sunflower', 'rock'][(h >>> 5) % 5], x * T, y * T + 16, { wild: 1 });
  }
}

// ---------------- who stands where (every poll; cheap) ----------------
// The yard: a row of fixed spots in the home's yard row (the tile row in front of it), up to 6 per home;
// stalled agents are placed first so their badges get one. A spot a neighbour's crew or doorstep
// already takes is skipped, and so is one off the land or on a building's footprint: that row used to
// sit a tile further out, inside the next lot's house, so in the 2.5D view crews stood on its roof.
const YARD = [-32, -54, 54, -76, 76].map(x => [x, 12]);
const YARD_CAP = 6;
export function placeAgents(W, agents, byId, seenIdx) {
  const homeById = new Map(W.items.filter(it => it.kind === 'home').map(it => [it.agentId, it]));
  const prItem = new Map(W.items.filter(it => it.kind === 'pr').map(it => [`${it.village.name}#${it.pr}`, it]));
  const homeOf = a => { for (let x = a, g = 0; x && g < 50; x = byId.get(x.parentId), g++) { const h = homeById.get(x.id); if (h) return h; } return null; };
  const vill = new Map(), crews = new Map(), yard = new Map(), crowd = new Map();
  // Every doorstep is kept for its own agent, so a neighbour's crew never stands on it.
  const taken = W.items.filter(it => it.kind === 'home').map(it => [it.x * T + R[it.look][5], (it.y + it.h) * T + 12]);
  const free = (x, y) => !taken.some(([a, b]) => Math.abs(a - x) < 20 && Math.abs(b - y) < 14);
  // Feet (x, y) on open ground: land, and not on any building's footprint (5 px either side of the feet).
  const ground = (x, y) => [x - 5, x + 5].every(px => { const k = key(Math.floor(px / T), Math.floor((y - 2) / T)); return W.land.has(k) && !W.fp.has(k); });
  const rank = { stalled: 0, waiting: 1, building: 2, resting: 3 };
  for (const a of [...agents].sort((x, y) => rank[x.bucket] - rank[y.bucket] || (seenIdx.get(x.id) ?? 0) - (seenIdx.get(y.id) ?? 0))) {
    const home = homeOf(a);
    if (!home) continue;
    const own = home.agentId === a.id;
    const look = a.role === 'boss' ? 'Sultan2' : a.role === 'sub' && !own ? NINJAS[hash(home.agentId) % NINJAS.length] : LOOKS[(seenIdx.get(a.id) ?? hash(a.id)) % LOOKS.length];
    const v = { a, home, look, own, sub: a.role === 'sub' && !own, phase: rnd(a.id), crowd: false };
    const door = home.x * T + R[home.look][5], base = (home.y + home.h) * T;
    v.door = door; v.base = base;
    if (folds(a)) { vill.set(a.id, v); continue; } // indoors; an Important one stays out on its doorstep
    // Builders on a live PR work its scaffold (up to 4 per site).
    const site = a.bucket === 'building' && (a.prs || []).map(p => prItem.get(`${home.village.name}#${p.id}`) || prItem.get(`${a.project}#${p.id}`)).find(it => it?.building);
    const n = site ? crews.get(site.id) || 0 : 0;
    // Its spots: either side of the front, then either side of the walls (the lot's side gaps).
    const sx = site && site.x * T, sb = site && (site.y + site.h) * T;
    const siteSpot = site && n < 4 && [[-14, 10, 3], [site.w * T - 2, 10, 2], [-14, -6, 3], [site.w * T - 2, -6, 2]].find(([dx, dy]) => free(sx + dx + 8, sb + dy) && ground(sx + dx + 8, sb + dy));
    if (siteSpot) {
      crews.set(site.id, n + 1);
      Object.assign(v, { x: sx + siteSpot[0] + 8, y: sb + siteSpot[1], dir: siteSpot[2], pose: 'hammer', site });
    } else if (own && !v.sub) {
      Object.assign(v, { x: door, y: base + 12, dir: 0, pose: a.bucket === 'waiting' ? 'sit' : a.bucket === 'building' ? 'hammer' : 'stand' });
      if (v.pose === 'hammer') Object.assign(v, { x: door - 4, dir: 3, block: [door + 5, base - 1] });
    } else {
      const k = yard.get(home.id) || 0;
      const spot = k < YARD_CAP && YARD.find(([sx, sy]) => free(v.door + sx, v.base + sy) && ground(v.door + sx, v.base + sy));
      if (!spot) { v.crowd = true; crowd.set(home.id, (crowd.get(home.id) || 0) + 1); vill.set(a.id, v); continue; }
      yard.set(home.id, k + 1);
      const [sx, sy] = spot;
      // A carrier shuttles a crate 6 px either side of its spot (see `place` in the renderer).
      if (a.bucket === 'building') Object.assign(v, { pose: 'carry', x0: door + sx - 3, x1: door + sx + 3, x: door + sx, y: base + sy });
      else Object.assign(v, { x: door + sx, y: base + sy, dir: 0, pose: a.bucket === 'waiting' ? 'sit' : 'stand' });
    }
    if (v.x != null && !v.crowd) taken.push([v.x, v.y]);
    vill.set(a.id, v);
  }
  return { vill, crowd };
}

// A stroller (chicken, cat) walks between hashed points inside `rect` (world px), then pauses, on a
// fixed 3.2 s leg. Pure in t. It faces the way it is walking (`right`), keeps facing that way while it
// pauses, and steps its walk cycle only while `moving`.
export function stroll(seed, rect, t) {
  const LEG = 3.2, u = t + rnd(seed) * LEG * 5, leg = Math.floor(u / LEG), s = u - leg * LEG;
  const pt = i => [rect.x + rnd(`${seed}:x${i}`) * rect.w, rect.y + rnd(`${seed}:y${i}`) * rect.h];
  const a = pt(leg), b = pt(leg + 1), dx = b[0] - a[0], dy = b[1] - a[1];
  const dur = Math.min(LEG - 1, Math.max(0.6, Math.hypot(dx, dy) / 14)), k = Math.min(1, s / dur);
  return { x: Math.round(a[0] + dx * k), y: Math.round(a[1] + dy * k), moving: s < dur && Math.abs(dx) + Math.abs(dy) > 1, right: dx >= 0 };
}

// ---------------- sheets ----------------
const FILES = { floor: 'tiles/TilesetFloor.png', nature: 'tiles/TilesetNature.png', house: 'tiles/TilesetHouse.png',
  element: 'tiles/TilesetElement.png', water: 'tiles/TilesetWater.png', towers: 'tiles/TilesetTowers.png', flag: 'anim/Flag.png',
  cat: 'animals/Cat.png', chicken: 'animals/Chicken.png', smoke: 'fx/Smoke.png', spark: 'fx/Spark.png', leaf: 'fx/Leaf.png',
  alert: 'ui/EmoteAlert.png', hammer: 'ui/Hammer.png', crate: 'ui/Crate.png' };
for (const a of ['Sultan2', ...LOOKS, ...NINJAS]) FILES[a] = `actors/${a}.png`;
export function loadSheets() {
  const IMG = {};
  return Promise.all(Object.entries(FILES).map(([k, f]) => new Promise((ok, no) => {
    const im = new Image();
    im.onload = () => { IMG[k] = im; ok(); };
    im.onerror = () => no(new Error(`Couldn't load ${f}`));
    im.src = BASE + f;
  }))).then(() => createRenderer(IMG));
}

const PATH = { TL: [4, 7], T: [5, 7], TR: [7, 7], L: [4, 8], C: [1, 8], R: [7, 8], BL: [4, 10], B: [5, 10], BR: [7, 10], iNW: [6, 9], iNE: [5, 9], iSW: [6, 8], iSE: [5, 8] };
// Streets use the floor sheet's darker packed-earth variant (the same autotile, 11 tiles right), so
// they read as a different road from the lanes inside a neighbourhood.
const STREET = Object.fromEntries(Object.entries(PATH).map(([k, [x, y]]) => [k, [x + 11, y]]));
const SEA = { TL: [4, 0], T: [5, 0], TR: [7, 0], L: [4, 1], C: [1, 1], R: [7, 1], BL: [4, 3], B: [5, 3], BR: [7, 3], iNW: [6, 2], iNE: [5, 2], iSW: [6, 1], iSE: [5, 1] };
const GRASS = [0, 0, 0, 0, 0, 0, 1, 2, 3, 4];
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function glyph(map, pal) {
  const c = canvas(map[0].length, map.length), g = c.getContext('2d');
  map.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
}
// Status badges: the loudest value tier. 17×17 + tail, 1px ink, 2px white ring, fill, glyph, shadow.
function badge(fill, map, color) {
  const N = 17, c = canvas(N + 2, N + 6), g = c.getContext('2d');
  const inset = y => (y === 0 || y === N - 1 ? 3 : y === 1 || y === N - 2 ? 1 : 0);
  const shape = (pad, col, dx = 0, dy = 0) => {
    g.fillStyle = col;
    for (let y = pad; y < N - pad; y++) { const i = Math.max(inset(y), pad + (y === pad || y === N - 1 - pad ? 1 : 0)); g.fillRect(dx + i, dy + y, N - 2 * i, 1); }
    for (let t = 0; t < 5 - pad; t++) { const w = 7 - 2 * t - 2 * pad; if (w > 0) g.fillRect(dx + 5 + t + pad, dy + N - 1 + t, w, 1); }
  };
  shape(0, 'rgba(10, 6, 16, 0.5)', 2, 2); shape(0, '#140f1c'); shape(1, '#ffffff'); shape(2, '#ffffff'); shape(3, fill);
  map.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') { g.fillStyle = color; g.fillRect(5 + x, 4 + y, 1, 1); } }));
  return c;
}

function createRenderer(IMG) {
  const TONED = {};
  const tone = (k, f) => { const im = IMG[k], c = canvas(im.width, im.height), g = c.getContext('2d'); g.filter = f; g.drawImage(im, 0, 0); TONED[k] = c; };
  tone('nature', 'hue-rotate(10deg) saturate(1.15) contrast(0.85) brightness(0.84)');
  tone('towers', 'saturate(0.95) contrast(1.06) brightness(0.92)');
  tone('house', 'saturate(0.95) contrast(1.06) brightness(0.92)');
  tone('element', 'saturate(0.85) contrast(1.04) brightness(0.92)');
  const blit = (g, r, x, y) => { const [sh, sx, sy, w, h] = R[r]; g.drawImage(TONED[sh] || IMG[sh], sx, sy, w, h, x, y, w, h); };
  const BADGE = {
    need: badge('#f5a623', ['...##..', '...##..', '...##..', '...##..', '...##..', '.......', '...##..', '...##..'], '#140f1c'),
    error: badge('#e5383b', ['.......', '##...##', '.##.##.', '..###..', '.##.##.', '##...##'], '#ffffff'),
    // A mouse cursor: the session is sitting in a dialog (permission, options, plan) waiting for a click.
    click: badge('#9b5de5', ['#......', '##.....', '###....', '####...', '#####..', '######.', '###....', '#.##...', '...##..'], '#ffffff'),
    // A hammer that taps down with the villager's own swing.
    build: [0, 1].map(f => badge('#2f9e5b', [...(f ? ['.......'] : []), '######.', '#######', '######.', '..##...', '..##...', '..##...', ...(f ? [] : ['..##...'])], '#ffffff')),
    wait: [0, 1].map(f => badge('#3d7be0', f ? ['#######', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#####.', '#######'] : ['#######', '.#####.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#######'], '#ffffff')),
  };
  const crown = glyph(['.o.o.o.o.', 'oyoyoyoyo', 'oyyyyyyyo', 'oyRyyyRyo', 'ooooooooo'], { o: '#140f1c', y: '#ffd23f', R: '#e8504a' });
  const zGlyph = glyph(['oooooo', 'owwwwo', 'oooowo', 'oowooo', 'owwwwo', 'oooooo'], { o: '#140f1c', w: '#f4efe4' });
  const star = glyph(['...o...', '..oyo..', 'ooyyyoo', '.oyyyo.', 'oyo.oyo', 'oo...oo'], { o: '#140f1c', y: '#ffd23f' });
  const marker = glyph(['ooooooo', 'oyyyyyo', '.oyyyo.', '..oyo..', '...o...'], { o: '#140f1c', y: '#eaf2ff' });
  const flags = new Map();
  const flagSheet = team => {
    if (flags.has(team)) return flags.get(team);
    const c = canvas(64, 16), g = c.getContext('2d');
    g.drawImage(IMG.flag, 0, 0); g.globalCompositeOperation = 'multiply'; g.fillStyle = team; g.fillRect(0, 0, 64, 16);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(IMG.flag, 0, 0);
    const out = canvas(64, 16), o = out.getContext('2d'); o.filter = 'brightness(1.45) saturate(1.25)'; o.drawImage(c, 0, 0);
    flags.set(team, out); return out;
  };
  const dock = createDockArt({ drawLamp, flagSheet });
  // A sprite dyed an accent (multiply, alpha kept, lifted back up), cached.
  const dyes = new Map();
  const dyed = (r, accent) => {
    const k = `${r}|${accent}`;
    if (dyes.has(k)) return dyes.get(k);
    const [sh, sx, sy, w, h] = R[r], c = canvas(w, h), g = c.getContext('2d');
    g.drawImage(IMG[sh], sx, sy, w, h, 0, 0, w, h); g.globalCompositeOperation = 'multiply'; g.fillStyle = accent; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(IMG[sh], sx, sy, w, h, 0, 0, w, h);
    const out = canvas(w, h), o = out.getContext('2d'); o.filter = 'brightness(1.3) saturate(1.1)'; o.drawImage(c, 0, 0);
    dyes.set(k, out); return out;
  };
  // Agents: sprite + 1px ink outline + 2px light rim (a "sticker"), cached per frame. A white
  // outline variant marks the selected agent / keyboard cursor.
  const rims = new Map();
  function rimmed(look, dir, row, crop, sel) {
    const k = `${look}|${dir}|${row}|${crop}|${sel}`;
    if (rims.has(k)) return rims.get(k);
    const sil = (color, pad) => {
      const c = canvas(16 + pad * 2, crop + pad * 2), g = c.getContext('2d');
      for (let dy = -pad; dy <= pad; dy++) for (let dx = -pad; dx <= pad; dx++) if (Math.abs(dx) + Math.abs(dy) <= pad + (pad > 1 ? 1 : 0)) g.drawImage(IMG[look], dir * 16, row * 16, 16, crop, pad + dx, pad + dy, 16, crop);
      g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height); return c;
    };
    const out = canvas(20, crop + 4), g = out.getContext('2d');
    if (sel) g.drawImage(sil('#ffffff', 2), 0, 0); else { g.globalAlpha = 0.55; g.drawImage(sil('#fff4dc', 2), 0, 0); g.globalAlpha = 1; }
    g.drawImage(sil('#140f1c', 1), 1, 1);
    g.drawImage(IMG[look], dir * 16, row * 16, 16, crop, 2, 2, 16, crop);
    rims.set(k, out);
    return out;
  }


  // ---------- ground: terrain, shore, sea, baked shadows and wild nature (one canvas per layout) ----------
  // The ground (grass, roads, shore, sea, baked shadows and wild props) is baked lazily in chunks of
  // C×C tiles: no single canvas outgrows browser limits on a big world, and open sea is never baked.
  const C = 48;
  let chunks = new Map(), Wcur = null;
  function prepare(W) {
    Wcur = W;
    chunks = new Map();
    W.wild = W.props.filter(p => p.wild).sort((a, b) => a.base - b.base);
    W.liveProps = W.props.filter(p => !p.wild);
    W.trees = W.props.filter(p => p.tree);
    W.lights = W.props.filter(p => p.light);
    // Each upright prop's iso offset (it stands on the middle of its bottom edge), and the wild ones in
    // iso draw order (by where their feet land on screen).
    for (const p of W.props) p.io = pointOffset(p.x + R[p.r][3] / 2, p.base);
    // Wild trees and bushes that could overlap a building on screen join the iso depth sort; the rest
    // are drawn first, in order of where their feet land.
    const rects = W.items.filter(it => it.kind === 'home' || it.kind === 'pr').map(it => { const [ox, oy] = isoP(it.x * T, it.y * T), e = isoExtent(it, T); return [ox + e[0], oy + e[1], ox + e[2], oy + e[3]]; });
    for (const p of W.wild) {
      const x = p.x + p.io[0], y = p.y + p.io[1], w = R[p.r][3], h = R[p.r][4];
      p.nearBuilding = rects.some(r => x < r[2] && x + w > r[0] && y < r[3] && y + h > r[1]);
    }
    W.wildIso = W.wild.filter(p => !p.nearBuilding).sort((a, b) => a.base + a.io[1] - b.base - b.io[1]);
    W.wildNear = W.wild.filter(p => p.nearBuilding);
  }
  // The ground is baked without anything that stands up (wild trees are drawn upright).
  function chunkAt(cx, cy) {
    const id = `${cx},${cy}`;
    if (!chunks.has(id)) chunks.set(id, bake(Wcur, cx * C, cy * C));
    return chunks.get(id);
  }
  function bake(W, x0, y0) {
    let shore = false;
    for (let y = y0; y < y0 + C && !shore; y++) for (let x = x0; x < x0 + C; x++) if ((W.seaDist.get(key(x, y)) ?? 99) < 5) { shore = true; break; }
    if (!shore) return null; // open sea: the frame's SEA_DEEP fill is the ground
    const S = C * T, ox = x0 * T, oy = y0 * T;
    const hit = (x, y, w, h) => x + w > ox && x < ox + S && y + h > oy && y < oy + S;
    const raw = canvas(S, S), g = raw.getContext('2d');
    const quad = (img, [cx, cy], qx, qy, dx, dy) => g.drawImage(img, cx * T + qx * 8, cy * T + qy * 8, 8, 8, dx + qx * 8, dy + qy * 8, 8, 8);
    const autotile = (img, has, x, y, M, dx, dy) => {
      for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const vy = qy ? 1 : -1, hx = qx ? 1 : -1, v = has(x, y + vy), h = has(x + hx, y), d = has(x + hx, y + vy);
        const t = !v && !h ? M[(qy ? 'B' : 'T') + (qx ? 'R' : 'L')] : !v ? M[qy ? 'B' : 'T'] : !h ? M[qx ? 'R' : 'L'] : !d ? M[`i${qy ? 'S' : 'N'}${qx ? 'E' : 'W'}`] : M.C;
        quad(img, t, qx, qy, dx, dy);
      }
    };
    const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (let y = y0; y < y0 + C; y++) for (let x = x0; x < x0 + C; x++) {
      const dx = (x - x0) * T, dy = (y - y0) * T, k = key(x, y);
      if (W.land.has(k)) {
        g.drawImage(IMG.floor, GRASS[hash(k) % GRASS.length] * T, 12 * T, T, T, dx, dy, T, T);
        if (!W.path.has(k) && N8.some(([a, b]) => !W.land.has(key(x + a, y + b)))) g.drawImage(IMG.water, 0, 80, T, T, dx, dy, T, T);
        if (W.street.has(k)) autotile(IMG.floor, (a, b) => W.street.has(key(a, b)), x, y, STREET, dx, dy);
        else if (W.path.has(k)) autotile(IMG.floor, (a, b) => W.path.has(key(a, b)) && W.land.has(key(a, b)), x, y, PATH, dx, dy);
      } else {
        g.drawImage(IMG.water, T, T, T, T, dx, dy, T, T);
        if (N8.some(([a, b]) => W.land.has(key(x + a, y + b)))) autotile(IMG.water, (a, b) => !W.land.has(key(a, b)), x, y, SEA, dx, dy);
      }
    }
    g.fillStyle = 'rgba(20, 16, 30, 0.32)';
    for (const p of W.trees) { const w = R[p.r][3]; if (!hit(p.x, p.base - 10, w, 14)) continue; g.beginPath(); g.ellipse(p.x + w / 2 - ox, p.base - 3 - oy, w * 0.42, 5, 0, 0, 7); g.fill(); }
    const out = canvas(S, S), o = out.getContext('2d');
    o.filter = 'hue-rotate(14deg) saturate(1.25) contrast(0.68) brightness(0.82)'; o.drawImage(raw, 0, 0);
    o.filter = 'contrast(0.75) brightness(0.9)';
    for (const [r, x, y] of W.groundDecor) if (hit(x, y, R[r][3], R[r][4])) blit(o, r, x - ox, y - oy);
    o.filter = 'none';
    // Each neighbourhood's ground takes its accent: a soft wash with a faint paving check, so a
    // district reads as one place at every zoom (tier 0: it must stay quieter than the buildings).
    for (const v of W.villages) {
      const b = v.block;
      if (!hit(b.x * T, b.y * T, b.w * T, b.h * T)) continue;
      o.globalCompositeOperation = 'soft-light'; o.fillStyle = v.accent;
      for (let j = b.y; j < b.y + b.h; j++) for (let i = b.x; i < b.x + b.w; i++) {
        o.globalAlpha = (i + j) % 2 ? 0.2 : 0.28;
        o.fillRect(i * T - ox, j * T - oy, T, T);
      }
    }
    o.globalCompositeOperation = 'source-over'; o.globalAlpha = 1;
    { // a district's edge is a faint kerb line, and each building casts a soft shadow east
      o.strokeStyle = 'rgba(20, 16, 30, 0.22)'; o.lineWidth = 2;
      for (const v of W.villages) { const b = v.block; if (hit(b.x * T - 4, b.y * T - 4, b.w * T + 8, b.h * T + 8)) o.strokeRect(b.x * T - ox + 1.5, b.y * T - oy + 1.5, b.w * T - 3, b.h * T - 3); }
      for (const it of W.items) {
        if ((it.kind !== 'home' && it.kind !== 'pr') || !hit(it.x * T, it.y * T, it.w * T, it.h * T)) continue;
        o.fillStyle = 'rgba(20, 16, 30, 0.3)'; o.fillRect(it.x * T - ox + 4, it.y * T - oy - 4, it.w * T + 8, it.h * T + 6); // its shadow, cast east
      }
    }
    for (let y = y0; y < y0 + C; y++) for (let x = x0; x < x0 + C; x++) {
      if (W.land.has(key(x, y))) continue;
      const d = (W.seaDist.get(key(x, y)) ?? 30) + noise(x, y, 3) * 1.8;
      if (d < 3.2) continue;
      o.fillStyle = d < 5.5 ? SEA_MID : SEA_DEEP; o.fillRect((x - x0) * T, (y - y0) * T, T, T);
    }
    return out;
  }

  // ---------- frame ----------
  let smoke = [], leaves = [], lastT = 0, veil = null, walkers = [], flagsDrawn = [], lastView = null, drawOrder = [];
  // f: { ctx, k (world→canvas scale), vx, vy, bw, bh (the view, in view px), zoom, t, night, still,
  //      agents (vill Map), selected, cursor }. View px are projected px (isoP); everything returned
  //      (hits, badges) is in view px.
  function draw(f) {
    const { ctx, k, vx, vy, bw, bh, zoom, t, still } = f, W = Wcur, f8 = Math.floor(t * 8);
    walkers = []; flagsDrawn = []; lastView = f;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SEA_DEEP; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // The ground: world px turned into iso diamonds by the transform.
    const cs = [isoInv(vx, vy), isoInv(vx + bw, vy), isoInv(vx, vy + bh), isoInv(vx + bw, vy + bh)];
    const gx0 = Math.min(...cs.map(c => c[0])), gx1 = Math.max(...cs.map(c => c[0])), gy0 = Math.min(...cs.map(c => c[1])), gy1 = Math.max(...cs.map(c => c[1]));
    ctx.setTransform(k * ISO, k * ISO / 2, -k * ISO, k * ISO / 2, -vx * k, -vy * k);
    ctx.imageSmoothingEnabled = true; // a turned, shrunk tile is cleaner smoothed; the sprites stay crisp
    const [bx0, by0, bx1, by1] = W.bounds, CT = C * T;
    for (let cy = Math.floor(Math.max(gy0 / T, by0) / C); cy * C < Math.min(gy1 / T, by1); cy++)
      for (let cx = Math.floor(Math.max(gx0 / T, bx0) / C); cx * C < Math.min(gx1 / T, bx1); cx++) { const g = chunkAt(cx, cy); if (g) ctx.drawImage(g, cx * CT, cy * CT); }
    const onGround = (x, y, w, h) => x + w > gx0 && x < gx1 && y + h > gy0 && y < gy1;
    ctx.fillStyle = '#e9fbff';
    for (const [x, y] of W.waves) { if (!onGround(x * T, y * T, T, T)) continue; const h = hash(key(x, y)), o = still ? 4 : Math.floor(t * 3 + h % 16) % 16; ctx.fillRect(x * T + o, y * T + 6 + (h >> 4) % 6, 4, 1); }
    // Everything upright, in view px.
    ctx.setTransform(k, 0, 0, k, -vx * k, -vy * k);
    ctx.imageSmoothingEnabled = false;
    const inView = (x, y, w, h) => x + w > vx && x < vx + bw && y + h > vy && y < vy + bh;
    dock.frame(f, W); // the pier lies on the water like ground; its ships, porters and sheds join the sort
    dock.drawGround(ctx);
    for (const p of W.wildIso) { const x = p.x + p.io[0], y = p.y + p.io[1]; if (inView(x, y, R[p.r][3], R[p.r][4])) blit(ctx, p.r, x, y); }
    const list = [];
    // Every drawable gets its ground footprint (fx0, fy0, fx1, fy1: world px; a point for anything
    // upright) and screen rect (sx0, sy0, sx1, sy1: view px) for isoSort.
    const pt = (d, fx, fy, sx0, sy0, sx1, sy1) => Object.assign(d, { fx0: fx, fx1: fx, fy0: fy, fy1: fy, sx0, sy0, sx1, sy1 });
    for (const p of W.wildNear) {
      const x = p.x + p.io[0], y = p.y + p.io[1], w = R[p.r][3], h = R[p.r][4];
      if (inView(x, y, w, h)) list.push(pt({ r: p.r, x, y }, p.x + w / 2, p.base, x, y, x + w, y + h));
    }
    for (const p of W.liveProps) {
      const [ox, oy] = p.io, w = R[p.r][3], h = R[p.r][4];
      if (!inView(p.x + ox, p.y + oy, 64, 64)) continue;
      if (p.light) list.push(pt({ lamp: 1, x: p.x + 8 + ox, y: p.base + oy }, p.x + w / 2, p.base, p.x + 8 + ox - 3, p.base + oy - 24, p.x + 8 + ox + 3, p.base + oy)); // a slim post: the lantern sprite reads as a birdhouse at this angle
      else list.push(pt(p.banner ? { ...p, x: p.x + ox, y: p.y + oy, base: p.base + oy } : { r: p.r, x: p.x + ox, y: p.y + oy }, p.x + w / 2, p.base, p.x + ox, p.y + oy - 4, p.x + ox + w, p.base + oy));
    }
    const restingIn = new Map();
    for (const v of f.agents.values()) if (folds(v.a) && v.own) restingIn.set(v.home.id, (restingIn.get(v.home.id) || 0) + 1);
    for (const it of W.items) {
      if (it.kind !== 'home' && it.kind !== 'pr') continue;
      it.px = null; it.iso = null; // set when drawn (night lights, smoke and the zZ use them)
      // Windows glow while its agent is in, and in every home after dark.
      const b = isoItem(it, !!restingIn.get(it.id) || (f.night > 0.5 && it.kind === 'home'));
      if (!inView(b.x, b.y, b.img.width, b.img.height)) continue;
      const [bx, by, bw2, bh2] = b.box;
      list.push({ it, b, fx0: it.x * T, fy0: it.y * T, fx1: (it.x + it.w) * T, fy1: (it.y + it.h) * T, sx0: b.ox + bx, sy0: b.oy + by, sx1: b.ox + bx + bw2, sy1: b.oy + by + bh2 });
    }
    const vills = [];
    for (const v of f.agents.values()) {
      const hidden = folds(v.a) || v.crowd;
      const ghost = hidden && v.a.id === f.selected;
      if (hidden && !ghost) continue;
      const d = place(v, ghost, still || v.a.id === f.selected, t);
      d.wx = d.left + 8; d.wy = d.feet; // its feet on the ground, world px
      const [ox, oy] = agentOffset(v);
      d.left += ox; d.feet += oy; d.top += oy;
      if (!inView(d.left - 30, d.feet - 60, 80, 70)) continue;
      // The depth sort decides: a house nearer the viewer hides whoever stands behind it (they show
      // through it as a silhouette).
      vills.push(d);
      list.push(pt({ vd: d }, d.wx, d.wy, d.left - 2, d.feet - 32, d.left + 18, d.feet + 3));
      if (v.pose === 'carry') walkers.push({ id: v.a.id, kind: 'carry', x: d.left, y: d.feet, facing: d.dir === 3 ? 'R' : d.dir === 2 ? 'L' : 'D', moving: d.moving, t });
      if (v.block && !ghost) list.push(pt({ r: 'block', x: v.block[0] + ox, y: v.block[1] + oy }, d.wx + 9, d.wy + 0.5, v.block[0] + ox, v.block[1] + oy, v.block[0] + ox + 16, v.block[1] + oy + 16));
    }
    // Strollers: a chicken in each neighbourhood square, a cat on the town square.
    const strollers = W.villages.map(v => ['chicken', `chicken:${v.name}`, { x: v.plaza.x * T, y: (v.plaza.y + 0.4) * T, w: (v.plaza.w - 1) * T, h: (v.plaza.h - 1) * T }]);
    strollers.push(['cat', 'cat', { x: (SQUARE.x + 0.5) * T, y: (SQUARE.y + SQUARE.h - 2) * T, w: (SQUARE.w - 2) * T, h: T }]);
    for (const [an, id, rect] of strollers) {
      const s = stroll(id, rect, t), [ox, oy] = pointOffset(s.x + 8, s.y + 14), x = s.x + ox, y = s.y + oy;
      if (!inView(x, y, 16, 16)) continue;
      // Both sheets face right; a stroller heading left is mirrored. The walk cycle only steps while it moves.
      const fr = !still && s.moving ? Math.floor(t * 6) % 2 : 0;
      list.push(pt({ an, x, y, flip: !s.right, fr }, s.x + 8, s.y + 14, x, y, x + 16, y + 16));
      walkers.push({ id, kind: an, x, y, facing: s.right ? 'R' : 'L', moving: s.moving && !still, t });
    }
    for (const d of dock.parts) list.push(d);
    walkers.push(...dock.walking); // the dock's walkers (dock-walk.js) face where they walk too
    const order = isoSort(list);
    drawOrder = order;
    const pops = [], hits = [], badges = [], resting = new Map();
    for (const v of f.agents.values()) if (folds(v.a) && v.own) resting.set(v.home.id, (resting.get(v.home.id) || 0) + 1);
    for (const d of order) {
      if (d.vd) drawVill(ctx, d.vd, t, f8, f, pops, badges);
      else if (d.dk) dock.draw(ctx, d, f);
      else if (d.b) { drawIsoItem(ctx, d.it, d.b, t, f, still); if (d.occludes) for (const o of d.occludes) drawHidden(ctx, o.vd, d.b, f); }
      else if (d.an) { if (d.flip) { ctx.save(); ctx.translate(d.x + 16, d.y); ctx.scale(-1, 1); ctx.drawImage(IMG[d.an], d.fr * 16, 0, 16, 16, 0, 0, 16, 16); ctx.restore(); } else ctx.drawImage(IMG[d.an], d.fr * 16, 0, 16, 16, d.x, d.y, 16, 16); }
      else if (d.banner) drawBanner(ctx, d);
      else if (d.lamp) drawLamp(ctx, d.x, d.y, f.night);
      else blit(ctx, d.r, d.x, d.y);
    }
    if (!still && zoom >= 1) {
      stepFx(t, W, f, resting);
      for (const p of smoke) { ctx.globalAlpha = p.a; ctx.drawImage(IMG.smoke, p.f * 32, 0, 32, 32, Math.round(p.x - 16), Math.round(p.y - 16), 32, 32); }
      ctx.globalAlpha = 1;
      for (const l of leaves) ctx.drawImage(IMG.leaf, (Math.floor(t * 6 + l.s) % 6) * 12, 0, 12, 7, Math.round(l.x), Math.round(l.y), 12, 7);
    } else { smoke = []; leaves = []; }
    if (f.night > 0) drawNight(ctx, f, vills, resting);
    for (const [x, y, k, d] of pops) if (!d.covered) ctx.drawImage(k === 'star' ? star : crown, x, y); // a crown behind a roof stays hidden
    if (f.night > 0.5) for (const it of W.items) {
      if (!resting.get(it.id) || it.px == null) continue;
      ctx.drawImage(zGlyph, it.iso.ox + it.iso.ridge[0] + 6, it.iso.oy + it.iso.ridge[1] - 4);
    }
    for (const d of vills) {
      if (d.v.a.id === f.selected) ctx.drawImage(marker, d.left + 4, d.top - 9 - (still ? 0 : Math.floor(t * 3) % 2));
      hits.push({ id: d.v.a.id, x: d.left - 1, y: d.top, w: 18, h: d.feet - d.top + 1, cx: d.left + 8, top: d.top, badge: d.badge, wx: d.wx, wy: d.wy });
    }
    // Badges (tier 3) in screen space at their own integer scale (at Map, village plates are DOM labels).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (zoom >= 1) {
      const bs = Math.max(2, zoom) / zoom; // canvas px per badge px: badges are max(2, zoom)× on screen
      for (const [wx, wy, img] of badges) ctx.drawImage(img, Math.round((wx - vx) * k - img.width * bs / 2), Math.round((wy - vy) * k - img.height * bs), img.width * bs, img.height * bs);
    }
    return hits;
  }
  // Map zoom: one cluster per village under its sign: a plate with a badge + count per state.
  function place(v, ghost, frozen, t) {
    const d = { v, ghost, left: Math.round(v.x - 8), feet: v.y, dir: v.dir || 0, row: 0, bob: 0 };
    if (ghost) { d.left = v.door - 8; d.feet = v.base + 12; d.dir = 0; d.top = d.feet - 18; return d; }
    if (v.pose === 'carry') {
      // Walk x0 → x1 facing right (column 3), set the crate down a moment, walk back facing left
      // (column 2). The walk rows (0–3) step only while walking; a pause or a frozen frame stands on row 0.
      const span = v.x1 - v.x0, walk = span / 8, leg = walk + 0.7, u = (t + v.phase * leg * 2) % (leg * 2);
      const back = u >= leg, s = back ? u - leg : u, k = Math.min(1, s / walk);
      d.moving = !frozen && s < walk;
      d.left = Math.round((frozen ? (v.x0 + v.x1) / 2 : back ? v.x1 - span * k : v.x0 + span * k) - 8);
      d.dir = back ? 2 : 3;
      d.row = d.moving ? Math.floor(t * 8) % 4 : 0;
    } else if (v.pose === 'hammer') d.row = !frozen && Math.floor(t * 4 + v.phase * 4) % 2 ? 4 : 0;
    if (v.a.bucket === 'stalled' && !frozen && (t + v.phase) % 1.2 < 0.15) d.bob = 1;
    d.top = d.feet - 18 - (v.a.role === 'boss' ? 4 : 0);
    return d;
  }
  function drawVill(ctx, d, t, f8, f, pops, badges) {
    const v = d.v, a = v.a, sel = a.id === f.selected || a.id === f.cursor;
    let y = d.feet - 16 - d.bob, crop = 16;
    if (d.ghost) ctx.globalAlpha = 0.5;
    else if (stoppedNote(a)) ctx.globalAlpha = 0.7; // an Important agent that isn't running: faded, not gone
    if (v.pose === 'sit' && !d.ghost) { blit(ctx, 'log', d.left, d.feet - 13); crop = 13; y = d.feet - 22; }
    else { ctx.fillStyle = 'rgba(16, 10, 24, 0.5)'; ctx.beginPath(); ctx.ellipse(d.left + 8, d.feet - 1, 7, 3, 0, 0, 7); ctx.fill(); }
    ctx.drawImage(rimmed(v.look, d.dir, d.row, crop, sel), d.left - 2, y - 2);
    d.sy = y; d.crop = crop; d.sel = sel;
    ctx.globalAlpha = 1;
    if (d.ghost) return;
    const still = f.still || a.id === f.selected;
    if (v.pose === 'hammer') { const down = d.row === 4; ctx.drawImage(IMG.hammer, d.left + (down ? 14 : 10), y + (down ? 7 : -3)); if (down) ctx.drawImage(IMG.spark, (f8 % 5) * 14, 0, 14, 8, d.left + 16, y + 6, 14, 8); }
    if (v.pose === 'carry') ctx.drawImage(IMG.crate, 0, 0, 16, 15, d.left + 2, y - 9 + (still ? 0 : f8 % 2), 12, 11);
    if (a.role === 'boss') pops.push([d.left + 3, y - 4, 'crown', d]);
    else if (a.important) pops.push([d.left + 5, y - 6, 'star', d]); // Important (Restore after crash)
    const up = a.role === 'boss' ? 6 : 0;
    const img = a.bucket === 'stalled' ? BADGE[a.severity === 'error' ? 'error' : a.prompt ? 'click' : 'need'] : a.bucket === 'waiting' ? BADGE.wait[still ? 0 : Math.floor((t + v.phase * 3) / 3) % 2]
      : a.bucket === 'building' ? BADGE.build[d.row === 4 ? 1 : 0] : null;
    if (img && (f.bubbles !== false || a.id === f.hover || a.id === f.selected || a.id === f.cursor)) {
      const bob = a.bucket === 'stalled' && !still ? Math.round(Math.sin((t + v.phase) * 4) * 0.8 + 0.8) : 0;
      const wy = y - 2 - up - bob;
      badges.push([d.left + 8, wy, img]);
      const s = Math.max(2, f.zoom) / f.zoom; // world px per badge px
      d.top = wy + bob - Math.round(img.height * s); // the badge's resting top, in world px (tags anchor here)
      d.badge = [d.left + 8 - img.width * s / 2, wy - img.height * s, d.left + 8 + img.width * s / 2, wy];
    }
  }

  // A villager hidden behind a building shows through it as a soft silhouette (a light rim round its
  // faded colours), only where the building covers it: so you can still see, and click, who is back there.
  const ghosts = new Map(), alphas = new WeakMap(), mask = canvas(24, 24), mg = mask.getContext('2d');
  function ghost(look, dir, row, crop, sel) {
    const k = `${look}|${dir}|${row}|${crop}|${sel}`;
    if (ghosts.has(k)) return ghosts.get(k);
    const shape = (color, pad) => {
      const c = canvas(16 + pad * 2, crop + pad * 2), g = c.getContext('2d');
      for (let dy = -pad; dy <= pad; dy++) for (let dx = -pad; dx <= pad; dx++) if (Math.abs(dx) + Math.abs(dy) <= pad) g.drawImage(IMG[look], dir * 16, row * 16, 16, crop, pad + dx, pad + dy, 16, crop);
      g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height); return c;
    };
    const out = canvas(20, crop + 4), g = out.getContext('2d');
    g.drawImage(shape(sel ? '#ffffff' : '#fff1d6', 1), 1, 1);
    g.drawImage(shape('#3a3150', 0), 2, 2);
    g.globalAlpha = 0.6; g.drawImage(IMG[look], dir * 16, row * 16, 16, crop, 2, 2, 16, crop); // its colours, faded
    ghosts.set(k, out);
    return out;
  }
  function drawHidden(ctx, d, b, f) {
    if (d.ghost || d.sy == null) return;
    const img = ghost(d.v.look, d.dir, d.row, d.crop, d.sel), x = d.left - 2, y = d.sy - 2, w = img.width, h = img.height;
    if (mask.width < w || mask.height < h) { mask.width = Math.max(mask.width, w); mask.height = Math.max(mask.height, h); }
    mg.globalCompositeOperation = 'source-over'; mg.clearRect(0, 0, mask.width, mask.height);
    mg.drawImage(img, 0, 0);
    mg.globalCompositeOperation = 'destination-in'; mg.drawImage(b.img, b.x - x, b.y - y);
    ctx.globalAlpha = d.sel || d.v.a.id === f.cursor ? 0.9 : 0.62;
    ctx.drawImage(mask, 0, 0, w, h, x, y, w, h);
    ctx.globalAlpha = 1;
    d.covered = true;
    // Hidden when the building covers its head (its crown, if any, stays hidden with it).
    if (!alphas.has(b.img)) alphas.set(b.img, b.img.getContext('2d').getImageData(0, 0, b.img.width, b.img.height).data);
    const al = alphas.get(b.img), hx = Math.floor(d.left + 8 - b.x), hy = Math.floor(d.sy + 3 - b.y);
    if (hx >= 0 && hy >= 0 && hx < b.img.width && hy < b.img.height && al[(hy * b.img.width + hx) * 4 + 3]) d.hidden = true;
  }

  function drawIsoItem(ctx, it, b, t, f, still) {
    ctx.drawImage(b.img, b.x, b.y);
    it.px = b.x; it.py = b.y; it.iso = b;
    if (it.kind === 'home') { // the neighbourhood's flag on the ridge
      const fr = still ? 0 : (Math.floor(t * 4) + hash(it.id)) % 4, fx = b.ox + b.ridge[0] - 2, fy = b.oy + b.ridge[1] - 15;
      ctx.drawImage(flagSheet(it.village.accent), fr * 16, 0, 16, 16, fx, fy, 16, 16);
      flagsDrawn.push({ id: it.id, x: fx, y: fy, frame: fr, accent: it.village.accent });
    }
    if (it.kind === 'pr' && it.building) blit(ctx, 'crate', b.ox + b.box[0] + b.box[2] - 18, b.oy + b.box[1] + b.box[3] - 20);
    if (f.selectedHome === it.id) { ctx.strokeStyle = '#eaf2ff'; ctx.lineWidth = 1; ctx.strokeRect(b.ox + b.box[0] + 0.5, b.oy + b.box[1] + 0.5, b.box[2], b.box[3]); }
  }
  // An iso street lamp: an inked post on a stone foot with a lantern head (lit at night).
  function drawLamp(ctx, x, y, night) {
    const ink = '#140f1c';
    ctx.fillStyle = ink; ctx.fillRect(x - 3, y - 3, 6, 3); ctx.fillRect(x - 2, y - 17, 4, 15); ctx.fillRect(x - 3, y - 22, 6, 6);
    ctx.fillStyle = '#8f8a86'; ctx.fillRect(x - 2, y - 2, 4, 1);
    ctx.fillStyle = '#5b3a24'; ctx.fillRect(x - 1, y - 16, 2, 14);
    ctx.fillStyle = night > 0.35 ? '#ffd27a' : '#e8c27a'; ctx.fillRect(x - 2, y - 21, 4, 4);
    ctx.fillStyle = '#3a2a22'; ctx.fillRect(x - 3, y - 23, 6, 1);
  }
  // A neighbourhood's banner: a post with the pack's cream banner dyed its accent (like the flags).
  function drawBanner(ctx, d) {
    const ink = '#140f1c', x = d.x, top = d.y;
    ctx.fillStyle = ink; ctx.fillRect(x + 6, top - 4, 4, d.base - top + 4); ctx.fillRect(x + 1, top - 4, 14, 3);
    ctx.fillStyle = '#9a6233'; ctx.fillRect(x + 7, top - 3, 2, d.base - top + 2); ctx.fillStyle = '#c98a4a'; ctx.fillRect(x + 2, top - 3, 12, 1);
    ctx.drawImage(dyed('banner', d.banner), x, top - 2);
  }
  function stepFx(t, W, f, resting) {
    const dt = Math.min(0.5, Math.max(0, t - lastT)); lastT = t;
    // Smoke rises from the chimney (or the ridge of a house without one).
    const flue = it => { const b = it.iso, p = b.chimney || b.ridge; return [b.ox + p[0], b.oy + p[1] - 4]; };
    for (const v of f.agents.values()) if (v.own && v.pose === 'hammer' && v.home.px != null && Math.random() < dt * 0.9) {
      const [x, y] = flue(v.home); smoke.push({ x, y, born: t, a: 0.8, f: 0 });
    }
    for (const it of W.items) {
      if (it.px == null) continue;
      if (it.kind === 'pr' && it.building && Math.random() < dt * 0.25) {
        const [bx, by, bw, bh] = it.iso.box; smoke.push({ x: it.iso.ox + bx + Math.random() * bw, y: it.iso.oy + by + bh * 0.7, born: t, a: 0.5, f: 0 });
      } else if (it.iso?.chimney && resting.get(it.id) && Math.random() < dt * 0.12) { const [x, y] = flue(it); smoke.push({ x, y, born: t, a: 0.45, f: 0 }); } // someone's home: the fire is lit
    }
    smoke = smoke.filter(p => { const age = t - p.born; p.y -= dt * 10; p.x += dt * 4; p.f = Math.min(2, Math.floor(age / 1.2)); p.a = Math.max(0, 0.75 - age * 0.2); return age < 3.6 && age >= 0; });
    const shown = smoke.filter(p => p.x > f.vx - 32 && p.x < f.vx + f.bw + 32 && p.y > f.vy - 32 && p.y < f.vy + f.bh + 32);
    if (shown.length > 6) { const drop = new Set(shown.slice(0, shown.length - 6)); smoke = smoke.filter(p => !drop.has(p)); } // at most 6 puffs on screen
    if (W.trees.length && Math.random() < dt * 0.8) { const p = W.trees[Math.floor(Math.random() * W.trees.length)]; const [ox, oy] = p.io; leaves.push({ x: p.x + 8 + ox + Math.random() * 16, y: p.y + 10 + oy, y1: p.base + 4 + oy, s: Math.random() * 6 }); }
    leaves = leaves.filter(l => { l.y += dt * 12; l.x += Math.sin(t * 2 + l.s) * dt * 10; return l.y < l.y1; });
  }
  function drawNight(ctx, f, vills, resting) {
    const { vx, vy, bw, bh, still, t } = f, W = Wcur, w = Math.ceil(bw), h = Math.ceil(bh);
    if (!veil || veil.width !== w || veil.height !== h) veil = canvas(w, h);
    const g = veil.getContext('2d');
    g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, w, h);
    g.fillStyle = `rgba(14, 18, 50, ${0.6 * f.night})`; g.fillRect(0, 0, w, h);
    // Light pools, in view px: [x, y, radius, warm glow?]. Every lamp; every home's windows (brighter when
    // its agent is in for the night); a work lamp on each building site; each square; each villager.
    const pools = [], P = isoP;
    for (const p of W.lights) { const [ox, oy] = p.io; pools.push([p.x + 8 + ox, p.base + oy - 19, 48, 1]); }
    for (const it of W.items) {
      if (it.px == null) continue;
      const lit = resting.get(it.id), b = it.iso;
      if (it.kind === 'pr' && it.building) pools.push([b.ox + b.ridge[0], b.oy + b.ridge[1] + 20, 40, 1]);
      for (const [x, y] of b.windows) pools.push([b.ox + x, b.oy + y, lit ? 34 : 22, lit ? 1 : 0]);
      if (b.door) pools.push([b.ox + b.door[0], b.oy + b.door[1] - 4, 26, 1]);
    }
    for (const v of W.villages) pools.push([...P((v.plaza.x + v.plaza.w / 2) * T, (v.plaza.y + v.plaza.h / 2) * T), 64, 1]);
    pools.push(...dock.lights);
    pools.push([...P((SQUARE.x + SQUARE.w / 2) * T, (SQUARE.y + SQUARE.h / 2) * T), 96, 1]);
    for (const d of vills) pools.push([d.left + 8, d.feet - 8, 20, 0]);
    const vis = pools.filter(([x, y, r]) => x + r > vx && x - r < vx + bw && y + r > vy && y - r < vy + bh);
    g.globalCompositeOperation = 'destination-out';
    for (const [x, y, r] of vis) { const fr = r * (1 + (still ? 0 : Math.sin(t * 3 + x) * 0.04)), gr = g.createRadialGradient(x - vx, y - vy, 0, x - vx, y - vy, fr); gr.addColorStop(0, 'rgba(0,0,0,0.88)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - vx - fr, y - vy - fr, fr * 2, fr * 2); }
    ctx.drawImage(veil, vx, vy);
    if (f.night < 0.35) return;
    // The warm glow fades in with the dark.
    const a = Math.min(1, (f.night - 0.35) / 0.4);
    ctx.globalCompositeOperation = 'lighter';
    for (const [x, y, r, warm] of vis) { if (!warm) continue; const gr = ctx.createRadialGradient(x, y, 0, x, y, r * 0.65); gr.addColorStop(0, `rgba(255,170,70,${0.24 * a})`); gr.addColorStop(1, 'rgba(255,170,70,0)'); ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
    // Lamps light their own head, and every home is drawn with its windows lit after dark.
    ctx.globalCompositeOperation = 'source-over';
  }
  // e2e only (?debug): what the last frame drew, and whether each flag drawn is really on the canvas
  // (its frame's opaque pixels compared with the canvas at 1×+, where a canvas px is a world px).
  function flagCheck(ctx) {
    if (!lastView || lastView.k !== 1) return [];
    return flagsDrawn.map(fl => {
      const want = flagSheet(fl.accent).getContext('2d').getImageData(fl.frame * 16, 0, 16, 16).data;
      const got = ctx.getImageData(fl.x - lastView.vx, fl.y - lastView.vy, 16, 16).data;
      let opaque = 0, matched = 0;
      for (let i = 0; i < want.length; i += 4) if (want[i + 3] > 200) { opaque++; if (Math.abs(want[i] - got[i]) + Math.abs(want[i + 1] - got[i + 1]) + Math.abs(want[i + 2] - got[i + 2]) < 9) matched++; }
      return { ...fl, opaque, matched };
    });
  }
  // e2e only (?debug), iso: every villager whose feet land on a building's drawn pixels must have been
  // drawn before that building (it is behind it), never after (standing on its roof). Returns offenders.
  function depthCheck() {
    const out = [];
    drawOrder.forEach((d, i) => {
      if (!d.b) return;
      const data = d.b.img.getContext('2d').getImageData(0, 0, d.b.img.width, d.b.img.height).data;
      drawOrder.forEach((o, j) => {
        if (!o.vd || o.vd.ghost || o.vd.walker) return; // a dock walker passes in front of houses on the street
        const x = Math.floor(o.vd.left + 8 - d.b.x), y = Math.floor(o.vd.feet - 1 - d.b.y);
        if (x < 0 || y < 0 || x >= d.b.img.width || y >= d.b.img.height || !data[(y * d.b.img.width + x) * 4 + 3]) return;
        if (j > i) out.push({ villager: o.vd.v.a.id, building: d.it.id });
      });
    });
    return out;
  }
  return { prepare, draw, BADGE, debug: () => ({ walkers, flags: flagsDrawn, hidden: drawOrder.filter(d => d.vd?.hidden).map(d => d.vd.v.a.id), dock: dock.debug() }), flagCheck, depthCheck,
    dockHit: (x, y) => dock.hit(x, y), dockTags: () => dock.tags };
}
