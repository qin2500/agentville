// City planner (docs: va-city-spec "Growing towns"): turns a project's tier and lot count into a planned
// settlement on a plot of tiles. PURE: no DOM, no imports; node tests import it directly.
//
// Every tier is built from the same idea, the way real planned towns grow: rows of buildings sit on the
// NORTH side of east-west streets (doors face south, the viewer looks from the south-east), their backs
// are gardens and yards, and north-south lanes cut the rows into blocks. v2 (va-city2-spec) keeps villagers
// visible: every door opens on a forecourt row (doorstep / pavement) with the street below it, town and city
// streets and the village main street are 2 wide, neighbouring buildings stand at least a tile apart (city
// townhouses in pairs), so the tiles (dx+k, dy+k), k = 1, 2, south-east of every lot door are never under a
// roof. v3 (va-city3-spec) keeps v2's buildings (same lots per bucket, same civic set) and spreads them out:
// 2-tile gaps (no touching pairs) with pocket lawns and trees in town and city rows, 2-wide cross streets, two back-garden rows, a 3-wide main street,
// 2-wide main cross streets, a wider square and close, and 2-tile gaps between village pairs, so the plot
// is about 1.4x v2's area in town and city and ~1.1x in a village (hamlets unchanged). Character from tier:
//   hamlet  a lane or two round a small green with a well; farmhouses, barn, windmill, granary, fields.
//   village a main street with a second row behind it, a green with well and maypole, the chapel facing
//           the green, smithy and inn on the main street, farmland round the edge.
//   town    a grid of streets, a central cobbled square with a fountain and clock tower, the guildhall and
//           the manor fronting it, a market square with stalls beside it and the market hall over it,
//           two-storey timber rows, yards and gardens behind, maybe a small canal, an orchard ring.
//   city    no walls: a tree-lined lawn belt with a boulevard inside it, a cathedral fronting a big square,
//           market square, guildhall, pairs of tall townhouses, courtyards, a canal with bridges,
//           lampposts, statues, small plazas in the outer districts.
// Size comes from capacity: each step adds a column of blocks or a band of rows (never stretches), so a
// plan only changes when the lot count crosses a bucket. All structure is seed-independent except a mirror,
// the market side, the town canal, crops and props, so the lot count of a step never depends on the seed.
export const TIERS = ['hamlet', 'village', 'town', 'city'];

export const GROUND = {
  NONE: 0, GRASS: 1, STREET: 2, LANE: 3, PLAZA: 4, MARKET: 5, YARD: 6, FIELD: 7, ORCHARD: 8,
  GARDEN: 9, LAWN: 10, PASTURE: 11, WATER: 12, BRIDGE: 13, WALL: 14, FLOWERS: 15,
};
const G = GROUND;
export const WALKABLE = new Set([G.STREET, G.LANE, G.PLAZA, G.MARKET, G.YARD, G.BRIDGE]);

export function tierFor(growth) {
  const g = Number(growth) || 0;
  return g >= 200 ? 3 : g >= 40 ? 2 : g >= 12 ? 1 : 0;
}

// Footprints [w (east), h (south)].
const DIM = {
  farmhouse: [3, 3], cottage: [3, 3], timber: [3, 3], timberM: [4, 3], townhouse: [2, 3], townhouseM: [3, 3],
  manor: [4, 4], hall: [4, 5], barn: [4, 3], windmill: [3, 3], granary: [2, 2], chapel: [3, 5], smithy: [3, 3],
  inn: [4, 3], guildhall: [5, 4], clocktower: [2, 2], markethall: [5, 3], cathedral: [6, 8],
};
const lot = (key, rank) => { const [w, h] = DIM[key]; return { kind: 'lot', look: key.replace(/M$/, ''), rank, w, h, door: true }; };
const civ = (look, door = true) => { const [w, h] = DIM[look]; return { kind: 'civic', look, w, h, door }; };

function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedNum(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  let h = 2166136261;
  for (const c of String(seed ?? '')) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// ---- the working grid ---------------------------------------------------------------------------------
function grid(w, h) {
  return { w, h, g: new Uint8Array(w * h), occ: new Int32Array(w * h), blds: [], props: [], squares: [], plaza: null };
}
const inside = (P, x, y) => x >= 0 && y >= 0 && x < P.w && y < P.h;
const get = (P, x, y) => (inside(P, x, y) ? P.g[y * P.w + x] : G.NONE);
const isFoot = (P, x, y) => inside(P, x, y) && P.occ[y * P.w + x] > 0;
function fill(P, x, y, w, h, c) {
  for (let j = Math.max(0, y); j < Math.min(P.h, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(P.w, x + w); i++) P.g[j * P.w + i] = c;
}
// Ground under open tiles of a rect only (keeps footprints' ground).
function fillOpen(P, x, y, w, h, c) {
  for (let j = Math.max(0, y); j < Math.min(P.h, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(P.w, x + w); i++) if (!P.occ[j * P.w + i]) P.g[j * P.w + i] = c;
}
function place(P, it, x, y) {
  const b = { ...it, x, y };
  for (let j = y; j < y + it.h; j++) for (let i = x; i < x + it.w; i++) {
    if (!inside(P, i, j) || P.occ[j * P.w + i]) throw new Error(`city-plan: ${it.look} at ${x},${y} overlaps or leaves the plot`);
  }
  P.blds.push(b);
  const n = P.blds.length;
  for (let j = y; j < y + it.h; j++) for (let i = x; i < x + it.w; i++) { P.occ[j * P.w + i] = n; P.g[j * P.w + i] = G.LAWN; }
  return b;
}
const prop = (P, kind, x, y, v = 0, extra) => P.props.push(extra ? { kind, x, y, v, ...extra } : { kind, x, y, v });
// A row of buildings standing on the forecourt row yF (bottoms at yF - 1), centred in [x0, x1]. `gap` is the
// number of tiles after each building, or a function of its index (city townhouse pairs).
function row(P, x0, x1, yF, items, gap) {
  const g = typeof gap === 'function' ? gap : () => gap;
  const tot = items.reduce((a, it, i) => a + it.w + (i < items.length - 1 ? g(i) : 0), 0);
  if (tot > x1 - x0 + 1) throw new Error(`city-plan: a row of ${items.length} does not fit in ${x1 - x0 + 1} tiles`);
  let x = x0 + ((x1 - x0 + 1 - tot) >> 1);
  const out = [];
  items.forEach((it, i) => { out.push(place(P, it, x, yF - it.h)); x += it.w + g(i); });
  return out;
}
const many = (n, key, rank) => Array.from({ length: Math.max(0, n) }, () => lot(key, rank));
const fit = (width, w, gap) => Math.floor((width + gap) / (w + gap));
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];

// Decorate the open tiles of a house block [x0..x1] x [y0..fc]: buildings stand with their bottoms on row
// fc - 1 and their doors on the forecourt row fc (a doorstep or pavement, walkable, the street is below it).
// Gap columns between buildings get flowers at the front; the backs become garden / yard / lawn by style.
function dressBlock(P, r, x0, x1, y0, fc, style, houses, fcCode) {
  const rural = style === 'hamlet' || style === 'village';
  for (let x = x0; x <= x1; x++) {
    let col = false;
    for (let y = y0; y < fc && !col; y++) col = isFoot(P, x, y);
    if (!col && get(P, x, fc - 1) === G.GARDEN) P.g[(fc - 1) * P.w + x] = G.FLOWERS;
    if (isFoot(P, x, fc)) continue;
    if (houses.some(b => x >= b.x && x < b.x + b.w && b.y + b.h === fc)) P.g[fc * P.w + x] = fcCode;
    else if (get(P, x, fc) === G.GARDEN) P.g[fc * P.w + x] = rural ? G.FLOWERS : fcCode;
  }
  for (const b of houses) {
    const back = b.y - y0; // rows of open ground behind this building
    if (back <= 0) continue;
    const roll = r();
    let code = G.GARDEN;
    if (style === 'town') code = roll < 0.45 ? G.YARD : roll < 0.85 ? G.GARDEN : G.LAWN;
    else if (style === 'city') code = roll < 0.3 ? G.YARD : roll < 0.65 ? G.GARDEN : G.LAWN;
    else code = roll < 0.75 ? G.GARDEN : G.LAWN;
    for (let y = y0; y < b.y; y++) for (let x = b.x; x < b.x + b.w; x++) if (!isFoot(P, x, y) && get(P, x, y) === G.GARDEN) P.g[y * P.w + x] = code;
    const py = b.y - 1 + 0.5, px = b.x + 0.5 + Math.floor(r() * b.w);
    if (get(P, Math.floor(px), Math.floor(py)) !== code) continue;
    if (code === G.YARD) prop(P, r() < 0.6 ? 'laundry' : pick(r, ['barrel', 'crate', 'woodpile']), px, py, Math.floor(r() * 4));
    else if (code === G.LAWN) prop(P, style === 'city' && r() < 0.25 ? 'well' : 'tree', px, py, Math.floor(r() * 4));
    else if (style === 'hamlet') prop(P, pick(r, ['beehive', 'laundry', 'woodpile', 'scarecrow']), px, py, Math.floor(r() * 4));
    else if (style === 'village') prop(P, pick(r, ['laundry', 'beehive', 'woodpile', 'flowers']), px, py, Math.floor(r() * 4));
    else if (r() < 0.5) prop(P, pick(r, ['laundry', 'beehive', 'flowers', 'bush']), px, py, Math.floor(r() * 4));
  }
  // v3: town and city gaps (2 wide) behind the front flowers are little lawns with a tree, pocket gardens
  if (!rural) {
    const fr = houses.filter(b => b.y + b.h === fc).sort((a, b) => a.x - b.x);
    for (let i = 1; i < fr.length; i++) {
      const gx0 = fr[i - 1].x + fr[i - 1].w, gx1 = fr[i].x - 1;
      if (gx1 <= gx0) continue;
      for (let y = y0; y < fc - 1; y++) for (let x = gx0; x <= gx1; x++) if (!isFoot(P, x, y) && get(P, x, y) === G.GARDEN) P.g[y * P.w + x] = G.LAWN;
      if (fc - 1 - y0 >= 3) prop(P, 'tree', gx0 + 1, y0 + 0.6, Math.floor(r() * 4));
      if (fc - 2 - y0 >= 3) prop(P, r() < 0.5 ? 'bush' : 'flowers', gx0 + 0.5 + (i % 2), fc - 1.6, Math.floor(r() * 4));
    }
  }
  // flower boxes, a barrel or a bush in the gaps between the buildings
  for (let x = x0; x <= x1; x++) {
    const y = fc - 1;
    if (isFoot(P, x, y) || get(P, x, y) !== G.FLOWERS) continue;
    const roll = r();
    if (roll < 0.35) prop(P, 'flowerbox', x + 0.5, y + 0.6, Math.floor(r() * 4));
    else if (roll < 0.55) prop(P, style === 'hamlet' ? 'woodpile' : 'barrel', x + 0.5, y + 0.6, Math.floor(r() * 4));
    else if (roll < 0.7) prop(P, rural ? 'flowers' : 'bush', x + 0.5, y + 0.5, Math.floor(r() * 4));
  }
}

const FARM0 = [G.FIELD, G.PASTURE, G.FIELD, G.GARDEN, G.FIELD, G.ORCHARD];
const FARM1 = [G.FIELD, G.ORCHARD, G.FIELD, G.PASTURE, G.FIELD, G.ORCHARD, G.FIELD, G.PASTURE];
// Farmland: parcels of crops, orchards and pasture with fences, over the open tiles of a rect.
function farmland(P, r, x0, x1, y0, y1, tier) {
  const width = x1 - x0 + 1;
  if (width <= 0) return;
  const n = Math.max(1, Math.round(width / 5));
  let x = x0;
  for (let i = 0; i < n; i++) {
    const pw = Math.round((width * (i + 1)) / n) - Math.round((width * i) / n);
    // crops cycle through the tier's mix from a seeded start, so every farm has fields and something else
    const kinds = tier === 0 ? FARM0 : FARM1;
    if (P.farmK == null) P.farmK = Math.floor(r() * kinds.length);
    const code = kinds[P.farmK++ % kinds.length];
    fillOpen(P, x, y0, pw, y1 - y0 + 1, code);
    const freeCol = cx => { for (let y = y0; y <= y1; y++) if (isFoot(P, cx, y)) return false; return true; };
    if (code === G.FIELD) {
      prop(P, 'fence', x, y0 + 0.05, 0, { dir: 'x', len: pw });
      if (pw >= 3) prop(P, 'scarecrow', x + 1 + Math.floor(r() * (pw - 2)) + 0.5, y0 + 1 + Math.floor(r() * Math.max(1, y1 - y0)) + 0.5, Math.floor(r() * 4));
    } else if (code === G.ORCHARD) {
      for (let yy = y0; yy <= y1; yy += 2) for (let xx = x + (yy % 2); xx < x + pw; xx += 2) prop(P, 'tree', xx + 0.5, yy + 0.5, 2 + Math.floor(r() * 2));
      if (r() < 0.6) prop(P, 'beehive', x + 0.5, y1 + 0.5, Math.floor(r() * 4));
    } else if (code === G.PASTURE) {
      prop(P, 'fence', x, y0 + 0.05, 1, { dir: 'x', len: pw });
      if (freeCol(x)) prop(P, 'fence', x + 0.05, y0, 1, { dir: 'y', len: y1 - y0 + 1 });
      prop(P, r() < 0.5 ? 'haystack' : 'hay', x + 0.5 + Math.floor(r() * pw), y0 + 1.5, Math.floor(r() * 4));
      prop(P, 'trough', x + pw - 0.5, y1 + 0.5, 0);
    } else {
      prop(P, 'beehive', x + 0.5, y0 + 0.5, Math.floor(r() * 4));
      prop(P, 'scarecrow', x + pw - 0.5, y1 + 0.5, Math.floor(r() * 4));
    }
    x += pw;
  }
}

// ---- hamlet and village -------------------------------------------------------------------------------
// Each band: (a back-garden row, except the first band), the buildings, a forecourt row of doorsteps, a lane.
// The back row keeps the next band's roofs off the diagonal south-east of the doors on the lane above.
function rural(tier, s, r) {
  const V = tier === 1;
  const per = V ? 2 : 1, colW = V ? 9 : 4, centerW = V ? 8 : 4; // v3: a 2-tile gap between village pairs
  let cw = 1, ce = 1, nA = 1;
  const cyc = V ? 'aew' : 'ewa';
  for (let i = 0; i < s; i++) { const k = cyc[i % 3]; if (k === 'a') nA++; else if (k === 'e') ce++; else cw++; }
  const bandH = 4, hallH = 6, greenH = 5, mainH = V ? 2 : 1, farmH = V ? 4 : 3;
  const bandOf = k => (k === nA - 1 ? hallH : bandH) + (k ? 1 : 0);
  const W = 2 + (cw + ce) * colW + 2 + centerW;
  let H = 1 + greenH + mainH + farmH + 1;
  for (let k = 0; k < nA; k++) H += bandOf(k) + 1;
  const P = grid(W, H);
  const xL = 1 + cw * colW, cx0 = xL + 1, cx1 = xL + centerW, xR = cx1 + 1, ex0 = xR + 1;
  const house = V ? 'cottage' : 'farmhouse', style = V ? 'village' : 'hamlet';
  const LN = G.LANE, MAIN = V ? G.STREET : G.LANE;
  // the outer ring: fields north and south, pasture east and west, a hedge of bushes
  fill(P, 0, 0, W, H, G.PASTURE);
  fill(P, 0, 0, W, 1, G.FIELD);
  fill(P, 0, H - 1, W, 1, G.FIELD);
  const xtra = colW - 4 * per; // gaps sit on the far side from the green
  const westSlot = j => 1 + Math.floor(j / per) * colW + xtra + (j % per) * 4 + 1;
  const eastSlot = j => ex0 + Math.floor(j / per) * colW + (j % per) * 4;
  let y = 1, lane0 = 0;
  for (let k = 0; k < nA; k++) {
    const hall = k === nA - 1, h = bandOf(k), fc = y + h - 1, yS = fc + 1, rank = hall ? 'M' : 'S';
    fill(P, 1, y, W - 2, h, G.GARDEN);
    const built = [];
    for (let j = 0; j < cw * per; j++) built.push(place(P, lot(house, rank), westSlot(j), fc - 3));
    for (let j = 0; j < ce * per; j++) built.push(place(P, lot(house, rank), eastSlot(j), fc - 3));
    if (hall) {
      built.push(place(P, lot('hall', 'L'), cx0, fc - 5));
      if (V) {
        const ch = place(P, civ('chapel'), cx0 + 5, fc - 5);
        prop(P, 'noticeboard', cx0 + 4.5, fc - 0.4, 0);
        prop(P, 'tree', cx0 + 4.5, y + 0.5, 1);
        built.push(ch);
      }
    } else {
      for (let j = 0; j < per; j++) built.push(place(P, lot(house, rank), cx0 + j * 4, fc - 3));
    }
    dressBlock(P, r, 1, xL - 1, y, fc, style, built.filter(b => b.x < xL), G.YARD);
    dressBlock(P, r, cx0, cx1, y, fc, style, built.filter(b => b.x > xL && b.x < xR), G.YARD);
    dressBlock(P, r, xR + 1, W - 2, y, fc, style, built.filter(b => b.x > xR), G.YARD);
    fill(P, 0, yS, W, 1, LN);
    if (k === 0) lane0 = yS;
    y = yS + 1;
  }
  // the green band: the green in the middle, farm buildings (hamlet) or inn and smithy (village) beside it
  const gy = y, gfc = gy + greenH - 1, main = gfc + 1;
  fill(P, 1, gy, W - 2, greenH, G.GARDEN);
  const built = [];
  for (let j = 0; j < cw * per; j++) {
    const x = westSlot(j);
    if (V && j >= (cw - 1) * per) { // the column next to the green: the inn and its yard
      if (j === cw * per - 1) {
        built.push(place(P, civ('inn'), x - 1, gfc - 3));
        fill(P, x - 5, gy, 4, greenH, G.YARD);
        prop(P, 'cart', x - 3.5, gy + 1, 0);
        prop(P, 'barrel', x - 4.5, gfc - 0.5, 0);
        prop(P, 'crate', x - 2.5, gfc - 1.5, 1);
        prop(P, 'barrel', x - 4.5, gy + 0.5, 1);
      }
      continue;
    }
    if (!V && j === cw * per - 1) {
      built.push(place(P, civ('barn'), x - 1, gfc - 3));
      continue;
    }
    built.push(place(P, lot(house, 'M'), V ? x : x - 1, gfc - 3)); // hamlet: one west so the barn stands clear
  }
  for (let j = 0; j < ce * per; j++) {
    const x = eastSlot(j);
    if (j === 0) {
      built.push(place(P, civ(V ? 'smithy' : 'windmill'), x, gfc - 3));
      if (V) { prop(P, 'woodpile', x + 3.5, gy + 0.5, 0); prop(P, 'trough', x + 3.5, gfc - 1.4, 0); }
      else prop(P, 'crate', x + 3.5, gfc - 1.5, 0);
      continue;
    }
    built.push(place(P, lot(house, 'M'), x, gfc - 3));
  }
  dressBlock(P, r, 1, cx0 - 2, gy, gfc, style, built.filter(b => b.x < xL), G.YARD);
  dressBlock(P, r, xR + 1, W - 2, gy, gfc, style, built.filter(b => b.x > xR), G.YARD);
  fill(P, cx0, gy, centerW, greenH, G.LAWN);
  const green = { x: cx0, y: gy, w: centerW, h: greenH, kind: 'green' };
  P.squares.push(green);
  P.plaza = { x: cx0, y: gy, w: centerW, h: greenH };
  const gcx = cx0 + centerW / 2, gcy = gy + greenH / 2;
  if (V) {
    prop(P, 'maypole', gcx - 0.5 - 1, gcy, 0);
    prop(P, 'well', gcx + 1.5, gcy, 0);
    prop(P, 'bench', cx0 + 0.5, main - 0.5, 0);
    prop(P, 'bench', cx1 - 0.5, main - 0.5, 1);
    prop(P, 'tree', cx0 + 0.5, gy + 0.5, 0);
    prop(P, 'tree', cx1 - 0.5, gy + 0.5, 1);
    prop(P, 'lamp', cx0 + 2.5, gy + 0.3, 0);
    prop(P, 'flowers', cx1 - 2.5, main - 0.5, 1);
  } else {
    prop(P, 'well', gcx, gcy, 0);
    prop(P, 'tree', cx0 + 0.5, gy + 0.5, 0);
    prop(P, 'flowers', cx1 - 0.5, main - 0.5, 2);
    prop(P, 'bush', cx1 - 0.5, gy + 0.5, 0);
  }
  fill(P, 0, main, W, mainH, MAIN);
  // the lanes round the green, the west one on south through the fields to a gate
  fill(P, xL, lane0, 1, main - lane0, LN);
  fill(P, xR, lane0, 1, main - lane0, LN);
  fill(P, xL, main, 1, H - main, LN);
  // farmland south of the main street
  const fy0 = main + mainH, fy1 = H - 2;
  place(P, civ('granary'), xL + 1, fy0);
  if (V) {
    place(P, civ('barn'), xL - 4, fy0);
    prop(P, 'cart', xL - 4.5, fy0 + 3.5, 1);
    const wx = Math.min(W - 5, xL + 4 + Math.max(0, (W - 2 - (xL + 4) - 3) >> 1));
    place(P, civ('windmill'), wx, fy0);
  }
  farmland(P, r, 1, xL - 1, fy0, fy1, tier);
  farmland(P, r, xL + 1, W - 2, fy0, fy1, tier);
  // hedges on the ring, trees at the corners, signposts at the main street's gates
  for (let x = 2; x < W - 2; x += 3) { prop(P, 'bush', x + 0.5, 0.5, x % 2); prop(P, 'bush', x + 0.5, H - 0.5, (x + 1) % 2); }
  for (let yy = 2; yy < H - 2; yy += 3) { prop(P, 'bush', 0.5, yy + 0.5, 0); prop(P, 'bush', W - 0.5, yy + 0.5, 1); }
  for (const [tx, ty] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) prop(P, tx ? 'tree' : 'pine', tx + 0.5, ty + 0.5, (tx + ty) % 4);
  prop(P, 'signpost', 0.5, main - 0.4, 0);
  prop(P, 'signpost', W - 0.5, main + mainH + 0.4, 1);
  return P;
}

// ---- town and city ------------------------------------------------------------------------------------
// Bands of (back-garden row,) buildings, a pavement forecourt row and a 2-wide street; the first band backs
// straight onto the ring. No walls: a town has an orchard ring, a city a tree-lined lawn belt with a
// boulevard inside it (the last band's street is the boulevard's south side).
function urban(tier, s, r, marketSide, canalOn) {
  // v3 (va-city3-spec): the same buildings as v2 with more room between them: 2-tile gaps in every row,
  // two back-garden rows, a 3-wide main street, 2-wide main cross streets and a wider square and close.
  const C = tier === 3, R = C ? 2 : 1, SW = C ? 14 : 13, CWd = C ? 22 : 13, BH = 6, SH = 2, MSH = 3;
  let nN = C ? 2 : 1, nS = 1, cw = 1, ce = 1;
  for (let i = 0; i < s; i++) { const k = 'sewn'[i % 4]; if (k === 's') nS++; else if (k === 'e') ce++; else if (k === 'w') cw++; else nN++; }
  const cols = [], ns = [];
  let x = R;
  for (let i = 0; i < cw; i++) { cols.push({ x0: x, x1: x + SW - 1 }); x += SW; ns.push({ x, w: 2 }); x += 2; }
  cols.push({ x0: x, x1: x + CWd - 1, center: true }); x += CWd; ns.push({ x, w: 2 }); x += 2;
  for (let i = 0; i < ce; i++) { cols.push({ x0: x, x1: x + SW - 1 }); x += SW; if (i < ce - 1) { ns.push({ x, w: 2 }); x += 2; } }
  const nb = nN + 1 + nS, m = nN, cc = cw, mc = cc + marketSide;
  const bh = k => (k === 0 && k !== m - 1 ? BH - 1 : BH);
  const sh = k => (k === m ? MSH : SH);
  const top = [], fcs = [], st = [];
  let yy = R;
  for (let k = 0; k < nb; k++) { top.push(yy); fcs.push(yy + bh(k) - 1); st.push(yy + bh(k)); yy += bh(k) + sh(k); }
  const W = x + R, H = yy + 1;
  const P = grid(W, H);
  const { x0: cx0, x1: cx1 } = cols[cc];
  const lampKind = C ? 'lamppost' : 'lamp';
  // ring: an orchard round a town; a lawn belt and the boulevard inside it round a city
  if (C) { fill(P, 0, 0, W, H, G.LAWN); fill(P, 1, 1, W - 2, H - 2, G.STREET); } else fill(P, 0, 0, W, H, G.ORCHARD);
  fill(P, R, R, W - 2 * R, H - 1 - R, G.GARDEN);
  // streets: one per band below its row, one between each pair of columns; the main ones leave the plot
  for (let k = 0; k < nb; k++) fill(P, R, st[k], W - 2 * R, sh(k), G.STREET);
  for (const c of ns) fill(P, c.x, R, c.w, H - 1 - R, G.STREET);
  fill(P, 0, st[m], W, MSH, G.STREET);
  fill(P, cx0 - 2, 0, 2, H, G.STREET);
  fill(P, cx1 + 1, 0, 2, H, G.STREET);
  if (C) fill(P, cx0, st[m - 2], CWd, sh(m - 2), G.GARDEN); // the cathedral close spans two bands
  // the main square (with the street rows above and below it), the market square beside it
  const sq = { x: cx0, y: st[m - 1], w: CWd, h: sh(m - 1) + BH + MSH, kind: 'square' };
  fill(P, sq.x, sq.y, sq.w, sq.h, G.PLAZA);
  P.squares.push(sq);
  P.plaza = { x: sq.x, y: sq.y, w: sq.w, h: sq.h };
  const mk = cols[mc], mkt = { x: mk.x0, y: top[m], w: SW, h: BH, kind: 'market' };
  fill(P, mkt.x, mkt.y, mkt.w, mkt.h, G.MARKET);
  P.squares.push(mkt);
  // canal along the back row of the first band south of the square, bridged where streets cross it
  if (C || canalOn) {
    const yc = top[m + 1];
    for (let xx = 0; xx < W; xx++) {
      const i = yc * W + xx;
      P.g[i] = P.g[i] === G.STREET ? G.BRIDGE : G.WATER;
      if (P.g[i] === G.BRIDGE) prop(P, 'bridge', xx + 0.5, yc + 0.5, 0, { dir: 'y' });
    }
  }
  const plazaBlock = (c, k) => C && !(c === cc && k === m) && ((c - cc) % 3 + 3) % 3 === 0 && ((k - m) % 3 + 3) % 3 === 0;
  for (let k = 0; k < nb; k++) for (let c = 0; c < cols.length; c++) {
    const { x0, x1 } = cols[c], y0 = top[k], fc = fcs[k], wd = x1 - x0 + 1;
    if (k === m && (c === cc || c === mc)) continue;
    if (C && c === cc && (k === m - 2 || k === m - 1)) { if (k === m - 1) cathedralClose(P, x0, x1, top[m - 2], fc); continue; }
    if (k === m - 1 && c === cc) { // town: the manor and the guildhall front the square
      const b = row(P, x0, x1, fc, [lot('manor', 'L'), civ('guildhall')], 2);
      dressBlock(P, r, x0, x1, y0, fc, 'town', b, G.PLAZA);
      prop(P, 'banner', b[1].x - 0.5, fc + 0.3, 0);
      prop(P, 'banner', b[1].x + b[1].w + 0.5, fc + 0.3, 1);
      continue;
    }
    if (k === m - 1 && c === mc) { // the market hall (and the guildhall in a city) over the market
      const items = C ? [civ('guildhall'), civ('markethall')] : [civ('markethall'), lot('timberM', 'M')];
      const b = row(P, x0, x1, fc, items, 2);
      dressBlock(P, r, x0, x1, y0, fc, C ? 'city' : 'town', b, G.PLAZA);
      prop(P, 'noticeboard', b[0].x - 0.5 < x0 ? b[0].x + b[0].w + 0.5 : b[0].x - 0.5, fc - 0.4, 0);
      continue;
    }
    if (plazaBlock(c, k)) { // a small district plaza
      const h = bh(k);
      fill(P, x0, y0, wd, h, G.PLAZA);
      P.squares.push({ x: x0, y: y0, w: wd, h, kind: 'plaza' });
      const mx = x0 + wd / 2, my = y0 + h / 2;
      prop(P, (k + c) % 2 ? 'fountain' : 'statue', mx, my, (k + c) % 4);
      for (const [tx, ty] of [[x0, y0], [x1, y0], [x0, fc], [x1, fc]]) prop(P, 'tree', tx + 0.5, ty + 0.5, (tx + ty) % 4);
      prop(P, 'bench', x0 + 2.5, y0 + 0.5, 0);
      prop(P, 'bench', x1 - 1.5, y0 + 0.5, 1);
      prop(P, lampKind, x0 + 1.5, fc + 0.5, 0);
      prop(P, lampKind, x1 - 1.5, fc + 0.5, 0);
      continue;
    }
    const rank = k === m - 1 || k === m ? 'M' : 'S';
    // the v2 counts per block (so every bucket keeps its lots), now as singles with 2-tile gaps
    const key = C ? (rank === 'M' ? 'townhouseM' : 'townhouse') : rank === 'M' ? 'timberM' : 'timber';
    const [w] = DIM[key], v2w = c === cc ? (C ? 16 : 11) : 11; // the v2 block width
    let n = fit(v2w, w, 1);
    if (C) { n = 1; while ((n + 1) * w + Math.ceil((n + 1) / 2) - 1 <= v2w) n++; } // v2's townhouse pairs
    const items = many(n, key, rank), gap = 2; // singles, 2 tiles apart
    const b = row(P, x0, x1, fc, items, gap);
    dressBlock(P, r, x0, x1, y0, fc, C ? 'city' : 'town', b, G.PLAZA);
    prop(P, lampKind, x0 + 0.5, st[k] + 0.15, 0);
    if (C) prop(P, lampKind, x1 + 0.5, st[k] + 0.15, 0);
  }
  // square: fountain in the middle, clock tower in a corner, trees, benches, banners
  const sqTop = top[m], sqBot = st[m];
  place(P, civ('clocktower'), cx1 - 2, sqTop);
  const fx = cx0 + Math.floor(CWd / 2), fy = sqTop + Math.floor(BH / 2);
  prop(P, 'fountain', fx, fy, 0);
  for (const tx of [cx0, cx1]) for (const ty of [sqTop, sqBot - 1]) if (!isFoot(P, tx, ty)) prop(P, 'tree', tx + 0.5, ty + 0.5, (tx + ty) % 4);
  for (const ty of [sqTop + 2, sqBot - 3]) { prop(P, 'tree', cx0 + 0.5, ty + 0.5, ty % 4); prop(P, 'tree', cx1 + 0.5, ty + 0.5, (ty + 1) % 4); }
  prop(P, 'flowers', fx - 1.5, fy + 1.5, 1);
  prop(P, 'flowers', fx + 1.5, fy - 1.5, 2);
  prop(P, 'bench', fx - 2.5, sqBot - 0.5, 0);
  prop(P, 'bench', fx + 1.5, sqBot - 0.5, 1);
  prop(P, 'bench', cx0 + 1.5, fy + 0.5, 0, { dir: 'y' });
  if (C) {
    prop(P, 'statue', cx0 + 2.5, sqTop + 0.6, 0);
    prop(P, 'statue', cx1 - 3.5, sqBot - 0.5, 1);
    prop(P, 'lamppost', fx - 1.5, sqTop + 0.5, 0);
    prop(P, 'lamppost', fx + 1.5, sqTop + 0.5, 0);
    prop(P, 'banner', cx0 + 4.5, sqTop - 0.6, 0);
    prop(P, 'banner', cx0 + 11.5, sqTop - 0.6, 1);
  } else {
    prop(P, 'lamp', fx - 1.5, sqBot - 0.5, 0);
    prop(P, 'noticeboard', cx0 + 0.5, sqBot - 0.5, 0);
  }
  // market stalls in rows with walkways, a cart and crates at the edges
  for (let y = mkt.y; y < mkt.y + mkt.h; y += 2) for (let xx = mkt.x + 1; xx + 2 <= mkt.x + mkt.w - 1; xx += 3) prop(P, 'stall', xx + 1, y + 0.5, Math.floor(r() * 8), { dir: 'x' });
  prop(P, 'cart', mkt.x + 0.5, mkt.y + mkt.h - 0.5, 0);
  prop(P, 'crate', mkt.x + mkt.w - 0.5, mkt.y + 0.5, 0);
  prop(P, 'barrel', mkt.x + mkt.w - 0.5, mkt.y + mkt.h - 0.5, 0);
  // ring dressing: orchard trees round a town, the green belt of a city
  if (C) greenBelt(P);
  else {
    for (let xx = 1; xx < W - 1; xx += 3) { if (get(P, xx, 0) === G.ORCHARD) prop(P, 'tree', xx + 0.5, 0.5, xx % 4); if (get(P, xx, H - 1) === G.ORCHARD) prop(P, 'tree', xx + 0.5, H - 0.5, (xx + 1) % 4); }
    for (let y = 1; y < H - 1; y += 3) { if (get(P, 0, y) === G.ORCHARD) prop(P, 'tree', 0.5, y + 0.5, 2); if (get(P, W - 1, y) === G.ORCHARD) prop(P, 'tree', W - 0.5, y + 0.5, 3); }
  }
  return P;
}

// The cathedral fronting the square across two bands; the manor and two townhouses (2 apart) front the square
// beside it, and a townhouse on each side stands behind them on a two-row lane off the cross street; the
// rest is the lawn and gardens of the close.
function cathedralClose(P, x0, x1, y0, fc) {
  const kx = x0 + ((x1 - x0 + 1 - 6) >> 1); // the nave in the middle, 2+ tiles clear of the houses each side
  place(P, civ('cathedral'), kx, fc - 8);
  const front = [place(P, lot('manor', 'L'), x0, fc - 4), place(P, lot('townhouse', 'M'), x1 - 5, fc - 3), place(P, lot('townhouse', 'M'), x1 - 1, fc - 3)];
  fill(P, x0, fc - 7, 4, 2, G.LANE);
  fill(P, x1 - 3, fc - 7, 4, 2, G.LANE);
  place(P, lot('townhouseM', 'M'), x0, fc - 10);
  place(P, lot('townhouseM', 'M'), x1 - 2, fc - 10);
  for (let y = y0; y < fc; y++) for (let x = x0; x <= x1; x++) {
    if (isFoot(P, x, y) || get(P, x, y) === G.LANE) continue;
    P.g[y * P.w + x] = x >= x0 + 4 && x <= x1 - 4 ? G.LAWN : G.GARDEN;
  }
  for (let x = x0; x <= x1; x++) if (!isFoot(P, x, fc)) P.g[fc * P.w + x] = G.PLAZA;
  for (let y = y0; y < fc - 8; y++) prop(P, 'tree', kx + 0.5 + ((y * 3) % 6), y + 0.5, y % 4);
  for (const tx of [x0 + 4, kx - 1, kx + 6, x1 - 4]) prop(P, 'tree', tx + 0.5, fc - 6.5, tx % 4);
  prop(P, 'lamppost', x0 + 4.5, fc - 0.5, 0);
  prop(P, 'lamppost', x1 - 2.5, fc - 0.5, 0);
  prop(P, 'flowers', x1 - 3.5, fc - 1.5, 1);
  prop(P, 'bench', kx - 0.5, fc - 2.5, 0, { dir: 'y' });
  prop(P, 'laundry', x0 + 1.5, fc - 4.5, 0);
  prop(P, 'flowers', x1 - 1.5, fc - 4.5, 0);
  return front;
}

// A city's green belt: trees along the outer lawn, lampposts and benches between them facing the boulevard.
function greenBelt(P) {
  const { w: W, h: H } = P;
  const dress = (x, y, i, tree) => {
    if (get(P, x, y) !== G.LAWN) return;
    const k = i % 8;
    if (k % 2 === 1) prop(P, tree, x + 0.5, y + 0.5, i % 4);
    else if (k === 2) prop(P, 'lamppost', x + 0.5, y + 0.5, 0);
    else if (k === 6) prop(P, 'bench', x + 0.5, y + 0.5, i % 2);
  };
  for (let x = 1; x < W - 1; x++) { dress(x, 0, x, 'tree'); dress(x, H - 1, x + 1, 'tree'); }
  for (let y = 1; y < H - 1; y++) { dress(0, y, y, 'pine'); dress(W - 1, y, y + 1, 'pine'); }
  for (const [tx, ty] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) prop(P, 'tree', tx + 0.5, ty + 0.5, (tx + ty) % 4);
}

// ---- finishing: mirror, door spurs, connectivity, props, lots ------------------------------------------
function mirror(P) {
  const { w, h } = P;
  for (let y = 0; y < h; y++) { const a = P.g.subarray(y * w, y * w + w); a.reverse(); }
  for (const b of P.blds) b.x = w - b.x - b.w;
  for (const q of P.squares) q.x = w - q.x - q.w;
  if (P.plaza) P.plaza.x = w - P.plaza.x - P.plaza.w;
  for (const p of P.props) { p.x = w - p.x; if (p.kind === 'fence' && p.dir === 'x') p.x -= p.len; }
  P.occ.fill(0);
  P.blds.forEach((b, i) => { for (let j = b.y; j < b.y + b.h; j++) for (let x = b.x; x < b.x + b.w; x++) P.occ[j * w + x] = i + 1; });
}
const doorTile = b => [b.x + Math.floor((b.w * 8) / 16), b.y + b.h];
const edge = (P, x, y) => x === 0 || y === 0 || x === P.w - 1 || y === P.h - 1;

// A door that opens onto non-walkable ground gets a short yard path to the nearest walkable tile.
function spurs(P, code) {
  const { w, h } = P;
  for (const b of P.blds) {
    if (!b.door) continue;
    const [dx, dy] = doorTile(b);
    if (WALKABLE.has(get(P, dx, dy))) continue;
    const prev = new Int32Array(w * h).fill(-1), q = [dy * w + dx];
    prev[q[0]] = q[0];
    let hit = -1;
    for (let qi = 0; qi < q.length && hit < 0; qi++) {
      const i = q[qi], x = i % w, y = (i / w) | 0;
      for (const [ax, ay] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (!inside(P, ax, ay)) continue;
        const j = ay * w + ax;
        if (prev[j] >= 0 || P.occ[j]) continue;
        const g = P.g[j];
        if (WALKABLE.has(g)) { prev[j] = i; hit = j; break; }
        if (edge(P, ax, ay) || g === G.WATER) continue;
        prev[j] = i;
        q.push(j);
      }
    }
    if (hit < 0) continue;
    for (let i = prev[hit]; ; i = prev[i]) { P.g[i] = code; if (prev[i] === i) break; }
  }
}
// Walkable tiles that cannot reach a gate become garden (back yards with no way out).
function connect(P) {
  const { w, h, g } = P, seen = new Uint8Array(w * h), q = [];
  for (let i = 0; i < w * h; i++) { const x = i % w, y = (i / w) | 0; if (edge(P, x, y) && WALKABLE.has(g[i])) { seen[i] = 1; q.push(i); } }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi], x = i % w, y = (i / w) | 0;
    for (const [ax, ay] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (!inside(P, ax, ay)) continue;
      const j = ay * w + ax;
      if (!seen[j] && WALKABLE.has(g[j])) { seen[j] = 1; q.push(j); }
    }
  }
  for (let i = 0; i < w * h; i++) if (WALKABLE.has(g[i]) && !seen[i]) g[i] = g[i] === G.YARD ? G.GARDEN : G.LAWN;
  for (let i = 0; i < w * h; i++) if (g[i] === G.NONE) g[i] = G.GARDEN;
}
function finishProps(P) {
  const doors = new Set(P.blds.filter(b => b.door).map(b => doorTile(b).join(',')));
  const used = new Set(), out = [];
  for (const p of P.props) {
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (!inside(P, tx, ty) || P.occ[ty * P.w + tx] || doors.has(`${tx},${ty}`)) continue;
    if (p.kind !== 'fence' && p.kind !== 'bridge') {
      const k = `${tx},${ty}`;
      if (used.has(k)) continue;
      if (P.g[ty * P.w + tx] === G.WATER) continue;
      used.add(k);
    }
    out.push(p);
  }
  return out;
}

function generate(tier, s, seed, countOnly = false) {
  const r = rng(seedNum(seed) ^ Math.imul(tier + 1, 0x9e3779b1) ^ Math.imul(s + 1, 0x85ebca6b));
  const bits = seedNum(seed);
  const P = tier <= 1 ? rural(tier, s, r) : urban(tier, s, r, bits & 2 ? 1 : -1, tier === 2 && bits % 3 === 0);
  if (countOnly) return P.blds.filter(b => b.kind === 'lot').length;
  if (bits & 1) mirror(P);
  spurs(P, tier <= 1 ? G.YARD : G.LANE);
  connect(P);
  const props = finishProps(P);
  const pl = P.plaza, pcx = pl.x + pl.w / 2, pcy = pl.y + pl.h / 2;
  const order = { L: 0, M: 1, S: 2 };
  const lots = P.blds.filter(b => b.kind === 'lot')
    .map(b => ({ b, d: Math.hypot(b.x + b.w / 2 - pcx, b.y + b.h / 2 - pcy) }))
    .sort((a, c) => order[a.b.rank] - order[c.b.rank] || a.d - c.d || a.b.y - c.b.y || a.b.x - c.b.x)
    .map(({ b }, i) => ({ id: `L${i}`, x: b.x, y: b.y, w: b.w, h: b.h, doorX: b.w * 8, rank: b.rank, look: b.look }));
  const n = {};
  const civic = P.blds.filter(b => b.kind === 'civic').map(b => {
    const c = n[b.look] = (n[b.look] || 0) + 1;
    const o = { id: c > 1 ? `${b.look}-${c - 1}` : b.look, look: b.look, x: b.x, y: b.y, w: b.w, h: b.h };
    if (b.door) o.doorX = b.w * 8;
    return o;
  });
  const gates = [];
  for (let y = 0; y < P.h; y++) for (let x = 0; x < P.w; x++) if (edge(P, x, y) && WALKABLE.has(P.g[y * P.w + x])) gates.push([x, y]);
  return { tier, w: P.w, h: P.h, cap: lots.length, ground: P.g, lots, civic, props, squares: P.squares, plaza: { ...pl }, gates };
}

const clampTier = t => Math.max(0, Math.min(3, Math.floor(Number(t) || 0)));
const capMemo = new Map();
function capAt(tier, s) {
  const k = tier * 1000 + s;
  if (!capMemo.has(k)) capMemo.set(k, generate(tier, s, 0, true));
  return capMemo.get(k);
}
function stepFor(tier, lots) {
  const n = Math.max(1, Math.floor(Number(lots) || 0));
  let s = 0;
  while (capAt(tier, s) < n) s++;
  return s;
}

// The lot capacity bucket planSettlement builds for: the smallest growth step with room for `lots`.
export function capacityFor(tier, lots) {
  const t = clampTier(tier);
  return capAt(t, stepFor(t, lots));
}

// Deterministic in (tier, seed, capacityFor(tier, lots)).
export function planSettlement({ tier = 0, seed = 0, lots = 0 } = {}) {
  const t = clampTier(tier);
  const p = generate(t, stepFor(t, lots), seed);
  p.cap = capAt(t, stepFor(t, lots));
  return p;
}
