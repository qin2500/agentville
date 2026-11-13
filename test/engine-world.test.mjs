import './support/ensure-mods-index.mjs';
// World invariants for the v2 engine (design docs/village-engine-v2.md §5.3 invariants 1, 2, 3, 8, plus determinism,
// the lint-drop tracker and fence/footprint clearance). Written from the spec, not the implementation.
// Until pieces A2-A4 land these fail with "not implemented"; fixture cases skip when the fixture file does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { edgeRunTiles } = await import('../web/src/engine/core/objects.js');
const { makeView, viewFromFixture, loadFixture, syntheticViews, syntheticFrames, NOW } = await import('./engine-support/world-views.mjs');

const SEED = 7;
const freshPersisted = () => ({ v: 1, seed: SEED, blocks: {}, lots: {} });
const build = (view, now = view.now ?? NOW, persisted = freshPersisted()) => buildWorld(view, persisted, { now, seed: SEED });

// ---- cases: synthetic always, fixtures when present -------------------------------------------------------------
const FIXTURES = ['citydemo', 'busy', 'stress', 'harbour'];
const cases = syntheticViews().map(([name, view, now]) => ({ name, get: () => ({ view, now }) }));
for (const f of FIXTURES) {
  const fx = loadFixture(`${f}.json`);
  cases.push({ name: `fixture:${f}`, skip: fx ? false : `e2e/fixtures/engine/${f}.json not present on this branch yet (piece A6)`,
    get: () => ({ view: viewFromFixture(fx), now: fx.now }) });
}
const worlds = new Map();   // memoised build per case, shared by read-only tests
const worldOf = c => {
  if (!worlds.has(c.name)) { const { view, now } = c.get(); worlds.set(c.name, build(view, now)); }
  return worlds.get(c.name);
};
const each = (title, fn, opts = {}) => { for (const c of cases) test(`${title} [${c.name}]`, { skip: c.skip, ...opts }, () => fn(worldOf(c), c)); };

// ---- helpers ------------------------------------------------------------------------------------------------------
const blockers = w => [...w.objects.values()].filter(o => o.walk === 'block');
const tilesOf = o => { const t = []; for (let y = o.ty; y < o.ty + o.h; y++) for (let x = o.tx; x < o.tx + o.w; x++) t.push([x, y]); return t; };
const rectOf = b => ({ x: b.x ?? b.tx, y: b.y ?? b.ty, w: b.w, h: b.h });
const inRect = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const blockOf = (w, project) => { const v = w.villages.find(v => v.name === project); return v && rectOf(v.block); };
const walkable = (g, x, y) => g.inBounds(x, y) && g.get('cost', x, y) < 255 && g.get('occ', x, y) === 0;

// ---- invariant 1: no overlap, project objects inside their block, occ agrees ----------------------------------------
each('inv1: no two blocking footprints overlap', w => {
  const seen = new Map();
  for (const o of blockers(w)) for (const [x, y] of tilesOf(o)) {
    const k = `${x},${y}`;
    assert.ok(!seen.has(k), `tile ${k} is covered by both ${seen.get(k)} and ${o.id}`);
    seen.set(k, o.id);
  }
});

each('inv1: every project object lies inside its own block', w => {
  for (const o of w.objects.values()) {
    if (!o.project || o.walk === 'floor') continue;
    const r = blockOf(w, o.project);
    assert.ok(r, `${o.id}: project ${o.project} has no village block`);
    for (const [x, y] of tilesOf(o)) assert.ok(inRect(r, x, y), `${o.id} tile ${x},${y} is outside block ${JSON.stringify(r)} of ${o.project}`);
  }
});

each('inv1: grid.occ agrees with the objects (both directions)', w => {
  const g = w.grid;
  for (const o of blockers(w)) {
    const num = w.objects.numOf(o.id);
    assert.ok(num >= 1, `${o.id} has no object number`);
    for (const [x, y] of tilesOf(o)) assert.equal(g.get('occ', x, y), num, `${o.id}: occ at ${x},${y}`);
  }
  for (let ty = g.oy; ty < g.oy + g.h; ty++) for (let tx = g.ox; tx < g.ox + g.w; tx++) {
    const n = g.get('occ', tx, ty);
    if (!n) continue;
    const o = w.objects.byNum(n);
    assert.ok(o, `occ ${n} at ${tx},${ty} names no object`);
    assert.equal(o.walk, 'block', `${o.id} stamps occ but is walk:${o.walk}`);
    assert.ok(inRect({ x: o.tx, y: o.ty, w: o.w, h: o.h }, tx, ty), `occ at ${tx},${ty} is outside the footprint of ${o.id}`);
  }
});

// ---- invariant 2: door forecourts ----------------------------------------------------------------------------------
each('inv2: every building door forecourt is walkable', w => {
  const g = w.grid;
  const doors = [...w.objects.values()].filter(o => o.kind === 'building' && o.door);
  for (const o of doors) {
    const { tx, ty } = o.door;
    assert.ok(g.inBounds(tx, ty), `${o.id}: door ${tx},${ty} outside the grid`);
    assert.ok(g.get('cost', tx, ty) < 255, `${o.id}: door tile cost is 255`);
    assert.equal(g.get('occ', tx, ty), 0, `${o.id}: door tile is occupied by ${g.get('occ', tx, ty)}`);
  }
});

// TODO(M2, lead 2026-11-13): at the 32x16 projection the M1 prism estimate (footprint + a per-look height guess) covers
// ~14% of doors (busy: 92/678), mostly by a taller neighbour one or two depth steps in front. Kept as a tracked todo
// until M2 measures true sprite bounds; whatever still fails then is a city-plan spacing fix (design §2.4, §7.5),
// reported by world.lint 'covered-forecourt'.
each('inv2: every building door forecourt has cover 0', w => {
  const g = w.grid;
  const covered = [...w.objects.values()].filter(o => o.kind === 'building' && o.door && g.get('cover', o.door.tx, o.door.ty) > 0);
  assert.deepEqual(covered.map(o => o.id), [], `${covered.length} covered door tiles`);
}, { todo: 'M2: true sprite bounds, then city-plan spacing' });

each('inv2: every building door is connected (grid.canStep BFS) to the town square', w => {
  const g = w.grid, sq = rectOf(w.square);
  const seen = new Uint8Array(g.w * g.h), q = [];
  for (let y = sq.y; y < sq.y + sq.h; y++) for (let x = sq.x; x < sq.x + sq.w; x++)
    if (walkable(g, x, y)) { seen[g.idx(x, y)] = 1; q.push(x, y); }
  assert.ok(q.length, 'the town square has no walkable tile');
  for (let h = 0; h < q.length; h += 2) {
    const x = q[h], y = q[h + 1];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (!g.inBounds(nx, ny) || seen[g.idx(nx, ny)] || !walkable(g, nx, ny) || !g.canStep(x, y, nx, ny)) continue;
      seen[g.idx(nx, ny)] = 1; q.push(nx, ny);
    }
  }
  const lost = [...w.objects.values()].filter(o => o.kind === 'building' && o.door && !seen[g.idx(o.door.tx, o.door.ty)]).map(o => o.id);
  assert.deepEqual(lost, [], `doors not connected to the square: ${lost.slice(0, 8).join(', ')}${lost.length > 8 ? ` (+${lost.length - 8})` : ''}`);
});

// ---- invariant 3: anchors ------------------------------------------------------------------------------------------
each('inv3: no stand/sit/work/vend anchor is on a blocked or covered tile', w => {
  const g = w.grid;
  let n = 0;
  for (const o of w.objects.values()) for (const kind of ['stand', 'sit', 'work', 'vend']) for (const s of o.anchors?.[kind] || []) {
    n++;
    assert.ok(g.inBounds(s.tx, s.ty), `${o.id} ${kind} anchor ${s.tx},${s.ty} is outside the grid`);
    assert.equal(g.get('occ', s.tx, s.ty), 0, `${o.id} ${kind} anchor ${s.tx},${s.ty} is on an occupied tile`);
    assert.ok(g.get('cost', s.tx, s.ty) < 255, `${o.id} ${kind} anchor ${s.tx},${s.ty} is on an impassable tile`);
    assert.equal(g.get('cover', s.tx, s.ty), 0, `${o.id} ${kind} anchor ${s.tx},${s.ty} is covered (cover > 0)`);
  }
  assert.ok(n > 0, 'no anchors at all: the world offers actors nowhere to stand');
});

// ---- fences ----------------------------------------------------------------------------------------------------------
each('edge runs (fences) never cross a building footprint', w => {
  const bt = new Map();
  for (const o of w.objects.values()) if (o.kind === 'building') for (const [x, y] of tilesOf(o)) bt.set(`${x},${y}`, o.id);
  for (const o of w.objects.values()) {
    if (o.walk !== 'edge') continue;
    for (const { tx, ty } of edgeRunTiles(o)) assert.ok(!bt.has(`${tx},${ty}`), `${o.id} runs through building ${bt.get(`${tx},${ty}`)} at ${tx},${ty}`);
  }
});

// ---- determinism -----------------------------------------------------------------------------------------------------
const GRID_LAYERS = ['terrain', 'ground', 'road', 'lot', 'occ', 'edges', 'cost', 'cover', 'slots'];
for (const c of cases) test(`determinism: same inputs twice give identical grid arrays and object ids [${c.name}]`, { skip: c.skip }, () => {
  const { view, now } = c.get();
  const a = build(view, now), b = build(view, now);
  assert.deepEqual([a.grid.ox, a.grid.oy, a.grid.w, a.grid.h], [b.grid.ox, b.grid.oy, b.grid.w, b.grid.h]);
  for (const k of GRID_LAYERS) assert.ok(Buffer.from(a.grid[k].buffer).equals(Buffer.from(b.grid[k].buffer)), `grid layer ${k} differs between runs`);
  assert.deepEqual([...a.objects.keys()].sort(), [...b.objects.keys()].sort(), 'object ids differ between runs');
  for (const [id, o] of a.objects) assert.equal(b.objects.numOf(id), a.objects.numOf(id), `${id}: object number differs`);
  assert.equal(a.sig, b.sig);
});

// ---- lint: drops are planner bugs (design §1.3) ----------------------------------------------------------------------
for (const c of cases) test(`lint: zero 'drop' entries in world.lint [${c.name}]`, { skip: c.skip }, () => {
  const drops = worldOf(c).lint.filter(e => e.kind === 'drop');
  assert.equal(drops.length, 0, `${drops.length} dropped prop(s), first: ${JSON.stringify(drops.slice(0, 3))}`);
});

// ---- invariant 8: stability over a 50-poll sequence ----------------------------------------------------------------
const clone = o => JSON.parse(JSON.stringify(o));
function replay(frames) {
  const persisted = freshPersisted();      // ONE persisted object carried across every poll
  let prev = null, checked = { blocks: 0, lots: 0 };
  frames.forEach((fr, i) => {
    const view = makeView(fr, { now: fr.now });
    const w = buildWorld(view, persisted, { now: fr.now, seed: SEED });
    const shown = new Set([...w.objects.values()].map(o => o.data?.item).filter(Boolean));
    const cur = { blocks: clone(persisted.blocks), lots: clone(persisted.lots) };
    if (prev) {
      for (const [name, b] of Object.entries(cur.blocks)) {
        const p = prev.blocks[name];
        if (!p) continue;
        const sameShape = p.tier === b.tier && p.cap === b.cap;
        if (sameShape) {
          checked.blocks++;
          assert.deepEqual([b.x, b.y, b.w, b.h], [p.x, p.y, p.w, p.h], `poll ${i}: block ${name} moved although its tier/cap did not change (${p.tier}/${p.cap})`);
        }
        const pl = prev.lots[name]?.a, cl = cur.lots[name]?.a;
        if (!pl || !cl || !sameShape) continue;
        for (const [item, lot] of Object.entries(pl)) {
          if (!shown.has(item) || !(item in cl)) continue;
          checked.lots++;
          assert.equal(cl[item], lot, `poll ${i}: ${name} item ${item} moved from lot ${lot} to ${cl[item]} while shown`);
        }
      }
    }
    prev = cur;
  });
  assert.ok(checked.blocks > 0, 'sequence never produced a comparable block (is persisted.blocks being filled?)');
  return checked;
}

test('inv8: 50 synthetic polls never move an unchanged block or a shown lot assignment', () => {
  const c = replay(syntheticFrames(50));
  assert.ok(c.lots > 0, 'no lot assignment was ever comparable (is persisted.lots[name].a being filled?)');
});

{
  const fx = loadFixture('sequence-50.json');
  test('inv8: sequence-50 fixture never moves an unchanged block or a shown lot assignment',
    { skip: fx ? false : 'e2e/fixtures/engine/sequence-50.json not present on this branch yet (piece A6)' }, () => {
      assert.equal(fx.frames.length, 50);
      replay(fx.frames);
    });
}
