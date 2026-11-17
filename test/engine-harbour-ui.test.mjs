import './support/ensure-mods-index.mjs';
// Harbour UI regressions under engine v2 (2026-11-16, "the UI for the PR port is incredibly bugged"). One test (or a few)
// per bug, written against the behaviour the user is used to from classic dock-art.js:
//   1. ships lay ACROSS their piers (berth face 2 = -x): a moored hull must lie along its pier, bow out to sea;
//   2. a brig (4.5 tiles) on a 3-tile berth sat on the ships either side of it: moored hulls never overlap;
//   3. departing ships sailed straight through the breakwater: they leave through the harbour mouth;
//   4. hovering one ship outlined every pier plank section (and the ship as a loose box): only that hull lights up;
//      hovering the dock outlines each pier once;
//   5. a ship's hit was its whole sprite rect, so a click on the air round a brig took the brig: hulls pick by pixel;
//   6. ships showed nothing of their PR (classic: a pennant red for failing checks / green when approved, cargo stowed
//      as checks pass): PrSpec flag / load, drawn by the vessel art;
//   7. a ship click opened the dock sheet without saying which PR: the click names the PR's link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrom, loadFixture, fantasyMod, simMod, SEED } from './engine-support/sim-harness.mjs';

const { VENUES, MOOR_FACE, PIER_ID, BRIG_SPAN } = await import('../mods/agentville.fantasy/venues.js');
const { mooring, HULL_TILES, seaCourse, pierTiles } = await import('../mods/agentville.fantasy/ambient/ship.js');
const { representPr: fantasyPr, flagOf, loadOf, FLAG } = await import('../mods/agentville.fantasy/represent-pr.js');
const { assignBerths, venueAssignments } = await import('../web/src/engine/world/venue.js');
const { representPr } = await import('../web/src/engine/sim/represent-world.js');
const { createTokens } = await import('../web/src/engine/sim/tokens.js');
const { createCraftArt } = await import('../web/src/engine/render/craft-art.js');
const { venueOutlines } = await import('../web/src/engine/render/venue-outline.js');
const { buildHits } = await import('../web/src/engine/render/hits.js');
const { pick } = await import('../web/src/engine/render/pick.js');
const { dockHref } = await import('../web/src/engine-host/dock-input.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const vessel = await import('../web/src/engine/art/props/vessel.js');

const H = VENUES.harbour;
/** A canvas for node: the 2d calls the craft art makes (create/put/getImageData), over one RGBA buffer. */
function fakeCanvas(width, height) {
  const d = new Uint8ClampedArray(width * height * 4);
  const g = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData(img, x0, y0) { for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) { const k = (j * img.width + i) * 4, x = x0 + i, y = y0 + j; if (img.data[k + 3] && x >= 0 && y >= 0 && x < width && y < height) d.set(img.data.slice(k, k + 4), (y * width + x) * 4); } },
    getImageData: () => ({ data: d, width, height }),
  };
  return { width, height, getContext: () => g };
}
const craft = () => createCraftArt({ createCanvas: fakeCanvas });
const SITE = { kind: 'harbour', rect: { x: 0, y: 0, w: 90, h: 50 }, anchor: { tx: 40, ty: 10 }, data: { cx: 40, foot: 10, sea: 11 } };
const planAt = tier => H.plan({ site: SITE, level: tier });
const HALF = { dinghy: 6 / 16, cutter: 9 / 16, brig: 12 / 16 };   // classic dock-art SHIPS half beam, in tiles
const spec = (id, model) => ({ id, state: 'loading', spec: { as: 'venue', venue: 'harbour', model } });

/** The hull footprint (tiles) of a ship moored at a berth: along y (face 1), centred by mooring(). */
function hullOf(b, model) {
  const m = mooring({ tx: b.tx, ty: b.ty, berth: b.id, model }), L = HULL_TILES[model], w = HALF[model];
  return { x0: m.x - w, x1: m.x + w, y0: m.y - L / 2, y1: m.y + L / 2 };
}
const overlap = (a, b, eps = 1e-6) => a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.y0 < b.y1 - eps && b.y0 < a.y1 - eps;

// ---------------------------------------------------------------- 1. along the pier, bow out to sea

test('[har.ships-along-the-pier] every berth faces 1 (SW: +y, the art heading S), so a hull lies along its pier', () => {
  for (const tier of [1, 2, 3, 4]) for (const b of planAt(tier).berths) assert.equal(b.face, MOOR_FACE, `${b.id} tier ${tier}`);
  assert.equal(MOOR_FACE, 1);
  // the craft art draws face 1 as heading S: the same sprite as the vessel prop with head 'S'
  const art = craft();
  const f = art.frame({ kind: 'token', id: 't', item: 'p#1', model: 'cutter', face: MOOR_FACE });
  const ext = vessel.extent({ cls: 'cutter', head: 'S', v: 0 });
  assert.equal(f.img.height, Math.ceil(ext[3] - ext[1]) + 2, 'heading S (a W-heading cutter is a different shape)');
});

// ---------------------------------------------------------------- 2. moored hulls never overlap

test('[har.brig-takes-two-berths] a full tier-4 harbour of brigs, cutters and dinghies: no two moored hulls overlap', () => {
  for (const tier of [2, 3, 4]) {
    const berths = planAt(tier).berths, byId = new Map(berths.map(b => [b.id, b]));
    const models = ['brig', 'cutter', 'dinghy', 'brig', 'brig', 'cutter'];
    const specs = Array.from({ length: berths.length }, (_, i) => spec(`p#${i}`, models[i % models.length]));
    const a = assignBerths({ id: 'dock', kind: 'harbour', berths }, specs, {}, { mod: resolveMod('agentville.fantasy') });
    const hulls = Object.entries(a).map(([id, b]) => ({ id, b, h: hullOf(byId.get(b), specs.find(s => s.id === id).spec.model) }));
    assert.ok(hulls.length > 10, 'the harbour is busy');
    for (let i = 0; i < hulls.length; i++) for (let j = i + 1; j < hulls.length; j++) {
      assert.ok(!overlap(hulls[i].h, hulls[j].h), `tier ${tier}: ${hulls[i].id}@${hulls[i].b} overlaps ${hulls[j].id}@${hulls[j].b}`);
    }
    // every brig on a pier is on a head, with the berth inside it left empty
    for (const { id, b } of hulls) {
      if (specs.find(s => s.id === id).spec.model !== 'brig' || !PIER_ID.test(b)) continue;
      const head = byId.get(b), inner = berths.find(o => o.tx === head.tx && o.ty === head.ty - 3);
      assert.ok(!berths.some(o => o.tx === head.tx && o.ty > head.ty && PIER_ID.test(o.id)), `${id} is on a head`);
      if (inner) assert.ok(!Object.values(a).includes(inner.id), `${id}: the berth inside its head (${inner.id}) stays empty`);
    }
  }
  assert.equal(BRIG_SPAN, 2);
});

test('[har.brig-takes-two-berths] assign keeps berths across polls; a brig whose inner berth an old assignment gave away moves', () => {
  const berths = planAt(4).berths, mod = resolveMod('agentville.fantasy');
  const specs = [spec('s#1', 'dinghy'), spec('b#2', 'brig'), spec('c#3', 'cutter')];
  const a = assignBerths({ id: 'dock', kind: 'harbour', berths }, specs, {}, { mod });
  assert.deepEqual(assignBerths({ id: 'dock', kind: 'harbour', berths }, specs, a, { mod }), a, 'stable');
  // an assignment from before the fix: the brig on a head and a cutter on the berth inside it
  const head = berths.find(b => b.id === a['b#2']), inner = berths.find(b => b.tx === head.tx && b.ty === head.ty - 3);
  const old = { 's#1': a['s#1'], 'b#2': head.id, 'c#3': inner.id };
  const b = assignBerths({ id: 'dock', kind: 'harbour', berths }, specs, old, { mod });
  assert.equal(b['c#3'], inner.id, 'the smaller ship keeps its berth');
  assert.notEqual(b['b#2'], head.id, 'the brig moves rather than sit on it');
  // small ships take plain berths before the berths inside heads, and heads last
  const smalls = Array.from({ length: 6 }, (_, i) => spec(`d#${i}`, 'dinghy'));
  const c = assignBerths({ id: 'dock', kind: 'harbour', berths }, smalls, {}, { mod });
  const isHead = id => { const x = berths.find(o => o.id === id); return !berths.some(o => PIER_ID.test(o.id) && o.tx === x.tx && o.ty > x.ty); };
  assert.ok(Object.values(c).every(id => PIER_ID.test(id) && !isHead(id)), 'heads stay free for brigs');
});

test('[har.brig-takes-two-berths] mooring: a brig on a pier lies bow at its berth end, over the inner berth; others centred', () => {
  const b = { tx: 5, ty: 20, berth: 'p2w2' };
  assert.deepEqual(mooring({ ...b, model: 'cutter' }), { x: 5.5, y: 21.5 });
  assert.deepEqual(mooring({ ...b, model: 'dinghy' }), { x: 5.5, y: 21.5 });
  assert.deepEqual(mooring({ ...b, model: 'brig' }), { x: 5.5, y: 23 - 72 / 32 });
  assert.deepEqual(mooring({ ...b, berth: 'a3', model: 'brig' }), { x: 5.5, y: 21.5 }, 'at anchor: centred');
});

// ---------------------------------------------------------------- 3. out through the mouth

const BARRIER = new Set(['breakwater', 'lighthouse', 'beacon']);
function barrierTiles(world) {
  const s = new Set();
  for (const o of world.objects.values()) if (BARRIER.has(o.model)) for (let y = o.ty; y < o.ty + (o.h || 1); y++) for (let x = o.tx; x < o.tx + (o.w || 1); x++) s.add(`${x},${y}`);
  return s;
}

test('[har.sail-out-through-the-mouth] a tier-4 harbour: every pier berth sails out through the mouth, never over the breakwater', () => {
  const { world } = buildFrom(loadFixture('harbour.json'));
  const v = world.venues.dock;
  assert.ok(v && v.nodes.mouth, 'the harbour has a breakwater and a mouth');
  const wall = barrierTiles(world), piers = pierTiles(world, v.id);
  assert.ok(wall.size > 0);
  const pierBerths = v.berths.filter(b => PIER_ID.test(b.id));
  assert.ok(pierBerths.length >= 20);
  for (const b of pierBerths) {
    const m = mooring({ ...b, berth: b.id, model: 'cutter' }), side = piers.has(`${b.tx + 1},${b.ty + 1}`) ? -1 : 1;
    const off = { x: m.x + side, y: m.y };
    const pts = [off.x, off.y, ...seaCourse(world, v, off, { dx: 0, dy: 1 })];
    let viaMouth = false;
    for (let i = 2; i < pts.length; i += 2) {
      const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.1);
      for (let k = 0; k <= n; k++) {
        const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n, key = `${Math.floor(x)},${Math.floor(y)}`;
        assert.ok(!wall.has(key), `${b.id}: the course crosses the breakwater at ${key}`);
        assert.ok(!piers.has(key), `${b.id}: the course crosses a pier at ${key}`);
        if (Math.floor(x) === v.nodes.mouth.tx && Math.floor(y) === v.nodes.mouth.ty) viaMouth = true;
      }
    }
    assert.ok(viaMouth, `${b.id} leaves through the mouth`);
    assert.ok(pts[pts.length - 1] > world.grid.oy + world.grid.h - 1, `${b.id} reaches the edge`);
  }
});

test('[har.sail-out-through-the-mouth] the sim: a merged ship at the main pier sails out and never touches the breakwater', () => {
  const fx = loadFixture('harbour.json');
  const built = buildFrom(fx), mod = fantasyMod(), world = built.world;
  // the fixture's dock PRs (project 'dock', from their hrefs) are open: loading, as the fantasy world opts in to
  const input = { ...built.input, prs: built.input.prs.map(p => (p.project === 'dock' && p.state === 'building' ? { ...p, state: 'loading' } : p)) };
  const berths = venueAssignments(world, input, mod, { venues: {} }, {}).prs;
  const sim = simMod.createSim({ world, nav: built.nav, seed: SEED, mod, serverId: built.serverId, clock: { dayLength: 60, phase0: 0.3 } });
  sim.applySnapshot(input, { berths });
  const id = Object.keys(berths).find(k => /^p2/.test(berths[k].berth));
  assert.ok(id, 'a ship at the main pier');
  for (let i = 0; i < 10; i++) sim.step(0.05);
  sim.applySnapshot({ ...input, prs: input.prs.map(p => (p.id === id ? { ...p, state: 'merged' } : p)) }, { berths });
  const a = sim.actors.get(`token:${id}`), wall = barrierTiles(world);
  let sailed = false;
  for (let i = 0; i < 4000 && sim.actors.has(a.id); i++) {
    sim.step(0.05);
    if (a.state === 'sailing') sailed = true;
    assert.ok(!wall.has(`${Math.floor(a.x)},${Math.floor(a.y)}`), `over the breakwater at ${a.x.toFixed(2)},${a.y.toFixed(2)}`);
  }
  assert.ok(sailed && !sim.actors.has(a.id), 'it sailed off the map and was removed');
});

// ---------------------------------------------------------------- 4. hover

test('[inp.dock-hover-outline] venueOutlines: a pier planked in sections outlines once; other kinds and venues apart', () => {
  const pier = (id, tx, ty, h, venue = 'dock') => ({ id, kind: 'venue', tx, ty, w: 2, h, data: { venue } });
  const objs = [pier('a0', 10, 5, 3), pier('a1', 10, 8, 3), pier('a2', 10, 11, 2), pier('b0', 17, 5, 3), pier('b1', 17, 8, 3),
    { id: 'quay', kind: 'prop', tx: 0, ty: 0, w: 30, h: 2 }, pier('c0', 10, 20, 3), pier('x0', 10, 8, 3, 'other')];
  const r = venueOutlines(objs).sort((p, q) => p.tx - q.tx || p.ty - q.ty);
  assert.deepEqual(r, [{ tx: 10, ty: 5, w: 2, h: 8 }, { tx: 10, ty: 8, w: 2, h: 3 }, { tx: 10, ty: 20, w: 2, h: 3 }, { tx: 17, ty: 5, w: 2, h: 6 }]);
});

test('[inp.dock-hover-outline] the hovered hull is its highlight sprite (classic hl outline): same box, other pixels', () => {
  const art = craft(), a = { kind: 'token', id: 'token:p#1', item: 'p#1', model: 'brig', face: 1 };
  const plain = art.frame(a), hl = art.frame(a, { hl: true });
  assert.notEqual(plain, hl);
  assert.equal(hl.img.width, plain.img.width); assert.equal(hl.img.height, plain.img.height);
  assert.deepEqual(hl.pivot, plain.pivot);
  const px = f => [...f.img.getContext('2d').getImageData(0, 0, f.img.width, f.img.height).data];
  assert.notDeepEqual(px(hl), px(plain));
});

// ---------------------------------------------------------------- 5. pick by pixel

test('hulls pick by pixel: the air in a hull sprite falls through to the pier behind it', () => {
  const art = craft(), f = art.frame({ kind: 'token', id: 'token:p#1', item: 'p#1', model: 'brig', face: 1 });
  const W = f.img.width, Hh = f.img.height, alpha = f.img.getContext('2d').getImageData(0, 0, W, Hh).data;
  let air = null, solid = null;
  for (let y = 0; y < Hh && !(air && solid); y++) for (let x = 0; x < W; x++) {
    const a = alpha[(y * W + x) * 4 + 3];
    if (!air && a === 0) air = { x, y };
    if (!solid && a === 255) solid = { x, y };
  }
  assert.ok(air && solid);
  // a pier slice behind the ship covering the whole sprite (opaque), drawn before it (smaller key)
  const pierImg = { width: W, height: Hh };
  const merged = [
    { key: 1, oid: 'venue:dock:pier2.0', hit: 'dock', img: pierImg, sx: 0, sy: 0, sw: W, sh: Hh, dx: 0, dy: 0 },
    { key: 2, actor: { id: 'token:p#1', kind: 'token' }, oid: 'token:p#1', hit: 'ship', x: 0, y: 0, p: { sx: f.pivot.x, sy: f.pivot.y }, img: f.img, pivot: f.pivot },
  ];
  const hits = buildHits(merged, (x, y) => [x, y]);
  const ship = hits.find(h => h.kind === 'ship');
  assert.ok(ship.src && ship.src.img === f.img, 'the hull hit carries its sprite');
  const alphaAt = (h, x, y) => (h.src.img === f.img ? alpha[(Math.floor(y - h.rect[1]) * W + Math.floor(x - h.rect[0])) * 4 + 3] >= 16 : true);
  assert.equal(pick(hits, air.x + 0.5, air.y + 0.5, { alphaAt })?.kind, 'dock', 'the air round the hull is the pier behind');
  assert.equal(pick(hits, solid.x + 0.5, solid.y + 0.5, { alphaAt })?.kind, 'ship', 'the hull itself is the ship');
});

// ---------------------------------------------------------------- 6. state on the ship: pennant and cargo

test('[har.pennant-and-cargo] represent.pr: a loading PR carries its pennant (failing red, approved green, else cream) and load', () => {
  const pr = (checks, review = null) => ({ id: 'p#1', project: 'p', number: 1, title: '', state: 'loading', checks, review, size: { additions: 0, deletions: 0, files: 0 } });
  assert.equal(flagOf(pr({ passed: 5, failed: 1, pending: 0 }, 'approved')), FLAG.failing, 'a failing check wins');
  assert.equal(flagOf(pr({ passed: 5, failed: 0, pending: 0 }, 'approved')), FLAG.approved);
  assert.equal(flagOf(pr({ passed: 1, failed: 0, pending: 4 })), FLAG.open);
  assert.equal(loadOf(pr({ passed: 0, failed: 0, pending: 0 })), 0);
  assert.equal(loadOf(pr({ passed: 2, failed: 0, pending: 2 })), 0.4);
  assert.equal(loadOf(pr({ passed: 4, failed: 0, pending: 0 }, 'approved')), 1);
  const s = fantasyPr(pr({ passed: 1, failed: 2, pending: 1 }));
  assert.deepEqual({ flag: s.flag, load: s.load }, { flag: FLAG.failing, load: 0.2 });
  // through the engine (the clean PrSpec keeps them; junk is dropped with lint)
  const mod = resolveMod('agentville.fantasy');
  const view = Object.freeze({ ...pr({ passed: 3, failed: 0, pending: 1 }, 'approved'), checks: Object.freeze({ passed: 3, failed: 0, pending: 1 }), size: Object.freeze({ additions: 0, deletions: 0, files: 0 }) });
  const out = representPr(view, mod);
  assert.equal(out.flag, FLAG.approved); assert.equal(out.load, 0.8);
  const lint = [], bad = representPr({ ...view }, { ...mod, represent: { pr: () => ({ as: 'venue', venue: 'harbour', flag: 'red', load: 'lots' }) } }, { lint });
  assert.equal(bad.flag, undefined); assert.equal(bad.load, undefined);
  assert.equal(lint.filter(l => l.kind === 'represent-pr').length, 2);
  const big = representPr({ ...view }, { ...mod, represent: { pr: () => ({ as: 'venue', venue: 'harbour', load: 7 }) } });
  assert.equal(big.load, 1, 'clamped');
});

test('[har.pennant-and-cargo] flag and load reach the token through its berth, and follow the PR on later polls', () => {
  const mod = resolveMod('agentville.fantasy');
  const world = { venues: { dock: { id: 'dock', kind: 'harbour', tx: 0, ty: 0, berths: planAt(2).berths } } };
  const pr = (failed, passed) => ({ id: 'p#1', project: 'p', number: 1, title: '', state: 'loading', checks: { passed, failed, pending: 0 }, review: null, size: { additions: 90, deletions: 0, files: 2 } });
  const a1 = venueAssignments(world, { prs: [pr(1, 1)] }, mod, { venues: {} }, {}).prs['p#1'];
  assert.equal(a1.flag, FLAG.failing); assert.equal(a1.load, 0.4);
  const actors = new Map(), store = createTokens({ actors, spawn: s => { actors.set(s.id, s); return s; }, leave() {} });
  store.sync({ 'p#1': a1 }, new Map(), 0);
  const t = actors.get('token:p#1');
  assert.equal(t.flag, FLAG.failing); assert.equal(t.load, 0.4);
  const a2 = venueAssignments(world, { prs: [pr(0, 4)] }, mod, { venues: {} }, {}).prs['p#1'];
  store.sync({ 'p#1': a2 }, new Map(), 1);
  assert.equal(t.flag, FLAG.open); assert.equal(t.load, 0.8, 'the checks passed since: more cargo, the red pennant gone');
});

test('[har.pennant-and-cargo] the vessel art draws the pennant colour at the masthead and the crates on deck', () => {
  const art = craft(), base = { kind: 'token', id: 'token:p#1', item: 'p#1', model: 'cutter', face: 1 };
  const count = (f, rgb) => { const d = f.img.getContext('2d').getImageData(0, 0, f.img.width, f.img.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] && d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) n++; return n; };
  const RED = [0xe5, 0x38, 0x3b], GREEN = [0x2f, 0x9e, 0x5b], CRATE = [0xb0, 0x7a, 0x42];
  const bare = art.frame(base), red = art.frame({ ...base, flag: FLAG.failing }), green = art.frame({ ...base, flag: FLAG.approved });
  assert.equal(count(bare, RED), 0);
  assert.ok(count(red, RED) >= 5, 'a red pennant');
  assert.ok(count(green, GREEN) >= 5 && count(green, RED) === 0, 'a green one');
  const empty = art.frame({ ...base, load: 0 }), half = art.frame({ ...base, load: 0.5 }), full = art.frame({ ...base, load: 1 });
  assert.equal(count(empty, CRATE), count(bare, CRATE));
  assert.ok(count(half, CRATE) > count(empty, CRATE) && count(full, CRATE) > count(half, CRATE), 'more crates as it loads');
  assert.equal(vessel.spotsOf('cutter'), 4); assert.equal(vessel.spotsOf('brig'), 6); assert.equal(vessel.spotsOf('dinghy'), 1);
});

// ---------------------------------------------------------------- 7. the click names its PR

test('[inp.dock-ship-click-va-dock] dockHref: the link of the PR a token carries (its item id), loading or sailed; never a guess', () => {
  const dock = {
    loading: [{ href: 'https://github.com/o/app/pull/7', id: '7', repo: 'o/app', agentId: 'srv-1', state: 'open' },
      { href: 'https://github.com/o/tf/pull/3', id: '3', repo: 'o/tf', agentId: null, state: 'open' }],
    sailed: [{ href: 'https://github.com/o/app/pull/5', id: '5', repo: 'o/app', agentId: 'srv-1', at: 1 }],
    total: 1, level: 1,
  };
  const view = makeView({ agents: [{ id: 'srv-1', project: 'amber', bucket: 'building' }], projects: [], dock }, { now: 1, demo: true });
  assert.equal(dockHref(view, 'amber#7'), 'https://github.com/o/app/pull/7', 'the agent\'s project names it');
  assert.equal(dockHref(view, 'tf#3'), 'https://github.com/o/tf/pull/3', 'no agent: the repo name');
  assert.equal(dockHref(view, 'amber#5'), 'https://github.com/o/app/pull/5', 'a sailed one too');
  assert.equal(dockHref(view, 'app#7'), null);
  assert.equal(dockHref(view, 'amber#8'), null);
  assert.equal(dockHref(view, null), null);
  assert.equal(dockHref({}, 'amber#7'), null);
});
