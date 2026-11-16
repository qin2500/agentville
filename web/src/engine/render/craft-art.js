// Sprites for the waterside actors (M5): a hull on a berth (token), a tug, a rowboat, a gull; and the crate a carrier holds.
// Each is the engine prop art (art/props/{vessel,tug,rowboat}.js) drawn once into a small canvas and cached by what changes
// it (kind, class, heading, oars, night). The 1 px bob is applied by the renderer as an offset, so frames stay few.
//   createCraftArt({ createCanvas }) -> { frame(actor, { lit }) -> { img, pivot } | null, kinds: Set }
import { createCanvas as rasterCanvas } from '../art/raster.js';
import * as vessel from '../art/props/vessel.js';
import * as tug from '../art/props/tug.js';
import * as rowboat from '../art/props/rowboat.js';
import { hash } from '../core/rng.js';

/** Actor kinds this module draws. */
export const CRAFT_KINDS = new Set(['token', 'tug', 'rowboat', 'gull']);
// engine facing (sim/actor.js faceFrom): 0 SE, 1 SW, 2 NW, 3 NE -> the art's bow heading (E: +x, S: +y, W: -x, N: -y)
const HEAD = ['E', 'S', 'W', 'N'];
const headOf = a => HEAD[(a.face | 0) & 3] ?? 'S';
const HEX = /^#[0-9a-fA-F]{6}$/;

export function createCraftArt({ createCanvas = rasterCanvas } = {}) {
  const memo = new Map();
  function paint(m, p, lit, key) {
    let e = memo.get(key);
    if (e) return e;
    const ext = m.extent(p, null);
    if (!(ext && ext[2] - ext[0] > 0 && ext[3] - ext[1] > 0)) { memo.set(key, null); return null; }
    const PAD = 1, cw = Math.ceil(ext[2] - ext[0]) + 2 * PAD, ch = Math.ceil(ext[3] - ext[1]) + 2 * PAD;
    const c = createCanvas(cw, ch), g = c.getContext('2d');
    const fx = PAD - Math.floor(ext[0]), fy = PAD - Math.floor(ext[1]);
    m.draw(g, p, fx, fy, 0.25, !!lit, null);
    e = { img: c, pivot: { x: fx, y: fy } };
    memo.set(key, e);
    return e;
  }
  function gull(a) {
    const f = Math.floor((a.frame | 0)) & 1, key = `gull|${(a.face | 0) & 3}|${f}`;
    let e = memo.get(key);
    if (e) return e;
    const c = createCanvas(11, 7), g = c.getContext('2d');
    g.fillStyle = '#140f1c';
    for (const [x, y] of f ? [[1, 1], [2, 2], [3, 3], [4, 3], [5, 3], [6, 3], [7, 2], [8, 1]] : [[1, 3], [2, 2], [3, 2], [4, 3], [5, 3], [6, 3], [7, 2], [8, 2], [9, 3]]) g.fillRect(x, y, 1, 2);
    g.fillStyle = '#f4f1ea';
    for (const [x, y] of f ? [[2, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 1]] : [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2]]) g.fillRect(x, y, 1, 1);
    e = { img: c, pivot: { x: 5, y: 4 } };
    memo.set(key, e);
    return e;
  }
  /** @returns {{ img: any, pivot: {x:number,y:number} } | null} */
  function frame(a, { lit = false } = {}) {
    const h = headOf(a), n = lit ? 1 : 0;
    switch (a.kind) {
      case 'token': {
        const cls = a.model === 'brig' || a.model === 'dinghy' ? a.model : 'cutter';
        const accent = typeof a.tint === 'string' && HEX.test(a.tint) ? a.tint : undefined;
        return paint(vessel, { cls, head: h, accent, v: hash(String(a.item ?? a.id)) }, lit, `v|${cls}|${h}|${accent ?? hash(String(a.item ?? a.id)) % 6}|${n}`);
      }
      case 'tug': return paint(tug, { head: h }, lit, `t|${h}|${n}`);
      case 'rowboat': { const oars = a.state === 'row', f = oars ? (a.frame | 0) & 1 : 0; return paint(rowboat, { head: h, oars, frame: f }, lit, `r|${h}|${oars ? 1 : 0}|${f}|${n}`); }
      case 'gull': return gull(a);
      default: return null;
    }
  }
  return { frame, kinds: CRAFT_KINDS };
}
