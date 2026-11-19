import './support/ensure-mods-index.mjs';
// M5 P1: the harbour's data path and plan. The host adapter (web/src/engine-host/dock-input.js dockPrs), the additive
// venue API (world/venue.js: load.merged/rank, shrinkAfterMs hold, deck stamping, assign's 5th argument, LEVEL_MAX) and
// the fantasy harbour (mods/agentville.fantasy/{venues,represent-pr}.js, layout/dock.js). Synthetic data and the
// e2e/fixtures/engine fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { dockPrs, prNumberOf, projectOf } = await import('../web/src/engine-host/dock-input.js');
const { buildVenues, venueSig, venueAssignments, assignBerths, loadOf, historyOf, LEVEL_MAX } = await import('../web/src/engine/world/venue.js');
const { VENUES, levelOf, decodeLevel, harbourGeom, SHRINK_MS, PIER_ID } = await import('../mods/agentville.fantasy/venues.js');
const { shipClass } = await import('../mods/agentville.fantasy/represent-pr.js');
const { DOCK_REACH } = await import('../mods/agentville.fantasy/layout/dock.js');
const { resolveMod, modCtx } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { viewFromFixture, makeView } = await import('../web/src/engine/snapshot.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { createNav } = await import('../web/src/engine/nav/index.js');
const { WorldGrid, LAYOUT_GROUND, ROAD } = await import('../web/src/engine/core/grid.js');
const { ObjectStore } = await import('../web/src/engine/core/objects.js');

const fantasy = () => resolveMod('agentville.fantasy');
const fixture = n => JSON.parse(fs.readFileSync(new URL(`../e2e/fixtures/engine/${n}.json`, import.meta.url), 'utf8'));
const MIN = 60e3;
const H = VENUES.harbour;
const SITE = { kind: 'harbour', rect: { x: 0, y: 0, w: 90, h: 50 }, anchor: { tx: 40, ty: 10 }, data: { cx: 40, foot: 10, sea: 11 } };
const pr = (n, state, size = { additions: 0, deletions: 0, files: 0 }) => ({ id: `p#${n}`, project: 'p', number: n, title: '', state,
  checks: { passed: 0, failed: 0, pending: 0 }, review: null, size });
const world = () => ({ grid: new WorldGrid({ ox: 0, oy: 0, w: 100, h: 60 }), objects: new ObjectStore() });
const ctxAt = now => ({ time: { now } });

// ---------------------------------------------------------------- dockPrs (host adapter)

const dockView = dock => makeView({ agents: [{ id: 'srv-1', project: 'amber', bucket: 'building' }], projects: [], dock }, { now: 1, demo: true });

test('dockPrs: loading -> loading PRs with checks/review/size, sailed -> merged; ids <project>#<n>; totals', () => {
  const view = dockView({
    loading: [
      { href: 'https://github.com/o/amber/pull/7', id: 7, repo: 'o/amber', agentId: 'srv-1', agentName: 'Mira', state: 'open',
        checks: { passed: 3, failed: 1, pending: 2 }, review: 'approved', since: 5, size: { additions: 10, deletions: 2, files: 1 } },
      { href: 'https://github.com/o/birch/pull/12', checks: {}, review: 'weird', since: 6 },
    ],
    sailed: [{ href: 'https://github.com/o/amber/pull/5', id: 5, repo: 'o/amber', agentId: 'gone', at: 9 }],
    total: 42, level: 3,
  });
  const r = dockPrs(view);
  assert.equal(r.merged, 42); assert.equal(r.rank, 3);
  assert.deepEqual(r.prs.map(p => [p.id, p.state]), [['amber#7', 'loading'], ['birch#12', 'loading'], ['amber#5', 'merged']]);
  const a = r.prs[0];
  assert.deepEqual(a, { id: 'amber#7', project: 'amber', number: 7, title: '', state: 'loading', checks: { passed: 3, failed: 1, pending: 2 },
    review: 'approved', size: { additions: 10, deletions: 2, files: 1 } });
  assert.equal(r.prs[1].review, null, 'an unknown review is null');
  assert.deepEqual(r.prs[1].size, { additions: 0, deletions: 0, files: 0 }, 'no size: zeros (the represent rule reads all zeros as unknown: a cutter)');
});

test('dockPrs: no href, URL, agent id or name, or time ever passes on', () => {
  const view = viewFromFixture(fixture('harbour-6'));
  const blob = JSON.stringify(dockPrs(view, toWorldInput(view).input.prs));
  assert.ok(!/https?:|\/pull\/|example\.invalid|"href"|"since"|"at"|agent/i.test(blob), blob.slice(0, 200));
  const v2 = dockView({ loading: [{ href: 'https://github.com/o/amber/pull/1', agentId: 'srv-1', agentName: 'SECRET-NAME', id: 1 }], sailed: [] });
  const s = JSON.stringify(dockPrs(v2));
  assert.ok(!s.includes('SECRET-NAME') && !s.includes('srv-1'));
});

test('dockPrs over base PRs: the dock state wins, a building PR keeps live: true, base order kept, base not mutated', () => {
  const view = dockView({ loading: [{ href: 'https://github.com/o/amber/pull/2', agentId: 'srv-1', id: 2, checks: { passed: 1 }, size: { additions: 900 } }],
    sailed: [{ href: 'https://github.com/o/amber/pull/1', agentId: 'srv-1', id: 1 }, { href: 'https://github.com/o/amber/pull/2', agentId: 'srv-1', id: 2 }],
    total: 3, level: 1 });
  const base = Object.freeze([1, 2, 3].map(n => Object.freeze({ ...pr(n, n === 3 ? 'merged' : 'building'), id: `amber#${n}`, project: 'amber', title: `T${n}` })));
  const r = dockPrs(view, base);
  assert.deepEqual(r.prs.map(p => [p.id, p.state, p.live]), [['amber#1', 'merged', true], ['amber#2', 'loading', true], ['amber#3', 'merged', undefined]]);
  assert.equal(r.prs[1].title, 'T2', 'the base title stays');
  assert.equal(r.prs[1].size.additions, 900); assert.equal(r.prs[1].checks.passed, 1);
  assert.equal(base[1].state, 'building', 'base untouched');
});

test('dockPrs: PR number from id or href, project from the agent, else the repo; entries without a number are skipped', () => {
  assert.equal(prNumberOf({ id: 4 }), 4); assert.equal(prNumberOf({ id: '9' }), 9);
  assert.equal(prNumberOf({ href: 'https://x/y/z/pull/77#c' }), 77); assert.equal(prNumberOf({ href: 'nope' }), null);
  const view = dockView({});
  assert.equal(projectOf({ agentId: 'srv-1', repo: 'o/other' }, view), 'amber');
  assert.equal(projectOf({ repo: 'o/other' }, view), 'other');
  assert.equal(projectOf({ href: 'https://example.invalid/harb/pull/1' }, view), 'harb');
  assert.equal(projectOf({}, view), '—');
  assert.deepEqual(dockPrs(dockView({ loading: [{ href: 'x' }, null, 5], sailed: 'bad' })).prs, []);
  assert.deepEqual(dockPrs({}), { prs: [], merged: 0, rank: 0 });
});

// ---------------------------------------------------------------- represent: ship class by size

test('ship class: < 50 lines dinghy, > 500 lines or > 20 files brig, else cutter (the vessel prop classes)', () => {
  const c = (a, d, f) => shipClass({ additions: a, deletions: d, files: f });
  assert.deepEqual([c(10, 39, 1), c(25, 25, 1), c(300, 200, 20), c(300, 201, 1), c(1, 1, 21), c(0, 0, 0), c(0, 0, 1)], ['dinghy', 'cutter', 'cutter', 'brig', 'brig', 'cutter', 'dinghy']);
});

// ---------------------------------------------------------------- level: lifetime floor + rank, engine shrink hold

test('load carries WorldInput.history as merged/rank (0 when absent or bad)', () => {
  assert.deepEqual(historyOf({ history: { merged: 12, rank: 3 } }), { merged: 12, rank: 3 });
  assert.deepEqual(historyOf({ history: { merged: -1, rank: 2.5 } }), { merged: 0, rank: 0 });
  assert.deepEqual(historyOf({}), { merged: 0, rank: 0 });
  const l = loadOf([], 'harbour', { merged: 5, rank: 2 });
  assert.equal(l.merged, 5); assert.equal(l.rank, 2);
  assert.equal(loadOf([], 'harbour').merged, 0);
  assert.equal(LEVEL_MAX, 63);
});

test('harbour level packs tier and rank; tier = max(loading tier, lifetime tier)', () => {
  for (let t = 1; t <= 4; t++) for (let r = 1; r <= 5; r++) assert.deepEqual(decodeLevel(levelOf(t, r)), { tier: t, rank: r });
  const L = (loading, merged, rank) => decodeLevel(H.level({ prs: loading, states: { building: 0, loading, merged: 0, closed: 0 }, merged, rank }, null));
  assert.deepEqual(L(0, 130, 4), { tier: 4, rank: 4 });
  assert.deepEqual(L(13, 0, 1), { tier: 4, rank: 1 });
  assert.deepEqual(L(5, 40, 2), { tier: 3, rank: 2 });
  assert.ok(levelOf(4, 5) <= LEVEL_MAX);
});

/** One harbour venue, driven poll by poll the way index.js does: venueSig each poll, a rebuild when the sig changes. */
function driver(mod = fantasy()) {
  const w = world(), persisted = {};
  let sig = null;
  const poll = (loading, now, history = { merged: 0, rank: 1 }) => {
    const input = { prs: Array.from({ length: loading }, (_, i) => pr(i + 1, 'loading')), history };
    const ctx = ctxAt(now), s = venueSig(input, mod, persisted, ctx);
    if (s !== sig) { const w2 = world(); buildVenues(w2, { venues: { dock: SITE } }, input, mod, persisted, ctx, { seed: 1 }); sig = venueSig(input, mod, persisted, ctx); Object.assign(w, w2); }
    return decodeLevel(w.venues.dock.level).tier;
  };
  return { poll, persisted };
}

test('shrink hold: grows at once; the loading part shrinks only after more than 10 minutes low (classic oracle timings)', () => {
  const d = driver();
  assert.equal(d.poll(13, 0), 4, 'grows at once');
  assert.equal(d.poll(1, 1 * MIN), 4, 'first low reading starts the clock');
  assert.equal(d.persisted.venues.dock.low, 1 * MIN, 'the low-since time is persisted');
  assert.equal(d.poll(1, 10 * MIN), 4, 'still held at 9 min of low');
  assert.equal(d.poll(1, 11 * MIN + 1), 1, 'shrinks once low longer than 10 min');
  assert.equal(d.persisted.venues.dock.low, undefined, 'clock cleared');
  // a busy poll in between resets the clock
  const e = driver();
  e.poll(13, 0); e.poll(1, MIN); e.poll(13, 5 * MIN);
  assert.equal(e.poll(1, 6 * MIN), 4);
  assert.equal(e.poll(1, 15 * MIN), 4, 'clock restarted at 6 min: 9 min is not enough');
  assert.equal(e.poll(1, 16 * MIN + 1), 1);
});

test('shrink hold: never below the lifetime floor; loading only grows it', () => {
  const d = driver(), hist = { merged: 10, rank: 1 };
  assert.equal(d.poll(13, 0, hist), 4);
  d.poll(0, MIN, hist);
  assert.equal(d.poll(0, 20 * MIN, hist), 2, 'back to the floor (lifetime 10 -> tier 2), not tier 1');
  assert.equal(d.poll(0, 5 * 60 * MIN, hist), 2, 'and it stays there');
  const e = driver();
  assert.equal(e.poll(0, 0, { merged: 120, rank: 5 }), 4);
  assert.equal(e.poll(0, 999 * MIN, { merged: 120, rank: 5 }), 4);
});

test('shrink hold is opt-in: a def without shrinkAfterMs drops at once, as before; no clock -> no hold', () => {
  const base = fantasy();
  const mod = { ...base, venues: { harbour: { level: H.level, plan: H.plan } } };
  const d = driver(mod);
  assert.equal(d.poll(13, 0), 4);
  assert.equal(d.poll(1, MIN), 1);
  const w = world(), persisted = { venues: { dock: { kind: 'harbour', level: 4 } } };
  buildVenues(w, { venues: { dock: SITE } }, { prs: [] }, base, persisted, {}, { seed: 1 });
  assert.equal(w.venues.dock.level, 1, 'no ctx.time: the lower level is taken');
});

// ---------------------------------------------------------------- plan: what stands where, by tier and rank

const planAt = (tier, rank = 1) => H.plan({ site: SITE, level: levelOf(tier, rank) });
const models = p => p.objects.reduce((m, o) => ((m[o.model] = (m[o.model] || 0) + 1), m), {});

test('[har.cranes] [har.crate-yard] [har.beacon] plan by tier: quay from 2, breakwater + lighthouse + beacon from 3, buoys at 2+, cranes per pier', () => {
  const m = [1, 2, 3, 4].map(t => models(planAt(t)));
  assert.deepEqual(m.map(x => x.pier > 0), [true, true, true, true]);
  assert.deepEqual(m.map(x => x.quay || 0), [0, 1, 1, 1]);
  assert.deepEqual(m.map(x => x.lighthouse || 0), [0, 0, 1, 1]);
  assert.deepEqual(m.map(x => x.beacon || 0), [0, 0, 1, 1]);
  assert.deepEqual(m.map(x => x.breakwater || 0), [0, 0, 3, 3]);
  assert.deepEqual(m.map(x => x.crane || 0), [0, 2, 4, 5], 'tier 2: the side piers; tier 3+: every pier (classic G.cranes)');
  assert.deepEqual(m.map(x => (x.buoy || 0) > 0), [false, true, true, true]);
  assert.deepEqual(m.map(x => x.crates || 0), [0, 3, 3, 3], 'the crate yard comes with the quay');
  assert.deepEqual(m.map(x => x.skiff || 0), [1, 0, 0, 0]);
});

test('[har.level-touches] [har.warehouses] plan by rank: pier-head lamps 2+, warehouse 3+, tier-1 crane 4+, flag and second lamps 5', () => {
  const m = (t, r) => models(planAt(t, r));
  assert.equal(m(1, 1).lamp || 0, 0); assert.equal(m(1, 2).lamp, 1); assert.equal(m(1, 5).lamp, 2);
  assert.equal(m(1, 2).warehouse || 0, 0); assert.equal(m(1, 3).warehouse, 1);
  assert.equal(m(1, 3).crane || 0, 0); assert.equal(m(1, 4).crane, 1);
  assert.equal(m(1, 4).banner || 0, 0); assert.equal(m(1, 5).banner, 1); assert.equal(m(3, 5).banner, 1);
  assert.equal(m(2, 2).warehouse || 0, 0); assert.equal(m(2, 3).warehouse, 1, 'tier 2: one warehouse from rank 3');
  assert.ok(m(3, 1).warehouse >= 3, 'tier 3: a row of warehouses');
});

test('[har.beacon] plan geometry: the lighthouse at the breakwater tip, the beacon on the east mole, anchorage outside the breakwater', () => {
  const p = planAt(4), G = harbourGeom(SITE.data, levelOf(4)), at = id => p.objects.find(o => o.id === id);
  assert.deepEqual([at('lighthouse').tx, at('lighthouse').ty], [G.bw.tip, G.bw.yb]);
  assert.deepEqual([at('beacon').tx, at('beacon').ty], [G.bw.xe, G.bw.yb + 1]);
  const anchors = p.berths.filter(b => !PIER_ID.test(b.id));
  assert.ok(anchors.length >= 4 && anchors.every(b => b.ty > G.bw.yb), 'the overflow rides at anchor beyond the breakwater');
  assert.ok(G.bw.xw < G.xmin && G.bw.xe > G.xmax && G.bw.yb > G.tail, 'the breakwater wraps the piers');
  assert.ok(p.nodes.mouth && p.nodes.offing && p.nodes.tug, 'sail-out course and tug nodes');
  assert.equal(G.bw.yb + 8, p.nodes.offing.ty);
  assert.ok(p.nodes.offing.ty <= SITE.data.sea + DOCK_REACH, 'the offing is inside the site reach');
});

test('plan: decks are walk floor + deck: true; every pier berth has a deck node on a deck', () => {
  for (let t = 1; t <= 4; t++) {
    const p = planAt(t), decks = p.objects.filter(o => o.deck);
    assert.ok(decks.length && decks.every(o => o.walk === 'floor'));
    assert.deepEqual([...new Set(decks.map(o => o.model))].sort(), t >= 2 ? ['pier', 'quay'] : ['pier']);
    const on = (n) => decks.some(o => n.tx >= o.tx && n.tx < o.tx + o.w && n.ty >= o.ty && n.ty < o.ty + o.h);
    for (const b of p.berths.filter(b => PIER_ID.test(b.id))) assert.ok(on(p.nodes[`deck-${b.id}`]), `deck-${b.id} stands on a deck`);
  }
});

// ---------------------------------------------------------------- berths: overflow at anchor, brigs on heads, merged none

test('assign: overflow at anchor, brigs on pier heads, stable, the 5th argument carries model and state', () => {
  const mod = fantasy(), berths = planAt(2).berths, nPier = berths.filter(b => PIER_ID.test(b.id)).length;
  const specs = Array.from({ length: nPier + 3 }, (_, i) => ({ id: `p#${i}`, state: 'loading', spec: { as: 'venue', venue: 'harbour', model: i === 5 ? 'brig' : 'cutter' } }));
  const a = assignBerths({ id: 'dock', kind: 'harbour', berths }, specs, {}, { mod });
  assert.equal(Object.keys(a).length, specs.length);
  // the brig holds a pier head and the berth inside it (two pier berths), so one more ship than the 3 extra lies at anchor
  assert.equal(Object.values(a).filter(b => !PIER_ID.test(b)).length, 4, 'the overflow is at anchor');
  const heads = new Set(berths.filter(b => PIER_ID.test(b.id) && !berths.some(o => PIER_ID.test(o.id) && o.tx === b.tx && o.ty > b.ty)).map(b => b.id));
  assert.ok(heads.has(a['p#5']), 'the brig is on a pier head');
  assert.deepEqual(assignBerths({ id: 'dock', kind: 'harbour', berths }, specs, a, { mod }), a, 'stable across polls');
  // the info argument
  let seen = null;
  const spy = { ...mod, venues: { harbour: { ...H, assign: (ids, b, prev, ctx, info) => { seen = info; return {}; } } } };
  assignBerths({ id: 'dock', kind: 'harbour', berths }, specs.slice(0, 2), {}, { mod: spy });
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), { 'p#0': { model: 'cutter', state: 'loading' }, 'p#1': { model: 'cutter', state: 'loading' } });
  assert.ok(Object.isFrozen(seen) && Object.isFrozen(seen['p#0']));
});

test('venueAssignments: merged PRs take no berth; a loading PR gets its class as the model', () => {
  const mod = fantasy(), w = world(), persisted = {};
  const input = { prs: [pr(1, 'merged'), pr(2, 'loading', { additions: 900, deletions: 0, files: 1 }), pr(3, 'loading'), pr(4, 'building')] };
  buildVenues(w, { venues: { dock: SITE } }, input, mod, persisted, ctxAt(0), { seed: 1 });
  const a = venueAssignments(w, input, mod, persisted, ctxAt(0));
  assert.deepEqual(Object.keys(a.prs).sort(), ['p#2', 'p#3']);
  assert.equal(a.prs['p#2'].model, 'brig'); assert.equal(a.prs['p#3'].model, 'cutter');
  assert.ok(PIER_ID.test(a.prs['p#2'].berth));
});

// ---------------------------------------------------------------- deck stamping (engine)

test('deck: true makes the footprint walkable ground + path road; only on walk floor objects; existing ground stays', () => {
  const plan = () => ({ objects: [
    { id: 'd', kind: 'venue', model: 'pier', tx: 3, ty: 3, w: 2, h: 2, walk: 'floor', deck: true },
    { id: 'x', kind: 'prop', model: 'crane', tx: 8, ty: 8, walk: 'block', deck: true },
    { id: 'f', kind: 'prop', model: 'lamp', tx: 9, ty: 3, walk: 'floor' },
  ], nodes: {}, berths: [] });
  const mod = { venues: { k: { level: () => 1, plan } } };
  const w = world();
  w.grid.set('ground', 4, 4, 7); w.grid.set('road', 4, 4, ROAD.STREET);
  const { lint } = buildVenues(w, { venues: { v: { kind: 'k', rect: { x: 0, y: 0, w: 20, h: 20 }, anchor: { tx: 1, ty: 1 } } } }, { prs: [] }, mod, {}, {});
  assert.equal(lint.length, 1); assert.match(lint[0].reason, /deck must be true on a walk 'floor' object/);
  assert.equal(w.objects.has('venue:v:x'), false);
  assert.deepEqual([w.grid.get('ground', 3, 3), w.grid.get('road', 3, 3)], [LAYOUT_GROUND.VENUE, ROAD.PATH]);
  assert.deepEqual([w.grid.get('ground', 4, 4), w.grid.get('road', 4, 4)], [7, ROAD.STREET], 'what the layout set stays');
  assert.deepEqual([w.grid.get('ground', 9, 3), w.grid.get('road', 9, 3)], [0, 0], 'no deck, no ground');
});

// ---------------------------------------------------------------- the real world: fixtures, site rect, nav

function realWorld(name, history) {
  const fx = fixture(name), view = viewFromFixture(fx), { input } = toWorldInput(view, { seed: 7, salt: '7' });
  const d = dockPrs(view, input.prs);
  const inp = { ...input, prs: d.prs, history: history ?? { merged: d.merged, rank: d.rank } };
  return buildWorld(inp, { v: 1, seed: 7, blocks: {}, lots: {} }, { mod: fantasy(), now: fx.now, seed: 7 });
}

test('[har.cove-reserved-tier4] fixtures: the harbour of every tier fits its site (no venue lint) and porters reach every pier berth from the square', () => {
  for (const [name, hist, tier] of [['harbour-3', { merged: 0, rank: 1 }, 1], ['harbour-6', { merged: 0, rank: 2 }, 2], ['harbour-10', { merged: 0, rank: 3 }, 3], ['harbour', null, 4]]) {
    const w = realWorld(name, hist), v = w.venues.dock;
    assert.equal(decodeLevel(v.level).tier, tier, `${name}: tier`);
    assert.deepEqual(w.lint.filter(l => String(l.kind).startsWith('venue')), [], `${name}: no venue lint`);
    const nav = createNav(w), sq = w.square, from = { x: sq.x + (sq.w >> 1) + 0.5, y: sq.y + (sq.h >> 1) + 0.5 };
    const decks = Object.entries(v.nodes).filter(([k]) => k.startsWith('deck-'));
    assert.equal(decks.length, v.berths.filter(b => PIER_ID.test(b.id)).length);
    for (const [k, n] of [...decks, ['yard', v.nodes.yard]]) assert.ok(nav.path(from, { x: n.tx + 0.5, y: n.ty + 0.5 }), `${name}: ${k} reachable`);
  }
});

test('fixtures: loading PRs berth at the harbour, sailed ones do not', () => {
  const fx = fixture('harbour-6'), view = viewFromFixture(fx), { input } = toWorldInput(view, { seed: 7, salt: '7' });
  const d = dockPrs(view, input.prs), inp = { ...input, prs: d.prs, history: { merged: d.merged, rank: d.rank } };
  const P = { v: 1, seed: 7, blocks: {}, lots: {} }, mod = fantasy();
  const w = buildWorld(inp, P, { mod, now: fx.now, seed: 7 });
  const a = venueAssignments(w, inp, mod, P, modCtx(mod, { seed: 7, now: fx.now, projectKey: '' }));
  const loading = d.prs.filter(p => p.state === 'loading').map(p => p.id).sort();
  assert.deepEqual(Object.keys(a.prs).sort(), loading);
  assert.ok(Object.values(a.prs).some(x => x.model === 'brig'), 'the 1270-line PR is a brig');
});
