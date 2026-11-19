import './support/ensure-mods-index.mjs';
// Parity: who stands outdoors when most of the town is resting sub-agents (vil.resting-indoors).
// Classic (web/src/world.js placeAgents): every agent finds the house of itself or its nearest ancestor with one; an agent
// that `folds` (resting and not Important) goes indoors there, a sub-agent included; one with no such house is not drawn.
// The live app had ~650 resting figures by the harbour on engine v2 against ~25 on classic: resting subs were never indoors
// and resting agents the resting-home cap left without a house stood outdoors by the village centre.
// The engine has no yard cap (lbl.crowd-tags waived): it also draws classic's yard overflow ("crowd").
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.location ??= { search: '', href: 'http://x/' };
globalThis.window ??= globalThis;
const mem = {};
globalThis.localStorage ??= { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };

const classic = await import('../web/src/world.js');
const { folds } = await import('../web/src/important.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { createSim } = await import('../web/src/engine/sim/world-sim.js');
const { FLAGS } = await import('../web/src/engine/sim/actor.js');
const { representAgent } = await import('../web/src/engine/sim/represent.js');

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const SUBS = 120;

/** Two projects, mostly resting sub-agents (the live shape: 481 of 689 agents were resting subs). */
function fixture() {
  const agents = [];
  let n = 0;
  const mk = (project, id, bucket, role, parentId, extra = {}) => {
    n++;
    agents.push({ id, name: id, shortName: id, project, bucket, role, parentId: parentId ?? null, severity: null, prompt: null,
      live: bucket !== 'resting', lastActivityAt: NOW - n * 60_000, since: NOW - n * 60_000, prs: [], ...extra });
    return id;
  };
  // harbourtown: an awake boss and lead, a resting lead, four resting solos (the cap gives two of them houses), one Important
  const boss = mk('harbourtown', 'h-boss', 'waiting', 'boss');
  const lead = mk('harbourtown', 'h-lead', 'building', 'lead', boss);
  const sleepyLead = mk('harbourtown', 'h-lead-rest', 'resting', 'lead', boss);
  for (let i = 0; i < 4; i++) mk('harbourtown', `h-solo-${i}`, 'resting', 'solo');
  mk('harbourtown', 'h-solo-vip', 'resting', 'solo', null, { important: true });
  const parents = [boss, lead, sleepyLead];
  for (let i = 0; i < SUBS; i++) mk('harbourtown', `h-sub-${i}`, 'resting', 'sub', parents[i % 3]);
  mk('harbourtown', 'h-sub-awake-0', 'building', 'sub', lead);
  mk('harbourtown', 'h-sub-awake-1', 'waiting', 'sub', boss);
  mk('harbourtown', 'h-sub-vip', 'resting', 'sub', lead, { important: true });       // Important: classic keeps it outdoors
  mk('harbourtown', 'h-subsub', 'resting', 'sub', 'h-sub-0');                           // a sub of a sub: the boss's house
  // quietfield: every lead resting (the cap houses two), and their subs resting
  for (let l = 0; l < 4; l++) {
    const ld = mk('quietfield', `q-lead-${l}`, 'resting', 'lead');
    for (let i = 0; i < 20; i++) mk('quietfield', `q-sub-${l}-${i}`, 'resting', 'sub', ld);
  }
  mk('quietfield', 'q-awake', 'building', 'solo');
  const projects = ['harbourtown', 'quietfield'].map(name => ({ name, prs: [], transcriptBytes: 2e6, agentsEver: 40 }));
  return { agents, projects };
}

function classicPlacement(agents, projects) {
  const byId = new Map(agents.map(a => [a.id, a]));
  const W = classic.layout(classic.plan(agents, byId, projects), NOW);
  const seenIdx = new Map(agents.map((a, i) => [a.id, i]));
  const { vill } = classic.placeAgents(W, agents, byId, seenIdx);
  return { vill };
}

function enginePlacement(agents, projects) {
  const view = makeView({ agents, projects, dock: { loading: [], sailed: [], total: 0, level: 1 } }, { now: NOW });
  const { input, serverId, opaqueId } = toWorldInput(view, { seed: 7, salt: '7' });
  const world = buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { now: NOW, seed: 7, serverId });
  const sim = createSim({ world, nav: createNav(world), seed: 7, mod: resolveMod(), serverId, clock: { dayLength: 60, phase0: 0.3 } });
  sim.applySnapshot(input);
  sim.step(12);
  const byServer = new Map();
  for (const a of sim.actors.values()) if (a.kind === 'agent') byServer.set(serverId(a.id), a);
  return { sim, world, byServer, input, opaqueId };
}

const isOut = a => (a.flags & FLAGS.VISIBLE) !== 0 && (a.flags & FLAGS.INDOORS) === 0;

test('[vil.resting-indoors] many resting sub-agents: engine v2 stands outdoors exactly who classic does', () => {
  const { agents, projects } = fixture();
  const { vill } = classicPlacement(agents, projects);
  const { byServer } = enginePlacement(agents, projects);
  assert.equal(byServer.size, agents.length, 'every agent has an actor');

  // classic outdoors: placed, not folded (its yard overflow included: the engine draws the crowd too)
  const classicOut = new Set([...vill.values()].filter(v => !folds(v.a)).map(v => v.a.id));
  const engineOut = new Set([...byServer].filter(([, a]) => isOut(a)).map(([id]) => id));
  assert.deepEqual([...engineOut].sort(), [...classicOut].sort());
  assert.ok(engineOut.size < 15, `a handful outdoors, not the ${SUBS}+ resting subs (got ${engineOut.size})`);

  // what that set is: the awake agents and the two Important resting ones; no resting un-pinned agent at all
  const expectOut = agents.filter(a => !folds(a)).map(a => a.id).sort();
  assert.deepEqual([...engineOut].sort(), expectOut);
  for (const id of ['h-sub-vip', 'h-solo-vip', 'h-sub-awake-0', 'h-sub-awake-1']) assert.ok(engineOut.has(id), `${id} stays visible`);
});

test('[vil.resting-indoors] a resting sub-agent goes into the house classic puts it in; one with no house in its chain is hidden', () => {
  const { agents, projects } = fixture();
  const { vill } = classicPlacement(agents, projects);
  const { byServer, world } = enginePlacement(agents, projects);
  let housed = 0, nowhere = 0;
  for (const a of agents) {
    if (!folds(a)) continue;
    const act = byServer.get(a.id), v = vill.get(a.id);
    assert.ok((act.flags & FLAGS.INDOORS) !== 0 && (act.flags & FLAGS.VISIBLE) === 0, `${a.id} is indoors`);
    if (v) {
      const house = world.objects.get(act._target?.homeId);
      assert.equal(house?.data?.agentId, v.home.agentId, `${a.id} is in ${v.home.agentId}'s house, as on classic`);
      housed++;
    } else {
      assert.equal(act._target?.nowhere, true, `${a.id}: classic does not draw it; the engine keeps it indoors, nowhere`);
      nowhere++;
    }
  }
  assert.ok(housed > SUBS / 2, `most resting subs have a house in their chain (${housed})`);
  assert.ok(nowhere > 0, 'the resting-home cap leaves some resting agents (and their subs) without a house');
  assert.equal(world.objects.get(byServer.get('h-subsub')._target.homeId)?.data?.agentId, 'h-boss', 'a sub of a sub: its grandparent\'s house');
});

test('[vil.resting-indoors] they stay indoors across polls and come out when they wake', () => {
  const { agents, projects } = fixture();
  const { sim, byServer, opaqueId } = enginePlacement(agents, projects);
  const view = s => makeView({ agents: s, projects, dock: { loading: [], sailed: [], total: 0, level: 1 } }, { now: NOW });
  const again = toWorldInput(view(agents), { seed: 7, salt: '7' }).input;
  sim.applySnapshot(again);
  sim.step(6);
  const outNow = [...byServer.values()].filter(isOut).length;
  assert.equal(outNow, agents.filter(a => !folds(a)).length, 'a repeat poll moves no one outdoors');
  // h-sub-3 (parent: the awake boss) wakes up: it comes out to its parent's yard
  const woke = agents.map(a => (a.id === 'h-sub-3' ? { ...a, bucket: 'waiting', live: true } : a));
  sim.applySnapshot(toWorldInput(view(woke), { seed: 7, salt: '7' }).input);
  sim.step(12);
  const a = sim.actors.get(opaqueId('h-sub-3'));
  assert.ok(isOut(a), 'a sub-agent that wakes up is outdoors again');
});

test('[vil.resting-indoors] representAgent: a resting sub is indoors at the resting place; an awake or Important sub keeps the sub place', () => {
  const mod = resolveMod();
  const sub = status => ({ id: 's', parent: 'p', role: 'sub', status, prs: [] });
  const r = representAgent(sub('resting'), mod);
  assert.equal(r.indoors, true); assert.equal(r.sub, true); assert.equal(r.place, 'home.forecourt');
  for (const st of ['waiting', 'working', 'stalled']) { const s = representAgent(sub(st), mod); assert.equal(s.indoors, false, st); assert.equal(s.place, 'anchor:stand', st); }
  const vip = representAgent({ ...sub('resting'), important: true }, mod);
  assert.equal(vip.indoors, false); assert.equal(vip.ghost, true); assert.equal(vip.place, 'anchor:stand');
});
