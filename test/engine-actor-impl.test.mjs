import test from 'node:test';
import assert from 'node:assert/strict';
import { makeActor, FLAGS, stepAlongPath, faceFrom } from '../web/src/engine/sim/actor.js';

test('FLAGS are distinct bits', () => {
  const v = Object.values(FLAGS);
  assert.equal(new Set(v).size, v.length);
  for (const f of v) assert.equal(f & (f - 1), 0);
  for (const k of ['VISIBLE', 'SELECTED', 'OCCLUDED', 'INDOORS', 'GHOST']) assert.ok(k in FLAGS);
});

test('makeActor defaults and previous position', () => {
  const a = makeActor({ id: 'a', kind: 'agent', x: 3, y: 4 });
  assert.equal(a.px, 3); assert.equal(a.py, 4);
  assert.equal(a.anim, 'idle'); assert.equal(a.face, 0);
  assert.ok(a.flags & FLAGS.VISIBLE);
});

test('faceFrom covers four facings', () => {
  assert.equal(faceFrom(1, 1), 0);   // down screen
  assert.equal(faceFrom(0, 1), 1);   // sx<0, sy>0
  assert.equal(faceFrom(-2, -1), 2);
  assert.equal(faceFrom(1, 0), 0);
  assert.equal(faceFrom(1, -2), 3);
  assert.equal(faceFrom(0, -1), 3);
  assert.equal(faceFrom(-1, 0), 2);
});

test('stepAlongPath moves, sets px/py, face, anim', () => {
  const a = makeActor({ id: 'a', x: 0, y: 0, path: new Float32Array([2, 0, 2, 2]), pathI: 0 });
  assert.equal(stepAlongPath(a, 0.5, 2), false);
  assert.equal(a.x, 1); assert.equal(a.y, 0); assert.equal(a.px, 0);
  assert.equal(a.anim, 'walk'); assert.equal(a.face, 0);
  assert.equal(stepAlongPath(a, 0.5, 2), false); // reaches (2,0) exactly, waypoint consumed
  assert.equal(a.x, 2);
});

test('stepAlongPath carries leftover across waypoints and finishes', () => {
  const a = makeActor({ id: 'a', x: 0, y: 0, path: new Float32Array([1, 0, 1, 1]), pathI: 0 });
  assert.equal(stepAlongPath(a, 1, 1.5), false);
  assert.ok(Math.abs(a.x - 1) < 1e-6 && Math.abs(a.y - 0.5) < 1e-6);
  assert.equal(a.face, 1);
  assert.equal(stepAlongPath(a, 1, 1.5), true);
  assert.equal(a.x, 1); assert.equal(a.y, 1);
  assert.equal(stepAlongPath(a, 1, 1.5), true);
});

test('stepAlongPath without path is a no-op', () => {
  const a = makeActor({ id: 'a', x: 1, y: 1 });
  assert.equal(stepAlongPath(a, 1, 1), false);
  assert.equal(a.x, 1); assert.equal(a.anim, 'idle');
});
