import './support/ensure-mods-index.mjs';
// Layout stability under growth (design §1.4: "a re-plan keeps the block centre if the new size fits there. Other plots
// never move"; rule: layouts stable, growth visible and permanent). Regression for e2e world.persisted-layout:
// demo-app grew (8 PRs, agentsEver +24), its centred re-plan did not fit beside the square, and the whole block jumped
// ~49 tiles to findSpot's most compact spot. A re-plan now grows in place (the new rect covers the old block) and only
// when hemmed in on an axis takes the free rect nearest its centred rect. Pure, node only, no store, no real sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { placeBlocks } = await import('../web/src/engine/world/sites.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { default: fantasy } = await import('../mods/agentville.fantasy/index.js');

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0), SEED = 7;
const GAP = fantasy.rules.layout.gap, SQUARE = fantasy.rules.layout.square;
const near = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
const covers = (o, i) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
const rect = b => ({ x: b.x, y: b.y, w: b.w, h: b.h });

// The e2e home's shape: demo-app (a boss, leads, workers, two PRs) and a small codex-app beside the square.
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
function build(src, persisted, now = NOW) {
  const { input, serverId } = toWorldInput(makeView(src, { now }), { seed: SEED, salt: 'growth' });
  return buildWorld(input, persisted, { mod: fantasy, now, seed: SEED, serverId });
}
// item id -> [tx, ty] of its lot building (homes and PRs)
const itemsOf = (w, project) => new Map([...w.objects.values()].filter(o => o.project === project && o.data?.item).map(o => [o.data.item, [o.tx, o.ty]]));
const blockOf = (w, project) => rect(w.villages.find(v => v.name === project).block);

test('growth across capacity buckets and tiers re-plans in place: the block covers its old rect, neighbours stay put', () => {
  const P = { v: 1, seed: SEED, blocks: {}, lots: {} };
  // growth = 3·PRs + agentsEver + ⌊log2(MB+1)⌋: tier 0 (<12), 1 (<40), 2 (<200), 3; capacity buckets inside each tier
  const steps = [{ ever: -9 }, { ever: -6, extraAgents: 4 }, {}, { ever: 6, extraAgents: 4 }, { prs: 8, ever: 24 }, { prs: 8, ever: 24, extraAgents: 10 },
    { prs: 40, ever: 80, extraAgents: 14 }, { prs: 40, ever: 80, extraAgents: 24 }];
  let prev = build(payload(steps[0]), P), tiers = new Set([P.blocks['demo-app'].tier]), replans = 0, blockedCentre = 0;
  const codex0 = blockOf(prev, 'codex-app');
  for (const s of steps.slice(1)) {
    const old = blockOf(prev, 'demo-app'), oldItems = itemsOf(prev, 'demo-app');
    const w = build(payload(s), P);
    const now = blockOf(w, 'demo-app');
    tiers.add(P.blocks['demo-app'].tier);
    assert.deepEqual(blockOf(w, 'codex-app'), codex0, 'another project\'s block never moves');
    if (now.w !== old.w || now.h !== old.h) {
      replans++;
      const c = { x: old.x + Math.round((old.w - now.w) / 2), y: old.y + Math.round((old.h - now.h) / 2), w: now.w, h: now.h };
      if (c.x !== now.x || c.y !== now.y) blockedCentre++;   // classic's centred re-plan did not fit here
      if (now.w >= old.w && now.h >= old.h) assert.ok(covers(now, old), `demo-app grew in place: ${JSON.stringify(now)} covers ${JSON.stringify(old)}`);
      else assert.ok(near(now, old, 0), 'a shrinking block stays on its ground');
    } else assert.deepEqual(now, old, 'no re-plan, no move');
    // every building that stood before still stands inside the block (its old tile is in the new block too)
    for (const [id, [x, y]] of oldItems) {
      assert.ok(x >= now.x && y >= now.y && x < now.x + now.w && y < now.y + now.h, `${id}'s old tile (${x},${y}) is inside the grown block`);
      const at = itemsOf(w, 'demo-app').get(id);
      if (at) assert.ok(at[0] >= now.x && at[1] >= now.y && at[0] < now.x + now.w && at[1] < now.y + now.h, `${id} is inside its block`);
    }
    // nothing overlaps (block gap respected)
    for (const v of w.villages) {
      assert.ok(!near(rect(v.block), SQUARE, GAP), `${v.name} keeps the gap round the square`);
      for (const u of w.villages) if (u !== v) assert.ok(!near(rect(v.block), rect(u.block), GAP), `${v.name} and ${u.name} keep the gap`);
    }
    prev = w;
  }
  assert.ok(tiers.size >= 3, `growth crossed tiers (${[...tiers]})`);
  assert.ok(replans >= 3, `growth re-planned several times (${replans})`);
  assert.ok(blockedCentre >= 1, 'at least one re-plan could not keep its centre (the e2e case)');
});

test('the e2e case: the grown block does not relocate (the old findSpot jump was ~49 tiles)', () => {
  const P = { v: 1, seed: SEED, blocks: {}, lots: {} };
  const w0 = build(payload(), P), b0 = blockOf(w0, 'demo-app');
  const w1 = build(payload({ prs: 8, ever: 24 }), P, NOW + 3000), b1 = blockOf(w1, 'demo-app');
  assert.notEqual(P.blocks['demo-app'].tier, undefined);
  assert.ok(b1.w > b0.w, 'it grew');
  assert.ok(covers(b1, b0), 'in place');
  // the block centre moves at most half the growth on each axis
  assert.ok(Math.abs((b1.x + b1.w / 2) - (b0.x + b0.w / 2)) <= (b1.w - b0.w) / 2 + 0.5);
  assert.ok(Math.abs((b1.y + b1.h / 2) - (b0.y + b0.h / 2)) <= (b1.h - b0.h) / 2 + 0.5);
});

// Minimal-move rule, on placeBlocks directly: a block hemmed in on both sides of an axis cannot cover its old rect, so it
// takes the free rect nearest its centred rect (Euclidean on the top-left; ties: most overlap, then y, then x).
test('hemmed in: the re-plan takes the free rect nearest the centred one (minimal move), never findSpot\'s far spot', () => {
  const mk = (x, y, w, h, tier = 1, cap = 12) => ({ x, y, w, h, tier, gt: tier, cap, crowns: 1, acc: 0, seen: NOW });
  // 'mid' sits between 'left' and 'right' with exactly GAP each side; growing wider cannot cover its old rect.
  const P = { blocks: { left: mk(10, 20, 10, 10), mid: mk(22, 20, 10, 10), right: mk(34, 20, 10, 10) }, lots: {} };
  const plan = (w, h) => ({ w, h, plaza: { x: 0, y: 0, w: 2, h: 2 }, lots: [] });
  const v = (name, w, h, tier = 1, cap = 12) => ({ name, tier, gt: tier, cap, crowns: 1, busy: 0, plan: plan(w, h) });
  const out = placeBlocks([v('left', 10, 10), v('mid', 16, 10, 2, 15), v('right', 10, 10)], P, fantasy, { now: NOW });
  const at = Object.fromEntries(out.villages.map(x => [x.name, rect(x.block)]));
  assert.deepEqual(at.left, { x: 10, y: 20, w: 10, h: 10 });
  assert.deepEqual(at.right, { x: 34, y: 20, w: 10, h: 10 });
  // brute force: the nearest free 16x10 rect to the centred one (19, 20)
  const c = { x: 22 + Math.round((10 - 16) / 2), y: 20 }, obs = [SQUARE, at.left, at.right];
  let best = null;
  for (let y = c.y - 40; y <= c.y + 40; y++) for (let x = c.x - 40; x <= c.x + 40; x++) {
    const r = { x, y, w: 16, h: 10 };
    if (obs.some(o => near(r, o, GAP))) continue;
    const d = (x - c.x) ** 2 + (y - c.y) ** 2;
    if (!best || d < best.d) best = { r, d };
  }
  assert.equal((at.mid.x - c.x) ** 2 + (at.mid.y - c.y) ** 2, best.d, `mid took a nearest free rect: ${JSON.stringify(at.mid)}`);
  assert.ok(Math.hypot(at.mid.x - c.x, at.mid.y - c.y) <= 13, 'a minimal move: just past the neighbours');
});

test('layouts saved before this change load without a reshuffle (no `at`, no re-plan: nothing moves; centred re-plans are classic)', () => {
  const P = { v: 1, seed: SEED, blocks: {}, lots: {} };
  build(payload(), P);
  const saved = JSON.parse(JSON.stringify(P));
  for (const L of Object.values(saved.lots)) delete L.at;   // the shape older builds wrote
  const before = JSON.parse(JSON.stringify(saved));
  const w = build(payload(), saved, NOW + 5000);
  for (const [n, b] of Object.entries(before.blocks)) assert.deepEqual(rect(saved.blocks[n]), rect(b), `${n} kept its block`);
  for (const [n, L] of Object.entries(before.lots)) assert.deepEqual(saved.lots[n].a, L.a, `${n} kept every lot`);
  assert.ok(w.villages.length === 2);
  // a classic re-plan whose centred rect fits lands exactly where classic put it
  const mk = (x, y, w, h) => ({ x, y, w, h, tier: 1, gt: 1, cap: 12, crowns: 1, acc: 0, seen: NOW });
  const Q = { blocks: { lone: mk(40, 40, 10, 10) }, lots: {} };
  const out = placeBlocks([{ name: 'lone', tier: 2, gt: 2, cap: 15, crowns: 1, busy: 0, plan: { w: 15, h: 13, plaza: { x: 0, y: 0, w: 2, h: 2 }, lots: [] } }], Q, fantasy, { now: NOW });
  assert.deepEqual(rect(out.villages[0].block), { x: 40 + Math.round(-5 / 2), y: 40 + Math.round(-3 / 2), w: 15, h: 13 });
});

test('a re-plan deals each standing item the free lot of its rank nearest where it stood', () => {
  // M6 nested growth: a re-plan that nests the old plan keeps every lot (same ids, same tiles), so the carry-over by `at`
  // only matters for a plan that does not nest (a layout saved before M6: no `nest`); `nest` off runs that path.
  const run = (keepAt, nest = false) => {
    const P = { v: 1, seed: SEED, blocks: {}, lots: {} };
    const w0 = build(payload(), P), a = itemsOf(w0, 'demo-app');
    if (!keepAt) for (const L of Object.values(P.lots)) delete L.at;
    if (!nest) { for (const L of Object.values(P.lots)) delete L.nest; for (const B of Object.values(P.blocks)) delete B.nest; }
    const w1 = build(payload({ prs: 8, ever: 24 }), P, NOW + 3000), b = itemsOf(w1, 'demo-app');
    let sum = 0, n = 0;
    for (const [id, [x, y]] of a) { const q = b.get(id); if (q) { sum += Math.hypot(q[0] - x, q[1] - y); n++; } }
    return { mean: sum / n, n, P };
  };
  const carried = run(true), fresh = run(false), nested = run(true, true);
  assert.ok(carried.n >= 8);
  assert.ok(carried.mean < fresh.mean, `homes move less with the carry-over (${carried.mean.toFixed(1)} < ${fresh.mean.toFixed(1)} tiles)`);
  assert.ok(nested.n >= carried.n && nested.mean <= carried.mean, `nested growth moves homes no more (${nested.mean.toFixed(1)} <= ${carried.mean.toFixed(1)} tiles)`);
  // `at` is persisted for every assigned item, in absolute tiles inside the block
  const L = carried.P.lots['demo-app'], b = carried.P.blocks['demo-app'];
  assert.deepEqual(Object.keys(L.at).sort(), Object.keys(L.a).sort());
  for (const [x, y] of Object.values(L.at)) assert.ok(x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h);
});
