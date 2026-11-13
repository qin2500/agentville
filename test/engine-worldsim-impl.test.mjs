// S1 world-sim tests, written from the seam (COMMON.md, design §4.1/§4.2/§4.5, D4). Synthetic world, injected deps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim, STEP } from '../web/src/engine/sim/world-sim.js';
import { rand } from '../web/src/engine/core/rng.js';

const FLAGS = { VISIBLE: 1, SELECTED: 2, OCCLUDED: 4, INDOORS: 8, GHOST: 16 };

// A tiny synthetic world: two homes whose data.agentId holds SERVER ids, one village.
function makeWorld() {
  const objects = new Map([
    ['lot:p:1', { id: 'lot:p:1', kind: 'building', project: 'p', tx: 10, ty: 10, door: { tx: 11, ty: 12, face: 0 }, data: { owner: 'home', agentId: 'srv-a' } }],
    ['lot:p:2', { id: 'lot:p:2', kind: 'building', project: 'p', tx: 20, ty: 10, door: { tx: 21, ty: 12, face: 0 }, data: { owner: 'home', agentId: 'srv-b' } }],
  ]);
  return { version: 1, objects, villages: [{ name: 'p', tier: 1, cx: 15, cy: 15 }] };
}
const serverId = o => ({ A: 'srv-a', B: 'srv-b' })[o];

const line = (x0, y0, x1, y1) => Float32Array.from([x0, y0, x1, y1]);

/** Test deps: places by status, a behaviour that walks to `a.goal` set from the status. */
function deps(log = [], { goals = {} } = {}) {
  const goalFor = a => goals[a.input.status] ?? null;
  return {
    FLAGS,
    makeActor: spec => ({ face: 0, anim: 'idle', frame: 0, state: 'idle', flags: 0, ...spec, px: spec.x, py: spec.y }),
    stepAlongPath(a, dt, speed) {
      log.push(`move:${a.id}`);
      const p = a.path, tx = p[p.length - 2], ty = p[p.length - 1], dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy), s = speed * dt;
      if (d <= s) { a.x = tx; a.y = ty; return true; }
      a.x += (dx / d) * s; a.y += (dy / d) * s; return false;
    },
    createEvents() { let q = []; return { emit: (type, p) => { log.push(`event:${type}`); q.push({ type, ...p }); }, drain: () => { const o = q; q = []; return o; } }; },
    representAgent: (ag) => ({ place: 'home.forecourt', pose: ag.status === 'working' ? 'hammer' : 'idle' }),
    resolvePlace: (place, a, world) => { const h = world.objects.get(a.home); return h ? { tx: h.door.tx, ty: h.door.ty, slotKind: 'stand' } : null; },
    agentBehaviour: {
      init(a, ctx) {
        log.push(`init:${a.id}:${a.input.status}`);
        a.homeObj = ctx.homeOf(a.agentId);
        const g = goalFor(a);
        if (g) a.path = line(a.x, a.y, g.x, g.y);
      },
      update(a, dt, ctx) { log.push(`update:${a.id}`); a.r = ctx.rand(7); a.rTick = ctx.tick; },
    },
  };
}

const agent = (id, status = 'working', extra = {}) => ({ id, name: id, project: 'p', parent: null, status, needs: null, role: 'worker',
  crown: false, important: false, stopped: false, harness: 'claude', since: 0, lastActive: 0, prs: [], ...extra });
const input = (agents, extra = {}) => ({ apiVersion: 1, now: 0, seed: 1, agents, projects: [{ key: 'p', name: 'p' }], prs: [], env: { night: 0, reduceMotion: false, zoom: 1 }, ...extra });
const sim0 = (opts = {}) => { const log = []; const s = createSim({ world: makeWorld(), nav: null, seed: 42, mod: null, serverId, deps: deps(log, opts), ...opts.sim }); return { s, log }; };

test('applySnapshot creates, updates and removes actors by opaque id; home lookup goes through serverId', () => {
  const { s, log } = sim0();
  s.applySnapshot(input([agent('A'), agent('B', 'waiting')]));
  assert.deepEqual([...s.actors.keys()].sort(), ['A', 'B']);
  const a = s.actors.get('A');
  assert.equal(a.kind, 'agent');
  assert.equal(a.homeObj.id, 'lot:p:1');           // ctx.homeOf(opaque) -> object whose data.agentId is the server id
  assert.equal(a.home, 'lot:p:1');
  assert.deepEqual([a.x, a.y], [11, 12]);           // spawned at its resolved place
  assert.equal(a.status.bucket, 'working');
  assert.ok(log.includes('init:A:working'));

  s.applySnapshot(input([agent('A', 'waiting'), agent('B', 'waiting')]));
  assert.equal(s.actors.get('A').status.bucket, 'waiting');
  assert.ok(!log.includes('init:A:waiting'), 're-plan waits for the intent system');
  s.tick(STEP);
  assert.ok(log.includes('init:A:waiting'));
  assert.ok(!log.some(l => l === 'init:B:waiting' && log.indexOf(l) !== log.lastIndexOf(l)), 'unchanged agent not re-inited');

  s.applySnapshot(input([agent('A', 'waiting')]));
  const b = s.actors.get('B');
  assert.ok(b.flags & FLAGS.GHOST, 'removed agent fades out first');
  assert.ok(s.events.drain().some(e => e.type === 'leave' && e.id === 'B'));
  s.tick(0.5);
  assert.equal(s.actors.has('B'), false);
});

test('a removed agent that comes back during its fade is revived', () => {
  const { s } = sim0();
  s.applySnapshot(input([agent('A'), agent('B')]));
  s.applySnapshot(input([agent('A')]));
  s.tick(STEP);
  s.applySnapshot(input([agent('A'), agent('B')]));
  s.tick(1);
  const b = s.actors.get('B');
  assert.ok(b);
  assert.equal(b.flags & FLAGS.GHOST, 0);
  assert.equal(b.alpha, 1);
});

test('systems run in fixed order: intent -> behaviour -> movement -> events', () => {
  const log = [];
  const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: deps(log, { goals: { waiting: { x: 13, y: 12 } } }) });
  s.applySnapshot(input([agent('A')]));
  s.tick(STEP);
  s.applySnapshot(input([agent('A', 'waiting')]));
  log.length = 0;
  s.tick(STEP);
  const i = log.indexOf('init:A:waiting'), u = log.indexOf('update:A'), m = log.indexOf('move:A');
  assert.ok(i >= 0 && u > i && m > u, log.join(','));
});

test('fixed 50 ms timestep accumulates; splitting dt does not change the result', () => {
  const run = dts => {
    const log = [];
    const s = createSim({ world: makeWorld(), seed: 9, serverId, deps: deps(log, { goals: { waiting: { x: 14, y: 12 } } }) });
    s.applySnapshot(input([agent('A', 'waiting'), agent('B')]));
    let steps = 0;
    for (const dt of dts) steps += s.tick(dt);
    return { steps, tick: s.tickCount, a: { ...s.actors.get('A') } };
  };
  const r1 = run([0.12]);
  assert.equal(r1.steps, 2);
  assert.equal(r1.tick, 2);
  const r2 = run([0.03, 0.03, 0.03, 0.03]);
  assert.equal(r2.tick, 2);
  const x = run([0.05, 0.05, 0.05]), y = run([0.1, 0.05]);
  assert.equal(x.tick, 3); assert.equal(y.tick, 3);
  assert.equal(x.a.x, y.a.x); assert.equal(x.a.y, y.a.y);
});

test('deterministic for (seed, inputs, dt sequence); rand is rand(seed, actorId, tick, k)', () => {
  const snap = seed => {
    const s = createSim({ world: makeWorld(), seed, serverId, deps: deps([], { goals: { working: { x: 16, y: 12 } } }) });
    s.applySnapshot(input([agent('B'), agent('A')]));
    for (const dt of [0.016, 0.033, 0.2, 0.05, 0.07]) s.tick(dt);
    return JSON.stringify([...s.actors.values()].map(a => [a.id, a.x, a.y, a.face, a.anim, a.frame, a.r]));
  };
  assert.equal(snap(5), snap(5));
  assert.notEqual(snap(5), snap(6));
  const s = createSim({ world: makeWorld(), seed: 5, serverId, deps: deps() });
  s.applySnapshot(input([agent('A')]));
  s.tick(STEP * 3);
  const a = s.actors.get('A');
  assert.equal(a.r, rand(5, 'A', a.rTick, 7));
  // input order does not matter
  const t = order => {
    const z = createSim({ world: makeWorld(), seed: 3, serverId, deps: deps() });
    z.applySnapshot(input(order)); z.tick(0.2);
    return JSON.stringify([...z.actors.values()].map(a => [a.id, a.r]).sort());
  };
  assert.equal(t([agent('A'), agent('B')]), t([agent('B'), agent('A')]));
});

test('interpolation: px/py hold the previous step, lerp blends with the accumulator', () => {
  const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: deps([], { goals: { working: { x: 16, y: 12 } } }) });
  s.applySnapshot(input([agent('A')]));
  s.tick(STEP);
  s.tick(STEP);
  const a = s.actors.get('A');
  assert.ok(a.x > a.px, 'walking +x');
  const x0 = a.px, x1 = a.x;
  s.tick(STEP / 2);
  const p = s.lerp(a);
  assert.ok(Math.abs(p.x - (x0 + (x1 - x0) * 0.5)) < 1e-9);
});

test('D4: a short on-screen route walks, with walk anim and facing', () => {
  const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: deps([], { goals: { working: { x: 16, y: 12 } } }) });
  s.applySnapshot(input([agent('A')]));
  const xs = [];
  for (let i = 0; i < 60; i++) { s.tick(STEP); xs.push(s.actors.get('A').x); if (i === 2) assert.equal(s.actors.get('A').anim, 'walk'); }
  const a = s.actors.get('A');
  assert.ok(xs.some(x => x > 11.01 && x < 15.99), 'passes through intermediate positions');
  assert.deepEqual([a.x, a.y], [16, 12]);
  assert.equal(a.face, 0);                         // +x is SE
  assert.equal(a.anim, 'hammer');                  // spec pose after arrival
  assert.equal(a.path, undefined);
});

test('D4: a long route (> 40 tiles) fades instead of walking', () => {
  const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: deps([], { goals: { working: { x: 80, y: 12 } } }) });
  s.applySnapshot(input([agent('A')]));
  const seen = [];
  for (let i = 0; i < 12; i++) { s.tick(STEP); const a = s.actors.get('A'); seen.push([a.x, a.alpha]); }
  assert.ok(seen.every(([x]) => x === 11 || x === 80), 'never in between');
  assert.ok(seen.some(([, al]) => al < 1), 'alpha dips');
  assert.deepEqual([s.actors.get('A').x, s.actors.get('A').alpha], [80, 1]);
});

test('D4: off-screen actors fade; walks over 6 s are cut short', () => {
  const s = createSim({ world: makeWorld(), seed: 1, serverId, onScreen: () => false, deps: deps([], { goals: { working: { x: 16, y: 12 } } }) });
  s.applySnapshot(input([agent('A')]));
  for (let i = 0; i < 3; i++) s.tick(STEP);
  assert.ok([11, 16].includes(s.actors.get('A').x));
  s.tick(0.2);
  assert.equal(s.actors.get('A').x, 16);

  // 30 tiles at a slow speed: walks, then fades at 6 s
  const d = deps([], { goals: { working: { x: 41, y: 12 } } });
  const init = d.agentBehaviour.init;
  d.agentBehaviour.init = (a, ctx) => { init(a, ctx); a.speed = 1; };
  const t = createSim({ world: makeWorld(), seed: 1, serverId, deps: d });
  t.applySnapshot(input([agent('A')]));
  for (let i = 0; i < 6 / STEP - 2; i++) t.tick(STEP);
  const mid = t.actors.get('A').x;
  assert.ok(mid > 15 && mid < 18, `walked ~6 tiles, at ${mid}`);
  for (let i = 0; i < 12; i++) t.tick(STEP);
  assert.equal(t.actors.get('A').x, 41);
});

test('D4: stalled and error agents never walk', () => {
  for (const status of ['stalled', 'error']) {
    const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: deps([], { goals: { [status]: { x: 14, y: 12 }, working: { x: 16, y: 12 } } }) });
    s.applySnapshot(input([agent('A', status)]));
    const xs = [];
    for (let i = 0; i < 20; i++) { s.tick(STEP); xs.push(s.actors.get('A').x); assert.notEqual(s.actors.get('A').anim, 'walk'); }
    assert.ok(xs.every(x => x === 11 || x === 14), `${status}: ${xs}`);
    // going stalled mid-walk: the remaining walk becomes a fade
    const t = createSim({ world: makeWorld(), seed: 1, serverId, deps: deps([], { goals: { working: { x: 16, y: 12 } } }) });
    t.applySnapshot(input([agent('A')]));
    for (let i = 0; i < 4; i++) t.tick(STEP);
    const x0 = t.actors.get('A').x;
    assert.ok(x0 > 11 && x0 < 16);
    t.applySnapshot(input([agent('A', status)]));
    const after = [];
    for (let i = 0; i < 10; i++) { t.tick(STEP); after.push(t.actors.get('A').x); }
    assert.ok(after.every(x => x === x0 || x === 16), `${status} mid-walk: ${after}`);
  }
});

test('reduced motion: actors snap to targets and show frame 0', () => {
  const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: deps([], { goals: { working: { x: 16, y: 12 } } }) });
  s.applySnapshot(input([agent('A')], { env: { night: 0, reduceMotion: true, zoom: 1 } }));
  s.tick(STEP);
  const a = s.actors.get('A');
  assert.deepEqual([a.x, a.y, a.frame], [16, 12, 0]);
  s.tick(1);
  assert.equal(a.frame, 0);
});

test('many owed steps fast-forward: movers land at their route end', () => {
  const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: deps([], { goals: { working: { x: 16, y: 12 } } }) });
  s.applySnapshot(input([agent('A')]));
  const n = s.tick(1);
  assert.equal(n, 20);
  assert.equal(s.tickCount, 20);
  const a = s.actors.get('A');
  assert.deepEqual([a.x, a.y, a.px, a.py], [16, 12, 16, 12]);
});

test('events: found and merge only after the first (baseline) snapshot; arrive for new agents', () => {
  const { s } = sim0();
  s.applySnapshot(input([agent('A')], { prs: [{ id: 'p#1', project: 'p', state: 'building' }] }));
  assert.deepEqual(s.events.drain(), []);
  s.applySnapshot(input([agent('A'), agent('B')], { projects: [{ key: 'p' }, { key: 'q' }], prs: [{ id: 'p#1', project: 'p', state: 'merged' }] }));
  const ev = s.events.drain().map(e => e.type).sort();
  assert.deepEqual(ev, ['arrive', 'found', 'merge']);
});

test('setWorld emits tierUp, re-plans agents and respawns ambient actors', () => {
  const log = [];
  const spawned = [];
  const mod = { ambient: {
    spawn: (world, r) => { spawned.push(world.version); return [{ kind: 'critter', x: 5, y: 5, seedVal: r() }, { kind: 'critter', x: 6, y: 5 }, { kind: 'unknown', x: 1, y: 1 }]; },
    behaviours: { critter: { init(a) { a.inited = true; }, update(a, dt, ctx) { a.ticks = (a.ticks || 0) + 1; a.rr = ctx.rand(1); } } },
  } };
  const s = createSim({ world: makeWorld(), seed: 1, mod, serverId, deps: deps(log) });
  assert.deepEqual([...s.actors.keys()].sort(), ['critter:0', 'critter:1']);
  assert.equal(s.actors.get('critter:0').inited, true);
  s.applySnapshot(input([agent('A')]));
  s.tick(STEP * 2);
  assert.equal(s.actors.get('critter:0').ticks, 2);
  assert.equal(s.actors.get('critter:0').rr, rand(1, 'critter:0', 1, 1));
  s.events.drain();
  const w2 = makeWorld(); w2.version = 2; w2.villages[0].tier = 2;
  s.setWorld(w2);
  assert.deepEqual(spawned, [1, 2]);
  assert.equal(s.actors.get('critter:0').ticks, undefined, 'fresh ambient actors');
  assert.ok(s.events.drain().some(e => e.type === 'tierUp' && e.project === 'p' && e.to === 2));
  log.length = 0;
  s.tick(STEP);
  assert.ok(log.includes('init:A:working'));
});

test('no mod, no nav, no agents: the sim still ticks', () => {
  const s = createSim({ world: makeWorld(), seed: 1, deps: deps() });
  assert.equal(s.tick(0.2), 4);
  s.applySnapshot(input([]));
  assert.equal(s.actors.size, 0);
});

// ---- conventions shared by every behaviour (integration fix) --------------------------------------------------------

test('ctx: place(place, a) -> resolvePlace(place, a, world, { slots, homeOf }); clock gives dayPhase and night; actors, FLAGS, faceFrom', () => {
  const seen = [];
  const d = deps();
  d.resolvePlace = (place, a, world, c) => { seen.push([place, typeof c?.homeOf, 'slots' in (c || {})]); return null; };
  d.agentBehaviour = { init() {}, update(a, dt, ctx) { a.got = { p: ctx.place('anchor:sit', a), night: ctx.night, phase: ctx.dayPhase, n: ctx.actors.size, F: ctx.FLAGS.INDOORS, f: ctx.faceFrom(1, 0) }; } };
  let phase = 0.5;
  const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: d, clock: () => phase });
  s.applySnapshot(input([agent('A')]));
  s.tick(STEP);
  assert.deepEqual(s.actors.get('A').got, { p: null, night: false, phase: 0.5, n: 1, F: 8, f: 0 });
  assert.ok(seen.some(([p, h, sl]) => p === 'anchor:sit' && h === 'function' && sl));
  phase = 0.8; s.tick(STEP);
  assert.equal(s.actors.get('A').got.night, true);
  // without a clock, env.night drives it
  const t = createSim({ world: makeWorld(), seed: 1, serverId, deps: d });
  t.applySnapshot(input([agent('A')], { env: { night: 1, reduceMotion: false, zoom: 1 } }));
  t.tick(STEP);
  assert.equal(t.actors.get('A').got.night, true);
});

test('movement contract: arrival sets a.arrived and clears a.path; a.warp jumps; illegal ambient paths are refused (a.stuck)', () => {
  const g = { inBounds: (x, y) => x >= 0 && y >= 0 && x < 20 && y < 20, get: (l, x, y) => (l === 'occ' ? (x === 5 && y === 5 ? 1 : 0) : 1) };
  const w = { ...makeWorld(), grid: g };
  const beh = { init(a) { a.warp = { x: 2.5, y: 5.5 }; }, update(a) {
    if (a.plan === 0) { a.path = Float32Array.from([8.5, 5.5]); a.plan = 1; }                  // straight through occ (5,5)
    else if (a.plan === 1 && a.stuck) { a.path = Float32Array.from([2.5, 6.5, 8.5, 6.5]); a.plan = 2; }
  } };
  const s = createSim({ world: w, seed: 1, mod: { ambient: { behaviours: { critter: beh }, spawn: () => [{ id: 'c', kind: 'critter', x: 0, y: 0, plan: 0 }] } }, deps: { ...deps(), stepAlongPath: undefined } });   // the real stepper
  const c = s.actors.get('c');
  assert.deepEqual([c.x, c.y], [2.5, 5.5], 'warp applied at spawn');
  s.tick(STEP);
  assert.equal(c.stuck, true); assert.equal(c.path, undefined); assert.deepEqual([c.x, c.y], [2.5, 5.5]);
  for (let i = 0; i < 80 && !c.arrived; i++) { s.tick(STEP); assert.notEqual(Math.floor(c.y) === 5 && Math.floor(c.x) === 5, true); }
  assert.equal(c.arrived, true); assert.equal(c.path, undefined); assert.deepEqual([c.x, c.y], [8.5, 6.5]);
  assert.equal(c.face, 0, '+x walk faces SE (faceFrom)');
});

test('ambient actors keep walking off screen and past 6 s (D4 is for agents)', () => {
  const beh = { init(a) { a.path = Float32Array.from([30, 0]); a.speed = 2; }, update() {} };
  const s = createSim({ world: makeWorld(), seed: 1, onScreen: () => false, mod: { ambient: { behaviours: { cart: beh }, spawn: () => [{ id: 'k', kind: 'cart', x: 0, y: 0 }] } }, deps: deps() });
  const k = s.actors.get('k'), xs = [];
  for (let i = 0; i < 7 / STEP; i++) { s.tick(STEP); xs.push(k.x); }
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1]) && xs.some(x => x > 1 && x < 13), 'walks smoothly');
  assert.ok(k.x > 13.5 && k.x < 14.5, `still walking at 7 s: ${k.x}`);
});

test('anim system maps non-enum pose names onto the §4.1 enum', () => {
  const d = deps();
  d.agentBehaviour = { init(a) { a.anim = 'wave-both'; }, update(a) { a.anim = a.anim === 'wave' ? 'carry-crate' : a.anim; } };
  const s = createSim({ world: makeWorld(), seed: 1, serverId, deps: d, mod: { represent: { poses: { 'wave-both': 'wave', 'carry-crate': 'carry' } } } });
  s.applySnapshot(input([agent('A')]));
  s.tick(STEP); assert.equal(s.actors.get('A').anim, 'wave');
  s.tick(STEP); assert.equal(s.actors.get('A').anim, 'carry');
});
