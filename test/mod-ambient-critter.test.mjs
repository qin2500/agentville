import test from 'node:test';
import assert from 'node:assert/strict';
import critter, { spawnCritters, MAX_PATH, critterOk } from '../mods/agentville.fantasy/ambient/critter.js';
import { createSim } from '../web/src/engine/sim/world-sim.js';

const W = 30, H = 30;
function mkGrid(blocked = () => false) {
  const occ = new Map();
  return {
    inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
    get: (l, x, y) => (l === 'occ' ? (blocked(x, y) ? 1 : 0) : l === 'cost' ? 1 : 0),
    _occ: occ,
  };
}
const stream = seed => { let a = seed; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; };
// straight-line nav stub: L-shaped path of tile centres
const nav = { path(f, t) {
  const pts = [Math.floor(f.x) + 0.5, Math.floor(f.y) + 0.5]; let x = Math.floor(f.x), y = Math.floor(f.y);
  const tx = Math.floor(t.x), ty = Math.floor(t.y);
  while (x !== tx) { x += Math.sign(tx - x); pts.push(x + 0.5, y + 0.5); }
  while (y !== ty) { y += Math.sign(ty - y); pts.push(x + 0.5, y + 0.5); }
  return Float32Array.from(pts);
} };
// Critters driven by the real world-sim (which owns movement). `others` are plain actors visible in ctx.actors
// (agents get a no-op behaviour so the fake ones are left alone).
function drive(w, critters, { others = [], navImpl = nav, seed = 5 } = {}) {
  const sim = createSim({ world: w, nav: navImpl, seed, deps: { agentBehaviour: { update() {} } },
    mod: { ambient: { behaviours: { critter }, spawn: () => critters } } });
  for (const o of others) sim.actors.set(o.id, { flags: 1, anim: 'idle', face: 0, px: o.x, py: o.y, ...o });
  const get = id => sim.actors.get(id);
  return { sim, get, step: () => sim.tick(0.1) };
}
const world = (blocked) => ({ grid: mkGrid(blocked), square: { x: 10, y: 10, w: 8, h: 6 }, villages: [{ block: { x: 2, y: 2, w: 6, h: 6 } }], dock: null });

test('spawnCritters is deterministic and only on free tiles', () => {
  const blocked = (x, y) => x < 4 && y < 4;
  const w = world(blocked);
  const a = spawnCritters(w, (...k) => stream(k.join('|').length * 7 + k.length)());
  const r = (...k) => { let h = 0; for (const c of k.join('|')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 10007) / 10007; };
  const s1 = spawnCritters(w, r), s2 = spawnCritters(w, r);
  assert.deepEqual(s1, s2);
  assert.ok(s1.some(c => c.species === 'cat'));
  assert.ok(s1.some(c => c.species === 'chicken'));
  for (const c of [...a, ...s1]) { assert.equal(c.kind, 'critter'); assert.ok(critterOk(w.grid, Math.floor(c.x), Math.floor(c.y))); }
});

test('wanders stay short and never enter buildings', () => {
  const blocked = (x, y) => (x + y) % 5 === 0 && x > 12;
  const w = world(blocked);
  const paths = [];
  const spy = { path: (f, t, o) => { const p = nav.path(f, t, o); if (p) paths.push(p); return p; } };
  const { get, step } = drive(w, [{ id: 'c1', kind: 'critter', species: 'chicken', x: 15.5, y: 12.5, home: { x: 15.5, y: 12.5 } }], { navImpl: spy });
  let walked = 0;
  for (let i = 0; i < 600; i++) {
    step();
    const a = get('c1');
    if (a.anim === 'walk') walked++;
    assert.ok(!blocked(Math.floor(a.x), Math.floor(a.y)), 'inside a building at tick ' + i);
  }
  assert.ok(walked > 0, 'it should wander at least once');
});

test('pigeon hops away from a walker within 1 tile', () => {
  const w = world(() => false);
  const walker = { id: 'f1', kind: 'folk', x: 12.9, y: 12.5 };
  const { get, step } = drive(w, [{ id: 'p1', kind: 'critter', species: 'pigeon', x: 12.5, y: 12.5, home: { x: 12.5, y: 12.5 } }], { others: [walker] });
  step();
  const a = get('p1');
  assert.equal(a.state, 'walk');
  assert.ok(a.path.length / 2 - 1 <= MAX_PATH);
  const end = [a.path[a.path.length - 2], a.path[a.path.length - 1]];
  assert.ok(Math.hypot(end[0] - walker.x, end[1] - walker.y) > 1.5);
});

test('cat sits beside a waiting agent facing it, then leaves when it stops waiting', () => {
  const w = world(() => false);
  const agent = { id: 'ag', kind: 'agent', x: 15.5, y: 12.5, anim: 'sit', status: { bucket: 'waiting' } };
  const { get, step } = drive(w, [{ id: 'cat', kind: 'critter', species: 'cat', x: 12.5, y: 12.5, home: { x: 12.5, y: 12.5 } }], { others: [agent] });
  let sat = false;
  for (let i = 0; i < 600 && !sat; i++) { step(); sat = get('cat').state === 'sitBy'; }
  const cat = get('cat');
  assert.ok(sat, 'cat should sit by the waiting agent');
  assert.equal(cat.anim, 'sit');
  assert.ok(Math.abs(cat.x - agent.x) + Math.abs(cat.y - agent.y) <= 1.01);
  const dx = agent.x - cat.x, dy = agent.y - cat.y;
  assert.equal(cat.face, (dx + dy >= 0 ? (dx - dy >= 0 ? 0 : 1) : (dx - dy < 0 ? 2 : 3)), 'faces the agent (faceFrom)');
  get('ag').status = { bucket: 'building' };
  step();
  assert.notEqual(cat.state, 'sitBy');
});

test('a lone critter (no other actors) keeps living', () => {
  const w = world(() => false);
  const { get, step } = drive(w, [{ id: 'c2', kind: 'critter', species: 'cat', x: 12.5, y: 12.5 }]);
  for (let i = 0; i < 200; i++) step();
  assert.ok(Number.isFinite(get('c2').x));
});

test('critter behaviour uses no Math.random (ctx.rand only)', () => {
  const orig = Math.random;
  Math.random = () => { throw new Error('Math.random called'); };
  try {
    const { step } = drive(world(() => false), spawnCritters(world(() => false), () => 0.4));
    for (let i = 0; i < 100; i++) step();
  } finally { Math.random = orig; }
});
