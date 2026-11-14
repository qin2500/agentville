// City v5 "no identical neighbours": pure, import-free. pickVariants(lots, key) -> Map<lotId, 0..15>.
// Neighbours (same row with gap <= 3 tiles, or same column with gap <= 4) differ in variant and variant % 4
// (iso.js maps variant % 4 to the massing archetype). Greedy in lots order, bumping +1 mod 16.
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }; // FNV-1a

export function pickVariants(lots, key) {
  const out = new Map(), rows = new Map(), cols = new Map();
  const gap = (a0, aw, b0, bw) => Math.max(a0, b0) - Math.min(a0 + aw, b0 + bw);
  for (const lot of lots) {
    const row = rows.get(lot.y) || [], col = cols.get(lot.x) || [];
    const near = [];
    for (const o of row) if (gap(lot.x, lot.w, o.x, o.w) <= 3) near.push(out.get(o.id));
    for (const o of col) if (gap(lot.y, lot.h, o.y, o.h) <= 4) near.push(out.get(o.id));
    let v = hash(`${lot.id}|${key}`) % 16, best = v, bestHits = Infinity;
    for (let t = 0; t < 16; t++, v = (v + 1) % 16) {
      let hits = 0;
      for (const n of near) if (n === v) hits += 4; else if (n % 4 === v % 4) hits++;
      if (hits < bestHits) { bestHits = hits; best = v; if (!hits) break; }
    }
    out.set(lot.id, best);
    row.push(lot); rows.set(lot.y, row); col.push(lot); cols.set(lot.x, col);
  }
  return out;
}
