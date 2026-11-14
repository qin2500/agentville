import './support/ensure-mods-index.mjs';
// MOD-READY P1 (test T1, written from the spec only: SEAMS.md P1 "API" block + §0/§1, L0-REPORT): the `layout` hook contract.
// A tiny fake mod layout is run through runLayout / stampLayout / buildWorld. Everything that needs P1's code is guarded
// with a skip ("needs P1"), so this file passes on the base branch and goes live after the merge.
//   hooks.layout(input: LayoutInput, ctx) => LayoutResult   (pure in `input`; ctx.time is NOT given; result is cached)
//   runLayout(placed, mod, { seed, cache }) -> Sites { villages, square, parks, bounds, focus, tiles, outside, venues, data }
//   stampLayout(grid, sites): terrain on every tile; ground/road/lot only outside blocks and only when non-zero.
import test from 'node:test';
import assert from 'node:assert/strict';
const SITES = await import('../web/src/engine/world/sites.js');
const LAYOUT = await import('../web/src/engine/world/layout.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { createBuildCache } = await import('../web/src/engine/world/cache.js');
const { WorldGrid, ROAD, LAYOUT_GROUND, LOT } = await import('../web/src/engine/core/grid.js');
const { resolveMod, modCtx } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

const SEED = 7;
const GRASS = 3, SEA = 1;
const HAS_P1 = typeof SITES.placeBlocks === 'function' && typeof LAYOUT.stampLayout === 'function';
const needP1 = t => { if (!HAS_P1) { t.skip('needs P1: placeBlocks / stampLayout not exported yet'); return true; } return false; };
const base = resolveMod();
const fresh = () => ({ v: 1, seed: SEED, blocks: {}, lots: {} });

/** A fake world: grass over the blocks' bounds + margin, a road row, a hub lot, a venue; every tile also gets ground
 * EDGE so a write inside a block would be visible. `opts` bends it for the negative tests. */
function makeToy(o = {}) {
  const calls = [];
  const layout = (input, ctx) => {
    calls.push({ input, ctx });
    const M = o.margin ?? 6;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of input.settlements) { x0 = Math.min(x0, s.block.x); y0 = Math.min(y0, s.block.y); x1 = Math.max(x1, s.block.x + s.block.w); y1 = Math.max(y1, s.block.y + s.block.h); }
    const sq = input.square;
    x0 = Math.min(x0, sq.x); y0 = Math.min(y0, sq.y); x1 = Math.max(x1, sq.x + sq.w); y1 = Math.max(y1, sq.y + sq.h);
    const bounds = o.bounds ?? { ox: x0 - M, oy: y0 - M, w: x1 - x0 + 2 * M, h: y1 - y0 + 2 * M };
    // the tile rect is smaller than bounds by one tile on each side, so `outside` is observable
    const T = o.tiles ?? { ox: bounds.ox + 1, oy: bounds.oy + 1, w: bounds.w - 2, h: bounds.h - 2 };
    const n = T.w * T.h;
    const terrain = new Uint8Array(o.terrainLen ?? n).fill(GRASS);
    const ground = new Uint8Array(n).fill(LAYOUT_GROUND.EDGE);
    const road = new Uint8Array(n);
    const lot = new Int8Array(n);
    for (let x = 0; x < T.w; x++) road[x] = ROAD.LANE;                       // first row of the tile rect
    for (let i = 5; i < 9; i++) lot[i + T.w] = LOT.VENUE;                    // second row
    if (o.badGround) ground[3] = 250;                                        // inside 200..255 but not a LAYOUT_GROUND, and > MOD_CODE_MAX
    const res = {
      bounds, focus: { ox: bounds.ox + 2, oy: bounds.oy + 2, w: bounds.w - 4, h: bounds.h - 4 },
      tiles: { ...T, terrain, ground, road, lot }, outside: SEA,
      venues: { dock: { kind: 'harbour', rect: { x: x0, y: y1, w: 3, h: 2 }, anchor: { tx: x0, ty: y1 } } },
      data: { note: 'toy', dock: { x: x0, y: y1 } },
    };
    return res;
  };
  const mod = { ...base, id: `toy.layout${o.tag ?? ''}`, hooks: { ...base.hooks, layout } };
  return { mod, calls };
}

function inputFor(name) {
  const fx = loadFixture(`${name}.json`);
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: SEED, salt: String(SEED), env: { reduceMotion: false, zoom: 1 } });
  return { input, serverId, now: fx.now };
}
/** Settlements -> placed blocks (the input of runLayout), for a given mod and persisted state. */
// `cache`: the memo key holds each block's plan key, which placeBlocks notes in the build cache (as buildWorld does);
// blocks placed without that cache are never memoised.
function placed(mod, name = 'citydemo', P = fresh(), cache = null) {
  const { input, serverId, now } = inputFor(name);
  const ctxFor = k => modCtx(mod, { seed: SEED, now, projectKey: k });
  const { settlements } = SITES.planSettlements(input, P, mod, { now, serverId, ctxFor });
  return { placed: SITES.placeBlocks(settlements, P, mod, { now, ctxFor, seed: SEED, cache }), P, now, ctxFor };
}
const inBlock = (villages, x, y) => villages.some(v => x >= v.block.x && x < v.block.x + v.block.w && y >= v.block.y && y < v.block.y + v.block.h);

test('hook contract: an unusable hook in the base repo does not change the default mod (sanity)', () => {
  assert.equal(typeof base.id, 'string');
  assert.equal(typeof LAYOUT.runLayout, 'function');
});

test('runLayout returns Sites with the documented fields', t => {
  if (needP1(t)) return;
  const { mod } = makeToy();
  const { placed: pl } = placed(mod);
  const sites = LAYOUT.runLayout(pl, mod, { seed: SEED, cache: createBuildCache() });
  for (const k of ['villages', 'square', 'parks', 'bounds', 'focus', 'tiles', 'outside', 'venues', 'data']) assert.ok(k in sites, `Sites.${k}`);
  assert.ok(Array.isArray(sites.villages) && sites.villages.length > 0);
  assert.equal(sites.outside, SEA);
  assert.equal(sites.data.note, 'toy');
  assert.equal(sites.venues.dock.kind, 'harbour');
  const T = sites.tiles;
  assert.equal(T.terrain.length, T.w * T.h);
  assert.ok(T.ground instanceof Uint8Array && T.road instanceof Uint8Array && T.lot instanceof Int8Array);
});

test('the hook is given {settlements, square, parks} and a ctx without time', t => {
  if (needP1(t)) return;
  const { mod, calls } = makeToy();
  const { placed: pl } = placed(mod);
  LAYOUT.runLayout(pl, mod, { seed: SEED, cache: createBuildCache() });
  assert.equal(calls.length, 1);
  const { input, ctx } = calls[0];
  assert.ok(Array.isArray(input.settlements) && input.settlements.length > 0);
  for (const s of input.settlements) {
    for (const k of ['index', 'name', 'block', 'plaza', 'cx', 'cy', 'accent', 'plan']) assert.ok(k in s, `settlement.${k}`);
    for (const k of ['w', 'h', 'ground', 'lots']) assert.ok(k in s.plan, `plan.${k}`);
  }
  assert.ok(input.square && Number.isFinite(input.square.w));
  assert.ok(Array.isArray(input.parks));
  assert.ok(ctx && ctx.time === undefined, 'ctx.time must not be given (the result is cached)');
  assert.doesNotThrow(() => structuredClone(input), 'the hook input is plain data');
});

test('determinism: two cold runs give identical results; a cache hit returns the same object', t => {
  if (needP1(t)) return;
  const a = makeToy(), b = makeToy({});
  const A = LAYOUT.runLayout(placed(a.mod).placed, a.mod, { seed: SEED, cache: createBuildCache() });
  const B = LAYOUT.runLayout(placed(b.mod).placed, b.mod, { seed: SEED, cache: createBuildCache() });
  assert.deepEqual(Buffer.from(A.tiles.ground), Buffer.from(B.tiles.ground));
  assert.deepEqual(A.bounds, B.bounds);
  assert.deepEqual(A.focus, B.focus);
  // same cache, same blocks: no second hook call, same object
  // (Sites is a fresh wrapper per call round the placed blocks; the cached object is the validated LayoutResult, so the
  // check is on its parts.)
  const cache = createBuildCache(), c = makeToy();
  const pl = placed(c.mod, 'citydemo', fresh(), cache).placed;
  const first = LAYOUT.runLayout(pl, c.mod, { seed: SEED, cache });
  const second = LAYOUT.runLayout(pl, c.mod, { seed: SEED, cache });
  assert.equal(c.calls.length, 1, 'no hook runs when no block moved');
  for (const k of ['tiles', 'bounds', 'focus', 'venues', 'data']) assert.equal(first[k], second[k], `a cache hit returns the same ${k}`);
});

test('the cache key follows the blocks: moving one block runs the hook again', t => {
  if (needP1(t)) return;
  const cache = createBuildCache(), { mod, calls } = makeToy();
  const r1 = placed(mod, 'citydemo', fresh(), cache).placed;
  LAYOUT.runLayout(r1, mod, { seed: SEED, cache });
  const r2 = placed(mod, 'busy', fresh(), cache).placed;      // a different town
  LAYOUT.runLayout(r2, mod, { seed: SEED, cache });
  assert.equal(calls.length, 2);
});

test('the result is structured-clonable', t => {
  if (needP1(t)) return;
  const { mod } = makeToy();
  const sites = LAYOUT.runLayout(placed(mod).placed, mod, { seed: SEED, cache: createBuildCache() });
  const copy = structuredClone({ bounds: sites.bounds, focus: sites.focus, tiles: sites.tiles, outside: sites.outside, venues: sites.venues, data: sites.data });
  assert.deepEqual(copy.bounds, sites.bounds);
  assert.deepEqual(Buffer.from(copy.tiles.terrain), Buffer.from(sites.tiles.terrain));
  assert.deepEqual(copy.data, sites.data);
});

test('stampLayout: terrain on every tile, ground/road/lot outside blocks only, `outside` beyond the tile rect', t => {
  if (needP1(t)) return;
  const { mod } = makeToy();
  const sites = LAYOUT.runLayout(placed(mod).placed, mod, { seed: SEED, cache: createBuildCache() });
  const grid = new WorldGrid(sites.bounds);
  LAYOUT.stampLayout(grid, sites);
  const T = sites.tiles, B = sites.bounds;
  let checked = 0;
  for (let y = B.oy; y < B.oy + B.h; y++) for (let x = B.ox; x < B.ox + B.w; x++) {
    const inTiles = x >= T.ox && x < T.ox + T.w && y >= T.oy && y < T.oy + T.h;
    if (!inTiles) { assert.equal(grid.get('terrain', x, y), sites.outside, `outside terrain ${x},${y}`); continue; }
    const i = (y - T.oy) * T.w + (x - T.ox);
    assert.equal(grid.get('terrain', x, y), T.terrain[i], `terrain ${x},${y}`);      // terrain: every tile, blocks included
    if (inBlock(sites.villages, x, y)) {
      assert.equal(grid.get('ground', x, y), 0, `no ground write inside a block ${x},${y}`);
      assert.equal(grid.get('road', x, y), 0, `no road write inside a block ${x},${y}`);
    } else {
      assert.equal(grid.get('ground', x, y), T.ground[i], `ground ${x},${y}`);
      assert.equal(grid.get('road', x, y), T.road[i], `road ${x},${y}`);
      if (T.lot[i] !== 0) assert.equal(grid.get('lot', x, y), T.lot[i], `lot ${x},${y}`);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('stampLayout: zero means "leave"; it never erases what is already on the grid', t => {
  if (needP1(t)) return;
  const { mod } = makeToy();
  const sites = LAYOUT.runLayout(placed(mod).placed, mod, { seed: SEED, cache: createBuildCache() });
  const grid = new WorldGrid(sites.bounds);
  const T = sites.tiles;
  // pick a tile on the last row, which the toy leaves with road 0 and lot 0 (and outside any block)
  const y = T.oy + T.h - 1;
  let x = T.ox; while (inBlock(sites.villages, x, y) && x < T.ox + T.w - 1) x++;
  grid.set('road', x, y, ROAD.MAIN);
  LAYOUT.stampLayout(grid, sites);
  assert.equal(grid.get('road', x, y), ROAD.MAIN);
});

test('buildWorld with a toy layout mod: villages are untouched by the toy ground, the world is deterministic', t => {
  if (needP1(t)) return;
  const { mod } = makeToy();
  const f = inputFor('citydemo');
  const a = buildWorld(f.input, fresh(), { mod, now: f.now, seed: SEED, serverId: f.serverId });
  const b = buildWorld(f.input, fresh(), { mod, now: f.now, seed: SEED, serverId: f.serverId });
  assert.deepEqual(Buffer.from(a.grid.ground), Buffer.from(b.grid.ground));
  assert.deepEqual(a.bounds, b.bounds);
  for (const v of a.villages) {
    for (let y = v.block.y; y < v.block.y + v.block.h; y++) for (let x = v.block.x; x < v.block.x + v.block.w; x++) {
      assert.notEqual(a.grid.get('ground', x, y), LAYOUT_GROUND.EDGE, `toy EDGE ground leaked into block at ${x},${y}`);
    }
  }
  assert.equal(a.dock, undefined, 'world.dock is gone; venues replace it');
});

test('bad results are linted (or rejected): wrong terrain length', t => {
  if (needP1(t)) return;
  const { mod } = makeToy({ terrainLen: 5, tag: '.badlen' });
  const f = inputFor('citydemo');
  const ok = buildWorld(f.input, fresh(), { mod: makeToy({ tag: '.ok' }).mod, now: f.now, seed: SEED, serverId: f.serverId });
  let w;
  try { w = buildWorld(f.input, fresh(), { mod, now: f.now, seed: SEED, serverId: f.serverId }); } catch (e) { assert.ok(e instanceof Error); return; }
  assert.ok(w.lint.length > ok.lint.length, 'a wrong typed-array length must be reported in lint');
});

test('bad results are linted (or rejected): ground code outside the mod range and not a LAYOUT_GROUND', t => {
  if (needP1(t)) return;
  const { mod } = makeToy({ badGround: true, tag: '.badcode' });
  const f = inputFor('citydemo');
  const ok = buildWorld(f.input, fresh(), { mod: makeToy({ tag: '.ok2' }).mod, now: f.now, seed: SEED, serverId: f.serverId });
  let w;
  try { w = buildWorld(f.input, fresh(), { mod, now: f.now, seed: SEED, serverId: f.serverId }); } catch (e) { assert.ok(e instanceof Error); return; }
  assert.ok(w.lint.length > ok.lint.length, 'an invalid ground code must be reported in lint');
});

test('bounds that do not contain every block are grown (or linted), never left short', t => {
  if (needP1(t)) return;
  const { mod } = makeToy({ bounds: { ox: 0, oy: 0, w: 4, h: 4 }, tiles: { ox: 0, oy: 0, w: 4, h: 4 }, terrainLen: undefined, tag: '.small' });
  const f = inputFor('citydemo');
  let w;
  try { w = buildWorld(f.input, fresh(), { mod, now: f.now, seed: SEED, serverId: f.serverId }); } catch (e) { assert.ok(e instanceof Error); return; }
  const B = w.bounds;
  const contained = w.villages.every(v => v.block.x >= B.ox && v.block.y >= B.oy && v.block.x + v.block.w <= B.ox + B.w && v.block.y + v.block.h <= B.oy + B.h);
  assert.ok(contained || w.lint.length > 0, 'engine grows the bounds or lints it');
});
