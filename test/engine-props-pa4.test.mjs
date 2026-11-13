import test from 'node:test';
import assert from 'node:assert/strict';
import * as laundry from '../web/src/engine/art/props/laundry.js';
import * as scarecrow from '../web/src/engine/art/props/scarecrow.js';

const W = 160, H = 160, OX = 80, OY = 100;
function fakeCtx() {
  const buf = new Uint8ClampedArray(W * H * 4);
  return {
    buf,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(img, x, y) {
      for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) {
        const s = (j * img.width + i) * 4; if (!img.data[s + 3]) continue;
        const px = OX + x + i, py = OY + y + j;
        assert.ok(px >= 0 && py >= 0 && px < W && py < H, 'write inside test canvas');
        buf.set(img.data.subarray(s, s + 4), (py * W + px) * 4);
      }
    },
    fillRect() { throw new Error('unexpected fillRect'); },
  };
}

for (const m of [laundry, scarecrow]) {
  test(`${m.name}: seam`, () => {
    assert.ok(Number.isInteger(m.frames) && m.frames >= 1);
    for (let v = 0; v < 4; v++) {
      const [x0, y0, x1, y1] = m.extent({ kind: m.name, v, dir: 'x', len: 1 }, null);
      assert.ok([x0, y0, x1, y1].every(Number.isFinite) && x0 < x1 && y0 < y1);
    }
  });
  for (const lit of [false, true]) for (let v = 0; v < 4; v++) {
    test(`${m.name} v${v} lit=${lit}: opaque, inside extent, deterministic`, () => {
      const p = { kind: m.name, v, dir: 'x', len: 1 };
      const [x0, y0, x1, y1] = m.extent(p, null);
      const a = fakeCtx(), b = fakeCtx();
      m.draw(a, p, 0, 0, 0, lit, null); m.draw(b, p, 0, 0, 0, lit, null);
      assert.deepEqual(a.buf, b.buf);
      let n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!a.buf[(y * W + x) * 4 + 3]) continue;
        n++;
        const dx = x - OX, dy = y - OY;
        assert.ok(dx >= x0 && dx < x1 && dy >= y0 && dy < y1, `pixel ${dx},${dy} outside extent`);
      }
      assert.ok(n > 40);
    });
  }
}
