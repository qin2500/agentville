import './support/ensure-mods-index.mjs';
// M7 condition: saved layouts must not re-lay-out on the first load after the M7 deploy, for classic (va.world9)
// and the engine (va.engine2.world + va.engine2.seed). test/fixtures/engine-layout-m6.json was captured from the code
// users run today (commit recorded in the fixture: main 43689d3, before M7) for a busy village that grew through
// several tiers. Here the current code loads that saved state, including the plan-sync hydrate against an empty server
// (everything goes up, nothing comes back), and then rebuilds on polls: every building and prop stays on its tile
// and the stored keys are byte-identical afterwards. Fake localStorage and fake fetch only: no real storage or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.location = { search: '', href: 'http://x/' };
globalThis.window = globalThis;
const fx = JSON.parse(readFileSync(new URL('./fixtures/engine-layout-m6.json', import.meta.url), 'utf8'));

const { hydratePlan } = await import('../web/src/plan-sync.js');
const W = await import('../web/src/world.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadWorld, saveWorld } = await import('../web/src/engine/world/persist.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');

const fakeLs = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: k => void m.delete(k),
    key: i => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m };
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function emptyServer() {   // an empty world-plan server: GET lists nothing, a PUT at baseRev 0 stores the key
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    f.calls.push({ method, body: opts.body && JSON.parse(opts.body) });
    if (method === 'GET') return res(200, { v: 1, keys: f.keys });
    const { key, value, baseRev } = JSON.parse(opts.body);
    if ((f.keys[key]?.rev || 0) !== baseRev) return res(409, { rev: f.keys[key]?.rev || 0, value: f.keys[key]?.value });
    f.keys[key] = { rev: baseRev + 1, value };
    return res(200, { rev: baseRev + 1 });
  };
  f.calls = []; f.keys = {};
  return f;
}
const noSeen = text => text.replace(/"seen":\d+/g, '"seen":0');
const saved = () => ({ [fx.classic.storeKey]: fx.classic.stored, [fx.engine.storeKey]: fx.engine.stored, [fx.engine.seedKey]: fx.engine.seed });

test('the fixture records its source: main before M7, both layouts, tiers crossed', () => {
  assert.match(fx.source.commit, /^43689d3/);
  assert.ok(fx.classic.stored && fx.engine.stored && fx.engine.seed != null);
  assert.ok(fx.classic.tiers.length >= 2, `classic grew through tiers (${fx.classic.tiers})`);
  assert.ok(fx.engine.tiers.length >= 3, `engine grew through tiers (${fx.engine.tiers})`);
  assert.ok(fx.engine.objects.length > 500, 'a busy engine world');
});

test('the plan-sync hydrate against an empty server leaves every stored layout key byte-identical', async () => {
  const ls = fakeLs(saved());
  const f = emptyServer();
  const r = await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.equal(r.source, 'server');
  assert.deepEqual(r.migrated.sort(), Object.keys(saved()).sort(), 'all three keys went up');
  assert.deepEqual(r.adopted, []);
  for (const [k, v] of Object.entries(saved())) assert.equal(ls.getItem(k), v, `${k} untouched by the hydrate`);
});

test('classic: after the hydrate, loads and polls keep every tile and the stored va.world9 byte-identical', async () => {
  const ls = fakeLs(saved());
  await hydratePlan({ fetch: emptyServer(), ls, timeoutMs: 300 });
  globalThis.localStorage = ls;
  const byId = new Map(fx.classic.agents.map(a => [a.id, a]));
  const poll = now => {
    const P = W.plan(fx.classic.agents, byId, fx.classic.projects);
    return W.layout(P, now).items.map(i => [i.id, i.x, i.y, i.w, i.h]);
  };
  // `seen` is a last-seen clock that every poll refreshes, so byte identity is checked at the capture's own clock
  // (the last poll of the capture); later polls must keep the tiles and everything in the key but `seen`.
  for (let i = 0; i < 3; i++) assert.deepEqual(poll(1032), fx.classic.tilesFinal, `poll ${i}: every building and prop on its tile`);
  assert.equal(ls.getItem(fx.classic.storeKey), fx.classic.stored, 'va.world9 byte-identical');
  for (let i = 0; i < 3; i++) assert.deepEqual(poll(9_000_000 + i), fx.classic.tilesFinal, `later poll ${i}: tiles unchanged`);
  assert.equal(noSeen(ls.getItem(fx.classic.storeKey)), noSeen(fx.classic.stored), 'va.world9 unchanged but for `seen`');
});

test('engine: after the hydrate, loads and polls keep every building and prop tile and the stored keys byte-identical', async () => {
  const NOW = Date.UTC(2026, 10, 14, 12, 0, 0), SEED = 7;
  const ag = (id, project, o = {}) => ({ id, name: id, project, bucket: o.bucket ?? 'building', role: o.role, parentId: o.parent,
    severity: null, live: true, lastActivityAt: NOW - 60_000, since: NOW - 3_600_000, prs: o.prs ?? [], harness: 'claude-code' });
  // the capture's last step: { prs: 40, ever: 80, extraAgents: 24 }
  const agents = [ag('d-boss', 'demo-app', { role: 'boss', bucket: 'waiting', prs: [{ id: '101' }] })];
  for (let i = 0; i < 28; i++) agents.push(ag(`d-lead${i}`, 'demo-app', { role: 'lead', parent: 'd-boss' }));
  for (let i = 0; i < 4; i++) agents.push(ag(`d-solo${i}`, 'demo-app', { bucket: i % 2 ? 'building' : 'waiting' }));
  agents.push(ag('c-a', 'codex-app'), ag('c-b', 'codex-app', { bucket: 'waiting' }));
  const demoPrs = [{ id: '101', live: true }, { id: '99', live: false }];
  for (let i = 0; i < 40; i++) demoPrs.push({ id: String(500 + i), live: false });
  const src = { agents, projects: [{ name: 'demo-app', prs: demoPrs, agentsEver: 91, transcriptBytes: 4e6 }, { name: 'codex-app', prs: [], agentsEver: 2, transcriptBytes: 1e5 }] };

  const ls = fakeLs(saved());
  await hydratePlan({ fetch: emptyServer(), ls, timeoutMs: 300 });
  const store = { get: (k, d) => { const v = ls.getItem(k); return v == null ? d : JSON.parse(v); }, set: (k, v) => ls.setItem(k, JSON.stringify(v)) };
  const persisted = loadWorld(store, { now: fx.engine.lastNow, mod: fantasy });
  assert.equal(persisted.seed, SEED, 'the stored seed is kept');
  // Wild scatter (ids `tree:x,y`: the fantasy mod's forest belt and, since the countryside commits 315f485/b866786, its meadow,
  // lone trees, copses and wildflower decals) is cosmetic and never persisted: it is recomputed on every build, so the requested
  // countryside dressing redraws it once. It is excluded here; everything that IS persisted is still pinned: every building, lot,
  // venue, civic block and persisted prop (`prop:*`, incl. its trees and decals), plus the stored keys byte-for-byte below.
  const isWild = id => id.startsWith('tree:');
  const expectedObjects = fx.engine.objects.filter(o => !isWild(o[0]));
  assert.ok(expectedObjects.length > 400, 'the persisted part of the capture is still large');
  const objectsAt = now => {
    const { input, serverId } = toWorldInput(makeView(src, { now }), { seed: SEED, salt: 'nest' });
    const w = buildWorld(input, persisted, { mod: fantasy, now, seed: SEED, serverId });
    saveWorld(store, persisted, { mod: fantasy });
    return [...w.objects.values()].filter(o => ['building', 'prop', 'tree', 'decal'].includes(o.kind) && !isWild(o.id))
      .map(o => [o.id, o.kind, o.project ?? null, o.lot ?? null, o.model ?? null, o.variant ?? null, o.tx, o.ty]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  };
  // `seen` is a last-seen clock that every build refreshes, so byte identity is checked at the capture's own clock;
  // a build a minute later must keep every tile and everything in the key but `seen`.
  for (let i = 0; i < 3; i++) assert.deepEqual(objectsAt(fx.engine.lastNow), expectedObjects, `build ${i}: every building and prop tile unchanged`);
  assert.equal(ls.getItem(fx.engine.storeKey), fx.engine.stored, 'va.engine2.world byte-identical');
  for (let i = 0; i < 3; i++) assert.deepEqual(objectsAt(fx.engine.lastNow + 60_000 + i * 3000), expectedObjects, `a minute later, build ${i}: tiles unchanged`);
  assert.equal(noSeen(ls.getItem(fx.engine.storeKey)), noSeen(fx.engine.stored), 'va.engine2.world unchanged but for `seen`');
  assert.equal(ls.getItem(fx.engine.seedKey), fx.engine.seed, 'va.engine2.seed byte-identical');
});

// ---- B1 (M7 audit): a browser that only ever ran classic (va.world9, no engine key) loads the engine for the first
// time (M7 makes it the default). Classic stores a block's and a lot map's growth chain as `chain`, the engine reads `nest`;
// the import maps it, so the engine replays the very plan classic drew (classic links are untagged: the v1 full-ring rule)
// and nothing moves. Reference = what classic itself lays out from the same key; the engine must match it tile for tile.
const { footprintFor, originTile } = await import('../web/src/engine/world/footprints.js');
const { parseChain } = await import('../web/src/city-plan.js');
const ENGINE_NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const storeOf = ls => ({ get: (k, d) => { const v = ls.getItem(k); return v == null ? d : JSON.parse(v); }, set: (k, v) => ls.setItem(k, JSON.stringify(v)) });
const rect = b => [b.x, b.y, b.w, b.h];

// Classic's own layout of the va.world9 in `ls` at clock `clock` (run on a copy, so `ls` is not written).
function classicLayout(ls, agents, projects, clock) {
  const copyLs = fakeLs(Object.fromEntries(ls._m));
  globalThis.localStorage = copyLs;
  const P = W.plan(agents, new Map(agents.map(a => [a.id, a])), projects);
  const L = W.layout(P, clock);
  return { L, S: JSON.parse(copyLs.getItem('va.world9')) };
}
// The classic agents as the engine's snapshot sees them (all live, as classic drew them).
const engineAgents = agents => agents.map(a => ({ name: a.id, severity: null, live: true, lastActivityAt: ENGINE_NOW - 60_000,
  since: ENGINE_NOW - 3_600_000, harness: 'claude-code', parentId: a.parentId ?? a.parent, ...a }));

// Every block, lot, building and plan prop the engine builds from the import vs what classic laid out.
function assertEngineKeepsClassic(world, persisted, { L, S }) {
  const objs = world.objects;
  for (const [name, b] of Object.entries(S.blocks)) {
    assert.deepEqual(rect(persisted.blocks[name]), rect(b), `block ${name} keeps classic's rect`);
    assert.equal(persisted.blocks[name].nest, b.chain, `block ${name}: classic chain carried as nest`);
    assert.ok(parseChain(b.chain), `block ${name}: classic chain ${b.chain} is one the engine reads`);
    assert.equal(persisted.lots[name].nest, S.lots[name].chain, `lots ${name}: classic chain carried as nest`);
    // every item classic shows keeps its lot (one classic only holds, gone since its own clock, may lapse by the engine's)
    const shown = Object.fromEntries(Object.entries(S.lots[name].a).filter(([id]) => S.lots[name].h?.[id] == null));
    for (const [id, lot] of Object.entries(shown)) assert.equal(persisted.lots[name].a[id], lot, `lots ${name}: ${id} keeps ${lot}`);
  }
  let lotsSeen = 0, propsSeen = 0;
  for (const v of L.villages) {
    const bx = v.block.x, by = v.block.y;
    // every plan lot (occupied or a vacant house) and civic building on classic's tiles
    for (const l of v.plan.lots) {
      const o = objs.get(`lot:${v.name}:${l.id}`);
      assert.ok(o, `lot:${v.name}:${l.id} built`);
      assert.deepEqual([o.tx, o.ty, o.w, o.h], [bx + l.x, by + l.y, l.w, l.h], `lot ${v.name}:${l.id} on classic's tiles`);
      lotsSeen++;
    }
    // every plan prop where classic's plan put it (its foot point -> tile), unless the engine's own placement rules
    // nudged or dropped it, which it lints `from` that same tile
    const count = {}, lint = new Map();
    for (const l of world.lint) if (String(l.id).startsWith(`prop:${v.name}:`)) lint.set(l.id, l);
    for (const p of v.plan.props || []) {
      const i = count[p.kind] = (count[p.kind] ?? -1) + 1, id = `prop:${v.name}:${p.kind}:${i}`;
      const fp = footprintFor(p, fantasy.objects), t = originTile(p, fp || { walk: 'floor', w: 1, h: 1 });
      const at = [bx + t.tx, by + t.ty], li = lint.get(id);
      if (li?.from) assert.deepEqual(li.from, at, `${id}: ${li.reason}, from classic's tile`);
      if (fp?.walk === 'edge') {
        const segs = [...objs.values()].filter(o => o.id === id || o.id.startsWith(`${id}.`));
        const run = fp.run, along = run.dir === 'x' ? 'tx' : 'ty', across = run.dir === 'x' ? 'ty' : 'tx', k = run.dir === 'x' ? 0 : 1;
        for (const s of segs) {
          assert.equal(s[across], at[1 - k], `${id}: on classic's run line`);
          assert.ok(s[along] >= at[k] && s[along] + (run.dir === 'x' ? s.w : s.h) <= at[k] + run.len, `${id}: inside classic's run`);
        }
        if (!li) assert.deepEqual(segs.map(s => [s.tx, s.ty, s.w, s.h]), [[at[0], at[1], fp.w, fp.h]], `${id}: classic's whole run`);
      } else if (!li) {
        const o = objs.get(id);
        assert.ok(o, `${id} built`);
        assert.deepEqual([o.tx, o.ty], at, `${id} on classic's tile`);
      }
      propsSeen++;
    }
  }
  // nothing the classic plans do not have (every engine prop is one of classic's plan props, or a run segment of one)
  const planIds = new Set(L.villages.flatMap(v => { const c = {}; return (v.plan.props || []).map(p => `prop:${v.name}:${p.kind}:${c[p.kind] = (c[p.kind] ?? -1) + 1}`); }));
  const extra = [...objs.values()].filter(o => o.id.startsWith('prop:') && !planIds.has(o.id.replace(/\.\d+$/, ''))).map(o => o.id);
  assert.deepEqual(extra, [], 'no prop outside the classic plans');
  // every building classic drew (homes, PR houses, vacant houses, civics) on the same tiles
  for (const it of L.items) {
    const [kind, rest] = [it.id.slice(0, it.id.indexOf(':')), it.id.slice(it.id.indexOf(':') + 1)];
    const proj = it.village?.name;
    const lotId = kind === 'house' ? rest.slice(rest.lastIndexOf(':') + 1) : S.lots[proj]?.a[it.id];
    const o = objs.get(kind === 'civic' ? it.id : `lot:${proj}:${lotId}`);
    assert.ok(o, `${it.id} built`);
    assert.deepEqual([o.tx, o.ty, o.w, o.h], [it.x, it.y, it.w, it.h], `${it.id} on classic's tiles`);
  }
  assert.ok(lotsSeen > 30 && propsSeen > 100, `a real town (${lotsSeen} lots, ${propsSeen} props)`);
}

// Loads the engine on `ls` (no engine key yet) as the app does, builds a few times, returns what it built.
function engineFirstLoad(ls, agents, projects) {
  const store = storeOf(ls);
  const persisted = loadWorld(store, { now: ENGINE_NOW, mod: fantasy, adopt: true });
  // the import is kept on the engine's own key at once, renamed; classic's key is never written
  const kept = JSON.parse(ls.getItem('va.engine2.world'));
  assert.ok(kept, 'the imported world is persisted on the engine key at once');
  for (const rec of [...Object.values(kept.blocks), ...Object.values(kept.lots)]) assert.ok(!('chain' in rec) && typeof rec.nest === 'string', 'stored renamed');
  let world;
  for (let i = 0; i < 3; i++) {
    const now = ENGINE_NOW + i * 3000;
    const { input, serverId } = toWorldInput(makeView({ agents: engineAgents(agents), projects }, { now }), { seed: persisted.seed, salt: 'nest' });
    world = buildWorld(input, persisted, { mod: fantasy, now, seed: persisted.seed, serverId });
    saveWorld(store, persisted, { mod: fantasy });
  }
  return { world, persisted };
}

test('engine, classic-only browser (va.world9 alone, deployed main): the first engine load keeps every block, lot, building and prop', async () => {
  const ls = fakeLs({ [fx.classic.storeKey]: fx.classic.stored });
  await hydratePlan({ fetch: emptyServer(), ls, timeoutMs: 300 });
  const ref = classicLayout(ls, fx.classic.agents, fx.classic.projects, 1032);
  assert.deepEqual(ref.L.items.map(i => [i.id, i.x, i.y, i.w, i.h]), fx.classic.tilesFinal, 'the classic reference is the captured layout');
  const { world, persisted } = engineFirstLoad(ls, fx.classic.agents, fx.classic.projects);
  assertEngineKeepsClassic(world, persisted, ref);
  assert.equal(ls.getItem(fx.classic.storeKey), fx.classic.stored, 'va.world9 byte-identical after the engine import');
  // a reload reads the engine's own copy (not the import again) and still keeps every block
  const again = loadWorld(storeOf(ls), { now: ENGINE_NOW + 60_000, mod: fantasy, adopt: true });
  for (const [n, b] of Object.entries(ref.S.blocks)) assert.deepEqual(rect(again.blocks[n]), rect(b), `reload: ${n} in place`);
  // reverse: Settings -> Classic (or ?engine=1) still shows the old town, unchanged, and leaves va.world9 as it was
  globalThis.localStorage = ls;
  const byId = new Map(fx.classic.agents.map(a => [a.id, a]));
  for (let i = 0; i < 3; i++) {
    const P = W.plan(fx.classic.agents, byId, fx.classic.projects);
    assert.deepEqual(W.layout(P, 1032).items.map(t => [t.id, t.x, t.y, t.w, t.h]), fx.classic.tilesFinal, `classic poll ${i} after the engine ran: the old town`);
  }
  assert.equal(ls.getItem(fx.classic.storeKey), fx.classic.stored, 'va.world9 byte-identical after classic ran again');
});

test('engine, classic-only browser: a classic town grown through every tier (0 -> 1 -> 2 -> 3) keeps every tile on first engine load', async () => {
  const mk = (id, project, role = 'worker', parentId) => ({ id, project, role, parentId, bucket: 'active', status: 'working', prs: [] });
  const agents = [mk('g-boss', 'grown', 'boss'), mk('g-l1', 'grown', 'lead', 'g-boss'), mk('g-l2', 'grown', 'lead', 'g-boss'),
    mk('g-w1', 'grown', 'worker', 'g-l1'), mk('g-s1', 'grown'), mk('n-boss', 'near', 'boss'), mk('n-s1', 'near')];
  const prs = n => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), live: i % 5 === 0 }));
  const projects = n => [{ name: 'grown', prs: prs(n), agentsEver: 5 + n, transcriptBytes: 2e6 }, { name: 'near', prs: prs(2), agentsEver: 3, transcriptBytes: 1e5 }];
  const ls = fakeLs();
  globalThis.localStorage = ls;
  const byId = new Map(agents.map(a => [a.id, a]));
  const tiers = new Set();
  let n = 0, clock = 1000;
  for (; n <= 400 && !tiers.has(3); n += 2) {
    const P = W.plan(agents, byId, projects(n));
    W.layout(P, clock += 10);
    tiers.add(P.villages.find(v => v.name === 'grown').tier);
  }
  n -= 2;
  const S = JSON.parse(ls.getItem('va.world9'));
  assert.deepEqual([...tiers].sort(), [0, 1, 2, 3], `classic grew through every tier (${[...tiers]})`);
  assert.ok(S.blocks.grown.chain.split('>').length >= 3, `a nested chain across tiers (${S.blocks.grown.chain})`);
  const stored = ls.getItem('va.world9');
  const ref = classicLayout(ls, agents, projects(n), clock);
  const { world, persisted } = engineFirstLoad(ls, agents, projects(n));
  assertEngineKeepsClassic(world, persisted, ref);
  assert.equal(ls.getItem('va.world9'), stored, 'va.world9 byte-identical after the engine import');
});
