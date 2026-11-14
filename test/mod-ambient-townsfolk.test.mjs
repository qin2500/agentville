import test from 'node:test';
import assert from 'node:assert/strict';
import townsfolk, { spawnTownsfolk, COUNT_BY_TIER, isNight } from '../mods/agentville.fantasy/ambient/townsfolk.js';
import * as mod from '../mods/agentville.fantasy/ambient/townsfolk.js';
import { createSim } from '../web/src/engine/sim/world-sim.js';

const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rand = (...k) => (hash(k.join('|')) % 100000) / 100000;
const W = 30, H = 30;

function fakeWorld(tiers = [0, 1, 2, 3]) {
  const cost = new Uint8Array(W * H).fill(1), occ = new Uint8Array(W * H);
  const objects = new Map();
  const villages = tiers.map((tier, vi) => ({ name: `p${vi}`, tier }));
  tiers.forEach((tier, vi) => {
    for (let k = 0; k < 4; k++) {
      const tx = 2 + vi * 6, ty = 2 + k * 5;
      occ[ty * W + tx + 1] = 1;
      objects.set(`b${vi}.${k}`, { id: `b${vi}.${k}`, kind: 'building', project: `p${vi}`, lot: `l${k}`, data: { owner: 'house' }, tx: tx + 1, ty: ty - 1, w: 1, h: 1, door: { tx, ty, face: 0 } });
    }
  });
  return {
    villages, objects, square: { x: 10, y: 10, w: 6, h: 4 },
    grid: { inBounds: (x, y) => x >= 0 && y >= 0 && x < W && y < H, get: (l, x, y) => (l === 'cost' ? cost : occ)[y * W + x] },
  };
}

function fakeSlots(world) {
  const slots = [];
  for (let i = 0; i < 4; i++) slots.push({ id: `sit${i}`, tx: 11 + i, ty: 12, sub: 0, kind: 'sit' });
  slots.push({ id: 'vend0', tx: 12, ty: 10, sub: 0, kind: 'vend' }, { id: 'vend1', tx: 13, ty: 10, sub: 0, kind: 'vend' });
  for (const o of world.objects.values()) for (const sub of [0, 1]) slots.push({ id: `${o.id}:s${sub}`, tx: o.door.tx, ty: o.door.ty, sub, kind: 'stand' });
  const owner = new Map();
  return {
    owner, slots,
    claim(id, actor) { if (owner.has(id)) return null; owner.set(id, actor); return slots.find(s => s.id === id); },
    release(actor) { for (const [k, v] of owner) if (v === actor) owner.delete(k); },
    nearestFree(x, y, kind) {
      return slots.filter(s => s.kind === kind && !owner.has(s.id)).sort((a, b) => Math.hypot(a.tx - x, a.ty - y) - Math.hypot(b.tx - x, b.ty - y))[0] || null;
    },
  };
}

// 4-connected BFS over walkable tiles (cost < 255, occ 0), tile centres; the target tile itself must be walkable
function bfsNav(world) {
  const g = world.grid, ok = (x, y) => g.inBounds(x, y) && g.get('cost', x, y) < 255 && g.get('occ', x, y) === 0;
  return { path(f, t) {
    const sx = Math.floor(f.x), sy = Math.floor(f.y), tx = Math.floor(t.x), ty = Math.floor(t.y);
    if (!ok(tx, ty)) return null;
    const prev = new Map([[`${sx},${sy}`, null]]), q = [[sx, sy]];
    while (q.length) {
      const [x, y] = q.shift();
      if (x === tx && y === ty) {
        const pts = []; for (let k = `${x},${y}`; k; k = prev.get(k)) { const [a, b] = k.split(',').map(Number); pts.unshift(a + 0.5, b + 0.5); }
        return Float32Array.from(pts);
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + dx},${y + dy}`;
        if (!prev.has(k) && ok(x + dx, y + dy)) { prev.set(k, `${x},${y}`); q.push([x + dx, y + dy]); }
      }
    }
    return null;
  } };
}

// Runs the townsfolk through the real world-sim (which owns movement); `clock.night` flips day and night.
function setup(world, specs, night = false) {
  const slots = fakeSlots(world);
  const clock = { night };
  const sim = createSim({ world, nav: { ...bfsNav(world), slots }, seed: 11,
    mod: { ambient: { behaviours: { folk: townsfolk }, spawn: () => specs } }, clock: () => (clock.night ? 0.9 : 0.4) });
  const actors = [...sim.actors.values()];
  return { sim, clock, actors, slots, step: () => sim.tick(0.1) };
}

test('spawnTownsfolk counts by tier, deterministic, no functions in specs', () => {
  const w = fakeWorld();
  const a = spawnTownsfolk(w, rand), b = spawnTownsfolk(w, rand);
  assert.deepEqual(a, b);
  for (const [i, t] of [0, 1, 2, 3].entries()) assert.equal(a.filter(s => s.project === `p${i}`).length, COUNT_BY_TIER[t]);
  assert.deepEqual(COUNT_BY_TIER, [2, 5, 10, 18]);
  assert.ok(a.every(s => s.kind === 'folk' && w.objects.has(s.home)));
  assert.equal(new Set(a.map(s => s.id)).size, a.length);
  assert.ok(a.some(s => s.role === 'vendor'));
  const noFn = v => { if (typeof v === 'function') return false; return v && typeof v === 'object' ? Object.values(v).every(noFn) : true; };
  assert.ok(noFn(a));
  for (const k of Object.keys(mod)) if (typeof mod[k] !== 'function' && k !== 'default') assert.ok(noFn(mod[k]), k);
});

test('day: folk walk, stay on walkable tiles, never overlap blocked tiles', () => {
  const w = fakeWorld([2]);
  const { actors, step } = setup(w, spawnTownsfolk(w, rand));
  const start = actors.map(a => [a.x, a.y]);
  let moved = 0;
  for (let i = 0; i < 3000; i++) {
    step();
    for (const a of actors) {
      assert.ok(w.grid.inBounds(Math.floor(a.x), Math.floor(a.y)));
      assert.ok(w.grid.get('cost', Math.floor(a.x), Math.floor(a.y)) < 255);
      assert.equal(w.grid.get('occ', Math.floor(a.x), Math.floor(a.y)), 0);
    }
  }
  actors.forEach((a, i) => { if (a.x !== start[i][0] || a.y !== start[i][1]) moved++; });
  assert.ok(moved >= actors.length / 2);
});

test('slots: never leaked, at most one claim per actor, released on entering home', () => {
  const w = fakeWorld([3]);
  const { clock, actors, slots, step } = setup(w, spawnTownsfolk(w, rand));
  for (let i = 0; i < 3000; i++) {
    step();
    const held = new Map();
    for (const [, who] of slots.owner) held.set(who, (held.get(who) || 0) + 1);
    for (const n of held.values()) assert.ok(n <= 1);
  }
  clock.night = true;
  for (let i = 0; i < 3000; i++) step();
  for (const a of actors) if (!a.lantern) { assert.equal(a.state, 'home'); assert.ok(![...slots.owner.values()].includes(a.id)); }
});

test('night: most go home, lantern walkers keep walking; leave only when day returns', () => {
  const w = fakeWorld([3]);
  const specs = spawnTownsfolk(w, rand);
  const { clock, actors, step } = setup(w, specs, true);
  for (let i = 0; i < 3000; i++) step();
  const home = actors.filter(a => a.state === 'home').length;
  assert.ok(home >= actors.length * 0.5, `home ${home}/${actors.length}`);
  assert.ok(actors.some(a => a.lantern));
  const lanternOut = actors.filter(a => a.lantern && a.state !== 'home');
  assert.ok(lanternOut.length >= 1);
  clock.night = false;
  for (let i = 0; i < 3000; i++) step();
  assert.ok(actors.filter(a => a.state !== 'home').length > home * 0 + actors.length / 2);
});

test('vendors stand at vend anchors by day', () => {
  const w = fakeWorld([3]);
  const { actors, slots, step } = setup(w, spawnTownsfolk(w, rand));
  for (let i = 0; i < 2000; i++) step();
  const vend = actors.filter(a => a.role === 'vendor');
  assert.ok(vend.length > 0);
  const atVend = vend.filter(a => [...slots.owner].some(([id, who]) => who === a.id && id.startsWith('vend')));
  assert.ok(atVend.length >= 1);
});

test('deterministic for same inputs', () => {
  const run = () => {
    const w = fakeWorld([2]);
    const { actors, step } = setup(w, spawnTownsfolk(w, rand));
    for (let i = 0; i < 1500; i++) step();
    return actors.map(a => [a.x.toFixed(3), a.y.toFixed(3), a.state]);
  };
  assert.deepEqual(run(), run());
});

test('isNight: explicit flag, dayPhase, and ms clock', () => {
  assert.equal(isNight({ night: true }), true);
  assert.equal(isNight({ dayPhase: 0.5 }), false);
  assert.equal(isNight({ dayPhase: 0.9 }), true);
  assert.equal(isNight({ now: 0 }), true);
  assert.equal(isNight({ now: 240_000 }), false);
});
