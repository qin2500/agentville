// Engine prop art: rowboat. p: { head, oars }. Without oars: moored, 1 frame of look (frames 2 = bob only). With oars:
// the stroke alternates per frame. Foot = hull middle at the waterline. anchors.oarlocks: the two oar pivots.
import { defineProp, classicArt, SC, proj, turn, headOf, cached, maybeLit } from './_wharf-kit.js';

const L = 23, Z = 4;
const foot = h => { const [x, y] = turn(h, 0, L / 2); return proj(x, y, 0).map(Math.round); };
const layers = (p, lit, f) => {
  const h = headOf(p), [sx, sy] = foot(h), fr = p && p.oars ? f & 1 : null;
  return [{ r: cached(`rowboat|${h}|${fr}|${lit}`, () => maybeLit(classicArt.rowboat(h, fr, false, SC), lit)), ax: sx, ay: sy }];
};
export const anchors = p => {
  const h = headOf(p), [sx, sy] = foot(h);
  return { oarlocks: [-5, 5].map(x => { const [a, b] = turn(h, x, 10.5), [X, Y] = proj(a, b, Z + 1); return [Math.round(X - sx), Math.round(Y - sy)]; }) };
};
export const { name, frames, extent, draw } = defineProp({ name: 'rowboat', frames: 2, layers, anchors });
