// WorldInput: the sanitised, allow-listed, deep-frozen view a mod sees (village-mods.md §3.1). OWNER: A1.
// Built field by field from SnapshotView: nothing is copied wholesale, so a new server field can never leak by default.
// Never passes: conversation text, ask/reason/resume, cwd/paths, hrefs/URLs, account/model/spend, raw server ids.
import { API_VERSION } from './api.js';
import { hash } from '../core/rng.js';
import { pinned, stoppedNote } from '../../important.js';
import { cleanPrTitle } from '../sim/represent-world.js';

const NEEDS = new Set(['permission', 'question', 'plan', 'dialog']);
const ROLE = { boss: 'boss', lead: 'lead', sub: 'sub' };
const HARNESS = { 'claude-code': 'claude', claude: 'claude', codex: 'codex' };
const num = v => (Number.isFinite(+v) ? +v : 0);
const str = v => (typeof v === 'string' ? v : '');
// Mods only ever get a short label: the server's shortName (nickname/override/session name, never prompt-derived),
// first line, whitespace collapsed, cut to 32 chars with an ellipsis. Without one: a neutral label, never a.name/a.title.
export const NAME_MAX = 32;
export function shortLabel(raw) {
  const first = str(raw).split(/\r?\n/).find(l => l.trim()) || '';
  const t = first.replace(/\s+/g, ' ').trim();
  const cp = [...t];
  return cp.length > NAME_MAX ? `${cp.slice(0, NAME_MAX - 1).join('').trimEnd()}\u2026` : t;
}
const statusOf = a => (a.bucket === 'building' ? 'working' : a.bucket === 'waiting' ? 'waiting' : a.bucket === 'resting' ? 'resting'
  : a.severity === 'error' ? 'error' : 'stalled');
const deepFreeze = o => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

/**
 * @param {object} view SnapshotView (snapshot.js)
 * @param {{ seed?: number, salt?: string, env?: { night?: number, reduceMotion?: boolean, zoom?: number } }} opts
 * @returns {{ input: import('./api.js').WorldInput, serverId: (opaque: string) => string|undefined, opaqueId: (serverId: string) => string }}
 */
export function toWorldInput(view, { seed = 0, salt = '', env = {} } = {}) {
  const toServer = new Map(), toOpaque = new Map();
  const opaqueId = id => {
    let o = toOpaque.get(id);
    if (!o) {
      o = `a${hash(`${salt}|${id}`).toString(36)}${hash(`${id}|${salt}|2`).toString(36)}`;
      toOpaque.set(id, o); toServer.set(o, id);
    }
    return o;
  };
  const agentsIn = view.agents || [], byId = view.byId || new Map();
  const projectNames = [...new Set(agentsIn.map(a => a.project || '—'))];
  const meta = new Map((view.projects || []).map(p => [p.name, p]));

  // PR history per project (the classic rule): the server's per-project list, else what its agents list right now.
  const prs = [], prsOf = new Map();
  for (const name of projectNames) {
    const m = meta.get(name), here = agentsIn.filter(a => (a.project || '—') === name);
    const list = m?.prs?.length ? m.prs.map(p => ({ n: String(p.id), live: !!p.live, title: p.title }))
      : [...new Map(here.flatMap(a => (a.prs || []).map(p => [String(p.id), { n: String(p.id), live: !!a.live && a.bucket !== 'resting' }]))).values()];
    const ids = [];
    for (const p of list) {
      const id = `${name}#${p.n}`;
      ids.push(id);
      prs.push({ id, project: name, number: num(p.n), title: cleanPrTitle(p.title),   // titles OK; never URLs or paths (§3.1)
        state: p.live ? 'building' : 'merged',
        checks: { passed: 0, failed: 0, pending: 0 }, review: null, size: { additions: 0, deletions: 0, files: 0 } });
    }
    prsOf.set(name, ids);
  }

  const agents = agentsIn.map(a => ({
    id: opaqueId(a.id), name: shortLabel(a.shortName) || (a.harness === 'codex' ? 'Codex thread' : a.harness === 'claude-code' || a.harness === 'claude' ? 'Claude session' : 'Agent'), project: a.project || '—',
    parent: a.parentId && byId.has(a.parentId) ? opaqueId(a.parentId) : null,
    status: statusOf(a), needs: NEEDS.has(a.prompt) ? a.prompt : null,
    role: ROLE[a.role] || 'worker', crown: a.role === 'boss', important: pinned(a), stopped: !!stoppedNote(a),
    harness: HARNESS[a.harness] || 'other', since: num(a.since), lastActive: num(a.lastActivityAt),
    prs: (a.prs || []).map(p => `${a.project || '—'}#${String(p.id)}`),
  }));

  const projects = projectNames.map(name => {
    const m = meta.get(name) || {}, ids = prsOf.get(name) || [];
    return { key: name, name, accent: '',
      stats: { prsEver: ids.length, prsLive: prs.filter(p => p.project === name && p.state === 'building').length,
        agentsEver: num(m.agentsEver), agentsNow: agents.filter(a => a.project === name).length, transcriptMB: num(m.transcriptBytes) / 1e6 },
      ...(m.style != null ? { preset: { family: m.style.family ?? m.style } } : {}) };
  });

  const input = deepFreeze({
    apiVersion: API_VERSION, now: num(view.now), seed: seed >>> 0, agents, projects, prs,
    env: { night: num(env.night), reduceMotion: !!(env.reduceMotion ?? view.reduceMotion), zoom: num(env.zoom) || 1 },
  });
  return { input, serverId: o => toServer.get(o), opaqueId };
}
