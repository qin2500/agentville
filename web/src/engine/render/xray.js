// X-ray and building fade (design §2.4, §3.6, R9). Pure: reads world.grid.cover and world.objects, draws through Gfx
// calls only (rect). Never mutates the world or actors.
//   occluded(actor)        -> true when the actor's feet tile has cover > 0 (grid.cover, derived by world/cover.js)
//   coveringIds(actor)     -> ids of the buildings in front of the actor's box (cover.js keeps no id, so geometry)
//   fadeFor(obj, actors)   -> 0.35 when obj hides a selected / stalled actor (or houses an indoors one), else 1
//   draw(gfx, cam, actors) -> flat-colour silhouettes of occluded actors (rim + faded fill), world px, layer 6
import { toScreen } from '../core/coords.js';

export const FADE_ALPHA = 0.35;
export const ALPHA_SELECTED = 0.9;
export const ALPHA_OTHER = 0.6;
export const MAX_XRAY = 32;
const BOX_W = 16, BOX_H = 24;
// Same bit order as sim/actor.js FLAGS (S2); actor.selected / actor.indoors booleans are also honoured.
const F = { VISIBLE: 1, SELECTED: 2, OCCLUDED: 4, INDOORS: 8, GHOST: 16 };
const isSelected = a => !!(a.selected || (a.flags & F.SELECTED));
const isIndoors = a => !!(a.indoors || (a.flags & F.INDOORS));
const isGhost = a => !!(a.flags & F.GHOST);
const isStalled = a => {
  const s = a.status;
  return !!(s && (s.stopped || s.bucket === 'stalled' || s.bucket === 'error' || s.state === 'stalled'));
};
const wanted = a => isSelected(a) || isStalled(a) || isIndoors(a);

function bbox(o) {   // screen bbox of a building prism (coords.js projection)
  const z = o.z || 0;
  return { x0: (o.tx - o.ty - o.h) * 16, x1: (o.tx + o.w - o.ty) * 16,
    y0: (o.tx + o.ty) * 8 - z, y1: (o.tx + o.w + o.ty + o.h) * 8 };
}

export function createXray({ world }) {
  let blds = null, blVer = -1;
  const buildings = () => {
    const v = world?.grid?.version ?? 0;
    if (!blds || blVer !== v) {
      blds = [];
      for (const o of world.objects.values()) if (o.kind === 'building') blds.push({ o, b: bbox(o), depth: o.tx + o.w - 1 + o.ty + o.h - 1 });
      blVer = v;
    }
    return blds;
  };
  const tileOf = a => [Math.floor(a.x), Math.floor(a.y)];

  function occluded(actor) {
    if (!actor || !world?.grid) return false;
    const [tx, ty] = tileOf(actor);
    return world.grid.get('cover', tx, ty) > 0;
  }

  function coveringIds(actor) {
    const out = [];
    if (!actor || !occluded(actor)) return out;
    const [tx, ty] = tileOf(actor);
    const { sx, sy } = toScreen(actor.x, actor.y, 0);
    const bx0 = sx - BOX_W / 2, bx1 = sx + BOX_W / 2, by0 = sy - BOX_H, by1 = sy;
    for (const { o, b, depth } of buildings()) {
      if (depth <= tx + ty) continue;
      if (tx >= o.tx && tx < o.tx + o.w && ty >= o.ty && ty < o.ty + o.h) continue;
      if (b.x1 <= bx0 || b.x0 >= bx1 || b.y1 <= by0 || b.y0 >= by1) continue;
      out.push(o.id);
    }
    return out;
  }

  function fadeFor(obj, actors) {
    if (!obj || obj.kind !== 'building' || !actors) return 1;
    const list = typeof actors.values === 'function' ? actors.values() : actors;
    for (const a of list) {
      if (!a || isGhost(a) || !wanted(a)) continue;
      if (isIndoors(a) && (a.home === obj.id || a.target === obj.id)) return FADE_ALPHA;
      if (coveringIds(a).includes(obj.id)) return FADE_ALPHA;
    }
    return 1;
  }

  function draw(gfx, cam, actors) {
    if (!actors) return 0;
    const list = typeof actors.values === 'function' ? [...actors.values()] : actors;
    const hit = [];
    for (const a of list) {
      if (!a || isGhost(a) || isIndoors(a) || !occluded(a)) continue;
      hit.push(a);
    }
    hit.sort((p, q) => isSelected(q) - isSelected(p));   // selected first so the cap never drops it
    let n = 0;
    for (const a of hit.slice(0, MAX_XRAY)) {
      const { sx, sy } = toScreen(a.x, a.y, 0);
      const alpha = isSelected(a) ? ALPHA_SELECTED : ALPHA_OTHER;
      const col = a.color || a.look?.color || '#9fd4ff';
      const x = Math.round(sx - BOX_W / 2 + 2), y = Math.round(sy - BOX_H + 2), w = BOX_W - 4, h = BOX_H - 2;
      const c = fade(col, alpha), rim = `rgba(255,255,255,${(alpha * 0.8).toFixed(2)})`;
      gfx.rect(x - 1, y - 1, w + 2, h + 2, rim);
      gfx.rect(x, y, w, h, c);
      n++;
    }
    return n;
  }
  return { occluded, coveringIds, fadeFor, draw };
}

function fade(col, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  const v = parseInt(m[1], 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${alpha})`;
}
