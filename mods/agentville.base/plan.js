// agentville.base planner: a grid of 2x2 'box' plots around a small square plaza. Pure and deterministic.
export const GROUND = { NONE: 0, GRASS: 1, PATH: 2, PLAZA: 3, WATER: 4 };
const G = GROUND;

// Layout (tile units), with `half` plot columns each side of a one-tile spine path:
//   plot rows (3 tall: 2 building + 1 street) / 5x5 plaza band (ring path round a 3x3 plaza) / plot rows.
// Every plot door faces south onto the street row below it; street rows and the spine are all path tiles.
export function planGrid({ tier = 0, seed = 0, lots = 1 }, ctx) {
  const n = Math.max(1, lots | 0);
  const half = Math.max(1, Math.ceil(Math.sqrt(n) / 2));
  const cols = half * 2, rows = Math.ceil(n / cols);
  const rowsTop = Math.ceil(rows / 2), rowsBot = rows - rowsTop;
  const spine = 1 + 3 * half;                 // spine column
  const w = 3 + 6 * half;
  const plazaY = 1 + 3 * rowsTop;             // top of the 5x5 ring
  const h = plazaY + 5 + 3 * rowsBot + 1;
  const ground = new Array(w * h).fill(G.GRASS);
  const set = (x, y, c) => { ground[y * w + x] = c; };
  const rand = ctx.rng(`plan:${tier}:${seed}:${n}`);

  for (let y = 1; y < h - 1; y++) set(spine, y, G.PATH);                       // spine
  const streets = [];
  for (let r = 0; r < rowsTop; r++) streets.push(1 + 3 * r + 2);
  for (let r = 0; r < rowsBot; r++) streets.push(plazaY + 5 + 3 * r + 2);
  for (const y of streets) for (let x = 1; x < w - 1; x++) set(x, y, G.PATH);  // street rows
  for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) {              // ring + plaza
    const ring = dx === 0 || dx === 4 || dy === 0 || dy === 4;
    set(spine - 2 + dx, plazaY + dy, ring ? G.PATH : G.PLAZA);
  }

  // Slot order: top rows then bottom rows, left to right.
  const slots = [];
  const rowYs = [];
  for (let r = 0; r < rowsTop; r++) rowYs.push(1 + 3 * r);
  for (let r = 0; r < rowsBot; r++) rowYs.push(plazaY + 5 + 3 * r);
  for (const y of rowYs) {
    for (let i = 0; i < half; i++) slots.push({ x: 1 + 3 * i, y });
    for (let i = 0; i < half; i++) slots.push({ x: 2 + 3 * half + 3 * i, y });
  }
  const lotList = slots.slice(0, n).map((s, i) => ({
    id: `plot${i}`, look: 'box', rank: i === 0 ? 'M' : 'S', x: s.x, y: s.y, w: 2, h: 2, doorX: 8, door: true,
  }));
  // Rows that ended up empty keep their street; fine, they stay connected via the spine.

  const props = [[0, 0], [2, 0], [0, 2], [2, 2]].map(([dx, dy]) => ({
    kind: 'marker', x: spine - 1 + dx, y: plazaY + 1 + dy, v: Math.floor(rand() * 4),
  }));
  return {
    w, h, ground, lots: lotList, civic: [], props,
    plaza: { x: spine - 1, y: plazaY + 1, w: 3, h: 3 }, squares: [], cap: lotList.length,
  };
}
