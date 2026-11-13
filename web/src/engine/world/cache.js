// Build cache for incremental world rebuilds (PERF, 2026-11-13). OWNER: wb-perf. Pure, no DOM, no storage.
// One cache lives as long as the engine instance (index.js) and is passed to buildWorld as opts.cache; buildWorld
// hands it to placeBlocks (plan keys), runLayout (world/layout.js: the mod's layout result reused when no block moved;
// kind 'layout') and stampPlan (each project's stamp replayed when its plan, origin, index, style and mod are unchanged). A build with cache = null computes everything
// and must give a deep-equal World: the cache only ever skips work whose inputs are all in its key.
//
// Keys are strings with a kind prefix ('layout|…', 'stamp|…'); each kind has its own LRU limit, because a layout entry
// holds whole-town tile arrays (a few MB) and a stamp entry one project's objects. ('sites' was the pre-MOD-READY name.)

const LIMITS = { layout: 3, sites: 3, stamp: 1024 };

/** @param {{ limits?: { sites?: number, stamp?: number, [kind: string]: number } }} [opts] */
export function createBuildCache({ limits = {} } = {}) {
  const LIM = { ...LIMITS, ...limits };
  const maps = new Map();   // kind → Map(key → value), insertion order = LRU order
  const modIds = new WeakMap(), fnIds = new WeakMap(), planKeys = new WeakMap();
  let seq = 0, hits = 0, misses = 0, sets = 0, evictions = 0;
  const kindOf = k => { const i = k.indexOf('|'); return i < 0 ? '' : k.slice(0, i); };
  const mapOf = k => { const kind = kindOf(k); let m = maps.get(kind); if (!m) { m = new Map(); maps.set(kind, m); } return m; };
  const idOf = (W, o) => { if (!o || (typeof o !== 'object' && typeof o !== 'function')) return String(o); let n = W.get(o); if (!n) { n = ++seq; W.set(o, n); } return n; };
  return {
    /** A key for a resolved mod object: its id plus an identity number, so a reloaded mod never hits old entries. */
    modKey(mod) { return `${mod?.id ?? ''}#${idOf(modIds, mod)}`; },
    /** The content key of a settlement plan: everything mod.hooks.planSettlement is given, plus the project name and the
     * planner function's identity (a hot-reloaded planner re-plans). */
    planKey({ mod, name, tier, seed, cap, crowns = 1, style = null, worldSeed = 0 }) {
      return `${this.modKey(mod)}|${idOf(fnIds, mod?.hooks?.planSettlement)}|${JSON.stringify([name, tier, seed, cap, crowns, style, worldSeed])}`;
    },
    /** Remember which planKey produced a plan object (placeBlocks does this for every plan it uses). */
    notePlan(plan, key) { if (plan && typeof plan === 'object') planKeys.set(plan, key); },
    /** @returns {string|null} the planKey noted for this plan object */
    keyOfPlan(plan) { return (plan && planKeys.get(plan)) || null; },
    get(k) {
      const m = mapOf(k), v = m.get(k);
      if (v === undefined) { misses++; return undefined; }
      hits++; m.delete(k); m.set(k, v);   // most recently used last
      return v;
    },
    set(k, v) {
      const m = mapOf(k), lim = LIM[kindOf(k)] ?? 256;
      m.delete(k); m.set(k, v); sets++;
      while (m.size > lim) { m.delete(m.keys().next().value); evictions++; }
      return v;
    },
    delete(k) { return mapOf(k).delete(k); },
    clear() { maps.clear(); hits = misses = sets = evictions = 0; },
    stats() {
      const size = {};
      for (const [kind, m] of maps) size[kind || '-'] = m.size;
      return { hits, misses, sets, evictions, size };
    },
  };
}
