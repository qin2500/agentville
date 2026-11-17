// M4 integration: what the integrator wires (camera keys, loop and visibility policy, night by local time, aria and
// dataset contract, the villageDebug compat shape on a real built world, the PR building site and accent fixes in the
// renderer, animated windmill sails and forge glow). Pure node, no DOM.
import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraCtl, isActive } from '../web/src/engine/camera-ctl.js';
import { nightAmount, nightFrame, ariaSummary, artState, nextFrame, FPS, bucketOrder, projectCounts, townWater, debugItems, debugHomes,
  debugHits, debugWalkers, debugClusters, debugOutdoors, prNumber } from '../web/src/engine/debug/compat.js';
import { createRenderer, siteOf } from '../web/src/engine/render/renderer.js';
import { toScreen } from '../web/src/engine/core/coords.js';
import { createEffects } from '../web/src/engine/render/effects.js';
import * as COMPAT from '../web/src/engine/debug/compat.js';

const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');

const at = (h, m = 0) => new Date(2026, 10, 14, h, m);

test('[camera.keys] + and = zoom in, - zooms out, 0 resets to the home fit', () => {
  const store = new Map(), st = { get: k => store.get(k), set: (k, v) => store.set(k, v) };
  const c = createCameraCtl({ vp: { w: 1200, h: 800 }, store: st, key: 'k', reduceMotion: true });
  const focus = { ox: 0, oy: 0, w: 20, h: 20 };
  c.setRects(focus, focus);
  c.home({ animate: false });
  const z0 = c.cam.z;
  assert.equal(c.key('+'), true); assert.equal(c.cam.z, Math.min(4, z0 < 1 ? 1 : z0 + 1));
  const z1 = c.cam.z;
  assert.equal(c.key('='), true); assert.equal(c.cam.z, Math.min(4, z1 + 1));
  assert.equal(c.key('-'), true); assert.equal(c.cam.z, z1);
  assert.equal(c.userMoved, true);
  assert.equal(c.key('0'), true);
  assert.equal(c.userMoved, false, 'reset hands the camera back to the auto fit');
  assert.equal(c.cam.z, z0);
  assert.equal(c.key('x'), false);
  assert.ok(store.get('k')?.v === 2, 'persisted under its key');
});

test('[loop.visibility-rules] draws unless hidden, zero-width or under a full panel; peek and village-only count', () => {
  assert.equal(isActive({}), true);
  assert.equal(isActive({ hidden: true }), false);
  assert.equal(isActive({ width: 0 }), false);
  assert.equal(isActive({ panel: 'full' }), false);
  assert.equal(isActive({ panel: 'full', peek: true }), true);
  assert.equal(isActive({ panel: 'full', villageOnly: true }), true);
  assert.equal(isActive({ panel: 'docked' }), true);
});

test('[loop.fps-8-on-demand] 8 fps while animating, rAF for a tween or streaming sprites, nothing otherwise or when hidden', () => {
  assert.equal(FPS, 8);
  assert.equal(nextFrame({ animating: true }), 125);
  assert.equal(nextFrame({ tweening: true }), 'raf');
  assert.equal(nextFrame({ streaming: true, animating: true }), 'raf');
  assert.equal(nextFrame({}), null, 'on demand');
  assert.equal(nextFrame({ active: false, animating: true, tweening: true }), null, 'hidden: no frames');
});

test('[night.amount-by-local-time] 20:00-06:00 full, ramps 18-20 and 06-08, day 0', () => {
  assert.equal(nightAmount(null, at(23)), 1);
  assert.equal(nightAmount(null, at(3)), 1);
  assert.equal(nightAmount(null, at(12)), 0);
  assert.equal(nightAmount(null, at(19)), 0.5);
  assert.equal(nightAmount(null, at(7)), 0.5);
  assert.equal(nightAmount(null, at(18)), 0);
  assert.equal(nightAmount(null, at(8)), 0);
});

test('[debug.night-param] ?night=1 forces night (midnight phase), ?night=0 forces day', () => {
  assert.deepEqual(nightFrame('1', at(12)), { night: 1, phase: 0 });
  assert.deepEqual(nightFrame('0', at(23)), { night: 0, phase: null });
  const dusk = nightFrame(null, at(19));
  assert.equal(dusk.night, 0.5); assert.ok(Math.abs(dusk.phase - 19 / 24) < 1e-9);
});

test('[aria.summary-label] counts, then the keyboard cursor agent', () => {
  assert.equal(ariaSummary({ loading: true }), 'Village: loading');
  assert.equal(ariaSummary({ total: 0 }), 'Village: no agents');
  assert.equal(ariaSummary({ total: 5, counts: { stalled: 2, waiting: 1, building: 2 } }), 'Village: 2 stalled, 1 waiting, 2 building');
  assert.equal(ariaSummary({ total: 1, counts: { stalled: 1 }, cursor: { name: 'CI Lead', role: 'lead', bucket: 'stalled' } }),
    'Village: 1 stalled, 0 waiting, 0 building. CI Lead, Lead, Stalled. Press Enter to select.');
});

test('[aria.dataset-art-villages-zoom] data-art: loading until the art is in, ready, failed when the sheets or art fail', () => {
  assert.equal(artState(null), 'loading');
  assert.equal(artState({ artReady: false, actorArt: false }), 'loading');
  assert.equal(artState({ artReady: true, actorArt: false }), 'loading');
  assert.equal(artState({ artReady: true, actorArt: true, actorLooks: 13 }), 'ready');
  assert.equal(artState({ artReady: true, actorArt: true, actorLooks: 0 }), 'failed');
  assert.equal(artState({ artReady: false, artFailed: true }), 'failed');
});

test('[inp.keyboard-cycle-by-bucket] keyboard order: stalled, waiting, building, resting; hidden and unplaced left out', () => {
  const ag = [{ id: 'r', bucket: 'resting' }, { id: 'b', bucket: 'building' }, { id: 's1', bucket: 'stalled' }, { id: 'w', bucket: 'waiting' },
    { id: 's2', bucket: 'stalled' }, { id: 'h', bucket: 'stalled', hidden: true }, { id: 'x', bucket: 'stalled' }];
  assert.deepEqual(bucketOrder(ag, id => id !== 'x'), ['s1', 's2', 'w', 'b', 'r']);
});

// ---- the villageDebug compat shape on a real world (the busy fixture)
const mod = resolveMod();
const fx = loadFixture('busy.json');
const view = viewFromFixture(fx);
const { input, serverId } = toWorldInput(view, { seed: 7, salt: '7' });
const world = buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { mod, now: fx.now, seed: 7, serverId });

test('[debug.villagedebug] compat: one town with no water, every item dry, PR sites and homes listed with server ids', () => {
  assert.equal(townWater(world, mod), 0);
  const items = debugItems(world, mod);
  assert.ok(items.length > 50);
  assert.ok(items.every(it => it.wet === 0), 'every item stands on land');
  for (const k of ['home', 'pr', 'house', 'civic', 'decor']) assert.ok(items.some(it => it.kind === k), `has ${k}`);
  const prs = items.filter(it => it.kind === 'pr');
  assert.ok(prs.every(it => /^pr:.+#\d+$/.test(it.id) && typeof it.building === 'boolean'));
  const byName = new Map(world.villages.map(v => [v.name, v.block]));
  for (const it of items.filter(i => i.kind !== 'decor')) {
    const b = byName.get(it.village);
    assert.ok(b && it.x >= b.x && it.y >= b.y && it.x + it.w <= b.x + b.w && it.y + it.h <= b.y + b.h, `${it.id} inside ${it.village}`);
  }
  const homes = debugHomes(world), ids = new Set(view.agents.map(a => a.id));
  assert.ok(homes.length > 0 && homes.every(id => ids.has(id)), 'homes are server ids');
  assert.equal(prNumber('amber#1046'), 1046);
});

test('[debug.villagedebug] compat: hits, outdoors, walkers and clusters map opaque ids to server ids', () => {
  const actors = [{ id: 'o1', kind: 'agent', anim: 'hammer', home: 'lot:x:L1', flags: 1, x: 1, y: 1 }, { id: 'o2', kind: 'agent', flags: 8, x: 2, y: 2 },
    { id: 'c1', kind: 'critter', species: 'chicken', face: 3, anim: 'walk', x: 4, y: 1 }];
  const toS = id => ({ o1: 'S1', o2: 'S2' })[id];
  const hits = [{ id: 'o1', kind: 'agent', rect: [10, 20, 30, 60] }, { id: 'o1', kind: 'agent', rect: [10, 20, 30, 60] }, { id: 'lot', kind: 'house', rect: [0, 0, 5, 5] }];
  assert.deepEqual(debugHits(hits, id => actors.find(a => a.id === id), toS), [{ id: 'S1', x: 10, y: 20, w: 20, h: 40, pose: 'hammer', home: 'lot:x:L1', occluded: false }]);
  assert.deepEqual(debugOutdoors(actors, toS), ['S1']);
  const [wk] = debugWalkers(actors, 1.5);
  assert.deepEqual({ ...wk, x: undefined, y: undefined }, { id: 'c1', kind: 'chicken', x: undefined, y: undefined, t: 1.5, facing: 'R', moving: true });
  assert.equal(wk.x, toScreen(4, 1).sx);
  assert.deepEqual(debugClusters([{ text: 'amber', counts: { need: 1, error: 0, prompt: 0, wait: 2 }, rect: { l: 1, t: 2, r: 11, b: 22 } }, { text: 'x', rect: {} }]),
    [{ name: 'amber', need: 1, error: 0, prompt: 0, wait: 2, x: 1, y: 2, w: 10, h: 20 }]);
  const c = projectCounts([{ project: 'p', bucket: 'stalled', severity: 'error' }, { project: 'p', bucket: 'stalled', prompt: 'plan' },
    { project: 'p', bucket: 'stalled' }, { project: 'p', bucket: 'waiting' }, { project: 'p', bucket: 'waiting', hidden: true }]);
  assert.deepEqual(c.get('p'), { need: 1, error: 1, prompt: 1, wait: 1 });
});

// ---- renderer fixes
function rig({ objects, villages = [] }) {
  const calls = { raster: [], polys: 0, rects: 0 };
  const gfx = { begin() {}, clear() {}, end() {}, image() {}, rect: () => calls.rects++, poly: () => calls.polys++, setComposite() {} };
  class SpriteCache {
    constructor() { this.map = new Map(); }
    get(key, make) { if (!this.map.has(key)) { const e = make(); this.map.set(key, e ? { ...e } : null); } return this.map.get(key); }
    pump() {}
  }
  const deps = {
    SpriteCache, loadClassicArt: undefined,
    rasterize: (model, style, opts) => {
      calls.raster.push({ model, style, opts });
      return { img: { width: 64, height: 64 }, bounds: { x: 0, y: 0, w: 64, h: 64 }, pivot: { x: 32, y: 20 }, anchors: model === 'windmill' ? { hub: { x: 30, y: 10 } } : model === 'smithy' ? { glow: { x: 30, y: 40 } } : {} };
    },
    createGround: () => ({ drawChunks: () => ({ pending: 0 }) }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }),
    createXray: () => ({ occluded: () => false, fadeFor: () => undefined, draw() {} }),
    createActorArt: () => null,
    effects: { draw() {} },
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), villages, version: 1 });
  const draw = (t = 0, still = false) => r.draw({ cam: { x: 0, y: 0, z: 2 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t, night: 0, mode: 'town', still });
  return { r, calls, draw };
}
const bld = (id, model, extra = {}) => ({ id, kind: 'building', model, tx: 0, ty: 0, w: 2, h: 2, z: 30, walk: 'block', styleKey: 's', variant: 0, project: 'amber', ...extra });

test('[bld.pr-building-site] a live PR lot rasterises as a building site (lots.js writes data.building), a finished one does not', () => {
  assert.equal(siteOf({ data: { owner: 'pr', building: true } }), true);
  assert.equal(siteOf({ data: { owner: 'pr', building: false } }), false);
  assert.equal(siteOf({ data: { owner: 'home' } }), false);
  const { calls, draw } = rig({ objects: [bld('live', 'townhouse', { data: { owner: 'pr', pr: 'amber#2', building: true } }),
    bld('done', 'townhouse', { tx: 4, data: { owner: 'pr', pr: 'amber#1', building: false } })] });
  draw();
  const by = Object.fromEntries(calls.raster.map(c => [c.opts.obj?.id ?? c.opts.variant + c.model, c]));
  const sites = calls.raster.map(c => c.opts.site);
  assert.deepEqual(sites.sort(), [false, true], 'one site, one finished building, under different sprite keys');
  void by;
});

test('[style.banners-on-plazas] the village accent rides on the style the art reads and splits the sprite key', () => {
  const villages = [{ name: 'amber', block: { x: 0, y: 0, w: 10, h: 10 }, style: { roof: 'r' } }, { name: 'birch', block: { x: 12, y: 0, w: 10, h: 10 }, style: { roof: 'r' } }];
  const { calls, draw } = rig({ villages, objects: [{ id: 'b1', kind: 'prop', model: 'banner', tx: 1, ty: 1, w: 1, h: 1, z: 20, walk: 'floor', styleKey: 's', variant: 0, project: 'amber' },
    { id: 'b2', kind: 'prop', model: 'banner', tx: 13, ty: 1, w: 1, h: 1, z: 20, walk: 'floor', styleKey: 's', variant: 0, project: 'birch' }] });
  draw();
  const acc = calls.raster.map(c => c.style?.accent);
  assert.equal(calls.raster.length, 2, 'neighbouring villages get distinct accents, so two sprites');
  assert.ok(acc.every(a => /^#[0-9a-f]{6}$/i.test(a)) && acc[0] !== acc[1]);
  assert.equal(calls.raster[0].style.roof, 'r', 'the village style is kept');
});

test('[bld.look-windmill-turning-sails] [bld.look-smithy-forge-glow] sails and forge glow are drawn per frame and move with t', () => {
  const mill = rig({ objects: [bld('m', 'windmill')] });
  mill.draw(0);   // first frame rasterises
  const p0 = mill.calls.polys; mill.draw(0); const per = mill.calls.polys - p0;
  assert.ok(per >= 12, `four sails drawn (${per} polys)`);
  const forge = rig({ objects: [bld('f', 'smithy')] });
  forge.draw(0); const r0 = forge.calls.rects; forge.draw(1); assert.ok(forge.calls.rects - r0 >= 3, 'forge glow drawn');
  const none = rig({ objects: [bld('c', 'cottage')] });
  none.draw(0); const n0 = none.calls.polys + none.calls.rects; none.draw(1);
  assert.equal(none.calls.polys + none.calls.rects - n0, 0, 'other looks draw no overlay');
});

test('effects.stats() reports puffs and birds of the last draw', () => {
  const fx2 = createEffects({ world: { objects: new Map(), villages: [] } });
  const g = { rect() {}, poly() {}, image() {} };
  fx2.draw(g, { z: 2 }, { rect: [-500, -500, 500, 500], zoom: 2 }, { t: 1 });
  assert.deepEqual(fx2.stats(), { puffs: 0, birds: true });
  fx2.draw(g, { z: 2 }, { rect: [-500, -500, 500, 500], zoom: 2 }, { t: 30 });
  assert.equal(fx2.stats().birds, false);
});

test('[debug.citydemo] [debug.citytier] dev params: ?citydemo=1, ?citytier=N (rounded, never negative), seed, t, night', () => {
  const { devParams } = COMPAT;
  assert.deepEqual(devParams('?citydemo=1&citytier=2.6&seed=-1&t=30&night=1'), { demo: true, tier: 3, style: null, seed: 4294967295, t: 30, night: '1', grid: null });
  assert.equal(devParams('?citytier=-4').tier, 0);
  assert.equal(devParams('?citytier=').tier, null);
  assert.equal(devParams('?citytier=x').tier, null);
  assert.equal(devParams('').demo, false);
});

test('[bld.lit-windows-agent-home] at night the renderer tells the lighting which homes have their agent in (resting)', () => {
  let statusOf = null;
  const objects = [bld('h1', 'cottage')];
  const gfx = { begin() {}, clear() {}, end() {}, image() {}, rect() {}, poly() {}, setComposite() {} };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps: {
    rasterize: () => null, placeholder: () => ({ img: { tag: 'ph', width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }), createGround: () => ({ drawChunks: () => ({ pending: 0 }) }), createActorArt: () => null, effects: { draw() {} },
    createLighting: o => { statusOf = o.statusOf; return { setTime() {}, lights: () => [], draw() {} }; }, createXray: () => ({ occluded: () => false, draw() {} }) } });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), villages: [], version: 1 });
  const actors = [{ id: 'a', kind: 'agent', x: 0.5, y: 2.5, flags: 8, home: 'h1', input: { status: 'resting' } }, { id: 'b', kind: 'agent', x: 1, y: 3, flags: 1, home: 'h2', input: { status: 'working' } }];
  r.draw({ cam: { x: 0, y: 0, z: 2 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors, t: 0, night: 1, phase: 0, mode: 'town' });
  assert.equal(statusOf('h1'), 'resting');
  assert.equal(statusOf('h2'), 'working');
  assert.equal(statusOf('nope'), undefined);
});

test('[vil.resting-indoors] a resting agent is indoors (not drawn, no hit), its selection shows the door ghost and home outline', () => {
  const objects = [bld('h1', 'cottage', { door: { tx: 1, ty: 2, face: 'S' } })];
  const images = [];
  const gfx = { begin() {}, clear() {}, end() {}, image: (img, ...a) => images.push(img), rect() {}, poly() {}, setComposite() {} };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps: {
    rasterize: () => null, placeholder: () => ({ img: { tag: 'ph', width: 32, height: 32 }, bounds: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 16, y: 32 }, slices: [] }), createGround: () => ({ drawChunks: () => ({ pending: 0 }) }), effects: { draw() {} },
    createActorArt: () => ({ load() {}, frame: () => ({ img: { tag: 'ghost', width: 20, height: 22 }, pivot: { x: 10, y: 18 } }) }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }), createXray: () => ({ occluded: () => false, draw() {} }) } });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), villages: [], version: 1 });
  const a = { id: 'a', kind: 'agent', x: 1.5, y: 2.5, flags: 8 | 2, home: 'h1', input: { status: 'resting' } };
  const hits = r.draw({ cam: { x: 0, y: 0, z: 2 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [a], t: 0, night: 0, mode: 'town', selected: 'a' });
  assert.ok(!hits.some(h => h.kind === 'agent'), 'indoors: no agent hit');
  assert.equal(images.filter(i => i?.tag === 'ghost').length, 1, 'only the ghost at the door is drawn');
});
