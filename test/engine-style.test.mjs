import './support/ensure-mods-index.mjs';
// M6 P5 spec tests for projectStyle (design 5.4, M6-PLAN P3, invariant 7). Written from the spec, not the implementation:
// every generated style validates, styles are deterministic per key, axes are independent, the tier overrides the
// paving/lamp materials, roofs avoid the reserved badge hues, and neighbouring blocks differ in roof colour and pattern.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStyle, validateStyle, applyNeighbourRule, axisRng } from '../mods/agentville.fantasy/style.js';
import { AXIS_SALT, RESERVED_HUES, PATTERNS } from '../mods/agentville.fantasy/style-rules.js';
import { distinctPicks } from '../web/src/engine/render/accent.js';
import { styleKeyFor } from '../web/src/engine/art/style-key.js';

const N = 10000;
const keyOf = i => `seed-${i}`;
const hsv = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: mx ? d / mx : 0 };
};
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

test('invariant 7: validateStyle returns [] for every seed 0..9999 (no tier, and each tier 0..3)', () => {
  for (let i = 0; i < N; i++) {
    const k = keyOf(i);
    for (const tier of [undefined, 0, 1, 2, 3]) {
      const s = projectStyle(k, tier === undefined ? {} : { tier }, {});
      const errs = validateStyle(s);
      assert.deepEqual(errs, [], `${k} tier ${tier}: ${errs.join('; ')}`);
    }
  }
});

test('deterministic per key: same inputs give the same style, even interleaved with other keys', () => {
  for (let i = 0; i < 300; i++) {
    const a = projectStyle(keyOf(i), { tier: 2 }, {});
    projectStyle(keyOf(i + 1), { tier: 0 }, {});
    assert.deepEqual(projectStyle(keyOf(i), { tier: 2 }, {}), a);
  }
  assert.notDeepEqual(projectStyle('alpha', {}, {}), projectStyle('beta', {}, {}));
  assert.equal(projectStyle('alpha', {}, {}).key, projectStyle('alpha', {}, {}).key);
});

test('preset.family picks the family', () => {
  for (let f = 0; f < 6; f++) assert.equal(projectStyle('x', {}, { family: f }).family, f);
});

test('salt independence: salts are distinct 32-bit ints, one stream per axis, and one axis never reads another', () => {
  const axes = Object.keys(AXIS_SALT);
  assert.ok(axes.length >= 11);
  assert.equal(new Set(Object.values(AXIS_SALT)).size, axes.length, 'salts are unique');
  for (const v of Object.values(AXIS_SALT)) assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
  for (let i = 0; i < 50; i++) {
    const k = keyOf(i);
    const first = {};
    for (const a of axes) first[a] = [axisRng(k, a)(), axisRng(k, a)()];
    for (const a of axes) { const r = axisRng(k, a); r(); r(); first[a].push(r()); }
    // streams are fresh per call, so drawing from one axis does not move another
    for (const a of axes) assert.equal(axisRng(k, a)(), first[a][0]);
    const heads = new Set(axes.map(a => axisRng(k, a)()));
    assert.ok(heads.size >= axes.length - 1, 'axes draw different streams');
  }
});

test('salt independence: changing the tier (which re-rolls paving and lamp) leaves every other axis unchanged', () => {
  const pick = s => JSON.stringify({ pattern: s.street.pattern, tree: s.street.tree, hedge: s.street.hedge, skin: s.folk.skin, apron: s.folk.apron, headwear: s.folk.headwear, banner: s.banner, roof: s.roof, wall: s.wall });
  for (let i = 0; i < 1000; i++) {
    const k = keyOf(i), base = pick(projectStyle(k, { tier: 3 }, {}));
    for (const t of [0, 1, 2]) assert.equal(pick(projectStyle(k, { tier: t }, {})), base, `${k} tier ${t}`);
  }
});

test('tier override: hamlet = earth/gravel + woodpost, village = gravel/cobble, painter kind stays coherent', () => {
  for (let i = 0; i < N; i++) {
    const k = keyOf(i);
    const h = projectStyle(k, { tier: 0 }, {}), v = projectStyle(k, { tier: 1 }, {});
    assert.ok(['earth', 'gravel'].includes(h.street.paving), `${k} hamlet paving ${h.street.paving}`);
    assert.equal(h.street.lamp, 'woodpost');
    assert.ok(['gravel', 'cobble'].includes(v.street.paving), `${k} village paving ${v.street.paving}`);
    assert.equal(h.tier, 0); assert.equal(v.tier, 1);
  }
  // the override applies through the preset too, and a preset family does not defeat it
  for (let f = 0; f < 6; f++) {
    const s = projectStyle('k', {}, { family: f, tier: 0 });
    assert.ok(['earth', 'gravel'].includes(s.street.paving));
  }
});

test('reserved badge hues: no roof within 18 degrees of a badge hue is vivid (saturation <= 0.55)', () => {
  const reserved = RESERVED_HUES.map(c => hsv(c).h);
  assert.ok(reserved.length >= 4);
  for (let i = 0; i < N; i++) {
    const s = projectStyle(keyOf(i), {}, {});
    for (const c of [s.roof.base, s.roof.ridge]) {
      const { h, s: sat } = hsv(c);
      if (reserved.some(r => hueGap(h, r) < 18)) assert.ok(sat <= 0.55 + 1e-9, `${keyOf(i)} roof ${c} sat ${sat.toFixed(2)} near a reserved hue`);
    }
  }
});

test('neighbour rule: adjacent blocks differ in roof colour and paving pattern; isolated blocks are untouched', () => {
  let checked = 0;
  for (let seed = 0; seed < 200; seed++) {
    // 3 mutually adjacent blocks (gap 1 tile) with seeded styles; same-family stress: force one family
    const names = [0, 1, 2].map(j => `p${seed}-${j}`);
    const fam = seed % 6;
    const styles = new Map(names.map(n => [n, projectStyle(n, {}, { family: fam })]));
    const blocks = names.map((n, j) => ({ project: n, x: (j % 2) * 9, y: (j >> 1) * 9, w: 8, h: 8 }));   // an L: every pair within 1 tile
    const out = applyNeighbourRule(styles, blocks, distinctPicks);
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      const A = out.get(names[a]), B = out.get(names[b]);
      assert.notEqual(A.roof.base, B.roof.base, `roof ${names[a]} vs ${names[b]}`);
      assert.notEqual(A.street.pattern, B.street.pattern, `pattern ${names[a]} vs ${names[b]}`);
      checked++;
    }
    for (const n of names) { assert.ok(validateStyle(out.get(n)).length === 0, `still valid: ${validateStyle(out.get(n)).join()}`); assert.ok(PATTERNS.includes(out.get(n).street.pattern)); }
  }
  assert.equal(checked, 600);
  // isolated: far apart blocks keep their own style
  const a = projectStyle('solo-a', {}, {}), b = projectStyle('solo-b', {}, {});
  const out = applyNeighbourRule(new Map([['solo-a', a], ['solo-b', b]]), [{ project: 'solo-a', x: 0, y: 0, w: 8, h: 8 }, { project: 'solo-b', x: 200, y: 0, w: 8, h: 8 }], distinctPicks);
  assert.equal(out.get('solo-a').roof.base, a.roof.base); assert.equal(out.get('solo-b').street.pattern, b.street.pattern);
});

test('neighbour rule: result depends on the set of blocks, not their order; the neighbour fix only touches roof and pattern', () => {
  const names = ['a', 'b', 'c', 'd'];
  const styles = new Map(names.map(n => [n, projectStyle(n, {}, { family: 2 })]));
  const blocks = names.map((n, j) => ({ project: n, x: j * 9, y: 0, w: 8, h: 8 }));
  const one = applyNeighbourRule(styles, blocks, distinctPicks), two = applyNeighbourRule(styles, [...blocks].reverse(), distinctPicks);
  for (const n of names) {
    assert.deepEqual(one.get(n), two.get(n));
    const before = styles.get(n), after = one.get(n);
    assert.deepEqual({ ...after, roof: 0, street: { ...after.street, pattern: 0 } }, { ...before, roof: 0, street: { ...before.street, pattern: 0 } });
  }
});

test('styleKeyFor: only the fields a model reads move the key', () => {
  const s = projectStyle('keyed', {}, {});
  const k = styleKeyFor(s, ['roof', 'wall']);
  assert.equal(k, styleKeyFor({ ...s, accent: '#000000', folk: null }, ['wall', 'roof']));
  assert.notEqual(k, styleKeyFor({ ...s, roof: { base: '#010203', ridge: '#040506' } }, ['roof', 'wall']));
  assert.equal(styleKeyFor(null, ['roof']), '');
});
