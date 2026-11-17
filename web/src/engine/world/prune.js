// City cap (2026-11-17): a city holds at most `cap` agent homes. Past it, the homes of agents nobody has touched for a
// long time are retired from the village, oldest first and a few at a time; the freed lot becomes a garden, orchard or
// little plaza (the mod's hooks.freeLot) until the next newcomer takes it. Pure, no DOM, no storage.
//
// "Retired" is Agentville state only (persisted.retired in the world layout): no session file is read, moved or touched.
// A retired agent whose session wakes up again (newer activity, or it is live / waiting / important again) comes back
// as a new arrival: it asks for a home like anyone else and takes the nearest free lot.
//
//   retire(agents, plan, now, cap, opts)   the decision for one city (pure; unit-tested)
//   isProtected(agent)                     who may never be retired
//   commitRetire(persisted, rules, now)    writes the rules phase's decisions into persisted.retired (idempotent)
//   capOf(value)                           a setting value -> a cap (null = no cap)
//
// Engine v2 only: the classic village has no cap.

const DAY = 864e5;
/** minIdleMs: only agents untouched this long can be retired. everyMs / perStep: at most perStep homes per city per
 * everyMs, so a city over its cap thins out gradually (one home a minute) instead of collapsing at once. */
export const RETIRE_DEFAULTS = Object.freeze({ minIdleMs: 14 * DAY, everyMs: 60_000, perStep: 1 });
/** Houses per city by default (Settings -> Advanced). See docs in the PR: a tier-3 plan for 40 homes is the 47-lot plan. */
export const DEFAULT_CITY_CAP = 40;
export const CITY_CAP_KEY = 'va.cityCap';
/** A retired record for an agent the server no longer lists is dropped after this long (it would be re-judged anyway). */
export const FORGET_MS = 90 * DAY;

/** The cap the user set (store key va.cityCap; unset = DEFAULT_CITY_CAP, 0 = no cap). `store`: get(key, fallback). */
export function cityCapOf(store) {
  let v = DEFAULT_CITY_CAP;
  try { v = store?.get?.(CITY_CAP_KEY, DEFAULT_CITY_CAP) ?? DEFAULT_CITY_CAP; } catch { /* default */ }
  return capOf(v);
}

/** A setting value -> a positive whole cap, or null (no cap). 0, negatives, junk and Infinity mean "no cap". */
export function capOf(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Never retired: live or running, waiting on the user, Important / pinned, crowned or a lead, or carrying PRs. */
export function isProtected(a) {
  if (!a) return true;
  return a.status !== 'resting' || !!a.needs || a.important === true || a.pinned === true || a.crown === true
    || a.role === 'boss' || a.role === 'lead' || (Array.isArray(a.prs) && a.prs.length > 0);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One city's retirement decision. Pure: `plan` is never mutated.
 * @param {Array<{ id: string, lastActive: number, status: string, needs?: string|null, important?: boolean, pinned?: boolean,
 *   crown?: boolean, role?: string, prs?: any[], home: boolean }>} agents  this city's agents; `home`: the world gives it a
 *   house this rebuild (before retirement)
 * @param {{ held?: number, retired?: Record<string, { at: number, last: number }>, lastAt?: number|null }|null} plan
 *   held: houses still standing for agents not listed (the hold window); retired: who is retired now; lastAt: this city's
 *   last retirement
 * @param {number} now ms
 * @param {number|null} cap homes allowed (no cap when not a positive finite number)
 * @param {{ minIdleMs?: number, everyMs?: number, perStep?: number }} [opts]
 * @returns {{ retire: string[], back: string[], over: number }} retire: newly retired ids (oldest first); back: retired ids
 *   that come back this rebuild (sorted); over: homes past the cap after the comebacks, before this rebuild's retirements
 */
export function retire(agents, plan, now, cap, opts = {}) {
  const o = { ...RETIRE_DEFAULTS, ...opts };
  const R = plan?.retired || {}, held = Math.max(0, Number(plan?.held) || 0), lastAt = plan?.lastAt ?? null;
  const list = agents || [];
  const back = [];
  for (const a of list) {
    const e = Object.prototype.hasOwnProperty.call(R, a.id) ? R[a.id] : null;
    if (e && (isProtected(a) || (Number(a.lastActive) || 0) > (Number(e.last) || 0))) back.push(a.id);
  }
  back.sort(cmp);
  const backSet = new Set(back);
  const isRetired = id => Object.prototype.hasOwnProperty.call(R, id) && !backSet.has(id);
  const housed = list.filter(a => a.home && !isRetired(a.id));
  const c = capOf(cap);
  if (c == null) return { retire: [], back, over: 0 };
  const over = Math.max(0, housed.length + held - c);
  if (!over || (lastAt != null && now - lastAt < o.everyMs)) return { retire: [], back, over };
  const cands = housed.filter(a => !isProtected(a) && now - (Number(a.lastActive) || 0) >= o.minIdleMs)
    .sort((a, b) => (Number(a.lastActive) || 0) - (Number(b.lastActive) || 0) || cmp(a.id, b.id));
  const n = Math.max(0, Math.min(over, Math.floor(o.perStep), cands.length));
  return { retire: cands.slice(0, n).map(a => a.id), back, over };
}

/**
 * Writes the rules phase's retirement decisions (ProjectRules.prune = { add: [{ id, last }], back: [id] }, server ids)
 * into persisted.retired[project] = { a: { id: { at, last } }, lastAt }. Idempotent: a decision committed twice (a memo
 * replays the same rules) changes nothing the second time. Also forgets records of agents gone for FORGET_MS.
 * @returns {Array<{ project: string, id: string }>} the agents retired by THIS call (for the retire cue)
 */
export function commitRetire(persisted, rules, now, presentIds = null) {
  const out = [];
  if (!persisted || !rules?.projects) return out;
  for (const [name, R] of Object.entries(rules.projects)) {
    const p = R?.prune;
    if (!p || (!p.add?.length && !p.back?.length)) continue;
    persisted.retired ||= {};
    const C = persisted.retired[name] ||= { a: {}, lastAt: null };
    C.a ||= {};
    for (const id of p.back || []) delete C.a[id];
    for (const { id, last } of p.add || []) {
      if (Object.prototype.hasOwnProperty.call(C.a, id)) continue;
      C.a[id] = { at: now, last: Number(last) || 0 };
      C.lastAt = now;
      out.push({ project: name, id });
    }
    if (!Object.keys(C.a).length && C.lastAt == null) delete persisted.retired[name];
  }
  if (presentIds && persisted.retired) {
    for (const [name, C] of Object.entries(persisted.retired)) {
      for (const [id, e] of Object.entries(C.a || {})) if (!presentIds.has(id) && now - (e.at || 0) > FORGET_MS) delete C.a[id];
    }
  }
  return out;
}

/** The retired record of a city in persisted (read only), or an empty one. */
export const retiredOf = (persisted, name) => {
  const C = persisted?.retired && Object.prototype.hasOwnProperty.call(persisted.retired, name) ? persisted.retired[name] : null;
  return { a: C?.a || {}, lastAt: C?.lastAt ?? null };
};
