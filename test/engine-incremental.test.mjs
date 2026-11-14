import './support/ensure-mods-index.mjs';
// PERF: world/cache.js createBuildCache(). Spec: a rebuild with a warm cache is identical to a cold build.
// If buildWorld ignores `cache` the tests pass by identity. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { makeView, viewFromFixture } = await import('../web/src/engine/snapshot.js');

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0), SEED = 7;
let createBuildCache = null;
try { ({ createBuildCache } = await import('../web/src/engine/world/cache.js')); } catch { /* not written yet */ }
const skip = createBuildCache ? false : 'world/cache.js not present yet';

const agent = (id, project, role, parentId, bucket = 'building', prs = []) => ({ id, name: id, project, role, parentId, bucket, severity: null, live: bucket !== 'resting', lastActivityAt: NOW - 60_000, since: NOW - 1e7, prs });
const base = () => ({
  agents: [
    agent('a-boss', 'alpha', 'boss', undefined, 'waiting'), agent('a-lead', 'alpha', 'lead', 'a-boss', 'building', [{ id: '11' }]),
    agent('a-sub', 'alpha', 'sub', 'a-lead'), agent('a-rest', 'alpha', undefined, undefined, 'resting'),
    agent('b-one', 'beta', undefined, undefined), agent('b-two', 'beta', undefined, undefined, 'resting', [{ id: '21' }]),
    agent('c-one', 'gamma', 'lead', undefined), agent('c-two', 'gamma', undefined, undefined, 'resting'),
  ],
  projects: [
    { name: 'alpha', prs: [{ id: '11', live: true }, { id: '12', live: false }], transcriptBytes: 2e6, agentsEver: 8 },
    { name: 'beta', prs: [{ id: '21', live: false }], transcriptBytes: 1e5, agentsEver: 3 },
    { name: 'gamma', prs: [], transcriptBytes: 5e4, agentsEver: 2 },
  ],
});
const clone = x => JSON.parse(JSON.stringify(x));
const inputOf = raw => { const view = makeView({ ...clone(raw), dock: { loading: [], sailed: [], total: 1, level: 1 } }, { now: NOW, demo: true }); const r = toWorldInput(view, { seed: SEED, salt: 'inc' }); return r; };

const LAYERS = ['ground', 'road', 'occ', 'cost', 'cover'];
function snap(w) {
  const g = w.grid, layers = {};
  for (const L of LAYERS) {
    const a = [];
    for (let y = g.oy; y < g.oy + g.h; y++) for (let x = g.ox; x < g.ox + g.w; x++) a.push(g.get(L, x, y));
    layers[L] = a.join(',');
  }
  const objs = [...w.objects.values()].map(o => o).sort((a, b) => (a.id < b.id ? -1 : 1));
  return { sig: w.sig, bounds: g.w + 'x' + g.h + '@' + g.ox + ',' + g.oy, layers, ids: objs.map(o => o.id), objs: JSON.parse(JSON.stringify(objs)), lint: JSON.parse(JSON.stringify(w.lint)) };
}

/** Build step 0 with a warm cache, then step 1 both warm and cold from identical persisted state; compare. */
function scenario(raw0, raw1, mod = resolveMod('agentville.fantasy')) {
  const cache = createBuildCache();
  const i0 = inputOf(raw0), i1 = inputOf(raw1);
  const p0 = { v: 1, seed: SEED, blocks: {}, lots: {} };
  buildWorld(i0.input, p0, { mod, now: NOW, seed: SEED, serverId: i0.serverId, cache });
  const p1warm = clone(p0), p1cold = clone(p0);
  const warm = buildWorld(i1.input, p1warm, { mod, now: NOW, seed: SEED, serverId: i1.serverId, cache });
  const cold = buildWorld(i1.input, p1cold, { mod, now: NOW, seed: SEED, serverId: i1.serverId, cache: createBuildCache() });
  const uncached = buildWorld(i1.input, clone(p0), { mod, now: NOW, seed: SEED, serverId: i1.serverId });
  return { warm, cold, uncached, p1warm, p1cold };
}
function same(r) {
  const c = snap(r.cold);
  assert.deepEqual(snap(r.warm), c);
  assert.deepEqual(snap(r.uncached), c);
  assert.deepEqual(r.p1warm, r.p1cold, 'persisted layout identical');
}

test('(a) nothing changed: warm rebuild equals cold build', { skip }, () => {
  const raw = base();
  same(scenario(raw, clone(raw)));
});

test('(a2) rebuilding twice in a row with the same warm cache is stable', { skip }, () => {
  const raw = base(), cache = createBuildCache(), mod = resolveMod('agentville.fantasy'), i = inputOf(raw);
  const run = () => snap(buildWorld(i.input, { v: 1, seed: SEED, blocks: {}, lots: {} }, { mod, now: NOW, seed: SEED, serverId: i.serverId, cache }));
  assert.deepEqual(run(), run());
});

test('(b) one agent added to one project', { skip }, () => {
  const raw = base(), next = clone(raw);
  next.agents.push(agent('b-three', 'beta', undefined, undefined));
  next.projects[1].agentsEver += 1;
  const r = scenario(raw, next);
  same(r);
  assert.notDeepEqual(snap(r.warm).objs, snap(scenario(raw, clone(raw)).warm).objs, 'sanity: the change is visible or at least built');
});

test('(c) one project removed', { skip }, () => {
  const raw = base(), next = clone(raw);
  next.agents = next.agents.filter(a => a.project !== 'beta');
  next.projects = next.projects.filter(p => p.name !== 'beta');
  const r = scenario(raw, next);
  same(r);
  assert.ok(![...r.warm.objects.values()].some(o => o.project === 'beta' && o.kind === 'building' && o.data?.item), 'no beta homes left');
});

test('(d) a PR merged', { skip }, () => {
  const raw = base(), next = clone(raw);
  next.agents.find(a => a.id === 'a-lead').prs = [];
  next.projects[0].prs = next.projects[0].prs.map(p => (p.id === '11' ? { ...p, live: false } : p));
  same(scenario(raw, next));
});

test('different mod with a shared cache never leaks results across mods', { skip }, () => {
  const cache = createBuildCache(), i = inputOf(base());
  const run = (id, c) => snap(buildWorld(i.input, { v: 1, seed: SEED, blocks: {}, lots: {} }, { mod: resolveMod(id), now: NOW, seed: SEED, serverId: i.serverId, cache: c }));
  run('agentville.fantasy', cache);
  assert.deepEqual(run('agentville.base', cache), run('agentville.base', createBuildCache()));
});

test('soft timing: warm vs cold on busy.json (no assertion)', { skip }, () => {
  const fx = JSON.parse(fs.readFileSync(new URL('../e2e/fixtures/engine/busy.json', import.meta.url), 'utf8'));
  const view = viewFromFixture(fx), { input, serverId } = toWorldInput(view, { seed: SEED, salt: 'inc' });
  const mod = resolveMod('agentville.fantasy'), cache = createBuildCache();
  const go = c => { const t = performance.now(); const w = buildWorld(input, { v: 1, seed: SEED, blocks: {}, lots: {} }, { mod, now: fx.now, seed: SEED, serverId, cache: c }); return { ms: performance.now() - t, w }; };
  const cold = go(createBuildCache()), prime = go(cache), warm = go(cache);
  console.log(`[perf] busy.json cold ${cold.ms.toFixed(1)}ms, first-with-cache ${prime.ms.toFixed(1)}ms, warm ${warm.ms.toFixed(1)}ms, stats ${JSON.stringify(cache.stats?.())}`);
  assert.deepEqual(snap(warm.w), snap(cold.w), 'busy: warm equals cold');
});
