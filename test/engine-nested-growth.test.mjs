import './support/ensure-mods-index.mjs';
// Nested growth in the engine (design decision: a project's decor never shrinks on tier-up; the plan for
// tier N+1 nests tier N's). Through real rebuilds (fantasy mod, buildWorld, persisted layout): every building and prop a
// project had keeps its exact world tile after a re-plan when the anchored block fits (old origin - nest offset), and in
// any case all of them move together (their tiles relative to the block's old origin are kept); decor never shrinks.
// Pure, node only, no store, no real sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0), SEED = 7;
const GAP = fantasy.rules.layout.gap, SQUARE = fantasy.rules.layout.square;
const near = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

function payload({ prs = 0, ever = 0, extraAgents = 0 } = {}) {
  const ag = (id, project, o = {}) => ({ id, name: id, project, bucket: o.bucket ?? 'building', role: o.role, parentId: o.parent,
    severity: null, live: true, lastActivityAt: NOW - 60_000, since: NOW - 3_600_000, prs: o.prs ?? [], harness: 'claude-code' });
  const agents = [ag('d-boss', 'demo-app', { role: 'boss', bucket: 'waiting', prs: [{ id: '101' }] })];
  for (let i = 0; i < 4 + extraAgents; i++) agents.push(ag(`d-lead${i}`, 'demo-app', { role: 'lead', parent: 'd-boss' }));
  for (let i = 0; i < 4; i++) agents.push(ag(`d-solo${i}`, 'demo-app', { bucket: i % 2 ? 'building' : 'waiting' }));
  agents.push(ag('c-a', 'codex-app'), ag('c-b', 'codex-app', { bucket: 'waiting' }));
  const demoPrs = [{ id: '101', live: true }, { id: '99', live: false }];
  for (let i = 0; i < prs; i++) demoPrs.push({ id: String(500 + i), live: false });
  return { agents, projects: [
    { name: 'demo-app', prs: demoPrs, agentsEver: 11 + ever, transcriptBytes: 4e6 },
    { name: 'codex-app', prs: [], agentsEver: 2, transcriptBytes: 1e5 },
  ] };
}
function build(src, persisted, now) {
  const { input, serverId } = toWorldInput(makeView(src, { now }), { seed: SEED, salt: 'nest' });
  return buildWorld(input, persisted, { mod: fantasy, now, seed: SEED, serverId });
}
// the project's buildings (by plan lot, else object id) and props, with their tiles
const placed = (w, project) => new Map([...w.objects.values()].filter(o => o.project === project && (o.kind === 'building' || o.kind === 'prop' || o.kind === 'tree' || o.kind === 'decal'))
  .map(o => [o.lot != null ? `lot ${o.lot}` : o.id, { x: o.tx, y: o.ty, model: o.model, variant: o.variant, kind: o.kind }]));
const decor = m => [...m.values()].filter(o => o.kind !== 'building').length;

test('growth through every tier keeps every old building and prop on its tile (or all of them shifted together)', () => {
  const P = { v: 1, seed: SEED, blocks: {}, lots: {} };
  const steps = [{ ever: -9 }, { ever: -6, extraAgents: 4 }, {}, { ever: 6, extraAgents: 4 }, { prs: 8, ever: 24 }, { prs: 8, ever: 24, extraAgents: 10 },
    { prs: 40, ever: 80, extraAgents: 14 }, { prs: 40, ever: 80, extraAgents: 24 }];
  let t = NOW, prev = build(payload(steps[0]), P, t), tiers = new Set([P.blocks['demo-app'].tier]), grown = 0, exact = 0;
  for (const s of steps.slice(1)) {
    const was = { ...P.blocks['demo-app'] }, old = placed(prev, 'demo-app');
    const w = build(payload(s), P, (t += 3000));
    const b = P.blocks['demo-app'], now = placed(w, 'demo-app');
    tiers.add(b.tier);
    const label = `${was.tier}/${was.cap} -> ${b.tier}/${b.cap} (${b.nest})`;
    assert.ok(decor(now) >= decor(old), `${label}: decor never shrinks (${decor(old)} -> ${decor(now)})`);
    if (b.tier < was.tier) continue;   // a tier drop may re-plan fresh
    if (b.w !== was.w || b.h !== was.h) grown++;
    // one shift for everything that stood before (homes and PRs may change lot only when theirs is gone; none is here)
    const shifts = new Set();
    for (const [id, o] of old) {
      const n = now.get(id);
      assert.ok(n, `${label}: ${id} is still there`);
      assert.equal(n.model, o.model, `${label}: ${id} keeps its model`);
      assert.equal(n.variant, o.variant, `${label}: ${id} keeps its variant ${JSON.stringify([o, n])}`);
      shifts.add(`${n.x - o.x},${n.y - o.y}`);
    }
    assert.equal(shifts.size, 1, `${label}: every old item moved together (${[...shifts].slice(0, 6)})`);
    if (shifts.has('0,0')) exact++;
    else {
      // the old items moved only because the anchored rect (old origin - nest offset) is taken: it is within the gap of
      // the square or another block, and the block that was placed instead still covers the old one
      const nest = w.villages.find(v => v.name === 'demo-app').plan.nest;
      assert.ok(nest && nest.from === was.nest, `${label}: a moved re-plan nests the old plan`);
      const want = { x: was.x - nest.dx, y: was.y - nest.dy, w: b.w, h: b.h };
      const others = [SQUARE, ...w.villages.filter(v => v.name !== 'demo-app').map(v => v.block)];
      assert.ok(others.some(o => near(want, o, GAP)), `${label}: the anchored rect was free but the block moved`);
      assert.ok(b.x <= was.x && b.y <= was.y && b.x + b.w >= was.x + was.w && b.y + b.h >= was.y + was.h, `${label}: grew in place`);
    }
    prev = w;
  }
  assert.ok(tiers.size >= 3, `growth crossed tiers (${[...tiers]})`);
  assert.ok(grown >= 3, `growth re-planned several times (${grown})`);
});

test('with room round it, a tier-up keeps every old building and prop on its exact world tile', () => {
  const P = { v: 1, seed: SEED, blocks: {}, lots: {} };
  build(payload({ ever: -9 }), P, NOW);
  P.blocks['demo-app'].x += 150;   // far from the square and the other block: the anchored rect is free
  const w0 = build(payload({ ever: -9 }), P, NOW + 1000), old = placed(w0, 'demo-app'), was = { ...P.blocks['demo-app'] };
  for (const [i, s] of [{ ever: 6, extraAgents: 4 }, { prs: 8, ever: 24 }, { prs: 40, ever: 80, extraAgents: 14 }].entries()) {
    const w = build(payload(s), P, NOW + 5000 * (i + 2)), now = placed(w, 'demo-app');
    assert.ok(P.blocks['demo-app'].tier > was.tier, 'it tiered up');
    for (const [id, o] of old) assert.deepEqual(now.get(id), o, `${id} kept its exact tile, model and variant`);
    assert.ok(decor(now) > decor(old), 'and decor grew');
  }
});

test('a layout saved before nested growth (blocks without `nest`) loads with every lot and building tile unchanged', () => {
  // condition: live villages must not re-lay-out on the first load after the deploy; nesting applies only
  // from the next tier-up. A pre-change save is the same persisted shape minus the `nest` field on each block.
  // Simulate the pre-change code: grow through tiers with no chain ever saved (every re-plan fresh, as before nesting).
  const P = { v: 1, seed: SEED, blocks: {}, lots: {} };
  const strip = () => { for (const b of Object.values(P.blocks)) delete b.nest; };
  let before = null;
  for (const s of [{ ever: -9 }, {}, { prs: 8, ever: 24 }]) { before = build(payload(s), P, NOW); strip(); }
  const legacy = JSON.parse(JSON.stringify(P));
  const blocksBefore = JSON.stringify(Object.fromEntries(Object.entries(legacy.blocks).map(([k, b]) => [k, [b.x, b.y, b.w, b.h, b.tier, b.cap]])));
  let t = NOW + 2000;
  for (let i = 0; i < 4; i++) {   // the first load and several polls with no tier or cap change
    const w = build(payload({ prs: 8, ever: 24 }), legacy, (t += 3000));
    for (const name of ['demo-app', 'codex-app']) {
      const a = placed(before, name), b = placed(w, name);
      assert.equal(b.size, a.size, `${name}: same items after load ${i}`);
      for (const [id, o] of a) assert.deepEqual(b.get(id), o, `${name}: ${id} unchanged after load ${i}`);
    }
    const blocksNow = JSON.stringify(Object.fromEntries(Object.entries(legacy.blocks).map(([k, b]) => [k, [b.x, b.y, b.w, b.h, b.tier, b.cap]])));
    assert.equal(blocksNow, blocksBefore, `blocks unchanged after load ${i}`);
    for (const name of Object.keys(P.lots)) assert.deepEqual(legacy.lots[name].a, P.lots[name].a, `${name}: lot assignments unchanged after load ${i}`);
  }
});
