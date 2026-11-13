import './support/ensure-mods-index.mjs';
// NAVPERF (engine v2 wave B): nav speed work must not change a single node, edge or path. Written from the spec
// (docs/village-engine-v2.md §2.2 + §2.5 budgets, COMMON.md nav seams):
//   1. golden digests: road graphs and nav.path results on harbour.json and stress.json, and graphs + grid A* on
//      seeded synthetic grids (2x2 blobs, loops, blocked edges, occupied tiles, separate islands for bridges, a costFn),
//      equal the digests the pre-NAVPERF implementation produced (base 25749ba) for the same inputs. The two nav.path
//      digests were re-pinned once, for the nav owner's capped-end-leg rule (see the last test): pairs whose end leg
//      runs out of nodes now get null instead of the 20000-node grid fallback; every other path is unchanged;
//   2. budgets on the stress fixture (100 projects): road graph build <= 15 ms warm median, nav.path <= 0.3 ms average
//      and <= 2 ms p99, asserted only with VA_PERF=1; without it only 10x sanity bounds run. Numbers go to diagnostics.
// Synthetic data only. Run: node --test test/engine-navperf.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { WorldGrid, ROAD } = await import('../web/src/engine/core/grid.js');
const { buildRoadGraph } = await import('../web/src/engine/nav/roadgraph.js');
const { astar } = await import('../web/src/engine/nav/astar.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

const SEED = 7;
const GRAPH_BUDGET_MS = 15, PATH_BUDGET_MS = 0.3, PATH_P99_MS = 2;

// Digests produced by the implementation at 25749ba (before NAVPERF) with exactly the procedures below.
const GOLDEN = {
  harbour: { graph: '049d66927bc75ff727b8e444a61012d3a959a376', paths: '7db5ffe100746e8aae5b6930571cb2c143cf3b42' },
  stress: { graph: 'ff23b7bb87b2ff40d41f2f703ad3138dc64e549e', paths: '777b3ae2cdee18df3fc3b81e53196fee9ebca143' },
  synthetic: { graphs: '2158d3ed1ca6ea93804dffa5b67c081dd042861c', astar: 'e20f5782ca8d7fceda8f3b163ea40581d8c5b790' },
};

const sha = () => createHash('sha1');
const graphDigest = G => sha().update(JSON.stringify({ n: G.nodes, e: G.edges.map(e => ({ ...e, poly: [...e.poly] })), u: G.unreached })).digest('hex');
const feed = (h, p) => h.update(p ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : Buffer.from('null'));
const lcg = s => () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);

const worlds = new Map();
function worldOf(name) {
  if (worlds.has(name)) return worlds.get(name);
  const fx = loadFixture(`${name}.json`);
  const w = fx && (() => {
    const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: SEED, salt: 'navperf' });
    return buildWorld(input, { v: 1, seed: SEED, blocks: {}, lots: {} }, { serverId, mod: resolveMod('agentville.fantasy'), now: fx.now, seed: SEED });
  })();
  worlds.set(name, w);
  return w;
}

/** n seeded random walkable (from, to) pairs on a world's grid. */
function pairsOf(world, n, seed = 99) {
  const g = world.grid, open = [];
  for (let i = 0; i < g.w * g.h; i++) if (g.cost[i] !== 255 && g.occ[i] === 0) open.push(i);
  const rnd = lcg(seed), at = i => ({ x: (i % g.w) + g.ox, y: Math.floor(i / g.w) + g.oy });
  return Array.from({ length: n }, () => [at(open[Math.floor(rnd() * open.length)]), at(open[Math.floor(rnd() * open.length)])]);
}

/** Every nav.path variant on the pairs: default, no lanes, roads only; a fresh nav, so route caches start empty. */
function pathDigest(world, pairs) {
  const nav = createNav(world), h = sha();
  for (const [a, b] of pairs) feed(h, nav.path(a, b));
  for (const [a, b] of pairs.slice(0, 200)) feed(h, nav.path(a, b, { lanes: false }));
  for (const [a, b] of pairs.slice(0, 200)) feed(h, nav.path(a, b, { roadsOnly: true }));
  return h.digest('hex');
}

/** Seeded synthetic road grids that hit the awkward cases: plazas (thick blobs), 2x2 blobs that thin to nothing, loops,
 *  islands a few tiles apart (bridges), occupied tiles and blocked edges on and next to the roads, doors. */
function syntheticWorld(seed) {
  const rnd = lcg(seed), W = 40 + Math.floor(rnd() * 30), H = 30 + Math.floor(rnd() * 30);
  const g = new WorldGrid({ ox: -5 + Math.floor(rnd() * 10), oy: -5 + Math.floor(rnd() * 10), w: W, h: H });
  const R = (x0, y0, w, h, cls) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g.set('road', g.ox + x, g.oy + y, cls); };
  const cls = () => 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < 6; k++) { const y = Math.floor(rnd() * (H - 3)); R(1 + Math.floor(rnd() * 5), y, W - 8, 1 + Math.floor(rnd() * 3), cls()); }
  for (let k = 0; k < 5; k++) { const x = Math.floor(rnd() * (W - 3)); R(x, 1 + Math.floor(rnd() * 5), 1 + Math.floor(rnd() * 3), H - 8, cls()); }
  R(Math.floor(W / 3), Math.floor(H / 3), 7, 6, ROAD.MAIN);                                   // a plaza
  for (let k = 0; k < 3; k++) R(Math.floor(rnd() * (W - 2)), Math.floor(rnd() * (H - 2)), 2, 2, ROAD.PATH);   // blobs
  R(W - 6, H - 6, 4, 1, ROAD.LANE); R(W - 6, H - 3, 4, 1, ROAD.LANE);                          // two islands, a gap of 2
  R(2, H - 5, 5, 1, ROAD.LANE); R(2, H - 3, 5, 1, ROAD.LANE); R(2, H - 5, 1, 3, ROAD.LANE); R(6, H - 5, 1, 3, ROAD.LANE);   // a loop
  for (let i = 0; i < g.w * g.h; i++) g.cost[i] = 1 + Math.floor(rnd() * 3);
  for (let k = 0; k < (W * H) / 40; k++) g.set('occ', g.ox + Math.floor(rnd() * W), g.oy + Math.floor(rnd() * H), 1 + k);
  for (let k = 0; k < (W * H) / 30; k++) g.set('edges', g.ox + Math.floor(rnd() * W), g.oy + Math.floor(rnd() * H), 1 << Math.floor(rnd() * 4));
  for (let k = 0; k < 12; k++) { const x = g.ox + Math.floor(rnd() * W), y = g.oy + Math.floor(rnd() * H); g.cost[(y - g.oy) * W + (x - g.ox)] = 255; }
  const objects = new Map();
  for (let k = 0; k < 14; k++) {
    const id = `b${String(k).padStart(2, '0')}`;
    objects.set(id, { id, kind: 'building', door: { tx: g.ox + Math.floor(rnd() * W), ty: g.oy + Math.floor(rnd() * H) } });
  }
  return { grid: g, objects, square: { x: g.ox + Math.floor(W / 3), y: g.oy + Math.floor(H / 3), w: 7, h: 6 } };
}

function syntheticDigests() {
  const hg = sha(), ha = sha();
  for (let s = 1; s <= 24; s++) {
    const w = syntheticWorld(s), g = w.grid;
    hg.update(graphDigest(buildRoadGraph(w)));
    const rnd = lcg(1000 + s), pt = () => ({ x: g.ox + rnd() * g.w, y: g.oy + rnd() * g.h });
    const costFn = (x, y, b) => ((x * 7 + y * 3) % 5 === 0 ? b * 4 : (x + y) % 13 === 0 ? 255 : b);
    for (let k = 0; k < 60; k++) {
      const a = pt(), b = pt();
      feed(ha, astar(g, a, b));
      feed(ha, astar(g, a, b, { maxNodes: 150 }));
      feed(ha, astar(g, a, b, { costFn }));
    }
  }
  return { graphs: hg.digest('hex'), astar: ha.digest('hex') };
}

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const ms = x => `${x.toFixed(2)} ms`;

test('synthetic grids: road graphs and grid A* are unchanged', () => {
  const d = syntheticDigests();
  assert.equal(d.graphs, GOLDEN.synthetic.graphs, 'road graphs on synthetic grids');
  assert.equal(d.astar, GOLDEN.synthetic.astar, 'grid A* on synthetic grids (plain, capped, costFn)');
});

for (const name of ['harbour', 'stress']) {
  test(`[${name}] road graph and nav.path results are unchanged`, { skip: !loadFixture(`${name}.json`) && `${name} fixture missing`, timeout: 300_000 }, () => {
    const w = worldOf(name);
    assert.equal(graphDigest(buildRoadGraph(w)), GOLDEN[name].graph, 'road graph');
    assert.equal(pathDigest(w, pairsOf(w, name === 'stress' ? 1000 : 1500)), GOLDEN[name].paths, 'nav.path results');
  });
}

// Budget runs. Real budgets are asserted only with VA_PERF=1 (a quiet machine); otherwise only loose sanity bounds
// (10x the budget) run, so a loaded box (a headless capture, other agents) cannot fail the suite. Diagnostics always.
const STRICT = process.env.VA_PERF === '1';
const strictSkip = !STRICT && 'timing budgets are asserted only with VA_PERF=1 (machine load makes them flaky)';
const SANITY = 10;
const noStress = !loadFixture('stress.json') && 'stress fixture missing';

function graphTimes(t) {
  const w = worldOf('stress'), times = [];
  for (let k = 0; k < 12; k++) { const t0 = performance.now(); buildRoadGraph(w); times.push(performance.now() - t0); }
  const warm = times.slice(1), r = { first: times[0], med: pct(warm, 0.5), p95: pct(warm, 0.95) };
  t.diagnostic(`stress buildRoadGraph ${w.grid.w}x${w.grid.h}: first ${ms(r.first)}, warm median ${ms(r.med)}, p95 ${ms(r.p95)} (budget ${GRAPH_BUDGET_MS} ms)`);
  return r;
}
function pathTimes(t) {
  const w = worldOf('stress'), nav = createNav(w);
  for (const [a, b] of pairsOf(w, 300, 7)) nav.path(a, b);   // warm-up: graph build + JIT, on other pairs
  const times = [];
  for (const [a, b] of pairsOf(w, 2000, 99)) { const t0 = performance.now(); nav.path(a, b); times.push(performance.now() - t0); }
  const r = { avg: times.reduce((s, x) => s + x, 0) / times.length, med: pct(times, 0.5), p95: pct(times, 0.95), p99: pct(times, 0.99) };
  t.diagnostic(`stress nav.path x${times.length}: avg ${ms(r.avg)}, median ${ms(r.med)}, p95 ${ms(r.p95)}, p99 ${ms(r.p99)} (budget ${PATH_BUDGET_MS} ms avg, ${PATH_P99_MS} ms p99)`);
  return r;
}

test('[stress] road graph build: sanity bound (10x budget, warm median)', { skip: noStress, timeout: 300_000 }, t => {
  const r = graphTimes(t);
  assert.ok(r.med < GRAPH_BUDGET_MS * SANITY, `warm median ${r.med} ms`);
});
test('[stress] nav.path: sanity bound (10x budget, average)', { skip: noStress, timeout: 300_000 }, t => {
  const r = pathTimes(t);
  assert.ok(r.avg < PATH_BUDGET_MS * SANITY, `avg ${r.avg} ms`);
});
test('[stress] VA_PERF: road graph build within 15 ms (warm median)', { skip: noStress || strictSkip, timeout: 300_000 }, t => {
  const r = graphTimes(t);
  assert.ok(r.med <= GRAPH_BUDGET_MS, `warm median ${r.med} ms`);
});
test('[stress] VA_PERF: nav.path within 0.3 ms average and 2 ms p99', { skip: noStress || strictSkip, timeout: 300_000 }, t => {
  const r = pathTimes(t);
  assert.ok(r.avg <= PATH_BUDGET_MS, `avg ${r.avg} ms`);
  assert.ok(r.p99 <= PATH_P99_MS, `p99 ${r.p99} ms`);
});

// Capped end legs (nav owner's rule, 2026-11-13): when every bounded leg on one side runs out of nodes, path() returns
// null without the 20000-node grid fallback, remembers the failure per end tile and grid stamp, and forgets it on
// invalidate(). Fake N1/N2 (the shape test/engine-navindex-impl.test.mjs uses), so this is about index.js alone.
test('capped end leg: null without the grid fallback, cached, cleared by invalidate()', () => {
  const calls = [];
  const astar = (g, a, b, o = {}) => {
    calls.push(o.maxNodes ?? 'full');
    if (o.maxNodes && b.x === 100 && b.y === 0) return null;   // every leg into (100, 0) runs out of nodes
    return Float32Array.from([Math.floor(a.x) + 0.5, Math.floor(a.y) + 0.5, Math.floor(b.x) + 0.5, Math.floor(b.y) + 0.5]);
  };
  const nodes = [{ x: 10, y: 0 }, { x: 60, y: 0 }, { x: 95, y: 0 }];
  const buildRoadGraph = () => ({ nodes, edges: [], nearestNode: x => (x < 30 ? 0 : x < 80 ? 1 : 2), route: (a, b) => (a <= b ? [a, b] : [b, a]).sort(() => 0) });
  const world = { grid: { version: 1 }, objects: new Map() };
  const nav = createNav(world, { astar, buildRoadGraph, flowField: () => null, createSlots: () => ({}) });
  assert.equal(nav.path({ x: 0, y: 0 }, { x: 100, y: 0 }), null);
  assert.ok(calls.length >= 2 && !calls.includes('full'), `legs only, no full-grid fallback: ${calls}`);
  calls.length = 0;
  assert.equal(nav.path({ x: 2, y: 0 }, { x: 100, y: 0 }), null);
  assert.deepEqual(calls, [], 'the capped end tile is remembered: no search at all');
  assert.ok(nav.path({ x: 0, y: 0 }, { x: 99, y: 0 }) instanceof Float32Array, 'other end tiles are unaffected');
  nav.invalidate(); calls.length = 0;
  assert.equal(nav.path({ x: 0, y: 0 }, { x: 100, y: 0 }), null);
  assert.ok(calls.length >= 2, 'invalidate() forgets the failure: the legs run again');
  world.grid.version++; calls.length = 0;
  nav.path({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.ok(calls.length >= 2, 'a new grid version forgets the failure too');
});
