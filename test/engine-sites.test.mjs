import './support/ensure-mods-index.mjs';
// Engine v2 sites port (A3), MOD0 seams: planSettlements / placeBlocks + runLayout / stampLayout / persist over
// WorldInput and a ResolvedMod (the fantasy mod). Pure, node only, fake store. The fantasy rule hooks are tested in
// mod-fantasy-rules; the layout contract in mod-layout-contract, the fantasy layout's parity in mod-fantasy-layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { planSettlements, placeBlocks, planFor } = await import('../web/src/engine/world/sites.js');
const { runLayout, stampLayout } = await import('../web/src/engine/world/layout.js');
const { SEED_KEY, emptyWorld, loadWorld, saveWorld, loadSeed } = await import('../web/src/engine/world/persist.js');
const { ROAD } = await import('../web/src/engine/core/grid.js');
const { TERRAIN, GROUND_EXT, LOT_SQUARE, LOT_DOCK } = await import('./support/fantasy-codes.mjs');
const { SEA_MARGIN: FANTASY_SEA_MARGIN } = await import('../mods/agentville.fantasy/layout/index.js');
const { hash, streamFor } = await import('../web/src/engine/core/rng.js');
const { capacityFor, planSettlement } = await import('../web/src/city-plan.js');
const { default: fantasyDefault } = await import('../mods/agentville.fantasy/index.js');
const { HOOKS, RULES, tierWithHysteresis } = await import('../mods/agentville.fantasy/rules.js');

const MOD = { ...fantasyDefault, hooks: { ...HOOKS, layout: fantasyDefault.hooks.layout } };   // the rule hooks plus fantasy's layout
const KEY = 'va.engine2.world', DEMO_KEY = 'va.engine2.world.demo';   // fantasy's PersistDecl key / demoKey
const terrainAt = (sites, x, y) => {   // the class a layout gave tile (x, y): its tiles, else `outside`
  const T = sites.tiles;
  if (T && x >= T.ox && y >= T.oy && x < T.ox + T.w && y < T.oy + T.h) return T.terrain[(y - T.oy) * T.w + (x - T.ox)];
  return sites.outside ?? 0;
};
const { square: SQUARE, gap: GAP, accents: ACCENT, reserveMs: RESERVE_MS } = RULES.layout;
const HOLD_MS = RULES.holdMs;
const NOW = 1_800_000_000_000;
const DAY = 864e5;
const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  const writes = [];
  return { m, writes, get: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => { writes.push(k); m.set(k, JSON.stringify(v)); } };
};
const clone = o => JSON.parse(JSON.stringify(o));
const near = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// WorldInput built by hand (what engine/mod/input.js produces): status from the classic bucket, parent null when the
// server no longer has it, important = pinned, PR ids `<project>#<n>`, state 'building' = live.
const STATUS = { building: 'working', waiting: 'waiting', resting: 'resting' };
const agent = (id, project, o = {}) => ({ id, name: id, project, parent: o.parent ?? null, status: o.status ?? 'working', needs: null,
  role: o.role ?? 'worker', crown: o.role === 'boss', important: !!o.important, stopped: false, harness: 'claude',
  since: 0, lastActive: o.lastActive ?? 0, prs: o.prs ?? [] });
// A town of four projects: one boss each, some subs, a few PRs.
function agentsFor(spec, now = NOW) {
  const out = [];
  for (const [p, n] of spec) for (let i = 0; i < n; i++) {
    out.push(agent(`${p}-${i}`, p, { role: i === 0 ? 'boss' : 'sub', parent: i === 0 ? null : `${p}-0`,
      status: STATUS[i % 3 === 2 ? 'resting' : i % 2 ? 'building' : 'waiting'], lastActive: now - i * 60_000 }));
  }
  return out;
}
const SPEC = [['alpha', 6], ['beta', 3], ['gamma', 2], ['delta', 9]];
// classic project meta: { name, prs: [{ id, live }], agentsEver, transcriptBytes }
const PROJECTS = [{ name: 'alpha', prs: [{ id: 5, live: true }, { id: 4, live: false }], agentsEver: 30, transcriptBytes: 3e6 }];
function inputOf(agents, projects = PROJECTS, now = NOW) {
  const prs = [], P = [];
  for (const m of projects) {
    const list = m.prs || [];
    for (const p of list) prs.push({ id: `${m.name}#${p.id}`, project: m.name, number: +p.id, title: '', state: p.live ? 'building' : 'merged',
      checks: { passed: 0, failed: 0, pending: 0 }, review: null, size: { additions: 0, deletions: 0, files: 0 } });
    P.push({ key: m.name, name: m.name, accent: '', ...(m.preset ? { preset: m.preset } : {}), stats: { prsEver: list.length, prsLive: list.filter(p => p.live).length,
      agentsEver: m.agentsEver || 0, agentsNow: agents.filter(a => a.project === m.name).length, transcriptMB: (m.transcriptBytes || 0) / 1e6 } });
  }
  return { apiVersion: 1, now, seed: 1, agents, projects: P, prs, env: { night: 0, reduceMotion: false, zoom: 1 } };
}
const ctxFor = (now, forcedTier = null, forcedStyle = null) => key => ({ rng: s => streamFor(1, MOD.id, key, s), hash, time: { now }, forcedTier, forcedStyle, parent: null });
const plan = (input, P, opts = {}) => planSettlements(input, P, MOD, { now: input.now, ctxFor: ctxFor(input.now, opts.forcedTier ?? null), serverId: id => id, ...opts });
const run = (input, P, now = NOW, forcedTier = null) => {
  const pv = plan(input, P, { now, forcedTier });
  return { pv, sites: runLayout(placeBlocks(pv.settlements, P, MOD, { now }), MOD) };
};
/** Every tile of a layout's tiles rect as [x, y, i]. */
const tilesOf = sites => { const T = sites.tiles, out = []; for (let y = T.oy; y < T.oy + T.h; y++) for (let x = T.ox; x < T.ox + T.w; x++) out.push([x, y, (y - T.oy) * T.w + (x - T.ox)]); return out; };
/** Land tiles of a layout: terrain shore or grass (water is sea or deep sea). */
const landOf = sites => tilesOf(sites).filter(([, , i]) => sites.tiles.terrain[i] >= TERRAIN.SHORE);
const rectOf = b => ({ x: b.x, y: b.y, w: b.w, h: b.h });

// ---------------- planSettlements: the mechanics round the fantasy hooks ----------------
test('planSettlements: homes follow the mod (hasHome, resting cap, Important), busy is classic', () => {
  const t = NOW;
  const agents = [
    agent('boss', 'p', { role: 'boss', status: 'waiting' }),
    agent('lead', 'p', { role: 'lead', parent: 'boss' }),
    agent('sub', 'p', { role: 'sub', parent: 'boss' }),                 // parent present: no home
    agent('orphan', 'p', { role: 'sub', parent: null }),                // parent missing: home
    agent('imp', 'p', { role: 'sub', parent: 'boss', important: true }), // pinned: home
    agent('r1', 'p', { status: 'resting', lastActive: t - 1000 }),
    agent('r2', 'p', { status: 'resting', lastActive: t - 3000 }),
    agent('r3', 'p', { status: 'resting', lastActive: t - 2000 }),
    agent('rImp', 'p', { status: 'resting', important: true, lastActive: t - 9e6 }), // never capped away
  ];
  const { settlements: [v] } = plan(inputOf(agents, []), { blocks: {}, lots: {} });
  assert.deepEqual(v.homes.map(a => a.id), ['boss', 'lead', 'orphan', 'imp', 'rImp', 'r1', 'r3']);
  assert.deepEqual(v.homes[0], { id: 'boss', role: 'boss', crown: true, important: false });
  // busy = awake homes * 10 + every non-resting agent
  assert.equal(v.busy, 5 * 10 + 5);
  // growth: no PRs, agentsEver falls back to agents here
  assert.equal(v.growth, agents.length);
});

test('planSettlements: PR caps (6 live, 3 done, newest first) as requests', () => {
  const prs = [...Array(8)].map((_, i) => ({ id: 100 + i, live: true })).concat([...Array(5)].map((_, i) => ({ id: 10 + i, live: false })));
  const agents = [agent('a', 'p')];
  const { settlements: [v] } = plan(inputOf(agents, [{ name: 'p', prs, agentsEver: 4, transcriptBytes: 7e6 }]), { blocks: {}, lots: {} });
  assert.deepEqual(v.prs.map(p => p.id), ['107', '106', '105', '104', '103', '102', '14', '13', '12']);
  assert.deepEqual(v.requests.filter(r => r.owner === 'pr').map(r => r.item), ['107', '106', '105', '104', '103', '102', '14', '13', '12'].map(n => `pr:p#${n}`));
  assert.equal(v.growth, 3 * 13 + 4 + Math.floor(Math.log2(7 + 1)));
});

test('planSettlements: tier hysteresis (60%), forced tier, held lots and capacity that only grows', () => {
  assert.equal(tierWithHysteresis(30, 2), 2);   // 30 >= 0.6 * 40
  assert.equal(tierWithHysteresis(20, 2), 1);   // 20 < 24 drops to tierFor(20) = 1
  assert.equal(tierWithHysteresis(50, 1), 2);   // rises at once
  assert.equal(tierWithHysteresis(5, null), 0);
  const agents = [agent('a', 'p')];
  const proj = [{ name: 'p', prs: [], agentsEver: 30 }]; // growth 30
  const P = { blocks: { p: { x: 20, y: 20, w: 10, h: 10, tier: 2, gt: 2, cap: 99, acc: 0, seen: NOW } }, lots: {} };
  let [v] = plan(inputOf(agents, proj), P).settlements;
  assert.equal(v.gt, 2); assert.equal(v.tier, 2); assert.equal(v.cap, 99); // kept: same tier, bigger cap
  [v] = plan(inputOf(agents, proj), P, { forcedTier: 0 }).settlements;
  assert.equal(v.gt, 2); assert.equal(v.tier, 0); assert.equal(v.cap, capacityFor(0, 1)); // other tier: cap not carried
  // held lots: an item gone within HOLD_MS still needs its lot, an older one does not, other tiers don't count
  const L = { tier: 2, cap: 99, a: { 'home:a': 'L0', 'home:gone': 'S1', 'home:old': 'S2', 'pr:p#9': 'S3' },
    h: { 'home:gone': NOW - HOLD_MS + 1, 'home:old': NOW - HOLD_MS - 1 } };
  P.lots.p = L;
  [v] = plan(inputOf(agents, proj), P).settlements;
  assert.equal(v.need, 1 + 2); // a, gone (fresh), pr:p#9 (no h entry yet: counts as gone now)
  [v] = plan(inputOf(agents, proj), P, { forcedTier: 1 }).settlements;
  assert.equal(v.need, 1);
  // the hold comes from mod.rules.holdMs
  const short = { ...MOD, rules: { ...MOD.rules, holdMs: 0 } };
  [v] = planSettlements(inputOf(agents, proj), P, short, { now: NOW, ctxFor: ctxFor(NOW) }).settlements;
  assert.equal(v.need, 1 + 1); // only pr:p#9 (gone "now") is still within a zero hold
});

test('planSettlements: sig is classic (city4) JSON [[name, tier, cap, crowns, style.key]…, items]', () => {
  const agents = [
    agent('b', 'p', { role: 'boss', status: 'waiting' }), agent('l', 'p', { role: 'lead', parent: 'b', status: 'waiting' }),
    agent('s', 'p', { parent: null, status: 'waiting', important: true }),
  ];
  const { settlements, sig } = plan(inputOf(agents, [{ name: 'p', prs: [{ id: 3, live: true }, { id: 2 }] }]), { blocks: {}, lots: {} });
  const v = settlements[0];
  assert.equal(v.crowns, 1);
  assert.ok(v.style && typeof v.style.key === 'string');
  assert.equal(sig, JSON.stringify([[['p', v.tier, v.cap, 1, v.style.key]], ['home:b:L', 'home:l:M', 'home:s:L', 'pr:p#3:1', 'pr:p#2:0']]));
});

test('planSettlements: opaque agent ids map back to server ids in requests, homes and the sig; held lots match server keys', () => {
  const sid = { 'o-1': 'srv-boss', 'o-2': 'srv-lead' };
  const agents = [agent('o-1', 'p', { role: 'boss' }), agent('o-2', 'p', { role: 'lead', parent: 'o-1' })];
  const P = { blocks: {}, lots: { p: { tier: 0, cap: 3, a: { 'home:srv-boss': 'L0', 'home:srv-lead': 'M0' }, h: {} } } };
  const { settlements: [v], sig } = plan(inputOf(agents, []), P, { serverId: o => sid[o] });
  assert.deepEqual(v.requests.map(r => [r.item, r.agent, r.rank]), [['home:srv-boss', 'srv-boss', 'L'], ['home:srv-lead', 'srv-lead', 'M']]);
  assert.deepEqual(v.homes.map(h => h.id), ['srv-boss', 'srv-lead']);
  assert.equal(v.need, 2); // the persisted server keys are the same items: nothing counts as held
  assert.ok(!sig.includes('o-1') && sig.includes('home:srv-boss:L'));
});

// ---------------- placeBlocks + runLayout ----------------
test('placeBlocks + runLayout is deterministic: same inputs give deep-equal outputs and persisted state', () => {
  const a = run(inputOf(agentsFor(SPEC)), emptyWorld(1)), b = run(inputOf(agentsFor(SPEC)), emptyWorld(1));
  assert.deepEqual(a.pv, b.pv);
  assert.deepEqual(a.sites, b.sites);
  const P1 = emptyWorld(1), P2 = emptyWorld(1);
  run(inputOf(agentsFor(SPEC)), P1); run(inputOf(agentsFor(SPEC)), P2);
  assert.deepEqual(P1, P2);
});

test('placeBlocks: blocks keep GAP from each other and the square, accents differ for neighbours, SiteVillage shape', () => {
  const P = emptyWorld(1);
  const { sites } = run(inputOf(agentsFor(SPEC)), P);
  const blocks = sites.villages.map(v => v.block);
  for (const b of blocks) assert.ok(!near(b, SQUARE, GAP), 'block clear of the square');
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) assert.ok(!near(blocks[i], blocks[j], GAP));
  for (const [i, v] of sites.villages.entries()) {
    assert.equal(v.index, i);
    assert.equal(v.name, SPEC[i][0]);
    assert.deepEqual(v.origin, { x: v.block.x, y: v.block.y });
    assert.equal(v.block.w, v.plan.w); assert.equal(v.block.h, v.plan.h);
    assert.equal(v.accent, ACCENT[v.block.acc]);
    assert.deepEqual(v.plaza, { x: v.block.x + v.plan.plaza.x, y: v.block.y + v.plan.plaza.y, w: v.plan.plaza.w, h: v.plan.plaza.h });
    assert.equal(P.blocks[v.name], v.block); // the persisted object, as classic
    assert.equal(v.block.seen, NOW);
  }
  // bounds cover the whole island plus >= SEA_MARGIN tiles of sea
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of landOf(sites)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const B = sites.bounds;
  assert.ok(FANTASY_SEA_MARGIN >= 12);
  assert.ok(B.ox <= x0 - FANTASY_SEA_MARGIN && B.oy <= y0 - FANTASY_SEA_MARGIN && B.ox + B.w >= x1 + 1 + FANTASY_SEA_MARGIN && B.oy + B.h >= y1 + 1 + FANTASY_SEA_MARGIN);
  // the dock is classic dockSite in tiles (layoutData.dock), and the harbour venue site
  const town = sites.data.town;
  assert.equal('town' in sites, false, 'world.town is gone (C1): the town rect is the mod\'s layoutData');
  assert.deepEqual(sites.data.dock, { cx: 0, foot: town[3] + 5, sea: town[3] + 6, x0: -20, x1: 24 });
  assert.equal(sites.venues.dock.kind, 'harbour');
  assert.deepEqual(sites.venues.dock.anchor, { tx: 0, ty: town[3] + 5 });
  assert.deepEqual(sites.focus, { ox: town[0] - 1, oy: town[1] - 1, w: town[2] - town[0] + 3, h: town[3] - town[1] + 3 });
  // every block's ring road is on land, and an A* road reaches the square
  const T = sites.tiles, at = (L, x, y) => T[L][(y - T.oy) * T.w + (x - T.ox)];
  for (const v of sites.villages) {
    const b = v.block;
    for (let i = b.x - 1; i <= b.x + b.w; i++) for (const y of [b.y - 1, b.y + b.h]) assert.ok(at('terrain', i, y) >= TERRAIN.SHORE);
  }
  const inSq = (x, y) => x >= SQUARE.x && x < SQUARE.x + SQUARE.w && y >= SQUARE.y && y < SQUARE.y + SQUARE.h;
  assert.ok(tilesOf(sites).some(([x, y, i]) => T.road[i] === ROAD.LANE && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => inSq(x + a, y + b))));
});

test('placeBlocks requires now', () => {
  assert.throws(() => placeBlocks([], emptyWorld(1), MOD, {}), TypeError);
});

test('the deprecated sites.js names are gone (C1); runLayout needs a layout hook', async () => {
  const S = await import('../web/src/engine/world/sites.js');
  for (const gone of ['planSites', 'stampSites', 'terrainAt', 'SEA_MARGIN', 'noise']) assert.equal(S[gone], undefined, gone);
  const pv = plan(inputOf(agentsFor(SPEC)), emptyWorld(1));
  const placed = placeBlocks(pv.settlements, emptyWorld(1), MOD, { now: NOW });
  assert.throws(() => runLayout(placed, { ...MOD, hooks: HOOKS }), /no hooks.layout/);
});

// growth for SPEC projects is < 12 (tier 0) without server PR history: everything is tier 0 for the import.
const IMPORT_PROJECTS = [];
// A real-shaped va.world8 written by classic: hand-placed blocks sized as classic's plans, tiers/caps as
// classic plan() computes them, lot maps, an older cap bucket kept within its tier, a hidden block still
// reserved, a long-gone `away` one, and fields from newer builds (crowns, style) that must pass through.
function classicWorld8(now = NOW) {
  const blocks = {}, lots = {};
  let x = -60;
  for (const [name, n] of SPEC) {
    const tier = 0, input = inputOf(agentsFor(SPEC), IMPORT_PROJECTS, now), need = plan(input, { blocks: {}, lots: {} }).settlements.find(v => v.name === name).need;
    const cap = name === 'beta' ? capacityFor(0, need + 5) : capacityFor(0, need); // beta grew earlier: its bigger bucket stays
    const p = planSettlement({ tier, seed: hash(name), lots: cap });
    blocks[name] = { x, y: 12, w: p.w, h: p.h, acc: Object.keys(blocks).length, tier, gt: tier, cap, seen: now - 3 * DAY, crowns: 1, style: { family: 2, key: 'f2' } };
    lots[name] = { cap, tier, a: { [`home:${name}-0`]: p.lots[0].id }, h: {} };
    x += p.w + 6;
    void n;
  }
  blocks.hidden = { x: -30, y: -40, w: 16, h: 18, acc: 5, tier: 0, gt: 0, cap: 3, seen: now - 2 * DAY };
  blocks.ancient = { x: 40, y: -40, w: 16, h: 18, acc: 6, tier: 0, gt: 0, cap: 3, seen: now - 90 * DAY, away: true };
  return { blocks, lots };
}

test('classic import (fantasy persist.import): va.world8 keeps every block where it was; classic keys are never written', () => {
  const w8 = classicWorld8();
  const store = fakeStore({ 'va.world8': w8 });
  const P = loadWorld(store, { now: NOW });
  assert.equal(P.v, 1);
  assert.equal(typeof P.seed, 'number');
  assert.deepEqual(P.blocks, w8.blocks); // deep copy, untouched
  assert.notEqual(P.blocks, w8.blocks);
  const { sites } = run(inputOf(agentsFor(SPEC), IMPORT_PROJECTS), P);
  for (const v of sites.villages) {
    assert.deepEqual(rectOf(v.block), rectOf(w8.blocks[v.name]), `${v.name} stayed put`);
    assert.equal(v.block.acc, w8.blocks[v.name].acc);
    assert.equal(v.cap, w8.blocks[v.name].cap);
    assert.deepEqual(v.block.crowns, 1); assert.deepEqual(v.block.style, { family: 2, key: 'f2' }); // pass through
  }
  assert.deepEqual(rectOf(P.blocks.hidden), rectOf(w8.blocks.hidden));
  assert.deepEqual(sites.parks.map(rectOf), [rectOf(w8.blocks.hidden)]); // reserved hidden block waits as park
  assert.equal(P.blocks.ancient.away, true);
  saveWorld(store, P);
  assert.ok(store.writes.every(k => k === KEY || k === SEED_KEY), `wrote only engine keys: ${store.writes}`);
  assert.deepEqual(store.get('va.world8'), w8);
});

test('classic import: prefers va.world9, demo reads the .demo keys, own key wins, empty otherwise', () => {
  const w8 = { blocks: { a: { x: 1 } }, lots: {} }, w9 = { blocks: { b: { x: 2, crowns: 2 } }, lots: {} };
  const seeded = init => ({ ...init, [SEED_KEY]: 7 });
  assert.deepEqual(loadWorld(fakeStore(seeded({ 'va.world8': w8, 'va.world9': w9 }))), { v: 1, seed: 7, blocks: w9.blocks, lots: {} });
  assert.deepEqual(loadWorld(fakeStore(seeded({ 'va.world8': w8 }))).blocks, w8.blocks);
  assert.deepEqual(loadWorld(fakeStore(seeded({ 'va.world8': w8 })), { demo: true }).blocks, {});
  assert.deepEqual(loadWorld(fakeStore(seeded({ 'va.world8.demo': w8 })), { demo: true }).blocks, w8.blocks);
  assert.deepEqual(loadWorld(fakeStore(seeded({ 'va.world8': { blocks: {} } }))).blocks, {}); // classic `saved` needs blocks and lots
  const own = { v: 1, seed: 3, blocks: { c: { x: 3 } }, lots: {} };
  assert.deepEqual(loadWorld(fakeStore({ [KEY]: own, 'va.world8': w8 })), own);
  assert.deepEqual(loadWorld(fakeStore({ [DEMO_KEY]: own, [KEY]: { blocks: {}, lots: {} } }), { demo: true }).blocks, own.blocks);
  const s = fakeStore();
  const e = loadWorld(s, { now: 5 });
  assert.deepEqual(e, emptyWorld(hash('va.engine2:5')));
  saveWorld(s, e, { demo: true });
  assert.deepEqual(s.writes, [SEED_KEY, DEMO_KEY]);
});

test('seed: stored once, deterministic, never Math.random', () => {
  const s = fakeStore();
  const a = loadSeed(s, { now: 123 });
  assert.equal(a, hash('va.engine2:123'));
  assert.equal(loadSeed(s, { now: 999 }), a); // stored: later calls keep it
  assert.equal(loadSeed(fakeStore()), hash('va.engine2'));
  assert.equal(loadSeed(fakeStore({ [SEED_KEY]: 42 })), 42);
});

test('20 polls with small changes never move an unchanged block', () => {
  const P = emptyWorld(1);
  let agents = agentsFor(SPEC), t = NOW;
  run(inputOf(agents, PROJECTS, t), P, t);
  for (let poll = 0; poll < 20; poll++) {
    t += 30_000;
    const before = clone(P.blocks);
    agents = agents.map((a, i) => ({ ...a, status: (i + poll) % 4 === 0 ? 'resting' : (i + poll) % 2 ? 'working' : 'waiting', lastActive: t - i * 1000 }));
    if (poll === 4) agents.push(agent('beta-x', 'beta', { role: 'sub', parent: 'beta-0' })); // a sub: no home
    if (poll === 9) agents = agents.filter(a => a.id !== 'delta-8');
    if (poll === 12) agents.push(...agentsFor([['epsilon', 2]], t));                                           // a newcomer
    const { pv } = run(inputOf(agents, PROJECTS, t), P, t);
    for (const v of pv.settlements) {
      const old = before[v.name];
      if (!old) continue;
      if (old.tier === v.tier && old.cap === v.cap) assert.deepEqual(rectOf(P.blocks[v.name]), rectOf(old), `poll ${poll}: ${v.name} moved`);
    }
    for (const n of Object.keys(before)) if (!pv.settlements.some(v => v.name === n)) assert.deepEqual(rectOf(P.blocks[n]), rectOf(before[n]));
  }
  assert.ok(P.blocks.epsilon, 'the newcomer got a block');
});

test('a tier change re-plans only that block (keeping its centre when it fits)', () => {
  const P = emptyWorld(1);
  const agents = agentsFor(SPEC);
  run(inputOf(agents), P);
  const before = clone(P.blocks);
  const grown = [...PROJECTS, { name: 'gamma', prs: [], agentsEver: 45 }]; // growth 45: tier 2
  const { sites } = run(inputOf(agents, grown, NOW + 60_000), P, NOW + 60_000);
  const g = sites.villages.find(v => v.name === 'gamma');
  assert.equal(g.tier, 2);
  assert.notEqual(before.gamma.tier, 2);
  assert.ok(g.block.w !== before.gamma.w || g.block.h !== before.gamma.h);
  for (const n of Object.keys(before)) if (n !== 'gamma') assert.deepEqual(rectOf(P.blocks[n]), rectOf(before[n]), `${n} moved`);
  // centre kept when it fits there (classic rule), else a fresh spot clear of everything
  const c = { x: before.gamma.x + Math.round((before.gamma.w - g.block.w) / 2), y: before.gamma.y + Math.round((before.gamma.h - g.block.h) / 2) };
  const others = [SQUARE, ...Object.keys(P.blocks).filter(n => n !== 'gamma').map(n => P.blocks[n])];
  if (!others.some(o => near({ ...c, w: g.block.w, h: g.block.h }, o, GAP))) assert.deepEqual({ x: g.block.x, y: g.block.y }, c);
  for (const o of others) assert.ok(!near(g.block, o, GAP));
});

test('reserve: a hidden block is held RESERVE_MS as a park, lapses, and its project keeps it on return if untaken', () => {
  const P = emptyWorld(1);
  const all = agentsFor(SPEC);
  run(inputOf(all), P);
  const gamma = clone(P.blocks.gamma);
  const without = all.filter(a => a.project !== 'gamma');
  // hidden but reserved: unchanged, shown as a park
  let { sites } = run(inputOf(without, PROJECTS, NOW + DAY), P, NOW + DAY);
  assert.deepEqual(rectOf(P.blocks.gamma), rectOf(gamma));
  assert.ok(sites.parks.includes(P.blocks.gamma));
  // lapsed: no longer a park; still not `away` until something needs that ground
  ({ sites } = run(inputOf(without, PROJECTS, NOW + RESERVE_MS + 2 * DAY), P, NOW + RESERVE_MS + 2 * DAY));
  assert.equal(sites.parks.length, 0);
  // gamma comes back after the reserve: it keeps its block if nothing took it
  ({ sites } = run(inputOf(all, PROJECTS, NOW + RESERVE_MS + 3 * DAY), P, NOW + RESERVE_MS + 3 * DAY));
  assert.deepEqual(rectOf(P.blocks.gamma), rectOf(gamma));
});

test('sites.js, layout.js and persist.js are pure: no Math.random, DOM or localStorage', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['sites.js', 'layout.js', 'persist.js']) {
    const src = readFileSync(new URL(`../web/src/engine/world/${f}`, import.meta.url), 'utf8');
    for (const bad of ['Math.random', 'localStorage', 'document.', 'window.', "world.js'"]) assert.ok(!src.includes(bad), `${f}: ${bad}`);
  }
  // MOD0: sites.js keeps only mechanics; the world rules come from the mod
  const sites = readFileSync(new URL('../web/src/engine/world/sites.js', import.meta.url), 'utf8');
  const imports = sites.split('\n').filter(l => /^import /.test(l)).join('\n');
  for (const bad of ['city-plan', 'styles-pool', 'important.js', 'mods/']) assert.ok(!imports.includes(bad), `sites.js imports ${bad}`);
  // MOD-READY: no world geometry is left in the engine's sites (it is the mod's hooks.layout)
  for (const gone of ['buildLand', 'buildRoads', 'dockSite', 'dockShore', 'geoFast', 'geoSlow', 'route', 'routeFast', 'stampRaster']) assert.ok(!new RegExp(`function ${gone}\\b`).test(sites), `sites.js still has ${gone}`);
});

test('planFor is the mod planner, memoised per mod id', () => {
  const cap = capacityFor(1, 5);
  const a = planFor(MOD, 1, hash('x'), cap);
  assert.equal(planFor(MOD, 1, hash('x'), cap), a);
  assert.deepEqual(a, planSettlement({ tier: 1, seed: hash('x'), lots: cap }));
  let calls = 0;
  const other = { ...MOD, id: 'test.other', hooks: { ...HOOKS, planSettlement: r => { calls++; return { ...planSettlement(r), other: true }; } } };
  const b = planFor(other, 1, hash('x'), cap);
  assert.equal(b.other, true); assert.equal(calls, 1); // another mod never reads fantasy's memo
  planFor(other, 1, hash('x'), cap); assert.equal(calls, 1);
  assert.equal(planFor(MOD, 1, hash('x'), cap), a);
});

// ---------------- stampLayout ----------------
function fakeGrid(r) {
  const n = r.w * r.h;
  return { ...r, version: 0, terrain: new Uint8Array(n), ground: new Uint8Array(n), road: new Uint8Array(n), lot: new Int32Array(n).fill(-1) };
}

test('stampLayout: terrain everywhere, square/ring/roads/dock ground and road class, block interiors left alone', () => {
  const P = emptyWorld(1);
  const { sites } = run(inputOf(agentsFor(SPEC), PROJECTS), P);
  const grid = fakeGrid(sites.bounds);
  stampLayout(grid, sites);
  assert.equal(grid.version, 1);
  const at = (L, x, y) => grid[L][(y - grid.oy) * grid.w + (x - grid.ox)];
  const counts = {};
  for (let i = 0; i < grid.terrain.length; i++) counts[grid.terrain[i]] = (counts[grid.terrain[i]] || 0) + 1;
  assert.ok(!counts[TERRAIN.FOREST_FLOOR], 'no forest floor (A4)');
  for (const t of [TERRAIN.SEA_DEEP, TERRAIN.SEA, TERRAIN.SHORE, TERRAIN.GRASS]) assert.ok(counts[t] > 0, `terrain ${t} present`);
  // the grid's edge is deep sea all round
  for (let x = grid.ox; x < grid.ox + grid.w; x++) { assert.equal(at('terrain', x, grid.oy), TERRAIN.SEA_DEEP); assert.equal(at('terrain', x, grid.oy + grid.h - 1), TERRAIN.SEA_DEEP); }
  for (let y = SQUARE.y; y < SQUARE.y + SQUARE.h; y++) for (let x = SQUARE.x; x < SQUARE.x + SQUARE.w; x++) {
    assert.equal(at('ground', x, y), GROUND_EXT.SQUARE); assert.equal(at('road', x, y), ROAD.MAIN); assert.equal(at('lot', x, y), LOT_SQUARE);
  }
  for (const v of sites.villages) {
    const b = v.block;
    for (let i = b.x - 1; i <= b.x + b.w; i++) for (const y of [b.y - 1, b.y + b.h]) { assert.equal(at('ground', i, y), GROUND_EXT.RING); assert.equal(at('road', i, y), ROAD.STREET); }
    for (let j = b.y; j < b.y + b.h; j++) for (let i = b.x; i < b.x + b.w; i++) {
      assert.equal(at('ground', i, j), 0); assert.equal(at('road', i, j), 0); assert.equal(at('lot', i, j), -1);
      assert.equal(at('terrain', i, j), terrainAt(sites, i, j));
    }
  }
  let lanes = 0, paths = 0, dock = 0, dockLot = 0;
  for (let i = 0; i < grid.road.length; i++) {
    if (grid.road[i] === ROAD.LANE) { lanes++; assert.equal(grid.ground[i], GROUND_EXT.ROAD); }
    if (grid.road[i] === ROAD.PATH) { paths++; assert.equal(grid.ground[i], GROUND_EXT.ROAD); }
    if (grid.ground[i] === GROUND_EXT.DOCK) { dock++; assert.equal(grid.lot[i], LOT_DOCK); assert.equal(grid.road[i], 0); }
    if (grid.lot[i] === LOT_DOCK) dockLot++;
  }
  assert.ok(lanes > 0 && paths > 0 && dock > 0 && dockLot >= dock);
  // the dock footpath runs from the town's south edge down to the waterfront
  const D = sites.data.dock;
  for (let y = sites.data.town[3] + 1; y <= D.foot; y++) assert.ok(at('road', D.cx, y) >= ROAD.PATH);
  // the stamped terrain is the layout's, and the grid corner is deep sea
  for (const [x, y] of landOf(sites).slice(0, 500)) assert.ok(at('terrain', x, y) >= TERRAIN.SHORE);
  assert.equal(at('terrain', grid.ox, grid.oy), TERRAIN.SEA_DEEP);
});
