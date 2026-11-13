import test from 'node:test';
import assert from 'node:assert/strict';
import { taskRows, taskCounts } from '../web/src/tasks-model.js';

const ag = (id, o = {}) => ({ id, name: id, bucket: 'resting', reason: 'Done', since: 100, prs: [], childIds: [], ...o });
const task = (id, agentId, o = {}) => ({ id, kind: 'agent', agentId, addedAt: 1, ...o });
const one = (agents, o) => taskRows([task('t', 'a', o)], agents, {}).open[0];

test('status precedence', () => {
  assert.equal(one([]).status, 'Agent gone');
  assert.equal(one([]).gone, true);
  const kid = ag('k', { parentId: 'a', bucket: 'stalled', reason: 'Needs your approval' });
  assert.equal(one([ag('a', { childIds: ['k'] }), kid]).tone, 'needs');
  assert.equal(one([ag('a', { severity: 'error', bucket: 'building' })]).status, 'Error');
  const w = one([ag('a', { bucket: 'building', childIds: ['k1', 'k2'] }), ag('k1', { parentId: 'a', bucket: 'building' }), ag('k2', { parentId: 'a', bucket: 'building' })]);
  assert.equal(w.status, 'Working (2 helpers)');
  assert.equal(w.helpers, 2);
  const pr = (state, extra = {}) => ({ id: '1', href: 'h' + state, state, checks: { failed: 0 }, review: null, ...extra });
  assert.equal(one([ag('a', { prs: [pr('open', { checks: { failed: 1 } })] })]).status, 'Checks failing');
  assert.equal(one([ag('a', { prs: [pr('merged'), pr('closed')] })]).tone, 'merged');
  assert.equal(one([ag('a', { prs: [pr('open', { review: 'approved' })] })]).status, 'PR open · approved');
  assert.equal(one([ag('a', { prs: [pr('closed')] })]).tone, 'finished');
});

test('cycles are guarded', () => {
  const r = one([ag('a', { parentId: 'b', childIds: ['b'] }), ag('b', { parentId: 'a', childIds: ['a'], bucket: 'building' })]);
  assert.equal(r.tone, 'working');
});

test('ideas, titles, unseen, ordering, done', () => {
  const agents = [ag('a', { since: 500, title: 'T' }), ag('w', { bucket: 'building', since: 900 })];
  const tasks = [
    { id: 'i', kind: 'idea', text: 'try x', addedAt: 5 },
    task('t1', 'a'),
    task('t2', 'w', { rename: 'Mine' }),
    task('t3', 'a', { doneAt: 50 }),
    task('t4', 'a', { doneAt: 60 }),
  ];
  const { open, done } = taskRows(tasks, agents, { a: { seenAt: 100 } });
  assert.deepEqual(open.map(r => r.id), ['t1', 't2', 'i']);
  assert.equal(open[0].title, 'T');
  assert.equal(open[0].unseen, true);
  assert.equal(open[1].title, 'Mine');
  assert.equal(open[1].unseen, false);
  assert.equal(open[2].status, 'Idea');
  assert.deepEqual(done.map(r => r.id), ['t4', 't3']);
  assert.deepEqual(taskCounts(open), { total: 3, needs: 0, followUp: 1 });
});

test('title prefers rename, then aiName, then the agent title', () => {
  const a = [ag('a', { title: 'Raw title' })];
  assert.equal(one(a).title, 'Raw title');
  assert.equal(one(a, { aiName: 'Fix login bug' }).title, 'Fix login bug');
  assert.equal(one(a, { aiName: 'Fix login bug', rename: 'Mine' }).title, 'Mine');
});
