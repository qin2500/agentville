import './support/ensure-mods-index.mjs';
// M7 thin growth in the engine: growth room round a standing block (world/room.js), the planner told where
// there is room (rules phase -> planSettlement `grow.room`), new blocks placed into a standing town keep room to grow
// (mod.rules.layout.growRoom), a world's first build packs exactly as before, and the measured shift rate stays low.
// Pure, node only: no store, no real sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { growthRoom } = await import('../web/src/engine/world/room.js');
const { planSettlements, placeBlocks, growRoomOf } = await import('../web/src/engine/world/sites.js');
const { runRules } = await import('../web/src/engine/world/rules-phase.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { engineRate } = await import('../tools/engine/shift-rate.mjs');

const near = (a, b, g) => a.x < b.x + b.w + g && b.x < a.x + a.w + g && a.y < b.y + b.h + g && b.y < a.y + a.h + g;
const GAP = fantasy.rules.layout.gap, SQUARE = fantasy.rules.layout.square;

// brute force: the grown rect for corner c, g across and v up/down, is clear of every obstacle
function fits(b, obs, gap, c, g, v) {
  const r = { x: c.endsWith('w') ? b.x - g : b.x, y: c.startsWith('n') ? b.y - v : b.y, w: b.w + g, h: b.h + v };
  return !obs.some(o => near(r, o, gap));
}

test('growthRoom matches a brute-force search in every corner', () => {
  let seed = 3;
  const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  for (let k = 0; k < 60; k++) {
    const b = { x: 0, y: 0, w: 5 + rnd(20), h: 5 + rnd(20) };
    const obs = [];
    for (let i = 0; i < 1 + rnd(8); i++) {
      const o = { x: rnd(80) - 40, y: rnd(80) - 40, w: 2 + rnd(15), h: 2 + rnd(15) };
      if (!near(o, b, GAP)) obs.push(o);
    }
    const R = growthRoom(b, obs, GAP, 30);
    for (const c of ['se', 'sw', 'ne', 'nw']) for (let g = 0; g <= 30; g++) {
      let v = -1;
      while (v < 30 && fits(b, obs, GAP, c, g, v + 1)) v++;
      assert.equal(R[c][g], v, `case ${k} ${c} g=${g}`);
    }
  }
});

test('growthRoom: a block already too near something has no room; open ground is capped', () => {
  const b = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(growthRoom(b, [], GAP, 8).se, Array(9).fill(8));
  const R = growthRoom(b, [{ x: 11, y: 0, w: 4, h: 4 }], GAP, 8);   // 1 tile east: within the gap already
  for (const c of ['se', 'sw', 'ne', 'nw']) assert.ok(R[c].every(v => v === -1), c);
});

// a hand-built WorldInput: n projects of `agents` agents each (WorldInput shape as engine/mod/input.js makes it)
const NOW = Date.UTC(2026, 10, 14, 12);
const agent = (id, project, o = {}) => ({ id, name: id, project, parent: null, status: 'working', needs: null, role: o.role ?? 'worker',
  crown: o.role === 'boss', important: false, stopped: false, harness: 'claude', since: 0, lastActive: NOW, prs: [] });
function input(projects) {
  const agents = [], P = [];
  for (const [name, n, prs] of projects) {
    agents.push(agent(`${name}-boss`, name, { role: 'boss' }));
    for (let i = 1; i < n; i++) agents.push(agent(`${name}-${i}`, name));
    P.push({ key: name, name, accent: '', stats: { prsEver: prs, prsLive: 0, agentsEver: n, agentsNow: n, transcriptMB: 0 } });
  }
  return { apiVersion: 1, now: NOW, seed: 7, agents, projects: P, prs: [], env: { night: 0, reduceMotion: false, zoom: 1 } };
}
function rebuild(inp, persisted, mod = fantasy) {
  const opts = { now: NOW, seed: 7 };
  const rules = runRules(inp, persisted, mod, opts);
  const { settlements } = planSettlements(inp, persisted, mod, opts, rules);
  return placeBlocks(settlements, persisted, mod, { now: NOW, seed: 7 });
}
const noRoom = { ...fantasy, rules: { ...fantasy.rules, layout: { ...fantasy.rules.layout } } };
delete noRoom.rules.layout.growRoom;
const SEVEN = [['a', 3, 0], ['b', 6, 2], ['c', 2, 0], ['d', 9, 5], ['e', 4, 1], ['f', 5, 0], ['g', 3, 3]];

test('a world\'s first build packs every block exactly as without growth room', () => {
  const P1 = { v: 1, seed: 7, blocks: {}, lots: {} }, P2 = { v: 1, seed: 7, blocks: {}, lots: {} };
  rebuild(input(SEVEN), P1);
  rebuild(input(SEVEN), P2, noRoom);
  assert.deepEqual(P1.blocks, P2.blocks);
  assert.ok(growRoomOf(fantasy), 'the fantasy mod keeps growth room');
  assert.equal(growRoomOf(noRoom), null);
  assert.throws(() => growRoomOf({ rules: { layout: { growRoom: { x: [1, 2], y: [1, 2, 3, 4] } } } }), /growRoom/);
});

test('a block placed into a standing town keeps its growth room from every other block; standing blocks never move', () => {
  const P = { v: 1, seed: 7, blocks: {}, lots: {} };
  rebuild(input(SEVEN), P);
  const before = JSON.parse(JSON.stringify(P.blocks));
  rebuild(input([...SEVEN, ['newcomer', 2, 0]]), P);
  for (const [n, b] of Object.entries(before)) assert.deepEqual({ ...P.blocks[n], seen: 0 }, { ...b, seen: 0 }, `${n} stayed`);
  const nb = P.blocks.newcomer, room = fantasy.rules.layout.growRoom, at = t => ({ x: room.x[t], y: room.y[t] });
  for (const [n, o] of Object.entries(before)) {
    const g = { x: GAP + at(nb.tier).x + at(o.tier).x, y: GAP + at(nb.tier).y + at(o.tier).y };
    const apart = nb.x >= o.x + o.w + g.x || o.x >= nb.x + nb.w + g.x || nb.y >= o.y + o.h + g.y || o.y >= nb.y + nb.h + g.y;
    assert.ok(apart, `newcomer keeps its room from ${n}`);
  }
  assert.ok(!near(nb, SQUARE, GAP), 'and the plain gap from the square');
});

test('the rules phase asks for thin growth and gives room only when a standing block re-plans', () => {
  const P = { v: 1, seed: 7, blocks: {}, lots: {} };
  rebuild(input([['solo', 2, 0]]), P);
  const calls = [];
  const spy = { ...fantasy, hooks: { ...fantasy.hooks, planSettlement: (req, ctx) => { calls.push(req); return fantasy.hooks.planSettlement(req, ctx); } } };
  runRules(input([['solo', 2, 0]]), P, spy, { now: NOW, seed: 7 });   // nothing changed: thin, no room
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].grow, {});
  runRules(input([['solo', 30, 30]]), P, spy, { now: NOW, seed: 7 });  // a tier-up: room in every corner
  const room = calls[1].grow.room;
  for (const c of ['se', 'sw', 'ne', 'nw']) assert.ok(Array.isArray(room[c]) && room[c].length > 1 && room[c].every(Number.isInteger), c);
  assert.deepEqual(structuredClone(calls[1]), calls[1], 'the request is plain data');
});

// The measured bound (tools/engine/shift-rate.mjs, M7 P5): most nested re-plans keep the block where it stood.
// Before M7 every tier-up shifted the town (100%); after: busy ~30% of tier-ups, stress ~43%.
test('shift-rate bound: on the busy and stress histories, fewer than half of the tier-ups move a block', () => {
  for (const f of ['busy', 'stress']) {
    const fx = JSON.parse(fs.readFileSync(new URL(`../e2e/fixtures/engine/${f}.json`, import.meta.url), 'utf8'));
    const r = engineRate(fx);
    assert.ok(r.tierUps >= 25, `${f}: the history has tier-ups (${r.tierUps})`);
    assert.ok(r.tierUpRate < 0.5, `${f}: ${r.tierUpsShifted}/${r.tierUps} tier-ups shifted`);
    assert.ok(r.eventRate < 0.35, `${f}: ${r.shifted}/${r.events} nested re-plans shifted`);
  }
});
