// Engine v2 art props: seam contract shared by every prop module (frames, extent, opaque pixels only inside the extent,
// deterministic output), table-driven over the five prop groups that used to live in engine-props-pa1..pa5.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as tree from '../web/src/engine/art/props/tree.js';
import * as pine from '../web/src/engine/art/props/pine.js';
import * as sapling from '../web/src/engine/art/props/sapling.js';
import * as bush from '../web/src/engine/art/props/bush.js';
import * as rock from '../web/src/engine/art/props/rock.js';
import * as hedge from '../web/src/engine/art/props/hedge.js';
import * as cart from '../web/src/engine/art/props/cart.js';
import * as barrel from '../web/src/engine/art/props/barrel.js';
import * as crate from '../web/src/engine/art/props/crate.js';
import * as laundry from '../web/src/engine/art/props/laundry.js';
import * as scarecrow from '../web/src/engine/art/props/scarecrow.js';
import * as lamp from '../web/src/engine/art/props/lamp.js';
import * as banner from '../web/src/engine/art/props/banner.js';
import * as railing from '../web/src/engine/art/props/railing.js';

const W = 400, H = 300, FX = 200, FY = 150;

// Minimal canvas: putImageData blits opaque pixels (out-of-canvas writes are recorded in `oob`); fillRect only when the
// group allows it (lamp/banner/railing draw rects with an rgb() fillStyle, the others must be pure putImageData).
function fakeCtx(allowFill) {
  const buf = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) { ctx.oob = true; return; }
    const i = (y * W + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  const ctx = {
    buf, oob: false, fillStyle: '#000',
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(img, x0, y0) {
      for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) {
        const k = (j * img.width + i) * 4;
        if (img.data[k + 3]) put(x0 + i, y0 + j, img.data[k], img.data[k + 1], img.data[k + 2], img.data[k + 3]);
      }
    },
    fillRect(x, y, w, h) {
      if (!allowFill) throw new Error('unexpected fillRect');
      const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(ctx.fillStyle);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, +(m?.[1] ?? 0), +(m?.[2] ?? 0), +(m?.[3] ?? 0), 255);
    },
  };
  return ctx;
}

const V4 = [0, 1, 2, 3];
const plain = m => V4.map(v => ({ kind: m.name, v }));
const runs = m => V4.flatMap(v => ['x', 'y'].flatMap(dir => [1, 3].map(len => ({ kind: m.name, v, dir, len }))));
const dirX = m => V4.map(v => ({ kind: m.name, v, dir: 'x', len: 1 }));

// group: modules, how to build the param sets, the style handed to extent/draw, the minimum opaque pixels per draw,
// whether every opaque pixel must be fully opaque, and whether fillRect is allowed.
const GROUPS = {
  trees: { mods: [tree, pine, sapling], params: plain, style: () => null, min: 101, alpha255: false, fill: false, litIgnored: true },
  shrubs: { mods: [bush, rock, hedge], params: m => (m === hedge ? runs(m) : plain(m)), style: () => ({}), min: 21, alpha255: true, fill: false },
  carts: { mods: [cart, barrel, crate], params: dirX, style: () => null, min: 41, alpha255: true, fill: false },
  yard: { mods: [laundry, scarecrow], params: dirX, style: () => null, min: 41, alpha255: false, fill: false },
  street: { mods: [lamp, banner, railing], params: m => (m === railing ? runs(m) : plain(m)), style: (m, p) => (p.kind === 'banner' && p.v === 1 ? { accent: '#aa33cc' } : {}), min: 1, alpha255: false, fill: true },
};

for (const [group, cfg] of Object.entries(GROUPS)) {
  for (const m of cfg.mods) {
    test(`${group}/${m.name}: seam (name, frames)`, () => {
      assert.equal(typeof m.name, 'string');
      assert.ok(Number.isInteger(m.frames) && m.frames >= 1);
    });
    for (const p of cfg.params(m)) for (const lit of [false, true]) {
      test(`${group}/${m.name} ${JSON.stringify(p)} lit=${lit}: extent, opaque only inside it, deterministic`, () => {
        const style = cfg.style(m, p);
        const e = m.extent(p, style);
        assert.equal(e.length, 4);
        const [x0, y0, x1, y1] = e;
        assert.ok(e.every(Number.isFinite) && x0 < x1 && y0 < y1);
        const run = (l, tick) => { const g = fakeCtx(cfg.fill); m.draw(g, p, FX, FY, tick, l, style); return g; };
        const a = run(lit, 0), b = run(lit, 0);
        assert.ok(!a.oob, 'inside test canvas');
        assert.deepEqual(Buffer.from(a.buf), Buffer.from(b.buf), 'deterministic');
        if (cfg.litIgnored) assert.deepEqual(Buffer.from(run(!lit, 5).buf), Buffer.from(a.buf), 'deterministic, lit and tick ignored');
        let n = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const al = a.buf[(y * W + x) * 4 + 3];
          if (!al) continue;
          n++;
          if (cfg.alpha255) assert.equal(al, 255);
          const rx = x - FX, ry = y - FY;
          assert.ok(rx >= x0 && rx < x1 && ry >= y0 && ry < y1, `${m.name} pixel (${rx},${ry}) outside extent`);
        }
        assert.ok(n >= cfg.min, `${m.name} drew ${n} opaque pixels`);
      });
    }
  }
}

test('prop module names match their kind', () => {
  assert.deepEqual([bush.name, rock.name, hedge.name], ['bush', 'rock', 'hedge']);
});

test('trees: variants differ and heights are plausible', () => {
  for (const [mod, lo, hi] of [[tree, 44, 56], [pine, 54, 66], [sapling, 30, 40]]) {
    const imgs = [];
    for (const v of V4) {
      const g = fakeCtx(false); mod.draw(g, { v }, FX, FY, 0, false, null);
      let top = H; for (let y = 0; y < H && top === H; y++) for (let x = 0; x < W; x++) if (g.buf[(y * W + x) * 4 + 3] === 255) { top = y; break; }
      assert.ok(FY - top >= lo && FY - top <= hi, `${mod.name} v${v} height ${FY - top}`);
      imgs.push(Buffer.from(g.buf).toString('base64'));
    }
    assert.equal(new Set(imgs).size, 4);
  }
});

test('hedge grows with len and dir changes the shape', () => {
  const a = hedge.extent({ v: 0, dir: 'x', len: 1 }), b = hedge.extent({ v: 0, dir: 'x', len: 3 });
  assert.ok(b[2] - b[0] > a[2] - a[0]);
  const y = hedge.extent({ v: 0, dir: 'y', len: 3 });
  assert.ok(y[0] < 0 && y[2] < b[2]);
});

test('cart variants differ', () => {
  const s = v => { const c = fakeCtx(false); cart.draw(c, { v }, FX, FY, 0, false, null); return Buffer.from(c.buf).toString('hex'); };
  assert.equal(new Set(V4.map(s)).size, 4);
});

test('banner accent tints the cloth, invalid accent falls back', () => {
  const draw = style => { const g = fakeCtx(true); banner.draw(g, { kind: 'banner', v: 0 }, FX, FY, 0, false, style); return Buffer.from(g.buf); };
  assert.notDeepEqual(draw({ accent: '#2233ff' }), draw({}));
  assert.deepEqual(draw({ accent: 'red' }), draw({}));
});
