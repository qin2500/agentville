// Hay: a loose straw pile with a small tied bale. Flat ground decal, stays inside one 32x16 tile. Variants: 4 layouts.
import { Surf, ramp, jit, h2 } from './pa2-kit.js';

export const name = 'hay';
export const frames = 1;
export function extent() { return [-14, -10, 14, 8]; }

const STRAW = [ramp('#d8b34a'), ramp('#e0bd5a'), ramp('#c9a243'), ramp('#d9c070')];
const BAND = [120, 78, 44];
const LAYOUT = [
  { pile: [-2, 0, 9, 3.6], bale: [5, -1.5] },
  { pile: [2, 0.5, 9, 3.4], bale: [-6, -1] },
  { pile: [0, 0, 11, 4], bale: null },
  { pile: [-1, 1, 8, 3.2], bale: [6, -2] },
];

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) & 3, R = STRAW[v], L = LAYOUT[v], S = new Surf(extent());
  const [cx, cy, rx, ry] = L.pile;
  S.ell(cx, cy, rx, ry, (x, y, u, w) => {
    const n = h2(x, y, v) % 9;
    let k = u < -0.25 && w < 0.3 ? 3 : w > 0.35 ? 1 : 2;
    if (n === 0) k = Math.min(4, k + 1); else if (n === 1) k = Math.max(0, k - 1);
    return R[k];
  });
  // loose straws radiating from the pile
  for (let i = 0; i < 7; i++) {
    const a = h2(i, v, 3) % 360 * Math.PI / 180;
    S.set(cx + Math.cos(a) * (rx + 1), cy + Math.sin(a) * (ry + 0.6), R[(i & 1) ? 3 : 2]);
  }
  for (let i = 0; i < 5; i++) S.set(cx - 5 + h2(i, v, 5) % 11, cy - 2 + h2(i, v, 6) % 4, R[4]);
  if (L.bale) {
    const [bx, by] = L.bale;
    S.ell(bx, by - 2, 4.5, 3, (x, y, u, w) => (w > 0.4 ? R[0] : u < -0.2 && w < 0 ? R[4] : R[(h2(x, y, 9) & 3) === 0 ? 3 : 2]));
    S.ell(bx, by + 0.5, 4.5, 1.6, (x, y, u, w) => R[1]);
    for (let y = by - 3; y <= by + 1; y++) { S.set(bx - 1, y, BAND); S.set(bx + 2, y, BAND); }
  }
  S.outline();
  S.blit(g, fx, fy);
}
