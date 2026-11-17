// Classic world.js: a saved pre-nesting layout (fixture captured with main's world.js, no `chain`) is left
// exactly as it is on load and across polls; a later tier-up only shifts the whole block uniformly and
// keeps every lot assignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.location = { search: '', href: 'http://x/' };
globalThis.window = globalThis;
const mem = {};
globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const W = await import('../web/src/world.js');
const fx = JSON.parse(readFileSync(new URL('./fixtures/classic-layout-pre-nest.json', import.meta.url), 'utf8'));

const mk = (id, role = 'worker') => ({ id, project: 'demo', role, bucket: 'active', status: 'working', prs: [] });
const agents = [mk('a', 'boss'), mk('b', 'lead'), mk('c'), mk('d')];
const byId = new Map(agents.map(a => [a.id, a]));
const projects = extra => [{ name: 'demo', prs: [{ id: '1', live: true }, { id: '2', live: false }], agentsEver: 6 + extra, transcriptBytes: 3e6 }];
const run = (extra = 0) => { const P = W.plan(agents, byId, projects(extra)); return { P, L: W.layout(P, 1000) }; };
const tiles = L => L.items.map(i => [i.id, i.x, i.y, i.w, i.h]);
const KEY = 'va.world9';

test('a saved pre-nesting layout is unchanged on load and after polls', () => {
  localStorage.setItem(KEY, JSON.stringify(fx.S));
  for (let i = 0; i < 4; i++) {
    const { L } = run();
    assert.deepEqual(tiles(L), fx.items);
  }
  const S = JSON.parse(localStorage.getItem(KEY));
  assert.deepEqual({ ...S.blocks.demo, chain: undefined }, { ...fx.S.blocks.demo, chain: undefined, seen: S.blocks.demo.seen });
  assert.deepEqual(S.lots.demo.a, fx.S.lots.demo.a);
});

test('a tier-up after that keeps every lot and shifts the block as one', () => {
  localStorage.setItem(KEY, JSON.stringify(fx.S));
  run();
  const before = run().L, b0 = { ...JSON.parse(localStorage.getItem(KEY)).blocks.demo };
  const { P, L } = run(60);
  assert.ok(P.villages[0].tier > b0.tier, 'tier rose');
  const S = JSON.parse(localStorage.getItem(KEY));
  for (const [id, lot] of Object.entries(fx.S.lots.demo.a)) assert.ok(S.lots.demo.a[id], `${id} kept an assignment`);
  const now = new Map(tiles(L).map(t => [t[0], t]));
  const shifts = new Set();
  for (const [id, x, y] of tiles(before)) if (now.has(id)) shifts.add(`${now.get(id)[1] - x},${now.get(id)[2] - y}`);
  assert.equal(shifts.size, 1, `one shared shift, got ${[...shifts]}`);
});
