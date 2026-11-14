// Engine v2 render/depth.js (R1): sort key, actor key, chunks, k-way merge. Written from design §3.2 / COMMON seams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortKey, actorKey, chunkOf, mergeSorted, LAYER } from '../web/src/engine/render/depth.js';

const lex = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

test('LAYER values and order', () => {
  assert.deepEqual({ ...LAYER }, { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 });
  assert.ok(Object.isFrozen(LAYER));
});

test('sortKey matches the packed formula', () => {
  for (const [d, s, l, c] of [[0, 0, 0, 0], [5, 3, 2, -7], [-12, 1, 4, 100], [4096, 3, 4, 2047], [-4096, 0, 0, -2048]]) {
    assert.equal(sortKey(d, s, l, c), ((d * 4 + s) * 8 + l) * 4096 + (c + 2048));
  }
});

test('sortKey is an exact integer and a total order over a ±2048-tile world', () => {
  // extremes of depth, sub, layer, in-range col
  const ds = [-4096, -4095, -1, 0, 1, 4095, 4096], ss = [0, 1, 2, 3], ls = [0, 1, 2, 3, 4], cs = [-2048, -1, 0, 1, 2047];
  const tuples = [];
  for (const d of ds) for (const s of ss) for (const l of ls) for (const c of cs) tuples.push([d, s, l, c]);
  const keyed = tuples.map((t) => ({ t, k: sortKey(...t) }));
  for (const { k } of keyed) { assert.ok(Number.isSafeInteger(k), `unsafe ${k}`); assert.ok(!Object.is(k, -0)); }
  keyed.sort((a, b) => a.k - b.k);
  for (let i = 1; i < keyed.length; i++) {
    assert.ok(keyed[i].k > keyed[i - 1].k, 'keys distinct');
    assert.ok(lex(keyed[i].t, keyed[i - 1].t) > 0, 'key order == lexicographic (depth, sub, layer, col)');
  }
  assert.ok(Math.abs(sortKey(4096, 3, 7, 4096)) < 2 ** 53 && Math.abs(sortKey(-4096, 0, 0, -4096)) < 2 ** 53);
});

test('out-of-range col never crosses into another layer, sub or depth slot', () => {
  assert.ok(sortKey(10, 0, LAYER.OBJECT, 4096) < sortKey(10, 0, LAYER.ACTOR, -4096));
  assert.ok(sortKey(10, 3, LAYER.EFFECT, 4096) < sortKey(11, 0, LAYER.GROUND_PROP, -4096));
  assert.ok(sortKey(10, 0, LAYER.EFFECT, 9999) < sortKey(10, 1, LAYER.GROUND_PROP, -9999));
});

test('layer bias orders ground props < objects < actors < carried < effects at equal depth', () => {
  const ks = [LAYER.GROUND_PROP, LAYER.OBJECT, LAYER.ACTOR, LAYER.CARRIED, LAYER.EFFECT].map((l) => sortKey(7, 0, l, 2047));
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i] > ks[i - 1]);
  // depth dominates layer: an effect behind sorts before a ground prop in front
  assert.ok(sortKey(6, 3, LAYER.EFFECT, 2047) < sortKey(7, 0, LAYER.GROUND_PROP, -2048));
});

test('actorKey: feet at quarter-tile resolution', () => {
  assert.equal(actorKey(3, 4), sortKey(7, 0, LAYER.ACTOR, -1));
  assert.equal(actorKey(3.1, 4.2), sortKey(7, 1, LAYER.ACTOR, -1));      // x+y = 7.3 -> sub 1
  assert.equal(actorKey(3.5, 4.25), sortKey(7, 3, LAYER.ACTOR, -1));     // 7.75 -> sub 3, col round(-0.75) = -1
  assert.equal(actorKey(3.5, 4.0), sortKey(7, 2, LAYER.ACTOR, 0));       // col round(-0.5) = -0 -> 0
  assert.equal(actorKey(2, 2, LAYER.CARRIED), sortKey(4, 0, LAYER.CARRIED, 0));
  // negatives floor, sub stays 0..3
  assert.equal(actorKey(-1.1, -1.2), sortKey(-3, 2, LAYER.ACTOR, 0));    // -2.3 -> depth -3, frac .7 -> sub 2
  assert.equal(actorKey(-0.25, 0), sortKey(-1, 3, LAYER.ACTOR, 0));
  // float edge just below an integer never yields sub 4
  const k = actorKey(1 - 1e-17, 0.9999999999999999);
  assert.ok(Number.isSafeInteger(k));
  // walking forward never decreases the key at fixed col
  let prev = -Infinity;
  for (let i = 0; i <= 200; i++) { const t = -50 + i * 0.37; const kk = actorKey(t, t); assert.ok(kk >= prev); prev = kk; }
});

test('actor sorts in front of a static slice at the same depth, behind the next depth', () => {
  const wall = sortKey(9, 0, LAYER.OBJECT, 0);
  assert.ok(actorKey(4.5, 4.5) > wall);           // feet at depth 9.0
  assert.ok(actorKey(4.4, 4.5) < wall);           // feet at 8.9: behind
  assert.ok(actorKey(4.9, 4.99) < sortKey(10, 0, LAYER.OBJECT, 0));
});

test('chunkOf: 16x16 chunks, negative-safe', () => {
  assert.deepEqual(chunkOf(0, 0), { cx: 0, cy: 0 });
  assert.deepEqual(chunkOf(15, 15.9), { cx: 0, cy: 0 });
  assert.deepEqual(chunkOf(16, 31), { cx: 1, cy: 1 });
  assert.deepEqual(chunkOf(-1, -16), { cx: -1, cy: -1 });
  assert.deepEqual(chunkOf(-17, -0.5), { cx: -2, cy: -1 });
  const c = chunkOf(-0, 5); assert.ok(!Object.is(c.cx, -0));
});

test('mergeSorted: trivial inputs', () => {
  assert.deepEqual(mergeSorted([]), []);
  assert.deepEqual(mergeSorted([[], []]), []);
  const a = [{ key: 1 }, { key: 2 }];
  const out = mergeSorted([[], a, []]);
  assert.deepEqual(out, a); assert.notEqual(out, a);
  assert.equal(out[0], a[0]);
});

test('mergeSorted: stable by list index, then position', () => {
  const A = [{ key: 1, id: 'a0' }, { key: 5, id: 'a1' }, { key: 5, id: 'a2' }];
  const B = [{ key: 1, id: 'b0' }, { key: 5, id: 'b1' }, { key: 9, id: 'b2' }];
  const C = [{ key: 0, id: 'c0' }, { key: 5, id: 'c1' }];
  assert.deepEqual(mergeSorted([A, B, C]).map((x) => x.id), ['c0', 'a0', 'b0', 'a1', 'a2', 'b1', 'c1', 'b2']);
  assert.deepEqual(mergeSorted([C, B, A]).map((x) => x.id), ['c0', 'b0', 'a0', 'c1', 'b1', 'a1', 'a2', 'b2']);
});

test('mergeSorted: matches a stable sort for many random lists (deterministic PRNG)', () => {
  let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let round = 0; round < 30; round++) {
    const k = 1 + Math.floor(rnd() * 40);
    const lists = [];
    for (let i = 0; i < k; i++) {
      const n = Math.floor(rnd() * 25);
      const L = [];
      for (let j = 0; j < n; j++) L.push({ key: sortKey(Math.floor(rnd() * 6) - 3, Math.floor(rnd() * 4), Math.floor(rnd() * 5), Math.floor(rnd() * 5) - 2), li: i, pos: j });
      L.sort((a, b) => a.key - b.key);
      L.forEach((x, j) => { x.pos = j; });
      lists.push(L);
    }
    const expect = lists.flat().sort((a, b) => a.key - b.key || a.li - b.li || a.pos - b.pos);
    const got = mergeSorted(lists);
    assert.equal(got.length, expect.length);
    for (let i = 0; i < got.length; i++) assert.equal(got[i], expect[i]);
  }
});

test('mergeSorted: reuses a passed output array and does not mutate inputs', () => {
  const A = [{ key: 2 }, { key: 4 }], B = [{ key: 1 }, { key: 3 }];
  const out = [{ key: 99 }, { key: 99 }, { key: 99 }, { key: 99 }, { key: 99 }, { key: 99 }];
  const r = mergeSorted([A, B], out);
  assert.equal(r, out);
  assert.deepEqual(r.map((x) => x.key), [1, 2, 3, 4]);
  assert.deepEqual(A.map((x) => x.key), [2, 4]);
  assert.deepEqual(B.map((x) => x.key), [1, 3]);
});

test('mergeSorted: chunk lists + actors, one draw order', () => {
  const chunkA = [sortKey(3, 0, LAYER.OBJECT, 0), sortKey(8, 0, LAYER.OBJECT, 1)].map((key, i) => ({ key, id: `wallA${i}` }));
  const chunkB = [sortKey(5, 0, LAYER.GROUND_PROP, -2)].map((key) => ({ key, id: 'fence' }));
  const actors = [actorKey(2, 2), actorKey(4, 4.5)].map((key, i) => ({ key, id: `actor${i}` })).sort((a, b) => a.key - b.key);
  assert.deepEqual(mergeSorted([chunkA, chunkB, actors]).map((x) => x.id), ['wallA0', 'actor0', 'fence', 'wallA1', 'actor1']);
});
