import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { createSlots } = await import('../web/src/engine/nav/slots.js');
const { syntheticViews, NOW } = await import('./engine-support/world-views.mjs');

const [, view, now] = syntheticViews().find(v => v[0] === 'synthetic-mixed');
const world = buildWorld(view, { v: 1, seed: 7, blocks: {}, lots: {} }, { now: now ?? NOW, seed: 7 });
const door = [...world.objects.values()].find(o => o.anchors?.stand);

test('slots: every door yields stand slots on its door tile, up to 4 per tile', () => {
  assert.ok(door, 'a building with a stand anchor exists');
  const s = createSlots(world);
  const here = s.all().filter(x => x.kind === 'stand' && x.tx === door.door.tx && x.ty === door.door.ty);
  assert.ok(here.length >= 2 && here.length <= 4);
  assert.equal(new Set(here.map(x => x.sub)).size, here.length);
  for (const x of s.all()) assert.ok([0, 1, 2, 3].includes(x.sub));
});

test('slots: claim is exclusive and idempotent', () => {
  const s = createSlots(world);
  const id = s.all().find(x => x.kind === 'stand').id;
  const a = s.claim(id, 'a1');
  assert.equal(a.id, id);
  assert.equal(s.claim(id, 'a1').id, id);
  assert.equal(s.claim(id, 'a2'), null);
  assert.equal(s.claim('nope', 'a2'), null);
  s.release('a1');
  assert.equal(s.claim(id, 'a2').id, id);
});

test('slots: an actor holds at most one slot', () => {
  const s = createSlots(world);
  const [x, y] = s.all().filter(q => q.kind === 'stand');
  s.claim(x.id, 'a1');
  s.claim(y.id, 'a1');
  assert.equal(s.claim(x.id, 'a2').id, x.id, 'first slot was released');
  assert.equal(s.claim(y.id, 'a2'), null);
});

test('slots: failed claim keeps the actor existing slot', () => {
  const s = createSlots(world);
  const [x, y] = s.all();
  s.claim(x.id, 'a1'); s.claim(y.id, 'a2');
  assert.equal(s.claim(y.id, 'a1'), null);
  assert.equal(s.claim(x.id, 'a1').id, x.id);
});

test('slots: nearestFree is nearest, skips claimed, filters by kind, ties break by id', () => {
  const s = createSlots(world);
  const t = { tx: door.door.tx, ty: door.door.ty };
  const first = s.nearestFree(t.tx, t.ty, 'stand');
  assert.equal(first.tx, t.tx); assert.equal(first.ty, t.ty);
  const all = s.all().filter(x => x.kind === 'stand' && x.tx === first.tx && x.ty === first.ty).map(x => x.id).sort();
  assert.equal(first.id, all[0]);
  s.claim(first.id, 'a1');
  assert.notEqual(s.nearestFree(t.tx, t.ty, 'stand').id, first.id);
  for (const k of ['stand', 'work', 'sit', 'vend']) { const n = s.nearestFree(t.tx, t.ty, k); if (n) assert.equal(n.kind, k); }
  assert.equal(createSlots({ objects: new Map() }).nearestFree(0, 0, 'stand'), null);
});

test('slots: exhausting a tile moves nearestFree elsewhere; release frees', () => {
  const s = createSlots(world);
  const t = door.door;
  const ids = s.all().filter(x => x.kind === 'stand' && x.tx === t.tx && x.ty === t.ty);
  ids.forEach((x, i) => s.claim(x.id, `a${i}`));
  const n = s.nearestFree(t.tx, t.ty, 'stand');
  assert.ok(n && !(n.tx === t.tx && n.ty === t.ty));
  s.release('a0');
  const back = s.nearestFree(t.tx, t.ty, 'stand');
  assert.ok(back.tx === t.tx && back.ty === t.ty);
});

test('slots: object anchors work/sit/vend are ingested', () => {
  const w = { objects: new Map([['o1', { id: 'o1', anchors: { sit: [{ tx: 3, ty: 4, sub: 1, face: 0 }], work: [{ tx: 5, ty: 5, sub: 0, face: 0 }] } }]]) };
  const s = createSlots(w);
  assert.equal(s.nearestFree(0, 0, 'sit').tx, 3);
  assert.equal(s.nearestFree(0, 0, 'work').tx, 5);
  assert.equal(s.nearestFree(0, 0, 'vend'), null);
});
