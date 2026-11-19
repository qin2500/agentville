// Size to fit (city-compact, 2026-11-17): a city's plan is sized to the homes it needs now, not to its historic peak.
// OWNER: city-compact. Pure, no DOM, no storage; the rules phase decides (plain data), placeBlocks and assignLots apply.
//
// Before this, plans only grew ("capacity only grows within a tier", and a nested plan never shrinks), so a city that once
// needed 83 homes kept an 83-home plan after the city cap (prune.js) brought it down to 40 or fewer, its outskirts drawn
// as greens. Now:
//
//   1. Compaction, once per block (blocks[name].fit !== FIT_VERSION): the block takes the smallest of
//        keep   the plan it has (when nothing smaller holds its homes),
//        embed  a plan it nests (a nest ancestor of the same tier, plan.nest.plan) that still holds every lot in use on
//               its exact tile (nothing moves), or
//        fresh  a fresh plan for the homes it needs (the most compact; homes are dealt again, each nearest where it
//               stood relative to the city, lots.js `at`), the one-time compaction.
//      The size it fits is max(min(need, cap), the requested items that hold a lot now): no home in use is dropped.
//      Once, for the whole world (persisted.fit !== FIT_VERSION), placeBlocks also packs every shown block afresh with
//      the packer a new world uses (biggest and busiest nearest the square, plain gap), so the ground the old plans held
//      between the cities closes up too. Hidden blocks go `away` (placed again when they show).
//   2. After that, hysteresis. A plan still grows at once when the city needs more lots. It shrinks only when
//        - the city has had a surplus (a smaller capacity bucket would hold it) for FIT_DEFAULTS.afterMs (7 days) without
//          a break (blocks[name].low = { since, peak }: when the surplus began and the most lots it needed since), and
//        - a smaller plan holds the peak AND every lot in use (assigned or held) on its exact tile (embedLots): only
//          empty lots are dropped, the block shrinks in place round them, nothing in use moves.
//      One shrink resets the clock, so a city shrinks at most once a week, by what the whole week never needed.
//
// Mods: no hook changes. The planner is asked exactly as before (planSettlement({ tier, seed, lots, crowns, from?,
// grow? })); a compaction asks it for a fresh plan (no `from`) or for an ancestor's chain (`from` = that chain, `lots` it
// holds). A mod can opt out with rules.compact === false (then plans only grow, as before).

export const FIT_VERSION = 1;
const DAY = 864e5;
/** afterMs: how long a surplus must last before a city shrinks. */
export const FIT_DEFAULTS = Object.freeze({ afterMs: 7 * DAY });

/** Whether the mod lets the engine compact its plans (rules.compact !== false). */
export const compactOn = mod => mod?.rules?.compact !== false;

/** The nest ancestors of a plan (plan.nest.plan, its nest.plan, ...), nearest first. */
export function ancestors(plan) {
  const out = [];
  for (let p = plan?.nest?.plan, k = 0; p && typeof p === 'object' && k < 256; p = p.nest?.plan, k++) out.push(p);
  return out;
}

const area = p => (Number(p?.w) || 0) * (Number(p?.h) || 0);
const same = (a, b) => a.w === b.w && a.h === b.h && (a.rank ?? null) === (b.rank ?? null) && (a.look ?? null) === (b.look ?? null);

/**
 * Where plan `next` can stand inside plan `cur` so that every lot of `cur` in `used` (lot ids) is a lot of `next` of the
 * same size, rank and look on the same tile. `next` must lie inside `cur` (0 <= dx <= cur.w - next.w, likewise y), so the
 * block shrinks in place and never needs new ground.
 * @param {{ w, h, lots }} cur
 * @param {{ w, h, lots }} next
 * @param {Iterable<string>} used
 * @param {{ dx: number, dy: number }|null} hint tried first (a nest ancestor's own offset)
 * @returns {{ dx: number, dy: number, remap: Record<string, string> }|null} dx, dy: next's origin minus cur's (plan tiles);
 *   remap: cur lot id -> next lot id for every used lot
 */
export function embedLots(cur, next, used, hint = null) {
  if (!cur?.lots || !next?.lots || next.w > cur.w || next.h > cur.h) return null;
  const byId = new Map(cur.lots.map(l => [l.id, l]));
  const U = [...new Set(used)].map(id => byId.get(id));
  if (U.some(l => !l)) return null;   // a lot in use the plan does not know: never guess
  const inside = (dx, dy) => dx >= 0 && dy >= 0 && dx <= cur.w - next.w && dy <= cur.h - next.h;
  const at = new Map(next.lots.map(l => [`${l.x},${l.y}`, l]));
  const tryAt = (dx, dy) => {
    if (!inside(dx, dy)) return null;
    const remap = {};
    for (const l of U) {
      const n = at.get(`${l.x - dx},${l.y - dy}`);
      if (!n || !same(l, n)) return null;
      remap[l.id] = n.id;
    }
    return { dx, dy, remap };
  };
  if (hint && Number.isInteger(hint.dx) && Number.isInteger(hint.dy)) { const r = tryAt(hint.dx, hint.dy); if (r) return r; }
  if (!U.length) return tryAt((cur.w - next.w) >> 1, (cur.h - next.h) >> 1);
  // offsets that put the first used lot on a twin of it, nearest the centred one first (deterministic)
  const l0 = U[0], cx = (cur.w - next.w) / 2, cy = (cur.h - next.h) / 2;
  const offs = next.lots.filter(n => same(l0, n)).map(n => [l0.x - n.x, l0.y - n.y])
    .sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy) || a[1] - b[1] || a[0] - b[0]);
  for (const [dx, dy] of offs) { const r = tryAt(dx, dy); if (r) return r; }
  return null;
}

/**
 * The offset of `next` inside `cur` that keeps the most lots of `cur` as twins (same size, rank and look on the same tile),
 * and those twins: `remap` cur lot id -> next lot id. Ties: nearest the centred offset, then smaller y, then x. Memoised
 * per plan pair (planFor hands back the same plan objects while the city stands still).
 * @returns {{ dx: number, dy: number, remap: Record<string, string> }|null} null when `next` does not fit inside `cur`
 */
const TWINS = new WeakMap();
export function twins(cur, next) {
  if (!cur?.lots || !next?.lots || next.w > cur.w || next.h > cur.h) return null;
  let M = TWINS.get(cur);
  if (!M) { M = new WeakMap(); TWINS.set(cur, M); }
  if (M.has(next)) return M.get(next);
  const key = l => `${l.w}|${l.h}|${l.rank ?? ''}|${l.look ?? ''}`, byKey = new Map();
  for (const n of next.lots) { const k = key(n); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(n); }
  const count = new Map();
  for (const l of cur.lots) for (const n of byKey.get(key(l)) || []) {
    const dx = l.x - n.x, dy = l.y - n.y;
    if (dx < 0 || dy < 0 || dx > cur.w - next.w || dy > cur.h - next.h) continue;
    const k = `${dx},${dy}`; count.set(k, (count.get(k) || 0) + 1);
  }
  const cx = (cur.w - next.w) / 2, cy = (cur.h - next.h) / 2;
  let best = null;
  for (const [k, c] of count) {
    const [dx, dy] = k.split(',').map(Number), d = Math.hypot(dx - cx, dy - cy);
    if (!best || c > best.c || (c === best.c && (d < best.d || (d === best.d && (dy < best.dy || (dy === best.dy && dx < best.dx)))))) best = { c, d, dx, dy };
  }
  let out = null;
  if (best) {
    const at = new Map(next.lots.map(l => [`${l.x},${l.y}`, l])), remap = {};
    for (const l of cur.lots) { const n = at.get(`${l.x - best.dx},${l.y - best.dy}`); if (n && same(l, n)) remap[l.id] = n.id; }
    out = { dx: best.dx, dy: best.dy, remap };
  } else if (!count.size) out = { dx: Math.floor(cx), dy: Math.floor(cy), remap: {} };
  M.set(next, out);
  return out;
}

/** A nest ancestor's offset inside `cur` (the sum of the nest offsets down to it), or null. */
export function nestOffset(cur, anc) {
  let dx = 0, dy = 0;
  for (let p = cur; p && p !== anc; p = p.nest?.plan) {
    if (!p.nest || !Number.isInteger(p.nest.dx) || !Number.isInteger(p.nest.dy)) return null;
    dx += p.nest.dx; dy += p.nest.dy;
  }
  return { dx, dy };
}

/**
 * The best smaller plan for a city (pure). Candidates: `cur`'s nest ancestors of `tier` with at least `lots` lots, and
 * `fresh` (may be null). Each must be smaller than `cur` (area). An ancestor or fresh plan that holds every used lot on
 * its tile (embedLots) is an `embed`; when `allowMove` (the one-time compaction) a fresh plan that does not is a `fresh`.
 * The smallest area wins; ties: embed before fresh, then the nearer ancestor.
 * @returns {{ mode: 'embed'|'fresh', plan: object, dx?: number, dy?: number, remap?: Record<string, string> }|null}
 */
export function pickSmaller(cur, fresh, { tier, lots, used, allowMove = false }) {
  const opts = [];
  const A = area(cur);
  for (const anc of ancestors(cur)) {
    if (anc.tier !== tier || (anc.lots?.length ?? 0) < lots || area(anc) >= A) continue;
    const e = embedLots(cur, anc, used, nestOffset(cur, anc));
    if (e) opts.push({ mode: 'embed', plan: anc, ...e, rank: 0 });
  }
  if (fresh && (fresh.lots?.length ?? 0) >= lots && area(fresh) < A) {
    const t = twins(cur, fresh), e = embedLots(cur, fresh, used, t);
    if (e) opts.push({ mode: 'embed', plan: fresh, ...e, rank: 1 });
    else if (allowMove) opts.push({ mode: 'fresh', plan: fresh, rank: 2 });
  }
  if (!opts.length) return null;
  opts.sort((a, b) => area(a.plan) - area(b.plan) || a.rank - b.rank);
  const { rank, ...best } = opts[0];
  return best;
}

/**
 * The surplus clock for a fitted block (pure). `fitCap`: the capacity bucket the city needs now; `cap`: its plan's.
 * @returns {{ since: number, peak: number }|null} the record to persist (null: no surplus, the clock stops)
 */
export function lowClock(prev, { cap, fitCap, need, now }) {
  if (!(fitCap < cap)) return null;
  const since = Number.isFinite(prev?.since) && prev.since <= now ? prev.since : now;
  return { since, peak: Math.max(Number.isFinite(prev?.peak) ? prev.peak : 0, need) };
}

/**
 * The plan a city with a surplus is heading for (pure): the smallest of `cur`'s same-tier nest ancestors and `fresh` that
 * holds `lots` and is smaller than `cur`, and the lots of `cur` it would drop (`avoid`: lots.js deals newcomers elsewhere
 * first, so those lots empty out and the shrink can come; nothing already there is moved).
 * @returns {{ plan: object, avoid: string[] }|null}
 */
export function shrinkTarget(cur, fresh, { tier, lots }) {
  const A = area(cur);
  const cands = [...ancestors(cur).filter(p => p.tier === tier), ...(fresh ? [fresh] : [])]
    .filter(p => (p.lots?.length ?? 0) >= lots && area(p) < A && p.w <= cur.w && p.h <= cur.h);
  if (!cands.length) return null;
  cands.sort((a, b) => area(a) - area(b));
  const plan = cands[0], off = ancestors(cur).includes(plan) ? nestOffset(cur, plan) : null;
  let keep;
  if (off) { const e = new Set(plan.lots.map(l => `${l.x + off.dx},${l.y + off.dy}`)); keep = new Set(cur.lots.filter(l => e.has(`${l.x},${l.y}`)).map(l => l.id)); }
  else keep = new Set(Object.keys(twins(cur, plan)?.remap || {}));
  return { plan, avoid: cur.lots.filter(l => !keep.has(l.id)).map(l => l.id) };
}
