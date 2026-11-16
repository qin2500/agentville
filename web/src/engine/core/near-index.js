// Nearest-point index on tiles (PERF M7). Pure, no DOM.
// Buckets items with integer-ish tile coordinates (tx, ty) into C x C chunks and answers "the item nearest to (x, y)
// that passes `ok`" by searching rings of chunks outward, so a query looks at the few chunks round it instead of
// every item. The answer is exactly what a full scan gives: the least squared distance, ties broken by `before(a, b)`
// (true when a wins over b at equal distance). Items with non-finite coordinates are never returned (a full scan never
// picks them either: their distance is NaN).
//
//   const ix = nearIndex(items, C?)
//   ix.nearest(x, y, ok?, before?) -> item | null      x, y finite (callers fall back to a scan otherwise)

const OFF = 1 << 15;
const keyOf = (cx, cy) => (cx + OFF) * 65536 + (cy + OFF);

/** @template T @param {Iterable<T & { tx: number, ty: number }>} items @param {number} [C] chunk size in tiles */
export function nearIndex(items, C = 16) {
  const buckets = new Map();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    if (!Number.isFinite(it?.tx) || !Number.isFinite(it?.ty)) continue;
    const cx = Math.floor(it.tx / C), cy = Math.floor(it.ty / C), k = keyOf(cx, cy);
    let b = buckets.get(k);
    if (!b) { b = []; buckets.set(k, b); }
    b.push(it);
    if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
  }
  return {
    size: buckets.size,
    nearest(x, y, ok = null, before = null) {
      if (!buckets.size) return null;
      const qx = Math.floor(x / C), qy = Math.floor(y / C);
      const maxR = Math.max(Math.abs(qx - x0), Math.abs(qx - x1), Math.abs(qy - y0), Math.abs(qy - y1));
      let best = null, bd = Infinity;
      const scan = b => {
        for (const it of b) {
          const dx = it.tx - x, dy = it.ty - y, d = dx * dx + dy * dy;
          if (d > bd) continue;
          if (d === bd && !(before ? before(it, best) : false)) continue;
          if (ok && !ok(it)) continue;
          best = it; bd = d;
        }
      };
      for (let r = 0; r <= maxR; r++) {
        // every item in ring r is more than (r - 1) * C tiles away on some axis
        if (best && r > 0) { const lo = (r - 1) * C; if (lo * lo >= bd) break; }
        for (let cx = qx - r; cx <= qx + r; cx++) {
          if (cx < x0 || cx > x1) continue;
          const edge = cx === qx - r || cx === qx + r;
          for (let cy = qy - r; cy <= qy + r; cy += edge ? 1 : 2 * r) {
            if (cy >= y0 && cy <= y1) { const b = buckets.get(keyOf(cx, cy)); if (b) scan(b); }
          }
        }
      }
      return best;
    },
  };
}
