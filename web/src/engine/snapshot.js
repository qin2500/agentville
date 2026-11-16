// The one file that knows the server's snapshot shape (design §6.2). Pure: node tests import it.
//
// SnapshotView = {
//   now: number,                 // ms; pinned by ?t= or the fixture
//   agents: Agent[],             // only the agents the village shows (quiet projects removed; the selected agent's project kept)
//   byId: Map<string, Agent>,    // every agent the server sent (shown, quiet or hidden), for parent lookups
//   projects: Project[],         // { name, prs: [{ id, live }], transcriptBytes, agentsEver }
//   quiet: string[],             // hidden quiet project names
//   dock: { loading: [], sailed: [], total: number, level: number },
//   hideQuiet: boolean, reduceMotion: boolean, demo: boolean,
// }
// Agent fields read (copied, never mutated): id, name, project, bucket, severity, prompt, role, parentId, prs[{ id }],
// live, hidden, important, since, lastActivityAt, folds/pinned/stoppedNote inputs (important.js reads `important`, `hidden`).
import { visibleProjects } from '../quiet.js';

// Server shape audited (A8): prompt is an enum key (permission|question|plan|dialog), severity error|attention|null,
// prs ids are digit strings; stoppedNote/folds/pinned are computed client-side (important.js) from reason/live/important/hidden.
export const AGENT_FIELDS = ['id', 'name', 'shortName', 'project', 'bucket', 'severity', 'prompt', 'role', 'parentId', 'childIds', 'prs', 'live', 'hidden',
  'important', 'since', 'lastActivityAt', 'reason', 'color', 'harness', 'kind', 'ask', 'resume', 'reopened', 'neverStarted'];
const EMPTY_DOCK = { loading: [], sailed: [], total: 0, level: 1 };

// PERF M7 (poll path): the field copy written out (named reads are much faster than a keyed loop over AGENT_FIELDS); the
// same fields in the same order as `for (const k of AGENT_FIELDS) if (a[k] !== undefined) o[k] = a[k]` (a test pins it).
export function copyAgentFields(a) {
  const o = {};
  if (a.id !== undefined) o.id = a.id;
  if (a.name !== undefined) o.name = a.name;
  if (a.shortName !== undefined) o.shortName = a.shortName;
  if (a.project !== undefined) o.project = a.project;
  if (a.bucket !== undefined) o.bucket = a.bucket;
  if (a.severity !== undefined) o.severity = a.severity;
  if (a.prompt !== undefined) o.prompt = a.prompt;
  if (a.role !== undefined) o.role = a.role;
  if (a.parentId !== undefined) o.parentId = a.parentId;
  if (a.childIds !== undefined) o.childIds = a.childIds;
  if (a.prs !== undefined) o.prs = a.prs;
  if (a.live !== undefined) o.live = a.live;
  if (a.hidden !== undefined) o.hidden = a.hidden;
  if (a.important !== undefined) o.important = a.important;
  if (a.since !== undefined) o.since = a.since;
  if (a.lastActivityAt !== undefined) o.lastActivityAt = a.lastActivityAt;
  if (a.reason !== undefined) o.reason = a.reason;
  if (a.color !== undefined) o.color = a.color;
  if (a.harness !== undefined) o.harness = a.harness;
  if (a.kind !== undefined) o.kind = a.kind;
  if (a.ask !== undefined) o.ask = a.ask;
  if (a.resume !== undefined) o.resume = a.resume;
  if (a.reopened !== undefined) o.reopened = a.reopened;
  if (a.neverStarted !== undefined) o.neverStarted = a.neverStarted;
  return o;
}
const pickAgent = a => {
  const o = copyAgentFields(a);
  o.project ||= '—';
  o.prs = (a.prs || []).map(p => ({ ...p, id: String(p.id) }));
  return o;
};
const pickProject = p => ({ name: p.name, prs: (p.prs || []).map(r => ({ id: String(r.id), live: !!r.live, ...(typeof r.title === 'string' ? { title: r.title } : {}) })),
  transcriptBytes: p.transcriptBytes || 0, agentsEver: p.agentsEver || 0, ...(p.style != null ? { style: p.style } : {}) });

/**
 * @param {{ agents: object[], byId?: Map, projects?: object[], dock?: object, hideQuiet?: boolean, reduceMotion?: boolean }} src
 * @param {{ now?: number, selected?: string|null, demo?: boolean }} opts
 */
export function makeView(src, { now = Date.now(), selected = null, demo = false } = {}) {
  const all = (src.agents || []).map(pickAgent);
  // byId holds every agent the server sent (hidden ones too, for parent lookups); `all` is what may show.
  const byId = new Map([...(src.everyone || []).map(pickAgent), ...all].map(a => [a.id, a]));
  let agents = all, quiet = [];
  if (!demo) {
    const sel = selected && byId.get(selected);
    // parity: world.quiet-projects-hidden, world.selected-project-always-shown
    const vis = visibleProjects(all, { hideQuiet: !!src.hideQuiet, keep: sel ? [sel.project] : [], now });
    agents = all.filter(a => vis.shown.has(a.project));
    quiet = vis.quiet || [];
  }
  return {
    now, agents, byId, quiet,
    projects: (src.projects || []).map(pickProject),
    dock: src.dock || EMPTY_DOCK,
    hideQuiet: !!src.hideQuiet, reduceMotion: !!src.reduceMotion, demo,
  };
}

/** The app state `S` (main.js) → SnapshotView. */
export function toView(S, opts = {}) {
  return makeView({ agents: S.agents || [], everyone: S.data?.agents, projects: S.data?.projects || [], dock: S.dock, hideQuiet: S.hideQuiet, reduceMotion: S.reduceMotion }, opts);
}

/** A frozen fixture (e2e/fixtures/engine/*.json: { v: 1, now, agents, projects, dock }) → SnapshotView. */
export function viewFromFixture(fx, opts = {}) {
  return makeView(fx, { now: fx.now, demo: !!fx.demo, ...opts });
}
