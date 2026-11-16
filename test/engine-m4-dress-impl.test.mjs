// Engine v2 M4 P4: town dressing (accent.js, flag.js, effects.js) against a recording fake gfx.
import test from 'node:test';
import assert from 'node:assert/strict';
import { distinctAccents, accentEdges, drawAccentEdges, ridgeFlags, flagSprite, DEFAULT_PALETTE } from '../web/src/engine/render/accent.js';
import { createEffects, actorOffset, CAPS } from '../web/src/engine/render/effects.js';
import * as flagArt from '../web/src/engine/art/props/flag.js';
import { toScreen } from '../web/src/engine/core/coords.js';

const fakeGfx = () => { const calls = []; return { calls, rect: (...a) => calls.push(['rect', ...a]), poly: (...a) => calls.push(['poly', ...a]), image: (...a) => calls.push(['image', ...a]) }; };
const view = { rect: [-2000, -2000, 2000, 2000], zoom: 2, mode: 'town' };

// a 5x3 grid of blocks, 20 tiles each, 2 tiles apart
const grid = () => { const b = []; for (let j = 0; j < 3; j++) for (let i = 0; i < 5; i++) b.push({ project: `p${j}${i}`, x: i * 22, y: j * 22, w: 20, h: 20 }); return b; };
const adj = (a, b) => Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h), 0) <= 6;

test('[style.plot-accent-edge] adjacent blocks never share an accent', () => {
  const bs = grid(), m = distinctAccents(bs);
  for (const a of bs) for (const b of bs) if (a !== b && adj(a, b)) assert.notEqual(m.get(a.project), m.get(b.project), `${a.project} vs ${b.project}`);
});

test('[style.plot-accent-edge] accents are stable across reorderings', () => {
  const bs = grid(), base = distinctAccents(bs);
  for (const shuffled of [[...bs].reverse(), [...bs].sort((a, b) => ((a.x * 7 + a.y) % 5) - ((b.x * 7 + b.y) % 5))]) {
    const m = distinctAccents(shuffled);
    for (const [k, v] of base) assert.equal(m.get(k), v);
  }
});

test('[style.plot-accent-edge] edge strips: 4 per block, in the block accent', () => {
  const world = { villages: [{ name: 'a', block: { x: 0, y: 0, w: 10, h: 8 }, accent: '#e4572e' }, { name: 'b', block: { x: 12, y: 0, w: 10, h: 8 } }] };
  const edges = accentEdges(world);
  assert.equal(edges.length, 2);
  assert.notEqual(edges[0].accent, edges[1].accent);
  assert.deepEqual(edges[0].pts.slice(0, 2), [toScreen(0, 0).sx, toScreen(0, 0).sy]);
  const g = fakeGfx(); drawAccentEdges(g, edges, view);
  assert.equal(g.calls.filter(c => c[0] === 'poly').length, 8);
});

test('[style.flags-on-ridges] flags sit on the ridge anchor, in the village accent, and wave over frames', () => {
  const o = { id: 'h1', kind: 'building', tx: 4, ty: 6, project: 'a', data: { agentId: 'x' } };
  const entry = { pivot: { x: 20, y: 30 }, anchors: { ridge: { x: 25, y: 12 } } };
  const flags = ridgeFlags([o, { id: 't', kind: 'tree', tx: 0, ty: 0 }], () => entry, new Map([['a', '#2e86de']]));
  assert.equal(flags.length, 1);
  const n = toScreen(4, 6);
  assert.equal(flags[0].x, n.sx + 5); assert.equal(flags[0].y, n.sy - 18); assert.equal(flags[0].accent, '#2e86de');
  assert.equal(ridgeFlags([o], () => null).length, 0);
  const a = flagArt.pixels('#2e86de', 0).data, b = flagArt.pixels('#2e86de', 2).data;
  assert.notDeepEqual([...a], [...b]);
  assert.equal(flagSprite('#2e86de', 1), flagSprite('#2e86de', 5));
  let blue = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i + 3] && a[i + 2] > a[i]) blue++;
  assert.ok(blue > 10);
});

test('[style.banners-on-plazas] every village gets an accent a banner style can carry', () => {
  const world = { villages: [{ name: 'a', block: { x: 0, y: 0, w: 10, h: 8 } }, { name: 'b', block: { x: 12, y: 0, w: 10, h: 8 } }] };
  const acc = createEffects({ world }).accents;
  assert.equal(acc.size, 2);
  for (const [, v] of acc) assert.match(v, /^#[0-9a-f]{6}$/i);
  assert.ok(DEFAULT_PALETTE.length >= 8);
});

// ---- effects
const homes = n => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, kind: 'building', model: 'cottage', tx: i * 4, ty: 0, w: 2, h: 2, z: 30, project: 'a' }));
const worldOf = (objs, extra = {}) => ({ objects: new Map(objs.map(o => [o.id, o])), villages: [{ name: 'a', block: { x: 0, y: 0, w: 60, h: 10 } }], layoutData: {}, ...extra });
const actorsFor = (n, over = {}) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, home: `h${i}`, x: i * 4, y: 2, anim: 'idle', input: { bucket: 'resting' }, ...over }));
const run = (world, frame, gv = view) => { const g = fakeGfx(); createEffects({ world }).draw(g, { z: gv.zoom }, gv, frame); return g.calls; };
const puffs = calls => calls.filter(c => c[0] === 'rect' && /rgba\(238,236,246/.test(c[5]));

test('[bld.smoke-puff-cap] never more than 6 puffs, however many homes', () => {
  const w = worldOf(homes(40));
  assert.equal(CAPS.puffs, 6);
  for (const t of [0, 1.3, 5.7, 11, 33]) assert.ok(puffs(run(w, { t, night: 0, actors: actorsFor(40) })).length <= 6);
  assert.ok(puffs(run(w, { t: 2, night: 0, actors: actorsFor(40) })).length > 0);
});

test('[bld.chimney-smoke-sources] hammering and resting homes smoke, and only in view', () => {
  const w = worldOf(homes(3));
  assert.ok(puffs(run(w, { t: 3, night: 0, actors: [{ id: 'a0', home: 'h0', x: 0, y: 2, anim: 'hammer', input: { bucket: 'working' } }] })).length >= 1);
  assert.ok(puffs(run(w, { t: 3, night: 0, actors: actorsFor(1) })).length >= 1);
  assert.equal(puffs(run(w, { t: 3, night: 0, actors: actorsFor(1) }, { rect: [5000, 5000, 5100, 5100], zoom: 2 })).length, 0);
});

test('[bld.zzz-resting-homes-night] zZ only at night and only over resting homes', () => {
  const w = worldOf(homes(2)), z = c => c.filter(x => x[0] === 'rect' && /rgba\(225,232,255/.test(x[5])).length;
  assert.ok(z(run(w, { t: 1, night: 1, actors: actorsFor(2) })) > 0);
  assert.equal(z(run(w, { t: 1, night: 0, actors: actorsFor(2) })), 0);
  assert.equal(z(run(w, { t: 1, night: 1, actors: actorsFor(2, { input: { bucket: 'working' } }) })), 0);
});

test('[amb.fountain-sparkle] a fountain twinkles; none without one', () => {
  const f = [{ id: 'f', kind: 'prop', model: 'fountain', tx: 3, ty: 3, w: 2, h: 2, z: 24 }];
  const sp = c => c.filter(x => x[0] === 'rect' && /rgba\(220,248,255/.test(x[5])).length;
  let seen = 0; for (let t = 0; t < 6; t += 0.25) seen += sp(run(worldOf(f), { t, actors: [] }));
  assert.ok(seen > 0);
  assert.equal(sp(run(worldOf([]), { t: 1, actors: [] })), 0);
});

test('[amb.bird-v-every-40s] a V crosses during the first seconds of each 40 s cycle, never in between', () => {
  const w = worldOf([]), bird = c => c.filter(x => x[0] === 'rect' && x[5] === '#3a2f52').length;
  assert.ok(bird(run(w, { t: 5, actors: [] })) >= 7);
  assert.equal(bird(run(w, { t: 25, actors: [] })), 0);
  assert.ok(bird(run(w, { t: 45, actors: [] })) >= 7);
  assert.equal(bird(run(w, { t: 70, actors: [] })), 0);
});

test('[amb.falling-leaves] leaves fall near trees and are capped', () => {
  const trees = Array.from({ length: 400 }, (_, i) => ({ id: `tree:${i}`, kind: 'tree', model: 'tree', tx: i % 20, ty: (i / 20) | 0, w: 1, h: 1, z: 30 }));
  const leaf = c => c.filter(x => x[0] === 'rect' && x[3] === 2 && x[4] === 1 && ['#d9a23c', '#c4642c', '#8fb84a'].includes(x[5])).length;
  let max = 0, any = 0; for (let t = 0; t < 14; t += 1) { const n = leaf(run(worldOf(trees), { t, actors: [] })); max = Math.max(max, n); any += n; }
  assert.ok(any > 0 && max <= CAPS.leaves);
});

test('[world.wave-glints] glints come from layoutData.waves, culled to the view and capped', () => {
  const waves = Array.from({ length: 3000 }, (_, i) => [i % 60, (i / 60) | 0]);
  const w = worldOf([], { layoutData: { waves } });
  const gl = c => c.filter(x => x[0] === 'rect' && /rgba\((235,248,255|200,230,250)/.test(x[5])).length;
  let any = 0; for (let t = 0; t < 4; t += 0.5) { const n = gl(run(w, { t, actors: [] })); any += n; assert.ok(n <= CAPS.glints); }
  assert.ok(any > 0);
  assert.equal(gl(run(w, { t: 1, actors: [] }, { rect: [9e4, 9e4, 9e4 + 10, 9e4 + 10], zoom: 2 })), 0);
  assert.equal(gl(run(w, { t: 1, actors: [] }, { ...view, zoom: 0.2, mode: 'map' })), 0);
});

test('[vil.pose-hammer-sparks-badge] a hammering villager throws sparks', () => {
  const w = worldOf(homes(1)), sk = c => c.filter(x => x[0] === 'rect' && x[3] === 1 && x[4] === 1 && (x[5] === '#ffe07a' || x[5] === '#ff9a3c')).length;
  let any = 0; for (let t = 0; t < 2; t += 0.1) any += sk(run(w, { t, actors: [{ id: 'a0', home: 'h0', x: 0, y: 2, anim: 'hammer' }] }));
  assert.ok(any > 0);
  assert.equal(sk(run(w, { t: 0.1, actors: actorsFor(1) })), 0);
});

test('[vil.stalled-bob] only stalled actors bob, within 2 px, by t', () => {
  const st = { id: 's', input: { bucket: 'stalled' } };
  const ys = new Set(); for (let t = 0; t < 3; t += 0.05) { const o = actorOffset(st, t); assert.equal(o.dx, 0); assert.ok(o.dy <= 0 && o.dy >= -2); ys.add(o.dy); }
  assert.ok(ys.size > 1);
  assert.deepEqual(actorOffset({ id: 'w', input: { bucket: 'working' } }, 1), { dx: 0, dy: 0 });
  assert.deepEqual(actorOffset(st, 1.7), actorOffset(st, 1.7));
});

test('effects are deterministic from t and use no Math.random', () => {
  const orig = Math.random; Math.random = () => { throw new Error('random'); };
  try {
    const trees = Array.from({ length: 50 }, (_, i) => ({ id: `tree:${i}`, kind: 'tree', model: 'tree', tx: i, ty: 0, w: 1, h: 1, z: 30 }));
    const w = worldOf([...homes(5), ...trees], { layoutData: { waves: [[1, 1], [2, 2]] } });
    const fr = { t: 7.3, night: 1, actors: actorsFor(5) };
    assert.deepEqual(run(w, fr), run(w, fr));
    assert.notDeepEqual(run(w, fr), run(w, { ...fr, t: 8.9 }));
  } finally { Math.random = orig; }
});
