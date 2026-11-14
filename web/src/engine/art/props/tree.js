// Broadleaf tree (~50px tall at engine scale): a trunk with a flared root and a clumpy, lit canopy.
// v % 4: 0 lush green round, 1 yellow-green wide, 2 deep green tall, 3 autumn gold.
import { Buf, ramp, dk, lt, hash } from './_pa1-kit.js';

export const name = 'tree';
export const frames = 1;
const X0 = -24, Y0 = -56, X1 = 24, Y1 = 8;
export function extent() { return [X0, Y0, X1, Y1]; }

const LEAVES = ['#4f9a3a', '#7aa83c', '#2f7a43', '#d49a2e'].map(ramp);
const BARK = ramp('#7a5236');
// [cx, cy, rx, ry] canopy discs per look (view px relative to the foot)
const SHAPES = [
  [[-9, -27, 9, 8], [8, -28, 9, 8], [0, -37, 11, 9], [-11, -35, 7, 6], [10, -36, 7, 6], [0, -45, 8, 6], [0, -25, 12, 6]],
  [[-12, -25, 10, 7], [11, -26, 10, 7], [0, -31, 13, 9], [-8, -38, 8, 6], [9, -37, 8, 6], [1, -43, 7, 5]],
  [[-7, -26, 8, 7], [7, -27, 8, 7], [0, -35, 9, 8], [-6, -43, 6, 6], [6, -43, 6, 6], [0, -50, 6, 6]],
  [[-9, -26, 9, 7], [9, -27, 9, 7], [0, -36, 11, 9], [-10, -36, 6, 6], [10, -35, 6, 6], [1, -44, 8, 6]],
];

export function draw(g, p, fx, fy) {
  const v = (p && p.v | 0) % 4, R = LEAVES[v], b = new Buf(X0, Y0, X1, Y1);
  // trunk: 4px wide, a root flare at the foot, lit on the left
  for (let y = -22; y <= 0; y++) {
    const w = y > -4 ? 3 : y > -9 ? 2 : 1, half = w; // half-width grows toward the root
    for (let x = -half; x < half + 1 - (y < -9 ? 1 : 0); x++) b.set(x, y, x <= -half ? BARK[3] : x >= half - (y < -9 ? 0 : 0) ? BARK[1] : BARK[2]);
  }
  for (let y = -20; y < -2; y += 3) b.set(1 - (y & 1), y, BARK[0]);
  b.blobs(SHAPES[v], (x, y, u, vv, bi, l) => {
    const h = hash(x, y, v + 7), clump = (hash(x >> 1, y >> 1, v) % 5) - 2;
    let t = l + clump * 0.07 + (y > -29 ? -0.12 : 0) - (bi === 0 ? 0 : 0);
    if (h % 17 === 0) t += 0.3; // leaf glints
    return R[t > 0.78 ? 4 : t > 0.5 ? 3 : t > 0.12 ? 2 : t > -0.28 ? 1 : 0];
  });
  b.outline();
  b.shadow(1, 0, 14, 5);
  b.flush(g, fx, fy);
}
