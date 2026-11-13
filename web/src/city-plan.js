// City planner (docs: va-city-spec "Growing towns"): turns a project's tier and lot count into a planned
// settlement on a plot of tiles. PURE: no DOM, no imports; node tests import it directly.
//
// Every tier is built from the same idea, the way real planned towns grow: rows of buildings sit on the
// NORTH side of east-west streets (doors face south, the viewer looks from the south-east), their backs
// are gardens and yards, and north-south lanes cut the rows into blocks. Character comes from the tier:
//   hamlet  a lane or two round a small green with a well; farmhouses, barn, windmill, granary, fields.
//   village a main street with a second row behind it, a green with well and maypole, the chapel facing
//           the green, smithy and inn on the main street, farmland round the edge.
//   town    a grid of streets, a central cobbled square with a fountain and clock tower, the guildhall and
//           the manor fronting it, a market square with stalls beside it and the market hall over it,
//           two-storey timber rows, yards and gardens behind, maybe a small canal.
//   city    walls with towers at the corners and flanking every gate, a cathedral fronting a big square,
//           market square, guildhall, terraces of tall townhouses, courtyards, a canal with bridges,
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
  inn: [4, 3], guildhall: [5, 4], clocktower: [2, 2], markethall: [5, 3], cathedral: [6, 8], walltower: [2, 2],
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
  const n = P.blds.length, c = it.look === 'wall' || it.look === 'walltower' ? G.WALL : G.LAWN;
  for (let j = y; j < y + it.h; j++) for (let i = x; i < x + it.w; i++) { P.occ[j * P.w + i] = n; P.g[j * P.w + i] = c; }
  return b;
}
const prop = (P, kind, x, y, v = 0, extra) => P.props.push(extra ? { kind, x, y, v, ...extra } : { kind, x, y, v });
// A row of buildings standing on the north side of street row yS (bottoms at yS - 1), centred in [x0, x1].
function row(P, x0, x1, yS, items, gap) {
  const tot = items.reduce((a, it) => a + it.w, 0) + gap * Math.max(0, items.length - 1);
  let x = x0 + ((x1 - x0 + 1 - tot) >> 1);
  const out = [];
  for (const it of items) { out.push(place(P, it, x, yS - it.h)); x += it.w + gap; }
  return out;
}
const many = (n, key, rank) => Array.from({ length: Math.max(0, n) }, () => lot(key, rank));
const fit = (width, w, gap) => Math.floor((width + gap) / (w + gap));
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];

// Decorate the open tiles of a house block [x0..x1] x [y0..yS-1]: front tiles (street just south) become
// flowers, the rest garden / yard / courtyard by style, with the props that go with each.
function dressBlock(P, r, x0, x1, y0, yS, style, houses) {
  for (let x = x0; x <= x1; x++) {
    let top = yS - 1;
    while (top >= y0 && !isFoot(P, x, top)) top--;
    // column x: open tiles from y0 .. (house top - 1) are its back; if no house in this column, a gap
    const house = top >= y0;
    for (let y = y0; y < yS; y++) {
      if (isFoot(P, x, y)) continue;
      if (house || get(P, x, y) !== G.GARDEN) continue;
      if (y === yS - 1) P.g[y * P.w + x] = G.FLOWERS;
    }
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
  // flower boxes and the odd barrel on the gaps between front doors
  for (let x = x0; x <= x1; x++) {
    const y = yS - 1;
    if (isFoot(P, x, y) || get(P, x, y) !== G.FLOWERS) continue;
    const roll = r();
    if (roll < 0.35) prop(P, 'flowerbox', x + 0.5, y + 0.6, Math.floor(r() * 4));
    else if (roll < 0.55) prop(P, style === 'hamlet' ? 'woodpile' : 'barrel', x + 0.5, y + 0.6, Math.floor(r() * 4));
    else if (roll < 0.7) prop(P, 'flowers', x + 0.5, y + 0.5, Math.floor(r() * 4));
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
function rural(tier, s, r) {
  const V = tier === 1;
  const per = V ? 2 : 1, colW = 4 * per, centerW = V ? 8 : 4;
  let cw = 1, ce = 1, nA = 1;
  const cyc = V ? 'aew' : 'ewa';
  for (let i = 0; i < s; i++) { const k = cyc[i % 3]; if (k === 'a') nA++; else if (k === 'e') ce++; else cw++; }
  const bandH = 4, hallH = 5, greenH = 3, farmH = V ? 4 : 3;
  const W = 2 + (cw + ce) * colW + 2 + centerW;
  const H = 2 + (nA - 1) * (bandH + 1) + hallH + 1 + greenH + 1 + farmH;
  const P = grid(W, H);
  const xL = 1 + cw * colW, cx0 = xL + 1, cx1 = xL + centerW, xR = cx1 + 1, ex0 = xR + 1;
  const house = V ? 'cottage' : 'farmhouse', style = V ? 'village' : 'hamlet';
  const LN = G.LANE, MAIN = V ? G.STREET : G.LANE;
  // the outer ring: fields north and south, pasture east and west, a hedge of bushes
  fill(P, 0, 0, W, H, G.PASTURE);
  fill(P, 0, 0, W, 1, G.FIELD);
  fill(P, 0, H - 1, W, 1, G.FIELD);
  const westSlot = j => 1 + j * 4 + 1, eastSlot = j => ex0 + j * 4; // gaps sit on the far side from the green
  let y = 1, lane0 = 0;
  for (let k = 0; k < nA; k++) {
    const hall = k === nA - 1, h = hall ? hallH : bandH, yS = y + h, rank = hall ? 'M' : 'S';
    fill(P, 1, y, W - 2, h, G.GARDEN);
    const built = [];
    for (let j = 0; j < cw * per; j++) built.push(place(P, lot(house, rank), westSlot(j), yS - 3));
    for (let j = 0; j < ce * per; j++) built.push(place(P, lot(house, rank), eastSlot(j), yS - 3));
    if (hall) {
      built.push(place(P, lot('hall', 'L'), cx0, yS - 5));
      if (V) {
        const ch = place(P, civ('chapel'), cx0 + 5, yS - 5);
        prop(P, 'noticeboard', cx0 + 4.5, yS - 0.4, 0);
        prop(P, 'tree', cx0 + 4.5, y + 0.5, 1);
        built.push(ch);
      }
    } else {
      for (let j = 0; j < per; j++) built.push(place(P, lot(house, rank), cx0 + j * 4, yS - 3));
    }
    dressBlock(P, r, 1, xL - 1, y, yS, style, built.filter(b => b.x < xL));
    dressBlock(P, r, cx0, cx1, y, yS, style, built.filter(b => b.x > xL && b.x < xR));
    dressBlock(P, r, xR + 1, W - 2, y, yS, style, built.filter(b => b.x > xR));
    fill(P, 0, yS, W, 1, LN);
    if (k === 0) lane0 = yS;
    y = yS + 1;
  }
  // the green band: the green in the middle, farm buildings (hamlet) or inn and smithy (village) beside it
  const gy = y, main = gy + greenH;
  fill(P, 1, gy, W - 2, greenH, G.GARDEN);
  const built = [];
  for (let j = 0; j < cw * per; j++) {
    const x = westSlot(j);
    if (V && j >= (cw - 1) * per) { // the column next to the green: the inn and its yard
      if (j === cw * per - 1) {
        built.push(place(P, civ('inn'), x - 1, main - 3));
        fill(P, x - 5, gy, 4, greenH, G.YARD);
        prop(P, 'cart', x - 3.5, gy + 1, 0);
        prop(P, 'barrel', x - 4.5, main - 0.5, 0);
        prop(P, 'crate', x - 1.5, main - 0.5, 1);
        prop(P, 'barrel', x - 4.5, gy + 0.5, 1);
      }
      continue;
    }
    if (!V && j === cw * per - 1) {
      built.push(place(P, civ('barn'), x - 1, main - 3));
      continue;
    }
    built.push(place(P, lot(house, 'M'), x, main - 3));
  }
  for (let j = 0; j < ce * per; j++) {
    const x = eastSlot(j);
    if (j === 0) {
      built.push(place(P, civ(V ? 'smithy' : 'windmill'), x, main - 3));
      if (V) { prop(P, 'woodpile', x + 3.5, gy + 0.5, 0); prop(P, 'trough', x + 3.5, main - 0.4, 0); }
      else prop(P, 'crate', x + 3.5, main - 0.5, 0);
      continue;
    }
    built.push(place(P, lot(house, 'M'), x, main - 3));
  }
  dressBlock(P, r, 1, cx0 - 2, gy, main, style, built.filter(b => b.x < xL));
  dressBlock(P, r, xR + 1, W - 2, gy, main, style, built.filter(b => b.x > xR));
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
  fill(P, 0, main, W, 1, MAIN);
  // the lanes round the green, the west one on south through the fields to a gate
  fill(P, xL, lane0, 1, main - lane0, LN);
  fill(P, xR, lane0, 1, main - lane0, LN);
  fill(P, xL, main, 1, H - main, LN);
  // farmland south of the main street
  const fy0 = main + 1, fy1 = H - 2;
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
  prop(P, 'signpost', W - 0.5, main + 1.4, 1);
  return P;
}

// ---- town and city ------------------------------------------------------------------------------------
function urban(tier, s, r, marketSide, canalOn) {
  const C = tier === 3, R = C ? 2 : 1, SW = 11, CWd = C ? 16 : 11, BH = C ? 5 : 4;
  let nN = C ? 2 : 1, nS = 1, cw = 1, ce = 1;
  for (let i = 0; i < s; i++) { const k = 'sewn'[i % 4]; if (k === 's') nS++; else if (k === 'e') ce++; else if (k === 'w') cw++; else nN++; }
  const cols = [];
  let x = R;
  for (let i = 0; i < cw; i++) { cols.push({ x0: x, x1: x + SW - 1 }); x += SW + 1; }
  cols.push({ x0: x, x1: x + CWd - 1, center: true }); x += CWd + 1;
  for (let i = 0; i < ce; i++) { cols.push({ x0: x, x1: x + SW - 1 }); x += SW + 1; }
  const W = x - 1 + R, nb = nN + 1 + nS, H = 2 * R + nb * (BH + 1);
  const P = grid(W, H);
  const cc = cw, m = nN, mc = cc + marketSide;
  const by0 = k => R + k * (BH + 1), st = k => by0(k) + BH;
  const { x0: cx0, x1: cx1 } = cols[cc];
  const lampKind = C ? 'lamppost' : 'lamp';
  // ring: a green belt of orchard (town) or the wall and a strip of lawn inside it (city)
  if (C) { fill(P, 0, 0, W, H, G.WALL); fill(P, 1, 1, W - 2, H - 2, G.LAWN); } else fill(P, 0, 0, W, H, G.ORCHARD);
  fill(P, R, R, W - 2 * R, H - 2 * R, G.GARDEN);
  // streets: one per band below its row, one between each pair of columns; the main ones leave the plot
  for (let k = 0; k < nb; k++) fill(P, R, st(k), W - 2 * R, 1, G.STREET);
  const nsx = cols.slice(0, -1).map(c => c.x1 + 1);
  for (const sx of nsx) fill(P, sx, R, 1, H - 2 * R, G.STREET);
  fill(P, 0, st(m), W, 1, G.STREET);
  fill(P, cx0 - 1, 0, 1, H, G.STREET);
  fill(P, cx1 + 1, 0, 1, H, G.STREET);
  if (C) fill(P, cx0, st(m - 2), CWd, 1, G.GARDEN); // the cathedral close spans two bands
  // the main square (with the street rows above and below it), the market square beside it
  const sq = { x: cx0, y: by0(m) - 1, w: CWd, h: BH + 2, kind: 'square' };
  fill(P, sq.x, sq.y, sq.w, sq.h, G.PLAZA);
  P.squares.push(sq);
  P.plaza = { x: sq.x, y: sq.y, w: sq.w, h: sq.h };
  const mk = cols[mc], mkt = { x: mk.x0, y: by0(m), w: SW, h: BH, kind: 'market' };
  fill(P, mkt.x, mkt.y, mkt.w, mkt.h, G.MARKET);
  P.squares.push(mkt);
  // canal behind the first band south of the square, bridged where streets cross it
  const canal = C || canalOn;
  if (canal) {
    const yc = by0(m + 1);
    for (let xx = R - 1; xx <= W - R; xx++) P.g[yc * W + xx] = nsx.includes(xx) || xx === cx0 - 1 || xx === cx1 + 1 ? G.BRIDGE : G.WATER;
    for (let xx = R; xx < W - R; xx++) if (get(P, xx, yc) === G.BRIDGE) prop(P, 'bridge', xx + 0.5, yc + 0.5, 0, { dir: 'y' });
  }
  const plazaBlock = (c, k) => C && !(c === cc && k === m) && ((c - cc) % 3 + 3) % 3 === 0 && ((k - m) % 3 + 3) % 3 === 0;
  for (let k = 0; k < nb; k++) for (let c = 0; c < cols.length; c++) {
    const { x0, x1 } = cols[c], y0 = by0(k), yS = st(k), wd = x1 - x0 + 1;
    if (k === m && (c === cc || c === mc)) continue;
    if (C && c === cc && (k === m - 2 || k === m - 1)) { if (k === m - 1) cathedralClose(P, r, x0, x1, by0(m - 2), yS); continue; }
    if (k === m - 1 && c === cc) { // town: the manor and the guildhall front the square
      const b = row(P, x0, x1, yS, [lot('manor', 'L'), civ('guildhall')], 1);
      dressBlock(P, r, x0, x1, y0, yS, 'town', b);
      prop(P, 'banner', b[1].x - 0.5, yS + 0.3, 0);
      prop(P, 'banner', b[1].x + b[1].w + 0.5, yS + 0.3, 1);
      continue;
    }
    if (k === m - 1 && c === mc) { // the market hall (and the guildhall in a city) over the market
      const items = C ? [civ('guildhall'), civ('markethall')] : [civ('markethall'), lot('timberM', 'M')];
      const b = row(P, x0, x1, yS, items, 1);
      dressBlock(P, r, x0, x1, y0, yS, C ? 'city' : 'town', b);
      prop(P, 'noticeboard', b[0].x - 0.5 < x0 ? b[0].x + b[0].w + 0.5 : b[0].x - 0.5, yS - 0.4, 0);
      continue;
    }
    if (plazaBlock(c, k)) { // a small district plaza
      fill(P, x0, y0, wd, BH, G.PLAZA);
      P.squares.push({ x: x0, y: y0, w: wd, h: BH, kind: 'plaza' });
      const mx = x0 + wd / 2, my = y0 + BH / 2;
      prop(P, (k + c) % 2 ? 'fountain' : 'statue', mx, my, (k + c) % 4);
      for (const [tx, ty] of [[x0, y0], [x1, y0], [x0, y0 + BH - 1], [x1, y0 + BH - 1]]) prop(P, 'tree', tx + 0.5, ty + 0.5, (tx + ty) % 4);
      prop(P, 'bench', x0 + 2.5, y0 + 0.5, 0);
      prop(P, 'bench', x1 - 1.5, y0 + 0.5, 1);
      prop(P, lampKind, x0 + 1.5, y0 + BH - 0.5, 0);
      prop(P, lampKind, x1 - 1.5, y0 + BH - 0.5, 0);
      continue;
    }
    const rank = k === m - 1 || k === m ? 'M' : 'S';
    let items;
    if (C) { const key = rank === 'M' ? 'townhouseM' : 'townhouse', [w] = DIM[key]; items = many(Math.floor((wd - 2) / w), key, rank); }
    else { const key = rank === 'M' ? 'timberM' : 'timber', [w] = DIM[key]; items = many(fit(wd, w, 1), key, rank); }
    const b = row(P, x0, x1, yS, items, C ? 0 : 1);
    dressBlock(P, r, x0, x1, y0, yS, C ? 'city' : 'town', b);
    prop(P, lampKind, x0 + 0.5, yS + 0.15, 0);
    if (C) prop(P, lampKind, x1 + 0.5, yS + 0.15, 0);
  }
  // square: fountain in the middle, clock tower in a corner, trees, benches, banners
  const sqTop = by0(m), sqBot = st(m);
  place(P, civ('clocktower'), cx1 - 2, sqTop);
  const fx = cx0 + Math.floor(CWd / 2), fy = sqTop + Math.floor(BH / 2);
  prop(P, 'fountain', fx, fy, 0);
  for (const tx of [cx0, cx1]) for (const ty of [sqTop, sqBot - 1]) if (!isFoot(P, tx, ty)) prop(P, 'tree', tx + 0.5, ty + 0.5, (tx + ty) % 4);
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
  for (let yy = mkt.y; yy < mkt.y + mkt.h; yy += 2) for (let xx = mkt.x + 1; xx + 2 <= mkt.x + mkt.w - 1; xx += 3) prop(P, 'stall', xx + 1, yy + 0.5, Math.floor(r() * 8), { dir: 'x' });
  prop(P, 'cart', mkt.x + 0.5, mkt.y + mkt.h - 0.5, 0);
  prop(P, 'crate', mkt.x + mkt.w - 0.5, mkt.y + 0.5, 0);
  prop(P, 'barrel', mkt.x + mkt.w - 0.5, mkt.y + mkt.h - 0.5, 0);
  // ring dressing: orchard trees round a town, the walls and towers of a city
  if (C) walls(P, R, cx0 - 1, cx1 + 1, st(m));
  else for (let xx = 1; xx < W - 1; xx += 3) { if (get(P, xx, 0) === G.ORCHARD) prop(P, 'tree', xx + 0.5, 0.5, xx % 4); if (get(P, xx, H - 1) === G.ORCHARD) prop(P, 'tree', xx + 0.5, H - 0.5, (xx + 1) % 4); }
  if (!C) for (let yy = 1; yy < H - 1; yy += 3) { if (get(P, 0, yy) === G.ORCHARD) prop(P, 'tree', 0.5, yy + 0.5, 2); if (get(P, W - 1, yy) === G.ORCHARD) prop(P, 'tree', W - 0.5, yy + 0.5, 3); }
  return P;
}

// The cathedral fronting the square across two bands, with the manor and townhouses on lanes beside it.
function cathedralClose(P, r, x0, x1, y0, yS) {
  const cat = place(P, civ('cathedral'), x0 + 5, yS - 8);
  const manor = place(P, lot('manor', 'L'), x0, yS - 4);
  fill(P, x0, yS - 5, 4, 1, G.LANE);
  const a = place(P, lot('townhouseM', 'M'), x0, yS - 8);
  const b = place(P, lot('townhouseM', 'M'), x1 - 2, yS - 3);
  fill(P, x1 - 3, yS - 4, 4, 1, G.LANE);
  const c = place(P, lot('townhouseM', 'M'), x1 - 2, yS - 7);
  for (let y = y0; y < yS; y++) for (let x = x0; x <= x1; x++) {
    if (isFoot(P, x, y) || get(P, x, y) === G.LANE) continue;
    P.g[y * P.w + x] = x === x0 + 4 || x === x1 - 4 || (x > x0 + 4 && x < x1 - 4) ? G.LAWN : G.GARDEN;
  }
  for (let y = y0; y < cat.y; y++) prop(P, 'tree', cat.x + 0.5 + ((y * 3) % 6), y + 0.5, y % 4);
  prop(P, 'tree', x0 + 4.5, yS - 6.5, 1);
  prop(P, 'tree', x1 - 3.5, yS - 6.5, 2);
  prop(P, 'lamppost', x0 + 4.5, yS - 0.5, 0);
  prop(P, 'lamppost', x1 - 3.5, yS - 0.5, 0);
  prop(P, 'flowers', x1 - 3.5, yS - 1.5, 1);
  for (const h of [a, c]) prop(P, r() < 0.5 ? 'laundry' : 'bush', h.x + 1.5, h.y - 0.5, 0);
  return [cat, manor, a, b, c];
}

// City walls: towers at the corners and flanking every gate, wall runs between them.
function walls(P, R, gx0, gx1, gy) {
  const { w: W, h: H } = P;
  const towers = [[0, 0], [W - 2, 0], [0, H - 2], [W - 2, H - 2]];
  for (const gx of [gx0, gx1]) for (const ty of [0, H - 2]) towers.push([gx - 2, ty], [gx + 1, ty]);
  for (const tx of [0, W - 2]) towers.push([tx, gy - 2], [tx, gy + 1]);
  for (const [tx, ty] of towers) if (!isFoot(P, tx, ty)) place(P, civ('walltower', false), tx, ty);
  const runs = (len, at, mk) => {
    let start = -1;
    for (let i = 0; i <= len; i++) {
      const ok = i < len && at(i);
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) { mk(start, i - start); start = -1; }
    }
  };
  const open = (x, y) => !isFoot(P, x, y) && get(P, x, y) === G.WALL;
  runs(W, i => open(i, 0), (a, n) => place(P, { kind: 'civic', look: 'wall', w: n, h: 1, door: false }, a, 0));
  runs(W, i => open(i, H - 1), (a, n) => place(P, { kind: 'civic', look: 'wall', w: n, h: 1, door: false }, a, H - 1));
  runs(H, j => open(0, j), (a, n) => place(P, { kind: 'civic', look: 'wall', w: 1, h: n, door: false }, 0, a));
  runs(H, j => open(W - 1, j), (a, n) => place(P, { kind: 'civic', look: 'wall', w: 1, h: n, door: false }, W - 1, a));
  // trees along the lawn inside the wall, a cart waiting at each gate
  for (let x = 3; x < W - 3; x += 4) { if (get(P, x, 1) === G.LAWN && !isFoot(P, x, 1)) P.props.push({ kind: 'tree', x: x + 0.5, y: 1.5, v: x % 4 }); if (get(P, x, H - 2) === G.LAWN && !isFoot(P, x, H - 2)) P.props.push({ kind: 'tree', x: x + 0.5, y: H - 1.5, v: (x + 1) % 4 }); }
  for (let y = 3; y < H - 3; y += 4) { if (get(P, 1, y) === G.LAWN && !isFoot(P, 1, y)) P.props.push({ kind: 'pine', x: 1.5, y: y + 0.5, v: 0 }); if (get(P, W - 2, y) === G.LAWN && !isFoot(P, W - 2, y)) P.props.push({ kind: 'pine', x: W - 1.5, y: y + 0.5, v: 1 }); }
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
    const o = { id: c > 1 || b.look === 'wall' || b.look === 'walltower' ? `${b.look}-${c - 1}` : b.look, look: b.look, x: b.x, y: b.y, w: b.w, h: b.h };
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
