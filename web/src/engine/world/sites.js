// Sites: the town square and the project blocks, placed (engine mechanism). Port of world.js plan() + layout() up to
// placeVillage (design §1.3 step 1). OWNER: MOD-READY P1 (was A3). Pure, no DOM, no storage.
// MOD0 (village-mods.md §6.1.3): only the mechanics live here. Every world rule (growth, tiers, capacity, who gets a
// lot, crowns, style, the planner and the layout constants) comes from the mod: `mod.hooks.*` and `mod.rules`.
// MOD-READY (MOD-4a): the geometry round the blocks (roads, land, water, venue sites) is the mod's `hooks.layout`
// (fantasy: mods/agentville.fantasy/layout/), run by world/layout.js.
//
// Classic → engine map (keep the comments `// classic: …` in step when classic changes, e.g. city4's
// crowns/style and va.world9):
//   world.js plan()              → world/rules-phase.js runRules (every hook once per project, plain data) +
//                                  planSettlements(input, persisted, mod, opts, rules) (mechanics) +
//                                  mods/agentville.fantasy/rules.js HOOKS (rules: growth, tier, capacity, lots, crowns, style)
//   world.js layout() up to placeVillage → placeBlocks(settlements, persisted, mod, { now })
//   world.js routes, roads, land, the venue site and the ground/water draw
//                                → mods/agentville.fantasy/layout/*.js (hooks.layout),
//                                  on the kit in mod/kit/layout.js (noise, raster, A*, floods); world/layout.js runs and
//                                  stamps it. The classic string-set version is test/support/fantasy-layout-reference.mjs.
//   world.js planFor()           → planFor()          (rules-phase.js, re-exported; memoised mod.hooks.planSettlement)
//   world.js tierWithHysteresis  → mods/agentville.fantasy/rules.js
//   world.js ACCENT/SQUARE/GAP/RESERVE_MS/HOLD_MS/caps → mod.rules (fantasy: rules.js RULES)
// Units: classic layout coordinates are already tiles (16 world px each), so they carry over 1:1.
// Out of scope here: placeVillage's plan ground and lots (A4 plan-adapter.js / lots.js), scatter (A4).
import { hash } from '../core/rng.js';
import { near } from '../mod/kit/layout.js';
import { runRules, rulesOf, projectNames, planFor, localCtx } from './rules-phase.js';

export { planFor, localCtx };
// The layout fields every mod must define (mod.rules.layout); there is no engine fallback: a missing field fails loudly.
const LAYOUT_FIELDS = ['square', 'gap', 'accents', 'searchX', 'searchY', 'aspect', 'reserveMs'];

export const tileKey = (x, y) => `${x},${y}`;

/** The mod's layout constants. Throws when a field is missing or malformed (no engine fallback). */
export function layoutOf(mod) {
  const L = mod?.rules?.layout;
  const missing = LAYOUT_FIELDS.filter(k => L?.[k] == null);
  if (missing.length) throw new Error(`engine: mod ${mod?.id ?? '?'} rules.layout is missing ${missing.join(', ')}`);
  const sq = L.square;
  if (![sq.x, sq.y, sq.w, sq.h].every(Number.isInteger) || !Array.isArray(L.accents) || !L.accents.length
    || !['gap', 'searchX', 'searchY', 'aspect', 'reserveMs'].every(k => Number.isFinite(L[k])))
    throw new Error(`engine: mod ${mod?.id ?? '?'} rules.layout has a malformed field`);
  return L;
}
/** Plan ground codes that count as existing path (LayoutInput.paths): rules.layout.paths, else terrain types tagged
 *  street/walk. Memoised per mod id and source. */
const PATHS = new Map();
export function pathsOf(mod) {
  const id = mod?.id ?? '';
  let s = PATHS.get(id);
  const L = mod?.rules?.layout?.paths;
  if (!s || s.src !== (L || mod?.terrain)) {
    s = new Set(Array.isArray(L) ? L : (mod?.terrain?.types || []).filter(t => t.tags?.includes('street') || t.tags?.includes('walk')).map(t => t.code));
    s.src = L || mod?.terrain;
    PATHS.set(id, s);
  }
  return s;
}


// ---------------- classic: plan() — the mechanics; the rules come from the rules phase ----------------
/** Settlements from a WorldInput and the rules phase's result (world/rules-phase.js runRules; computed here when absent,
 * for tests and headless tools). No mod hook is called here when `rules` is given. `persisted` is read only.
 * Settlement = { name (project key), tier, gt, need, cap, crowns, style, growth, busy, plan,
 *   requests: LotRequest[] (home items and agent ids mapped to server ids), homes: [{ id, role, crown, important }],
 *   prs: [{ id: '<n>', live }] (compat for assignLots until it reads requests) }.
 * The engine keeps: held lots (mod.rules.holdMs) and capacity that only grows within a tier (both applied in the rules
 * phase, between the hooks), and the sig.
 * @returns {{ settlements: object[], sig: string }} */
export function planSettlements(input, persisted, mod, { now, seed, forcedTier = null, forcedStyle = null, serverId = id => id, ctxFor = null } = {}, rules = null) {
  now ??= input?.now;
  rules ??= runRules(input, persisted, mod, { now, seed, forcedTier, forcedStyle, serverId, ctxFor });
  const agents = input?.agents || [];
  const settlements = projectNames(input).map(name => {
    const R = rulesOf(rules, name);
    if (!R) throw new Error(`engine: the rules phase has no entry for project ${JSON.stringify(name)}`);
    const here = agents.filter(a => (a.project || '—') === name);
    const byId = new Map(here.map(a => [a.id, a]));
    const requests = R.lots.map(r => {
      if (r.owner !== 'home') return { ...r };
      const sid = serverId(r.agent) ?? r.agent;
      return { ...r, item: `home:${sid}`, agent: sid };
    });
    const homes = R.lots.filter(r => r.owner === 'home').map(r => {
      const a = byId.get(r.agent) || {};
      return { id: serverId(r.agent) ?? r.agent, role: a.role, crown: !!a.crown, important: !!a.important };
    });
    // classic busy: awake homes ×10 + every agent not resting (placement order only)
    const awake = R.lots.filter(r => r.owner === 'home' && (byId.get(r.agent)?.status !== 'resting' || byId.get(r.agent)?.important)).length;
    const busy = awake * 10 + here.filter(a => a.status !== 'resting').length;
    const prsCompat = requests.filter(r => r.owner === 'pr').map(r => ({ id: String(r.pr ?? r.item.slice(3)).replace(/^.*#/, ''), live: !!r.building }));
    const { tier, gt, need, cap, crowns, style, growth, plan } = R;
    return { name, tier, gt, need, cap, crowns, style, growth, busy, requests, homes, prs: prsCompat, plan };
  });
  // placeBlocks asks planFor(...) positionally: hand it this rebuild's plans so no hook runs a second time
  const items = settlements.flatMap(s => s.requests.map(r => (r.owner === 'home' ? `${r.item}:${r.rank}` : `${r.item}:${r.building ? 1 : 0}`)));
  return { settlements, sig: JSON.stringify([settlements.map(s => [s.name, s.tier, s.cap, s.crowns, s.style?.key]), items]) };
}

// ---------------- classic: layout() up to placeVillage (block placement: engine mechanism) ----------------
/** Places every settlement's block (classic layout() up to placeVillage): held / reserved / evicted blocks, the compact
 * findSpot search, accents. Mutates persisted.blocks like classic (unknown block fields pass through untouched); the
 * caller saves `persisted`. Layout constants: mod.rules.layout; plans: mod.hooks.planSettlement (memoised per mod).
 * The world's geometry round the blocks (roads, land, sea, venues) is the mod's: world/layout.js runLayout.
 * @returns {{ villages: object[], square: object, parks: object[] }} villages: SiteVillage (settlement + index, block,
 *   plan, accent, origin, plaza, cx, cy); square: mod.rules.layout.square; parks: hidden blocks still reserved. */
export function placeBlocks(villages, persisted, mod, { now, ctxFor = null, seed = 0, fast = true, cache = null } = {}) {
  if (typeof now !== 'number') throw new TypeError('placeBlocks: `now` (ms) is required');
  const { square: SQUARE, gap: GAP, accents: ACCENT, searchX, searchY, aspect: ASPECT, reserveMs: RESERVE_MS } = layoutOf(mod);
  persisted.blocks ||= {};
  persisted.lots ||= {};
  const B = persisted.blocks;
  const shown = new Set(villages.map(v => v.name));
  // classic: held / obstacles / evict
  const held = n => B[n] && !B[n].away && (shown.has(n) || now - (B[n].seen || 0) < RESERVE_MS);
  const obstacles = self => [SQUARE, ...Object.keys(B).filter(n => n !== self && held(n)).map(n => B[n])];
  const evict = (r, self) => { for (const n of Object.keys(B)) if (n !== self && !held(n) && !B[n].away && near(r, B[n], GAP)) B[n].away = true; };
  // classic: score (ASPECT 1.25) and contact
  const score = (r, self) => {
    let x0 = Math.min(r.x, SQUARE.x), y0 = Math.min(r.y, SQUARE.y), x1 = Math.max(r.x + r.w, SQUARE.x + SQUARE.w), y1 = Math.max(r.y + r.h, SQUARE.y + SQUARE.h);
    for (const n of shown) { const o = B[n]; if (n === self || !o || o.away) continue; x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h); }
    return Math.max((x1 - x0) / ASPECT, y1 - y0) + Math.hypot((r.x + r.w / 2) / ASPECT, r.y + r.h / 2) * 0.02;
  };
  const contact = (r, obs) => {
    let c = 0;
    for (const o of obs) {
      const ox = Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x), oy = Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y);
      if (oy > 0 && (r.x === o.x + o.w + GAP || o.x === r.x + r.w + GAP)) c += oy;
      if (ox > 0 && (r.y === o.y + o.h + GAP || o.y === r.y + r.h + GAP)) c += ox;
    }
    return c;
  };
  // classic: findSpot
  // Engine change (A1, 2026-11-13): classic clamps the search to ±120 × ±90 tiles and crashes (best = null) once
  // that window is full (~100 projects, the stress fixture). The clamp still applies first, so every town that
  // fits today is placed exactly as classic places it; only when it is full does the window grow (by 60 tiles a try).
  // MOD0: the window is mod.rules.layout.searchX / searchY.
  function findSpot(w, h, self, grow = 0) {
    const obs = obstacles(self), CX = searchX + grow, CY = searchY + grow;
    const m = GAP + 2, bx0 = Math.max(-CX, Math.min(...obs.map(o => o.x)) - w - m), bx1 = Math.min(CX, Math.max(...obs.map(o => o.x + o.w)) + m);
    const by0 = Math.max(-CY, Math.min(...obs.map(o => o.y)) - h - m), by1 = Math.min(CY, Math.max(...obs.map(o => o.y + o.h)) + m);
    const best = (fast ? scanFast : scanSlow)(w, h, self, obs, bx0, bx1, by0, by1);
    if (!best) { if (grow >= 600) throw new Error(`placeBlocks: no room for a ${w}×${h} block`); return findSpot(w, h, self, grow + 60); }
    return best[1];
  }
  // classic scan: every window position, every obstacle (kept as the reference for scanFast; opts.fast === false)
  function scanSlow(w, h, self, obs, bx0, bx1, by0, by1) {
    let best = null;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const r = { x, y, w, h };
      if (obs.some(o => near(r, o, GAP))) continue;
      const s = score(r, self) - contact(r, obs) * 0.05;
      if (!best || s < best[0]) best = [s, r];
    }
    return best;
  }
  // PERF (2026-11-13): the same scan in the same order with the same float arithmetic, so the same spot wins, but
  // O(window + obstacles): blocked positions come from a 2-D prefix sum of each obstacle's forbidden rect, the
  // score's bounding box of the other blocks is computed once, and contact only looks at the obstacles whose edge
  // sits exactly GAP from the candidate's (indexed by that coordinate). Falls back to scanSlow on non-integer rects.
  function scanFast(w, h, self, obs, bx0, bx1, by0, by1) {
    const ints = [w, h, GAP, bx0, bx1, by0, by1].every(Number.isInteger) && obs.every(o => Number.isInteger(o.x) && Number.isInteger(o.y) && Number.isInteger(o.w) && Number.isInteger(o.h));
    if (!ints) return scanSlow(w, h, self, obs, bx0, bx1, by0, by1);
    const WD = bx1 - bx0 + 1, HD = by1 - by0 + 1;
    if (WD <= 0 || HD <= 0) return null;
    // forbidden top-left positions of obstacle o: x in [o.x - w - GAP + 1, o.x + o.w + GAP - 1], likewise y
    const D = new Int32Array((WD + 1) * (HD + 1)), S = WD + 1;
    for (const o of obs) {
      const x0 = Math.max(o.x - w - GAP + 1, bx0) - bx0, x1 = Math.min(o.x + o.w + GAP - 1, bx1) - bx0;
      const y0 = Math.max(o.y - h - GAP + 1, by0) - by0, y1 = Math.min(o.y + o.h + GAP - 1, by1) - by0;
      if (x0 > x1 || y0 > y1) continue;
      D[y0 * S + x0]++; D[y0 * S + x1 + 1]--; D[(y1 + 1) * S + x0]--; D[(y1 + 1) * S + x1 + 1]++;
    }
    for (let y = 0; y <= HD; y++) for (let x = 1; x <= WD; x++) D[y * S + x] += D[y * S + x - 1];
    for (let y = 1; y <= HD; y++) for (let x = 0; x <= WD; x++) D[y * S + x] += D[(y - 1) * S + x];
    // score(): the bounding box of the square and every other shown, placed, present block
    let X0 = SQUARE.x, Y0 = SQUARE.y, X1 = SQUARE.x + SQUARE.w, Y1 = SQUARE.y + SQUARE.h;
    for (const n of shown) { const o = B[n]; if (n === self || !o || o.away) continue; X0 = Math.min(X0, o.x); Y0 = Math.min(Y0, o.y); X1 = Math.max(X1, o.x + o.w); Y1 = Math.max(Y1, o.y + o.h); }
    // contact(): obstacles touching at exactly GAP, by the candidate x (left/right neighbours) and y (top/bottom)
    const byX = new Map(), byY = new Map(), add = (M, k, o) => { const l = M.get(k); if (l) l.push(o); else M.set(k, [o]); };
    for (const o of obs) { add(byX, o.x + o.w + GAP, o); add(byX, o.x - w - GAP, o); add(byY, o.y + o.h + GAP, o); add(byY, o.y - h - GAP, o); }
    let best = null, bs = 0;
    for (let y = by0; y <= by1; y++) {
      const row = (y - by0) * S, ly = byY.get(y);
      for (let x = bx0; x <= bx1; x++) {
        if (D[row + x - bx0] !== 0) continue;
        const sc = Math.max((Math.max(X1, x + w) - Math.min(X0, x)) / ASPECT, Math.max(Y1, y + h) - Math.min(Y0, y)) + Math.hypot((x + w / 2) / ASPECT, y + h / 2) * 0.02;
        let c = 0;
        const lx = byX.get(x);
        if (lx) for (const o of lx) { const oy = Math.min(y + h, o.y + o.h) - Math.max(y, o.y); if (oy > 0) c += oy; }
        if (ly) for (const o of ly) { const ox = Math.min(x + w, o.x + o.w) - Math.max(x, o.x); if (ox > 0) c += ox; }
        const s = sc - c * 0.05;
        if (!best || s < bs) { best = { x, y, w, h }; bs = s; }
      }
    }
    return best && [bs, best];
  }
  const fitsAt = (r, self) => !obstacles(self).some(o => near(r, o, GAP));

  // classic: the placement loop (existing plots first, then biggest and busiest)
  const plans = new Map(villages.map(pv => [pv.name, pv.plan ?? planFor(mod, pv.tier, hash(pv.name), pv.cap, pv.crowns, ctxFor ? ctxFor(pv.name) : null, pv.style ?? null, seed)]));
  // PERF: a content key per plan (the planner's inputs; planFor's memo relies on the same purity), so the stamp
  // cache and the layout memo (world/layout.js) can tell an unchanged plan from a new one without hashing it.
  if (cache) for (const pv of villages) cache.notePlan(plans.get(pv.name), cache.planKey({ mod, name: pv.name, tier: pv.tier, seed: hash(pv.name), cap: pv.cap, crowns: pv.crowns, style: pv.style ?? null, worldSeed: seed }));
  const live = n => B[n] && !B[n].away ? 0 : 1, area = pv => plans.get(pv.name).w * plans.get(pv.name).h;
  const order = [...villages].sort((a, b) => live(a.name) - live(b.name) || area(b) - area(a) || b.busy - a.busy || a.name.localeCompare(b.name));
  const byName = new Map();
  for (const pv of order) {
    const name = pv.name, p = plans.get(name);
    let b = B[name];
    const replan = b && !b.away && (b.tier !== pv.tier || b.cap !== pv.cap || (b.crowns ?? 1) !== (pv.crowns ?? 1) || b.w !== p.w || b.h !== p.h);
    if (!b || b.away || replan) {
      let r = null;
      if (replan) {
        const c = { x: b.x + Math.round((b.w - p.w) / 2), y: b.y + Math.round((b.h - p.h) / 2), w: p.w, h: p.h };
        if (fitsAt(c, name)) r = c;
      }
      r ||= findSpot(p.w, p.h, name);
      if (b) { delete b.away; Object.assign(b, r); }
      else {
        const used = Object.keys(B).filter(n => held(n) && near(B[n], r, GAP + 4)).map(n => B[n].acc);
        const tally = i => Object.values(B).filter(o => o.acc === i).length;
        const acc = ACCENT.map((_, i) => i).filter(i => !used.includes(i)).sort((i, j) => tally(i) - tally(j) || i - j)[0] ?? 0;
        b = B[name] = { ...r, acc };
      }
      evict(b, name);
    }
    Object.assign(b, { tier: pv.tier, gt: pv.gt, cap: pv.cap, crowns: pv.crowns ?? 1, seen: now });
    // classic placeVillage's geometry only: plaza and centre (lots and ground are A4's)
    const plaza = { x: b.x + p.plaza.x, y: b.y + p.plaza.y, w: p.plaza.w, h: p.plaza.h };
    byName.set(name, { ...pv, block: b, plan: p, accent: ACCENT[b.acc % ACCENT.length], origin: { x: b.x, y: b.y }, plaza,
      cx: plaza.x + (plaza.w >> 1), cy: plaza.y + (plaza.h >> 1) });
  }
  const vs = villages.map((pv, index) => Object.assign(byName.get(pv.name), { index }));
  const parks = Object.keys(B).filter(n => !shown.has(n) && held(n)).map(n => B[n]);
  return { villages: vs, square: SQUARE, parks };
}
