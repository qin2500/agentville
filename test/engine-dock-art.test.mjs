import test from 'node:test';
import assert from 'node:assert/strict';
import { PROPS } from '../web/src/engine/art/props/index.js';
import { createActorArt, CRITTER_RATIO } from '../web/src/engine/render/actor-art.js';
import { VENUES } from '../mods/agentville.fantasy/venues.js';
import { validateObject } from '../web/src/engine/core/objects.js';

const W = 300, H = 200, FX = 150, FY = 100;
function fakeCtx() {
  const d = new Uint8ClampedArray(W * H * 4);
  return { d, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData(img, x0, y0) { for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) { const k = (j * img.width + i) * 4; if (img.data[k + 3]) { const o = ((y0 + j) * W + x0 + i) * 4; d.set(img.data.slice(k, k + 4), o); } } } };
}
const cases = [];
for (const v of [0, 1, 2, 3]) {
  for (const dir of ['x', 'y']) for (const len of [1, 3]) cases.push([PROPS.pier, { v, dir, len }]);
  cases.push([PROPS.bollard, { v }]);
  for (const dir of ['x', 'y']) cases.push([PROPS.skiff, { v, dir }]);
}
for (const [m, p] of cases) {
  test(`dock prop ${m.name} ${JSON.stringify(p)}: deterministic, inside extent, opaque`, () => {
    const [x0, y0, x1, y1] = m.extent(p, {});
    const run = () => { const g = fakeCtx(); m.draw(g, p, FX, FY, 0, false, {}); return g.d; };
    const a = run();
    assert.deepEqual(Buffer.from(a), Buffer.from(run()));
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[(y * W + x) * 4 + 3]) {
      n++; const rx = x - FX, ry = y - FY;
      assert.ok(rx >= x0 && rx < x1 && ry >= y0 && ry < y1, `pixel (${rx},${ry}) outside extent`);
    }
    assert.ok(n > 60);
  });
}

test('dock props are registered engine props', () => {
  for (const k of ['pier', 'bollard', 'skiff']) assert.equal(PROPS[k].name, k);
});

test('harbour plan: valid objects for every level, piers cover every berth row', () => {
  const site = { kind: 'harbour', rect: { x: 20, y: 40, w: 60, h: 30 }, anchor: { tx: 50, ty: 42 }, data: { cx: 50, foot: 42, sea: 43 } };
  for (const lv of [1, 2, 3, 4]) {
    const { objects, berths } = VENUES.harbour.plan({ site, level: lv });
    assert.equal(new Set(objects.map(o => o.id)).size, objects.length);
    for (const o of objects) {
      assert.deepEqual(validateObject({ ...o, id: 'v:' + o.id, styleKey: '' }), [], o.id);
      assert.ok(o.tx >= site.rect.x && o.tx + o.w <= site.rect.x + site.rect.w && o.ty >= site.rect.y && o.ty + o.h <= site.rect.y + site.rect.h, `${o.id} inside the site rect`);
    }
    const decks = objects.filter(o => o.model === 'pier');
    assert.ok(decks.length >= lv);
    // a berth sits beside a deck (west: tile left of the pier, east: right of it)
    for (const b of berths) assert.ok(decks.some(d => (b.tx === d.tx - 1 || b.tx === d.tx + d.w) && b.ty >= d.ty && b.ty < d.ty + d.h), `${b.id} beside a deck`);
  }
});

// ---- critters vs villagers
test('critter sprites are clearly smaller than villagers (< 0.65x height)', async () => {
  const mk = (w, h) => ({ width: w, height: h, getContext: () => ({ fillStyle: '', imageSmoothingEnabled: false, drawImage() {}, save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, ellipse() {}, fill() {}, fillRect() {}, globalCompositeOperation: '', globalAlpha: 1 }) });
  const art = createActorArt({ base: '/x/', loadImage: async () => ({ width: 64, height: 112 }), createCanvas: mk });
  await art.load();
  const v = art.frame({ kind: 'folk', id: 'f', look: { seed: 0 }, anim: 'idle', face: 0 });
  for (const species of ['cat', 'chicken']) {
    const c = art.frame({ kind: 'critter', species, anim: 'idle', face: 0 });
    assert.ok(c.img.height < 0.65 * v.img.height, `${species} ${c.img.height} vs villager ${v.img.height}`);
    assert.ok(c.img.height > 0.4 * v.img.height, 'but not vanishing');
  }
  assert.ok(CRITTER_RATIO < 0.65);
});
