// Slot registry (N4, design §2.3). Slots come from world.anchors (if present) and every object's anchors.
// A slot is one sub-tile position on a tile (sub 0..3; §2.3 uses two per tile, left and right of the centre), so
// several actors share a tile without overlapping. An anchor's own `sub` is honoured; a stand anchor without one
// yields subs 0 and 1. Anchors on blocked or covered (cover != 0) tiles yield no slot (§2.4).
// claim(anchorId, actorId): anchorId is a slot id, or an object id (or 'world') = its first free slot in
// stand, work, sit, vend order.
// slot = { id, tx, ty, sub: 0..3, kind: 'stand'|'work'|'sit'|'vend' }
import { nearIndex } from '../core/near-index.js';

const KINDS = ['stand', 'work', 'sit', 'vend'];

export function createSlots(world) {
  const slots = new Map();      // id -> slot (insertion order = deterministic)
  const owner = new Map();      // slot id -> actorId
  const held = new Map();       // actorId -> slot id
  const byObj = new Map();      // object id -> [slot]
  const grid = world?.grid;
  const usable = (tx, ty) => !grid || typeof grid.isBlocked !== 'function'
    || (!grid.isBlocked(tx, ty) && !(grid.get?.('cover', tx, ty) > 0));

  const add = (objId, kind, tx, ty, sub) => {
    const id = `${objId}:${kind}:${tx},${ty}:${sub}`;
    if (slots.has(id)) return;
    const s = { id, tx, ty, sub, kind };
    slots.set(id, s);
    if (!byObj.has(objId)) byObj.set(objId, []);
    byObj.get(objId).push(s);
  };
  const ingest = (objId, anchors) => {
    if (!anchors) return;
    for (const kind of KINDS) {
      for (const s of anchors[kind] || []) {
        if (!Number.isFinite(s.tx) || !Number.isFinite(s.ty) || !usable(s.tx, s.ty)) continue;
        if (kind === 'stand' && !Number.isFinite(s.sub)) { add(objId, kind, s.tx, s.ty, 0); add(objId, kind, s.tx, s.ty, 1); }
        else add(objId, kind, s.tx, s.ty, Math.min(3, Math.max(0, s.sub | 0)));
      }
    }
  };
  if (world?.anchors && typeof world.anchors === 'object') {
    const a = world.anchors;
    if (Array.isArray(a)) for (const e of a) ingest(e.id ?? 'world', e.anchors ?? e);
    else ingest('world', a);
  }
  if (world?.objects) for (const o of world.objects.values()) ingest(o.id, o.anchors);

  // Spill slots (no cap, every agent drawn): when a yard has no free stand slot nearby, an actor takes a sub-slot on a
  // free walkable tile beside it. Eligible: in bounds, cost <= 2, no occupancy or cover, not within one tile of any door
  // (never blocking a door), not a tile that carries a regular slot. Order is by distance then (ty, tx): deterministic.
  // Ids are `spill:tx,ty:sub`, so a rebuilt registry can recreate a held spill slot from its id alone.
  const SPILL_SUBS = [0, 1], SPILL_RADIUS = 24;
  let barred = null;
  const isBarred = (tx, ty) => {
    if (!barred) {
      barred = new Set();
      for (const sl of slots.values()) if (!sl.spill) barred.add(`${sl.tx},${sl.ty}`);
      for (const o of world?.objects?.values?.() ?? []) {
        const d = o?.door;
        if (!d || !Number.isFinite(d.tx)) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) barred.add(`${d.tx + dx},${d.ty + dy}`);
      }
    }
    return barred.has(`${tx},${ty}`);
  };
  const spillTile = (tx, ty) => !!grid && typeof grid.get === 'function' && (!grid.inBounds || grid.inBounds(tx, ty))
    && grid.get('cost', tx, ty) <= 2 && grid.get('occ', tx, ty) === 0 && !(grid.get('cover', tx, ty) > 0) && !isBarred(tx, ty);
  const spillSlot = (tx, ty, sub) => {
    const id = `spill:${tx},${ty}:${sub}`;
    let sl = slots.get(id);
    if (!sl) { sl = { id, tx, ty, sub, kind: 'spill', spill: true }; slots.set(id, sl); }
    return sl;
  };
  const parseSpill = id => {
    const m = /^spill:(-?\d+),(-?\d+):(\d)$/.exec(id);
    return m && spillTile(+m[1], +m[2]) ? spillSlot(+m[1], +m[2], +m[3]) : null;
  };

  const resolve = (ref, actorId) => {
    const key = typeof ref === 'string' ? ref : ref && ref.id;
    if (key == null) return null;
    if (slots.has(key)) return slots.get(key);
    if (typeof key === 'string' && key.startsWith('spill:')) return parseSpill(key);
    const list = byObj.get(key);
    if (!list) return null;
    const mine = held.get(actorId);
    return list.find(s => s.id === mine) ?? list.find(s => !owner.has(s.id)) ?? null;   // keep own slot (idempotent)
  };

  let near = null;
  const byKind = () => {
    const m = new Map();
    for (const sl of slots.values()) { if (sl.spill) continue; if (!m.has(sl.kind)) m.set(sl.kind, []); m.get(sl.kind).push(sl); }
    return new Map([...m].map(([k, list]) => [k, nearIndex(list)]));
  };
  const free = sl => !owner.has(sl.id), idFirst = (a, b) => a.id < b.id;

  return {
    claim(anchorId, actorId) {
      const s = resolve(anchorId, actorId);
      if (!s) return null;
      const cur = owner.get(s.id);
      if (cur !== undefined && cur !== actorId) return null;
      if (cur === actorId) return s;                       // idempotent
      this.release(actorId);                               // one slot per actor
      owner.set(s.id, actorId);
      held.set(actorId, s.id);
      return s;
    },
    release(actorId) {
      const id = held.get(actorId);
      if (id === undefined) return;
      held.delete(actorId);
      if (owner.get(id) === actorId) owner.delete(id);
    },
    nearestFree(x, y, kind) {
      // anchor kinds: a per-kind nearest-point index over the regular slots (fixed once built; spill slots are kind
      // 'spill'), same answer as the scan below: least distance, then least id
      if (kind && kind !== 'spill' && Number.isFinite(x) && Number.isFinite(y)) {
        near ||= byKind();
        return near.get(kind)?.nearest(x, y, free, idFirst) ?? null;
      }
      let best = null, bd = Infinity;
      for (const s of slots.values()) {
        if ((kind && s.kind !== kind) || owner.has(s.id)) continue;
        const dx = s.tx - x, dy = s.ty - y, d = dx * dx + dy * dy;
        if (d < bd || (d === bd && s.id < best.id)) { best = s; bd = d; }
      }
      return best;
    },
    /** The nearest free spill sub-slot to tile (x, y), claimed for actorId; null when none within the search radius. */
    claimSpill(x, y, actorId) {
      const cx = Math.floor(x), cy = Math.floor(y), cand = [];
      for (let dy = -SPILL_RADIUS; dy <= SPILL_RADIUS; dy++) for (let dx = -SPILL_RADIUS; dx <= SPILL_RADIUS; dx++) {
        if (spillTile(cx + dx, cy + dy)) cand.push([dx * dx + dy * dy, cy + dy, cx + dx]);
      }
      cand.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      for (const [, ty, tx] of cand) for (const sub of SPILL_SUBS) {
        const sl = spillSlot(tx, ty, sub);
        if (!owner.has(sl.id)) return this.claim(sl.id, actorId);
      }
      return null;
    },
    // helpers beyond the seam
    all: () => [...slots.values()],
    /** an object's own slots, in registry order (the ones all() lists with ids `${objId}:...`) */
    ofObject: objId => byObj.get(objId) ?? [],
    get: id => slots.get(id) || (typeof id === 'string' && id.startsWith('spill:') ? parseSpill(id) : null),
    heldBy: actorId => (held.has(actorId) ? slots.get(held.get(actorId)) : null),
    ownerOf: id => owner.get(id) ?? null,
  };
}
