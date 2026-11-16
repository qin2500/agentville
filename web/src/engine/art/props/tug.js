// Engine prop art: tug (red hull, white wheelhouse, funnel). p: { head }. frames 2 = bob. Foot = hull middle at the waterline.
// anchors.smoke: the funnel top, view px from the foot.
import { defineProp, classicArt, SC, proj, turn, headOf, cached, maybeLit } from './_wharf-kit.js';

const L = 24, Z = 5;
const foot = h => { const [x, y] = turn(h, 0, L / 2); return proj(x, y, 0).map(Math.round); };
const layers = (p, lit) => {
  const h = headOf(p), [sx, sy] = foot(h);
  return [{ r: cached(`tug|${h}|${lit}`, () => maybeLit(classicArt.tug(h, false, SC), lit)), ax: sx, ay: sy }];
};
export const anchors = p => { const h = headOf(p), [sx, sy] = foot(h), [a, b] = turn(h, 0, 9.8), [X, Y] = proj(a, b, Z + 14); return { smoke: [Math.round(X - sx), Math.round(Y - sy)] }; };
export const { name, frames, extent, draw } = defineProp({ name: 'tug', frames: 2, bob: true, layers, anchors });
