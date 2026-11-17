import './support/ensure-mods-index.mjs';
// M3 sim fixes (audit): D4 walk rule (shouldWalk), rebuild stability (setWorld keeps actors), one
// actor per sub-slot, stalled/error never move, select(), step() determinism. Fixture worlds built like engine-sim.test.
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { createSim, shouldWalk, WALK_MAX_S, STEP } = await import('../web/src/engine/sim/world-sim.js');
const { FLAGS } = await import('../web/src/engine/sim/actor.js');
const { guardSlots } = await import('../web/src/engine/sim/slot-guard.js');

const SEED = 7;
const FIX = { citydemo: loadFixture('citydemo.json'), busy: loadFixture('busy.json') };
const frameOf = fx => (fx?.frames ? fx.frames[0] : fx);
const skipFor = name => (FIX[name] ? false : `e2e/fixtures/engine/${name}.json missing`);

function fantasyMod() {
  const m = resolveMod();
  return { ...m, behaviour: m.behaviour ?? fantasy.behaviour, represent: m.represent ?? fantasy.represent, ambient: m.ambient ?? fantasy.ambient };
}
function build(fx, seed = SEED) {
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed, salt: String(seed) });
  const world = buildWorld(input, { v: 1, seed, blocks: {}, lots: {} }, { now: fx.now, seed, serverId });
  return { world, nav: createNav(world), input, serverId };
}
function make(name, seed = SEED) {
  const fx = frameOf(FIX[name]);
  const b = build(fx, seed);
  const sim = createSim({ world: b.world, nav: b.nav, seed, mod: fantasyMod(), serverId: b.serverId, clock: { dayLength: 60, phase0: 0.3 } });
  sim.applySnapshot(b.input);
  return { ...b, sim, fx };
}
const agentsOf = sim => [...sim.actors.values()].filter(a => a.kind === 'agent');
const posSnap = sim => [...sim.actors.values()].map(a => `${a.id}:${a.x.toFixed(5)},${a.y.toFixed(5)}`).sort().join('|');
const settled = a => !a.path && !a.fade && a.leaving == null && (a.flags & FLAGS.INDOORS) === 0;

// ---- shouldWalk ------------------------------------------------------------------------------------------------------

test('shouldWalk: walk only when <= 6 s, on screen, and not stalled/error/stopped', () => {
  assert.equal(WALK_MAX_S, 6);
  assert.equal(shouldWalk(15, 2.5, true, 'working'), true);         // exactly 6 s
  assert.equal(shouldWalk(15.5, 2.5, true, 'working'), false);
  assert.equal(shouldWalk(3, 2.5, false, 'working'), false);
  for (const s of ['stalled', 'error', 'stopped']) assert.equal(shouldWalk(1, 2.5, true, s), false, s);
  assert.equal(shouldWalk(1, 2.5, true, { bucket: 'resting', stopped: true }), false);
  assert.equal(shouldWalk(1, 2.5, true, { bucket: 'working', severity: 'error' }), false);
  assert.equal(shouldWalk(1, 2.5, true, { bucket: 'waiting' }), true);
  assert.equal(shouldWalk(0, 0, true, 'waiting'), true);
  assert.equal(shouldWalk(1, 0, true, 'waiting'), false);
});

// ---- rebuild stability -----------------------------------------------------------------------------------------------

for (const name of ['citydemo', 'busy']) {
  test(`${name}: a rebuild with no project changes moves no agent and re-targets none`, { skip: skipFor(name) }, () => {
    const { sim, fx } = make(name);
    sim.step(10);                                    // settle
    const before = new Map(agentsOf(sim).map(a => [a.id, { x: a.x, y: a.y, target: a._target, slot: a.slot && `${a.slot.tx},${a.slot.ty},${a.slot.sub}` }]));
    const nb = build(fx);
    sim.setWorld(nb.world, nb.nav);
    for (let i = 0; i < 100; i++) {
      sim.step(STEP);
      for (const a of agentsOf(sim)) {
        const b = before.get(a.id);
        if (!b) continue;
        assert.ok(a.x === b.x && a.y === b.y, `tick ${i}: ${a.id} moved ${b.x},${b.y} -> ${a.x},${a.y}`);
        assert.equal(a._target, b.target, `tick ${i}: ${a.id} re-targeted`);
      }
    }
    for (const a of agentsOf(sim)) {
      const b = before.get(a.id);
      assert.equal(a.slot && `${a.slot.tx},${a.slot.ty},${a.slot.sub}`, b.slot, `${a.id} slot`);
      if (a._target?.slotId) assert.equal(nb.nav.slots.heldBy(a.id)?.id, a._target.slotId, `${a.id} re-claimed its slot id in the new nav`);
    }
  });

  test(`${name}: after a rebuild no two settled actors share a sub-slot`, { skip: skipFor(name) }, () => {
    const { sim, fx } = make(name);
    sim.step(5);
    const nb = build(fx);
    sim.setWorld(nb.world, nb.nav);
    for (let i = 0; i < 200; i++) {
      sim.step(STEP);
      if (i % 20) continue;
      const bySlot = new Map(), byPos = new Map();
      for (const a of sim.actors.values()) {
        if (!settled(a)) continue;
        if (a.slot) {
          const k = `${a.slot.tx},${a.slot.ty},${a.slot.sub}`;
          assert.ok(!bySlot.has(k), `tick ${i}: ${a.id} shares sub-slot ${k} with ${bySlot.get(k)}`);
          bySlot.set(k, a.id);
        }
        if (a.kind === 'agent') {
          const k = `${a.x.toFixed(3)},${a.y.toFixed(3)}`;
          assert.ok(!byPos.has(k), `tick ${i}: agent ${a.id} stands on ${k} with ${byPos.get(k)}`);
          byPos.set(k, a.id);
        }
      }
      // and the registry itself: one holder per (tx, ty, sub)
      const pos = new Map();
      for (const s of nb.nav.slots.all()) {
        const o = nb.nav.slots.ownerOf(s.id);
        if (o == null) continue;
        const k = `${s.tx},${s.ty},${s.sub}`;
        assert.ok(!pos.has(k) || pos.get(k) === o, `tick ${i}: ${o} and ${pos.get(k)} hold ${k}`);
        pos.set(k, o);
      }
    }
  });
}

test('citydemo: ambient actors whose id survives a rebuild keep a legal position', { skip: skipFor('citydemo') }, () => {
  const { sim, fx } = make('citydemo');
  sim.step(3);
  const before = new Map([...sim.actors.values()].filter(a => a.kind !== 'agent').map(a => [a.id, [a.x, a.y]]));
  assert.ok(before.size > 0, 'fixture has ambient life');
  const nb = build(fx);
  sim.setWorld(nb.world, nb.nav);
  let kept = 0;
  for (const [id, [x, y]] of before) {
    const a = sim.actors.get(id);
    if (!a) continue;
    const g = nb.world.grid, tx = Math.floor(a.x), ty = Math.floor(a.y);
    assert.ok(g.get('cost', tx, ty) < 255 && g.get('occ', tx, ty) === 0, `${id} on an illegal tile`);
    if (a.x === x && a.y === y) kept++;
  }
  assert.ok(kept >= before.size * 0.9, `most ambient actors kept their spot (${kept}/${before.size})`);
});

// ---- stalled / error -------------------------------------------------------------------------------------------------

for (const name of ['citydemo', 'busy']) {
  test(`${name}: stalled and error agents never change x/y over 600 ticks (rebuild at 300)`, { skip: skipFor(name) }, () => {
    const { sim, fx, input } = make(name);
    const fixed = new Set(input.agents.filter(a => a.status === 'stalled' || a.status === 'error').map(a => a.id));
    if (!fixed.size) return;
    sim.step(STEP);
    const start = new Map(agentsOf(sim).filter(a => fixed.has(a.id)).map(a => [a.id, [a.x, a.y]]));
    for (let i = 0; i < 600; i++) {
      if (i === 300) { const nb = build(fx); sim.setWorld(nb.world, nb.nav); }
      sim.step(STEP);
      for (const [id, [x, y]] of start) {
        const a = sim.actors.get(id);
        assert.ok(a.x === x && a.y === y, `tick ${i}: ${id} moved ${x},${y} -> ${a.x},${a.y}`);
      }
    }
  });
}

// ---- walk vs fade on a real world ------------------------------------------------------------------------------------

/** A settled, visible, non-stalled agent and two destinations: a short one (<= 3 s) and a long one (> 6 s). */
function trips(sim, nav, world) {
  const g = world.grid;
  const legal = (tx, ty) => g.inBounds(tx, ty) && g.get('cost', tx, ty) < 255 && g.get('occ', tx, ty) === 0;
  const len = (p, x, y) => { let l = 0; for (let i = 0; i + 1 < p.length; i += 2) { l += Math.hypot(p[i] - x, p[i + 1] - y); x = p[i]; y = p[i + 1]; } return l; };
  const others = agentsOf(sim);
  for (const a of others) {
    if (!settled(a) || a.status?.bucket === 'stalled' || a.status?.bucket === 'error' || a.status?.stopped) continue;
    let short = null, long = null;
    for (let r = 2; r <= 4 && !short; r++) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
      const tx = Math.floor(a.x) + dx, ty = Math.floor(a.y) + dy;
      if (!legal(tx, ty)) continue;
      const p = nav.path({ x: a.x, y: a.y }, { x: tx + 0.5, y: ty + 0.5 });
      if (p && p.length >= 2 && len(p, a.x, a.y) / 2.5 <= 3) { short = p; break; }
    }
    for (const b of others) {
      if (b === a || Math.hypot(b.x - a.x, b.y - a.y) < 30) continue;
      const p = nav.path({ x: a.x, y: a.y }, { x: Math.floor(b.x) + 0.5, y: Math.floor(b.y) + 0.5 });
      if (p && p.length >= 2 && len(p, a.x, a.y) / 2.5 > WALK_MAX_S + 1) { long = p; break; }
    }
    if (short && long) return { a, short, long };
  }
  return null;
}
/** Give the actor a path as a behaviour would, then watch it for `secs`. */
function watch(sim, a, path, secs) {
  a.path = Float32Array.from(path); a.move = 'walk'; a.speed = 2.5;
  const x0 = a.x, y0 = a.y, end = [path[path.length - 2], path[path.length - 1]];
  const out = { walked: false, faded: false, between: 0 };
  for (let i = 0; i < Math.round(secs / STEP); i++) {
    sim.step(STEP);
    if (a.anim === 'walk' && !a.fade) out.walked = true;
    if (a.fade || a.alpha < 1) out.faded = true;
    const atStart = a.x === x0 && a.y === y0, atEnd = Math.abs(a.x - end[0]) < 1e-6 && Math.abs(a.y - end[1]) < 1e-6;
    if (!atStart && !atEnd) out.between++;
  }
  out.arrived = Math.abs(a.x - end[0]) < 1e-6 && Math.abs(a.y - end[1]) < 1e-6;
  return out;
}

test('citydemo: a short on-screen trip walks; a long trip fades; an off-screen trip fades', { skip: skipFor('citydemo') }, () => {
  const { sim, nav, world } = make('citydemo');
  sim.step(10);
  const t = trips(sim, nav, world);
  assert.ok(t, 'found an agent with a short and a long trip');
  const short = watch(sim, t.a, t.short, 4);
  assert.ok(short.walked && !short.faded && short.between > 0 && short.arrived, `short trip walked ${JSON.stringify(short)}`);

  const { sim: s2, nav: n2, world: w2 } = make('citydemo');
  s2.step(10);
  const t2 = trips(s2, n2, w2);
  const long = watch(s2, s2.actors.get(t2.a.id), t2.long, 2);
  assert.ok(long.faded && !long.walked && long.between === 0 && long.arrived, `long trip faded ${JSON.stringify(long)}`);

  const { sim: s3, nav: n3, world: w3 } = make('citydemo');
  s3.step(10);
  s3.setOnScreen(() => false);
  const t3 = trips(s3, n3, w3);
  const off = watch(s3, s3.actors.get(t3.a.id), t3.short, 2);
  assert.ok(off.faded && !off.walked && off.between === 0 && off.arrived, `off-screen trip faded ${JSON.stringify(off)}`);
});

// ---- step / select ---------------------------------------------------------------------------------------------------

test('citydemo: step(seconds) runs round(seconds/STEP) fixed steps; same seed -> same positions', { skip: skipFor('citydemo') }, () => {
  const A = make('citydemo'), B = make('citydemo');
  assert.equal(A.sim.step(0.12), 2);
  assert.equal(A.sim.tickCount, 2);
  assert.equal(A.sim.step(0.01), 0);
  A.sim.step(29.9); B.sim.step(30);
  assert.equal(A.sim.tickCount, B.sim.tickCount);
  assert.equal(posSnap(A.sim), posSnap(B.sim));
  const C = make('citydemo', SEED + 1);
  C.sim.step(30);
  assert.notEqual(posSnap(C.sim), posSnap(A.sim), 'a different seed differs somewhere');
});

test('select(id) sets FLAGS.SELECTED on exactly one actor; select(null) clears it', { skip: skipFor('citydemo') }, () => {
  const { sim } = make('citydemo');
  const [a, b] = agentsOf(sim);
  const selectedIds = () => [...sim.actors.values()].filter(x => x.flags & FLAGS.SELECTED).map(x => x.id);
  sim.select(a.id);
  assert.deepEqual(selectedIds(), [a.id]);
  sim.select(b.id);
  assert.deepEqual(selectedIds(), [b.id]);
  sim.step(1);
  assert.deepEqual(selectedIds(), [b.id], 'kept across steps');
  sim.select('no-such-actor');
  assert.deepEqual(selectedIds(), []);
  sim.select(a.id); sim.select(null);
  assert.deepEqual(selectedIds(), []);
});

// ---- slot guard unit -------------------------------------------------------------------------------------------------

test('guardSlots: two slot ids at one (tx, ty, sub) are never both held', async () => {
  const { createSlots } = await import('../web/src/engine/nav/slots.js');
  const world = { objects: new Map([
    ['A', { id: 'A', anchors: { stand: [{ tx: 1, ty: 1, sub: 0 }] } }],
    ['B', { id: 'B', anchors: { stand: [{ tx: 1, ty: 1, sub: 0 }, { tx: 2, ty: 1, sub: 0 }] } }],
  ]) };
  const S = guardSlots(createSlots(world));
  assert.ok(S.claim('A:stand:1,1:0', 'x'));
  assert.equal(S.claim('B:stand:1,1:0', 'y'), null, 'same position, different id');
  assert.equal(S.claim('B', 'y').id, 'B:stand:2,1:0', 'object ref skips the taken position');
  assert.equal(S.nearestFree(1, 1, 'stand'), null);
  S.release('x');
  assert.equal(S.nearestFree(1, 1, 'stand').id, 'A:stand:1,1:0');
});
