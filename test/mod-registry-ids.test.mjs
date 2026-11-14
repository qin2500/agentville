import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { resolveMod, validateModId, DEFAULT_MOD } = await import('../web/src/engine/mod/registry.js');

test('valid reverse-DNS ids pass', () => {
  for (const id of ['agentville.fantasy', 'a.b', 'com.example.my-mod', 'x1.y2.z3']) assert.equal(validateModId(id), id);
});
test('invalid ids throw', () => {
  for (const id of ['', 'nodots', 'Upper.case', 'a..b', 'a.-b', 'a.b_c', '.a.b', 'a.b.', 'a b.c', 'x.demo', 'agentville.fantasy.demo', 'a.' + 'b'.repeat(63), null, 42])
    assert.throws(() => validateModId(id), /invalid mod id/, String(id));
});
test('resolveMod rejects bad ids, falls back for unknown valid ids', () => {
  assert.throws(() => resolveMod('bad id'), /invalid mod id/);
  assert.throws(() => resolveMod('foo.demo'), /invalid mod id/);
  assert.equal(resolveMod('unknown.mod').id, DEFAULT_MOD);
  assert.equal(resolveMod().id, DEFAULT_MOD);
});
test('objects are deep-frozen', () => {
  const o = resolveMod().objects;
  assert.ok(Object.isFrozen(o));
  for (const v of Object.values(o)) if (v && typeof v === 'object') assert.ok(Object.isFrozen(v));
});
