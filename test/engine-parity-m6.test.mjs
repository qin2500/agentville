import './support/ensure-mods-index.mjs';
// M6 parity proofs (classic world.js / iso.js / panel.js behaviour on the engine v2 fantasy mod): neighbourhood accents,
// per-project styles and ?citystyle, crown palaces, looks stable by first-seen order, boss look and crown, subs in ninja
// looks. Pure node, real engine code, no browser. Each title carries its parity id in brackets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { makeView } = await import('../web/src/engine/snapshot.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { RULES, HOOKS } = await import('../mods/agentville.fantasy/rules.js');
const { lookOf } = await import('../mods/agentville.fantasy/art/looks.js');
const { projectStyle } = await import('../mods/agentville.fantasy/style.js');
const { default: fantasy, ACTORS } = await import('../mods/agentville.fantasy/index.js');
const { createSeenOrder, lookOf: sheetLookOf } = await import('../web/src/engine/render/actor-art.js');
const { hash } = await import('../web/src/engine/core/rng.js');

const NOW = 1e12;
const agent = (id, project, role = 'worker', extra = {}) => ({ id, name: id, project, role, bucket: 'working', live: true, prs: [], ...extra });
function world(agents, { forcedStyle = null, seed = 7 } = {}) {
  const view = makeView({ agents, projects: [] }, { now: NOW, demo: true }), per = { v: 1, seed, blocks: {}, lots: {} };
  const { input, serverId } = toWorldInput(view, { seed });
  return buildWorld(input, per, { serverId, mod: resolveMod('agentville.fantasy'), now: NOW, seed, forcedStyle });
}
const PROJECTS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const crowded = () => PROJECTS.flatMap(p => [agent(`${p}-boss`, p, 'boss'), agent(`${p}-w`, p)]);
const near = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// parity: style.neighbourhood-accent (sites.js placeBlocks: a new block takes the least-used accent not worn by a block near it)
test('[style.neighbourhood-accent] every neighbourhood has a palette accent and neighbours never share one', () => {
  const w = world(crowded());
  const { accents, gap } = RULES.layout;
  assert.ok(new Set(accents).size >= 6, 'the palette has distinct colours');
  let pairs = 0;
  for (const v of w.villages) assert.equal(v.accent, accents[v.block.acc % accents.length]);
  for (let i = 0; i < w.villages.length; i++) for (let j = i + 1; j < w.villages.length; j++) {
    const a = w.villages[i], b = w.villages[j];
    if (!near(a.block, b.block, gap + 4)) continue;
    pairs++;
    assert.notEqual(a.accent, b.accent, `${a.name} and ${b.name} are neighbours`);
  }
  assert.ok(pairs >= 3, `only ${pairs} neighbour pairs were checked`);
  assert.equal(new Set(w.villages.map(v => v.accent)).size, Math.min(w.villages.length, accents.length), 'colours are spread before any repeats');
});

// parity: style.city4-per-project-styles (rules hook style + forcedStyle from ?citystyle)
test('[style.city4-per-project-styles] each project gets its own stable style; ?citystyle=N forces family N for all', () => {
  const free = world(crowded());
  const again = world(crowded());
  assert.deepEqual(free.villages.map(v => v.style.key), again.villages.map(v => v.style.key), 'stable per project');
  assert.ok(new Set(free.villages.map(v => v.style.family)).size >= 3, 'projects do not all look alike');
  assert.equal(new Set(free.villages.map(v => v.style.key)).size, free.villages.length, 'every project has its own style key');
  for (const n of [0, 3, 5]) for (const v of world(crowded(), { forcedStyle: n }).villages) assert.equal(v.style.family, n, `forced ${n}: ${v.name}`);
  const ctx = { hash, time: { now: NOW }, forcedTier: null, forcedStyle: 8 };
  assert.equal(HOOKS.style('alpha', ctx).family, 2, '?citystyle wraps modulo 6');
  assert.equal(HOOKS.style('alpha', { ...ctx, forcedStyle: -1 }).family, 5);
});

// parity: style.crown-palaces (build.js: an L lot of a crowned agent gets crown + mod.rules.crownModel)
test('[style.crown-palaces] a boss\'s large lot is the crown palace; without a boss there is none', () => {
  assert.equal(RULES.crownModel, 'palace');
  const w = world([...crowded(), agent('solo-w1', 'solo'), agent('solo-w2', 'solo')]);
  const crowns = [...w.objects.values()].filter(o => o.crown);
  assert.equal(crowns.length, PROJECTS.length, 'one palace per boss project');
  for (const o of crowns) {
    assert.equal(o.rank, 'L'); assert.equal(o.model, 'palace');
    assert.equal(o.data.agentId, `${o.project}-boss`, 'it houses the boss');
  }
  assert.ok(![...w.objects.values()].some(o => o.project === 'solo' && (o.crown || o.model === 'palace')), 'a project with no boss has no palace');
  assert.ok([...w.objects.values()].filter(o => o.kind === 'building' && !o.crown).every(o => o.model !== 'palace'), 'only crowned lots are palaces');
  // the crown follows the boss: demote the boss and the palace goes
  const demoted = world(crowded().map(a => (a.id === 'alpha-boss' ? { ...a, role: 'worker' } : a)));
  assert.ok(![...demoted.objects.values()].some(o => o.project === 'alpha' && o.crown));
  assert.ok([...demoted.objects.values()].some(o => o.project === 'beta' && o.crown));
});

// parity: vil.looks-stable-by-first-seen (looks.js: a look is a function of the first-seen ordinal, never of the id or arrival time)
test('[vil.looks-stable-by-first-seen] a person keeps their look by first-seen ordinal, across reloads and later arrivals', () => {
  const style = projectStyle('proj-a', { tier: 1 }, undefined);
  const view = (id, seen) => ({ id, kind: 'agent', role: 'worker', parent: null, crown: false, important: false, project: 'p', status: 'working', species: null, seed: null, seen });
  const ctx = { hash, api: { version: 1 } };
  const store = new Map(), st = { get: (k, d) => (store.has(k) ? JSON.parse(store.get(k)) : d), set: (k, v) => store.set(k, JSON.stringify(v)) };
  const s1 = createSeenOrder({ store: st });
  s1.note(['a', 'b', 'c']);
  const before = ['a', 'b', 'c'].map(id => lookOf(view(id, s1.of(id)), style, ctx));
  s1.note(['d', 'e']);                                          // later arrivals never shift earlier looks
  const s2 = createSeenOrder({ store: st });                    // a reload
  assert.deepEqual(['a', 'b', 'c'].map(id => s2.of(id)), [0, 1, 2]);
  assert.deepEqual(['a', 'b', 'c'].map(id => lookOf(view(id, s2.of(id)), style, ctx)), before);
  assert.notDeepEqual(before[0], before[1]);
  // the look depends on the ordinal, not the id
  assert.deepEqual(lookOf(view('zzz', 1), style, ctx), lookOf(view('b', 1), style, ctx));
  // the sheet fallback walks the classic LOOKS list in first-seen order
  const fb = ACTORS.fallback;
  assert.deepEqual([0, 1, 2].map(n => sheetLookOf({ kind: 'agent', id: `x${n}`, input: { role: 'worker' } }, fb, n)), fb.looks.slice(0, 3));
  assert.equal(sheetLookOf({ kind: 'agent', id: 'q', input: { role: 'worker' } }, fb, fb.looks.length), fb.looks[0], 'wraps');
});

// parity: vil.boss-look-and-crown (looks.js bossLook: robe + crown + accent cape; sheet fallback: the boss sheet)
test('[vil.boss-look-and-crown] the boss wears a crown and the settlement accent; the sheet fallback shows the boss sheet', () => {
  const style = projectStyle('proj-b', { tier: 2 }, undefined);
  const ctx = { hash, api: { version: 1 } };
  const v = o => ({ id: 'b1', kind: 'agent', role: 'boss', parent: null, crown: false, important: false, project: 'p', status: 'working', species: null, seed: null, seen: 4, ...o });
  const boss = lookOf(v(), style, ctx), worker = lookOf(v({ role: 'worker', id: 'w1' }), style, ctx);
  assert.ok(boss.extras.includes('crown')); assert.equal(boss.palette.cape, style.accent);
  assert.ok(!worker.extras.includes('crown'));
  assert.ok(lookOf(v({ role: 'worker', crown: true }), style, ctx).extras.includes('crown'), 'the crown flag alone crowns');
  assert.notEqual(boss.palette.cloth, worker.palette.cloth, 'a boss looks unlike a worker');
  const other = lookOf(v(), projectStyle('proj-c', { tier: 2 }, undefined), ctx);
  if (projectStyle('proj-c', { tier: 2 }).accent !== style.accent) assert.notEqual(other.palette.cape, boss.palette.cape, 'cape follows the project accent');
  const fb = ACTORS.fallback;
  assert.equal(sheetLookOf({ kind: 'agent', id: 'b1', input: { role: 'boss' } }, fb, 3), fb.boss);
  assert.equal(sheetLookOf({ kind: 'agent', id: 'w9', input: { crown: true } }, fb, 3), fb.boss);
  assert.ok(!fb.looks.includes(fb.boss));
});

// parity: vil.subs-ninja-looks (looks.js subLook: hooded ninja garb coloured by the parent; sheet fallback: ninja sheets by parent)
test('[vil.subs-ninja-looks] subs are ninjas coloured by their parent, not by their own order', () => {
  const style = projectStyle('proj-d', { tier: 1 }, undefined);
  const ctx = { hash, api: { version: 1 } };
  const sub = (id, parent, seen) => ({ id, kind: 'agent', role: 'sub', parent, crown: false, important: false, project: 'p', status: 'working', species: null, seed: null, seen });
  const a = lookOf(sub('s1', 'boss-1', 1), style, ctx), b = lookOf(sub('s2', 'boss-1', 9), style, ctx);
  assert.ok(a.extras.includes('ninja'));
  assert.equal(a.palette.hat, b.palette.hat, 'siblings share a colour');
  assert.equal(a.palette.cloth, b.palette.cloth);
  assert.ok(new Set(Array.from({ length: 16 }, (_, i) => lookOf(sub('x', `parent-${i}`, 0), style, ctx).palette.hat)).size >= 4, 'different parents, different colours');
  const worker = lookOf({ ...sub('w', null, 2), role: 'worker' }, style, ctx);
  assert.ok(!worker.extras.includes('ninja'));
  const fb = ACTORS.fallback;
  assert.ok(fb.subs.length >= 4 && fb.subs.every(n => /^Ninja/.test(n)));
  const s = n => sheetLookOf({ kind: 'agent', id: `s${n}`, parent: 'boss-1', input: { role: 'sub' } }, fb, n);
  assert.ok(fb.subs.includes(s(0)));
  assert.equal(s(0), s(5), 'same parent, same ninja whatever the ordinal');
  assert.equal(fb.subs.indexOf(s(0)), Math.abs(hash('boss-1') | 0) % fb.subs.length);
});
