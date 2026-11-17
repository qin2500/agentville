import './support/ensure-mods-index.mjs';
// M6 P5 spec tests for world events (M6-PLAN P4). The module is not on this branch yet, so the suite skips cleanly
// until web/src/engine/render/event-fx.js exists, and activates on merge.
// Planned contract these tests are written against (docs/village-mods.md `events`, M6-PLAN P4):
//   EventSpec = { kind, at: 'plaza:<project>' | 'actor:<id>' | 'pr:<id>', effect, seconds, colors? }
//   effect: 'burst' | 'ring' | 'site:<objId>' | 'anim:<name>'
//   render/event-fx.js is PURE of t (no Date.now/performance.now/Math.random): same specs + same t = same output.
//   Real exports (render/event-fx.js): createEventFx() -> { add(specs[], t0) -> n kept, active(t) -> entries { t0, seconds, ... } live
//   at t, prune(t) -> n still unexpired, size }; progress = (t - t0) / seconds, computed here from the entry.
//   An effect is live for t0 <= t < t0 + seconds and gone after (expiry). A mod's events() hook has a 10 ms deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const FX = new URL('../web/src/engine/render/event-fx.js', import.meta.url);
const FANTASY_EVENTS = new URL('../mods/agentville.fantasy/events.js', import.meta.url);
const absent = !existsSync(FX);
const WHY = 'render/event-fx.js not on this branch yet (M6 P4); suite activates when it merges';
if (absent) console.log(`# engine-events: SKIPPED, ${WHY}`);
const mod = absent ? null : await import(FX.href);
const has = !!mod && typeof mod.createEventFx === 'function';
const opts = absent ? { skip: WHY } : !has ? { skip: 'event-fx.js has no createEventFx(): contract exports differ from the plan, update this suite' } : {};
// thin adapters from the spec's vocabulary to the real API
const addOne = (fx, spec, t0) => fx.add([spec], t0);
const sizeAt = (fx, t) => fx.prune(t);

const SPEC = (o = {}) => ({ kind: 'merge', at: 'plaza:alpha', effect: 'burst', seconds: 2, colors: ['#e4572e', '#f2b134'], ...o });
const live = (fx, t) => fx.active(t).map(e => ({ spec: { kind: e.kind, at: e.at, effect: e.effect, seconds: e.seconds, colors: e.colors }, p: (t - e.t0) / e.seconds }));

test('effects are live for [t0, t0 + seconds) and expire afterwards', opts, () => {
  const fx = mod.createEventFx();
  addOne(fx, SPEC({ seconds: 2 }), 10);
  assert.equal(live(fx, 9.99).length, 0, 'not started');
  assert.equal(live(fx, 10).length, 1);
  assert.equal(live(fx, 11.99).length, 1);
  assert.equal(live(fx, 12).length, 0, 'expired at t0 + seconds');
  assert.equal(sizeAt(fx, 100), 0);
});

test('progress runs 0..1 over the lifetime', opts, () => {
  const fx = mod.createEventFx();
  addOne(fx, SPEC({ seconds: 4 }), 0);
  const p = t => live(fx, t)[0].p;
  assert.ok(p(0) >= 0 && p(0) < 0.01);
  assert.ok(Math.abs(p(2) - 0.5) < 1e-6);
  assert.ok(p(3.999) > 0.99 && p(3.999) <= 1);
});

test('pure of t: same specs and same t give identical output, in any query order', opts, () => {
  const build = () => { const fx = mod.createEventFx(); addOne(fx, SPEC(), 1); addOne(fx, SPEC({ effect: 'ring', at: 'pr:p#1', seconds: 1 }), 1.5); return fx; };
  const a = build(), b = build();
  const ts = [1, 1.2, 2.4, 0.5, 1.2, 3, 1.2];
  const ra = ts.map(t => JSON.stringify(live(a, t)));
  const rb = [...ts].reverse().map(t => JSON.stringify(live(b, t))).reverse();
  assert.deepEqual(ra, rb);
  assert.equal(ra[1], ra[4]);
});

test('does not read the clock or randomness', opts, () => {
  const now = Date.now, perf = performance.now, rnd = Math.random;
  Date.now = performance.now = Math.random = () => { throw new Error('event-fx must be pure of t'); };
  try {
    const fx = mod.createEventFx();
    addOne(fx, SPEC(), 0); addOne(fx, SPEC({ effect: 'site:house-1', seconds: 8 }), 0); addOne(fx, SPEC({ at: 'actor:a1', effect: 'anim:cheer', seconds: 3 }), 0);
    for (const t of [0, 1, 5, 9]) live(fx, t);
  } finally { Date.now = now; performance.now = perf; Math.random = rnd; }
});

test('every effect kind of the contract is accepted: burst, ring, site:<obj>, anim:<name>', opts, () => {
  const fx = mod.createEventFx();
  for (const [at, effect] of [['plaza:a', 'burst'], ['plaza:a', 'ring'], ['plaza:a', 'site:obj7'], ['actor:a1', 'anim:cheer'], ['pr:p#3', 'burst']]) addOne(fx, SPEC({ at, effect, seconds: 8 }), 0);
  assert.equal(live(fx, 1).length, 5);
});

test('malformed specs are ignored, never thrown', opts, () => {
  const fx = mod.createEventFx();
  for (const bad of [null, undefined, {}, { kind: 'x' }, SPEC({ seconds: -1 }), SPEC({ seconds: NaN }), SPEC({ at: 42 }), SPEC({ effect: 7 })]) assert.doesNotThrow(() => addOne(fx, bad, 0));
  assert.equal(live(fx, 0.5).length, 0);
});

test('many events stay bounded after they expire', opts, () => {
  const fx = mod.createEventFx();
  for (let i = 0; i < 500; i++) addOne(fx, SPEC({ seconds: 1 }), i * 0.01);
  assert.equal(sizeAt(fx, 1000), 0);
});

// ---- the fantasy mod's events hook (M6 P4: mods/agentville.fantasy/events.js) ----
const fantasyOpts = !existsSync(FANTASY_EVENTS) ? { skip: 'mods/agentville.fantasy/events.js not on this branch yet (M6 P4)' } : {};
test('fantasy events: merge -> confetti burst in the accent; found -> banner + ring; tierUp -> site scaffolds + cheers; 10 ms deadline', fantasyOpts, async () => {
  const m = await import(FANTASY_EVENTS.href);
  const events = m.events ?? m.default;
  assert.equal(typeof events, 'function');
  const ctx = { accentOf: p => (p === 'alpha' ? '#e4572e' : null), actorsOf: p => (p === 'alpha' ? ['a1', 'a2'] : []),
    newObjects: [{ id: 'house-1', project: 'alpha', kind: 'building', model: 'cottage' }, { id: 'ban-1', project: 'alpha', kind: 'prop', model: 'banner' }],
    hash: s => s.length, api: { version: 1 } };
  const run = diff => { const t0 = performance.now(); const r = events(diff, ctx); assert.ok(performance.now() - t0 < 10, 'under the 10 ms mod deadline'); return r; };
  const spec = run([{ type: 'merge', pr: 'alpha#1', project: 'alpha' }]);
  assert.ok(Array.isArray(spec) && spec.length >= 1);
  for (const s of spec) {
    assert.ok(typeof s.kind === 'string' && /^(plaza|actor|pr):/.test(s.at) && typeof s.effect === 'string' && s.seconds > 0, JSON.stringify(s));
  }
  assert.ok(spec.some(s => s.effect === 'burst'), 'merge makes a burst');
  assert.ok(run([{ type: 'found', project: 'alpha' }]).some(s => s.effect === 'ring'), 'found makes a dust ring');
  const tier = run([{ type: 'tierUp', project: 'alpha', tier: 2 }]);
  assert.ok(tier.some(s => s.effect.startsWith('site:') || s.effect === 'anim:cheer'), 'tierUp: scaffolds and/or cheers');
  assert.deepEqual(run([]), []);
});
