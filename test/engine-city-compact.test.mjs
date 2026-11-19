import './support/ensure-mods-index.mjs';
// City compact (size to fit, 2026-11-17): a legacy oversized plan is compacted once, then shrinks only after a week of
// surplus and never moves a home in use; opt-out mods keep the old grow-only behaviour. Pure, node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { embedLots, lowClock, FIT_VERSION } = await import('../web/src/engine/world/fit.js');

const mod = resolveMod();
const legacyMod = { ...mod, rules: { ...mod.rules, compact: false } };
const DAY = 864e5, T0 = Date.UTC(2026, 10, 17, 12), P = 'keep';
// protected agents (stalled, active now) so nobody is retired or loses a home
const agent = (id, now) => ({ id, name: id, project: P, parent: null, status: 'stalled', needs: null, role: 'worker', crown: false,
  important: false, stopped: false, harness: 'claude', since: T0 - 40 * DAY, lastActive: now, prs: [] });
const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => `a${String(from + i).padStart(3, '0')}`);
const inputOf = (list, now) => ({ apiVersion: 1, now, seed: 7, agents: list.map(i => agent(i, now)), prs: [],
  projects: [{ key: P, name: P, accent: '', stats: { prsEver: 80, prsLive: 0, agentsEver: 300, agentsNow: list.length, transcriptMB: 0 } }] });
const build = (list, persisted, now, m = mod, extra = {}) => buildWorld(inputOf(list, now), persisted, { mod: m, now, seed: 7, ...extra });
const fresh = () => ({ v: 1, seed: 7, blocks: {}, lots: {} });
const homes = w => new Map([...w.objects.values()].filter(o => o.data?.owner === 'home').map(o => [o.data.agentId, `${o.tx},${o.ty}`]));
const block = p => p.blocks[P];
const size = p => block(p).w * block(p).h;
const shape = p => `${block(p).nest}|${block(p).w}x${block(p).h}`;
const sig = w => JSON.stringify([...w.objects.values()].map(o => [o.id, o.tx, o.ty]).sort());
const stable = p => JSON.stringify(p, (k, v) => (k === 'seen' ? undefined : v));
// a legacy layout: grown to 45 working agents (chain 3.1, 47 lots) with compact:false, then quiet at 12 two days later
const legacy = () => {
  const p = fresh(), many = ids(45), few = many.slice(0, 12);
  build(many, p, T0, legacyMod);
  const w = build(few, p, T0 + 2 * DAY, legacyMod);
  return { p, few, w, now: T0 + 3 * DAY };
};

// 1. the first normal build of a legacy oversized city shrinks the footprint and changes the chain
test('compaction: a legacy oversized block gets strictly smaller', () => {
  const { p, few, now } = legacy();
  assert.equal(p.fit, undefined);
  assert.equal(block(p).nest, '3.1');
  const before = size(p), chain = block(p).nest;
  build(few, p, now);
  assert.ok(size(p) < before, `area ${size(p)} < ${before}`);
  assert.notEqual(block(p).nest, chain);
  assert.equal(p.fit, FIT_VERSION);
  assert.equal(block(p).fit, FIT_VERSION);
});

// 2. the same agents stay housed, every one of them
test('compaction: every housed agent is still housed afterwards', () => {
  const { p, few, w, now } = legacy();
  const before = [...homes(w).keys()].sort();
  assert.deepEqual(before, [...few].sort());
  const after = [...homes(build(few, p, now)).keys()].sort();
  assert.deepEqual(after, before);
});

// 3. the civic core survives compaction
test('compaction: cathedral, guildhall and markethall are kept', () => {
  const { p, few, now } = legacy();
  const models = new Set([...build(few, p, now).objects.values()].filter(o => o.id.includes(P)).map(o => o.model));
  for (const m of ['cathedral', 'guildhall', 'markethall']) assert.ok(models.has(m), `${m} kept`);
});

// 4. 60 days of churn (a +12 spike every 13 days, +28 on day 40; a spike near the plan size legitimately blocks shrinking): shrinks are a week apart, never follow growth within a week, and move no surviving home
test('churn: no oscillation, shrinks >= 7 days apart, no surviving home moves in a shrink', () => {
  const p = fresh();
  let cur = ids(45), next = 45, seed = 11, prev = null;
  const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return (seed >>> 12) % n; };
  const events = [];
  for (let day = 0; day < 60; day++) {
    const now = T0 + day * DAY;
    if (day > 0) {
      cur = cur.slice(0, 12);
      for (let k = 0; k < 3; k++) cur[rnd(12)] = `a${String(next++).padStart(3, '0')}`;
      if (day % 13 === 5) { cur = [...cur, ...ids(12, next)]; next += 12; }
      if (day === 40) { cur = [...cur, ...ids(28, next)]; next += 28; }
    }
    const w = build(cur, p, now, mod, { cityCap: 40 });
    const h = homes(w), s = shape(p), a = size(p);
    if (prev && s !== prev.s) {
      const kind = a < prev.a ? 'shrink' : 'grow';
      events.push({ day, kind });
      if (kind === 'shrink') for (const [id, tile] of h) if (prev.h.has(id)) assert.equal(tile, prev.h.get(id), `day ${day}: ${id} moved in a shrink`);
    }
    prev = { s, a, h };
  }
  const shrinks = events.filter(e => e.kind === 'shrink');
  assert.ok(shrinks.length >= 2 && events.some(e => e.kind === 'grow'), 'it shrank, grew back on the day-40 surge, and shrank again');
  for (let i = 1; i < shrinks.length; i++) assert.ok(shrinks[i].day - shrinks[i - 1].day >= 7, `shrinks ${shrinks[i - 1].day} and ${shrinks[i].day} too close`);
  for (const e of shrinks) {
    const g = events.filter(x => x.kind === 'grow' && x.day < e.day).pop();
    if (g) assert.ok(e.day - g.day >= 7, `shrink on day ${e.day} follows growth on day ${g.day}`);
  }
});

// 5. an old saved layout (JSON round trip) migrates once, then is stable
test('migration: marks written, later builds identical', () => {
  const { p, few, now } = legacy();
  const saved = JSON.parse(JSON.stringify(p));
  const w1 = build(few, saved, now);
  assert.equal(saved.fit, 1);
  for (const b of Object.values(saved.blocks)) assert.equal(b.fit, 1);
  const s1 = stable(saved);
  const w2 = build(few, saved, now + 60_000);
  const w3 = build(few, saved, now + 120_000);
  assert.equal(sig(w2), sig(w1));
  assert.equal(sig(w3), sig(w2));
  assert.equal(stable(saved), s1);
});

// 6. the same scenario twice from deep copies is byte identical
test('deterministic: two runs agree byte for byte', () => {
  const run = () => {
    const { p, few, now } = legacy();
    const c = JSON.parse(JSON.stringify(p));
    const w = build(few, c, now);
    return [JSON.stringify(c), sig(w)];
  };
  assert.deepEqual(run(), run());
});

// 7. a mod with rules.compact === false never shrinks and writes no fit marks
test('opt-out: compact:false never shrinks and writes no fit', () => {
  const { p, few } = legacy();
  const before = shape(p);
  for (let d = 4; d < 30; d += 3) build(few, p, T0 + d * DAY, legacyMod);
  assert.equal(shape(p), before);
  assert.equal(p.fit, undefined);
  assert.equal(block(p).fit, undefined);
});

// 8a. embedLots refuses when a used lot has no twin, and honours a hint offset
test('embedLots: null without a twin; the hint offset is kept', () => {
  const L = (id, x, y) => ({ id, x, y, w: 2, h: 2, rank: 'S' });
  const cur = { w: 10, h: 6, lots: [L('A', 4, 2), L('B', 8, 2)] };
  const next = { w: 6, h: 6, lots: [L('X', 0, 2)] };
  assert.equal(embedLots(cur, next, ['B'], null), null, 'B has no twin');
  assert.equal(embedLots(cur, next, ['Z'], null), null, 'unknown lot');
  const e = embedLots(cur, next, ['A'], { dx: 4, dy: 0 });
  assert.deepEqual(e, { dx: 4, dy: 0, remap: { A: 'X' } });
  assert.equal(embedLots(cur, { w: 12, h: 6, lots: next.lots }, ['A'], null), null, 'next larger than cur');
});

// 8b. lowClock stops without a surplus, keeps since and raises peak while it lasts
test('lowClock: null without surplus; keeps since, raises peak', () => {
  assert.equal(lowClock({ since: 5, peak: 9 }, { cap: 33, fitCap: 33, need: 10, now: 100 }), null);
  assert.deepEqual(lowClock(null, { cap: 47, fitCap: 33, need: 12, now: 100 }), { since: 100, peak: 12 });
  assert.deepEqual(lowClock({ since: 50, peak: 12 }, { cap: 47, fitCap: 33, need: 20, now: 100 }), { since: 50, peak: 20 });
  assert.deepEqual(lowClock({ since: 50, peak: 12 }, { cap: 47, fitCap: 33, need: 8, now: 100 }), { since: 50, peak: 12 });
});
