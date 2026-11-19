// Market stalls (2026-11-19): the engine-scale stall art (web/src/engine/art/props/stall.js) and the fantasy mod's
// propVariants hook (mods/agentville.fantasy/variety.js) that picks how each stall is drawn. Pure, node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROPS } from '../web/src/engine/art/props/index.js';
import * as stall from '../web/src/engine/art/props/stall.js';
const { propVariants, stallLook, stallVariant, STALL_CLOTHS, STALL_GOODS, STALL_SHAPES } = await import('../mods/agentville.fantasy/variety.js');

// the market as city-plan.js lays it out: rows 2 apart, stalls 3 apart, with other props mixed in
const market = (x0 = 10, y0 = 20, cols = 3, rows = 4) => {
  const out = [{ kind: 'fountain', x: 1, y: 1, v: 0 }];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ kind: 'stall', x: x0 + 1 + c * 3, y: y0 + r * 2 + 0.5, v: (r * 3 + c) % 8, dir: 'x' });
  out.push({ kind: 'cart', x: x0 + 0.5, y: y0 + 7.5, v: 0 });
  return out;
};
const fakeG = () => {
  const g = { put: null };
  g.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  g.putImageData = (img, x, y) => { g.put = { img, x, y }; };
  return g;
};
const opaque = img => { let n = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) n++; return n; };

test('the stall is registered as engine-scale art (raster.js prefers it over the classic 1.25x upscale)', () => {
  assert.equal(PROPS.stall, stall);
  assert.equal(PROPS.stall.name, 'stall');
  assert.equal(PROPS.stall.frames, 1);
});

test('mod and art decode a variant the same way, and the mod encoding round-trips', () => {
  for (let v = 0; v < 4096; v++) assert.deepEqual(stallLook(v), stall.stallLook(v), `v ${v}`);
  for (let c = 0; c < STALL_CLOTHS; c++) for (let g = 0; g < STALL_GOODS; g++) for (let s = 0; s < STALL_SHAPES; s++) {
    const v = stallVariant(c, g, s);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 4096);
    assert.deepEqual(stallLook(v), { cloth: c, goods: g, shape: s });
  }
  // a bare plan variant (0..7, no hook) still draws eight different stalls
  const bare = new Set([...Array(8).keys()].map(v => JSON.stringify(stallLook(v))));
  assert.equal(bare.size, 8);
  assert.equal(new Set([...Array(8).keys()].map(v => stallLook(v).shape)).size, 3, 'all three canopies among the bare variants');
});

test('every look draws pixels inside its extent, in both directions; looks differ', () => {
  const [x0, y0, x1, y1] = stall.extent({});
  const seen = new Set();
  for (let s = 0; s < STALL_SHAPES; s++) for (let c = 0; c < STALL_CLOTHS; c++) for (const dir of ['x', 'y']) {
    const g = fakeG(), v = stallVariant(c, (c + s) % STALL_GOODS, s);
    stall.draw(g, { v, dir }, -x0, -y0, 0, false, null);
    assert.ok(g.put, 'drew');
    assert.ok(opaque(g.put.img) > 600, `shape ${s} cloth ${c} ${dir}: a solid sprite`);
    const { width: w, height: h, data } = g.put.img;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) assert.equal(data[(y * w + x) * 4 + 3], 0, `shape ${s} cloth ${c} ${dir}: clipped at the extent's edge (${x}, ${y})`);
    seen.add(Buffer.from(g.put.img.data).toString('base64'));
  }
  assert.equal(seen.size, STALL_SHAPES * STALL_CLOTHS * 2, 'no two looks draw the same sprite');
});

test('cloth 0 wears the settlement accent; a bad accent falls back', () => {
  const v = stallVariant(0, 1, 0), draw = st => { const g = fakeG(); stall.draw(g, { v }, 32, 56, 0, false, st); return Buffer.from(g.put.img.data).toString('base64'); };
  assert.notEqual(draw({ accent: '#2050d0' }), draw(null));
  assert.equal(draw({ accent: 'red' }), draw(null));
  const v1 = stallVariant(3, 1, 0), d1 = st => { const g = fakeG(); stall.draw(g, { v: v1 }, 32, 56, 0, false, st); return Buffer.from(g.put.img.data).toString('base64'); };
  assert.equal(d1({ accent: '#2050d0' }), d1(null), 'other cloths ignore the accent');
});

test('propVariants: only stalls, deterministic, and neighbours never share a cloth or goods', () => {
  const props = market();
  const m = propVariants(props, 'alpha');
  assert.deepEqual([...m.keys()].sort((a, b) => a - b), props.map((p, i) => (p.kind === 'stall' ? i : -1)).filter(i => i >= 0));
  assert.deepEqual([...propVariants(props.map(p => ({ ...p })), 'alpha')], [...m]);
  const st = props.map((p, i) => ({ ...p, L: m.has(i) ? stallLook(m.get(i)) : null })).filter(p => p.L);
  for (const a of st) for (const b of st) {
    if (a === b || Math.abs(a.x - b.x) > 3.5 || Math.abs(a.y - b.y) > 2.5) continue;
    assert.notEqual(a.L.cloth, b.L.cloth, `cloth ${a.x},${a.y} vs ${b.x},${b.y}`);
    assert.notEqual(a.L.goods, b.L.goods, `goods ${a.x},${a.y} vs ${b.x},${b.y}`);
    if (a.y === b.y) assert.notEqual(a.L.shape, b.L.shape, `row neighbours alternate canopies ${a.x},${a.y} vs ${b.x},${b.y}`);
  }
  assert.equal(new Set(st.map(s => s.L.shape)).size, 3, 'all three canopies in one market');
  assert.notDeepEqual([...propVariants(props, 'beta').values()], [...m.values()], 'another project draws its own market');
});

test('propVariants: prefix-stable and translation-invariant (a nested plan keeps its old stalls)', () => {
  const small = market(10, 20, 3, 2), big = [...market(14, 25, 3, 2), ...market(30, 25, 3, 3).filter(p => p.kind === 'stall')];
  const a = propVariants(small, 'k'), b = propVariants(big, 'k');
  // big starts with the small market shifted by (4, 5): the same props in the same order
  for (const [i, v] of a) assert.equal(b.get(i), v, `stall ${i}`);
  assert.equal(propVariants([], 'k').size, 0);
  assert.equal(propVariants(null, 'k').size, 0);
});
