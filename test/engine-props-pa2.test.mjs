import test from 'node:test';
import assert from 'node:assert/strict';
import * as bush from '../web/src/engine/art/props/bush.js';
import * as rock from '../web/src/engine/art/props/rock.js';
import * as hedge from '../web/src/engine/art/props/hedge.js';

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
  fillRect() { throw new Error('unexpected fillRect'); }
}

const W = 400, H = 300, FX = 150, FY = 150;
const cases = [];
for (const m of [bush, rock]) for (let v = 0; v < 4; v++) cases.push([m, { kind: m.name, v }]);
for (let v = 0; v < 4; v++) for (const dir of ['x', 'y']) for (const len of [1, 3]) cases.push([hedge, { kind: 'hedge', v, dir, len }]);

function render(m, p, lit = false) {
  const g = new FakeCtx(W, H);
  m.draw(g, p, FX, FY, 0, lit, {});
  return g;
}

test('seam: name and frames', () => {
  for (const m of [bush, rock, hedge]) {
    assert.equal(typeof m.name, 'string');
    assert.ok(Number.isInteger(m.frames) && m.frames >= 1);
  }
  assert.deepEqual([bush.name, rock.name, hedge.name], ['bush', 'rock', 'hedge']);
});

test('extent is finite and non-empty', () => {
  for (const [m, p] of cases) {
    const e = m.extent(p, {});
    assert.equal(e.length, 4);
    assert.ok(e.every(Number.isFinite));
    assert.ok(e[0] < e[2] && e[1] < e[3]);
  }
});

test('draws opaque pixels, only inside extent, deterministically', () => {
  for (const [m, p] of cases) for (const lit of [false, true]) {
    const g = render(m, p, lit), e = m.extent(p, {});
    assert.ok(!g.oob);
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!g.data[(y * W + x) * 4 + 3]) continue;
      n++;
      const rx = x - FX, ry = y - FY;
      assert.ok(rx >= e[0] && rx < e[2] && ry >= e[1] && ry < e[3], `${m.name} pixel outside extent`);
      assert.equal(g.data[(y * W + x) * 4 + 3], 255);
    }
    assert.ok(n > 20, `${m.name} drew too little`);
    assert.deepEqual(render(m, p, lit).data, g.data);
  }
});

test('hedge grows with len and dir changes the shape', () => {
  const a = hedge.extent({ v: 0, dir: 'x', len: 1 }), b = hedge.extent({ v: 0, dir: 'x', len: 3 });
  assert.ok(b[2] - b[0] > a[2] - a[0]);
  const y = hedge.extent({ v: 0, dir: 'y', len: 3 });
  assert.ok(y[0] < 0 && y[2] < b[2]);
});
