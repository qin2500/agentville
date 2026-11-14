import './support/ensure-mods-index.mjs';
// MOD1 M1c (review B3): the rules phase. Written from the seam in the Wave B brief:
//   runRules(input, persisted, mod, { now, seed, forcedTier, forcedStyle }) -> { projects: { [key]: { growth, tier, cap, crowns,
//   style, lots, plan } } } — plain structured-clonable data, every hook once per project per rebuild;
//   planSettlements(input, persisted, mod, opts, rules) and buildWorld(input, persisted, { ..., rules }) consume it;
//   planSettlement requests gain ranks: { L, M, S }; layout fields have no engine fallback.
// Synthetic data only (e2e/fixtures/engine/*.json through the snapshot adapter).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { runRules } = await import('../web/src/engine/world/rules-phase.js');
const { planSettlements, layoutOf } = await import('../web/src/engine/world/sites.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod, modCtx } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

const SEED = 7;
const fresh = () => ({ v: 1, seed: SEED, blocks: {}, lots: {} });
const inputFor = name => {
  const fx = loadFixture(`${name}.json`);
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: SEED, salt: String(SEED), env: { reduceMotion: false, zoom: 1 } });
  return { input, serverId, now: fx.now };
};
const HOOKS = ['growth', 'tier', 'capacity', 'lots', 'crowns', 'style', 'planSettlement'];
let spyN = 0;
/** A copy of a bundled mod whose hooks count calls per (hook, project). Fresh functions: no planner memo is shared. */
function spyMod(id = 'agentville.fantasy') {
  const base = resolveMod(id), calls = new Map(), reqs = [];
  const bump = (h, p) => { const k = `${h}|${p}`; calls.set(k, (calls.get(k) || 0) + 1); };
  const hooks = {
    ...base.hooks,
    growth: (project, ctx) => { bump('growth', project.key); return base.hooks.growth(project, ctx); },
    tier: (g, prev, ctx) => { bump('tier', ctx.__key); return base.hooks.tier(g, prev, ctx); },
    capacity: (t, need, ctx) => { bump('capacity', ctx.__key); return base.hooks.capacity(t, need, ctx); },
    lots: (project, a, p, ctx) => { bump('lots', project.key); return base.hooks.lots(project, a, p, ctx); },
    crowns: (project, a, ctx) => { bump('crowns', project.key); return base.hooks.crowns(project, a, ctx); },
    style: (key, ctx, preset) => { bump('style', key); return base.hooks.style(key, ctx, preset); },
    planSettlement: (req, ctx) => { bump('planSettlement', ctx.__key); reqs.push(req); return base.hooks.planSettlement(req, ctx); },
  };
  return { mod: { ...base, id: `${base.id}.spy${++spyN}`, hooks }, calls, reqs };
}
// ctx tagged with its project, so per-project counts work for hooks that do not get the project
const taggedCtx = (mod, now, extra = {}) => key => ({ ...modCtx(mod, { seed: SEED, now, projectKey: key, ...extra }), __key: key });

const h = x => createHash('sha256').update(typeof x === 'string' ? x : Buffer.from(x.buffer, x.byteOffset, x.byteLength)).digest('hex').slice(0, 16);
function fingerprint(w) {
  const g = w.grid, layers = Object.keys(g).filter(k => ArrayBuffer.isView(g[k])).sort();
  return { sig: h(w.sig), objects: h(JSON.stringify([...w.objects.values()].map(o => JSON.stringify(o)).sort())), lint: h(JSON.stringify(w.lint)),
    grid: Object.fromEntries(layers.map(k => [k, h(g[k])])) };
}
/** Two rebuilds on one persisted state (the second reads what the first saved), as the app does. */
function twoPass(name, mod, withRules) {
  const { input, serverId, now } = inputFor(name), P = fresh();
  let w;
  for (let pass = 0; pass < 2; pass++) {
    const t = now + pass * 1000;
    const opts = { mod, now: t, seed: SEED, serverId };
    if (withRules) opts.rules = runRules(input, P, mod, { now: t, seed: SEED, serverId, ctxFor: key => modCtx(mod, { seed: SEED, now: t, projectKey: key }) });
    w = buildWorld(input, P, opts);
  }
  return w;
}

// Golden fingerprints of engine 554bbbf (before the split), re-pinned after m1g's stateless scatter (only wild-scatter objects/occ/cost changed; sig, lint and the other layers are as at 554bbbf), fantasy mod, WorldInput path, seed 7, two passes. Re-pinned after the harbour art (venue plan emits pier, bollard and skiff objects): only objects and occ changed.
const GOLDEN = {
  citydemo: { sig: '1052876b2985324b', objects: 'ab61d04c50c905e4', lint: '402568c1d9c59f5d', grid: { cost: '65b147c4d6b64c05', cover: 'ee5e0790ce9afa21',
    edges: '2f7697d7505ce49a', ground: '5eb21dfe9b69ca69', lot: 'd2a184597bb41229', occ: '01cb11a86d7ce21d', road: '1e255e6655bd7a28', slots: '599aac33df4b3572', terrain: 'd903f0b7631f9e12' } },
  busy: { sig: 'd236d5bbe28b2e4f', objects: '4b9772ad70a8e1d7', lint: '6cc0e0250ce0a055', grid: { cost: '63780a3c14534042', cover: '28ff20eb0ac20b74',
    edges: '656731783cd6f486', ground: '0d2da4b7f5ac9243', lot: 'aed12d6ba4bf5e27', occ: 'd9c01a5ff5b2ffbb', road: '4bb2bb926ca4f69a', slots: '26acd9d92d3d54c8', terrain: '10dfc77920835b47' } },
};

for (const name of ['citydemo', 'busy']) {
  test(`world output is identical to 554bbbf (fantasy, ${name}): objects, lint and every grid layer`, () => {
    const mod = resolveMod('agentville.fantasy');
    assert.deepEqual(fingerprint(twoPass(name, mod, false)), GOLDEN[name]);
    assert.deepEqual(fingerprint(twoPass(name, mod, true)), GOLDEN[name], 'precomputed rules give the same world');
  });
}

test('runRules returns plain structured-clonable data with the seam fields, for both bundled mods', () => {
  for (const id of ['agentville.fantasy', 'agentville.base']) for (const name of ['citydemo', 'busy']) {
    const mod = resolveMod(id), { input, serverId, now } = inputFor(name);
    const r = runRules(input, fresh(), mod, { now, seed: SEED, serverId });
    const keys = Object.keys(r.projects);
    assert.deepEqual(keys.sort(), [...new Set(input.agents.map(a => a.project || '—'))].sort(), `${id}/${name}: one entry per project`);
    for (const k of keys) {
      const p = r.projects[k];
      for (const f of ['growth', 'tier', 'cap', 'crowns', 'style', 'lots', 'plan']) assert.ok(f in p, `${id}/${name}/${k}: ${f}`);
      assert.ok(Array.isArray(p.lots));
      assert.ok(p.cap >= 0 && Number.isFinite(p.cap));
    }
    const c = structuredClone(r);   // throws on functions, class instances with private state, etc.
    assert.deepEqual(JSON.parse(JSON.stringify(c)), JSON.parse(JSON.stringify(r)));
    assert.deepEqual({ ...c.projects }, { ...r.projects });
  }
});

test('runRules never writes to persisted', () => {
  const mod = resolveMod('agentville.fantasy'), { input, serverId, now } = inputFor('busy');
  const P = fresh();
  buildWorld(input, P, { mod, now, seed: SEED, serverId });   // a realistic persisted state
  const before = JSON.stringify(P);
  runRules(input, P, mod, { now: now + 5000, seed: SEED, serverId });
  assert.equal(JSON.stringify(P), before);
});

test('buildWorld without rules computes them itself: every hook once per project', () => {
  for (const id of ['agentville.fantasy', 'agentville.base']) {
    const { mod, calls } = spyMod(id), { input, serverId, now } = inputFor('busy');
    const names = [...new Set(input.agents.map(a => a.project || '—'))];
    buildWorld(input, fresh(), { mod, now, seed: SEED, serverId });
    const total = hk => [...calls].filter(([k]) => k.startsWith(`${hk}|`)).reduce((a, [, v]) => a + v, 0);
    for (const hk of HOOKS) assert.equal(total(hk), names.length, `${id}: ${hk} total`);
    for (const hk of ['growth', 'lots', 'crowns', 'style']) for (const n of names) assert.equal(calls.get(`${hk}|${n}`), 1, `${id}: ${hk} for ${n}`);
  }
});

test('the app rebuild path (rules once, sig check, build) calls each hook once per project; consumers call none', () => {
  const { mod, calls } = spyMod(), { input, serverId, now } = inputFor('citydemo');
  const names = [...new Set(input.agents.map(a => a.project || '—'))];
  const P = fresh(), opts = { now, seed: SEED, serverId, ctxFor: taggedCtx(mod, now) };
  const rules = runRules(input, P, mod, opts);
  const before = new Map(calls);
  const pv = planSettlements(input, P, mod, opts, rules);
  assert.deepEqual(calls, before, 'planSettlements with rules calls no hook');
  const w = buildWorld(input, P, { mod, now, seed: SEED, serverId, rules });
  assert.equal(w.sig, pv.sig);
  for (const hk of HOOKS) for (const n of names) assert.equal(calls.get(`${hk}|${n}`), 1, `${hk} for ${n}`);
});

test('consumers given rules never reach the hooks (a mod whose hooks throw still builds)', () => {
  const real = resolveMod('agentville.fantasy'), { input, serverId, now } = inputFor('citydemo');
  const rules = runRules(input, fresh(), real, { now, seed: SEED, serverId });
  const boom = () => { throw new Error('hook called'); };
  const dead = { ...real, id: 'test.dead', hooks: { ...real.hooks, ...Object.fromEntries(HOOKS.map(k => [k, boom])) } };
  const P = fresh();
  const pv = planSettlements(input, P, dead, { now, seed: SEED, serverId }, rules);
  assert.ok(pv.settlements.length > 0);
  const w = buildWorld(input, P, { mod: dead, now, seed: SEED, serverId, rules });
  assert.ok(w.objects.size > 0);
});

test('a big town (stress fixture, many projects) still plans each project once', () => {
  const fx = loadFixture('stress.json');
  if (!fx) return;
  const { mod, calls } = spyMod(), { input, serverId, now } = inputFor('stress');
  const names = [...new Set(input.agents.map(a => a.project || '—'))];
  const rules = runRules(input, fresh(), mod, { now, seed: SEED, serverId, ctxFor: taggedCtx(mod, now) });
  buildWorld(input, fresh(), { mod, now, seed: SEED, serverId, rules });
  for (const n of names) assert.equal(calls.get(`planSettlement|${n}`), 1, `planSettlement for ${n} (of ${names.length})`);
});

test('a forced tier asks tier twice (unforced gt and forced tier) and nothing else more than once', () => {
  const { mod, calls } = spyMod(), { input, serverId, now } = inputFor('citydemo');
  const names = [...new Set(input.agents.map(a => a.project || '—'))];
  const r = runRules(input, fresh(), mod, { now, seed: SEED, serverId, forcedTier: 3, ctxFor: taggedCtx(mod, now, { forcedTier: 3 }) });
  for (const n of names) {
    assert.equal(calls.get(`tier|${n}`), 2);
    assert.equal(r.projects[n].tier, 3);
    for (const hk of HOOKS.filter(k => k !== 'tier')) assert.equal(calls.get(`${hk}|${n}`), 1, `${hk} for ${n}`);
  }
});

test('planSettlement requests carry ranks { L, M, S } = the validated lot requests per rank', () => {
  const { mod, reqs } = spyMod(), { input, serverId, now } = inputFor('busy');
  const r = runRules(input, fresh(), mod, { now, seed: SEED, serverId, ctxFor: taggedCtx(mod, now) });
  assert.ok(reqs.length > 0);
  for (const q of reqs) {
    assert.deepEqual(Object.keys(q.ranks).sort(), ['L', 'M', 'S']);
    for (const v of Object.values(q.ranks)) assert.ok(Number.isInteger(v) && v >= 0);
  }
  for (const p of Object.values(r.projects)) {
    const count = rk => p.lots.filter(l => l.rank === rk).length;
    assert.deepEqual(p.ranks, { L: count('L'), M: count('M'), S: count('S') });
  }
});

test('the engine builds lot items; a mod-supplied item is ignored', () => {
  const real = resolveMod('agentville.fantasy'), { input, serverId, now } = inputFor('citydemo');
  const liar = { ...real, id: 'test.liar', hooks: { ...real.hooks, lots: (...a) => real.hooks.lots(...a).map(l => ({ ...l, item: 'home:someone-else' })) } };
  const r = runRules(input, fresh(), liar, { now, seed: SEED, serverId });
  for (const p of Object.values(r.projects)) for (const l of p.lots) {
    assert.equal(l.item, l.owner === 'home' ? `home:${l.agent}` : `pr:${l.pr}`);
  }
});

test('layout fields have no engine fallback: a missing one fails loudly; both bundled mods define them all', () => {
  for (const id of ['agentville.fantasy', 'agentville.base']) assert.doesNotThrow(() => layoutOf(resolveMod(id)), id);
  const real = resolveMod('agentville.fantasy');
  for (const f of ['square', 'gap', 'accents', 'searchX', 'searchY', 'aspect', 'reserveMs']) {
    const { [f]: _gone, ...rest } = real.rules.layout;
    assert.throws(() => layoutOf({ ...real, rules: { ...real.rules, layout: rest } }), new RegExp(f));
  }
  assert.throws(() => layoutOf({ id: 'x', rules: {} }), /layout/);
});
