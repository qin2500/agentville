// Engine prop art: pier (wooden plank deck over water, original pixel art). Seam: name, frames, extent, draw.
// Two tiles wide, `len` tiles long, running along `dir` ('y' = toward the sea, default). The foot point is
// the footprint's north corner (the engine puts the sprite pivot there: render/slice.js); the deck top sits DECK px above the water, on pilings that dip below. v: 0..3 weathering of the boards.
import { ramp, canvasOf, hash, view, boxExtent } from './_quay-kit.js';

export const name = 'pier';
export const frames = 1;
export const DECK = 6, THICK = 3, PIER_W = 2;
const WOODS = [ramp('#a67c52'), ramp('#9a7048'), ramp('#b08a5c'), ramp('#8c6a48')];
const PILE = ramp('#5e4430');
const lenOf = p => Math.max(1, (p && p.len | 0) || 1);
const box = p => {
  const L = lenOf(p) * 16, Wd = PIER_W * 16;
  return p && p.dir === 'x' ? [0, 0, L, Wd, -6, DECK] : [0, 0, Wd, L, -6, DECK];
};
export function extent(p) { return boxExtent([box(p)]); }

export function draw(g, p, fx, fy, t, lit) {
  const R = WOODS[Math.abs((p && p.v | 0) % 4)], B = box(p), [x0, y0, x1, y1] = B, alongX = p && p.dir === 'x';
  const c = canvasOf(...extent(p));
  const set = (wx, wy, z, col) => { const [x, y] = view(wx, wy, z); c.set(x, y, col); };
  // pilings under the near edges, every tile border, dipping into the water
  for (let s = 0; s <= (alongX ? x1 : y1); s += 16) {
    for (const [wx, wy] of alongX ? [[s, y1 - 1]] : [[x1 - 1, s]]) {
      for (let z = B[4]; z < DECK - THICK; z++) for (let d = -1; d <= 1; d++) set(wx + (alongX ? d : 0), wy + (alongX ? 0 : d), z, d < 0 ? PILE[3] : d > 0 ? PILE[1] : PILE[2]);
    }
  }
  // far-side pilings peek out under the back edge
  // side faces (thickness THICK): +y face lit, +x face shaded, with a board seam line
  for (let wx = x0; wx <= x1; wx += 0.5) for (let z = DECK - THICK; z < DECK; z++) set(wx, y1, z, z === DECK - THICK ? R[1] : z === DECK - 1 ? R[4] : R[2]);
  for (let wy = y0; wy <= y1; wy += 0.5) for (let z = DECK - THICK; z < DECK; z++) set(x1, wy, z, z === DECK - THICK ? R[0] : z === DECK - 1 ? R[2] : R[1]);
  // top: boards across the run, 4 px wide, seams, light nail heads, a worn edge stripe
  const a0 = alongX ? x0 : y0;
  for (let y = Math.floor(extent(p)[1]); y < extent(p)[3]; y++) for (let x = Math.floor(extent(p)[0]); x < extent(p)[2]; x++) {
    const m = y + DECK, wx = x / 2 + m, wy = m - x / 2;
    if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
    const a = alongX ? wx : wy, b = alongX ? wy : wx, k = Math.floor((a - a0) / 4), r = Math.floor(a - a0) % 4;
    const h = hash(k, 3, p && p.v | 0), cross = Math.floor(b - (alongX ? y0 : x0));
    let col = R[2 + ((h & 3) === 0 ? 1 : (h & 3) === 1 ? -1 : 0)];
    if (r === 0) col = R[1];
    else if (r === 1 && (h & 4)) col = R[3];
    if ((h >> 4 & 7) === 0 && cross % 5 === 2 && r === 2) col = R[0];          // knot
    if (r === 2 && (cross === 1 || cross === PIER_W * 16 - 2)) col = R[4];       // nail heads
    if (b < (alongX ? y0 : x0) + 1.5 || b > (alongX ? y1 : x1) - 1.5) col = R[3]; // worn edge boards
    c.set(x, y, col);
  }
  c.outline();
  c.flush(g, fx, fy);
}
