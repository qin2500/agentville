// Bush: a round leafy shrub, ~12px tall. Variants: plain, berries, blossom, dark.
import { Surf, ramp, rgbOf, jit, h2 } from './pa2-kit.js';

export const name = 'bush';
export const frames = 1;
export function extent() { return [-12, -17, 12, 5]; }

const LEAVES = [ramp('#5b9a3c'), ramp('#6aa840'), ramp('#4f9a52'), ramp('#3f7a3a')];
const DOTS = [rgbOf('#d8404e'), rgbOf('#f5cf4f'), rgbOf('#ef93cc'), rgbOf('#fbf6ea')];

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) & 3, R = LEAVES[v], S = new Surf(extent());
  // blobs: [cx, cy, rx, ry]; a wide base with two smaller lumps on top
  const blobs = [[0, -5, 7.5, 6], [-4, -7, 4.5, 5], [4, -7.5, 4.5, 5], [0, -9, 4.5, 4]];
  const lumpy = (x, y, u, w) => {
    const nz = Math.sqrt(Math.max(0, 1 - u * u - w * w)), l = -0.45 * u - 0.6 * w + 0.5 * nz;
    let k = l > 0.62 ? 4 : l > 0.38 ? 3 : l > 0.05 ? 2 : l > -0.3 ? 1 : 0;
    const n = h2(x >> 1, y >> 1, v) % 7;
    if (n === 0 && k > 0) k--; else if (n === 1 && k < 4) k++;
    return R[k];
  };
  // draw back-to-front: big base first, then top lumps (later paint wins, so draw lower blobs last for front)
  for (const b of [blobs[3], blobs[1], blobs[2], blobs[0]]) S.ell(b[0], b[1], b[2], b[3], (x, y, u, w) => lumpy(x, y, u, w));
  // underside shadow row
  for (let x = -7; x <= 7; x++) if (S.alpha(x, 0)) S.set(x, 0, R[0]);
  if (v === 1 || v === 2) {
    const col = DOTS[v === 1 ? 0 : 2], n = v === 1 ? 7 : 9;
    for (let i = 0; i < n; i++) {
      const x = (h2(i, 3, 11) % 15) - 7, y = -(h2(i, 5, 13) % 10) - 1;
      if (S.alpha(x, y) && S.alpha(x + 1, y)) { S.set(x, y, col); if (v === 2) S.set(x + 1, y, DOTS[3]); }
    }
  }
  S.outline();
  S.blit(g, fx, fy);
}
