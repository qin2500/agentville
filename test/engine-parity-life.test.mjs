import './support/ensure-mods-index.mjs';
// Parity proofs for building looks, villager poses, ambient life and night lighting. Each test title carries the
// parity id in [brackets]; tools/parity.mjs --run counts it only when it actually ran and passed.
// Building art runs the REAL classic iso.js (via the engine rasteriser's art seam) on a tiny in-memory canvas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ---- minimal DOM so the real iso.js can draw in node -------------------------------------------------------------------
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.ImageData ??= class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; this.buf = null; }
  getContext() {
    const c = this;
    const buf = () => (c.buf ||= new Uint8ClampedArray(c.width * c.height * 4));
    return { fillStyle: '', putImageData(id) { c.buf = Uint8ClampedArray.from(id.data); }, getImageData() { return { data: buf(), width: c.width, height: c.height }; },
      fillRect() {}, clearRect() {},
      drawImage(src, x, y) { const d = buf(); for (let j = 0; j < src.height; j++) for (let i = 0; i < src.width; i++) { const s0 = (j * src.width + i) * 4; if (!src.buf[s0 + 3]) continue; const o = ((j + y) * c.width + i + x) * 4; for (let k = 0; k < 4; k++) d[o + k] = src.buf[s0 + k]; } } };
  }
}
globalThis.document ??= { createElement: () => new FakeCanvas() };
const iso = await import('../web/src/iso.js');
const { rasterize, setCanvasFactory, useClassicArt } = await import('../web/src/engine/art/raster.js');
const { OBJECT_TYPES } = await import('../mods/agentville.fantasy/objects.js');

const draw = (look, lit = false, w = 3, h = 3) =>
  iso.isoBuilding({ id: 'x', kind: 'building', look, w, h, x: 0, y: 0, variant: 0, village: { accent: '#c46a42' }, doorX: 24 }, 16, lit, 1.25);
const alphaOf = r => { const a = r.img.buf; let solid = 0, soft = 0; for (let i = 3; i < a.length; i += 4) { if (a[i] === 255) solid++; else if (a[i] > 0) soft++; } return { solid, soft }; };
const sig = r => Buffer.from(r.img.buf).toString('base64');

function looksRender(looks) {
  const seen = new Set();
  for (const look of looks) {
    assert.ok(OBJECT_TYPES.buildings[look]?.z > 0, `${look} is in the mod's building table`);
    const r = draw(look);
    assert.ok(r.box[2] > 20 && r.box[3] > 20, `${look} draws a building`);
    assert.ok(r.door, `${look} has a door anchor`);
    seen.add(sig(r));
  }
  return seen;
}

test('[bld.looks-farmhouse-cottage-timber-townhouse-manor] the five house looks each draw a distinct building', () => {
  assert.equal(looksRender(['farmhouse', 'cottage', 'timber', 'townhouse', 'manor']).size, 5);
});
test('[bld.looks-palace-hall] palace and hall draw distinct buildings', () => {
  assert.equal(looksRender(['palace', 'hall']).size, 2);
  assert.ok(draw('palace').box[3] > draw('hall').box[3] - 10);
});
for (const look of ['barn', 'granary', 'chapel', 'inn', 'guildhall', 'clocktower', 'markethall', 'cathedral']) {
  test(`[bld.look-${look}] ${look} draws a building of its own`, () => {
    const mine = looksRender([look]);
    const cottage = sig(draw('cottage'));
    assert.ok(!mine.has(cottage), `${look} differs from the cottage`);
  });
}
test('[bld.look-legacy-house-and-tower] the legacy hall and tower looks still draw (hall, tower, towerDome)', () => {
  const sigs = new Set();
  for (const look of ['hall', 'tower', 'towerDome', 'houseA']) {
    const r = draw(look); assert.ok(r.box[2] > 20 && r.box[3] > 20, look); sigs.add(sig(r));
  }
  assert.ok(sigs.size >= 3, 'tower and house looks are told apart');
  // the engine rasteriser hands any look name to the classic art, so the legacy names need no table of their own
  const seen = [];
  useClassicArt({ isoBuilding: (it, ...r) => { seen.push(it.look); return iso.isoBuilding(it, ...r); }, isoExtent: iso.isoExtent, createPropArt: () => ({}) });
  setCanvasFactory((w, h) => { const c = new FakeCanvas(); c.width = w; c.height = h; return c; });
  const out = rasterize('towerDome', {}, { kind: 'building', w: 2, h: 2 });
  assert.deepEqual(seen, ['towerDome']); assert.ok(out.bounds.w > 0 && out.bounds.h > 0);
});

test('[bld.ground-shadows] a building sprite carries soft (translucent) ground-shadow pixels below its solid walls', () => {
  for (const look of ['cottage', 'manor', 'barn']) {
    const r = draw(look), { soft, solid } = alphaOf(r);
    assert.ok(soft > 50 && solid > soft, `${look}: soft ${soft} solid ${solid}`);
    // the shadow sits on the ground: the lowest translucent row is at or below the lowest solid wall row
    const W = r.img.width, a = r.img.buf; let lowSoft = -1, lowSolid = -1;
    for (let y = 0; y < r.img.height; y++) for (let x = 0; x < W; x++) { const v = a[(y * W + x) * 4 + 3]; if (v === 255) lowSolid = y; else if (v > 0) lowSoft = y; }
    assert.ok(lowSoft >= lowSolid - 6, `${look}: shadow row ${lowSoft} vs wall base ${lowSolid}`);
  }
});

// ---- villagers ------------------------------------------------------------------------------------------------------------
const { representAgent, ENGINE_BEHAVIOUR } = await import('../web/src/engine/sim/represent.js');
const { ANIMS, FLAGS } = await import('../web/src/engine/sim/actor.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { loadFixture, makeSim, simMod, present, agentsOf, advance } = await import('./engine-support/sim-harness.mjs');
const fantasyMod = { behaviour: fantasy.behaviour, represent: fantasy.represent };

test('[vil.stopped-important-faded-doorstep] a stopped or Important resting agent stands on the doorstep as a half-faded ghost', async () => {
  for (const o of [{ status: 'resting', stopped: true }, { status: 'resting', important: true }]) {
    const s = representAgent(o, fantasyMod);
    assert.equal(s.key, 'resting:doorstep'); assert.equal(s.ghost, true); assert.equal(s.indoors, false); assert.equal(s.place, 'home.forecourt');
  }
  assert.equal(representAgent({ status: 'resting' }, fantasyMod).ghost, false);
  // the sim sets the GHOST flag, and the renderer draws a GHOST actor at alpha 0.5
  const { createRenderer } = await import('../web/src/engine/render/renderer.js');
  const D = await import('../web/src/engine/render/depth.js');
  const { toScreen } = await import('../web/src/engine/core/coords.js');
  const ops = [];
  const gfx = { begin() {}, clear() {}, end() {}, image: (img, ...r) => ops.push([img.tag, r[r.length - 1]]), rect() {}, poly() {}, setComposite() {}, size: () => ({ w: 800, h: 600 }) };
  const deps = { LAYER: D.LAYER, sortKey: D.sortKey, mergeSorted: l => l.flat().sort((a, b) => a.key - b.key), SpriteCache: class { get() { return null; } pump() {} },
    spriteKey: () => 'k', placeholder: o => ({ img: { tag: 'ph', width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }),
    sliceSprite: () => [], rasterize: () => ({}), artView: o => Object.freeze({ id: o.id }), createGround: () => ({ drawChunks() {}, chunkKeys: () => [], invalidate() {} }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }), createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }), effects: { draw() {} }, badges: { draw() {} } };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld({ objects: new Map(), version: 1 });
  const base = { kind: 'agent', x: 1.5, y: 1.5, face: 0, anim: 'idle', frame: 0, look: {} };
  r.draw({ cam: { x: 0, y: 0, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, t: 0, night: 0, mode: 'town',
    actors: [{ ...base, id: 'ghost', flags: FLAGS.VISIBLE | FLAGS.GHOST }, { ...base, id: 'plain', x: 2.5, y: 2.5, flags: FLAGS.VISIBLE }] });
  const alphas = ops.filter(o => o[0] !== undefined && o[1] !== undefined).map(o => o[1]);
  assert.ok(alphas.includes(0.5), `a ghost is drawn at alpha 0.5 (got ${JSON.stringify(ops)})`);
  assert.ok(ops.length >= 2);
  void toScreen;
});

test('[vil.pose-stand-sit] stalled agents stand on their forecourt, waiting agents sit on a bench anchor', () => {
  assert.ok(ANIMS.includes('idle') && ANIMS.includes('sit'));
  const waiting = representAgent({ status: 'waiting' }, fantasyMod);
  assert.equal(waiting.place, 'anchor:sit'); assert.equal(waiting.pose, 'sit');
  const stalled = representAgent({ status: 'stalled' }, fantasyMod);
  assert.equal(stalled.pose, 'stand'); assert.equal(stalled.place, 'home.forecourt');
  assert.equal(fantasy.represent.poses.stand, 'idle', "the mod's 'stand' pose is the engine idle anim");
  assert.equal(ENGINE_BEHAVIOUR.waiting.pose, 'sit');
  // in the sim a waiting agent really settles into the sit anim at a sit slot, and a stalled one stays idle
  const fx = loadFixture('citydemo.json');
  assert.ok(fx && present);
  const { sim } = makeSim(fx);
  const sat = new Set(), stoodStalled = new Set();
  for (let i = 0; i < 1200; i++) {
    advance(sim);
    for (const a of agentsOf(sim)) {
      const st = a.input?.status ?? a.status?.bucket ?? a.status;
      if (st === 'waiting' && a.anim === 'sit') sat.add(a.id);
      if (st === 'stalled' && a.anim === 'idle') stoodStalled.add(a.id);
    }
  }
  assert.ok(sat.size > 0, 'a waiting agent sat');
  assert.ok(stoodStalled.size > 0, 'a stalled agent stood');
  void simMod;
});

test('[vil.xray-silhouette] an occluded agent is drawn as a silhouette of its own sprite, clipped to the building in front', async () => {
  const { createXray, ALPHA_SELECTED } = await import('../web/src/engine/render/xray.js');
  const { sortKey, feetKey, LAYER } = await import('../web/src/engine/render/depth.js');
  const { toScreen } = await import('../web/src/engine/core/coords.js');
  const xray = createXray({ world: { objects: new Map(), grid: null } });
  const P = toScreen(3.5, 2.5);
  const tower = { key: sortKey(10, 0, LAYER.OBJECT, 0), sx: 0, sy: 0, sw: 32, sh: 100, dx: Math.round(P.sx) - 16, dy: Math.round(P.sy) - 60, img: { tag: 'tower' }, oid: 'tower', obj: { id: 'tower' } };
  const it = { key: feetKey(3.5, 2.5, LAYER.ACTOR), x: 3.5, y: 2.5, p: P, actor: { id: 'v', x: 3.5, y: 2.5, flags: 3 }, img: { tag: 'spr', width: 20, height: 22 }, w: 20, h: 22, pivot: { x: 10, y: 18 } };
  const calls = []; const gfx = { silhouette: o => { calls.push(o); return true; }, rect() {} };
  assert.equal(xray.draw(gfx, {}, [it], [tower]), 1);
  assert.equal(calls[0].img.tag, 'spr'); assert.equal(calls[0].alpha, ALPHA_SELECTED);
  assert.deepEqual(calls[0].clips.map(c => c.img.tag), ['tower']);
  const clear = { ...it, x: -9.5, p: toScreen(-9.5, 2.5), key: feetKey(-9.5, 2.5, LAYER.ACTOR) };
  assert.equal(xray.draw({ silhouette: () => assert.fail('not occluded'), rect() {} }, {}, [clear], [tower]), 0);
});

// ---- ambient life ---------------------------------------------------------------------------------------------------------
const { spawnTownsfolk, COUNT_BY_TIER, carriesLantern, VENDOR_SHARE } = await import('../mods/agentville.fantasy/ambient/townsfolk.js');
const { spawnCarts } = await import('../mods/agentville.fantasy/ambient/cart.js');
const { spawnCritters } = await import('../mods/agentville.fantasy/ambient/critter.js');
const rnd = (...k) => { let h = 2166136261; for (const c of k.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

function townWorld(tiers) {
  const objects = new Map(), villages = [];
  tiers.forEach((tier, i) => {
    const name = `v${i}`; villages.push({ name, tier, cx: 10 + i * 20, cy: 10 });
    for (let k = 0; k < 4; k++) objects.set(`${name}:h${k}`, { id: `${name}:h${k}`, kind: 'building', project: name, lot: true, data: { owner: 'house' }, door: { tx: 10 + i * 20 + k, ty: 12, face: 2 } });
  });
  return { objects, villages, square: { x: 0, y: 0, w: 6, h: 6 } };
}

test('[amb.townsfolk-walkers-by-tier] a settlement spawns 2 / 5 / 10 / 18 townsfolk by tier', () => {
  assert.deepEqual(COUNT_BY_TIER, [2, 5, 10, 18]);
  const folk = spawnTownsfolk(townWorld([0, 1, 2, 3]), rnd);
  for (const t of [0, 1, 2, 3]) assert.equal(folk.filter(f => f.project === `v${t}`).length, COUNT_BY_TIER[t], `tier ${t}`);
});

test('[amb.night-lanterns-20pct] about 20% of townsfolk carry a lantern, lit only at night and outdoors, as a warm light pool', async () => {
  let n = 0; for (let i = 0; i < 4000; i++) if (carriesLantern(`folk:t${i % 40}:${i}`)) n++;
  assert.ok(n / 4000 > 0.17 && n / 4000 < 0.23, `share ${n / 4000}`);
  const { default: beh } = await import('../mods/agentville.fantasy/ambient/townsfolk.js');
  const mkA = (indoors) => ({ id: 'folk:x:1', kind: 'folk', x: 3.5, y: 3.5, lantern: true, state: 'dwell', dwell: 99, stop: 'sit', sched: { i: 0, n: 0 }, flags: indoors ? 8 : 1 });
  const world = { objects: new Map() };
  const ctx = night => ({ world, rand: () => 0.5, night, now: 0, slots: {}, nav: null, FLAGS: { VISIBLE: 1, INDOORS: 8 } });
  const a = mkA(false); beh.update(a, 0.05, ctx(true)); assert.deepEqual([...a.fx], ['lantern']);
  const d = mkA(false); beh.update(d, 0.05, ctx(false)); assert.equal(d.fx, undefined);
  // the lighting module turns the lantern fx into a small warm pool
  const { createLighting } = await import('../web/src/engine/render/lighting.js');
  const L = createLighting({ world: { objects: new Map() }, createCanvas: () => ({ getContext: () => ({}) }) });
  const ls = L.lights(null, new Map([['f', { id: 'f', x: 3, y: 3, fx: ['lantern'] }]]));
  assert.equal(ls.length, 1); assert.equal(ls[0].kind, 'lantern'); assert.equal(ls[0].warm, 1);
});

test('[amb.vendors-at-stalls] vendors exist from tier 1 up and spend the day on a stall vend slot', () => {
  const folk = spawnTownsfolk(townWorld([0, 1, 2, 3]), rnd);
  assert.equal(folk.filter(f => f.role === 'vendor' && f.project === 'v0').length, 0);
  for (const t of [1, 2, 3]) assert.equal(folk.filter(f => f.role === 'vendor' && f.project === `v${t}`).length, Math.max(1, Math.round(COUNT_BY_TIER[t] * VENDOR_SHARE)));
  assert.deepEqual(OBJECT_TYPES.props.stall.byDir.x.anchors.vend.length, 1, 'the stall prop offers a vend anchor');
  const fx = loadFixture('citydemo.json');
  const { sim } = makeSim(fx);
  const atStall = new Set(); let vendors = 0;
  for (let i = 0; i < 2400; i++) {
    advance(sim);
    for (const a of sim.actors.values()) if (a.kind === 'folk' && a.role === 'vendor') { if (i === 0) vendors++; if (a.stop === 'vend' && a.slot?.kind === 'vend' && a.state === 'dwell') atStall.add(a.id); }
  }
  assert.ok(vendors > 0, 'the fixture has vendors'); assert.ok(atStall.size > 0, 'a vendor reached a stall slot');
});

test('[amb.carts-in-towns-cities] carts run only in towns and cities: 0 / 0 / 1 / 2 per settlement by tier', () => {
  const carts = spawnCarts(townWorld([0, 1, 2, 3]), rnd);
  const by = t => carts.filter(c => c.project === `v${t}`).length;
  assert.deepEqual([0, 1, 2, 3].map(by), [0, 0, 1, 2]);
  assert.ok(carts.every(c => c.kind === 'cart' && c.target === 'square'));
});

test('[amb.pigeons-on-squares] pigeons spawn on the town square tiles', () => {
  const fx = loadFixture('citydemo.json');
  return import('./engine-support/sim-harness.mjs').then(({ buildFrom: bf }) => {
    const { world } = bf(fx);
    const sq = world.square; assert.ok(sq && sq.w > 0, 'the fixture has a square');
    const pigeons = spawnCritters(world, rnd).filter(c => c.species === 'pigeon');
    assert.ok(pigeons.length > 0);
    for (const p of pigeons) assert.ok(p.x >= sq.x && p.x < sq.x + sq.w && p.y >= sq.y && p.y < sq.y + sq.h, `${p.id} on the square`);
  });
});

// ---- night ---------------------------------------------------------------------------------------------------------------
const { createLighting, nightOf, veilColor, POOL_LIFT, GLOW_FROM } = await import('../web/src/engine/render/lighting.js');
function lightRig() {
  const log = [], gl = [];
  const mk = () => { const ctx = { globalCompositeOperation: 'source-over', fillStyle: '', clearRect() {}, fillRect() { log.push(this.globalCompositeOperation); }, createRadialGradient() { return { addColorStop() {} }; } }; return { getContext: () => ctx }; };
  return { log, mk };
}
const gfxLog = () => { const c = []; return { c, setComposite: op => c.push(op), image() {} }; };

test('[night.lamppost-glow] lamps and lampposts are lit at night: each makes a warm light pool, none by day', () => {
  const objs = [{ id: 'l', kind: 'prop', model: 'lamp', tx: 10, ty: 10, w: 1, h: 1, z: 30 }, { id: 'p', kind: 'prop', model: 'lamppost', tx: 11, ty: 10, w: 1, h: 1, z: 40 },
    { id: 'r', kind: 'prop', model: 'rock', tx: 12, ty: 10, w: 1, h: 1, z: 8 }];
  const rig = lightRig();
  const L = createLighting({ world: { objects: new Map(objs.map(o => [o.id, o])) }, createCanvas: rig.mk });
  const ls = L.lights();
  assert.deepEqual(ls.map(l => l.id).sort(), ['l', 'p']); assert.ok(ls.every(l => l.kind === 'lamp' && l.warm > 0 && l.r >= 48));
  const g = gfxLog(); L.setTime(0.5); assert.equal(L.draw(g, { x: 10, y: 10, z: 1 }, { cssW: 400, cssH: 300, dpr: 1 }, ls), 0);
  L.setTime(0); assert.equal(L.draw(g, { x: 10, y: 10, z: 1 }, { cssW: 400, cssH: 300, dpr: 1 }, ls), 2);
});

test('[night.warm-glow] after dark a warm additive (lighter) glow layer is drawn over the veil, fading in from dusk', () => {
  assert.ok(GLOW_FROM > 0 && GLOW_FROM < 1);
  const objs = [{ id: 'l', kind: 'prop', model: 'lamp', tx: 10, ty: 10, w: 1, h: 1, z: 30 }];
  const L = createLighting({ world: { objects: new Map(objs.map(o => [o.id, o])) }, createCanvas: lightRig().mk });
  const view = { cssW: 400, cssH: 300, dpr: 1 }, cam = { x: 10, y: 10, z: 1 };
  const night = gfxLog(); L.setTime(0); L.draw(night, cam, view);
  assert.deepEqual(night.c, ['source-over', 'lighter', 'source-over']);
  const dusk = gfxLog(); L.setNight(GLOW_FROM - 0.05); L.draw(dusk, cam, view);
  assert.deepEqual(dusk.c, ['source-over', 'source-over'], 'no glow while it is still light');
  assert.equal(nightOf(0.5), 0);
  assert.ok(POOL_LIFT > 0 && veilColor(1) !== veilColor(0));
});
