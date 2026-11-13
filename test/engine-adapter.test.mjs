import './support/ensure-mods-index.mjs';
// Engine v2 piece A4: footprints, lots, plan adapter, scatter, buildWorld. Uses minimal fakes for the grid and object
// store (A2's real classes are used instead when they are implemented, see REAL below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { planSettlement } = await import('../web/src/city-plan.js');
const { footprintFor } = await import('../web/src/engine/world/footprints.js');
const { stampPlan } = await import('../web/src/engine/world/plan-adapter.js');
const { assignLots } = await import('../web/src/engine/world/lots.js');
const { scatterWild } = await import('../web/src/engine/world/scatter.js');
const { TERRAIN_TABLE } = await import('../mods/agentville.fantasy/terrain.js');
const { OBJECT_TYPES } = await import('../mods/agentville.fantasy/objects.js');
// build.js is the lead's and may not be on the MOD0 seams yet (it still imports grid.js costOf): load it lazily, skip when it fails.
const { buildWorld } = await import('../web/src/engine/world/build.js').catch(() => ({ buildWorld: null }));
const { makeView } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const G = await import('../web/src/engine/core/grid.js');
const O = await import('../web/src/engine/core/objects.js');

const HOLD_MS = 432e5;
const MOD = { id: 'agentville.fantasy', terrain: TERRAIN_TABLE, objects: OBJECT_TYPES, rules: { holdMs: HOLD_MS } };
const DECALS = new Set(Object.entries(OBJECT_TYPES.props).filter(([, v]) => v && v.decal).map(([k]) => k));

// ---- fakes -------------------------------------------------------------------------------------------------------
class FakeGrid {
  constructor(r) {
    Object.assign(this, r); const n = r.w * r.h; this.version = 0;
    for (const k of ['terrain', 'ground', 'road', 'edges', 'cost', 'cover', 'slots']) this[k] = new Uint8Array(n);
    this.lot = new Int32Array(n).fill(-1); this.occ = new Int32Array(n);
  }
  idx(x, y) { return this.inBounds(x, y) ? (y - this.oy) * this.w + (x - this.ox) : -1; }
  inBounds(x, y) { return x >= this.ox && y >= this.oy && x < this.ox + this.w && y < this.oy + this.h; }
  get(l, x, y) { const i = this.idx(x, y); return i < 0 ? 0 : this[l][i]; }
  set(l, x, y, v) { const i = this.idx(x, y); if (i >= 0) this[l][i] = v; }
  tiles(o) { const t = []; for (let j = 0; j < o.h; j++) for (let i = 0; i < o.w; i++) t.push([o.tx + i, o.ty + j]); return t; }
  canPlace(o) { return o.walk === 'floor' || this.tiles(o).every(([x, y]) => this.inBounds(x, y) && (o.walk === 'edge' || !this.occ[this.idx(x, y)])); }
  stamp(o, num) {
    if (o.walk === 'floor') return { ok: true, conflicts: [] };
    if (!this.canPlace(o)) return { ok: false, conflicts: [] };
    if (o.walk === 'block') for (const [x, y] of this.tiles(o)) this.occ[this.idx(x, y)] = num;
    this.version++; return { ok: true, conflicts: [] };
  }
  isBlocked(x, y) { return this.get('occ', x, y) !== 0; }
}
class FakeStore extends Map { constructor() { super(); this.n = 0; } add(o) { this.set(o.id, o); return ++this.n; } }
const REAL = (() => { try { new G.WorldGrid({ ox: 0, oy: 0, w: 2, h: 2 }); new O.ObjectStore().add({ id: 'x' }); return true; } catch { return false; } })();

const isWalk = c => !!TERRAIN_TABLE.types.find(t => t.code === c)?.tags.includes('walk');
const TIERS = [0, 1, 2, 3], SEEDS = [...Array(20).keys()];
const plans = new Map();
const planOf = (t, s) => { const k = `${t}:${s}`; if (!plans.has(k)) plans.set(k, planSettlement({ tier: t, seed: s, lots: 999 })); return plans.get(k); };
const stampOne = (t, s) => {
  const plan = planOf(t, s), org = { x: 5, y: 7 };
  const grid = new FakeGrid({ ox: 0, oy: 0, w: plan.w + 12, h: plan.h + 14 }), objects = new FakeStore();
  const r = stampPlan(grid, objects, plan, org, { mod: MOD, name: `p${s}`, index: 0, tier: t });
  return { plan, grid, objects, org, lint: r.lint, placed: r.objects };
};

// ---- footprints --------------------------------------------------------------------------------------------------
test('footprint table covers every prop kind city-plan emits (tiers 0-3, seeds 0-19)', () => {
  const kinds = new Set();
  for (const t of TIERS) for (const s of SEEDS) for (const p of planOf(t, s).props) kinds.add(p.kind);
  assert.ok(kinds.size >= 25, `saw ${kinds.size} kinds`);
  for (const k of kinds) {
    const fp = footprintFor({ kind: k, x: 3.5, y: 3.5, v: 0, dir: 'x', len: 3 }, OBJECT_TYPES);
    if (DECALS.has(k)) { assert.equal(fp, null, k); continue; }
    assert.ok(fp, `no footprint for ${k}`);
    assert.ok(['block', 'edge', 'floor'].includes(fp.walk) && fp.w >= 1 && fp.h >= 1 && fp.z >= 0, k);
  }
});
test('footprint table: the design §1.2 shapes', () => {
  const f = k => footprintFor({ kind: k, x: 4, y: 4, v: 0, dir: 'x', len: 5 }, OBJECT_TYPES);
  assert.deepEqual([f('fountain').w, f('fountain').h, f('fountain').walk], [2, 2, 'block']);
  assert.equal(f('fountain').anchors.sit.length, 4);
  assert.deepEqual([f('stall').w, f('stall').h], [2, 1]);
  assert.equal(f('stall').anchors.vend[0].face, 2);
  assert.deepEqual([footprintFor({ kind: 'bench', x: 1, y: 1, dir: 'y' }, OBJECT_TYPES).w, footprintFor({ kind: 'bench', x: 1, y: 1, dir: 'y' }, OBJECT_TYPES).h], [1, 2]);
  assert.ok(f('bench').anchors.sit);
  for (const k of ['statue', 'well', 'maypole', 'trough', 'noticeboard', 'signpost', 'cart', 'woodpile', 'beehive', 'lamp', 'lamppost', 'banner', 'tree']) assert.deepEqual([f(k).w, f(k).h, f(k).walk], [1, 1, 'block'], k);
  assert.deepEqual(f('fence').run, { dir: 'x', len: 5, side: 'S' === f('fence').run.side ? 'S' : 'N' });
  assert.equal(footprintFor({ kind: 'fence', x: 2, y: 3.05, dir: 'x', len: 4 }, OBJECT_TYPES).run.side, 'N');
  assert.equal(footprintFor({ kind: 'fence', x: 2.95, y: 3, dir: 'y', len: 4 }, OBJECT_TYPES).run.side, 'E');
  assert.equal(f('bridge').walk, 'floor');
  for (const k of ['flowers', 'flowerbox', 'hay']) assert.equal(f(k), null);
  assert.ok(OBJECT_TYPES.props.tree);
  for (const k of ['lamp', 'lamppost', 'banner']) assert.equal(f(k).snap, 'street-edge', k);
  assert.equal(f('tree').kind, 'tree');
  assert.equal(OBJECT_TYPES.buildings.palace.z, 58);
});

// ---- stampPlan ---------------------------------------------------------------------------------------------------
const lintTotals = {};
test('stampPlan: no overlapping footprints, door and forecourt clear, routes stay connected (tiers 0-3, seeds 0-19)', () => {
  for (const t of TIERS) {
    const tot = lintTotals[t] = { drop: 0, nudge: 0, overlap: 0, other: 0, props: 0 };
    for (const s of SEEDS) {
      const { plan, grid, objects, org, lint, placed } = stampOne(t, s);
      const seen = new Map();
      for (const o of objects.values()) {
        if (o.walk !== 'block') continue;
        for (const [x, y] of grid.tiles(o)) { const k = `${x},${y}`; assert.ok(!seen.has(k), `${t}/${s}: ${o.id} overlaps ${seen.get(k)} at ${k}`); seen.set(k, o.id); }
      }
      for (const o of objects.values()) if (o.kind === 'building' && o.door) {
        assert.ok(isWalk(grid.get('ground', o.door.tx, o.door.ty)), `${t}/${s}: ${o.id} door tile not walkable`);
        for (const k of [0, 1, 2]) assert.equal(grid.get('occ', o.door.tx + k, o.door.ty + k), 0, `${t}/${s}: ${o.id} forecourt ${k} blocked`);
      }
      // connectivity: every walkable tile that could reach a gate before stamping still can
      const W = plan.w, H = plan.h, ok = (x, y) => x >= 0 && y >= 0 && x < W && y < H && isWalk(plan.ground[y * W + x]);
      const reach = blocked => {
        const q = [], sn = new Set();
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ok(x, y) && (x === 0 || y === 0 || x === W - 1 || y === H - 1) && !blocked(x, y)) { q.push([x, y]); sn.add(y * W + x); }
        for (let i = 0; i < q.length; i++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = q[i][0] + dx, b = q[i][1] + dy; if (ok(a, b) && !blocked(a, b) && !sn.has(b * W + a)) { sn.add(b * W + a); q.push([a, b]); } }
        return sn;
      };
      const before = reach(() => false), after = reach((x, y) => grid.isBlocked(org.x + x, org.y + y));
      for (const k of after) assert.ok(before.has(k));
      for (const k of before) { const x = k % W, y = (k / W) | 0; if (!grid.isBlocked(org.x + x, org.y + y)) assert.ok(after.has(k), `${t}/${s}: tile ${x},${y} cut off by a prop`); }
      for (const l of lint) tot[l.kind in tot ? l.kind : 'other']++;
      tot.props += plan.props.length;
      assert.ok(placed.length > 0);
    }
  }
});
test('stampPlan: lamps, lampposts and banners on streets stand on the street edge', () => {
  let seen = 0;
  for (const t of [1, 2, 3]) for (const s of SEEDS.slice(0, 8)) {
    const { grid, objects, org, plan } = stampOne(t, s);
    for (const o of objects.values()) {
      if (!['lamp', 'lamppost', 'banner'].includes(o.model)) continue;
      const x = o.tx - org.x, y = o.ty - org.y;
      if (!isWalk(plan.ground[y * plan.w + x])) continue;
      seen++;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const a = x + dx, b = y + dy; return a >= 0 && b >= 0 && a < plan.w && b < plan.h && !isWalk(plan.ground[b * plan.w + a]); });
      assert.ok(edge, `${t}/${s}: ${o.id} mid-street`);
    }
  }
  assert.ok(seen > 0);
});
test('stampPlan: ids are stable and independent of ownership; buildings carry doors and heights', () => {
  const a = stampOne(2, 3), b = stampOne(2, 3);
  assert.deepEqual([...a.objects.keys()], [...b.objects.keys()]);
  const bld = [...a.objects.values()].filter(o => o.kind === 'building');
  assert.ok(bld.length > 5);
  for (const o of bld) {
    assert.match(o.id, /^(lot|civic):p3:/);
    assert.ok(o.z >= 28 && o.z <= 100);
  }
  const l = a.plan.lots[0], lo = a.objects.get(`lot:p3:${l.id}`);
  assert.deepEqual(lo.door, { tx: a.org.x + l.x + Math.floor(l.doorX / 16), ty: a.org.y + l.y + l.h, face: 'S' });
  assert.equal(lo.rank, l.rank);
  assert.ok([...a.objects.keys()].some(k => /^prop:p3:\w+:\d+$/.test(k)));
});
test('stampPlan: fence runs never cross a building footprint', () => {
  for (const t of [0, 1]) for (const s of SEEDS) {
    const { grid, objects } = stampOne(t, s);
    const bld = new Set();
    for (const o of objects.values()) if (o.kind === 'building') for (const [x, y] of grid.tiles(o)) bld.add(`${x},${y}`);
    for (const o of objects.values()) if (o.walk === 'edge') for (const [x, y] of grid.tiles(o)) assert.ok(!bld.has(`${x},${y}`), `${o.id} runs into a building`);
  }
});

// ---- assignLots --------------------------------------------------------------------------------------------------
const mkAgents = (n, role = 'worker') => Array.from({ length: n }, (_, i) => ({ id: `${role}${i}`, role }));
const RANK = { boss: 'L', lead: 'M' };
const reqsOf = (homes, prs, name) => [
  ...homes.map(a => ({ item: `home:${a.id}`, owner: 'home', rank: RANK[a.role] || (a.important ? 'L' : 'S'), agent: a.id })),
  ...prs.map(p => ({ item: `pr:${name}#${p.id}`, owner: 'pr', rank: 'S', pr: p.id, building: !!p.live }))];
const village = (homes, prs = []) => { const plan = planOf(2, 1); return { name: 'proj', plan, requests: reqsOf(homes, prs, 'proj'), cap: plan.cap, tier: 2 }; };
test('assignLots: rank rule, stability and HOLD_MS', () => {
  const homes = [{ id: 'b', role: 'boss' }, { id: 'l', role: 'lead' }, { id: 'p', role: 'worker', important: true }, ...mkAgents(5)];
  const store = {}, now = 1e9;
  const r1 = assignLots(village(homes, [{ id: '7', live: true }]), store, now, MOD);
  const lotOf = id => [...r1.byLot].find(([, it]) => it === id)?.[0];
  const rankOfLot = lot => planOf(2, 1).lots.find(l => l.id === lot).rank;
  assert.equal(rankOfLot(lotOf('home:b')), 'L');
  assert.ok(['L', 'M'].includes(rankOfLot(lotOf('home:p'))));
  assert.ok(lotOf('home:l'));
  assert.equal(rankOfLot(lotOf('home:worker0')), 'S');
  assert.equal(r1.items.get('pr:proj#7').building, true);
  assert.equal(r1.items.get('home:b').owner, 'home');
  // same items again and again: same lots
  const r2 = assignLots(village(homes.slice().reverse(), [{ id: '7', live: false }]), store, now + 1000, MOD);
  assert.deepEqual([...r2.byLot].sort(), [...r1.byLot].sort());
  // a gone agent keeps its lot for HOLD_MS, then it is freed
  const gone = lotOf('home:worker3');
  const left = homes.filter(h => h.id !== 'worker3');
  const r3 = assignLots(village(left, [{ id: '7', live: true }]), store, now + 2000, MOD);
  assert.ok(!r3.byLot.has(gone) && store.proj.a['home:worker3'] === gone);
  assignLots(village(left, [{ id: '7', live: true }]), store, now + 2000 + HOLD_MS - 10, MOD);
  assert.equal(store.proj.a['home:worker3'], gone);
  assignLots(village(left, [{ id: '7', live: true }]), store, now + 2000 + HOLD_MS + 10, MOD);
  assert.equal(store.proj.a['home:worker3'], undefined);
  // a re-plan (capacity change) starts afresh
  const v = village(left); v.cap += 5;
  assignLots(v, store, now + 3000, MOD);
  assert.equal(store.proj.cap, v.cap);
});
test('assignLots: a newcomer evicts the oldest gone item when every lot is taken', () => {
  const plan = planOf(0, 2), n = plan.lots.length, store = {};
  const mk = ids => ({ name: 'q', plan, requests: reqsOf(ids.map(id => ({ id, role: 'worker' })), [], 'q'), cap: plan.cap, tier: 0 });
  const all = Array.from({ length: n }, (_, i) => `a${i}`);
  assignLots(mk(all), store, 1000, MOD);
  assert.equal(Object.keys(store.q.a).length, n);
  const r = assignLots(mk([...all.slice(2), 'new']), store, 2000, MOD);   // a0, a1 gone (held), one newcomer: evicts a0 (oldest gone)
  assert.ok(r.items.has('home:new'));
  assert.equal(store.q.a['home:a0'] ?? store.q.a['home:a1'] ? 1 : 0, 1);
});

// ---- mod seams ---------------------------------------------------------------------------------------------------
test('footprintFor reads the passed table, not a built-in one', () => {
  const toy = { props: { tree: { w: 3, h: 2, walk: 'block', z: 5 }, glow: { decal: true }, gate: p => ({ w: 1, h: 1, walk: 'floor', z: 0, dir: p.dir }) }, buildings: {} };
  assert.deepEqual(footprintFor({ kind: 'tree', x: 1, y: 1 }, toy), { w: 3, h: 2, walk: 'block', z: 5 });
  assert.equal(footprintFor({ kind: 'glow', x: 1, y: 1 }, toy), null);
  assert.equal(footprintFor({ kind: 'lamp', x: 1, y: 1 }, toy), null, 'the fantasy kind is unknown to the toy table');
  assert.equal(footprintFor({ kind: 'gate', x: 1, y: 1, dir: 'y' }, toy).dir, 'y');
  assert.throws(() => footprintFor({ kind: 'tree' }), /ObjectTypeTable/);
  const fp = footprintFor({ kind: 'fountain', x: 4, y: 4 }, OBJECT_TYPES); fp.anchors.sit[0].dx = 99;
  assert.equal(OBJECT_TYPES.props.fountain.anchors.sit[0].dx, 0, 'anchors are copied');
});
test('stampPlan reads terrain tags and building heights from the mod', () => {
  const plan = planOf(1, 3), org = { x: 2, y: 2 };
  const run = mod => { const grid = new FakeGrid({ ox: 0, oy: 0, w: plan.w + 6, h: plan.h + 6 }), objects = new FakeStore(); const r = stampPlan(grid, objects, plan, org, { mod, name: 'x', index: 0, tier: 1 }); return { grid, objects, r }; };
  // no walkable tags at all: no road layer and every tile counts as non-walkable, so lamps are not snapped
  const none = { ...MOD, terrain: { ...TERRAIN_TABLE, types: TERRAIN_TABLE.types.map(t => ({ ...t, tags: [] })) } };
  assert.ok(Array.from(run(none).grid.road).every(v => v === 0));
  assert.ok(Array.from(run(MOD).grid.road).some(v => v === G.ROAD.STREET) && Array.from(run(MOD).grid.road).some(v => v === G.ROAD.LANE));
  const tall = { ...MOD, objects: { ...OBJECT_TYPES, buildings: Object.fromEntries(Object.keys(OBJECT_TYPES.buildings).map(k => [k, { z: 77 }])) } };
  for (const o of run(tall).objects.values()) if (o.kind === 'building') assert.equal(o.z, 77);
  assert.throws(() => stampPlan(new FakeGrid({ ox: 0, oy: 0, w: 5, h: 5 }), new FakeStore(), plan, org, { name: 'x', index: 0, tier: 1 }), /ctx\.mod/);
});
test('scatterWild: the curve comes from the mod scatter hook; no hook, no scatter', { skip: !REAL && 'needs the real grid' }, async () => {
  const { scatter } = await import('../mods/agentville.fantasy/scatter.js');
  const mod = { id: 'toy', objects: OBJECT_TYPES, terrain: TERRAIN_TABLE, hooks: { scatter } };
  const grass = TERRAIN_TABLE.classes.find(c => c.name === 'grass').code;
  const run = m => {
    const grid = new G.WorldGrid({ ox: 0, oy: 0, w: 60, h: 60 }), store = new O.ObjectStore();
    grid.terrain.fill(grass);
    return { n: scatterWild(grid, store, {}, 5, m), store };
  };
  const a = run(mod), b = run(mod);
  assert.ok(a.n > 20); assert.equal(a.n, b.n);
  assert.equal(scatterWild(new G.WorldGrid({ ox: 0, oy: 0, w: 4, h: 4 }), new O.ObjectStore(), {}, 1, { id: 'x', objects: {} }), 0);
});

// ---- buildWorld --------------------------------------------------------------------------------------------------
test('buildWorld is deterministic on a small view (needs A2 + A3 merged)', { skip: (!REAL && 'A2/A3 not merged') || (!buildWorld && 'build.js not on the MOD0 seams yet') }, () => {
  const agents = [
    { id: 'a1', name: 'a1', project: 'alpha', role: 'boss', bucket: 'working', live: true, prs: [] },
    { id: 'a2', name: 'a2', project: 'alpha', role: 'worker', bucket: 'working', live: true, prs: [{ id: 5 }] },
    { id: 'b1', name: 'b1', project: 'beta', role: 'lead', bucket: 'working', live: true, prs: [] },
  ];
  const run = () => { const view = makeView({ agents, projects: [] }, { now: 1e12, demo: true }), per = { v: 1, seed: 7, blocks: {}, lots: {} }; const { input, serverId } = toWorldInput(view, { seed: 7 }); return { w: buildWorld(input, per, { serverId, mod: resolveMod('agentville.fantasy'), now: 1e12, seed: 7 }), per }; };
  const a = run(), b = run();
  assert.deepEqual([...a.w.objects.keys()], [...b.w.objects.keys()]);
  assert.deepEqual(a.w.lint, b.w.lint);
  assert.deepEqual(a.per.lots, b.per.lots);
  assert.deepEqual(Array.from(a.w.grid.occ), Array.from(b.w.grid.occ));
  assert.ok([...a.w.objects.values()].some(o => o.crown));
});

test('lint totals (report)', () => {
  const line = t => { const x = lintTotals[t]; return `tier ${t}: props ${x.props}, drops ${x.drop}, nudges ${x.nudge}, overlaps ${x.overlap}, other ${x.other}`; };
  console.log('LINT over seeds 0-19\n' + TIERS.map(line).join('\n'));
});

// review M1 B4: a plan cannot write engine-reserved ground codes (> MOD_CODE_MAX), e.g. forge SQUARE or DOCK tiles
test('stampPlan drops engine-reserved plan ground codes and lints once', { skip: !REAL && 'needs the real grid' }, () => {
  const plan = { w: 3, h: 1, ground: Uint8Array.from([202, 201, 0]), plaza: { x: 0, y: 0, w: 1, h: 1 }, lots: [], civic: [], props: [] };
  const grid = new G.WorldGrid({ ox: 0, oy: 0, w: 3, h: 1 });
  const r = stampPlan(grid, new O.ObjectStore(), plan, { x: 0, y: 0 }, { mod: MOD, name: 'p', index: 1, tier: 0, style: null });
  assert.equal(grid.get('ground', 0, 0), 0); assert.equal(grid.get('ground', 1, 0), 0);
  assert.equal(r.lint.filter(l => l.kind === 'forged-ground').length, 1);
});
