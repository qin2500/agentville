// Engine prop art: vessel (a moored or sailing hull with masts, by class). Wraps the classic builders at the 32x16 tile.
// p: { cls: 'dinghy'|'cutter'|'brig', head: 'S'|'E'|'W'|'N', v | accent (hex), flag?: hex, crates?: n, hl?: bool }.
// frames 2 = a 1 px bob (p.frame, or p.anim with t). Foot = the hull's middle at the waterline. Night (lit): cabin
// windows glow. flag: a pennant of that colour at the masthead; crates: that many crates
// stowed on the deck spots (at most the class's spots); hl: the classic highlight outline (hover) instead of the ink one.
import { defineProp, classicArt, SC, proj, turn, headOf, cached, maybeLit, pick } from './_wharf-kit.js';
import { VESSEL_CLASSES } from '../../../engine-art-bridge.js';

const ACCENTS = ['#c8423a', '#3f6b8c', '#6b8a3f', '#8c5a9a', '#c08a3e', '#2f8f8a'];
export const CLASSES = ['dinghy', 'cutter', 'brig'];
const clsOf = p => { const c = p && p.cls; return c === 'brig' || c === 'dinghy' ? c : 'cutter'; };
const accentOf = p => (p && typeof p.accent === 'string' ? p.accent : pick(ACCENTS, p && p.v));
const footOf = (cls, h) => { const [x, y] = turn(h, 0, VESSEL_CLASSES[cls].L / 2); return proj(x, y, 0).map(Math.round); };
const HEX = /^#[0-9a-f]{6}$/i;
/** A small pixel glyph (the classic glyph helper) as a raster: rows of palette keys, '.' clear. */
const glyph = (rows, pal) => {
  const w = rows[0].length, h = rows.length, data = new Uint8ClampedArray(w * h * 4);
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const c = pal[ch]; if (!c) return;
    const i = (y * w + x) * 4; data[i] = parseInt(c.slice(1, 3), 16); data[i + 1] = parseInt(c.slice(3, 5), 16); data[i + 2] = parseInt(c.slice(5, 7), 16); data[i + 3] = 255;
  }));
  return { ox: 0, oy: 0, w, h, data };
};
const CRATE = ['.oooooo.', 'oLLLLLLo', 'oDmmmmDo', 'omDmmDmo', 'ommDDmmo', 'omDmmDmo', 'oDmmmmDo', 'oooooooo'];
const CRATE_PAL = { o: '#2a1a14', L: '#e0b070', m: '#b07a42', D: '#7a4f2e' };
const PENNANT = [['oooooo.', 'occccoo', 'occco..', 'ooo....'], ['ooooo..', 'occcooo', 'occccco', 'ooooooo']];
// a point of the boat's frame (classic world px: x across, y stern to bow, z up) in view px from the foot
const atFoot = (cls, h, x, y, z) => { const [sx, sy] = footOf(cls, h), [a, b] = turn(h, x, y), [X, Y] = proj(a, b, z); return [Math.round(X - sx), Math.round(Y - sy)]; };
const layers = (p, lit, f = 0) => {
  const cls = clsOf(p), h = headOf(p), a = accentOf(p), hl = !!(p && p.hl), [sx, sy] = footOf(cls, h), S = VESSEL_CLASSES[cls];
  const r = cached(`vessel|${cls}|${h}|${a}|${lit}|${hl}`, () => maybeLit(classicArt.hull(cls, a, h, hl, SC), lit));
  const out = [{ r, ax: sx, ay: sy }];
  // the classic builder draws the cargo, then the pennant, over the hull at these points (a dinghy turned off 'S' has no deck room)
  const spots = cls === 'dinghy' && h !== 'S' ? [] : S.spots, n = Math.min(spots.length, Math.max(0, (p && p.crates) | 0));
  for (let i = 0; i < n; i++) {
    const [lx, ly, l] = spots[i], [X, Y] = atFoot(cls, h, lx, ly, S.Z);
    out.push({ r: cached('vessel|crate', () => glyph(CRATE, CRATE_PAL)), ax: -(X - 4), ay: -(Y - 7 - l * 6) });
  }
  const flag = p && typeof p.flag === 'string' && HEX.test(p.flag) ? p.flag : null;
  if (flag) {
    const [mx, my] = atFoot(cls, h, S.mast[0], S.mast[1], S.mast[2]), fr = f & 1;
    out.push({ r: cached(`vessel|pennant|${flag}|${fr}`, () => glyph(PENNANT[fr], { o: '#1d1233', c: flag })), ax: -mx, ay: -(my - 1) });
  }
  return out;
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
/** How many crates a hull of this class can stow (its cargo spots). */
export const spotsOf = cls => VESSEL_CLASSES[clsOf({ cls })].spots.length;
