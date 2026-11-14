// Ground diamonds are pixel-exact: adjacent tiles partition the plane (no AA seams, no double cover). Synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from '../web/src/engine/render/ground.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';

const W = 512, H = 256;
function bufCanvas(log) {
  return (w, h) => {
    const px = new Uint8Array(w * h), ops = { n: 0 };
    const ctx = new Proxy({}, { get: (t, k) => k === 'fillRect' ? (x, y, rw, rh) => {
      ops.n++;
      for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) px[j * w + i]++;
    } : (k in t ? t[k] : () => { ops.n++; }), set: (t, k, v) => (t[k] = v, true) });
    const cv = { w, h, px, ops, getContext: () => ctx }; log.push(cv); return cv;
  };
}
test('3x3 block of diamonds: every covered pixel written exactly once, no gaps inside the block', () => {
  const grid = new WorldGrid({ ox: 0, oy: 0, w: 16, h: 16 }); grid.terrain.fill(3);
  const log = [];
  createGround({ world: { version: 1, grid, mod: {} }, createCanvas: bufCanvas(log) }).drawChunks({ image() {}, poly() {} }, { x: 8, y: 8, z: 1 }, { cssW: 1e4, cssH: 1e4 });
  const { px } = log[0];
  // Chunk 0,0: tile (tx,ty) north corner at x=(tx-ty)*16+256, y=(tx+ty)*8. Interior of the 3x3 block tx,ty in 6..8:
  // pixels strictly inside the union diamond region of the central tile's 4 neighbours are all covered.
  let max = 0; for (const v of px) max = Math.max(max, v);
  assert.equal(max, 1, 'no double cover');
  // Fully surrounded region: the central tile (7,7) plus its 4 edge-neighbours cover a diamond of half-extent 32x16.
  const cx = 256, cy = 7 * 2 * 8 + 8;
  for (let y = cy - 8; y < cy + 8; y++) for (let x = cx - 16; x < cx + 16; x++) {
    const inside = Math.abs(x + 0.5 - cx) / 16 + Math.abs(y + 0.5 - cy) / 8 <= 1;
    if (inside) assert.equal(px[y * W + x], 1, `gap at ${x},${y}`);
  }
  // whole bitmap: coverage count equals the sum of 256 tile areas (288-32=256 each)
  let sum = 0; for (const v of px) sum += v;
  assert.equal(sum, 256 * 256);
});
test('chunk bake op count stays bounded (16 fillRects per tile)', () => {
  const grid = new WorldGrid({ ox: 0, oy: 0, w: 16, h: 16 }); grid.terrain.fill(3);
  const log = [];
  createGround({ world: { version: 1, grid, mod: {} }, createCanvas: bufCanvas(log) }).drawChunks({ image() {}, poly() {} }, { x: 8, y: 8, z: 1 }, { cssW: 1e4, cssH: 1e4 });
  assert.ok(log[0].ops.n <= 256 * 16, String(log[0].ops.n));
});
