// Classic world.js: when the ±120 × ±90 search window is full, findSpot widens deterministically
// instead of crashing on a null best.
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.location = { search: '', href: 'http://x/' };
globalThis.window = globalThis;
const mem = {};
globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const W = await import('../web/src/world.js');

const build = n => {
  const agents = [], projects = [];
  for (let i = 0; i < n; i++) {
    const name = `proj${String(i).padStart(3, '0')}`;
    agents.push({ id: `b${i}`, project: name, role: 'boss', bucket: 'active', status: 'working', prs: [] });
    projects.push({ name, prs: Array.from({ length: 12 }, (_, k) => ({ id: String(k), live: k < 6 })), agentsEver: 60, transcriptBytes: 9e7 });
  }
  return { agents, byId: new Map(agents.map(a => [a.id, a])), projects };
};
const run = n => { const { agents, byId, projects } = build(n); return W.layout(W.plan(agents, byId, projects), 1000); };

test('a full search window still yields a spot for every plot, deterministically', () => {
  for (const k of Object.keys(mem)) delete mem[k];
  const a = run(90);
  for (const k of Object.keys(mem)) delete mem[k];
  const b = run(90);
  const boxes = Object.values(JSON.parse(Object.values(mem)[0] ?? '{"blocks":{}}').blocks);
  assert.equal(boxes.length, 90);
  for (const r of boxes) assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
  assert.deepEqual(a.items.map(i => [i.id, i.x, i.y]), b.items.map(i => [i.id, i.x, i.y]));
});
