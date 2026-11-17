// agentville.fantasy house variety (city-variety, 2026-11-17): which of the 16 building variants each lot of a settlement
// plan draws. The art (web/src/iso.js) reads a variant as two independent axes:
//   variant % 4   the massing archetype: the one big feature (turret, oriel, street gable, wing...) and the gable direction
//   (variant >> 2) & 3  the height class 0..3: storeys and roof pitch (0 a low house .. 3 a tall core house)
//   variant >> 4  a free detail axis (tone, chimney, sign, climbers: everything else the art hashes from the variant)
// so two lots that differ in variant % 4 never share a silhouette, and the height class shades the city from a tall core
// to low houses at its edge.
//
// The art also picks a house's colours by variant (iso.js houseHues): roof slot (v % 4 + 3 * (v >> 2)) % 6 and wall slot
// (3 * (v % 4) + (v >> 2)) % 4 into the district palette (style.js housePalette: 6 roofs, up to 4 wall pairs), so the
// picker below also keeps neighbours off the same roof and wall slot when it can, and off the same height class (a
// skyline that steps up and down, never one eave line).
export const roofSlot = v => ((v & 3) + 3 * ((v >> 2) & 3)) % 6;
export const wallSlot = v => (3 * (v & 3) + ((v >> 2) & 3)) % 4;
//
// Pure and deterministic in (lots, key, opts): no clock, no global RNG. Greedy in plan order, looking only at lots placed
// before, so a plan that grows by appending lots never changes the variants of the lots it already had (prefix-stable).
// It never moves a lot: it only picks how each one is drawn.

const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const mixh = h => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };

/** Row neighbours: same y, at most ROW_GAP tiles apart; column neighbours: same x, at most COL_GAP apart (classic variety.js). */
export const ROW_GAP = 3, COL_GAP = 4;
const gap = (a0, aw, b0, bw) => Math.max(a0, b0) - Math.min(a0 + aw, b0 + bw);
export const areNeighbours = (a, b) => (a.y === b.y && gap(a.x, a.w, b.x, b.w) <= ROW_GAP) || (a.x === b.x && gap(a.y, a.h, b.y, b.h) <= COL_GAP);

/** The height class a lot leans to, from its distance to the plan centre (0 = centre, 1 = the plot's edge): the core is
 *  tall, the edge low. Without a plan size every lot leans to the middle classes. */
function preferredClass(lot, opts) {
  const W = Number(opts?.w), H = Number(opts?.h);
  if (!(W > 0 && H > 0)) return 1.5;
  const cx = lot.x + lot.w / 2 - W / 2, cy = lot.y + lot.h / 2 - H / 2;
  const d = Math.min(1, Math.hypot(cx / (W / 2), cy / (H / 2)) / Math.SQRT2 * 1.1);
  return 0.6 + 2.8 * (1 - d);
}

/**
 * The variant (0..63) each lot draws. lots: [{ id, x, y, w, h }] in plan order (plan-local tiles); key: the project key;
 * opts: { w, h, nest? } the plan size (for the tall core) and plan.nest (nested growth keeps old lots' variants). Neighbours never share a variant, and share variant % 4 only when
 * their earlier neighbours already use all four archetypes.
 * @returns {Map<string, number>}
 */
export function lotVariants(lots, key, opts = {}) {
  const out = new Map(), placed = [];
  if (!Array.isArray(lots)) return out;
  const k = String(key ?? '');
  // Nested growth (city-plan.js: a tier-up keeps the older plan's lots, same ids and tiles, at plan.nest = { plan, dx, dy }):
  // a lot the older plan already had keeps the variant it drew there (when its look is unchanged), so a tier-up never
  // redraws an old house; those lots are placed first, and the new lots fit round them.
  const NP = opts?.nest?.plan, keep = new Map();
  if (NP && Array.isArray(NP.lots)) {
    const was = lotVariants(NP.lots, k, { w: NP.w, h: NP.h, nest: NP.nest }), look = new Map(NP.lots.map(l => [String(l?.id), l?.look]));
    for (const lot of lots) if (lot && lot.id != null && was.has(String(lot.id)) && look.get(String(lot.id)) === lot.look) keep.set(String(lot.id), was.get(String(lot.id)));
  }
  for (const lot of lots) if (lot && keep.has(String(lot.id))) { out.set(String(lot.id), keep.get(String(lot.id))); placed.push(lot); }
  for (const lot of lots) {
    if (!lot || lot.id == null || keep.has(String(lot.id))) continue;
    const id = String(lot.id), h = mixh(fnv(`${k}|${id}`));
    const near = [];
    for (const o of placed) if (areNeighbours(lot, o)) near.push(out.get(String(o.id)) & 15);
    const usedArch = new Set(near.map(v => v & 3)), used = new Set(near), usedRoof = new Set(near.map(roofSlot)), usedWall = new Set(near.map(wallSlot)), usedCls = new Set(near.map(v => (v >> 2) & 3));
    const pref = preferredClass(lot, opts);
    // a class near the preference (a hashed nudge of up to one class, so a row is not one height)
    const cls = Math.max(0, Math.min(3, Math.round(pref + ((h >>> 8) % 3) - 1 + ((h >>> 12) % 2 ? 0.25 : -0.25))));
    let best = -1, bestCost = Infinity;
    for (let t = 0; t < 16; t++) {
      const v = (h + t) & 15, arch = v & 3, c = v >> 2;
      const cost = (used.has(v) ? 100 : 0) + (usedArch.has(arch) ? 10 : 0) + (usedRoof.has(roofSlot(v)) ? 3 : 0) + (usedWall.has(wallSlot(v)) ? 1.5 : 0) + (usedCls.has(c) ? 2.5 : 0)
        + Math.abs(c - cls) * 2 + t * 0.01;
      if (cost < bestCost) { bestCost = cost; best = v; }
    }
    // bits 4-5: a free detail axis (iso.js hashes the whole variant into tone, chimney, sign, ivy...), so a city draws
    // up to 64 different houses per look instead of 16; neighbours already differ in the low four bits
    out.set(id, best | (((h >>> 20) & 3) << 4));
    placed.push(lot);
  }
  return out;
}
