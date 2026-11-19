// Per-project rules memo for rebuilds (PERF M7). Pure, no DOM, no storage.
// index.js used to key the whole rules phase on one string (cache.js rulesKey): any agent's status flip changed it and
// every project's hooks (runRules) and planSettlements re-ran. This memo keys each project on exactly what the rules
// phase reads for it, so a poll re-runs the hooks of the projects whose inputs changed and nothing else:
//   world part:   the mod (identity), seed, forced tier / style            (a change clears the memo)
//   project part: its WorldInput project record, its agents, its PRs (by identity when they are the very objects of the
//                 last call, see mod/input.js createInputReuse; else by JSON), persisted.blocks[name] (gt, tier, cap, nest, fit, low, w, h, away),
//                 persisted.lots[name] (tier + the items still inside the hold window at `now`), and `now` itself when a
//                 hook read ctx.time.now for this project last time.
// Each project's rules come from runRules on that project alone (rules-phase.js loops projects independently: a hook
// only ever sees its own project), and the sig is rebuilt from per-project pieces in the same JSON shape as
// planSettlements' sig, so the result equals runRules + planSettlements on the whole input.
//
//   const memo = createRulesMemo()
//   memo.run({ input, persisted, mod, opts, cache? }) -> { rules: RulesResult, pv: { sig }, ran: string[] }
//     opts: runRules / planSettlements options ({ now, seed, forcedTier, forcedStyle, serverId, ctxFor })
//     ran:  the projects whose hooks ran this call (tests and the debug counters)
import { runRules, projectNames } from './rules-phase.js';
import { planSettlements } from './sites.js';
import { retiredOf, capOf } from './prune.js';

const DAY = 864e5;

/** True when runRules (M7 P5 thin growth) would hand this project's planner a growth room computed from the other
 * blocks: the block is standing, nested (blocks[name].nest), the mod lays out thin (rules.layout square + gap), and this
 * rebuild re-plans it (tier at or above the block's, and a new tier or cap). Mirrors rules-phase.js runRules. */
export function replansInPlace(b, R, mod) {
  const L = mod?.rules?.layout || {};
  if (!b || !R || typeof b.nest !== 'string' || !b.nest || !L.square || !Number.isFinite(L.gap) || b.away) return false;
  return R.tier >= b.tier && (b.tier !== R.tier || b.cap !== R.cap);
}

export function createRulesMemo() {
  let worldKey = null;
  let byName = new Map();   // name -> { key, now, timeRead, rules, lint, piece, items, pj, ij }
  let lastSig = null, lastParts = null;   // the sig of the last call and the per-project JSON parts it joined
  const stats = { runs: 0, projectsRun: 0, projectsKept: 0 };

  function run({ input, persisted, mod, opts = {}, cache = null }) {
    stats.runs++;
    const now = opts.now ?? input?.now, seed = opts.seed ?? input?.seed ?? persisted?.seed ?? 0;
    const forcedTier = opts.forcedTier ?? null, forcedStyle = opts.forcedStyle ?? null;
    const wk = JSON.stringify([cache?.modKey ? cache.modKey(mod) : String(mod?.id ?? ''), seed, forcedTier, forcedStyle, capOf(opts.cityCap), opts.retireOpts ?? null, opts.fitOpts ?? null]);
    if (wk !== worldKey) { worldKey = wk; byName = new Map(); lastSig = null; lastParts = null; }
    const holdMs = mod?.rules?.holdMs ?? DAY / 2;
    const B = persisted?.blocks || {}, LOTS = persisted?.lots || {};
    // group once: project -> its agents / PRs / project records (input order kept)
    const names = projectNames(input), agentsOf = new Map(names.map(n => [n, []])), prsOf = new Map(names.map(n => [n, []]));
    for (const a of input?.agents || []) agentsOf.get(a.project || '—').push(a);
    for (const p of input?.prs || []) prsOf.get(p.project)?.push(p);
    // a project record belongs to every name it carries as key or name (input order kept), as the filter did
    const recsBy = new Map();
    for (const p of input?.projects || []) for (const k of p.key === p.name ? [p.key] : [p.key, p.name]) { if (!recsBy.has(k)) recsBy.set(k, []); recsBy.get(k).push(p); }
    const recsOf = name => recsBy.get(name) || [];
    const next = new Map(), projects = {}, lint = [], parts = [], ran = [];
    for (const name of names) {
      const here = agentsOf.get(name), prsHere = prsOf.get(name), recs = recsOf(name);
      const b = B[name], L = LOTS[name];
      // small: the block (gt, tier, cap, nest) and the held lots (tier + the ids still inside the hold window), flat; compared
      // value by value with last call's (what JSON equality of the same arrays said, without building the strings)
      const small = b ? [1, b.gt ?? null, b.tier ?? null, b.cap ?? null, b.nest ?? null, b.fit ?? null, b.low?.since ?? null, b.low?.peak ?? null, b.w ?? null, b.h ?? null, !!b.away] : [0];
      if (L && typeof L === 'object') { small.push(1, L.tier ?? null); for (const id of Object.keys(L.a || {})) if (now - (L.h?.[id] ?? now) <= holdMs) small.push(id); }
      // city cap (prune.js): this city's retired agents and its last retirement
      { const C = retiredOf(persisted, name); small.push(2, C.lastAt, ...Object.keys(C.a).sort()); }
      let e = byName.get(name);
      // the same record objects as last time (mod/input.js createInputReuse) are the same content; a different object is
      // compared by its JSON (the old whole-project key, now only for the records that are not the same objects)
      const refs = [recs, here, prsHere];
      const same = !!e && e.small.length === small.length && small.every((v, i) => v === e.small[i])
        && e.refs.every((list, i) => list.length === refs[i].length && list.every((x, j) => x === refs[i][j] || JSON.stringify(x) === JSON.stringify(refs[i][j])));
      if (!same || (e.timeRead && e.now !== now)) {
        let timeRead = typeof opts.ctxFor !== 'function';   // no ctx to watch (localCtx): assume the clock was read
        const ctxFor = typeof opts.ctxFor === 'function' ? k => {
          const c = opts.ctxFor(k), t = c?.time;
          if (!t) return c;
          return { ...c, time: Object.defineProperty({ ...t }, 'now', { enumerable: true, get() { timeRead = true; return t.now; } }) };
        } : null;
        const sub = { ...input, agents: here, prs: prsHere, projects: recs };
        const o = { ...opts, ctxFor };
        const r = runRules(sub, persisted, mod, o);
        const pv = planSettlements(sub, persisted, mod, o, r);
        const [[piece], its] = JSON.parse(pv.sig);
        // pj / ij: this project's piece and items as JSON (ij without its brackets), joined into the sig below
        // a city over its cap is judged again every poll (the 14-day floor and the retire rate read the clock)
        if (r.projects[name]?.prune?.over > 0) timeRead = true;
        // a city whose surplus clock runs is judged again every poll (fit.js: the shrink waits on the clock)
        if (r.projects[name]?.low) timeRead = true;
        e = { small, refs, now, timeRead, rules: r.projects[name], lint: r.lint, piece, items: its, pj: JSON.stringify(piece), ij: JSON.stringify(its).slice(1, -1) };
        ran.push(name);
        stats.projectsRun++;
      } else { stats.projectsKept++; e = { ...e, refs }; }   // keep the newest objects for the identity check
      next.set(name, e);
      projects[name] = e.rules;
      for (const l of e.lint) lint.push(l);
      parts.push(e);
    }
    // M7 thin growth (rules-phase.js, m7-int P5): a standing nested block that re-plans this rebuild (tier up, or cap
    // change within its tier) is told its growth room, which reads every other block and the rects the projects before
    // it grow into. Its rules then depend on the whole town, so per-project answers do not hold: run the whole rules
    // phase, keep nothing. It only happens on a rebuild that re-plans a block (a growth event), never on a status flip.
    if (names.some(n => replansInPlace(B[n], projects[n], mod))) {
      byName = new Map(); lastSig = null; lastParts = null;
      stats.full = (stats.full || 0) + 1;
      const r = runRules(input, persisted, mod, opts);
      return { rules: r, pv: { sig: planSettlements(input, persisted, mod, opts, r).sig }, ran: [...names] };
    }
    byName = next;
    // the sig is planSettlements' JSON.stringify([pieces, items]), joined from the per-project parts; the same parts as
    // last call (every project kept) give the same string without joining again
    if (!(lastParts && lastParts.length === parts.length && parts.every((e, i) => e.pj === lastParts[i].pj && e.ij === lastParts[i].ij))) {
      lastSig = `[[${parts.map(e => e.pj).join(',')}],[${parts.filter(e => e.ij).map(e => e.ij).join(',')}]]`;
      lastParts = parts.map(e => ({ pj: e.pj, ij: e.ij }));
    }
    return { rules: { projects, lint }, pv: { sig: lastSig }, ran };
  }
  return { run, stats: () => ({ ...stats, projects: byName.size }), clear() { worldKey = null; byName = new Map(); lastSig = null; lastParts = null; } };
}
