import './support/ensure-mods-index.mjs';
// R9 x-ray: spec = design §2.4 / §3.6 and the COMMON.md seam createXray({world}).
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { createXray } = await import('../web/src/engine/render/xray.js');
const { syntheticViews } = await import('./engine-support/world-views.mjs');

const [, view, now] = syntheticViews()[0];
const world = buildWorld(view, { v: 1, seed: 7, blocks: {}, lots: {} }, { now, seed: 7 });
const g = world.grid;
const xray = createXray({ world });
const tiles = pred => { const o = []; for (let y = g.oy; y < g.oy + g.h; y++) for (let x = g.ox; x < g.ox + g.w; x++) if (pred(x, y)) o.push([x, y]); return o; };
const covered = tiles((x, y) => g.get('cover', x, y) > 0);
const clear = tiles((x, y) => g.get('cover', x, y) === 0 && g.get('cost', x, y) < 255);
const actorAt = ([x, y], extra = {}) => ({ id: `a${x},${y}`, x: x + 0.5, y: y + 0.5, flags: 1, ...extra });
const fakeGfx = () => { const calls = []; return { calls, rect: (...a) => calls.push(['rect', ...a]), poly: (...a) => calls.push(['poly', ...a]), image: () => calls.push(['image']) }; };
const withCover = covered.find(t => xray.coveringIds(actorAt(t)).length > 0);

test('fixture world has covered and clear tiles', () => { assert.ok(covered.length > 0); assert.ok(clear.length > 0); });

test('occluded follows grid.cover at the actor tile', () => {
  for (const t of covered.slice(0, 20)) assert.equal(xray.occluded(actorAt(t), world), true);
  for (const t of clear.slice(0, 20)) assert.equal(xray.occluded(actorAt(t), world), false);
});

test('occluded is false for null and out-of-grid actors', () => {
  assert.equal(xray.occluded(null), false);
  assert.equal(xray.occluded({ x: 99999, y: 99999 }), false);
});

test('fadeFor reduces alpha for a building hiding a selected actor, not for others', () => {
  assert.ok(withCover, 'a covered tile has a covering building');
  const ids = xray.coveringIds(actorAt(withCover));
  const b = world.objects.get(ids[0]);
  assert.equal(xray.fadeFor(b, [actorAt(withCover)]), 1, 'plain actor: no fade');
  const sel = actorAt(withCover, { flags: 1 | 2 });
  const a = xray.fadeFor(b, [sel]);
  assert.ok(a < 1 && a > 0);
  const stalled = actorAt(withCover, { status: { bucket: 'stalled' } });
  assert.equal(xray.fadeFor(b, [stalled]), a);
  const other = [...world.objects.values()].find(o => o.kind === 'building' && !ids.includes(o.id));
  if (other) assert.equal(xray.fadeFor(other, [sel]), 1);
});

test('fadeFor ignores a selected actor on a clear tile and non-buildings', () => {
  const b = [...world.objects.values()].find(o => o.kind === 'building');
  assert.equal(xray.fadeFor(b, [actorAt(clear[0], { flags: 3 })]), 1);
  const prop = [...world.objects.values()].find(o => o.kind !== 'building');
  if (prop && withCover) assert.equal(xray.fadeFor(prop, [actorAt(withCover, { flags: 3 })]), 1);
});

test('draw paints silhouettes only for occluded actors, selected stronger', () => {
  const gfx = fakeGfx();
  const n = xray.draw(gfx, {}, [actorAt(clear[0]), actorAt(withCover)]);
  assert.equal(n, 1);
  assert.ok(gfx.calls.length >= 1 && gfx.calls.every(c => c[0] === 'rect'));
  const alphaOf = c => Number(/,([\d.]+)\)$/.exec(c[5])[1]);
  const g2 = fakeGfx();
  xray.draw(g2, {}, [actorAt(withCover, { flags: 3 })]);
  assert.ok(alphaOf(g2.calls[1]) > alphaOf(gfx.calls[1]));
});

test('draw is capped at 32 and does not mutate actors', () => {
  const as = Array.from({ length: 50 }, (_, i) => actorAt(withCover, { id: `x${i}` }));
  const snap = JSON.stringify(as);
  assert.equal(xray.draw(fakeGfx(), {}, as), 32);
  assert.equal(JSON.stringify(as), snap);
});
