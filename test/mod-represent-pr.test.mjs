// MOD-READY P6: mod.represent.pr and mod.represent.project (SEAMS P6), with a fake mod. Written from the spec only.
// Needs P6's sim/represent-world.js; tests skip ("needs P6") while it is missing. Includes the canary: no URL, path or
// conversation text from a synthetic snapshot reaches anything a mod receives. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toWorldInput } from '../web/src/engine/mod/input.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';
import { ObjectStore } from '../web/src/engine/core/objects.js';
import { canaryView, CANARIES, RAW_IDS } from './mod-support/views.mjs';

const tryImport = async p => { try { return await import(p); } catch { return null; } };
const RW = await tryImport('../web/src/engine/sim/represent-world.js');
const VN = await tryImport('../web/src/engine/world/venue.js');
const NEEDS_PR = RW?.representPr ? false : 'needs P6 (sim/represent-world.js representPr)';
const NEEDS_PROJECT = RW?.representProject ? false : 'needs P6 (sim/represent-world.js representProject)';
const NEEDS_VENUE = VN?.buildVenues ? false : 'needs P6 (world/venue.js buildVenues)';

const AS = ['lot', 'venue', 'none'];
const ctx = () => ({ rng: () => () => 0.5, hash: s => s.length, time: { now: 0 }, forcedTier: null, forcedStyle: null, parent: null,
  api: { version: 1, has: () => true } });
const prView = (state = 'building', over = {}) => ({ id: 'alpha#7', project: 'alpha', number: 7, title: '', state,
  checks: { passed: 1, failed: 0, pending: 0 }, review: null, size: { additions: 1, deletions: 0, files: 1 }, ...over });
const projView = (over = {}) => ({ key: 'alpha', name: 'alpha', accent: '#336699',
  stats: { prsEver: 3, prsLive: 1, agentsEver: 4, agentsNow: 2, transcriptMB: 1 }, ...over });
const repPr = (pr, represent) => RW.representPr(pr, { id: 'test.space', represent, venues: { spaceport: {} } }, ctx());
const repProject = (p, represent) => RW.representProject(p, { id: 'test.space', represent }, ctx());
const validPrSpec = s => { assert.ok(s && typeof s === 'object', 'a spec object'); assert.ok(AS.includes(s.as), `as is one of ${AS}: ${s.as}`); return s; };

// ---------------------------------------------------------------- represent.pr

test('P6 represent.pr data form: each PR state maps to its own spec', { skip: NEEDS_PR }, () => {
  const represent = { pr: { building: { as: 'lot' }, loading: { as: 'venue', venue: 'spaceport', model: 'rocket' },
    merged: { as: 'venue', venue: 'spaceport', model: 'shuttle' }, closed: { as: 'none' } } };
  assert.equal(repPr(prView('building'), represent).as, 'lot');
  const l = repPr(prView('loading'), represent);
  assert.deepEqual([l.as, l.venue, l.model], ['venue', 'spaceport', 'rocket']);
  assert.equal(repPr(prView('merged'), represent).model, 'shuttle');
  assert.equal(repPr(prView('closed'), represent).as, 'none');
});

test('P6 represent.pr: a state the mod leaves out still yields a valid spec; so does a mod with no represent at all', { skip: NEEDS_PR }, () => {
  validPrSpec(repPr(prView('closed'), { pr: { building: { as: 'lot' } } }));
  validPrSpec(repPr(prView('building'), undefined));
  validPrSpec(repPr(prView('merged'), {}));
});

test('P6 represent.pr function form: (prView, ctx) => PrSpec', { skip: NEEDS_PR }, () => {
  const seen = [];
  const represent = { pr: (pr, c) => { seen.push({ pr, c }); return pr.checks.failed ? { as: 'none' } : { as: 'venue', venue: 'spaceport', model: 'rocket' }; } };
  const a = repPr(prView('loading'), represent);
  assert.equal(a.as, 'venue');
  assert.equal(repPr(prView('loading', { checks: { passed: 0, failed: 2, pending: 0 } }), represent).as, 'none');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].pr.state, 'loading');
  assert.equal(seen[0].pr.id, 'alpha#7');
  assert.equal(typeof seen[0].c.rng, 'function');
});

test('P6 represent.pr: results are sanitised (bad as, unknown keys, bad model and tint, throwing or non-object results)', { skip: NEEDS_PR }, () => {
  const evil = repPr(prView(), { pr: () => ({ as: 'teleport', evil: 'x', __proto__: { polluted: 1 }, model: 'Bad Model <b>!', tint: 'javascript:alert(1)', venue: 42 }) });
  validPrSpec(evil);
  assert.equal(evil.evil, undefined, 'unknown keys dropped');
  assert.notEqual(evil.tint, 'javascript:alert(1)');
  assert.notEqual(evil.model, 'Bad Model <b>!');
  assert.equal(typeof (evil.venue ?? ''), 'string');
  assert.equal({}.polluted, undefined);

  const long = repPr(prView(), { pr: { building: { as: 'lot', model: 'm'.repeat(300) } } });
  assert.ok(long.model === undefined || long.model.length <= 64, 'over-long model dropped or clipped');

  validPrSpec(repPr(prView(), { pr: () => { throw new Error('boom'); } }));
  for (const bad of [null, undefined, 7, 'lot', [], () => 1]) validPrSpec(repPr(prView(), { pr: () => bad }));
});

test('P6 represent.pr: a mod cannot reach the engine through the view it is given (mutation is not seen by the caller)', { skip: NEEDS_PR }, () => {
  const pr = prView('loading', { title: 'Add widget' });
  const before = JSON.stringify(pr);
  repPr(pr, { pr: v => { try { v.title = 'HACK'; v.state = 'merged'; v.checks.failed = 99; } catch { /* frozen view */ } return { as: 'lot' }; } });
  assert.equal(JSON.stringify(pr), before, 'the caller\'s PR is untouched');
});

// ---------------------------------------------------------------- represent.project

test('P6 represent.project data form: label template, model and accent', { skip: NEEDS_PROJECT }, () => {
  const s = repProject(projView({ name: 'alpha' }), { project: { label: '{name} Station', model: 'tower', accent: '#aabbcc' } });
  assert.equal(typeof s.label, 'string');
  assert.ok(s.label.length <= 40);
  assert.ok(s.label.includes('Station'));
  assert.ok(!s.label.includes('{name}') || s.label === '{name} Station', 'the {name} slot is filled in (or the template is kept whole for the caller to fill)');
  assert.equal(s.model, 'tower');
  assert.equal(s.accent, '#aabbcc');
});

test('P6 represent.project function form: (projectView, ctx) => ProjectSpec', { skip: NEEDS_PROJECT }, () => {
  const seen = [];
  const s = repProject(projView({ name: 'beta', key: 'beta' }), { project: (p, c) => { seen.push({ p, c }); return { label: `Base ${p.stats.prsLive}`, model: 'tower' }; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].p.key, 'beta');
  assert.equal(typeof seen[0].c.rng, 'function');
  assert.ok(s.label.includes('Base 1'));
  assert.equal(s.model, 'tower');
});

test('P6 represent.project: the label is sanitised (length <= 40, no control characters or markup)', { skip: NEEDS_PROJECT }, () => {
  const check = (label, name = 'alpha') => {
    const s = repProject(projView({ name }), { project: { label } });
    if (s.label !== undefined) {
      assert.equal(typeof s.label, 'string');
      assert.ok(s.label.length <= 40, `<= 40: ${s.label.length}`);
      assert.ok(!/[\u0000-\u001f\u007f]/.test(s.label), 'no control characters');
      assert.ok(!/[<>]/.test(s.label), 'no markup');
    }
    return s;
  };
  check('x'.repeat(100));
  check('{name} '.repeat(30));
  check('\u0000\u001b[31mHello\n{name}\t');
  check('<img src=x onerror=alert(1)>{name}');
  check('{name}', 'n'.repeat(80));
  const empty = check('');
  assert.ok(empty.label === undefined || empty.label.length <= 40);
});

test('P6 represent.project: bad accent, unknown keys and failing functions are tolerated', { skip: NEEDS_PROJECT }, () => {
  const s = repProject(projView(), { project: () => ({ label: 'ok', accent: 'red; x', model: 'Not A Model!', evil: 1 }) });
  assert.equal(s.evil, undefined);
  assert.notEqual(s.accent, 'red; x');
  assert.notEqual(s.model, 'Not A Model!');
  for (const bad of [null, 5, 'str', undefined]) assert.ok(typeof repProject(projView(), { project: () => bad }) === 'object');
  assert.ok(typeof repProject(projView(), { project: () => { throw new Error('boom'); } }) === 'object');
  assert.ok(typeof repProject(projView(), undefined) === 'object');
});

// ---------------------------------------------------------------- canary: nothing sensitive reaches a mod

/** every string anywhere in a value (functions and cycles skipped). */
function allStrings(v, out = [], seen = new Set()) {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object' && !seen.has(v)) { seen.add(v); for (const [k, x] of Object.entries(v)) { out.push(k); allStrings(x, out, seen); } }
  return out;
}
const LEAK = [...CANARIES, ...RAW_IDS, 'canary.example', '/Users/', 'https://', 'http://'];
function assertClean(received, what) {
  const hay = allStrings(received).join('\n');
  for (const c of LEAK) assert.ok(!hay.includes(c), `${what}: leaked ${c}`);
}

test('P6 canary: the PR and project views a represent function receives carry no URL, path or conversation text', { skip: NEEDS_PR || NEEDS_PROJECT }, () => {
  const { view } = canaryView();
  const { input } = toWorldInput(view, { seed: 5, salt: 'salt-A' });
  assert.ok(input.prs.length > 0 && input.projects.length > 0, 'the synthetic snapshot has PRs and projects');
  const got = [];
  const mod = { id: 'test.space', represent: {
    pr: (pr, c) => { got.push(pr, c); return { as: 'lot' }; },
    project: (p, c) => { got.push(p, c); return { label: p.name }; },
  } };
  for (const pr of input.prs) RW.representPr(pr, mod, ctx());
  for (const p of input.projects) RW.representProject(p, mod, ctx());
  assert.ok(got.length >= 2);
  assertClean(got, 'represent fn args');
});

test('P6 canary: results of representPr / representProject on a canary snapshot carry nothing sensitive either', { skip: NEEDS_PR || NEEDS_PROJECT }, () => {
  const { view } = canaryView();
  const { input } = toWorldInput(view, { seed: 5, salt: 'salt-A' });
  const mod = { id: 'test.space', represent: { pr: { building: { as: 'lot' }, loading: { as: 'venue', venue: 'spaceport' }, merged: { as: 'venue', venue: 'spaceport' } }, project: { label: '{name}' } } };
  const out = [...input.prs.map(p => RW.representPr(p, mod, ctx())), ...input.projects.map(p => RW.representProject(p, mod, ctx()))];
  assertClean(out, 'represent results');
});

test('P6 canary: the venue hooks (level, plan, assign) receive no URL, path or conversation text', { skip: NEEDS_VENUE }, () => {
  const { view } = canaryView();
  const { input } = toWorldInput(view, { seed: 5, salt: 'salt-A' });
  const got = [];
  const rect = { x: 10, y: 10, w: 8, h: 6 };
  const mod = { id: 'test.space', hooks: {},
    represent: { pr: { building: { as: 'venue', venue: 'spaceport' }, merged: { as: 'venue', venue: 'spaceport' }, loading: { as: 'venue', venue: 'spaceport' } } },
    venues: { spaceport: {
      level: (load, prev, c) => { got.push(load, prev, c); return 1; },
      plan: (req, c) => { got.push(req, c); return { objects: [], nodes: { yard: { tx: 11, ty: 11 } }, berths: [{ id: 'b0', tx: 11, ty: 12, face: 0 }] }; },
      assign: (ids, berths, prev, c) => { got.push(ids, berths, prev, c); return {}; },
    } } };
  const world = { grid: new WorldGrid({ ox: 0, oy: 0, w: 40, h: 30 }), objects: new ObjectStore(), venues: {}, lint: [] };
  VN.buildVenues(world, { venues: { port: { kind: 'spaceport', rect, anchor: { tx: 12, ty: 12 } } } }, input, mod, {}, ctx());
  assert.ok(got.length >= 2, 'the hooks were called');
  assertClean(got, 'venue hook args');
  assertClean(world.venues, 'world.venues');
});

test('P6 canary: the test itself would notice a leak (the canary strings are really in the snapshot)', () => {
  const { view } = canaryView();
  const raw = JSON.stringify(view);
  assert.ok(raw.includes('CANARY-HREF') || raw.includes('canary.example'), 'the raw view holds canaries');
  assert.throws(() => assertClean({ href: 'https://canary.example/x' }, 'self-check'));
  assert.throws(() => assertClean([{ title: 'at /Users/canary-home/x.js' }], 'self-check'));
});
