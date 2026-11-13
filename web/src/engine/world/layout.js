// runLayout: runs a mod's `hooks.layout` (api.js LayoutResult), memoised and validated, and returns Sites; stampLayout
// writes a LayoutResult into the grid. Pure, no DOM, no clock, no storage.
// The engine keeps the mechanism (block placement: sites.js placeBlocks; this memo, the validation and the stamp); the
// mod owns what the world looks like (fantasy: mods/agentville.fantasy/layout/).
import { ROAD, LAYOUT_GROUND, LOT } from '../core/grid.js';
import { MOD_CODE_MAX } from '../mod/api.js';
import { modCtx } from '../mod/registry.js';
import { pathsOf } from './sites.js';

/** @typedef {{ villages: object[], square: object, parks: object[], bounds: { ox: number, oy: number, w: number, h: number },
 *   focus: { ox: number, oy: number, w: number, h: number }, tiles: object|null, outside: number, venues: object, data: object|null,
 *   lint: object[] }} Sites
 *   villages/square/parks: placeBlocks; the rest: the mod's validated LayoutResult (shared, frozen: read only). */

const ROAD_MAX = Math.max(...Object.values(ROAD));
const GROUND_OK = new Uint8Array(256);
for (let c = 1; c <= MOD_CODE_MAX; c++) GROUND_OK[c] = 1;
for (const c of Object.values(LAYOUT_GROUND)) GROUND_OK[c] = 1;
const LOT_OK = new Set([0, LOT.HUB, LOT.VENUE]);
const TERRAIN_MAX = 15;
const isRect = r => r && ['ox', 'oy', 'w', 'h'].every(k => Number.isInteger(r[k])) && r.w >= 0 && r.h >= 0;

/** Every resolved mod has a layout: agentville.base defines one and every mod extends base (or is base). A mod without
 *  one (a hand-built hooks object) is an error: there is no fallback. */
function layoutHookOf(mod) {
  const own = mod?.hooks?.layout;
  if (typeof own === 'function') return own;
  throw new Error(`engine: mod ${mod?.id ?? '?'} has no hooks.layout (extend agentville.base, which has one)`);
}

/** The LayoutInput a hook sees: plain copies of what it may read, so the memo key covers everything. */
function inputOf(placed, mod) {
  return {
    settlements: placed.villages.map(v => ({
      index: v.index, name: v.name, block: { x: v.block.x, y: v.block.y, w: v.block.w, h: v.block.h }, plaza: v.plaza,
      cx: v.cx, cy: v.cy, accent: v.accent, plan: v.plan,
    })),
    square: placed.square,
    parks: placed.parks.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    // the plan ground codes that are walkable path (mod.rules.layout.paths, else terrain types tagged street/walk)
    paths: [...pathsOf(mod)],
  };
}

/** Validates a LayoutResult. Bad parts are dropped or zeroed with a lint entry; bounds grow to hold every block and
 *  the square. @returns {{ bounds, focus, tiles, outside, venues, data, lint }} frozen (tiles' arrays excepted) */
function validate(res, input, modId) {
  const lint = [], bad = reason => lint.push({ kind: 'layout', mod: modId, reason });
  if (!res || typeof res !== 'object') { bad('the layout hook returned no object'); res = {}; }
  const need = [input.square, ...input.settlements.map(v => v.block)];
  let x0 = Math.min(...need.map(r => r.x)), y0 = Math.min(...need.map(r => r.y));
  let x1 = Math.max(...need.map(r => r.x + r.w)), y1 = Math.max(...need.map(r => r.y + r.h));
  let bounds;
  if (!isRect(res.bounds)) { bad('bounds is not an integer rect'); bounds = { ox: x0, oy: y0, w: x1 - x0, h: y1 - y0 }; }
  else {
    const b = res.bounds;
    if (b.ox > x0 || b.oy > y0 || b.ox + b.w < x1 || b.oy + b.h < y1) {
      bad('bounds does not contain every block and the square: grown');
      x0 = Math.min(x0, b.ox); y0 = Math.min(y0, b.oy); x1 = Math.max(x1, b.ox + b.w); y1 = Math.max(y1, b.oy + b.h);
      bounds = { ox: x0, oy: y0, w: x1 - x0, h: y1 - y0 };
    } else bounds = { ox: b.ox, oy: b.oy, w: b.w, h: b.h };
  }
  let focus = bounds;
  if (res.focus != null) {
    if (isRect(res.focus)) focus = { ox: res.focus.ox, oy: res.focus.oy, w: res.focus.w, h: res.focus.h };
    else bad('focus is not an integer rect: bounds used');
  }
  let outside = 0;
  if (res.outside != null) {
    if (Number.isInteger(res.outside) && res.outside >= 0 && res.outside <= TERRAIN_MAX) outside = res.outside;
    else bad(`outside ${res.outside} is not a terrain class 0..${TERRAIN_MAX}: 0 used`);
  }
  let tiles = null;
  const T = res.tiles;
  if (T != null) {
    const n = isRect(T) ? T.w * T.h : -1;
    const kinds = { terrain: Uint8Array, ground: Uint8Array, road: Uint8Array, lot: Int8Array };
    const wrong = n < 0 ? ['rect'] : Object.keys(kinds).filter(k => !(T[k] instanceof kinds[k]) || T[k].length !== n);
    if (wrong.length) bad(`tiles dropped: bad ${wrong.join(', ')} (want ${n < 0 ? 'an integer rect' : `typed arrays of ${n}`})`);
    else {
      // copies: the mod may reuse (and later mutate) its own buffers, and the cache must not alias them
      const terrain = T.terrain.slice(), ground = T.ground.slice(), road = T.road.slice(), lot = T.lot.slice();
      const counts = { terrain: 0, ground: 0, road: 0, lot: 0 };
      for (let i = 0; i < n; i++) {
        if (terrain[i] > TERRAIN_MAX) { terrain[i] = outside; counts.terrain++; }
        if (!GROUND_OK[ground[i]] && ground[i] !== 0) { ground[i] = 0; counts.ground++; }
        if (road[i] > ROAD_MAX) { road[i] = 0; counts.road++; }
        if (lot[i] !== 0 && !LOT_OK.has(lot[i])) { lot[i] = 0; counts.lot++; }
      }
      for (const [k, c] of Object.entries(counts)) if (c) bad(`tiles.${k}: ${c} tile(s) with an out-of-range code cleared`);
      tiles = Object.freeze({ ox: T.ox, oy: T.oy, w: T.w, h: T.h, terrain, ground, road, lot });
    }
  }
  const venues = {};
  if (res.venues != null) {
    for (const [id, v] of Object.entries(res.venues)) {
      const r = v?.rect, a = v?.anchor;
      if (typeof v?.kind !== 'string' || !r || ![r.x, r.y, r.w, r.h].every(Number.isInteger) || !a || !Number.isInteger(a.tx) || !Number.isInteger(a.ty)) {
        bad(`venue ${JSON.stringify(id)} dropped: want { kind, rect, anchor: { tx, ty } } in tiles`);
        continue;
      }
      venues[id] = deepFreeze(structuredClone(v));
    }
  }
  let data = null;
  if (res.data != null) {
    try { data = deepFreeze(structuredClone(res.data)); } catch { bad('data is not structured-clonable'); }
  }
  return Object.freeze({ bounds: Object.freeze(bounds), focus: Object.freeze(focus), tiles, outside,
    venues: Object.freeze(venues), data, lint: Object.freeze(lint) });
}
function deepFreeze(o) {
  if (o && typeof o === 'object' && !ArrayBuffer.isView(o) && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

/**
 * Runs the mod's layout over placed blocks: `placed` = sites.js placeBlocks(...) → { villages, square, parks }.
 * Memoised in `cache` on the mod, the square, the parks and each block's index, rect, accent and plan key (a rebuild
 * that moved no block runs no hook); validated; never given ctx.time.
 * @param {{ villages: object[], square: object, parks: object[] }} placed
 * @param {object} mod a ResolvedMod
 * @param {{ seed?: number, cache?: object|null }} [opts]
 * @returns {Sites}
 */
export function runLayout(placed, mod, { seed = 0, cache = null } = {}) {
  const hook = layoutHookOf(mod);
  let key = null, res = null;
  if (cache) {
    const pk = placed.villages.map(v => cache.keyOfPlan(v.plan));
    if (pk.every(Boolean)) {
      const S = placed.square;
      key = `layout|${cache.modKey(mod)}|${JSON.stringify([[S.x, S.y, S.w, S.h], placed.villages.map((v, i) => [v.index, v.block.x, v.block.y, v.block.w, v.block.h, v.accent, pk[i]]),
        placed.parks.map(r => [r.x, r.y, r.w, r.h])])}`;
      res = cache.get(key) || null;
    }
  }
  if (!res) {
    const input = inputOf(placed, mod);
    const ctx = modCtx(mod, { seed });
    delete ctx.time;   // the result is cached across polls: a layout may not depend on the clock
    res = validate(hook(input, ctx), input, mod?.id ?? '?');
    if (key) cache.set(key, res);
  }
  return { villages: placed.villages, square: placed.square, parks: placed.parks, ...res };
}

const STAMPS = new WeakMap();   // LayoutResult tiles → { rk, terrain, ground, road, lot }: the last stamp, per grid rect and blocks
/**
 * Writes a layout into a fresh grid: terrain on every tile (`outside` where the tiles do not reach); ground, road and
 * lot only outside the blocks and only where non-zero. Bumps grid.version once; the caller bakes cost afterwards.
 * The stamped layers are kept per (layout result, grid rect, blocks), so a rebuild that reuses the result copies them.
 */
export function stampLayout(grid, sites) {
  const { ox, oy, w, h } = grid, T = sites.tiles;
  const blocks = sites.villages.map(v => v.block);
  const rk = `${ox},${oy},${w},${h}|${blocks.map(b => `${b.x},${b.y},${b.w},${b.h}`).join(';')}|${sites.outside}`;
  const memo = T ? STAMPS.get(T) : null;
  if (memo && memo.rk === rk) {
    grid.terrain.set(memo.terrain); grid.ground.set(memo.ground); grid.road.set(memo.road); grid.lot.set(memo.lot);
  } else {
    const n = w * h, inBlock = new Uint8Array(n);
    for (const b of blocks) for (let y = Math.max(b.y, oy); y < Math.min(b.y + b.h, oy + h); y++) {
      const row = (y - oy) * w;
      for (let x = Math.max(b.x, ox); x < Math.min(b.x + b.w, ox + w); x++) inBlock[row + x - ox] = 1;
    }
    grid.terrain.fill(sites.outside ?? 0);
    if (T) {
      const x0 = Math.max(ox, T.ox), x1 = Math.min(ox + w, T.ox + T.w), y0 = Math.max(oy, T.oy), y1 = Math.min(oy + h, T.oy + T.h);
      for (let y = y0; y < y1; y++) {
        let i = (y - oy) * w + (x0 - ox), t = (y - T.oy) * T.w + (x0 - T.ox);
        for (let x = x0; x < x1; x++, i++, t++) {
          grid.terrain[i] = T.terrain[t];
          if (inBlock[i]) continue;
          if (T.ground[t]) grid.ground[i] = T.ground[t];
          if (T.road[t]) grid.road[i] = T.road[t];
          if (T.lot[t]) grid.lot[i] = T.lot[t];
        }
      }
      STAMPS.set(T, { rk, terrain: grid.terrain.slice(), ground: grid.ground.slice(), road: grid.road.slice(), lot: grid.lot.slice() });
    }
  }
  grid.version = (grid.version || 0) + 1;
  return grid;
}
