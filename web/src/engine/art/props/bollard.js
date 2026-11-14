// Engine prop art: bollard (iron mooring post with a rope turn, original pixel art). Seam: name, frames, extent, draw.
// Stands on a pier deck (1x1 footprint, art centred on the tile), so it is drawn DECK px above the foot point. v: 0 black iron, 1 verdigris, 2 rust, 3 stone.
import { ramp, canvasOf } from './_quay-kit.js';

export const name = 'bollard';
export const frames = 1;
const DECK = 6;
const TONES = [ramp('#3d4150'), ramp('#3f6a60'), ramp('#7a4a38'), ramp('#a39a8c')];
const ROPE = ramp('#c9a96a');
export function extent() { return [-6, -DECK - 13 + 8, 7, 4 + 8]; }
export function draw(g, p, fx, fy) {
  const R = TONES[Math.abs((p && p.v | 0) % 4)], c = canvasOf(...extent());
  const y0 = 8 - DECK;   // centre of the 1x1 footprint, whose north corner is the pivot
  c.rect(-5, y0 - 1, 11, 3, [24, 18, 36], 90);            // contact shade on the deck
  // shaft (a slim waist), cylinder lit from the left
  for (let z = 0; z < 9; z++) {
    const hw = z < 2 ? 3 : z < 6 ? 2 : 3;
    for (let x = -hw; x <= hw - 1; x++) c.set(x, y0 - z, x < -hw + 1 ? R[3] : x < 0 ? R[2] : x < hw - 1 ? R[1] : R[0]);
  }
  // domed head with a lip
  for (let x = -4; x <= 3; x++) c.set(x, y0 - 9, x < -1 ? R[3] : x < 2 ? R[2] : R[1]);
  for (let x = -3; x <= 2; x++) c.set(x, y0 - 10, x < 0 ? R[4] : R[2]);
  for (let x = -2; x <= 1; x++) c.set(x, y0 - 11, R[3]);
  c.set(-2, y0 - 10, R[4]);
  // rope: two turns around the waist and a loose end on the deck
  for (let x = -2; x <= 2; x++) { c.set(x, y0 - 4, x < 0 ? ROPE[3] : ROPE[2]); c.set(x, y0 - 5, (x & 1) ? ROPE[2] : ROPE[1]); }
  c.set(3, y0 - 3, ROPE[2]); c.set(4, y0 - 2, ROPE[1]); c.set(5, y0 - 1, ROPE[1]);
  c.outline();
  c.flush(g, fx, fy);
}
