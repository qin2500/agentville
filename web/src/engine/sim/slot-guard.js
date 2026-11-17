// Sub-slot guard (M3). Wraps a nav slot registry (nav/slots.js) so that no two actors ever hold slots
// at the same sub-slot position (tx, ty, sub). The registry keys slots by `${objId}:${kind}:${tx},${ty}:${sub}`, so
// two objects (or two kinds) with anchors on one tile give distinct slot ids at one position; this wrapper treats such
// a position as taken once any of its slots has an owner. It is stateless over the inner registry (owners are read
// from ownerOf), so claims made straight on the inner registry are still seen.
// A registry without all()/ownerOf (test fakes) passes through unchanged.

import { nearIndex } from '../core/near-index.js';

const keyOf = s => `${s.tx},${s.ty},${s.sub ?? -1}`;

export function guardSlots(inner) {
  if (!inner || inner.__guarded) return inner;
  if (typeof inner.all !== 'function' || typeof inner.ownerOf !== 'function') return inner;
  let list = null, atPos = null, near = null;   // lazy indexes (slots never change for a registry)
  const index = () => {
    if (list) return;
    list = inner.all();
    atPos = new Map();
    for (const s of list) { const k = keyOf(s); if (!atPos.has(k)) atPos.set(k, []); atPos.get(k).push(s.id); }
  };
  // per kind, a nearest-point index over `list` (PERF M7): nearestFree looks at the slots round the point, not all of them
  const nearOf = kind => {
    near ||= new Map();
    let ix = near.get(kind);
    if (!ix) { ix = nearIndex(list.filter(s => s.kind === kind)); near.set(kind, ix); }
    return ix;
  };
  const freeHere = s => inner.ownerOf(s.id) == null && !taken(s, null), idFirst = (a, b) => a.id < b.id;
  /** the position of slot s is held by someone other than actorId (null = anyone) */
  const taken = (s, actorId) => {
    index();
    for (const id of atPos.get(keyOf(s)) || []) {
      const o = inner.ownerOf(id);
      if (o != null && o !== actorId) return true;
    }
    return false;
  };
  const get = id => (typeof inner.get === 'function' ? inner.get(id) : null);

  const api = {
    __guarded: true,
    inner,
    claim(ref, actorId) {
      const key = typeof ref === 'string' ? ref : ref && ref.id;
      if (key == null) return null;
      const s = get(key);
      if (s) return taken(s, actorId) ? null : inner.claim(key, actorId);
      // an object id: its first slot whose position is free (keeps the actor's own slot there)
      index();
      const prefix = `${key}:`;
      const mine = inner.heldBy?.(actorId);
      if (mine && mine.id.startsWith(prefix)) return mine;
      for (const c of list) {
        if (!c.id.startsWith(prefix) || inner.ownerOf(c.id) != null || taken(c, actorId)) continue;
        return inner.claim(c.id, actorId);
      }
      return null;
    },
    release: actorId => inner.release(actorId),
    nearestFree(x, y, kind) {
      index();
      if (kind && Number.isFinite(x) && Number.isFinite(y)) return nearOf(kind).nearest(x, y, freeHere, idFirst);
      let best = null, bd = Infinity;
      for (const s of list) {
        if ((kind && s.kind !== kind) || inner.ownerOf(s.id) != null) continue;
        const dx = s.tx - x, dy = s.ty - y, d = dx * dx + dy * dy;
        if (d > bd || (d === bd && s.id >= best.id)) continue;
        if (taken(s, null)) continue;
        best = s; bd = d;
      }
      return best;
    },
    claimSpill: (x, y, actorId) => (typeof inner.claimSpill === 'function' ? inner.claimSpill(x, y, actorId) : null),
    all: () => inner.all(),
    ofObject: typeof inner.ofObject === 'function' ? objId => inner.ofObject(objId) : undefined,
    get,
    heldBy: actorId => inner.heldBy?.(actorId) ?? null,
    ownerOf: id => inner.ownerOf(id),
    /** is the sub-slot position (tx, ty, sub) free for actorId? */
    positionFree: (tx, ty, sub, actorId = null) => !taken({ tx, ty, sub }, actorId),
  };
  return api;
}
