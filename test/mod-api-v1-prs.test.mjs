import './support/ensure-mods-index.mjs';
// Public mod API v1 is frozen: open PRs reach a mod as state 'building' unless the world opts in to the 'prs.loading'
// feature (`features: ['prs.loading']`). Opted in (agentville.fantasy): 'loading' + live. MOD1_HOOKS never change.
import test from 'node:test';
import assert from 'node:assert/strict';
const { FEATURES, MOD1_HOOKS, MOD0_HOOKS } = await import('../web/src/engine/mod/api.js');
const { resolveMod, resolveWith } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { makeView } = await import('../web/src/engine/snapshot.js');

const view = () => makeView({
  agents: [{ id: 'srv-1', project: 'amber', bucket: 'building', prs: [{ id: '7' }] }],
  projects: [{ name: 'amber', prs: [{ id: '7', live: true, title: 'x' }, { id: '3', live: false }] }],
  dock: { loading: [{ href: 'https://github.com/o/amber/pull/7', id: 7, repo: 'o/amber', agentId: 'srv-1', checks: { passed: 2, failed: 0, pending: 1 }, review: 'approved' },
    { href: 'https://github.com/o/birch/pull/12', id: 12, repo: 'o/birch' }],
    sailed: [{ href: 'https://github.com/o/amber/pull/3', id: 3, repo: 'o/amber' }], total: 9, level: 2 },
}, { now: 1, demo: true });
const states = input => Object.fromEntries(input.prs.map(p => [p.id, p.state]));

test('FEATURES gains prs.loading, nothing else changes; MOD1_HOOKS unchanged', () => {
  assert.deepEqual([...FEATURES], ['layout', 'terrain.classes', 'scatter.at', 'represent.pr', 'represent.project', 'venues', 'persist', 'prs.loading']);
  assert.deepEqual([...MOD1_HOOKS], [...MOD0_HOOKS, 'layout', 'scatter']);
});

test('a v1 mod without the opt-in gets open PRs as building (dock data present), never loading', () => {
  const base = resolveMod('agentville.base');
  assert.deepEqual([...base.features], []);
  for (const f of [undefined, [], base.features]) {
    const { input } = toWorldInput(view(), { features: f });
    assert.deepEqual(states(input), { 'amber#7': 'building', 'amber#3': 'merged', 'birch#12': 'building' });
    assert.ok(input.prs.every(p => p.state !== 'loading'));
    assert.equal(input.prs.find(p => p.id === 'amber#7').live, true);
    assert.deepEqual(input.prs.find(p => p.id === 'amber#7').checks, { passed: 2, failed: 0, pending: 1 }, 'dock data still present');
    assert.deepEqual(input.history, { merged: 9, rank: 2 });
  }
});

test('an opted-in mod (agentville.fantasy) gets loading + live', () => {
  const fan = resolveMod('agentville.fantasy');
  assert.deepEqual([...fan.features], ['prs.loading']);
  const { input } = toWorldInput(view(), { features: fan.features });
  assert.deepEqual(states(input), { 'amber#7': 'loading', 'amber#3': 'merged', 'birch#12': 'loading' });
  assert.equal(input.prs.find(p => p.id === 'amber#7').live, true);
});

test('registry: features are top-only (not inherited along extends), validated, and unknown names lint', () => {
  const kid = { id: 'x.kid', name: 'k', version: '1', apiVersion: 1, extends: 'agentville.fantasy' };
  assert.deepEqual([...resolveWith([kid], 'x.kid').features], []);
  assert.deepEqual([...resolveWith([{ ...kid, id: 'x.kid2', features: ['prs.loading'] }], 'x.kid2').features], ['prs.loading']);
  const plain = { id: 'x.plain', name: 'p', version: '1', apiVersion: 1, extends: 'agentville.base' };
  assert.deepEqual([...resolveWith([plain], 'x.plain').features], []);
  const bad = { ...plain, id: 'x.bad', features: ['nope', 7, 'prs.loading'] };
  const r = resolveWith([bad], 'x.bad');
  assert.deepEqual([...r.features], ['prs.loading']);
  assert.equal(r.lint.filter(l => l.kind === 'features').length, 2);
  assert.equal(resolveWith([{ ...plain, id: 'x.str', features: 'prs.loading' }], 'x.str').lint.some(l => l.kind === 'features'), true);
});

test('registry: a non-first-party mod\'s own `ground` is linted (M6) and ignored', () => {
  const m = { id: 'x.gr', name: 'g', version: '1', apiVersion: 1, ground: { renderTile() {} } };
  const r = resolveWith([m], 'x.gr');
  assert.equal(r.ground, null);
  assert.ok(r.lint.some(l => l.kind === 'ground' && l.rule === 'M6'));
  assert.ok(!resolveWith([{ ...m, id: 'x.ok', ground: undefined }], 'x.ok').lint.some(l => l.kind === 'ground'));
});
