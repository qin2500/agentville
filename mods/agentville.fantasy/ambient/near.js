// Per-step tile index of the sim's actors (PERF M7 psim), for the "who is on this tile / next to me" questions
// the ambient behaviours ask every step (townsfolk yield to carts, carts yield to pedestrians, chickens hop from walkers).
// A full scan of ctx.actors per asking actor is O(n^2) per step: on a 1,000-agent world (~2,100 actors) it was over half
// of the sim tick. The index buckets every actor by its tile once per sim step and answers from the few buckets asked.
//
// Exactness: the world-sim only moves actors in its movement system, after every behaviour has run, so positions are
// constant for the whole behaviour pass of one step; the index is keyed by (actor store, ctx.tick, store size) and
// brought up to date on the next step (incrementally, see refresh below). Buckets hold actor records, not copies: flags / fade / alpha are read live by the caller.
// Without a numeric ctx.tick (a hand-made ctx in a unit test) there is no index and callers scan, as before.
// Pure: no DOM, imports nothing from the engine.

const OFF = 1 << 15;
const keyOf = (tx, ty) => (tx + OFF) * 65536 + (ty + OFF);
const CACHE = new WeakMap();
const NONE = Object.freeze([]);

/** The step's index of ctx.actors, or null when the ctx has no actor store or no numeric tick. */
export function tileIndex(ctx) {
  const actors = ctx?.actors;
  if (!actors || typeof actors.values !== 'function' || !Number.isFinite(ctx.tick)) return null;
  let e = CACHE.get(actors);
  if (e && e.ix.tick === ctx.tick && e.ix.size === actors.size) return e.ix;
  if (!e) { e = { cells: new Map(), recs: new Map(), seq: 0, stamp: 0, count: 0, ix: null }; CACHE.set(actors, e); }
  if (!refresh(e, actors)) { e.cells = new Map(); e.recs = new Map(); e.seq = 0; e.count = 0; refresh(e, actors); }
  e.ix = { tick: ctx.tick, size: actors.size, cells: e.cells };
  return e.ix;
}

// Incremental (PERF M7 asim): most actors (settled agents, dwelling folk) keep their tile from one step to the
// next, so the index is kept across steps and only the actors whose tile changed move bucket. Each actor keeps the order
// number it got when first seen; store order is insertion order and new actors are appended, so those numbers stay in
// store order (refresh checks it and the index is rebuilt from scratch when they do not, e.g. an id replaced in place).
// The buckets then hold exactly what a rebuild would: every finite actor in its tile's bucket with an order number that
// sorts like its store position (firstWithin takes the lowest; onTile callers only ask "is there one").
const NOWHERE = -1;
function cellAdd(cells, k, o, s) {
  const l = cells.get(k);
  if (l) l.push(o, s); else cells.set(k, [o, s]);
}
function cellDrop(cells, k, o) {
  const l = cells.get(k);
  if (!l) return;
  for (let i = 0; i < l.length; i += 2) {
    if (l[i] !== o) continue;
    if (l.length === 2) cells.delete(k); else l.splice(i, 2);
    return;
  }
}
/** Brings the kept index up to the store. False when the order numbers no longer follow store order (rebuild). */
function refresh(e, actors) {
  const cells = e.cells, recs = e.recs, stamp = ++e.stamp;
  let fresh = 0, last = 0;
  for (const o of actors.values()) {
    let r = recs.get(o);
    if (r === undefined) { r = { k: NOWHERE, s: ++e.seq, st: 0 }; recs.set(o, r); fresh++; }
    if (r.s < last) return false;
    last = r.s; r.st = stamp;
    const tx = Math.floor(o.x), ty = Math.floor(o.y);
    // a scan never matches a non-finite position either (NaN compares false)
    const k = Number.isFinite(tx) && Number.isFinite(ty) ? keyOf(tx, ty) : NOWHERE;
    if (k === r.k) continue;
    if (r.k !== NOWHERE) cellDrop(cells, r.k, o);
    if (k !== NOWHERE) cellAdd(cells, k, o, r.s);
    r.k = k;
  }
  if (e.count + fresh !== actors.size) {             // some actors left the store: drop them
    for (const [o, r] of recs) if (r.st !== stamp) { if (r.k !== NOWHERE) cellDrop(cells, r.k, o); recs.delete(o); }
  }
  e.count = actors.size;
  return true;
}

/** Flat [actor, order, actor, order, ...] of the actors on tile (tx, ty) at the start of this step. */
export function onTile(ix, tx, ty) { return ix.cells.get(keyOf(tx, ty)) ?? NONE; }

/**
 * The first actor in store order (what a scan of ctx.actors returns) that passes `ok` and lies within `r` tiles
 * (Euclidean, strictly less) of (x, y); null when none. Uses the index when there is one, else scans.
 */
export function firstWithin(ctx, x, y, r, ok) {
  const ix = tileIndex(ctx);
  if (!ix) {
    for (const o of ctx?.actors?.values?.() ?? []) if (ok(o) && Math.hypot(o.x - x, o.y - y) < r) return o;
    return null;
  }
  const R = Math.ceil(r), cx = Math.floor(x), cy = Math.floor(y);
  let best = null, bestSeq = Infinity;
  for (let ty = cy - R; ty <= cy + R; ty++) for (let tx = cx - R; tx <= cx + R; tx++) {
    const l = ix.cells.get(keyOf(tx, ty));
    if (!l) continue;
    for (let i = 0; i < l.length; i += 2) {
      const o = l[i], s = l[i + 1];
      if (s < bestSeq && ok(o) && Math.hypot(o.x - x, o.y - y) < r) { best = o; bestSeq = s; }
    }
  }
  return best;
}
