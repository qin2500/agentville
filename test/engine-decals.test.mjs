import test from 'node:test';
import assert from 'node:assert/strict';
import { PROPS } from '../web/src/engine/art/props/index.js';

class FakeCtx {
  constructor(w, h) { this.w = w; this.h = h; this.data = new Uint8ClampedArray(w * h * 4); }
  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData(img, dx, dy) {
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4, X = x + dx, Y = y + dy;
      if (!img.data[s + 3]) continue;
      if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) { this.oob = true; continue; }
      this.data.set(img.data.subarray(s, s + 4), (Y * this.w + X) * 4);
    }
  }
}
const W = 200, H = 160, FX = 100, FY = 100;
const NAMES = ['hay', 'crops', 'clover', 'sunflower', 'flowers'];
const MAXH = { hay: 15, crops: 17, clover: 12, sunflower: 20, flowers: 14 };

function render(m, v) { const g = new FakeCtx(W, H); m.draw(g, { kind: m.name, v }, FX, FY, 0, false, {}); return g; }

test('decal models resolve to art through the PROPS registry (what raster.js looks up)', () => {
  for (const n of NAMES) {
    assert.ok(Object.hasOwn(PROPS, n), n);
    assert.equal(PROPS[n].name, n);
    assert.ok(Number.isInteger(PROPS[n].frames) && PROPS[n].frames >= 1);
    assert.equal(typeof PROPS[n].draw, 'function');
  }
});

for (const n of NAMES) {
  test(`${n}: extent sane, flat, within one tile wide`, () => {
    const m = PROPS[n];
    for (let v = 0; v < 4; v++) {
      const e = m.extent({ v }, {});
      assert.equal(e.length, 4);
      assert.ok(e.every(Number.isFinite) && e[0] < e[2] && e[1] < e[3]);
      assert.ok(e[0] >= -16 && e[2] <= 16 && e[3] <= 8, `${n} extent leaves the tile`);
    }
  });

  test(`${n}: every variant paints opaque pixels only inside extent, deterministically`, () => {
    const m = PROPS[n], seen = new Set();
    for (let v = 0; v < 4; v++) {
      const g = render(m, v), e = m.extent({ v }, {});
      assert.ok(!g.oob);
      let cnt = 0, top = Infinity, bot = -Infinity;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!g.data[(y * W + x) * 4 + 3]) continue;
        cnt++; top = Math.min(top, y); bot = Math.max(bot, y);
        const rx = x - FX, ry = y - FY;
        assert.ok(rx >= e[0] && rx < e[2] && ry >= e[1] && ry < e[3], `${n} v${v} pixel outside extent`);
        assert.equal(g.data[(y * W + x) * 4 + 3], 255);
      }
      assert.ok(bot - top + 1 <= MAXH[n], `${n} v${v} too tall for a decal`);
      assert.ok(cnt > 25, `${n} v${v} drew too little (${cnt})`);
      assert.deepEqual(render(m, v).data, g.data);
      seen.add(Buffer.from(g.data).toString('base64'));
    }
    assert.ok(seen.size >= 3, `${n} variants should differ`);
  });
}
