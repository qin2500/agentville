// Engine prop art: buoy (a floating marker with a cap and lamp post). p: { v: 0 red, 1 green }. Foot = its centre at the
// waterline. Night (lit): the cap glows nothing extra (the lamp is an anchor); anchors.lamp: the lamp tip.
import { defineProp, classicArt, SC, cached, proj } from './_wharf-kit.js';

const col = p => ((p && p.v | 0) & 1 ? 'g' : 'r');
const layers = p => [{ r: cached(`buoy|${col(p)}`, () => classicArt.buoy(col(p), SC)), ax: 0, ay: 0 }];
export const anchors = () => ({ lamp: proj(0, 0, 12).map(Math.round) });
export const { name, frames, extent, draw } = defineProp({ name: 'buoy', layers, anchors });
