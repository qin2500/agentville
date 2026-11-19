// Harbour walk: characters in the port used to appear there out of nowhere; they should walk there from their
// town. A dock porter (mods/agentville.fantasy/ambient/porter.js) used to put every leg through the agents' D4 rule
// (walk only if <= 6 s and on screen, else fade); at the classic 1.25 tiles/s every town-to-quay leg is longer than that,
// so the porter faded out at its door and popped up on the quay. These tests follow a porter at the real speed and check
// the classic dock-walk.js behaviour: it shows up at its town origin (its home door, or the bottom of the town square for
// a townsperson), walks every step of the way on walkable tiles (never more than about a tile between two steps, never a
// fade), reaches the ship, and walks back home again. Spec-driven: written from the bug report, not from the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrom, loadFixture, fantasyMod, simMod, SEED } from './engine-support/sim-harness.mjs';

const { venueAssignments } = await import('../web/src/engine/world/venue.js');
const { SPEED } = await import('../mods/agentville.fantasy/ambient/porter.js');

const STEP = 0.05;
const LOAD = ['amber#1000', 'cedar#3000', 'cedar#3001', 'cedar#3002'];
const MAX_JUMP = 1.05;          // tiles between two steps (a walk at 1.25 tiles/s moves ~0.06; LOD off screen ~0.5)
const fixture = loadFixture('harbour-6.json');

function setup({ mutate, onScreen } = {}) {
  const built = buildFrom(fixture);
  const mod = fantasyMod();
  let input = { ...built.input, prs: built.input.prs.map(p => (LOAD.includes(p.id) ? { ...p, state: 'loading' } : p.state === 'loading' ? { ...p, state: 'merged' } : p)) };
  if (mutate) input = mutate(input);
  const berths = venueAssignments(built.world, input, mod, { venues: {} }, {}).prs;
  const sim = simMod.createSim({ world: built.world, nav: built.nav, seed: SEED, mod, serverId: built.serverId, clock: { dayLength: 60, phase0: 0.3 }, ...(onScreen ? { onScreen } : {}) });
  sim.applySnapshot(input, { berths });
  return { sim, world: built.world, input, berths };
}
const portersOf = sim => [...sim.actors.values()].filter(a => a.kind === 'porter');
const visible = a => (a.flags & 1) !== 0;
const walkable = (g, x, y) => { const tx = Math.floor(x), ty = Math.floor(y); return g.inBounds(tx, ty) && g.get('cost', tx, ty) < 255 && g.get('occ', tx, ty) === 0; };
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/**
 * Step the sim and follow porter `pick(sim)` from the step it first shows until it is home again (hidden) or `limit`
 * steps run out. Returns the trace: one { x, y, state, alpha, fade, visible } per step while it is out of doors.
 */
function follow(sim, pick, { limit = 6000, view } = {}) {
  let p = null;
  for (let i = 0; i < 4000 && !p; i++) { sim.step(STEP); p = pick(sim); }
  assert.ok(p, 'a porter goes out');
  const trace = [], origin = { ...p.origin };
  trace.push({ x: p.x, y: p.y, state: p.state, alpha: p.alpha ?? 1, fade: !!p.fade, visible: true });
  let sawDrop = false;
  for (let i = 0; i < limit; i++) {
    if (view) view(sim, i);
    sim.step(STEP);
    if (!visible(p)) break;
    if (p.state === 'drop') sawDrop = true;
    trace.push({ x: p.x, y: p.y, state: p.state, alpha: p.alpha ?? 1, fade: !!p.fade, visible: true });
  }
  return { p, trace, origin, sawDrop, home: !visible(p) };
}

function assertWalked(world, { p, trace, origin, sawDrop, home }, who) {
  const g = world.grid, dock = world.venues.dock;
  // it shows up in town, at its origin, not on the quay
  assert.ok(dist(trace[0], origin) <= 1.0, `${who} first shows at its origin (${trace[0].x.toFixed(2)},${trace[0].y.toFixed(2)} vs ${origin.x},${origin.y})`);
  const toDock = Math.hypot(origin.x - (dock.tx + 0.5), origin.y - (dock.ty + 0.5));
  assert.ok(toDock > SPEED * 6, `${who}: the origin is a town spot more than a 6 s walk from the dock (${toDock.toFixed(1)} tiles)`);
  // every step is a walk: no fade, no jump, on walkable ground
  let far = 0;
  for (let i = 0; i < trace.length; i++) {
    const s = trace[i];
    assert.equal(s.fade, false, `${who} step ${i}: fading (${s.state})`);
    assert.ok(s.alpha >= 1 - 1e-9, `${who} step ${i}: alpha ${s.alpha}`);
    assert.ok(walkable(g, s.x, s.y), `${who} step ${i}: on a blocked tile ${Math.floor(s.x)},${Math.floor(s.y)}`);
    if (i) assert.ok(dist(s, trace[i - 1]) <= MAX_JUMP, `${who} step ${i}: jumped ${dist(s, trace[i - 1]).toFixed(2)} tiles (${trace[i - 1].state} -> ${s.state})`);
    far = Math.max(far, dist(s, origin));
  }
  assert.ok(sawDrop, `${who} reached its ship and set the crate down`);
  assert.ok(Math.abs(p.x - p.to.x) < 1.5 || far > SPEED * 6, `${who} walked out to the dock`);
  // and walked home: it goes indoors at its origin, after walking there
  assert.ok(home, `${who} got home`);
  const last = trace[trace.length - 1];
  assert.ok(dist(last, origin) <= MAX_JUMP, `${who} the last step out of doors is at its origin (${dist(last, origin).toFixed(2)} tiles away)`);
}

test('harbour walk: a townsperson porter walks from the town square to its ship and back, no fade, no jump', () => {
  const { sim, world } = setup();
  const r = follow(sim, s => portersOf(s).find(x => visible(x) && x.job?.startsWith('town:')) ?? null);
  assertWalked(world, r, r.p.id);
});

test('harbour walk: a resting agent carries its own crate from its home door to the dock and back on foot', () => {
  const pr = 'amber#1000';
  const { sim, world } = setup({ mutate: inp => ({ ...inp, agents: inp.agents.map(a => (a.project === 'amber' && a.status === 'resting' ? { ...a, prs: [pr] } : a)) }) });
  const r = follow(sim, s => portersOf(s).find(x => visible(x) && x.job?.startsWith('agent:')) ?? null);
  const home = sim.homeOf(r.p.agentId);
  assert.ok(home?.door, 'its home has a door');
  assert.ok(Math.abs(r.origin.x - (home.door.tx + 0.5)) < 1e-9 && Math.abs(r.origin.y - (home.door.ty + 0.5)) < 1e-9, 'its origin is its own door');
  assertWalked(world, r, r.p.id);
});

test('harbour walk: a PR that starts loading mid-run sends a porter walking from town (no pop-in on the quay)', () => {
  const { sim, world, input } = setup({ mutate: inp => ({ ...inp, prs: inp.prs.map(p => (LOAD.includes(p.id) ? { ...p, state: 'merged' } : p)) }) });
  for (let i = 0; i < 100; i++) sim.step(STEP);
  assert.equal(portersOf(sim).filter(visible).length, 0, 'no ships, nobody out');
  // the state change: the PRs open again (loading), ships berth, porters set off
  const live = { ...input, prs: input.prs.map(p => (LOAD.includes(p.id) ? { ...p, state: 'loading' } : p)) };
  const b2 = venueAssignments(world, live, fantasyMod(), { venues: {} }, {}).prs;
  sim.applySnapshot(live, { berths: b2 });
  const r = follow(sim, s => portersOf(s).find(visible) ?? null);
  assertWalked(world, r, r.p.id);
});

test('harbour walk: off screen and zoomed out (LOD on) a porter still walks the whole way, never faster than a tile a step', () => {
  // the camera sits far away: every porter is off screen and runs on the LOD.off cadence
  const { sim, world } = setup({ onScreen: () => false });
  sim.setView({ zoom: 0.5 });
  const r = follow(sim, s => portersOf(s).find(x => visible(x) && x.job?.startsWith('town:')) ?? null);
  assertWalked(world, r, r.p.id);
});

test('harbour walk: every porter out at once keeps to walking (6 porters, 600 s of sim time)', () => {
  const { sim, world } = setup();
  const last = new Map();
  let moves = 0;
  for (let i = 0; i < 12000; i++) {
    sim.step(STEP);
    for (const p of portersOf(sim)) {
      if (!visible(p)) { last.delete(p.id); continue; }
      assert.equal(p.fade ?? null, null, `step ${i}: ${p.id} fading (${p.state})`);
      const q = last.get(p.id);
      if (!q) assert.ok(dist(p, p.origin) <= 1.0, `step ${i}: ${p.id} first shows away from its origin (${p.state})`);
      else if (dist(p, q) > 0) { assert.ok(dist(p, q) <= MAX_JUMP, `step ${i}: ${p.id} jumped ${dist(p, q).toFixed(2)}`); moves++; }
      assert.ok(walkable(world.grid, p.x, p.y), `step ${i}: ${p.id} on a blocked tile`);
      last.set(p.id, { x: p.x, y: p.y });
    }
  }
  assert.ok(moves > 1000, `porters walked (${moves} moves)`);
});
