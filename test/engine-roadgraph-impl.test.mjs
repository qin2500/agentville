import './support/ensure-mods-index.mjs';
// N2 road graph (design §2.2 + Wave B seam): written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
const { WorldGrid, ROAD } = await import('../web/src/engine/core/grid.js');
const { buildRoadGraph } = await import('../web/src/engine/nav/roadgraph.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { NOW } = await import('./mod-support/views.mjs');

const grid = (w = 32, h = 24) => new WorldGrid({ ox: 0, oy: 0, w, h });
const line = (g, x0, y0, x1, y1, cls) => {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) g.set('road', x, y, cls);
};
const pts = p => { const o = []; for (let k = 0; k < p.length; k += 2) o.push([p[k], p[k + 1]]); return o; };
/** every step of a tile-centre polyline is one legal 8-way grid step */
const assertLegal = (g, p, msg = '') => {
  const t = pts(p).map(([x, y]) => [Math.floor(x), Math.floor(y)]);
  for (let k = 1; k < t.length; k++) assert.ok(g.canStep(t[k - 1][0], t[k - 1][1], t[k][0], t[k][1]), `${msg} illegal step ${t[k - 1]} -> ${t[k]}`);
  return t;
};
const kinds = G => G.nodes.reduce((m, n) => ({ ...m, [n.kind]: (m[n.kind] || 0) + 1 }), {});

test('plus: one junction, four ends, four edges with tile lengths', () => {
  const g = grid();
  line(g, 2, 10, 20, 10, ROAD.STREET); line(g, 11, 3, 11, 18, ROAD.STREET);
  const G = buildRoadGraph({ grid: g });
  assert.deepEqual(kinds(G), { end: 4, junction: 1 });
  const j = G.nodes.find(n => n.kind === 'junction');
  assert.deepEqual([j.x, j.y], [11, 10]);
  assert.equal(G.edges.length, 4);
  assert.deepEqual(G.edges.map(e => e.length).sort((a, b) => a - b), [7, 8, 9, 9]);
  for (const e of G.edges) { assert.equal(e.cls, ROAD.STREET); assertLegal(g, e.poly); assert.ok(e.a < e.b); }
});

test('node ids are row-major and the graph is deterministic', () => {
  const make = () => { const g = grid(); line(g, 2, 10, 20, 10, ROAD.LANE); line(g, 11, 3, 11, 18, ROAD.PATH); line(g, 4, 2, 4, 10, ROAD.LANE); return buildRoadGraph({ grid: g }); };
  const A = make(), B = make();
  const flat = G => JSON.stringify({ n: G.nodes, e: G.edges.map(e => ({ ...e, poly: [...e.poly] })) });
  assert.equal(flat(A), flat(B));
  A.nodes.forEach((n, i) => { assert.equal(n.id, i); if (i) { const p = A.nodes[i - 1]; assert.ok(p.y < n.y || (p.y === n.y && p.x < n.x)); } });
  A.edges.forEach((e, i) => assert.equal(e.id, i));
});

test('a 2-wide street thins to one chain: two ends, one edge', () => {
  const g = grid();
  line(g, 3, 8, 22, 9, ROAD.STREET);
  const G = buildRoadGraph({ grid: g });
  assert.deepEqual(kinds(G), { end: 2 });
  assert.equal(G.edges.length, 1);
  assert.ok(G.edges[0].length >= 15 && G.edges[0].length <= 20, `length ${G.edges[0].length}`);
  assertLegal(g, G.edges[0].poly);
});

test('route + polyline: continuous, legal, on road tiles, endpoints at the nodes', () => {
  const g = grid();
  line(g, 2, 10, 20, 10, ROAD.STREET); line(g, 11, 3, 11, 18, ROAD.STREET); line(g, 20, 4, 20, 10, ROAD.STREET);
  const G = buildRoadGraph({ grid: g });
  const a = G.nodeAt(2, 10), b = G.nodeAt(20, 4), c = G.nodeAt(11, 18);
  assert.ok(a !== null && b !== null && c !== null);
  const r = G.route(a, b);
  assert.equal(r[0], a); assert.equal(r[r.length - 1], b);
  const p = G.polyline(r);
  assert.ok(p instanceof Float32Array);
  const t = assertLegal(g, p);
  assert.deepEqual(t[0], [2, 10]); assert.deepEqual(t[t.length - 1], [20, 4]);
  assert.deepEqual(pts(p)[0], [2.5, 10.5], 'tile centres');
  for (const [x, y] of t) assert.ok(g.get('road', x, y) > 0);
  assert.equal(t.length, 18 + 6 + 1);
  assert.deepEqual(G.route(c, c), [c]);
  assert.equal(G.route(a, 999), null);
});

test('disconnected roads: route is null', () => {
  const g = grid();
  line(g, 1, 1, 8, 1, ROAD.STREET); line(g, 1, 10, 8, 10, ROAD.STREET);
  const G = buildRoadGraph({ grid: g });
  assert.equal(G.route(G.nodeAt(1, 1), G.nodeAt(8, 10)), null);
  assert.ok(G.route(G.nodeAt(1, 1), G.nodeAt(8, 1)));
});

test('roadsOnly: carts skip PATH edges and take the lane loop', () => {
  const g = grid(30, 20);
  line(g, 2, 2, 22, 2, ROAD.LANE); line(g, 2, 12, 22, 12, ROAD.LANE);
  line(g, 2, 2, 2, 12, ROAD.LANE); line(g, 22, 2, 22, 12, ROAD.LANE);
  line(g, 12, 3, 12, 11, ROAD.PATH);   // a footpath chord
  const G = buildRoadGraph({ grid: g });
  const top = G.nodeAt(12, 2), bot = G.nodeAt(12, 12);
  assert.ok(top !== null && bot !== null, 'T junctions are nodes');
  const walk = G.polyline(G.route(top, bot));
  assert.equal(pts(walk).length, 11, 'walkers take the footpath');
  const r = G.route(top, bot, { roadsOnly: true });
  assert.deepEqual(r, [top, bot], 'same two nodes, a different edge');
  const cart = G.polyline(r, { roadsOnly: true });
  const t = assertLegal(g, cart, 'cart');
  for (const [x, y] of t) assert.ok(g.get('road', x, y) >= ROAD.LANE, `cart on ${x},${y}`);
  assert.ok(t.length >= 28, `cart goes round the loop (${t.length} tiles)`);
  // nearestNode with roadsOnly never returns a path-only node
  const g2 = grid(30, 20);
  line(g2, 2, 2, 12, 2, ROAD.LANE); line(g2, 20, 2, 26, 2, ROAD.PATH);
  const G2 = buildRoadGraph({ grid: g2 });
  assert.equal(G2.nearestNode(25, 3), G2.nodeAt(26, 2));
  assert.equal(G2.nearestNode(25, 3, { roadsOnly: true }), G2.nodeAt(12, 2));
});

test('every door gets a node at its nearest road tile, joined to the skeleton', () => {
  const g = grid();
  line(g, 2, 10, 24, 11, ROAD.STREET);   // 2-wide, skeleton on one row
  const objects = [
    { id: 'b:near', kind: 'building', door: { tx: 6, ty: 13 } },    // two tiles south of the street
    { id: 'b:on', kind: 'building', door: { tx: 15, ty: 10 } },     // on the street
    { id: 'b:far', kind: 'building', door: { tx: 20, ty: 23 } },    // 12 rows off: reachable at the radius limit
    { id: 'b:none', kind: 'tree' },
  ];
  const G = buildRoadGraph({ grid: g, objects });
  const near = G.doorNode('b:near'), on = G.doorNode('b:on');
  assert.ok(near !== null && on !== null);
  assert.deepEqual([G.nodes[near].x, G.nodes[near].y], [6, 11], 'nearest road tile of the door');
  assert.equal(G.nodes[near].kind, 'door');
  assert.deepEqual(G.nodes[near].doors, ['b:near']);
  assert.deepEqual([G.nodes[on].x, G.nodes[on].y], [15, 10]);
  assert.deepEqual([G.nodes[G.doorNode('b:far')].x, G.nodes[G.doorNode('b:far')].y], [20, 11]);
  const r = G.route(near, on);
  assert.ok(r, 'door nodes connect');
  const t = assertLegal(g, G.polyline(r));
  for (const [x, y] of t) assert.ok(g.get('road', x, y) > 0);
  // a door with no road in range
  const g2 = grid(40, 40); line(g2, 0, 0, 5, 0, ROAD.STREET);
  const G2 = buildRoadGraph({ grid: g2, objects: [{ id: 'lost', door: { tx: 30, ty: 30 } }] });
  assert.equal(G2.doorNode('lost'), null);
  assert.deepEqual(G2.unreached, ['lost']);
});

test('blocked road tiles are not part of the graph; plaza centre is a node', () => {
  const g = grid();
  line(g, 2, 5, 20, 5, ROAD.STREET);
  g.set('occ', 10, 5, 7);
  const G = buildRoadGraph({ grid: g });
  assert.equal(G.route(G.nodeAt(2, 5), G.nodeAt(20, 5)), null, 'a blocked tile cuts the road');
  const g2 = grid();
  line(g2, 8, 8, 15, 15, ROAD.MAIN); line(g2, 0, 11, 7, 11, ROAD.LANE);
  const G2 = buildRoadGraph({ grid: g2, square: { x: 8, y: 8, w: 8, h: 8 } });
  const plaza = G2.nodes.filter(n => n.kind === 'plaza');
  assert.equal(plaza.length, 1);
  assert.ok(Math.abs(plaza[0].x - 11.5) <= 2 && Math.abs(plaza[0].y - 11.5) <= 2, `plaza at ${plaza[0].x},${plaza[0].y}`);
  assert.ok(G2.route(G2.nodeAt(0, 11), plaza[0].id), 'the lane reaches the plaza centre');
});

// ---- a real World from buildWorld ----
const agent = (id, project, role, parentId, bucket = 'building', prs = []) => ({ id, name: id, project, role, parentId, bucket, severity: null, live: bucket !== 'resting', lastActivityAt: NOW - 60_000, since: NOW - 1e7, prs });
const smallInput = () => {
  const agents = [
    agent('a-boss', 'alpha', 'boss', undefined, 'waiting'), agent('a-lead', 'alpha', 'lead', 'a-boss', 'building', [{ id: '11' }]),
    agent('a-sub', 'alpha', 'sub', 'a-lead'), agent('a-rest', 'alpha', undefined, undefined, 'resting'),
    agent('b-one', 'beta', undefined, undefined), agent('b-two', 'beta', undefined, undefined, 'resting', [{ id: '21' }]),
    agent('c-one', 'gamma', 'lead', undefined),
  ];
  const projects = [{ name: 'alpha', prs: [{ id: '11', live: true }, { id: '12', live: false }], transcriptBytes: 2e6, agentsEver: 8 },
    { name: 'beta', prs: [{ id: '21', live: false }], transcriptBytes: 1e5, agentsEver: 3 }, { name: 'gamma', prs: [], transcriptBytes: 0, agentsEver: 1 }];
  const view = makeView({ agents, projects, dock: { loading: [], sailed: [], total: 1, level: 1 } }, { now: NOW, demo: true });
  return toWorldInput(view, { seed: 7, salt: 'seams' }).input;
};

// fantasy joins block paths to the ring road; base's block paths stop one grass tile short of it (the road layer itself
// is disconnected there), so buildRoadGraph bridges the gap with short PATH edges (e.bridge) and every door routes.
for (const [id, minReach] of [['agentville.fantasy', 0.9], ['agentville.base', 1]]) {
  test(`buildRoadGraph on a built ${id} world: door nodes, polylines legal, deterministic`, () => {
    const mod = resolveMod(id);
    const w = buildWorld(smallInput(), { v: 1, seed: 7, blocks: {}, lots: {} }, { mod, now: NOW, seed: 7 });
    const G = buildRoadGraph(w);
    assert.ok(G.nodes.length > 0 && G.edges.length > 0);
    assert.equal(G.version, w.grid.version);
    for (const e of G.edges) {
      const t = assertLegal(w.grid, e.poly, `edge ${e.id}`);
      assert.ok(e.length >= t.length - 1 && e.length <= (t.length - 1) * Math.SQRT2 + 1e-9);
      if (e.bridge) { assert.ok(t.length <= 2 + 3, `bridge ${e.id} spans at most BRIDGE_RADIUS steps`); assert.equal(e.cls, 1); continue; }
      for (const [x, y] of t) assert.ok(w.grid.get('road', x, y) > 0, `edge ${e.id} leaves the road at ${x},${y}`);
    }
    const doors = [...w.objects.values()].filter(o => o.kind === 'building' && o.door);
    assert.ok(doors.length > 0);
    const plaza = G.nodes.find(n => n.kind === 'plaza');
    assert.ok(plaza, 'the town square has a node');
    let reached = 0;
    for (const o of doors) {
      const d = G.doorNode(o.id);
      if (d === null) { assert.ok(G.unreached.includes(o.id)); continue; }
      assert.ok(G.edgesOf(d).length > 0, `${o.id} door node has an edge`);
      const r = G.route(d, plaza.id);
      if (r) { reached++; assertLegal(w.grid, G.polyline(r), o.id); }
    }
    assert.ok(reached >= doors.length * minReach, `${reached}/${doors.length} doors route to the plaza`);
    const cartFrom = G.nearestNode(plaza.x, plaza.y, { roadsOnly: true });
    assert.ok(cartFrom !== null);
    const G2 = buildRoadGraph(buildWorld(smallInput(), { v: 1, seed: 7, blocks: {}, lots: {} }, { mod, now: NOW, seed: 7 }));
    assert.deepEqual(G2.nodes, G.nodes);
    assert.deepEqual(G2.edges.map(e => [e.a, e.b, e.length, e.cls, [...e.poly]]), G.edges.map(e => [e.a, e.b, e.length, e.cls, [...e.poly]]));
  });
}
