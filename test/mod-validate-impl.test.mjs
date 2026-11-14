// MOD1 (M1a): validateLots / validateGroundCode, per COMMON.md "MOD1" seam. Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLots, validateGroundCode, LINT_MAX } from '../web/src/engine/mod/validate.js';
import { MOD_CODE_MAX } from '../web/src/engine/mod/api.js';

const opts = { projectKey: 'alpha', agents: new Set(['a1', 'a2']), prs: new Set(['alpha#1', 'alpha#2']), mod: 'test.mod' };

test('valid home and pr requests pass; engine builds item', () => {
  const { requests, lint } = validateLots([
    { owner: 'home', rank: 'L', agent: 'a1', item: 'home:EVIL' },
    { owner: 'pr', rank: 'S', pr: 'alpha#2', building: true, item: '__proto__' },
  ], opts);
  assert.deepEqual(lint, []);
  assert.deepEqual(requests, [
    { item: 'home:a1', owner: 'home', rank: 'L', agent: 'a1' },
    { item: 'pr:alpha#2', owner: 'pr', rank: 'S', pr: 'alpha#2', building: true },
  ]);
});

test('mod item ignored even for an otherwise valid request without item', () => {
  const { requests } = validateLots([{ owner: 'pr', rank: 'M', pr: 'alpha#1' }], opts);
  assert.equal(requests[0].item, 'pr:alpha#1');
  assert.equal(requests[0].building, false);
});

test('bad owner, rank, agent, pr are dropped with lint naming the field path', () => {
  const { requests, lint } = validateLots([
    { owner: 'boss', rank: 'L', agent: 'a1' },
    { owner: 'home', rank: 'XL', agent: 'a1' },
    { owner: 'home', rank: 'L', agent: 'stranger' },
    { owner: 'pr', rank: 'S', pr: 'beta#1' },
    { owner: 'pr', rank: 'S', pr: 7 },
    null, 'x', [],
    { owner: 'home', rank: 'M', agent: 'a2' },
  ], opts);
  assert.deepEqual(requests.map(r => r.item), ['home:a2']);
  assert.deepEqual(lint.map(l => l.path), ['[0].owner', '[1].rank', '[2].agent', '[3].pr', '[4].pr', '[5]', '[6]', '[7]']);
  for (const l of lint) { assert.equal(l.hook, 'lots'); assert.equal(l.mod, 'test.mod'); assert.equal(l.project, 'alpha'); }
});

test('lint does not echo mod-supplied values', () => {
  const secret = 'SECRET-TEXT-123';
  const { lint } = validateLots([{ owner: secret, rank: 'L' }, { owner: 'home', rank: 'L', agent: secret }], opts);
  assert.ok(!JSON.stringify(lint).includes(secret));
});

test('pr must belong to this project even if listed in prs', () => {
  const { requests } = validateLots([{ owner: 'pr', rank: 'S', pr: 'beta#9' }], { ...opts, prs: new Set(['beta#9']) });
  assert.deepEqual(requests, []);
});

test('duplicates keep the first entry', () => {
  const { requests, lint } = validateLots([
    { owner: 'home', rank: 'L', agent: 'a1' }, { owner: 'home', rank: 'S', agent: 'a1' },
  ], opts);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].rank, 'L');
  assert.equal(lint.length, 1);
});

test('non-array output: null/undefined is empty without lint, anything else lints', () => {
  assert.deepEqual(validateLots(null, opts), { requests: [], lint: [] });
  assert.deepEqual(validateLots(undefined, opts), { requests: [], lint: [] });
  const r = validateLots({ length: 1, 0: { owner: 'home', rank: 'L', agent: 'a1' } }, opts);
  assert.deepEqual(r.requests, []);
  assert.equal(r.lint.length, 1);
});

test('getters are never invoked and inherited fields are ignored', () => {
  let called = false;
  const r = { rank: 'L', agent: 'a1' };
  Object.defineProperty(r, 'owner', { get() { called = true; return 'home'; }, enumerable: true });
  const proto = Object.create({ owner: 'home', rank: 'L', agent: 'a1' });
  const { requests } = validateLots([r, proto], opts);
  assert.equal(called, false);
  assert.deepEqual(requests, []);
});

test('output objects are fresh and carry no extra fields', () => {
  const input = { owner: 'home', rank: 'M', agent: 'a2', extra: 1, data: { x: 1 } };
  const { requests } = validateLots([input], opts);
  assert.notEqual(requests[0], input);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['agent', 'item', 'owner', 'rank']);
});

test('agents/prs accept arrays; missing sets reject everything', () => {
  assert.equal(validateLots([{ owner: 'home', rank: 'L', agent: 'a1' }], { projectKey: 'alpha', agents: ['a1'], prs: [] }).requests.length, 1);
  assert.equal(validateLots([{ owner: 'home', rank: 'L', agent: 'a1' }], { projectKey: 'alpha' }).requests.length, 0);
});

test('lint is capped with a summary entry', () => {
  const junk = Array.from({ length: LINT_MAX + 10 }, () => null);
  const { lint } = validateLots(junk, opts);
  assert.equal(lint.length, LINT_MAX + 1);
  assert.match(lint.at(-1).reason, /^10 more/);
});

test('validateGroundCode', () => {
  assert.equal(validateGroundCode(0), 0);
  assert.equal(validateGroundCode(5), 5);
  assert.equal(validateGroundCode(MOD_CODE_MAX), MOD_CODE_MAX);
  for (const c of [MOD_CODE_MAX + 1, 255, -1, 1.5, NaN, Infinity, '5', null, undefined, {}]) assert.equal(validateGroundCode(c), 0);
});
