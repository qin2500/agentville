// Engine prop art: vessel (a moored or sailing hull with masts, by class). Wraps the classic builders at the 32x16 tile.
// p: { cls: 'dinghy'|'cutter'|'brig', head: 'S'|'E'|'W'|'N', v | accent (hex) }. frames 2 = a 1 px bob
// (p.frame, or p.anim with t). Foot = the hull's middle at the waterline. Night (lit): cabin windows glow.
import { defineProp, classicArt, SC, proj, turn, headOf, cached, maybeLit, pick } from './_wharf-kit.js';
import { VESSEL_CLASSES } from '../../../engine-art-bridge.js';

const ACCENTS = ['#c8423a', '#3f6b8c', '#6b8a3f', '#8c5a9a', '#c08a3e', '#2f8f8a'];
export const CLASSES = ['dinghy', 'cutter', 'brig'];
const clsOf = p => { const c = p && p.cls; return c === 'brig' || c === 'dinghy' ? c : 'cutter'; };
const accentOf = p => (p && typeof p.accent === 'string' ? p.accent : pick(ACCENTS, p && p.v));
const footOf = (cls, h) => { const [x, y] = turn(h, 0, VESSEL_CLASSES[cls].L / 2); return proj(x, y, 0).map(Math.round); };
const layers = (p, lit) => {
  const cls = clsOf(p), h = headOf(p), a = accentOf(p), [sx, sy] = footOf(cls, h);
  const r = cached(`vessel|${cls}|${h}|${a}|${lit}`, () => maybeLit(classicArt.hull(cls, a, h, false, SC), lit));
  return [{ r, ax: sx, ay: sy }];
};
// Anchors, view px from the foot: mast (pennant), bow, stern, and the cargo spots [x, y, layer] where crates sit.
const anchors = p => {
  const cls = clsOf(p), h = headOf(p), S = VESSEL_CLASSES[cls], [sx, sy] = footOf(cls, h);
  const at = (x, y, z) => { const [a, b] = turn(h, x, y); const [X, Y] = proj(a, b, z); return [Math.round(X - sx), Math.round(Y - sy)]; };
  return {
    mast: at(S.mast[0], S.mast[1], S.mast[2] + S.Z), bow: at(0, S.L, S.Z), stern: at(0, 0, S.Z),
    cargo: S.spots.map(([x, y, l]) => at(x, y, S.Z + 1 + l * 6)),
  };
};
export const { name, frames, extent, draw, anchors: anchorsOf } = defineProp({ name: 'vessel', frames: 2, bob: true, layers, anchors });
export { anchors };
