import './support/ensure-mods-index.mjs';
// Parity proofs for the world and layout rules (docs/engine-parity.json, area "World and layout"). One test per item,
// titled `[<id>] ...` so tools/parity.mjs can count it. Each builds real worlds (buildWorld over the fantasy mod) from
// the engine fixtures or from a hand-built WorldInput, and checks the behaviour the classic app had.
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { ROAD, LOT } = await import('../web/src/engine/core/grid.js');
const { makeView, viewFromFixture, loadFixture, syntheticViews, NOW } = await import('./engine-support/world-views.mjs');
const { TERRAIN } = await import('./support/fantasy-codes.mjs');
const { RULES, HOOKS, tierWithHysteresis, rankOf, homesOf } = await import('../mods/agentville.fantasy/rules.js');
const { tierFor, capacityFor, TIERS } = await import('../web/src/city-plan.js');
const { assignLots } = await import('../web/src/engine/world/lots.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');

const SEED = 7;
const DAY = 864e5, HOUR = 36e5;
const fresh = () => ({ v: 1, seed: SEED, blocks: {}, lots: {} });
const build = (view, now = view.now ?? NOW, persisted = fresh(), opts = {}) => buildWorld(view, persisted, { now, seed: SEED, ...opts });
const rectOf = b => ({ x: b.x, y: b.y, w: b.w, h: b.h });
const MODS = resolveMod();
const GAP = RULES.layout.gap;

// ---- worlds, built once -------------------------------------------------------------------------------------------
const cache = new Map();
const once = (k, f) => (cache.has(k) ? cache.get(k) : (cache.set(k, f()), cache.get(k)));
const synth = name => syntheticViews().find(([n]) => n === name);
const synthWorld = name => once(`s:${name}`, () => { const [, v, now] = synth(name); return build(v, now); });
const fixWorld = name => once(`f:${name}`, () => { const fx = loadFixture(`${name}.json`); assert.ok(fx, `fixture ${name}`); return build(viewFromFixture(fx), fx.now); });
const WORLDS = () => [['mixed', synthWorld('synthetic-mixed')], ['wide', synthWorld('synthetic-wide')], ['busy', fixWorld('busy')], ['stress', fixWorld('stress')]];
const roadAt = (w, x, y) => (w.grid.inBounds(x, y) ? w.grid.get('road', x, y) : 0);

// ---- a hand-built WorldInput (what engine/mod/input.js produces) ---------------------------------------------------
const agent = (id, project, o = {}) => ({ id, name: id, project, parent: o.parent ?? null, status: o.status ?? 'working', needs: null,
  role: o.role ?? 'worker', crown: o.role === 'boss', important: !!o.important, stopped: false, harness: 'claude',
  since: 0, lastActive: o.lastActive ?? 0, prs: [] });
const pr = (project, n, live) => ({ id: `${project}#${n}`, project, number: n, title: '', state: live ? 'building' : 'merged',
  checks: { passed: 0, failed: 0, pending: 0 }, review: null, size: { additions: 0, deletions: 0, files: 0 } });
function input(agents, prs = [], now = NOW, stats = {}) {
  const names = [...new Set(agents.map(a => a.project))];
  const projects = names.map(n => ({ key: n, name: n, accent: '', stats: { prsEver: prs.filter(p => p.project === n).length,
    prsLive: prs.filter(p => p.project === n && p.state === 'building').length, agentsEver: agents.filter(a => a.project === n).length,
    agentsNow: agents.filter(a => a.project === n).length, transcriptMB: 0, ...(stats[n] || {}) } }));
  return { apiVersion: 1, now, seed: SEED, agents, projects, prs, env: { night: 0, reduceMotion: false, zoom: 1 } };
}
const lotObjs = (w, name) => [...w.objects.values()].filter(o => o.kind === 'building' && o.project === name && o.id.startsWith('lot:'));
const homeLot = (w, name, id) => lotObjs(w, name).find(o => o.data?.item === `home:${id}`);

// ============================== world and layout ==============================

test('[world.project-blocks-compact] blocks sit apart by the gap, clear of the square, and stay compact round it', () => {
  for (const [name, w] of WORLDS()) {
    const blocks = w.villages.map(v => rectOf(v.block));
    const SQ = w.square;
    const apart = (a, b, g) => a.x < b.x + b.w + g && b.x < a.x + a.w + g && a.y < b.y + b.h + g && b.y < a.y + a.h + g;
    for (let i = 0; i < blocks.length; i++) {
      assert.ok(!apart(blocks[i], SQ, GAP), `${name}: block ${i} too near the square`);
      for (let j = i + 1; j < blocks.length; j++) assert.ok(!apart(blocks[i], blocks[j], GAP), `${name}: blocks ${i} and ${j} closer than the gap`);
    }
    // compact: the town's bounding box is not much bigger than the blocks themselves (no sprawl); aspect near the classic 1.25
    const x0 = Math.min(SQ.x, ...blocks.map(b => b.x)), x1 = Math.max(SQ.x + SQ.w, ...blocks.map(b => b.x + b.w));
    const y0 = Math.min(SQ.y, ...blocks.map(b => b.y)), y1 = Math.max(SQ.y + SQ.h, ...blocks.map(b => b.y + b.h));
    const used = blocks.reduce((s, b) => s + b.w * b.h, SQ.w * SQ.h);
    const fill = used / ((x1 - x0) * (y1 - y0));
    assert.ok(fill > 0.4, `${name}: the town fills only ${(fill * 100).toFixed(0)}% of its bounding box`);
    if (blocks.length >= 8) assert.ok((x1 - x0) / (y1 - y0) < 2.2 && (y1 - y0) / (x1 - x0) < 2.2, `${name}: town box ${x1 - x0}x${y1 - y0} is stretched`);
    // every block touches the town: the nearest neighbour (block or square) is within gap + a few tiles
    for (const [i, b] of blocks.entries()) {
      const near = [SQ, ...blocks.filter((_, j) => j !== i)].some(o => apart(b, o, GAP + 4));
      assert.ok(near, `${name}: block ${i} floats away from the town`);
    }
  }
});

test('[world.shared-streets-2-wide] two neighbouring blocks share one street, two tiles wide (both ring roads side by side)', () => {
  let pairs = 0;
  for (const [name, w] of WORLDS()) {
    const bs = w.villages.map(v => rectOf(v.block));
    for (const a of bs) for (const b of bs) {
      if (a === b || b.x !== a.x + a.w + GAP) continue;                      // b is exactly GAP east of a
      const y0 = Math.max(a.y, b.y), y1 = Math.min(a.y + a.h, b.y + b.h);
      if (y1 - y0 < 3) continue;
      pairs++;
      for (let y = y0; y < y1; y++) for (let k = 0; k < GAP; k++) assert.ok(roadAt(w, a.x + a.w + k, y) >= ROAD.STREET, `${name}: street column ${k} missing at y=${y}`);
    }
  }
  assert.equal(GAP, 2);
  assert.ok(pairs > 0, 'found no pair of blocks side by side to check');
});

test('[world.ring-roads] every block is ringed by a street on all four sides', () => {
  for (const [name, w] of WORLDS()) {
    for (const v of w.villages) {
      const b = v.block;
      for (let x = b.x - 1; x <= b.x + b.w; x++) for (const y of [b.y - 1, b.y + b.h]) assert.ok(roadAt(w, x, y) >= ROAD.STREET, `${name}/${v.name}: ring gap at ${x},${y}`);
      for (let y = b.y; y < b.y + b.h; y++) for (const x of [b.x - 1, b.x + b.w]) assert.ok(roadAt(w, x, y) >= ROAD.STREET, `${name}/${v.name}: ring gap at ${x},${y}`);
    }
  }
});

test('[world.astar-roads-to-square] a road network joins every block ring to the square, in 2-wide lanes', () => {
  for (const [name, w] of WORLDS()) {
    const seen = new Set(), q = [], key = (x, y) => `${x},${y}`, SQ = w.square;
    for (let y = SQ.y; y < SQ.y + SQ.h; y++) for (let x = SQ.x; x < SQ.x + SQ.w; x++) { seen.add(key(x, y)); q.push([x, y]); }
    for (let k = 0; k < q.length; k++) for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = q[k][0] + a, y = q[k][1] + b;
      if (seen.has(key(x, y)) || roadAt(w, x, y) < ROAD.PATH) continue;
      seen.add(key(x, y)); q.push([x, y]);
    }
    let lanes = 0;
    for (const t of seen) { const [x, y] = t.split(',').map(Number); if (roadAt(w, x, y) === ROAD.LANE) lanes++; }
    for (const v of w.villages) {
      const b = v.block, ring = [];
      for (let x = b.x - 1; x <= b.x + b.w; x++) ring.push([x, b.y - 1], [x, b.y + b.h]);
      for (let y = b.y; y < b.y + b.h; y++) ring.push([b.x - 1, y], [b.x + b.w, y]);
      assert.ok(ring.every(([x, y]) => seen.has(key(x, y))), `${name}/${v.name}: ring is not connected to the square by road`);
    }
    // the roads are 2 wide: nearly every lane tile sits in a full 2x2 square of road
    let wide = 0, all = 0;
    const inBlockNear = (x, y) => w.villages.some(v => x >= v.block.x - 2 && x <= v.block.x + v.block.w + 1 && y >= v.block.y - 2 && y <= v.block.y + v.block.h + 1);
    for (const t of seen) {
      const [x, y] = t.split(',').map(Number);
      if (roadAt(w, x, y) !== ROAD.LANE || inBlockNear(x, y)) continue;
      all++;
      if ([[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([a, b]) => [[0, 0], [1, 0], [0, 1], [1, 1]].every(([c, d]) => roadAt(w, x + a + c, y + b + d) >= ROAD.PATH))) wide++;
    }
    assert.ok(all === 0 || wide / all > 0.95, `${name}: only ${wide}/${all} lane tiles are 2 wide`);
    if (w.villages.length > 1) assert.ok(lanes > 0, `${name}: no lane tiles joined the ring roads to the square`);
  }
});

const terrainOf = (w, x, y) => (w.grid.inBounds(x, y) ? w.grid.get('terrain', x, y) : 0);
const tiles = w => { const g = w.grid, out = []; for (let y = g.oy; y < g.oy + g.h; y++) for (let x = g.ox; x < g.ox + g.w; x++) out.push([x, y, g.get('terrain', x, y)]); return out; };
const isWaterT = t => t === TERRAIN.SEA || t === TERRAIN.SEA_DEEP;

test('[world.forest-belt] wild grass far from the town turns to forest floor and grows denser with distance', () => {
  for (const [name, w] of [['mixed', synthWorld('synthetic-mixed')], ['busy', fixWorld('busy')]]) {
    const g = w.grid, ff = tiles(w).filter(([, , t]) => t === TERRAIN.FOREST_FLOOR);
    assert.ok(ff.length > 30, `${name}: only ${ff.length} forest-floor tiles`);
    // forest floor sits away from anything built: no building footprint within 2 tiles of it
    const near = (x, y, r) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (g.inBounds(x + dx, y + dy) && (g.get('occ', x + dx, y + dy) !== 0 && w.objects.byNum?.(g.get('occ', x + dx, y + dy))?.kind === 'building')) return true; return false; };
    for (const [x, y] of ff.slice(0, 400)) assert.ok(!near(x, y, 2), `${name}: forest floor at ${x},${y} touches a building`);
    // trees thicken into the belt: more trees per tile on forest floor than on ordinary grass
    const trees = [...w.objects.values()].filter(o => o.data?.wild && o.kind === 'tree');
    const onFF = trees.filter(o => terrainOf(w, o.tx, o.ty) === TERRAIN.FOREST_FLOOR).length;
    const onGrass = trees.filter(o => terrainOf(w, o.tx, o.ty) === TERRAIN.GRASS).length;
    const grassTiles = tiles(w).filter(([, , t]) => t === TERRAIN.GRASS).length;
    assert.ok(onFF / ff.length > 1.5 * (onGrass / Math.max(1, grassTiles)), `${name}: forest floor not denser (${onFF}/${ff.length} vs ${onGrass}/${grassTiles})`);
  }
});

test('[world.shore-and-sea] land is grass, a shore rim touches the water, sea shades to deep sea further out', () => {
  for (const [name, w] of WORLDS()) {
    const all = tiles(w), has = c => all.some(([, , t]) => t === c);
    for (const c of ['SEA_DEEP', 'SEA', 'SHORE', 'GRASS']) assert.ok(has(TERRAIN[c]), `${name}: no ${c} tiles`);
    const n8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    let shore = 0;
    for (const [x, y, t] of all) {
      const touchesWater = n8.some(([a, b]) => isWaterT(terrainOf(w, x + a, y + b)));
      if (t === TERRAIN.SHORE) { shore++; assert.ok(touchesWater, `${name}: shore ${x},${y} touches no water`); }
      if (t === TERRAIN.GRASS) assert.ok(!touchesWater || roadAt(w, x, y) > 0 || w.grid.get('ground', x, y) !== 0, `${name}: bare grass ${x},${y} on the water's edge`);
    }
    assert.ok(shore > 0);
    // the grid's outer ring is deep sea; sea (the lighter band) only ever lies between land and deep sea
    const g = w.grid;
    for (const [x, y] of [[g.ox, g.oy], [g.ox + g.w - 1, g.oy + g.h - 1], [g.ox, g.oy + g.h - 1], [g.ox + g.w - 1, g.oy]]) assert.equal(terrainOf(w, x, y), TERRAIN.SEA_DEEP, `${name}: corner ${x},${y} is not deep sea`);
    const dist = (x, y) => { for (let r = 1; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r && terrainOf(w, x + dx, y + dy) >= TERRAIN.SHORE) return r; return 99; };
    const sea = all.filter(([, , t]) => t === TERRAIN.SEA).slice(0, 300), deep = all.filter(([, , t]) => t === TERRAIN.SEA_DEEP).slice(0, 300);
    const mean = l => l.reduce((s, [x, y]) => s + dist(x, y), 0) / l.length;
    assert.ok(mean(sea) < mean(deep), `${name}: sea is not nearer land than deep sea`);
  }
});

/** Water components (4-connected) of the world; each is { n, touchesEdge }. */
function waterBodies(w) {
  const g = w.grid, seen = new Uint8Array(g.w * g.h), out = [], I = (x, y) => (y - g.oy) * g.w + (x - g.ox);
  for (let y = g.oy; y < g.oy + g.h; y++) for (let x = g.ox; x < g.ox + g.w; x++) {
    if (seen[I(x, y)] || !isWaterT(terrainOf(w, x, y))) continue;
    let n = 0, edge = false;
    const q = [[x, y]]; seen[I(x, y)] = 1;
    for (let k = 0; k < q.length; k++) {
      const [cx, cy] = q[k]; n++;
      if (cx === g.ox || cy === g.oy || cx === g.ox + g.w - 1 || cy === g.oy + g.h - 1) edge = true;
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + a, ny = cy + b;
        if (!g.inBounds(nx, ny) || seen[I(nx, ny)] || !isWaterT(terrainOf(w, nx, ny))) continue;
        seen[I(nx, ny)] = 1; q.push([nx, ny]);
      }
    }
    out.push({ n, edge });
  }
  return out;
}

test('[world.lakes-filled] no enclosed lake: every body of water reaches the open sea', () => {
  for (const [name, w] of WORLDS()) {
    const bodies = waterBodies(w);
    assert.ok(bodies.length >= 1 && bodies.some(b => b.edge), `${name}: no open sea`);
    for (const b of bodies) assert.ok(b.edge, `${name}: an enclosed lake of ${b.n} water tiles`);
  }
});

test('[world.no-one-tile-spits] no thin spit of land (a tile with one land neighbour) pokes into the sea outside the town', () => {
  for (const [name, w] of WORLDS()) {
    const [tx0, ty0, tx1, ty1] = w.layoutData.town;
    const land = (x, y) => terrainOf(w, x, y) >= TERRAIN.SHORE;
    let checked = 0;
    for (const [x, y, t] of tiles(w)) {
      if (t < TERRAIN.SHORE || (x >= tx0 && x <= tx1 && y >= ty0 && y <= ty1) || roadAt(w, x, y) > 0) continue;
      checked++;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => land(x + a, y + b)).length;
      assert.ok(n >= 2, `${name}: land tile ${x},${y} is a ${n === 0 ? 'speck' : 'one-tile spit'}`);
    }
    assert.ok(checked > 50, `${name}: only ${checked} outer land tiles checked`);
  }
});

// ---- quiet projects ------------------------------------------------------------------------------------------------
const qa = (id, project, bucket, ago, o = {}) => ({ id, name: id, project, bucket, role: o.role ?? 'boss', parentId: null, prs: [], live: bucket !== 'resting',
  lastActivityAt: NOW - ago, important: !!o.important });
const qview = (agents, o = {}, opts = {}) => makeView({ agents, projects: [...new Set(agents.map(a => a.project))].map(name => ({ name, prs: [], transcriptBytes: 0, agentsEver: 1 })), hideQuiet: true, ...o }, { now: NOW, ...opts });
const QUIET_SET = () => [qa('a1', 'busy', 'building', 60e3), qa('b1', 'old', 'resting', 3 * DAY), qa('b2', 'old', 'resting', 2 * DAY),
  qa('c1', 'fresh-rest', 'resting', 2 * HOUR), qa('d1', 'pinned', 'resting', 5 * DAY, { important: true })];

test('[world.quiet-projects-hidden] a project whose agents all rest and were idle for a day leaves the village (its agents too)', () => {
  const v = qview(QUIET_SET());
  assert.deepEqual(v.quiet, ['old']);
  const shown = new Set(v.agents.map(a => a.project));
  assert.ok(!shown.has('old'), 'the quiet project still shows');
  for (const p of ['busy', 'fresh-rest', 'pinned']) assert.ok(shown.has(p), `${p} should stay (awake, recent, or Important)`);
  assert.ok(v.byId.has('b1'), 'hidden agents stay in byId for parent lookups');
  // the world built from that view has no block for it, and showing quiet projects brings it back
  const w = build(v);
  assert.ok(!w.villages.some(x => x.name === 'old') && w.villages.some(x => x.name === 'busy'));
  const all = qview(QUIET_SET(), { hideQuiet: false });
  assert.deepEqual(all.quiet, []);
  assert.ok(new Set(all.agents.map(a => a.project)).has('old'));
  // the village never goes empty: when everything is quiet the three most recently active stay
  const dead = qview(['p1', 'p2', 'p3', 'p4', 'p5'].map((p, i) => qa(`x${i}`, p, 'resting', (3 + i) * DAY)));
  assert.equal(new Set(dead.agents.map(a => a.project)).size, 3);
  assert.equal(dead.quiet.length, 2);
});

test('[world.selected-project-always-shown] the selected agent keeps its quiet project in the village', () => {
  const plain = qview(QUIET_SET());
  assert.ok(plain.quiet.includes('old'));
  const sel = qview(QUIET_SET(), {}, { selected: 'b2' });
  assert.ok(sel.agents.some(a => a.project === 'old'), 'the selected agent project was hidden');
  assert.ok(!sel.quiet.includes('old'));
  assert.ok(build(sel).villages.some(x => x.name === 'old'), 'no block for the selected project');
  // selecting an agent of a visible project changes nothing else
  assert.deepEqual(qview(QUIET_SET(), {}, { selected: 'a1' }).quiet, ['old']);
});

// ---- blocks, parks, holds, re-planning -----------------------------------------------------------------------------
const trio = (extra = []) => input([agent('a0', 'alpha', { role: 'boss' }), agent('b0', 'beta', { role: 'boss' }), agent('c0', 'gamma', { role: 'boss' }), ...extra]);
const only = (names, base = trio()) => ({ ...base, agents: base.agents.filter(a => names.includes(a.project)), projects: base.projects.filter(p => names.includes(p.name)) });

test('[world.hidden-blocks-park-14d] a hidden project keeps its block as a park for 14 days, then the ground is free', () => {
  assert.equal(RULES.layout.reserveMs, 14 * DAY);
  const P = fresh();
  const w0 = buildWorld(trio(), P, { now: NOW, seed: SEED });
  const betaBlock = rectOf(w0.villages.find(v => v.name === 'beta').block);
  const hidden = only(['alpha', 'gamma']);
  const w1 = buildWorld({ ...hidden, now: NOW + 13 * DAY }, P, { now: NOW + 13 * DAY, seed: SEED });
  // the persisted `seen` is NOW, so 13 days on it is still reserved: a park, and nobody may be placed on it
  assert.equal(w1.parks.length, 1);
  assert.deepEqual(rectOf(w1.parks[0]), betaBlock);
  const newcomer = input([...hidden.agents, agent('n0', 'newbie', { role: 'boss' })], [], NOW + 13 * DAY);
  const w2 = buildWorld(newcomer, P, { now: NOW + 13 * DAY, seed: SEED });
  const nb = w2.villages.find(v => v.name === 'newbie').block;
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!hit(nb, betaBlock), 'a newcomer was placed on a reserved park');
  // past 14 days the reservation lapses
  const w3 = buildWorld({ ...hidden, now: NOW + 15 * DAY }, P, { now: NOW + 15 * DAY, seed: SEED });
  assert.ok(!w3.parks.some(p => rectOf(p).x === betaBlock.x && rectOf(p).y === betaBlock.y), 'beta is still a park after 14 days');
});

test('[world.vanished-hold-12h] a vanished home keeps its lot for 12 hours, then it is freed', () => {
  assert.equal(RULES.holdMs, 12 * HOUR);
  const base = [agent('boss', 'alpha', { role: 'boss' }), agent('lead', 'alpha', { role: 'lead', parent: 'boss' }), agent('imp', 'alpha', { role: 'worker', important: true })];
  const P = fresh();
  const w0 = buildWorld(input(base), P, { now: NOW, seed: SEED });
  const lot = homeLot(w0, 'alpha', 'lead').data && homeLot(w0, 'alpha', 'lead').lot;
  assert.ok(lot, 'the lead had a lot');
  const gone = input(base.filter(a => a.id !== 'lead'), [], NOW + 6 * HOUR);
  const w1 = buildWorld(gone, P, { now: NOW + 6 * HOUR, seed: SEED });
  assert.equal(P.lots.alpha.a['home:lead'], lot, 'the lot was given up before 12 h');
  assert.ok(!homeLot(w1, 'alpha', 'lead'), 'the vanished home is still drawn as lived in');
  // the hold runs from the first rebuild that saw it gone (NOW + 6 h)
  buildWorld({ ...gone, now: NOW + 17 * HOUR }, P, { now: NOW + 17 * HOUR, seed: SEED });
  assert.equal(P.lots.alpha.a['home:lead'], lot, 'freed before the 12 h were up');
  const w2 = buildWorld({ ...gone, now: NOW + 19 * HOUR }, P, { now: NOW + 19 * HOUR, seed: SEED });
  assert.equal(P.lots.alpha.a['home:lead'], undefined, 'the lot was not freed after 12 h');
  assert.ok(w2.villages.length === 1);
  // a returning home within the hold gets the same lot back
  const P2 = fresh();
  buildWorld(input(base), P2, { now: NOW, seed: SEED });
  buildWorld(gone, P2, { now: NOW + 6 * HOUR, seed: SEED });
  const back = buildWorld(input(base, [], NOW + 8 * HOUR), P2, { now: NOW + 8 * HOUR, seed: SEED });
  assert.equal(homeLot(back, 'alpha', 'lead').lot, lot);
});

test('[world.tiers-hysteresis] four tiers; a tier rises at once and drops only below 60% of its threshold', () => {
  assert.deepEqual(TIERS, ['hamlet', 'village', 'town', 'city']);
  const at = [0, 12, 40, 200];                                   // least growth for tier 0..3
  at.forEach((g, t) => { assert.equal(tierFor(g), t); if (g) assert.equal(tierFor(g - 1), t - 1); });
  assert.equal(tierWithHysteresis(12, 0), 1, 'rises at the threshold');
  assert.equal(tierWithHysteresis(200, 1), 3, 'jumps straight up');
  assert.equal(tierWithHysteresis(11, 1), 1, 'one under the threshold stays');
  assert.equal(tierWithHysteresis(Math.ceil(0.6 * 12), 1), 1, 'still held at 8 (60% of 12 is 7.2)');
  assert.equal(tierWithHysteresis(7, 1), 0, 'under 60% of 12 it drops');
  assert.equal(tierWithHysteresis(24, 2), 2, 'a town holds down to 24 (60% of 40)');
  assert.equal(tierWithHysteresis(23, 2), 1);
  assert.equal(tierWithHysteresis(120, 3), 3, 'a city holds down to 120');
  assert.equal(tierWithHysteresis(119, 3), 2, 'a city drops under 120');
  assert.equal(tierWithHysteresis(5, null), 0, 'no previous tier: the plain tier');
  // the mod's tier hook is this rule, and ?citytier forces a tier
  assert.equal(HOOKS.tier(8, 1, {}), 1);
  assert.equal(HOOKS.tier(5, 1, {}), 0);   // 5 < 7.2
  assert.equal(HOOKS.tier(0, 0, { forcedTier: 9 }), 3);
  // and it reaches the world: a project that shrinks inside the band keeps its tier, one that shrinks past it drops
  const grown = (n, prev) => { const a = Array.from({ length: n }, (_, i) => agent(`g${i}`, 'grow', { role: i ? 'worker' : 'boss', parent: i ? 'g0' : null })); const P = fresh(); if (prev) P.blocks.grow = { x: 20, y: 20, w: 1, h: 1, tier: prev, gt: prev, cap: 1 }; return buildWorld(input(a), P, { now: NOW, seed: SEED }).villages[0].tier; };
  assert.equal(grown(40, 0), 2);
  assert.equal(grown(30, 2), 2, 'held at 75%');
  assert.equal(grown(20, 2), 1, 'dropped under 60%');
});

test('[world.capacity-buckets] a plot has a capacity bucket that fits its lots and only grows within a tier', () => {
  for (let t = 0; t < 4; t++) {
    let last = 0;
    const buckets = new Set();
    for (let n = 1; n <= 60; n++) {
      const c = HOOKS.capacity(t, n);
      assert.equal(c, capacityFor(t, n));
      assert.ok(c >= n, `tier ${t}: capacity ${c} < need ${n}`);
      assert.ok(c >= last, `tier ${t}: capacity shrinks with need`);
      last = c; buckets.add(c);
    }
    assert.ok(buckets.size > 1 && buckets.size < 40, `tier ${t}: capacities are not a small set of buckets (${buckets.size})`);
  }
  // within one bucket, a few more or fewer items give the same plot (stable layouts)
  const c1 = HOOKS.capacity(1, 10);
  assert.ok([9, 10, 11].some(n => HOOKS.capacity(1, n) === c1) && HOOKS.capacity(1, c1) === c1);
  // in a world: need -> cap; it never shrinks while the tier stays
  const many = n => Array.from({ length: n }, (_, i) => agent(`m${i}`, 'big', { role: i ? 'lead' : 'boss', parent: i ? 'm0' : null }));
  const P = fresh();
  const wA = buildWorld(input(many(14), [], NOW, { big: { agentsEver: 20 } }), P, { now: NOW, seed: SEED });
  const capA = wA.villages[0].cap;
  assert.equal(capA, capacityFor(wA.villages[0].tier, 14));
  const wB = buildWorld(input(many(3), [], NOW, { big: { agentsEver: 20 } }), P, { now: NOW + 1, seed: SEED });
  assert.equal(wB.villages[0].cap, capA, 'capacity shrank inside the same tier');
});

test('[world.replan-only-changed-plot] when one project changes tier or capacity only its plot is re-planned', () => {
  const small = n => Array.from({ length: n }, (_, i) => agent(`z${i}`, 'zed', { role: i ? 'lead' : 'boss', parent: i ? 'z0' : null }));
  const others = [agent('a0', 'alpha', { role: 'boss' }), agent('b0', 'beta', { role: 'boss' }), agent('c0', 'gamma', { role: 'boss' })];
  const P = fresh();
  const w0 = buildWorld(input([...others, ...small(2)]), P, { now: NOW, seed: SEED });
  const snap = name => JSON.stringify(rectOf(w0.villages.find(v => v.name === name).block));
  const before = Object.fromEntries(['alpha', 'beta', 'gamma', 'zed'].map(n => [n, snap(n)]));
  const lotsBefore = JSON.stringify({ alpha: P.lots.alpha, beta: P.lots.beta, gamma: P.lots.gamma });
  const zedCap0 = w0.villages.find(v => v.name === 'zed').cap, zedLots0 = JSON.stringify(P.lots.zed);
  const w1 = buildWorld(input([...others, ...small(30)], [], NOW + 1000), P, { now: NOW + 1000, seed: SEED });
  const zed1 = w1.villages.find(v => v.name === 'zed');
  assert.ok(zed1.cap > zedCap0, 'the fixture must actually grow zed');
  const after = n => JSON.stringify(rectOf(w1.villages.find(v => v.name === n).block));
  for (const n of ['alpha', 'beta', 'gamma']) assert.equal(after(n), before[n], `${n} moved or re-planned`);
  assert.equal(JSON.stringify({ alpha: P.lots.alpha, beta: P.lots.beta, gamma: P.lots.gamma }), lotsBefore, 'other plots lost their lot assignments');
  assert.notEqual(JSON.stringify(P.lots.zed), zedLots0);
  assert.equal(P.lots.zed.cap, zed1.cap);
  // assignLots itself: a cap change starts that map afresh, an unchanged one keeps it
  const set = { name: 'p', plan: { lots: [{ id: 'l0', rank: 'L' }, { id: 'l1', rank: 'S' }] }, requests: [{ item: 'home:x', owner: 'home', rank: 'L', agent: 'x' }], cap: 2, tier: 0, crowns: 1 };
  const pl = {};
  assignLots(set, pl, NOW, MODS);
  assert.equal(pl.p.a['home:x'], 'l0');
  pl.p.a['home:old'] = 'l1';
  assignLots(set, pl, NOW + 1, MODS);
  assert.equal(pl.p.a['home:old'], 'l1', 'an unchanged plan lost its assignment');
  assignLots({ ...set, cap: 3 }, pl, NOW + 2, MODS);
  assert.equal(pl.p.a['home:old'], undefined, 'a capacity change should start afresh');
});

// ============================== lots ==============================

test('[lots.rank-l-m-s] a home asks for lot rank L (boss, Important), M (lead) or S (anyone else), and the plan has all three', () => {
  assert.equal(rankOf({ role: 'boss' }), 'L');
  assert.equal(rankOf({ role: 'worker', important: true }), 'L');
  assert.equal(rankOf({ role: 'lead' }), 'M');
  assert.equal(rankOf({ role: 'sub' }), 'S');
  assert.equal(rankOf({ role: 'worker' }), 'S');
  const ag = [agent('boss', 'alpha', { role: 'boss' }), agent('l1', 'alpha', { role: 'lead', parent: 'boss' }), agent('l2', 'alpha', { role: 'lead', parent: 'boss' }),
    agent('s1', 'alpha', { role: 'sub', parent: 'l1' }), agent('w1', 'alpha', { role: 'worker' })];
  const w = buildWorld(input(ag, [], NOW, { alpha: { agentsEver: 40, prsEver: 5 } }), fresh(), { now: NOW, seed: SEED });
  const ranks = new Set(lotObjs(w, 'alpha').map(o => o.rank));
  for (const r of ['L', 'M', 'S']) assert.ok(ranks.has(r), `no ${r} lots in the plot`);
  assert.equal(homeLot(w, 'alpha', 'boss').rank, 'L');
  assert.equal(homeLot(w, 'alpha', 'l1').rank, 'M');
  assert.equal(homeLot(w, 'alpha', 'w1').rank, 'S');
  // the lot order: L requests are served before M before S, so a lone L lot goes to the boss, not an earlier sub
  const set = { name: 'p', plan: { lots: [{ id: 'S0', rank: 'S' }, { id: 'M0', rank: 'M' }, { id: 'L0', rank: 'L' }] }, cap: 3, tier: 0,
    requests: [{ item: 'home:sub', owner: 'home', rank: 'S' }, { item: 'home:lead', owner: 'home', rank: 'M' }, { item: 'home:boss', owner: 'home', rank: 'L' }] };
  const { items } = assignLots(set, {}, NOW, MODS);
  assert.ok(items.has('home:boss'));
  const pl = {}; assignLots(set, pl, NOW, MODS);
  assert.deepEqual([pl.p.a['home:boss'], pl.p.a['home:lead'], pl.p.a['home:sub']], ['L0', 'M0', 'S0']);
});

test('[lots.boss-important-large-leads-medium] bosses and Important agents live in large (L) lots, leads in medium (M)', () => {
  // a plot has one L lot, so the boss and the Important agent are asked in two separate projects (each is the only L request)
  const ag = [agent('boss', 'alpha', { role: 'boss' }), agent('lead', 'alpha', { role: 'lead', parent: 'boss' }), agent('sub', 'alpha', { role: 'sub', parent: 'lead' }),
    agent('lead2', 'beta', { role: 'lead' }), agent('pin', 'beta', { role: 'sub', parent: 'lead2', important: true })];
  const w = buildWorld(input(ag, [], NOW, { alpha: { agentsEver: 40, prsEver: 5 }, beta: { agentsEver: 40, prsEver: 5 } }), fresh(), { now: NOW, seed: SEED });
  assert.equal(homeLot(w, 'alpha', 'boss').rank, 'L');
  assert.equal(homeLot(w, 'alpha', 'lead').rank, 'M');
  assert.equal(homeLot(w, 'beta', 'pin').rank, 'L');
  assert.equal(homeLot(w, 'beta', 'lead2').rank, 'M');
  assert.ok(!homeLot(w, 'alpha', 'sub'), 'a sub lives in its lead home, it owns none');
  assert.equal(HOOKS.lots({}, ag, []).find(l => l.agent === 'pin').rank, 'L');
  assert.equal(HOOKS.lots({}, ag, []).find(l => l.agent === 'lead').rank, 'M');
  // an Important agent keeps a home of its own even while resting, and a parentless agent counts as an owner too
  assert.ok(homesOf([agent('r', 'p', { role: 'sub', parent: 'x', status: 'resting', important: true })]).length === 1);
  assert.equal(homesOf([agent('s', 'p', { role: 'sub', parent: 'x' })]).length, 0, 'a plain sub shares its lead home, it has none');
});

test('[lots.resting-home-cap-2] at most the 2 most recently active resting homes are kept, awake homes always', () => {
  assert.equal(HOOKS.lots({}, [], []).length, 0);
  const ag = [];
  for (let i = 0; i < 6; i++) ag.push(agent(`r${i}`, 'alpha', { role: 'lead', status: 'resting', lastActive: NOW - i * 1000 }));
  ag.push(agent('w0', 'alpha', { role: 'boss', status: 'working' }), agent('w1', 'alpha', { role: 'lead', status: 'waiting' }), agent('keep', 'alpha', { role: 'lead', status: 'resting', important: true, lastActive: 1 }));
  const homes = HOOKS.lots({}, ag, []).filter(l => l.owner === 'home').map(l => l.agent);
  assert.deepEqual(homes.filter(id => id.startsWith('r')).sort(), ['r0', 'r1'], 'only the two most recent resting homes');
  for (const id of ['w0', 'w1', 'keep']) assert.ok(homes.includes(id), `${id} lost its home`);
  const w = buildWorld(input(ag, [], NOW, { alpha: { agentsEver: 60, prsEver: 6 } }), fresh(), { now: NOW, seed: SEED });
  const lived = lotObjs(w, 'alpha').filter(o => o.data?.owner === 'home').map(o => o.data.agentId);
  assert.equal(lived.filter(id => id.startsWith('r')).length, 2);
  assert.ok(lived.includes('r0') && lived.includes('r1') && !lived.includes('r5'));
});

test('[lots.pr-caps] at most 6 live and 3 finished PR buildings, newest first', () => {
  const prs = [];
  for (let n = 1; n <= 9; n++) prs.push(pr('alpha', n, true));
  for (let n = 20; n <= 25; n++) prs.push(pr('alpha', n, false));
  const wants = HOOKS.lots({}, [agent('b', 'alpha', { role: 'boss' })], prs).filter(l => l.owner === 'pr');
  const live = wants.filter(l => l.building), done = wants.filter(l => !l.building);
  assert.equal(live.length, 6);
  assert.equal(done.length, 3);
  assert.deepEqual(live.map(l => l.pr), [9, 8, 7, 6, 5, 4].map(n => `alpha#${n}`), 'the six newest live PRs');
  assert.deepEqual(done.map(l => l.pr), [25, 24, 23].map(n => `alpha#${n}`), 'the three newest finished PRs');
  const w = buildWorld(input([agent('b', 'alpha', { role: 'boss' })], prs, NOW, { alpha: { agentsEver: 60, prsEver: 15 } }), fresh(), { now: NOW, seed: SEED });
  const sites = lotObjs(w, 'alpha').filter(o => o.data?.owner === 'pr');
  assert.equal(sites.filter(o => o.data.building).length, 6);
  assert.equal(sites.filter(o => !o.data.building).length, 3);
});

test('[lots.free-lots-townsfolk-houses] lots nobody wants become ordinary houses; wanted ones are homes and PR buildings', () => {
  const ag = [agent('b', 'alpha', { role: 'boss' }), agent('l', 'alpha', { role: 'lead', parent: 'b' })];
  const w = buildWorld(input(ag, [pr('alpha', 1, true)], NOW, { alpha: { agentsEver: 60, prsEver: 6 } }), fresh(), { now: NOW, seed: SEED });
  const lots = lotObjs(w, 'alpha');
  const by = k => lots.filter(o => o.data?.owner === k);
  assert.equal(by('home').length, 2);
  assert.equal(by('pr').length, 1);
  const houses = by('house');
  assert.ok(houses.length >= 3, `expected spare lots as houses, got ${houses.length}`);
  assert.equal(lots.length, 2 + 1 + houses.length, 'every lot is a home, a PR building or a house');
  assert.ok(houses.every(o => o.data.item === null && o.kind === 'building'));
  // a house is not a home: the cap that folds resting homes only decides whose lot is whose, never how many lots there are
  const w2 = buildWorld(input([agent('b', 'alpha', { role: 'boss' })], [], NOW, { alpha: { agentsEver: 60, prsEver: 6 } }), fresh(), { now: NOW, seed: SEED });
  assert.equal(lotObjs(w2, 'alpha').length, lots.length);
});

test('[lots.civic-landmarks-per-tier] bigger tiers carry more civic landmarks, and the plan builds them', () => {
  const counts = [];
  for (let t = 0; t < 4; t++) {
    const ag = [agent('b', `t${t}`, { role: 'boss' })];
    const w = buildWorld(input(ag, [], NOW, { [`t${t}`]: { agentsEver: 1 } }), fresh(), { now: NOW, seed: SEED, forcedTier: t });
    const v = w.villages[0];
    assert.equal(v.tier, t);
    const civic = [...w.objects.values()].filter(o => o.kind === 'building' && o.id.startsWith(`civic:${v.name}:`));
    assert.equal(civic.length, (v.plan.civic || []).length, 'every planned landmark is built');
    counts.push([civic.length, new Set(civic.map(o => o.model))]);
  }
  // every tier has its own landmark set (classic city-plan): farm buildings, then chapel/inn/smithy, market and guild halls, the cathedral
  assert.ok(counts.every(c => c[0] >= 3), `every tier has landmarks (${counts.map(c => c[0])})`);
  const has = (t, m) => counts[t][1].has(m);
  assert.ok(has(0, 'windmill') && has(1, 'chapel') && has(1, 'inn') && has(2, 'markethall') && has(2, 'clocktower') && has(3, 'cathedral'), 'tier landmarks differ from classic');
  assert.ok(!has(0, 'cathedral') && !has(2, 'cathedral') && !has(0, 'chapel'), 'the cathedral and chapel belong only to the bigger tiers');
  assert.notDeepEqual([...counts[0][1]].sort(), [...counts[2][1]].sort());
});
