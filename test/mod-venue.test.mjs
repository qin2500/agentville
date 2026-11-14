// MOD-READY P6: the generic venue contract (SEAMS P6). Written from the spec only, with a toy "spaceport" venue declared
// by a fake mod on a toy layout. Needs P6's world/venue.js; each test skips ("needs P6") while the module is missing.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldGrid } from '../web/src/engine/core/grid.js';
import { ObjectStore } from '../web/src/engine/core/objects.js';
import { resolvePlace } from '../web/src/engine/sim/represent.js';

const tryImport = async p => { try { return await import(p); } catch { return null; } };
const V = await tryImport('../web/src/engine/world/venue.js');
const NEEDS = V?.buildVenues ? false : 'needs P6 (web/src/engine/world/venue.js buildVenues)';
const NEEDS_ASSIGN = V?.assignBerths ? false : 'needs P6 (web/src/engine/world/venue.js assignBerths)';

const RECT = { x: 10, y: 10, w: 8, h: 6 };
const BOUNDS = { ox: 0, oy: 0, w: 40, h: 30 };
const obj = (id, tx, ty, over = {}) => ({ id, kind: 'venue', model: 'pad', tx, ty, w: 1, h: 1, z: 4, walk: 'floor', styleKey: 'toy', variant: 0, ...over });
const isRecord = v => v && typeof v === 'object' && !Array.isArray(v);

/** a fake mod that declares one venue kind, 'spaceport'; calls are recorded so tests can see what the engine passed. */
function fakeMod({ berthCount = 3, plan, level } = {}) {
  const calls = { level: [], plan: [] };
  const defaultPlan = ({ site, level: lv }) => ({
    objects: [obj(`venue:${site.kind}:pad${lv}`, site.rect.x + 1, site.rect.y + 1)],
    nodes: { yard: { tx: site.rect.x + 1, ty: site.rect.y + 1 }, foot: { tx: site.rect.x + 2, ty: site.rect.y + 3 } },
    berths: Array.from({ length: berthCount }, (_, i) => ({ id: `b${i}`, tx: site.rect.x + 1 + i, ty: site.rect.y + site.rect.h - 1, face: 2 })),
  });
  const mod = {
    id: 'test.space', hooks: {},
    represent: { pr: { building: { as: 'lot' }, loading: { as: 'venue', venue: 'spaceport', model: 'rocket' }, merged: { as: 'venue', venue: 'spaceport', model: 'rocket' } } },
    venues: {
      spaceport: {
        level: (load, prev, ctx) => { calls.level.push({ load, prev, ctx }); return Math.max(prev ?? 1, Math.min(3, 1 + Math.floor(load.prs / 2))); },
        plan: (req, ctx) => { calls.plan.push({ req, ctx }); return (plan || defaultPlan)(req, ctx); },
      },
    },
  };
  if (level) mod.venues.spaceport.level = (l, p, c) => { calls.level.push({ load: l, prev: p, ctx: c }); return level(l, p, c); };
  return { mod, calls };
}
const mkWorld = () => ({ grid: new WorldGrid(BOUNDS), objects: new ObjectStore(), venues: {}, lint: [] });
const mkSites = (extra = {}) => ({ venues: { port: { kind: 'spaceport', rect: { ...RECT }, anchor: { tx: 12, ty: 12 } }, ...extra } });
const prs = (n, state = 'loading') => Array.from({ length: n }, (_, i) => ({ id: `alpha#${i + 1}`, project: 'alpha', number: i + 1, title: '', state,
  checks: { passed: 0, failed: 0, pending: 0 }, review: null, size: { additions: 0, deletions: 0, files: 0 } }));
const mkInput = (n = 0, state) => ({ apiVersion: 1, now: 0, seed: 1, agents: [], projects: [], prs: prs(n, state), env: { night: 0, reduceMotion: false, zoom: 1 } });
const ctx = () => ({ rng: () => () => 0.5, hash: s => s.length, time: { now: 0 }, forcedTier: null, forcedStyle: null, parent: null,
  api: { version: 1, has: () => true } });
const lintOf = (ret, world) => [...(Array.isArray(ret) ? ret : ret?.lint || []), ...(world.lint || [])];
const build = (world, sites, input, mod, persisted = {}) => { const ret = V.buildVenues(world, sites, input, mod, persisted, ctx()); return { ret, lint: lintOf(ret, world) }; };

test('P6 venue: a site whose kind has a def becomes world.venues[id] with level, nodes, berths and rect', { skip: NEEDS }, () => {
  const { mod } = fakeMod();
  const world = mkWorld();
  build(world, mkSites(), mkInput(2), mod);
  const v = world.venues.port;
  assert.ok(v, 'world.venues.port exists');
  assert.equal(v.kind, 'spaceport');
  assert.deepEqual(v.rect, RECT);
  assert.ok(Number.isFinite(v.tx) && Number.isFinite(v.ty), 'tx, ty are the venue tile (resolvePlace reads them)');
  assert.equal(typeof v.level, 'number');
  assert.deepEqual(Object.keys(v.nodes).sort(), ['foot', 'yard']);
  assert.deepEqual(v.berths.map(b => b.id), ['b0', 'b1', 'b2']);
  for (const b of v.berths) assert.ok([0, 1, 2, 3].includes(b.face));
});

test('P6 venue: a site whose kind has no def is ignored (no entry, no throw)', { skip: NEEDS }, () => {
  const { mod } = fakeMod();
  const world = mkWorld();
  build(world, mkSites({ odd: { kind: 'unknown-kind', rect: { x: 1, y: 1, w: 3, h: 3 }, anchor: { tx: 1, ty: 1 } } }), mkInput(0), mod);
  assert.equal(world.venues.odd, undefined);
  assert.ok(world.venues.port);
});

test('P6 venue: level(load, prev, ctx) gets the PR load, prev is null on first build and the persisted level after', { skip: NEEDS }, () => {
  const a = fakeMod();
  build(mkWorld(), mkSites(), mkInput(3), a.mod);
  assert.equal(a.calls.level.length, 1);
  assert.equal(a.calls.level[0].load.prs, 3, 'three venue PRs');
  assert.equal(a.calls.level[0].prev, null, 'no persisted level yet');
  assert.equal(typeof a.calls.level[0].ctx.rng, 'function');

  const b = fakeMod({ level: (l, prev) => prev });   // echoes prev, so the world level proves where prev came from
  const world = mkWorld();
  build(world, mkSites(), mkInput(0), b.mod, { venues: { port: { level: 2 } } });
  assert.equal(b.calls.level[0].prev, 2);
  assert.equal(world.venues.port.level, 2);

  // a persisted entry the engine wrote for another kind of venue at this site is not this venue's history
  const c = fakeMod({ level: (l, prev) => prev ?? 1 });
  build(mkWorld(), mkSites(), mkInput(0), c.mod, { venues: { port: { kind: 'harbour', level: 5 } } });
  assert.equal(c.calls.level[0].prev, null);
});

test('P6 venue: plan receives the site and the level the def chose', { skip: NEEDS }, () => {
  const { mod, calls } = fakeMod();
  const world = mkWorld();
  build(world, mkSites(), mkInput(4), mod);
  assert.equal(calls.plan.length, 1);
  assert.equal(calls.plan[0].req.site.kind, 'spaceport');
  assert.deepEqual(calls.plan[0].req.site.rect, RECT);
  assert.equal(calls.plan[0].req.level, world.venues.port.level);
});

test('P6 venue: plan is memoised on kind + level + site rect', { skip: NEEDS }, () => {
  const { mod, calls } = fakeMod();
  build(mkWorld(), mkSites(), mkInput(2), mod);
  build(mkWorld(), mkSites(), mkInput(2), mod);
  assert.equal(calls.plan.length, 1, 'same kind, level and rect: planned once');
  build(mkWorld(), mkSites({ port: { kind: 'spaceport', rect: { ...RECT, x: 12 }, anchor: { tx: 14, ty: 12 } } }), mkInput(2), mod);
  assert.equal(calls.plan.length, 2, 'a different rect is a different key');
  build(mkWorld(), mkSites(), mkInput(8), mod);
  assert.equal(calls.plan.length, 3, 'a different level is a different key');
});

test('P6 venue: planned objects are stamped into the world', { skip: NEEDS }, () => {
  const { mod } = fakeMod();
  const world = mkWorld();
  build(world, mkSites(), mkInput(0), mod);
  const planned = [...world.objects.values()].filter(o => o.kind === 'venue');
  assert.equal(planned.length, 1);
  assert.ok(world.objects.numOf(planned[0].id) >= 1, 'numbered in the store');
});

test('P6 venue: objects outside the site rect are dropped, with lint', { skip: NEEDS }, () => {
  const { mod } = fakeMod({ plan: req => {
    const base = ({ objects: [obj('venue:in', RECT.x + 1, RECT.y + 1), obj('venue:out', 30, 25), obj('venue:edge', RECT.x + RECT.w, RECT.y)],
      nodes: { yard: { tx: RECT.x + 1, ty: RECT.y + 1 } }, berths: [{ id: 'b0', tx: RECT.x + 1, ty: RECT.y + 2, face: 0 }] });
    return base;
  } });
  const world = mkWorld();
  const { lint } = build(world, mkSites(), mkInput(0), mod);
  // (the engine namespaces venue object ids and lints with { kind, reason } records, like every other engine lint;
  // the spec left both open, so objects are found by tile and the lint by its reason)
  const at = (tx, ty) => [...world.objects.values()].some(o => o.kind === 'venue' && o.tx === tx && o.ty === ty);
  assert.ok(at(RECT.x + 1, RECT.y + 1), 'the object inside the rect is stamped');
  assert.ok(!at(30, 25), 'far outside dropped');
  assert.ok(!at(RECT.x + RECT.w, RECT.y), 'one tile past the right edge dropped');
  assert.equal([...world.objects.values()].filter(o => o.kind === 'venue').length, 1);
  assert.ok(lint.length > 0, 'the drop is linted');
  assert.ok(lint.every(l => l && typeof l.reason === 'string'));
});

test('P6 venue: nodes and berths outside the grid bounds are dropped, with lint', { skip: NEEDS }, () => {
  const { mod } = fakeMod({ plan: () => ({ objects: [],
    nodes: { yard: { tx: RECT.x + 1, ty: RECT.y + 1 }, lost: { tx: 500, ty: 500 }, neg: { tx: -3, ty: 2 } },
    berths: [{ id: 'ok', tx: RECT.x + 1, ty: RECT.y + 2, face: 1 }, { id: 'gone', tx: 999, ty: 1, face: 1 }] }) });
  const world = mkWorld();
  const { lint } = build(world, mkSites(), mkInput(0), mod);
  const v = world.venues.port;
  assert.ok(v, 'the venue itself still exists');
  assert.ok(v.nodes.yard);
  assert.equal(v.nodes.lost, undefined);
  assert.equal(v.nodes.neg, undefined);
  assert.deepEqual(v.berths.map(b => b.id), ['ok']);
  assert.ok(lint.length > 0);
});

test('P6 venue: a venue node resolves through resolvePlace("venue:<id>")', { skip: NEEDS }, () => {
  const { mod } = fakeMod();
  const world = mkWorld();
  build(world, mkSites(), mkInput(0), mod);
  const v = world.venues.port;
  // a home to fall back to exists, so a miss would show as `fallback: true`
  world.objects.add({ id: 'lot:a:1', kind: 'building', model: 'x', tx: 0, ty: 0, w: 2, h: 2, z: 10, walk: 'block', styleKey: 's', variant: 0,
    door: { tx: 1, ty: 2, face: 'S' }, data: { owner: 'home', agentId: 'a-1' } });
  const r = resolvePlace('venue:port', { id: 'a-1', agentId: 'a-1' }, world, { homeOf: id => (id === 'a-1' ? 'lot:a:1' : null) });
  assert.ok(r && !r.fallback, 'resolved, not a fallback');
  assert.equal(r.tx, v.tx);
  assert.equal(r.ty, v.ty);
});

test('P6 venue: building twice from the same input gives identical venues (pure and deterministic)', { skip: NEEDS }, () => {
  const w1 = mkWorld(), w2 = mkWorld();
  build(w1, mkSites(), mkInput(3), fakeMod().mod);
  build(w2, mkSites(), mkInput(3), fakeMod().mod);
  assert.deepEqual(JSON.parse(JSON.stringify(w1.venues)), JSON.parse(JSON.stringify(w2.venues)));
});

test('P6 venue: a frozen mod (the registry deep-freezes mod.venues) still builds', { skip: NEEDS }, () => {
  const { mod } = fakeMod();
  Object.freeze(mod.venues.spaceport); Object.freeze(mod.venues); Object.freeze(mod.represent);
  const world = mkWorld();
  build(world, mkSites(), mkInput(1), mod);
  assert.ok(world.venues.port);
});

// ---------------------------------------------------------------- assignBerths (per poll, no rebuild)

const BERTHS = [0, 1, 2].map(i => ({ id: `b${i}`, tx: 11 + i, ty: 15, face: 2 }));
const venueOf = () => ({ kind: 'spaceport', tx: 12, ty: 12, rect: RECT, level: 1, nodes: {}, berths: BERTHS });
// assignBerths takes PR specs in priority order as { id, spec: PrSpec } (what prSpecsOf returns; the spec left the shape open)
const spec = id => ({ id, spec: { as: 'venue', venue: 'spaceport', model: 'rocket' } });

test('P6 venue: assignBerths gives each venue PR its own berth', { skip: NEEDS_ASSIGN }, () => {
  const out = V.assignBerths(venueOf(), [spec('alpha#1'), spec('alpha#2')], {});
  assert.ok(isRecord(out), 'a prId -> berthId record');
  const ids = Object.keys(out).sort();
  assert.deepEqual(ids, ['alpha#1', 'alpha#2']);
  assert.notEqual(out['alpha#1'], out['alpha#2']);
  for (const b of Object.values(out)) assert.ok(BERTHS.some(x => x.id === b));
});

test('P6 venue: assignBerths is stable across polls (a PR keeps its berth when others come and go)', { skip: NEEDS_ASSIGN }, () => {
  const v = venueOf();
  const first = V.assignBerths(v, [spec('alpha#1'), spec('alpha#2')], {});
  const again = V.assignBerths(v, [spec('alpha#1'), spec('alpha#2')], first);
  assert.deepEqual(again, first, 'unchanged input, unchanged berths');

  // alpha#1 leaves, alpha#0 (sorts first) and alpha#3 arrive: alpha#2 must not move
  const later = V.assignBerths(v, [spec('alpha#0'), spec('alpha#2'), spec('alpha#3')], first);
  assert.equal(later['alpha#2'], first['alpha#2'], 'alpha#2 kept its berth');
  assert.equal(later['alpha#1'], undefined, 'a departed PR holds nothing');
  const used = Object.values(later);
  assert.equal(new Set(used).size, used.length, 'no berth is shared');
});

test('P6 venue: assignBerths never invents a berth: surplus PRs wait without one', { skip: NEEDS_ASSIGN }, () => {
  const out = V.assignBerths(venueOf(), ['a', 'b', 'c', 'd', 'e'].map(n => spec(`alpha#${n}`)), {});
  const used = Object.values(out);
  assert.ok(used.length <= BERTHS.length);
  assert.equal(new Set(used).size, used.length);
});

test('P6 venue: assignBerths ignores a stale prev entry that points at a berth the venue no longer has', { skip: NEEDS_ASSIGN }, () => {
  const out = V.assignBerths(venueOf(), [spec('alpha#1')], { 'alpha#1': 'b-removed' });
  assert.ok(BERTHS.some(b => b.id === out['alpha#1']), 'reassigned to a real berth');
});

test('P6 venue: assignBerths does not mutate its inputs', { skip: NEEDS_ASSIGN }, () => {
  const v = venueOf(), prev = { 'alpha#1': 'b1' }, specs = [spec('alpha#1')];
  const snap = JSON.stringify([v, prev, specs]);
  V.assignBerths(v, specs, prev);
  assert.equal(JSON.stringify([v, prev, specs]), snap);
});
