// agentville.fantasy rules: growth, tiers, capacity, lots, crowns, planner, style, layout constants
// (was engine sites.js planVillages + constants; village-mods.md §6.1.3). Pure: no DOM, no clock,
// no global RNG (ctx.time / ctx.rng only). Hooks read WorldInput objects (web/src/engine/mod/api.js).
//
// Classic → mod map (world.js plan(), re-synced with city4):
//   ACCENT, SQUARE, GAP, RESERVE_MS, findSpot ±120×±90, score ASPECT 1.25 → RULES.layout
//   HOLD_MS                                                            → RULES.holdMs
//   RESTING_HOMES, PR_LIVE_CAP, PR_DONE_CAP, hasHome, folds, rank      → HOOKS.lots / HOOKS.crowns
//   growth formula                                                     → HOOKS.growth
//   tierWithHysteresis (+ ?citytier)                                   → HOOKS.tier
//   capacityFor                                                        → HOOKS.capacity
//   planFor's planSettlement                                           → HOOKS.planSettlement
//   styleFor (styles-pool, ?citystyle, ?citydemo preset family)        → HOOKS.style
//   city-plan WALKABLE (the plan ground routes treat as path)          → RULES.layout.paths (MOD0 extension)
import { tierFor, capacityFor, planSettlement, WALKABLE } from '../../web/src/city-plan.js';
import { styleFor as poolStyle } from '../../web/src/styles-pool.js';

const DAY = 864e5;
// classic constants (world.js), unchanged
export const ACCENT = ['#e4572e', '#2e86de', '#f2b134', '#9b59b6', '#16a085', '#e84393', '#27ae60', '#d35400'];
export const RESTING_HOMES = 2, PR_LIVE_CAP = 6, PR_DONE_CAP = 3;
export const MAX_CROWNS = 3;

export const RULES = {
  layout: {
    square: { x: -4, y: -3, w: 9, h: 5 },  // the town square, tiles
    gap: 2,                                 // tiles between blocks (and round the square)
    accents: ACCENT,                        // block accent colours; neighbours differ
    searchX: 120, searchY: 90,              // classic findSpot window (±tiles); the engine grows it only when full
    aspect: 1.25,                           // classic score: the town grows a little wider than tall
    reserveMs: 14 * DAY,                    // a hidden neighbourhood keeps its block this long
    paths: [...WALKABLE].sort((a, b) => a - b), // plan ground codes roads treat as existing path (MOD0 extension)
  },
  holdMs: DAY / 2,                          // a building that vanished holds its ground this long
  crownModel: 'palace',                     // city4: a crowned agent's L lot is drawn as the palace
};

// classic: TIER_AT / tierAt — the least growth at which tierFor() says tier k or more (bisected).
let TIER_AT = null;
const tierAt = k => {
  TIER_AT ||= [0, 1, 2, 3].map(t => {
    let lo = 0, hi = 1 << 24;
    if (tierFor(hi) < t) return Infinity;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tierFor(m) >= t) hi = m; else lo = m + 1; }
    return lo;
  });
  return TIER_AT[k] ?? Infinity;
};
/** classic: tierWithHysteresis — rises at once, drops only under 60% of the current tier's threshold. */
export function tierWithHysteresis(growth, prev) {
  const t = tierFor(growth);
  if (prev == null || t >= prev) return t;
  return growth < 0.6 * tierAt(prev) ? t : prev;
}
const forced = v => (v == null || v === '' || Number.isNaN(+v) ? null : +v);

// classic: an Important agent always keeps its own house and villager, whatever its rank or status.
// WorldInput: `parent` is null when the server no longer has the parent (classic !byId.has(parentId)); `important`
// is classic pinned(a); `status 'resting'` is classic bucket 'resting'.
const hasHome = a => a.role === 'boss' || a.role === 'lead' || !a.parent || a.important === true;
const folds = a => a.status === 'resting' && a.important !== true;
/** classic plan(): awake owners in input order, then the RESTING_HOMES most recently active resting ones. */
export function homesOf(agents) {
  const owners = (agents || []).filter(hasHome);
  const awake = owners.filter(a => !folds(a));
  const resting = owners.filter(folds).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0)).slice(0, RESTING_HOMES);
  return [...awake, ...resting];
}
/** classic rank: boss or Important → L, lead → M, else S. */
export const rankOf = a => (a.role === 'boss' || a.important === true ? 'L' : a.role === 'lead' ? 'M' : 'S');

export const HOOKS = {
  /** classic: 3·prsEver + agentsEver (agents now when 0) + ⌊log2(MB+1)⌋. */
  growth(project) {
    const s = project?.stats || {};
    return 3 * (s.prsEver || 0) + (s.agentsEver || s.agentsNow || 0) + Math.floor(Math.log2((s.transcriptMB || 0) + 1));
  },
  /** classic tierWithHysteresis; ctx.forcedTier (?citytier) wins, clamped to the four tiers. */
  tier(growth, prevTier, ctx) {
    const f = forced(ctx?.forcedTier);
    if (f != null) return Math.max(0, Math.min(3, Math.round(f)));
    return tierWithHysteresis(growth, prevTier);
  },
  capacity(tier, need) { return capacityFor(tier, need); },
  /** classic plan(): homes (hasHome, resting cap) then PRs (6 live, 3 done, newest first). */
  lots(project, agents, prs) {
    const out = homesOf(agents).map(a => ({ item: `home:${a.id}`, owner: 'home', rank: rankOf(a), agent: a.id }));
    const all = prs || [], newest = (a, b) => (b.number || 0) - (a.number || 0);
    const live = all.filter(p => p.state === 'building').sort(newest).slice(0, PR_LIVE_CAP);
    const done = all.filter(p => p.state !== 'building').sort(newest).slice(0, PR_DONE_CAP);
    for (const p of [...live, ...done]) out.push({ item: `pr:${p.id}`, owner: 'pr', rank: 'S', pr: p.id, building: p.state === 'building' });
    return out;
  },
  /** city4: crown estates = bosses with homes, 1..3. */
  crowns(project, agents) {
    return Math.max(1, Math.min(MAX_CROWNS, homesOf(agents).filter(a => a.role === 'boss').length));
  },
  planSettlement({ tier, seed, lots, crowns }) { return planSettlement({ tier, seed, lots, crowns }); },   // classic request shape (style unused by city-plan)
  /** city4 styleFor: styles-pool, stable per key; ?citystyle (ctx.forcedStyle) or the ?citydemo preset family pick the family. */
  style(projectKey, ctx, preset) {
    const fs = forced(ctx?.forcedStyle);
    const f = fs == null ? preset?.family : ((Math.round(fs) % 6) + 6) % 6;
    return poolStyle(projectKey, f != null ? { family: f } : {});
  },
};
