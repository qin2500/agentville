import test from 'node:test';
import assert from 'node:assert/strict';
import * as tree from '../web/src/engine/art/props/tree.js';
import * as pine from '../web/src/engine/art/props/pine.js';
import * as sapling from '../web/src/engine/art/props/sapling.js';

const W = 200, H = 200, FX = 100, FY = 120;
function fakeCtx() {
  const buf = new Uint8ClampedArray(W * H * 4);
  return {
    buf,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(img, x, y) {
      for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) {
        const s = (j * img.width + i) * 4, X = x + i, Y = y + j;
        if (img.data[s + 3] === 0) continue;
        assert.ok(X >= 0 && Y >= 0 && X < W && Y < H, 'inside test canvas');
        buf.set(img.data.subarray(s, s + 4), (Y * W + X) * 4);
      }
    },
    fillRect() { throw new Error('unexpected fillRect'); },
  };
}

for (const mod of [tree, pine, sapling]) {
  test(`${mod.name}: seam`, () => {
    assert.ok(Number.isInteger(mod.frames) && mod.frames >= 1);
    for (let v = 0; v < 4; v++) {
      const [x0, y0, x1, y1] = mod.extent({ kind: mod.name, v }, null);
      assert.ok([x0, y0, x1, y1].every(Number.isFinite) && x0 < x1 && y0 < y1);
      const g = fakeCtx();
      mod.draw(g, { kind: mod.name, v }, FX, FY, 0, false, null);
      let n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (g.buf[(y * W + x) * 4 + 3] === 0) continue;
        n++;
        assert.ok(x >= FX + x0 && x < FX + x1 && y >= FY + y0 && y < FY + y1, `pixel outside extent v${v}`);
      }
      assert.ok(n > 100, 'draws opaque pixels');
      const g2 = fakeCtx(); mod.draw(g2, { kind: mod.name, v }, FX, FY, 5, true, null);
      assert.deepEqual(g2.buf, g.buf, 'deterministic, lit ignored');
    }
  });
}
test('variants differ and heights are plausible', () => {
  for (const [mod, lo, hi] of [[tree, 44, 56], [pine, 54, 66], [sapling, 30, 40]]) {
    const imgs = [];
    for (let v = 0; v < 4; v++) {
      const g = fakeCtx(); mod.draw(g, { v }, FX, FY, 0, false, null);
      let top = H; for (let y = 0; y < H && top === H; y++) for (let x = 0; x < W; x++) if (g.buf[(y * W + x) * 4 + 3] === 255) { top = y; break; }
      assert.ok(FY - top >= lo && FY - top <= hi, `${mod.name} v${v} height ${FY - top}`);
      imgs.push(Buffer.from(g.buf).toString('base64'));
    }
    assert.equal(new Set(imgs).size, 4);
  }
});
