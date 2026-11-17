// Build cache for incremental world rebuilds (PERF). Pure, no DOM, no storage.
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
    planKey({ mod, name, tier, seed, cap, crowns = 1, style = null, worldSeed = 0, chain = null }) {
      const k = [name, tier, seed, cap, crowns, style, worldSeed];
      if (chain != null) k.push(chain);   // M6 nested growth: the same (tier, cap) can name different plans
      return `${this.modKey(mod)}|${idOf(fnIds, mod?.hooks?.planSettlement)}|${JSON.stringify(k)}`;
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

// ---------------------------------------------------------------- rebuild memo keys (M3 rebuild cost, index.js)

const DAY = 864e5;
const hashWords = (h, buf) => {
  const n = buf.byteLength >> 2, u = new Uint32Array(buf.buffer, buf.byteOffset, n);
  for (let i = 0; i < n; i++) h = Math.imul(h ^ u[i], 16777619);
  for (let i = n << 2; i < buf.byteLength; i++) h = Math.imul(h ^ new Uint8Array(buf.buffer, buf.byteOffset + i, 1)[0], 16777619);
  return h >>> 0;
};
const hashStr = (h, s) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

/** Content hash of a grid: bounds plus every typed-array layer (terrain, ground, road, edges, cost, cover, slots, lot, occ).
 * Two grids with the same hash answer every nav/ground query the same way. */
export function gridHash(grid) {
  if (!grid) return '';
  let h = hashStr(0x811c9dc5, `${grid.ox},${grid.oy},${grid.w},${grid.h}`);
  for (const k of Object.keys(grid).sort()) {
    const v = grid[k];
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) { h = hashStr(h, k); h = hashWords(h, v); }
  }
  return h.toString(36);
}

/** Everything nav/index.js (with roadgraph.js and slots.js) reads from a World: the grid content, every object's id,
 * footprint, door and anchors, the square, the venues and the settlement sites. Equal keys mean an existing nav built
 * for the old world answers exactly as a new one would, so its road graph, labels, flow fields and routes can be kept. */
export function navKey(world) {
  if (!world) return '';
  let h = 0x811c9dc5;
  for (const o of world.objects?.values?.() ?? []) {
    h = hashStr(h, `${o.id}|${o.kind}|${o.tx},${o.ty},${o.w},${o.h}|${o.door ? `${o.door.tx},${o.door.ty},${o.door.face ?? ''}` : ''}|${o.anchors ? JSON.stringify(o.anchors) : ''};`);
  }
  const sites = (world.villages || []).map(v => [v.id, v.name, v.cx, v.cy]);
  h = hashStr(h, JSON.stringify([world.square ?? null, world.venues ?? null, sites, world.anchors ?? null]));
  return `${gridHash(world.grid)}|${h.toString(36)}|${world.objects?.size ?? 0}`;
}

/** Input key for the rules phase + planSettlements (index.js skips both when it is unchanged). Holds every value they
 * read except the clock: the mod (identity), seed, forced tier/style, the WorldInput's agents, prs and projects (all a
 * hook is handed), persisted.blocks (gt/tier/cap), and per persisted lot table its tier and the items still inside the
 * hold window at `now` (the engine's own clock read). Hooks may also read ctx.time.now: the caller records whether any
 * did and, if so, also compares `now` (see index.js). */
export function rulesKey({ input, persisted, mod, seed, forcedTier = null, forcedStyle = null, now }, cache = null) {
  const holdMs = mod?.rules?.holdMs ?? DAY / 2;
  const held = {};
  for (const [name, L] of Object.entries(persisted?.lots || {})) {
    if (!L || typeof L !== 'object') continue;
    held[name] = [L.tier, Object.keys(L.a || {}).filter(id => now - (L.h?.[id] ?? now) <= holdMs)];
  }
  const blocks = {};
  for (const [name, b] of Object.entries(persisted?.blocks || {})) blocks[name] = b ? [b.gt ?? null, b.tier ?? null, b.cap ?? null] : null;
  const modK = cache?.modKey ? cache.modKey(mod) : String(mod?.id ?? '');
  return JSON.stringify([modK, seed, forcedTier, forcedStyle, input?.agents, input?.prs, input?.projects, blocks, held]);
}
