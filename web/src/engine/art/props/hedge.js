// Hedge: a trimmed green hedge running along dir for len tiles (edge run, foot = centre of the FIRST tile).
// Ends are flush with the tile borders so neighbouring runs join. ~14px tall. Variants: 4 greens/trims.
import { Surf, ramp, jit, h2 } from './pa2-kit.js';

export const name = 'hedge';
export const frames = 1;

const H = 14, HW = 3.5;
const GREENS = [ramp('#3f8a3a'), ramp('#4f9a3a'), ramp('#3a7a4a'), ramp('#5b9a3c')];
const lenOf = p => Math.max(1, (p && p.len | 0) || 1);

export function extent(p) {
  const L = lenOf(p) * 16, a = -8, b = L - 8, y = p && p.dir === 'y';
  const w = HW + 1;
  return y
    ? [Math.floor(-w - b) - 2, Math.floor((a - w) / 2 - H) - 3, Math.ceil(w - a) + 2, Math.ceil((b + w) / 2) + 3]
    : [Math.floor(a - w) - 2, Math.floor((a - w) / 2 - H) - 3, Math.ceil(b + w) + 2, Math.ceil((b + w) / 2) + 3];
}

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) & 3, R = GREENS[v], L = lenOf(p) * 16, isY = p && p.dir === 'y', S = new Surf(extent(p));
  const x0 = isY ? -HW : -8, x1 = isY ? HW : L - 8, y0 = isY ? -8 : -HW, y1 = isY ? L - 8 : HW;
  // leafy texture: clumps of ~2px, banded by trim lines; top is a lighter mottled cap
  const tex = (f, x, y, c) => {
    const n = h2(x >> 1, (y + (x >> 2)) >> 1, v + 3) % 9;
    if (f === 't') return n < 2 ? R[2] : n === 8 ? R[4] : R[3];
    const clump = h2((x + (y >> 2) * 2) >> 1, y >> 1, v) % 8;
    const base = f === 'l' ? 2 : 1;
    if (y % 5 === 0) return R[Math.max(0, base - 1)];
    const k = clump === 0 ? base - 1 : clump === 1 ? base + 1 : base;
    return R[Math.min(4, Math.max(0, k))];
  };
  S.box(x0, y0, x1, y1, 0, H, R, tex);
  // toothy top silhouette: little leaf tufts poking up along the front-top edge
  for (let u = 0; u < (isY ? L : L); u += 2) {
    if (h2(u, v, 5) % 3 === 0) continue;
    const wx = isY ? x1 : x0 + u, wy = isY ? y0 + u : y1;
    const [vx, vy] = S.P(wx, wy, H);
    if (isY ? S.alpha(vx, vy - 1) : S.alpha(vx, vy - 1)) continue;
    S.set(vx, vy - 1, R[h2(u, 9, v) % 3 === 0 ? 4 : 3]);
  }
  S.outline();
  S.blit(g, fx, fy);
}
