// Sapling (~35px tall at engine scale): a thin trunk, a small round crown and a support stake.
// v % 4: 0 light green, 1 yellow-green, 2 mid green, 3 pink blossom.
import { Buf, ramp, lt, hash } from './_pa1-kit.js';

export const name = 'sapling';
export const frames = 1;
const X0 = -14, Y0 = -42, X1 = 14, Y1 = 8;
export function extent() { return [X0, Y0, X1, Y1]; }

const LEAVES = ['#68b04a', '#98bc48', '#4b9a46', '#e58fb4'].map(ramp);
const BARK = ramp('#8a5e3a'), STAKE = ramp('#b07a48');
const SHAPES = [
  [[-4, -26, 6, 6], [4, -27, 6, 6], [0, -32, 6, 6]],
  [[-5, -25, 6, 5], [4, -26, 7, 6], [0, -31, 5, 5]],
  [[-3, -25, 5, 6], [4, -26, 5, 6], [0, -32, 6, 7]],
  [[-4, -26, 6, 6], [4, -26, 6, 6], [0, -32, 6, 6]],
];

export function draw(g, p, fx, fy) {
  const v = (p && p.v | 0) % 4, R = LEAVES[v], b = new Buf(X0, Y0, X1, Y1);
  b.rect(5, -14, 1, 14, STAKE[2]); b.rect(6, -14, 1, 14, STAKE[1]); // stake, tied with a bit of twine
  b.rect(0, -22, 2, 22, BARK[2]); b.rect(0, -22, 1, 22, BARK[3]); b.rect(1, -22, 1, 22, BARK[1]);
  b.rect(-1, -2, 4, 2, BARK[2]); b.set(-1, -2, BARK[3]); b.set(2, -1, BARK[1]);
  b.set(4, -10, STAKE[4]); b.set(5, -10, STAKE[4]); b.set(2, -10, STAKE[4]);
  b.blobs(SHAPES[v], (x, y, u, vv, bi, l) => {
    let t = l + ((hash(x >> 1, y >> 1, v) % 5) - 2) * 0.07 + (y > -23 ? -0.1 : 0);
    if (v === 3 && hash(x, y, 3) % 9 === 0) return [255, 226, 236];
    return R[t > 0.78 ? 4 : t > 0.5 ? 3 : t > 0.1 ? 2 : t > -0.28 ? 1 : 0];
  });
  b.outline();
  b.shadow(1, 0, 9, 3);
  b.flush(g, fx, fy);
}
