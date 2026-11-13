import test from 'node:test';
import assert from 'node:assert/strict';
import { loopItems, unseenIds, snoozeOptions } from '../web/src/loops-model.js';

const NOW = 1_000_000;
const needs = (id, since) => ({ id, bucket: 'stalled', reason: 'Needs your input', since });
const turn = (id, since, prs) => ({ id, bucket: 'stalled', reason: 'Turn finished', since, prs });
const ids = items => items.map(i => i.id);

test('kinds and labels', () => {
  const agents = [
    needs('n', 5),
    { id: 'e', bucket: 'stalled', reason: 'x', severity: 'error', since: 5 },
    { id: 'c', bucket: 'building', since: 5, prs: [{ state: 'open', checks: { failed: 1 } }] },
    { id: 'd', bucket: 'resting', reason: 'Done', since: 5 },
    { id: 'idle', bucket: 'building', since: 5 },
  ];
  const items = loopItems(agents, {}, NOW);
  assert.deepEqual(items.map(i => [i.id, i.kind, i.label]), [
    ['n', 'needs', 'Needs you'], ['d', 'finished', 'Done'], ['e', 'error', 'Error'], ['c', 'checks', 'Checks failing'],
  ]);
});

test('seen clears unseen only; done hides until newer state', () => {
  const a = [needs('n', 100)];
  assert.equal(loopItems(a, { n: { seenAt: 200 } }, NOW)[0].unseen, false);
  assert.deepEqual(loopItems(a, { n: { doneAt: 100 } }, NOW), []);
  assert.equal(loopItems([needs('n', 101)], { n: { doneAt: 100 } }, NOW).length, 1);
  assert.deepEqual([...unseenIds(loopItems([needs('n', 100), needs('m', 100)], { m: { seenAt: 100 } }, NOW))], ['n']);
});

test('hidden, merged and snoozed are excluded; expired snooze is due', () => {
  assert.deepEqual(loopItems([{ ...needs('h', 5), hidden: true }], {}, NOW), []);
  assert.deepEqual(loopItems([turn('m', 5, [{ state: 'merged' }, { state: 'closed' }])], {}, NOW), []);
  assert.equal(loopItems([turn('o', 5, [{ state: 'open' }])], {}, NOW).length, 1);
  assert.deepEqual(loopItems([needs('s', 5)], { s: { snoozeUntil: NOW + 1 } }, NOW), []);
  const [it] = loopItems([needs('s', 5)], { s: { snoozeUntil: NOW - 1 } }, NOW);
  assert.equal(it.due, true);
});

test('priority order', () => {
  const agents = [
    turn('seenFin', 50), turn('unseenFin', 10), needs('needs', 1),
    { id: 'err', bucket: 'stalled', severity: 'error', since: 5 },
    { id: 'chk', bucket: 'building', since: 5, prs: [{ state: 'draft', checks: { failed: 2 } }] },
    turn('dueFin', 40),
  ];
  const loops = { seenFin: { seenAt: 60 }, dueFin: { seenAt: 60, snoozeUntil: NOW - 1 } };
  assert.deepEqual(ids(loopItems(agents, loops, NOW)), ['needs', 'unseenFin', 'err', 'chk', 'dueFin', 'seenFin']);
});

test('snoozeOptions', () => {
  const now = new Date(2026, 0, 5, 15, 0).getTime();
  const [two, tom] = snoozeOptions(now);
  assert.equal(two.until, now + 7200e3);
  assert.equal(new Date(tom.until).getDate(), 6);
  assert.equal(new Date(tom.until).getHours(), 9);
});
