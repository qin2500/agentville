// Engine v2 R5: Canvas2D Gfx backend, against a recording fake context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGfx, worldToDevice } from '../web/src/engine/render/gfx-canvas2d.js';
import { worldToCss } from '../web/src/engine/camera.js';
import { toScreen } from '../web/src/engine/core/coords.js';

function fake(cssW = 800, cssH = 600) {
  const calls = [];
  const ctx = new Proxy({ globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true }, {
    get(t, k) { return k in t ? t[k] : (...a) => { calls.push([k, ...a]); }; },
    set(t, k, v) { t[k] = v; calls.push(['set:' + k, v]); return true; },
  });
  const canvas = { width: 0, height: 0, clientWidth: cssW, clientHeight: cssH, getContext: () => ctx };
  return { canvas, ctx, calls };
}
const last = (calls, name) => calls.filter(c => c[0] === name).at(-1);

test('begin sizes the canvas to device px and maps world to CSS like worldToCss', () => {
  const { canvas, calls, ctx } = fake();
  const g = createGfx(canvas);
  const cam = { x: 7.5, y: 3, z: 2 };
  g.begin(2, cam);
  assert.deepEqual([canvas.width, canvas.height], [1600, 1200]);
  assert.equal(ctx.imageSmoothingEnabled, false);
  const [, a, b, c, d, e, f] = last(calls, 'setTransform');
  assert.deepEqual([a, b, c, d], [4, 0, 0, 4]);
  for (const [tx, ty] of [[0, 0], [10, 4], [7.5, 3]]) {
    const p = toScreen(tx, ty), css = worldToCss(cam, { w: 800, h: 600 }, tx, ty);
    assert.ok(Math.abs((p.sx * a + e) / 2 - css.x) < 0.5 && Math.abs((p.sy * d + f) / 2 - css.y) < 0.5);
  }
});

test('translation is integer at integer zoom, exact at fractional zoom', () => {
  const v = { cssW: 801, cssH: 601, dpr: 1.5 };
  const t = worldToDevice({ x: 1.3, y: 0.7, z: 3 }, v);
  assert.ok(Number.isInteger(t.tx) && Number.isInteger(t.ty));
  assert.equal(t.scale, 4.5);
  const u = worldToDevice({ x: 1.3, y: 0.7, z: 0.25 }, v);
  assert.ok(!Number.isInteger(u.tx) || !Number.isInteger(u.ty));
});

test('view centre lands on the device centre', () => {
  const t = worldToDevice({ x: 4, y: 4, z: 1 }, { cssW: 800, cssH: 600, dpr: 1 });
  const c = toScreen(4, 4);
  assert.equal(c.sx * t.scale + t.tx, 400);
  assert.equal(c.sy * t.scale + t.ty, 300);
});

test('clear, rect, poly, image, composite, end', () => {
  const { canvas, calls, ctx } = fake();
  const g = createGfx(canvas);
  g.begin(1, { x: 0, y: 0, z: 1 });
  g.clear('#123');
  assert.deepEqual(last(calls, 'fillRect'), ['fillRect', 0, 0, 800, 600]);
  g.clear();
  assert.ok(last(calls, 'clearRect'));
  g.rect(1, 2, 3, 4, 'red');
  assert.deepEqual(last(calls, 'fillRect'), ['fillRect', 1, 2, 3, 4]);
  g.poly([0, 0, 16, 8, 0, 16], 'blue');
  assert.equal(calls.filter(c => c[0] === 'lineTo').length, 2);
  assert.ok(last(calls, 'fill'));
  g.image('IMG', 0, 0, 8, 8, 10, 10, 8, 8, 0.5);
  assert.deepEqual(last(calls, 'drawImage'), ['drawImage', 'IMG', 0, 0, 8, 8, 10, 10, 8, 8]);
  assert.equal(ctx.globalAlpha, 1);
  const n = calls.length;
  g.image('IMG', 0, 0, 8, 8, 0, 0, 8, 8, 0);
  assert.equal(calls.length, n);
  g.setComposite('multiply');
  assert.equal(ctx.globalCompositeOperation, 'multiply');
  g.end();
  assert.equal(ctx.globalCompositeOperation, 'source-over');
  assert.deepEqual(last(calls, 'setTransform'), ['setTransform', 1, 0, 0, 1, 0, 0]);
});

test('size reports css size and dpr', () => {
  const { canvas } = fake(640, 480);
  const g = createGfx(canvas);
  g.begin(2, { x: 0, y: 0, z: 1 });
  assert.deepEqual(g.size(), { cssW: 640, cssH: 480, dpr: 2 });
});
