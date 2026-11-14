// R3 rasteriser tests, written from the seam spec (COMMON.md / design §5.2): rasterize(model, style, opts) and
// measureBounds(imageData). Node has no canvas: a fake 2D context records calls and holds an RGBA buffer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rasterize, measureBounds, setCanvasFactory, useClassicArt, loadClassicArt, PAD } from '../web/src/engine/art/raster.js'

/** A canvas-like with a real RGBA buffer, a call log and just enough 2D API (putImageData, drawImage, getImageData). */
class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.buf = new Uint8ClampedArray(w * h * 4); this.calls = []; }
  getContext() {
    const c = this;
    return {
      putImageData(id, x, y) { c.calls.push(['put', x, y]); for (let j = 0; j < id.height; j++) for (let i = 0; i < id.width; i++) for (let k = 0; k < 4; k++) c.buf[((j + y) * c.width + i + x) * 4 + k] = id.data[(j * id.width + i) * 4 + k]; },
      drawImage(src, x, y) {
        c.calls.push(['draw', x, y]);
        for (let j = 0; j < src.height; j++) for (let i = 0; i < src.width; i++) {
          const s = (j * src.width + i) * 4; if (!src.buf[s + 3]) continue;
          for (let k = 0; k < 4; k++) c.buf[((j + y) * c.width + i + x) * 4 + k] = src.buf[s + k];
        }
      },
      fillRect() {}, clearRect() {},
      getImageData() { return { data: c.buf, width: c.width, height: c.height }; },
    };
  }
}
const solid = (w, h, rects) => { const c = new FakeCanvas(w, h); for (const [x, y, rw, rh] of rects) for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) c.buf[(j * w + i) * 4 + 3] = 255; return c; };

test('measureBounds: empty, one pixel, a rect, an L shape, threshold', () => {
  const img = (w, h, px) => { const d = new Uint8ClampedArray(w * h * 4); for (const [x, y, a] of px) d[(y * w + x) * 4 + 3] = a; return { data: d, width: w, height: h }; };
  assert.deepEqual(measureBounds(img(4, 3, [])), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(measureBounds(img(4, 3, [[2, 1, 255]])), { x: 2, y: 1, w: 1, h: 1 });
  assert.deepEqual(measureBounds(img(5, 5, [[1, 1, 9], [3, 2, 255], [1, 4, 255]])), { x: 1, y: 1, w: 3, h: 4 });
  assert.deepEqual(measureBounds(img(3, 3, [[0, 0, 10], [2, 2, 255]]), 10), { x: 2, y: 2, w: 1, h: 1 }, 'alpha at or under the threshold is transparent');
  assert.deepEqual(measureBounds(img(3, 3, [[0, 0, 1]])), { x: 0, y: 0, w: 1, h: 1 }, 'default: any alpha counts');
});

function fakeArt(log) {
  const sprite = solid(20, 30, [[3, 6, 10, 20]]);   // opaque rect (3,6)-(12,25) inside a 20x30 classic image
  return {
    isoExtent: (it, T, S) => { log.push(['extent', it, T, S]); return [-10, -24, 10, 6]; },
    isoBuilding: (it, T, lit, S) => { log.push(['build', it, T, lit, S]); return { img: sprite, dx: -10, dy: -24, windows: [[0, -10]], door: [1, 2], ridge: [0, -20], chimney: null, box: [0, 0, 1, 1] }; },
    createPropArt: () => ({
      extent: (p) => (p.kind === 'well' ? [-6, -12, 6, 3] : [0, 0, 0, 0]),
      draw: (g, p, x, y, t, night, style) => { log.push(['prop', p, x, y, t, night, style]); g.drawImage(solid(12, 15, [[2, 3, 8, 9]]), x - 6, y - 12); },
    }),
  };
}

test('building: classic image copied with a margin, pivot at the north corner, true bounds by alpha scan', () => {
  const log = []; useClassicArt(fakeArt(log)); setCanvasFactory((w, h) => new FakeCanvas(w, h));
  const r = rasterize('cottage', { accent: '#aa3322', family: 2, key: 'k1' }, { kind: 'building', w: 2, h: 3, variant: 5, lit: true, crown: true });
  assert.equal(PAD >= 1, true);
  assert.deepEqual([r.img.width, r.img.height], [20 + 2 * PAD, 30 + 2 * PAD]);
  assert.deepEqual(r.bounds, { x: 3 + PAD, y: 6 + PAD, w: 10, h: 20 });
  assert.ok(r.bounds.x >= 1 && r.bounds.y >= 1 && r.bounds.x + r.bounds.w <= r.img.width - 1 && r.bounds.y + r.bounds.h <= r.img.height - 1, '1px transparent border');
  assert.deepEqual(r.pivot, { x: PAD + 10, y: PAD + 24 }, 'isoP(x0,y0) = image origin minus dx,dy');
  assert.deepEqual(r.anchors.door, { x: 1 + PAD + 10, y: 2 + PAD + 24 });
  assert.deepEqual(r.anchors.windows, [{ x: PAD + 10, y: PAD + 14 }]);
  assert.equal(r.anchors.chimney, null);
  assert.equal(r.classic, false);
  const build = log.find(l => l[0] === 'build'), it = build[1];
  assert.equal(build[2], 16, 'classic T');
  assert.equal(build[3], true, 'lit passed');
  assert.equal(build[4], 1.25, 'engine 32x16 tile = 1.25 x the classic 0.8 projection');
  assert.deepEqual([it.look, it.w, it.h, it.variant, it.crown, it.village.accent], ['cottage', 2, 3, 5, true, '#aa3322']);
  assert.equal(it.style.family, 2, 'the style object reaches classic');
});

test('building: scale 0.8 maps to the classic projection, door and site options', () => {
  const log = []; useClassicArt(fakeArt(log)); setCanvasFactory((w, h) => new FakeCanvas(w, h));
  rasterize('barn', null, { kind: 'building', w: 4, h: 3, scale: 0.8, door: 24, site: true });
  const [, it, , , S] = log.find(l => l[0] === 'build');
  assert.ok(Math.abs(S - 1) < 1e-9);
  assert.equal(it.doorX, 24); assert.equal(it.kind, 'pr'); assert.equal(it.building, true);
  rasterize('barn', null, { kind: 'building', w: 4, h: 3, door: null });
  assert.equal(log.filter(l => l[0] === 'build').at(-1)[1].doorX, null);
  rasterize('barn', null, { kind: 'building', w: 4, h: 3 });
  assert.equal(log.filter(l => l[0] === 'build').at(-1)[1].doorX, 32, 'default door is centred');
});

test('prop: sized from its extent plus a margin, pivot is the foot, dir/len/anim reach the prop art (a classic prop: engine props in art/props take precedence)', () => {
  const log = []; useClassicArt(fakeArt(log)); setCanvasFactory((w, h) => new FakeCanvas(w, h));
  const r = rasterize('well', null, { variant: 2, dir: 'y', len: 4, lit: true, anim: 3 });
  assert.deepEqual([r.img.width, r.img.height], [12 + 2 * PAD, 15 + 2 * PAD]);
  assert.deepEqual(r.pivot, { x: PAD + 6, y: PAD + 12 });
  assert.equal(r.classic, true, 'props stay at the classic projection');
  const [, p, , , t, night] = log.find(l => l[0] === 'prop');
  assert.deepEqual(p, { kind: 'well', v: 2, dir: 'y', len: 4 });
  assert.equal(night, true); assert.ok(t > 0);
  assert.deepEqual(r.bounds, { x: 2 + PAD, y: 3 + PAD, w: 8, h: 9 });
});

test('unknown prop with kind "prop" is null; without kind it falls through to a building', () => {
  const log = []; useClassicArt(fakeArt(log)); setCanvasFactory((w, h) => new FakeCanvas(w, h));
  assert.equal(rasterize('nothing', null, { kind: 'prop' }), null);
  assert.ok(rasterize('nothing', null, { w: 1, h: 1 }));
  assert.ok(log.some(l => l[0] === 'build'));
});

test('canvas factory is injectable; with none and no DOM it throws a clear error; art must be loaded', () => {
  let made = 0; useClassicArt(fakeArt([])); setCanvasFactory((w, h) => { made++; return new FakeCanvas(w, h); });
  rasterize('barn', null, { kind: 'building', w: 2, h: 2 });
  assert.equal(made, 1);
  setCanvasFactory(null);
  assert.throws(() => rasterize('barn', null, { kind: 'building', w: 2, h: 2 }), /no canvas/);
  useClassicArt(null);
  setCanvasFactory((w, h) => new FakeCanvas(w, h));
  assert.throws(() => rasterize('barn', null, { kind: 'building' }), /not loaded/);
});

test('real classic art, drawn through a fake DOM: every fantasy building look rasterises with a clear margin', async () => {
  const g = globalThis;
  const canvasLike = () => new FakeCanvas(0, 0);
  // iso.js / props-art.js make canvases with document.createElement and fill them with putImageData(new ImageData(...)).
  class Doc extends FakeCanvas { set width(v) { this._w = v; if (this.buf !== undefined) this.buf = new Uint8ClampedArray(this._w * (this._h || 0) * 4); } get width() { return this._w; } set height(v) { this._h = v; this.buf = new Uint8ClampedArray((this._w || 0) * v * 4); } get height() { return this._h; } }
  g.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  g.document = { createElement: () => new Doc(0, 0), addEventListener() {}, querySelector() { return null }, documentElement: { style: {} }, body: {} };
  g.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  g.window = g; g.localStorage = { getItem() { return null }, setItem() {} };
  void canvasLike;
  setCanvasFactory((w, h) => new FakeCanvas(w, h));
  useClassicArt(null);
  await loadClassicArt();
  const { OBJECT_TYPES } = await import('../mods/agentville.fantasy/objects.js');
  for (const look of Object.keys(OBJECT_TYPES.buildings)) {
    const r = rasterize(look, null, { kind: 'building', w: 3, h: 3, variant: 3 });
    const { bounds: b, img } = r;
    assert.ok(b.w > 20 && b.h > 20, `${look}: has pixels`);
    assert.ok(b.x >= 1 && b.y >= 1 && b.x + b.w <= img.width - 1 && b.y + b.h <= img.height - 1, `${look}: 1px transparent border`);
    assert.ok(r.anchors.door && r.anchors.door.x > b.x && r.anchors.door.x < b.x + b.w, `${look}: door inside bounds across`);
    assert.ok(r.pivot.x > 0 && r.pivot.y > 0);
  }
  // 32x16 projection: a 1x1 footprint's diamond is 32 px wide at the base, wider than the classic 25.6
  const wide = rasterize('cottage', null, { kind: 'building', w: 3, h: 3 }).bounds.w;
  const classic = rasterize('cottage', null, { kind: 'building', w: 3, h: 3, scale: 0.8 }).bounds.w;
  assert.ok(wide > classic, 'engine scale draws wider than classic');
  for (const kind of ['fountain', 'stall', 'bench', 'statue', 'lamppost', 'fence']) {
    const r = rasterize(kind, null, { kind: 'prop', variant: 1, len: 3 });
    assert.ok(r && r.bounds.w > 0 && r.classic, kind);
  }
});
