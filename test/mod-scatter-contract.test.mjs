// MOD-4c: the scatter hook contract (api.js hooks.scatter). The engine runs the mechanics (BFS, lattice, 2x2-free, cover, draws,
// objects); the mod decides what grows. Toy hooks on a synthetic grid; no real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scatterWild } from '../web/src/engine/world/scatter.js';
import { WorldGrid } from '../web/src/engine/core/grid.js';
import { TERRAIN } from './support/fantasy-codes.mjs';
import { ObjectStore } from '../web/src/engine/core/objects.js';
import { rand } from '../web/src/engine/core/rng.js';
import { OBJECT_TYPES } from '../mods/agentville.fantasy/objects.js';
import { TERRAIN_TABLE } from '../mods/agentville.fantasy/terrain.js';
import { scatter as fantasyScatter } from '../mods/agentville.fantasy/scatter.js';

const mkGrid = (w = 20, h = 20) => {
  const grid = new WorldGrid({ ox: 0, oy: 0, w, h }), store = new ObjectStore();
  grid.terrain.fill(TERRAIN.GRASS);
  return { grid, store };
};
// the hook runs on tiles whose terrain class `grows` (the mod's classes; C1: no engine default), so toys carry fantasy's table
const mkMod = (hook, extra = {}) => ({ id: 'toy', objects: OBJECT_TYPES, terrain: TERRAIN_TABLE, hooks: hook ? { scatter: hook } : {}, ...extra });
const wild = store => [...store.values()].filter(o => o.data?.wild);

test('no hook means no scatter (and no throw)', () => {
  const { grid, store } = mkGrid();
  assert.equal(scatterWild(grid, store, {}, 1, { id: 'x', objects: OBJECT_TYPES }), 0);
  assert.equal(scatterWild(grid, store, {}, 1, { id: 'x', objects: {} }), 0);
  assert.equal(store.size, 0);
});

test('a toy hook places exactly where it says, and only where canPlace is true', () => {
  const { grid, store } = mkGrid();
  const calls = [];
  const hook = tile => { calls.push(tile); return { model: 'tree', variant: 3 }; };   // asks for a tree on every tile
  const n = scatterWild(grid, store, {}, 1, mkMod(hook));
  assert.equal(calls.length, 400, 'called for every unbuilt growing tile');
  const placeable = calls.filter(t => t.canPlace);
  assert.equal(placeable.length, 100, 'default lattice 2: only even x, even y');
  for (const t of calls) assert.equal(t.canPlace, t.x % 2 === 0 && t.y % 2 === 0);
  assert.equal(n, 100);
  assert.deepEqual(wild(store).map(o => o.id).sort(), placeable.map(t => `tree:${t.x},${t.y}`).sort());
  for (const o of wild(store)) assert.deepEqual([o.model, o.variant, o.w, o.h], ['tree', 3, 1, 1]);
});

test('canPlace is false next to anything built, under cover and off the lattice; the hook is told the tile facts', () => {
  const { grid, store } = mkGrid(12, 12);
  const i = (x, y) => y * 12 + x;
  grid.occ[i(5, 4)] = 1;          // built: blocks (4,4) via its +x neighbour and itself
  grid.ground[i(2, 3)] = 5;       // built (a road): (2,2) has it as its +y neighbour
  grid.cover = new Uint8Array(144); grid.cover[i(8, 8)] = 1;
  const tiles = new Map();
  scatterWild(grid, store, { parks: [{ x: 10, y: 10, w: 2, h: 2 }] }, 1, mkMod(t => { tiles.set(`${t.x},${t.y}`, t); return null; }));
  assert.equal(tiles.has('5,4'), false, 'built tiles are not offered');
  assert.equal(tiles.get('4,4').canPlace, false);
  assert.equal(tiles.get('2,2').canPlace, false);
  assert.equal(tiles.get('8,8').canPlace, false);
  assert.equal(tiles.get('6,6').canPlace, true);
  assert.equal(tiles.get('6,4').dist, 1);
  assert.equal(tiles.get('0,11').dist, 9, 'far tiles read 9');
  assert.equal(tiles.get('10,10').park, true);
  assert.equal(tiles.get('6,6').park, false);
  assert.equal(tiles.get('0,0').terrainAt(-1, 0), 0, 'outside the grid is class 0');
  assert.equal(tiles.get('0,0').terrainAt(1, 1), TERRAIN.GRASS);
  assert.equal(tiles.get('0,0').terrain, TERRAIN.GRASS);
  assert.equal(store.size, 0, 'a null pick adds nothing');
});

test('a model on a tile that is not canPlace is ignored', () => {
  const { grid, store } = mkGrid(6, 6);
  const n = scatterWild(grid, store, {}, 1, mkMod(t => (t.canPlace ? null : { model: 'tree' })));
  assert.equal(n, 0); assert.equal(store.size, 0);
});

test('objects.scatter.lattice sets the lattice (default 2)', () => {
  const { grid, store } = mkGrid(12, 12);
  const mod = mkMod(() => ({ model: 'tree' }), { objects: { ...OBJECT_TYPES, scatter: { ...OBJECT_TYPES.scatter, lattice: 3 } } });
  assert.equal(scatterWild(grid, store, {}, 1, mod), 16);
  for (const o of wild(store)) assert.ok(o.tx % 3 === 0 && o.ty % 3 === 0);
});

test('returning terrain recolours, with or without a model, and also off the lattice', () => {
  const { grid, store } = mkGrid(8, 8);
  scatterWild(grid, store, {}, 1, mkMod(t => (t.x < 4 ? { terrain: TERRAIN.FOREST_FLOOR } : t.canPlace ? { terrain: TERRAIN.FOREST_FLOOR, model: 'rock' } : null)));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const expect = x < 4 || (x % 2 === 0 && y % 2 === 0) ? TERRAIN.FOREST_FLOOR : TERRAIN.GRASS;
    assert.equal(grid.terrain[y * 8 + x], expect, `${x},${y}`);
  }
  assert.ok(store.size > 0);
});

test('only tiles whose class grows are offered (table classes); no classes, nothing grows', () => {
  const a = mkGrid(6, 6);
  a.grid.terrain.fill(TERRAIN.SHORE);
  a.grid.terrain[0] = TERRAIN.GRASS; a.grid.terrain[1] = TERRAIN.FOREST_FLOOR;
  const seen = [];
  scatterWild(a.grid, a.store, {}, 1, mkMod(t => { seen.push(t.x); return null; }));   // fantasy classes: grass, forest-floor grow
  assert.deepEqual(seen, [0, 1]);
  const none = [];
  scatterWild(a.grid, a.store, {}, 1, mkMod(t => { none.push(t.x); return null; }, { terrain: { types: [] } }));
  assert.deepEqual(none, [], 'a table without classes grows nothing (C1: no classic fallback)');
  const b = mkGrid(6, 6);
  b.grid.terrain.fill(TERRAIN.SHORE);
  const classes = [{ code: 0, name: 'sea', water: true }, { code: 2, name: 'meadow', grows: true }];
  const seenB = [];
  scatterWild(b.grid, b.store, {}, 1, mkMod(t => { seenB.push(t.x + t.y * 6); return null; }, { terrain: { classes } }));
  assert.equal(seenB.length, 36, 'class 2 grows in this table');
});

test('draw(k) is rand(seed, mod.id, "scatter", x, y, k): stateless and keyed by tile', () => {
  const { grid, store } = mkGrid(6, 6);
  scatterWild(grid, store, {}, 42, mkMod((t, draw) => {
    for (const k of [0, 1, 2, 3]) assert.equal(draw(k), rand(42, 'toy', 'scatter', t.x, t.y, k));
    return null;
  }));
});

test('the hook receives ctx, the sixth argument', () => {
  const { grid, store } = mkGrid(2, 2);
  const ctx = { tag: 'ctx' };
  let got;
  scatterWild(grid, store, {}, 1, mkMod((t, d, c) => { got = c; return null; }), ctx);
  assert.equal(got, ctx);
});

test('the fantasy hook: forest recolour, park, big tree, bushes; terrain pick only for GRASS in the dense belt', () => {
  const T = (o = {}) => ({ x: 4, y: 4, dist: 9, park: false, terrain: TERRAIN.GRASS, terrainAt: () => TERRAIN.GRASS, canPlace: true, ...o });
  const lowDraw = k => (k === 0 ? 0 : k === 1 ? 0.999 : 0.5);   // always a tree; the last (big) tree draw
  assert.equal(fantasyScatter(T({ dist: 9 }), () => 0.99).terrain, TERRAIN.FOREST_FLOOR);
  assert.equal(fantasyScatter(T({ dist: 4 }), () => 0.99), null, 'dist-2 < forestDist-2: no recolour, nothing drawn');
  assert.equal(fantasyScatter(T({ terrain: TERRAIN.FOREST_FLOOR }), () => 0.99), null, 'already forest-floor');
  assert.equal(fantasyScatter(T({ dist: 9 }), lowDraw).model, 'tree');                    // dist 9: v = 7 > 4, big tree allowed
  assert.equal(fantasyScatter(T({ dist: 9 }), lowDraw).variant, 3);
  assert.equal(fantasyScatter(T({ dist: 5 }), lowDraw).model, 'pine', 'v = 3: the big tree is withheld');
  const nearbush = fantasyScatter(T({ dist: 1 }), k => (k === 0 ? 0.99 : k === 2 ? 0 : 0));
  assert.deepEqual([nearbush.model, nearbush.variant], ['bush', 0]);
  const cant = fantasyScatter(T({ dist: 9, canPlace: false }), () => 0);
  assert.deepEqual(cant, { terrain: TERRAIN.FOREST_FLOOR }, 'not canPlace: recolour only');
  const parkTile = fantasyScatter(T({ dist: 1, park: true }), k => (k === 0 ? 0.34 : 0));
  assert.ok(parkTile.model, 'park chance is 0.35 whatever the distance');
  assert.equal(fantasyScatter(T({ dist: 1, park: true }), k => (k === 0 ? 0.36 : 0.99)), null);
  const coast = fantasyScatter(T({ dist: 1, terrainAt: (dx) => (dx === 3 ? TERRAIN.SHORE : TERRAIN.GRASS) }), k => (k === 0 ? 0.2 : 0));
  assert.ok(coast.model, 'coast adds 0.25: p = 0.25 beats 0.2 where the plain curve (0) would not');
});

test('the fantasy hook through scatterWild with the real table is deterministic and grows on a bare grid', () => {
  const run = seed => {
    const { grid, store } = mkGrid(40, 40);
    const mod = { id: 'agentville.fantasy', objects: OBJECT_TYPES, terrain: TERRAIN_TABLE, hooks: { scatter: fantasyScatter } };
    const n = scatterWild(grid, store, {}, seed, mod);
    return { n, sig: [...store.values()].map(o => `${o.id}:${o.model}:${o.variant}`).join('|'), forest: grid.terrain.filter(t => t === TERRAIN.FOREST_FLOOR).length };
  };
  const a = run(5), b = run(5), c = run(6);
  assert.ok(a.n > 20); assert.equal(a.sig, b.sig); assert.notEqual(a.sig, c.sig);
  assert.ok(a.forest > 0);
});
