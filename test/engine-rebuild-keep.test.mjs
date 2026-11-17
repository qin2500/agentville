// A world rebuild must not disturb agents (design §2 layouts stable, §4 setWorld keeps actors). Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { present, loadFixture, makeSim, buildFrom, advance, agentsOf, SEED } from './engine-support/sim-harness.mjs';
// loaded before any test is registered, so no test depends on declaration order (Node 22 ran them first)
const awaitedBuild = await import('../web/src/engine/world/build.js');
const awaitedNav = await import('../web/src/engine/nav/index.js');

const skip = (!present || !loadFixture('citydemo.json')) && 'sim or fixture missing';
const lastOf = a => (a.path && a.path.length >= 2 ? [a.path[a.path.length - 2], a.path[a.path.length - 1]] : null);
const snap = sim => new Map(agentsOf(sim).map(a => [a.id, { x: a.x, y: a.y, tgt: (a.fade ? [a.fade.x, a.fade.y] : lastOf(a))?.join(','), slot: a.slot ? `${a.slot.tx},${a.slot.ty},${a.slot.sub}` : '' }]));
const run = (sim, n) => { for (let i = 0; i < n; i++) advance(sim); };

for (const name of ['citydemo.json', 'busy.json']) {
  const fx = loadFixture(name);
  test(`rebuild with identical input: no agent moves or changes target (${name})`, { skip: skip || !fx && 'fixture missing' }, () => {
    const { sim } = makeSim(fx);
    run(sim, 200);                                  // settle: placements done
    const before = snap(sim);
    const nb = buildFrom(fx, SEED);
    sim.setWorld(nb.world, nb.nav);
    run(sim, 1);
    const after = snap(sim);
    for (const [id, b] of before) {
      const a = after.get(id);
      assert.ok(a, `${id} vanished`);
      assert.ok(Math.abs(a.x - b.x) < 0.2 && Math.abs(a.y - b.y) < 0.2, `${id} moved ${b.x},${b.y} -> ${a.x},${a.y}`);
      assert.equal(a.tgt, b.tgt, `${id} target changed ${b.tgt} -> ${a.tgt}`);
    }
    run(sim, 100);                                  // and it stays put afterwards
    for (const [id, b] of before) {
      const a = snap(sim).get(id);
      assert.ok(Math.abs(a.x - b.x) < 0.2 && Math.abs(a.y - b.y) < 0.2, `${id} drifted after rebuild ${b.x},${b.y} -> ${a.x},${a.y}`);
    }
  });
}

test('rebuild where one project\'s agent count changes: other projects\' agents do not move', { skip }, async t => {
  const fx = loadFixture('citydemo.json');
  const { sim, input } = makeSim(fx);
  run(sim, 200);
  const projOf = new Map(input.agents.map(a => [a.id, a.project]));
  const counts = new Map();
  for (const a of input.agents) counts.set(a.project, (counts.get(a.project) ?? 0) + 1);
  assert.ok(counts.size >= 2, 'fixture has at least two projects');
  const [victim] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  for (const mode of ['shrink', 'grow']) {
    await t.test(mode, () => {
      const s = makeSim(fx).sim;
      run(s, 200);
      const before = snap(s);
      // new input: the victim project loses 2 agents, or gains 2 (clones with fresh ids)
      const B0 = buildFrom(fx, SEED), base = { ...B0.input, serverId: B0.serverId };
      const mine = base.agents.filter(a => a.project === victim);
      const agents = mode === 'shrink'
        ? base.agents.filter(a => !mine.slice(-2).some(m => m.id === a.id))
        : [...base.agents, ...mine.slice(0, 2).map((a, i) => ({ ...a, id: `${a.id}~new${i}`, parentId: undefined }))];
      const changed = { ...base, agents };
      // rebuild the world from the changed input via the same builder/mod path the app uses
      const { buildWorld } = awaitedBuild;
      const world = buildWorld(changed, { v: 1, seed: SEED, blocks: {}, lots: {} }, { now: fx.now, seed: SEED, serverId: base.serverId });
      const nav = awaitedNav.createNav(world);
      s.setWorld(world, nav);
      s.applySnapshot(changed);
      run(s, 60);
      const after = snap(s);
      let checked = 0;
      for (const [id, b] of before) {
        if (projOf.get(id) === victim) continue;
        const a = after.get(id);
        if (!a) continue;
        checked++;
        assert.ok(Math.abs(a.x - b.x) < 0.2 && Math.abs(a.y - b.y) < 0.2, `${id} (project ${projOf.get(id)}) moved ${b.x},${b.y} -> ${a.x},${a.y} after ${victim} ${mode}`);
      }
      assert.ok(checked > 0, 'some other-project agents were compared');
    });
  }
});
