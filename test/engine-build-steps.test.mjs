// PERF M7 : the world build as a step generator (world/build.js buildWorldSteps, world/layout.js runLayoutSteps,
// world/scatter.js scatterWildSteps, the fantasy layout's hooks.layout.steps). Drained at once, or in slices that hand the
// thread back after every step, it builds the same world as buildWorld; and it does yield, many times, so the cold build
// can keep each main-thread task short. Pure node: no DOM, no network, no real storage or sessions.
import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const { resolveMod, modCtx } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { buildWorld, buildWorldSteps } = await import('../web/src/engine/world/build.js');
const { placeBlocks, planSettlements } = await import('../web/src/engine/world/sites.js');
const { runLayout } = await import('../web/src/engine/world/layout.js');
const { runRules } = await import('../web/src/engine/world/rules-phase.js');
const { drainSync, drainSliced } = await import('../web/src/engine/core/slices.js');
const { viewFromFixture } = await import('../web/src/engine/snapshot.js');

const SEED = 7, SALT = 's7';
const fixture = name => JSON.parse(fs.readFileSync(new URL(`../e2e/fixtures/engine/${name}.json`, import.meta.url), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));
const H = v => crypto.createHash('sha1').update(v).digest('hex');
const ser = (k, v) => (ArrayBuffer.isView(v) ? H(Buffer.from(v.buffer, v.byteOffset, v.byteLength)) : v instanceof Map ? [...v] : v instanceof Set ? [...v] : typeof v === 'function' ? undefined : v);

/** A fresh input/persisted/opts for one build of a fixture (each build mutates its own persisted). */
function setup(fxName, modId, layoutFile) {
  const fx = fixture(fxName), mod = resolveMod(modId);
  const layout = layoutFile ? fixture(layoutFile.replace(/\.json$/, '')) : null;
  const persisted = clone(layout?.persisted ?? { v: 1, seed: SEED, blocks: {}, lots: {} }), seed = layout?.seed ?? SEED;
  const view = viewFromFixture(fx, { now: fx.now });
  const { input, serverId } = toWorldInput(view, { seed, salt: layout?.salt ?? SALT, features: mod.features });
  return { input, persisted, opts: { mod, now: view.now, seed, serverId } };
}

/** A stable serialisation of everything a world is: every grid layer, the objects in order, the lint, the sig, the rest. */
function digest(world, persisted) {
  const layers = {};
  for (const [k, v] of Object.entries(world.grid)) if (ArrayBuffer.isView(v)) layers[k] = H(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  return {
    layers, grid: H(JSON.stringify(world.grid, ser)),
    objects: H(JSON.stringify([...world.objects.values()], ser)), objectCount: world.objects.size,
    lint: JSON.stringify(world.lint), sig: world.sig, version: world.version,
    rest: H(JSON.stringify({ v: world.villages, sq: world.square, pk: world.parks, ve: world.venues, b: world.bounds, f: world.focus, d: world.layoutData }, ser)),
    persisted: H(JSON.stringify(persisted)),
  };
}

const CASES = [
  ['fantasy, 1,000-agent stress, nested growth history', 'stress', 'agentville.fantasy', 'stress-nested.layout.json'],
  ['fantasy, busy, fresh layout', 'busy', 'agentville.fantasy', null],
  ['base (a layout hook with no step form), busy', 'busy', 'agentville.base', null],
];

for (const [name, fxName, modId, layoutFile] of CASES) {
  test(`buildWorldSteps drained at once = buildWorld (${name}), and it yields many times`, () => {
    const a = setup(fxName, modId, layoutFile);
    const whole = digest(buildWorld(a.input, a.persisted, a.opts), a.persisted);
    const b = setup(fxName, modId, layoutFile);
    const gen = buildWorldSteps(b.input, b.persisted, b.opts), labels = [];
    let r;
    while (!(r = gen.next()).done) labels.push(r.value);
    const world = r.value;
    assert.deepEqual(digest(world, b.persisted), whole);
    const n = world.villages.length;
    assert.ok(n >= 2, `${n} villages`);
    assert.equal(labels.filter(l => l === 'stamp').length, n, 'one yield per village stamped');
    assert.equal(labels.filter(l => l === 'lots').length, n, 'one yield per village given its owners');
    for (const l of ['rules', 'settlements', 'blocks', 'layout-hook', 'layout', 'venues', 'cover', 'cost', 'cover-final', 'anchors'])
      assert.ok(labels.includes(l), `yields after ${l}`);
    assert.ok(labels.length >= 2 * n + 10, `${labels.length} yields`);
    if (modId === 'agentville.fantasy') {
      assert.ok(labels.includes('scatter') && labels.includes('scatter-dist'), 'the scatter is its own steps');
      assert.ok(labels.indexOf('layout-hook') - labels.indexOf('blocks') > 3, 'the fantasy layout hook runs in several steps');
    }
  });
}

test('buildWorldSteps in slices (the thread handed back after every step) = buildWorld (stress, nested)', async () => {
  const a = setup('stress', 'agentville.fantasy', 'stress-nested.layout.json');
  const whole = digest(buildWorld(a.input, a.persisted, a.opts), a.persisted);
  const b = setup('stress', 'agentville.fantasy', 'stress-nested.layout.json');
  let turns = 0;
  const world = await drainSliced(buildWorldSteps(b.input, b.persisted, b.opts), { budgetMs: 0, yieldTo: () => { turns++; return new Promise(r => setImmediate(r)); } });
  assert.ok(turns > 100, `${turns} hand-backs`);
  assert.deepEqual(digest(world, b.persisted), whole);
});

test('buildWorldSteps with the rules given runs no rules step and builds the same world', () => {
  const a = setup('busy', 'agentville.fantasy', null);
  const whole = digest(buildWorld(a.input, a.persisted, a.opts), a.persisted);
  const b = setup('busy', 'agentville.fantasy', null);
  const ctxFor = k => modCtx(b.opts.mod, { seed: b.opts.seed, now: b.opts.now, projectKey: k });
  const rules = runRules(b.input, b.persisted, b.opts.mod, { ...b.opts, ctxFor });
  const gen = buildWorldSteps(b.input, b.persisted, { ...b.opts, rules }), labels = [];
  let r;
  while (!(r = gen.next()).done) labels.push(r.value);
  assert.ok(!labels.includes('rules'));
  assert.deepEqual(digest(r.value, b.persisted), whole);
});

test('hooks.layout.steps survives mod resolution and gives the same LayoutResult as hooks.layout', () => {
  const mod = resolveMod('agentville.fantasy');
  assert.equal(typeof mod.hooks.layout, 'function');
  assert.equal(typeof mod.hooks.layout.steps, 'function', 'the resolved (wrapped) hook keeps its step form');
  const { input, persisted, opts } = setup('busy', 'agentville.fantasy', null);
  persisted.lots ||= {};
  const ctxFor = k => modCtx(mod, { seed: opts.seed, now: opts.now, projectKey: k });
  const o = { now: opts.now, seed: opts.seed, serverId: opts.serverId, ctxFor };
  const { settlements } = planSettlements(input, persisted, mod, o, runRules(input, persisted, mod, o));
  const placed = placeBlocks(settlements, persisted, mod, { now: opts.now, ctxFor, seed: opts.seed });
  const viaSteps = runLayout(placed, mod, { seed: opts.seed });
  const noSteps = { ...mod, hooks: { ...mod.hooks, layout: (i, c) => mod.hooks.layout(i, c) } };   // a plain hook: one step
  assert.equal(noSteps.hooks.layout.steps, undefined);
  const plain = runLayout(placed, noSteps, { seed: opts.seed });
  const strip = s => JSON.stringify({ ...s, villages: undefined }, ser);
  assert.equal(strip(viaSteps), strip(plain));
});
