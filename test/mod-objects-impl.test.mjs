import './support/ensure-mods-index.mjs';
// MOD1 piece M1b: the ObjectTypeTable holds NO functions (it must cross into a mod sandbox via structuredClone / JSON);
// direction variants are declarative (byDir), and the engine derives edge runs from prop.dir / prop.len.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { planSettlement } = await import('../web/src/city-plan.js');
const { footprintFor } = await import('../web/src/engine/world/footprints.js');
const { stampPlan } = await import('../web/src/engine/world/plan-adapter.js');
const { TERRAIN_TABLE } = await import('../mods/agentville.fantasy/terrain.js');
const { OBJECT_TYPES } = await import('../mods/agentville.fantasy/objects.js');
const { resolveMod, listMods } = await import('../web/src/engine/mod/registry.js');
const G = await import('../web/src/engine/core/grid.js');
const O = await import('../web/src/engine/core/objects.js');

const functionsIn = (v, path = 'objects', out = []) => {
  if (typeof v === 'function') out.push(path);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) functionsIn(x, `${path}.${k}`, out);
  return out;
};

test('the fantasy ObjectTypeTable holds no functions and survives structuredClone and JSON', () => {
  assert.deepEqual(functionsIn(OBJECT_TYPES), []);
  assert.deepEqual(structuredClone(OBJECT_TYPES), OBJECT_TYPES);
  assert.deepEqual(JSON.parse(JSON.stringify(OBJECT_TYPES)), OBJECT_TYPES);
});

test('every registered mod resolves to a function-free objects table', () => {
  for (const { id } of listMods()) {
    const m = resolveMod(id);
    assert.deepEqual(functionsIn(m.objects), [], id);
    assert.deepEqual(structuredClone(m.objects), m.objects, id);
  }
});

test('byDir picks the variant by prop.dir (y, else x) and keeps the old footprints', () => {
  const fp = (kind, dir) => footprintFor({ kind, x: 4.5, y: 4.5, v: 0, dir }, OBJECT_TYPES);
  assert.deepEqual([fp('stall', 'x').w, fp('stall', 'x').h], [2, 1]);
  assert.deepEqual([fp('stall', 'y').w, fp('stall', 'y').h], [1, 2]);
  assert.deepEqual([fp('stall', undefined).w, fp('stall', undefined).h], [2, 1], 'no dir means x');
  assert.deepEqual(fp('stall', 'x').anchors, { vend: [{ dx: 0, dy: -1, sub: 0, face: 2 }] });
  assert.deepEqual(fp('stall', 'y').anchors, { vend: [{ dx: -1, dy: 0, sub: 0, face: 1 }] });
  assert.deepEqual([fp('bench', 'x').w, fp('bench', 'x').h, fp('bench', 'x').anchors.sit.length], [1, 1, 1]);
  assert.deepEqual([fp('bench', 'y').w, fp('bench', 'y').h, fp('bench', 'y').anchors.sit.length], [1, 2, 2]);
  assert.equal(fp('bridge', 'y').dir, 'y'); assert.equal(fp('bridge', 'x').dir, 'x'); assert.equal(fp('bridge', 'y').walk, 'floor');
  for (const k of ['stall', 'bench', 'bridge']) assert.equal(fp(k, 'x').byDir, undefined, 'byDir is not leaked into the footprint');
  const a = fp('bench', 'y'); a.anchors.sit[0].dx = 99;
  assert.equal(OBJECT_TYPES.props.bench.byDir.y.anchors.sit[0].dx, 1, 'anchors are copied');
});

test('edge kinds: the engine derives w, h and run { dir, len, side } from the prop', () => {
  for (const kind of ['fence', 'hedge', 'railing']) {
    assert.deepEqual(OBJECT_TYPES.props[kind].run, undefined, 'the table carries no run');
    const x = footprintFor({ kind, x: 2, y: 3.05, dir: 'x', len: 4 }, OBJECT_TYPES);
    assert.deepEqual([x.w, x.h, x.walk, x.run], [4, 1, 'edge', { dir: 'x', len: 4, side: 'N' }]);
    const xs = footprintFor({ kind, x: 2, y: 3.95, dir: 'x', len: 2.6 }, OBJECT_TYPES);
    assert.deepEqual([xs.w, xs.run], [3, { dir: 'x', len: 3, side: 'S' }]);
    const y = footprintFor({ kind, x: 2.95, y: 3, dir: 'y', len: 4 }, OBJECT_TYPES);
    assert.deepEqual([y.w, y.h, y.run], [1, 4, { dir: 'y', len: 4, side: 'E' }]);
    const yw = footprintFor({ kind, x: 2.05, y: 3, dir: 'y' }, OBJECT_TYPES);
    assert.deepEqual([yw.h, yw.run], [1, { dir: 'y', len: 1, side: 'W' }], 'len defaults to 1');
  }
});

test('a toy plain-data table with byDir and an edge kind works without any functions', () => {
  const toy = { props: {
    gate: { z: 3, byDir: { x: { w: 2, h: 1, walk: 'block' }, y: { w: 1, h: 2, walk: 'block', z: 9 } } },
    wall: { walk: 'edge', z: 20 }, half: { byDir: { x: { w: 1, h: 1, walk: 'block', z: 1 } } } }, buildings: {} };
  const t = JSON.parse(JSON.stringify(toy));
  assert.deepEqual(footprintFor({ kind: 'gate', x: 1, y: 1 }, t), { w: 2, h: 1, walk: 'block', z: 3 });
  assert.deepEqual(footprintFor({ kind: 'gate', x: 1, y: 1, dir: 'y' }, t), { w: 1, h: 2, walk: 'block', z: 9 });
  assert.deepEqual(footprintFor({ kind: 'wall', x: 1, y: 1.1, dir: 'x', len: 3 }, t), { w: 3, h: 1, walk: 'edge', z: 20, run: { dir: 'x', len: 3, side: 'N' } });
  assert.equal(footprintFor({ kind: 'half', x: 1, y: 1, dir: 'y' }, t), null, 'a missing variant is unknown');
});

// Golden digest of stampPlan output (objects, lint, placed list, every grid layer) for tiers 0-3 x seeds 0-19 with the
// fantasy mod, recorded at engine 554bbbf BEFORE the table lost its functions. Legalising must stay byte-identical.
const GOLDEN = '8d51fdb259eab9e94d4b69ca9d1b85264038802ab12a64c42621df6faf2bff7a';
const LAYERS = ['terrain', 'ground', 'road', 'lot', 'occ', 'cost', 'cover', 'edges'];
const digest = objectsTable => {
  const mod = { id: 'agentville.fantasy', terrain: TERRAIN_TABLE, objects: objectsTable, rules: { holdMs: 432e5 } };
  const all = createHash('sha256');
  for (const t of [0, 1, 2, 3]) for (let s = 0; s < 20; s++) {
    const plan = planSettlement({ tier: t, seed: s, lots: 999 });
    const grid = new G.WorldGrid({ ox: 0, oy: 0, w: plan.w + 12, h: plan.h + 14 }), objects = new O.ObjectStore();
    const r = stampPlan(grid, objects, plan, { x: 5, y: 7 }, { mod, name: `p${s}`, index: 0, tier: t });
    const h = createHash('sha256');
    h.update(JSON.stringify([...objects.values()])); h.update(JSON.stringify(r.lint)); h.update(JSON.stringify(r.objects ?? null));
    for (const l of LAYERS) if (grid[l]) h.update(l + ':' + Buffer.from(grid[l].buffer).toString('hex'));
    all.update(h.digest('hex'));
  }
  return all.digest('hex');
};

test('stampPlan output is identical to the pre-M1b engine (tiers 0-3 x seeds 0-19), also from a JSON-cloned table', () => {
  assert.equal(digest(OBJECT_TYPES), GOLDEN);
  assert.equal(digest(JSON.parse(JSON.stringify(OBJECT_TYPES))), GOLDEN, 'the table as it arrives from a sandbox');
});
