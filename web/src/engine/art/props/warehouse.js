// Engine prop art: warehouse (plank walls, gabled shingle roof, big door). p: { w, h tiles (default 3x2), v 0..4 roof
// colour, z0 lift (default 6: it stands on the quay slab) }. Foot = the footprint's north corner. Night (lit): windows glow.
// anchors.door: the door's foot centre; anchors.ridge: the roof ridge middle.
import { defineProp, classicArt, SC, cached, maybeLit, proj } from './_wharf-kit.js';

const dims = p => [Math.max(2, (p && p.w | 0) || 3), Math.max(1, (p && p.h | 0) || 2), (p && p.z0 != null ? p.z0 : 6), Math.abs((p && p.v | 0) % 5)];
const layers = (p, lit) => {
  const [w, h, z0, v] = dims(p);
  return [{ r: cached(`warehouse|${w}|${h}|${z0}|${v}|${lit}`, () => maybeLit(classicArt.shed([2, 2, w * 16 - 2, h * 16 - 2], z0, v, false, SC), lit)), ax: 0, ay: 0 }];
};
export const anchors = p => { const [w, h, z0] = dims(p); return { door: proj(w * 8, h * 16 - 2, z0).map(Math.round), ridge: proj(w * 8, h * 8, z0 + 25).map(Math.round) }; };
export const { name, frames, extent, draw } = defineProp({ name: 'warehouse', layers, anchors });
