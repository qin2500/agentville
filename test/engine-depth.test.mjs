// Depth ordering for the v2 engine (design docs/village-engine-v2.md §3.2 and §5.3 invariant 5). Written from the spec.
// render/depth.js and render/slice.js are written in parallel: every case skips while the module is missing.
import test from 'node:test';
import assert from 'node:assert/strict';

const load = async p => { try { return await import(p); } catch (e) { if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ENOENT')) return null; throw e; } };
const D = await load('../web/src/engine/render/depth.js');
const S = await load('../web/src/engine/render/slice.js');
const dTest = (name, fn) => test(name, { skip: D ? false : 'render/depth.js not present yet' }, fn);
const sTest = (name, fn) => test(name, { skip: D && S ? false : 'render/depth.js or render/slice.js not present yet' }, fn);

function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const ri = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// reference comparator: lexicographic on (depth, sub, layer, col)
const refCmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];

dTest('LAYER bias order: ground props < objects < actors < carried < effects', () => {
  const L = D.LAYER;
  assert.deepEqual([L.GROUND_PROP, L.OBJECT, L.ACTOR, L.CARRIED, L.EFFECT], [0, 1, 2, 3, 4]);
});

dTest('sortKey matches the documented formula and is an exact integer', () => {
  const r = prng(1);
  for (let i = 0; i < 2000; i++) {
    const d = ri(r, 0, 400), sub = ri(r, 0, 3), layer = ri(r, 0, 4), col = ri(r, -200, 200);
    const k = D.sortKey(d, sub, layer, col);
    assert.equal(k, ((d * 4 + sub) * 8 + layer) * 4096 + (col + 2048));
    assert.ok(Number.isInteger(k));
    assert.ok(Number.isSafeInteger(k));
  }
});

dTest('sortKey is a total order equal to the (depth, sub, layer, col) lexicographic reference', () => {
  const r = prng(2);
  const grid = [];
  for (let i = 0; i < 1500; i++) grid.push([ri(r, 0, 60), ri(r, 0, 3), ri(r, 0, 4), ri(r, -60, 60)]);
  const keyed = grid.map(t => ({ t, k: D.sortKey(...t) }));
  for (let i = 0; i < 20000; i++) {
    const a = keyed[ri(r, 0, keyed.length - 1)], b = keyed[ri(r, 0, keyed.length - 1)];
    assert.equal(Math.sign(a.k - b.k), Math.sign(refCmp(a.t, b.t)), `${a.t} vs ${b.t}`);
  }
  // distinct tuples never collide
  const seen = new Map();
  for (const { t, k } of keyed) { const s = t.join(','); if (seen.has(k)) assert.equal(seen.get(k), s); seen.set(k, s); }
});

dTest('sortKey: extreme columns do not bleed into the layer field', () => {
  for (const col of [-2048, -1, 0, 1, 2047]) {
    assert.ok(D.sortKey(5, 0, 1, col) < D.sortKey(5, 0, 2, -2048), `col ${col}`);
    assert.ok(D.sortKey(5, 3, 4, col) < D.sortKey(6, 0, 0, -2048), `col ${col}`);
  }
});

dTest('mergeSorted equals concat + stable sort on random lists', () => {
  const r = prng(3);
  for (let round = 0; round < 200; round++) {
    const lists = [];
    let n = 0;
    for (let l = ri(r, 0, 8); l > 0; l--) {
      const len = ri(r, 0, 40);
      const list = [];
      for (let i = 0; i < len; i++) list.push({ key: ri(r, 0, 30), id: n++ }); // many ties
      list.sort((a, b) => a.key - b.key || a.id - b.id);
      lists.push(list);
    }
    const expected = lists.flat().sort((a, b) => a.key - b.key); // Array.prototype.sort is stable: list order breaks ties
    const got = D.mergeSorted(lists);
    assert.equal(got.length, expected.length);
    assert.deepEqual(got.map(x => x.id), expected.map(x => x.id));
  }
});

dTest('mergeSorted handles empty input and does not mutate its lists', () => {
  assert.deepEqual(D.mergeSorted([]), []);
  assert.deepEqual(D.mergeSorted([[], []]), []);
  const a = [{ key: 1 }, { key: 3 }], b = [{ key: 2 }];
  const copyA = a.slice(), copyB = b.slice();
  D.mergeSorted([a, b]);
  assert.deepEqual(a, copyA); assert.deepEqual(b, copyB);
});

// ---- slicing -----------------------------------------------------------------------------------------------------
const mkObj = (o) => ({ id: 'o', kind: 'building', model: 'house', tx: 0, ty: 0, w: 1, h: 1, z: 24, walk: 'block', project: 'p', styleKey: 's', variant: 0, ...o });
const mkSprite = (o) => ({ img: { tag: 'img' }, bounds: { x: 0, y: 0, w: 160, h: 160 }, pivot: { x: 80, y: 120 }, slices: [], anchors: {}, bytes: 0, lastUsed: 0, ...o });
const cells = obj => { const c = []; for (let x = obj.tx; x < obj.tx + obj.w; x++) for (let y = obj.ty; y < obj.ty + obj.h; y++) c.push({ x, y }); return c; };
// Slice.col is the 16-px screen strip index k: strip k covers world sx in [16k, 16k + 16). Strip boundaries are the
// tile half-diagonals (vertical lines through the tile corners, sx = 16 * (tx - ty)), so a tile diamond of column
// c = tx - ty (32 px wide) spans strips c - 1 and c, and strip k shows the cells of columns k and k + 1.
// Expected depth of strip k: max(x+y) over the footprint cells whose diamond lies in that strip.
const expectedDepthByStrip = obj => {
  const m = new Map();
  for (const { x, y } of cells(obj)) for (const k of [x - y - 1, x - y]) m.set(k, Math.max(m.get(k) ?? -Infinity, x + y));
  return m;
};

sTest('sliceSprite: each slice depth is the frontmost footprint cell in its screen strip', () => {
  const r = prng(4);
  for (let i = 0; i < 100; i++) {
    const obj = mkObj({ tx: ri(r, 0, 30), ty: ri(r, 0, 30), w: ri(r, 1, 4), h: ri(r, 1, 4) });
    const want = expectedDepthByStrip(obj);
    // a sprite exactly as wide as the footprint diamond, pivot on the north corner: every slice lies over the footprint
    const wpx = (obj.w + obj.h) * 16;
    const slices = S.sliceSprite(obj, mkSprite({ bounds: { x: 0, y: 0, w: wpx, h: 80 }, pivot: { x: obj.h * 16, y: 40 } }));
    assert.ok(slices.length > 0);
    for (const s of slices) {
      assert.ok(want.has(s.col), `slice strip ${s.col} not over the footprint`);
      assert.equal(s.depth, want.get(s.col));
      assert.ok(Number.isInteger(s.key));
      assert.ok(s.dx >= s.col * 16 && s.dx + s.sw <= s.col * 16 + 16, 'slice lies inside its strip');
    }
    for (const k of want.keys()) assert.ok(slices.some(s => s.col === k), `strip ${k} has no slice`);
  }
});

sTest('sliceSprite: art overhanging the footprint keeps the depth of the nearest footprint strip', () => {
  const obj = mkObj({ tx: 6, ty: 2, w: 2, h: 1 });
  const want = expectedDepthByStrip(obj), ks = [...want.keys()], kMin = Math.min(...ks), kMax = Math.max(...ks);
  // 160 px wide sprite centred on the footprint: overhangs well past both ends
  const slices = S.sliceSprite(obj, mkSprite());
  for (const s of slices) assert.equal(s.depth, want.get(Math.min(Math.max(s.col, kMin), kMax)), `strip ${s.col}`);
});

sTest('sliceSprite: slice key is consistent with sortKey for the object layer', () => {
  const obj = mkObj({ tx: 5, ty: 3, w: 3, h: 2 });
  for (const s of S.sliceSprite(obj, mkSprite())) assert.equal(s.key, D.sortKey(s.depth, 0, D.LAYER.OBJECT, s.col));
});

sTest('sliceSprite: slices are 16 px wide, and neighbouring columns do not overlap on screen', () => {
  const slices = S.sliceSprite(mkObj({ tx: 4, ty: 4, w: 3, h: 3 }), mkSprite());
  for (const s of slices) assert.ok(s.sw > 0 && s.sw <= 16, `sw ${s.sw}`);
  const byCol = [...slices].sort((a, b) => a.col - b.col);
  for (let i = 1; i < byCol.length; i++) assert.ok(byCol[i].dx >= byCol[i - 1].dx + byCol[i - 1].sw, 'overlapping dx');
});

sTest('sliceSprite: 2-tile-wide tower keeps each column\'s own depth', () => {
  // tile columns -1 (10,11) d21, 0 (10,10) d20 & (11,11) d22, 1 (11,10) d21 -> screen strips
  // -2: col -1 only -> 21; -1: cols -1,0 -> 22; 0: cols 0,1 -> 22; 1: col 1 only -> 21
  const tower = mkObj({ tx: 10, ty: 10, w: 2, h: 2, z: 96 });
  const slices = S.sliceSprite(tower, mkSprite({ bounds: { x: 0, y: 0, w: 64, h: 200 }, pivot: { x: 32, y: 180 } }));
  const depthOf = c => slices.filter(s => s.col === c).map(s => s.depth);
  assert.deepEqual([...new Set(depthOf(-2))], [21]);
  assert.deepEqual([...new Set(depthOf(-1))], [22]);
  assert.deepEqual([...new Set(depthOf(0))], [22]);
  assert.deepEqual([...new Set(depthOf(1))], [21]);
  assert.deepEqual([...new Set(slices.map(s => s.col))].sort((a, b) => a - b), [-2, -1, 0, 1]);
  // every slice of the same strip shares one depth (a spire does not take a different depth than its own strip)
  for (const c of [-2, -1, 0, 1]) assert.equal(new Set(depthOf(c)).size, 1);
});

sTest('actor in front of a house sorts after every slice of the house; behind it sorts before', () => {
  const r = prng(5);
  for (let i = 0; i < 200; i++) {
    const house = mkObj({ tx: ri(r, 5, 30), ty: ri(r, 5, 30), w: ri(r, 1, 3), h: ri(r, 1, 3) });
    const slices = S.sliceSprite(house, mkSprite());
    const maxD = Math.max(...slices.map(s => s.depth)), minD = Math.min(...slices.map(s => s.depth));
    const maxKey = Math.max(...slices.map(s => s.key)), minKey = Math.min(...slices.map(s => s.key));
    // in front: feet strictly beyond the frontmost cell diagonal, any column, any sub-position
    const colA = ri(r, -40, 40), subA = ri(r, 0, 3);
    const front = D.sortKey(maxD + 1, subA, D.LAYER.ACTOR, colA);
    assert.ok(front > maxKey, 'actor in front must sort after every slice');
    // behind: feet strictly before the rearmost diagonal
    const back = D.sortKey(minD - 1, subA, D.LAYER.ACTOR, colA);
    assert.ok(back < minKey, 'actor behind must sort before every slice');
  }
});

sTest('actorKey: sub-tile feet position and ordering against house slices', () => {
  assert.equal(typeof D.actorKey, 'function');
  const house = mkObj({ tx: 10, ty: 10, w: 2, h: 2 });
  const slices = S.sliceSprite(house, mkSprite());
  const maxKey = Math.max(...slices.map(s => s.key)), minKey = Math.min(...slices.map(s => s.key));
  // feet at world tile coords (fx, fy); an actor in front stands at x+y beyond the house's frontmost cell (11+11=22)
  assert.ok(D.actorKey(13.0, 13.0) > maxKey);
  assert.ok(D.actorKey(8.0, 8.0) < minKey);
  // quarter-tile resolution: moving feet forward never lowers the key
  let prev = -Infinity;
  for (let t = 0; t <= 8; t += 0.25) { const k = D.actorKey(5 + t / 2, 5 + t / 2); assert.ok(k >= prev); prev = k; }
});

sTest('fence run beside a house never outranks a house slice in the same column when it is behind it', () => {
  const r = prng(6);
  for (let i = 0; i < 100; i++) {
    const hx = ri(r, 10, 30), hy = ri(r, 10, 30);
    const house = mkObj({ tx: hx, ty: hy, w: 2, h: 2 });
    const len = ri(r, 2, 6);
    // fence run along x, one row behind (smaller y) the house: every fence tile is behind the house cell in its column
    const fence = mkObj({ id: 'f', kind: 'prop', model: 'fence', tx: hx - 2, ty: hy - 1, w: len, h: 1, z: 8, walk: 'edge', run: { dir: 'x', len, side: 'S' } });
    const hs = S.sliceSprite(house, mkSprite());
    const fs = S.sliceSprite(fence, mkSprite({ bounds: { x: 0, y: 0, w: 32 * len, h: 40 }, pivot: { x: 16, y: 30 } }));
    assert.ok(fs.length >= len, 'one slice per run tile at least');
    for (const f of fs) {
      const sameCol = hs.filter(h => h.col === f.col);
      if (!sameCol.length) continue;
      const frontHouseDepth = Math.max(...sameCol.map(h => h.depth));
      const fenceTileDepth = f.depth;
      if (fenceTileDepth < frontHouseDepth) for (const h of sameCol) assert.ok(f.key < h.key, `fence col ${f.col} d${f.depth} vs house d${h.depth}`);
    }
  }
});

// An edge lies between two tiles. Its slice takes the depth of the tile IN FRONT of the edge: a N/W edge of (x, y) is
// in front of nothing but (x, y) itself (depth x+y); a S/E edge of (x, y) is the N/W edge of (x, y+1) / (x+1, y),
// depth x+y+1. So an actor on the tile behind the edge is covered and an actor on the tile in front draws over it.
const edgeDepth = (x, y, side) => x + y + (side === 'S' || side === 'E' ? 1 : 0);
sTest('fence run: one slice per run tile, each at the depth of the tile in front of its edge (x and y runs)', () => {
  for (const [dir, side] of [['x', 'S'], ['x', 'N'], ['y', 'E'], ['y', 'W'], ['y', 'S']]) {
    const len = 5;
    const fence = mkObj({ id: 'f', kind: 'prop', model: 'fence', tx: 7, ty: 9, w: dir === 'x' ? len : 1, h: dir === 'y' ? len : 1, z: 8, walk: 'edge', run: { dir, len, side } });
    // a sprite wide enough to reach both ends of the run whichever way it runs on screen
    const slices = S.sliceSprite(fence, mkSprite({ bounds: { x: 0, y: 0, w: 64 * len, h: 40 }, pivot: { x: 32 * len, y: 30 } }));
    assert.ok(slices.length >= len, `at least one slice per run tile (${dir}/${side})`);
    const tileDepths = new Set(Array.from({ length: len }, (_, i) => (dir === 'x' ? edgeDepth(7 + i, 9, side) : edgeDepth(7, 9 + i, side))));
    const got = new Set(slices.map(s => s.depth));
    for (const d of tileDepths) assert.ok(got.has(d), `no slice at depth ${d} for run ${dir}/${side}`);
    for (const d of got) assert.ok(tileDepths.has(d), `unexpected depth ${d} for run ${dir}/${side}`);
    for (const s of slices) assert.equal(s.key, D.sortKey(s.depth, 0, D.LAYER.OBJECT, s.col));
  }
});

sTest('fence on the south edge: an actor behind it is covered, an actor in front draws over it', () => {
  assert.equal(typeof D.feetKey, 'function');
  // fence along x on the S edge of row y = 9, tiles x = 7..11; behind = row 9, in front = row 10.
  // Actor feet are float tiles with the tile centre at (tx + .5, ty + .5); stand slots sit left/right of the centre
  // along screen x, i.e. along the same x + y diagonal.
  const fence = mkObj({ id: 'f', kind: 'prop', model: 'fence', tx: 7, ty: 9, w: 5, h: 1, z: 8, walk: 'edge', run: { dir: 'x', len: 5, side: 'S' } });
  const slices = S.sliceSprite(fence, mkSprite({ bounds: { x: 0, y: 0, w: 160, h: 40 }, pivot: { x: 16, y: 30 } }));
  for (let x = 7; x <= 11; x++) {
    // S edge of (x, 9) = N edge of (x, 10): runs east from (x, 10)'s north corner (sx = 16 * (x - 10)), strip x - 10
    const s = slices.find(q => q.col === x - 10);
    assert.ok(s, `slice for run tile ${x}`);
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.75], [0.75, 0.25], [0.9, 0.9], [0.1, 0.1]]) {
      assert.ok(D.feetKey(x + fx, 9 + fy) < s.key, `actor behind the fence at (${x}+${fx}, 9+${fy}) must be covered`);
    }
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.75], [0.75, 0.25], [0.9, 0.9]]) {
      assert.ok(D.feetKey(x + fx, 10 + fy) > s.key, `actor in front of the fence at (${x}+${fx}, 10+${fy}) must draw over it`);
    }
  }
});

sTest('feetKey: an actor on the centre of a cell next to a house sorts by that cell against every overlapping slice', () => {
  const r = prng(7);
  for (let i = 0; i < 200; i++) {
    const house = mkObj({ tx: ri(r, 5, 30), ty: ri(r, 5, 30), w: ri(r, 1, 3), h: ri(r, 1, 3) });
    const wpx = (house.w + house.h) * 16;
    const slices = S.sliceSprite(house, mkSprite({ bounds: { x: 0, y: 0, w: wpx, h: 80 }, pivot: { x: house.h * 16, y: 40 } }));
    // ring of cells around the footprint: behind = x < tx or y < ty (and not in front), in front = x >= tx+w or y >= ty+h
    for (let x = house.tx - 1; x <= house.tx + house.w; x++) for (let y = house.ty - 1; y <= house.ty + house.h; y++) {
      const inside = x >= house.tx && x < house.tx + house.w && y >= house.ty && y < house.ty + house.h;
      if (inside) continue;
      const front = x >= house.tx + house.w || y >= house.ty + house.h, back = x < house.tx || y < house.ty;
      if (front === back) continue; // the two side corners: neither in front nor behind
      const k = D.feetKey(x + 0.5, y + 0.5), c = x - y;
      // the actor (16 px wide, centred on its tile's centre column sx = 16c) overlaps strips c - 1 and c
      for (const s of slices.filter(q => q.col === c - 1 || q.col === c)) {
        if (front) assert.ok(k > s.key, `actor in front at (${x},${y}) vs strip ${s.col} d${s.depth}`);
        else assert.ok(k < s.key, `actor behind at (${x},${y}) vs strip ${s.col} d${s.depth}`);
      }
    }
  }
});
