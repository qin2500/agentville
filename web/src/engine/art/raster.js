// Engine v2 rasteriser (design §5.2, seam R3). OWNER: R3.
// Draws one model (a building look or a prop) with the CLASSIC art code (iso.js isoBuilding, props-art.js
// createPropArt) into an offscreen canvas that has a transparent margin, then measures the true opaque rect by an
// alpha scan. Nothing here draws art of its own.
//
//   rasterize(model, style, opts) -> { img, bounds:{x,y,w,h}, pivot:{x,y}, anchors, classic }
//   measureBounds(imageData) -> {x,y,w,h}          (alpha > 0; an empty image gives w = h = 0)
//   setCanvasFactory(fn)   fn(w, h) -> canvas-like with getContext('2d'). Default: OffscreenCanvas, else a DOM canvas.
//   useClassicArt(art)     inject { isoBuilding, isoExtent, createPropArt } (tests, workers); loadClassicArt() imports
//                          the real modules lazily (they need a DOM, so this file stays importable from node).
//
// opts: { variant, w, h, door, lit, crown, scale, anim, site, kind, dir, len, accent }
//   w, h    footprint in tiles (buildings; props take dir/len). door: world px along the south wall from the footprint's
//           west corner (a number or { x }), null = no door, undefined = centred. scale: projection scale, 1 = 32x16 tile
//           (the classic projection is 0.8 of that: iso.js `S` = 1.25 * scale). anim: frame index (animated props).
// img pixels: bounds are inside img with >= 1px transparent margin. pivot = the footprint's NORTH corner for a
// building (draw at toScreen(tx, ty) - pivot), the foot point for a prop. anchors are {x, y} in img px.
// Props are authored at the classic 0.8 projection with hand-set rects (props-art.js), so they are NOT rescaled:
// result.classic is true for them (see the report). OffscreenCanvas and DOM canvas both work for the image copy.

import { PROPS as ENGINE_PROPS } from './props/index.js';

export const T = 16;           // classic world px per tile (world.js T)
export const PAD = 2;          // transparent margin around the classic image, px
const ENGINE_OVER_CLASSIC = 1.25; // 32x16 tile / classic 25.6x12.8 tile
const PROP_FPS = { fountain: 5, maypole: 2.5 };

let factory = null;
let art = null;
let propArt = null;

export function setCanvasFactory(fn) { factory = typeof fn === 'function' ? fn : null; }

export function createCanvas(w, h) {
  if (factory) return factory(w, h);
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  throw new Error('raster: no canvas available (setCanvasFactory)');
}

export function useClassicArt(a) { art = a || null; propArt = null; }

/** Import the real classic art (browser). Resolves when rasterize() can run. */
export async function loadClassicArt() {
  if (art) return art;
  const [iso, props] = await Promise.all([import('../../iso.js'), import('../../props-art.js')]);
  useClassicArt({ isoBuilding: iso.isoBuilding, isoExtent: iso.isoExtent, createPropArt: props.createPropArt });
  return art;
}

/** The true opaque rect of an ImageData-like { data, width, height }: alpha > threshold (default 0). */
export function measureBounds(imageData, threshold = 0) {
  const { data, width: w, height: h } = imageData;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const pt = (p, ox, oy) => (Array.isArray(p) && Number.isFinite(p[0]) ? { x: p[0] + ox, y: p[1] + oy } : null);

function finish(canvas, pivot, anchors, classic) {
  const g = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
  const bounds = measureBounds(g.getImageData(0, 0, canvas.width, canvas.height));
  return { img: canvas, bounds, pivot, anchors, classic };
}

/**
 * Snap an anchor that is outside the opaque bounds, or on a transparent pixel, to the top opaque pixel of the roof in
 * the same column (nearest non-empty column if that one is empty). Anchors already on an opaque pixel are kept (rounded to the pixel).
 * imageData is { data, width, height }; bounds is measureBounds(imageData). Deterministic, O(w + h) per anchor.
 */
export function snapAnchor(p, imageData, bounds) {
  if (!p || !(bounds && bounds.w > 0 && bounds.h > 0)) return p;
  const { data, width: W } = imageData;
  const op = (x, y) => data[(y * W + x) * 4 + 3] > 0;
  const rx = Math.round(p.x), ry = Math.round(p.y);
  const inB = rx >= bounds.x && rx < bounds.x + bounds.w && ry >= bounds.y && ry < bounds.y + bounds.h;
  if (inB && op(rx, ry)) return p.x === rx && p.y === ry ? p : { x: rx, y: ry };
  const top = x => { for (let y = bounds.y; y < bounds.y + bounds.h; y++) if (op(x, y)) return y; return -1; };
  const cx = Math.min(bounds.x + bounds.w - 1, Math.max(bounds.x, rx));
  for (let d = 0; d < bounds.w; d++) {
    for (const x of d ? [cx - d, cx + d] : [cx]) {
      if (x < bounds.x || x >= bounds.x + bounds.w) continue;
      const y = top(x);
      if (y >= 0) return { x, y };
    }
  }
  return p;
}

function rasterBuilding(model, style, o) {
  const S = ENGINE_OVER_CLASSIC * (o.scale > 0 ? o.scale : 1);
  const w = Math.max(1, o.w | 0 || 1), h = Math.max(1, o.h | 0 || 1);
  const site = !!o.site;
  const accent = typeof o.accent === 'string' ? o.accent : (style && typeof style.accent === 'string' ? style.accent : '#c46a42');
  const door = o.door === null ? null : typeof o.door === 'number' ? o.door : (o.door && Number.isFinite(o.door.x) ? o.door.x : Math.round(w * T / 2));
  const it = {
    id: `r3:${model}:${o.variant | 0}`, kind: site ? 'pr' : 'building', look: model, w, h, x: 0, y: 0, variant: o.variant | 0,
    village: { accent }, doorX: door, crown: !!o.crown, building: site, style: style && typeof style === 'object' ? style : undefined,
  };
  const ext = art.isoExtent(it, T, S), b = art.isoBuilding(it, T, !!o.lit, S);
  const iw = b.img.width, ih = b.img.height;
  // canvas from the extent (classic sizes its image the same way, floor/ceil apart), never smaller than the image
  const cw = Math.max(iw, Math.ceil(ext[2]) - Math.floor(ext[0])) + 2 * PAD, ch = Math.max(ih, Math.ceil(ext[3]) - Math.floor(ext[1])) + 2 * PAD;
  const c = createCanvas(cw, ch), g = c.getContext('2d');
  g.drawImage(b.img, PAD, PAD);
  const ox = PAD - b.dx, oy = PAD - b.dy;            // isoP(x0, y0) (the north corner) in img px
  const anchors = { door: pt(b.door, ox, oy), ridge: pt(b.ridge, ox, oy), chimney: pt(b.chimney, ox, oy), windows: (b.windows || []).map(p => pt(p, ox, oy)).filter(Boolean) };
  if (b.hub) anchors.hub = pt(b.hub, ox, oy);
  if (b.glow) anchors.glow = pt(b.glow, ox, oy);
  const res = finish(c, { x: ox, y: oy }, anchors, false);
  // The classic ridge/chimney points are projected at nominal heights (towers, spires, cupolas, the generic fallback),
  // so they can float off the drawn roof: pull them onto the real opaque top edge.
  if (anchors.ridge || anchors.chimney) {
    const id = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    for (const k of ['ridge', 'chimney']) if (anchors[k]) anchors[k] = snapAnchor(anchors[k], id, res.bounds);
  }
  return res;
}

// Props drawn by the engine's own art at the 32x16 scale (art/props/*): result.classic = false.
function rasterEngineProp(m, model, style, o) {
  const dir = o.dir === 'y' ? 'y' : 'x', len = Math.max(1, o.len | 0 || Math.max(o.w | 0 || 1, o.h | 0 || 1));
  const p = { kind: model, v: o.variant | 0, dir, len };
  const st = style && typeof style === 'object' ? style : null;
  const e = m.extent(p, st);
  if (!(e && e[2] - e[0] > 0 && e[3] - e[1] > 0)) return null;
  const cw = Math.ceil(e[2] - e[0]) + 2 * PAD, ch = Math.ceil(e[3] - e[1]) + 2 * PAD;
  const c = createCanvas(cw, ch), g = c.getContext('2d');
  const fx = PAD - Math.floor(e[0]), fy = PAD - Math.floor(e[1]);
  const fr = Math.max(1, m.frames | 0);
  m.draw(g, p, fx, fy, fr > 1 ? ((o.anim | 0) % fr + 0.5) / fr : 0, !!o.lit, st);
  return finish(c, { x: fx, y: fy }, {}, false);
}

function rasterProp(model, style, o) {
  const em = Object.hasOwn(ENGINE_PROPS, model) ? ENGINE_PROPS[model] : null;
  if (em) return rasterEngineProp(em, model, style, o);
  propArt ||= art.createPropArt();
  const dir = o.dir === 'y' ? 'y' : 'x', len = Math.max(1, o.len | 0 || Math.max(o.w | 0 || 1, o.h | 0 || 1));
  const p = { kind: model, v: o.variant | 0, dir, len };
  const st = style && typeof style === 'object' ? style : null;
  const e = propArt.extent(p, st);
  if (!(e[2] - e[0] > 0 && e[3] - e[1] > 0)) return null;
  const cw = Math.ceil(e[2] - e[0]) + 2 * PAD, ch = Math.ceil(e[3] - e[1]) + 2 * PAD;
  const c = createCanvas(cw, ch), g = c.getContext('2d');
  const fx = PAD - Math.floor(e[0]), fy = PAD - Math.floor(e[1]);
  const t = ((o.anim | 0) + 0.5) / (PROP_FPS[model] || 1);
  propArt.draw(g, p, fx, fy, t, !!o.lit, st);
  return finish(c, { x: fx, y: fy }, {}, true);
}

/**
 * @returns {{ img, bounds, pivot, anchors, classic: boolean } | null} null when the classic art has no such model.
 */
export function rasterize(model, style, opts = {}) {
  if (!art) throw new Error('raster: classic art not loaded (await loadClassicArt() or useClassicArt())');
  const o = opts || {};
  if (o.kind !== 'building') {
    const r = rasterProp(model, style, o);
    if (r) return r;
    if (o.kind === 'prop') return null;
  }
  return rasterBuilding(model, style, o);
}
