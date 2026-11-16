// Clover: a low patch of three-lobed leaves with tiny white / pink blooms. Flat decal. Variants: 4 patches.
import { Surf, ramp, h2 } from './pa2-kit.js';

export const name = 'clover';
export const frames = 1;
export function extent() { return [-12, -7, 12, 6]; }

const LEAF = ramp('#5fa04c'), LEAF2 = ramp('#4f9158');
const BLOOM = [[250, 246, 240], [244, 170, 196], [250, 246, 240], [236, 140, 176]];
const PATCH = [
  [[-6, 0], [-1, 2], [4, -1], [7, 2], [1, -2]],
  [[-5, 1], [0, -1], [5, 1], [-1, 3], [8, 0]],
  [[-7, -1], [-3, 2], [2, 0], [6, 2], [0, -3], [9, -1]],
  [[-4, 0], [1, 2], [6, 0], [-1, -2]],
];

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) & 3, S = new Surf(extent());
  PATCH[v].forEach(([cx, cy], i) => {
    const R = (i & 1) ? LEAF2 : LEAF;
    // a three-lobed leaf cluster: three small discs around a centre
    for (const [dx, dy] of [[-1.6, 0.2], [1.6, 0.2], [0, -1.2]]) S.ell(cx + dx, cy + dy, 1.9, 1.4, (x, y, u, w) => (w < -0.2 ? R[3] : w > 0.3 ? R[1] : R[2]));
    S.set(cx, cy, R[0]);
  });
  // blooms on the high points
  PATCH[v].forEach(([cx, cy], i) => {
    if (i % 2 === 0 || h2(i, v, 2) % 3 === 0) { const c = BLOOM[(i + v) & 3]; S.set(cx, cy - 3, c); S.set(cx, cy - 2, c); S.set(cx - 1, cy - 2, c); }
  });
  S.outline();
  S.blit(g, fx, fy);
}
