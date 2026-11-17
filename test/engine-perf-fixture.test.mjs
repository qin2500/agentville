import './support/ensure-mods-index.mjs';
// M7 P3: the nested-growth stress layout the perf harness loads (tools/engine/make-nested-history.mjs ->
// e2e/fixtures/engine/stress-nested.layout.json). It must be current (regenerating gives the same layout), every city
// must have grown 0 > 1 > 2 > 3, and the page's first load from it must re-plan nothing. Pure, node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const { makeHistory, slice, FRACTIONS, SEED, SALT } = await import('../tools/engine/make-nested-history.mjs');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { viewFromFixture } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');

const read = rel => JSON.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
const fx = read('../e2e/fixtures/engine/stress.json');
const saved = read('../e2e/fixtures/engine/stress-nested.layout.json');
const hist = makeHistory(fx);

test('the committed layout is what the generator makes now', () => {
  assert.equal(saved.v, 1); assert.equal(saved.fixture, 'stress'); assert.equal(saved.seed, SEED); assert.equal(saved.salt, SALT);
  assert.equal(saved.steps, FRACTIONS.length);
  assert.deepEqual(saved.persisted, JSON.parse(JSON.stringify(hist.persisted)), 'regenerate: node tools/engine/make-nested-history.mjs');
});

test('every city grew one tier per step, and most towns carry a nested chain', () => {
  const cities = hist.projects.filter(p => p.tier === 3);
  assert.ok(cities.length >= 10, `cities: ${cities.length}`);
  for (const c of cities) {
    assert.deepEqual(c.tiers, [0, 1, 2, 3], c.name);
    assert.equal(c.chainDepth, 4, `${c.name}: ${c.nest}`);
  }
  assert.ok(hist.projects.filter(p => p.chainDepth >= 3).length >= 25);
  // the final step is the full fixture: same tiers as a fresh build of it
  const fresh = makeHistory(fx, { fractions: [1] });
  assert.deepEqual(hist.projects.map(p => [p.name, p.tier]), fresh.projects.map(p => [p.name, p.tier]));
});

test('slices are prefixes: boss kept, PR and agent counts grow with f', () => {
  const a = slice(fx, 0.06, 0), b = slice(fx, 0.2, 0);
  assert.equal(a.agents.filter(x => x.role === 'boss').length, fx.agents.filter(x => x.role === 'boss').length);
  assert.ok(a.agents.every(x => b.agents.some(y => y.id === x.id)));
  for (const [i, p] of a.projects.entries()) assert.ok(p.prs.length <= b.projects[i].prs.length && p.agentsEver <= b.projects[i].agentsEver);
  assert.equal(slice(fx, 1, 0).agents.length, fx.agents.length);
});

test('loading the saved layout at the fixture time re-plans nothing', () => {
  const persisted = JSON.parse(JSON.stringify(saved.persisted));
  const { input, serverId } = toWorldInput(viewFromFixture(fx, { now: fx.now }), { seed: SEED, salt: SALT, features: fantasy.features });
  buildWorld(input, persisted, { mod: fantasy, now: fx.now, seed: SEED, serverId });
  assert.deepEqual(persisted.blocks, saved.persisted.blocks);
  for (const k of Object.keys(saved.persisted.lots)) assert.deepEqual(persisted.lots[k].a, saved.persisted.lots[k].a, k);
});
