// Crops: a furrowed tile with rows of green sprouts / young wheat. Flat decal. Variants: 4 crops (wheat, cabbage, turnip, barley).
import { Surf, ramp, h2 } from './pa2-kit.js';

export const name = 'crops';
export const frames = 1;
export function extent() { return [-15, -11, 15, 8]; }

const SOIL = ramp('#6b4a34');
const PLANT = [ramp('#6fa84a'), ramp('#8bb84a'), ramp('#5d9a55'), ramp('#a3b84a')];
const inTile = (x, y) => Math.abs(x + 0.5) / 15 + Math.abs(y + 0.5) / 7.5 <= 1;

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) & 3, R = PLANT[v], S = new Surf(extent());
  // tilled soil diamond with furrow lines running along the +x iso axis
  for (let y = -8; y < 8; y++) for (let x = -16; x < 16; x++) {
    if (!inTile(x, y)) continue;
    const row = ((x + 2 * y + 64) >> 2) & 1; // alternating ridge / furrow bands
    let k = row ? 1 : 3;
    const n = h2(x, y, v) % 11;
    if (n === 0) k = Math.max(0, k - 1); else if (n === 1) k = Math.min(4, k + 1);
    S.set(x, y, SOIL[k]);
  }
  // plants on the ridges
  for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
    const wx = c * 4 + r * 2 + (r & 1), wy = r * 2 - c * 0.8 + 0.5;
    const x = Math.round(wx), y = Math.round(wy);
    if (!inTile(x, y - 2)) continue;
    const j = h2(r, c, v) % 4;
    S.set(x, y, R[1]); S.set(x, y - 1, R[2 + (j & 1)]);
    if (v === 0 || v === 3) { S.set(x, y - 2, R[4]); if (j === 0) S.set(x + 1, y - 1, R[3]); }
    else { S.set(x - 1, y - 1, R[3]); S.set(x + 1, y - 1, R[2]); S.set(x, y - 2, R[3]); }
  }
  S.outline();
  S.blit(g, fx, fy);
}
