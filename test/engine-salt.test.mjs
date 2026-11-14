import './support/ensure-mods-index.mjs';
// loadSalt (M1f): crypto-random, persisted at va.engine2.salt, independent of the seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { loadSalt, loadSeed } = await import('../web/src/engine/world/persist.js');

const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { m, get: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => { m.set(k, JSON.stringify(v)); } };
};
const HEX32 = /^[0-9a-f]{32}$/;

test('salt is 32 hex and stable across calls', () => {
  const st = fakeStore();
  const a = loadSalt(st);
  assert.match(a, HEX32);
  assert.equal(loadSalt(st), a);
  assert.equal(st.get('va.engine2.salt'), a);
});

test('two fresh stores get different salts', () => {
  assert.notEqual(loadSalt(fakeStore()), loadSalt(fakeStore()));
});

test('junk values are replaced', () => {
  for (const junk of [42, '', 'abc', 'g'.repeat(32), 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), null, {}, ['a']]) {
    const st = fakeStore({ 'va.engine2.salt': junk });
    const s = loadSalt(st);
    assert.match(s, HEX32);
    assert.equal(st.get('va.engine2.salt'), s);
  }
});

test('salt does not depend on the seed', () => {
  const st = fakeStore();
  const seed = loadSeed(st, { now: 1 });
  const salt = loadSalt(st);
  assert.ok(!salt.includes(seed.toString(16).padStart(8, '0')) || salt.length === 32);
  const st2 = fakeStore({ 'va.engine2.seed': seed });
  assert.notEqual(loadSalt(st2), salt);
});
