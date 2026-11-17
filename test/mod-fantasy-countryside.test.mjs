import './support/ensure-mods-index.mjs';
// M7 dress: the gaps between grown blocks read as countryside (meadow, wildflowers, copses, a winding footpath), never bare
// flat grass; deterministic; cosmetic (nothing on a street, a lot, a door's tile or beside built land). Pure node, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { scatterWild } = await import('../web/src/engine/world/scatter.js');
const { WorldGrid, LOT } = await import('../web/src/engine/core/grid.js');
const { ObjectStore } = await import('../web/src/engine/core/objects.js');
const { viewFromFixture } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { CLASSES } = await import('../mods/agentville.fantasy/terrain.js');
const { tilePixels } = await import('../mods/agentville.fantasy/ground.js');

const code = n => CLASSES.find(c => c.name === n).code;
const GRASS = code('grass'), MEADOW = code('meadow'), BLOOM = code('bloom-meadow'), PATH = code('footpath');
const DRIFTS = ['drift-gold', 'drift-rose', 'drift-violet'].map(code), TALL = code('tall-grass');
const DRESSED = new Set([MEADOW, BLOOM, PATH, TALL, ...DRIFTS]);
const root = new URL('../', import.meta.url);
const read = p => JSON.parse(fs.readFileSync(new URL(p, root), 'utf8'));

function nested() {
  const layout = read('e2e/fixtures/engine/stress-nested.layout.json'), fx = read('e2e/fixtures/engine/stress.json');
  const persisted = JSON.parse(JSON.stringify(layout.persisted));
  const { input, serverId } = toWorldInput(viewFromFixture(fx, { now: fx.now }), { seed: layout.seed, salt: layout.salt, features: fantasy.features });
  return buildWorld(input, persisted, { mod: fantasy, now: fx.now, seed: layout.seed, serverId });
}
const world = nested();
const g = world.grid, W = g.w, H = g.h;
const built = i => g.lot[i] !== LOT.WILD || g.ground[i] !== 0;
const wildObjs = () => [...world.objects.values()].filter(o => o.data?.wild);
const idx = (x, y) => (y - g.oy) * W + (x - g.ox);

// BFS distance (to 8) from built land, the same measure the engine hands the hook
const dist = new Int16Array(W * H).fill(-1);
{
  const q = [];
  for (let i = 0; i < W * H; i++) if (built(i)) { dist[i] = 0; q.push(i); }
  for (let k = 0; k < q.length; k++) {
    const d = dist[q[k]]; if (d > 8) continue;
    const x = q[k] % W, y = (q[k] / W) | 0;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + a, ny = y + b; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx; if (dist[j] < 0) { dist[j] = d + 1; q.push(j); }
    }
  }
}
const gapTiles = [];
for (let i = 0; i < W * H; i++) if (!built(i) && g.terrain[i] >= 3 && dist[i] >= 3 && dist[i] <= 8) gapTiles.push(i);

test('a gap region gets non-flat ground and some dressing', () => {
  assert.ok(gapTiles.length > 1000, `only ${gapTiles.length} gap tiles`);
  const dressed = gapTiles.filter(i => DRESSED.has(g.terrain[i])).length;
  assert.ok(dressed / gapTiles.length > 0.25, `only ${dressed}/${gapTiles.length} gap tiles are meadow, bloom or footpath`);
  assert.ok(gapTiles.some(i => g.terrain[i] === BLOOM), 'no wildflower patch');
  assert.ok(gapTiles.some(i => g.terrain[i] === PATH), 'no footpath');
  const objs = new Set(wildObjs().map(o => idx(o.tx, o.ty)));
  assert.ok(gapTiles.filter(i => objs.has(i)).length > 100, 'no trees or props in the gaps');
  // flat bare grass is the exception: a gap tile left as plain GRASS is only the near-the-block fringe
  const plain = gapTiles.filter(i => g.terrain[i] === GRASS && dist[i] >= 6).length;
  assert.ok(plain / gapTiles.length < 0.05, `${plain} far gap tiles are still plain grass`);
});

test('no run of plain meadow wider than 3x3 without a drift, long grass, path, bush, rock or tree', () => {
  const objs = new Set(wildObjs().map(o => idx(o.tx, o.ty)));
  const plain = (x, y) => x >= g.ox && y >= g.oy && x < g.ox + W && y < g.oy + H && g.terrain[idx(x, y)] === MEADOW && !objs.has(idx(x, y));
  let meadow = 0, drifts = 0;
  for (let i = 0; i < W * H; i++) { if (g.terrain[i] === MEADOW) meadow++; if (DRIFTS.includes(g.terrain[i])) drifts++; }
  assert.ok(meadow > 1000 && drifts > 200, `meadow ${meadow}, drift tiles ${drifts}`);
  for (let y = g.oy; y < g.oy + H - 3; y++) for (let x = g.ox; x < g.ox + W - 3; x++) {
    if (!plain(x, y)) continue;
    let all = true; for (let b = 0; b < 4 && all; b++) for (let a = 0; a < 4 && all; a++) all = plain(x + a, y + b);
    assert.ok(!all, `a plain 4x4 of meadow at ${x},${y}`);
  }
});

test('the dressing is deterministic', () => {
  const sig = w => { const t = w.grid.terrain; let h = 0; for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t[i]) | 0; return `${h}|${[...w.objects.values()].filter(o => o.data?.wild).map(o => `${o.id}:${o.model}:${o.variant}`).join(',')}`; };
  assert.equal(sig(nested()), sig(world));
});

test('nothing lands on streets, lots, beside built land or on a door tile; footpath is wild land only', () => {
  const seen = new Set(wildObjs().map(o => idx(o.tx, o.ty)));
  for (const o of wildObjs()) {
    const i = idx(o.tx, o.ty);
    assert.ok(!built(i), `${o.id} on built land`);
    assert.equal(g.road[i], 0, `${o.id} on a road`);
    for (const [a, b] of [[1, 0], [0, 1], [1, 1]]) { const x = o.tx + a, y = o.ty + b; if (x < g.ox + W && y < g.oy + H) assert.ok(!built(idx(x, y)), `${o.id} beside built land`); }
  }
  for (const ob of world.objects.values()) for (const s of ob.anchors?.stand ?? []) assert.ok(!seen.has(idx(s.tx, s.ty)), `${ob.id}: a tree on its door tile`);
  for (let i = 0; i < W * H; i++) if (g.terrain[i] === PATH) assert.ok(!built(i) && g.road[i] === 0, 'footpath on a street or lot');
});

test('cosmetic: a block grown into a gap takes the tiles and the dressing yields', () => {
  const mod = { id: fantasy.id, objects: fantasy.objects, terrain: fantasy.terrain, hooks: { scatter: fantasy.hooks.scatter } };
  const run = block => {
    const grid = new WorldGrid({ ox: 0, oy: 0, w: 80, h: 40 }), store = new ObjectStore();
    grid.terrain.fill(GRASS);
    for (const [x0, w] of block) for (let y = 5; y < 35; y++) for (let x = x0; x < x0 + w; x++) grid.lot[(y) * 80 + x] = 0;
    scatterWild(grid, store, {}, 3, mod);
    return { grid, store };
  };
  const before = run([[10, 15], [55, 15]]);          // two blocks, a 30-wide gap
  const after = run([[10, 15], [55, 15], [32, 12]]);  // a third grows into the gap
  assert.ok([...before.store.values()].some(o => o.tx >= 32 && o.tx < 44), 'the gap was dressed');
  for (const o of after.store.values()) assert.ok(!(o.tx >= 32 && o.tx < 44 && o.ty >= 5 && o.ty < 35), `${o.id} stayed inside the grown block`);
  assert.ok(![...after.grid.terrain].some((t, i) => DRESSED.has(t) && after.grid.lot[i] === 0), 'dressed terrain inside a block');
});

test('meadow ground is painted as a dithered tile, not a flat colour, and is stable', () => {
  for (const t of [MEADOW, BLOOM, PATH, GRASS, 4]) {
    const nb = { terrain: t, tn: t, te: t, ts: t, tw: t, tx: 5, ty: 9 };
    const a = tilePixels(0, nb), b = tilePixels(0, { ...nb });
    assert.ok(a, `terrain ${t} has art`);
    assert.deepEqual([...a.data], [...b.data]);
    const cols = new Set(); for (let i = 0; i < a.data.length; i += 4) if (a.data[i + 3]) cols.add(`${a.data[i]},${a.data[i + 1]},${a.data[i + 2]}`);
    assert.ok(cols.size >= 3, `terrain ${t}: only ${cols.size} colours`);
  }
});

test('object budget: dressing does not add wild objects (stress-nested)', () => {
  const OLD = 25112;   // wild objects on the nested stress fixture before the dressing
  assert.ok(wildObjs().length <= OLD, `${wildObjs().length} > ${OLD}`);
});
