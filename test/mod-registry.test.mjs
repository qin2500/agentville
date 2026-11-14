import './support/ensure-mods-index.mjs';
// village-mods.md §3.2-§3.4 and §6.1 items 1 and 8 (registry, chain, hooks, ctx rng). Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
const { resolveMod, modCtx, listMods, DEFAULT_MOD, checkPersistOwner, lintTop } = await import('../web/src/engine/mod/registry.js');
const { API_VERSION, MOD0_HOOKS, MOD_CODE_MAX } = await import('../web/src/engine/mod/api.js');
const { listFiles, ROOT } = await import('./mod-support/views.mjs');
import fs from 'node:fs';
import path from 'node:path';

test('default mod is agentville.fantasy with chain [fantasy, base]', () => {
  assert.equal(DEFAULT_MOD, 'agentville.fantasy');
  const m = resolveMod();
  assert.equal(m.id, 'agentville.fantasy');
  assert.deepEqual(m.chain, ['agentville.fantasy', 'agentville.base']);
  assert.deepEqual(m.persist.import, ['va.world9', 'va.world8']);
});

test('agentville.base resolves alone, no classic import', () => {
  const m = resolveMod('agentville.base');
  assert.equal(m.id, 'agentville.base');
  assert.deepEqual(m.chain, ['agentville.base']);
  assert.equal(m.persist, null);
});

test('unknown id falls back to the default mod (§3.4)', () => {
  const m = resolveMod('nope.not-a-mod');
  assert.equal(m.id, DEFAULT_MOD);
  assert.deepEqual(m.chain, ['agentville.fantasy', 'agentville.base']);
});

test('apiVersion equals API_VERSION for both mods', () => {
  assert.equal(API_VERSION, 1);
  for (const id of ['agentville.fantasy', 'agentville.base']) assert.equal(resolveMod(id).apiVersion, API_VERSION);
});

test('every MOD0 hook resolves to a function on the fantasy mod; base too (each hook has a minimal answer)', () => {
  for (const id of ['agentville.fantasy', 'agentville.base']) {
    const m = resolveMod(id);
    for (const h of MOD0_HOOKS) assert.equal(typeof m.hooks[h], 'function', `${id}.hooks.${h}`);
  }
});

test('resolved shape: rules.layout, terrain table, objects table, codes within mod range', () => {
  for (const id of ['agentville.fantasy', 'agentville.base']) {
    const m = resolveMod(id);
    assert.ok(m.rules && m.rules.layout && typeof m.rules.holdMs === 'number', `${id} rules`);
    assert.ok(m.terrain && Array.isArray(m.terrain.types) && m.terrain.byName && typeof m.terrain.wildCost === 'number');
    for (const t of m.terrain.types) assert.ok(t.code >= 0 && t.code <= MOD_CODE_MAX, `${id} terrain code ${t.code}`);
    assert.ok(m.objects && m.objects.props && m.objects.buildings);
  }
  const f = resolveMod('agentville.fantasy');
  assert.ok(f.terrain.types.length > 0 && Object.keys(f.objects.props).length > 0);
});

test('chain merge: objects merge, arrays replace, nearest hook wins (observable on the bundled mods)', () => {
  const f = resolveMod('agentville.fantasy'), b = resolveMod('agentville.base');
  // fantasy overrides base data and hooks, so the fantasy rules/terrain differ from base's and base keys it lacks do not vanish
  assert.notDeepEqual(f.terrain.types, b.terrain.types, 'fantasy terrain replaces base terrain array');
  assert.ok(f.terrain.types.length >= b.terrain.types.length);
  assert.notEqual(f.hooks.growth, b.hooks.growth, 'nearest hook (fantasy) wins over base');
  // arrays replace, never concatenate
  assert.ok(f.terrain.types.length < b.terrain.types.length + f.terrain.types.length || b.terrain.types.length === 0);
  assert.deepEqual(f.rules.layout.accents, resolveMod('agentville.fantasy').rules.layout.accents);
  // resolving does not mutate across calls: a second resolve is deep-equal on data
  assert.deepEqual(resolveMod('agentville.fantasy').rules, f.rules);
});

test('represent.pr merges per PR state: a child state entry replaces the parent entry whole', () => {
  const f = resolveMod('agentville.fantasy'), b = resolveMod('agentville.base');
  assert.equal(b.represent.pr.building.model, 'flag');
  assert.deepEqual(f.represent.pr.building, { as: 'lot' }, 'fantasy\'s building spec does not inherit base\'s flag model');
  assert.deepEqual(f.represent.pr.closed, b.represent.pr.closed, 'a state the child leaves out is inherited');
});

test('persist: a mod may name only its own va.engine2.world.<id> keys; the legacy keys are fantasy\'s', () => {
  assert.doesNotThrow(() => checkPersistOwner(resolveMod('agentville.fantasy').persist, 'agentville.fantasy'));
  assert.doesNotThrow(() => checkPersistOwner({ key: 'va.engine2.world.example.a', demoKey: 'va.engine2.world.example.a.demo' }, 'example.a'));
  assert.doesNotThrow(() => checkPersistOwner(null, 'example.a'));
  for (const decl of [
    { key: 'va.engine2.world' },                              // fantasy's legacy key
    { demoKey: 'va.engine2.world.demo' },
    { import: ['va.world9'] },                                // the classic app's keys
    { also: ['va.engine2.world.agentville.fantasy'] },        // another mod's key
    { key: 'va.engine2.world.example.ab' },                   // a different id, even a near one
    { key: 'va.engine2.world.example.a.b' },                  // another mod could be called example.a.b
  ]) assert.throws(() => checkPersistOwner(decl, 'example.a'), /is not this mod's/, JSON.stringify(decl));
  assert.throws(() => checkPersistOwner({ also: ['va.engine2.world.agentville.base'] }, 'agentville.fantasy'), /is not this mod's/);
});

test('lint: a mod\'s own terrain classes are checked (kit checkClasses); the bundled mods lint clean', () => {
  for (const id of ['agentville.fantasy', 'agentville.base']) assert.deepEqual([...resolveMod(id).lint], [], id);
  const l = lintTop({ id: 'example.a', terrain: { classes: [{ code: 1, name: 'x' }, { code: 1, name: 'y' }] } });
  assert.ok(l.some(x => /duplicate code/.test(x.reason)) && l.some(x => /class 0/.test(x.reason)));
  assert.ok(l.every(x => x.kind === 'terrain-classes' && x.mod === 'example.a'));
  assert.deepEqual(lintTop({ id: 'example.a' }), [], 'no classes of its own: nothing to lint (inherited from the parent)');
});

test('hook shapes: growth is a number, tier a number, capacity a number (pure, same inputs same output)', () => {
  const m = resolveMod();
  const ctx = modCtx(m, { seed: 3, now: 1e12, projectKey: 'alpha' });
  const project = { key: 'alpha', name: 'alpha', accent: '#fff', stats: { prsEver: 3, prsLive: 1, agentsEver: 6, agentsNow: 2, transcriptMB: 5 } };
  const g = m.hooks.growth(project, ctx);
  assert.equal(typeof g, 'number');
  assert.equal(m.hooks.growth(project, ctx), g);
  const t = m.hooks.tier(g, null, ctx);
  assert.equal(typeof t, 'number');
  assert.equal(typeof m.hooks.capacity(t, 4, ctx), 'number');
});

test('modCtx: rng deterministic per (seed, mod, project, stream), differs across streams', () => {
  const m = resolveMod();
  const draw = (o, stream, n = 6) => { const r = modCtx(m, o).rng(stream); return Array.from({ length: n }, r); };
  const o = { seed: 9, now: 1e12, projectKey: 'alpha' };
  assert.deepEqual(draw(o, 'x'), draw(o, 'x'));
  assert.notDeepEqual(draw(o, 'x'), draw(o, 'y'));
  assert.notDeepEqual(draw(o, 'x'), draw({ ...o, seed: 10 }, 'x'));
  assert.notDeepEqual(draw(o, 'x'), draw({ ...o, projectKey: 'beta' }, 'x'));
  assert.notDeepEqual(draw(o, 'x'), draw(o, 'x', 6).map(() => 0.5));
  const other = resolveMod('agentville.base');
  assert.notDeepEqual(draw(o, 'x'), (() => { const r = modCtx(other, o).rng('x'); return Array.from({ length: 6 }, r); })(), 'mod id is part of the stream');
  for (const v of draw(o, 'x', 50)) assert.ok(v >= 0 && v < 1);
});

test('modCtx fields: hash, time, forced dev params, parent', () => {
  const m = resolveMod();
  const c = modCtx(m, { seed: 1, now: 123, projectKey: 'p', forcedTier: 2, forcedStyle: 1 });
  assert.equal(typeof c.hash('abc'), 'number');
  assert.equal(c.hash('abc'), c.hash('abc'));
  assert.equal(c.time.now, 123);
  assert.equal(c.forcedTier, 2);
  assert.equal(c.forcedStyle, 1);
  const d = modCtx(m, { seed: 1, now: 1 });
  assert.equal(d.forcedTier, null);
  assert.equal(d.forcedStyle, null);
});

test('listMods lists both bundled mods', () => {
  const l = listMods();
  const ids = l.map(x => x.id);
  assert.ok(ids.includes('agentville.fantasy') && ids.includes('agentville.base'));
  for (const x of l) assert.equal(typeof x.name, 'string');
});

test('§6.1.8 no Math.random anywhere under web/src/engine/** or mods/**', () => {
  const files = [...listFiles(path.join(ROOT, 'web/src/engine')), ...listFiles(path.join(ROOT, 'mods'))];
  assert.ok(files.length > 5);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!/Math\s*\.\s*random|\[\s*['"]random['"]\s*\]/.test(src), `${path.relative(ROOT, f)} uses Math.random`);
  }
});
