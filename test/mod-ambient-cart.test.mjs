import test from 'node:test';
import assert from 'node:assert/strict';
import cart, { spawnCarts } from '../mods/agentville.fantasy/ambient/cart.js';
import { createSim } from '../web/src/engine/sim/world-sim.js';

// Fake world: a 30x10 grid, road row y=5 (x 0..20) as LANE, a vertical spur at x=10 (y 2..8) making a junction.
const W = 30, H = 10;
const road = new Uint8Array(W * H);
for (let x = 0; x <= 20; x++) road[5 * W + x] = 2;
for (let y = 2; y <= 8; y++) road[y * W + 10] = 2;
const grid = { inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < H, get: (l, x, y) => (l === 'road' ? road[y * W + x] : 0) };
const world = { grid, square: { x: 18, y: 4, w: 3, h: 3 }, dock: null,
  villages: [{ name: 'a', tier: 3, cx: 2, cy: 5 }, { name: 'b', tier: 1, cx: 3, cy: 5 }, { name: 'c', tier: 2, cx: 4, cy: 5 }] };
const straight = (f, t) => { const o = []; const s = Math.sign(t.tx - f.tx); for (let x = f.tx; x !== t.tx + s; x += s) o.push({ tx: x, ty: 5 }); return o; };
// One cart of town c driven by the real world-sim (which owns movement). `night` is the sim clock's night flag.
function drive({ night = false, path = straight, seed = 3, r = () => 0 } = {}) {
  const calls = [];
  const [spec] = spawnCarts(world, r).filter(c => c.project === 'c');
  const sim = createSim({ world, seed, nav: { path: (f, t, o) => { calls.push(o); return path(f, t); } },
    mod: { ambient: { behaviours: { cart }, spawn: () => [spec] } }, clock: () => (night ? 0.9 : 0.4) });
  const a = sim.actors.get(spec.id);
  return { a, spec, calls, step: () => sim.tick(0.1) };
}

test('spawnCarts: count by tier, none for low tiers', () => {
  const s = spawnCarts(world, () => 0.1);
  assert.equal(s.filter(c => c.project === 'a').length, 2);
  assert.equal(s.filter(c => c.project === 'b').length, 0);
  assert.equal(s.filter(c => c.project === 'c').length, 1);
  assert.ok(s.every(c => c.kind === 'cart' && c.id.startsWith('cart:')));
  assert.equal(new Set(s.map(c => c.id)).size, s.length);
});

test('cart walks only on road tiles, roadsOnly requested, and waits at the end', () => {
  const { a, calls, step } = drive();
  let reached = false;
  for (let i = 0; i < 1500; i++) {
    step();
    assert.ok(road[Math.floor(a.y) * W + Math.floor(a.x)] >= 2, `off road at ${a.x},${a.y}`);
    if (a.x >= 18.4 && a.state === 'wait') reached = true;
  }
  assert.ok(reached);
  assert.ok(calls.length > 0 && calls.every(o => o.roadsOnly === true));
});

test('pauses at the junction for 1-2 s, standing still', () => {
  const { a, step } = drive();
  let paused = 0, x = null;
  for (let i = 0; i < 100; i++) {
    step();
    if (a.state === 'pause') { paused++; if (x == null) x = a.x; assert.equal(a.x, x, 'does not move while paused'); assert.equal(a.x, 10.5); }
  }
  assert.ok(paused >= 9 && paused <= 21, `paused ${paused} ticks`);
});

test('a path with an off-road tile is refused and the cart stays put', () => {
  const { a, spec, step } = drive({ path: () => [{ tx: 4, ty: 4 }] });
  for (let i = 0; i < 100; i++) step();
  assert.equal(a.x, spec.x); assert.equal(a.y, spec.y);
});

test('at night a cart goes to the market and parks', () => {
  const { a, step } = drive({ night: true });
  for (let i = 0; i < 1500; i++) step();
  assert.ok(a.x >= 18 && a.state === 'wait');
  const x = a.x; for (let i = 0; i < 300; i++) step();
  assert.equal(a.x, x);
});

test('the sim faces the cart along its road (faceFrom: +x is 0)', () => {
  const { a, step } = drive();
  for (let i = 0; i < 60 && a.state !== 'go'; i++) step();
  step(); step();
  assert.equal(a.state, 'go'); assert.equal(a.face, 0);
});

test('deterministic', () => {
  const run = () => { const { a, step } = drive({ r: () => 0.3 }); for (let i = 0; i < 700; i++) step(); return [a.x, a.y, a.state]; };
  assert.deepEqual(run(), run());
});
