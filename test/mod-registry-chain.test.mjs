// Registry chain contract: ctx.parent is bound per level of the extends-chain (no recursion when every level delegates),
// the bound ctx is cached per incoming ctx (scatter runs per tile), bad and duplicate ids are skipped with lint, a
// missing parent names the mod, and a non-first-party `ambient` is ignored (M6). Synthetic in-memory mods only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWith, resolveMod, indexMods, registryLint, modCtx, CTX_AT } from '../web/src/engine/mod/registry.js';

const HOOKS = Object.keys(CTX_AT);
// Arguments for each hook, without the ctx; the ctx goes in at CTX_AT[name].
const ARGS = { growth: [{}], tier: [3, null], capacity: [1, 4], lots: [{}, [], []], crowns: [{}, []], planSettlement: [{}], style: ['p', {}], layout: [{}], scatter: [{}, () => 0.5] };
const call = (hooks, name, ctx) => { const a = [...ARGS[name]]; a.splice(CTX_AT[name], 0, ctx); return hooks[name](...a); };

/** A mod whose every hook logs `<tag>:<hook>` and then calls ctx.parent.<hook> (if there is one), like the template. */
function delegating(id, ext, log) {
  const hooks = {};
  for (const name of HOOKS) {
    hooks[name] = (...args) => {
      const ctx = args[CTX_AT[name]];
      log.push(`${id}:${name}`);
      return typeof ctx.parent?.[name] === 'function' ? ctx.parent[name](...args) : `${id}:${name}`;
    };
  }
  return { id, name: id, version: '0.0.1', apiVersion: 1, extends: ext, hooks };
}

test('CTX_AT matches the ctx position of every v1 hook', () => {
  assert.deepEqual({ ...CTX_AT }, { growth: 1, tier: 2, capacity: 2, lots: 3, crowns: 2, planSettlement: 1, style: 1, layout: 1, scatter: 2 });
});

test('3-level chain: every level calls ctx.parent for every hook, in order, with no recursion', () => {
  const log = [];
  const mods = [delegating('test.a', null, log), delegating('test.b', 'test.a', log), delegating('test.c', 'test.b', log)];
  const m = resolveWith(mods, 'test.c');
  assert.deepEqual(m.chain, ['test.c', 'test.b', 'test.a']);
  const ctx = modCtx(m, { seed: 1, projectKey: 'p' });
  for (const name of HOOKS) {
    log.length = 0;
    assert.equal(call(m.hooks, name, ctx), `test.a:${name}`, name);
    assert.deepEqual(log, [`test.c:${name}`, `test.b:${name}`, `test.a:${name}`], name);
  }
  // From the middle of the chain too (parentHooks start at test.b).
  log.length = 0;
  assert.equal(call(m.parentHooks, 'growth', ctx), 'test.a:growth');
  assert.deepEqual(log, ['test.b:growth', 'test.a:growth']);
});

test('a level that does not define a hook inherits the one above, still bound to its own level', () => {
  const log = [];
  const b = delegating('test.b', 'test.a', log);
  delete b.hooks.growth;
  const m = resolveWith([delegating('test.a', null, log), b, delegating('test.c', 'test.b', log)], 'test.c');
  call(m.hooks, 'growth', modCtx(m));
  assert.deepEqual(log, ['test.c:growth', 'test.a:growth']);
});

test('template-style worlds two deep over agentville.fantasy (autumn → night) match fantasy and do not recurse', () => {
  const pass = (id, ext) => ({ id, name: id, version: '0.0.1', apiVersion: 1, extends: ext, hooks: {
    growth: (p, ctx) => ctx.parent.growth(p, ctx), tier: (g, t, ctx) => ctx.parent.tier(g, t, ctx),
    capacity: (t, n, ctx) => ctx.parent.capacity(t, n, ctx), crowns: (p, a, ctx) => ctx.parent.crowns(p, a, ctx),
    style: (k, ctx, preset) => ctx.parent.style(k, ctx, preset),
  } });
  const night = resolveWith([pass('example.autumn', 'agentville.fantasy'), pass('example.night', 'example.autumn')], 'example.night');
  const fantasy = resolveMod('agentville.fantasy');
  const project = { name: 'p', agents: 3, active: 2, prs: 1, lastActive: 0 };
  const cn = modCtx(night, { seed: 5, projectKey: 'p' }), cf = modCtx(fantasy, { seed: 5, projectKey: 'p' });
  assert.equal(night.hooks.growth(project, cn), fantasy.hooks.growth(project, cf));
  assert.equal(night.hooks.tier(7, null, cn), fantasy.hooks.tier(7, null, cf));
  assert.equal(night.hooks.capacity(1, 4, cn), fantasy.hooks.capacity(1, 4, cf));
  assert.deepEqual(night.hooks.style('p', cn), fantasy.hooks.style('p', cf));
});

test('scatter: the bound ctx is cached per incoming ctx object', () => {
  const seen = { c: [], b: [] };
  const a = { id: 'test.a', name: 'a', version: '0', apiVersion: 1, extends: null, hooks: { scatter: () => null } };
  const b = { id: 'test.b', name: 'b', version: '0', apiVersion: 1, extends: 'test.a', hooks: { scatter: (t, d, ctx) => { seen.b.push(ctx); return ctx.parent.scatter(t, d, ctx); } } };
  const c = { id: 'test.c', name: 'c', version: '0', apiVersion: 1, extends: 'test.b', hooks: { scatter: (t, d, ctx) => { seen.c.push(ctx); return ctx.parent.scatter(t, d, ctx); } } };
  const m = resolveWith([a, b, c], 'test.c');
  const ctx1 = modCtx(m), ctx2 = modCtx(m), draw = () => 0;
  for (let i = 0; i < 3; i++) m.hooks.scatter({ tx: i, ty: 0 }, draw, ctx1);
  m.hooks.scatter({ tx: 9, ty: 9 }, draw, ctx2);
  assert.equal(seen.c[0], seen.c[1]); assert.equal(seen.c[1], seen.c[2]);
  assert.equal(seen.b[0], seen.b[1]); assert.equal(seen.b[1], seen.b[2]);
  assert.notEqual(seen.c[0], seen.b[0], 'each level has its own bound ctx');
  assert.notEqual(seen.c[3], seen.c[0], 'a new incoming ctx gets a new bound ctx');
  assert.equal(seen.c[0].parent, m.parentHooks);
  assert.equal(seen.c[0].rng, ctx1.rng, 'every other ctx field passes through');
  // A ctx that is not an object passes through unchanged.
  const raw = { id: 'test.r', name: 'r', version: '0', apiVersion: 1, extends: 'test.a', hooks: { scatter: (t, d, ctx) => ctx } };
  const r = resolveWith([a, raw], 'test.r');
  assert.equal(r.hooks.scatter({}, draw, undefined), undefined);
  assert.equal(r.hooks.scatter({}, draw, 7), 7);
});

test('bad and duplicate ids are skipped with lint, never thrown', () => {
  const ok = { id: 'test.ok', name: 'ok', version: '0', apiVersion: 1, extends: 'agentville.base' };
  const { byId, lint } = indexMods([{ ...ok, id: 'Bad_World' }, ok, { ...ok, name: 'second' }, { ...ok, id: 'x.y.demo' }, null]);
  assert.deepEqual([...byId.keys()], ['test.ok']);
  assert.equal(byId.get('test.ok').name, 'ok', 'the first of two duplicates is kept');
  assert.deepEqual(lint.map(l => l.kind), ['mod-id', 'mod-duplicate', 'mod-id', 'mod-id']);
  assert.match(lint[0].reason, /invalid mod id "Bad_World"/);
  assert.equal(lint[1].mod, 'test.ok');
  // resolveWith over a list holding a bad folder still resolves the good one.
  assert.equal(resolveWith([{ ...ok, id: 'Bad_World' }, ok], 'test.ok').id, 'test.ok');
  assert.deepEqual([...registryLint()], [], 'the bundled mods index cleanly');
});

test('a missing parent throws a message naming the mod', () => {
  const orphan = { id: 'test.orphan', name: 'o', version: '0', apiVersion: 1, extends: 'test.nope' };
  assert.throws(() => resolveWith([orphan], 'test.orphan'), /^Error: mod test\.orphan: extends "test\.nope" is not a bundled mod$/);
  const mid = { id: 'test.kid', name: 'k', version: '0', apiVersion: 1, extends: 'test.orphan' };
  assert.throws(() => resolveWith([orphan, mid], 'test.kid'), /mod test\.orphan: extends "test\.nope" is not a bundled mod/);
});

test('a non-first-party own ambient is ignored with an M6 lint; first-party ambient is inherited', () => {
  const fantasy = resolveMod('agentville.fantasy');
  assert.ok(fantasy.ambient, 'fantasy has ambient');
  assert.equal(fantasy.lint.some(l => l.rule === 'M6'), false);
  const own = { spawn: () => [], behaviours: {} };
  const kid = resolveWith([{ id: 'example.amb', name: 'a', version: '0', apiVersion: 1, extends: 'agentville.fantasy', ambient: own }], 'example.amb');
  assert.equal(kid.ambient, fantasy.ambient, 'own ambient ignored, fantasy\'s inherited');
  assert.deepEqual(kid.lint.filter(l => l.rule === 'M6').map(l => [l.kind, l.mod]), [['ambient', 'example.amb']]);
  const onBase = resolveWith([{ id: 'example.amb', name: 'a', version: '0', apiVersion: 1, extends: 'agentville.base', ambient: own }], 'example.amb');
  assert.equal(onBase.ambient, null);
  const plain = resolveWith([{ id: 'example.plain', name: 'p', version: '0', apiVersion: 1, extends: 'agentville.fantasy' }], 'example.plain');
  assert.equal(plain.ambient, fantasy.ambient);
  assert.equal(plain.lint.some(l => l.rule === 'M6'), false);
});
