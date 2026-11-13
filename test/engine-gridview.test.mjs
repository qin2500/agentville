import test from 'node:test';
import assert from 'node:assert/strict';
import { drawGridDebug } from '../web/src/engine/debug/grid-view.js';

function fakeCtx() {
  const c = { calls: [], fills: 0, texts: [], moves: [], fillStyle: '', strokeStyle: '' };
  for (const m of ['beginPath', 'closePath', 'lineTo', 'stroke', 'fillRect', 'arc']) c[m] = () => {};
  c.moveTo = (x, y) => c.moves.push([x, y]);
  c.fill = () => { c.fills++; c.calls.push(c.fillStyle); };
  c.fillText = t => c.texts.push(t);
  return c;
}
function fakeWorld() {
  const w = 8, h = 8, n = w * h;
  const grid = { ox: 0, oy: 0, w, h, terrain: new Uint8Array(n).fill(3), ground: new Uint8Array(n), road: new Uint8Array(n),
    edges: new Uint8Array(n), cost: new Uint8Array(n).fill(1), cover: new Uint8Array(n), lot: new Int32Array(n).fill(-1), occ: new Int32Array(n) };
  grid.ground[9] = 2; grid.occ[10] = 1; grid.cost[10] = 255; grid.cover[11] = 60; grid.edges[12] = 3; grid.lot[13] = 2;
  const objects = { byNum: n => n === 1 ? { kind: 'building', door: { tx: 2, ty: 1 } } : null };
  return { grid, objects };
}
const view = (cam, mode) => ({ cam, cssW: 400, cssH: 300, mode });

test('modes draw without throwing', () => {
  for (const mode of ['ground', 'walk', 'cover', 'lot']) {
    const r = drawGridDebug(fakeCtx(), fakeWorld(), view({ x: 4, y: 4, z: 2 }, mode));
    assert.ok(r.drawn > 0, mode);
  }
});
test('far camera culls everything', () => {
  const ctx = fakeCtx();
  assert.equal(drawGridDebug(ctx, fakeWorld(), view({ x: 500, y: -500, z: 1 }, 'ground')).drawn, 0);
});
test('fills are batched by colour', () => {
  const ctx = fakeCtx();
  drawGridDebug(ctx, fakeWorld(), view({ x: 4, y: 4, z: 1 }, 'ground'));
  assert.ok(ctx.fills <= new Set(ctx.calls).size + 1);
  assert.ok(ctx.fills <= 10);
});
test('tile corner placement for known camera', () => {
  const ctx = fakeCtx();
  drawGridDebug(ctx, fakeWorld(), view({ x: 0, y: 0, z: 1 }, 'ground'));
  // tile (0,0) N corner sits at the viewport centre (200,150), one px above for seam overlap
  assert.ok(ctx.moves.some(([x, y]) => x === 200 && y === 149));
  const ctx2 = fakeCtx();
  drawGridDebug(ctx2, fakeWorld(), view({ x: 0, y: 0, z: 2 }, 'ground'));
  // tile (1,0) N corner: toScreen = (16, 8) * 2 + centre
  assert.ok(ctx2.moves.some(([x, y]) => x === 232 && y === 165));
});
test('legend names the mode', () => {
  const ctx = fakeCtx();
  drawGridDebug(ctx, fakeWorld(), view({ x: 4, y: 4, z: 1 }, 'cover'));
  assert.ok(ctx.texts.includes('grid: cover'));
});

test('ground colours come from world.mod.terrain; engine codes 200+ keep fixed colours; unknown codes are grey', () => {
  const w = fakeWorld();
  w.grid.ground.fill(0); w.grid.ground[9] = 5; w.grid.ground[14] = 6; w.grid.ground[11] = 201;
  w.mod = { terrain: { types: [{ code: 5, name: 'a', cost: 1, color: '#123456' }] } };
  const ctx = fakeCtx();
  drawGridDebug(ctx, w, view({ x: 4, y: 4, z: 1 }, 'ground'));
  assert.ok(ctx.calls.includes('#123456'), 'mod colour');
  assert.ok(ctx.calls.includes('#808080'), 'code 6 has no colour: grey');
  assert.ok(ctx.calls.includes('#6b4a2a'), 'engine DOCK 201');
  const ctx2 = fakeCtx(); const w2 = fakeWorld(); w2.grid.ground[9] = 5;
  drawGridDebug(ctx2, w2, view({ x: 4, y: 4, z: 1 }, 'ground'));   // no world.mod at all
  assert.ok(ctx2.calls.includes('#808080') && !ctx2.calls.includes('#123456'));
});
