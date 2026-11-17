// Host adapter: the classic dock data (SnapshotView.dock, from server/dock.mjs: { loading, sailed, total, level }) as
// WorldInput PRs (engine/mod/api.js). Outside web/src/engine/** because it names the classic app's dock
// (test/mod-ready-ratchet). Pure: no DOM, node tests import it.
//
// Built field by field, like mod/input.js: a dock entry's href is read only to recover the PR number and repo name and
// never passes on; nor do agent ids or names, `since`/`at` times or anything else the server adds later.
//
//   dockPrs(view, base = [], { loading?, owned? }) -> { prs, merged, rank }   owned: lay over base's own entries (see below)
//     prs: (opts.loading false: an open PR is state 'building' + live: true, the v1 shape) `base` (the WorldInput PRs built from the projects' PR histories) with the dock's state laid over it, then the
//          dock's PRs that `base` does not have. A loading PR becomes state 'loading' with its checks, review and size;
//          a sailed PR becomes 'merged'. A base PR that was 'building' (current work) gets `live: true`, so a lots rule
//          reading `p.live ?? p.state === 'building'` still scaffolds it while it loads at the harbour (as classic does).
//     merged: dock.total (PRs ever merged, lifetime); rank: dock.level (the classic dock level, 1..5).
//   Ids are '<project>#<number>': the project of the agent that has the PR when the view knows that agent, else the repo's
//   name (the href path segment before /pull/), else '—'.

const REVIEW = new Set(['approved', 'changes', 'pending']);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const nonNeg = v => Math.max(0, Math.floor(num(+v)));
const PULL_RE = /\/([^/?#]+)\/pull\/(\d+)(?:[/?#]|$)/;

/** The PR number of a dock entry: its numeric id, else the /pull/<n> of its href. null when there is none. */
export function prNumberOf(x) {
  const id = x?.id;
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  if (typeof id === 'string' && /^\d{1,9}$/.test(id) && +id > 0) return +id;
  const m = PULL_RE.exec(typeof x?.href === 'string' ? x.href : '');
  return m ? +m[2] : null;
}

/** The project a dock entry belongs to: its agent's project (view.byId), else the repo name, else '—'. */
export function projectOf(x, view) {
  const a = typeof x?.agentId === 'string' && view?.byId instanceof Map ? view.byId.get(x.agentId) : null;
  if (a && typeof a.project === 'string' && a.project) return a.project;
  const repo = typeof x?.repo === 'string' ? x.repo.split('/').filter(Boolean).pop() : '';
  if (repo && /^[\w.-]{1,100}$/.test(repo)) return repo;
  const m = PULL_RE.exec(typeof x?.href === 'string' ? x.href : '');
  if (m && /^[\w.-]{1,100}$/.test(m[1])) return m[1];
  return '—';
}

const checksOf = c => ({ passed: nonNeg(c?.passed), failed: nonNeg(c?.failed), pending: nonNeg(c?.pending) });
const sizeOf = z => ({ additions: nonNeg(z?.additions), deletions: nonNeg(z?.deletions), files: nonNeg(z?.files) });
const ZERO_CHECKS = () => ({ passed: 0, failed: 0, pending: 0 });
const ZERO_SIZE = () => ({ additions: 0, deletions: 0, files: 0 });

/** A fresh WorldInput PR entry copied field by field from a base entry (never the object itself: base may be frozen). */
const copyBase = p => ({ id: p.id, project: p.project, number: p.number, title: typeof p.title === 'string' ? p.title : '',
  state: p.state, checks: checksOf(p.checks), review: REVIEW.has(p.review) ? p.review : null, size: sizeOf(p.size),
  ...(typeof p.live === 'boolean' ? { live: p.live } : {}) });

/**
 * @param {{ dock?: { loading?: object[], sailed?: object[], total?: number, level?: number }, byId?: Map }} view SnapshotView
 * @param {object[]} [base] WorldInput PRs from the projects (mod/input.js); not mutated
 * @param {{ loading?: boolean }} [opts] loading (default true): an open PR is state 'loading'. false (API v1 default, a world
 *   that did not opt in to 'prs.loading'): an open PR stays state 'building'; every other field is as for loading.
 * @returns {{ prs: object[], merged: number, rank: number }}
 */
export function dockPrs(view, base = [], { loading: asLoading = true, owned = false } = {}) {
  const dock = view?.dock && typeof view.dock === 'object' ? view.dock : {};
  // owned (PERF M7, mod/input.js): base holds fresh, unfrozen entries already in copyBase's shape that the caller hands
  // over, so they are laid over in place instead of copied (one allocation per PR less on every poll)
  const kept = (Array.isArray(base) ? base : []).filter(p => p && typeof p.id === 'string');
  const out = owned ? kept : kept.map(copyBase);
  // the entry for an id: the last one with it (what a Map built over out would give); a short dock looks it up in place
  const few = (dock.loading?.length || 0) + (dock.sailed?.length || 0) <= 32;
  const byId = few ? { get: id => out.findLast(p => p.id === id), set() {} } : new Map(out.map(p => [p.id, p]));
  const lay = (x, state) => {
    const n = prNumberOf(x);
    if (n == null) return;
    const project = projectOf(x, view), id = `${project}#${n}`;
    let p = byId.get(id);
    if (!p) {
      p = { id, project, number: n, title: '', state, checks: ZERO_CHECKS(), review: null, size: ZERO_SIZE() };
      out.push(p); byId.set(id, p);
    }
    // a PR the dock lists twice keeps its first (loading wins over sailed: loading is laid first)
    if (p.dockState) return;
    if (p.state === 'building' && p.live === undefined) p.live = true;   // still current work: the town keeps its scaffold
    p.dockState = state;
    p.state = state === 'loading' && !asLoading ? 'building' : state;
    if (state === 'loading' && !asLoading) p.live = true;
    if (state === 'loading') { p.checks = checksOf(x.checks); p.review = REVIEW.has(x.review) ? x.review : null; if (x.size && typeof x.size === 'object') p.size = sizeOf(x.size); }
  };
  for (const x of Array.isArray(dock.loading) ? dock.loading : []) lay(x, 'loading');
  for (const x of Array.isArray(dock.sailed) ? dock.sailed : []) lay(x, 'merged');
  for (const p of out) delete p.dockState;
  const level = Number.isInteger(dock.level) && dock.level > 0 ? dock.level : 0;
  return { prs: out, merged: nonNeg(dock.total), rank: level };
}

/**
 * ?total=<n> and ?level=<1..5> (dev params, the classic ones): override the dock's lifetime total and level on a view, so a
 * fixture's lifetime floor can be switched off (total=0). Returns the view itself when neither is given. Never mutates.
 */
export function dockParams(view, search = '') {
  const q = new URLSearchParams(search), dock = view?.dock && typeof view.dock === 'object' ? view.dock : null;
  if (!dock || (!q.has('total') && !q.has('level'))) return view;
  const next = { ...dock };
  if (q.has('total')) { const n = Number.parseInt(q.get('total'), 10); next.total = Number.isFinite(n) ? Math.max(0, n) : 0; }
  if (q.has('level')) { const n = Number.parseInt(q.get('level'), 10); next.level = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1; }
  return { ...view, dock: next };
}

// parity: inp.dock-ship-click-va-dock
/**
 * The link of the PR a venue token carries (its item id '<project>#<number>', as dockPrs builds it): the href of the dock
 * entry (loading first, then sailed) that dockPrs would give that id, else null. Host-side only: the href never enters
 * the world, it goes straight to the panel event (classic: a ship click names its PR).
 */
export function dockHref(view, item) {
  if (typeof item !== 'string' || !item) return null;
  const dock = view?.dock && typeof view.dock === 'object' ? view.dock : {};
  for (const list of [dock.loading, dock.sailed]) for (const x of Array.isArray(list) ? list : []) {
    const n = prNumberOf(x);
    if (n != null && `${projectOf(x, view)}#${n}` === item && typeof x.href === 'string') return x.href;
  }
  return null;
}
