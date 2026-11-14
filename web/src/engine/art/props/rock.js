// Rock: a faceted grey boulder, ~10px tall, with a small companion stone. Variants: 4 shapes / tints.
import { Surf, ramp, jit, h2 } from './pa2-kit.js';

export const name = 'rock';
export const frames = 1;
export function extent() { return [-12, -15, 12, 5]; }

const TONES = [ramp('#8e929a'), ramp('#9a958c'), ramp('#7f8794'), ramp('#a3a29a')];
const SHAPES = [
  // [cx, cy, rx, ry] main, then optional small stone
  { main: [0, -5, 7.5, 6.5], small: [-8, -1.5, 3, 2.2] },
  { main: [-1, -5.5, 6.5, 7], small: [7, -1.5, 3, 2.2] },
  { main: [0, -4.5, 9, 5.5], small: null },
  { main: [1, -5.5, 7, 6.5], small: [-7, -1.5, 3.5, 2.5] },
];

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) & 3, R = TONES[v], sh = SHAPES[v], S = new Surf(extent());
  const stone = (b, seed) => S.ell(b[0], b[1], b[2], b[3], (x, y, u, w) => {
    // facets: planes chosen by a diagonal split, lit from the front left
    const l = -0.5 * u - 0.5 * w + 0.35 + (u + w * 0.5 > 0.25 ? -0.3 : 0) + (w < -0.45 ? 0.2 : 0);
    let k = l > 0.6 ? 4 : l > 0.35 ? 3 : l > 0.05 ? 2 : l > -0.25 ? 1 : 0;
    const n = h2(x, y, seed) % 12;
    if (n === 0 && k > 0) k--; else if (n === 1 && k < 4) k++;
    if (w > 0.7) k = Math.min(k, 1);
    return R[k];
  });
  if (sh.small) stone(sh.small, v + 20);
  stone(sh.main, v);
  // a crack and a moss patch
  const m = sh.main;
  for (let i = 0; i < 3; i++) S.set(m[0] - 1 + i, m[1] - 1 + (i >> 1), R[0]);
  if (v === 1 || v === 3) for (let i = 0; i < 4; i++) { const x = m[0] - 4 + i * 2, y = m[1] - m[3] + 1 + (i & 1); if (S.alpha(x, y)) S.set(x, y, [91, 138, 70]); }
  S.outline();
  S.blit(g, fx, fy);
}
