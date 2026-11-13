// Engine v2: camera helpers and the snapshot adapter (A1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldToCss, cssToWorld, fitCamera, stepZoom, zoomAt, clampCamera, ZOOMS } from '../web/src/engine/camera.js';
import { makeView, viewFromFixture } from '../web/src/engine/snapshot.js';

const vp = { w: 1440, h: 900 };

test('camera: the view centre maps to the viewport centre and back', () => {
  const cam = { x: 10.5, y: -3.25, z: 2 };
  assert.deepEqual(worldToCss(cam, vp, cam.x, cam.y), { x: 720, y: 450 });
  const p = worldToCss(cam, vp, 14, 2), w = cssToWorld(cam, vp, p.x, p.y);
  assert.ok(Math.abs(w.tx - 14) < 1e-9 && Math.abs(w.ty - 2) < 1e-9);
});

test('camera: one tile east is +16 px x and +8 px y per zoom step', () => {
  const cam = { x: 0, y: 0, z: 3 };
  const a = worldToCss(cam, vp, 0, 0), b = worldToCss(cam, vp, 1, 0);
  assert.deepEqual([b.x - a.x, b.y - a.y], [48, 24]);
});

test('camera: fit picks the largest zoom that shows the rect, Map levels when needed', () => {
  assert.equal(fitCamera({ ox: 0, oy: 0, w: 10, h: 10 }, vp).z, 2);
  const big = fitCamera({ ox: -100, oy: -100, w: 200, h: 200 }, vp);
  assert.ok(big.z < 1 && ZOOMS.includes(big.z));
  const c = fitCamera({ ox: 0, oy: 0, w: 10, h: 10 }, vp);
  assert.ok(Math.abs(c.x - 5) < 1e-9 && Math.abs(c.y - 5) < 1e-9);
});

test('camera: zoom steps and anchored zoom keep the point under the pointer', () => {
  assert.equal(stepZoom(0.25, 1), 1); assert.equal(stepZoom(4, 1), 4); assert.equal(stepZoom(1, -1), 0.5); assert.equal(stepZoom(3, -1), 2);
  const cam = { x: 3, y: 4, z: 1 }, anchor = { x: 100, y: 700 };
  const before = cssToWorld(cam, vp, anchor.x, anchor.y), after = cssToWorld(zoomAt(cam, vp, 3, anchor), vp, anchor.x, anchor.y);
  assert.ok(Math.abs(before.tx - after.tx) < 1e-9 && Math.abs(before.ty - after.ty) < 1e-9);
  assert.deepEqual(clampCamera({ x: 500, y: -500, z: 1 }, { ox: 0, oy: 0, w: 10, h: 10 }, 2), { x: 12, y: -2, z: 1 });
});

test('snapshot: only the fields the engine reads, quiet projects removed, nothing mutated', () => {
  const now = 1_800_000_000_000;
  const agents = [
    { id: 'a', name: 'A', project: 'p1', bucket: 'building', role: 'boss', prs: [{ id: 12, title: 'x' }], lastActivityAt: now - 60e3, secret: 'no' },
    { id: 'b', name: 'B', project: 'p2', bucket: 'resting', role: 'boss', prs: [], lastActivityAt: now - 5 * 864e5 },
  ];
  const frozen = JSON.stringify(agents);
  const v = makeView({ agents, projects: [{ name: 'p1', prs: [{ id: 12, live: 1 }], transcriptBytes: 5, extra: 1 }], hideQuiet: true }, { now });
  assert.equal(JSON.stringify(agents), frozen);
  assert.deepEqual(v.agents.map(a => a.id), ['a']);
  assert.deepEqual(v.quiet, ['p2']);
  assert.equal(v.agents[0].secret, undefined);
  assert.equal(v.agents[0].prs[0].id, '12');
  assert.deepEqual(v.projects[0], { name: 'p1', prs: [{ id: '12', live: true }], transcriptBytes: 5, agentsEver: 0 });
  assert.ok(v.byId.has('b'));
  const f = viewFromFixture({ v: 1, now, agents, projects: [], dock: null });
  assert.equal(f.now, now);
  assert.deepEqual(f.dock, { loading: [], sailed: [], total: 0, level: 1 });
});
