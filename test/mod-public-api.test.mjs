import './support/ensure-mods-index.mjs';
// The public mod API (web/src/engine/mod/public.js, imported as `#agentville/mod`): the documented names, the
// FEATURES list and ctx.api.has. The kit's behaviour is tested by its pieces (layout, terrain classes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pub from '#agentville/mod';
const byPath = await import('../web/src/engine/mod/public.js');
const { API_VERSION, MOD_CODE_MAX, FEATURES, MOD0_HOOKS, MOD1_HOOKS } = await import('../web/src/engine/mod/api.js');
const { hash } = await import('../web/src/engine/core/rng.js');
const GRID = await import('../web/src/engine/core/grid.js');
const { ROAD, LAYOUT_GROUND, LOT } = await import('../web/src/engine/core/grid.js');
const { resolveMod, modCtx } = await import('../web/src/engine/mod/registry.js');

const NAMES = [
  'API_VERSION', 'MOD_CODE_MAX', 'FEATURES', 'MOD1_HOOKS',
  'hash',
  'ROAD', 'LAYOUT_GROUND', 'LOT',
  'createRaster', 'routeOnRaster', 'noise', 'flood4', 'distance4', 'rectsBounds', 'near', 'inRect',
  'checkClasses', 'classByName',
];

test('#agentville/mod resolves to public.js and exports exactly the documented names', () => {
  assert.equal(pub.API_VERSION, byPath.API_VERSION);
  assert.deepEqual(Object.keys(pub).sort(), [...NAMES].sort());
  assert.deepEqual(Object.keys(byPath).sort(), [...NAMES].sort());
});

test('public.js is a barrel of export-from lines only', () => {
  const src = fs.readFileSync(new URL('../web/src/engine/mod/public.js', import.meta.url), 'utf8');
  for (const line of src.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')))
    assert.match(line, /^export \{[^}]+\} from '\.{1,2}\/[^']+\.js';$/, line);
});

test('the core names are the engine values themselves', () => {
  assert.equal(pub.API_VERSION, API_VERSION); assert.equal(pub.API_VERSION, 1);
  assert.equal(pub.MOD_CODE_MAX, MOD_CODE_MAX);
  assert.equal(pub.FEATURES, FEATURES);
  assert.equal(pub.MOD1_HOOKS, MOD1_HOOKS);
  assert.equal(pub.hash, hash);
  assert.equal(pub.ROAD, ROAD);
  assert.equal(typeof pub.noise, 'function');
});

test('LAYOUT_GROUND and LOT keep the codes every saved world and golden uses; the fantasy-named aliases are gone (C1)', () => {
  assert.deepEqual({ ...LAYOUT_GROUND }, { EDGE: 200, VENUE: 201, HUB: 202, ROUTE: 203 });
  assert.deepEqual({ ...LOT }, { WILD: -1, HUB: -2, VENUE: -3 });
  assert.ok(Object.isFrozen(LAYOUT_GROUND) && Object.isFrozen(LOT));
  for (const gone of ['TERRAIN', 'GROUND_EXT', 'LOT_WILD', 'LOT_SQUARE', 'LOT_DOCK']) assert.equal(GRID[gone], undefined, gone);
});

test('FEATURES lists the MOD-READY capabilities; MOD1_HOOKS extends MOD0_HOOKS', () => {
  assert.deepEqual([...FEATURES], ['layout', 'terrain.classes', 'scatter.at', 'represent.pr', 'represent.project', 'venues', 'persist']);
  assert.ok(Object.isFrozen(FEATURES));
  assert.deepEqual(MOD1_HOOKS, [...MOD0_HOOKS, 'layout', 'scatter']);
});

test('ctx.api.has(feature) is FEATURES.includes(feature)', () => {
  for (const id of ['agentville.fantasy', 'agentville.base']) {
    const ctx = modCtx(resolveMod(id), { seed: 1, projectKey: 'p' });
    assert.equal(ctx.api.version, API_VERSION);
    for (const f of FEATURES) assert.equal(ctx.api.has(f), true, f);
    for (const f of ['', 'sandbox', 'LAYOUT', 'layout ', undefined, null, 1]) assert.equal(ctx.api.has(f), false, String(f));
  }
});

test('registry: persist is top-only, venues is merged data, no classicImport flag (C1)', () => {
  const f = resolveMod('agentville.fantasy'), b = resolveMod('agentville.base');
  assert.deepEqual(f.persist.import, ['va.world9', 'va.world8']);
  assert.equal(f.persist.key, 'va.engine2.world');
  assert.equal(b.persist, null);
  assert.equal('classicImport' in f, false); assert.equal('classicImport' in b, false);
  assert.deepEqual([...f.lint], []); assert.deepEqual([...b.lint], []);
  assert.deepEqual(Object.keys(f.venues), ['harbour']);   // P6: the fantasy harbour venue
  assert.ok(Object.isFrozen(f.venues));
});
