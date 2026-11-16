// Engine prop art: quay (a flagstone slab with a kerb and a coursed sea wall on its south face). p: { w, h tiles }.
// Foot = the footprint's north corner; the top sits 6 px up. anchors.edge: the middle of the kerb.
import { defineProp, classicArt, SC, cached, proj } from './_wharf-kit.js';

const dims = p => [Math.max(1, (p && p.w | 0) || 2), Math.max(1, (p && p.h | 0) || 1)];
const layers = p => { const [w, h] = dims(p); return [{ r: cached(`quay|${w}|${h}`, () => classicArt.quay({ x0: 0, y0: 0, x1: w * 16, y1: h * 16 }, false, SC)), ax: 0, ay: 0 }]; };
export const anchors = p => { const [w, h] = dims(p); return { edge: proj(w * 8, h * 16, 6).map(Math.round) }; };
export const { name, frames, extent, draw } = defineProp({ name: 'quay', layers, anchors });
