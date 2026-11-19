// Rules phase (MOD1 M1c, review B3): every mod hook a world rebuild needs, called ONCE per project, before any mechanics
// run. The result is plain, structured-clonable data, so the hooks can later move into an async sandbox (one batched call
// per rebuild) without the mechanics noticing. Pure, no DOM, no storage; `persisted` is read only.
//
//   runRules(input, persisted, mod, opts) -> RulesResult
//   planSettlements(input, persisted, mod, opts, rules)   (sites.js)  consumes it
//   buildWorld(input, persisted, { ..., rules })           (build.js)  consumes it (computes it when absent)
//
// Hook order per project (classic plan()): growth -> tier -> lots (validated) -> capacity -> crowns -> style -> planSettlement.
// Between lots and capacity the ENGINE counts held lots (an item gone within mod.rules.holdMs still needs its lot, same tier
// only) and after capacity it applies "capacity only grows within a tier": both read `persisted` and are mechanics.
// `tier` is asked once when no tier is forced (then gt === tier); with ?citytier it is asked twice (unforced gt, forced tier).
import { hash, streamFor } from '../core/rng.js';
import { validateLots } from '../mod/validate.js';
import { growthRoom, anchoredRect, nearRect } from './room.js';
import { retire, retiredOf, capOf } from './prune.js';
import { FIT_VERSION, FIT_DEFAULTS, compactOn, pickSmaller, lowClock, shrinkTarget } from './fit.js';

const DAY = 864e5;
const RANK_KEYS = ['L', 'M', 'S'];

/** A ModCtx for a project when the caller (the registry) gives none: tests and headless tools. */
export function localCtx(mod, projectKey, { seed = 0, now = 0, forcedTier = null, forcedStyle = null } = {}) {
  return { rng: s => streamFor(seed, mod?.id ?? '', projectKey, s), hash, time: { now }, forcedTier, forcedStyle, parent: null };
}

// classic: planFor — plans are pure in (tier, seed, capacity, crowns, style, ranks). Memoised per mod id (LRU).
// The memo is keyed WITHOUT ranks so placeBlocks' positional planFor(...) (no ranks) finds the plan the rules phase made
// this rebuild; an entry made for other ranks is re-planned when ranks are given. One project = one seed, so two
// projects never share a key inside one rebuild.
const PLANS = new Map(); // modId → Map(key → { rk, plan })
const PLAN_MEMO_MAX = 256;
/** The style part of a plan memo key: the style's identity plus its tier, so a tier change re-plans. */
const styleMemoKey = style => (style ? `${style.key ?? style.id ?? style.family ?? ''}${style.tier != null ? '@' + style.tier : ''}` : '');
/** Memoised mod.hooks.planSettlement({ tier, seed, lots: cap, crowns, style, ranks, from }, ctx). The memo key includes the
 * style key and the world seed, so a restyle or a reseed re-plans. `ranks` ({ L, M, S } lot-request counts) is optional.
 * `from` (M6 nested growth, optional): the `chain` string of the plan the block drew before (persisted blocks[name].nest);
 * a planner that nests keeps that plan whole inside the new one and says where in `plan.nest` = { from, dx, dy }. */
export function planFor(mod, tier, seed, cap, crowns = 1, ctx = null, style = null, worldSeed = 0, ranks = undefined, from = null, grow = null) {
  const id = mod?.id ?? '';
  let M = PLANS.get(id);
  if (!M || M.fn !== mod.hooks.planSettlement) { M = new Map(); M.fn = mod.hooks.planSettlement; PLANS.set(id, M); } // a reloaded planner drops the memo
  const styleKey = styleMemoKey(style);
  const k = `${tier}|${seed}|${cap}|${crowns}|${styleKey}|${worldSeed}|${typeof from === 'string' ? from : ''}${growKey(grow)}`;
  const rk = ranks ? `${ranks.L}|${ranks.M}|${ranks.S}` : null;
  const e = M.get(k);
  if (e && (rk == null || e.rk === rk)) { M.delete(k); M.set(k, e); return e.plan; }   // refresh LRU position
  const req = { tier, seed, lots: cap, crowns, style };
  if (ranks) req.ranks = { L: ranks.L, M: ranks.M, S: ranks.S };
  if (typeof from === 'string' && from) req.from = from;
  if (grow) req.grow = grow.room ? { room: grow.room } : {};
  const plan = mod.hooks.planSettlement(req, ctx || localCtx(mod, '', {}));
  M.delete(k);
  M.set(k, { rk, plan });
  while (M.size > PLAN_MEMO_MAX) M.delete(M.keys().next().value);
  return plan;
}

/** The grow part of a plan memo key: none, thin growth anywhere, or thin growth with this room. */
const growKey = grow => (!grow ? '' : grow.room ? `|g${['se', 'sw', 'ne', 'nw'].map(c => (grow.room[c] || []).join(',')).join(';')}` : '|g');

/** Seeds the planner memo with plans the rules phase already made, so placeBlocks' positional planFor(...) finds them even
 * when the memo was cleared or the mod's planner may not be called again (hooks run once per rebuild). Bridge until
 * placeBlocks reads `settlement.plan` directly. */
export function primePlans(mod, settlements, worldSeed = 0) {
  const id = mod?.id ?? '';
  let M = PLANS.get(id);
  if (!M || M.fn !== mod.hooks?.planSettlement) { M = new Map(); M.fn = mod.hooks?.planSettlement; PLANS.set(id, M); }
  for (const s of settlements) {
    if (!s.plan) continue;
    const styleKey = styleMemoKey(s.style);
    const k = `${s.tier}|${hash(s.name)}|${s.cap}|${s.crowns}|${styleKey}|${worldSeed}|${typeof s.from === 'string' ? s.from : ''}${growKey(s.grow)}`;
    const rk = s.ranks ? `${s.ranks.L}|${s.ranks.M}|${s.ranks.S}` : null;
    M.delete(k);
    M.set(k, { rk, plan: s.plan });
  }
  while (M.size > Math.max(PLAN_MEMO_MAX, settlements.length)) M.delete(M.keys().next().value);
}

/** The project names a WorldInput shows, in classic order (first agent of each project). */
export const projectNames = input => [...new Set((input?.agents || []).map(a => a.project || '—'))];

/** The WorldInput project record for a name (or the classic synthetic one when the input lists none). */
export function projectOf(input, name, here, prsHere) {
  const projects = input?.projects || [];
  return projects.find(p => p.key === name) || projects.find(p => p.name === name) || { key: name, name, accent: '',
    stats: { prsEver: prsHere.length, prsLive: prsHere.filter(p => p.live ?? p.state === 'building').length, agentsEver: 0, agentsNow: here.length, transcriptMB: 0 } };
}

/** The ctx factory both phases share: the caller's ctxFor (registry modCtx), else localCtx; dev params fill in. */
export function ctxFactory(mod, { seed = 0, now = 0, forcedTier = null, forcedStyle = null, ctxFor = null } = {}) {
  return name => {
    const c = ctxFor ? ctxFor(name) : localCtx(mod, name, { seed, now, forcedTier, forcedStyle });
    if ((c.forcedTier == null && forcedTier != null) || (c.forcedStyle == null && forcedStyle != null)) {
      return { ...c, forcedTier: c.forcedTier ?? forcedTier, forcedStyle: c.forcedStyle ?? forcedStyle };
    }
    return c;
  };
}

/** Engine-built item key for a validated request (any mod-supplied item is ignored). Ids are the mod's (opaque). */
const itemOf = r => (r.owner === 'home' ? `home:${r.agent}` : `pr:${r.pr ?? String(r.item ?? '').replace(/^pr:/, '')}`);

/**
 * @typedef {{ growth: number, gt: number, tier: number, need: number, cap: number, crowns: number, style: object,
 *   lots: Array<{ item: string, owner: 'home'|'pr', rank: 'L'|'M'|'S', agent?: string, pr?: string, building?: boolean }>,
 *   ranks: { L: number, M: number, S: number }, plan: object }} ProjectRules
 *   lots: validated, homes first then PRs (classic order), ids as the mod saw them (opaque agent ids).
 * @typedef {{ projects: Record<string, ProjectRules>, lint: object[] }} RulesResult
 */

/**
 * Runs every world-rule hook once per project. Plain data out: nothing in the result is a function or a live reference
 * the mechanics could call back through.
 * @param {object} input WorldInput
 * @param {object} persisted read only (blocks[name].gt/tier/cap, lots[name])
 * @param {object} mod ResolvedMod
 * @param {{ now?: number, seed?: number, forcedTier?: number|null, forcedStyle?: number|null,
 *   serverId?: (opaque: string) => string, ctxFor?: (projectKey: string) => object }} opts
 * @returns {RulesResult}
 */
export function runRules(input, persisted, mod, { now, seed, forcedTier = null, forcedStyle = null, serverId = id => id, ctxFor = null, cityCap = null, retireOpts = null, fitOpts = null } = {}) {
  now ??= input?.now;
  seed ??= input?.seed ?? persisted?.seed ?? 0;
  const H = mod.hooks, holdMs = mod.rules?.holdMs ?? DAY / 2;
  const B = persisted?.blocks || {}, LOTS = persisted?.lots || {};
  const agents = input?.agents || [], prs = input?.prs || [];
  const ctxOf = ctxFactory(mod, { seed, now, forcedTier, forcedStyle, ctxFor });
  const projects = {}, lint = [];   // plain object: the result must structuredClone deep-equal (sandbox)
  const layout = mod.rules?.layout || {}, thin = !!layout.square && Number.isFinite(layout.gap);
  const grownTo = new Map(), CAP = capOf(cityCap);
  for (const name of projectNames(input)) {
    const here = agents.filter(a => (a.project || '—') === name);
    const prsHere = prs.filter(p => p.project === name);
    const project = projectOf(input, name, here, prsHere);
    const ctx = ctxOf(name);
    const b = B[name], prevGt = b?.gt ?? null;
    const growth = H.growth(project, ctx);
    const gt = H.tier(growth, prevGt, { ...ctx, forcedTier: null });
    const tier = ctx.forcedTier == null ? gt : H.tier(growth, prevGt, ctx);
    const raw = H.lots(project, here, prsHere, ctx) || [];
    const v = validateLots(raw, { projectKey: name, agents: new Set(here.map(a => a.id)), prs: new Set(prsHere.map(p => p.id)) });
    for (const l of v.lint || []) lint.push({ project: name, ...l });
    const ok = v.requests || [];
    // homes first, then PRs (classic order), each as the mod listed them; the engine builds `item`
    let lots = [...ok.filter(r => r.owner === 'home'), ...ok.filter(r => r.owner !== 'home')].map(r => ({ ...r, item: itemOf(r) }));
    // classic: an item gone within HOLD_MS still needs its lot (same tier only). Persisted items are in server ids.
    const L = LOTS[name], sidOf = r => serverId(r.agent) ?? r.agent;
    const ids = new Set(lots.map(r => (r.owner === 'home' ? `home:${sidOf(r)}` : r.item)));
    // parity: world.vanished-hold-12h
    let held = 0, heldHomes = 0;
    if (L && L.tier === tier) for (const id of Object.keys(L.a || {})) if (!ids.has(id) && now - (L.h?.[id] ?? now) <= holdMs) { held++; if (id.startsWith('home:')) heldHomes++; }
    // City cap (prune.js): retired agents ask for no home; past the cap the oldest untouched homes retire, a few at a time.
    // The decision is plain data here (prune) and is written to persisted.retired by build.js (commitRetire).
    let prune = null;
    {
      const C = retiredOf(persisted, name), wants = new Set(lots.filter(r => r.owner === 'home').map(sidOf));
      if (CAP != null || Object.keys(C.a).length) {
        const cands = here.map(a => ({ id: serverId(a.id) ?? a.id, lastActive: a.lastActive, status: a.status, needs: a.needs, important: a.important,
          crown: a.crown, role: a.role, prs: a.prs, home: wants.has(serverId(a.id) ?? a.id) }));
        const d = retire(cands, { held: heldHomes, retired: C.a, lastAt: C.lastAt }, now, CAP, retireOpts || {});
        // the cap switched off (0): everyone retired here comes back
        if (CAP == null) d.back = cands.filter(a => Object.prototype.hasOwnProperty.call(C.a, a.id)).map(a => a.id).sort();
        const back = new Set(d.back), gone = new Set([...Object.keys(C.a).filter(id => !back.has(id)), ...d.retire]);
        if (gone.size) lots = lots.filter(r => r.owner !== 'home' || !gone.has(sidOf(r)));
        const last = new Map(cands.map(a => [a.id, a.lastActive]));
        prune = { add: d.retire.map(id => ({ id, last: Number(last.get(id)) || 0 })), back: d.back, over: d.over, retired: gone.size };
      }
    }
    const need = lots.length + held;
    // parity: world.capacity-buckets
    // City cap: the planner is never asked for more lots than the cap.
    const want = CAP != null ? Math.min(need, CAP) : need;
    let cap = H.capacity(tier, want, ctx);
    if (b && b.tier === tier && b.cap > cap) cap = b.cap; // classic: capacity only grows within a tier (fit.js may shrink it)
    const crowns = H.crowns ? H.crowns(project, here, ctx) : 1;
    const style = H.style ? H.style(name, { ...ctx, tier }, project.preset) : { key: '' };
    const ranks = { L: 0, M: 0, S: 0 };
    for (const r of lots) if (RANK_KEYS.includes(r.rank)) ranks[r.rank]++;
    // M6 nested growth: the plan grows from the one this block drew last (its chain), so a re-plan only adds.
    // M7 thin growth: the planner is asked to grow thin (`grow`), and, when this rebuild will re-plan a standing block,
    // told how much room the block has round it in each corner (room.js), so it grows where the block keeps its place.
    let from = typeof b?.nest === 'string' ? b.nest : null;
    // Size to fit (fit.js): the one-time compaction of a block, then a shrink after a week-long surplus (only empty lots go)
    let fit = null, low = null, avoid = null;
    if (b && compactOn(mod)) {
      const La = L?.a && typeof L.a === 'object' ? L.a : {}, has = k => Object.prototype.hasOwnProperty.call(La, k);
      const keepN = lots.filter(r => has(r.owner === 'home' ? `home:${sidOf(r)}` : r.item)).length;   // requested and housed now
      const fitNeed = Math.max(want, keepN), fitCap = keepN > want ? Math.max(H.capacity(tier, fitNeed, ctx), H.capacity(tier, want, ctx)) : H.capacity(tier, want, ctx);
      // the lots in use (assigned or held), on the plan the block stands on; unknown when the lot map is another plan's
      const usedOk = !!L && L.tier === b.tier && L.cap === b.cap;
      const used = usedOk ? Object.values(La) : null;
      const current = () => {
        const p = planFor(mod, b.tier, hash(name), b.cap, b.crowns ?? crowns, ctx, style ?? null, seed, undefined, from, null);
        return p && p.w === b.w && p.h === b.h ? p : null;   // not the plan the block stands on: never embed into it
      };
      const fresh = c => planFor(mod, tier, hash(name), c, crowns, ctx, style ?? null, seed, ranks, null, null);
      // the planner gets the picked plan's own chain back (it holds `c` lots, so the planner returns it as it is)
      const take = (pick, c) => { cap = c; from = typeof pick.plan.chain === 'string' ? pick.plan.chain : null;
        fit = pick.mode === 'embed' ? { mode: 'embed', dx: pick.dx, dy: pick.dy, remap: pick.remap } : { mode: 'fresh' }; };
      if (b.fit !== FIT_VERSION) {
        // one-time compaction: the smallest of the plan it has, a nest ancestor that keeps every lot in use, a fresh plan
        if (b.tier !== tier) take({ mode: 'fresh', plan: {} }, fitCap);
        else {
          const cur = current(), fp = fresh(fitCap);
          const pick = cur ? pickSmaller(cur, fp, { tier, lots: fitCap, used: used ?? [], allowMove: true })
            : (fp && fp.w * fp.h < b.w * b.h ? { mode: 'fresh', plan: fp } : null);
          if (pick && !(pick.mode === 'embed' && !used)) take(pick, fitCap);
          else if (pick) take({ mode: 'fresh', plan: pick.plan }, fitCap);
        }
      } else if (b.tier === tier && !b.away) {
        // hysteresis: a surplus that lasts FIT_DEFAULTS.afterMs, then the smallest plan that keeps every lot in use
        low = lowClock(b.low, { cap: b.cap, fitCap, need: fitNeed, now });
        const after = Number.isFinite(fitOpts?.afterMs) ? fitOpts.afterMs : FIT_DEFAULTS.afterMs;
        if (low && used) {
          // one spare lot: never shrink to a bucket the peak fills
          const peakCap = H.capacity(tier, low.peak + 1, ctx), cur = peakCap < b.cap ? current() : null;
          // a week whose peak still fills the plan: start a new week from today's need, so an old spike cannot block forever
          if (!cur && now - low.since >= after) low = { since: now, peak: fitNeed };
          const fp = cur ? fresh(peakCap) : null;
          if (cur && now - low.since >= after) {
            const pick = pickSmaller(cur, fp, { tier, lots: peakCap, used, allowMove: false });
            if (pick) { take(pick, peakCap); low = null; }
          }
          // still waiting: newcomers are dealt lots the coming shrink keeps, so the lots it drops empty out
          if (low && cur) { const t = shrinkTarget(cur, fp, { tier, lots: peakCap }); if (t?.avoid.length) avoid = t.avoid; }
        }
      }
    }
    let grow = null, obs = null;
    if (from && thin && !fit) {
      grow = {};
      if (!b.away && tier >= b.tier && (b.tier !== tier || b.cap !== cap)) {
        obs = [layout.square, ...Object.keys(B).filter(n => n !== name && !B[n].away).map(n => grownTo.get(n) || B[n])];
        grow.room = growthRoom(b, obs, layout.gap);
      }
    }
    const plan = planFor(mod, tier, hash(name), cap, crowns, ctx, style ?? null, seed, ranks, from, grow);
    // a block that grows in place this rebuild claims its grown rect for the rooms of the projects after it
    if (obs && plan?.nest && plan.nest.from === from && Number.isInteger(plan.nest.dx) && Number.isInteger(plan.nest.dy)) {
      const r = anchoredRect(b, plan);
      if (!obs.some(o => nearRect(r, o, layout.gap))) grownTo.set(name, r);   // it will stand there (else it moves: unknown)
    }
    projects[name] = { growth, gt, tier, need, cap, crowns, style, lots, ranks, plan, ...(prune ? { prune } : {}), ...(fit ? { fit } : {}), ...(low ? { low } : {}), ...(avoid ? { avoid } : {}) };
  }
  return { projects, lint };
}

/** The rules for one project, or undefined (own keys only: a project may be called "constructor"). */
export const rulesOf = (rules, name) => (rules?.projects && Object.prototype.hasOwnProperty.call(rules.projects, name) ? rules.projects[name] : undefined);
