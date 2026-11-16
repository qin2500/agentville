// Sunflower: two or three tall flowers on short stems with big golden heads. Up to 18px tall. Variants: 4 clusters.
import { Surf, ramp, h2 } from './pa2-kit.js';

export const name = 'sunflower';
export const frames = 1;
export function extent() { return [-10, -17, 10, 5]; }

const LEAF = ramp('#4f9a48'), PET = ramp('#f0c02a'), SEED = ramp('#5b3a22');
const CLUSTER = [
  [[-4, 0, 9], [3, 1, 12], [8, -1, 8]],
  [[-5, 1, 8], [1, 0, 12]],
  [[-6, 0, 11], [0, 2, 9], [6, 0, 12]],
  [[-2, 1, 12], [5, 0, 9], [-7, -1, 7]],
];

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) & 3, S = new Surf(extent());
  // back to front by foot y
  [...CLUSTER[v]].sort((a, b) => a[1] - b[1]).forEach(([x, y, h], i) => {
    for (let k = 0; k < h - 2; k++) S.set(x, y - k, k & 1 ? LEAF[1] : LEAF[2]);
    S.set(x - 1, y - 2, LEAF[3]); S.set(x - 2, y - 3, LEAF[3]); S.set(x + 1, y - 4, LEAF[2]); S.set(x + 2, y - 5, LEAF[2]);
    const hy = y - h;
    // petals: a ring of gold around a dark seed disc
    S.ell(x, hy, 3.6, 3.2, (px, py, u, w) => (u * u + w * w > 0.45 ? PET[(h2(px, py, i + v) & 3) === 0 ? 3 : (u < 0 && w < 0 ? 4 : 2)] : SEED[u < 0 ? 2 : 1]));
    S.set(x, hy, SEED[0]);
  });
  S.outline();
  S.blit(g, fx, fy);
}
