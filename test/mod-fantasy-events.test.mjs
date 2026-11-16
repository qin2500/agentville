import './support/ensure-mods-index.mjs';
// M6 P4: agentville.fantasy's events hook (mods/agentville.fantasy/events.js) and its wiring through the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { events } from '../mods/agentville.fantasy/events.js';
import { runEvents, createEventFx, normalizeSpec, animOverrides } from '../web/src/engine/render/event-fx.js';
const { resolveMod } = await import('../web/src/engine/mod/registry.js');

const CTX = {
  accentOf: p => (p === 'p' ? '#3366ff' : null), actorsOf: p => (p === 'p' ? ['z', 'a', 'm'] : []),
  newObjects: [{ id: 'lot:p:2', project: 'p', kind: 'building', model: 'house' }, { id: 'tree:1,1', project: 'p', kind: 'tree', model: 'oak' },
    { id: 'prop:p:banner:0', project: 'p', kind: 'prop', model: 'banner' }, { id: 'lot:q:1', project: 'q', kind: 'building', model: 'house' }],
};

test('the fantasy mod carries the events hook through the registry', () => {
  assert.equal(resolveMod('agentville.fantasy').events, events);
});

test('merge: confetti over the plaza in the village accent', () => {
  const [s, ...rest] = events([{ type: 'merge', pr: 'p#3', project: 'p' }], CTX);
  assert.equal(rest.length, 0);
  assert.deepEqual([s.kind, s.at, s.effect], ['merge', 'plaza:p', 'burst']);
  assert.equal(s.colors[0], '#3366ff');
});

test('merge without an accent still gets colours', () => {
  const [s] = events([{ type: 'merge', pr: 'q#1', project: 'q' }], CTX);
  assert.ok(s.colors.length >= 2);
});

test('found: banner scaffolds then a dust ring', () => {
  const out = events([{ type: 'found', project: 'p' }], CTX);
  assert.deepEqual(out.map(s => s.effect), ['site:prop:p:banner:0', 'ring']);
  assert.ok(out.every(s => s.at === 'plaza:p'));
  assert.equal(out[1].seconds > 0, true);
  assert.deepEqual(events([{ type: 'found', project: 'q' }], CTX).map(s => s.effect), ['ring']);
});

test('tierUp: 8 s scaffolds on the project\'s new buildings only, and its agents cheer', () => {
  const out = events([{ type: 'tierUp', project: 'p', from: 1, to: 2 }], CTX);
  const sites = out.filter(s => s.effect.startsWith('site:')), cheers = out.filter(s => s.effect === 'anim:cheer');
  assert.deepEqual(sites.map(s => s.effect), ['site:lot:p:2']);
  assert.ok(sites.every(s => s.seconds === 8));
  assert.deepEqual(cheers.map(s => s.at), ['actor:a', 'actor:m', 'actor:z']);
});

test('determinism, and hostile input: no project, no ctx, unknown types', () => {
  const d = [{ type: 'tierUp', project: 'p' }, { type: 'merge', project: 'p' }];
  assert.deepEqual(events(d, CTX), events(d, CTX));
  assert.deepEqual(events([{ type: 'merge' }, null, { type: 'arrive', project: 'p', id: 'a' }, { type: 'leave', project: 'p' }], CTX), []);
  assert.doesNotThrow(() => events([{ type: 'tierUp', project: 'p' }, { type: 'found', project: 'p' }], undefined));
  assert.deepEqual(events(undefined, CTX), []);
});

test('every spec the mod makes passes the engine validator and runs through the deadline wrapper', () => {
  const diff = [{ type: 'merge', project: 'p' }, { type: 'found', project: 'p' }, { type: 'tierUp', project: 'p' }];
  const r = runEvents(events, diff, CTX);
  assert.equal(r.status, 'ok');
  assert.equal(r.specs.length, events(diff, CTX).length);
  assert.ok(events(diff, CTX).every(s => normalizeSpec(s, 0)));
  const fx = createEventFx(); fx.add(r.specs, 100);
  assert.deepEqual([...animOverrides(fx.active(101), 101).keys()].sort(), ['a', 'm', 'z']);
  assert.equal(fx.prune(100 + 9), 0);
});
