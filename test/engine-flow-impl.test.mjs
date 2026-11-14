import './support/ensure-mods-index.mjs';
// nav/flow.js (N3): flow fields, design docs/village-engine-v2.md §2.2 and budgets §2.5. Synthetic grids + the busy fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
const { WorldGrid, EDGE } = await import('../web/src/engine/core/grid.js');
const { rng } = await import('../web/src/engine/core/rng.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { flowField } = await import('../web/src/engine/nav/flow.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

/** An open w x h grid of cost-1 tiles at origin (ox, oy). */
function open(w, h, ox = 0, oy = 0) {
  const g = new WorldGrid({ ox, oy, w, h });
  g.cost.fill(1);
  return g;
}
const block = (g, x, y) => g.set('occ', x, y, 99);
const walkable = (g, x, y) => g.inBounds(x, y) && g.get('cost', x, y) < 255 && g.get('occ', x, y) === 0;
const stepCost = (g, dx, dy, bx, by) => (dx && dy ? 14 : 10) * Math.max(1, g.get('cost', bx, by));

/** Reference: Bellman-Ford style relaxation using grid.canStep, cost of entering the tile. */
function reference(g, targets) {
  const d = new Map(), key = (x, y) => `${x},${y}`;
  for (const t of targets) if (walkable(g, t.x, t.y)) d.set(key(t.x, t.y), 0);
  for (let changed = true; changed;) {
    changed = false;
    for (let y = g.oy; y < g.oy + g.h; y++) for (let x = g.ox; x < g.ox + g.w; x++) {
      if (!walkable(g, x, y)) continue;
      let best = d.get(key(x, y)) ?? Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nb = d.get(key(x + dx, y + dy));
        if (nb === undefined || !g.canStep(x, y, x + dx, y + dy)) continue;
        const c = nb + stepCost(g, dx, dy, x + dx, y + dy);
        if (c < best) best = c;
      }
      if (best < (d.get(key(x, y)) ?? Infinity)) { d.set(key(x, y), best); changed = true; }
    }
  }
  return (x, y) => d.get(key(x, y)) ?? Infinity;
}

/** Follow dirAt from (x, y): every step legal, costAt strictly decreases, summed step cost equals costAt(start). */
function follow(g, f, x, y) {
  const start = f.costAt(x, y);
  let paid = 0, steps = 0;
  while (f.costAt(x, y) > 0) {
    const d = f.dirAt(x, y);
    assert.ok(d && (d.dx || d.dy), `no step at ${x},${y}`);
    assert.ok(g.canStep(x, y, x + d.dx, y + d.dy), `illegal step at ${x},${y} by ${d.dx},${d.dy}`);
    const before = f.costAt(x, y);
    x += d.dx; y += d.dy;
    paid += stepCost(g, d.dx, d.dy, x, y);
    assert.ok(f.costAt(x, y) < before, 'cost must strictly decrease');
    assert.ok(++steps < 100000, 'runaway');
  }
  assert.equal(paid, start, 'the followed path costs exactly costAt (the field is optimal)');
  return steps;
}

test('open grid: integer octile costs, 0 on the target, Infinity outside', () => {
  const g = open(12, 12, -3, 4);
  const f = flowField(g, [{ x: 2, y: 9 }]);
  assert.equal(f.costAt(2, 9), 0);
  assert.deepEqual(f.dirAt(2, 9), { dx: 0, dy: 0 });
  assert.equal(f.costAt(5, 9), 30);
  assert.equal(f.costAt(5, 12), 42);
  assert.equal(f.costAt(6, 11), 14 * 2 + 10 * 2);
  assert.equal(f.costAt(2.7, 9.2), 0, 'float positions floor to their tile');
  assert.equal(f.costAt(-4, 9), Infinity);
  assert.equal(f.costAt(100, 100), Infinity);
  assert.equal(f.dirAt(100, 100), null);
  assert.deepEqual(f.dirAt(5, 9), { dx: -1, dy: 0 });
  assert.deepEqual(f.dirAt(5, 12), { dx: -1, dy: -1 });
});

test('weighted tiles: a step costs 10/14 x the cost of the tile entered', () => {
  const g = open(6, 3);
  g.set('cost', 1, 1, 3);
  const f = flowField(g, [{ x: 0, y: 1 }]);
  assert.equal(f.costAt(1, 1), 10, 'stepping out onto cost-1 target');
  assert.equal(f.costAt(2, 1), 28, 'detour via diagonals (14 + 14) beats entering the cost-3 tile (30 + 10)');
  follow(g, f, 5, 1);
});

test('multiple targets: cost is to the nearest one', () => {
  const g = open(20, 1);
  const f = flowField(g, [{ x: 0, y: 0 }, { x: 19, y: 0 }]);
  assert.equal(f.costAt(4, 0), 40);
  assert.equal(f.costAt(15, 0), 40);
  assert.deepEqual(f.dirAt(4, 0), { dx: -1, dy: 0 });
  assert.deepEqual(f.dirAt(15, 0), { dx: 1, dy: 0 });
  assert.equal(f.costAt(10, 0), 90);
});

test('no corner cutting past a blocked tile', () => {
  const g = open(4, 4);
  block(g, 1, 0);
  const f = flowField(g, [{ x: 2, y: 0 }]);
  assert.equal(f.costAt(1, 1), 20, 'diagonal (1,1)->(2,0) would cut past (1,0)');
  assert.deepEqual(f.dirAt(1, 1), { dx: 1, dy: 0 });
  assert.equal(f.costAt(1, 0), Infinity);
  assert.equal(f.dirAt(1, 0), null, 'blocked tiles have no direction');
});

test('edges (fences) block the crossed side and diagonals past them', () => {
  const g = open(3, 3);
  g.set('edges', 1, 1, EDGE.E); g.set('edges', 2, 1, EDGE.W);
  const f = flowField(g, [{ x: 2, y: 1 }]);
  assert.notEqual(f.costAt(1, 1), 10, 'cannot cross the fence');
  assert.equal(f.costAt(1, 1), 30, 'three orthogonal steps round the fence end (a diagonal would cut past it)');
  follow(g, f, 0, 1);
});

test('unreachable pockets and blocked targets', () => {
  const g = open(7, 7);
  for (const [x, y] of [[4, 3], [6, 3], [5, 2], [5, 4]]) block(g, x, y);   // (5,3) walled in
  block(g, 0, 0);
  const f = flowField(g, [{ x: 1, y: 1 }, { x: 0, y: 0 }]);
  assert.equal(f.costAt(5, 3), Infinity);
  assert.equal(f.dirAt(5, 3), null);
  assert.equal(f.costAt(0, 0), Infinity, 'a blocked target is ignored');
  assert.equal(f.costAt(1, 1), 0);
  const none = flowField(g, [{ x: 0, y: 0 }, { x: -50, y: 2 }]);
  assert.equal(none.costAt(1, 1), Infinity);
  assert.equal(none.dirAt(1, 1), null);
});

test('maxCost bounds the search and the arrays', () => {
  const g = open(200, 200);
  const f = flowField(g, [{ x: 100, y: 100 }], { maxCost: 50 });
  assert.equal(f.costAt(105, 100), 50);
  assert.equal(f.costAt(106, 100), Infinity);
  assert.equal(f.costAt(103, 103), 42);
  assert.equal(f.costAt(104, 104), Infinity, '56 > 50');
  assert.equal(f.dirAt(106, 100), null);
  assert.ok(f.region.w <= 11 && f.region.h <= 11, `region ${JSON.stringify(f.region)} should be the bounded box`);
  assert.ok(f.reached < 200);
});

test('deterministic tie-break: among equal-cost steps prefer the neighbour with lower costAt, then N,E,S,W,NE,SE,SW,NW', () => {
  const g = open(5, 5);
  const f = flowField(g, [{ x: 2, y: 1 }]);
  assert.deepEqual(f.dirAt(0, 0), { dx: 1, dy: 1 }, 'via (1,1) costs 10 to go; via (1,0) 14 to go; both 24 total');
  const a = flowField(g, [{ x: 2, y: 2 }]), b = flowField(g, [{ x: 2, y: 2 }]);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) assert.deepEqual(a.dirAt(x, y), b.dirAt(x, y));
});

test('random grids: costs match a reference relaxation over grid.canStep; following dirAt is legal and optimal', () => {
  const r = rng(1234);
  for (let trial = 0; trial < 25; trial++) {
    const w = 6 + Math.floor(r() * 10), h = 6 + Math.floor(r() * 10);
    const g = open(w, h, Math.floor(r() * 20) - 10, Math.floor(r() * 20) - 10);
    for (let y = g.oy; y < g.oy + h; y++) for (let x = g.ox; x < g.ox + w; x++) {
      const p = r();
      if (p < 0.18) block(g, x, y);
      else if (p < 0.24) g.set('cost', x, y, 255);
      else if (p < 0.4) g.set('cost', x, y, 1 + Math.floor(r() * 4));
      if (r() < 0.08) g.set('edges', x, y, 1 << Math.floor(r() * 4));
    }
    const targets = [];
    for (let k = 0; k < 1 + Math.floor(r() * 3); k++) targets.push({ x: g.ox + Math.floor(r() * w), y: g.oy + Math.floor(r() * h) });
    const f = flowField(g, targets), ref = reference(g, targets);
    const bounded = flowField(g, targets, { maxCost: 60 });
    for (let y = g.oy; y < g.oy + h; y++) for (let x = g.ox; x < g.ox + w; x++) {
      assert.equal(f.costAt(x, y), ref(x, y), `trial ${trial} cost at ${x},${y}`);
      assert.equal(bounded.costAt(x, y), ref(x, y) <= 60 ? ref(x, y) : Infinity, `trial ${trial} bounded cost at ${x},${y}`);
      if (!walkable(g, x, y)) assert.equal(f.dirAt(x, y), null);
      if (Number.isFinite(ref(x, y))) { follow(g, f, x, y); if (ref(x, y) <= 60) follow(g, bounded, x, y); }
      else assert.equal(f.dirAt(x, y), null);
    }
  }
});

test('stale() tracks the grid version', () => {
  const g = open(5, 5);
  const f = flowField(g, [{ x: 0, y: 0 }]);
  assert.equal(f.stale(), false);
  block(g, 3, 3);
  assert.equal(f.stale(), true);
});

const fx = loadFixture('busy.json');
test('busy fixture: one field over the whole town from the square; build time vs the §2.5 budget', { skip: fx ? false : 'busy.json missing' }, t => {
  const w = buildWorld(viewFromFixture(fx), { v: 1, seed: 7, blocks: {}, lots: {} }, { now: fx.now, seed: 7 });
  const g = w.grid, sq = w.square;
  const targets = [];
  for (let y = sq.y; y < sq.y + sq.h; y++) for (let x = sq.x; x < sq.x + sq.w; x++) if (walkable(g, x, y)) targets.push({ x, y });
  assert.ok(targets.length > 0, 'square has walkable tiles');
  flowField(g, targets);   // warm the JIT once
  const times = [];
  let f;
  for (let k = 0; k < 7; k++) { f = flowField(g, targets); times.push(f.buildMs); }
  times.sort((a, b) => a - b);
  const median = times[3];
  t.diagnostic(`busy grid ${g.w}x${g.h}: ${f.reached} tiles reached, build median ${median.toFixed(2)} ms (min ${times[0].toFixed(2)}, max ${times[6].toFixed(2)})`);
  let walk = 0;
  for (let y = g.oy; y < g.oy + g.h; y++) for (let x = g.ox; x < g.ox + g.w; x++) if (walkable(g, x, y)) walk++;
  assert.ok(f.reached > walk * 0.5, `field reaches most walkable tiles (${f.reached}/${walk})`);
  assert.ok(median < 40, `build ${median.toFixed(2)} ms is far over the 8 ms budget`);
  // Spot-follow from many tiles.
  let followed = 0;
  for (let y = g.oy; y < g.oy + g.h; y += 7) for (let x = g.ox; x < g.ox + g.w; x += 7) if (Number.isFinite(f.costAt(x, y)) && walkable(g, x, y)) { follow(g, f, x, y); followed++; }
  assert.ok(followed > 50);
});
