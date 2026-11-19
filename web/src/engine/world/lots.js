// Lot assignment (port of world.js placeVillage's lot section, design §1.3 step 4). Pure.

// Who wants which lot rank: each request names its rank (L, M or S) and falls back to the others. PRs fill what is left.
// The rank rule itself (boss/pinned -> L, lead -> M, else S) is the mod's (mod.hooks.lots) and arrives in the requests.
export const RANKS = { L: ['L', 'M', 'S'], M: ['M', 'L', 'S'], S: ['S', 'M', 'L'] };

/** settlement: { name, plan: { lots }, requests: LotRequest[], cap, tier, crowns? }, LotRequest = { item, owner, rank, agent?, pr?,
 * building? } (item = the persisted key, e.g. 'home:<id>' / 'pr:<project>#<n>', in the server's ids). Home requests are
 * served L, M, S first (the request order breaks ties), then PR requests, as classic.
 * Persisted as persistedLots[name] = { cap, tier, crowns, a: { itemId: lotId }, h: { itemId: goneSince }, at?: { itemId: [x, y] }, nest? };
 * a re-plan (tier, capacity or crown count change) starts the map afresh, but each item first looks for the free lot
 * nearest its `at` (its lot's absolute top-left before the re-plan; written whenever the settlement has an origin). An item keeps its lot for as long as it shows; one that is gone
 * keeps it mod.rules.holdMs (then it is freed), and is the first to give it up when a newcomer finds every lot taken.
 * Mutates persistedLots[settlement.name] like classic.
 * settlement.retired (optional Set of items): retired homes, freed at once and listed in `freed` (lot ids) and L.f.
 * @returns {{ byLot: Map<string, string>, items: Map<string, { owner: 'home'|'pr', agentId?, pr?, building? }>, freed: string[] }} */
// parity: world.persisted-layout (the saved lots and their absolute positions carry over every poll, re-plan and reload)
export function assignLots(settlement, persistedLots, now, mod) {
  const holdMs = mod?.rules?.holdMs;
  if (!Number.isFinite(holdMs)) throw new Error('engine: assignLots needs mod.rules.holdMs');
  const { name, plan: p } = settlement;
  let L = persistedLots[name], was = null;
  // parity: world.replan-only-changed-plot
  // M6 nested growth: a plan that is, or nests, the plan these lots were dealt on (persisted `nest` = that plan's chain)
  // keeps every old lot id on the same tiles, so a re-plan keeps each item's lot instead of dealing afresh.
  const chain = typeof p.chain === 'string' ? p.chain : null;
  const nested = !!L && !!chain && typeof L.nest === 'string' && (L.nest === chain || L.nest === p.nest?.from);
  if (!L || L.cap !== settlement.cap || L.tier !== settlement.tier || (L.crowns ?? 1) !== (settlement.crowns ?? 1)) {
    if (nested) Object.assign(L, { cap: settlement.cap, tier: settlement.tier, crowns: settlement.crowns ?? 1 });
    else {
      was = L?.at || null;   // where each item stood before this re-plan (absolute tiles; absent in layouts saved before M4)
      L = persistedLots[name] = { cap: settlement.cap, tier: settlement.tier, crowns: settlement.crowns ?? 1, a: {}, h: {} };
    }
  }
  if (chain) L.nest = chain; else delete L.nest;
  L.h ||= {};
  // City cap (prune.js): a retired agent's home is freed at once (no hold) and its lot is remembered in L.f (lot id ->
  // when) so the world draws it as a green (hooks.freeLot) until a newcomer takes it. Nothing else moves.
  const retired = settlement.retired instanceof Set ? settlement.retired : null, freed = [];
  const o = settlement.origin || settlement.block || null;
  const abs = lot => (o ? [o.x + lot.x, o.y + lot.y] : null);
  const lots = new Map(p.lots.map(l => [l.id, l]));
  const want = [], extra = new Map();
  const reqs = settlement.requests || [];
  const add = r => {
    want.push([r.item, RANKS[r.rank] || RANKS.S]);
    extra.set(r.item, r.owner === 'pr' ? { owner: 'pr', pr: r.pr, building: !!r.building } : { owner: 'home', agentId: r.agent });
  };
  // parity: lots.rank-l-m-s
  for (const rk of ['L', 'M', 'S']) for (const r of reqs) if (r.owner !== 'pr' && r.rank === rk) add(r);
  for (const r of reqs) if (r.owner === 'pr' || !RANKS[r.rank]) add(r);
  for (const [id, lot] of Object.entries(L.a)) {
    if (!lots.has(lot)) { delete L.a[id]; delete L.h[id]; continue; }   // the plan has no such lot any more
    if (extra.has(id)) { delete L.h[id]; continue; }
    if (retired?.has(id)) { (L.f ||= {})[lot] = now; freed.push(lot); delete L.a[id]; delete L.h[id]; continue; }
    // parity: world.vanished-hold-12h
    L.h[id] ??= now;
    if (now - L.h[id] > holdMs) { delete L.a[id]; delete L.h[id]; }
  }
  const used = new Set(Object.values(L.a));
  // Engine (M4 layout): a re-plan draws a new plan, so classic dealt every item a fresh lot in request order
  // and homes jumped across the block. An item that had a lot before the re-plan now takes the free lot of its best
  // available rank nearest where it stood (an identical lot at the same tiles keeps it exactly in place).
  const nearest = (rank, at) => {
    let best = null, bd = Infinity;
    for (const l of p.lots) {
      if (l.rank !== rank || used.has(l.id)) continue;
      const q = abs(l), d = (q[0] - at[0]) ** 2 + (q[1] - at[1]) ** 2;
      if (d < bd) { best = l; bd = d; }
    }
    return best;
  };
  for (const [id, ranks] of want) {
    if (L.a[id]) continue;
    let lot = null;
    const at = o && was?.[id];
    if (Array.isArray(at)) for (const r of ranks) if ((lot = nearest(r, at))) break;
    if (!lot) for (const r of ranks) if ((lot = p.lots.find(l => l.rank === r && !used.has(l.id)))) break;
    lot ||= p.lots.find(l => !used.has(l.id));
    if (!lot) {
      const gone = Object.keys(L.h).filter(g => L.a[g]).sort((x, y) => L.h[x] - L.h[y])[0];
      if (!gone) continue;   // more items than lots: it waits unbuilt
      lot = lots.get(L.a[gone]); delete L.a[gone]; delete L.h[gone];
    }
    L.a[id] = lot.id; used.add(lot.id);
    if (L.f) delete L.f[lot.id];
  }
  if (L.f) { for (const k of Object.keys(L.f)) if (!lots.has(k) || used.has(k)) delete L.f[k]; if (!Object.keys(L.f).length) delete L.f; }
  // where each assigned item stands (absolute top-left of its lot), for the next re-plan; only written with an origin
  if (o) { L.at = {}; for (const [id, lotId] of Object.entries(L.a)) { const l = lots.get(lotId); if (l) L.at[id] = abs(l); } }
  const byLot = new Map(Object.entries(L.a).filter(([id]) => extra.has(id)).map(([id, lot]) => [lot, id]));
  const items = new Map([...extra].filter(([id]) => L.a[id]));
  return { byLot, items, freed };
}
