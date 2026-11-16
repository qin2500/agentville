// Engine render: village accents (M4 P4). Per-village accent colour, distinct from its neighbours; the plot accent
// edge line; flags on home ridges; the accent a plaza banner must be drawn with. Pure of DOM except flagSprite's canvas.
import { toScreen } from '../core/coords.js';
import * as flagArt from '../art/props/flag.js';

// parity: style.plot-accent-edge
// parity: style.flags-on-ridges
// parity: style.banners-on-plazas
export const DEFAULT_PALETTE = ['#e4572e', '#2e86de', '#f2b134', '#9b59b6', '#16a085', '#e84393', '#27ae60', '#d35400'];

const keyOf = b => String(b.project ?? b.name ?? '');
const gapBetween = (a, b) => Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h), 0);

/**
 * Greedy graph colouring of village blocks by adjacency. blocks: [{project|name, x, y, w, h}] (tiles); two blocks are
 * neighbours when the gap between them is <= `near` tiles. Visits blocks in project-key order, so the result depends only
 * on the set of blocks, never on the order they arrive in. A block takes the first palette colour (least used overall,
 * then palette order) none of its already-coloured neighbours wears; when the palette is exhausted around it, the colour
 * worn by the fewest neighbours.
 * @returns {Map<string, string>} project -> accent
 */
export function distinctAccents(blocks, palette = DEFAULT_PALETTE, near = 6) {
  const pal = palette && palette.length ? palette : DEFAULT_PALETTE;
  const list = [...blocks].filter(b => b && keyOf(b)).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const out = new Map(), idx = new Map(), tally = pal.map(() => 0);
  for (const b of list) {
    const k = keyOf(b);
    if (idx.has(k)) continue;
    const worn = pal.map(() => 0);
    for (const o of list) {
      const j = idx.get(keyOf(o));
      if (j !== undefined && o !== b && gapBetween(b, o) <= near) worn[j]++;
    }
    let best = 0;
    for (let i = 1; i < pal.length; i++) if (worn[i] < worn[best] || (worn[i] === worn[best] && tally[i] < tally[best])) best = i;
    idx.set(k, best); tally[best]++; out.set(k, pal[best]);
  }
  return out;
}

/**
 * Neighbour rule for any per-block pick (roof colour, paving pattern, ...). Same greedy as distinctAccents, generalised: blocks
 * visit in project-key order; `options(project)` lists the candidate values for that block, its own preferred value first.
 * A block keeps the first option none of its already-decided neighbours wears; when every option is worn around it, the one
 * worn by the fewest neighbours (earlier option wins ties). Depends only on the set of blocks, never on arrival order.
 * @param {Array<{project?:string,name?:string,x:number,y:number,w:number,h:number}>} blocks
 * @param {(project:string)=>any[]} options
 * @returns {Map<string, any>} project -> picked value
 */
export function distinctPicks(blocks, options, near = 6) {
  const list = [...blocks].filter(b => b && keyOf(b)).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const out = new Map(), seen = new Set();
  for (const b of list) {
    const k = keyOf(b);
    if (seen.has(k)) continue;
    seen.add(k);
    const opts = options(k) || [];
    if (!opts.length) continue;
    const worn = opts.map(() => 0);
    for (const o of list) {
      const ok = keyOf(o);
      if (o === b || ok === k || !out.has(ok) || gapBetween(b, o) > near) continue;
      const i = opts.indexOf(out.get(ok));
      if (i >= 0) worn[i]++;
    }
    let best = 0;
    for (let i = 1; i < opts.length; i++) if (worn[i] < worn[best]) best = i;
    out.set(k, opts[best]);
  }
  return out;
}

/** project -> accent for a built world (world.villages[].block, mod palette). */
export function accentsOf(world) {
  const vs = world?.villages || [];
  const pal = world?.mod?.rules?.layout?.accents;
  return distinctAccents(vs.filter(v => v.block).map(v => ({ project: v.name, ...v.block })), pal);
}

/** Plot accent edge: the diamond round each project block, in screen px. -> [{project, accent, pts:[x,y,...]}] */
export function accentEdges(world, accents = accentsOf(world)) {
  const out = [];
  for (const v of world?.villages || []) {
    const b = v.block; if (!b) continue;
    const c = [toScreen(b.x, b.y), toScreen(b.x + b.w, b.y), toScreen(b.x + b.w, b.y + b.h), toScreen(b.x, b.y + b.h)];
    out.push({ project: v.name, accent: accents.get(v.name) ?? v.accent ?? DEFAULT_PALETTE[0], pts: c.flatMap(p => [p.sx, p.sy]) });
  }
  return out;
}

const rgba = (hexc, a) => `rgba(${[1, 3, 5].map(i => parseInt(hexc.slice(i, i + 2), 16)).join(',')},${a})`;
/** One thin strip per block edge (a 2 px parallelogram, translucent so roads and grass show through). */
export function drawAccentEdges(g, edges, gview) {
  const r = gview?.rect;
  for (const e of edges) {
    const p = e.pts, col = /^#[0-9a-f]{6}$/i.test(e.accent) ? rgba(e.accent, 0.55) : e.accent;
    if (r) {
      const xs = [p[0], p[2], p[4], p[6]], ys = [p[1], p[3], p[5], p[7]];
      if (Math.max(...xs) < r[0] || Math.min(...xs) > r[2] || Math.max(...ys) < r[1] || Math.min(...ys) > r[3]) continue;
    }
    for (let i = 0; i < 4; i++) {
      const x0 = p[i * 2], y0 = p[i * 2 + 1], x1 = p[((i + 1) % 4) * 2], y1 = p[((i + 1) % 4) * 2 + 1];
      g.poly([x0, y0, x1, y1, x1, y1 + 2, x0, y0 + 2], col);
    }
  }
}

const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const homesOnly = o => o && o.kind === 'building' && (o.data?.agentId != null || o.home === true);

/**
 * Flag positions on home ridges. objs: iterable of world objects (buildings with data.agentId are homes; pass `all` true
 * to flag every building). entryOf(obj) -> sprite entry { anchors: { ridge: {x, y} }, pivot: {x, y} } or null (skipped
 * until the sprite is ready). accents: Map project -> accent (default accentsOf(world)).
 * -> [{x, y, accent, phase}] in 1x world screen px (x, y = staff foot).
 */
export function ridgeFlags(objs, entryOf, accents, all = false) {
  const out = [];
  for (const o of objs || []) {
    if (!(all ? o?.kind === 'building' : homesOnly(o))) continue;
    const e = entryOf?.(o), rg = e?.anchors?.ridge;
    if (!rg || !e.pivot) continue;
    const n = toScreen(o.tx, o.ty);
    out.push({ x: n.sx + rg.x - e.pivot.x, y: n.sy + rg.y - e.pivot.y, accent: accents?.get?.(o.project) ?? o.accent ?? DEFAULT_PALETTE[0], phase: hash(String(o.id)) % flagArt.frames });
  }
  return out;
}

const sprites = new Map();
function makeImg(w, h, data) {
  try {
    let c = null;
    if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
    else if (typeof document !== 'undefined') { c = document.createElement('canvas'); c.width = w; c.height = h; }
    const x = c?.getContext?.('2d'); if (!x) return null;
    const id = x.createImageData(w, h); id.data.set(data); x.putImageData(id, 0, 0);
    return c;
  } catch { return null; }
}
/** Cached sprite of the flag: { img|null, w, h, ox, oy, data }; ox, oy is the staff foot inside the image. */
export function flagSprite(accent, frame = 0) {
  const f = ((frame % flagArt.frames) + flagArt.frames) % flagArt.frames, k = `${accent}|${f}`;
  let s = sprites.get(k);
  if (!s) { const px = flagArt.pixels(accent, f); s = { ...px, img: makeImg(px.w, px.h, px.data) }; sprites.set(k, s); if (sprites.size > 256) sprites.delete(sprites.keys().next().value); }
  return s;
}

/** Draw the flags in the view; they wave at ~6 fps from t (seconds), each with its own phase. */
export function drawFlags(g, flags, t, gview) {
  const r = gview?.rect;
  for (const fl of flags) {
    if (r && (fl.x < r[0] - 20 || fl.x > r[2] + 20 || fl.y < r[1] - 20 || fl.y > r[3] + 30)) continue;
    const s = flagSprite(fl.accent, Math.floor(t * 6) + fl.phase);
    if (s.img) g.image(s.img, 0, 0, s.w, s.h, Math.round(fl.x - s.ox), Math.round(fl.y - s.oy), s.w, s.h);
    else g.rect(Math.round(fl.x), Math.round(fl.y - 14), 6, 5, fl.accent);   // no canvas (headless): a plain pennant block
  }
}
