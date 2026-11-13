// Lot assignment (port of world.js placeVillage's lot section, design §1.3 step 4). OWNER: A4. Pure.

// Who wants which lot rank: each request names its rank (L, M or S) and falls back to the others. PRs fill what is left.
// The rank rule itself (boss/pinned -> L, lead -> M, else S) is the mod's (mod.hooks.lots) and arrives in the requests.
export const RANKS = { L: ['L', 'M', 'S'], M: ['M', 'L', 'S'], S: ['S', 'M', 'L'] };

/** settlement: { name, plan: { lots }, requests: LotRequest[], cap, tier, crowns? }, LotRequest = { item, owner, rank, agent?, pr?,
 * building? } (item = the persisted key, e.g. 'home:<id>' / 'pr:<project>#<n>', in the server's ids). Home requests are
 * served L, M, S first (the request order breaks ties), then PR requests, as classic.
 * Persisted as persistedLots[name] = { cap, tier, crowns, a: { itemId: lotId }, h: { itemId: goneSince } }; a re-plan (tier,
 * capacity or crown count change) starts the map afresh. An item keeps its lot for as long as it shows; one that is gone
 * keeps it mod.rules.holdMs (then it is freed), and is the first to give it up when a newcomer finds every lot taken.
 * Mutates persistedLots[settlement.name] like classic.
 * @returns {{ byLot: Map<string, string>, items: Map<string, { owner: 'home'|'pr', agentId?, pr?, building? }> }} */
export function assignLots(settlement, persistedLots, now, mod) {
  const holdMs = mod?.rules?.holdMs;
  if (!Number.isFinite(holdMs)) throw new Error('engine: assignLots needs mod.rules.holdMs');
  const { name, plan: p } = settlement;
  let L = persistedLots[name];
  if (!L || L.cap !== settlement.cap || L.tier !== settlement.tier || (L.crowns ?? 1) !== (settlement.crowns ?? 1)) L = persistedLots[name] = { cap: settlement.cap, tier: settlement.tier, crowns: settlement.crowns ?? 1, a: {}, h: {} };
  L.h ||= {};
  const lots = new Map(p.lots.map(l => [l.id, l]));
  const want = [], extra = new Map();
  const reqs = settlement.requests || [];
  const add = r => {
    want.push([r.item, RANKS[r.rank] || RANKS.S]);
    extra.set(r.item, r.owner === 'pr' ? { owner: 'pr', pr: r.pr, building: !!r.building } : { owner: 'home', agentId: r.agent });
  };
  for (const rk of ['L', 'M', 'S']) for (const r of reqs) if (r.owner !== 'pr' && r.rank === rk) add(r);
  for (const r of reqs) if (r.owner === 'pr' || !RANKS[r.rank]) add(r);
  for (const [id, lot] of Object.entries(L.a)) {
    if (!lots.has(lot)) { delete L.a[id]; delete L.h[id]; continue; }   // the plan has no such lot any more
    if (extra.has(id)) { delete L.h[id]; continue; }
    L.h[id] ??= now;
    if (now - L.h[id] > holdMs) { delete L.a[id]; delete L.h[id]; }
  }
  const used = new Set(Object.values(L.a));
  for (const [id, ranks] of want) {
    if (L.a[id]) continue;
    let lot = null;
    for (const r of ranks) if ((lot = p.lots.find(l => l.rank === r && !used.has(l.id)))) break;
    lot ||= p.lots.find(l => !used.has(l.id));
    if (!lot) {
      const gone = Object.keys(L.h).filter(g => L.a[g]).sort((x, y) => L.h[x] - L.h[y])[0];
      if (!gone) continue;   // more items than lots: it waits unbuilt
      lot = lots.get(L.a[gone]); delete L.a[gone]; delete L.h[gone];
    }
    L.a[id] = lot.id; used.add(lot.id);
  }
  const byLot = new Map(Object.entries(L.a).filter(([id]) => extra.has(id)).map(([id, lot]) => [lot, id]));
  const items = new Map([...extra].filter(([id]) => L.a[id]));
  return { byLot, items };
}
