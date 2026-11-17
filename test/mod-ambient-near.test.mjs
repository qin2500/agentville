// mods/agentville.fantasy/ambient/near.js: the per-step tile index answers exactly what a scan of ctx.actors answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tileIndex, onTile, firstWithin } from '../mods/agentville.fantasy/ambient/near.js';

let st = 9;
const rnd = () => { st = (st * 1103515245 + 12345) >>> 0; return st / 4294967296; };
const crowd = n => new Map(Array.from({ length: n }, (_, i) => [`a${i}`, { id: `a${i}`, kind: i % 3 ? 'folk' : 'cart', x: rnd() * 12 - 2, y: rnd() * 12 - 2 }]));

test('firstWithin: same actor as a store-order scan, with and without the index', () => {
  const actors = crowd(300);
  actors.set('nan', { id: 'nan', kind: 'folk', x: NaN, y: 3 });
  const scan = (x, y, r, ok) => { for (const o of actors.values()) if (ok(o) && Math.hypot(o.x - x, o.y - y) < r) return o; return null; };
  for (let k = 0; k < 400; k++) {
    const x = rnd() * 14 - 3, y = rnd() * 14 - 3, ok = o => o.kind !== 'cart';
    const want = scan(x, y, 1, ok);
    assert.equal(firstWithin({ actors, tick: 1 }, x, y, 1, ok), want, `indexed at ${x},${y}`);
    assert.equal(firstWithin({ actors }, x, y, 1, ok), want, `scan fallback at ${x},${y}`);
  }
});

test('onTile buckets every finite actor by its tile; the index is per (store, tick, size)', () => {
  const actors = crowd(50);
  const ix = tileIndex({ actors, tick: 3 });
  let n = 0;
  for (const a of actors.values()) {
    const l = onTile(ix, Math.floor(a.x), Math.floor(a.y));
    assert.ok(l.includes(a)); n++;
  }
  assert.equal([...ix.cells.values()].reduce((s, l) => s + l.length / 2, 0), n);
  assert.equal(tileIndex({ actors, tick: 3 }), ix, 'same step: reused');
  assert.notEqual(tileIndex({ actors, tick: 4 }), ix, 'next step: rebuilt');
  assert.equal(tileIndex({ actors }), null, 'no numeric tick: no index (callers scan)');
});
