import './support/ensure-mods-index.mjs';
// City cap (2026-11-17), the layout half: retiring a long-idle agent's home frees its lot (a green: garden, orchard or
// small plaza) and moves nothing else; freed lots are reused nearest the plaza first; a retired agent that wakes comes
// back as a new arrival; no cap = the world exactly as before. Pure, node only: no store, no real sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { runRules } = await import('../web/src/engine/world/rules-phase.js');
const { createRulesMemo } = await import('../web/src/engine/world/rules-memo.js');
const { capacityFor } = await import('../web/src/city-plan.js');
const { freeLot } = await import('../mods/agentville.fantasy/greens.js');
const { events } = await import('../mods/agentville.fantasy/events.js');
const { parseAt, resolveAt } = await import('../web/src/engine/render/event-fx.js');
const { cityCapOf, DEFAULT_CITY_CAP, CITY_CAP_KEY } = await import('../web/src/engine/world/prune.js');
const worlds = await import('../web/src/worlds.js');

const mod = resolveMod();
const DAY = 864e5, T0 = Date.UTC(2026, 10, 17, 12);
const P = 'keep';
const agent = (id, over = {}) => ({ id, name: id, project: P, parent: null, status: 'stalled', needs: null, role: 'worker', crown: false,
  important: false, stopped: false, harness: 'claude', since: T0 - 40 * DAY, lastActive: T0 - DAY, prs: [], ...over });
// 10 awake agents (protected: stalled) + 2 resting ones idle 30 and 20 days: 12 homes, cap 10
const base = () => [...Array.from({ length: 10 }, (_, i) => agent(`w${String(i).padStart(2, '0')}`)),
  agent('old30', { status: 'resting', lastActive: T0 - 30 * DAY }), agent('old20', { status: 'resting', lastActive: T0 - 20 * DAY })];
const inputOf = (agents, now) => ({ apiVersion: 1, now, seed: 7, agents, prs: [],
  projects: [{ key: P, name: P, accent: '', stats: { prsEver: 0, prsLive: 0, agentsEver: 14, agentsNow: agents.length, transcriptMB: 0 } }] });
const build = (agents, persisted, now, cityCap = 10) => buildWorld(inputOf(agents, now), persisted, { mod, now, seed: 7, cityCap });
const lotObjs = w => new Map([...w.objects.values()].filter(o => o.id.startsWith('lot:')).map(o => [o.id, o]));
// a town that stood before the cap was set (an existing install): every home already has its lot
const settled = () => { const p = { v: 1, seed: 7, blocks: {}, lots: {} }; build(base(), p, T0 - 5 * 60_000, null); return p; };
const homeOf = (w, id) => [...w.objects.values()].find(o => o.data?.owner === 'home' && o.data.agentId === id)?.id ?? null;

test('over the cap: the oldest idle home retires first, one a minute, and no other lot moves', () => {
  const persisted = settled();
  const w00 = build(base(), structuredClone(persisted), T0 - 4 * 60_000, null);
  const w0 = build(base(), persisted, T0);
  assert.deepEqual(w0.retired.map(r => r.project), [P]);
  assert.ok(persisted.retired[P].a.old30, 'the 30-day agent retired first');
  assert.equal(homeOf(w0, 'old30'), null);
  assert.ok(homeOf(w0, 'old20'), 'the 20-day agent keeps its home this minute');
  const freed = w0.retired[0].lot;
  assert.ok(!w0.objects.has(freed), 'the house is gone');
  assert.ok(w0.greens.has(freed), 'its lot is a green');
  assert.ok([...w0.objects.keys()].some(k => k.startsWith(`green:${freed.slice(4)}:`)), 'the green has props');

  // 30 s later: the rate holds the second retirement back
  const w1 = build(base(), persisted, T0 + 30_000);
  assert.equal(w1.retired.length, 0);
  assert.ok(homeOf(w1, 'old20'));
  // a minute later: the next oldest goes; every surviving lot is exactly where it was
  const w2 = build(base(), persisted, T0 + 61_000);
  assert.equal(w2.retired.length, 1);
  assert.equal(homeOf(w2, 'old20'), null);
  const before = lotObjs(w00), after = lotObjs(w2);
  for (const [id, o] of after) {
    const b = before.get(id);
    assert.ok(b, `${id} existed before`);
    assert.deepEqual([o.tx, o.ty, o.w, o.h, o.model], [b.tx, b.ty, b.w, b.h, b.model], `${id} did not move`);
  }
  const bk = v => [v.block.x, v.block.y, v.block.w, v.block.h];
  assert.deepEqual(bk(w2.villages[0]), bk(w00.villages[0]), 'the block did not move or resize');
  assert.ok(homeOf(w00, 'old30') === freed, 'the freed lot was old30\'s');
  for (const a of base().filter(a => a.status !== 'resting')) assert.equal(homeOf(w2, a.id), homeOf(w00, a.id), `${a.id} kept its home`);
  // at the cap now: a later build retires nobody
  const w3 = build(base(), persisted, T0 + 10 * 60_000);
  assert.equal(w3.retired.length, 0);
  assert.equal(Object.keys(persisted.retired[P].a).length, 2);
});

test('a newcomer takes the freed lot nearest the plaza first; the other stays a green', () => {
  const persisted = settled();
  build(base(), persisted, T0);
  const w = build(base(), persisted, T0 + 61_000);
  const order = w.villages[0].plan.lots.map(l => `lot:${P}:${l.id}`);
  const greens = [...w.greens.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  assert.equal(greens.length, 2, 'two freed lots');
  const lots = w.villages[0].plan.lots, rankOf = id => lots.find(l => `lot:${P}:${l.id}` === id).rank;
  // the newcomer asks for an S lot (a plain worker): the first free lot of its best rank in plan order (nearest the plaza)
  const free = order.filter(id => w.objects.get(id)?.data?.owner === 'house' || w.greens.has(id));
  // (assignLots' rank fallback for an S request is S, then M, then L)
  const want = ['S', 'M', 'L'].map(r => free.find(id => rankOf(id) === r)).find(Boolean);
  const w2 = build([...base(), agent('new', { status: 'working', lastActive: T0 + 62_000 })], persisted, T0 + 62_000);
  assert.equal(homeOf(w2, 'new'), want);
  assert.ok(!w2.greens.has(want), 'the green it took is a house again');
  for (const g of greens.filter(id => id !== want)) assert.ok(w2.greens.has(g), `${g} is still a green`);
  // and nothing else moved
  const a = lotObjs(w), b = lotObjs(w2);
  for (const [id, o] of a) if (b.has(id)) assert.deepEqual([b.get(id).tx, b.get(id).ty], [o.tx, o.ty]);
});

test('a retired agent that wakes comes back as a new arrival', () => {
  const persisted = { v: 1, seed: 7, blocks: {}, lots: {} };
  build(base(), persisted, T0);
  assert.ok(persisted.retired[P].a.old30);
  const woke = base().map(a => (a.id === 'old30' ? { ...a, lastActive: T0 + 5_000 } : a));
  const w = build(woke, persisted, T0 + 6_000);
  assert.ok(!persisted.retired[P]?.a?.old30, 'no longer retired');
  assert.ok(homeOf(w, 'old30'), 'it has a home again');
  // still retired across a "restart": a fresh rules memo over the same persisted state keeps old20 retired once it is
  const p2 = { v: 1, seed: 7, blocks: {}, lots: {} };
  build(base(), p2, T0); build(base(), p2, T0 + 61_000);
  const saved = JSON.parse(JSON.stringify(p2));
  const w2 = build(base(), saved, T0 + 2 * DAY);
  assert.equal(homeOf(w2, 'old30'), null);
  assert.equal(homeOf(w2, 'old20'), null);
});

test('switching the cap off brings every retired agent back', () => {
  const persisted = settled();
  build(base(), persisted, T0);
  assert.ok(persisted.retired[P].a.old30);
  const w = build(base(), persisted, T0 + 1000, 0);
  assert.ok(!persisted.retired[P]?.a?.old30);
  assert.ok(homeOf(w, 'old30'));
});

test('protected agents are never retired: the city stays over the cap', () => {
  const persisted = { v: 1, seed: 7, blocks: {}, lots: {} };
  const ag = base().map(a => (a.status === 'resting' ? { ...a, important: true } : a));
  const w = build(ag, persisted, T0);
  assert.equal(w.retired.length, 0);
  assert.equal(persisted.retired, undefined);
  assert.ok(homeOf(w, 'old30') && homeOf(w, 'old20'));
});

test('no cap: the world is exactly as before (no greens, nothing retired, same objects)', () => {
  const a = buildWorld(inputOf(base(), T0), { v: 1, seed: 7, blocks: {}, lots: {} }, { mod, now: T0, seed: 7 });
  const b = buildWorld(inputOf(base(), T0), { v: 1, seed: 7, blocks: {}, lots: {} }, { mod, now: T0, seed: 7, cityCap: 0 });
  assert.equal(a.greens.size, 0);
  assert.equal(a.retired.length, 0);
  assert.deepEqual([...a.objects.keys()], [...b.objects.keys()]);
});

test('the cap bounds the plan: a city never plans more lots than the bucket that holds the cap', () => {
  const many = Array.from({ length: 80 }, (_, i) => agent(`a${i}`, { status: 'working' }));
  const input = { ...inputOf(many, T0), projects: [{ key: P, name: P, accent: '', stats: { prsEver: 80, prsLive: 0, agentsEver: 300, agentsNow: 80, transcriptMB: 0 } }] };
  const R = runRules(input, {}, mod, { now: T0, seed: 7, cityCap: 40 }).projects[P];
  assert.equal(R.tier, 3);
  assert.equal(R.cap, capacityFor(3, 40));
  const free = runRules(input, {}, mod, { now: T0, seed: 7 }).projects[P];
  assert.ok(free.cap > R.cap, `uncapped ${free.cap} > capped ${R.cap}`);
  // a standing plan never shrinks: a block already at 83 lots keeps them (its outskirts turn green when free)
  const kept = runRules(input, { blocks: { [P]: { x: 0, y: 0, w: 1, h: 1, tier: 3, gt: 3, cap: 83 } } }, mod, { now: T0, seed: 7, cityCap: 40 }).projects[P];
  assert.equal(kept.cap, 83);
});

test('free lots past the cap are greens; lots inside it stay townsfolk houses', () => {
  const few = [agent('only', { status: 'working' })];
  const w = build(few, { v: 1, seed: 7, blocks: {}, lots: {} }, T0, 3);
  const lots = w.villages[0].plan.lots;
  assert.ok(lots.length > 3);
  lots.forEach((l, i) => {
    const id = `lot:${P}:${l.id}`;
    if (i < 3) assert.ok(w.objects.has(id), `${id} (index ${i}) stands`);
    else assert.ok(w.greens.has(id) && !w.objects.has(id), `${id} (index ${i}) is a green`);
  });
});

test('the rules memo re-judges an over-cap city every poll and keeps a city under it', () => {
  const memo = createRulesMemo(), persisted = { v: 1, seed: 7, blocks: {}, lots: {} };
  const input = inputOf(base(), T0), opts = t => ({ now: t, seed: 7, cityCap: 10, ctxFor: () => ({ time: { now: t } }) });
  const r1 = memo.run({ input, persisted, mod, opts: opts(T0) });
  assert.equal(r1.rules.projects[P].prune.add.length, 1);
  const r2 = memo.run({ input, persisted, mod, opts: opts(T0 + 1000) });
  assert.deepEqual(r2.ran, [P], 'over the cap: runs again');
});

test('freeLot is deterministic, stays inside the lot and uses known ground and props', () => {
  const kinds = new Set();
  for (let i = 0; i < 60; i++) for (const [w, h] of [[2, 3], [3, 3], [4, 3], [4, 4], [6, 8]]) {
    const id = `lot:p${i}:L${i}`, a = freeLot({ id, w, h }), b = freeLot({ id, w, h });
    assert.deepEqual(a, b);
    kinds.add(a.kind);
    assert.ok(mod.terrain.types.some(t => t.code === a.ground));
    for (const p of a.props) {
      assert.ok(mod.objects.props[p.kind], p.kind);
      assert.ok(p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h);
    }
  }
  assert.deepEqual([...kinds].sort(), ['garden', 'orchard', 'plaza']);
});

test('the retire cue: petals and dust where the home stood (obj: target)', () => {
  const specs = events([{ type: 'retire', project: P, lot: `lot:${P}:L3`, tick: 0 }], {});
  assert.equal(specs.length, 2);
  for (const s of specs) assert.deepEqual(parseAt(s.at), { type: 'obj', id: `lot:${P}:L3` });
  const world = { objects: new Map(), greens: new Map([[`lot:${P}:L3`, { tx: 4, ty: 6, w: 2, h: 4 }]]) };
  assert.deepEqual(resolveAt(parseAt(specs[0].at), { world }), { x: 5, y: 8 });
});

test('the setting: default 40, 0 = no cap, and the classic settings copy agrees with the engine', () => {
  const store = v => ({ get: (k, d) => (k === CITY_CAP_KEY && v !== undefined ? v : d) });
  assert.equal(cityCapOf(store()), 40);
  assert.equal(cityCapOf(store(25)), 25);
  assert.equal(cityCapOf(store(0)), null);
  assert.equal(cityCapOf(null), 40);
  assert.equal(worlds.CITY_CAP_KEY, CITY_CAP_KEY);
  assert.equal(worlds.CITY_CAP_DEFAULT, DEFAULT_CITY_CAP);
  assert.match(worlds.classicToggleHtml({ get: (k, d) => d }), /data-set="citycap" value="40"/);
});
