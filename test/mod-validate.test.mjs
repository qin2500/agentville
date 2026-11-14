// MOD1 M1a spec tests (from COMMON.md): validateLots + validateGroundCode in web/src/engine/mod/validate.js.
// Loaded lazily so this file passes before the implementation is merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../web/src/engine/mod/validate.js').catch(() => null);
const SKIP = mod && mod.validateLots ? false : 'web/src/engine/mod/validate.js (validateLots) not merged yet';
const SKIP_G = mod && mod.validateGroundCode ? false : 'web/src/engine/mod/validate.js (validateGroundCode) not merged yet';

const ctx = () => ({ projectKey: 'p1', agents: new Set(['a1', 'a2']), prs: new Set(['p1#1', 'p1#2']) });
const home = (agent, rank = 'M', extra = {}) => ({ owner: 'home', agent, rank, ...extra });
const pr = (p, rank = 'S', extra = {}) => ({ owner: 'pr', pr: p, rank, ...extra });

test('valid requests are kept in order, with engine-built items', { skip: SKIP }, () => {
  const out = mod.validateLots([home('a2', 'L'), pr('p1#2', 'S'), home('a1', 'M'), pr('p1#1', 'L')], ctx());
  assert.equal(out.requests.length, 4);
  assert.deepEqual(out.requests.map((r) => r.item), ['home:a2', 'pr:p1#2', 'home:a1', 'pr:p1#1']);
  assert.deepEqual(out.requests.map((r) => r.rank), ['L', 'S', 'M', 'L']);
  assert.deepEqual(out.requests.map((r) => r.owner), ['home', 'pr', 'home', 'pr']);
  assert.equal(out.lint.length, 0);
});

test('wrong owner is dropped with a lint', { skip: SKIP }, () => {
  for (const owner of ['town', 'HOME', '', null, undefined, 7]) {
    const out = mod.validateLots([{ owner, rank: 'M', agent: 'a1' }], ctx());
    assert.equal(out.requests.length, 0, `owner ${String(owner)}`);
    assert.ok(out.lint.length >= 1, `lint for owner ${String(owner)}`);
  }
});

test('wrong rank is dropped with a lint', { skip: SKIP }, () => {
  for (const rank of ['XL', 'l', '', null, undefined, 1]) {
    const out = mod.validateLots([{ ...home('a1'), rank }, { ...pr('p1#1'), rank }], ctx());   // explicit: the helpers default an undefined rank
    assert.equal(out.requests.length, 0, `rank ${String(rank)}`);
    assert.ok(out.lint.length >= 1);
  }
});

test('home agent not in this project set is dropped with a lint', { skip: SKIP }, () => {
  const out = mod.validateLots([home('zzz'), home('a1')], ctx());
  assert.equal(out.requests.length, 1);
  assert.equal(out.requests[0].item, 'home:a1');
  assert.ok(out.lint.length >= 1);
});

test('pr not in the set is dropped with a lint', { skip: SKIP }, () => {
  const out = mod.validateLots([pr('p1#99'), pr('other#1'), pr('p1#1')], ctx());
  assert.equal(out.requests.length, 1);
  assert.equal(out.requests[0].item, 'pr:p1#1');
  assert.ok(out.lint.length >= 2);
});

test('mod-supplied item is ignored and rebuilt by the engine', { skip: SKIP }, () => {
  const out = mod.validateLots([home('a1', 'M', { item: 'home:a2' }), pr('p1#1', 'L', { item: 'pr:p1#2' }), home('a2', 'S', { item: 'evil' })], ctx());
  assert.deepEqual(out.requests.map((r) => r.item), ['home:a1', 'pr:p1#1', 'home:a2']);
});

test('a forged item cannot rescue an invalid entry', { skip: SKIP }, () => {
  const out = mod.validateLots([home('zzz', 'M', { item: 'home:a1' }), pr('nope', 'M', { item: 'pr:p1#1' })], ctx());
  assert.equal(out.requests.length, 0);
  assert.ok(out.lint.length >= 2);
});

test('input is not mutated', { skip: SKIP }, () => {
  const reqs = [home('a1', 'M', { item: 'x' }), home('zzz'), pr('p1#1')];
  const c = ctx();
  const before = structuredClone(reqs);
  mod.validateLots(reqs, c);
  assert.deepEqual(reqs, before);
  assert.deepEqual([...c.agents], ['a1', 'a2']);
  assert.deepEqual([...c.prs], ['p1#1', 'p1#2']);
});

test('output is structured-clonable plain data', { skip: SKIP }, () => {
  const out = mod.validateLots([home('a1'), home('bad'), pr('p1#1', 'X')], ctx());
  const copy = structuredClone(out);
  assert.deepEqual(copy, out);
  assert.ok(Array.isArray(out.requests) && Array.isArray(out.lint));
});

test('empty input gives empty output', { skip: SKIP }, () => {
  const out = mod.validateLots([], ctx());
  assert.deepEqual(out.requests, []);
  assert.deepEqual(out.lint, []);
});

test('validateGroundCode: codes above MOD_CODE_MAX (199) become 0', { skip: SKIP_G }, () => {
  assert.equal(mod.validateGroundCode(200), 0);
  assert.equal(mod.validateGroundCode(255), 0);
  assert.equal(mod.validateGroundCode(1000), 0);
});

test('validateGroundCode: codes 0..199 pass through', { skip: SKIP_G }, () => {
  for (const c of [0, 1, 7, 150, 199]) assert.equal(mod.validateGroundCode(c), c);
});
