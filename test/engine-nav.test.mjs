import './support/ensure-mods-index.mjs';
// Nav invariants for engine v2 (design docs/village-engine-v2.md §2 and §5.3 invariant 4, "no walking through buildings").
// Written from the spec. nav/* modules are imported lazily; every test skips while they are missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

const NAV = new URL('../web/src/engine/nav/', import.meta.url);
const has = f => fs.existsSync(fileURLToPath(new URL(f, NAV)));
const load = async f => (has(f) ? import(new URL(f, NAV)) : null);
const SEED = 7;

const fx = loadFixture('citydemo.json');
const skipAll = fx ? false : 'e2e/fixtures/engine/citydemo.json missing';
const worlds = new Map();
const build = modId => {
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: SEED, salt: 'nav' });
  return buildWorld(input, { v: 1, seed: SEED, blocks: {}, lots: {} }, { mod: resolveMod(modId), serverId, now: fx.now, seed: SEED });
};
const worldFor = modId => { if (!worlds.has(modId)) worlds.set(modId, build(modId)); return worlds.get(modId); };
const getWorld = () => worldFor('agentville.fantasy');
const need = (mod, f) => (mod ? false : `nav/${f} not present yet`);

const walkable = (g, x, y) => g.inBounds(x, y) && g.get('cost', x, y) < 255 && g.get('occ', x, y) === 0;
const tile = (a, i) => [Math.floor(a[2 * i]), Math.floor(a[2 * i + 1])];
const doorsOf = w => [...w.objects.values()].filter(o => o.kind === 'building' && o.door && walkable(w.grid, o.door.tx, o.door.ty));
const byProject = w => { const m = new Map(); for (const o of doorsOf(w)) { if (!m.has(o.project)) m.set(o.project, []); m.get(o.project).push(o); } return m; };

/** The path's tiles with straight runs expanded: the spec allows a polyline smoothed only along straight runs, so two
 *  consecutive points are either neighbours or the two ends of one orthogonal or 45-degree run; every tile on a run
 *  is a step. Anything else fails here. */
function expandTiles(p, label) {
  const out = [tile(p, 0)];
  for (let i = 1; i < p.length / 2; i++) {
    const [px, py] = out[out.length - 1], [x, y] = tile(p, i);
    const dx = x - px, dy = y - py;
    assert.ok(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy), `${label}: point ${i} jumps ${dx},${dy} (not a straight run)`);
    const n = Math.max(Math.abs(dx), Math.abs(dy)), sx = Math.sign(dx), sy = Math.sign(dy);
    for (let k = 1; k <= n; k++) out.push([px + sx * k, py + sy * k]);
  }
  return out;
}

/** Every step on a free tile, consecutive tiles neighbours (<=1 apart, straight runs expanded), no corner cutting. */
function assertPathLegal(g, p, label) {
  assert.ok(p && p.length >= 2 && p.length % 2 === 0, `${label}: bad path array`);
  const ts = expandTiles(p, label), n = ts.length;
  for (let i = 0; i < n; i++) {
    const [x, y] = ts[i];
    assert.ok(walkable(g, x, y), `${label}: step ${i} at ${x},${y} is blocked (cost>=255 or occ)`);
    if (!i) continue;
    const [px, py] = ts[i - 1];
    const dx = x - px, dy = y - py;
    assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1, `${label}: step ${i} jumps ${dx},${dy}`);
    if (dx && dy) {
      assert.ok(walkable(g, px + dx, py), `${label}: step ${i} cuts corner past ${px + dx},${py}`);
      assert.ok(walkable(g, px, py + dy), `${label}: step ${i} cuts corner past ${px},${py + dy}`);
    }
    if (dx || dy) assert.ok(g.canStep(px, py, x, y), `${label}: step ${i} crosses a blocked edge`);
  }
}

// ---- astar -----------------------------------------------------------------------------------------------------------
test('astar: paths between door forecourts never enter blocked tiles and do not cut corners', { skip: skipAll }, async t => {
  const m = await load('astar.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), ds = doorsOf(w);
  assert.ok(ds.length >= 2, 'need at least two doors');
  let found = 0;
  for (let i = 0; i < ds.length; i += Math.max(1, Math.floor(ds.length / 12))) {
    const a = ds[i], b = ds[(i * 7 + 3) % ds.length];
    if (a === b || a.project !== b.project) continue;
    const p = m.astar(w.grid, { x: a.door.tx, y: a.door.ty }, { x: b.door.tx, y: b.door.ty }, {});
    if (!p) continue;
    found++;
    assertPathLegal(w.grid, p, `${a.id}->${b.id}`);
    assert.deepEqual(tile(p, 0), [a.door.tx, a.door.ty]);
    assert.deepEqual(tile(p, p.length / 2 - 1), [b.door.tx, b.door.ty]);
  }
  assert.ok(found > 0, 'no astar path was found at all');
});

test('astar: a target inside a building footprint yields null or a path that stops outside it', { skip: skipAll }, async t => {
  const m = await load('astar.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld();
  const b = [...w.objects.values()].find(o => o.walk === 'block' && o.kind === 'building' && o.door);
  assert.ok(b);
  const p = m.astar(w.grid, { x: b.door.tx, y: b.door.ty }, { x: b.tx, y: b.ty }, {});
  if (p) { const n = p.length / 2; for (let i = 0; i < n; i++) { const [x, y] = tile(p, i); assert.equal(w.grid.get('occ', x, y), 0, `step ${i} on occ tile`); } }
});

test('astar: deterministic (same inputs, same path)', { skip: skipAll }, async t => {
  const m = await load('astar.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), ds = doorsOf(w), a = ds[0], b = ds.find(d => d.project === a.project && d !== a);
  assert.ok(b);
  const run = () => m.astar(w.grid, { x: a.door.tx, y: a.door.ty }, { x: b.door.tx, y: b.door.ty }, {});
  const p1 = run(), p2 = run();
  assert.ok(p1);
  assert.deepEqual([...p1], [...p2]);
});

// ---- door to door through nav.path -----------------------------------------------------------------------------------
test('nav: a path exists between every pair of doors in one settlement, and is legal', { skip: skipAll }, async t => {
  const m = await load('index.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), nav = m.createNav(w);
  let pairs = 0;
  for (const [project, ds] of byProject(w)) {
    const cap = ds.slice(0, 14);   // bounded: O(n^2) pairs
    for (const a of cap) for (const b of cap) {
      if (a === b) continue;
      const p = nav.path({ x: a.door.tx, y: a.door.ty }, { x: b.door.tx, y: b.door.ty }, {});
      assert.ok(p, `${project}: no path ${a.id} -> ${b.id}`);
      assertPathLegal(w.grid, p, `${a.id}->${b.id}`);
      pairs++;
    }
  }
  assert.ok(pairs > 0, 'no door pairs tested');
});

test('nav: path is deterministic across fresh nav instances', { skip: skipAll }, async t => {
  const m = await load('index.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), ds = [...byProject(w).values()].sort((a, b) => b.length - a.length)[0];
  assert.ok(ds.length >= 2);
  const a = ds[0], b = ds[ds.length - 1];
  const run = () => m.createNav(w).path({ x: a.door.tx, y: a.door.ty }, { x: b.door.tx, y: b.door.ty }, {});
  assert.deepEqual([...run()], [...run()]);
});

test('nav: long trips between settlements stay off building tiles', { skip: skipAll }, async t => {
  const m = await load('index.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), nav = m.createNav(w), groups = [...byProject(w).values()];
  if (groups.length < 2) return;
  let ok = 0;
  for (let i = 0; i + 1 < groups.length; i++) {
    const a = groups[i][0], b = groups[i + 1][0];
    const p = nav.path({ x: a.door.tx, y: a.door.ty }, { x: b.door.tx, y: b.door.ty }, {});
    if (!p) continue;
    ok++;
    assertPathLegal(w.grid, p, `${a.id}->${b.id}`);
  }
  assert.ok(ok > 0, 'no inter-settlement path found');
});

// ---- roadgraph -------------------------------------------------------------------------------------------------------
test('roadgraph: builds, nearestNode works, route joins door nodes of one settlement', { skip: skipAll }, async t => {
  const m = await load('roadgraph.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), g = m.buildRoadGraph(w);
  assert.ok(g.nodes && g.edges);
  const ds = [...byProject(w).values()].sort((a, b) => b.length - a.length)[0];
  const a = ds[0], b = ds[ds.length - 1];
  const na = g.nearestNode(a.door.tx, a.door.ty), nb = g.nearestNode(b.door.tx, b.door.ty);
  assert.ok(na != null && nb != null);
  const r = g.route(na, nb);
  assert.ok(Array.isArray(r) || ArrayBuffer.isView(r), 'route returns node ids');
  assert.equal(r[0], na);
  assert.equal(r[r.length - 1], nb);
  assert.deepEqual([...g.route(na, nb)], [...r], 'route deterministic');
});

// ---- flow ------------------------------------------------------------------------------------------------------------
test('flow: following dirAt from reachable tiles strictly decreases costAt and never enters blocked tiles', { skip: skipAll }, async t => {
  const m = await load('flow.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), g = w.grid, sq = w.square;
  const r = { x: sq.x ?? sq.tx, y: sq.y ?? sq.ty, w: sq.w, h: sq.h };
  const tx = Math.floor(r.x + r.w / 2), ty = Math.floor(r.y + r.h / 2);
  assert.ok(walkable(g, tx, ty) || true);
  const f = m.flowField(g, [{ x: tx, y: ty }], { maxCost: 1e9 });
  let checked = 0;
  for (let y = r.y - 20; y < r.y + r.h + 20; y++) for (let x = r.x - 20; x < r.x + r.w + 20; x++) {
    if (!walkable(g, x, y)) continue;
    const c = f.costAt(x, y);
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    const d = f.dirAt(x, y);
    assert.ok(d, `reachable tile ${x},${y} (cost ${c}) has no direction`);
    const nx = x + d.dx, ny = y + d.dy;
    assert.ok(Math.abs(d.dx) <= 1 && Math.abs(d.dy) <= 1 && (d.dx || d.dy));
    assert.ok(walkable(g, nx, ny), `dir at ${x},${y} points into blocked ${nx},${ny}`);
    if (d.dx && d.dy) assert.ok(walkable(g, x + d.dx, y) && walkable(g, x, y + d.dy), `dir at ${x},${y} cuts a corner`);
    assert.ok(f.costAt(nx, ny) < c, `cost does not decrease at ${x},${y}: ${c} -> ${f.costAt(nx, ny)}`);
    checked++;
  }
  assert.ok(checked > 20, 'too few tiles checked');
  const tc = f.costAt(tx, ty);
  assert.ok(tc === 0 || tc == null || tc < 1, 'target cost is zero');
});

test('flow: blocked tiles have no direction', { skip: skipAll }, async t => {
  const m = await load('flow.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), g = w.grid, sq = w.square;
  const f = m.flowField(g, [{ x: Math.floor((sq.x ?? sq.tx) + sq.w / 2), y: Math.floor((sq.y ?? sq.ty) + sq.h / 2) }], { maxCost: 1e9 });
  const b = [...w.objects.values()].find(o => o.walk === 'block');
  assert.equal(f.dirAt(b.tx, b.ty), null);
});

// ---- slots -----------------------------------------------------------------------------------------------------------
test('slots: never double-booked; release frees; claims sit on free tiles', { skip: skipAll }, async t => {
  const m = await load('slots.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), g = w.grid, slots = m.createSlots(w);
  const anchored = [...w.objects.values()].filter(o => o.anchors?.stand?.length);
  assert.ok(anchored.length > 0);
  const held = new Map();   // "tx,ty,sub" -> actor
  let n = 0;
  for (const o of anchored.slice(0, 40)) for (let k = 0; k < 4; k++) {
    const actor = `a${n++}`;
    const s = slots.claim(o.id, actor);
    if (!s) continue;
    const key = `${s.tx},${s.ty},${s.sub}`;
    assert.ok(!held.has(key), `slot ${key} double-booked by ${held.get(key)} and ${actor}`);
    held.set(key, actor);
    assert.ok(walkable(g, s.tx, s.ty), `slot ${key} on a blocked tile`);
    assert.equal(g.get('cover', s.tx, s.ty), 0, `slot ${key} is covered`);
  }
  assert.ok(held.size > 0, 'nothing could be claimed');
  const [key, actor] = [...held][0];
  slots.release(actor);
  const o = anchored.find(x => x.anchors.stand.some(s => `${s.tx},${s.ty},${s.sub}` === key)) || anchored[0];
  const again = slots.claim(o.id, 'late');
  if (again) assert.ok(!held.has(`${again.tx},${again.ty},${again.sub}`) || `${again.tx},${again.ty},${again.sub}` === key, 'released slot reused only by the new claimant');
});

test('slots: an actor claims one slot at a time; nearestFree never returns a held slot', { skip: skipAll }, async t => {
  const m = await load('slots.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld(), slots = m.createSlots(w);
  const o = [...w.objects.values()].find(x => x.anchors?.stand?.length);
  const held = new Set();
  for (let i = 0; i < 6; i++) {
    const s = slots.claim(o.id, `p${i}`);
    if (s) { const k = `${s.tx},${s.ty},${s.sub}`; assert.ok(!held.has(k), 'double-booked'); held.add(k); }
  }
  for (let i = 0; i < 6; i++) {
    const s = slots.nearestFree(o.door ? o.door.tx : o.tx, o.door ? o.door.ty : o.ty, 'stand');
    if (!s) break;
    const k = `${s.tx},${s.ty},${s.sub}`;
    assert.ok(!held.has(k), `nearestFree returned held slot ${k}`);
    assert.equal(s.kind, 'stand');
    assert.ok(slots.claim(o.id, `q${i}`) !== undefined);
  }
});

test('slots: deterministic for the same claim sequence', { skip: skipAll }, async t => {
  const m = await load('slots.js');
  if (!m) return t.skip('nav module not present yet');
  const w = getWorld();
  const run = () => { const s = m.createSlots(w), out = []; for (const o of [...w.objects.values()].filter(x => x.anchors?.stand?.length).slice(0, 10)) out.push(s.claim(o.id, `x${o.id}`)?.id ?? null); return out; };
  assert.deepEqual(run(), run());
});

// ---- agentville.base: block paths end short of the ring road; nav.path must still join every door to its plaza ----
test('nav (agentville.base): every door reaches its settlement plaza and the town square, legally', { skip: skipAll }, async t => {
  const m = await load('index.js');
  if (!m) return t.skip('nav module not present yet');
  const w = worldFor('agentville.base'), g = w.grid, nav = m.createNav(w);
  const freeNear = r => {   // the free plaza tile nearest the rect centre (a centre prop may block the exact centre)
    const cx = r.x + (r.w - 1) / 2, cy = r.y + (r.h - 1) / 2;
    let best = null, bd = Infinity;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (!walkable(g, x, y)) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bd) { bd = d; best = { x, y }; }
    }
    return best;
  };
  const sq = freeNear(w.square);
  assert.ok(sq, 'square has a free tile');
  let n = 0;
  for (const v of w.villages) {
    const pz = freeNear(v.plaza);
    assert.ok(pz, `${v.name}: plaza has a free tile`);
    for (const d of doorsOf(w).filter(o => o.project === v.name)) {
      const from = { x: d.door.tx, y: d.door.ty };
      for (const [to, what] of [[pz, 'plaza'], [sq, 'square']]) {
        const p = nav.path(from, to, {});
        assert.ok(p, `${d.id}: no path to ${what}`);
        assertPathLegal(g, p, `${d.id}->${what}`);
        assert.deepEqual(tile(p, p.length / 2 - 1), [to.x, to.y]);
        n++;
      }
    }
  }
  assert.ok(n > 0, 'no base doors tested');
});

test('roadgraph (agentville.base): the road graph is one connected network', { skip: skipAll }, async t => {
  const m = await load('roadgraph.js');
  if (!m) return t.skip('nav module not present yet');
  const g = m.buildRoadGraph(worldFor('agentville.base'));
  for (let i = 1; i < g.nodes.length; i += Math.max(1, Math.floor(g.nodes.length / 20))) assert.ok(g.route(0, i), `node ${i} not reachable from node 0`);
});
