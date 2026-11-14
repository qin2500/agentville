// agentville.base layout: flat land, no sea. The square is the hub, a one-tile street ring runs round each block, and a
// lane joins every ring to the square (the shortest way round the blocks: a plain breadth-first search, no A*).
import { LAYOUT_GROUND, ROAD, LOT } from '#agentville/mod';

const PAD = 8;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function layout({ settlements, square }) {
  const rects = [square, ...settlements.map(s => s.block)];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  const ox = x0 - PAD, oy = y0 - PAD, w = x1 - x0 + 2 * PAD, h = y1 - y0 + 2 * PAD;
  const n = w * h, at = (x, y) => (y - oy) * w + (x - ox);
  const terrain = new Uint8Array(n).fill(1);   // class 1: land
  const ground = new Uint8Array(n), road = new Uint8Array(n), lot = new Int8Array(n);
  const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const blocks = settlements.map(s => s.block);
  const inBlock = new Uint8Array(n);
  for (const b of blocks) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) inBlock[at(x, y)] = 1;
  // the square: the hub
  for (let y = square.y; y < square.y + square.h; y++) for (let x = square.x; x < square.x + square.w; x++) {
    const i = at(x, y);
    if (!inBlock[i]) { ground[i] = LAYOUT_GROUND.HUB; road[i] = ROAD.MAIN; lot[i] = LOT.HUB; }
  }
  // a street ring round each block (ground is never written inside a block)
  for (const b of blocks) {
    for (let y = b.y - 1; y <= b.y + b.h; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) {
      const i = at(x, y);
      if (inBlock[i] || ground[i] === LAYOUT_GROUND.HUB) continue;
      ground[i] = LAYOUT_GROUND.EDGE; road[i] = ROAD.STREET;
    }
  }
  // lanes: breadth-first from the square round the blocks; each ring's nearest tile is traced back to the square
  const from = new Int32Array(n).fill(-1), queue = [];
  for (let y = square.y; y < square.y + square.h; y++) for (let x = square.x; x < square.x + square.w; x++) { from[at(x, y)] = at(x, y); queue.push(at(x, y)); }
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k], x = ox + i % w, y = oy + ((i / w) | 0);
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy, j = at(nx, ny);
      if (nx < ox || ny < oy || nx >= ox + w || ny >= oy + h || inBlock[j] || from[j] >= 0) continue;
      from[j] = i; queue.push(j);
    }
  }
  for (const b of blocks) {
    const ring = { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 };
    let i = queue.find(q => ground[q] === LAYOUT_GROUND.EDGE && inside(ring, ox + q % w, oy + ((q / w) | 0)));
    for (; i !== undefined && from[i] !== i; i = from[i]) if (!ground[i]) { ground[i] = LAYOUT_GROUND.ROUTE; road[i] = ROAD.LANE; }
  }
  const bounds = { ox, oy, w, h };
  return { bounds, focus: { ...bounds }, tiles: { ox, oy, w, h, terrain, ground, road, lot } };
}
