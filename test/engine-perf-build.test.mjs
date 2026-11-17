// M7 build/poll perf: the per-project rules memo (world/rules-memo.js), toWorldInput record reuse (mod/input.js) and the
// sliced cold build (world/world-steps.js + core/slices.js). Pure node, no DOM, no network, no real sessions.
import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const { resolveMod, modCtx } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput, createInputReuse } = await import('../web/src/engine/mod/input.js');
const { runRules } = await import('../web/src/engine/world/rules-phase.js');
const { planSettlements } = await import('../web/src/engine/world/sites.js');
const { createRulesMemo, replansInPlace } = await import('../web/src/engine/world/rules-memo.js');
const { createBuildCache } = await import('../web/src/engine/world/cache.js');
const { worldSteps } = await import('../web/src/engine/world/world-steps.js');
const { drainSync, drainSliced } = await import('../web/src/engine/core/slices.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { createSim } = await import('../web/src/engine/sim/world-sim.js');
const { viewFromFixture } = await import('../web/src/engine/snapshot.js');

const SEED = 7, SALT = 's7';
const fixture = name => JSON.parse(fs.readFileSync(new URL(`../e2e/fixtures/engine/${name}.json`, import.meta.url), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));

/** The fantasy mod with every rule hook counted per project key (planSettlement counted as a whole). */
function countedMod() {
  const base = resolveMod('agentville.fantasy'), calls = new Map(), bump = k => calls.set(k, (calls.get(k) || 0) + 1);
  const H = base.hooks, hooks = { ...H };
  hooks.growth = (p, ctx) => { bump(`growth:${p.key}`); return H.growth(p, ctx); };
  hooks.lots = (p, here, prs, ctx) => { bump(`lots:${p.key}`); return H.lots(p, here, prs, ctx); };
  hooks.capacity = (...a) => { bump('capacity'); return H.capacity(...a); };
  if (H.crowns) hooks.crowns = (p, here, ctx) => { bump(`crowns:${p.key}`); return H.crowns(p, here, ctx); };
  hooks.planSettlement = (...a) => { bump('planSettlement'); return H.planSettlement(...a); };
  return { mod: { ...base, hooks }, calls };
}

function poller(fx, mod) {
  const memo = createRulesMemo(), reuse = createInputReuse(), cache = createBuildCache();
  const persisted = { v: 1, seed: SEED, blocks: {}, lots: {} };
  return frame => {
    const view = viewFromFixture(frame, { now: fx.now });
    const { input, serverId } = toWorldInput(view, { seed: SEED, salt: SALT, features: mod.features, reuse });
    const opts = { now: view.now, seed: SEED, serverId, ctxFor: k => modCtx(mod, { seed: SEED, now: view.now, projectKey: k }) };
    return { input, opts, persisted, ...memo.run({ input, persisted, mod, opts, cache }) };
  };
}

test('rules memo: a status flip re-runs only the rule hooks of its own project and never the planner; an unchanged poll runs none', () => {
  const fx = clone(fixture('busy'));
  const { mod, calls } = countedMod();
  const poll = poller(fx, mod);
  const first = poll(fx);
  assert.ok(first.ran.length > 5, 'the first poll runs every project');
  assert.ok(calls.get('planSettlement') > 0);

  // flip one agent between two working statuses: a rule input changed (status), so only its project's hooks may run
  const a = fx.agents.find(x => x.bucket === 'building');
  assert.ok(a, 'the busy fixture has a building agent');
  calls.clear();
  a.bucket = 'waiting';
  const p1 = poll(fx);
  const proj = a.project || '—';
  assert.deepEqual(p1.ran, [proj], 'only the flipped agent\'s project re-runs');
  for (const k of calls.keys()) if (k.includes(':')) assert.ok(k.endsWith(`:${proj}`), `no hook ran for another project (${k})`);
  assert.equal(calls.get('planSettlement') ?? 0, 0, 'the planner does not run again (same tier, cap, crowns, style, ranks)');
  assert.equal(p1.pv.sig, first.pv.sig, 'a status flip keeps the sig: no world rebuild');

  // nothing changed: nothing runs
  calls.clear();
  const p2 = poll(fx);
  assert.deepEqual(p2.ran, []);
  assert.equal(calls.size, 0, 'an unchanged poll calls no hook at all');

  // the memo's answer is always the full rules phase's answer
  for (const p of [p1, p2]) {
    const r = runRules(p.input, p.persisted, mod, p.opts), pv = planSettlements(p.input, p.persisted, mod, p.opts, r);
    assert.equal(JSON.stringify(p.rules), JSON.stringify(r));
    assert.equal(p.pv.sig, pv.sig);
  }

  // resting folds a home (the fantasy lots rule reads status): its project re-runs, nothing else
  calls.clear();
  a.bucket = 'resting';
  const p3 = poll(fx);
  assert.deepEqual(p3.ran, [proj]);
  const r3 = runRules(p3.input, p3.persisted, mod, p3.opts);
  assert.equal(JSON.stringify(p3.rules), JSON.stringify(r3));
  assert.equal(p3.pv.sig, planSettlements(p3.input, p3.persisted, mod, p3.opts, r3).sig);
});

test('rules memo: a persisted block or seed change re-runs what reads it', () => {
  const fx = clone(fixture('busy'));
  const { mod } = countedMod();
  const memo = createRulesMemo(), cache = createBuildCache();
  const view = viewFromFixture(fx, { now: fx.now });
  const { input, serverId } = toWorldInput(view, { seed: SEED, salt: SALT, features: mod.features });
  const persisted = { v: 1, seed: SEED, blocks: {}, lots: {} };
  const opts = s => ({ now: view.now, seed: s, serverId, ctxFor: k => modCtx(mod, { seed: s, now: view.now, projectKey: k }) });
  const all = memo.run({ input, persisted, mod, opts: opts(SEED), cache }).ran.length;
  const name = input.agents[0].project;
  persisted.blocks[name] = { gt: 1, tier: 1, cap: 99 };
  assert.deepEqual(memo.run({ input, persisted, mod, opts: opts(SEED), cache }).ran, [name]);
  assert.equal(memo.run({ input, persisted, mod, opts: opts(SEED + 1), cache }).ran.length, all, 'a new seed re-runs everything');
});

test('rules memo: a nested block re-planned in place (growth room reads the whole town) runs the whole rules phase', () => {
  const fx = clone(fixture('busy'));
  const { mod } = countedMod();
  const memo = createRulesMemo(), cache = createBuildCache();
  const view = viewFromFixture(fx, { now: fx.now });
  const { input, serverId } = toWorldInput(view, { seed: SEED, salt: SALT, features: mod.features });
  const persisted = { v: 1, seed: SEED, blocks: {}, lots: {} };
  const opts = { now: view.now, seed: SEED, serverId, ctxFor: k => modCtx(mod, { seed: SEED, now: view.now, projectKey: k }) };
  const first = memo.run({ input, persisted, mod, opts, cache });
  assert.equal(memo.run({ input, persisted, mod, opts, cache }).ran.length, 0);
  // a standing nested block whose tier is about to change: thin growth would give its planner a room from every block
  const name = input.agents[0].project, R = first.rules.projects[name];
  persisted.blocks[name] = { x: 0, y: 0, w: 10, h: 10, tier: R.tier - 1, gt: R.tier - 1, cap: R.cap, nest: 'c1' };
  assert.ok(replansInPlace(persisted.blocks[name], R, mod), 'the fantasy mod lays out thin');
  const m = memo.run({ input, persisted, mod, opts, cache });
  assert.equal(m.ran.length, Object.keys(first.rules.projects).length, 'every project runs (no per-project answer is kept)');
  const r = runRules(input, persisted, mod, opts);
  assert.equal(JSON.stringify(m.rules), JSON.stringify(r));
  assert.equal(m.pv.sig, planSettlements(input, persisted, mod, opts, r).sig);
  assert.equal(memo.stats().full, 1);
  // once the block stands at its new tier and cap, polls are per project again
  persisted.blocks[name] = { ...persisted.blocks[name], tier: R.tier, gt: R.tier, cap: R.cap };
  assert.ok(!replansInPlace(persisted.blocks[name], memo.run({ input, persisted, mod, opts, cache }).rules.projects[name], mod));
  assert.deepEqual(memo.run({ input, persisted, mod, opts, cache }).ran, []);
});

test('toWorldInput reuse: the same input, and unchanged records come back as the very same frozen objects', () => {
  const fx = clone(fixture('busy'));
  const reuse = createInputReuse();
  const view = () => viewFromFixture(fx, { now: fx.now });
  const a = toWorldInput(view(), { seed: SEED, salt: SALT, reuse }).input;
  assert.equal(JSON.stringify(a), JSON.stringify(toWorldInput(view(), { seed: SEED, salt: SALT }).input));
  const flip = fx.agents.find(x => x.bucket === 'building');
  flip.bucket = 'waiting';
  const b = toWorldInput(view(), { seed: SEED, salt: SALT, reuse }).input;
  assert.equal(JSON.stringify(b), JSON.stringify(toWorldInput(view(), { seed: SEED, salt: SALT }).input), 'reuse never changes the content');
  let same = 0, changed = 0;
  b.agents.forEach((x, i) => { if (x === a.agents[i]) same++; else changed++; });
  assert.equal(changed, 1, 'only the flipped agent is a new record');
  assert.equal(same, b.agents.length - 1);
  assert.equal(b.projects.filter((p, i) => p === a.projects[i]).length, b.projects.length, 'project records are kept (stats unchanged)');
  assert.ok(Object.isFrozen(b.agents.find(x => x.status === 'waiting' && !a.agents.includes(x))), 'a new record is frozen');
  assert.ok(Object.isFrozen(b.prs[0]) && Object.isFrozen(b.prs[0].checks), 'kept records stay deep frozen');
});

// ---- sliced vs unsliced cold build ----
const H = v => crypto.createHash('sha1').update(v).digest('hex');
const ser = (k, v) => (ArrayBuffer.isView(v) ? H(Buffer.from(v.buffer, v.byteOffset, v.byteLength)) : v instanceof Map ? [...v] : v instanceof Set ? [...v] : typeof v === 'function' ? undefined : v);
function coldSteps(fxName, layout) {
  const fx = fixture(fxName), mod = resolveMod('agentville.fantasy');
  const persisted = clone(layout?.persisted ?? { v: 1, seed: SEED, blocks: {}, lots: {} }), seed = layout?.seed ?? SEED;
  const view = viewFromFixture(fx, { now: fx.now });
  const { input, serverId } = toWorldInput(view, { seed, salt: layout?.salt ?? SALT, features: mod.features });
  const ctxFor = k => modCtx(mod, { seed, now: view.now, projectKey: k });
  const opts = { now: view.now, seed, serverId, ctxFor };
  const { rules } = createRulesMemo().run({ input, persisted, mod, opts });
  const gen = worldSteps({ input, persisted, mod, build: { ...opts, ctxFor: undefined, rules, cache: createBuildCache() }, berthCtx: ctxFor(''),
    createNav, createSim: (w, n) => createSim({ world: w, nav: n, seed, mod, serverId }) });
  return { gen, persisted };
}
function digest({ world, sim, berths }, persisted) {
  for (let i = 0; i < 20; i++) sim.tick(0.05);
  return {
    grid: H(JSON.stringify(world.grid, ser)), objects: H(JSON.stringify([...world.objects.values()], ser)),
    rest: H(JSON.stringify({ v: world.villages, sq: world.square, ve: world.venues, b: world.bounds, l: world.lint, sig: world.sig }, ser)),
    persisted: H(JSON.stringify(persisted)), berths: H(JSON.stringify(berths)),
    sim: H(JSON.stringify([...sim.actors.values()].map(a => [a.id, a.kind, a.x, a.y, a.face, a.slot?.id ?? null, a.path?.length ?? null, a.status ?? null]))),
  };
}

for (const [name, layoutFile] of [['busy', null], ['stress', 'stress-nested.layout.json']]) {
  test(`sliced cold build (${name}): the same world, nav and sim as the build run at once, handing the thread back between stages`, async () => {
    const layout = layoutFile ? JSON.parse(fs.readFileSync(new URL(`../e2e/fixtures/engine/${layoutFile}`, import.meta.url), 'utf8')) : null;
    const once = coldSteps(name, layout), whole = digest(drainSync(once.gen), once.persisted);
    const sliced = coldSteps(name, layout);
    let turns = 0;
    const out = await drainSliced(sliced.gen, { budgetMs: 0, yieldTo: () => { turns++; return new Promise(r => setImmediate(r)); } });
    assert.ok(turns >= 3, `the main thread is handed back between stages (${turns} turns)`);
    assert.deepEqual(digest(out, sliced.persisted), whole);
  });
}

test('drainSliced: yields only once a slice has used its budget, and passes a thrown error on', async () => {
  let clock = 0, turns = 0;
  function* steps() { for (let i = 0; i < 10; i++) { clock += 15; yield i; } return 'done'; }
  const v = await drainSliced(steps(), { budgetMs: 40, now: () => clock, yieldTo: async () => { turns++; } });
  assert.equal(v, 'done');
  assert.equal(turns, 3, '150 ms of 15 ms steps in 40 ms slices: 3 hand-backs');
  function* bad() { yield 1; throw new Error('boom'); }
  await assert.rejects(drainSliced(bad(), { budgetMs: 0, yieldTo: async () => {} }), /boom/);
  assert.equal(drainSync(steps()), 'done');
});

// ---- M7 pmap: the status-only poll on the nested stress town (the perf row "Per poll (status change only)") ----
// What a poll does after the world is built (index.js rebuildSteps, the sig-unchanged branch): view, toWorldInput (reuse),
// the rules memo, venueSig, venueAssignments, sim.applySnapshot. Every answer must equal the one computed from scratch.
const { venueSig, venueAssignments, prSpecsOf } = await import('../web/src/engine/world/venue.js');
const { representPr } = await import('../web/src/engine/sim/represent-world.js');

function nestedTown() {
  const fx = clone(fixture('stress')), layout = JSON.parse(fs.readFileSync(new URL('../e2e/fixtures/engine/stress-nested.layout.json', import.meta.url), 'utf8'));
  const mod = resolveMod('agentville.fantasy'), seed = layout.seed, salt = layout.salt;
  const persisted = clone(layout.persisted), memo = createRulesMemo(), reuse = createInputReuse(), cache = createBuildCache();
  const inputOf = r => { const view = viewFromFixture(fx, { now: fx.now }); return { view, ...toWorldInput(view, { seed, salt, features: mod.features, reuse: r }) }; };
  const optsOf = (view, serverId) => ({ now: view.now, seed, serverId, ctxFor: k => modCtx(mod, { seed, now: view.now, projectKey: k }) });
  const first = inputOf(reuse), o0 = optsOf(first.view, first.serverId);
  const r0 = memo.run({ input: first.input, persisted, mod, opts: o0, cache });
  const built = drainSync(worldSteps({ input: first.input, persisted, mod, build: { ...o0, ctxFor: undefined, rules: r0.rules, cache }, berthCtx: o0.ctxFor(''),
    createNav, createSim: (w, n) => createSim({ world: w, nav: n, seed, mod, serverId: first.serverId }) }));
  const sigOf = (pv, input, opts) => { const v = venueSig(input, mod, persisted, opts.ctxFor('')); return v ? `${pv.sig}|${v}` : pv.sig; };
  const sig0 = sigOf(memo.run({ input: first.input, persisted, mod, opts: o0, cache }).pv, first.input, o0);
  let turn = 0;
  /** flips `n` building/waiting agents (the harness's villagePerf.poll) and runs one poll; returns what each stage gave */
  function poll(n = 20) {
    const flipped = new Set();
    for (let i = 0, k = 0; i < fx.agents.length && k < n; i++) {
      const a = fx.agents[(i * 7 + turn) % fx.agents.length];
      if (a.bucket === 'building' || a.bucket === 'waiting') { a.bucket = a.bucket === 'building' ? 'waiting' : 'building'; flipped.add(a.project || '—'); k++; }
    }
    turn++;
    const { view, input, serverId } = inputOf(reuse), opts = optsOf(view, serverId);
    const m = memo.run({ input, persisted, mod, opts, cache });
    const sig = sigOf(m.pv, input, opts);
    const berths = venueAssignments(built.world, input, mod, persisted, opts.ctxFor(''));
    return { input, opts, m, sig, berths, flipped, view };
  }
  return { fx, mod, persisted, memo, built, poll, sig0, inputOf, optsOf };
}

test('status-only poll (nested stress town): rules, sig, venue sig and berths equal a full computation; only flipped projects re-run', () => {
  const T = nestedTown();
  for (let k = 0; k < 6; k++) {
    const p = T.poll(20);
    assert.ok(p.m.ran.length > 0 && p.m.ran.every(n => p.flipped.has(n)), `only flipped projects re-run (${p.m.ran.length} of ${p.flipped.size})`);
    assert.equal(T.memo.stats().full ?? 0, 0, 'no whole-town fallback on a status flip');
    assert.equal(p.sig, T.sig0, 'a status flip keeps the sig: no world rebuild');
    // from scratch: no reuse, no memo
    const fresh = T.inputOf(null), r = runRules(fresh.input, T.persisted, T.mod, p.opts), pv = planSettlements(fresh.input, T.persisted, T.mod, p.opts, r);
    assert.equal(JSON.stringify(p.input), JSON.stringify(fresh.input), 'the reused input is the fresh input');
    assert.equal(JSON.stringify(p.m.rules), JSON.stringify(r));
    assert.equal(p.m.pv.sig, pv.sig);
    assert.equal(venueSig(fresh.input, T.mod, clone(T.persisted), p.opts.ctxFor('')), venueSig(p.input, T.mod, T.persisted, p.opts.ctxFor('')));
    assert.deepEqual(venueAssignments(T.built.world, fresh.input, T.mod, clone(T.persisted), p.opts.ctxFor('')), p.berths);
  }
});

test('status-only poll: unchanged PRs are not represented again; the spec list is the same object while the records are', () => {
  const T = nestedTown();
  let calls = 0;
  const base = T.mod.represent.pr;
  const mod = { ...T.mod, represent: { ...T.mod.represent, pr: (v, ctx) => { calls++; return base(v, ctx); } } };
  const p = T.poll(20);
  const a = prSpecsOf(p.input, mod, {});
  assert.ok(calls >= p.input.prs.length, 'the first call represents every PR');
  calls = 0;
  assert.equal(prSpecsOf(p.input, mod, {}), a, 'the same records: the same list');
  const q = T.poll(20);
  const b = prSpecsOf(q.input, mod, {});
  assert.equal(calls, 0, 'a status flip changes no PR record: represent.pr is not called again');
  assert.deepEqual(b, prSpecsOf(T.inputOf(null).input, { ...mod }, {}), 'the kept specs equal fresh ones');
});

test('representPr memo: a function that reads its ctx is asked every time; lint is replayed into every caller', () => {
  const pr = Object.freeze({ id: 'p#1', project: 'p', number: 1, title: 't', state: 'loading', checks: Object.freeze({ passed: 0, failed: 0, pending: 0 }), review: null,
    size: Object.freeze({ additions: 1, deletions: 0, files: 1 }) });
  let n = 0;
  const reads = { represent: { pr: (v, ctx) => { n++; return { as: ctx.time.now > 5 ? 'none' : 'lot' }; } } };
  assert.equal(representPr(pr, reads, { time: { now: 1 } }).as, 'lot');
  assert.equal(representPr(pr, reads, { time: { now: 9 } }).as, 'none', 'the clock is read: never kept');
  assert.equal(n, 2);
  let m = 0;
  const bad = { represent: { pr: () => { m++; return { as: 'lot', tint: 'red' }; } } };
  const l1 = [], l2 = [];
  const s1 = representPr(pr, bad, { lint: l1 }), s2 = representPr(pr, bad, { lint: l2 });
  assert.equal(m, 1, 'kept: the function did not read its ctx');
  assert.equal(s1, s2);
  assert.equal(l1.length, 1); assert.deepEqual(l2, l1, 'the kept lint reaches the second caller too');
  const loose = { ...pr };   // not frozen: never kept
  representPr(loose, bad, {}); representPr(loose, bad, {});
  assert.equal(m, 3);
});

test('status-only poll: the sim given the reused records ends as one given fresh copies (record identity only skips work)', () => {
  const T = nestedTown();
  // one nav each: the slot registry lives in the nav
  const sims = [0, 1].map(() => createSim({ world: T.built.world, nav: createNav(T.built.world), seed: 7, mod: T.mod, serverId: id => id }));
  const order = [];
  for (let k = 0; k < 5; k++) {
    const p = T.poll(40);
    order.push(p.input.agents.map(a => a.id).join());
    sims[0].applySnapshot(p.input, { berths: p.berths.prs });
    sims[1].applySnapshot({ ...p.input, agents: p.input.agents.map(a => ({ ...a, prs: [...a.prs] })), prs: p.input.prs.map(x => ({ ...x })) }, { berths: p.berths.prs });
    for (let i = 0; i < 12; i++) for (const s of sims) s.tick(0.05);
  }
  assert.equal(new Set(order).size, 1, 'a status flip keeps the agents and their order (the kept visit order applies)');
  const dig = s => H(JSON.stringify([...s.actors.values()].map(a => [a.id, a.x, a.y, a.anim, a.frame, a.status?.bucket ?? null, a.path ? Array.from(a.path) : null])));
  assert.equal(dig(sims[0]), dig(sims[1]));
});

test('toWorldInput reuse: a record whose keys change order or gain a key is a new record (equality is JSON equality)', () => {
  const fx = clone(fixture('busy'));
  const reuse = createInputReuse();
  const view = () => viewFromFixture(fx, { now: fx.now });
  const a = toWorldInput(view(), { seed: SEED, salt: SALT, reuse }).input;
  const p = fx.projects.find(x => a.projects.some(q => q.name === x.name));
  p.style = 'elven';
  const b = toWorldInput(view(), { seed: SEED, salt: SALT, reuse }).input;
  const i = b.projects.findIndex(q => q.name === p.name);
  assert.notEqual(b.projects[i], a.projects[i], 'a gained preset: new record');
  assert.equal(JSON.stringify(b), JSON.stringify(toWorldInput(view(), { seed: SEED, salt: SALT }).input));
});

test('snapshot copyAgentFields: the same fields in the same order as the AGENT_FIELDS loop', async () => {
  const { copyAgentFields, AGENT_FIELDS } = await import('../web/src/engine/snapshot.js');
  const loop = a => { const o = {}; for (const k of AGENT_FIELDS) if (a[k] !== undefined) o[k] = a[k]; return o; };
  const full = Object.fromEntries([...AGENT_FIELDS].reverse().map((k, i) => [k, i % 3 ? `v${i}` : null]));
  for (const a of [{}, full, { ...full, extra: 1, url: 'x' }, ...fixture('stress').agents.slice(0, 50), { id: 'x', live: undefined, since: 0 }]) {
    assert.equal(JSON.stringify(copyAgentFields(a)), JSON.stringify(loop(a)));
    assert.deepEqual(Object.keys(copyAgentFields(a)), Object.keys(loop(a)));
  }
});
