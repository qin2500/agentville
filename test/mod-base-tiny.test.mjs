import './support/ensure-mods-index.mjs';
// P10: agentville.base stays tiny (SEAMS P10). Written from the spec, not from the implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const { default: base } = await import('../mods/agentville.base/index.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { MOD1_HOOKS } = await import('../web/src/engine/mod/api.js');
import { LAYOUT_GROUND, ROAD, LOT } from '#agentville/mod';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mods', 'agentville.base');
const OPTIONAL = new Set(['scatter']);   // by design: base has no scatter, no venues, no persist
const hash = () => 0;

const input = (blocks, square = { x: -3, y: -3, w: 6, h: 6 }) => ({
  settlements: blocks.map((block, index) => ({ index, name: `s${index}`, block, plaza: block, cx: 0, cy: 0, accent: '#fff', plan: { w: block.w, h: block.h, ground: [], lots: [] } })),
  square, parks: [],
});
const INPUTS = {
  one: input([{ x: 6, y: -4, w: 9, h: 8 }]),
  three: input([{ x: 6, y: -4, w: 9, h: 8 }, { x: -20, y: 2, w: 12, h: 10 }, { x: -4, y: 12, w: 8, h: 8 }]),
  touching: input([{ x: 6, y: 0, w: 5, h: 5 }, { x: 11, y: 0, w: 5, h: 5 }]),
};
const run = i => base.hooks.layout(i, { rng: () => () => 0.5, hash, parent: null });

test('base resolves and every MOD1 hook is present or documented optional', () => {
  const m = resolveMod('agentville.base');
  assert.equal(m.id, 'agentville.base');
  for (const h of MOD1_HOOKS) assert.ok(typeof m.hooks[h] === 'function' || OPTIONAL.has(h), `hook ${h}`);
  assert.equal(m.hooks.scatter, undefined);
  assert.equal(base.venues, undefined);
  assert.equal(base.persist, undefined);
});

test('terrain classes are [void, land]; represent.pr is a flag lot or nothing', () => {
  const c = base.terrain.classes;
  assert.deepEqual(c.map(x => [x.code, x.name]), [[0, 'void'], [1, 'land']]);
  assert.ok(c[1].wild && c[1].grows && !c[1].water);
  const pr = base.represent.pr;
  assert.deepEqual(pr.building, { as: 'lot', model: 'flag' });
  for (const k of ['loading', 'merged', 'closed']) assert.deepEqual(pr[k], { as: 'none' });
});

// C1 (lead): SEAMS P10 had no roads in base (road/lot all 0, EDGE only). The engine's nav builds its road graph from
// the road layer and needs the square as its hub, so a base world could not route: base now marks the square
// (HUB / MAIN / LOT.HUB), puts ROAD.STREET on each ring and joins every ring to the square with a ROUTE lane.
test('layout: bounds = blocks and square + 8, flat land, street ring, hub square, lanes to it, no ground inside blocks', () => {
  for (const [name, inp] of Object.entries(INPUTS)) {
    const r = run(inp), t = r.tiles, b = r.bounds;
    const rects = [inp.square, ...inp.settlements.map(s => s.block)];
    const x0 = Math.min(...rects.map(q => q.x)), y0 = Math.min(...rects.map(q => q.y));
    const x1 = Math.max(...rects.map(q => q.x + q.w)), y1 = Math.max(...rects.map(q => q.y + q.h));
    assert.deepEqual(b, { ox: x0 - 8, oy: y0 - 8, w: x1 - x0 + 16, h: y1 - y0 + 16 }, name);
    assert.deepEqual(r.focus, b);
    assert.deepEqual([t.ox, t.oy, t.w, t.h], [b.ox, b.oy, b.w, b.h]);
    const n = t.w * t.h;
    assert.equal(t.terrain.length, n); assert.equal(t.ground.length, n); assert.equal(t.road.length, n); assert.equal(t.lot.length, n);
    assert.ok(t.terrain.every(v => v === 1), 'land everywhere in tiles');
    assert.ok(r.outside === undefined || r.outside === 0);
    const inBlock = (x, y) => inp.settlements.some(s => x >= s.block.x && x < s.block.x + s.block.w && y >= s.block.y && y < s.block.y + s.block.h);
    const ROAD_OF = { [LAYOUT_GROUND.EDGE]: ROAD.STREET, [LAYOUT_GROUND.HUB]: ROAD.MAIN, [LAYOUT_GROUND.ROUTE]: ROAD.LANE, 0: 0 };
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
      const i = y * t.w + x, g = t.ground[i], wx = x + t.ox, wy = y + t.oy;
      if (inBlock(wx, wy)) { assert.equal(g + t.road[i] + t.lot[i], 0, `${name}: nothing inside a block`); continue; }
      assert.ok(g in ROAD_OF, `${name}: ground ${g}`);
      assert.equal(t.road[i], ROAD_OF[g], `${name}: road class follows the ground at ${wx},${wy}`);
      const sq = inp.square, inSq = wx >= sq.x && wx < sq.x + sq.w && wy >= sq.y && wy < sq.y + sq.h;
      assert.equal(t.lot[i], inSq ? LOT.HUB : 0);
      if (inSq) assert.equal(g, LAYOUT_GROUND.HUB);
    }
    // one road network: every road tile is reachable from the square over road tiles (4-way)
    const seen = new Uint8Array(t.w * t.h), q = [];
    for (let i = 0; i < seen.length; i++) if (t.ground[i] === LAYOUT_GROUND.HUB) { seen[i] = 1; q.push(i); }
    for (let k = 0; k < q.length; k++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = q[k] % t.w + dx, y = ((q[k] / t.w) | 0) + dy, j = y * t.w + x;
      if (x >= 0 && y >= 0 && x < t.w && y < t.h && !seen[j] && t.road[j]) { seen[j] = 1; q.push(j); }
    }
    for (let i = 0; i < seen.length; i++) if (t.road[i]) assert.ok(seen[i], `${name}: road tile ${i} not joined to the square`);
    // every outside-the-block tile one step from a block (4-way or diagonal) is edge ground (or the square)
    for (const { block: k } of inp.settlements) {
      for (let y = k.y - 1; y <= k.y + k.h; y++) for (let x = k.x - 1; x <= k.x + k.w; x++) {
        if (inBlock(x, y)) continue;
        assert.ok([LAYOUT_GROUND.EDGE, LAYOUT_GROUND.HUB].includes(t.ground[(y - t.oy) * t.w + (x - t.ox)]), `${name}: ring at ${x},${y}`);
      }
    }
  }
});

test('layout: pure, deterministic, and pinned', () => {
  const a = run(INPUTS.three), b = run(INPUTS.three);
  assert.deepEqual(a, b);
  const sig = r => JSON.stringify([r.bounds, r.focus, r.tiles.w, r.tiles.h,
    [...r.tiles.terrain].reduce((s, v) => s + v, 0), [...r.tiles.ground].reduce((s, v, i) => (s + v * (i % 97 + 1)) % 1000003, 0)]);
  assert.equal(sig(a), PINNED_THREE);
  assert.ok(!('data' in a) || a.data === undefined);
});

test('base is tiny: at most 200 JS lines, imports only #agentville/mod and its own files', () => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  let lines = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    lines += src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
    for (const m of src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(m[1] === '#agentville/mod' || /^\.\/[\w.-]+\.js$/.test(m[1]), `${f}: import ${m[1]}`);
    }
  }
  assert.ok(lines <= 200, `${lines} lines`);
});

// re-pinned in C1: base layout gained the hub square, street rings and lanes (see the layout test above)
const PINNED_THREE = '[{"ox":-28,"oy":-12,"w":51,"h":40},{"ox":-28,"oy":-12,"w":51,"h":40},51,40,2040,475248]';

// ---------------------------------------------------------------- base builds every fixture (MOD-READY C0, after P1)
// buildWorld runs base's own layout hook on every engine fixture: deterministic, no layout lint, and every building door
// can be walked to from the square (4-way BFS over cost < 255).
import { createHash } from 'node:crypto';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { viewFromFixture, loadFixture } = await import('./engine-support/world-views.mjs');

const FIX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures', 'engine');
const FIXTURES = fs.readdirSync(FIX_DIR).filter(f => f.endsWith('.json')).sort();
const baseWorld = name => {
  let fx = loadFixture(name);
  if (fx.frames) fx = { ...fx, ...fx.frames[0] };
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: 7, salt: '7', env: { reduceMotion: false, zoom: 1 } });
  return buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { mod: resolveMod('agentville.base'), now: fx.now, seed: 7, serverId });
};
const fingerprint = w => createHash('sha256').update(JSON.stringify([w.sig, w.bounds, w.focus,
  [...w.objects.values()].map(o => JSON.stringify(o)).sort(), ...['terrain', 'ground', 'road', 'lot', 'cost'].map(k => Buffer.from(w.grid[k].buffer).toString('base64'))])).digest('hex').slice(0, 16);

test('base builds every engine fixture through its own layout hook: deterministic, no layout lint, doors reachable', () => {
  const m = resolveMod('agentville.base');
  assert.equal(m.hooks.layout, base.hooks.layout, 'base uses its own layout hook');
  assert.equal(resolveMod('agentville.fantasy').hooks.layout === base.hooks.layout, false, 'fantasy does not inherit base\'s layout');
  for (const name of FIXTURES) {
    const w = baseWorld(name);
    assert.equal(fingerprint(w), fingerprint(baseWorld(name)), `${name}: deterministic`);
    assert.deepEqual(w.lint.filter(l => l.kind === 'layout'), [], `${name}: no layout lint`);
    assert.deepEqual(Object.keys(w.venues), [], `${name}: base has no venues`);
    assert.equal(w.dock, undefined, `${name}: no world.dock (venues replace it)`);
    const { grid, square } = w, W = grid.w, H = grid.h;
    const seen = new Uint8Array(W * H), q = [];
    const push = (x, y) => { const i = (y - grid.oy) * W + (x - grid.ox); if (!grid.inBounds(x, y) || seen[i] || grid.get('cost', x, y) >= 255) return; seen[i] = 1; q.push([x, y]); };
    push(square.x + (square.w >> 1), square.y + (square.h >> 1));
    assert.ok(q.length, `${name}: the square centre is walkable`);
    for (let k = 0; k < q.length; k++) { const [x, y] = q[k]; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
    let doors = 0;
    for (const o of w.objects.values()) {
      if (o.kind !== 'building' || !o.door) continue;
      doors++;
      assert.ok(seen[(o.door.ty - grid.oy) * W + (o.door.tx - grid.ox)], `${name}: door of ${o.id} reachable from the square`);
    }
    assert.ok(doors > 0, `${name}: has doors`);
  }
});

// Pinned base world (SEAMS §0.5: base gets its own golden). Only the lead re-pins, with the reason in the commit.
const BASE_PINS = { 'busy.json': 'cc2a8365ec9fc0a2', 'citydemo.json': '19a1e3f40051463f' };
test('base world fingerprint is pinned (busy, citydemo)', () => {
  const got = Object.fromEntries(Object.keys(BASE_PINS).map(n => [n, fingerprint(baseWorld(n))]));
  if (process.env.VA_PIN_PRINT) console.log('BASE_PINS ' + JSON.stringify(got));
  assert.deepEqual(got, BASE_PINS);
});
