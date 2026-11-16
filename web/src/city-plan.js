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
    // An x-direction fence along row y0, split into runs that stop at building footprints (never through one).
    const fenceX = v => {
      for (let a = x; a < x + pw;) {
        if (isFoot(P, a, y0)) { a++; continue; }
        let b = a;
        while (b + 1 < x + pw && !isFoot(P, b + 1, y0)) b++;
        prop(P, 'fence', a, y0 + 0.05, v, { dir: 'x', len: b - a + 1 });
        a = b + 1;
      }
    };
    if (code === G.FIELD) {
      fenceX(0);
      if (pw >= 3) prop(P, 'scarecrow', x + 1 + Math.floor(r() * (pw - 2)) + 0.5, y0 + 1 + Math.floor(r() * Math.max(1, y1 - y0)) + 0.5, Math.floor(r() * 4));
    } else if (code === G.ORCHARD) {
      for (let yy = y0; yy <= y1; yy += 2) for (let xx = x + (yy % 2); xx < x + pw; xx += 2) prop(P, 'tree', xx + 0.5, yy + 0.5, 2 + Math.floor(r() * 2));
      if (r() < 0.6) prop(P, 'beehive', x + 0.5, y1 + 0.5, Math.floor(r() * 4));
    } else if (code === G.PASTURE) {
      fenceX(1);
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
function connect(P, lock = null) {
  const locked = i => !!lock && (i % P.w) >= lock.x && (i % P.w) < lock.x + lock.w && ((i / P.w) | 0) >= lock.y && ((i / P.w) | 0) < lock.y + lock.h;
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
  for (let i = 0; i < w * h; i++) if (WALKABLE.has(g[i]) && !seen[i] && !locked(i)) g[i] = g[i] === G.YARD ? G.GARDEN : G.LAWN;
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
// Plot size of a fresh plan (seed-independent): the size a ring wrapped round an older plan grows to at least.
const dimMemo = new Map();
function dimsAt(tier, s) {
  const k = tier * 1000 + s;
  if (!dimMemo.has(k)) { const p = generate(tier, s, 0); dimMemo.set(k, { w: p.w, h: p.h }); }
  return dimMemo.get(k);
}

// The lot capacity bucket planSettlement builds for: the smallest growth step with room for `lots`.
export function capacityFor(tier, lots) {
  const t = clampTier(tier);
  return capAt(t, stepFor(t, lots));
}

// ---- nested growth (design decision: decor never shrinks on tier-up) ---------------------------
// A plan grows by WRAPPING the plan it grew from: the old plan is kept whole (every lot, civic and prop at the same
// tile and variant, the same lot ids, the same ground) at a fixed offset `nest = { from, dx, dy }` inside the new one,
// and a ring of the new tier's streets, house rows and decor is built round it (a new tier also gets its civic band:
// the village green with chapel, inn and smithy; the town square with guildhall, clock tower and market; the city's
// square with the cathedral). So the plan for tier N+1 is a superset of tier N's: higher tiers only add.
// A plan is named by its `chain`, e.g. '0.2>1.0>2.1': the fresh plan '0.2' (tier.step) wrapped by a tier-1 ring sized
// like a fresh tier-1 step-0 plan, then by a tier-2 ring sized like step 1. Hosts persist `plan.chain` and pass it back
// as `from` on the next re-plan; plans are deterministic in (seed, chain). Without `from` (or after a tier drop)
// the plan is fresh, exactly as before nesting.
//
// LINK FORMAT (versioned, M7): a link is `<tier>.<step><tag>`. The tag names the rule that grew this link:
//   no tag   v1 ring (wrap): a full ring round the old plan, sized like a fresh (tier, step) plan. Every chain saved before
//            M7 has only untagged links, and they replay byte-identically forever (test/city-plan-golden.test.mjs).
//   a b c d  v2 thin growth (thinWrap): the old plan stays in one corner and the plot grows only away from it, by the
//            new tier's civic band and `step` extra bands; a = south-east, b = south-west, c = north-east, d = north-west.
// The first link is always untagged (a fresh plan). Links of different rules mix freely in one chain ('0.2>1.0a>2.1'):
// each link is applied to the plan before it by its own rule. A new rule takes new letters (or a longer tag, up to 3
// lowercase letters), never a new meaning for an old one; a tag this code does not know makes the chain unreadable, so
// it plans fresh. The planner picks the tag: `grow` absent = v1 (classic callers), `grow` given = v2 (planSettlement).
const CHAIN_MAX = 128;   // a longer (corrupt) chain plans fresh
const THIN = { a: [1, 1], b: [-1, 1], c: [1, -1], d: [-1, -1] };   // v2 tag -> [east +1 / west -1, south +1 / north -1]
const LINK = /^([0-3])\.(\d{1,3})([a-z]{0,3})$/;
const KNOWN_TAGS = new Set(['', ...Object.keys(THIN)]);
export function parseChain(from) {
  if (typeof from !== 'string' || !from) return null;
  const parts = from.split('>');
  if (parts.length > CHAIN_MAX) return null;
  const out = [];
  for (const p of parts) {
    const m = LINK.exec(p);
    if (!m || !KNOWN_TAGS.has(m[3]) || (m[3] && !out.length)) return null;
    out.push(m[3] ? [Number(m[1]), Number(m[2]), m[3]] : [Number(m[1]), Number(m[2])]);
  }
  for (let i = 1; i < out.length; i++) if (out[i][0] < out[i - 1][0]) return null;
  return out;
}
const chainKey = c => c.map(([t, s, tag = '']) => `${t}.${s}${tag}`).join('>');

function freshPlan(t, s, seed) {
  const p = generate(t, s, seed);
  p.cap = capAt(t, s);
  p.chain = `${t}.${s}`;
  p.nest = null;
  return p;
}
function buildChain(chain, seed) {
  let p = freshPlan(chain[0][0], chain[0][1], seed);
  for (let i = 1; i < chain.length; i++) {
    const [t, st, tag] = chain[i], key = chainKey(chain.slice(0, i + 1));
    p = tag ? thinWrap(p, t, st, seed, i, key, tag) : wrap(p, t, st, seed, i, key);
  }
  return p;
}

// The new tier's civic band pieces, west to east: buildings (b) and open squares (q), with the gap after each.
function civicPieces(t, r, flip) {
  let a;
  if (t === 1) a = [{ b: civ('inn'), g: 1 }, { q: 'green', w: 8, g: 1 }, { b: civ('chapel'), g: 1 }, { b: civ('smithy'), g: 0 }];
  else if (t === 2) a = [{ b: civ('guildhall'), g: 2 }, { q: 'square', w: 12, g: 0 }, { q: 'market', w: 9, g: 2 }, { b: civ('markethall'), g: 2 }, { b: lot('manor', 'L'), g: 0 }];
  else a = [{ b: lot('manor', 'L'), g: 2 }, { b: civ('guildhall'), g: 2 }, { q: 'square', w: 14, g: 2 }, { b: civ('cathedral'), g: 2 }, { b: civ('markethall'), g: 2 }, { q: 'market', w: 9, g: 0 }];
  if (flip) { a.reverse(); for (let i = 0; i < a.length; i++) a[i].g = i < a.length - 1 ? a[i + 1].g : 0; }
  return a;
}
const piecesW = ps => ps.reduce((n, p) => n + (p.b ? p.b.w : p.w) + p.g, 0);

// What every grown plan builds with (old ring and thin growth alike): tier constants, a band of houses, the civic band,
// the edge dressing. Each call draws from `r` in the same order as the code it replaced, so plans stay byte-identical.
function ringKit(P, t, r) {
  const urbanT = t >= 2, C = t === 3;
  const style = TIERS[t], sw = urbanT ? 2 : 1, gr = 2, HB = gr + 3 + 1 + sw, e = 1;
  const LN = urbanT ? G.STREET : G.LANE, fcCode = urbanT ? G.PLAZA : G.YARD;
  const edgeCode = C ? G.LAWN : urbanT ? G.ORCHARD : G.PASTURE;
  const lampKind = C ? 'lamppost' : 'lamp';
  const houseKey = rank => (C ? (rank === 'M' ? 'townhouseM' : 'townhouse') : urbanT ? (rank === 'M' ? 'timberM' : 'timber') : t === 1 ? 'cottage' : 'farmhouse');
  const gap = urbanT ? 2 : 1;
  // A band of houses on [xa..xb] x [y0..y0+hb-1]: gardens, the row, its forecourt and a street that runs on to xs0..xs1.
  const band = (xa, xb, y0, hb, rank, xs0, xs1) => {
    const fc = y0 + hb - sw - 1;
    fill(P, xa, y0, xb - xa + 1, fc - y0 + 1, G.GARDEN);
    const key = houseKey(rank), [w] = DIM[key], n = fit(xb - xa + 1 - 2, w, gap);
    const houses = n > 0 ? row(P, xa + 1, xb - 1, fc, many(n, key, rank), gap) : [];
    dressBlock(P, r, xa, xb, y0, fc, style, houses, fcCode);
    fill(P, xs0, fc + 1, xs1 - xs0 + 1, sw, LN);
    if (urbanT) prop(P, lampKind, xa + 0.5, fc + 1 + 0.15, 0);
    return houses;
  };
  // The civic band (a new tier's centre) on rows [y..y+HBc-1], across the plot: squares and civic buildings centred,
  // rows of M houses either side, the street along its foot.
  const civicBand = (pieces, y, HBc) => {
    const W = P.w, civics = [];
    const fc = y + HBc - sw - 1, tot = piecesW(pieces), xa = e, xb = W - 1 - e;
    fill(P, xa, y, xb - xa + 1, fc - y + 1, G.GARDEN);
    let x = xa + ((xb - xa + 1 - tot) >> 1);
    const left = [xa, x - 1], right = [x + tot, xb];
    for (const pc of pieces) {
      if (pc.b) civics.push(place(P, pc.b, x, fc - pc.b.h));
      else {
        const q = { x, y, w: pc.w, h: fc - y + 1, kind: pc.q };
        fill(P, q.x, q.y, q.w, q.h, pc.q === 'green' ? G.LAWN : pc.q === 'market' ? G.MARKET : G.PLAZA);
        P.squares.push(q);
        if (pc.q !== 'market') P.plaza = { x: q.x, y: q.y, w: q.w, h: q.h };
        dressSquare(P, r, q, t);
      }
      x += (pc.b ? pc.b.w : pc.w) + pc.g;
    }
    const sideRow = ([a, b]) => {
      const key = houseKey('M'), [w] = DIM[key], n = fit(b - a + 1 - 2, w, gap);
      return n > 0 && b - a + 1 >= w + 2 ? row(P, a + 1, b - 1, fc, many(n, key, 'M'), gap) : [];
    };
    const hs = [...sideRow(left), ...sideRow(right)];
    dressBlock(P, r, xa, xb, y, fc, style, [...hs, ...civics].sort((a, b) => a.x - b.x), fcCode);
    fill(P, 0, fc + 1, W, sw, LN);
  };
  // the edge: a hedge round a village, orchard trees round a town, the tree-lined lawn belt round a city (`skip(x, y)`:
  // tiles that are not this ring's, e.g. the old plan where it reaches the plot edge)
  const dressEdge = (skip = null) => {
    const W = P.w, H = P.h;
    const edgeAt = (x, yy) => !(skip && skip(x, yy)) && (get(P, x, yy) === edgeCode || (!urbanT && get(P, x, yy) === G.FIELD));
    for (let x = 1; x < W - 1; x += 3) {
      if (edgeAt(x, 0)) prop(P, urbanT ? 'tree' : 'bush', x + 0.5, 0.5, x % 4);
      if (edgeAt(x, H - 1)) prop(P, urbanT ? 'tree' : 'bush', x + 0.5, H - 0.5, (x + 1) % 4);
    }
    for (let yy = 1; yy < H - 1; yy += 3) {
      if (edgeAt(0, yy)) prop(P, C ? 'pine' : urbanT ? 'tree' : 'bush', 0.5, yy + 0.5, 2);
      if (edgeAt(W - 1, yy)) prop(P, C ? 'pine' : urbanT ? 'tree' : 'bush', W - 0.5, yy + 0.5, 3);
    }
  };
  // the plot: edge ground, (rural) field rows north and south, garden inside; then the old plan locked in at (dx, dy)
  const ground = (core, dx, dy) => {
    const W = P.w, H = P.h, cw = core.w, ch = core.h;
    fill(P, 0, 0, W, H, edgeCode);
    if (!urbanT) { fill(P, 0, 0, W, 1, G.FIELD); fill(P, 0, H - 1, W, 1, G.FIELD); }
    fill(P, e, e, W - 2 * e, H - 2 * e, G.GARDEN);
    // the old plan: its footprints block the ring, its tiles are locked
    for (const b of [...core.lots, ...core.civic]) for (let j = b.y; j < b.y + b.h; j++) for (let i = b.x; i < b.x + b.w; i++) P.occ[(j + dy) * W + i + dx] = -1;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) P.g[(j + dy) * W + i + dx] = core.ground[j * cw + i];
    return { x: dx, y: dy, w: cw, h: ch };
  };
  return { urbanT, C, style, sw, HB, e, LN, houseKey, gap, band, civicBand, dressEdge, ground };
}

// Wrap `core` (a plan) in a ring of tier `t` sized at least like a fresh (t, s) plan. `depth` salts the rng.
function wrap(core, t, s, seed, depth, key) {
  const fresh = core.tier < t;
  const r = rng(seedNum(seed) ^ Math.imul(t + 1, 0x9e3779b1) ^ Math.imul(s + 1, 0x85ebca6b) ^ Math.imul(depth + 7, 0xc2b2ae35));
  const pieces = fresh ? civicPieces(t, r, !!(seedNum(seed) & 2)) : [];
  const { w: tw, h: th } = dimsAt(t, s);
  const cw = core.w, ch = core.h, urbanT = t >= 2, minWs = urbanT ? 6 : 5;
  const sw = urbanT ? 2 : 1, e = 1, HB = 2 + 3 + 1 + sw;
  const HBc = fresh ? Math.max(HB, Math.max(...pieces.map(p => (p.b ? p.b.h : 0))) + 1 + sw + 1) : HB;
  const ws = Math.max(minWs, Math.ceil((tw - 2 * e - 2 * sw - cw) / 2), Math.ceil((piecesW(pieces) + 2 - 2 * sw - cw) / 2));
  const nBands = Math.max(2, Math.ceil((th - 2 * e - ch - sw - (HBc - HB)) / HB));
  const nN = nBands >> 1, nS = nBands - nN;
  const W = 2 * e + 2 * ws + 2 * sw + cw;
  const dx = e + ws + sw, dy = e + nN * HB;
  const H = dy + ch + sw + HBc + (nS - 1) * HB + e;
  const P = grid(W, H);
  P.tier = t;
  const K = ringKit(P, t, r), { band, LN } = K;
  const lock = K.ground(core, dx, dy);
  // north bands (the last one's street is the ring road along the old plan's north edge)
  for (let k = 0; k < nN; k++) band(e, W - 1 - e, e + k * HB, HB, 'S', 0, W - 1);
  // the ring road west, east and south of the old plan
  fill(P, dx - sw, dy, sw, ch, LN);
  fill(P, dx + cw, dy, sw, ch, LN);
  fill(P, 0, dy + ch, W, sw, LN);
  // side bands beside the old plan, each with a street out to the plot edge and in to the ring road
  const nSide = Math.floor(ch / HB), y1 = dy + ch - nSide * HB;
  for (let k = 0; k < nSide; k++) {
    band(e, dx - sw - 1, y1 + k * HB, HB, 'S', 0, dx - sw - 1);
    band(dx + cw + sw, W - 1 - e, y1 + k * HB, HB, 'S', dx + cw + sw, W - 1);
  }
  // south: the civic band (a new tier's centre) or a plain band, then plain bands to the south edge
  let y = dy + ch + sw;
  if (fresh) { K.civicBand(pieces, y, HBc); y += HBc; }
  for (let k = fresh ? 1 : 0; k < nS; k++) { band(e, W - 1 - e, y, HB, k === 0 ? 'M' : 'S', 0, W - 1); y += HB; }
  K.dressEdge();
  connect(P, lock);
  return assemble(P, core, dx, dy, key);
}

// v2 thin growth (link tags a-d, see parseChain): the old plan stays whole in one CORNER of the new plot and the plot only
// grows away from it, by as little as the new lots and the new tier's centre need:
//   - bands of houses across the whole new width on one side (south: a ring road along the old plan's south edge first,
//     so its gates stay connected; north: the band nearest the old plan has its street along the old plan's north edge),
//     the new tier's civic band (green / square / cathedral close) nearest the old plan;
//   - a side strip east or west only when the civic band is wider than the old plan: a street along the old plan's side,
//     side bands of houses when it is wide enough, the edge.
// So a cap step grows one side by one band (HB = 7 village / 8 town and city) plus the street and the edge, and a tier-up
// grows one side by the civic band and, when the old plan is narrower than the civic band, a second side to its width.
// The corner is the tag: a = grow south-east, b = south-west, c = north-east, d = north-west. `s` = extra plain bands.
function thinDims(core, t, s) {
  const fresh = core.tier < t, urbanT = t >= 2, sw = urbanT ? 2 : 1, e = 1, HB = 2 + 3 + 1 + sw;
  const pieces = fresh ? civicPieces(t, () => 0, false) : [];   // widths and heights only (the order does not matter)
  const HBc = fresh ? Math.max(HB, Math.max(...pieces.map(p => (p.b ? p.b.h : 0))) + 1 + sw + 1) : HB;
  let X = Math.max(0, piecesW(pieces) + 2 * e - core.w);
  if (X > 0) X = Math.max(X, sw + 1 + e);
  const bands = HBc + s * HB;
  return { X, north: e + bands, south: sw + bands + e, sw, e, HB, HBc };
}
function thinWrap(core, t, s, seed, depth, key, tag) {
  const [gx, gy] = THIN[tag];
  const fresh = core.tier < t;
  const r = rng(seedNum(seed) ^ Math.imul(t + 1, 0x9e3779b1) ^ Math.imul(s + 1, 0x85ebca6b) ^ Math.imul(depth + 7, 0xc2b2ae35) ^ Math.imul(tag.charCodeAt(0), 0x27d4eb2f));
  const pieces = fresh ? civicPieces(t, r, !!(seedNum(seed) & 2)) : [];
  const { X, north, south, sw, e, HB, HBc } = thinDims(core, t, s);
  const cw = core.w, ch = core.h, Y = gy > 0 ? south : north;
  const W = cw + X, H = ch + Y, dx = gx > 0 ? 0 : X, dy = gy > 0 ? 0 : Y;
  const P = grid(W, H);
  P.tier = t;
  const K = ringKit(P, t, r), { band, LN } = K;
  const lock = K.ground(core, dx, dy);
  const inLock = (x, y) => x >= dx && x < dx + cw && y >= dy && y < dy + ch;
  // the bands, nearest the old plan first: the civic band (a new tier) or an M band, then S bands outwards
  const n = 1 + s, hs = k => (k === 0 ? (fresh ? HBc : HB) : HB);
  let y = gy > 0 ? ch + sw : dy;
  if (gy > 0) fill(P, 0, ch, W, sw, LN);   // the ring road along the old plan's south edge
  for (let k = 0; k < n; k++) {
    const h = hs(k);
    if (gy < 0) y -= h;
    if (k === 0 && fresh) K.civicBand(pieces, y, h);
    else band(e, W - 1 - e, y, h, k === 0 ? 'M' : 'S', 0, W - 1);
    if (gy > 0) y += h;
  }
  // the side strip beside the old plan: a street along its side (edge to edge of the old plan's rows, on to the bands'
  // street or ring road), then side bands whose streets run out to the plot edge
  if (X > 0) {
    const rx = gx > 0 ? cw : X - sw, y0 = gy > 0 ? 0 : dy, y1 = gy > 0 ? ch : H;
    fill(P, rx, y0, sw, y1 - y0, LN);
    const xa = gx > 0 ? cw + sw : e, xb = gx > 0 ? W - 1 - e : X - sw - 1;
    const [hw] = DIM[K.houseKey('S')];
    if (xb - xa + 1 >= hw + 2) {
      const rows = ch - e, nSide = Math.floor(rows / HB), top = gy > 0 ? ch - nSide * HB : H - e - nSide * HB;
      for (let k = 0; k < nSide; k++) band(xa, xb, top + k * HB, HB, 'S', gx > 0 ? xa : 0, gx > 0 ? W - 1 : xb);
    }
  }
  K.dressEdge(inLock);
  connect(P, lock);
  return assemble(P, core, dx, dy, key);
}

// The grown plan: the old plan shifted by (dx, dy), then what was built round it (P: the new plot, the old one locked in it).
function assemble(P, core, dx, dy, key) {
  const W = P.w, H = P.h;
  const props = finishProps(P);
  const sh = o => ({ ...o, x: o.x + dx, y: o.y + dy });
  const pl = P.plaza || sh(core.plaza), pcx = pl.x + pl.w / 2, pcy = pl.y + pl.h / 2;
  const order = { L: 0, M: 1, S: 2 };
  const base = core.lots.length;
  const lots = [...core.lots.map(sh), ...P.blds.filter(b => b.kind === 'lot')
    .map(b => ({ b, d: Math.hypot(b.x + b.w / 2 - pcx, b.y + b.h / 2 - pcy) }))
    .sort((a, c) => order[a.b.rank] - order[c.b.rank] || a.d - c.d || a.b.y - c.b.y || a.b.x - c.b.x)
    .map(({ b }, i) => ({ id: `L${base + i}`, x: b.x, y: b.y, w: b.w, h: b.h, doorX: b.w * 8, rank: b.rank, look: b.look }))];
  const n = {};
  for (const c of core.civic) n[c.look] = (n[c.look] || 0) + 1;
  const civic = [...core.civic.map(sh), ...P.blds.filter(b => b.kind === 'civic').map(b => {
    const c = n[b.look] = (n[b.look] || 0) + 1;
    const o = { id: c > 1 ? `${b.look}-${c - 1}` : b.look, look: b.look, x: b.x, y: b.y, w: b.w, h: b.h };
    if (b.door) o.doorX = b.w * 8;
    return o;
  })];
  const gates = [];
  for (let yy = 0; yy < H; yy++) for (let x = 0; x < W; x++) if (edge(P, x, yy) && WALKABLE.has(P.g[yy * W + x])) gates.push([x, yy]);
  return {
    tier: P.tier, w: W, h: H, cap: lots.length, ground: P.g, lots, civic,
    props: [...core.props.map(sh), ...props], squares: [...core.squares.map(sh), ...P.squares],
    plaza: { ...pl }, gates, chain: key, nest: { from: core.chain, dx, dy, plan: core },
  };
}

// A new tier's square, green or market: its centrepiece and dressing.
function dressSquare(P, r, q, t) {
  const cx = q.x + q.w / 2, cy = q.y + q.h / 2;
  if (q.kind === 'market') {
    for (let y = q.y; y < q.y + q.h; y += 2) for (let xx = q.x + 1; xx + 2 <= q.x + q.w - 1; xx += 3) prop(P, 'stall', xx + 1, y + 0.5, Math.floor(r() * 8), { dir: 'x' });
    prop(P, 'cart', q.x + 0.5, q.y + q.h - 0.5, 0);
    prop(P, 'crate', q.x + q.w - 0.5, q.y + 0.5, 0);
    return;
  }
  if (q.kind === 'green') {
    prop(P, 'maypole', cx - 1.5, cy, 0);
    prop(P, 'well', cx + 1.5, cy, 0);
    prop(P, 'tree', q.x + 0.5, q.y + 0.5, 0);
    prop(P, 'tree', q.x + q.w - 0.5, q.y + 0.5, 1);
    prop(P, 'bench', q.x + 0.5, q.y + q.h - 0.5, 0);
    prop(P, 'bench', q.x + q.w - 0.5, q.y + q.h - 0.5, 1);
    prop(P, 'flowers', cx - 2.5, q.y + 0.5, 1);
    return;
  }
  const C = t === 3;
  if (C) {
    prop(P, 'fountain', Math.floor(cx), Math.floor(cy), 0);
    prop(P, 'statue', q.x + 1.5, q.y + 0.6, 0);
    prop(P, 'statue', q.x + q.w - 1.5, q.y + 0.6, 1);
    prop(P, 'lamppost', cx - 2.5, q.y + q.h - 0.5, 0);
    prop(P, 'lamppost', cx + 2.5, q.y + q.h - 0.5, 0);
  } else {
    place(P, civ('clocktower'), q.x + q.w - 3, q.y);
    prop(P, 'fountain', Math.floor(cx), Math.floor(cy), 0);
    prop(P, 'lamp', cx - 2.5, q.y + q.h - 0.5, 0);
    prop(P, 'noticeboard', q.x + 0.5, q.y + q.h - 0.5, 0);
  }
  prop(P, 'tree', q.x + 0.5, q.y + 0.5, 1);
  prop(P, 'bench', cx - 1.5, q.y + q.h - 0.5, 0);
  prop(P, 'bench', cx + 1.5, q.y + q.h - 0.5, 1);
  prop(P, 'flowers', cx - 1.5, cy + 1.5, 2);
}

// Deterministic in (tier, seed, capacityFor(tier, lots)) and, with `from` (the `chain` of the plan the host drew
// before this re-plan), in that chain: the result contains the `from` plan unchanged at `plan.nest` = { from, dx, dy }
// when the tier did not drop. Every plan carries `chain` (persist it) and `nest` (null for a fresh plan).
export function planSettlement({ tier = 0, seed = 0, lots = 0, from = null, grow = null } = {}) {
  const t = clampTier(tier);
  const need = Math.max(1, Math.floor(Number(lots) || 0));
  const chain = parseChain(from);
  if (!chain || chain[chain.length - 1][0] > t) return freshPlan(t, stepFor(t, lots), seed);
  const prev = buildChain(chain, seed);
  if (prev.tier === t && prev.lots.length >= need) return prev;
  const at = (s, tag) => `${chainKey(chain)}>${t}.${s}${tag}`;
  if (!grow) {
    for (let s = 0; ; s++) {
      const p = wrap(prev, t, s, seed, chain.length, at(s, ''));
      if (p.lots.length >= need || s >= 400) return p;
    }
  }
  // v2 thin growth: the fewest extra bands that hold the lots (the lot count is the same in every corner), then the corner
  // with room for it (grow.room, see growCorner), else the default, a (south-east)
  for (let s = 0; ; s++) {
    const p = thinWrap(prev, t, s, seed, chain.length, at(s, 'a'), 'a');
    if (p.lots.length < need && s < 400) continue;
    const tag = growCorner(thinDims(prev, t, s), grow.room);
    return tag === 'a' ? p : thinWrap(prev, t, s, seed, chain.length, at(s, tag), tag);
  }
}

// The corner for a thin growth of dims d (thinDims) given `room`: { se, sw, ne, nw } (any may be missing), each an array
// R where R[g] is the most the block can grow vertically (toward that corner) when it grows g tiles horizontally (toward
// it) and still keeps its gap to everything round it; -1 or a missing entry: no room. The corner that fits with the most
// vertical room to spare wins (it is likeliest to fit the next growth too); ties go a, b, c, d; none fits: a.
const ROOM_KEYS = { a: 'se', b: 'sw', c: 'ne', d: 'nw' };
function growCorner(d, room) {
  if (!room || typeof room !== 'object') return 'a';
  let best = 'a', slack = -1;
  for (const tag of Object.keys(THIN)) {
    const R = room[ROOM_KEYS[tag]], dv = THIN[tag][1] > 0 ? d.south : d.north;
    const v = Array.isArray(R) && Number.isInteger(R[d.X]) ? R[d.X] - dv : -1;
    if (v >= 0 && v > slack) { best = tag; slack = v; }
  }
  return best;
}
