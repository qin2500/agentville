import './support/ensure-mods-index.mjs';
// agentville.fantasy rule hooks (mods/agentville.fantasy/rules.js) reproduce classic world.js plan() over WorldInput,
// and persistence is per mod (village-mods.md §3.4, §6.1.3, §6.1.6). Pure, node only, fake store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { default: fantasyDefault } = await import('../mods/agentville.fantasy/index.js');
const { RULES, HOOKS, ACCENT, RESTING_HOMES, PR_LIVE_CAP, PR_DONE_CAP, tierWithHysteresis } = await import('../mods/agentville.fantasy/rules.js');
const { tierFor, capacityFor, planSettlement } = await import('../web/src/city-plan.js');
const { styleFor: poolStyle } = await import('../web/src/styles-pool.js');
const { hash, streamFor } = await import('../web/src/engine/core/rng.js');
const { planSettlements, placeBlocks } = await import('../web/src/engine/world/sites.js');
const { SEED_KEY, loadWorld, saveWorld, worldKey, modKey, emptyWorld } = await import('../web/src/engine/world/persist.js');
const KEY = 'va.engine2.world', DEMO_KEY = 'va.engine2.world.demo';   // fantasy's PersistDecl key / demoKey

const NOW = 1_800_000_000_000;
const MOD = { ...fantasyDefault, hooks: HOOKS };
const ctx = (o = {}) => ({ rng: s => streamFor(1, MOD.id, 'p', s), hash, time: { now: NOW }, forcedTier: null, forcedStyle: null, parent: null, ...o });
const agent = (id, o = {}) => ({ id, name: id, project: 'p', parent: o.parent ?? null, status: o.status ?? 'working', needs: null,
  role: o.role ?? 'worker', crown: o.role === 'boss', important: !!o.important, stopped: false, harness: 'claude', since: 0,
  lastActive: o.lastActive ?? 0, prs: [] });
const pr = (n, live) => ({ id: `p#${n}`, project: 'p', number: n, title: '', state: live ? 'building' : 'merged',
  checks: { passed: 0, failed: 0, pending: 0 }, review: null, size: { additions: 0, deletions: 0, files: 0 } });
const project = stats => ({ key: 'p', name: 'p', accent: '', stats: { prsEver: 0, prsLive: 0, agentsEver: 0, agentsNow: 0, transcriptMB: 0, ...stats } });
const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  const writes = [];
  return { m, writes, get: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => { writes.push(k); m.set(k, JSON.stringify(v)); } };
};

test('RULES: the classic layout constants and hold', () => {
  assert.deepEqual(RULES.layout.square, { x: -4, y: -3, w: 9, h: 5 });
  assert.equal(RULES.layout.gap, 2);
  assert.deepEqual(RULES.layout.accents, ACCENT);
  assert.equal(ACCENT.length, 8);
  assert.equal(RULES.layout.searchX, 120); assert.equal(RULES.layout.searchY, 90);
  assert.equal(RULES.layout.aspect, 1.25);
  assert.equal(RULES.layout.reserveMs, 14 * 864e5);
  assert.equal(RULES.holdMs, 864e5 / 2);
  assert.equal(RULES.crownModel, 'palace');
  assert.deepEqual([RESTING_HOMES, PR_LIVE_CAP, PR_DONE_CAP], [2, 6, 3]);
  assert.equal(fantasyDefault.id, 'agentville.fantasy');
  assert.deepEqual(fantasyDefault.persist.import, ['va.world9', 'va.world8']);
  assert.equal(fantasyDefault.rules, RULES);
  for (const [k, f] of Object.entries(HOOKS)) assert.equal(fantasyDefault.hooks[k], f, k); // plus the mod's own layout/scatter hooks
  assert.equal(typeof fantasyDefault.hooks.scatter, 'function');
  assert.equal(typeof fantasyDefault.hooks.layout, 'function');
});

test('growth: 3·prsEver + agentsEver (agentsNow when 0) + ⌊log2(MB+1)⌋', () => {
  assert.equal(HOOKS.growth(project({ prsEver: 13, agentsEver: 4, agentsNow: 1, transcriptMB: 7 })), 3 * 13 + 4 + 3);
  assert.equal(HOOKS.growth(project({ agentsNow: 9 })), 9);
  assert.equal(HOOKS.growth(project({ prsEver: 2, agentsEver: 30, transcriptMB: 3 })), 6 + 30 + 2);
  assert.equal(HOOKS.growth({}), 0);
});

test('tier: tierFor with 60% hysteresis; ctx.forcedTier wins (clamped)', () => {
  for (const g of [0, 5, 11, 12, 39, 40, 199, 200, 5000]) assert.equal(HOOKS.tier(g, null, ctx()), tierFor(g));
  assert.equal(HOOKS.tier(30, 2, ctx()), 2);    // 30 >= 0.6 * 40
  assert.equal(HOOKS.tier(20, 2, ctx()), 1);    // drops
  assert.equal(HOOKS.tier(50, 1, ctx()), 2);    // rises at once
  assert.equal(HOOKS.tier(130, 3, ctx()), 3);   // 130 >= 0.6 * 200
  assert.equal(HOOKS.tier(100, 3, ctx()), 2);
  assert.equal(HOOKS.tier(30, 2, ctx()), tierWithHysteresis(30, 2));
  assert.equal(HOOKS.tier(500, 3, ctx({ forcedTier: 0 })), 0);
  assert.equal(HOOKS.tier(0, null, ctx({ forcedTier: 9 })), 3);
  assert.equal(HOOKS.tier(0, null, ctx({ forcedTier: -2 })), 0);
  assert.equal(HOOKS.tier(50, null, ctx({ forcedTier: NaN })), 2);
});

test('capacity and planSettlement are city-plan', () => {
  for (const t of [0, 1, 2, 3]) for (const n of [0, 1, 5, 17, 40]) assert.equal(HOOKS.capacity(t, n, ctx()), capacityFor(t, n));
  const req = { tier: 1, seed: hash('x'), lots: capacityFor(1, 5), crowns: 1 };
  assert.deepEqual(HOOKS.planSettlement(req, ctx()), planSettlement(req));
});

test('lots: who has a home, resting cap, ranks, Important', () => {
  const t = NOW;
  const agents = [
    agent('boss', { role: 'boss', status: 'waiting' }),
    agent('lead', { role: 'lead', parent: 'boss' }),
    agent('sub', { role: 'sub', parent: 'boss' }),                  // parent present: no home
    agent('orphan', { role: 'sub' }),                                // parent gone: home
    agent('imp', { role: 'sub', parent: 'boss', important: true }),  // Important: home, rank L
    agent('r1', { status: 'resting', lastActive: t - 1000 }),
    agent('r2', { status: 'resting', lastActive: t - 3000 }),
    agent('r3', { status: 'resting', lastActive: t - 2000 }),
    agent('rImp', { status: 'resting', important: true, lastActive: t - 9e6 }), // not resting for the cap
    agent('rSub', { role: 'sub', parent: 'boss', status: 'resting', lastActive: t }), // no home at all
  ];
  const req = HOOKS.lots(project({}), agents, [], ctx());
  assert.deepEqual(req.map(r => [r.item, r.rank]), [
    ['home:boss', 'L'], ['home:lead', 'M'], ['home:orphan', 'S'], ['home:imp', 'L'], ['home:rImp', 'L'], ['home:r1', 'S'], ['home:r3', 'S'],
  ]);
  for (const r of req) { assert.equal(r.owner, 'home'); assert.equal(r.item, `home:${r.agent}`); }
});

test('lots: PR caps (6 live, 3 done, newest first), PR rank S, building = live', () => {
  const prs = [...Array(8)].map((_, i) => pr(100 + i, true)).concat([...Array(5)].map((_, i) => pr(10 + i, false)));
  const req = HOOKS.lots(project({}), [agent('a')], prs, ctx()).filter(r => r.owner === 'pr');
  assert.deepEqual(req.map(r => r.item), [107, 106, 105, 104, 103, 102, 14, 13, 12].map(n => `pr:p#${n}`));
  assert.deepEqual(req.map(r => r.building), [true, true, true, true, true, true, false, false, false]);
  assert.ok(req.every(r => r.rank === 'S' && r.pr === r.item.slice(3)));
});

test('crowns: bosses with homes, clamped 1..3', () => {
  assert.equal(HOOKS.crowns(project({}), [], ctx()), 1);
  assert.equal(HOOKS.crowns(project({}), [agent('w')], ctx()), 1);
  assert.equal(HOOKS.crowns(project({}), [agent('a', { role: 'boss' }), agent('b', { role: 'boss' })], ctx()), 2);
  assert.equal(HOOKS.crowns(project({}), 'abcde'.split('').map(i => agent(i, { role: 'boss' })), ctx()), 3);
  // resting bosses past the resting-home cap have no home, so no crown
  const resting = 'abcd'.split('').map((i, k) => agent(i, { role: 'boss', status: 'resting', lastActive: k }));
  assert.equal(HOOKS.crowns(project({}), resting, ctx()), 2);
});

test('style: styles-pool per key; forcedStyle, else the preset family', () => {
  assert.deepEqual(HOOKS.style('alpha', ctx()), poolStyle('alpha'));
  assert.deepEqual(HOOKS.style('alpha', ctx(), { family: 3 }), poolStyle('alpha', { family: 3 }));
  assert.deepEqual(HOOKS.style('alpha', ctx({ forcedStyle: 8 }), { family: 3 }), poolStyle('alpha', { family: 2 }));
  assert.deepEqual(HOOKS.style('alpha', ctx({ forcedStyle: -1 })), poolStyle('alpha', { family: 5 }));
  assert.equal(HOOKS.style('alpha', ctx()).key, HOOKS.style('alpha', ctx()).key);
});

test('rules.js is pure: no clock, no global RNG, no DOM or storage, no engine internals', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../mods/agentville.fantasy/rules.js', import.meta.url), 'utf8');
  for (const bad of ['Math.random', 'Date.now', 'new Date', 'performance.', 'localStorage', 'document.', 'window.']) {
    assert.ok(!src.includes(bad), `rules.js: ${bad}`);
  }
  const imports = src.split('\n').filter(l => /^import /.test(l));
  assert.ok(imports.every(l => !l.includes('web/src/engine/') || l.includes('engine/mod/api.js')), 'rules.js imports engine internals');
});

// ---------------- persistence per mod ----------------
const OTHER = { id: 'test.other' };
const world = tag => ({ v: 1, seed: 3, blocks: { [tag]: { x: 1, y: 2, w: 3, h: 4 } }, lots: {} });

test('persist: keys per mod; fantasy keeps va.engine2.world, others va.engine2.world.<modId>', () => {
  assert.equal(worldKey(undefined), KEY);
  assert.equal(worldKey(MOD), 'va.engine2.world');
  assert.equal(worldKey(MOD, { demo: true }), DEMO_KEY);
  assert.equal(worldKey(OTHER), 'va.engine2.world.test.other');
  assert.equal(worldKey(OTHER, { demo: true }), 'va.engine2.world.test.other.demo');
  assert.equal(modKey('agentville.fantasy'), 'va.engine2.world.agentville.fantasy');
  const s = fakeStore();
  saveWorld(s, world('f'), {});                       // no mod: fantasy
  saveWorld(s, world('o'), { mod: OTHER });
  saveWorld(s, world('od'), { mod: OTHER, demo: true });
  assert.deepEqual(s.writes, [KEY, 'va.engine2.world.test.other', 'va.engine2.world.test.other.demo']);
});

test('persist: fantasy reads va.engine2.world, then its per-mod alias, then classic; others never import classic', () => {
  const w8 = { blocks: { classic: { x: 9 } }, lots: {} };
  // own key wins
  assert.deepEqual(loadWorld(fakeStore({ [KEY]: world('legacy'), [modKey(MOD.id)]: world('alias'), 'va.world8': w8 }), { mod: MOD }).blocks, world('legacy').blocks);
  // alias when the legacy key is absent
  assert.deepEqual(loadWorld(fakeStore({ [modKey(MOD.id)]: world('alias'), 'va.world8': w8 }), { mod: MOD }).blocks, world('alias').blocks);
  assert.deepEqual(loadWorld(fakeStore({ [modKey(MOD.id, true)]: world('aliasDemo') }), { mod: MOD, demo: true }).blocks, world('aliasDemo').blocks);
  // classic import last (fantasy only, also with no mod given)
  assert.deepEqual(loadWorld(fakeStore({ 'va.world8': w8 }), { mod: MOD }).blocks, w8.blocks);
  assert.deepEqual(loadWorld(fakeStore({ 'va.world8': w8 })).blocks, w8.blocks);
  // another mod: never the classic layout, never fantasy's
  const s = fakeStore({ 'va.world8': w8, 'va.world9': w8, [KEY]: world('legacy'), [modKey(MOD.id)]: world('alias') });
  const o = loadWorld(s, { mod: OTHER, now: 5 });
  assert.deepEqual(o.blocks, {}); assert.deepEqual(o.lots, {});
  assert.ok(s.writes.every(k => k === SEED_KEY));
  // classic import comes only from a PersistDecl (C1: the classicImport flag is gone)
  assert.deepEqual(loadWorld(fakeStore({ 'va.world8': w8 }), { mod: { id: 'test.classic', classicImport: true } }).blocks, {});
});

test('two different mods never share a persisted layout', () => {
  const s = fakeStore();
  const input = { apiVersion: 1, now: NOW, seed: 1, prs: [], env: { night: 0, reduceMotion: false, zoom: 1 },
    projects: [{ key: 'p', name: 'p', accent: '', stats: { prsEver: 0, prsLive: 0, agentsEver: 3, agentsNow: 1, transcriptMB: 0 } }],
    agents: [agent('a', { role: 'boss' })] };
  // a second mod built on the fantasy hooks, with its own layout rules (a different square)
  // persist: null as the registry resolves it: a child never inherits fantasy's legacy keys (MOD-4e)
  const other = { ...MOD, id: 'test.other', persist: null, rules: { ...RULES, layout: { ...RULES.layout, square: { x: -10, y: -10, w: 4, h: 4 } } } };
  for (const m of [MOD, other]) {
    const P = loadWorld(s, { mod: m, now: NOW });
    assert.deepEqual(P.blocks, {}, `${m.id} starts empty`);
    const { settlements } = planSettlements(input, P, m, { now: NOW });
    placeBlocks(settlements, P, m, { now: NOW });
    saveWorld(s, P, { mod: m });
  }
  const f = loadWorld(s, { mod: MOD }), o = loadWorld(s, { mod: other });
  assert.ok(f.blocks.p && o.blocks.p);
  assert.notDeepEqual({ x: f.blocks.p.x, y: f.blocks.p.y }, { x: o.blocks.p.x, y: o.blocks.p.y });
  // switching back and forth never reshuffles either
  const before = JSON.stringify([f.blocks, o.blocks]);
  for (const m of [MOD, other, MOD]) {
    const P = loadWorld(s, { mod: m });
    const { settlements } = planSettlements(input, P, m, { now: NOW + 1000 });
    placeBlocks(settlements, P, m, { now: NOW + 1000 });
    saveWorld(s, P, { mod: m });
  }
  const strip = b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { x: v.x, y: v.y, w: v.w, h: v.h }]));
  const after = [loadWorld(s, { mod: MOD }).blocks, loadWorld(s, { mod: other }).blocks];
  assert.deepEqual(after.map(strip), JSON.parse(before).map(strip));
  assert.deepEqual(emptyWorld(0).blocks, {});
});
