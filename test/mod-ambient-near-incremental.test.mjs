// mods/agentville.fantasy/ambient/near.js, kept across steps (PERF M7 asim): after any mix of moves, joins, leaves, ids
// replaced in place and non-finite positions, every bucket holds exactly what a from-scratch index of the store holds
// (same actors, order numbers that sort like store order), and firstWithin answers what a store-order scan answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tileIndex, onTile, firstWithin } from '../mods/agentville.fantasy/ambient/near.js';

let st = 21;
const rnd = () => { st = (st * 1103515245 + 12345) >>> 0; return st / 4294967296; };

/** The reference: bucket -> actors in store order, from a full scan. */
function reference(actors) {
  const cells = new Map();
  for (const o of actors.values()) {
    const tx = Math.floor(o.x), ty = Math.floor(o.y);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
    const k = `${tx},${ty}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(o);
  }
  return cells;
}
function assertMatches(actors, ix, where) {
  const ref = reference(actors);
  const order = new Map([...actors.values()].map((o, i) => [o, i]));
  let n = 0;
  for (const [k, want] of ref) {
    const [tx, ty] = k.split(',').map(Number);
    const l = onTile(ix, tx, ty), got = [];
    for (let i = 0; i < l.length; i += 2) got.push([l[i], l[i + 1]]);
    got.sort((p, q) => p[1] - q[1]);
    assert.deepEqual(got.map(p => p[0].id), want.map(o => o.id), `${where}: bucket ${k}`);
    for (let i = 1; i < got.length; i++) assert.ok(order.get(got[i - 1][0]) < order.get(got[i][0]), `${where}: order numbers follow store order in ${k}`);
    n += got.length;
  }
  let total = 0;
  for (const l of ix.cells.values()) total += l.length / 2;
  assert.equal(total, n, `${where}: no stale entries`);
}

test('the kept index equals a rebuild after moves, joins, leaves and in-place replacements', () => {
  const actors = new Map();
  let next = 0;
  const join = () => { const id = `a${next++}`; actors.set(id, { id, kind: rnd() < 0.3 ? 'cart' : 'folk', x: rnd() * 10, y: rnd() * 10 }); };
  for (let i = 0; i < 200; i++) join();
  for (let tick = 0; tick < 300; tick++) {
    for (const o of actors.values()) if (rnd() < 0.1) { o.x += rnd() * 2 - 1; o.y += rnd() * 2 - 1; }
    if (rnd() < 0.3) join();
    if (rnd() < 0.3) { const ids = [...actors.keys()]; actors.delete(ids[Math.floor(rnd() * ids.length)]); }
    if (tick % 37 === 5) { const ids = [...actors.keys()]; const id = ids[Math.floor(rnd() * ids.length)]; actors.set(id, { ...actors.get(id) }); }  // replaced in place
    if (tick % 41 === 7) { const o = [...actors.values()][3]; o.x = NaN; }
    if (tick % 41 === 9) { const o = [...actors.values()][3]; o.x = 4.5; }
    const ctx = { actors, tick };
    const ix = tileIndex(ctx);
    assertMatches(actors, ix, `tick ${tick}`);
    for (let q = 0; q < 20; q++) {
      const x = rnd() * 12 - 1, y = rnd() * 12 - 1, ok = o => o.kind !== 'cart';
      let want = null;
      for (const o of actors.values()) if (ok(o) && Math.hypot(o.x - x, o.y - y) < 1) { want = o; break; }
      assert.equal(firstWithin(ctx, x, y, 1, ok), want, `tick ${tick}: firstWithin at ${x.toFixed(2)},${y.toFixed(2)}`);
    }
  }
});

test('same tick and size: the same index; a store change within a tick is picked up', () => {
  const actors = new Map([['a', { id: 'a', x: 1.5, y: 1.5 }], ['b', { id: 'b', x: 2.5, y: 1.5 }]]);
  const ix = tileIndex({ actors, tick: 1 });
  assert.equal(tileIndex({ actors, tick: 1 }), ix);
  actors.set('c', { id: 'c', x: 1.2, y: 1.7 });
  const ix2 = tileIndex({ actors, tick: 1 });
  assert.notEqual(ix2, ix, 'a new store size refreshes');
  assert.deepEqual(onTile(ix2, 1, 1).filter((_, i) => i % 2 === 0).map(o => o.id), ['a', 'c']);
});
