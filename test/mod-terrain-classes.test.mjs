// MOD-4b: terrain classes drive the walk-cost rule, checkClasses lints a class list, and the fantasy sea/shore rule
// is class-driven yet identical to the old branch. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCostFn, WorldGrid } from '../web/src/engine/core/grid.js';
import { TERRAIN, GROUND_EXT } from './support/fantasy-codes.mjs';
import { checkClasses, classByName } from '../web/src/engine/mod/kit/terrain.js';
import * as pub from '#agentville/mod';
import { noise } from '#agentville/mod';
import { TERRAIN_TABLE, CLASSES } from '../mods/agentville.fantasy/terrain.js';
import { terrainAt } from '../mods/agentville.fantasy/layout/terrain-rule.js';

// The old rule, written out from the pre-classes makeCostFn (fixed fantasy codes).
function oldCost(table) {
  const cost = new Map(), over = new Set([GROUND_EXT.DOCK]);
  for (const t of table.types) if (t.code > 0 && t.code < 200) { cost.set(t.code, t.cost); if (t.tags?.includes('over-water')) over.add(t.code); }
  for (const c of Object.values(GROUND_EXT)) cost.set(c, 1);
  return (terrain, ground, road, lot, occ) => {
    if (occ !== 0) return 255;
    if ((terrain === 0 || terrain === 1) && !over.has(ground)) return 255;
    if (ground !== 0) return cost.get(ground) ?? 255;
    if (road > 0) return 1;
    if (lot >= 0) return 255;
    return terrain === 2 || terrain === 3 ? table.wildCost : 255;
  };
}

test('the fantasy table carries its classes, with today\'s codes', () => {
  assert.equal(TERRAIN_TABLE.classes, CLASSES);
  assert.deepEqual(checkClasses(CLASSES), []);
  assert.deepEqual(CLASSES.map(c => [c.code, c.name]), [[0, 'deep-sea'], [1, 'sea'], [2, 'shore'], [3, 'grass'], [4, 'forest-floor']]);
  assert.deepEqual([TERRAIN.SEA_DEEP, TERRAIN.SEA, TERRAIN.SHORE, TERRAIN.GRASS, TERRAIN.FOREST_FLOOR], [0, 1, 2, 3, 4]);
  assert.equal(classByName(TERRAIN_TABLE, 'shore').code, 2);
  assert.equal(classByName(TERRAIN_TABLE, 'nope'), undefined);
  assert.equal(classByName({}, 'shore'), undefined);
});

test('cost table is identical to the old rule for every (terrain, ground, road, lot, occ) over the fantasy table', () => {
  const f = makeCostFn(TERRAIN_TABLE), old = oldCost(TERRAIN_TABLE);
  let n = 0;
  for (let terrain = 0; terrain < 8; terrain++) for (let ground = 0; ground < 256; ground++)
    for (const road of [0, 1, 2, 3, 4]) for (const lot of [-3, -2, -1, 0, 5]) for (const occ of [0, 1, 7]) {
      assert.equal(f(terrain, ground, road, lot, occ), old(terrain, ground, road, lot, occ), `t${terrain} g${ground} r${road} l${lot} o${occ}`);
      n++;
    }
  assert.equal(n, 8 * 256 * 5 * 5 * 3);
});

test('a table with no water class: nothing is sea, and a class without wild is blocked', () => {
  const table = {
    types: [{ code: 1, name: 'path', cost: 1, tags: ['walk'] }], byName: { path: 1 }, wildCost: 5,
    classes: [{ code: 0, name: 'void' }, { code: 1, name: 'meadow', wild: true, grows: true }, { code: 2, name: 'rock' }],
  };
  assert.deepEqual(checkClasses(table.classes), []);
  const f = makeCostFn(table);
  assert.equal(f(1, 0, 0, -1, 0), 5, 'wild meadow');
  assert.equal(f(2, 0, 0, -1, 0), 255, 'rock is not wild');
  assert.equal(f(0, 0, 0, -1, 0), 255, 'class 0 is not wild here');
  assert.equal(f(0, 1, 0, 0, 0), 1, 'a path on class 0 is walkable: no class is water');
  assert.equal(f(2, 1, 0, 0, 0), 1);
  assert.equal(f(1, 0, 1, -1, 0), 1, 'wild road');
  assert.equal(f(1, 0, 0, 3, 0), 255, 'inside a block');
  assert.equal(f(1, 1, 0, 0, 1), 255, 'occupied');
  assert.equal(f(9, 0, 0, -1, 0), 255, 'an undeclared terrain code');
  assert.equal(f(1, GROUND_EXT.ROAD, 0, 0, 0), 1);
});

test('water: blocked unless the ground is over-water; the venue ground always is', () => {
  const table = {
    types: [{ code: 1, name: 'bridge', cost: 2, tags: ['over-water'] }, { code: 2, name: 'road', cost: 1 }], byName: {}, wildCost: 3,
    classes: [{ code: 0, name: 'lake', water: true }, { code: 1, name: 'land', wild: true }],
  };
  const f = makeCostFn(table);
  assert.equal(f(0, 0, 0, -1, 0), 255);
  assert.equal(f(0, 2, 0, 0, 0), 255);
  assert.equal(f(0, 1, 0, 0, 0), 2);
  assert.equal(f(0, pub.LAYOUT_GROUND.VENUE, 0, pub.LOT.VENUE, 0), 1);
  assert.equal(f(1, 0, 0, -1, 0), 3);
});

test('outside the grid is terrain 0 and cost 255', () => {
  const g = new WorldGrid({ ox: 0, oy: 0, w: 2, h: 2 });
  assert.equal(g.get('terrain', -1, 0), 0);
  assert.equal(g.get('cost', 5, 5), 255);
  assert.equal(g.get('lot', 9, 9), -1);
});

test('checkClasses flags duplicates, codes over 15 and a missing class 0', () => {
  assert.deepEqual(checkClasses([{ code: 0, name: 'a' }, { code: 1, name: 'b', water: true }]), []);
  assert.ok(checkClasses([{ code: 0, name: 'a' }, { code: 0, name: 'b' }]).some(l => /duplicate code 0/.test(l)));
  assert.ok(checkClasses([{ code: 0, name: 'a' }, { code: 1, name: 'a' }]).some(l => /duplicate name a/.test(l)));
  assert.ok(checkClasses([{ code: 0, name: 'a' }, { code: 16, name: 'b' }]).some(l => /over 15/.test(l)));
  assert.ok(checkClasses([{ code: 15, name: 'ok' }, { code: 1, name: 'b' }]).some(l => /class 0 is required/.test(l)));
  assert.ok(checkClasses([]).some(l => /class 0 is required/.test(l)));
  assert.ok(checkClasses([{ code: 0, name: 'a', water: 'yes' }]).some(l => /water must be a boolean/.test(l)));
  assert.ok(checkClasses([{ code: -1, name: 'a' }, { code: 0, name: '' }]).length >= 2);
  assert.ok(checkClasses(null).length === 1 && checkClasses('x').length === 1);
  assert.ok(checkClasses([null]).some(l => /must be an object/.test(l)));
});

test('checkClasses and classByName are on the public barrel', () => {
  assert.equal(pub.checkClasses, checkClasses);
  assert.equal(pub.classByName, classByName);
});

// ---- terrainAt vs the old branch, on a 200x200 sample ----
const key = (x, y) => x + ',' + y;
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
function oldTerrainAt(land, path, seaDist, x, y) {
  const k = key(x, y);
  if (land.has(k)) {
    if (path.has(k)) return TERRAIN.GRASS;
    for (const [a, b] of N8) if (!land.has(key(x + a, y + b))) return TERRAIN.SHORE;
    return TERRAIN.GRASS;
  }
  const d = (seaDist.get(k) ?? 30) + noise(x, y, 3) * 1.8;
  return d < 5.5 ? TERRAIN.SEA : TERRAIN.SEA_DEEP;
}

test('terrainAt matches the old branch on a 200x200 sample', () => {
  const land = new Set(), path = new Set(), seaDist = new Map();
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    const dx = x - 100, dy = y - 100;
    if (dx * dx + dy * dy < 55 * 55 + 400 * Math.sin(x / 7) + 300 * Math.cos(y / 5)) land.add(key(x, y));
    if (land.has(key(x, y)) && (x + y) % 17 === 0) path.add(key(x, y));
  }
  // seaDist: Chebyshev-ish distance to land, capped, for water tiles within 12; farther tiles are unknown
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    if (land.has(key(x, y))) continue;
    let best = Infinity;
    for (let b = -12; b <= 12 && best > 1; b++) for (let a = -12; a <= 12; a++) if (land.has(key(x + a, y + b))) best = Math.min(best, Math.hypot(a, b));
    if (best < Infinity) seaDist.set(key(x, y), best);
  }
  const r = { isLand: (x, y) => land.has(key(x, y)), isPath: (x, y) => path.has(key(x, y)), seaDist: (x, y) => seaDist.get(key(x, y)) ?? -1 };
  const seen = new Set();
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    const got = terrainAt(r, x, y);
    assert.equal(got, oldTerrainAt(land, path, seaDist, x, y), `(${x},${y})`);
    seen.add(got);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3], 'deep sea, sea, shore and grass all occur');
});
