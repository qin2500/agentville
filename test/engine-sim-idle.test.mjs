import './support/ensure-mods-index.mjs';
// Agents at rest (PERF M7 asim): the world-sim offers a still agent to the agent behaviour's idle() instead of running
// every system for it. That is a pure cost cut: with it on or off (createSim fastIdle) every actor field, every event,
// every held slot and every rendered value is identical, step for step, through status churn, joins and leaves, PR
// changes, reduced motion, a rebuild, fast-forward ticks, step() and the ambient LOD views.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { createSim, STEP } = await import('../web/src/engine/sim/world-sim.js');
const agentB = await import('../web/src/engine/sim/behaviours/agent.js');

const SEED = 7;
const SEQ = loadFixture('sequence-50.json'), BUSY = loadFixture('busy.json');
const frames = SEQ?.frames ?? [];

function fantasyMod() {
  const m = resolveMod();
  return { ...m, behaviour: m.behaviour ?? fantasy.behaviour, represent: m.represent ?? fantasy.represent, ambient: m.ambient ?? fantasy.ambient };
}
const inputOf = (fx, seed = SEED) => toWorldInput(viewFromFixture(fx), { seed, salt: String(seed) });
function buildFrom(fx, seed = SEED) {
  const { input, serverId } = inputOf(fx, seed);
  const world = buildWorld(input, { v: 1, seed, blocks: {}, lots: {} }, { now: fx.now, seed, serverId });
  return { world, nav: createNav(world), input, serverId };
}
/** Two sims on the same world and inputs, the fast path on (`on`) and off (`off`). */
function pair(fx) {
  const mod = fantasyMod();
  const mk = fastIdle => {
    const b = buildFrom(fx);
    const sim = createSim({ world: b.world, nav: b.nav, seed: SEED, mod, serverId: b.serverId, clock: { dayLength: 60, phase0: 0.3 }, fastIdle });
    sim.applySnapshot(b.input);
    return { ...b, sim };
  };
  return { on: mk(true), off: mk(false) };
}

// the fast path's own bookkeeping (it exists on one side only); everything else must match
const OWN = new Set(['_still', '_slotRef', '_slotGen', '_P', '_Pspec', '_Pkey']);
const stateOf = a => Object.fromEntries(Object.entries(a).filter(([k]) => !OWN.has(k)));
function assertSame(on, off, where) {
  const A = on.sim, B = off.sim;
  assert.equal(A.tickCount, B.tickCount, `${where}: tick`);
  assert.equal(A.alpha, B.alpha, `${where}: alpha`);
  assert.deepEqual([...A.actors.keys()].sort(), [...B.actors.keys()].sort(), `${where}: actor ids`);
  for (const [id, a] of A.actors) {
    const b = B.actors.get(id);
    if (!isDeepStrictEqual(stateOf(a), stateOf(b))) {
      const diff = Object.keys({ ...stateOf(a), ...stateOf(b) }).filter(k => !isDeepStrictEqual(a[k], b[k]));
      assert.fail(`${where}: actor ${id} differs in ${diff.join(', ')}: ${diff.map(k => `${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`).join('; ')}`);
    }
    const sa = on.nav?.slots?.heldBy?.(id), sb = off.nav?.slots?.heldBy?.(id);
    assert.equal(sa?.id ?? null, sb?.id ?? null, `${where}: slot of ${id}`);
  }
}
const drainEvents = sim => (typeof sim.events.drain === 'function' ? sim.events.drain() : typeof sim.events.take === 'function' ? sim.events.take() : null);

test('fast idle path: identical to the full systems through 50 frames of status churn, rebuild, reduced motion, LOD, fast-forward',
  { skip: frames.length ? false : 'sequence-50 fixture missing', timeout: 240_000 }, () => {
    const { on, off } = pair(frames[0]);
    const both = fn => { fn(on); fn(off); };
    let rested = 0;
    const steps = (k, dt = STEP, label = '') => {
      for (let i = 0; i < k; i++) {
        both(s => s.sim.tick(dt));
        rested = Math.max(rested, on.sim.lod.rest ?? 0);
        assertSame(on, off, `${label} step ${i}`);
      }
      assert.deepEqual(drainEvents(on.sim), drainEvents(off.sim), `${label}: events`);
    };
    steps(60, STEP, 'settle');
    for (let f = 1; f < frames.length; f++) {
      const fr = frames[f];
      const reduce = f >= 20 && f < 24;              // reduced motion for a few frames, then back
      both(s => {
        const { input } = inputOf(fr);
        s.sim.applySnapshot({ ...input, env: { ...input.env, reduceMotion: reduce } });
      });
      if (f === 10) both(s => s.sim.setView({ zoom: 0.25 }));                       // map zoom, ambient LOD on
      if (f === 15) both(s => { s.sim.setView({ zoom: 2 }); s.sim.setOnScreen((x, y) => x < 40 && y < 40); });
      if (f === 30) both(s => { s.sim.setView(null); s.sim.setOnScreen(() => true); });
      if (f === 25) {                                 // a rebuild with the same content: actors kept, agents re-plan
        both(s => { const b = buildFrom(fr); s.sim.setWorld(b.world, b.nav); s.nav = b.nav; });
      }
      // uneven frame dts (render frames), incl. one long stall that fast-forwards
      steps(4, 0.0167, `frame ${f}`);
      steps(3, STEP, `frame ${f}`);
      if (f % 9 === 0) steps(1, 0.5, `frame ${f} fast-forward`);
      if (f % 7 === 0) { both(s => s.sim.step(1.2)); assertSame(on, off, `frame ${f} step()`); }
      if (f % 11 === 0) { both(s => s.sim.select([...s.sim.actors.keys()].sort()[f])); }
    }
    steps(400, STEP, 'tail');                          // long rest: every idle cue starts and ends many times
    assert.ok(rested > 50, `the fast path took agents at rest (most at once: ${rested})`);
  });

test('fast idle path: busy world, 1,000 steps of rest with cues, identical and mostly idle', { skip: BUSY ? false : 'busy fixture missing', timeout: 240_000 }, () => {
  const { on, off } = pair(BUSY);
  let rest = 0, n = 0;
  for (let i = 0; i < 1000; i++) {
    on.sim.tick(STEP); off.sim.tick(STEP);
    if (i % 50 === 49) assertSame(on, off, `step ${i}`);
    if (i >= 200) { rest += on.sim.lod.rest; n++; }
  }
  assertSame(on, off, 'end');
  const agents = [...on.sim.actors.values()].filter(a => a.kind === 'agent').length;
  assert.ok(rest / n > agents * 0.8, `most agents rest on a step (${(rest / n).toFixed(0)} of ${agents})`);
  assert.equal(off.sim.lod.rest, 0, 'fastIdle: false never rests');
});

test('a status change on a resting agent shows on the very next step', { skip: frames.length ? false : 'fixture missing' }, () => {
  const { on, off } = pair(frames[0]);
  for (let i = 0; i < 100; i++) { on.sim.tick(STEP); off.sim.tick(STEP); }
  const { input } = inputOf(frames[0]);
  const ag = input.agents.find(x => on.sim.actors.get(x.id)?._still && x.status === 'working');
  assert.ok(ag, 'a resting working agent');
  const next = { ...input, agents: input.agents.map(x => (x.id === ag.id ? { ...x, status: 'error' } : x)) };
  on.sim.applySnapshot(next); off.sim.applySnapshot(next);
  assert.equal(on.sim.actors.get(ag.id)._still, false, 'the snapshot woke it');
  on.sim.tick(STEP); off.sim.tick(STEP);
  const a = on.sim.actors.get(ag.id);
  assert.equal(a._bkey, 'stalled:error', 'its behaviour key changed within one step');
  assert.ok(a.fx?.includes?.('smoke') || a.state !== 'hold', 'its new look is applied within one step');
  assertSame(on, off, 'after the change');
});

test('idle() changes nothing when it declines, and declines a cue start, a changed status and an unsettled state', () => {
  const ctx = { mod: null, reduceMotion: false };
  const spec = { place: 'p', pose: 'idle', idle: ['look-around'] };
  const P = { mod: null, idle: spec.idle, pose: 'idle', idleEvery: undefined, ghost: false, base: 'idle', fx: null, cues: ['look-around'], every: [6, 10] };
  const status = { bucket: 'waiting' };
  const mk = () => {
    const a = { id: 'a', state: 'hold', spec, status, pr: undefined, prs: [], _sig: 's', _spec: spec, _bkey: 'waiting', flags: 1,
      _P: P, _Pspec: spec, _Pkey: 'waiting', fx: null, pose: 'idle', face: 1, cue: null, _cueT: 0, _nextCue: 1 };
    a._sigOf = [a.spec, a.status, a.pr, a.prs, a._sig, a._spec];
    return a;
  };
  const a = mk();
  assert.equal(agentB.idle(a, STEP, ctx), true);
  assert.equal(a._nextCue, 1 - STEP, 'the cue timer counts down exactly as update() would');
  const b = mk(); b._nextCue = STEP;
  const before = JSON.stringify(b);
  assert.equal(agentB.idle(b, STEP, ctx), false, 'a cue starting needs update()');
  assert.equal(JSON.stringify(b), before, 'and nothing changed');
  const c = mk(); c.status = { bucket: 'error' };
  assert.equal(agentB.idle(c, STEP, ctx), false, 'a new status needs update()');
  const d = mk(); d.state = 'go';
  assert.equal(agentB.idle(d, STEP, ctx), false, 'a walk needs update()');
  const e = mk(); e._bkey = e._Pkey = 'stalled:attention'; e.face = 2;
  assert.equal(agentB.idle(e, STEP, ctx), false, 'a pinned agent facing away needs update() to face the viewer');
});
