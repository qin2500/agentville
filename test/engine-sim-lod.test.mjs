import './support/ensure-mods-index.mjs';
// Ambient level of detail in the world-sim (PERF M7 psim): zoomed out or off screen, ambient actors tick less; agents are
// never throttled; a returning actor resumes at once with the time it is owed; same inputs + views -> same result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim, STEP, LOD } from '../web/src/engine/sim/world-sim.js';

const FLAGS = { VISIBLE: 1, SELECTED: 2, OCCLUDED: 4, INDOORS: 8, GHOST: 16 };
const world = () => ({ version: 1, objects: new Map(), villages: [{ name: 'p', tier: 1, cx: 15, cy: 15 }] });
const agent = (id, extra = {}) => ({ id, name: id, project: 'p', parent: null, status: 'working', needs: null, role: 'worker',
  crown: false, important: false, stopped: false, harness: 'claude', since: 0, lastActive: 0, prs: [], ...extra });
const input = agents => ({ apiVersion: 1, now: 0, seed: 1, agents, projects: [{ key: 'p', name: 'p' }], prs: [], env: { night: 0, reduceMotion: false, zoom: 1 } });

/** A sim with N standing 'still' ambient actors, N walkers ('walk': back and forth along x) and one agent 'A'. Every
 *  behaviour call is logged with its dt. */
function make({ n = 16, walkers = 4 } = {}) {
  const calls = [];
  const still = {
    init(a) { a.timer = 0; },
    update(a, dt, ctx) { calls.push({ id: a.id, dt, tick: ctx.tick }); a.timer += dt; a.r = ctx.rand('r'); },
  };
  const walk = {
    init(a) { a.path = Float32Array.from([a.x + 40, a.y]); a.speed = 2; },
    update(a, dt, ctx) { calls.push({ id: a.id, dt, tick: ctx.tick }); if (!a.path && a.arrived) a.path = Float32Array.from([a.x - 40, a.y]); },
  };
  const agentLog = [];
  const agentBehaviour = { init() {}, update(a, dt, ctx) { agentLog.push({ id: a.id, dt, tick: ctx.tick }); } };
  const spawn = () => [
    ...Array.from({ length: n }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, kind: 'still', x: 2 + i, y: 2 })),
    ...Array.from({ length: walkers }, (_, i) => ({ id: `w${i}`, kind: 'walk', x: 2, y: 10 + i })),
  ];
  const s = createSim({ world: world(), seed: 5, mod: { ambient: { behaviours: { still, walk }, spawn } },
    deps: { FLAGS, agentBehaviour, representAgent: () => ({ place: 'x', pose: 'idle' }), resolvePlace: () => null } });
  s.applySnapshot(input([agent('A')]));
  return { s, calls, agentLog };
}
const count = (calls, re) => calls.filter(c => re.test(c.id)).length;
const sumDt = (calls, id) => calls.filter(c => c.id === id).reduce((t, c) => t + c.dt, 0);

test('LOD is off until setView: every actor runs every step', () => {
  const { s, calls } = make();
  for (let i = 0; i < 40; i++) s.tick(STEP);
  assert.equal(count(calls, /^s/), 16 * 40);
  assert.equal(s.lod.on, false);
});

test('off screen: ambient behaviour runs every LOD.off steps, spread over steps, with the owed time', () => {
  const { s, calls } = make();
  s.setOnScreen(() => false); s.setView({ zoom: 2 });
  const N = LOD.off * 10;
  for (let i = 0; i < N; i++) s.tick(STEP);
  assert.equal(count(calls, /^s/), 16 * 10, 'one run in LOD.off steps');
  const perTick = new Map();
  for (const c of calls) if (/^s/.test(c.id)) perTick.set(c.tick, (perTick.get(c.tick) || 0) + 1);
  assert.ok(perTick.size > 1, 'runs are spread over steps (phase by id), not all on one');
  for (const id of ['s00', 's07', 's15']) {
    const own = calls.filter(c => c.id === id);
    assert.ok(own.every(c => Math.abs(c.dt - LOD.off * STEP) < 1e-9 || c.dt < LOD.off * STEP), `${id} dt ${own.map(c => c.dt)}`);
    const owed = N * STEP - sumDt(calls, id);
    assert.ok(owed >= -1e-9 && owed < LOD.off * STEP, `${id}: behaviour time keeps pace (owed ${owed})`);
  }
  assert.equal(s.lod.off, 20); assert.ok(s.lod.skipped > 0);
});

test('off screen walkers move in coarse steps but cover the same ground', () => {
  const A = make(), B = make();
  B.s.setOnScreen(() => false); B.s.setView({ zoom: 2 });
  for (let i = 0; i < LOD.off * 6; i++) { A.s.tick(STEP); B.s.tick(STEP); }
  for (const id of ['w0', 'w1', 'w2', 'w3']) {
    const a = A.s.actors.get(id), b = B.s.actors.get(id);
    assert.ok(Math.abs(a.x - b.x) <= 2 * LOD.off * STEP + 1e-6, `${id}: ${a.x} vs ${b.x}`);
    assert.equal(a.y, b.y);
  }
});

test('zoomed out (< 1) on screen: still actors think every LOD.far steps; movers every step and move every step', () => {
  const { s, calls } = make();
  s.setOnScreen(() => true); s.setView({ zoom: 0.5 });
  const xs = [];
  for (let i = 0; i < LOD.far * 10; i++) { s.tick(STEP); xs.push(s.actors.get('w0').x); }
  assert.equal(count(calls, /^s/), 16 * 10);
  assert.equal(count(calls, /^w/), 4 * LOD.far * 10, 'a moving actor still runs its behaviour every step (right of way)');
  for (let i = 1; i < 20; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 2 * STEP) < 1e-5, `smooth on screen at step ${i}: ${xs[i] - xs[i - 1]}`);
  assert.equal(s.lod.far, 20);
});

test('zoom >= 1 on screen is full rate', () => {
  const { s, calls } = make();
  s.setOnScreen(() => true); s.setView({ zoom: 1 });
  for (let i = 0; i < 24; i++) s.tick(STEP);
  assert.equal(count(calls, /^s/), 16 * 24);
});

test('coming back on screen: the actor runs on the very next step with everything it is owed', () => {
  const { s, calls } = make();
  let seen = false;
  s.setOnScreen(() => seen); s.setView({ zoom: 2 });
  for (let i = 0; i < LOD.off * 3 + 3; i++) s.tick(STEP);
  const before = new Map(['s00', 's05', 's11'].map(id => [id, s.actors.get(id).timer]));
  const n0 = calls.length;
  seen = true;
  s.tick(STEP);
  const now = calls.slice(n0);
  for (const id of before.keys()) {
    const c = now.find(x => x.id === id);
    assert.ok(c, `${id} ran at once`);
    assert.ok(c.dt >= STEP - 1e-9 && c.dt <= LOD.off * STEP + 1e-9, `${id} dt ${c.dt}`);
    assert.ok(Math.abs(s.actors.get(id).timer - s.now) < 1e-9, `${id}: its clock caught up exactly (${s.actors.get(id).timer} vs ${s.now})`);
  }
  for (let i = 0; i < 5; i++) s.tick(STEP);
  assert.equal(count(calls.slice(n0), /^s/), 16 * 6, 'full rate from then on');
});

test('deterministic: same seed, inputs, dts and views -> identical actors (and different views stay legal)', () => {
  const run = () => {
    const { s, calls } = make();
    for (let i = 0; i < 200; i++) {
      const phase = Math.floor(i / 30) % 3;   // off screen, zoomed out, near: the camera wanders
      s.setOnScreen(phase === 0 ? () => false : (x) => x < 20);
      s.setView({ zoom: phase === 1 ? 0.25 : 2 });
      s.tick(i % 5 === 0 ? 0.125 : STEP);
    }
    return { pos: [...s.actors.values()].map(a => [a.id, a.x, a.y, a.timer ?? null, a.r ?? null]), n: calls.length };
  };
  assert.deepEqual(run(), run());
});

test('agents are never throttled: every step, the step dt, whatever the view', () => {
  const { s, agentLog } = make();
  s.setOnScreen(() => false); s.setView({ zoom: 0.25 });
  for (let i = 0; i < 40; i++) s.tick(STEP);
  const own = agentLog.filter(c => c.id === 'A');
  assert.equal(own.length, 40);
  assert.ok(own.every(c => c.dt === STEP));
  const st = s.actors.get('A');
  assert.equal(st.kind, 'agent'); assert.equal(st._lodPh, undefined, 'an agent never gets LOD state');
});

test('step(seconds) (captures, a pinned clock) and fast-forward never throttle', () => {
  const { s, calls } = make();
  s.setOnScreen(() => false); s.setView({ zoom: 0.25 });
  s.step(1);
  assert.equal(count(calls, /^s/), 16 * 20);
  const n0 = calls.length;
  s.tick(1);                                   // > MAX_CATCHUP steps owed: one fast-forward step for everyone
  assert.equal(count(calls.slice(n0), /^s/), 16);
});

test('setView(null) turns LOD off again and settles every debt on the next step', () => {
  const { s, calls } = make();
  s.setOnScreen(() => false); s.setView({ zoom: 2 });
  for (let i = 0; i < 5; i++) s.tick(STEP);
  s.setView(null);
  const n0 = calls.length;
  s.tick(STEP);
  assert.equal(count(calls.slice(n0), /^s/), 16);
  for (const id of ['s00', 's09']) assert.ok(Math.abs(s.actors.get(id).timer - s.now) < 1e-9, id);
  assert.equal(s.lod.on, false);
});

// ---- the fantasy world: life stays legal and plausible under the camera ------------------------------------------------
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const fx = loadFixture('citydemo.json');

test('citydemo: off screen / map zoom / back keeps every ambient actor on a legal tile and agents identical', { skip: fx ? false : 'citydemo.json missing' }, () => {
  const mk = () => {
    const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: 7, salt: '7' });
    const w = buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { now: fx.now, seed: 7, serverId, mod: fantasy });
    const sim = createSim({ world: w, nav: createNav(w), seed: 7, mod: fantasy, serverId, clock: { dayLength: 60, phase0: 0.3 } });
    sim.applySnapshot(input);
    return { sim, w };
  };
  const A = mk(), B = mk();
  const cx = A.w.grid.ox + A.w.grid.w / 2;
  B.sim.setView({ zoom: 2 });
  for (let i = 0; i < 600; i++) {
    const phase = Math.floor(i / 100) % 3;
    B.sim.setOnScreen(phase === 0 ? () => false : phase === 1 ? () => true : x => x < cx);
    B.sim.setView({ zoom: phase === 1 ? 0.25 : 2 });
    A.sim.tick(0.125); B.sim.tick(0.125);
  }
  const g = B.w.grid, legal = a => {
    const tx = Math.floor(a.x), ty = Math.floor(a.y);
    return a.gridFree === true || (g.inBounds(tx, ty) && g.get('cost', tx, ty) < 255);
  };
  let amb = 0;
  for (const a of B.sim.actors.values()) {
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), `${a.id} has a position`);
    if (a.kind === 'agent') continue;
    amb++;
    if (!(a.flags & 8)) assert.ok(legal(a), `${a.id} (${a.kind}) on a legal tile at ${a.x},${a.y}`);
  }
  assert.ok(amb > 20, `the fixture has ambient life (${amb})`);
  assert.ok(B.sim.lod.on);
  const agents = s => [...s.actors.values()].filter(a => a.kind === 'agent').map(a => [a.id, a.state, a.flags & 8, a.alpha]);
  assert.deepEqual(agents(B.sim), agents(A.sim), 'agents end in the same states as without LOD');
});
