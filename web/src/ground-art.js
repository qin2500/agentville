// Procedural ground tiles for the growing towns: one 16x16 tile per call, top-down, fillRect only.
// The chunk is later filtered (hue-rotate / saturate / contrast .68 / brightness .82), turned 45deg and
// squashed 2:1, so the colours here are a little punchier than they will finally read.
// Codes match GROUND in city-plan.js (kept local so this file imports nothing).
const NONE = 0, GRASS = 1, STREET = 2, LANE = 3, PLAZA = 4, MARKET = 5, YARD = 6, FIELD = 7, ORCHARD = 8,
  GARDEN = 9, LAWN = 10, PASTURE = 11, WATER = 12, BRIDGE = 13, WALL = 14, FLOWERS = 15;
export const GROUND_CODES = { NONE, GRASS, STREET, LANE, PLAZA, MARKET, YARD, FIELD, ORCHARD, GARDEN, LAWN, PASTURE, WATER, BRIDGE, WALL, FLOWERS };

// Integer hash of up to three ints -> 0..2^32.
const H = (a, b, c = 0) => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};
const pick = (arr, h) => arr[h % arr.length];
const PAVED = new Set([STREET, LANE, PLAZA, MARKET, YARD, BRIDGE]);

const SETT = ['#8d8379', '#9a8f84', '#85796f', '#a39688', '#938478'];
const SLAB = ['#d2c7b2', '#c9bda8', '#d9cfbb', '#c4b8a3'];
const BRICK = ['#c08a68', '#b57e5e', '#cd9876', '#ad7656'];
const GRASS_C = ['#70b04a', '#68a843', '#78b852'];
const WHEAT = ['#e0b43c', '#d6a832', '#eac24c'];

// ---- styled paving (style.paving = { kind, base, joint }); only STREET/LANE/PLAZA/MARKET read it ----
const hx = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mixC = (a, b, k) => '#' + a.map((v, i) => Math.max(0, Math.min(255, Math.round(v + (b[i] - v) * k))).toString(16).padStart(2, '0')).join('');
const WHITE = [255, 255, 255], BLACK = [20, 14, 30];
const PAVING_KINDS = new Set(['cobble', 'flagstone', 'brick', 'earth']);

function paintPaving(R, code, tx, ty, near, pv) {
  const kind = pv.kind, base = hx(pv.base), joint = pv.joint;
  // each code reads a little differently so streets, plazas, markets and lanes stay distinguishable
  const role = code === PLAZA ? mixC(base, WHITE, 0.12) : code === MARKET ? mixC(base, BLACK, 0.12) : code === LANE ? mixC(base, BLACK, 0.06) : pv.base;
  const rb = hx(role);
  const tone = (n) => mixC(rb, n > 0 ? WHITE : BLACK, Math.abs(n));
  const jit = h => [0, 0.06, -0.06, 0.11, -0.1][h % 5];
  const lit = mixC(rb, WHITE, 0.28), shade = mixC(rb, BLACK, 0.22);
  R(0, 0, 16, 16, joint);
  if (kind === 'cobble') {
    for (let r = 0; r < 4; r++) {
      const y = r * 4, wid = r & 1 ? [2, 4, 4, 4, 2] : [4, 4, 4, 4];
      let x = 0;
      for (let i = 0; i < wid.length; i++) {
        const w = wid[i], c = tone(jit(H(tx, ty, r * 7 + i + 1)));
        if (w === 4) { R(x + 1, y, 2, 4, c); R(x, y + 1, 4, 2, c); R(x + 1, y + 1, 2, 2, lit); }
        else R(x, y + 1, w, 2, c);
        x += w;
      }
    }
  } else if (kind === 'flagstone') {
    for (let r = 0; r < 2; r++) {
      const y = r * 8, off = ((ty * 2 + r) & 1) ? 4 : 0;
      for (let i = -1; i < 2; i++) {
        const x = i * 8 + off, c = tone(jit(H(tx, ty, r * 3 + i + 8))), x0 = Math.max(0, x), x1 = Math.min(16, x + 8);
        if (x1 - x0 <= 0) continue;
        R(x0, y, x1 - x0, 7, c); R(x0, y, x1 - x0, 1, lit);
        if (x >= 0) R(x, y, 1, 7, lit);
        if ((H(tx, ty, r * 5 + i + 20) & 7) === 0) R(x0 + 2, y + 3, 2, 1, shade);
      }
    }
  } else if (kind === 'brick') {
    // herringbone weave: 8x8 blocks of two 7x3 bricks, alternating direction, every other block-row shifted half a block
    for (let cj = 0; cj < 2; cj++) for (let ci = -1; ci < 2; ci++) {
      const bx = ci * 8 + (cj & 1 ? 4 : 0), by = cj * 8, vert = (ci + cj + tx + ty) & 1;
      for (let k = 0; k < 2; k++) {
        const c = tone(jit(H(tx, ty, cj * 9 + (ci + 1) * 2 + k + 60))), px = vert ? bx + k * 4 : bx, py = vert ? by : by + k * 4;
        const w = vert ? 3 : 7, h = vert ? 7 : 3, x0 = Math.max(0, px), x1 = Math.min(16, px + w);
        if (x1 <= x0) continue;
        R(x0, py, x1 - x0, h, c); R(x0, py, x1 - x0, 1, lit);
      }
    }
  } else { // earth: packed dirt with pebbles and a pair of faint ruts along the road
    R(0, 0, 16, 16, role);
    for (let i = 0; i < 14; i++) { const h = H(tx, ty, i + 40); R(h & 15, (h >> 4) & 15, 1 + (h >> 9) % 2, 1, (h >> 11) & 1 ? lit : shade); }
    for (let i = 0; i < 3; i++) { const h = H(tx, ty, i + 70); R(h & 13, (h >> 4) & 13, 2, 1, joint); }
    const road = c => c === LANE || c === STREET || c === PLAZA || c === MARKET || c === YARD;
    const hz = road(near(-1, 0)) || road(near(1, 0)), vz = road(near(0, -1)) || road(near(0, 1));
    const horiz = hz && !vz;
    if ((code === LANE || code === STREET) && (hz !== vz)) {
      if (horiz) { R(0, 4, 16, 2, joint); R(0, 10, 16, 2, joint); R(0, 6, 16, 1, lit); R(0, 12, 16, 1, lit); }
      else { R(4, 0, 2, 16, joint); R(10, 0, 2, 16, joint); R(6, 0, 1, 16, lit); R(12, 0, 1, 16, lit); }
    }
  }
  // edges: kerb for hard paving on streets; grass creeping in on lanes and earth
  if (code === STREET && kind !== 'earth') {
    const kerb = mixC(rb, WHITE, 0.34), kd = mixC(rb, BLACK, 0.3);
    if (!PAVED.has(near(0, -1))) { R(0, 0, 16, 2, kerb); R(0, 2, 16, 1, kd); }
    if (!PAVED.has(near(0, 1))) { R(0, 14, 16, 2, kerb); R(0, 13, 16, 1, kd); }
    if (!PAVED.has(near(-1, 0))) { R(0, 0, 2, 16, kerb); R(2, 0, 1, 16, kd); }
    if (!PAVED.has(near(1, 0))) { R(14, 0, 2, 16, kerb); R(13, 0, 1, 16, kd); }
  } else if (code === LANE || kind === 'earth') {
    const edge = (a, b, f) => { if (!PAVED.has(near(a, b))) for (let i = 0; i < 16; i += 2) { const h = H(tx, ty, i + a * 5 + b * 9 + 90); if (h & 3) f(i, 1 + (h >> 3) % 2); } };
    edge(0, -1, (i, n) => R(i, 0, 2, n, '#6aa845'));
    edge(0, 1, (i, n) => R(i, 16 - n, 2, n, '#6aa845'));
    edge(-1, 0, (i, n) => R(0, i, n, 2, '#6aa845'));
    edge(1, 0, (i, n) => R(16 - n, i, n, 2, '#6aa845'));
  }
}

export function paintGround(g, code, tx, ty, dx, dy, near, style) {
  const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(dx + x, dy + y, w, h); };
  const h0 = H(tx, ty);
  const is = (a, b, c) => near(a, b) === c;
  const pv = style && typeof style === 'object' ? style.paving : null;
  if (pv && PAVING_KINDS.has(pv.kind) && (code === STREET || code === LANE || code === PLAZA || code === MARKET)) {
    paintPaving(R, code, tx, ty, near, pv);
    return;
  }

  switch (code) {
    case STREET: {
      R(0, 0, 16, 16, '#5f564d'); // joints
      for (let r = 0; r < 4; r++) {
        const y = r * 4, odd = r & 1, wid = odd ? [2, 4, 4, 4, 2] : [4, 4, 4, 4];
        let x = 0;
        for (let i = 0; i < wid.length; i++) {
          const w = wid[i], c = pick(SETT, H(tx, ty, r * 7 + i + 1));
          if (w === 4) { R(x + 1, y, 2, 4, c); R(x, y + 1, 4, 2, c); R(x + 1, y + 1, 2, 2, '#aa9e90'); }
          else R(x, y + 1, w, 2, c);
          x += w;
        }
      }
      // kerb where the street meets anything that is not paved
      const kerb = '#cfc6b6', shade = '#7c7266';
      if (!PAVED.has(near(0, -1))) { R(0, 0, 16, 2, kerb); R(0, 2, 16, 1, shade); }
      if (!PAVED.has(near(0, 1))) { R(0, 14, 16, 2, kerb); R(0, 13, 16, 1, shade); }
      if (!PAVED.has(near(-1, 0))) { R(0, 0, 2, 16, kerb); R(2, 0, 1, 16, shade); }
      if (!PAVED.has(near(1, 0))) { R(14, 0, 2, 16, kerb); R(13, 0, 1, 16, shade); }
      break;
    }
    case LANE: {
      R(0, 0, 16, 16, '#a68a62');
      for (let i = 0; i < 14; i++) { const h = H(tx, ty, i + 40); R(h & 15, (h >> 4) & 15, 1 + (h >> 9) % 2, 1, (h >> 11) & 1 ? '#bfa57c' : '#8b7249'); }
      const lane = c => c === LANE || c === STREET || c === PLAZA || c === MARKET || c === YARD;
      const hz = lane(near(-1, 0)) || lane(near(1, 0)), vz = lane(near(0, -1)) || lane(near(0, 1));
      const horiz = hz && !vz ? true : vz && !hz ? false : (h0 & 1) === 0;
      if (horiz) { R(0, 4, 16, 2, '#7f6745'); R(0, 10, 16, 2, '#7f6745'); R(0, 6, 16, 1, '#b79d74'); R(0, 12, 16, 1, '#b79d74'); R(0, 7, 16, 3, '#9a7f58'); }
      else { R(4, 0, 2, 16, '#7f6745'); R(10, 0, 2, 16, '#7f6745'); R(6, 0, 1, 16, '#b79d74'); R(12, 0, 1, 16, '#b79d74'); R(7, 0, 3, 16, '#9a7f58'); }
      // grass creeping in from unpaved sides
      const edge = (a, b, f) => { if (!PAVED.has(near(a, b))) for (let i = 0; i < 16; i += 2) { const h = H(tx, ty, i + a * 5 + b * 9 + 90); if (h & 3) f(i, 1 + (h >> 3) % 2); } };
      edge(0, -1, (i, n) => R(i, 0, 2, n, '#6aa845'));
      edge(0, 1, (i, n) => R(i, 16 - n, 2, n, '#6aa845'));
      edge(-1, 0, (i, n) => R(0, i, n, 2, '#6aa845'));
      edge(1, 0, (i, n) => R(16 - n, i, n, 2, '#6aa845'));
      break;
    }
    case PLAZA: {
      R(0, 0, 16, 16, '#9d927e'); // joints
      for (let r = 0; r < 2; r++) {
        const y = r * 8, off = ((ty * 2 + r) & 1) ? 4 : 0;
        for (let i = -1; i < 2; i++) {
          const x = i * 8 + off, c = pick(SLAB, H(tx, ty, r * 3 + i + 8));
          const x0 = Math.max(0, x), x1 = Math.min(16, x + 8);
          if (x1 - x0 <= 0) continue;
          R(x0, y, x1 - x0, 7, c);
          R(x0, y, x1 - x0, 1, '#e6ddca'); // lit top edge
          if (x >= 0) R(x, y, 1, 7, '#e0d7c4');
          if ((H(tx, ty, r * 5 + i + 20) & 7) === 0) R(x0 + 2, y + 3, 2, 1, '#b3a791'); // a worn chip
        }
      }
      break;
    }
    case MARKET: {
      R(0, 0, 16, 16, '#7c5a44');
      for (let cj = 0; cj < 2; cj++) for (let ci = 0; ci < 2; ci++) {
        const x = ci * 8, y = cj * 8, vert = (ci + cj + tx + ty) & 1;
        for (let k = 0; k < 2; k++) {
          const c = pick(BRICK, H(tx, ty, cj * 4 + ci * 2 + k + 60));
          if (vert) { R(x + k * 4, y, 3, 7, c); R(x + k * 4, y, 3, 1, '#d8a888'); }
          else { R(x, y + k * 4, 7, 3, c); R(x, y + k * 4, 7, 1, '#d8a888'); }
        }
      }
      break;
    }
    case YARD: {
      R(0, 0, 16, 16, '#9c8458');
      for (let i = 0; i < 10; i++) { const h = H(tx, ty, i + 120); R(h & 15, (h >> 4) & 15, 1, 1, (h >> 9) & 1 ? '#7e673f' : '#b39a6c'); }
      for (let i = 0; i < 7; i++) { const h = H(tx, ty, i + 140), x = h & 11, y = (h >> 4) & 15; R(x, y, 3 + ((h >> 8) & 1), 1, i & 1 ? '#dcc470' : '#c9a84a'); if (h & 64) R(x + 1, y + 1, 2, 1, '#e8d488'); }
      break;
    }
    case FIELD: {
      // one variant per contiguous field: hash the field's north-west corner (found by walking out)
      let ox = 0, oy = 0;
      while (ox < 32 && near(-ox - 1, 0) === FIELD) ox++;
      while (oy < 32 && near(0, -oy - 1) === FIELD) oy++;
      const fx = tx - ox, fy = ty - oy, v = H(fx, fy, 5) % 6, horiz = (H(fx, fy, 9) & 1) === 0;
      // r: coordinate across the rows (world-continuous), a: along them
      const row = (x, y, w, h, c) => horiz ? R(x, y, w, h, c) : R(y, x, h, w, c);
      const gy = (ty * 16) & 15; void gy; // rows are 16-aligned per tile so they join seamlessly
      row(0, 0, 16, 16, v === 4 ? '#7a5636' : '#6f4f32');
      if (v === 0 || v === 1) { // wheat / barley: dense rows with grain heads
        const cs = v === 0 ? WHEAT : ['#6fae48', '#7cbc52', '#62a03f'], head = v === 0 ? '#f6dc7c' : '#a4dc78';
        for (let r = 0; r < 4; r++) {
          const c = cs[(H(tx, ty, r) % 3)];
          row(0, r * 4, 16, 3, c);
          for (let i = 0; i < 16; i += 2) if (H(tx, ty, r * 16 + i + 3) & 1) row(i, r * 4, 1, 1, head);
          if (v === 1 && r & 1) row(0, r * 4 + 1, 16, 1, '#58923a');
        }
      } else if (v === 2) { // cabbages
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
          const x = i * 8 + 1, y = j * 8 + 1, c = (i + j) & 1 ? '#86c460' : '#74b650';
          row(x + 1, y, 4, 6, c); row(x, y + 1, 6, 4, c);
          row(x + 2, y + 1, 2, 4, '#b4e486'); row(x + 1, y + 2, 4, 2, '#b4e486'); row(x + 2, y + 2, 2, 2, '#d6f2a8');
        }
      } else if (v === 3) { // lavender
        for (let r = 0; r < 2; r++) {
          row(0, r * 8 + 1, 16, 5, '#5c8c3c');
          for (let i = 0; i < 16; i += 2) { const h = H(tx, ty, r * 16 + i + 70); row(i, r * 8 + 1, 2, 4, h & 1 ? '#8d6cc4' : '#a487d6'); if (h & 6) row(i, r * 8, 1, 1, '#c3a8ee'); }
        }
      } else if (v === 4) { // ploughed furrows
        for (let r = 0; r < 4; r++) { row(0, r * 4, 16, 2, '#946a44'); row(0, r * 4 + 2, 16, 2, '#5e4128'); row(0, r * 4, 16, 1, '#a87c52'); }
        for (let i = 0; i < 4; i++) { const h = H(tx, ty, i + 80); row(h & 15, (h >> 4) & 15, 1, 1, '#b08a5e'); }
      } else { // sunflowers
        row(0, 0, 16, 16, '#4f8a3a');
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
          const x = i * 8 + 1 + ((j & 1) ? 1 : 0), y = j * 8 + 1;
          row(x, y + 1, 4, 3, '#f2c424'); row(x + 1, y, 2, 5, '#f2c424'); row(x + 1, y + 1, 2, 3, '#6e4520');
          row(x + 1, y + 5, 2, 2, '#3e7430');
        }
      }
      // headland: a strip of bare earth where the field ends
      for (const [a, b] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        if (near(a, b) === FIELD) continue;
        if (b === -1) R(0, 0, 16, 2, '#5c4128'); else if (b === 1) R(0, 14, 16, 2, '#5c4128');
        else if (a === -1) R(0, 0, 2, 16, '#5c4128'); else R(14, 0, 2, 16, '#5c4128');
      }
      break;
    }
    case ORCHARD: {
      R(0, 0, 16, 16, pick(GRASS_C, h0));
      for (let i = 0; i < 12; i++) { const h = H(tx, ty, i + 150); R(h & 15, (h >> 4) & 15, 1, 2, (h >> 9) & 1 ? '#5f9c3c' : '#86c45e'); }
      for (let i = 0; i < 5; i++) { const h = H(tx, ty, i + 170); R(h & 14, (h >> 4) & 14, 2, 2, (h >> 9) % 3 ? '#d84a38' : '#e8c040'); }
      break;
    }
    case GARDEN: {
      R(0, 0, 16, 16, '#a68a62'); // packed paths
      const horiz = (H(tx >> 2, ty >> 2, 13) & 1) === 0;
      const row = (x, y, w, h, c) => horiz ? R(x, y, w, h, c) : R(y, x, h, w, c);
      const crop = H(tx >> 1, ty >> 1, 17) % 3;
      for (const by of [0, 8]) {
        row(0, by, 16, 6, '#5e4228'); row(0, by, 16, 1, '#74543a');
        for (let i = 0; i < 16; i += 3) {
          const h = H(tx, ty, by + i + 200);
          if (crop === 0) { row(i, by + 1, 2, 4, '#5aa63e'); row(i, by + 1, 1, 1, '#9ad46c'); }
          else if (crop === 1) { row(i, by + 2, 2, 3, '#d8643a'); row(i, by + 1, 1, 1, '#4f9a38'); }
          else { row(i, by + 1, 2, 4, (h & 1) ? '#7cc050' : '#4f9a38'); }
        }
      }
      break;
    }
    case LAWN: {
      // stripes 4px wide, continuous over the lawn (parity of the stripe index from the tile coords)
      const s = horizontalStripe(tx, ty);
      for (let r = 0; r < 4; r++) R(0, r * 4, 16, 4, ((s + r) & 1) ? '#7cbc56' : '#6aa845');
      if ((h0 & 7) === 0) R(h0 >> 8 & 15, h0 >> 4 & 15, 1, 1, '#f4f0d0');
      break;
    }
    case PASTURE: {
      R(0, 0, 16, 16, '#648f3e');
      for (let i = 0; i < 16; i++) { const h = H(tx, ty, i + 230); R(h & 15, (h >> 4) & 15, 1, 2 + ((h >> 8) & 1), (h >> 10) % 3 === 0 ? '#86a84c' : (h >> 10) % 3 === 1 ? '#52803a' : '#7aa046'); }
      for (let i = 0; i < 3; i++) { const h = H(tx, ty, i + 250); R(h & 15, (h >> 4) & 15, 2, 1, '#b4b06a'); }
      break;
    }
    case WATER: {
      R(0, 0, 16, 16, '#3a88be');
      for (let i = 0; i < 4; i++) { const h = H(tx, ty, i + 300); R(h & 11, (h >> 4) & 15, 4, 1, i & 1 ? '#63aedc' : '#2f76a8'); }
      R(h0 & 7, (h0 >> 4) & 15, 3, 1, '#a8d8f0');
      // stone banks where the canal ends
      const bank = c => c !== WATER && c !== BRIDGE;
      const stone = '#a39a8d', edge = '#716a60', lite = '#c9c0b2';
      if (bank(near(0, -1))) { R(0, 0, 16, 3, stone); R(0, 0, 16, 1, lite); R(0, 3, 16, 1, edge); }
      if (bank(near(0, 1))) { R(0, 13, 16, 3, stone); R(0, 15, 16, 1, lite); R(0, 12, 16, 1, edge); }
      if (bank(near(-1, 0))) { R(0, 0, 3, 16, stone); R(0, 0, 1, 16, lite); R(3, 0, 1, 16, edge); }
      if (bank(near(1, 0))) { R(13, 0, 3, 16, stone); R(15, 0, 1, 16, lite); R(12, 0, 1, 16, edge); }
      break;
    }
    case BRIDGE: {
      const wl = near(-1, 0) === WATER, wr = near(1, 0) === WATER, wu = near(0, -1) === WATER, wd = near(0, 1) === WATER;
      const alongX = wu || wd; // water north/south: the deck runs east-west
      R(0, 0, 16, 16, '#a89c88');
      for (let i = 0; i < 4; i++) {
        const c = pick(SLAB, H(tx, ty, i + 400));
        if (alongX) { R(i * 4, 0, 3, 16, c); R(i * 4 + 3, 0, 1, 16, '#82786a'); }
        else { R(0, i * 4, 16, 3, c); R(0, i * 4 + 3, 16, 1, '#82786a'); }
      }
      const par = '#7a7064', top = '#bfb4a0';
      if (wu) { R(0, 0, 16, 3, par); R(0, 0, 16, 1, top); }
      if (wd) { R(0, 13, 16, 3, par); R(0, 13, 16, 1, top); }
      if (wl) { R(0, 0, 3, 16, par); R(0, 0, 1, 16, top); }
      if (wr) { R(13, 0, 3, 16, par); R(13, 0, 1, 16, top); }
      break;
    }
    case WALL: {
      R(0, 0, 16, 16, '#5a534c'); // mortar
      for (let r = 0; r < 4; r++) {
        const y = r * 4, off = (r + ty) & 1 ? 4 : 0;
        for (let i = -1; i < 2; i++) {
          const x = i * 8 + off, x0 = Math.max(0, x), x1 = Math.min(16, x + 7);
          if (x1 <= x0) continue;
          const c = pick(['#8d857a', '#7f776d', '#9a9286', '#868075'], H(tx, ty, r * 3 + i + 500));
          R(x0, y, x1 - x0, 3, c); R(x0, y, x1 - x0, 1, '#aaa296');
        }
      }
      if (near(0, 1) !== WALL) R(0, 13, 16, 3, '#4a443e'); // shadowed foot
      if (near(0, -1) !== WALL) R(0, 0, 16, 1, '#b9b1a3');
      break;
    }
    case FLOWERS: {
      R(0, 0, 16, 16, pick(GRASS_C, h0));
      for (let i = 0; i < 8; i++) { const h = H(tx, ty, i + 600); R(h & 15, (h >> 4) & 15, 1, 2, '#5f9c3c'); }
      const PET = ['#f06a8c', '#f4d84a', '#f2f2ea', '#9a7ae0', '#f08a3c', '#6aa8f0'];
      const fam = PET[H(tx >> 1, ty >> 1, 7) % 6];
      for (let i = 0; i < 9; i++) {
        const h = H(tx, ty, i + 620), x = 1 + (h & 13), y = 1 + ((h >> 4) & 13), c = (h >> 9) & 3 ? fam : PET[(h >> 12) % 6];
        R(x, y, 2, 2, c);
        if (!((h >> 16) & 3)) { R(x - 1, y, 1, 2, c); R(x + 2, y, 1, 2, c); R(x, y - 1, 2, 1, c); R(x, y + 2, 2, 1, c); R(x, y, 2, 2, '#f8e060'); }
      }
      break;
    }
    default:
      break;
  }
}

// Stripe phase so lawn stripes run unbroken across neighbouring tiles (4 stripes of 4px per tile).
function horizontalStripe(tx, ty) { return (ty * 4) & 1; }
