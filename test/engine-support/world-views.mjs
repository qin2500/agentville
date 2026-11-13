// Synthetic SnapshotViews + fixture loading for test/engine-world.test.mjs. Pure, in-memory, no real sessions.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeView, viewFromFixture } from '../../web/src/engine/snapshot.js';

export const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const FIX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e', 'fixtures', 'engine');
export const fixturePath = name => path.join(FIX_DIR, name);
export function loadFixture(name) {
  const p = fixturePath(name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

let seq = 0;
/** Agents for one project: 1 boss, `leads` leads (parented to the boss), `subs` subs (parented to leads), plus `flat` plain agents. */
export function crew(project, { leads = 0, subs = 0, flat = 0, bucket = 'building', prs = [], now = NOW } = {}) {
  const out = [];
  const mk = (role, parentId, b, n) => {
    const id = `${project}-${role || 'a'}-${n}`;
    out.push({ id, name: id, project, bucket: b, role, parentId, severity: 0, live: b !== 'resting', lastActivityAt: now - 60_000 * (n + 1), prs: [] });
    return id;
  };
  const boss = mk('boss', undefined, 'waiting', 0);
  const lead = [];
  for (let i = 0; i < leads; i++) lead.push(mk('lead', boss, bucket, i));
  for (let i = 0; i < subs; i++) mk('sub', lead.length ? lead[i % lead.length] : boss, i % 3 === 0 ? 'resting' : bucket, i);
  for (let i = 0; i < flat; i++) mk(undefined, undefined, i % 4 === 0 ? 'resting' : bucket, 100 + i);
  prs.forEach((p, i) => { if (out[i]) out[i].prs = [{ id: String(p.id) }]; if (out[i]) out[i].live = p.live; });
  return out;
}
const projOf = (name, prs = []) => ({ name, prs: prs.map(p => ({ id: String(p.id), live: !!p.live })), transcriptBytes: 1e5, agentsEver: 10 });
const DOCK = { loading: [], sailed: [], total: 3, level: 1 };

/** Own small synthetic views, so the suite never depends only on fixtures. */
export function syntheticViews(now = NOW) {
  const mixed = (() => {
    const pr1 = [{ id: 11, live: true }, { id: 12, live: false }];
    const agents = [
      ...crew('alpha', { leads: 1, subs: 3, prs: pr1, now }),
      ...crew('beta', { leads: 2, subs: 8, flat: 4, prs: [{ id: 21, live: true }], now }),
      ...crew('gamma', { leads: 3, subs: 30, flat: 12, prs: [{ id: 31, live: true }, { id: 32, live: true }, { id: 33, live: false }], now }),
      ...crew('delta', { now }),
    ];
    return makeView({ agents, projects: [projOf('alpha', pr1), projOf('beta', [{ id: 21, live: true }]), projOf('gamma', [{ id: 31, live: true }, { id: 32, live: true }, { id: 33, live: false }]), projOf('delta')], dock: DOCK }, { now });
  })();
  const tiny = makeView({ agents: crew('solo', { now }), projects: [projOf('solo')], dock: DOCK }, { now });
  const wide = (() => {
    const agents = [], projects = [];
    for (let i = 0; i < 12; i++) {
      const n = `proj${i}`;
      agents.push(...crew(n, { leads: i % 3, subs: (i * 5) % 17, flat: i % 4, prs: i % 2 ? [{ id: 100 + i, live: i % 4 === 1 }] : [], now }));
      projects.push(projOf(n, i % 2 ? [{ id: 100 + i, live: i % 4 === 1 }] : []));
    }
    return makeView({ agents, projects, dock: { ...DOCK, level: 2, total: 9 } }, { now });
  })();
  return [['synthetic-tiny', tiny, now], ['synthetic-mixed', mixed, now], ['synthetic-wide', wide, now]];
}

/** A 50-poll synthetic sequence: project 'gamma' grows, statuses cycle, PRs open and close. Deterministic. */
export function syntheticFrames(n = 50, t0 = NOW) {
  const frames = [];
  for (let f = 0; f < n; f++) {
    const now = t0 + f * 30_000;
    const buckets = ['building', 'waiting', 'resting', 'stalled'];
    const agents = [];
    const grow = 2 + Math.floor(f / 2);                       // gamma gains subs over time
    for (const [proj, base] of [['alpha', 4], ['beta', 6], ['gamma', grow]]) {
      const cs = crew(proj, { leads: 1, subs: base, now });
      cs.forEach((a, i) => { a.bucket = buckets[(i + f) % 4]; a.live = a.bucket !== 'resting'; a.lastActivityAt = now - 1000 * i; });
      agents.push(...cs);
    }
    const prA = f % 7 < 4 ? [{ id: 11, live: f % 2 === 0 }] : [];
    const prG = f > 10 ? [{ id: 31, live: true }, ...(f % 5 === 0 ? [{ id: 32, live: false }] : [])] : [];
    agents.find(a => a.project === 'alpha' && a.role === 'lead').prs = prA.map(p => ({ id: String(p.id) }));
    if (prG.length) agents.find(a => a.project === 'gamma' && a.role === 'lead').prs = prG.map(p => ({ id: String(p.id) }));
    frames.push({ now, agents, projects: [projOf('alpha', prA), projOf('beta'), projOf('gamma', prG)], dock: DOCK });
  }
  return frames;
}

export { makeView, viewFromFixture };
