import './support/ensure-mods-index.mjs';
// M4 spec tests for render/accent.js, art/props/flag.js and render/effects.js (plan P4).
// While the modules are missing the tests are todo; once they exist they run for real.
import test from 'node:test';
import assert from 'node:assert/strict';

const load = p => import(p).catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
const [ACC, FLAG, FX] = await Promise.all([load('../web/src/engine/render/accent.js'), load('../web/src/engine/art/props/flag.js'), load('../web/src/engine/render/effects.js')]);
const mk = (m, name) => (title, fn) => test(title, { todo: m ? false : `needs ${name}` }, m ? fn : () => {});
const ta = mk(ACC, 'render/accent.js'), tf = mk(FLAG, 'art/props/flag.js'), tx = mk(FX, 'render/effects.js');

const { buildWorld } = await import('../web/src/engine/world/build.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const fx = loadFixture('citydemo.json');
const skip = fx ? false : 'citydemo.json missing';
function world(seed = 7) {
  const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed, salt: String(seed) });
  return buildWorld(input, { v: 1, seed, blocks: {}, lots: {} }, { now: fx.now, seed, serverId });
}
// Gfx has rect / poly / image only
const recorder = () => {
  const calls = [];
  const g = { rect: (...a) => calls.push(['rect', ...a]), poly: (...a) => calls.push(['poly', ...a]), image: (...a) => calls.push(['image', ...a]) };
  return { g, calls };
};
const PAINT = /^(rect|poly|image)$/;
const { toScreen } = await import('../web/src/engine/core/coords.js');
// draw(g, cam, gview, frame): gview.rect is the visible world-screen rect, frame is { t seconds, night 0..1, actors }
function viewOf(w, z = 2) {
  const b = w.bounds, cs = [[b.ox, b.oy], [b.ox + b.w, b.oy], [b.ox + b.w, b.oy + b.h], [b.ox, b.oy + b.h]].map(([x, y]) => toScreen(x, y));
  const xs = cs.map(p => p.sx), ys = cs.map(p => p.sy);
  return { w: 1000, h: 600, zoom: z, rect: [Math.min(...xs) - 100, Math.min(...ys) - 100, Math.max(...xs) + 100, Math.max(...ys) + 100] };
}
const objectsOf = w => [...(typeof w.objects.values === 'function' ? w.objects.values() : w.objects)];
const hex = c => String(c).toLowerCase();

ta('accent: every village gets an accent edge with points [style.plot-accent-edge]', () => {
  if (skip) return;
  const w = world(), edges = ACC.accentEdges(w);
  assert.ok(edges.length >= 1);
  for (const e of edges) { assert.ok(e.project && e.accent, 'project + accent'); assert.ok(Array.isArray(e.pts) && e.pts.length >= 2, 'a line'); }
  assert.equal(edges.length, new Set(edges.map(e => e.project)).size, 'one edge line per project');
});

ta('accent: neighbouring villages never share an accent colour [style.neighbourhood-accent] [style.plot-accent-edge]', () => {
  if (skip) return;
  const w = world(), edges = ACC.accentEdges(w), by = new Map(edges.map(e => [e.project, hex(e.accent)]));
  const vs = w.villages.filter(v => by.has(v.name));
  const near = (a, b) => Math.hypot((a.cx ?? a.plaza.x) - (b.cx ?? b.plaza.x), (a.cy ?? a.plaza.y) - (b.cy ?? b.plaza.y));
  for (const a of vs) { const nn = vs.filter(b => b !== a).sort((p, q) => near(a, p) - near(a, q)).slice(0, 2); for (const b of nn) assert.notEqual(by.get(a.name), by.get(b.name), `${a.name} vs ${b.name}`); }
});

ta('accent: the same world gives the same accents (stable) [style.plot-accent-edge]', () => {
  if (skip) return;
  assert.deepEqual(ACC.accentEdges(world()), ACC.accentEdges(world()));
});

ta('accent: drawAccentEdges strokes each line and tolerates no edges [style.plot-accent-edge]', () => {
  const { g, calls } = recorder();
  ACC.drawAccentEdges(g, []);
  assert.equal(calls.filter(c => PAINT.test(c[0])).length, 0);
  // pts is a flat [x0,y0,...] diamond (4 corners); one strip per edge
  ACC.drawAccentEdges(g, [{ project: 'p', accent: '#c0392b', pts: [0, 0, 40, 20, 0, 40, -40, 20] }]);
  assert.equal(calls.filter(c => c[0] === 'poly').length, 4, 'a strip on each of the four edges');
  calls.length = 0;
  ACC.drawAccentEdges(g, [{ project: 'p', accent: '#c0392b', pts: [0, 0, 40, 20, 0, 40, -40, 20] }], { rect: [500, 500, 600, 600] });
  assert.equal(calls.length, 0, 'an edge outside the view is skipped');
});

tf('flag: pixels gives a small RGBA flag per accent and frame, in the accent colour [style.flags-on-ridges] [style.banners-on-plazas]', () => {
  const a = FLAG.pixels('#c0392b', 0), b = FLAG.pixels('#c0392b', 1), c = FLAG.pixels('#2980b9', 0);
  assert.ok(a.w > 0 && a.h > 0 && a.w <= 32 && a.h <= 32, 'a small flag');
  assert.equal(a.data.length, a.w * a.h * 4);
  assert.ok(a.ox >= 0 && a.oy <= a.h, 'the staff foot is inside the image');
  assert.equal(b.w, a.w);
  assert.notDeepEqual([...a.data], [...b.data], 'the cloth ripples between frames');
  assert.notDeepEqual([...a.data], [...c.data], 'a different accent is different pixels');
  const has = (d, rgb) => { for (let i = 0; i < d.length; i += 4) if (d[i + 3] && Math.abs(d[i] - rgb[0]) < 4 && Math.abs(d[i + 1] - rgb[1]) < 4 && Math.abs(d[i + 2] - rgb[2]) < 4) return true; return false; };
  assert.ok(has(a.data, [0xc0, 0x39, 0x2b]), 'the base accent colour appears in the cloth');
  assert.equal(FLAG.frames, 4);
});

ta('accent: flagSprite is cached by accent and frame [style.flags-on-ridges]', () => {
  assert.strictEqual(ACC.flagSprite('#c0392b', 0), ACC.flagSprite('#c0392b', 0));
  assert.strictEqual(ACC.flagSprite('#c0392b', 4), ACC.flagSprite('#c0392b', 0), 'frames wrap at 4');
  assert.notStrictEqual(ACC.flagSprite('#c0392b', 0), ACC.flagSprite('#2980b9', 0));
  assert.ok(ACC.flagSprite('#c0392b', 0).w > 0);
});

ta('accent: ridgeFlags puts one flag on each home ridge with its village accent [style.flags-on-ridges]', () => {
  if (skip) return;
  const w = world(), objs = objectsOf(w), homes = objs.filter(o => o.kind === 'building' && o.data?.agentId != null);
  assert.ok(homes.length > 0);
  const entryOf = () => ({ anchors: { ridge: { x: 20, y: 8 } }, pivot: { x: 16, y: 40 } });
  const accents = ACC.accentsOf(w);
  const flags = ACC.ridgeFlags(objs, entryOf, accents);
  assert.equal(flags.length, homes.length, 'one flag per home, none on other objects');
  for (const f of flags) { assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y)); assert.ok(f.accent); assert.ok(Number.isInteger(f.phase) && f.phase >= 0 && f.phase < FLAG.frames); }
  assert.deepEqual(ACC.ridgeFlags(objs, () => null, accents), [], 'skipped until the sprite is ready');
});

tx('effects: createEffects returns a draw hook that survives every zoom and 600 frames [amb.fountain-sparkle] [amb.falling-leaves] [world.wave-glints]', () => {
  if (skip) return;
  const w = world(), e = FX.createEffects({ world: w, mod: null });
  assert.equal(typeof e.draw, 'function');
  const { g } = recorder();
  for (const z of [0.25, 1, 2, 4]) for (let f = 0; f < 150; f++) e.draw(g, { v: 2, x: 0, y: 0, z }, viewOf(w, z), { t: f / 60, night: f % 2, actors: [] });
});

tx('effects: something is painted over a long run at a close zoom [amb.fountain-sparkle] [amb.falling-leaves] [bld.chimney-smoke-sources]', () => {
  if (skip) return;
  const w = world(), e = FX.createEffects({ world: w, mod: null }), { g, calls } = recorder();
  for (let f = 0; f < 900; f++) e.draw(g, { v: 2, x: 0, y: 0, z: 2 }, viewOf(w, 2), { t: f / 60, night: 0, actors: [] });
  assert.ok(calls.filter(x => PAINT.test(x[0])).length > 0, 'at least one effect painted');
});

tx('effects: smoke never exceeds 6 puffs on screen [bld.smoke-puff-cap]', (ctx) => {
  if (skip) return;
  const w = world(), e = FX.createEffects({ world: w, mod: null }), { g } = recorder();
  let max = 0;
  for (let f = 0; f < 600; f++) { e.draw(g, { v: 2, x: 0, y: 0, z: 1 }, viewOf(w, 1), { t: f / 60, night: 0, actors: [] }); const p = e.stats?.().puffs; if (p !== undefined) max = Math.max(max, p); }
  if (!e.stats) return ctx.todo('effects needs stats() -> { puffs } to prove the cap');
  assert.ok(max <= 6, `saw ${max} puffs`);
});

tx('effects: the bird V flies every 40 s, not more often [amb.bird-v-every-40s]', (ctx) => {
  if (skip) return;
  const w = world(), e = FX.createEffects({ world: w, mod: null }), { g, calls } = recorder();
  if (!e.stats) return ctx.todo('effects needs stats() -> { birds } to count flocks');
  let flocks = 0, was = 0;
  for (let f = 0; f < 60 * 130; f += 4) { e.draw(g, { v: 2, x: 0, y: 0, z: 1 }, viewOf(w, 1), { t: f / 60, night: 0, actors: [] }); const b = e.stats().birds || 0; if (b && !was) flocks++; was = b; }
  assert.ok(flocks >= 2 && flocks <= 4, `${flocks} flocks in about 130 s`);
});

tx('effects: actorOffset bobs a stalled agent over time and leaves others still [vil.stalled-bob]', () => {
  const stalled = { id: 'a', bucket: 'stalled', phase: 0.3 }, seen = new Set();
  for (let t = 0; t < 4; t += 0.1) { const o = FX.actorOffset(stalled, t); assert.ok(Number.isFinite(o.dx) && Number.isFinite(o.dy)); assert.ok(Math.abs(o.dx) <= 2 && Math.abs(o.dy) <= 2, 'a small bob'); seen.add(`${o.dx},${o.dy}`); }
  assert.ok(seen.size > 1, 'it moves');
  for (const bucket of ['building', 'waiting', 'resting']) assert.deepEqual(FX.actorOffset({ id: 'b', bucket, phase: 0.3 }, 1.7), { dx: 0, dy: 0 }, bucket);
});
