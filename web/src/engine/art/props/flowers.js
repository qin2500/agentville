// Flowers: a low bed of mixed storybook blooms (red, yellow, violet, white) on leafy tufts. Flat decal inside one tile. Variants: 4 beds.
import { Surf, ramp, h2 } from './pa2-kit.js';

export const name = 'flowers';
export const frames = 1;
export function extent() { return [-12, -9, 12, 6]; }

const LEAF = ramp('#4f9a4a'), LEAF2 = ramp('#5fa855');
const BLOOM = [[226, 74, 84], [246, 206, 72], [160, 112, 206], [250, 246, 236], [240, 142, 70]];
const BED = [
  [[-7, 0], [-3, 2], [1, -1], [5, 1], [8, -1], [-1, 3]],
  [[-8, 1], [-4, -1], [0, 2], [4, 0], [7, 2], [2, -2]],
  [[-6, -1], [-2, 1], [3, 2], [6, -1], [-4, 3], [0, -2], [9, 1]],
  [[-7, 2], [-1, 0], [4, 2], [8, 0], [1, -2]],
];

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) & 3, S = new Surf(extent());
  BED[v].forEach(([cx, cy], i) => {
    const R = (i & 1) ? LEAF2 : LEAF;
    S.ell(cx, cy, 3, 1.5, (x, y, u, w) => (w < -0.2 ? R[3] : w > 0.3 ? R[1] : R[2]));
  });
  BED[v].forEach(([cx, cy], i) => {
    const c = BLOOM[(h2(i, v, 3) + i) % 5], hy = cy - 2 - (i & 1);
    S.set(cx, cy - 1, LEAF[1]);
    S.set(cx, hy, c); S.set(cx - 1, hy, c); S.set(cx + 1, hy, c); S.set(cx, hy - 1, c); S.set(cx, hy + 1, c);
    S.set(cx, hy, [250, 226, 120]);
  });
  S.outline();
  S.blit(g, fx, fy);
}
