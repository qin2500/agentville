import './support/ensure-mods-index.mjs';
// Parity gap proofs (engine side): bld.lit-windows-night and vil.yard-cap-plus-n-more.
// Classic: web/src/world.js drawBuildings (lit when night > 0.5, never a PR site), drawNight (window pools), placeAgents
// (every agent drawn, overflow spills beside the yard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { createLighting } from '../web/src/engine/render/lighting.js';
import { labelCands } from '../web/src/engine/overlay/labels.js';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { createSim, STEP } = await import('../web/src/engine/sim/world-sim.js');
const { FLAGS } = await import('../web/src/engine/sim/actor.js');
const agentBeh = await import('../web/src/engine/sim/behaviours/agent.js');
const YARD_CAP = agentBeh.YARD_CAP;

// ---- bld.lit-windows-night ---------------------------------------------------------------------------------------

function rig() {
  const imgs = [], rasters = [];
  const gfx = { begin() {}, clear() {}, end() {}, image(...a) { imgs.push(a); }, rect() {}, poly() {}, setComposite() {}, size: () => ({ w: 800, h: 600 }) };
  const deps = {
    rasterize: (model, style, o) => { rasters.push({ model, lit: !!o.lit, kind: o.kind }); return { img: { width: 64, height: 64, tag: `${model}:${o.lit ? 'lit' : 'day'}` }, bounds: { x: 0, y: 0, w: 64, h: 64 }, pivot: { x: 32, y: 60 }, anchors: {}, slices: [] }; },
    loadClassicArt: async () => {}, createGround: () => ({ drawChunks() {} }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }), createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }),
    effects: { draw() {} }, badges: { draw() {} },
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  const mk = (id, extra) => ({ id, kind: 'building', model: 'cottage', tx: 0, ty: 0, w: 2, h: 2, z: 24, walk: 'block', styleKey: 's', variant: 0, ...extra });
  r.setWorld({ objects: new Map([['h', mk('h', { tx: 0, data: { owner: 'home' } })], ['p', mk('p', { tx: 4, model: 'site', data: { owner: 'pr', building: true } })], ['t', { ...mk('t', { tx: 8 }), kind: 'prop', model: 'rock', w: 1, h: 1 }]]), version: 1 });
  const frame = night => ({ cam: { x: 3, y: 3, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t: 0, night, mode: 'town' });
  const settle = async (night) => { for (let i = 0; i < 6; i++) { await new Promise(res => setTimeout(res, 5)); imgs.length = 0; r.draw(frame(night)); } return imgs.map(a => a[0]?.tag).filter(Boolean); };
  return { settle, rasters };
}

test('[bld.lit-windows-night] buildings (not PR sites, not props) are rastered lit once night > 0.5; day frames stay day', async () => {
  const { settle, rasters } = rig();
  const day = await settle(0);
  assert.ok(day.includes('cottage:day') && !day.some(t => t.endsWith(':lit')), `day: ${day}`);
  assert.equal(rasters.filter(r => r.lit).length, 0);
  const dusk = await settle(0.5);                       // the threshold is exclusive: 0.5 is still a day sprite
  assert.ok(!dusk.some(t => t.endsWith(':lit')), `0.5: ${dusk}`);
  const night = await settle(0.9);
  assert.ok(night.includes('cottage:lit'), `night: ${night}`);
  assert.ok(!night.includes('site:lit') && !night.includes('rock:lit'), `no lit site or prop: ${night}`);
  assert.deepEqual([...new Set(rasters.filter(r => r.lit).map(r => r.model))], ['cottage']);
  const n = rasters.length;
  const back = await settle(0);                         // dawn: the cached day entry comes back, nothing is re-rastered
  assert.ok(back.includes('cottage:day') && !back.some(t => t.endsWith(':lit')), `dawn: ${back}`);
  assert.equal(rasters.length, n, 'the day sprite was cached under its own key');
});

test('[bld.lit-windows-night] lighting adds window pools after dark: two per house, all for a home, none for a PR site, no warm glow', () => {
  const mk = (id, data) => ({ id, kind: 'building', model: 'x', tx: 5, ty: 5, w: 2, h: 2, z: 24, data });
  const world = { objects: new Map([['house', mk('house', { owner: 'civic' })], ['home', mk('home', { owner: 'home' })], ['site', mk('site', { owner: 'pr', building: true })]]) };
  const L = createLighting({ world, createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ({}) }) });
  const four = [{ x: -8, y: -10 }, { x: 0, y: -10 }, { x: 8, y: -10 }, { x: 12, y: -4 }];
  const win = () => L.lights(null, null, () => four).filter(l => l.kind === 'window');
  L.setTime(0.5); assert.equal(win().length, 0, 'noon: none');
  L.setNight(0.2); assert.equal(win().length, 6, 'night 0.2: classic lights the dim window pools at any night > 0 (2 house + 4 home)');
  L.setNight(0.8);
  const ls = win();
  assert.equal(ls.filter(l => l.id.startsWith('house#')).length, 2);
  assert.equal(ls.filter(l => l.id.startsWith('home#')).length, 4);
  assert.equal(ls.filter(l => l.id.startsWith('site#')).length, 0);
  assert.ok(ls.every(l => l.warm === 0 && l.r === 22));
  const rest = createLighting({ world, createCanvas: () => ({}), statusOf: id => (id === 'home' ? 'resting' : undefined) });
  rest.setNight(0.8);
  assert.ok(rest.lights(null, null, () => four).filter(l => l.id.startsWith('home#')).every(l => l.warm === 1 && l.r === 34), 'a resting agent keeps the bright warm pools');
});

// ---- vil.yard-cap-plus-n-more -------------------------------------------------------------------------------------

function simWith(extra) {
  const fx = loadFixture('citydemo.json'), f = fx.frames ? fx.frames[0] : fx;
  const { input, serverId } = toWorldInput(viewFromFixture(f), { seed: 7, salt: '7' });
  const world = buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { now: f.now, seed: 7, serverId });
  const sim = createSim({ world, nav: createNav(world), seed: 7, mod: resolveMod(), serverId, clock: { dayLength: 60, phase0: 0.3 } });
  const parent = input.agents.find(a => a.status === 'working' && !a.parent && world.objects.size);
  const subs = extra(parent);
  sim.applySnapshot({ ...input, agents: [...input.agents, ...subs] });
  return { sim, parent, subs, world };
}
const sub = (parent, i, status, needs = null) => ({ ...parent, id: `zsub${i}`, name: `Sub${i}`, parent: parent.id, role: 'sub', crown: false, status, needs, prs: [], since: parent.since + i });

const feetTile = a => `${Math.floor(a.x)},${Math.floor(a.y)}`;
function assertAllDrawn(sim, world, subs) {
  const doors = new Set();
  for (const o of world.objects.values()) if (o.door) doors.add(`${o.door.tx},${o.door.ty}`);
  const seen = new Map();
  let nSpill = 0;
  for (const s of subs) {
    const a = sim.actors.get(s.id);
    assert.ok(a, `${s.id} exists`);
    assert.ok(!a.crowd, `${s.id} is never folded into a crowd`);
    assert.ok((a.flags & FLAGS.INDOORS) === 0 && (a.flags & FLAGS.VISIBLE) !== 0, `${s.id} is drawn`);
    assert.ok(world.grid.get('cost', Math.floor(a.x), Math.floor(a.y)) < 255, `${s.id} stands on a walkable tile`);
    const spilled = String(a._target?.slotId ?? '').startsWith('spill:');
    if (spilled) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.ok(!doors.has(`${a.slot.tx + dx},${a.slot.ty + dy}`), `${s.id} spilled onto or beside a door`);
    if (spilled) nSpill++;
    const k = `${feetTile(a)}|${a._target?.slotId ? a.slot?.sub : ''}`;
    assert.ok(!seen.has(k), `${s.id} shares a sub-slot with ${seen.get(k)}`);
    seen.set(k, s.id);
  }
  return nSpill;
}

test('[vil.yard-cap-plus-n-more] every agent drawn: a crowded home keeps all agents visible, stalled and error stay put, overflow spills beside the yard', () => {
  const { sim, subs, world } = simWith(p => {
    const out = [];
    for (let i = 0; i < 8; i++) out.push(sub(p, i, 'working'));
    out.push(sub(p, 8, 'stalled', 'question'), sub(p, 9, 'error'));
    return out;
  });
  sim.step(12);
  assertAllDrawn(sim, world, subs);
  const pin = ['zsub8', 'zsub9'].map(id => { const a = sim.actors.get(id); return [a.x, a.y]; });
  sim.step(12);
  ['zsub8', 'zsub9'].forEach((id, i) => assert.deepEqual([sim.actors.get(id).x, sim.actors.get(id).y], pin[i], `${id} never moves`));
});

test('[vil.yard-cap-plus-n-more] stress: 40 agents on one home all get distinct walkable tiles off the doors, and stay put across polls', () => {
  const { sim, subs, world, parent } = simWith(p => Array.from({ length: 40 }, (_, i) => sub(p, i, i % 7 === 0 ? 'stalled' : 'working', i % 7 === 0 ? 'question' : null)));
  sim.step(15);
  assert.ok(assertAllDrawn(sim, world, subs) > 0, 'a 40-agent crowd overflows the yard slots and spills');
  const before = new Map(subs.map(s => [s.id, [sim.actors.get(s.id).x, sim.actors.get(s.id).y]]));
  const tiles = new Set(subs.map(s => feetTile(sim.actors.get(s.id))));
  assert.ok(tiles.size >= 20, `40 agents spread over at least 20 tiles (two per tile), got ${tiles.size}`);
  const input2 = [...sim.actors.values()].filter(a => a.kind === 'agent').map(a => a.input);
  sim.applySnapshot({ ...sim.lastInput?.(), agents: input2 });   // a repeat poll
  sim.step(15);
  assertAllDrawn(sim, world, subs);
  for (const s of subs) if (s.status === 'stalled') assert.deepEqual([sim.actors.get(s.id).x, sim.actors.get(s.id).y], before.get(s.id), `${s.id} did not move`);
  assert.ok(parent);
});

test('[vil.yard-cap-plus-n-more] labels no longer carry a "+N more" candidate; no yard cap in the engine', () => {
  const c = labelCands({ zoom: 2, crowds: [{ id: 'h1', n: 3, x: 10, y: 20 }] });
  assert.ok(!c.some(x => /more/.test(x.text)), JSON.stringify(c));
  assert.equal(typeof agentBeh.yardCrowd, 'undefined');
  assert.equal(typeof YARD_CAP, 'undefined');
  const src = readFileSync(new URL('../web/src/engine/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /crowds/);
});

// ---- night.veil-light-pools ---------------------------------------------------------------------------------------

test('[night.veil-light-pools] mod.lightsFor reaches createLighting and mod.extraLights pools reach lighting.draw', () => {
  const drawn = [], made = [];
  const gfx = { begin() {}, clear() {}, end() {}, image() {}, rect() {}, poly() {}, setComposite() {}, size: () => ({ w: 800, h: 600 }) };
  const extra = [{ id: 'x1', kind: 'extra', x: 1, y: 2, r: 30, warm: 1, flicker: 0 }];
  let seen = null;
  const mod = { lightsFor: () => null, extraLights: (w, actors) => { seen = { w, actors }; return extra; } };
  const deps = {
    rasterize: () => null, loadClassicArt: async () => {}, createGround: () => ({ drawChunks() {} }),
    createLighting: o => { made.push(o); return { setTime() {}, lights: () => [{ id: 'own' }], draw: (g, cam, view, list) => drawn.push(list) }; },
    createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }), effects: { draw() {} }, badges: { draw() {} },
  };
  const r = createRenderer({ canvas: {}, gfx, mod, deps });
  const w = { objects: new Map(), version: 1 };
  r.setWorld(w);
  assert.equal(made[0].lightsFor, mod.lightsFor);
  const actors = [];
  r.draw({ cam: { x: 0, y: 0, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors, t: 0, night: 0.9, mode: 'town' });
  assert.deepEqual(drawn.at(-1).map(l => l.id), ['own', 'x1']);
  assert.equal(seen.w, w); assert.equal(seen.actors, actors);
  const bad = createRenderer({ canvas: {}, gfx, mod: { extraLights() { throw new Error('x'); } }, deps });
  bad.setWorld(w);
  bad.draw({ cam: { x: 0, y: 0, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t: 0, night: 0.9, mode: 'town' });
  assert.deepEqual(drawn.at(-1).map(l => l.id), ['own'], 'a throwing hook adds nothing');
});
