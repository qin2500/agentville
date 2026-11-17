#!/usr/bin/env node
// Nested growth history for the 1,000-agent stress fixture (M7 P3; design decision: perf budgets are
// measured on a town that GREW through several tier-ups, not a fresh one).
//
// Fractions: the plan said [0.06, 0.2, 0.5, 1.0], but with the fantasy thresholds (tierFor: 12 / 40 / 200 growth, growth =
// 3*prs + agentsEver + log2(MB+1)) every stress city is already tier 1 at 0.06 (the ceil keeps >= 1 PR and agent and
// the transcript term alone is ~6) and tier 2 at 0.2 and 0.5 mixes tiers 2 and 3. [0.006, 0.06, 0.2, 1.0] makes all 15
// cities go 0 > 1 > 2 > 3, one tier-up per step (the run fails if they do not).
//
// Replays e2e/fixtures/engine/stress.json as 4 days of growth. Step i keeps a fraction f = FRACTIONS[i] of each project:
// the boss + the first ceil(f*n) other agents (fixture order), the first ceil(f*prs) PRs, ceil(f*agentsEver) and
// round(f*transcriptBytes). Each step runs the real pipeline the engine page runs for ?fixture= (makeView ->
// toWorldInput -> buildWorld with the fantasy mod), carrying the persisted layout forward, so every block re-plans
// nested on each tier-up. The last step is the full fixture at its own `now`, so the page loads the saved layout with
// no re-plan. Step i runs at now_i = fixture.now - (STEPS-1-i) days (= NOW + i*day with NOW three days earlier); agent
// and dock timestamps shift with it so ages stay the same.
//
// Output (default e2e/fixtures/engine/stress-nested.layout.json, or --out <file>):
//   { v: 1, fixture: 'stress', seed: 7, steps: 4, fractions, salt, persisted,
//     projects: [{ name, tier, tiers: [t0..t3], nest, chainDepth }] }
// persisted is what the page reads from localStorage va.engine2.world.demo (fixture runs use the demo key), with
// va.engine2.seed = seed and va.engine2.salt = salt (lots are keyed by opaque agent ids, which hash the salt).
// `projects` is a summary for tests and reports (the per-step tier history, the block's nest chain).
//
// Deterministic: no Math.random, no Date.now; byte-identical output on every run. Node only, touches nothing but --out.
//   node tools/engine/make-nested-history.mjs [--out file] [--quiet]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../test/support/ensure-mods-index.mjs';

const { buildWorld } = await import('../../web/src/engine/world/build.js');
const { viewFromFixture } = await import('../../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../../web/src/engine/mod/input.js');
const { default: fantasy } = await import('../../mods/agentville.fantasy/index.js');

export const FRACTIONS = [0.006, 0.06, 0.2, 1.0];
export const SEED = 7;
export const SALT = '5eed0007c0ffee00d00dfeed0000beef';   // fixed opaque-id salt (32 hex); the perf harness seeds the same one
const DAY = 864e5;

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = path.join(ROOT, 'e2e/fixtures/engine/stress.json');
const OUT = path.resolve(opt('out', path.join(ROOT, 'e2e/fixtures/engine/stress-nested.layout.json')));

/** The fixture cut to fraction f, timestamps shifted by dt ms. */
export function slice(fx, f, dt) {
  const projects = fx.projects.map(p => {
    const prs = p.prs.slice(0, Math.ceil(f * p.prs.length));
    return { ...p, prs, agentsEver: Math.ceil(f * (p.agentsEver || 0)), transcriptBytes: Math.round(f * (p.transcriptBytes || 0)) };
  });
  const keptPrs = new Set(projects.flatMap(p => p.prs.map(r => r.id)));
  const byProject = new Map();
  for (const a of fx.agents) { if (!byProject.has(a.project)) byProject.set(a.project, []); byProject.get(a.project).push(a); }
  const keep = new Set();
  for (const list of byProject.values()) {
    const others = list.filter(a => a.role !== 'boss');
    for (const a of list) if (a.role === 'boss') keep.add(a.id);
    for (const a of others.slice(0, Math.ceil(f * others.length))) keep.add(a.id);
  }
  const shift = v => (typeof v === 'number' ? v + dt : v);
  const agents = fx.agents.filter(a => keep.has(a.id)).map(a => ({ ...a, since: shift(a.since), lastActivityAt: shift(a.lastActivityAt),
    prs: (a.prs || []).filter(r => keptPrs.has(r.id)) }));
  const dock = fx.dock && {
    ...fx.dock,
    loading: (fx.dock.loading || []).map(d => ({ ...d, since: shift(d.since) })),
    sailed: (fx.dock.sailed || []).map(d => ({ ...d, at: shift(d.at) })),
  };
  return { ...fx, now: fx.now + dt, agents, projects, ...(dock ? { dock } : {}) };
}

/** Replays the history; returns { persisted, projects, steps: [{ f, now, agents, tiers: { name: tier } }] }. */
export function makeHistory(fx, { fractions = FRACTIONS, seed = SEED, salt = SALT } = {}) {
  const persisted = { v: 1, seed, blocks: {}, lots: {} };
  const steps = [];
  const snap = () => JSON.stringify([persisted.blocks, persisted.lots]);
  let settle = 0;
  fractions.forEach((f, i) => {
    const step = slice(fx, f, -(fractions.length - 1 - i) * DAY);
    const view = viewFromFixture(step, { now: step.now });
    const { input, serverId } = toWorldInput(view, { seed, salt, features: fantasy.features });
    let w = buildWorld(input, persisted, { mod: fantasy, now: step.now, seed, serverId });
    // The last step polls again at the same time until the layout is a fixed point: the first build after growth
    // holds the lots of items that just left (and caps follow), so one more poll can still change a block's capacity.
    // A live town is past that after its second poll; the page must load this layout with no re-plan.
    if (i === fractions.length - 1) {
      for (let before = snap(); settle < 4; before = snap()) {
        w = buildWorld(input, persisted, { mod: fantasy, now: step.now, seed, serverId });
        settle++;
        if (snap() === before) break;
      }
      if (settle >= 4) throw new Error('the final layout did not settle in 4 polls');
    }
    steps.push({ f, now: step.now, agents: step.agents.length, objects: w.objects.size,
      tiers: Object.fromEntries(w.villages.map(v => [v.name, v.tier])) });
  });
  const names = Object.keys(steps.at(-1).tiers).sort();
  // block.nest is the plan chain the block's plan nests, oldest first ("0.0>1.0>2.0>3.0"): its depth is the plan count
  const projects = names.map(name => {
    const nest = persisted.blocks[name]?.nest ?? '';
    return { name, tier: steps.at(-1).tiers[name], tiers: steps.map(s => s.tiers[name] ?? null), nest, chainDepth: nest ? nest.split('>').length : 0 };
  });
  return { persisted, projects, steps, settlePolls: settle };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fx = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const { persisted, projects, steps, settlePolls } = makeHistory(fx);
  // the point of the fixture: every city grew hamlet -> village -> town -> city, one tier per step
  const bad = projects.filter(p => p.tier === 3 && p.tiers.join('>') !== '0>1>2>3');
  if (!projects.some(p => p.tier === 3) || bad.length) {
    console.error(`cities did not grow 0>1>2>3: ${bad.map(p => `${p.name} ${p.tiers.join('>')}`).join(', ') || 'no city'}`);
    process.exit(1);
  }
  const out = { v: 1, fixture: 'stress', seed: SEED, steps: FRACTIONS.length, fractions: FRACTIONS, salt: SALT, persisted, projects };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  if (!args.includes('--quiet')) {
    const byTier = t => projects.filter(p => p.tier === t).length;
    console.log(`final step settled after ${settlePolls} extra poll(s)`);
    console.log(`steps: ${steps.map(s => `f=${s.f} agents=${s.agents} objects=${s.objects}`).join(' | ')}`);
    const chains = {};
    for (const p of projects) chains[`t${p.tier}/depth${p.chainDepth}`] = (chains[`t${p.tier}/depth${p.chainDepth}`] || 0) + 1;
    console.log(`chain depths (final tier/depth): ${Object.entries(chains).sort().map(([k, n]) => `${k} x${n}`).join(', ')}`);
    console.log(`final tiers: ${[0, 1, 2, 3].map(t => `${t}:${byTier(t)}`).join(' ')}`);
    const hist = {};
    for (const p of projects) hist[p.tiers.join('>')] = (hist[p.tiers.join('>')] || 0) + 1;
    console.log(`tier paths: ${Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', ')}`);
    console.log(`→ ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
  }
}
