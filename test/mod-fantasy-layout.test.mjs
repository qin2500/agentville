import './support/ensure-mods-index.mjs';
// MOD-READY P1 (test T1, written from the spec only): the fantasy layout, once it runs through the `layout` hook, gives the
// same world as the built-in planSites path did on the base code (branch mr-l0, 6928df1).
//
// HOW THE PINS WERE GENERATED: on the base code (before P1), run this file with VA_PIN_PRINT=1. It computes, for each
// fixture (citydemo, busy, stress), a short sha256 of (a) planSites + stampSites output (terrain/ground/road/lot/edges layers,
// bounds, dock, square, parks, village blocks) and (b) the full buildWorld result (every grid layer, bounds, dock, town, square,
// parks, village blocks), and prints the PINS table that is pasted below. No other source of truth is used.
// C1 (lead): planSites / stampSites are gone; the same output is placeBlocks + runLayout / stampLayout (which is what
// planSites was after P1), so the pins are unchanged. world.town is gone too; the pinned value is the layout's data.town.
// The deprecated-path parity test became a parity test against the classic reference (test/support/fantasy-layout-reference.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { planSettlements, placeBlocks } = await import('../web/src/engine/world/sites.js');
const { runLayout, stampLayout } = await import('../web/src/engine/world/layout.js');
const { referenceLayout } = await import('./support/fantasy-layout-reference.mjs');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { WorldGrid } = await import('../web/src/engine/core/grid.js');
const { resolveMod, modCtx } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

const SEED = 7;
const FIXTURES = ['citydemo', 'busy', 'stress'];
const fresh = () => ({ v: 1, seed: SEED, blocks: {}, lots: {} });
const mod = resolveMod();
const h = x => createHash('sha256').update(typeof x === 'string' ? x : Buffer.from(x.buffer, x.byteOffset, x.byteLength)).digest('hex').slice(0, 16);

function inputFor(name) {
  const fx = loadFixture(`${name}.json`);
  if (!fx) return null;
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: SEED, salt: String(SEED), env: { reduceMotion: false, zoom: 1 } });
  return { input, serverId, now: fx.now };
}
const villageKey = v => ({ name: v.name, index: v.index, block: v.block, plaza: v.plaza, cx: v.cx, cy: v.cy, accent: v.accent, origin: v.origin });
const geoOf = (grid, layers) => Object.fromEntries(layers.map(k => [k, h(grid[k])]));

/** placeBlocks + runLayout + stampLayout (planSites + stampSites on the base). */
function sitesPin(name) {
  const f = inputFor(name); if (!f) return null;
  const { input, serverId, now } = f, P = fresh();
  const ctxFor = k => modCtx(mod, { seed: SEED, now, projectKey: k });
  const { settlements } = planSettlements(input, P, mod, { now, serverId, ctxFor });
  const sites = runLayout(placeBlocks(settlements, P, mod, { now, ctxFor, seed: SEED }), mod, { seed: SEED });
  const grid = new WorldGrid(sites.bounds);
  stampLayout(grid, sites);
  return h(JSON.stringify({
    bounds: sites.bounds, dock: sites.data?.dock ?? null, square: sites.square, parks: sites.parks,
    villages: sites.villages.map(villageKey),
    layers: geoOf(grid, ['terrain', 'ground', 'road', 'lot', 'edges']),
  }));
}
/** buildWorld on a fresh persisted state. */
function worldPin(name, m = mod) {
  const f = inputFor(name); if (!f) return null;
  const { input, serverId, now } = f;
  const w = buildWorld(input, fresh(), { mod: m, now, seed: SEED, serverId });
  const layers = Object.keys(w.grid).filter(k => ArrayBuffer.isView(w.grid[k])).sort();
  return h(JSON.stringify({
    bounds: w.bounds, dock: w.layoutData?.dock, town: w.layoutData?.town, square: w.square, parks: w.parks, villages: w.villages.map(villageKey),
    layers: geoOf(w.grid, layers),
  }));
}

// Generated on the base code with VA_PIN_PRINT=1 (see the header). Do not edit by hand.
// M5 P1 re-pinned the `world` pins with VA_PIN_PRINT=1 (the harbour plan stamps pier and quay decks: ground/road/occ/cost
// in the cove change); every `sites` pin, i.e. the layout itself, is unchanged. M5 integration re-pinned busy and stress
// `world` again: the harbour follows the fixtures' dock (lifetime total and level), so its cove holds more; `sites` unchanged. Re-pinned after merging M4 (central square venue: tree + 4 lanterns): `world` only.
// Re-pinned (M6 nested growth): every block now persists `nest` (its plan's chain, so the next re-plan nests
// it); the hashed village blocks carry that field. With `nest` left out the old pins still match (geometry unchanged).
// Re-pinned (M7 dress): the countryside scatter (meadow, bloom-meadow, footpath terrain; copses) changes the terrain
// and wild-object layers of `world`; every `sites` pin (the layout itself) is unchanged.
// Re-pinned (city-compact, 2026-11-17): every block now persists `fit: 1` (world/fit.js, the size-to-fit mark); the hashed
// village blocks carry that field. A fresh town is already compact: with rules.compact false (no mark) the old pins
// (citydemo 71b762831e8e16f5/cb43c46b2ebea63c, busy c56459900054e3cf/bc6f64602ca96b7c, stress 8d25ba0e1687ea1b/2f065193add09327)
// still match exactly, so no geometry changed.
const PINS = {
  citydemo: { sites: '5d0863b0216852f2', world: '940b2e9e9d153265' },
  busy: { sites: '55ec95a830b58df8', world: '6c3641424dc192fd' },
  stress: { sites: 'da1995706bd99b7b', world: 'e4509b07dde333d7' },
};

if (process.env.VA_PIN_PRINT) {
  const out = {};
  for (const n of FIXTURES) out[n] = { sites: sitesPin(n), world: worldPin(n) };
  console.log('PINS_JSON ' + JSON.stringify(out));
}

for (const name of FIXTURES) {
  test(`fantasy layout ${name}: placeBlocks + runLayout + stampLayout equals the pinned base output`, t => {
    if (!inputFor(name)) return t.skip(`fixture ${name} missing`);
    assert.equal(sitesPin(name), PINS[name]?.sites);
  });
  test(`fantasy layout ${name}: buildWorld equals the pinned base world (whichever path builds it)`, t => {
    if (!inputFor(name)) return t.skip(`fixture ${name} missing`);
    assert.equal(worldPin(name), PINS[name]?.world);
  });
}

test('fantasy layout: the hook equals the classic string-set reference on every fixture', t => {
  if (typeof mod.hooks?.layout !== 'function') return t.skip('needs P1: fantasy hooks.layout not defined yet');
  const snapTiles = T => ({ ...T, terrain: h(T.terrain), ground: h(T.ground), road: h(T.road), lot: h(T.lot) });
  for (const name of FIXTURES) {
    const f = inputFor(name); if (!f) continue;
    const P = fresh(), ctxFor = k => modCtx(mod, { seed: SEED, now: f.now, projectKey: k });
    const { settlements } = planSettlements(f.input, P, mod, { now: f.now, serverId: f.serverId, ctxFor });
    const placed = placeBlocks(settlements, P, mod, { now: f.now, ctxFor, seed: SEED });
    const sites = runLayout(placed, mod, { seed: SEED });
    const input = {
      settlements: placed.villages.map(v => ({ index: v.index, name: v.name, block: v.block, plaza: v.plaza, cx: v.cx, cy: v.cy, accent: v.accent, plan: v.plan })),
      square: placed.square, parks: placed.parks, paths: [...mod.rules.layout.paths],
    };
    const ref = referenceLayout(input);
    for (const k of ['bounds', 'focus', 'outside']) assert.deepEqual(sites[k], ref[k], `${name}: ${k}`);
    assert.deepEqual(JSON.parse(JSON.stringify(sites.venues)), JSON.parse(JSON.stringify(ref.venues)), `${name}: venues`);
    assert.deepEqual(sites.data.dock, ref.data.dock, `${name}: data.dock`);
    assert.deepEqual(sites.data.town, ref.data.town, `${name}: data.town`);
    assert.deepEqual(snapTiles(sites.tiles), snapTiles(ref.tiles), `${name}: tiles`);
  }
});

test('fantasy layout: hook result is deterministic and structured-clonable (needs P1)', async t => {
  if (typeof mod.hooks?.layout !== 'function') return t.skip('needs P1: fantasy hooks.layout not defined yet');
  const { buildWorld: bw } = await import('../web/src/engine/world/build.js');
  const f = inputFor('citydemo');
  const a = bw(f.input, fresh(), { mod, now: f.now, seed: SEED, serverId: f.serverId });
  const b = bw(f.input, fresh(), { mod, now: f.now, seed: SEED, serverId: f.serverId });
  assert.equal(h(JSON.stringify(a.layoutData?.dock)), h(JSON.stringify(b.layoutData?.dock)));
  assert.deepEqual(a.bounds, b.bounds);
  assert.doesNotThrow(() => structuredClone(a.layoutData));
});
