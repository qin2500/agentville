import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvents, diffInputs } from '../web/src/engine/sim/events.js';

const mk = ({ agents = [], projects = [], prs = [] } = {}) => ({ agents, projects, prs });
const A = (id, project = 'p') => ({ id, project });
const P = key => ({ key });
const R = (id, state, project = 'p') => ({ id, state, project });

test('emit/drain queue, unknown types ignored, drain clears', () => {
  const e = createEvents();
  e.emit('merge', { pr: 'p#1' }); e.emit('bogus', {}); e.emit('leave', { agent: 'a1' });
  const d = e.drain();
  assert.deepEqual(d.map(x => x.type), ['merge', 'leave']);
  assert.deepEqual(e.drain(), []);
});

test('diff: first snapshot yields nothing', () => {
  assert.deepEqual(diffInputs(null, mk({ agents: [A('a1')] })), []);
});

test('diff: merge, found, arrive, leave, tierUp', () => {
  const prev = mk({ agents: [A('a1'), A('a2')], projects: [P('p')], prs: [R('p#1', 'building'), R('p#2', 'merged')] });
  const next = mk({ agents: [A('a2'), A('a3')], projects: [P('p'), P('q')], prs: [R('p#1', 'merged'), R('p#2', 'merged')] });
  const ev = diffInputs(prev, next, { tiers: { prev: { p: 0 }, next: { p: 1, q: 0 } } });
  assert.deepEqual(ev.map(e => e.type), ['merge', 'found', 'tierUp', 'arrive', 'leave']);
  assert.equal(ev[0].pr, 'p#1'); assert.equal(ev[1].project, 'q');
  assert.equal(ev[3].agent, 'a3'); assert.equal(ev[4].agent, 'a1');
});

test('diff: named tiers via order; no downgrade events; deterministic order by id', () => {
  const order = ['hamlet', 'village', 'town'];
  const ev = diffInputs(mk(), mk(), { tiers: { order, prev: { a: 'hamlet', b: 'town' }, next: { a: 'town', b: 'village' } } });
  assert.deepEqual(ev.map(e => e.project), ['a']);
  const prev = mk({ agents: [] }), next = mk({ agents: [A('z'), A('b'), A('m')] });
  assert.deepEqual(diffInputs(prev, next).map(e => e.agent), ['b', 'm', 'z']);
});

test('payloads carry only ids and keys', () => {
  const ev = diffInputs(mk(), mk({ agents: [{ id: 'a1', project: 'p', name: 'secret' }] }));
  assert.deepEqual(Object.keys(ev[0]).sort(), ['agent', 'project', 'type']);
});
