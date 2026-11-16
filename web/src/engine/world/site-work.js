// parity: vil.builders-cap-4-per-site
// addSiteWork: gives every PR-site object its `work` anchors from the mod, so the sim's `pr.site` place has hammering spots.
// The mod's optional `siteWork(site) -> Slot[]` (first-party, additive to API v1, like lightsFor) lists the preferred spots
// round one footprint; its LENGTH is the crew size (the fantasy mod: 4). A preferred spot that is not standable (lots are
// packed, so fences, walls and trees often take it) is replaced by the nearest free tile round the footprint, so a site
// still gets a full crew where the street allows. A builder who finds every spot taken is not hidden: claimOn returns
// null and resolvePlace falls back to the builder's own forecourt (the yard). Pure, no DOM. Runs after the cost and cover
// layers are final (build.js calls it just before its own anchor filter).
const MAX_CREW = 8;   // engine ceiling; the mod decides the real number

const stands = (grid, tx, ty) => grid.inBounds(tx, ty) && grid.get('occ', tx, ty) === 0 && grid.get('cost', tx, ty) < 255 && grid.get('cover', tx, ty) === 0;
const faceOf = (o, tx, ty) => (tx < o.tx ? 1 : tx >= o.tx + o.w ? 3 : ty < o.ty ? 2 : 0);

/** @param {import('../core/grid.js').WorldGrid} grid  @param {Map<string, object>} objects  @param {{ siteWork?: Function }} mod */
export function addSiteWork(grid, objects, mod) {
  const fn = mod?.siteWork;
  if (typeof fn !== 'function' || !grid) return;
  for (const o of objects.values()) {
    if (o.kind !== 'building' || o.data?.owner !== 'pr') continue;
    let spots;
    try { spots = fn({ tx: o.tx, ty: o.ty, w: o.w, h: o.h }); } catch { continue; }
    if (!Array.isArray(spots)) continue;
    spots = spots.filter(s => s && Number.isFinite(s.tx) && Number.isFinite(s.ty)).slice(0, MAX_CREW);
    const want = spots.length, taken = new Set(), work = [];
    const take = (tx, ty, face) => {
      const k = `${tx},${ty}`;
      if (work.length >= want || taken.has(k) || !stands(grid, tx, ty)) return;
      taken.add(k); work.push({ tx, ty, sub: 0, face: face & 3 });
    };
    for (const s of spots) take(s.tx | 0, s.ty | 0, s.face | 0);
    if (work.length < want) {   // ring fallback: free tiles 1..2 outside the footprint, nearest the front first
      const fx = o.door ? o.door.tx : o.tx + (o.w >> 1), fy = o.door ? o.door.ty : o.ty + o.h;
      const ring = [];
      for (let ty = o.ty - 2; ty < o.ty + o.h + 3; ty++) for (let tx = o.tx - 2; tx < o.tx + o.w + 2; tx++) {
        if (tx >= o.tx && tx < o.tx + o.w && ty >= o.ty && ty < o.ty + o.h) continue;
        if (o.door && tx === o.door.tx && ty === o.door.ty) continue;   // keep the doorstep free
        ring.push({ tx, ty, d: (tx - fx) ** 2 + (ty - fy) ** 2 });
      }
      ring.sort((a, b) => a.d - b.d || a.ty - b.ty || a.tx - b.tx);
      for (const r of ring) take(r.tx, r.ty, faceOf(o, r.tx, r.ty));
    }
    if (work.length) o.anchors = { ...(o.anchors || {}), work };
  }
}
