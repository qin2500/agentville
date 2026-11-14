import './support/ensure-mods-index.mjs';
// PERF (wave B): the build cache and the fast sites path must never change the world. Written from the spec
// (COMMON.md "world/cache.js (PERF)" + the wb-perf brief): a build with a cache, cold or warm, deep-equals the uncached
// build; the raster fantasy layout deep-equals the classic string-set reference (test/support); a rebuild where one
// project changes re-stamps only what changed and stays within budget. Synthetic fixtures only.
// MOD-READY P1: sites = placeBlocks + runLayout (the mod's hooks.layout, memoised) + stampLayout, as build.js wires them.
import test from 'node:test';
import assert from 'node:assert/strict';
const { createBuildCache } = await import('../web/src/engine/world/cache.js');
const { planSettlements, placeBlocks, pathsOf } = await import('../web/src/engine/world/sites.js');
const { runLayout, stampLayout } = await import('../web/src/engine/world/layout.js');
const { layout: fantasyLayout } = await import('../mods/agentville.fantasy/layout/index.js');
const { referenceLayout } = await import('./support/fantasy-layout-reference.mjs');
const { stampPlan } = await import('../web/src/engine/world/plan-adapter.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { WorldGrid } = await import('../web/src/engine/core/grid.js');
const { ObjectStore } = await import('../web/src/engine/core/objects.js');
const { resolveMod, modCtx } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, makeView } = await import('./engine-support/world-views.mjs');

const SEED = 7;
const mod = resolveMod();
const fresh = () => ({ v: 1, seed: SEED, blocks: {}, lots: {} });

/** The fixture's agents, plus helpers that change exactly one project. */
function scenario(name) {
  const fx = loadFixture(`${name}.json`);
  if (!fx) return null;
  const now = fx.now, P = fx.agents[0].project, base = fx.agents.find(a => a.project === P);
  const input = agents => toWorldInput(makeView({ ...fx, agents }, { now, demo: !!fx.demo }), { seed: SEED });
  const grow = n => [...fx.agents, ...Array.from({ length: n }, (_, i) => ({ ...base, id: `perf:extra:${i}`, name: `x${i}`, role: 'sub', parentId: null, bucket: 'building', live: true }))];
  const flip = k => fx.agents.map((a, i) => (i === k ? { ...a, bucket: a.bucket === 'building' ? 'resting' : 'building', live: a.bucket !== 'building' } : a));
  // a sequence of polls: cold, unchanged, one project grows (twice), one agent flips, back to the start
  const steps = [['cold', fx.agents], ['same', fx.agents], ['grow', grow(20)], ['grow-more', grow(40)], ['flip', flip(3)], ['back', fx.agents]];
  return { now, input, steps };
}

/** Sites + stamping, exactly as build.js wires them (placeBlocks → runLayout → stampLayout → stampPlan per village). */
function sitesAndStamp({ input, serverId }, persisted, now, { cache = null } = {}) {
  const ctxFor = k => modCtx(mod, { seed: SEED, now, projectKey: k });
  const { settlements } = planSettlements(input, persisted, mod, { now, serverId, ctxFor });
  const sites = runLayout(placeBlocks(settlements, persisted, mod, { now, ctxFor, seed: SEED, cache }), mod, { seed: SEED, cache });
  const grid = new WorldGrid(sites.bounds);
  stampLayout(grid, sites);
  const objects = new ObjectStore(), lint = [];
  for (const v of sites.villages) lint.push(...stampPlan(grid, objects, v.plan, v.origin, { mod, name: v.name, index: v.index, tier: v.tier, style: v.style, cache }).lint);
  return { sites, grid, objects, lint };
}

const LAYERS = ['terrain', 'ground', 'road', 'edges', 'cost', 'cover', 'slots', 'lot', 'occ'];
const b64 = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const tilesSnap = T => T && { ox: T.ox, oy: T.oy, w: T.w, h: T.h, terrain: b64(T.terrain), ground: b64(T.ground), road: b64(T.road), lot: b64(T.lot) };
/** A comparable snapshot: grid layers, objects with their occ numbers, lint, and every sites field. */
function snap({ sites, grid, objects, lint }) {
  const layers = Object.fromEntries(LAYERS.map(k => [k, b64(grid[k])]));
  return {
    grid: { ox: grid.ox, oy: grid.oy, w: grid.w, h: grid.h, version: grid.version, layers, edgeRef: [...grid._edgeRef] },
    objects: [...objects.entries()].map(([id, o]) => [id, objects.numOf(id), o]),
    lint,
    sites: {
      villages: sites.villages, square: sites.square, parks: sites.parks, bounds: sites.bounds, focus: sites.focus, town: sites.town,
      outside: sites.outside, venues: sites.venues, data: sites.data, lint: sites.lint, tiles: tilesSnap(sites.tiles),
    },
  };
}
const worldSnap = w => {
  const { grid, objects } = snap({ sites: {}, grid: w.grid, objects: w.objects, lint: [] });
  return { grid, objects, lint: w.lint, sig: w.sig, version: w.version, villages: w.villages, town: w.town, square: w.square, parks: w.parks, dock: w.dock, bounds: w.bounds };
};
/** The LayoutInput runLayout hands a hook, for placed blocks. */
const layoutInput = placed => ({
  settlements: placed.villages.map(v => ({ index: v.index, name: v.name, block: { x: v.block.x, y: v.block.y, w: v.block.w, h: v.block.h },
    plaza: v.plaza, cx: v.cx, cy: v.cy, accent: v.accent, plan: v.plan })),
  square: placed.square, parks: placed.parks.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h })), paths: [...pathsOf(mod)],
});
const resultSnap = r => ({ ...r, tiles: tilesSnap(r.tiles) });
// what build.js does to stamped objects afterwards (ownership, anchors): a cached replay must not be affected by it
const scribble = objects => { for (const o of objects.values()) { o.data = { item: 'x', owner: 'house' }; if (o.anchors) o.anchors.stand = [{ tx: 0, ty: 0, sub: 0, face: 0 }]; if (o.door) o.door.face = 'E'; } };

// ---- cache.js seam ------------------------------------------------------------------------------------------------------
test('createBuildCache: get/set, per-kind LRU limits, stats', () => {
  const c = createBuildCache({ limits: { stamp: 2 } });
  assert.equal(c.get('stamp|a'), undefined);
  c.set('stamp|a', 1); c.set('stamp|b', 2);
  assert.equal(c.get('stamp|a'), 1);            // a is now most recent
  c.set('stamp|c', 3);                          // evicts b
  assert.equal(c.get('stamp|b'), undefined);
  assert.equal(c.get('stamp|c'), 3);
  c.set('sites|x', { big: true });              // another kind has its own budget
  assert.deepEqual(c.get('sites|x'), { big: true });
  const s = c.stats();
  assert.equal(s.evictions, 1);
  assert.deepEqual(s.size, { stamp: 2, sites: 1 });
  assert.ok(s.hits >= 3 && s.misses >= 2);
});

test('createBuildCache: planKey covers every planner input; modKey tells mod objects apart', () => {
  const c = createBuildCache();
  const base = { mod, name: 'p', tier: 2, seed: 9, cap: 6, crowns: 1, style: { key: 's1' }, worldSeed: 7 };
  const k = c.planKey(base);
  assert.equal(c.planKey({ ...base }), k);
  for (const [f, v] of [['name', 'q'], ['tier', 3], ['seed', 10], ['cap', 7], ['crowns', 2], ['style', { key: 's2' }], ['worldSeed', 8]]) assert.notEqual(c.planKey({ ...base, [f]: v }), k, f);
  const clone = { ...mod, hooks: { ...mod.hooks } };
  assert.notEqual(c.modKey(clone), c.modKey(mod));
  assert.equal(c.modKey(mod), c.modKey(mod));
  const plan = { w: 1 };
  assert.equal(c.keyOfPlan(plan), null);
  c.notePlan(plan, k);
  assert.equal(c.keyOfPlan(plan), k);
});

// ---- identical output -----------------------------------------------------------------------------------------------------
for (const name of ['citydemo', 'busy']) {
  const sc = scenario(name);
  test(`[${name}] cold and warm cached builds deep-equal the uncached build at every poll`, { skip: !sc && `${name} fixture missing` }, () => {
    const cache = createBuildCache(), pc = fresh(), pu = fresh();
    for (const [step, agents] of sc.steps) {
      const inp = sc.input(agents);
      const cached = sitesAndStamp(inp, pc, sc.now, { cache });
      const plain = sitesAndStamp(inp, pu, sc.now);
      assert.deepEqual(snap(cached), snap(plain), `${name}/${step}`);
      assert.deepEqual(pc, pu, `${name}/${step}: persisted`);
      scribble(cached.objects);
    }
    const st = cache.stats();
    assert.ok(st.hits > 0, 'the warm polls hit the cache');
  });

  test(`[${name}] the raster fantasy layout equals the classic string-set reference, and runLayout returns it`, { skip: !sc && `${name} fixture missing` }, () => {
    const P = fresh();
    for (const [step, agents] of sc.steps.slice(0, 3)) {
      const { input, serverId } = sc.input(agents);
      const ctxFor = k => modCtx(mod, { seed: SEED, now: sc.now, projectKey: k });
      const { settlements } = planSettlements(input, P, mod, { now: sc.now, serverId, ctxFor });
      const placed = placeBlocks(settlements, P, mod, { now: sc.now, ctxFor, seed: SEED });
      const fast = fantasyLayout(layoutInput(placed));
      assert.deepEqual(resultSnap(fast), resultSnap(referenceLayout(layoutInput(placed))), `${name}/${step}`);
      const sites = runLayout(placed, mod, { seed: SEED });
      for (const k of ['bounds', 'focus', 'outside', 'venues', 'data']) assert.deepEqual(sites[k], fast[k], `${name}/${step}: ${k}`);
      assert.deepEqual(tilesSnap(sites.tiles), tilesSnap(fast.tiles));
      assert.deepEqual(sites.lint, []);
    }
  });

  test(`[${name}] buildWorld with opts.cache deep-equals buildWorld without`, { skip: !sc && `${name} fixture missing` }, () => {
    const cache = createBuildCache(), pc = fresh(), pu = fresh();
    for (const [step, agents] of sc.steps) {
      const { input, serverId } = sc.input(agents);
      const a = buildWorld(input, pc, { mod, now: sc.now, seed: SEED, serverId, cache });
      const b = buildWorld(input, pu, { mod, now: sc.now, seed: SEED, serverId });
      assert.deepEqual(worldSnap(a), worldSnap(b), `${name}/${step}`);
    }
  });
}

test('a project whose rect is already occupied is stamped fresh, not replayed', { skip: !loadFixture('citydemo.json') && 'fixture missing' }, () => {
  const sc = scenario('citydemo'), cache = createBuildCache(), per = fresh();
  const inp = sc.input(sc.steps[0][1]);
  sitesAndStamp(inp, per, sc.now, { cache });                       // records every project
  const ctxFor = k => modCtx(mod, { seed: SEED, now: sc.now, projectKey: k });
  const run = c => {
    const p = structuredClone(per);
    const { settlements } = planSettlements(inp.input, p, mod, { now: sc.now, serverId: inp.serverId, ctxFor });
    const sites = runLayout(placeBlocks(settlements, p, mod, { now: sc.now, ctxFor, seed: SEED, cache: c }), mod, { seed: SEED, cache: c });
    const grid = new WorldGrid(sites.bounds);
    stampLayout(grid, sites);
    const objects = new ObjectStore(), v = sites.villages[0];
    // a stranger already stands inside the first block
    const stranger = { id: 'stranger', kind: 'prop', model: 'x', tx: v.origin.x + 1, ty: v.origin.y + 1, w: 1, h: 1, z: 0, walk: 'block', styleKey: '', variant: 0 };
    grid.stamp(stranger, objects.add(stranger));
    const r = stampPlan(grid, objects, v.plan, v.origin, { mod, name: v.name, index: v.index, tier: v.tier, style: v.style, cache: c });
    return { sites, grid, objects, lint: r.lint };
  };
  assert.deepEqual(snap(run(cache)), snap(run(null)));
});

// ---- budget ---------------------------------------------------------------------------------------------------------------
// Owner budget: on the stress fixture (100 projects, 1113 agents) a warm rebuild where one project changes takes <= 300 ms
// for sites + stamping. The assertion allows 3x for a loaded CI box; set VA_PERF_STRICT=1 for the real budget.
test('[stress] warm rebuild with one changed project is within budget, and equals the uncached build', { skip: !loadFixture('stress.json') && 'stress fixture missing' }, t => {
  const sc = scenario('stress'), cache = createBuildCache(), pc = fresh(), pu = fresh();
  const time = fn => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };
  const [cold] = time(() => sitesAndStamp(sc.input(sc.steps[0][1]), pc, sc.now, { cache }));
  sitesAndStamp(sc.input(sc.steps[0][1]), pu, sc.now);
  const warm = [];
  for (const [step, agents] of sc.steps.slice(1)) {
    const inp = sc.input(agents);
    const [ms, cached] = time(() => sitesAndStamp(inp, pc, sc.now, { cache }));
    warm.push(ms);
    assert.deepEqual(snap(cached), snap(sitesAndStamp(inp, pu, sc.now)), `stress/${step}`);
  }
  const worst = Math.max(...warm), limit = process.env.VA_PERF_STRICT ? 300 : 900;
  t.diagnostic(`stress sites+stamp: cold ${cold.toFixed(0)} ms, warm ${warm.map(m => m.toFixed(0)).join('/')} ms`);
  assert.ok(cold < 1500 * (process.env.VA_PERF_STRICT ? 1 : 3), `cold ${cold.toFixed(0)} ms`);
  assert.ok(worst < limit, `warm one-project rebuild ${worst.toFixed(0)} ms (limit ${limit})`);
});
