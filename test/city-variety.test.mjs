import './support/ensure-mods-index.mjs';
// City variety: lotVariants (mods/agentville.fantasy/variety.js), its use by the fantasy mod's engine hook, and the
// variety metric (tools/engine/variety-metric.mjs). Written from the spec, not from the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const { lotVariants } = await import('../mods/agentville.fantasy/variety.js');
const { planSettlement } = await import('../web/src/city-plan.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { viewFromFixture } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');

const hGap = (a, b) => Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
const vGap = (a, b) => Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
const areNeighbours = (a, b) => (a.y === b.y && hGap(a, b) <= 3) || (a.x === b.x && vGap(a, b) <= 4);
const sameVariants = (a, b) => assert.deepEqual([...a.entries()], [...b.entries()]);

function neighbourPairs(lots) {
  const out = [];
  for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) if (areNeighbours(lots[i], lots[j])) out.push([lots[i], lots[j]]);
  return out;
}
function noSharedVariant(lots, m, label) {
  for (const [a, b] of neighbourPairs(lots)) assert.notEqual(m.get(a.id), m.get(b.id), `${label}: ${a.id} and ${b.id} share variant ${m.get(a.id)}`);
}
function gridLots(cols, rows, w = 3, h = 3, gapX = 1, gapY = 2) {
  const lots = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) lots.push({ id: `L${r}_${c}`, x: c * (w + gapX), y: r * (h + gapY), w, h });
  return lots;
}

test('empty lots give an empty Map', () => {
  const m = lotVariants([], 'proj');
  assert.ok(m instanceof Map);
  assert.equal(m.size, 0);
});

test('one integer 0..63 entry per lot', () => {
  const lots = gridLots(12, 8);
  const m = lotVariants(lots, 'alpha', { w: 60, h: 60 });
  assert.equal(m.size, lots.length);
  for (const l of lots) { const v = m.get(l.id); assert.ok(Number.isInteger(v) && v >= 0 && v <= 63, `${l.id}: ${v}`); }
});

test('deterministic across calls and fresh copies', () => {
  const lots = gridLots(10, 6);
  const opts = { w: 50, h: 40 };
  const a = lotVariants(lots, 'alpha', opts);
  sameVariants(a, lotVariants(lots, 'alpha', opts));
  sameVariants(a, lotVariants(lots.map(l => ({ ...l })), 'alpha', { ...opts }));
});

test('neighbours never share a variant (grid, rows, columns, several keys)', () => {
  const grid = gridLots(15, 10);
  for (const key of ['a', 'b', 'project-x', '', 'ünï']) noSharedVariant(grid, lotVariants(grid, key), `grid/${key}`);
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ id: 'r' + i, x: i * 4, y: 5, w: 3, h: 3 });
  for (let i = 0; i < 20; i++) rows.push({ id: 's' + i, x: i * 6, y: 20, w: 3, h: 3 });
  noSharedVariant(rows, lotVariants(rows, 'rows'), 'rows');
  const cols = [];
  for (let i = 0; i < 40; i++) cols.push({ id: 'c' + i, x: 7, y: i * 5, w: 3, h: 3 });
  for (let i = 0; i < 20; i++) cols.push({ id: 'd' + i, x: 30, y: i * 7, w: 3, h: 3 });
  noSharedVariant(cols, lotVariants(cols, 'cols'), 'cols');
});

test('neighbours differ in variant % 4 when each lot has at most 3 earlier neighbours', () => {
  const lots = gridLots(15, 10);   // left + up (+ none other) earlier
  for (const key of ['a', 'b', 'k3']) {
    const m = lotVariants(lots, key);
    for (const [a, b] of neighbourPairs(lots)) assert.notEqual(m.get(a.id) % 4, m.get(b.id) % 4, `${key}: ${a.id}/${b.id}`);
  }
  const row = Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, x: i * 4, y: 5, w: 3, h: 3 }));
  const m = lotVariants(row, 'row');
  for (const [a, b] of neighbourPairs(row)) assert.notEqual(m.get(a.id) % 4, m.get(b.id) % 4);
});

test('prefix-stable: a shorter plan agrees with the longer one', () => {
  const lots = gridLots(9, 7);
  const opts = { w: 40, h: 40 };
  const full = lotVariants(lots, 'stable', opts);
  for (const k of [1, 2, 5, 13, 30, 62]) {
    const part = lotVariants(lots.slice(0, k), 'stable', opts);
    assert.equal(part.size, k);
    for (const l of lots.slice(0, k)) assert.equal(part.get(l.id), full.get(l.id), `k=${k} ${l.id}`);
  }
});

test('height class: the centre is taller than the edge when the plan size is given', () => {
  const cols = 24, rows = 24, w = 3, h = 3;
  const lots = gridLots(cols, rows, w, h, 1, 2);
  const W = cols * (w + 1), H = rows * (h + 2);
  const m = lotVariants(lots, 'centre', { w: W, h: H });
  const dist = l => Math.hypot(l.x + l.w / 2 - W / 2, l.y + l.h / 2 - H / 2);
  const sorted = [...lots].sort((a, b) => dist(a) - dist(b));
  const q = Math.floor(sorted.length / 4);
  const mean = xs => xs.reduce((s, l) => s + ((m.get(l.id) >> 2) & 3), 0) / xs.length;
  const centre = mean(sorted.slice(0, q)), edge = mean(sorted.slice(-q));
  assert.ok(centre - edge >= 1.0, `centre ${centre.toFixed(2)} vs edge ${edge.toFixed(2)}`);
});

test('different keys give different assignments', () => {
  const lots = gridLots(6, 5);
  const a = lotVariants(lots, 'one', { w: 30, h: 30 }), b = lotVariants(lots, 'two', { w: 30, h: 30 });
  assert.equal(lots.length, 30);
  assert.notDeepEqual([...a.entries()], [...b.entries()]);
});

test('real plans (tier 2 and 3): neighbours never share a variant', () => {
  for (const tier of [2, 3]) {
    const spec = Array.from({ length: 30 }, (_, i) => ({ id: 'a' + i, rank: i === 0 ? 'L' : 'S' }));
    const plan = planSettlement({ tier, seed: 7, lots: spec.length });
    assert.ok(plan.lots.length >= 20, `tier ${tier}: ${plan.lots.length} lots`);
    const m = lotVariants(plan.lots, `proj-t${tier}`, { w: plan.w, h: plan.h });
    assert.equal(m.size, plan.lots.length);
    noSharedVariant(plan.lots, m, `tier ${tier}`);
    sameVariants(m, lotVariants(plan.lots, `proj-t${tier}`, { w: plan.w, h: plan.h }));
  }
});

// ---- engine hook --------------------------------------------------------------------------------------------------
test('fantasy mod exposes hooks.lotVariants', () => {
  assert.equal(typeof fantasy.hooks.lotVariants, 'function');
});

const read = rel => JSON.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
function build(name, mod) {
  const fx = read(`../e2e/fixtures/engine/${name}.json`);
  const { input, serverId } = toWorldInput(viewFromFixture(fx, { now: fx.now }), { seed: 7, salt: '0', features: fantasy.features });
  return buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { mod, now: fx.now, seed: 7, serverId });
}
const lotBuildings = world => [...world.objects.values()].filter(o => o.kind === 'building' && o.id.startsWith('lot:'));
const asLot = o => ({ id: o.id, x: o.tx, y: o.ty, w: o.w, h: o.h });
const stripped = { ...fantasy, hooks: { ...fantasy.hooks, lotVariants: undefined } };

for (const name of ['busy', 'six-styles']) {
  test(`${name}: no two neighbouring lot buildings share a variant`, () => {
    const world = build(name, fantasy);
    const byProject = new Map();
    for (const o of lotBuildings(world)) { assert.ok(Number.isInteger(o.variant) && o.variant >= 0 && o.variant <= 63, o.id); (byProject.get(o.project) ?? byProject.set(o.project, []).get(o.project)).push(o); }
    assert.ok(byProject.size > 0);
    for (const [proj, list] of byProject) {
      const lots = list.map(asLot);
      for (const [a, b] of neighbourPairs(lots)) assert.notEqual(list.find(o => o.id === a.id).variant, list.find(o => o.id === b.id).variant, `${proj}: ${a.id} / ${b.id}`);
    }
  });

  test(`${name}: building twice is identical`, () => {
    const key = w => [...w.objects.values()].filter(o => o.kind === 'building').map(o => [o.id, o.model, o.variant, o.tx, o.ty]);
    assert.deepEqual(key(build(name, fantasy)), key(build(name, fantasy)));
  });

  test(`${name}: removing the hook moves nothing (art never moves lots)`, () => {
    const geo = w => [...w.objects.values()].filter(o => o.kind === 'building').map(o => [o.id, o.tx, o.ty, o.w, o.h]);
    assert.deepEqual(geo(build(name, fantasy)), geo(build(name, stripped)));
  });
}

// ---- metric -------------------------------------------------------------------------------------------------------
test('variety metric on busy, tiers 2 and 3', { timeout: 300000 }, async () => {
  const { measureVariety } = await import('../tools/engine/variety-metric.mjs');
  const r = await measureVariety({ fixture: 'busy', seed: 7, tiers: [2, 3] });
  console.log('variety overall', JSON.stringify(r.overall));
  assert.ok(r.overall.buildings > 0 && r.overall.adjPairs > 0);
  assert.ok(r.overall.identicalPct <= 5, `identicalPct ${r.overall.identicalPct}`);
  // main (ed0c85d, PR sites excluded) measured lookalikePct 46.6, roofColoursPerCity 3.5, heightsPerCity 4.8
  assert.ok(r.overall.lookalikePct <= 15, `lookalikePct ${r.overall.lookalikePct}`);
  assert.ok(r.overall.roofColoursPerCity >= 4, `roofColoursPerCity ${r.overall.roofColoursPerCity}`);
  assert.ok(r.overall.heightsPerCity >= 4.8, `heightsPerCity ${r.overall.heightsPerCity}`);
  for (const c of r.cities.filter(c => c.tier === 3)) assert.ok(c.lookalikePct <= 20, `${c.name}: lookalikePct ${c.lookalikePct}`);
});
