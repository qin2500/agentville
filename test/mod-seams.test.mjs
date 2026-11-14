import './support/ensure-mods-index.mjs';
// village-mods.md §6.1 items 3-7: engine-wide seams. Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { LAYOUT_GROUND } = await import('../web/src/engine/core/grid.js');
const { loadWorld, saveWorld, emptyWorld } = await import('../web/src/engine/world/persist.js');
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { listFiles, fakeStore, ROOT, NOW } = await import('./mod-support/views.mjs');

test('§6.1.3/4 no file under web/src/engine/** imports city-plan.js or styles-pool.js', () => {
  const files = listFiles(path.join(ROOT, 'web/src/engine'));
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map(m => m[1] || m[2] || m[3]);
    for (const s of specs) assert.ok(!/(^|\/)(city-plan|styles-pool)(\.js)?$/.test(s), `${path.relative(ROOT, f)} imports ${s}`);
  }
});

test('§6.1.4 engine-reserved ground codes are all within 200..255 and distinct', () => {
  const codes = Object.values(LAYOUT_GROUND);
  assert.ok(codes.length >= 4);
  for (const c of codes) assert.ok(Number.isInteger(c) && c >= 200 && c <= 255, `LAYOUT_GROUND code ${c}`);
  assert.equal(new Set(codes).size, codes.length);
});

const persisted = { v: 1, seed: 11, blocks: { a: { x: 1, y: 2, w: 3, h: 4 } }, lots: { a: { tier: 1, cap: 2, a: {}, h: {} } } };
const keysWritten = s => s.writes.filter(k => !/seed/.test(k));

test('§3.4/§6.1.6 per-mod key: non-fantasy mod writes va.engine2.world.<modId> and never classic keys', () => {
  const mod = { id: 'x.y' };
  const s = fakeStore();
  saveWorld(s, persisted, { mod });
  assert.deepEqual(keysWritten(s), ['va.engine2.world.x.y']);
  const back = loadWorld(s, { mod, now: NOW });
  assert.deepEqual(back.blocks, persisted.blocks);
  assert.ok(![...s.writes, ...s.reads].some(k => /^va\.world[89]/.test(k)), 'touched a classic key');
});

test('§6.1.6 fantasy keeps va.engine2.world as the alias', () => {
  const mod = resolveMod('agentville.fantasy');   // its PersistDecl names the legacy keys (MOD-4e)
  const s = fakeStore();
  saveWorld(s, persisted, { mod });
  assert.deepEqual(keysWritten(s), ['va.engine2.world']);
  assert.deepEqual(loadWorld(s, { mod, now: NOW }).blocks, persisted.blocks);
});

test('§6.1.6 classic import (va.world9/8) only for agentville.fantasy', () => {
  const classic = { blocks: { old: { x: 0, y: 0, w: 5, h: 5 } }, lots: {} };
  const seed = () => fakeStore({ 'va.world9': classic });
  const f = seed();
  const wf = loadWorld(f, { mod: resolveMod('agentville.fantasy'), now: NOW });
  assert.ok(wf.blocks.old, 'fantasy imports classic');
  assert.ok(f.reads.includes('va.world9'));
  assert.ok(!f.writes.some(k => /^va\.world[89]/.test(k)), 'never writes a classic key');
  const o = seed();
  const wo = loadWorld(o, { mod: { id: 'x.y' }, now: NOW });
  assert.deepEqual(wo.blocks, {}, 'other mod starts empty');
  assert.ok(!o.reads.some(k => /^va\.world[89]/.test(k)), 'other mod never reads classic keys');
});

test('§3.4 each mod keeps its own layout: switching worlds and back never reshuffles', () => {
  const s = fakeStore();
  const A = resolveMod('agentville.fantasy'), B = resolveMod('agentville.base');
  saveWorld(s, persisted, { mod: A });
  saveWorld(s, { ...persisted, blocks: { b: { x: 9, y: 9, w: 1, h: 1 } } }, { mod: B });
  assert.ok(loadWorld(s, { mod: A, now: NOW }).blocks.a);
  assert.ok(loadWorld(s, { mod: B, now: NOW }).blocks.b);
  assert.ok(!loadWorld(s, { mod: B, now: NOW }).blocks.a);
});

test('§6.1.6 demo worlds are per mod too and stay off the live key', () => {
  const s = fakeStore();
  saveWorld(s, persisted, { mod: { id: 'x.y' }, demo: true });
  assert.ok(keysWritten(s).every(k => k.includes('x.y') && k.includes('demo')), keysWritten(s).join());
  assert.ok(emptyWorld(1));
});

// ---- "the API is not fantasy-shaped": the same small WorldInput builds a sound world with BOTH bundled mods ----
const agent = (id, project, role, parentId, bucket = 'building', prs = []) => ({ id, name: id, project, role, parentId, bucket, severity: null, live: bucket !== 'resting', lastActivityAt: NOW - 60_000, since: NOW - 1e7, prs });
const smallInput = () => {
  const agents = [
    agent('a-boss', 'alpha', 'boss', undefined, 'waiting'), agent('a-lead', 'alpha', 'lead', 'a-boss', 'building', [{ id: '11' }]),
    agent('a-sub', 'alpha', 'sub', 'a-lead'), agent('a-rest', 'alpha', undefined, undefined, 'resting'),
    agent('b-one', 'beta', undefined, undefined), agent('b-two', 'beta', undefined, undefined, 'resting', [{ id: '21' }]),
    agent('c-one', 'gamma', 'lead', undefined),
  ];
  const projects = [{ name: 'alpha', prs: [{ id: '11', live: true }, { id: '12', live: false }], transcriptBytes: 2e6, agentsEver: 8 },
    { name: 'beta', prs: [{ id: '21', live: false }], transcriptBytes: 1e5, agentsEver: 3 }, { name: 'gamma', prs: [], transcriptBytes: 0, agentsEver: 1 }];
  const view = makeView({ agents, projects, dock: { loading: [], sailed: [], total: 1, level: 1 } }, { now: NOW, demo: true });
  return toWorldInput(view, { seed: 7, salt: 'seams' }).input;
};

for (const id of ['agentville.fantasy', 'agentville.base']) {
  test(`buildWorld accepts { mod } and builds a sound world with ${id}`, () => {
    const mod = resolveMod(id);
    const w = buildWorld(smallInput(), { v: 1, seed: 7, blocks: {}, lots: {} }, { mod, now: NOW, seed: 7 });
    assert.ok(w && w.grid && w.objects, 'world built');
    const g = w.grid;
    const seen = new Map();
    const tiles = o => { const t = []; for (let y = o.ty; y < o.ty + o.h; y++) for (let x = o.tx; x < o.tx + o.w; x++) t.push([x, y]); return t; };
    for (const o of w.objects.values()) {
      if (o.walk !== 'block') continue;
      for (const [x, y] of tiles(o)) { const k = `${x},${y}`; assert.ok(!seen.has(k), `${o.id} overlaps ${seen.get(k)} at ${k}`); seen.set(k, o.id); }
    }
    for (const o of w.objects.values()) {
      if (o.kind !== 'building' || !o.door) continue;
      const { tx, ty } = o.door;
      assert.ok(g.inBounds(tx, ty) && g.get('cost', tx, ty) < 255 && g.get('occ', tx, ty) === 0, `${o.id}: door ${tx},${ty} not walkable`);
    }
  });
}

// review M1 B1: building heights are the flat { z } of api.js, for every mod (base's box is z 24, not the 40 fallback)
test('building height comes from mod.objects.buildings[look].z (flat contract)', () => {
  const mod = resolveMod('agentville.base');
  const w = buildWorld(smallInput(), { v: 1, seed: 7, blocks: {}, lots: {} }, { mod, now: NOW, seed: 7 });
  const boxes = [...w.objects.values()].filter(o => o.kind === 'building' && o.model === 'box');
  assert.ok(boxes.length > 0, 'base built boxes');
  for (const o of boxes) assert.equal(o.z, 24, o.id);
  const fantasy = resolveMod('agentville.fantasy');
  assert.equal(fantasy.objects.buildings.palace.z, 58);
});
