import test from 'node:test';
import assert from 'node:assert/strict';
import * as cart from '../web/src/engine/art/props/cart.js';
import * as barrel from '../web/src/engine/art/props/barrel.js';
import * as crate from '../web/src/engine/art/props/crate.js';

const W = 160, H = 160, FX = 80, FY = 100;
function fakeCtx() {
  const buf = new Uint8ClampedArray(W * H * 4);
  return {
    buf,
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
    putImageData(im, dx, dy) {
      for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
        const s = (y * im.width + x) * 4, X = dx + x, Y = dy + y;
        if (im.data[s + 3] === 0) continue;
        assert.ok(X >= 0 && Y >= 0 && X < W && Y < H, 'inside test canvas');
        const o = (Y * W + X) * 4; for (let k = 0; k < 4; k++) buf[o + k] = im.data[s + k];
      }
    },
    fillRect() { throw new Error('unexpected fillRect'); },
  };
}
for (const m of [cart, barrel, crate]) {
  test(`${m.name} seam`, () => {
    assert.ok(Number.isInteger(m.frames) && m.frames >= 1);
    for (const lit of [false, true]) for (let v = 0; v < 4; v++) {
      const p = { kind: m.name, v, dir: 'x', len: 1 };
      const [x0, y0, x1, y1] = m.extent(p, null);
      assert.ok([x0, y0, x1, y1].every(Number.isFinite) && x0 < x1 && y0 < y1);
      const a = fakeCtx(); m.draw(a, p, FX, FY, 0, lit, null);
      const b = fakeCtx(); m.draw(b, p, FX, FY, 0, lit, null);
      assert.deepEqual(a.buf, b.buf);
      let n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const al = a.buf[(y * W + x) * 4 + 3];
        if (!al) continue;
        n++; assert.equal(al, 255);
        const dx = x - FX, dy = y - FY;
        assert.ok(dx >= x0 && dx < x1 && dy >= y0 && dy < y1, `${m.name} v${v} pixel ${dx},${dy} outside extent`);
      }
      assert.ok(n > 40);
    }
  });
}
test('cart variants differ', () => {
  const s = v => { const c = fakeCtx(); cart.draw(c, { v }, FX, FY, 0, false, null); return Buffer.from(c.buf).toString('hex'); };
  assert.equal(new Set([0, 1, 2, 3].map(s)).size, 4);
});
