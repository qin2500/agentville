// RIDGE: building anchors (ridge, chimney) must land on the drawn roof. Written from the spec: for any look, after
// rasterize() the ridge/chimney anchor is inside bounds and on (or within 1px of) an opaque pixel.
// Node has no canvas and classic iso.js needs a DOM (document.createElement), so the real looks cannot run here:
// the snapping helper and rasterBuilding are tested with a fake classic art whose anchors float off the sprite,
// including the shapes the hall/chapel/guildhall produce (apex above the roof, apex beside it, fallback centre).
import test from 'node:test'
import assert from 'node:assert/strict'
import { rasterize, snapAnchor, measureBounds, setCanvasFactory, useClassicArt, loadClassicArt } from '../web/src/engine/art/raster.js'

class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.buf = new Uint8ClampedArray(w * h * 4); }
  getContext() {
    const c = this;
    return {
      drawImage(src, x, y) { for (let j = 0; j < src.height; j++) for (let i = 0; i < src.width; i++) { const s = (j * src.width + i) * 4; if (!src.buf[s + 3]) continue; for (let k = 0; k < 4; k++) c.buf[((j + y) * c.width + i + x) * 4 + k] = src.buf[s + k]; } },
      getImageData() { return { data: c.buf, width: c.width, height: c.height }; },
    };
  }
}
// a gable-ish silhouette: apex column 10 at row 4, widening downward; a gap column-free region left of x=4
const sprite = (w, h) => { const c = new FakeCanvas(w, h); for (let y = 4; y < 26; y++) { const half = Math.min(9, y - 4); for (let x = 10 - half; x <= 10 + half; x++) c.buf[(y * w + x) * 4 + 3] = 255; } return c; };
const art = (ridge, chimney) => ({
  isoExtent: () => [-10, -24, 10, 6],
  isoBuilding: () => ({ img: sprite(21, 30), dx: -10, dy: -24, windows: [], door: [0, 0], ridge, chimney, box: [0, 0, 1, 1] }),
  createPropArt: () => ({ extent: () => [0, 0, 0, 0], draw() {} }),
});
const opaqueNear = (img, p, r = 1) => {
  const { data, width: W, height: H } = img.getContext().getImageData();
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy; if (x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3]) return true; }
  return false;
};

const CASES = {
  inside: [[0, -15], [0, -10]],
  aboveRoof: [[0, -40], [0, -35]],
  floatingRight: [[30, -10], [-50, -5]],
  belowSprite: [[0, 60], [0, 60]],
  nullChimney: [[0, -40], null],
};
for (const [name, [ridge, chimney]] of Object.entries(CASES)) for (const [w, h] of [[2, 2], [4, 3]]) {
  test(`rasterize: ridge/chimney anchors on the roof (${name} ${w}x${h})`, () => {
    setCanvasFactory((a, b) => new FakeCanvas(a, b)); useClassicArt(art(ridge, chimney));
    try {
      for (const look of ['hall', 'chapel', 'guildhall']) {
        const r = rasterize(look, null, { kind: 'building', w, h });
        const b = r.bounds;
        for (const k of chimney ? ['ridge', 'chimney'] : ['ridge']) {
          const p = r.anchors[k];
          assert.ok(p, `${look} ${k} present`);
          assert.ok(p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h, `${look} ${k} inside bounds`);
          assert.ok(opaqueNear(r.img, p), `${look} ${k} on an opaque pixel`);
        }
        if (!chimney) assert.equal(r.anchors.chimney, null);
      }
    } finally { useClassicArt(null); setCanvasFactory(null); }
  });
}

test('snapAnchor: keeps an anchor already on an opaque pixel (same object)', () => {
  const c = sprite(21, 30), id = { data: c.buf, width: 21, height: 30 }, b = measureBounds(id), p = { x: 10, y: 8 };
  assert.equal(snapAnchor(p, id, b), p);
  assert.deepEqual(snapAnchor({ x: 10.4, y: 8.3 }, id, b), { x: 10, y: 8 }, 'fractional anchors are rounded to the pixel');
});
test('snapAnchor: moves to the top opaque pixel of the column, then the nearest non-empty column', () => {
  const c = sprite(21, 30), id = { data: c.buf, width: 21, height: 30 }, b = measureBounds(id);
  assert.deepEqual(snapAnchor({ x: 10, y: -3 }, id, b), { x: 10, y: 4 });
  assert.deepEqual(snapAnchor({ x: 8, y: 0 }, id, b), { x: 8, y: 6 });
  assert.deepEqual(snapAnchor({ x: 99, y: 0 }, id, b), { x: 19, y: 13 }, 'clamped to the right edge column');
  const d = new Uint8ClampedArray(10 * 10 * 4); d[(5 * 10 + 2) * 4 + 3] = 255; d[(7 * 10 + 8) * 4 + 3] = 255;
  const id2 = { data: d, width: 10, height: 10 }, b2 = measureBounds(id2);
  assert.deepEqual(snapAnchor({ x: 4, y: 0 }, id2, b2), { x: 2, y: 5 }, 'empty column: nearest non-empty column, ties left');
});
test('snapAnchor: null anchors and empty images pass through', () => {
  assert.equal(snapAnchor(null, { data: new Uint8ClampedArray(4), width: 1, height: 1 }, { x: 0, y: 0, w: 0, h: 0 }), null);
  const p = { x: 1, y: 1 };
  assert.equal(snapAnchor(p, { data: new Uint8ClampedArray(4), width: 1, height: 1 }, { x: 0, y: 0, w: 0, h: 0 }), p);
});

// The real classic looks, through the same fake DOM engine-raster-impl.test.mjs uses (pixels via putImageData).
test('real classic art: every building look at several sizes has ridge/chimney inside bounds on an opaque pixel', async () => {
  const g = globalThis;
  class Doc extends FakeCanvas { set width(v) { this._w = v; this.buf = new Uint8ClampedArray(v * (this._h || 0) * 4); } get width() { return this._w; } set height(v) { this._h = v; this.buf = new Uint8ClampedArray((this._w || 0) * v * 4); } get height() { return this._h; }
    getContext() { const c = this, base = super.getContext(); return { ...base, putImageData(id, x, y) { for (let j = 0; j < id.height; j++) for (let i = 0; i < id.width; i++) for (let k = 0; k < 4; k++) c.buf[((j + y) * c.width + i + x) * 4 + k] = id.data[(j * id.width + i) * 4 + k]; }, fillRect() {}, clearRect() {} }; } }
  g.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  g.document = { createElement: () => new Doc(0, 0), addEventListener() {}, querySelector() { return null }, documentElement: { style: {} }, body: {} };
  g.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  g.window = g; g.localStorage = { getItem() { return null }, setItem() {} };
  setCanvasFactory((w, h) => new FakeCanvas(w, h));
  useClassicArt(null);
  await loadClassicArt();
  const { OBJECT_TYPES } = await import('../mods/agentville.fantasy/objects.js');
  const looks = Object.keys(OBJECT_TYPES.buildings);
  assert.ok(looks.includes('hall') && looks.includes('chapel') && looks.includes('guildhall'));
  try {
    for (const look of looks) for (const [w, h, variant] of [[2, 2, 0], [3, 3, 3], [5, 4, 7]]) {
      const r = rasterize(look, null, { kind: 'building', w, h, variant });
      const b = r.bounds;
      for (const k of ['ridge', 'chimney']) {
        const p = r.anchors[k];
        if (!p) continue;
        assert.ok(p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h, `${look} ${w}x${h} ${k} inside bounds ${JSON.stringify([p, b])}`);
        assert.ok(opaqueNear(r.img, p), `${look} ${w}x${h} ${k} on an opaque pixel`);
      }
      assert.ok(r.anchors.ridge, `${look} has a ridge`);
    }
  } finally { useClassicArt(null); setCanvasFactory(null); }
});
