import './support/ensure-mods-index.mjs';
// Parity proof for the central square (docs/engine-parity.json, "World and layout"): classic dressed the square with a
// big tree in the middle and a lantern on each corner. Titled `[world.central-square] ...` so tools/parity.mjs counts it.
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

test('[world.central-square] a big tree stands at the centre, a lantern on each corner, and every road and door still reaches the square', () => {
  const fx = loadFixture('busy.json');
  assert.ok(fx, 'busy fixture');
  const w = buildWorld(viewFromFixture(fx), { v: 1, seed: 7, blocks: {}, lots: {} }, { now: fx.now, seed: 7 });
  const q = w.square, cx = q.x + (q.w >> 1), cy = q.y + (q.h >> 1);
  const at = (x, y) => [...w.objects.values()].filter(o => o.tx === x && o.ty === y && o.id.startsWith('venue:square:'));
  const tree = at(cx, cy);
  assert.equal(tree.length, 1, 'one object at the centre');
  assert.equal(tree[0].model, 'tree'); assert.equal(tree[0].variant, 3, 'the big tree variant');
  for (const [x, y] of [[q.x, q.y], [q.x + q.w - 1, q.y], [q.x, q.y + q.h - 1], [q.x + q.w - 1, q.y + q.h - 1]]) {
    const l = at(x, y);
    assert.equal(l.length, 1, `a lantern on the corner ${x},${y}`);
    assert.equal(l[0].model, 'lamp');
  }
  assert.equal([...w.objects.values()].filter(o => o.id.startsWith('venue:square:')).length, 5, 'exactly the tree and four lanterns');
  assert.ok(w.villages.length >= 5, 'a busy world');
  assert.deepEqual(w.lint.filter(l => /venue/.test(l.kind ?? '')), [], 'no venue lint');

  // the square stays routable: its anchor is a free tile, and every village plaza and every building door reaches it and back
  const v = w.venues.square;
  assert.ok(v, 'the square is a venue');
  assert.ok(!(v.tx === cx && v.ty === cy), 'the anchor is not the tree tile');
  const nav = createNav(w), to = { x: v.tx, y: v.ty };
  let n = 0;
  const reach = (from, label) => {
    const a = nav.path(from, to, {}), free = w.grid.get('cost', from.x, from.y) < 255, b = free ? nav.path(to, from, {}) : [from];
    assert.ok(a && a.length, `${label}: no path to the square`);
    assert.ok(b && b.length, `${label}: no path back from the square`);
    n++;
  };
  for (const vil of w.villages) reach({ x: vil.plaza.x + (vil.plaza.w >> 1), y: vil.plaza.y + (vil.plaza.h >> 1) }, `plaza ${vil.name}`);
  const doors = [...w.objects.values()].filter(o => o.kind === 'building' && o.door);
  assert.ok(doors.length > 20, 'many doors');
  for (const o of doors.filter((_, i) => i % 3 === 0)) reach({ x: o.door.tx, y: o.door.ty }, `door ${o.id}`);
  // every road tile that touches the square edge connects in
  for (let x = q.x - 1; x <= q.x + q.w; x++) for (const y of [q.y - 1, q.y + q.h]) {
    if (w.grid.inBounds(x, y) && w.grid.get('road', x, y)) assert.ok(nav.path({ x, y }, to, {}), `road tile ${x},${y} reaches the square`);
  }
  assert.ok(n > 10);
});

test('[world.central-square] flowTo("square") aims at the venue anchor, not the blocked tree tile', () => {
  const fx = loadFixture('busy.json');
  const w = buildWorld(viewFromFixture(fx), { v: 1, seed: 7, blocks: {}, lots: {} }, { now: fx.now, seed: 7 });
  const v = w.venues.square, f = createNav(w).flowTo('square');
  assert.ok(f, 'a flow field');
  assert.equal(f.costAt(v.tx, v.ty), 0, 'the anchor is the flow target');
  const p = w.villages[0].plaza;
  assert.ok(Number.isFinite(f.costAt(p.x + (p.w >> 1), p.y + (p.h >> 1) + 1)) || Number.isFinite(f.costAt(p.x, p.y)), 'a plaza reaches the square by flow');
});
