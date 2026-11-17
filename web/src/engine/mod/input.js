// WorldInput: the sanitised, allow-listed, deep-frozen view a mod sees (village-mods.md §3.1).
// Built field by field from SnapshotView: nothing is copied wholesale, so a new server field can never leak by default.
// Never passes: conversation text, ask/reason/resume, cwd/paths, hrefs/URLs, account/model/spend, raw server ids.
import { API_VERSION } from './api.js';
import { hash } from '../core/rng.js';
import { pinned, stoppedNote } from '../../important.js';
import { cleanPrTitle } from '../sim/represent-world.js';
import { venuePrs } from '../../engine-host.js';

const NEEDS = new Set(['permission', 'question', 'plan', 'dialog']);
const ROLE = { boss: 'boss', lead: 'lead', sub: 'sub' };
const HARNESS = { 'claude-code': 'claude', claude: 'claude', codex: 'codex' };
const num = v => (Number.isFinite(+v) ? +v : 0);
const str = v => (typeof v === 'string' ? v : '');
// Mods only ever get a short label: the server's shortName (nickname/override/session name, never prompt-derived),
// cut at the first line break (CR/LF/NEL/LS/PS), whitespace collapsed, cut to 32 chars with an ellipsis. Without one: a neutral label, never a.name/a.title.
export const NAME_MAX = 32;
export const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;
/** Text up to the first CR, LF, NEL, U+2028 or U+2029, trimmed. Nothing after a line break ever reaches a mod. */
export const firstLine = raw => str(raw).split(LINE_BREAK)[0].trim();
export function shortLabel(raw) {
  const t = firstLine(raw).replace(/\s+/g, ' ').trim();
  const cp = [...t];
  return cp.length > NAME_MAX ? `${cp.slice(0, NAME_MAX - 1).join('').trimEnd()}\u2026` : t;
}
const ZERO_CHECKS = Object.freeze({ passed: 0, failed: 0, pending: 0 }), ZERO_SIZE = Object.freeze({ additions: 0, deletions: 0, files: 0 });
const statusOf = a => (a.bucket === 'building' ? 'working' : a.bucket === 'waiting' ? 'waiting' : a.bucket === 'resting' ? 'resting'
  : a.severity === 'error' ? 'error' : 'stalled');
// FROZEN: objects deepFreeze already froze whole (PERF M7): a record reused from the last input is not walked again
const FROZEN = new WeakSet();
const deepFreeze = o => {
  if (o && typeof o === 'object' && !FROZEN.has(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); FROZEN.add(o); }
  return o;
};
/** Plain-data equality (same keys in the same order, same values): what JSON.stringify would call equal for these records.
 *  PERF M7: no key arrays for arrays, and objects walk their keys with for-in (own enumerable string keys of these plain
 *  records, in the same order as Object.keys) instead of allocating two key lists per level. */
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a !== a && b !== b;
  const arr = Array.isArray(a);
  if (arr !== Array.isArray(b)) return false;
  if (arr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return sameKeys(a, b);
  // walk b's keys in order alongside a's: same count, same order, same values
  const kb = [];
  for (const k in b) kb.push(k);
  let i = 0;
  for (const k in a) { if (k !== kb[i++] || !same(a[k], b[k])) return false; }
  return i === kb.length;
};
const sameKeys = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || !same(a[ka[i]], b[ka[i]])) return false;
  return true;
};

/** State a caller keeps across toWorldInput calls (index.js, one per engine) so an unchanged agent, PR or project comes back
 * as the very same frozen object as last time, and ids and PR titles are not re-derived. The input is equal either way;
 * reuse only lets later stages (world/rules-memo.js) see "unchanged" by identity. */
export function createInputReuse() {
  return { salt: null, ids: new Map(), titles: new Map(), labels: new Map(), agents: new Map(), prs: new Map(), projects: new Map() };
}
// The agent record's keys, in the order toWorldInput builds them: an agent record is compared field by field (no key walk).
const AGENT_KEYS = ['id', 'name', 'project', 'parent', 'status', 'needs', 'role', 'crown', 'important', 'stopped', 'harness', 'since', 'lastActive', 'prs'];
const sameAgent = (a, b) => {
  for (let i = 0; i < 13; i++) { const k = AGENT_KEYS[i]; if (a[k] !== b[k] && !(a[k] !== a[k] && b[k] !== b[k])) return false; }
  const p = a.prs, q = b.prs;
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
};
// A PR record (the host adapter's shape: id, project, number, title, state, checks{3}, review, size{3}, then live when set),
// compared field by field.
const samePr = (a, b) => {
  // records this file and the adapter build carry exactly these keys in this order ('live' last when set), so the fields
  // decide; the nested checks / size are compared the same way (no key lists: this runs for every PR on every poll)
  if (a.id !== b.id || a.project !== b.project || a.number !== b.number || a.title !== b.title || a.state !== b.state || a.review !== b.review) return false;
  if (('live' in a) !== ('live' in b) || a.live !== b.live) return false;
  const c = a.checks, d = b.checks, y = a.size, z = b.size;
  if (c !== d && (c.passed !== d.passed || c.failed !== d.failed || c.pending !== d.pending)) return false;
  return y === z || (y.additions === z.additions && y.deletions === z.deletions && y.files === z.files);
};
const keep = (prevMap, nextMap, key, rec, eq = same) => {
  const prev = prevMap.get(key);
  const out = prev !== undefined && (prev === rec || eq(prev, rec)) ? prev : deepFreeze(rec);
  if (!nextMap.has(key)) nextMap.set(key, out);
  return out;
};

/**
 * @param {object} view SnapshotView (snapshot.js)
 * @param {{ seed?: number, salt?: string, env?: { night?: number, reduceMotion?: boolean, zoom?: number } }} opts
 * @returns {{ input: import('./api.js').WorldInput, serverId: (opaque: string) => string|undefined, opaqueId: (serverId: string) => string }}
 */
export function toWorldInput(view, { seed = 0, salt = '', env = {}, features = [], reuse = null } = {}) {
  const R = reuse;
  if (R && R.salt !== salt) { R.salt = salt; R.ids = new Map(); }
  if (R && R.titles.size > 20000) R.titles = new Map();
  if (R && (R.labels ||= new Map()).size > 20000) R.labels = new Map();
  if (R && R.ids.size > 20000) R.ids = new Map();
  const toServer = new Map(), toOpaque = new Map();
  const opaqueId = id => {
    let o = toOpaque.get(id);
    if (!o) {
      o = R?.ids.get(id);
      if (o === undefined) { o = `a${hash(`${salt}|${id}`).toString(36)}${hash(`${id}|${salt}|2`).toString(36)}`; R?.ids.set(id, o); }
      toOpaque.set(id, o); toServer.set(o, id);
    }
    return o;
  };
  const titleOf = raw => {
    if (typeof raw !== 'string') return '';   // cleanPrTitle of a non-string
    if (!R) return cleanPrTitle(firstLine(raw));
    let t = R.titles.get(raw);
    if (t === undefined) { t = cleanPrTitle(firstLine(raw)); R.titles.set(raw, t); }
    return t;
  };
  const agentsIn = view.agents || [], byId = view.byId || new Map();
  const projectNames = [...new Set(agentsIn.map(a => a.project || '—'))];
  const meta = new Map((view.projects || []).map(p => [p.name, p]));
  const agentsByProject = new Map(projectNames.map(n => [n, []]));
  for (const a of agentsIn) agentsByProject.get(a.project || '—').push(a);

  // PR history per project (the classic rule): the server's per-project list, else what its agents list right now.
  const prs = [], prsOf = new Map();
  for (const name of projectNames) {
    const m = meta.get(name), here = agentsByProject.get(name);
    // the project's own list is read in place (id, live, title); without one, what its agents list (no title)
    const own = !!m?.prs?.length;
    const list = own ? m.prs
      : [...new Map(here.flatMap(a => (a.prs || []).map(p => [String(p.id), { id: String(p.id), live: !!a.live && a.bucket !== 'resting' }]))).values()];
    const ids = [];
    for (const p of list) {
      const n = String(p.id), id = `${name}#${n}`;
      ids.push(id);
      // checks / size: shared frozen zeros (the adapter replaces, never mutates, them)
      prs.push({ id, project: name, number: num(n), title: titleOf(own ? p.title : undefined),   // titles OK; never URLs or paths (§3.1)
        state: p.live ? 'building' : 'merged',
        checks: ZERO_CHECKS, review: null, size: ZERO_SIZE });
    }
    prsOf.set(name, ids);
  }

  const labelOf = raw => {
    if (typeof raw !== 'string') return '';   // shortLabel of a non-string
    if (!R) return shortLabel(raw);
    let t = R.labels.get(raw);
    if (t === undefined) { t = shortLabel(raw); R.labels.set(raw, t); }
    return t;
  };
  // PERF M7 (poll path): with reuse, an agent whose fields all equal its last record's is that record (no new object)
  const agents = agentsIn.map(a => {
    const id = opaqueId(a.id), project = a.project || '—';
    const name = labelOf(a.shortName) || (a.harness === 'codex' ? 'Codex thread' : a.harness === 'claude-code' || a.harness === 'claude' ? 'Claude session' : 'Agent');
    const parent = a.parentId && byId.has(a.parentId) ? opaqueId(a.parentId) : null;
    const status = statusOf(a), needs = NEEDS.has(a.prompt) ? a.prompt : null, role = ROLE[a.role] || 'worker', crown = a.role === 'boss';
    const important = pinned(a), stopped = !!stoppedNote(a), harness = HARNESS[a.harness] || 'other', since = num(a.since), lastActive = num(a.lastActivityAt);
    const src = a.prs || [], prev = R?.agents.get(id);
    if (prev && prev.name === name && prev.project === project && prev.parent === parent && prev.status === status && prev.needs === needs
      && prev.role === role && prev.crown === crown && prev.important === important && prev.stopped === stopped && prev.harness === harness
      && Object.is(prev.since, since) && Object.is(prev.lastActive, lastActive) && prev.prs.length === src.length
      && src.every((p, i) => prev.prs[i] === `${project}#${String(p.id)}`)) return prev;
    return { id, name, project, parent, status, needs, role, crown, important, stopped, harness, since, lastActive,
      prs: src.map(p => `${project}#${String(p.id)}`) };
  });

  const liveOf = new Map(), nowOf = new Map();
  for (const p of prs) if (p.state === 'building') liveOf.set(p.project, (liveOf.get(p.project) || 0) + 1);
  for (const a of agents) nowOf.set(a.project, (nowOf.get(a.project) || 0) + 1);
  const projects = projectNames.map(name => {
    const m = meta.get(name) || {}, ids = prsOf.get(name) || [];
    return { key: name, name, accent: '',
      stats: { prsEver: ids.length, prsLive: liveOf.get(name) || 0,
        agentsEver: num(m.agentsEver), agentsNow: nowOf.get(name) || 0, transcriptMB: num(m.transcriptBytes) / 1e6 },
      ...(m.style != null ? { preset: { family: m.style.family ?? m.style } } : {}) };
  });

  // API v1: open PRs are 'building' unless the world opted in to 'prs.loading' (the resolved mod's `features`)
  // owned: `prs` is this call's own fresh entries, in the adapter's shape: laid over in place, not copied
  const ex = venuePrs(view, prs, { loading: Array.isArray(features) && features.includes('prs.loading'), owned: true });
  let agentsOut = agents, projectsOut = projects, prsOut = ex.prs;
  if (R) {
    const A = new Map(), P = new Map(), Q = new Map();
    agentsOut = agents.map(a => keep(R.agents, A, a.id, a, sameAgent));
    projectsOut = projects.map(p => keep(R.projects, P, p.key, p));
    prsOut = Array.isArray(ex.prs) ? ex.prs.map(p => (p && typeof p.id === 'string' ? keep(R.prs, Q, p.id, p, samePr) : p)) : ex.prs;
    R.agents = A; R.projects = P; R.prs = Q;
  }
  const input = deepFreeze({
    apiVersion: API_VERSION, now: num(view.now), seed: seed >>> 0, agents: agentsOut, projects: projectsOut, prs: prsOut, history: { merged: ex.merged, rank: ex.rank },
    env: { night: num(env.night), reduceMotion: !!(env.reduceMotion ?? view.reduceMotion), zoom: num(env.zoom) || 1 },
  });
  return { input, serverId: o => toServer.get(o), opaqueId };
}
