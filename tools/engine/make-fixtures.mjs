#!/usr/bin/env node
// Generates the engine fixtures into e2e/fixtures/engine/*.json. Deterministic: seeded PRNG, fixed NOW,
// no Math.random / Date.now in the output. Run: node tools/engine/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cityDemo } from '../../web/src/city-demo.js';

const OUT = fileURLToPath(new URL('../../e2e/fixtures/engine/', import.meta.url));
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0); // fixed
const MIN = 6e4;

const prng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const NAMES = ['Ada', 'Bram', 'Cora', 'Dov', 'Elin', 'Fenn', 'Gus', 'Hale', 'Ivo', 'Juno', 'Kit', 'Lark', 'Milo', 'Nell', 'Oren', 'Pia', 'Quill', 'Rue', 'Sol', 'Tam', 'Una', 'Vale', 'Wren', 'Yara'];
const WORDS = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'iris', 'juniper', 'kelp', 'lumen', 'maple', 'nova', 'onyx', 'pine', 'quartz', 'river', 'sage', 'tundra', 'umber', 'vega', 'willow', 'xenon', 'yarrow', 'zephyr'];
// tier -> [PRs, agentsEver, MB, agents per project]
const TIERS = { hamlet: [1, 4, 2, 4], village: [4, 18, 40, 7], town: [12, 60, 300, 14], city: [45, 260, 4000, 30] };

/** One project with its agents. opts.tier picks the size; lastAct = ms since the most recent activity. */
function makeProject(r, name, tier, now, idx) {
  const [bp, be, bmb, bn] = TIERS[tier], j = (v, s = 0.25) => Math.max(1, Math.round(v * (1 - s + 2 * s * r())));
  const nPrs = j(bp), live = Math.min(nPrs, 1 + Math.floor(r() * (tier === 'city' ? 6 : 3)));
  const base = 1000 * (idx + 1);
  const prs = Array.from({ length: nPrs }, (_, i) => ({ id: String(base + i), live: i >= nPrs - live }));
  const nAg = j(bn, 0.2), agents = [];
  const mk = (role, parent) => {
    const i = agents.length, x = r();
    const bucket = role === 'boss' && x < 0.5 ? 'waiting' : x < 0.12 ? 'stalled' : x < 0.34 ? 'waiting' : x < 0.68 ? 'building' : 'resting';
    const a = {
      id: `fx:${name}:${i}`, name: role === 'boss' ? `${name} Boss` : role === 'lead' ? `${NAMES[(idx + i) % NAMES.length]} Lead` : `${name.toLowerCase()}-${NAMES[(idx * 7 + i) % NAMES.length].toLowerCase()}`,
      project: name, bucket, severity: null, prompt: null, role, parentId: parent?.id ?? null, prs: [], live: bucket !== 'resting', hidden: false,
      important: r() < 0.06, since: now - Math.round((2 + r() * 120) * MIN), lastActivityAt: now - Math.round((0.5 + r() * 90) * MIN),
    };
    if (bucket === 'stalled') { a.severity = r() < 0.5 ? 'error' : 'attention'; a.prompt = a.severity === 'error' || r() < 0.5 ? 'permission' : null; }
    if (bucket === 'building' && role !== 'boss') { const lp = prs.filter(p => p.live); if (lp.length && r() < 0.7) a.prs.push({ id: lp[Math.floor(r() * lp.length)].id }); }
    if (bucket === 'resting') a.lastActivityAt = now - Math.round((90 + r() * 600) * MIN);
    agents.push(a); return a;
  };
  const boss = mk('boss', null);
  const nLeads = tier === 'hamlet' ? 0 : Math.max(1, Math.round(nAg / 6));
  const leads = Array.from({ length: nLeads }, () => mk('lead', boss));
  while (agents.length < nAg) {
    const k = r();
    if (leads.length && k < 0.6) mk('sub', leads[Math.floor(r() * leads.length)]); else mk('solo', null);
  }
  // keep the project awake: at least one building agent, activity recent
  if (!agents.some(a => a.bucket === 'building')) { const a = agents[agents.length - 1]; a.bucket = 'building'; a.live = true; a.severity = a.prompt = null; }
  return { agents, project: { name, prs, transcriptBytes: Math.round(j(bmb) * 1e6), agentsEver: j(be) } };
}

function makeWorld(seed, mix, now = NOW) {
  const r = prng(seed), agents = [], projects = [];
  const tiers = Object.entries(mix).flatMap(([t, n]) => Array(n).fill(t));
  for (let i = tiers.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [tiers[i], tiers[k]] = [tiers[k], tiers[i]]; }
  tiers.forEach((t, i) => { const nm = `${WORDS[i % WORDS.length]}${i >= WORDS.length ? '-' + Math.floor(i / WORDS.length + 1) : ''}`; const p = makeProject(r, nm, t, now, i); agents.push(...p.agents); projects.push(p.project); });
  return { agents, projects };
}

const prSize = r => { const k = r(); return k < 0.3 ? { additions: 8 + Math.floor(r() * 30), deletions: Math.floor(r() * 10), files: 1 + Math.floor(r() * 3) }
  : k < 0.8 ? { additions: 60 + Math.floor(r() * 250), deletions: Math.floor(r() * 120), files: 3 + Math.floor(r() * 10) } : { additions: 500 + Math.floor(r() * 900), deletions: Math.floor(r() * 400), files: 21 + Math.floor(r() * 30) }; };
function makeDock(seed, loading, sailed = 5, now = NOW) {
  const r = prng(seed), pr = n => ({ href: `https://example.invalid/dock/pull/${n}`, size: prSize(r) });
  return {
    loading: Array.from({ length: loading }, (_, i) => {
      const total = 4 + Math.floor(r() * 5), passed = Math.floor(r() * (total + 1)), failed = r() < 0.15 && passed < total ? 1 : 0;
      return { ...pr(500 + i), state: 'open', checks: { passed, failed, pending: total - passed - failed }, review: r() < 0.3 ? 'approved' : 'pending', since: now - Math.round((5 + r() * 400) * MIN) };
    }),
    sailed: Array.from({ length: sailed }, (_, i) => ({ href: `https://example.invalid/dock/pull/${480 + i}`, at: now - (i + 1) * 40 * MIN })),
    total: 120 + loading, level: 4,
  };
}
const EMPTY = { loading: [], sailed: [], total: 0, level: 1 };

const files = {};
// citydemo: dump of cityDemo(NOW); ids and prs trimmed to the snapshot fields.
{
  const d = cityDemo(NOW), keep = ['id', 'name', 'project', 'bucket', 'severity', 'prompt', 'role', 'parentId', 'live', 'hidden', 'important', 'since', 'lastActivityAt'];
  const agents = d.agents.map(a => ({ ...Object.fromEntries(keep.map(k => [k, a[k]])), prs: a.prs.map(p => ({ id: p.id })) }));
  const projects = d.projects.map(p => ({ name: p.name, prs: p.prs.map(x => ({ id: x.id, live: x.live })), transcriptBytes: p.transcriptBytes, agentsEver: p.agentsEver }));
  files['citydemo'] = { v: 1, name: 'citydemo', now: NOW, agents, projects, dock: EMPTY };
}
{ const w = makeWorld(11, { hamlet: 14, village: 12, town: 9, city: 5 }); files['busy'] = { v: 1, name: 'busy', now: NOW, ...w, dock: makeDock(12, 4) }; }
{ const w = makeWorld(21, { hamlet: 30, village: 30, town: 25, city: 15 }); files['stress'] = { v: 1, name: 'stress', now: NOW, ...w, dock: makeDock(22, 12) }; }
for (const [name, n, seed] of [['harbour', 16, 31], ['harbour-3', 3, 32], ['harbour-6', 6, 33], ['harbour-10', 10, 34]]) {
  const w = makeWorld(30, { hamlet: 1, village: 2, town: 2, city: 0 });
  files[name] = { v: 1, name, now: NOW, ...w, dock: makeDock(seed, n, 6) };
}
// sequence-50: a small busy-like world over 50 polls, 30 s apart.
{
  const r = prng(41), base = makeWorld(40, { hamlet: 2, village: 3, town: 2, city: 1 }), frames = [];
  let agents = base.agents.map(a => ({ ...a })), projects = JSON.parse(JSON.stringify(base.projects));
  const first = projects[0].name, leaver = agents.find(a => a.role === 'solo' && a.project === projects[1].name) || agents.find(a => a.role === 'solo');
  const target = projects.find(p => p.name !== first && p.prs.length >= 3) || projects[1];
  let leaverAgent = null;
  const grow = projects.reduce((m, p) => (m && m.agentsEver < p.agentsEver ? m : p), null) ; // smallest by agentsEver
  const SZ = 14;
  for (let i = 0; i < 50; i++) {
    const now = NOW + i * 30000;
    // status changes every poll: a few agents move bucket
    for (let k = 0; k < 4; k++) {
      const a = agents[Math.floor(r() * agents.length)];
      if (a.id === leaver.id && i >= 15 && i < 20) continue;
      const order = ['building', 'waiting', 'resting', 'stalled'], nb = order[(order.indexOf(a.bucket) + 1 + Math.floor(r() * 3)) % 4];
      a.bucket = nb; a.live = nb !== 'resting'; a.since = now; a.lastActivityAt = now;
      a.severity = nb === 'stalled' ? 'attention' : null; a.prompt = nb === 'stalled' ? 'permission' : null;
    }
    // keep every project awake: one agent stays building
    for (const p of projects) { const mine = agents.filter(a => a.project === p.name); if (!mine.some(a => a.bucket !== 'resting')) { mine[0].bucket = 'building'; mine[0].live = true; mine[0].severity = mine[0].prompt = null; } }
    if (i === 10) { target.prs.push({ id: '9001', live: true }); const b = agents.find(a => a.project === target.name && a.bucket === 'building' && a.role !== 'boss'); if (b) b.prs.push({ id: '9001' }); }
    if (i === 25) { const t = target.prs.find(p => p.id === '9001'); if (t) t.live = false; for (const a of agents) a.prs = a.prs.filter(p => p.id !== '9001'); }
    if (i === 15) { leaverAgent = leaver; agents = agents.filter(a => a.id !== leaver.id); }
    if (i === 20) agents.push({ ...leaverAgent, bucket: 'waiting', live: true, since: now, lastActivityAt: now });
    if (i === 30) {
      const nm = 'newcomer', p = makeProject(prng(77), nm, 'hamlet', now, 99);
      projects.push(p.project); agents.push(...p.agents);
    }
    if (i === 40) { const g = grow; g.agentsEver += 120; g.transcriptBytes += 300e6; for (let k = 0; k < 4; k++) g.prs.push({ id: String(8000 + k), live: false }); }
    frames.push({ now, agents: JSON.parse(JSON.stringify(agents)), projects: JSON.parse(JSON.stringify(projects)), dock: makeDock(42, 3, 3, now) });
  }
  void SZ;
  files['sequence-50'] = { v: 1, name: 'sequence-50', frames };
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, fx] of Object.entries(files)) {
  const s = JSON.stringify(fx);
  if (s.length > 2e6) throw new Error(`${name} is ${s.length} bytes (> 2 MB)`);
  fs.writeFileSync(path.join(OUT, `${name}.json`), s + '\n');
  const ag = fx.agents ? fx.agents.length : `${fx.frames[0].agents.length}..`, pr = fx.projects ? fx.projects.length : fx.frames[0].projects.length;
  console.log(`${name}.json  ${(s.length / 1024).toFixed(0)} KB  agents ${ag}  projects ${pr}`);
}
