// Fantasy mod: night light pools beyond lamps (the engine already lights `lamp` / `lamppost` / windows / lanterns).
// lightsFor(obj) is the engine's per-object `lightsFor` seam (render/lighting.js createLighting({ lightsFor })): a spec
// { r, warm, flicker, dx, dy } or a list of them, or null to keep the engine default (lamps). `extraLights` covers the
// sources that are not objects (plazas, the central square, villagers); its entries are engine light records.
// Radii follow classic world.js drawNight: door 26, work lamp 40, plaza 64, central square 96, villager 20 (unwarmed).
// Pure; imports nothing. The harbour's beacon and buoy pools are here; its lamps and lighthouse use the engine defaults.
// parity: night.veil-light-pools
export const POOL_R = Object.freeze({ door: 26, site: 40, plaza: 64, square: 96, villager: 20 });
const HALF_W = 16, HALF_H = 8;   // tile diamond 32x16 (screen = (tx - ty) * 16, (tx + ty) * 8)
const scr = (tx, ty) => ({ sx: (tx - ty) * HALF_W, sy: (tx + ty) * HALF_H });
const centre = o => scr(o.tx + (o.w || 1) / 2, o.ty + (o.h || 1) / 2);

/** @returns {object[]|null} light specs for a building (door pool; a work lamp too on a PR building site), else null */
// parity: har.beacon
export function lightsFor(o) {
  // the harbour's own: the beacon on the mole (a warm steady pool), a channel buoy's lamp (small, red / green by variant);
  // lamps and the lighthouse keep the engine's default pools
  if (o?.model === 'beacon') return [{ r: 60, warm: 1, flicker: 0.05, dx: 0, dy: 36 }];
  if (o?.model === 'buoy') return [{ r: 18, warm: 0, flicker: 0.1, dx: 0, dy: 14 }];
  if (!o || o.kind !== 'building') return null;
  const out = [], c = centre(o);
  if (o.data?.owner === 'pr' && o.data.building) out.push({ r: POOL_R.site, warm: 1, flicker: 0.25, dx: 0, dy: Math.round((o.z || 24) * 0.6) });
  const d = o.door;
  if (d && Number.isFinite(d.tx) && Number.isFinite(d.ty)) {
    const p = scr(d.tx + 0.5, d.ty + 0.5);
    out.push({ r: POOL_R.door, warm: 1, flicker: 0.05, dx: p.sx - c.sx, dy: c.sy - p.sy + 4 });
  }
  return out.length ? out : null;
}

const INDOORS = 8;
/** Pools for plazas, the central square and villagers, as lighting.js records { id, kind, x, y, r, warm, flicker }.
 *  @param {{villages?:object[], square?:object}} world @param {Iterable<object>|Map<any,object>} [actors] */
export function extraLights(world, actors) {
  const out = [], mid = r => (r && r.w > 0 && r.h > 0 ? scr(r.x + r.w / 2, r.y + r.h / 2) : null);
  for (const v of world?.villages || []) {
    const p = mid(v.plaza);
    if (p) out.push({ id: `plaza:${v.name}`, kind: 'plaza', x: p.sx, y: p.sy, r: POOL_R.plaza, warm: 1, flicker: 0.1 });
  }
  const sq = mid(world?.square);
  if (sq) out.push({ id: 'square', kind: 'square', x: sq.sx, y: sq.sy, r: POOL_R.square, warm: 1, flicker: 0.1 });
  if (actors) for (const a of actors.values ? actors.values() : actors) {
    if (!a || (a.kind !== 'agent' && a.kind !== 'folk') || ((a.flags | 0) & INDOORS) || !Number.isFinite(a.x)) continue;
    const p = scr(a.x, a.y);
    out.push({ id: `pool:${a.id}`, kind: 'villager', x: p.sx, y: p.sy - 8, r: POOL_R.villager, warm: 0, flicker: 0 });
  }
  return out;
}
