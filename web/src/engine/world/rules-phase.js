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
/** Memoised mod.hooks.planSettlement({ tier, seed, lots: cap, crowns, style, ranks }, ctx). The memo key includes the style
 * key and the world seed, so a restyle or a reseed re-plans. `ranks` ({ L, M, S } lot-request counts) is optional. */
export function planFor(mod, tier, seed, cap, crowns = 1, ctx = null, style = null, worldSeed = 0, ranks = undefined) {
  const id = mod?.id ?? '';
  let M = PLANS.get(id);
  if (!M || M.fn !== mod.hooks.planSettlement) { M = new Map(); M.fn = mod.hooks.planSettlement; PLANS.set(id, M); } // a reloaded planner drops the memo
  const styleKey = style ? String(style.key ?? style.id ?? style.family ?? '') : '';
  const k = `${tier}|${seed}|${cap}|${crowns}|${styleKey}|${worldSeed}`;
  const rk = ranks ? `${ranks.L}|${ranks.M}|${ranks.S}` : null;
  const e = M.get(k);
  if (e && (rk == null || e.rk === rk)) { M.delete(k); M.set(k, e); return e.plan; }   // refresh LRU position
  const req = { tier, seed, lots: cap, crowns, style };
  if (ranks) req.ranks = { L: ranks.L, M: ranks.M, S: ranks.S };
  const plan = mod.hooks.planSettlement(req, ctx || localCtx(mod, '', {}));
  M.delete(k);
  M.set(k, { rk, plan });
  while (M.size > PLAN_MEMO_MAX) M.delete(M.keys().next().value);
  return plan;
}

/** Seeds the planner memo with plans the rules phase already made, so placeBlocks' positional planFor(...) finds them even
 * when the memo was cleared or the mod's planner may not be called again (hooks run once per rebuild). Bridge until
 * placeBlocks reads `settlement.plan` directly. */
export function primePlans(mod, settlements, worldSeed = 0) {
  const id = mod?.id ?? '';
  let M = PLANS.get(id);
  if (!M || M.fn !== mod.hooks?.planSettlement) { M = new Map(); M.fn = mod.hooks?.planSettlement; PLANS.set(id, M); }
  for (const s of settlements) {
    if (!s.plan) continue;
    const styleKey = s.style ? String(s.style.key ?? s.style.id ?? s.style.family ?? '') : '';
    const k = `${s.tier}|${hash(s.name)}|${s.cap}|${s.crowns}|${styleKey}|${worldSeed}`;
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
    stats: { prsEver: prsHere.length, prsLive: prsHere.filter(p => p.state === 'building').length, agentsEver: 0, agentsNow: here.length, transcriptMB: 0 } };
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
export function runRules(input, persisted, mod, { now, seed, forcedTier = null, forcedStyle = null, serverId = id => id, ctxFor = null } = {}) {
  now ??= input?.now;
  seed ??= input?.seed ?? persisted?.seed ?? 0;
  const H = mod.hooks, holdMs = mod.rules?.holdMs ?? DAY / 2;
  const B = persisted?.blocks || {}, LOTS = persisted?.lots || {};
  const agents = input?.agents || [], prs = input?.prs || [];
  const ctxOf = ctxFactory(mod, { seed, now, forcedTier, forcedStyle, ctxFor });
  const projects = {}, lint = [];   // plain object: the result must structuredClone deep-equal (sandbox)
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
    const lots = [...ok.filter(r => r.owner === 'home'), ...ok.filter(r => r.owner !== 'home')].map(r => ({ ...r, item: itemOf(r) }));
    // classic: an item gone within HOLD_MS still needs its lot (same tier only). Persisted items are in server ids.
    const L = LOTS[name], ids = new Set(lots.map(r => (r.owner === 'home' ? `home:${serverId(r.agent) ?? r.agent}` : r.item)));
    let held = 0;
    if (L && L.tier === tier) for (const id of Object.keys(L.a || {})) if (!ids.has(id) && now - (L.h?.[id] ?? now) <= holdMs) held++;
    const need = lots.length + held;
    let cap = H.capacity(tier, need, ctx);
    if (b && b.tier === tier && b.cap > cap) cap = b.cap; // classic: capacity only grows within a tier
    const crowns = H.crowns ? H.crowns(project, here, ctx) : 1;
    const style = H.style ? H.style(name, ctx, project.preset) : { key: '' };
    const ranks = { L: 0, M: 0, S: 0 };
    for (const r of lots) if (RANK_KEYS.includes(r.rank)) ranks[r.rank]++;
    const plan = planFor(mod, tier, hash(name), cap, crowns, ctx, style ?? null, seed, ranks);
    projects[name] = { growth, gt, tier, need, cap, crowns, style, lots, ranks, plan };
  }
  return { projects, lint };
}

/** The rules for one project, or undefined (own keys only: a project may be called "constructor"). */
export const rulesOf = (rules, name) => (rules?.projects && Object.prototype.hasOwnProperty.call(rules.projects, name) ? rules.projects[name] : undefined);
