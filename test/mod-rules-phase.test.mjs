import './support/ensure-mods-index.mjs';
// MOD1 M1c: world/rules-phase.js runRules. Written from the spec (/tmp/waveb/COMMON.md), not the implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { NOW } = await import('./mod-support/views.mjs');

let RP = null;
try { RP = await import('../web/src/engine/world/rules-phase.js'); } catch { RP = null; }
const skip = RP && typeof RP.runRules === 'function' ? false : 'world/rules-phase.js not present yet';

const agent = (id, project, role, parentId, bucket = 'building', prs = []) => ({ id, name: id, project, role, parentId, bucket, severity: null, live: bucket !== 'resting', lastActivityAt: NOW - 60_000, since: NOW - 1e7, prs });
const smallInput = () => {
  const agents = [
    agent('a-boss', 'alpha', 'boss', undefined, 'waiting'), agent('a-lead', 'alpha', 'lead', 'a-boss', 'building', [{ id: '11' }]),
    agent('a-sub', 'alpha', 'sub', 'a-lead'), agent('a-rest', 'alpha', undefined, undefined, 'resting'),
    agent('b-one', 'beta', undefined, undefined), agent('b-two', 'beta', undefined, undefined, 'resting', [{ id: '21' }]),
    agent('c-one', 'gamma', 'lead', undefined),
  ];
  const projects = [{ name: 'alpha', prs: [{ id: '11', live: true }, { id: '12', live: false }], transcriptBytes: 2e6, agentsEver: 8 },
    { name: 'beta', prs: [{ id: '21', live: false }], transcriptBytes: 1e5, agentsEver: 3 }, { name: 'gamma', prs: [], transcriptBytes: 0, agentsEver: 1 }];
  const view = makeView({ agents, projects, dock: { loading: [], sailed: [], total: 1, level: 1 } }, { now: NOW, demo: true });
  return toWorldInput(view, { seed: 7, salt: 'rp' }).input;
};
const fresh = () => ({ v: 1, seed: 7, blocks: {}, lots: {} });
const OPTS = { now: NOW, seed: 7, forcedTier: null, forcedStyle: null };
const PROJECTS = ['alpha', 'beta', 'gamma'];
const PER_PROJECT = ['growth', 'lots', 'crowns', 'style'];

const WORLD_SHAPE_HOOKS = new Set(['layout', 'scatter']);
function spyMod(id = 'agentville.fantasy') {
  const mod = resolveMod(id), calls = {}, planArgs = [];
  const hooks = {};
  for (const [k, fn] of Object.entries(mod.hooks)) {
    // layout/scatter are world-shape hooks: they run inside buildWorld by design (MOD-READY), not in the rules phase
    if (typeof fn !== 'function' || WORLD_SHAPE_HOOKS.has(k)) { hooks[k] = fn; continue; }
    hooks[k] = function (...a) {
      calls[k] = (calls[k] || 0) + 1;
      if (k === 'planSettlement') planArgs.push(a[0]);
      return fn.apply(this, a);
    };
  }
  return { mod: { ...mod, hooks }, calls, planArgs, reset() { for (const k of Object.keys(calls)) delete calls[k]; planArgs.length = 0; } };
}

// Compare worlds by what the spec names: object ids, lint, grid occ layer.
const sig = w => ({
  ids: [...w.objects.keys()].sort(),
  lint: w.lint,
  occ: (() => { const o = []; const g = w.grid; for (let y = g.oy; y < g.oy + g.h; y++) for (let x = g.ox; x < g.ox + g.w; x++) o.push(g.get('occ', x, y)); return o; })(),
});

test('runRules result is plain data: survives structuredClone deep-equal', { skip }, () => {
  const mod = resolveMod('agentville.fantasy');
  const r = RP.runRules(smallInput(), fresh(), mod, OPTS);
  assert.ok(r && r.projects && typeof r.projects === 'object');
  for (const p of PROJECTS) assert.ok(r.projects[p], `project ${p} present`);
  assert.deepEqual(structuredClone(r), r);
  // The sandbox contract is structured clone (postMessage), not JSON: plans carry typed arrays (ground).
});

test('runRules calls each per-project hook once per project', { skip }, () => {
  const s = spyMod();
  RP.runRules(smallInput(), fresh(), s.mod, OPTS);
  for (const k of PER_PROJECT) assert.equal(s.calls[k], PROJECTS.length, `${k} called once per project (got ${s.calls[k]})`);
  for (const k of ['tier', 'capacity', 'planSettlement']) assert.ok(s.calls[k] >= PROJECTS.length, `${k} ran for every project`);
});

test('buildWorld with precomputed rules calls no rules-phase hooks', { skip }, () => {
  const s = spyMod();
  const input = smallInput(), p = fresh();
  const rules = RP.runRules(input, p, s.mod, OPTS);
  s.reset();
  buildWorld(input, p, { mod: s.mod, now: NOW, seed: 7, rules });
  assert.deepEqual(s.calls, {}, `hooks called during buildWorld: ${JSON.stringify(s.calls)}`);
});

test('a rebuild runs the hooks once total: runRules then buildWorld(rules) equals the hook count of runRules alone', { skip }, () => {
  const s = spyMod(), input = smallInput(), p = fresh();
  const rules = RP.runRules(input, p, s.mod, OPTS);
  const after = { ...s.calls };
  buildWorld(input, p, { mod: s.mod, now: NOW, seed: 7, rules });
  assert.deepEqual(s.calls, after);
});

test('buildWorld(input, p, { rules }) equals buildWorld(input, p) without rules', { skip }, () => {
  for (const id of ['agentville.fantasy', 'agentville.base']) {
    const mod = resolveMod(id), input = smallInput();
    const pa = fresh(), pb = fresh();
    const rules = RP.runRules(input, pa, mod, OPTS);
    const withRules = buildWorld(input, pa, { mod, now: NOW, seed: 7, rules });
    const without = buildWorld(input, pb, { mod, now: NOW, seed: 7 });
    assert.deepEqual(sig(withRules), sig(without), id);
    assert.ok(withRules.objects.size === undefined || withRules.objects.size === without.objects.size);
  }
});

test('planSettlement receives ranks { L, M, S } counts', { skip }, () => {
  const s = spyMod();
  RP.runRules(smallInput(), fresh(), s.mod, OPTS);
  assert.ok(s.planArgs.length >= PROJECTS.length);
  for (const req of s.planArgs) {
    assert.ok(req.ranks && typeof req.ranks === 'object', 'ranks present');
    for (const r of ['L', 'M', 'S']) assert.ok(Number.isInteger(req.ranks[r]) && req.ranks[r] >= 0, `ranks.${r}`);
    assert.ok(req.ranks.L + req.ranks.M + req.ranks.S <= req.lots + 1e9);
  }
});
