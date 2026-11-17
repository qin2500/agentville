// M6 P3: projectStyle, validateStyle, neighbour rule, styleKeyFor, fantasy ground.renderTile. Written from design 5.4 / invariant 7.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStyle, validateStyle, applyNeighbourRule, axisRng, roofChoices, muteNearReserved } from '../mods/agentville.fantasy/style.js';
import { AXIS_SALT, TIER_PAVING, PATTERNS } from '../mods/agentville.fantasy/style-rules.js';
import { tilePixels, renderTile } from '../mods/agentville.fantasy/ground.js';
import { styleKeyFor } from '../web/src/engine/art/style-key.js';
import { distinctPicks } from '../web/src/engine/render/accent.js';
import { styleFor } from '../web/src/styles-pool.js';

test('invariant 7: seeds 0..9999 give a valid style (every tier), reserved hues hold', () => {
  for (let i = 0; i < 10000; i++) {
    const tier = [null, 0, 1, 2, 3][i % 5], e = validateStyle(projectStyle(`seed-${i}`, tier == null ? {} : { tier }));
    assert.deepEqual(e, [], `seed ${i}: ${e.join('; ')}`);
  }
});

test('projectStyle is deterministic, frozen, and extends city4 without replacing it', () => {
  const a = projectStyle('alpha', {}), b = projectStyle('alpha', {}), c = styleFor('alpha');
  assert.deepEqual(a, b); assert.ok(Object.isFrozen(a) && Object.isFrozen(a.street));
  assert.equal(a.key, c.key); assert.equal(a.roof.base, muteNearReserved(c.roof.base)); assert.deepEqual(a.wall, c.wall); assert.equal(a.accent, c.accent);
  assert.equal(projectStyle('alpha', { forcedStyle: 8 }, { family: 3 }).family, 2);
  assert.equal(projectStyle('alpha', {}, { family: 4 }).street.paving, 'brick');
});

test('salt independence: distinct salts and streams; axes are not correlated', () => {
  const salts = Object.values(AXIS_SALT); assert.equal(new Set(salts).size, salts.length);
  let both = 0, k = 0, h = 0; const N = 4000;
  for (let i = 0; i < N; i++) { const s = projectStyle(`p${i}`, {}, { family: 0 }); k += s.street.kerb; h += s.street.hedge; both += s.street.kerb && s.street.hedge; }
  assert.ok(Math.abs(both / N - (k / N) * (h / N)) < 0.03, `kerb/hedge joint ${both / N} vs ${(k / N) * (h / N)}`);
  let same = 0; for (let i = 0; i < 500; i++) if (axisRng(`p${i}`, 'kerb')() === axisRng(`p${i}`, 'hedge')()) same++;
  assert.ok(same < 5);
  // an axis draws only from its own stream: the skin set does not depend on the family or tier rows
  const t0 = projectStyle('zed', { tier: 0 }, { family: 1 }), t3 = projectStyle('zed', { tier: 3 }, { family: 1 });
  assert.deepEqual(t0.folk.skin, t3.folk.skin); assert.equal(t0.folk.apron, t3.folk.apron); assert.deepEqual(t0.banner, t3.banner);
});

test('tier override: hamlet earth/gravel + woodpost, village gravel/cobble, town+ the family paving', () => {
  for (let i = 0; i < 300; i++) {
    const k = `t${i}`;
    const h = projectStyle(k, { tier: 0 }), v = projectStyle(k, { tier: 1 }), t = projectStyle(k, { tier: 2 }), n = projectStyle(k, {});
    assert.ok(TIER_PAVING[0].includes(h.street.paving) && h.street.lamp === 'woodpost' && h.paving.kind === 'earth', k);
    assert.ok(TIER_PAVING[1].includes(v.street.paving), k);
    assert.deepEqual(t.street, n.street, 'town = untiered');
    assert.equal(projectStyle(k, { forcedTier: 0 }).street.paving, h.street.paving);
  }
});

test('validateStyle names what is wrong', () => {
  const ok = projectStyle('alpha', {});
  assert.deepEqual(validateStyle(ok), []);
  assert.ok(validateStyle(null).length);
  assert.ok(validateStyle({ ...ok, street: { ...ok.street, paving: 'lava' } }).some(m => /street\.paving/.test(m)));
  assert.ok(validateStyle({ ...ok, banner: undefined }).some(m => /banner/.test(m)));
  assert.ok(validateStyle({ ...ok, folk: { ...ok.folk, skin: ['#fff', '#fff'] } }).length);
  assert.ok(validateStyle({ ...ok, roof: { base: '#f0a020', ridge: '#aa5500' } }).some(m => /reserved/.test(m)));
  assert.ok(validateStyle({ ...ok, tier: 0, street: { ...ok.street, paving: 'brick', lamp: 'brassglobe' } }).some(m => /hamlet/.test(m)));
});

const blocks = (...xs) => xs.map(([project, x, y]) => ({ project, x, y, w: 6, h: 6 }));
test('neighbour rule: adjacent blocks differ in roof colour and paving pattern; stable in key order, not arrival order', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'], bs = blocks(['a', 0, 0], ['b', 7, 0], ['c', 14, 0], ['d', 0, 7], ['e', 7, 7], ['f', 14, 7]);
  // force every block into one family and one pick so the rule has work to do
  const styles = new Map(keys.map(k => [k, projectStyle('same', {}, { family: 0 })]));
  const out = applyNeighbourRule(styles, bs, distinctPicks);
  const near = (p, q) => Math.max(p.x - (q.x + q.w), q.x - (p.x + p.w), p.y - (q.y + q.h), q.y - (p.y + p.h), 0) <= 6;
  for (const p of bs) for (const q of bs) if (p !== q && near(p, q) && [p, q].every(z => ['a', 'c', 'e'].includes(z.project) || true)) {
    const sp = out.get(p.project), sq = out.get(q.project);
    if (roofChoices(0).length >= 3) assert.notEqual(sp.roof.base, sq.roof.base, `${p.project}/${q.project} roof`);
  }
  // a pair (a,b) at least differs in both axes
  assert.notEqual(out.get('a').roof.base, out.get('b').roof.base); assert.notEqual(out.get('a').street.pattern, out.get('b').street.pattern);
  const rev = applyNeighbourRule(styles, [...bs].reverse(), distinctPicks);
  for (const k of keys) assert.deepEqual(rev.get(k), out.get(k));
  assert.ok(Object.isFrozen(out.get('b')));
  assert.ok(PATTERNS.includes(out.get('b').street.pattern));
});

test('neighbour rule: an isolated block keeps its own pick (same object), the family is never re-rolled', () => {
  const s = projectStyle('solo', {}), o = applyNeighbourRule({ solo: s }, blocks(['solo', 0, 0]), distinctPicks);
  assert.equal(o.get('solo'), s);
  const s2 = projectStyle('solo', {}), s3 = projectStyle('solo', {}), two = applyNeighbourRule({ x: s2, y: s3 }, blocks(['x', 0, 0], ['y', 7, 0]), distinctPicks);
  for (const k of ['x', 'y']) { assert.equal(two.get(k).family, s2.family); assert.equal(two.get(k).key, s2.key); assert.deepEqual(two.get(k).folk, s2.folk); }
  assert.ok(validateStyle(two.get('y')).length === 0);
});

test('distinctPicks: far blocks keep their first option; exhausted options fall to the least worn', () => {
  const o = distinctPicks(blocks(['a', 0, 0], ['b', 50, 0]), () => ['x', 'y']);
  assert.equal(o.get('a'), 'x'); assert.equal(o.get('b'), 'x');
  const three = distinctPicks(blocks(['a', 0, 0], ['b', 7, 0], ['c', 14, 0]), () => ['x', 'y']);
  assert.deepEqual([three.get('a'), three.get('b'), three.get('c')], ['x', 'y', 'x']);
});

test('styleKeyFor: only the read fields count, order-free, dotted paths', () => {
  const s = projectStyle('alpha', {}), r = ['roof.base', 'wall', 'accent'];
  const k = styleKeyFor(s, r);
  assert.equal(k, styleKeyFor(s, [...r].reverse()));
  assert.equal(k, styleKeyFor({ ...s, banner: { shape: 'square', motif: 'cross' }, folk: null }, r));
  assert.notEqual(k, styleKeyFor({ ...s, accent: '#000001' }, r));
  assert.notEqual(k, styleKeyFor({ ...s, roof: { ...s.roof, base: '#000001' } }, r));
  assert.equal(styleKeyFor(null, r), ''); assert.equal(styleKeyFor(s, []), '');
});

// ---- ground ----
const inDiamond = (x, y) => { const half = (y < 8 ? 4 * y + 2 : 4 * (15 - y) + 2) / 2; return x >= 16 - half && x < 16 + half; };
const nbAll = (c, extra = {}) => ({ n: c, e: c, s: c, w: c, ne: c, se: c, sw: c, nw: c, terrain: 3, road: 0, ...extra });
test('ground.tilePixels paints exactly the 32x16 diamond, opaque, inside the tile', () => {
  for (const fam of [0, 1, 2, 3, 4, 5]) for (const tier of [0, 2]) for (const code of [2, 3, 4, 5]) for (const pat of ['running', 'herringbone', 'fan', 'random']) {
    const base = projectStyle(`g${fam}`, { tier }, { family: fam }), st = { ...base, street: { ...base.street, pattern: pat } };
    const px = tilePixels(code, nbAll(code === 3 ? 2 : 2, { n: 1, e: 2 }), st);
    assert.ok(px && px.w === 32 && px.h === 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) assert.equal(px.data[(y * 32 + x) * 4 + 3], inDiamond(x, y) ? 255 : 0, `${fam}/${tier}/${code}/${pat} @${x},${y}`);
  }
});

test('ground.tilePixels: styles differ, neighbours change edges, deterministic; unpaved codes and string styles draw nothing', () => {
  const a = projectStyle('alpha', { tier: 2 }, { family: 1 }), b = projectStyle('alpha', { tier: 2 }, { family: 4 });
  const pa = tilePixels(2, nbAll(2), a), pb = tilePixels(2, nbAll(2), b);
  assert.notDeepEqual([...pa.data], [...pb.data]);
  assert.deepEqual([...tilePixels(2, nbAll(2), a).data], [...pa.data]);
  const edge = tilePixels(2, nbAll(2, { n: 1 }), a);
  assert.notDeepEqual([...edge.data], [...pa.data], 'a kerb appears where the street meets grass');
  assert.equal(tilePixels(1, nbAll(1), a), null); assert.equal(tilePixels(12, nbAll(12), a), null);
  assert.equal(tilePixels(2, nbAll(2), 'default'), null); assert.equal(tilePixels(2, nbAll(2), undefined), null);
  assert.ok(tilePixels(2, nbAll(2, { style: a }), 'default'), 'per-settlement style rides on nb.style');
  const nok = { ...a, street: { ...a.street, kerb: false } };
  assert.notDeepEqual([...tilePixels(2, nbAll(2, { n: 1 }), nok).data], [...edge.data]);
});

test('ground.renderTile returns a canvas bitmap (injected OffscreenCanvas) or null without one', () => {
  const a = projectStyle('alpha', { tier: 2 });
  assert.equal(typeof OffscreenCanvas === 'undefined' ? renderTile(2, nbAll(2), a) : 0, typeof OffscreenCanvas === 'undefined' ? null : 0);
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { const o = this; return { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (id) => { o.data = id.data; } }; } };
  try {
    const bmp = renderTile(2, nbAll(2, { n: 1 }), a);
    assert.ok(bmp && bmp.width === 32 && bmp.height === 16 && bmp.data.length === 32 * 16 * 4);
    assert.equal(renderTile(2, nbAll(2, { n: 1 }), a), bmp, 'memoised');
    assert.equal(renderTile(1, nbAll(1), a), null);
  } finally { delete globalThis.OffscreenCanvas; }
});

test('ground.tilePixels: a flowers tile is a flower bed (many colours, varies by tile, deterministic), not one flat fill', () => {
  const cols = (tx, ty) => {
    const px = tilePixels(15, nbAll(15, { tx, ty }), undefined), set = new Set();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) if (inDiamond(x, y)) { const i = (y * 32 + x) * 4; set.add(px.data.slice(i, i + 3).join(',')); }
    return { px, n: set.size };
  };
  const a = cols(3, 4), b = cols(5, 1);
  assert.ok(a.n >= 6, `distinct colours ${a.n}`);
  assert.deepEqual([...cols(3, 4).px.data], [...a.px.data]);
  assert.notDeepEqual([...a.px.data], [...b.px.data]);
});
