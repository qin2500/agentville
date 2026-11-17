// Map-zoom actor atlas (design §3.5).
// At Map zoom (¼, ⅛) every actor is a few device px tall. Drawing each one from its own 1x frame canvas, scaled by
// the camera transform, costs a texture switch and a resample per actor per frame, and finding that canvas means the
// doll's frame cache (which a whole-world view of ~800 actors overflows, so frames were composed again every frame).
// This atlas keeps each frame once, pre-scaled to the device scale (z × dpr), in one page per scale, under the frame's
// key (actor-art frameKey: equal keys, the same pixels). A frame drawn from the atlas is a key lookup and a 1:1 copy
// out of one shared image; the doll composes a frame only the first time its key is seen at that scale.
//
// The pre-scale is the same nearest-neighbour sample the camera transform makes (image smoothing is off everywhere in
// the engine): the frame is drawn into its slot under a scale(s) transform at a whole device px. A slot is drawn back
// at a whole device px, so the copy is exactly 1:1; next to the direct draw the sample phase differs by under one
// device px.
//
//   createActorAtlas({ createCanvas, size?, maxPages? }) -> {
//     get(key, s) -> slot | null                  the slot of a frame key at scale s
//     put(key, s, frame) -> slot | null           pre-scales frame { img, pivot, head? } into a slot (null: no canvas,
//                                                 or a frame wider than a page)
//     resets: number                              how many times a full page started over (slots of it are gone)
//     stats() -> { pages, slots, resets, made }
//     clear()
//   }
//   slot = { img (the page), sx, sy, sw, sh (device px), w, h, pivot, head } (w, h, pivot, head: the 1x frame's)
// A full page starts over: its slots are made again as they are next drawn. A caller that holds slots across puts
// checks `resets` (renderer drawMap finds all of a frame's slots, then finds them again if a page started over).
// Pages for scales not drawn lately are dropped past `maxPages`.
import { READ } from '../art/alpha.js';

export const ATLAS_PAGE = 1024;
const PAD = 1;   // empty px between slots: a slot never samples its neighbour

export function createActorAtlas({ createCanvas, size = ATLAS_PAGE, maxPages = 3 } = {}) {
  /** @type {Map<number, {c: any, g: any, x: number, y: number, rowH: number, slots: Map<string, object>}>} */
  const pages = new Map();
  let resets = 0, made = 0, lastS = NaN, lastP = null;   // lastP: the page of the last scale looked up

  function pageOf(s) {
    let p = pages.get(s);
    if (p) return p;
    let c = null, g = null;
    try { c = createCanvas?.(size, size); g = c?.getContext?.('2d', READ) ?? null; } catch { c = null; }
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    p = { c, g, x: PAD, y: PAD, rowH: 0, slots: new Map() };
    pages.set(s, p);
    while (pages.size > maxPages) { pages.delete(pages.keys().next().value); lastS = NaN; lastP = null; }
    return p;
  }
  function reset(p) {
    p.g.setTransform(1, 0, 0, 1, 0, 0);
    p.g.clearRect(0, 0, size, size);
    p.x = PAD; p.y = PAD; p.rowH = 0; p.slots.clear(); resets++;
  }

  function get(key, s) {
    if (s !== lastS) { lastS = s; lastP = pages.get(s) ?? null; if (lastP) { pages.delete(s); pages.set(s, lastP); } }   // LRU touch per scale change
    return lastP?.slots.get(key) ?? null;
  }

  function put(key, s, f) {
    const img = f?.img, w = img?.width, h = img?.height;
    if (!img || !(w > 0 && h > 0 && s > 0)) return null;
    const p = pageOf(s);
    if (!p) return null;
    if (s === lastS) lastP = p;
    const sw = Math.max(1, Math.ceil(w * s)), sh = Math.max(1, Math.ceil(h * s));
    if (sw + 2 * PAD > size || sh + 2 * PAD > size) return null;
    if (p.x + sw + PAD > size) { p.x = PAD; p.y += p.rowH + PAD; p.rowH = 0; }
    if (p.y + sh + PAD > size) reset(p);
    const x = p.x, y = p.y;
    try {
      p.g.setTransform(s, 0, 0, s, x, y);
      p.g.drawImage(img, 0, 0, w, h, 0, 0, w, h);
      p.g.setTransform(1, 0, 0, 1, 0, 0);
    } catch { return null; }
    p.x += sw + PAD; p.rowH = Math.max(p.rowH, sh);
    made++;
    const v = { img: p.c, sx: x, sy: y, sw, sh, w, h, pivot: f.pivot ?? { x: w / 2, y: h }, head: f.head ?? null };
    p.slots.set(key, v);
    return v;
  }

  return {
    get, put,
    get resets() { return resets; },
    stats: () => ({ pages: pages.size, slots: [...pages.values()].reduce((n, p) => n + p.slots.size, 0), resets, made }),
    clear() { pages.clear(); lastS = NaN; lastP = null; },
  };
}
