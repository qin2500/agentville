// Engine prop art: skiff (a small moored rowing/sail boat, original pixel art). Seam: name, frames, extent, draw.
// Lies along `dir` ('x' default) on a 3x1 (dir x) or 1x3 (dir y) footprint, about 2.5 tiles long; the pivot is the
// footprint's north corner (render/slice.js). v: 0..3 picks hull and furled-sail colours.
import { ramp, canvasOf, hash, view, boxExtent } from './_quay-kit.js';

export const name = 'skiff';
export const frames = 1;
const HULLS = [ramp('#8a5e3a'), ramp('#3f6f9a'), ramp('#a2483c'), ramp('#5a7a50')];
const SAIL = ramp('#e8dcc0'), WOOD = ramp('#a67c52'), HALF = 20, BEAM = 7, GUN = 5;
const ctr = p => (p && p.dir === 'y' ? [8, 24] : [24, 8]);   // footprint centre; the sprite pivot is its north corner
const alongOf = p => (p && p.dir === 'y' ? 'y' : 'x');
export function extent(p) { const [cx, cy] = ctr(p); return boxExtent([alongOf(p) === 'x' ? [cx - HALF, cy - BEAM, cx + HALF, cy + BEAM, -2, 24] : [cx - BEAM, cy - HALF, cx + BEAM, cy + HALF, -2, 24]]); }
export function draw(g, p, fx, fy) {
  const v = Math.abs((p && p.v | 0) % 4), R = HULLS[v], ax = alongOf(p) === 'x', c = canvasOf(...extent(p));
  const [cx, cy] = ctr(p);
  const put = (a, b, z, col, al = 255) => { const [x, y] = ax ? view(a + cx, b + cy, z) : view(b + cx, a + cy, z); c.set(x, y, col, al); };
  const hw = a => BEAM * Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(a) / (HALF + 0.5), 3)));
  // soft shadow on the water
  for (let a = -HALF; a <= HALF; a += 0.5) for (let b = -hw(a); b <= hw(a) + 2; b += 1) put(a, b, -1, [20, 40, 70], 110);
  // far gunwale (inside face), then the cockpit floor, then the near hull
  for (let a = -HALF; a <= HALF; a += 0.5) for (let z = 2; z <= GUN; z++) put(a, -hw(a), z, z === GUN ? R[3] : R[0]);
  for (let a = -HALF + 3; a <= HALF - 3; a += 0.5) for (let b = -hw(a) + 1; b <= hw(a) - 1; b += 0.5) put(a, b, 2, (Math.floor(a / 3) & 1) ? WOOD[1] : WOOD[0]);
  for (let a = -4; a <= 4; a += 0.5) for (let b = -hw(a) + 1; b <= hw(a) - 1; b += 0.5) put(a, b, 3, WOOD[2]);   // thwart
  for (let a = -HALF; a <= HALF; a += 0.5) for (let z = 0; z <= GUN; z++) {
    const e = z === GUN ? R[4] : z === GUN - 1 ? R[3] : z === 0 ? R[0] : (hash(Math.floor(a / 3), z, v) & 7) === 0 ? R[1] : R[2];
    put(a, hw(a), z, e);
  }
  // stem: bow end face
  for (let z = 0; z <= GUN; z++) put(HALF, 0, z, R[1]);
  // mast with a furled sail on the boom and a pennant
  for (let z = GUN; z <= 22; z++) { put(0, 0, z, WOOD[1]); put(-0.5, 0.5, z, WOOD[3]); }
  for (let a = -10; a <= 6; a += 0.5) for (let z = 9; z <= 11; z++) put(a, 0, z, z === 11 ? SAIL[4] : z === 10 ? SAIL[3] : SAIL[1]);
  for (let a = -10; a <= 6; a += 4) put(a, 0, 10, R[2]);
  for (let i = 0; i < 4; i++) put(0, 0 + i * 0.5, 22 - (i & 1), R[3]);
  c.outline();
  c.flush(g, fx, fy);
}
