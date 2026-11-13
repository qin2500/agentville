import test from 'node:test';
import assert from 'node:assert/strict';
import * as lamp from '../web/src/engine/art/props/lamp.js';
import * as banner from '../web/src/engine/art/props/banner.js';
import * as railing from '../web/src/engine/art/props/railing.js';

const W = 400, H = 300, FX = 200, FY = 150;
function fakeCtx() {
  const d = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b, a) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; };
  return {
    d, fillStyle: '#000',
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData(img, x0, y0) { for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) { const k = (j * img.width + i) * 4; if (img.data[k + 3]) put(x0 + i, y0 + j, img.data[k], img.data[k + 1], img.data[k + 2], img.data[k + 3]); } },
    fillRect(x, y, w, h) { const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(this.fillStyle); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, +(m?.[1] ?? 0), +(m?.[2] ?? 0), +(m?.[3] ?? 0), 255); },
  };
}
const cases = [];
for (const v of [0, 1, 2, 3]) {
  cases.push([lamp, { kind: 'lamp', v }]);
  cases.push([banner, { kind: 'banner', v }]);
  for (const dir of ['x', 'y']) for (const len of [1, 3]) cases.push([railing, { kind: 'railing', v, dir, len }]);
}

for (const [m, p] of cases) {
  for (const lit of [false, true]) {
    test(`${m.name} ${JSON.stringify(p)} lit=${lit}`, () => {
      assert.ok(Number.isInteger(m.frames) && m.frames >= 1);
      const style = p.kind === 'banner' && p.v === 1 ? { accent: '#aa33cc' } : {};
      const [x0, y0, x1, y1] = m.extent(p, style);
      assert.ok([x0, y0, x1, y1].every(Number.isFinite) && x0 < x1 && y0 < y1);
      const run = () => { const g = fakeCtx(); m.draw(g, p, FX, FY, 0, lit, style); return g.d; };
      const a = run(), b = run();
      assert.deepEqual(Buffer.from(a), Buffer.from(b));
      let opaque = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!a[(y * W + x) * 4 + 3]) continue;
        opaque++;
        const rx = x - FX, ry = y - FY;
        assert.ok(rx >= x0 && rx < x1 && ry >= y0 && ry < y1, `pixel (${rx},${ry}) outside extent`);
      }
      assert.ok(opaque > 0);
    });
  }
}

test('banner accent tints the cloth, invalid accent falls back', () => {
  const draw = style => { const g = fakeCtx(); banner.draw(g, { kind: 'banner', v: 0 }, FX, FY, 0, false, style); return Buffer.from(g.d); };
  assert.notDeepEqual(draw({ accent: '#2233ff' }), draw({}));
  assert.deepEqual(draw({ accent: 'red' }), draw({}));
});
