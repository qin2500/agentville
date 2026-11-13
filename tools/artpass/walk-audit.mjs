#!/usr/bin/env node
// Walk-through audit (no browser): for each tier's plan, which things stand on tiles that walkers treat
// as free ground? Ambient townsfolk (ambient.js makeRoute) random-walk tile centres of every WALKABLE
// ground code and know nothing of props or footprints; this counts what they can pass through.
//   node tools/artpass/walk-audit.mjs [seeds=20]
import { planSettlement, capacityFor, GROUND, WALKABLE } from '../../web/src/city-plan.js';

const seeds = +(process.argv[2] || 20), NAMES = Object.fromEntries(Object.entries(GROUND).map(([k, v]) => [v, k]));
const SOLID = new Set(['fountain', 'well', 'stall', 'haystack', 'woodpile', 'bench', 'statue', 'noticeboard', 'signpost', 'beehive', 'trough', 'maypole', 'flowerbox', 'lamppost', 'lamp', 'tree', 'pine', 'sapling', 'barrel', 'crate', 'cart', 'laundry', 'scarecrow', 'banner', 'fence', 'bush']);
for (const tier of [0, 1, 2, 3]) {
  const onWalk = {}, total = {}; let fpWalk = 0, walkTiles = 0, plans = 0, doorBlocked = 0, lots = 0, fenceThroughFp = 0, propInFp = {};
  for (let s = 1; s <= seeds; s++) for (const need of [3, 12, 30]) {
    const p = planSettlement({ tier, seed: s * 7919, lots: capacityFor(tier, need) });
    plans++;
    const g = p.ground, w = p.w, fp = new Uint8Array(w * p.h);
    for (const b of [...p.lots, ...(p.civic || [])]) for (let j = b.y; j < b.y + b.h; j++) for (let i = b.x; i < b.x + b.w; i++) fp[j * w + i] = 1;
    for (let i = 0; i < g.length; i++) if (WALKABLE.has(g[i])) { walkTiles++; if (fp[i]) fpWalk++; }
    for (const l of p.lots) { lots++; const dx = l.x + Math.floor(l.doorX / 16), dy = l.y + l.h; if (dy >= p.h || !WALKABLE.has(g[dy * w + dx]) || fp[dy * w + dx]) doorBlocked++; }
    for (const q of p.props || []) {
      if (!SOLID.has(q.kind)) continue;
      const tiles = q.kind === 'fence' ? Array.from({ length: q.len || 1 }, (_, k) => (q.dir === 'y' ? [Math.floor(q.x), Math.floor(q.y) + k] : [Math.floor(q.x) + k, Math.floor(q.y)]))
        : q.kind === 'fountain' ? [[Math.floor(q.x - 0.5), Math.floor(q.y - 0.5)], [Math.floor(q.x), Math.floor(q.y - 0.5)], [Math.floor(q.x - 0.5), Math.floor(q.y)], [Math.floor(q.x), Math.floor(q.y)]]
        : q.kind === 'stall' ? [[Math.floor(q.x - 0.5), Math.floor(q.y)], [Math.floor(q.x), Math.floor(q.y)]] : [[Math.floor(q.x), Math.floor(q.y)]];
      total[q.kind] = (total[q.kind] || 0) + 1;
      let hitW = false, hitF = false;
      for (const [x, y] of tiles) { if (x < 0 || y < 0 || x >= w || y >= p.h) continue; if (WALKABLE.has(g[y * w + x])) hitW = true; if (fp[y * w + x]) hitF = true; }
      if (hitW) onWalk[q.kind] = (onWalk[q.kind] || 0) + 1;
      if (hitF) { propInFp[q.kind] = (propInFp[q.kind] || 0) + 1; if (q.kind === 'fence') fenceThroughFp++; }
    }
  }
  console.log(`\n== tier ${tier} (${plans} plans) ==`);
  console.log(`walkable tiles under a building footprint: ${fpWalk} of ${walkTiles}`);
  console.log(`lots whose door tile is not walkable/free: ${doorBlocked} of ${lots}`);
  console.log('props standing on a walkable tile (walkers pass through them): ' + Object.keys(total).sort().map(k => `${k} ${onWalk[k] || 0}/${total[k]}`).join(', '));
  console.log('props whose tile(s) lie inside a building footprint: ' + (Object.entries(propInFp).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'));
}
