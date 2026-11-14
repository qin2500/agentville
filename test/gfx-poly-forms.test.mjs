// B1: gfx.poly accepts flat, {x,y} and nested [[x,y]] points and draws the same path. Plus ground colours from mod classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGfx } from '../web/src/engine/render/gfx-canvas2d.js';
import { createGround } from '../web/src/engine/render/ground.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';

const run = pts => {
  const ops = [];
  const ctx = new Proxy({}, { get: (t, k) => typeof t[k] !== 'undefined' ? t[k] : (...a) => ops.push([k, ...a]), set: (t, k, v) => (t[k] = v, true) });
  createGfx({ getContext: () => ctx, width: 10, height: 10 }).poly(pts, '#123456');
  return ops;
};

test('poly: flat, {x,y} and nested [[x,y]] produce the same path', () => {
  const flat = run([0, 0, 16, 8, 0, 16, -16, 8]);
  const objs = run([{ x: 0, y: 0 }, { x: 16, y: 8 }, { x: 0, y: 16 }, { x: -16, y: 8 }]);
  const nested = run([[0, 0], [16, 8], [0, 16], [-16, 8]]);
  assert.deepEqual(flat.map(o => o[0]), ['beginPath', 'moveTo', 'lineTo', 'lineTo', 'lineTo', 'closePath', 'fill']);
  assert.deepEqual(objs, flat);
  assert.deepEqual(nested, flat);
  assert.deepEqual(nested[1], ['moveTo', 0, 0]);
});

test('poly: fewer than 3 points draws nothing', () => {
  assert.deepEqual(run([[0, 0], [1, 1]]), []);
});

test('ground colours: mod terrain classes win, LAYOUT_GROUND codes and fallbacks apply', () => {
  const grid = new WorldGrid({ ox: 0, oy: 0, w: 2, h: 1 });
  grid.terrain[0] = 3; grid.terrain[1] = 3; grid.ground[1] = 202;
  const polys = [];
  const gfx = { poly: (p, c) => polys.push(c), image() {}, rect() {} };
  const draw = mod => { polys.length = 0; createGround({ world: { grid, mod, version: 1 }, createCanvas: () => ({}) }).drawChunks(gfx, { x: 1, y: 0, z: 0.1 }, { cssW: 1e4, cssH: 1e4 }); return polys.slice(); };
  assert.deepEqual(draw({ terrain: { classes: [{ code: 0, name: 'void' }, { code: 3, name: 'grass', color: '#010203' }] } }), ['#010203', '#e0c060']);
  assert.deepEqual(draw({}), ['#5f8a3c', '#e0c060']);
});
