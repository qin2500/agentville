// Regression (2026-11-20): a tug sat on the quay stone and bobbed as if afloat. Every craft that bobs sits on open water
// (no land, no deck, no venue object), and any craft on land or a deck has no bob offset. Real harbour fixtures, tiers 1-4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrom, loadFixture, fantasyMod, simMod, SEED } from './engine-support/sim-harness.mjs';

const { venueAssignments } = await import('../web/src/engine/world/venue.js');
const { venueTiles, pierTiles } = await import('../mods/agentville.fantasy/ambient/ship.js');

const FIXTURES = ['harbour-3', 'harbour-6', 'harbour-10', 'harbour', 'harbour-few', 'harbour-mix'];
const CRAFT = new Set(['token', 'tug', 'rowboat']);

for (const name of FIXTURES) {
  test(`${name}: bobbing craft are on water; craft on land or a deck do not bob`, () => {
    const built = buildFrom(loadFixture(`${name}.json`));
    const { world, nav } = built, mod = fantasyMod(), g = world.grid;
    const input = { ...built.input, prs: built.input.prs.map(p => ({ ...p, state: 'loading' })) };
    const berths = venueAssignments(world, input, mod, { venues: {} }, {}).prs;
    const sim = simMod.createSim({ world, nav, seed: SEED, mod, serverId: built.serverId, clock: { dayLength: 60, phase0: 0.3 } });
    sim.applySnapshot(input, { berths });
    let seen = 0, bobbed = 0;
    for (let i = 0; i < 600; i++) {
      sim.step(0.05);
      for (const a of sim.actors.values()) {
        if (!CRAFT.has(a.kind)) continue;
        const p = a.warp ?? a, tx = Math.floor(p.x), ty = Math.floor(p.y);
        const water = g.get('cost', tx, ty) >= 255 && g.get('occ', tx, ty) === 0 && !venueTiles(world, a.venue).has(`${tx},${ty}`);
        seen++;
        if (Math.abs(+a.bob || 0) > 1e-9) { bobbed++; assert.ok(water, `${name} step ${i}: ${a.id} bobs at (${tx},${ty}) but that tile is not open water`); }
        if (!water) assert.equal(+a.bob || 0, 0, `${name}: ${a.id} on land/deck at (${tx},${ty}) has a bob offset`);
        if (a.kind === 'tug') assert.ok(water, `${name}: tug ${a.id} placed on a non-water tile (${tx},${ty})`);
        assert.ok(!pierTiles(world, a.venue).has(`${tx},${ty}`), `${name}: ${a.id} on a pier deck`);
      }
    }
    assert.ok(seen > 0, 'craft were checked');
    assert.ok(bobbed > 0, 'some craft bob (the check is not vacuous)');
  });
}
