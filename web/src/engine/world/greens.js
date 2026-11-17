// Greens (city cap, 2026-11-17): a free lot the city does not need drawn as a house becomes a little green instead (a
// garden, an orchard, a small plaza: the mod's hooks.freeLot decides). Pure, no DOM.
//
// Which free lots: one a retired agent left (persisted lots L.f), and any free lot past the city cap in plan order (the
// plan lists lots nearest the plaza first, a nested plan its old core first, so these are the outskirts). Geometry never
// moves: the lot keeps its tiles and its id, so the next newcomer can take it and a house stands there again.
import { footprintFor, originTile } from './footprints.js';
import { MOD_CODE_MAX } from '../mod/api.js';

/** The lot ids of `v` to draw as greens: free lots (no owner) freed by a retirement, or at plan index >= cap. */
export function greenLotIds(v, L, cap, isFree) {
  const out = [];
  const lots = v.plan?.lots || [];
  for (let i = 0; i < lots.length; i++) {
    const id = lots[i].id;
    if (!isFree(id)) continue;
    if ((L?.f && Object.prototype.hasOwnProperty.call(L.f, id)) || (cap != null && i >= cap)) out.push(id);
  }
  return out;
}

/**
 * Replaces the building of lot object `o` with the mod's green: ground code over the lot rect and its props (lot-local
 * tiles). Without hooks.freeLot, or when the hook throws or answers nothing usable, the house stays (never a bare scar).
 * @returns {object|null} { id, tx, ty, w, h, kind } of the green, or null when the house stays
 */
export function stampGreen(grid, objects, o, mod, ctx) {
  const hook = mod?.hooks?.freeLot;
  if (typeof hook !== 'function') return null;
  let spec;
  try { spec = hook({ id: o.id, w: o.w, h: o.h, rank: o.rank ?? null, look: o.model ?? null }, ctx); } catch { return null; }
  if (!spec || typeof spec !== 'object') return null;
  const codes = new Set((mod.terrain?.types || []).map(t => t.code));
  const ground = Number.isInteger(spec.ground) && spec.ground > 0 && spec.ground <= MOD_CODE_MAX && codes.has(spec.ground) ? spec.ground : null;
  if (ground == null) return null;
  const num = objects.numOf(o.id);
  grid.unstamp(o, num);
  objects.delete(o.id);
  for (let y = o.ty; y < o.ty + o.h; y++) for (let x = o.tx; x < o.tx + o.w; x++) if (grid.inBounds(x, y)) { grid.set('ground', x, y, ground); grid.set('road', x, y, 0); }
  const proj = o.project, base = `green:${o.id.slice(4)}`;
  let i = 0;
  for (const p of Array.isArray(spec.props) ? spec.props.slice(0, 24) : []) {
    if (!p || typeof p.kind !== 'string' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const decl = mod.objects?.props?.[p.kind];
    if (!decl) continue;
    const fp = footprintFor(p, mod.objects), variant = p.v | 0, id = `${base}:${i++}`;
    if (!fp) {   // a decal
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      if (tx < 0 || ty < 0 || tx >= o.w || ty >= o.h) continue;
      objects.add({ id, kind: 'decal', model: p.kind, tx: o.tx + tx, ty: o.ty + ty, w: 1, h: 1, z: 0, walk: 'floor', project: proj, styleKey: o.styleKey, variant });
      continue;
    }
    if (fp.walk !== 'block') continue;
    const t = originTile(p, fp);
    if (t.tx < 0 || t.ty < 0 || t.tx + fp.w > o.w || t.ty + fp.h > o.h) continue;
    const obj = { id, kind: fp.kind === 'tree' ? 'tree' : 'prop', model: p.kind, tx: o.tx + t.tx, ty: o.ty + t.ty, w: fp.w, h: fp.h, z: fp.z, walk: 'block', project: proj, styleKey: o.styleKey, variant };
    if (!grid.canPlace(obj)) continue;
    const n = objects.add(obj), r = grid.stamp(obj, n);
    if (r && r.ok === false) objects.delete(id);
  }
  return { id: o.id, tx: o.tx, ty: o.ty, w: o.w, h: o.h, kind: spec.kind ?? null };
}
