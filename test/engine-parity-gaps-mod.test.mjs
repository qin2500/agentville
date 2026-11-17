import './support/ensure-mods-index.mjs';
// Parity proofs for three fantasy-mod gaps: chickens by tier, night light pools, builder cap per PR site.
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const { spawnCritters, CHICKENS_MAX } = await import('../mods/agentville.fantasy/ambient/critter.js');
const { lightsFor, extraLights, POOL_R } = await import('../mods/agentville.fantasy/lights.js');
const { siteWorkAnchors, crewAt, SITE_CREW_MAX } = await import('../mods/agentville.fantasy/represent.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');
const { createLighting } = await import('../web/src/engine/render/lighting.js');

const fx = loadFixture('citydemo.json');
const skip = fx ? false : 'citydemo.json missing';
const rnd = (...k) => { let h = 2166136261; for (const c of k.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
function build() {
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: 7, salt: '7' });
  return buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { now: fx.now, seed: 7, serverId });
}

test('[amb.chickens-hamlet-village] chickens live only in hamlet (<=3) and village (<=4) blocks, none in towns or cities', { skip }, () => {
  const world = build();
  const hens = spawnCritters(world, rnd).filter(c => c.species === 'chicken');
  for (const v of world.villages) {
    const n = hens.filter(c => c.id.startsWith(`critter:chicken:${v.name}:`)).length;
    if (v.tier === 0) assert.ok(n >= 1 && n <= CHICKENS_MAX[0], `${v.name} hamlet has ${n}`);
    else if (v.tier === 1) assert.ok(n >= 1 && n <= CHICKENS_MAX[1], `${v.name} village has ${n}`);
    else assert.equal(n, 0, `${v.name} (tier ${v.tier}) has no chickens`);
  }
  assert.deepEqual(CHICKENS_MAX, [3, 4]);
  assert.ok(world.villages.some(v => v.tier >= 2) && hens.length > 0);
});

test('[night.veil-light-pools] doors, PR-site work lamps, plazas, the square and villagers each get a night light pool', () => {
  assert.equal(fantasy.lightsFor, lightsFor);
  const home = { id: 'h', kind: 'building', tx: 10, ty: 10, w: 3, h: 3, z: 30, door: { tx: 11, ty: 13, face: 'S' }, data: { owner: 'home' } };
  const site = { ...home, id: 's', data: { owner: 'pr', pr: 'p#1', building: true } };
  const done = { ...site, id: 'd', data: { owner: 'pr', pr: 'p#2', building: false } };
  const prop = { id: 'l', kind: 'prop', model: 'lamp', tx: 1, ty: 1, w: 1, h: 1 };
  assert.deepEqual(lightsFor(home).map(s => s.r), [POOL_R.door]);
  assert.deepEqual(lightsFor(site).map(s => s.r), [POOL_R.site, POOL_R.door]);
  assert.deepEqual(lightsFor(done).map(s => s.r), [POOL_R.door], 'a finished PR lot has no work lamp');
  assert.equal(lightsFor(prop), null, 'lamps keep the engine default pool');
  // through the real engine lighting: pools land at the door / site and light only at night
  const world = { objects: new Map([home, site, prop].map(o => [o.id, o])) };
  const L = createLighting({ world, lightsFor, createCanvas: () => ({ getContext: () => ({}) }) });
  const ls = L.lights();
  const doorPool = ls.find(l => l.id === 'h'), c = { sx: (11.5 - 11.5) * 16, sy: (11.5 + 11.5) * 8 }, d = { sx: (11.5 - 13.5) * 16, sy: (11.5 + 13.5) * 8 };
  assert.ok(doorPool && Math.abs(doorPool.x - d.sx) < 1e-6 && Math.abs(doorPool.y - (d.sy - 4)) < 1e-6, 'door pool sits at the door');
  assert.ok(c.sx !== d.sx);
  assert.equal(ls.filter(l => l.id === 's').length, 2);
  assert.ok(ls.some(l => l.id === 'l' && l.kind === 'lamp'));
  const w = { villages: [{ name: 'V', plaza: { x: 0, y: 0, w: 4, h: 4 } }], square: { x: 10, y: 10, w: 8, h: 6 } };
  const ex = extraLights(w, [{ id: 'a1', kind: 'agent', x: 5, y: 5, flags: 1 }, { id: 'a2', kind: 'agent', x: 6, y: 6, flags: 8 }, { id: 'c', kind: 'cart', x: 1, y: 1 }]);
  assert.deepEqual(ex.map(l => [l.kind, l.r]), [['plaza', 64], ['square', 96], ['villager', 20]], 'indoor agents and carts get no pool');
});

test('[vil.builders-cap-4-per-site] a PR site offers at most 4 hammering spots; extra builders wait at the yard', () => {
  assert.equal(SITE_CREW_MAX, 4);
  const site = { tx: 20, ty: 20, w: 3, h: 3 };
  const spots = siteWorkAnchors(site);
  assert.equal(spots.length, 4);
  assert.equal(new Set(spots.map(s => `${s.tx},${s.ty}`)).size, 4, 'distinct tiles');
  for (const s of spots) assert.ok(s.tx < 20 || s.tx >= 23, 'every spot is outside the footprint');
  const { hammering, waiting } = crewAt(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(hammering, ['a', 'b', 'c', 'd']);
  assert.deepEqual(waiting, ['e', 'f']);
  assert.deepEqual(crewAt(['a', 'a', 'b']).hammering, ['a', 'b']);
  assert.deepEqual(siteWorkAnchors(null), []);
});

test('[night.veil-light-pools] the resolved fantasy mod carries lightsFor/extraLights to the renderer (resolveMod, not the raw module)', async () => {
  const { resolveMod } = await import('../web/src/engine/mod/registry.js');
  const m = resolveMod('agentville.fantasy');
  assert.equal(typeof m.lightsFor, 'function');
  assert.equal(typeof m.extraLights, 'function');
});
