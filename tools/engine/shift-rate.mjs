#!/usr/bin/env node
// Nested-growth shift rate (M7 p6). Replays a synthetic growth history for every project of an engine fixture (busy,
// stress): each project appears at a staggered stage and grows (PRs, agents, agentsEver, transcript) to its fixture size
// over STAGES rebuilds, so tier-ups and capacity re-plans happen in a crowded town, as in a real town. After each rebuild
// it counts the nested re-plans (a block whose plan nests the plan it drew last) and how many of them did not land on
// their anchor (old origin - nest offset), i.e. moved every old building by one shared shift.
//   events: (project, nested re-plan) pairs; shifted: those that moved. tierUps: the subset that changed tier.
//   rebuilds: rebuilds with at least one nested re-plan; rebuildsShifted: those where anything shifted.
// Engine path: runRules + planSettlements + placeBlocks (the placement buildWorld runs). Classic path: world.js
// plan() + layout() (same nested anchor, nearestSpot fallback). Pure, node only: no store, no real sessions.
// Run: node tools/engine/shift-rate.mjs [--label before|after] [--fixtures busy,stress] [--classic]
// Prints JSON and merges it into /tmp/enginev2/m7-shift-rate.json under the label.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LABEL = arg('--label', 'current'), FIXTURES = arg('--fixtures', 'busy,stress').split(','), CLASSIC = argv.includes('--classic');
const STAGES = Number(arg('--stages', 14)), OUT = arg('--out', '/tmp/enginev2/m7-shift-rate.json');

const { writeModsIndex } = await import(`${ROOT}tools/mods-index.mjs`);
writeModsIndex(ROOT);   // mods/index.js is generated (gitignored); the registry imports it
const { runRules } = await import(`${ROOT}web/src/engine/world/rules-phase.js`);
const { planSettlements, placeBlocks } = await import(`${ROOT}web/src/engine/world/sites.js`);
const { makeView } = await import(`${ROOT}web/src/engine/snapshot.js`);
const { toWorldInput } = await import(`${ROOT}web/src/engine/mod/input.js`);
const { default: fantasy } = await import(`${ROOT}mods/agentville.fantasy/index.js`);
const { modCtx } = await import(`${ROOT}web/src/engine/mod/registry.js`);

const SEED = 7;
const prng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

/** The fixture at stage k of the history: each project appears at its own stage and grows to its fixture size. */
export function stageOf(fx, k, stages = STAGES) {
  const r = prng(1234), start = new Map(fx.projects.map(p => [p.name, Math.floor(r() * stages * 0.6)]));
  const projects = [], agents = [];
  for (const p of fx.projects) {
    const s0 = start.get(p.name);
    if (k < s0) continue;
    const f = Math.min(1, (k - s0 + 1) / (stages - s0)), part = n => Math.max(1, Math.ceil(n * f));
    const mine = fx.agents.filter(a => a.project === p.name), keep = mine.slice(0, part(mine.length));
    const ids = new Set(keep.map(a => a.id));
    const prs = p.prs.slice(0, part(p.prs.length));
    const prIds = new Set(prs.map(x => x.id));
    agents.push(...keep.map(a => ({ ...a, parentId: ids.has(a.parentId) ? a.parentId : null, prs: (a.prs || []).filter(x => prIds.has(x.id)) })));
    projects.push({ ...p, prs, agentsEver: part(p.agentsEver), transcriptBytes: Math.round(p.transcriptBytes * f) });
  }
  return { ...fx, agents, projects };
}

function tally() { return { events: 0, coverable: 0, headroom: [], shifted: 0, tierUps: 0, tierUpsShifted: 0, rebuilds: 0, rebuildsShifted: 0, maxShift: 0, sumShift: 0 }; }
function finish(t) {
  const hr = [...t.headroom].sort((a, b) => a - b), at = q => hr.length ? hr[Math.min(hr.length - 1, Math.floor(q * hr.length))] : 0;
  const share = g => hr.length ? +(hr.filter(h => h >= g).length / hr.length).toFixed(3) : 0;
  delete t.headroom;
  return { ...t, coverableRate: t.events ? +(t.coverable / t.events).toFixed(3) : 0,
    headroom: { p25: at(0.25), median: at(0.5), p75: at(0.75), atLeast2: share(2), atLeast4: share(4), atLeast8: share(8), atLeast14: share(14) }, eventRate: t.events ? +(t.shifted / t.events).toFixed(3) : 0, tierUpRate: t.tierUps ? +(t.tierUpsShifted / t.tierUps).toFixed(3) : 0,
    rebuildRate: t.rebuilds ? +(t.rebuildsShifted / t.rebuilds).toFixed(3) : 0, meanShift: t.shifted ? +(t.sumShift / t.shifted).toFixed(2) : 0 };
}
// one rebuild's nested re-plans: before = persisted blocks before, after = after, planOf(name) = the plan drawn
// Free room round a block (bounded analysis, not the placement rule): whether a w×h rect that covers `old` (so every old
// item could stay on its tile) is at least GAP from every obstacle, and the largest uniform growth g for which one is.
const GAP = fantasy.rules.layout.gap, SQUARE = fantasy.rules.layout.square;
const near = (a, b) => a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
function covers(old, w, h, obs) {
  for (let y = old.y + old.h - h; y <= old.y; y++) for (let x = old.x + old.w - w; x <= old.x; x++) {
    const r = { x, y, w, h };
    if (!obs.some(o => near(r, o))) return true;
  }
  return false;
}
function headroom(old, obs) { let g = 0; while (g < 40 && covers(old, old.w + g + 1, old.h + g + 1, obs)) g++; return g; }
function count(T, before, after, planOf) {
  let any = 0, shifted = 0;
  for (const [name, b] of Object.entries(after)) {
    const was = before[name];
    if (!was || was.away || typeof was.nest !== 'string' || b.nest === was.nest) continue;
    const n = planOf(name)?.nest;
    if (!n || n.from !== was.nest) continue;
    any++; T.events++;
    const obs = [SQUARE, ...Object.entries(before).filter(([k, o]) => k !== name && !o.away).map(([, o]) => o)];
    if (covers(was, b.w, b.h, obs)) T.coverable++;
    T.headroom.push(headroom(was, obs));
    const up = b.tier !== was.tier;
    if (up) T.tierUps++;
    const sx = b.x - (was.x - n.dx), sy = b.y - (was.y - n.dy);
    if (sx || sy) {
      shifted++; T.shifted++; if (up) T.tierUpsShifted++;
      if (process.env.SHIFT_DEBUG) console.error(name, `${was.tier}->${b.tier}`, 'was', [was.x, was.y, was.w, was.h], 'want', [was.x - n.dx, was.y - n.dy], 'got', [b.x, b.y, b.w, b.h]);
      const d = Math.hypot(sx, sy); T.sumShift += d; T.maxShift = Math.max(T.maxShift, +d.toFixed(2));
    }
  }
  if (any) { T.rebuilds++; if (shifted) T.rebuildsShifted++; }
}

export function engineRate(fx, stages = STAGES) {
  const P = { v: 1, seed: SEED, blocks: {}, lots: {} }, T = tally();
  for (let k = 0; k < stages; k++) {
    const src = stageOf(fx, k, stages), now = fx.now + k * 3600e3;
    const { input, serverId } = toWorldInput(makeView(src, { now }), { seed: SEED, salt: 'shift' });
    const ctxFor = projectKey => modCtx(fantasy, { seed: SEED, now, projectKey });
    const opts = { now, seed: SEED, serverId, ctxFor };
    const before = JSON.parse(JSON.stringify(P.blocks));
    const rules = runRules(input, P, fantasy, opts);
    const { settlements } = planSettlements(input, P, fantasy, opts, rules);
    const placed = placeBlocks(settlements, P, fantasy, { now, ctxFor, seed: SEED });
    const plans = new Map(placed.villages.map(v => [v.name, v.plan]));
    count(T, before, P.blocks, n => plans.get(n));
  }
  return finish(T);
}

async function classicRate(fx, stages = STAGES) {
  globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {}, addListener() {} });
  globalThis.location ||= { search: '', href: 'http://x/' };
  globalThis.window ||= globalThis;
  const mem = {};
  globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  const W = await import(`${ROOT}web/src/world.js`);
  const T = tally(), KEY = 'va.world9';
  for (let k = 0; k < stages; k++) {
    const src = stageOf(fx, k, stages), now = fx.now + k * 3600e3;
    const agents = src.agents.map(a => ({ ...a, status: a.bucket === 'resting' ? 'resting' : 'working' }));
    const byId = new Map(agents.map(a => [a.id, a]));
    const before = JSON.parse(mem[KEY] || '{"blocks":{}}').blocks || {};
    for (const b of Object.values(before)) b.nest = b.chain;
    const P = W.plan(agents, byId, src.projects);
    let L;
    try { L = W.layout(P, now); } catch (e) { T.fullAt = k; T.error = String(e.message).slice(0, 80); break; }   // classic's ±120×±90 window can fill up
    const after = JSON.parse(mem[KEY]).blocks;
    for (const b of Object.values(after)) b.nest = b.chain;
    const plans = new Map(L.villages.map(v => [v.name, v.plan]));
    count(T, before, after, n => plans.get(n));
  }
  return finish(T);
}

const load = n => JSON.parse(fs.readFileSync(`${ROOT}e2e/fixtures/engine/${n}.json`, 'utf8'));
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const res = { stages: STAGES, engine: {}, classic: CLASSIC ? {} : undefined };
  for (const f of FIXTURES) {
    const fx = load(f), t0 = Date.now();
    res.engine[f] = { ...engineRate(fx), ms: Date.now() - t0 };
    if (CLASSIC) { const t1 = Date.now(); res.classic[f] = { ...(await classicRate(fx)), ms: Date.now() - t1 }; }
  }
  console.log(JSON.stringify({ [LABEL]: res }, null, 1));
  if (OUT) {
    fs.mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true });
    let all = {};
    try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
    all[LABEL] = res;
    fs.writeFileSync(OUT, JSON.stringify(all, null, 1) + '\n');
  }
}
