// PERF M7 pmap: the map-zoom sim frame. The fantasy porters used to scan every actor per idle porter per step (who has a
// job) and sort every agent per tick (who carries which ship): a step where porters came due cost ~0.2 ms more than its
// neighbours, which made the 3-step frames at map zoom the p95. Now the porter list is gathered once per tick and the
// ship owners in one unsorted pass. These tests pin that the answers are exactly the old ones, step by step, through
// LOD, wake-ups and a rebuild (which respawns the porters). Pure node, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildFrom, loadFixture, fantasyMod, simMod, SEED } from './engine-support/sim-harness.mjs';

const { venueAssignments } = await import('../web/src/engine/world/venue.js');
const { wantsOf, portersOf, restingIndoors } = await import('../mods/agentville.fantasy/ambient/porter.js');

const STEP = 0.05;
const LOAD = ['amber#1000', 'cedar#3000', 'cedar#3001', 'cedar#3002'];
const fixture = loadFixture('harbour-6.json');

/** The answers as the porter computed them before PERF M7 (full scans, id sort). */
function wantsRef(ctx, venue) {
  const want = new Map();
  const ships = (ctx.tokens?.list?.() ?? []).filter(s => s.venue === venue && !s.depart && s.leaving == null);
  if (!ships.length) return want;
  const agents = [...ctx.actors.values()].filter(x => x.kind === 'agent').sort((p, q) => (p.id < q.id ? -1 : 1));
  for (const s of ships) {
    const ag = agents.find(x => Array.isArray(x.input?.prs) && x.input.prs.includes(s.item) && restingIndoors(x, ctx));
    const id = ag ? `agent:${ag.id}` : `town:${s.item}`;
    if (!want.has(id)) want.set(id, { agentId: ag ? ag.id : null, ships: [] });
    want.get(id).ships.push(s.item);
  }
  return want;
}
const portersRef = (ctx, venue) => [...ctx.actors.values()].filter(o => o.kind === 'porter' && o.venue === venue);

/** The harbour-6 world with the porter behaviour wrapped: before every porter update, the new answers are compared with
 *  the reference ones on the very ctx the porter sees. */
function setup() {
  const built = buildFrom(fixture);
  const base = fantasyMod(), P = base.ambient.behaviours.porter;
  let checks = 0;
  const porter = {
    ...P,
    update(a, dt, ctx) {
      assert.deepEqual([...wantsOf(ctx, a.venue)], [...wantsRef(ctx, a.venue)], `wants at tick ${ctx.tick}`);
      assert.deepEqual(portersOf(ctx, a.venue), portersRef(ctx, a.venue), `porters at tick ${ctx.tick}`);
      checks++;
      return P.update(a, dt, ctx);
    },
  };
  const mod = { ...base, ambient: { ...base.ambient, behaviours: { ...base.ambient.behaviours, porter } } };
  // every resting agent lists every loading PR, so several are candidates for each ship and the owner pick (lowest id) matters
  const input = { ...built.input,
    prs: built.input.prs.map(p => (LOAD.includes(p.id) ? { ...p, state: 'loading' } : p.state === 'loading' ? { ...p, state: 'merged' } : p)),
    agents: built.input.agents.map(a => (a.status === 'resting' ? { ...a, prs: LOAD } : a)) };
  const berths = venueAssignments(built.world, input, mod, { venues: {} }, {}).prs;
  const sim = simMod.createSim({ world: built.world, nav: built.nav, seed: SEED, mod, serverId: built.serverId, clock: { dayLength: 60, phase0: 0.3 } });
  sim.applySnapshot(input, { berths });
  return { sim, built, input, berths, checks: () => checks };
}
const digest = sim => crypto.createHash('sha1').update(JSON.stringify([...sim.actors.values()]
  .map(a => [a.id, a.kind, +a.x.toFixed(6), +a.y.toFixed(6), a.flags, a.state ?? null, a.job ?? null, a.item ?? null, a.path ? Array.from(a.path) : null]))).digest('hex');

test('porters: wants and the porter list equal the full-scan answers every step (LOD on, wake-ups, a rebuild)', () => {
  const { sim, built, input, berths, checks } = setup();
  sim.setOnScreen((x, y) => x < 40); sim.setView({ zoom: 0.25 });   // map zoom: far + off-screen LOD both in play
  for (let i = 0; i < 600; i++) sim.tick(STEP);
  // an owner wakes up: its job goes back to the townsfolk
  const owner = [...sim.actors.values()].filter(a => a.kind === 'agent' && a.input?.prs?.includes('amber#1000') && (a.flags & 8)).sort((p, q) => (p.id < q.id ? -1 : 1))[0];
  sim.applySnapshot({ ...input, agents: input.agents.map(a => (a.id === owner.id ? { ...a, status: 'working' } : a)) }, { berths });
  for (let i = 0; i < 300; i++) sim.tick(STEP * 2.5);
  // a rebuild respawns the porters: the next update must see the new ones
  sim.setWorld(built.world, built.nav);
  for (let i = 0; i < 300; i++) sim.tick(STEP);
  assert.ok(checks() > 200, `porters ran (${checks()} checked updates)`);
});

test('porters: the same run twice gives the same actors (deterministic with the per-tick lists)', () => {
  const run = () => {
    const { sim } = setup();
    sim.setOnScreen(() => true); sim.setView({ zoom: 0.25 });
    for (let i = 0; i < 400; i++) sim.tick(0.125);
    return digest(sim);
  };
  assert.equal(run(), run());
});
