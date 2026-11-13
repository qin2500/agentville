import test from 'node:test';
import assert from 'node:assert/strict';
import base from '../mods/agentville.base/index.js';
import { API_VERSION, MOD0_HOOKS, MOD_CODE_MAX } from '../web/src/engine/mod/api.js';
import { streamFor, hash } from '../web/src/engine/core/rng.js';

const ctxFor = (seed = 7, key = 'proj') => ({
  rng: s => streamFor(seed, 'agentville.base', key, s), hash, time: { now: 0 },
  forcedTier: null, forcedStyle: null, parent: null,
});
const H = base.hooks;
const agent = (id, over = {}) => ({ id, name: id, project: 'p', parent: null, status: 'working', needs: null, role: 'worker',
  crown: false, important: false, stopped: false, harness: 'claude', since: 0, lastActive: 0, prs: [], ...over });
const pr = (n, state) => ({ id: `p#${n}`, project: 'p', number: n, title: 't', state, checks: { passed: 0, failed: 0, pending: 0 }, review: null, size: { additions: 0, deletions: 0, files: 0 } });
const project = { key: 'p', name: 'P', accent: '#fff', stats: { prsEver: 5, prsLive: 1, agentsEver: 4, agentsNow: 3, transcriptMB: 1 } };

test('shape and tables', () => {
  assert.equal(base.apiVersion, API_VERSION);
  for (const h of MOD0_HOOKS) assert.equal(typeof H[h], 'function', h);
  const t = base.terrain;
  assert.equal(t.wildCost, 3);
  for (const ty of t.types) { assert.ok(ty.code >= 0 && ty.code <= MOD_CODE_MAX); assert.equal(t.byName[ty.name], ty.code); }
  assert.deepEqual(t.types.find(x => x.name === 'path').tags, ['street', 'walk']);
  assert.equal(t.types.find(x => x.name === 'water').cost, 255);
  assert.equal(base.rules.layout.accents.length, 4);
  assert.equal(base.rules.holdMs, 12 * 3600 * 1000);
  assert.equal(base.objects.props.marker.z, 8);
  assert.equal(base.objects.buildings.box.z, 24);
});

test('growth, tier, capacity, crowns, style', () => {
  const c = ctxFor();
  assert.equal(H.growth(project, c), 8);
  assert.equal(H.tier(99, 3, c), 0);
  assert.equal(H.capacity(0, 0, c), 4);
  assert.equal(H.capacity(0, 5, c), 8);
  assert.equal(H.capacity(0, 8, c), 8);
  assert.equal(H.crowns(project, [], c), 1);
  const s = H.style('alpha', c);
  assert.equal(s.key, 'base');
  assert.ok(base.rules.layout.accents.includes(s.accent));
  assert.deepEqual(s, H.style('alpha', c));
});

test('lots: homes for roots, sites for building PRs (max 8)', () => {
  const agents = [agent('a'), agent('b', { parent: 'a' }), agent('c', { parent: 'a', role: 'lead' }), agent('d', { role: 'boss' })];
  const prs = [...Array.from({ length: 12 }, (_, i) => pr(i, 'building')), pr(99, 'merged')];
  const out = H.lots(project, agents, prs, ctxFor());
  const homes = out.filter(l => l.owner === 'home');
  assert.deepEqual(homes.map(l => l.item), ['home:a', 'home:c', 'home:d']);
  assert.equal(homes.find(l => l.agent === 'd').rank, 'L');
  assert.ok(homes.filter(l => l.agent !== 'd').every(l => l.rank === 'S'));
  const sites = out.filter(l => l.owner === 'pr');
  assert.equal(sites.length, 8);
  assert.ok(sites.every(l => l.rank === 'S' && l.building && l.item === `pr:${l.pr}`));
});

const walk = new Set(base.terrain.types.filter(t => t.tags?.includes('walk')).map(t => t.code));

function checkPlan(p, want) {
  assert.equal(p.ground.length, p.w * p.h);
  assert.ok(p.lots.length >= want, `lots ${p.lots.length} >= ${want}`);
  assert.ok(p.cap >= want);
  const taken = new Map();
  for (const l of p.lots) {
    assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.w <= p.w && l.y + l.h <= p.h, 'in bounds');
    for (let y = l.y; y < l.y + l.h; y++) for (let x = l.x; x < l.x + l.w; x++) {
      assert.ok(!taken.has(`${x},${y}`), 'no overlap');
      taken.set(`${x},${y}`, l.id);
    }
  }
  for (const o of p.props) assert.ok(base.objects.props[o.kind] && o.x >= 0 && o.x < p.w && o.y >= 0 && o.y < p.h);
  // BFS over walk-tagged codes from the plaza.
  const seen = new Set();
  const q = [[p.plaza.x, p.plaza.y]];
  seen.add(`${p.plaza.x},${p.plaza.y}`);
  assert.ok(walk.has(p.ground[p.plaza.y * p.w + p.plaza.x]));
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h || seen.has(`${nx},${ny}`)) continue;
      if (!walk.has(p.ground[ny * p.w + nx])) continue;
      seen.add(`${nx},${ny}`); q.push([nx, ny]);
    }
  }
  for (const l of p.lots) {
    const dx = l.x + Math.floor(l.doorX / 16), dy = l.y + l.h;
    assert.ok(dy < p.h && walk.has(p.ground[dy * p.w + dx]), `door walkable ${l.id}`);
    assert.ok(seen.has(`${dx},${dy}`), `door connected ${l.id}`);
    assert.ok(l.door);
  }
}

test('planner: valid plans across sizes', () => {
  for (const n of [1, 2, 3, 4, 5, 8, 9, 13, 20, 37, 64]) {
    for (const seed of [1, 99]) {
      const req = { tier: 0, seed, lots: n, crowns: 1, style: { key: 'base' } };
      checkPlan(H.planSettlement(req, ctxFor(seed)), n);
    }
  }
});

test('planner: deterministic', () => {
  const req = { tier: 0, seed: 5, lots: 11, crowns: 1, style: { key: 'base' } };
  const a = H.planSettlement(req, ctxFor(5)), b = H.planSettlement(req, ctxFor(5));
  assert.deepEqual(a, b);
  assert.ok(JSON.stringify(a).length > 0);
});
