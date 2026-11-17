// Engine prop art: breakwater (a paved stone mole with rubble on its sea side). p: { len tiles, dir: 'x' (default) | 'y',
// sea: 1 (south / east, default) | -1 (north / west) }. Foot = the footprint's north corner (len x 1 tiles). anchors.end: the far end's top.
import { defineProp, classicArt, SC, cached, proj } from './_wharf-kit.js';

const dims = p => [Math.max(1, (p && p.len | 0) || 3), p && p.dir === 'y' ? 'y' : 'x', p && p.sea === -1 ? -1 : 1];
const seg = (len, dir, sea) => {
  const n = len * 16, hw = 6;
  return dir === 'x'
    ? { quad: [[0, 8 - hw], [n, 8 - hw], [n, 8 + hw], [0, 8 + hw]], a: [0, 8], b: [n, 8], n: [0, sea], len: n }
    : { quad: [[8 - hw, 0], [8 + hw, 0], [8 + hw, n], [8 - hw, n]], a: [8, 0], b: [8, n], n: [sea, 0], len: n };
};
const layers = p => { const [len, dir, sea] = dims(p); return [{ r: cached(`breakwater|${len}|${dir}|${sea}`, () => classicArt.breakwater(seg(len, dir, sea), false, SC)), ax: 0, ay: 0 }]; };
export const anchors = p => { const [len, dir] = dims(p); return { end: (dir === 'x' ? proj(len * 16, 8, 8) : proj(8, len * 16, 8)).map(Math.round) }; };
export const { name, frames, extent, draw } = defineProp({ name: 'breakwater', layers, anchors });
