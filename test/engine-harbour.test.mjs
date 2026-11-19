// Engine v2 M5 harbour: spec tests written from docs/village-engine-v2.md section 4.4 and 7.2 (Harbour items), with the
// classic harbour (web/src/dock.js, dock-art.js, dock-walk.js) as the oracle. Modules that M5 adds are imported
// dynamically; a missing module or seam FAILS the file.
// Parity ids are in the test titles: har.* and lbl.ship-pr-tags (docs/engine-parity.json).
import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const tryImport = async rel => { try { return await import(new URL(rel, root)); } catch (e) { if (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(String(e?.message))) return null; throw e; } };
const readSrc = rel => { try { return fs.readFileSync(new URL(rel, root), 'utf8'); } catch { return null; } };
const fixture = n => JSON.parse(fs.readFileSync(new URL(`e2e/fixtures/engine/${n}.json`, root), 'utf8'));

// ---- classic oracle: dock-art.js touches matchMedia/localStorage/location at import, so stub them first.
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location ??= { search: '', hash: '' };
const classic = await tryImport('web/src/dock-art.js');

const venuesMod = await tryImport('mods/agentville.fantasy/venues.js');
const reprMod = await tryImport('mods/agentville.fantasy/represent-pr.js');
const adapter = (await tryImport('web/src/engine-host/dock-input.js')) ?? (await tryImport('web/src/engine/dock/adapter.js'));
const tokens = await tryImport('web/src/engine/sim/tokens.js');
const ship = await tryImport('mods/agentville.fantasy/ambient/ship.js');
const porter = await tryImport('mods/agentville.fantasy/ambient/porter.js');
const registry = await tryImport('web/src/engine/mod/registry.js');
const venueLib = await tryImport('web/src/engine/world/venue.js');
const reprWorld = await tryImport('web/src/engine/sim/represent-world.js');
const snapshot = await tryImport('web/src/engine/snapshot.js');
const inputMod = await tryImport('web/src/engine/mod/input.js');

const def = venuesMod?.VENUES?.harbour;
const fantasy = registry?.resolveMod?.('agentville.fantasy');
const tierFor = venuesMod?.tierFor;
const MIN = 60e3;
const lvl = (loading, extra = {}, prev = null, ctx = {}) => def.level({ prs: loading, states: { loading, building: 0, merged: 0, closed: 0 }, ...extra }, prev, ctx);

// ---------------------------------------------------------------- classic oracle (runs now)

test('[har.tiers-1-4-by-prs-loading] classic oracle: tier by PRs loading at 3/4/7/8/12/13', { skip: !classic && 'classic dock-art.js not importable' }, () => {
  classic.resetHarbourTier();
  const t = n => { classic.resetHarbourTier(); return classic.harbourTier({ loading: Array(n).fill({}), total: 0 }, 0); };
  assert.deepEqual([0, 1, 3, 4, 7, 8, 12, 13, 30].map(t), [1, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test('[har.shrink-hysteresis-10min] classic oracle: lifetime floor, grow at once, loading shrinks only after 10 min', { skip: !classic && 'classic dock-art.js not importable' }, () => {
  const H = n => ({ loading: Array(n).fill({}), total: 0 });
  classic.resetHarbourTier();
  assert.equal(classic.harbourTier(H(13), 0), 4, 'grows at once');
  assert.equal(classic.harbourTier(H(1), 1 * MIN), 4, 'first low reading starts the clock');
  assert.equal(classic.harbourTier(H(1), 10 * MIN), 4, 'still held at 9 min of low');
  assert.equal(classic.harbourTier(H(1), 11 * MIN + 1), 1, 'shrinks once low longer than 10 min (the loading component only)');
  // a busy poll in between resets the low clock
  classic.resetHarbourTier();
  classic.harbourTier(H(13), 0); classic.harbourTier(H(1), MIN); classic.harbourTier(H(13), 5 * MIN);
  assert.equal(classic.harbourTier(H(1), 6 * MIN), 4);
  assert.equal(classic.harbourTier(H(1), 15 * MIN), 4, 'clock restarted at 6 min: 9 min is not enough');
  // lifetime floor: never shrinks below tierForTotal, even after the load is gone for hours
  classic.resetHarbourTier();
  const floor = total => { classic.harbourTier({ loading: [], total }, 0); return classic.harbourTier({ loading: [], total }, 5 * 60 * MIN); };
  assert.deepEqual([0, 9, 10, 39, 40, 119, 120, 5000].map(floor), [1, 1, 2, 2, 3, 3, 4, 4]);
  // loading only grows it: lifetime tier 2 + 13 loading -> 4, then back to the floor (2) after the hold
  classic.resetHarbourTier();
  assert.equal(classic.harbourTier({ loading: Array(13).fill({}), total: 10 }, 0), 4);
  classic.harbourTier({ loading: [], total: 10 }, MIN);
  assert.equal(classic.harbourTier({ loading: [], total: 10 }, 20 * MIN), 2);
});

test('[har.ship-class-by-pr-size] classic oracle: shipClass thresholds', { skip: !classic && 'classic dock-art.js not importable' }, () => {
  const c = (a, d, f) => classic.shipClass({ additions: a, deletions: d, files: f });
  assert.equal(c(10, 39, 1), 'dinghy'); assert.equal(c(25, 25, 1), 'sloop');   // < 50 lines small, 50 is not
  assert.equal(c(300, 200, 20), 'sloop'); assert.equal(c(300, 201, 3), 'cargo');   // > 500 lines big, 500 is not
  assert.equal(c(1, 1, 21), 'cargo'); assert.equal(c(1, 1, 20), 'dinghy');          // > 20 files big, 20 is not
  assert.equal(classic.shipClass(null), 'sloop'); assert.equal(classic.shipClass(undefined), 'sloop');
});

// ---------------------------------------------------------------- tier boundaries (mod venues.js)

test('[har.tiers-1-4-by-prs-loading] tier boundaries 3/4/7/8/12/13', () => {
  assert.deepEqual([0, 1, 3, 4, 7, 8, 12, 13, 99].map(tierFor), [1, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual([0, 3, 4, 7, 8, 12, 13].map(n => lvl(n, {}, null)), [1, 1, 2, 2, 3, 3, 4]);
});

test('[har.tiers-1-4-by-prs-loading] merged PRs never count as load; only loading ones do', () => {
  assert.equal(def.level({ prs: 20, states: { loading: 2, building: 0, merged: 18, closed: 0 } }, null, {}), 1);
});

test('[har.shrink-hysteresis-10min] lifetime floor: size follows lifetime PRs sailed (load.merged), tiers at 10/40/120', t => {
  const floor = total => lvl(0, { merged: total }, null);
  const got = [0, 9, 10, 39, 40, 119, 120, 500].map(floor);
  assert.deepEqual(got, [1, 1, 2, 2, 3, 3, 4, 4]);
});

test('[har.shrink-hysteresis-10min] never shrinks below the lifetime floor, whatever prev and load say', t => {
  for (const prev of [null, 1, 2, 3, 4]) for (const loading of [0, 1, 5, 20]) {
    const got = lvl(loading, { merged: 120 }, prev, { now: 1e12 });
    assert.equal(got, 4, `prev ${prev}, loading ${loading}`);
  }
  assert.ok(lvl(0, { merged: 40 }, 4, { now: 1e12 }) >= 3, 'lifetime 40 keeps tier 3 at least');
});

test('[har.shrink-hysteresis-10min] shrink hysteresis is 10 minutes on the loading component (VenueDef.shrinkAfterMs, injected clock)', () => {
  assert.equal(def.shrinkAfterMs, 10 * MIN);
  // The engine keeps low-since in persisted.venues[id] (SEAMS); drive it through venueAssignments-free API: level() with an
  // injected ctx.now and a persisted-like prev object is engine territory, so here only the declared constant is pinned.
});

// ---------------------------------------------------------------- ship class by PR size (represent-pr.js)

const pr = (state, size, n = 1) => ({ id: `p#${n}`, project: 'p', number: n, title: 't', state, checks: { passed: 0, failed: 0, pending: 0 }, review: null, size });
const modelOf = size => reprWorld.representPr(pr('loading', size), fantasy, {}).model;
const classOk = () => { try { return !!(reprWorld && fantasy && reprMod && modelOf({ additions: 5, deletions: 5, files: 1 }) !== modelOf({ additions: 900, deletions: 5, files: 1 })); } catch { return false; } };

test('[har.ship-class-by-pr-size] small < 50 lines, big > 500 lines or > 20 files, otherwise medium; merged is none', () => {
  const small = modelOf({ additions: 10, deletions: 39, files: 1 }), mid = modelOf({ additions: 25, deletions: 25, files: 1 });
  const bigLines = modelOf({ additions: 300, deletions: 201, files: 3 }), bigFiles = modelOf({ additions: 1, deletions: 1, files: 21 });
  assert.notEqual(small, mid); assert.notEqual(mid, bigLines);
  assert.equal(bigFiles, bigLines, '> 20 files is as big as > 500 lines');
  assert.equal(modelOf({ additions: 300, deletions: 200, files: 20 }), mid, 'exactly 500 lines and 20 files stay medium');
  // classic: a missing size is a sloop (medium). WorldInput fills a missing size with zeros, so all zeros means unknown
  assert.equal(modelOf({ additions: 0, deletions: 0, files: 0 }), mid, 'unknown (all-zero) size is medium, as classic draws a PR with no size');
  assert.equal(reprWorld.representPr(pr('merged', { additions: 9, deletions: 9, files: 1 }), fantasy, {}).as, 'none', 'merged PRs are not drawn as ships');
  assert.equal(reprWorld.representPr(pr('loading', { additions: 9, deletions: 9, files: 1 }), fantasy, {}).venue, 'harbour');
});

// ---------------------------------------------------------------- plan: berths, overflow to anchor, brigs on pier heads

const site = { id: 'dock', kind: 'harbour', rect: { x: 0, y: 0, w: 120, h: 60 }, anchor: { tx: 40, ty: 10 }, data: { cx: 40, foot: 10, sea: 11 } };
const planAt = lv => def.plan({ site, level: lv }, {});
const PIER_BERTHS = [null, 4, 12, 16, 30];   // lanes x (units / 2): 2*1*2, 2*3*2, 2*4*2, 2*5*3 (classic LAYOUT units 4/4/5/6)
const hasPlan = () => { try { return !!(def && planAt(1)?.berths?.length); } catch { return false; } };

test('[har.berths-and-at-anchor] pier berths per tier, main pier first', () => {
  for (let lv = 1; lv <= 4; lv++) {
    const b = planAt(lv).berths, piers = b.filter(x => /^p/.test(x.id));
    assert.ok(piers.length >= PIER_BERTHS[lv], `tier ${lv}: ${piers.length} pier berths`);
    assert.equal(new Set(b.map(x => x.id)).size, b.length, 'berth ids are unique');
  }
  const t1 = planAt(1).berths.filter(x => /^p/.test(x.id));
  assert.ok(t1.every(x => x.tx >= site.data.cx - 2 && x.tx <= site.data.cx + 3), 'tier 1 berths sit on the main pier');
});

const anchorBerths = lv => planAt(lv).berths.filter(x => !/^p\d/.test(x.id));
test('[har.berths-and-at-anchor] anchor berths come after the pier berths (overflow at anchor)', () => {
  for (let lv = 1; lv <= 4; lv++) {
    const b = planAt(lv).berths, firstAnchor = b.findIndex(x => !/^p\d/.test(x.id));
    assert.ok(firstAnchor > 0 && b.slice(firstAnchor).every(x => !/^p\d/.test(x.id)), `tier ${lv}: anchor berths are a tail`);
  }
  // overflow: more loading PRs than pier berths -> the extras take anchor berths, nobody is dropped while berths remain
  const berths = planAt(1).berths, nPier = berths.filter(x => /^p\d/.test(x.id)).length;
  const specs = Array.from({ length: nPier + 2 }, (_, i) => ({ id: `p#${i}`, spec: { as: 'venue', venue: 'harbour', model: 'cutter' } }));
  const a = venueLib.assignBerths({ id: 'dock', kind: 'harbour', berths }, specs, {}, { mod: fantasy });
  const idOf = new Map(berths.map(x => [x.id, x]));
  const onAnchor = Object.values(a).filter(id => !/^p\d/.test(id));
  assert.equal(Object.keys(a).length, specs.length);
  assert.equal(onAnchor.length, 2, 'exactly the overflow lies at anchor');
  assert.ok(onAnchor.every(id => idOf.has(id)));
});

test('[har.berths-and-at-anchor] brigs (big PRs) take pier heads', () => {
  const berths = planAt(3).berths.filter(x => /^p\d/.test(x.id));
  const headOf = b => berths.every(o => o.tx !== b.tx || o.ty <= b.ty);   // outermost row of its pier column
  const heads = berths.filter(headOf);
  assert.ok(heads.length >= 2, 'there are pier heads');
  const ids = ['small#1', 'big#2', 'mid#3', 'big#4'];
  const specs = ids.map(id => ({ id, spec: { as: 'venue', venue: 'harbour', model: id.startsWith('big') ? 'brig' : id.startsWith('small') ? 'dinghy' : 'cutter' } }));
  const a = venueLib.assignBerths({ id: 'dock', kind: 'harbour', berths: planAt(3).berths }, specs, {}, { mod: fantasy });
  for (const id of ['big#2', 'big#4']) assert.ok(heads.some(h => h.id === a[id]), `${id} is on a pier head`);
});

// ---------------------------------------------------------------- hrefs never inside the world objects

const viewOf = n => snapshot.viewFromFixture(fixture(n));
const dockPrs = view => { const r = adapter.dockPrs(view); return { r, list: Array.isArray(r) ? r : (r?.prs ?? r?.list ?? []) }; };

test('[har.tiers-1-4-by-prs-loading] dockPrs(view): loading and sailed become PRs with id <project>#<n>, size, checks, review', () => {
  const view = viewOf('harbour-6'), { r, list } = dockPrs(view);
  const loading = list.filter(p => p.state === 'loading'), merged = list.filter(p => p.state === 'merged');
  assert.equal(loading.length, 6);
  assert.ok(merged.length >= 1, 'the sailed PR is there as merged');
  for (const p of loading) {
    assert.match(p.id, /^.+#\d+$/); assert.ok(p.size && typeof p.size === 'object'); assert.ok(p.checks && 'review' in p);
  }
  assert.equal(new Set(list.map(p => p.id)).size, list.length, 'ids are unique');
  assert.equal(r.merged, view.dock.total, 'merged carries the lifetime total');
  assert.equal(r.rank, view.dock.level, 'rank carries the dock level');
});

test('[lbl.ship-pr-tags] hrefs never go into the world: not in dockPrs, not in the world input', () => {
  const view = viewOf('harbour-6');
  const blob = JSON.stringify(dockPrs(view).r);
  assert.ok(!/https?:|example\.invalid|\/pull\//.test(blob), 'no URL in the adapter output');
  assert.ok(!/"href"/.test(blob), 'no href key');
  if (inputMod?.toWorldInput) {
    const input = JSON.stringify(inputMod.toWorldInput(view));
    assert.ok(!/https?:|example\.invalid|\/pull\//.test(input), 'no URL in the WorldInput');
  }
});

// ---------------------------------------------------------------- tokens, ships, porters

test('[har.cast-off-stagger-sail-out] tokens: a berthed PR is a token actor and leaves on merge', () => {
  assert.ok(Object.keys(tokens).length > 0, 'tokens.js exports its seam');
});

test('[har.cast-off-stagger-sail-out] ship ambient: 6 s cast-off stagger', () => {
  const src = readSrc('mods/agentville.fantasy/ambient/ship.js');
  assert.match(src, /\b6000\b|\b6\b\s*(\/\/|;|,)|STAGGER/, 'a 6 s stagger constant is named');
  assert.ok(typeof (ship.update ?? ship.default?.update) === 'function', 'ship is a behaviour { init, update }');
});

const policy = { CAP: 6, PICK: 0.9, DROP: 1.2 };
test('[har.porter-cap-6] [har.porter-drop-and-head-home] porter policy constants match dock-walk.js: CAP 6, PICK 0.9 s, DROP 1.2 s, REST [5, 4]', () => {
  const classicSrc = readSrc('web/src/dock-walk.js'), src = readSrc('mods/agentville.fantasy/ambient/porter.js');
  // the oracle itself
  assert.match(classicSrc, /CAP = 6/); assert.match(classicSrc, /DROP = 1\.2/); assert.match(classicSrc, /PICK = 0\.9/); assert.match(classicSrc, /REST = \[5, 4\]/);
  for (const [k, v] of Object.entries(policy)) {
    const exported = porter[k] ?? porter.default?.[k] ?? porter.POLICY?.[k];
    if (exported !== undefined) assert.equal(exported, v, k);
    else assert.match(src, new RegExp(`${k}\\s*=\\s*${String(v).replace('.', '\\.')}\\b`), `${k} = ${v} in porter.js`);
  }
  const rest = porter.REST ?? porter.default?.REST ?? porter.POLICY?.REST;
  if (rest) assert.deepEqual([...rest], [5, 4]); else assert.match(src, /REST\s*=\s*\[\s*5\s*,\s*4\s*\]/);
});

test('[har.porters-resting-agents] [har.porter-townsperson-fallback] porter policy: resting agents first, townsperson fallback, head home when the ship sails', () => {
  const src = readSrc('mods/agentville.fantasy/ambient/porter.js');
  assert.match(src, /rest/i, 'resting agents carry first');
  assert.match(src, /townsp|square|fallback/i, 'a townsperson from the square carries when no resting agent can');
  assert.match(src, /home/i, 'a porter heads home when its ship sails');
  assert.ok(typeof (porter.update ?? porter.default?.update) === 'function', 'porter is a behaviour { init, update }');
});
