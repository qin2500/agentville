// Harbour art props: classic output stays byte-identical at the default projection scale; every new prop paints inside its extent.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import '../web/src/engine-art-env.js';
import { harbourArt as A } from '../web/src/dock-art.js';
import * as vessel from '../web/src/engine/art/props/vessel.js';
import * as tug from '../web/src/engine/art/props/tug.js';
import * as rowboat from '../web/src/engine/art/props/rowboat.js';
import * as lighthouse from '../web/src/engine/art/props/lighthouse.js';
import * as beacon from '../web/src/engine/art/props/beacon.js';
import * as warehouse from '../web/src/engine/art/props/warehouse.js';
import * as crane from '../web/src/engine/art/props/crane.js';
import * as buoy from '../web/src/engine/art/props/buoy.js';
import * as quay from '../web/src/engine/art/props/quay.js';
import * as breakwater from '../web/src/engine/art/props/breakwater.js';
import * as crates from '../web/src/engine/art/props/crates.js';

const GOLDEN = {"sloopS": "9807bb7342cf94ed354a921432a5fdc3c24256cb:54x62@-45,-40", "brigE": "be0b6b0770a4cde82f9dbd03a7565e411b3d19c7:80x84@-10,-52", "dinW": "42a6d2e76d96aa8af91c10be6902ee14f0fd6890:28x38@-22,-33", "tugN": "1d4fc01cc9352d85d377b731cfd2068acf70d9c3:29x31@-6,-26", "row": "de7a2c672975a9cb8b0a9ce9f3c32d427d21c002:29x22@-20,-10", "lh": "8f39a5369b38f2aa67286e0bf15dc91e33eb57b4:49x88@-22,-70", "bc": "10de3389d507c3399bf2d2a930ef2924c5e8d686:37x42@-18,-29", "shed": "a6cbe42cf8ccc021958b23abff66d87401a28b6f:87x64@-29,-28", "pc": "1df0f905e82df1aba02c35ffd05a9404ef9893d9:26x65@-13,-55", "jib": "2adc63a1a4a3f7f08dd3b8d94d79b37ec9ccee55:36x23@-5,-50", "buoyr": "8f9887985b2b7c6996da09ef53211a57b23a7082:14x22@-6,-15", "buoyg": "bc96a8e5302c0c65c1cf82a81ffd7871b5a7bd4b:14x22@-6,-15", "bw": "ce0baaa60be89fc8959352ad183b5eeedeb21149:69x44@-18,-9", "quay": "60e703aed1323740ca1a49a743496f6033004e98:137x78@-35,-7"};
const sg = { quad: [[0, 0], [60, 0], [60, 14], [0, 14]], a: [0, 7], b: [60, 7], n: [0, 1], len: 60 };
const classic = {
  sloopS: () => A.ship('sloop', '#c8423a', 'S', false), brigE: () => A.ship('cargo', '#3f6b8c', 'E', false), dinW: () => A.ship('dinghy', '#6b8a3f', 'W', true),
  tugN: () => A.tug('N', false), row: () => A.rowboat('S', 1, false), lh: () => A.lighthouse(0, 0, false), bc: () => A.beacon(0, 0, false),
  shed: () => A.shed([0, 0, 60, 30], 6, 2, false), pc: () => A.pierCrane({ bx: 0, by: 0, z0: 4 }, false), jib: () => A.jib({ bx: 0, by: 0, z0: 4, tipX: 40 }, false),
  buoyr: () => A.buoy('r'), buoyg: () => A.buoy('g'), bw: () => A.breakwater(sg, false), quay: () => A.quay({ x0: 0, y0: 0, x1: 120, y1: 40 }, false),
};
const sig = r => crypto.createHash('sha1').update(r.data).digest('hex') + ':' + r.w + 'x' + r.h + '@' + r.ox + ',' + r.oy;
for (const [k, f] of Object.entries(classic)) test(`classic ${k} is byte-identical at the default scale`, () => assert.equal(sig(f()), GOLDEN[k]));
test('scale 1 equals the default; 1.25 makes the ground wider', () => {
  assert.equal(sig(A.quay({ x0: 0, y0: 0, x1: 120, y1: 40 }, false, 1)), GOLDEN.quay);
  assert.ok(A.quay({ x0: 0, y0: 0, x1: 120, y1: 40 }, false, 1.25).w > 137);
});

const W = 400, H = 300, FX = 200, FY = 200;
function fakeCtx() {
  const d = new Uint8ClampedArray(W * H * 4);
  return { d, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData(img, x0, y0) { for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) { const k = (j * img.width + i) * 4; if (img.data[k + 3]) { const o = ((y0 + j) * W + x0 + i) * 4; d.set(img.data.slice(k, k + 4), o); } } } };
}
const render = (m, p, lit = false, t = 0) => { const g = fakeCtx(); m.draw(g, p, FX, FY, t, lit, {}); return g.d; };
const cases = [];
for (const cls of ['dinghy', 'cutter', 'brig']) for (const head of ['S', 'E', 'W', 'N']) cases.push([vessel, { cls, head, v: 1 }]);
for (const head of ['S', 'E', 'W', 'N']) { cases.push([tug, { head }]); cases.push([rowboat, { head }]); cases.push([rowboat, { head, oars: 1 }]); }
cases.push([lighthouse, {}], [beacon, {}], [crane, {}], [crane, { reach: 56, z0: 0 }]);
for (const v of [0, 1, 2, 3, 4]) cases.push([warehouse, { v }]);
cases.push([warehouse, { w: 4, h: 3 }], [buoy, { v: 0 }], [buoy, { v: 1 }]);
cases.push([quay, {}], [quay, { w: 5, h: 2 }], [breakwater, { len: 4 }], [breakwater, { len: 3, dir: 'y' }], [breakwater, { len: 3, sea: -1 }]);
for (let n = 1; n <= 6; n++) cases.push([crates, { n, v: n % 3 }]);

for (const [m, p] of cases) for (const lit of [false, true]) {
  test(`${m.name} ${JSON.stringify(p)} lit=${lit}: deterministic, inside extent, paints`, () => {
    const [x0, y0, x1, y1] = m.extent(p, {}), a = render(m, p, lit);
    assert.deepEqual(Buffer.from(a), Buffer.from(render(m, p, lit)));
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[(y * W + x) * 4 + 3]) {
      n++; const rx = x - FX, ry = y - FY;
      assert.ok(rx >= x0 && rx < x1 && ry >= y0 && ry < y1, `${m.name}: pixel (${rx},${ry}) outside extent`);
    }
    assert.ok(n > 40, `${m.name} painted only ${n} px`);
  });
}
test('frames: vessel and tug bob by one pixel, oars alternate', () => {
  for (const [m, p] of [[vessel, { cls: 'cutter' }], [tug, {}], [rowboat, { oars: 1 }]]) {
    assert.equal(m.frames, 2);
    const a = render(m, { ...p, frame: 0 }), b = render(m, { ...p, frame: 1 });
    assert.notDeepEqual(Buffer.from(a), Buffer.from(b), m.name);
  }
});
test('lit variants differ where the art has windows or lanterns', () => {
  for (const [m, p] of [[vessel, { cls: 'cutter' }], [vessel, { cls: 'brig' }], [lighthouse, {}], [beacon, {}], [warehouse, { w: 4 }], [tug, {}]]) {
    assert.notDeepEqual(Buffer.from(render(m, p, false)), Buffer.from(render(m, p, true)), m.name);
  }
});
test('classes and heads differ; anchors are exported', () => {
  assert.notDeepEqual(vessel.extent({ cls: 'dinghy' }), vessel.extent({ cls: 'brig' }));
  assert.notDeepEqual(Buffer.from(render(vessel, { head: 'S' })), Buffer.from(render(vessel, { head: 'E' })));
  assert.ok(vessel.anchors({ cls: 'brig' }).cargo.length === 6 && vessel.anchors({}).mast.length === 2);
  assert.ok(tug.anchors({}).smoke && lighthouse.anchors().lamp && beacon.anchors().glow && crane.anchors({}).hook && buoy.anchors().lamp);
  assert.ok(warehouse.anchors({}).door && quay.anchors({}).edge && breakwater.anchors({}).end && crates.anchors({ n: 3 }).slots.length === 3);
});
