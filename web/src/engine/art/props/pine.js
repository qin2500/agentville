// Pine / conifer (~60px tall at engine scale): stacked, ragged tiers over a short trunk.
// v % 4: 0 forest green, 1 blue-green, 2 dark fir, 3 frosted (pale tips).
import { Buf, ramp, dk, lt, hash } from './_pa1-kit.js';

export const name = 'pine';
export const frames = 1;
const X0 = -20, Y0 = -66, X1 = 20, Y1 = 8;
export function extent() { return [X0, Y0, X1, Y1]; }

const NEEDLES = ['#3d7a3c', '#2f7468', '#245a36', '#4f8a5a'].map(ramp);
const BARK = ramp('#6a4630');
const TIERS = [4, 5, 4, 5]; // tier count by look

export function draw(g, p, fx, fy) {
  const v = (p && p.v | 0) % 4, R = NEEDLES[v], n = TIERS[v], b = new Buf(X0, Y0, X1, Y1);
  b.rect(-1, -12, 3, 12, BARK[2]); b.rect(-1, -12, 1, 12, BARK[3]); b.rect(1, -12, 1, 12, BARK[1]);
  b.rect(-2, -2, 5, 2, BARK[2]); b.set(-2, -2, BARK[3]); b.set(2, -1, BARK[1]);
  // tiers from the bottom up: a cone slice per tier, widest at its lower edge, with a ragged skirt
  const top = -62, bot = -9, step = (bot - top) / n;
  for (let i = n - 1; i >= 0; i--) {
    const yTop = Math.round(top + i * step * 0.82), yBot = Math.round(top + (i + 1) * step + 2);
    const maxW = 7 + i * (14 / n) + (i === 0 ? -2 : 0);
    for (let y = yTop; y <= yBot; y++) {
      const k = (y - yTop) / Math.max(1, yBot - yTop), half = Math.max(0.5, maxW * Math.pow(k, 0.85));
      const skirt = y > yBot - 3 ? ((hash(y, i, v) % 3) - 1) : 0;
      for (let x = Math.ceil(-half - skirt - 0.5); x <= Math.floor(half + skirt + 0.5); x++) {
        const u = x / Math.max(1, half + 1);
        let t = -0.5 * u * 1.1 + 0.3 - 0.5 * k * 0.5 + ((hash(x, y, v + i) % 5) - 2) * 0.06;
        if (y >= yBot - 1) t -= 0.35; // underside of each tier
        if (v === 3 && k < 0.3 && u < 0.2) t += 0.4; // frosted tips
        b.set(x, y, R[t > 0.62 ? 4 : t > 0.3 ? 3 : t > -0.02 ? 2 : t > -0.34 ? 1 : 0]);
      }
    }
  }
  b.outline();
  b.shadow(1, 0, 12, 4);
  b.flush(g, fx, fy);
}
