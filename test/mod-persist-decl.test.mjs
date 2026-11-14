import './support/ensure-mods-index.mjs';
// Spec tests for MOD-4e (SEAMS P5b): the persistence declaration. Written from the spec, not the implementation.
// Legacy key paths are pinned against today's behaviour; declaration-API tests skip ("needs P5b") until it lands.
import test from 'node:test';
import assert from 'node:assert/strict';
const PERSIST_MOD = await import('../web/src/engine/world/persist.js');
const { loadWorld, saveWorld, loadSalt, loadSeed, worldKey } = await import('../web/src/engine/world/persist.js');
const { PERSIST } = await import('../mods/agentville.fantasy/persist.js');

const FANTASY = 'agentville.fantasy';
const W = (tag, extra = {}) => ({ v: 1, seed: 7, blocks: { [tag]: { x: 1, y: 2 } }, lots: {}, ...extra });
// A fantasy-shaped mod: its keys come from its PersistDecl alone (C1 removed the classicImport flag).
const fantasy = () => ({ id: FANTASY, persist: PERSIST });
const child = id => ({ id, persist: null });

function fake(init = {}) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const reads = [], writes = [];
  return {
    data, reads, writes,
    get(k, d) { reads.push(k); return data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : d; },
    set(k, v) { writes.push(k); data.set(k, JSON.parse(JSON.stringify(v))); },
  };
}
const worldReads = s => s.reads.filter(k => k.startsWith('va.engine2.world') || /^va\.world\d/.test(k));
const tagOf = w => Object.keys(w.blocks)[0];

test('fantasy default key is va.engine2.world and wins over every other source', () => {
  const s = fake({ 'va.engine2.world': W('own'), 'va.engine2.world.agentville.fantasy': W('alias'), 'va.world9': W('c9'), 'va.world8': W('c8') });
  assert.equal(tagOf(loadWorld(s, { mod: fantasy() })), 'own');
  assert.deepEqual(worldReads(s), ['va.engine2.world']);
});

test('fantasy demo key is va.engine2.world.demo', () => {
  const s = fake({ 'va.engine2.world.demo': W('demo'), 'va.engine2.world': W('own') });
  assert.equal(tagOf(loadWorld(s, { demo: true, mod: fantasy() })), 'demo');
  assert.deepEqual(worldReads(s), ['va.engine2.world.demo']);
});

test('fantasy falls back to the per-mod alias before any classic import', () => {
  const s = fake({ 'va.engine2.world.agentville.fantasy': W('alias'), 'va.world9': W('c9') });
  assert.equal(tagOf(loadWorld(s, { mod: fantasy() })), 'alias');
  assert.deepEqual(worldReads(s), ['va.engine2.world', 'va.engine2.world.agentville.fantasy']);
});

test('fantasy demo alias is va.engine2.world.agentville.fantasy.demo', () => {
  const s = fake({ 'va.engine2.world.agentville.fantasy.demo': W('alias-demo') });
  assert.equal(tagOf(loadWorld(s, { demo: true, mod: fantasy() })), 'alias-demo');
});

test('fantasy read order: world, alias, va.world9, va.world8, then empty', () => {
  const s = fake({ 'va.world8': W('c8') });
  assert.equal(tagOf(loadWorld(s, { mod: fantasy() })), 'c8');
  assert.deepEqual(worldReads(s), ['va.engine2.world', 'va.engine2.world.agentville.fantasy', 'va.world9', 'va.world8']);
  const s2 = fake({ 'va.world9': W('c9'), 'va.world8': W('c8') });
  assert.equal(tagOf(loadWorld(s2, { mod: fantasy() })), 'c9');
  const s3 = fake();
  const w = loadWorld(s3, { mod: fantasy() });
  assert.deepEqual(w.blocks, {});
  assert.deepEqual(w.lots, {});
  assert.deepEqual(worldReads(s3), ['va.engine2.world', 'va.engine2.world.agentville.fantasy', 'va.world9', 'va.world8']);
});

test('classic demo import reads va.world9.demo then va.world8.demo', () => {
  const s = fake({ 'va.world8.demo': W('c8d'), 'va.world9': W('c9') });
  assert.equal(tagOf(loadWorld(s, { demo: true, mod: fantasy() })), 'c8d');
  assert.deepEqual(worldReads(s).slice(-2), ['va.world9.demo', 'va.world8.demo']);
});

test('classic import keeps blocks/lots, forces v:1 and takes the install seed; never writes a classic key', () => {
  const s = fake({ 'va.engine2.seed': 99, 'va.world9': { v: 9, seed: 5, blocks: { p: { x: 3, extra: 'keep' } }, lots: { p: { tier: 2 } } } });
  const w = loadWorld(s, { mod: fantasy() });
  assert.equal(w.v, 1);
  assert.equal(w.seed, 99);
  assert.equal(w.blocks.p.extra, 'keep');
  assert.equal(w.lots.p.tier, 2);
  assert.deepEqual(s.writes.filter(k => /^va\.world\d/.test(k)), []);
  assert.deepEqual(s.writes.filter(k => k.startsWith('va.engine2.world')), []);
});

test('invalid stored shapes are skipped (falls through the chain)', () => {
  const s = fake({ 'va.engine2.world': { blocks: {} }, 'va.engine2.world.agentville.fantasy': W('alias') });
  assert.equal(tagOf(loadWorld(s, { mod: fantasy() })), 'alias');
});

test('fantasy saves to va.engine2.world (demo: .demo) only', () => {
  const s = fake();
  saveWorld(s, W('a'), { mod: fantasy() });
  saveWorld(s, W('b'), { demo: true, mod: fantasy() });
  assert.deepEqual(s.writes, ['va.engine2.world', 'va.engine2.world.demo']);
});

test('a loaded fantasy layout round-trips through save on the same key', () => {
  const s = fake({ 'va.world9': W('c9') });
  const w = loadWorld(s, { mod: fantasy() });
  saveWorld(s, w, { mod: fantasy() });
  assert.equal(tagOf(loadWorld(s, { mod: fantasy() })), 'c9');
  assert.ok(s.data.has('va.engine2.world'));
});

test('the deprecated key constants are gone (C1): the keys live in the fantasy PersistDecl', () => {
  for (const gone of ['KEY', 'DEMO_KEY', 'CLASSIC_KEYS', 'importClassic']) assert.equal(PERSIST_MOD[gone], undefined, gone);
  assert.equal(worldKey(fantasy()), 'va.engine2.world');
  assert.equal(worldKey(fantasy(), { demo: true }), 'va.engine2.world.demo');
  // a mod without a declaration imports nothing, even one that still carries the old flag
  const s = fake({ 'va.world9': W('c9') });
  assert.deepEqual(loadWorld(s, { mod: { id: 'acme.world', classicImport: true } }).blocks, {});
});

test('salt and seed keys are untouched by mod choice', () => {
  for (const mod of [fantasy(), child('acme.world')]) {
    const s = fake({ 'va.engine2.salt': 'a'.repeat(32), 'va.engine2.seed': 4242 });
    loadWorld(s, { mod });
    saveWorld(s, W('x'), { mod });
    assert.equal(loadSalt(s), 'a'.repeat(32));
    assert.equal(loadSeed(s), 4242);
    assert.equal(s.data.get('va.engine2.salt'), 'a'.repeat(32));
    assert.equal(s.data.get('va.engine2.seed'), 4242);
  }
  const s = fake();
  loadSalt(s);
  assert.match(s.data.get('va.engine2.salt'), /^[0-9a-f]{32}$/);
});

test('seed is stored once and shared across mods', () => {
  const s = fake();
  const a = loadWorld(s, { mod: fantasy(), now: 1000 });
  const b = loadWorld(s, { mod: child('acme.world'), now: 2000 });
  assert.equal(a.seed, b.seed);
  assert.equal(s.writes.filter(k => k === 'va.engine2.seed').length, 1);
});

test('non-fantasy mod gets its own key, demo key, and no legacy reads', () => {
  const s = fake({ 'va.engine2.world': W('fantasy'), 'va.world9': W('c9'), 'va.engine2.world.agentville.fantasy': W('alias') });
  const w = loadWorld(s, { mod: child('acme.world') });
  assert.deepEqual(w.blocks, {});
  assert.deepEqual(worldReads(s), ['va.engine2.world.acme.world']);
  saveWorld(s, W('mine'), { mod: child('acme.world') });
  saveWorld(s, W('mined'), { demo: true, mod: child('acme.world') });
  assert.deepEqual(s.writes.filter(k => k.includes('acme')), ['va.engine2.world.acme.world', 'va.engine2.world.acme.world.demo']);
  assert.equal(tagOf(loadWorld(s, { mod: child('acme.world') })), 'mine');
  assert.equal(tagOf(loadWorld(s, { demo: true, mod: child('acme.world') })), 'mined');
});

test('a child of fantasy does NOT inherit its legacy keys', () => {
  const s = fake({ 'va.engine2.world': W('fantasy'), 'va.engine2.world.agentville.fantasy': W('alias'), 'va.world9': W('c9'), 'va.world8': W('c8') });
  const w = loadWorld(s, { mod: child('acme.child') });
  assert.deepEqual(w.blocks, {});
  for (const k of ['va.engine2.world', 'va.engine2.world.agentville.fantasy', 'va.world9', 'va.world8']) assert.ok(!s.reads.includes(k), k);
});

test('switching worlds and back never reshuffles either one', () => {
  const s = fake();
  saveWorld(s, W('F'), { mod: fantasy() });
  saveWorld(s, W('A'), { mod: child('acme.world') });
  saveWorld(s, W('F2'), { mod: fantasy() });
  assert.equal(tagOf(loadWorld(s, { mod: child('acme.world') })), 'A');
  assert.equal(tagOf(loadWorld(s, { mod: fantasy() })), 'F2');
});

test('worldKey for fantasy and others (today)', () => {
  assert.equal(worldKey(fantasy()), 'va.engine2.world');
  assert.equal(worldKey(fantasy(), { demo: true }), 'va.engine2.world.demo');
  assert.equal(worldKey(child('acme.world')), 'va.engine2.world.acme.world');
});

// ---- the declaration itself (needs P5b) ----
// Probe: does loadWorld honour mod.persist.key? (Today it ignores it.)
const declared = (() => {
  const s = fake({ 'va.engine2.world.probe-decl': W('decl') });
  try { return tagOf(loadWorld(s, { mod: { id: 'probe', persist: { key: 'va.engine2.world.probe-decl' } } })) === 'decl'; } catch { return false; }
})();
const t = declared ? test : (name, fn) => test(name, { skip: 'needs P5b' }, fn);

t('fantasy PERSIST declaration matches the legacy read order', () => {
  assert.equal(PERSIST.key, 'va.engine2.world');
  assert.equal(PERSIST.demoKey, 'va.engine2.world.demo');
  assert.deepEqual(PERSIST.also, ['va.engine2.world.agentville.fantasy']);
  assert.deepEqual(PERSIST.import, ['va.world9', 'va.world8']);
});

t('fantasy works from persist alone (no classicImport flag, no special id)', () => {
  const m = { id: FANTASY, persist: PERSIST };
  const s = fake({ 'va.world8': W('c8') });
  assert.equal(tagOf(loadWorld(s, { mod: m })), 'c8');
  assert.deepEqual(worldReads(s), ['va.engine2.world', 'va.engine2.world.agentville.fantasy', 'va.world9', 'va.world8']);
});

t('custom key and demoKey are the ones read and written', () => {
  const m = { id: 'acme.world', persist: { key: 'va.engine2.world.custom', demoKey: 'va.engine2.world.custom.demo' } };
  const s = fake({ 'va.engine2.world.custom': W('c'), 'va.engine2.world.custom.demo': W('cd') });
  assert.equal(tagOf(loadWorld(s, { mod: m })), 'c');
  assert.equal(tagOf(loadWorld(s, { demo: true, mod: m })), 'cd');
  saveWorld(s, W('n'), { mod: m });
  saveWorld(s, W('nd'), { demo: true, mod: m });
  assert.deepEqual(s.writes.filter(k => k.startsWith('va.engine2.world')), ['va.engine2.world.custom', 'va.engine2.world.custom.demo']); // the seed write is separate
});

t('also[] keys are read after key, read-only; import[] last, read-only (demo adds .demo)', () => {
  const m = { id: 'acme.world', persist: { key: 'va.engine2.world.k', also: ['va.engine2.world.old'], import: ['va.world7'] } };
  const s = fake({ 'va.world7': W('c7') });
  assert.equal(tagOf(loadWorld(s, { mod: m })), 'c7');
  assert.deepEqual(worldReads(s), ['va.engine2.world.k', 'va.engine2.world.old', 'va.world7']);
  const s2 = fake({ 'va.engine2.world.old': W('old'), 'va.world7': W('c7') });
  assert.equal(tagOf(loadWorld(s2, { mod: m })), 'old');
  const s3 = fake({ 'va.world7.demo': W('c7d') });
  assert.equal(tagOf(loadWorld(s3, { demo: true, mod: m })), 'c7d');
  assert.deepEqual(s3.writes.filter(k => k !== 'va.engine2.seed'), []);
});

t('persist.import non-empty enables classic import; absent persist does not', () => {
  const withImp = { id: 'a.b', persist: { import: ['va.world9'] } };
  assert.equal(tagOf(loadWorld(fake({ 'va.world9': W('c9') }), { mod: withImp })), 'c9');
  assert.deepEqual(loadWorld(fake({ 'va.world9': W('c9') }), { mod: { id: 'a.b' } }).blocks, {});
});

const bad = [
  'va.engine2.seed', 'va.engine2.salt', 'localStorage', 'va.world9x', 'evil', 'va.engine2.worldx', 'va.engine2.World',
  'va.engine2.world.a b', 'va.engine2.world/x', 'va.engine2.world.A', 'va.world', '__proto__', '',
];
t('bad key patterns are rejected and never touched', () => {
  for (const k of bad) {
    for (const field of ['key', 'demoKey', 'also', 'import']) {
      const decl = { [field]: field === 'also' || field === 'import' ? [k] : k };
      const s = fake({ [k]: W('x') });
      let threw = false;
      try { loadWorld(s, { mod: { id: 'a.b', persist: decl } }); saveWorld(s, W('y'), { mod: { id: 'a.b', persist: decl } }); } catch { threw = true; }
      if (!threw) assert.ok(!s.reads.includes(k) && !s.writes.includes(k), `${field}=${JSON.stringify(k)} was used`);
    }
  }
});

t('key/demoKey must start with va.engine2.world; a classic key is allowed only in also/import', () => {
  for (const field of ['key', 'demoKey']) {
    const s = fake();
    const mod = { id: 'a.b', persist: { [field]: 'va.world9' } };
    let threw = false;
    try { loadWorld(s, { mod }); saveWorld(s, W('y'), { mod }); saveWorld(s, W('y'), { demo: true, mod }); } catch { threw = true; }
    if (!threw) assert.ok(!s.writes.includes('va.world9'), `${field} wrote a classic key`);
  }
  const s = fake({ 'va.world8': W('c8') });
  assert.equal(tagOf(loadWorld(s, { mod: { id: 'a.b', persist: { also: ['va.world8'] } } })), 'c8');
});

t('a non-fantasy mod with a declaration never writes a classic key', () => {
  const m = { id: 'a.b', persist: { import: ['va.world9', 'va.world8'] } };
  const s = fake({ 'va.world9': W('c9') });
  saveWorld(s, loadWorld(s, { mod: m }), { mod: m });
  assert.deepEqual(s.writes.filter(k => /^va\.world\d/.test(k)), []);
});
