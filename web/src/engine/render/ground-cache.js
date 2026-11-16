// Bounded LRU for baked ground chunks (and their 1/4-scale Map LOD bitmaps). Pure; no canvas knowledge.
// Bounded by chunk count AND bytes (w*h*4 per entry). Also carries the per-frame bake budget the ground reads.
// The ground pins the chunks the current frame shows: a pinned entry is never evicted, so the bounds are soft by at most
// one viewport of chunks. Without that, a view holding more chunks than maxChunks (Map LOD over a large world) evicts its
// own chunks to bake the rest every frame: the tail of the view stays flat for ever and groundPending never reaches 0.
// The 1x chunks and the Map LOD bitmaps (entries with `iw`) are bounded apart: the LOD of a whole world is far more
// chunks than maxChunks, and when one count held both, a visit to Map zoom evicted every street-zoom bake, so the way
// back in re-baked the whole view a few chunks a frame. LOD bounds: maxLodChunks (default 16 x maxChunks) and
// maxLodBytes (default the 1x byte bound).
export function createGroundCache({ maxBytes, maxChunks = 64, bakesPerFrame = 2, budgetMs = 4, maxLodChunks = maxChunks * 16, maxLodBytes } = {}) {
  const m = new Map();   // insertion order = LRU order (oldest first)
  let hits = 0, misses = 0, evictions = 0, pinned = new Set();
  const limitBytes = maxBytes ?? maxChunks * 512 * 256 * 4, lodBytes = maxLodBytes ?? limitBytes;
  const sizeOf = e => e.bytes ?? ((e.w | 0) * (e.h | 0) * 4);
  // per class: [count, bytes]; class 1 = Map LOD
  const n = [0, 0], b = [0, 0], cap = [maxChunks, maxLodChunks], capB = [limitBytes, lodBytes];
  const clsOf = e => (e.iw != null ? 1 : 0);
  const over = c => n[c] > cap[c] || b[c] > capB[c];
  const drop = (k, e) => { m.delete(k); n[e._c]--; b[e._c] -= e._b; };
  function evict(keep) {
    if (!over(0) && !over(1)) return;
    for (const [k, e] of m) {
      if (!over(0) && !over(1)) break;
      if (k === keep || pinned.has(k) || !over(e._c)) continue;
      drop(k, e); evictions++;
    }
  }
  const api = {
    maxChunks, maxBytes: limitBytes, bakesPerFrame, budgetMs,
    /** Lookup; a hit refreshes recency. */
    get(key) {
      const e = m.get(key);
      if (!e) { misses++; return undefined; }
      hits++; m.delete(key); m.set(key, e); return e;
    },
    has: key => m.has(key),
    /** Recency refresh without counting a hit. */
    touch(key) { const e = m.get(key); if (e) { m.delete(key); m.set(key, e); } return !!e; },
    put(key, entry) {
      const old = m.get(key);
      if (old) drop(key, old);
      entry._b = sizeOf(entry); entry._c = clsOf(entry); n[entry._c]++; b[entry._c] += entry._b; m.set(key, entry);
      evict(key);
      return entry;
    },
    /** Pin the keys the current frame draws (replaces the previous frame's pins); pinned entries survive eviction. */
    pin(keys) { pinned = new Set(keys); evict(null); },
    delete(key) { const e = m.get(key); if (!e) return false; drop(key, e); return true; },
    clear() { m.clear(); n[0] = n[1] = 0; b[0] = b[1] = 0; pinned = new Set(); },
    /** Room for one more 1x chunk without evicting anything (idle pre-bakes only fill free space). */
    roomFor: (lod = false) => n[lod ? 1 : 0] < cap[lod ? 1 : 0] && b[lod ? 1 : 0] + (lod ? 128 * 64 : 512 * 256) * 4 <= capB[lod ? 1 : 0],
    keys: () => m.keys(),
    stats: () => ({ chunks: m.size, bytes: b[0] + b[1], lodChunks: n[1], maxChunks, maxBytes: limitBytes, hits, misses, evictions, pinned: pinned.size }),
  };
  return api;
}
