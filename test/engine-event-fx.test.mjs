import './support/ensure-mods-index.mjs';
// M6 P4: world-event effects (render/event-fx.js): spec validation, purity and determinism in t, expiry, the hook
// deadline, throw safety, anim overrides, the registry seam and the `star` mark. Pure node: a recording Gfx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAt, parseEffect, normalizeSpec, runEvents, createEventFx, activeAt, animOverrides, resolveAt, drawEventFx, withAlpha, LIMITS } from '../web/src/engine/render/event-fx.js';
import { importantStars, drawMarks } from '../web/src/engine/render/marks.js';
const { resolveWith } = await import('../web/src/engine/mod/registry.js');

const rec = () => { const calls = []; return { calls, rect: (...a) => calls.push(['rect', ...a]), poly: (...a) => calls.push(['poly', ...a]), image() {} }; };
const WORLD = { villages: [{ name: 'p', cx: 10, cy: 12 }], objects: new Map([['o1', { id: 'o1', tx: 4, ty: 5, w: 2, h: 2, z: 30 }]]) };
const ENV = { world: WORLD, actors: [{ id: 'a1', x: 3, y: 4 }], berths: { 'p#1': { tx: 7, ty: 8 } } };
const sp = (o = {}) => ({ kind: 'merge', at: 'plaza:p', effect: 'burst', seconds: 2, colors: ['#ff0000', '#00ff00'], ...o });
const draw = (list, t, env = ENV) => { const g = rec(); drawEventFx(g, list, t, env); return g.calls; };

test('parseAt / parseEffect accept the contract and nothing else', () => {
  assert.deepEqual(parseAt('plaza:proj'), { type: 'plaza', id: 'proj' });
  assert.deepEqual(parseAt('pr:a#3'), { type: 'pr', id: 'a#3' });
  for (const bad of [null, 5, '', 'plaza', 'plaza:', 'town:x', ':x']) assert.equal(parseAt(bad), null, String(bad));
  assert.deepEqual(parseEffect('burst'), { type: 'burst', arg: null });
  assert.deepEqual(parseEffect('site:o1'), { type: 'site', arg: 'o1' });
  assert.deepEqual(parseEffect('anim:cheer'), { type: 'anim', arg: 'cheer' });
  for (const bad of [null, 'site', 'site:', 'anim:moonwalk', 'burst:x', 'boom', 7]) assert.equal(parseEffect(bad), null, String(bad));
});

test('normalizeSpec clamps seconds, caps colours, rejects malformed specs and never throws', () => {
  assert.equal(normalizeSpec(sp({ seconds: 999 }), 0).seconds, LIMITS.seconds);
  assert.equal(normalizeSpec(sp({ colors: Array(20).fill('#fff') }), 0).colors.length, LIMITS.colors);
  assert.ok(normalizeSpec(sp({ colors: undefined }), 0).colors.length > 0);
  for (const bad of [null, 'x', {}, sp({ seconds: 0 }), sp({ seconds: -1 }), sp({ seconds: NaN }), sp({ at: 'nowhere' }), sp({ effect: 'nope' })]) assert.equal(normalizeSpec(bad, 0), null);
  assert.equal(normalizeSpec({ get at() { throw new Error('x'); } }, 0), null);
  assert.equal(normalizeSpec(sp(), NaN), null);
});

test('drawing is a pure function of t: the same entry and t draw the same calls, in any order, with no randomness or clock', () => {
  const list = createEventFx(); list.add([sp(), sp({ effect: 'ring', seconds: 3 }), sp({ effect: 'site:o1', seconds: 8 })], 10);
  const all = list.active(10.5);
  const a = draw(all, 11.2), b = draw(all, 12.5), c = draw(all, 11.2);
  assert.deepEqual(a, c);
  assert.notDeepEqual(a, b);
  const saved = { r: Math.random, n: Date.now, p: globalThis.performance?.now };
  Math.random = () => { throw new Error('Math.random'); }; Date.now = () => { throw new Error('Date.now'); };
  if (globalThis.performance) globalThis.performance.now = () => { throw new Error('performance.now'); };
  try { assert.deepEqual(draw(all, 11.2), a); } finally { Math.random = saved.r; Date.now = saved.n; if (saved.p) globalThis.performance.now = saved.p; }
});

test('two entries with different specs scatter differently; the same spec at the same t0 is identical', () => {
  const a = normalizeSpec(sp(), 5), b = normalizeSpec(sp(), 5), c = normalizeSpec(sp({ kind: 'other' }), 5);
  assert.deepEqual(draw([a], 6), draw([b], 6));
  assert.notDeepEqual(draw([a], 6), draw([c], 6));
});

test('expiry: nothing before t0 or at/after t0 + seconds; prune drops the expired', () => {
  const e = normalizeSpec(sp({ seconds: 2 }), 10);
  assert.equal(draw([e], 9.99).length, 0);
  assert.ok(draw([e], 10).length > 0);
  assert.ok(draw([e], 11.99).length > 0);
  assert.equal(draw([e], 12).length, 0);
  assert.equal(activeAt([e], 12).length, 0);
  const fx = createEventFx(); fx.add([sp({ seconds: 1 }), sp({ seconds: 5, effect: 'ring' })], 0);
  assert.equal(fx.size, 2); assert.equal(fx.prune(2), 1); assert.equal(fx.prune(6), 0);
});

test('the active set is capped: the newest entries win', () => {
  const fx = createEventFx({ max: 3 });
  for (let i = 0; i < 6; i++) fx.add([sp({ kind: `k${i}`, seconds: 10 })], i);
  assert.equal(fx.size, 3);
  assert.deepEqual(fx.active(5).map(e => e.kind), ['k3', 'k4', 'k5']);
});

test('burst particles stay on screen near the plaza and are bounded; a missing target draws nothing', () => {
  const e = normalizeSpec(sp(), 0);
  const calls = draw([e], 1);
  assert.ok(calls.length > 0 && calls.length <= LIMITS.particles);
  assert.equal(draw([normalizeSpec(sp({ at: 'plaza:gone' }), 0)], 1).length, 0);
  assert.equal(draw([normalizeSpec(sp({ at: 'actor:ghost' }), 0)], 1).length, 0);
  assert.equal(draw([normalizeSpec(sp({ effect: 'site:nope' }), 0)], 1).length, 0);
});

test('resolveAt: plaza centre, actor feet, pr berth', () => {
  assert.deepEqual(resolveAt(parseAt('plaza:p'), ENV), { x: 10.5, y: 12.5 });
  assert.deepEqual(resolveAt(parseAt('actor:a1'), ENV), { x: 3, y: 4 });
  assert.deepEqual(resolveAt(parseAt('pr:p#1'), ENV), { x: 7.5, y: 8.5 });
  assert.equal(resolveAt(parseAt('pr:none'), ENV), null);
});

test('site overlay fades in and out and only draws for a known object', () => {
  const e = normalizeSpec(sp({ effect: 'site:o1', seconds: 8 }), 0);
  const alphaOf = t => { const c = draw([e], t).find(x => x[0] === 'rect'); return c ? Number(/,([\d.]+)\)$/.exec(c[5])?.[1] ?? 1) : 0; };
  assert.ok(alphaOf(0.25) < alphaOf(4));
  assert.ok(alphaOf(7.65) < alphaOf(4));
  assert.ok(draw([e], 4).length > 0);
});

test('anim overrides: only actor targets, only while alive, frame advances with t', () => {
  const list = [normalizeSpec({ kind: 'tierUp', at: 'actor:a1', effect: 'anim:cheer', seconds: 2 }, 10), normalizeSpec(sp({ effect: 'anim:wave' }), 10)];
  assert.equal(animOverrides(list, 9).size, 0);
  const m = animOverrides(list, 10.5);
  assert.deepEqual([...m.keys()], ['a1']);
  assert.equal(m.get('a1').anim, 'cheer');
  assert.ok(animOverrides(list, 11.5).get('a1').frame > m.get('a1').frame);
  assert.equal(animOverrides(list, 12).size, 0);
  assert.deepEqual(animOverrides(list, 10.5), animOverrides(list, 10.5));
});

test('runEvents: ok, none, throw, overrun, trim and non-array results; the engine keeps going', () => {
  const diff = [{ type: 'merge', project: 'p' }];
  assert.equal(runEvents(null, diff, {}).status, 'none');
  assert.equal(runEvents(() => [sp()], [], {}).status, 'none');
  const ok = runEvents(() => [sp(), { bad: 1 }, sp({ kind: 'b' })], diff, {});
  assert.equal(ok.status, 'ok'); assert.equal(ok.specs.length, 2);
  const th = runEvents(() => { throw new Error('boom'); }, diff, {});
  assert.deepEqual([th.status, th.specs.length], ['threw', 0]);
  assert.equal(runEvents(() => 'nope', diff, {}).specs.length, 0);
  // a fake clock: the hook "takes" 25 ms
  let now = 0; const clock = () => now;
  const slow = runEvents(() => { now += 25; return [sp()]; }, diff, {}, { clock });
  assert.deepEqual([slow.status, slow.specs.length], ['overrun', 0]);
  // within budget on the call, deadline passes while validating: trimmed, earlier specs kept
  now = 0;
  const many = Array.from({ length: 50 }, (_, i) => sp({ kind: `k${i}` }));
  let calls = 0; const tick = () => (calls++ < 5 ? 0 : 11);
  const tr = runEvents(() => many, diff, {}, { clock: tick });
  assert.equal(tr.status, 'trimmed'); assert.ok(tr.specs.length < many.length);
  // the cap per drain
  const big = runEvents(() => Array.from({ length: 100 }, () => sp()), diff, {}, { clock: () => 0 });
  assert.equal(big.specs.length, LIMITS.perDrain);
  // later calls still work after a failure
  assert.equal(runEvents(() => [sp()], diff, {}).specs.length, 1);
});

test('the registry exposes the nearest events hook; mods without one have none; hooks and MOD1_HOOKS are unchanged', async () => {
  const f = () => [];
  const base = { id: 'test.ev-a', name: 'a', version: '1.0.0', apiVersion: 1, extends: 'agentville.base' };
  assert.equal(resolveWith([base], 'test.ev-a').events, null);
  assert.equal(resolveWith([{ ...base, events: f }], 'test.ev-a').events, f);
  const child = { id: 'test.ev-b', name: 'b', version: '1.0.0', apiVersion: 1, extends: 'test.ev-a' };
  assert.equal(resolveWith([{ ...base, events: f }, child], 'test.ev-b').events, f);
  const { MOD1_HOOKS } = await import('../web/src/engine/mod/api.js');
  assert.ok(!MOD1_HOOKS.includes('events'));
  assert.ok(!('events' in resolveWith([{ ...base, events: f }], 'test.ev-a').hooks));
});

test('[vil.important-star] star mark: outdoor important agents only; drawn as a 7x6 glyph left of the head', () => {
  const actors = [{ id: 'a', kind: 'agent', x: 4, y: 4, input: { important: true } }, { id: 'b', kind: 'agent', x: 5, y: 5 },
    { id: 'c', kind: 'agent', x: 6, y: 6, important: true, indoors: true }, { id: 'd', kind: 'folk', x: 7, y: 7, important: true }];
  const stars = importantStars({ actors });
  assert.deepEqual(stars.map(s => s.id), ['a']);
  const g = rec(); drawMarks(g, { stars }, {});
  assert.ok(g.calls.length > 10);
  const xs = g.calls.map(c => c[1]), ys = g.calls.map(c => c[2]);
  assert.equal(Math.max(...xs) - Math.min(...xs), 6); assert.equal(Math.max(...ys) - Math.min(...ys), 5);
  assert.ok(g.calls.some(c => c[5] === '#ffd23f'));
  assert.deepEqual(importantStars({}), []);
});

test('withAlpha', () => {
  assert.equal(withAlpha('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
  assert.equal(withAlpha('#f00', 2), 'rgba(255,0,0,1)');
  assert.equal(withAlpha('red', 0.5), 'red');
});
