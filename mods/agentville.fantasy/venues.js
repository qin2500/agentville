// agentville.fantasy venue definitions (api.js VenueDef), keyed by kind: the harbour.
// The layout's harbour site (kind 'harbour', id 'dock') gives `anchor` = { tx: cx, ty: foot } and, when it has them,
// `data` = { cx, foot, sea }: cx the main pier's west tile column (under the town square), foot the shore row, sea the
// first water row. Geometry follows the classic harbour (web/src/dock-art.js harbourGeom, 16 px = 1 tile) in tiles:
// piers 7 tiles apart, 2 wide, pointing south; a berth is 3 tiles of a pier side.
//
// Size: the harbour follows the lifetime PRs sailed (load.merged: tiers at 10/40/120) and never
// shrinks below that; the PRs loading now can grow it further (tiers at 4/8/13) and that part shrinks only after ten
// minutes of needing less (shrinkAfterMs: the engine holds the level). The lifetime rank (load.rank, the classic dock
// level 1..5) adds its touches: pier-head lamps (2+), the warehouse (3+), the tier-1 crane (4+), the flag and the second
// pier-head lamp (5). Both are packed into the venue level: level = tier + 4 * (rank - 1), 1..20.
//
// `plan` lays out, by tier: plank piers (walkable decks), a stone quay (tier 2+, a walkable deck), the crate yard,
// cranes, warehouses, lamps, channel buoys, a breakwater with a lighthouse and a beacon (tier 3+), and berths: pier
// berths (ids p<pier><w|e><n>, the main pier first) then berths at anchor (ids a<n>) for the overflow.
// Models are engine-scale props (web/src/engine/art/props): pier, bollard, skiff, lamp, banner, crates, quay, crane,
// warehouse, buoy, breakwater, lighthouse, beacon.

// parity: har.tiers-1-4-by-prs-loading
/** Harbour tier by PRs loading now (classic dock-art.js tierFor). */
export const tierFor = n => (n <= 3 ? 1 : n <= 7 ? 2 : n <= 12 ? 3 : 4);
/** Lifetime floor (classic dock-art.js tierForTotal): PRs ever sailed reach these tiers and the harbour keeps them. */
export const LIFETIME_TIER2 = 10, LIFETIME_TIER3 = 40, LIFETIME_TIER4 = 120;
export const tierForTotal = t => (t >= LIFETIME_TIER4 ? 4 : t >= LIFETIME_TIER3 ? 3 : t >= LIFETIME_TIER2 ? 2 : 1);
// parity: har.shrink-hysteresis-10min
/** The loading part shrinks only after needing a smaller tier this long (classic dock-art.js SHRINK_MS). */
export const SHRINK_MS = 10 * 60e3;
export const RANK_MAX = 5;

const clampTier = t => Math.min(4, Math.max(1, t | 0 || 1));
const clampRank = r => Math.min(RANK_MAX, Math.max(1, Number.isInteger(r) ? r : 1));
/** The venue level for a tier (1..4) and a lifetime rank (1..5): 1..20. Rank 1 gives level = tier. */
export const levelOf = (tier, rank = 1) => clampTier(tier) + 4 * (clampRank(rank) - 1);
/** The tier and rank a level packs. */
export function decodeLevel(level) {
  const l = Math.max(1, Number.isInteger(level) ? level : 1) - 1;
  return { tier: (l % 4) + 1, rank: Math.min(RANK_MAX, Math.floor(l / 4) + 1) };
}

/** The harbour's level: tier = max(loading tier, lifetime tier), rank = load.rank. Shrinking is held by the engine
 *  (shrinkAfterMs); a rank step taken while the tier would drop keeps the old tier, so the drop still waits its turn. */
function level(load, prev) {
  const n = Number.isFinite(load?.states?.loading) ? load.states.loading : (load?.prs ?? 0);
  const merged = Number.isFinite(load?.merged) ? load.merged : 0, rank = clampRank(load?.rank);
  let tier = Math.max(tierFor(n), tierForTotal(merged));
  if (Number.isInteger(prev)) { const p = decodeLevel(prev); if (rank > p.rank && tier < p.tier) tier = p.tier; }
  return levelOf(tier, rank);
}

// parity: har.berths-and-at-anchor, har.cranes, har.crate-yard, har.warehouses, har.level-touches, har.beacon
const PIERS = [null, [0], [-1, 0, 1], [-2, -1, 0, 1], [-2, -1, 0, 1, 2]];
const UNITS = [null, 4, 4, 5, 6];        // classic berth units per pier side (26 px each); a berth here is 2 of them
const PITCH = 7, PIER_W = 2, SHIP = 3;   // tiles
export const PIER_ID = /^p\d/;           // pier berth ids; anything else is at anchor

/**
 * Where everything stands, in tiles. Pure; also used by the plan's tests and by ambient code that wants the harbour's
 * shape (sail-out course, tug and rowboat water).
 * @returns {{ tier, rank, cx, foot, sea, quay: object|null, y0, tail, piers: Array<{ k, x }>, xmin, xmax, bw: object|null }}
 */
export function harbourGeom({ cx, foot, sea }, lv) {
  const { tier, rank } = decodeLevel(lv);
  const hasQuay = tier >= 2, per = UNITS[tier] >> 1;
  const y0 = hasQuay ? sea + 2 : sea;               // the berths start below this row
  const tail = y0 + per * SHIP;                     // a pier's last row
  const piers = PIERS[tier].map(k => ({ k, x: cx + k * PITCH }));
  const xmin = piers[0].x, xmax = piers[piers.length - 1].x + PIER_W - 1;
  let bw = null;
  if (tier >= 3) {
    const yb = tail + 4, xw = xmin - 5, tip = xmax + 2, xe = xmax + 7;
    bw = { yb, xw, tip, xe, mouth: xmax + 5 };
  }
  const quay = hasQuay ? { x0: bw ? bw.xw - 1 : xmin - 4, x1: bw ? bw.xe + 1 : xmax + 4, y0: foot, y1: sea + 1 } : null;
  return { tier, rank, cx, foot, sea, quay, y0, tail, per, piers, xmin, xmax, bw };
}

function plan({ site, level: lv }) {
  const d = site.data && typeof site.data === 'object' ? site.data : {};
  const cx = Number.isInteger(d.cx) ? d.cx : site.anchor.tx, foot = Number.isInteger(d.foot) ? d.foot : site.anchor.ty;
  const sea = Number.isInteger(d.sea) ? d.sea : foot + 1;
  const G = harbourGeom({ cx, foot, sea }, lv), { tier, rank, quay, y0, tail, per, piers, xmin, xmax, bw } = G;
  const objects = [], nodes = { foot: { tx: cx, ty: foot }, yard: quay ? { tx: cx + 3, ty: foot - 1 } : { tx: cx, ty: foot } };
  const add = o => objects.push({ z: 0, walk: 'floor', variant: 0, w: 1, h: 1, ...o });

  // ---- berths: the main pier first, west side before east (dock-art.js lane order), then at anchor
  const lanes = [];
  for (const p of piers) for (const side of ['w', 'e']) lanes.push({ ...p, side });
  lanes.sort((a, b) => Math.abs(a.k) - Math.abs(b.k) || a.k - b.k || (a.side === 'w' ? -1 : 1));
  const berths = [];
  for (const { k, x, side } of lanes) {
    const bx = side === 'w' ? x - 1 : x + PIER_W;
    for (let j = 0; j < per; j++) {
      const id = `p${k + 2}${side}${j}`, ty = y0 + 1 + j * SHIP;
      berths.push({ id, tx: bx, ty, face: 2 });
      nodes[`deck-${id}`] = { tx: side === 'w' ? x : x + 1, ty };   // where a porter stands to load this berth
    }
  }
  const anchors = [];
  if (bw) for (let x = bw.xw + 2; x < bw.tip - 2; x += 3) anchors.push([x, bw.yb + 4]);
  else {
    const ay = tail + 4;
    anchors.push(...piers.map(p => [p.x + 1, ay]), [xmin - 6, ay], [xmax + 6, ay - 1], [xmin - 12, ay + 1], [xmax + 12, ay]);
  }
  anchors.forEach(([tx, ty], i) => berths.push({ id: `a${i}`, tx, ty, face: 2 }));

  // ---- piers: plank decks (walkable) in berth-length planks, bollards where each berth starts, cranes at the root
  const top = quay ? quay.y1 + 1 : sea;
  for (const { k, x } of piers) {
    for (let ty = top, n = 0; ty <= tail; ty += SHIP, n++) {
      add({ id: `pier${k + 2}.${n}`, kind: 'venue', model: 'pier', tx: x, ty, w: PIER_W, h: Math.min(SHIP, tail - ty + 1), deck: true, variant: (k + 2 + n) & 3 });
    }
    for (let j = 0; j < per; j++) for (const bx of [x, x + PIER_W - 1]) {
      add({ id: `bol${k + 2}.${bx - x}.${j}`, kind: 'prop', model: 'bollard', tx: bx, ty: y0 + 1 + j * SHIP, z: 6, variant: (k + 2) & 3 });
    }
    if (rank >= 2) add({ id: `lamp.p${k + 2}w`, kind: 'prop', model: 'lamp', tx: x, ty: tail, z: 20 });
    if (rank >= 5) add({ id: `lamp.p${k + 2}e`, kind: 'prop', model: 'lamp', tx: x + 1, ty: tail, z: 20 });
    if (tier >= 3 || (tier === 2 && k !== 0)) add({ id: `crane.p${k + 2}`, kind: 'prop', model: 'crane', tx: x, ty: y0, z: 46, walk: 'block' });
  }

  if (!quay) {
    // tier 1: a jetty off the beach, a skiff at its mooring; the warehouse (rank 3+) and the crane (rank 4+) on the bank
    add({ id: 'skiff0', kind: 'prop', model: 'skiff', tx: cx - 4, ty: sea + 1, w: 1, h: 3, variant: 1 });
    if (rank >= 3) add({ id: 'shed0', kind: 'prop', model: 'warehouse', tx: cx - 4, ty: foot - 1, w: 3, h: 2, z: 30, walk: 'block' });
    if (rank >= 4) add({ id: 'crane.bank', kind: 'prop', model: 'crane', tx: cx + 3, ty: foot, z: 46, walk: 'block' });
    if (rank >= 5) add({ id: 'flag', kind: 'prop', model: 'banner', tx: cx + 2, ty: sea, z: 24 });
  } else {
    // the quay: one stone slab along the shore, walkable
    add({ id: 'quay', kind: 'prop', model: 'quay', tx: quay.x0, ty: quay.y0, w: quay.x1 - quay.x0 + 1, h: quay.y1 - quay.y0 + 1, z: 6, deck: true });
    for (const [i, x] of [quay.x0, cx - 1, quay.x1].entries()) add({ id: `lamp.q${i}`, kind: 'prop', model: 'lamp', tx: x, ty: quay.y1, z: 20 });
    if (rank >= 5) add({ id: 'flag', kind: 'prop', model: 'banner', tx: cx - 2, ty: foot, z: 24 });
    // the crate yard on land east of the footpath: crates waiting for the porters (the yard node is their pick-up tile)
    [[cx + 4, foot - 2, 4], [cx + 5, foot - 1, 2], [cx + 6, foot - 2, 5]].forEach(([tx, ty, n], i) =>
      add({ id: `crates${i}`, kind: 'prop', model: 'crates', tx, ty, z: 8 + 7 * Math.ceil(n / 3), variant: i % 3 }));
    // warehouses on the quay: the west end and between the piers (not east of the main pier: the footpath and yard)
    const gaps = [];
    { const b = xmin - 2, w = Math.min(4, b - quay.x0 + 1); if (w >= 2) gaps.push([b - w + 1, w]); }
    for (let i = 0; i + 1 < piers.length; i++) if (piers[i].k !== 0) gaps.push([piers[i].x + 3, 3]);
    const want = tier >= 3 ? gaps : rank >= 3 ? gaps.filter(g => g[0] > xmin).slice(-1) : [];
    want.forEach(([tx, w], i) => add({ id: `shed${i}`, kind: 'prop', model: 'warehouse', tx, ty: foot, w, h: 2, z: 30, walk: 'block', variant: i % 5 }));
  }

  if (tier === 2) {
    // channel buoys either side of each fairway between the piers
    const fairs = [...new Set(piers.flatMap(p => [p.x - 3, p.x + PIER_W + 2]))].sort((a, b) => a - b);
    fairs.forEach((f, i) => {
      add({ id: `buoy${i}r`, kind: 'prop', model: 'buoy', tx: f - 1, ty: tail + 2, z: 12, variant: 0 });
      add({ id: `buoy${i}g`, kind: 'prop', model: 'buoy', tx: f + 1, ty: tail + 2, z: 12, variant: 1 });
    });
  }
  if (bw) {
    // the breakwater: a west arm down from the quay and along the basin's south side to the lighthouse, an east mole
    // with the beacon on its end; the mouth between them is marked with buoys
    const { yb, xw, tip, xe, mouth } = bw, from = quay.y1 + 1;
    add({ id: 'bw.west', kind: 'prop', model: 'breakwater', tx: xw, ty: from, w: 1, h: yb - from, z: 8 });
    add({ id: 'bw.south', kind: 'prop', model: 'breakwater', tx: xw, ty: yb, w: tip - xw, h: 1, z: 8 });
    add({ id: 'bw.east', kind: 'prop', model: 'breakwater', tx: xe, ty: from, w: 1, h: yb - from + 1, z: 8 });
    add({ id: 'lighthouse', kind: 'prop', model: 'lighthouse', tx: tip, ty: yb, w: 2, h: 2, z: 68, walk: 'block' });
    add({ id: 'beacon', kind: 'prop', model: 'beacon', tx: xe, ty: yb + 1, z: 30, walk: 'block' });
    [[mouth - 1, yb + 2, 0], [mouth + 1, yb + 2, 1], [mouth - 2, yb + 6, 0], [mouth + 2, yb + 6, 1]].forEach(([tx, ty, v], i) =>
      add({ id: `buoy.m${i}`, kind: 'prop', model: 'buoy', tx, ty, z: 12, variant: v }));
    nodes.mouth = { tx: mouth, ty: yb };
    nodes.offing = { tx: mouth, ty: yb + 8 };
    nodes.tug = { tx: tip - 5, ty: yb - 2 };
  } else {
    nodes.mouth = { tx: cx + 1, ty: tail + 2 };
    nodes.offing = { tx: cx + 1, ty: tail + 9 };
  }
  return { objects, nodes, berths };
}

/** Which berth each harbour PR takes (VenueDef.assign; the 5th argument tells ship classes). Stable: a PR keeps the
 *  berth it had. A new brig takes a free pier head (the outermost berth of a pier side), then any pier berth; a smaller
 *  ship takes a pier berth that is not a head first, so the heads stay free for brigs. The overflow lies at anchor. */
function assign(prIds, berths, prev, ctx, info = {}) {
  const ids = prIds.slice(0, berths.length), valid = new Set(berths.map(b => b.id)), used = new Set(), out = {};
  for (const id of ids) {
    const b = Object.prototype.hasOwnProperty.call(prev || {}, id) ? prev[id] : undefined;
    if (valid.has(b) && !used.has(b)) { out[id] = b; used.add(b); }
  }
  const pier = berths.filter(b => PIER_ID.test(b.id)), outer = new Map();
  for (const b of pier) { const k = `${b.tx}`; if (!outer.has(k) || outer.get(k).ty < b.ty) outer.set(k, b); }
  const heads = pier.filter(b => outer.get(`${b.tx}`) === b), rest = pier.filter(b => !heads.includes(b));
  const atAnchor = berths.filter(b => !PIER_ID.test(b.id));
  const firstFree = list => list.find(b => !used.has(b.id));
  for (const id of ids) {
    if (out[id]) continue;
    const big = info?.[id]?.model === 'brig';
    const b = (big ? firstFree(heads) ?? firstFree(rest) : firstFree(rest) ?? firstFree(heads)) ?? firstFree(atAnchor);
    if (!b) break;
    out[id] = b.id; used.add(b.id);
  }
  return out;
}

// parity: world.central-square
// The central square's dressing (classic web/src/world.js): a big tree in the middle and a lantern on each of the four
// corners. The layout names the square as a 'square' site (layout/square.js); this plan places the objects in it.
function squarePlan({ site }) {
  const { x, y, w, h } = site.rect, cx = x + (w >> 1), cy = y + (h >> 1);
  const objects = [{ id: 'bigtree', kind: 'tree', model: 'tree', tx: cx, ty: cy, w: 1, h: 1, z: 40, walk: 'block', variant: 3 }];
  [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]].forEach(([tx, ty], i) =>
    objects.push({ id: `lantern${i}`, kind: 'prop', model: 'lamp', tx, ty, w: 1, h: 1, z: 34, walk: 'block', variant: 0 }));
  return { objects, nodes: { centre: { tx: cx, ty: cy + 1 } }, berths: [] };
}

export const VENUES = { harbour: { level, plan, assign, shrinkAfterMs: SHRINK_MS }, square: { level: () => 1, plan: squarePlan } };
