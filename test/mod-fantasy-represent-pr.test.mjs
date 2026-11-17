import './support/ensure-mods-index.mjs';
// The fantasy mod's PR representation and harbour venue (mods/agentville.fantasy/{represent-pr,venues}.js), through the
// engine seams (sim/represent-world.js, world/venue.js). Split from mod-fantasy-represent.test.mjs so the behaviour
// table and the PR representation have separate owners. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
const { REPRESENT } = await import('../mods/agentville.fantasy/represent-pr.js');
const { REPRESENT: REEXPORTED } = await import('../mods/agentville.fantasy/represent.js');
const { VENUES, tierFor, levelOf, decodeLevel, MOOR_FACE } = await import('../mods/agentville.fantasy/venues.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { representPr, prView, cleanPrTitle } = await import('../web/src/engine/sim/represent-world.js');
const { buildVenues, venueAssignments, venueSig } = await import('../web/src/engine/world/venue.js');
const { resolvePlace } = await import('../web/src/engine/sim/represent.js');
const { WorldGrid } = await import('../web/src/engine/core/grid.js');
const { ObjectStore } = await import('../web/src/engine/core/objects.js');
const { canaryView, CANARIES, RAW_IDS } = await import('./mod-support/views.mjs');

function noFunctions(v, path = '') {
  assert.notEqual(typeof v, 'function', path);
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) noFunctions(x, `${path}.${k}`);
}
const fantasy = () => resolveMod('agentville.fantasy');
const pr = (n, state, over = {}) => ({ id: `alpha#${n}`, project: 'alpha', number: n, title: '', state,
  checks: { passed: 0, failed: 0, pending: 0 }, review: null, size: { additions: 0, deletions: 0, files: 0 }, ...over });

test('REPRESENT.pr is a function of the PR view (M5: ship class by size); represent.js re-exports the same object', () => {
  assert.equal(typeof REPRESENT.pr, 'function');
  assert.deepEqual(Object.keys(REPRESENT), ['pr']);
  assert.equal(REEXPORTED, REPRESENT, 'represent.js re-exports the same object');
});

test('PRs: building is a lot, loading is a ship at the harbour by size, merged and closed are not shown', () => {
  const mod = fantasy(), lint = [];
  const size = (additions, deletions, files) => ({ size: { additions, deletions, files } });
  assert.deepEqual({ ...representPr(pr(1, 'building'), mod, { lint }) }, { as: 'lot' });
  assert.deepEqual({ ...representPr(pr(2, 'loading'), mod, { lint }) }, { as: 'venue', venue: 'harbour', model: 'cutter', flag: '#f4efe4', load: 0 },
    'no size yet: a cutter (classic: no size -> sloop); no checks yet: a cream pennant, nothing stowed (the pennant and cargo: test/engine-harbour-ui.test.mjs)');
  assert.equal(representPr(pr(2, 'loading', size(25, 24, 1)), mod).model, 'dinghy', '< 50 lines: a dinghy');
  assert.equal(representPr(pr(2, 'loading', size(25, 25, 1)), mod).model, 'cutter', '50 lines: a cutter');
  assert.equal(representPr(pr(2, 'loading', size(300, 200, 20)), mod).model, 'cutter', '500 lines, 20 files: still a cutter');
  assert.equal(representPr(pr(2, 'loading', size(300, 201, 1)), mod).model, 'brig', '> 500 lines: a brig');
  assert.equal(representPr(pr(2, 'loading', size(1, 1, 21)), mod).model, 'brig', '> 20 files: a brig');
  assert.deepEqual({ ...representPr(pr(2, 'merged'), mod, { lint }) }, { as: 'none' }, 'a merged PR has sailed: no ship, no berth');
  assert.deepEqual({ ...representPr(pr(3, 'closed'), mod, { lint }) }, { as: 'none' });
  assert.deepEqual(lint, [], 'the fantasy function lints clean');
  assert.equal(typeof mod.venues.harbour.plan, 'function', 'the harbour is a venue kind of the resolved mod');
});

// ---------------------------------------------------------------- privacy: titles yes, URLs/paths/conversation text never

test('canary: a represent.pr function sees no URL, path, conversation text or server id', () => {
  const { view } = canaryView();
  const { input } = toWorldInput(view, { seed: 3, salt: 's' });
  assert.ok(input.prs.length >= 2, 'the canary view has PRs');
  const seen = [];
  const mod = { venues: {}, represent: { pr: (v, ctx) => { seen.push({ v, keys: Object.keys(ctx || {}) }); return { as: 'none' }; } } };
  // the WorldInput PRs, plus the same PRs with hostile extra fields and a hostile title, as if the input grew them
  const hostile = input.prs.map(p => ({ ...p, href: 'https://canary.example/CANARY-HREF', url: 'https://canary.example', cwd: '/Users/canary-home/CANARY-CWD',
    text: 'CANARY-TEXT', ask: 'CANARY-ASK', transcript: 'CANARY-TRANSCRIPT', serverId: RAW_IDS[0],
    title: 'Fix login https://canary.example/CANARY-HREF in /Users/canary-home/CANARY-CWD/x.js\nCANARY-TEXT CANARY-TRANSCRIPT' }));
  for (const p of [...input.prs, ...hostile]) representPr(p, mod, { lint: [] });
  assert.equal(seen.length, input.prs.length * 2);
  const s = JSON.stringify(seen);
  for (const c of CANARIES) assert.ok(!s.includes(c), `leaked canary ${c}`);
  for (const id of RAW_IDS) assert.ok(!s.includes(id), `leaked raw id ${id}`);
  assert.ok(!/https?:/.test(s) && !/\/Users\//.test(s));
  for (const { v, keys } of seen) {
    assert.deepEqual(Object.keys(v).sort(), ['checks', 'id', 'number', 'project', 'review', 'size', 'state', 'title']);
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.checks) && Object.isFrozen(v.size));
    assert.ok(!keys.includes('lint'), 'the engine lint sink is not passed to the mod');
  }
  assert.equal(seen[input.prs.length].v.title, 'Fix login in', 'the safe words of a title survive');
});

test('PR titles: first line only, URLs and paths cut, short', () => {
  assert.equal(cleanPrTitle('Add widget'), 'Add widget');
  assert.equal(cleanPrTitle('see www.example.com/x and C:\\Users\\x\\y now'), 'see and now');
  assert.equal(cleanPrTitle('a/b testing ./src/x.js ~/notes'), 'a/b testing');
  assert.equal(cleanPrTitle(42), '');
  assert.ok([...cleanPrTitle('x'.repeat(500))].length <= 80);
  assert.equal(prView({ title: 'ok', state: 'weird', review: 'nope' }).state, 'building');
});

// ---------------------------------------------------------------- the harbour venue

test('harbour level: the classic tier rule, the lifetime floor, the rank packed in; shrinking is the engine\'s hold', () => {
  const { level, shrinkAfterMs } = VENUES.harbour;
  const L = (loading, prev = null, extra = {}) => level({ prs: loading, states: { building: 0, loading, merged: 0, closed: 0 }, ...extra }, prev);
  assert.deepEqual([0, 3, 4, 7, 8, 12, 13, 99].map(n => tierFor(n)), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(L(0), 1); assert.equal(L(13), 4);
  assert.equal(L(13, 1), 4, 'grows at once');
  assert.equal(L(5, 3), 2, 'the want, lower than prev: the engine holds it shrinkAfterMs');
  assert.equal(shrinkAfterMs, 10 * 60e3);
  assert.equal(level({ prs: 20 }, null), 4, 'without states, all PRs count');
  assert.deepEqual([0, 9, 10, 39, 40, 119, 120].map(m => L(0, null, { merged: m })), [1, 1, 2, 2, 3, 3, 4], 'lifetime floor 10/40/120');
  assert.equal(L(13, null, { merged: 10 }), 4, 'loading grows it past the floor');
  assert.equal(L(0, 4, { merged: 40 }), 3, 'never below the floor');
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(r => L(0, null, { rank: r })), [1, 5, 9, 13, 17, 17], 'rank r adds 4 (r - 1), up to 5');
  assert.deepEqual(decodeLevel(L(5, null, { rank: 3 })), { tier: 2, rank: 3 });
  assert.equal(L(0, levelOf(3, 2), { rank: 3 }), levelOf(3, 3), 'a rank step while the tier would drop keeps the tier (the drop waits its turn)');
});

const SITE = { kind: 'harbour', rect: { x: 20, y: 40, w: 60, h: 30 }, anchor: { tx: 50, ty: 42 }, data: { cx: 50, foot: 42, sea: 43 } };

test('harbour plan: piers, bollards; nodes foot, yard, a deck node per pier berth; unique berths in the water, main pier first, anchor last', () => {
  for (const lv of [1, 2, 3, 4]) {
    const p = VENUES.harbour.plan({ site: SITE, level: lv });
    assert.ok(p.objects.some(o => o.model === 'pier') && p.objects.some(o => o.model === 'bollard'), 'the harbour has its art');
    assert.deepEqual(p.nodes.foot, { tx: 50, ty: 42 });
    assert.deepEqual(p.nodes.yard, lv >= 2 ? { tx: 53, ty: 41 } : { tx: 50, ty: 42 });
    assert.equal(new Set(p.berths.map(b => b.id)).size, p.berths.length);
    for (const b of p.berths) assert.ok(b.ty > SITE.data.sea && b.face === MOOR_FACE);   // along the pier, bow out to sea
    assert.ok(p.berths[0].tx === 49 && p.berths[1].tx === 49, 'main pier, west side first');
    const pier = p.berths.filter(b => /^p\d/.test(b.id)), first = p.berths.findIndex(b => !/^p\d/.test(b.id));
    assert.equal(first, pier.length, 'berths at anchor come after every pier berth');
    for (const b of pier) assert.ok(p.nodes[`deck-${b.id}`], `${b.id} has a deck node`);
  }
  assert.deepEqual([1, 2, 3, 4].map(lv => VENUES.harbour.plan({ site: SITE, level: lv }).berths.filter(b => /^p\d/.test(b.id)).length), [4, 12, 16, 30]);
});

function world() {
  return { grid: new WorldGrid({ ox: 0, oy: 0, w: 100, h: 100 }), objects: new ObjectStore() };
}
const inputOf = prs => ({ prs });

test('buildVenues with the fantasy mod: world.venues.dock, art stamped, no lint, level persisted', () => {
  const mod = fantasy(), w = world(), persisted = {};
  const input = inputOf([pr(1, 'building'), pr(2, 'merged'), pr(3, 'loading')]);
  const { venues, lint } = buildVenues(w, { venues: { dock: SITE } }, input, mod, persisted, {}, { seed: 1 });
  assert.deepEqual(lint, []);
  assert.equal(w.venues, venues);
  assert.ok(w.objects.size > 0, 'the harbour stamps its piers, bollards and skiff');
  const v = venues.dock;
  assert.equal(v.kind, 'harbour'); assert.equal(v.level, 1);
  assert.deepEqual([v.tx, v.ty], [50, 42]);
  assert.ok(['foot', 'yard', 'mouth', 'offing', 'deck-p2w0'].every(k => v.nodes[k]), 'the harbour nodes');
  assert.deepEqual(persisted.venues, { dock: { kind: 'harbour', level: 1 } });
  assert.equal(venueSig(input, mod, persisted), 'dock:1');
  const r = resolvePlace('venue:dock', { id: 'x', agentId: 'x' }, w);
  assert.deepEqual([r.tx, r.ty, r.fallback], [50, 42, undefined], "resolvePlace('venue:dock') reaches the harbour");
});

test('no venue sites (today\'s built-in layout): no-op, persisted untouched', () => {
  const w = world(), persisted = {};
  const r = buildVenues(w, { villages: [] }, inputOf([pr(1, 'merged')]), fantasy(), persisted);
  assert.deepEqual(r, { venues: {}, lint: [] });
  assert.deepEqual(persisted, {});
});

test('harbour berths: the loading PR gets a berth, kept across polls; merged PRs take none', () => {
  const mod = fantasy(), w = world(), persisted = {};
  const merged = [5, 6, 7, 8, 9].map(n => pr(n, 'merged'));
  let input = inputOf([...merged, pr(1, 'loading')]);
  buildVenues(w, { venues: { dock: SITE } }, input, mod, persisted, {}, { seed: 1 });
  const a1 = venueAssignments(w, input, mod, persisted);
  assert.deepEqual(Object.keys(a1.venues.dock), ['alpha#1'], 'merged PRs no longer compete for berths');
  const b1 = a1.venues.dock['alpha#1'];
  assert.ok(b1, 'the loading PR has a berth');
  assert.equal(a1.prs['alpha#1'].model, 'cutter');   // no size yet: classic's middle class
  input = inputOf([pr(2, 'loading'), ...merged, pr(1, 'loading')]);
  const a2 = venueAssignments(w, input, mod, persisted);
  assert.equal(a2.venues.dock['alpha#1'], b1, 'stable across polls');
  assert.ok(a2.venues.dock['alpha#2'], 'the new loading PR found a berth');
  assert.deepEqual(persisted.venues.dock.assign, a2.venues.dock);
  // a rebuild keeps the assignment
  const w2 = world();
  buildVenues(w2, { venues: { dock: SITE } }, input, mod, persisted, {}, { seed: 1 });
  assert.equal(venueAssignments(w2, input, mod, persisted).venues.dock['alpha#1'], b1);
});
