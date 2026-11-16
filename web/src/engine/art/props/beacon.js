// Engine prop art: beacon (a green-and-white banded post on a stone footing). Foot = footing centre at the waterline.
// Night (lit): the lantern glows. anchors.glow: the lantern centre.
import { defineProp, classicArt, SC, cached, maybeLit, proj } from './_wharf-kit.js';

const layers = (p, lit) => [{ r: cached(`beacon|${lit}`, () => maybeLit(classicArt.beacon(0, 0, false, SC), lit)), ax: 0, ay: 0 }];
export const anchors = () => ({ glow: proj(0, 0, 8 + 14).map(Math.round) });
export const { name, frames, extent, draw } = defineProp({ name: 'beacon', layers, anchors });
