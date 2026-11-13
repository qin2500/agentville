import './support/ensure-mods-index.mjs';
// N1 local grid A* (design §2.2, §2.5; Wave B COMMON.md seam). Written from the spec:
// astar(grid, from:{x,y}, to:{x,y}, { maxNodes=20000, costFn? }) -> Float32Array|null of tile-centre x,y pairs,
// 8-way, no corner cutting past a blocked tile or edge, uses the baked cost layer (255 = blocked), octile heuristic,
// maxNodes cap -> null, straight runs collapsed to their ends, never through a blocked tile.
import test from 'node:test';
import assert from 'node:assert/strict';
const { astar } = await import('../web/src/engine/nav/astar.js');
const { WorldGrid, EDGE, COST_BLOCKED } = await import('../web/src/engine/core/grid.js');

const B = COST_BLOCKED;

/** Grid from rows of chars: '.' cost 1, '#' blocked (cost 255), '~' cost 5, 'o' occupied (occ 1, cost 1). */
function gridFrom(rows, { ox = 0, oy = 0 } = {}) {
  const h = rows.length, w = rows[0].length, g = new WorldGrid({ ox, oy, w, h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = rows[y][x], i = y * w + x;
    g.cost[i] = c === '#' ? B : c === '~' ? 5 : 1;
    if (c === 'o') g.occ[i] = 1;
  }
  return g;
}

const pts = a => { const out = []; for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; };
const stepCost = (g, tx, ty, costFn) => {
  const base = g.get('cost', tx, ty);
  const c = costFn ? costFn(tx, ty, base) : base;
  return Math.max(1, c);
};

/** Expand waypoints to unit steps; assert every step is legal and every segment is a straight 8-way run. Returns cost. */
function walk(g, path, costFn) {
  const p = pts(path);
  let total = 0;
  for (const [x, y] of p) { assert.equal(x - Math.floor(x), 0.5); assert.equal(y - Math.floor(y), 0.5); }
  for (let k = 1; k < p.length; k++) {
    let [x, y] = p[k - 1].map(Math.floor);
    const [ex, ey] = p[k].map(Math.floor);
    const dx = Math.sign(ex - x), dy = Math.sign(ey - y);
    assert.ok(ex - x === 0 || ey - y === 0 || Math.abs(ex - x) === Math.abs(ey - y), `segment ${k} is not a straight 8-way run`);
    assert.ok(dx || dy, 'repeated waypoint');
    while (x !== ex || y !== ey) {
      assert.ok(g.canStep(x, y, x + dx, y + dy), `illegal step ${x},${y} -> ${x + dx},${y + dy}`);
      if (costFn) assert.ok(costFn(x + dx, y + dy, g.get('cost', x + dx, y + dy)) < B);
      x += dx; y += dy;
      total += stepCost(g, x, y, costFn) * (dx && dy ? Math.SQRT2 : 1);
    }
  }
  // collapsed: consecutive segments never share a direction
  for (let k = 2; k < p.length; k++) {
    const d1 = [Math.sign(p[k - 1][0] - p[k - 2][0]), Math.sign(p[k - 1][1] - p[k - 2][1])];
    const d2 = [Math.sign(p[k][0] - p[k - 1][0]), Math.sign(p[k][1] - p[k - 1][1])];
    assert.ok(d1[0] !== d2[0] || d1[1] !== d2[1], 'straight run not collapsed');
  }
  return total;
}

/** Reference Dijkstra over WorldGrid.canStep (independent of the implementation). Infinity when unreachable. */
function refCost(g, from, to, costFn) {
  const { w, h, ox, oy } = g, n = w * h, dist = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
  const s = (from.y - oy) * w + (from.x - ox), t = (to.y - oy) * w + (to.x - ox);
  if (g.isBlocked(to.x, to.y) || (costFn && costFn(to.x, to.y, g.get('cost', to.x, to.y)) >= B)) return Infinity;
  dist[s] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) return Infinity;
    if (u === t) return dist[u];
    done[u] = 1;
    const ux = (u % w) + ox, uy = Math.floor(u / w) + oy;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const vx = ux + dx, vy = uy + dy;
      if (!g.canStep(ux, uy, vx, vy)) continue;
      if (costFn && (costFn(vx, vy, g.get('cost', vx, vy)) >= B)) continue;
      if (costFn && dx && dy && (costFn(ux + dx, uy, g.get('cost', ux + dx, uy)) >= B || costFn(ux, uy + dy, g.get('cost', ux, uy + dy)) >= B)) continue;
      const v = (vy - oy) * w + (vx - ox), nd = dist[u] + stepCost(g, vx, vy, costFn) * (dx && dy ? Math.SQRT2 : 1);
      if (nd < dist[v]) dist[v] = nd;
    }
  }
}

test('returns a Float32Array of tile centres from start tile to goal tile', () => {
  const g = gridFrom(['.....', '.....', '.....']);
  const p = astar(g, { x: 0, y: 1 }, { x: 4, y: 1 });
  assert.ok(p instanceof Float32Array);
  assert.deepEqual([...p], [0.5, 1.5, 4.5, 1.5]);   // straight run collapsed to its ends
});

test('float positions resolve to their tile', () => {
  const g = gridFrom(['.....', '.....', '.....']);
  assert.deepEqual([...astar(g, { x: 0.9, y: 1.2 }, { x: 4.01, y: 1.99 })], [0.5, 1.5, 4.5, 1.5]);
});

test('same tile -> one point; goal blocked, occupied or outside -> null', () => {
  const g = gridFrom(['..#', '..o', '...']);
  assert.deepEqual([...astar(g, { x: 1, y: 1 }, { x: 1.7, y: 1.2 })], [1.5, 1.5]);
  assert.equal(astar(g, { x: 0, y: 0 }, { x: 2, y: 0 }), null);
  assert.equal(astar(g, { x: 0, y: 0 }, { x: 2, y: 1 }), null);
  assert.equal(astar(g, { x: 0, y: 0 }, { x: 9, y: 9 }), null);
  assert.equal(astar(g, { x: -3, y: 0 }, { x: 1, y: 1 }), null);
});

test('diagonal moves are used on open ground', () => {
  const g = gridFrom(['....', '....', '....', '....']);
  assert.deepEqual([...astar(g, { x: 0, y: 0 }, { x: 3, y: 3 })], [0.5, 0.5, 3.5, 3.5]);
});

test('no corner cutting past a blocked tile', () => {
  // (0,0) -> (1,1): the diagonal would cut the corner of the blocked (1,0)
  const g = gridFrom(['.#', '..']);
  const p = astar(g, { x: 0, y: 0 }, { x: 1, y: 1 });
  assert.deepEqual([...p], [0.5, 0.5, 0.5, 1.5, 1.5, 1.5]);
  walk(g, p);
  // also with an occupied (occ) corner
  const o = gridFrom(['..', 'o.']);
  assert.deepEqual([...astar(o, { x: 0, y: 0 }, { x: 1, y: 1 })], [0.5, 0.5, 1.5, 0.5, 1.5, 1.5]);
  // both corners blocked: no path at all
  assert.equal(astar(gridFrom(['.#', '#.']), { x: 0, y: 0 }, { x: 1, y: 1 }), null);
});

test('edges block steps (both sides) and the diagonals that would cut past them', () => {
  const g = gridFrom(['...', '...', '...']);
  // fence on the east side of (0,1) (mirrored on the west side of (1,1) by stamp; here set one side only)
  g.edges[1 * 3 + 0] |= EDGE.E;
  const p = astar(g, { x: 0, y: 1 }, { x: 1, y: 1 });
  assert.ok(p.length > 4, 'went around the fence');
  walk(g, p);
  const g2 = gridFrom(['...', '...', '...']);
  g2.edges[1 * 3 + 1] |= EDGE.W;   // only the far side carries the bit
  walk(g2, astar(g2, { x: 0, y: 1 }, { x: 1, y: 1 }));
  assert.ok(astar(g2, { x: 0, y: 1 }, { x: 1, y: 1 }).length > 4);
  // a wall of edges with no gap -> null
  const g3 = gridFrom(['..', '..']);
  g3.edges[0] |= EDGE.E; g3.edges[2] |= EDGE.E;
  assert.equal(astar(g3, { x: 0, y: 0 }, { x: 1, y: 1 }), null);
});

test('prefers cheap tiles (roads) over expensive ones and matches a reference Dijkstra', () => {
  const g = gridFrom([
    '..........',
    '.~~~~~~~~.',
    '.~~~~~~~~.',
    '..........',
  ]);
  const p = astar(g, { x: 0, y: 2 }, { x: 9, y: 2 });
  const c = walk(g, p);
  assert.ok(Math.abs(c - refCost(g, { x: 0, y: 2 }, { x: 9, y: 2 })) < 1e-9);
  for (const [x, y] of pts(p)) assert.ok(g.get('cost', Math.floor(x), Math.floor(y)) !== 5 || false);
});

test('maxNodes caps the search -> null; a large enough cap finds the path', () => {
  const rows = [];
  for (let y = 0; y < 60; y++) rows.push('.'.repeat(60));
  const g = gridFrom(rows);
  for (let y = 0; y < 59; y++) g.cost[y * 60 + 30] = B;   // wall with a gap at the bottom
  assert.equal(astar(g, { x: 0, y: 0 }, { x: 59, y: 0 }, { maxNodes: 50 }), null);
  const p = astar(g, { x: 0, y: 0 }, { x: 59, y: 0 });
  assert.ok(p);
  walk(g, p);
  // unreachable goal also -> null, without hanging
  for (let y = 0; y < 60; y++) g.cost[y * 60 + 30] = B;
  assert.equal(astar(g, { x: 0, y: 0 }, { x: 59, y: 0 }), null);
});

test('costFn overrides tile cost; >= 255 blocks', () => {
  const g = gridFrom(['.....', '.....', '.....']);
  const blockMid = (tx, ty, base) => (tx === 2 && ty === 1 ? 255 : base);
  const p = astar(g, { x: 0, y: 1 }, { x: 4, y: 1 }, { costFn: blockMid });
  walk(g, p, blockMid);
  assert.ok(!pts(p).some(([x, y]) => x === 2.5 && y === 1.5));
  const x4 = (tx, ty, base) => (ty === 1 ? base * 4 : base);   // reserved lane costs x4
  const q = astar(g, { x: 0, y: 1 }, { x: 4, y: 1 }, { costFn: x4 });
  assert.ok(Math.abs(walk(g, q, x4) - refCost(g, { x: 0, y: 1 }, { x: 4, y: 1 }, x4)) < 1e-9);
});

test('works on a grid with a negative origin', () => {
  const g = gridFrom(['.....', '.###.', '.....'], { ox: -10, oy: -5 });
  const p = astar(g, { x: -10, y: -4 }, { x: -6, y: -4 });
  walk(g, p);
  assert.deepEqual([p[0], p[1]], [-9.5, -3.5]);
  assert.deepEqual([p[p.length - 2], p[p.length - 1]], [-5.5, -3.5]);
});

test('optimal and legal on random grids (vs reference Dijkstra), scratch reused across grids', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let round = 0; round < 60; round++) {
    const w = 3 + Math.floor(rnd() * 18), h = 2 + Math.floor(rnd() * 18), rows = [];
    for (let y = 0; y < h; y++) {
      let r = '';
      for (let x = 0; x < w; x++) { const v = rnd(); r += v < 0.25 ? '#' : v < 0.35 ? '~' : v < 0.4 ? 'o' : '.'; }
      rows.push(r);
    }
    const g = gridFrom(rows, { ox: Math.floor(rnd() * 10) - 5, oy: Math.floor(rnd() * 10) - 5 });
    for (let k = 0; k < Math.floor(rnd() * 6); k++) g.edges[Math.floor(rnd() * w * h)] |= 1 << Math.floor(rnd() * 4);
    for (let q = 0; q < 6; q++) {
      const from = { x: g.ox + Math.floor(rnd() * w), y: g.oy + Math.floor(rnd() * h) };
      const to = { x: g.ox + Math.floor(rnd() * w), y: g.oy + Math.floor(rnd() * h) };
      const ref = refCost(g, from, to);
      const p = astar(g, from, to);
      if (from.x === to.x && from.y === to.y) { assert.equal(p.length, 2); continue; }
      if (ref === Infinity) { assert.equal(p, null, `round ${round}: expected null`); continue; }
      assert.ok(p, `round ${round}: expected a path`);
      assert.deepEqual([p[0], p[1]], [from.x + 0.5, from.y + 0.5]);
      assert.deepEqual([p[p.length - 2], p[p.length - 1]], [to.x + 0.5, to.y + 0.5]);
      const c = walk(g, p);
      assert.ok(Math.abs(c - ref) < 1e-6, `round ${round}: cost ${c} vs optimal ${ref}`);
    }
  }
});

test('start tile may itself be blocked (an actor stepping off it)', () => {
  const g = gridFrom(['#..']);
  assert.deepEqual([...astar(g, { x: 0, y: 0 }, { x: 2, y: 0 })], [0.5, 0.5, 2.5, 0.5]);
});

test('stress fixture world: legal paths, timings within budget', { timeout: 300_000 }, async t => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures', 'engine', 'stress.json');
  if (!fs.existsSync(fx)) return t.skip('no stress fixture');
  const { viewFromFixture } = await import('../web/src/engine/snapshot.js');
  const { toWorldInput } = await import('../web/src/engine/mod/input.js');
  const { resolveMod } = await import('../web/src/engine/mod/registry.js');
  const { buildWorld } = await import('../web/src/engine/world/build.js');
  const data = JSON.parse(fs.readFileSync(fx, 'utf8'));
  const view = viewFromFixture(data);
  const { input, serverId } = toWorldInput(view, { seed: 7, salt: 'astar' });
  const t0 = performance.now();
  const world = buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { serverId, mod: resolveMod('agentville.fantasy'), now: data.now, seed: 7 });
  const buildMs = performance.now() - t0;
  const g = world.grid;
  // walkable tiles, deterministic sample
  const open = [];
  for (let i = 0; i < g.w * g.h; i++) if (g.cost[i] !== B && g.occ[i] === 0) open.push(i);
  assert.ok(open.length > 1000, 'stress world has walkable ground');
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const at = i => ({ x: (i % g.w) + g.ox, y: Math.floor(i / g.w) + g.oy });
  const pick = () => at(open[Math.floor(rnd() * open.length)]);
  const stats = ts => {
    ts.sort((x, y) => x - y);
    const n = ts.length || 1;
    return { n: ts.length, avg: ts.reduce((s, x) => s + x, 0) / n, p50: ts[Math.floor(n * 0.5)] ?? 0, p99: ts[Math.floor(n * 0.99)] ?? 0, max: ts[ts.length - 1] ?? 0 };
  };
  const run = (n, near, opts) => {
    const all = [], hit = [], miss = [];
    for (let k = 0; k < n; k++) {
      const a = pick();
      let b;
      if (near) {
        for (let tries = 0; tries < 50; tries++) {
          const c = { x: a.x + Math.floor(rnd() * 25) - 12, y: a.y + Math.floor(rnd() * 25) - 12 };
          if (g.inBounds(c.x, c.y) && !g.isBlocked(c.x, c.y)) { b = c; break; }
        }
        b ??= a;
      } else b = pick();
      const s = performance.now();
      const p = astar(g, a, b, opts);
      const dt = performance.now() - s;
      all.push(dt);
      if (p) { hit.push(dt); if (k % 7 === 0) walk(g, p); } else miss.push(dt);
    }
    return { all: stats(all), hit: stats(hit), miss: stats(miss) };
  };
  // §2.2: the local legs are a BOUNDED search (radius 12 tiles); 25x25 = 625 tiles, so a 2,000-node cap is generous.
  const LOCAL = { maxNodes: 2000 };
  run(300, true, LOCAL);   // warm-up
  const local = run(3000, true, LOCAL), localUncapped = run(1000, true), long = run(300, false);
  const fmt = r => `n=${r.n} avg=${r.avg.toFixed(3)}ms p50=${r.p50.toFixed(3)} p99=${r.p99.toFixed(3)} max=${r.max.toFixed(3)}`;
  const line = (name, r) => t.diagnostic(`${name}: all ${fmt(r.all)} | found ${fmt(r.hit)} | null ${fmt(r.miss)}`);
  t.diagnostic(`stress grid ${g.w}x${g.h} (${open.length} walkable), build ${buildMs.toFixed(0)} ms`);
  line('local <=12 tiles, maxNodes 2000', local);
  line('local <=12 tiles, maxNodes 20000', localUncapped);
  line('long random pairs, maxNodes 20000', long);
  // §2.5: a path request (graph A* + 2 local A*) is <= 0.3 ms avg, 2 ms p99, so each bounded local leg must fit.
  assert.ok(local.all.avg < 0.3, `local A* avg ${local.all.avg} ms`);
  // p99 is asserted on found paths: capped misses (unreachable goals) are the slow tail, and N5 should reject those
  // before searching (see report). Bound kept loose enough for a loaded machine; the diagnostics carry the numbers.
  assert.ok(local.hit.p99 < 2, `local A* found-path p99 ${local.hit.p99} ms`);
});
