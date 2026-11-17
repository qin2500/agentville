// Engine prop art: lighthouse (stone platform, banded tower, gallery, lantern room, red cap). Foot = platform centre at
// the waterline. 2x2 tiles is a good footprint. Night (lit): the lantern glows. anchors.lamp: the lantern centre (the sweep pivots here).
import { defineProp, classicArt, SC, cached, maybeLit, proj } from './_wharf-kit.js';

const layers = (p, lit) => [{ r: cached(`lighthouse|${lit}`, () => maybeLit(classicArt.lighthouse(0, 0, false, SC), lit)), ax: 0, ay: 0 }];
export const anchors = () => ({ lamp: proj(0, 0, 8 + 40 + 6).map(Math.round), top: proj(0, 0, 8 + 40 + 20).map(Math.round) });
export const { name, frames, extent, draw } = defineProp({ name: 'lighthouse', layers, anchors });
