import './support/ensure-mods-index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { retire, RETIRE_DEFAULTS, isProtected } = await import('../web/src/engine/world/prune.js');

const DAY = 864e5;
const NOW = 1_000 * DAY;

// An idle, unprotected, home-owning agent last active `idleDays` ago.
const mk = (id, idleDays = 30, o = {}) => ({
  id,
  lastActive: NOW - idleDays * DAY,
  status: 'resting',
  needs: null,
  important: false,
  crown: false,
  role: 'worker',
  prs: [],
  home: true,
  ...o,
});
const plan = (o = {}) => ({ held: 0, retired: {}, lastAt: null, ...o });
const run = (agents, p, cap, opts) => retire(agents, p, NOW, cap, opts);

test('defaults match the spec', () => {
  assert.deepEqual(RETIRE_DEFAULTS, { minIdleMs: 14 * DAY, everyMs: 60_000, perStep: 1 });
});

// ---------- isProtected ----------

test('isProtected: plain resting agent is not protected', () => {
  assert.equal(isProtected(mk('a')), false);
});

for (const status of ['working', 'waiting', 'stalled', 'error']) {
  test(`isProtected: status ${status} is protected`, () => {
    assert.equal(isProtected(mk('a', 30, { status })), true);
  });
}
for (const [name, o] of [
  ['needs set', { needs: 'permission' }],
  ['important', { important: true }],
  ['pinned', { pinned: true }],
  ['crown', { crown: true }],
  ['role boss', { role: 'boss' }],
  ['role lead', { role: 'lead' }],
  ['open PRs', { prs: [{ n: 1 }] }],
]) {
  test(`isProtected: ${name} is protected`, () => {
    assert.equal(isProtected(mk('a', 30, o)), true);
  });
}
test('isProtected: empty prs array and non-lead role are not protected', () => {
  assert.equal(isProtected(mk('a', 30, { prs: [], role: 'worker', needs: null, pinned: false })), false);
});

// ---------- cap ----------

test('under the cap retires nothing', () => {
  const r = run([mk('a'), mk('b')], plan(), 5);
  assert.deepEqual(r, { retire: [], back: [], over: 0 });
});

test('exactly at the cap retires nothing', () => {
  const r = run([mk('a'), mk('b')], plan(), 2);
  assert.deepEqual(r, { retire: [], back: [], over: 0 });
});

test('over the cap retires the oldest first, one per step by default', () => {
  const agents = [mk('new', 20), mk('old', 90), mk('mid', 40)];
  const r = run(agents, plan(), 2);
  assert.equal(r.over, 1);
  assert.deepEqual(r.retire, ['old']);
});

test('ties on lastActive break by id ascending', () => {
  const agents = [mk('c', 30), mk('a', 30), mk('b', 30)];
  const r = run(agents, plan(), 2);
  assert.deepEqual(r.retire, ['a']);
  const r2 = run(agents, plan(), 1, { perStep: 5 });
  assert.deepEqual(r2.retire, ['a', 'b']);
});

test('oldest-first beats id order', () => {
  const agents = [mk('a', 20), mk('z', 60)];
  assert.deepEqual(run(agents, plan(), 1).retire, ['z']);
});

// ---------- idle floor ----------

test('13.9 days idle is not retired, exactly 14 days is', () => {
  const young = [mk('a', 13.9), mk('b', 13.9)];
  const r = run(young, plan(), 1);
  assert.deepEqual(r, { retire: [], back: [], over: 1 });

  const exact = [mk('a', 14), mk('b', 13.9)];
  assert.deepEqual(run(exact, plan(), 1).retire, ['a']);
});

test('minIdleMs option overrides the floor', () => {
  const agents = [mk('a', 1), mk('b', 2)];
  assert.deepEqual(run(agents, plan(), 1, { minIdleMs: DAY }).retire, ['b']);
});

// ---------- protection blocks retirement ----------

const protectedCases = [
  ['working', { status: 'working' }],
  ['waiting', { status: 'waiting' }],
  ['stalled', { status: 'stalled' }],
  ['error', { status: 'error' }],
  ['needs', { needs: 'question' }],
  ['important', { important: true }],
  ['pinned', { pinned: true }],
  ['crown', { crown: true }],
  ['boss', { role: 'boss' }],
  ['lead', { role: 'lead' }],
  ['prs', { prs: [{ n: 7 }] }],
];
for (const [name, o] of protectedCases) {
  test(`protected (${name}) oldest agent is skipped; next oldest retires`, () => {
    const agents = [mk('prot', 200, o), mk('free', 50), mk('keep', 20)];
    const r = run(agents, plan(), 2);
    assert.equal(r.over, 1);
    assert.deepEqual(r.retire, ['free']);
  });
}

test('only protected candidates: stays over the cap, retires nothing', () => {
  const agents = [mk('a', 90, { important: true }), mk('b', 80, { role: 'boss' }), mk('c', 70, { status: 'working' })];
  assert.deepEqual(run(agents, plan(), 1), { retire: [], back: [], over: 2 });
});

test('only too-young candidates: stays over the cap', () => {
  const agents = [mk('a', 1), mk('b', 2), mk('c', 3)];
  assert.deepEqual(run(agents, plan(), 1), { retire: [], back: [], over: 2 });
});

// ---------- home false / held ----------

test('home:false agents are never retired and do not count', () => {
  const agents = [mk('a', 90, { home: false }), mk('b', 80, { home: false }), mk('c', 30)];
  assert.deepEqual(run(agents, plan(), 1), { retire: [], back: [], over: 0 });
});

test('home:false old agent is skipped as a candidate', () => {
  const agents = [mk('ghost', 500, { home: false }), mk('a', 30), mk('b', 20)];
  const r = run(agents, plan(), 1);
  assert.deepEqual(r.retire, ['a']);
  assert.equal(r.over, 1);
});

test('held counts toward over', () => {
  const agents = [mk('a', 30), mk('b', 40)];
  const r = run(agents, plan({ held: 3 }), 4);
  assert.equal(r.over, 1);
  assert.deepEqual(r.retire, ['b']);
});

test('held alone can push over the cap with no candidates', () => {
  const r = run([], plan({ held: 5 }), 3);
  assert.deepEqual(r, { retire: [], back: [], over: 2 });
});

// ---------- already retired ----------

test('already retired agents do not count and are not re-retired', () => {
  const agents = [mk('gone', 90), mk('a', 60), mk('b', 30)];
  const p = plan({ retired: { gone: { at: NOW - 10 * DAY, last: NOW - 90 * DAY } } });
  // homes = a, b = 2; cap 2 -> not over
  assert.deepEqual(run(agents, p, 2), { retire: [], back: [], over: 0 });
  // cap 1 -> over 1; gone must not be picked even though oldest
  const r = run(agents, p, 1);
  assert.equal(r.over, 1);
  assert.deepEqual(r.retire, ['a']);
});

// ---------- rate ----------

test('rate: lastAt just inside everyMs blocks, at the boundary allows', () => {
  const agents = [mk('a', 60), mk('b', 50)];
  const inside = run(agents, plan({ lastAt: NOW - (RETIRE_DEFAULTS.everyMs - 1) }), 1);
  assert.deepEqual(inside, { retire: [], back: [], over: 1 });
  const at = run(agents, plan({ lastAt: NOW - RETIRE_DEFAULTS.everyMs }), 1);
  assert.deepEqual(at.retire, ['a']);
});

test('rate: lastAt null allows immediately', () => {
  assert.deepEqual(run([mk('a', 60), mk('b', 50)], plan({ lastAt: null }), 1).retire, ['a']);
});

test('rate: everyMs option overrides', () => {
  const agents = [mk('a', 60), mk('b', 50)];
  const p = plan({ lastAt: NOW - 5000 });
  assert.deepEqual(run(agents, p, 1).retire, []);
  assert.deepEqual(run(agents, p, 1, { everyMs: 5000 }).retire, ['a']);
});

test('perStep 3 retires up to 3 but never more than over', () => {
  const agents = [mk('a', 90), mk('b', 80), mk('c', 70), mk('d', 60), mk('e', 50)];
  // over 4, perStep 3 -> 3 oldest
  assert.deepEqual(run(agents, plan(), 1, { perStep: 3 }).retire, ['a', 'b', 'c']);
  // over 2, perStep 3 -> only 2
  const r = run(agents, plan(), 3, { perStep: 3 });
  assert.equal(r.over, 2);
  assert.deepEqual(r.retire, ['a', 'b']);
});

test('perStep is also limited by candidate count', () => {
  const agents = [mk('a', 90), mk('b', 1), mk('c', 1), mk('d', 1)];
  const r = run(agents, plan(), 1, { perStep: 3 });
  assert.equal(r.over, 3);
  assert.deepEqual(r.retire, ['a']);
});

// ---------- comeback ----------

test('comeback: newer lastActive than entry.last brings the agent back', () => {
  const agents = [mk('a', 5)];
  const p = plan({ retired: { a: { at: NOW - 3 * DAY, last: NOW - 20 * DAY } } });
  assert.deepEqual(run(agents, p, 10), { retire: [], back: ['a'], over: 0 });
});

test('comeback: becoming protected brings it back even with unchanged lastActive', () => {
  const last = NOW - 40 * DAY;
  const agents = [mk('a', 40, { status: 'working' })];
  const p = plan({ retired: { a: { at: NOW - 3 * DAY, last } } });
  assert.deepEqual(run(agents, p, 10).back, ['a']);
  const n = [mk('a', 40, { needs: 'plan' })];
  assert.deepEqual(run(n, p, 10).back, ['a']);
  const pr = [mk('a', 40, { prs: [{ n: 1 }] })];
  assert.deepEqual(run(pr, p, 10).back, ['a']);
});

test('no comeback when lastActive is unchanged (or equal) and unprotected', () => {
  const last = NOW - 40 * DAY;
  const p = plan({ retired: { a: { at: NOW - 3 * DAY, last } } });
  assert.deepEqual(run([mk('a', 40)], p, 10), { retire: [], back: [], over: 0 });
});

test('no comeback when lastActive is older than entry.last', () => {
  const p = plan({ retired: { a: { at: NOW - 3 * DAY, last: NOW - 40 * DAY } } });
  assert.deepEqual(run([mk('a', 50)], p, 10).back, []);
});

test('retired id absent from agents is never reported back', () => {
  const p = plan({ retired: { missing: { at: NOW - DAY, last: NOW - 50 * DAY } } });
  assert.deepEqual(run([mk('a', 1)], p, 10).back, []);
});

test('back ids are sorted ascending', () => {
  const agents = [mk('c', 1), mk('a', 1), mk('b', 1)];
  const p = plan({
    retired: Object.fromEntries(['c', 'a', 'b'].map((id) => [id, { at: NOW - 5 * DAY, last: NOW - 30 * DAY }])),
  });
  assert.deepEqual(run(agents, p, 10).back, ['a', 'b', 'c']);
});

test('a comeback counts toward homes again and can push the city over', () => {
  const agents = [mk('x', 30), mk('y', 40), mk('back', 2)];
  const p = plan({ retired: { back: { at: NOW - 5 * DAY, last: NOW - 60 * DAY } } });
  // without comeback homes would be 2 (x,y); with it 3 -> over cap 2 by 1
  const r = run(agents, p, 2);
  assert.deepEqual(r.back, ['back']);
  assert.equal(r.over, 1);
  assert.deepEqual(r.retire, ['y']);
});

test('a comeback agent is not itself retired in the same pass (not idle / protected)', () => {
  const agents = [mk('back', 100, { status: 'working' }), mk('x', 30)];
  const p = plan({ retired: { back: { at: NOW - 5 * DAY, last: NOW - 100 * DAY } } });
  const r = run(agents, p, 1);
  assert.deepEqual(r.back, ['back']);
  assert.deepEqual(r.retire, ['x']);
});

// ---------- no cap ----------

for (const [name, cap] of [
  ['null', null],
  ['undefined', undefined],
  ['0', 0],
  ['negative', -3],
  ['NaN', NaN],
  ['Infinity', Infinity],
]) {
  test(`cap ${name} means no cap`, () => {
    const agents = [mk('a', 90), mk('b', 80), mk('c', 70)];
    assert.deepEqual(run(agents, plan({ held: 4 }), cap), { retire: [], back: [], over: 0 });
  });
}

test('no cap still reports comebacks', () => {
  const p = plan({ retired: { a: { at: NOW - DAY, last: NOW - 50 * DAY } } });
  assert.deepEqual(run([mk('a', 1)], p, null), { retire: [], back: ['a'], over: 0 });
});

// ---------- plan shape / purity ----------

test('plan null and undefined behave like an empty plan', () => {
  const agents = [mk('a', 90), mk('b', 30)];
  const expected = run(agents, { held: 0, retired: {}, lastAt: null }, 1);
  assert.deepEqual(retire(agents, null, NOW, 1), expected);
  assert.deepEqual(retire(agents, undefined, NOW, 1), expected);
  assert.deepEqual(expected.retire, ['a']);
});

test('retire() does not mutate plan or agents', () => {
  const agents = [mk('a', 90), mk('b', 30), mk('back', 1)];
  const p = plan({
    held: 1,
    lastAt: NOW - 10 * 60_000,
    retired: { back: { at: NOW - DAY, last: NOW - 50 * DAY } },
  });
  const agentsBefore = structuredClone(agents);
  const planBefore = structuredClone(p);
  run(agents, p, 1, { perStep: 2 });
  assert.deepEqual(p, planBefore);
  assert.deepEqual(agents, agentsBefore);
});

test('deterministic: same inputs give same output; shuffled input order gives same output', () => {
  const agents = [
    mk('a', 30), mk('b', 30), mk('c', 45), mk('d', 20), mk('e', 90, { pinned: true }),
    mk('f', 60), mk('g', 60), mk('back', 1),
  ];
  const p = plan({ held: 1, retired: { back: { at: NOW - DAY, last: NOW - 50 * DAY } } });
  const base = run(agents, p, 3, { perStep: 3 });
  assert.deepEqual(run(agents, p, 3, { perStep: 3 }), base);
  const shuffles = [
    [...agents].reverse(),
    [agents[3], agents[6], agents[0], agents[7], agents[2], agents[5], agents[1], agents[4]],
    [agents[5], agents[1], agents[7], agents[4], agents[0], agents[6], agents[3], agents[2]],
  ];
  for (const s of shuffles) assert.deepEqual(run(s, p, 3, { perStep: 3 }), base);
  assert.deepEqual(base.retire, ['f', 'g', 'c']);
});
