// M5 parity proofs that had no node test yet: the renderer's lighthouse sweep, the panel hover outline and the carried
// crate; the zoom-3 PR tags; the beacon's night pool; the cove reserved for the biggest harbour.
// Tags live here (and in mods/) where the id carries a world word the engine directory may not contain
// (test/mod-ready-ratchet.test.mjs); the implementing sites are named on each test.
// parity: inp.dock-hover-outline   (web/src/engine/render/renderer.js: host panel hover)
// parity: lbl.ship-pr-tags, har.dock-tags   (web/src/engine/index.js hull tags -> overlay/labels.js 'tag prt')
// parity: vil.pose-carry-crate-shuttle   (web/src/engine/render/renderer.js carried(); mods ambient/porter.js sets a.carry)
// parity: debug.dockdemo   (web/src/main.js overrides S.dock; e2e/engine.spec.mjs proves the berths change)
// parity: har.dock-debug   (web/src/engine-host/dock-debug.js venueDebug -> debug().dock)
// parity: inp.dock-ship-click-va-dock   (web/src/engine-host.js PANEL_HIT_KINDS + openPrPanel; e2e/engine-harbour.spec.mjs clicks a ship)
// parity: har.dock-panel-summary   (web/src/dock.js, opened by va:dock; e2e/engine-harbour.spec.mjs reads the sheet)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { toScreen } from '../web/src/engine/core/coords.js';
import { labelCands } from '../web/src/engine/overlay/labels.js';
import { lightsFor } from '../mods/agentville.fantasy/lights.js';
import { dockVenue, dockSite, DOCK_REACH } from '../mods/agentville.fantasy/layout/dock.js';
import { VENUES, levelOf, PIER_ID } from '../mods/agentville.fantasy/venues.js';
import { CARRIER_KIND, PANEL_HIT_KINDS, openPrPanel } from '../web/src/engine-host.js';
import { venueDebug } from '../web/src/engine-host/dock-debug.js';

const LAYER = { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 };
const sortKey = (d, s, l, c) => ((d * 4 + s) * 8 + l) * 4096 + (c + 2048);
function mk(objects) {
  const ops = [];
  const gfx = {
    begin() {}, clear() {}, end() {}, image() {}, size: () => ({ w: 800, h: 600 }), setComposite() {},
    rect: (x, y, w, h, c) => ops.push({ op: 'rect', c }), poly: (pts, c) => ops.push({ op: 'poly', c, pts: JSON.stringify(pts) }),
  };
  class SpriteCache { get() { return null; } pump() {} }
  const ph = o => ({ img: { tag: o.id, width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] });
  const deps = {
    LAYER, sortKey, mergeSorted: l => l.flat().sort((a, b) => a.key - b.key), SpriteCache, spriteKey: o => o.model, placeholder: ph,
    sliceSprite: () => [], rasterize: () => ({}), artView: o => Object.freeze({ ...o }),
    createGround: () => ({ drawChunks() {}, chunkKeys: () => [], invalidate() {} }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }),
    createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }), effects: { draw() {} }, badges: { draw() {} },
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), version: 1 });
  return { r, ops };
}
const frame = (o = {}) => ({ cam: { x: 0, y: 0, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t: 1, night: 0, mode: 'town', ...o });
const obj = (id, kind, model, extra = {}) => ({ id, kind, model, tx: 0, ty: 0, w: 2, h: 2, z: 30, walk: 'block', styleKey: 's', variant: 0, ...extra });
const BEAM = /^rgba\(255,2(26|40),/;

test('[har.lighthouse-sweep] a lighthouse sweeps two warm beams at night, none by day, fading in with the dark', () => {
  const lh = obj('lighthouse', 'prop', 'lighthouse');
  const beams = (night, o = lh) => { const { r, ops } = mk([o]); r.draw(frame({ night })); return ops.filter(x => x.op === 'poly' && BEAM.test(x.c)).length; };
  assert.equal(beams(0), 0, 'no sweep by day');
  assert.equal(beams(0.3), 0, 'none below the sweep threshold');
  assert.equal(beams(0.9), 4, 'two wedges (wide + core) per beam, two beams');
  assert.equal(beams(0.9, obj('pier', 'venue', 'pier')), 0, 'only a lighthouse sweeps');
  const shape = t => { const { r, ops } = mk([lh]); r.draw(frame({ night: 0.9, t })); return ops.filter(x => x.op === 'poly').map(x => x.pts).join('|'); };
  assert.equal(shape(1), shape(1), 'deterministic');
  assert.notEqual(shape(1), shape(3), 'the beam turns with time');
});

test('[inp.dock-hover-outline] hovering the harbour in the host panel outlines the venue (and a hull) in the pale gold', () => {
  const pale = ops => ops.filter(x => x.c === '#ffe9a8').length;
  const venue = obj('dock-site', 'venue', 'pier');
  const a = mk([venue]); a.r.draw(frame());
  assert.equal(pale(a.ops), 0, 'no outline without a hover');
  const b = mk([venue]); b.r.draw(frame({ hoverPanel: 'dock' }));
  assert.ok(pale(b.ops) > 0, 'the venue under the pointer lights up its outline');
  const c = mk([obj('house', 'building', 'cottage')]); c.r.draw(frame({ hoverPanel: 'dock' }));
  assert.equal(pale(c.ops), 0, 'a plain building is not outlined');
  const d = mk([venue]); d.r.draw(frame({ hoverPanel: 'dock', mode: 'map' }));
  assert.equal(pale(d.ops), 0, 'not at Map zoom');
});

test('[vil.pose-carry-crate-shuttle] a carrier holding a crate draws it at the chest; empty-handed it does not', () => {
  const crate = ops => ops.filter(x => x.op === 'rect' && x.c === '#b98c4e').length;
  const porter = (carry) => ({ id: 'porter:dock:0', kind: CARRIER_KIND, x: 0.5, y: 0.5, face: 0, anim: 'walk', frame: 0, look: { seed: 1 }, flags: 1, carry });
  const run = a => { const { r, ops } = mk([]); r.draw(frame({ actors: [a] })); return crate(ops); };
  assert.equal(run(porter(true)), 1, 'crate drawn');
  assert.equal(run(porter(false)), 0, 'no crate when not carrying');
  assert.equal(run({ ...porter(true), kind: 'agent' }), 0, 'only carriers hold crates');
});

test('[lbl.ship-pr-tags] [har.dock-tags] PR numbers tag the hulls from zoom 3 only', () => {
  const prs = [{ id: 'token:app#42', pr: 42, x: 100, y: 50 }, { id: 'token:app#7', pr: 7, x: 200, y: 60 }];
  const tags = z => labelCands({ zoom: z, prs }).filter(c => c.cls === 'tag prt').map(c => c.text).sort();
  assert.deepEqual(tags(3), ['#42', '#7']);
  assert.deepEqual(tags(2), []);
});

test('[har.beacon] the beacon throws a warm steady pool at night; a channel buoy a small one; a bare lamp keeps the default', () => {
  const b = lightsFor({ model: 'beacon', kind: 'prop' });
  assert.equal(b.length, 1);
  assert.equal(b[0].warm, 1); assert.ok(b[0].r >= 40 && b[0].flicker <= 0.1);
  const u = lightsFor({ model: 'buoy', kind: 'prop' });
  assert.ok(u[0].r < b[0].r);
  assert.equal(lightsFor({ model: 'lamp', kind: 'prop' }), null);
});

test('[har.cove-reserved-tier4] the cove is cut for the biggest harbour whatever the level: every tier-4 object and berth sits inside it', () => {
  const D = dockSite({ square: { x: 40, y: 10, w: 8, h: 8 }, town: [0, 0, 100, 30] });
  const site = dockVenue(D), r = site.rect;
  assert.ok(r.y + r.h - 1 >= D.sea + DOCK_REACH - 1 && r.x <= D.x0 && r.x + r.w > D.x1, 'rect spans the classic cove and reaches DOCK_REACH into the water');
  const inside = (tx, ty, w = 1, h = 1) => tx >= r.x && ty >= r.y && tx + w <= r.x + r.w && ty + h <= r.y + r.h;
  for (const rank of [1, 5]) {
    const plan = VENUES.harbour.plan({ site: { ...site, data: site.data }, level: levelOf(4, rank) });
    for (const o of plan.objects) assert.ok(inside(o.tx, o.ty, o.w, o.h), `${o.id} inside the cove`);
    for (const b of plan.berths) assert.ok(inside(b.tx, b.ty), `berth ${b.id} inside the cove`);
    assert.ok(plan.berths.some(b => !PIER_ID.test(b.id)), 'tier 4 has anchorage berths');
  }
  assert.deepEqual(dockVenue(D).rect, site.rect, 'the cove does not depend on the level');
});

test('[har.dock-debug] debug().dock: tier from the packed level, rect, berths, ship sails, visible porters with carry, harbour lights only', () => {
  const dock = { id: 'dock', kind: 'harbour', level: levelOf(3, 2), tx: 40, ty: 10, rect: { x: 1, y: 2, w: 30, h: 20 }, berths: [{ id: 'p0w0', tx: 1, ty: 12, face: 2 }] };
  const objects = new Map([
    ['l', { model: 'lamp', tx: 3, ty: 4, data: { venue: 'dock' } }], ['b', { model: 'beacon', tx: 5, ty: 6, data: { venue: 'dock' } }],
    ['x', { model: 'lamp', tx: 9, ty: 9, data: { venue: 'other' } }], ['c', { model: 'crane', tx: 7, ty: 7, data: { venue: 'dock' } }],
  ]);
  const actors = [
    { id: 'token:a#1', kind: 'token', venue: 'dock', item: 'a#1', berth: 'p0w0', state: 'moored' },
    { id: 'porter:dock:0', kind: 'porter', venue: 'dock', flags: 1, state: 'walk', carry: true },
    { id: 'porter:dock:1', kind: 'porter', venue: 'dock', flags: 0, state: 'home', carry: false },
  ];
  const { dock: d } = venueDebug({ world: { venues: { dock }, objects }, actors });
  assert.equal(d.tier, 3);
  assert.deepEqual(d.rect, { x: 1, y: 2, w: 30, h: 20 });
  assert.deepEqual(d.berths, [{ id: 'p0w0', tx: 1, ty: 12 }]);
  assert.deepEqual(d.sails, [{ id: 'token:a#1', item: 'a#1', berth: 'p0w0', state: 'moored' }]);
  assert.deepEqual(d.walkers, [{ id: 'porter:dock:0', state: 'walk', carry: true }], 'only porters that are out');
  assert.deepEqual(d.lights.map(l => l.model).sort(), ['beacon', 'lamp'], 'this harbour\'s lights, not other venues\' or cranes');
  assert.deepEqual(venueDebug({ world: { venues: {}, objects } }), {}, 'no harbour, no dock key');
  assert.deepEqual(venueDebug({ world: { venues: { square: { kind: 'square' } }, objects } }), {}, 'venues but no harbour: no throw, no dock key');
});

test('[inp.dock-ship-click-va-dock] a harbour or ship hit opens the PR sheet by the va:dock event (href null: none in the world)', () => {
  assert.ok(PANEL_HIT_KINDS.has('dock') && PANEL_HIT_KINDS.has('ship') && !PANEL_HIT_KINDS.has('house'));
  const prev = globalThis.window, got = [];
  globalThis.window = new EventTarget();
  globalThis.window.addEventListener('va:dock', e => got.push(e.detail));
  try { openPrPanel(); openPrPanel('https://example.test/pull/1'); } finally { globalThis.window = prev; }
  assert.deepEqual(got, [{ href: null }, { href: 'https://example.test/pull/1' }]);
});
