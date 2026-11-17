// Engine prop art: crane (stone footing, mast, counterweight, a jib reaching east over the water). p: { reach px (default 40),
// z0 lift (default 6) }. Foot = the 1x1 footprint's north corner. anchors.hook: the jib tip, where the rope hangs.
import { defineProp, classicArt, SC, cached, proj } from './_wharf-kit.js';

const dims = p => [Math.max(24, (p && p.reach | 0) || 40), p && p.z0 != null ? p.z0 : 6];
const layers = (p) => {
  const [reach, z0] = dims(p), c = { bx: 2, by: 2, z0, tipX: 2 + reach };
  return [
    { r: cached(`crane|post|${z0}`, () => classicArt.pierCrane(c, false, SC)), ax: 0, ay: 0 },
    { r: cached(`crane|jib|${reach}|${z0}`, () => classicArt.jib(c, false, SC)), ax: 0, ay: 0 },
  ];
};
export const anchors = p => { const [reach, z0] = dims(p); return { hook: proj(2 + reach, 6, z0 + 46).map(Math.round) }; };
export const { name, frames, extent, draw } = defineProp({ name: 'crane', layers, anchors });
