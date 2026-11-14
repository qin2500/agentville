// Slot registry (N4, design §2.3). Slots come from world.anchors (if present) and every object's anchors.
// A slot is one sub-tile position on a tile (sub 0..3; §2.3 uses two per tile, left and right of the centre), so
// several actors share a tile without overlapping. An anchor's own `sub` is honoured; a stand anchor without one
// yields subs 0 and 1. Anchors on blocked or covered (cover != 0) tiles yield no slot (§2.4).
// claim(anchorId, actorId): anchorId is a slot id, or an object id (or 'world') = its first free slot in
// stand, work, sit, vend order.
// slot = { id, tx, ty, sub: 0..3, kind: 'stand'|'work'|'sit'|'vend' }
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

  const resolve = (ref, actorId) => {
    const key = typeof ref === 'string' ? ref : ref && ref.id;
    if (key == null) return null;
    if (slots.has(key)) return slots.get(key);
    const list = byObj.get(key);
    if (!list) return null;
    const mine = held.get(actorId);
    return list.find(s => s.id === mine) ?? list.find(s => !owner.has(s.id)) ?? null;   // keep own slot (idempotent)
  };

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
      let best = null, bd = Infinity;
      for (const s of slots.values()) {
        if ((kind && s.kind !== kind) || owner.has(s.id)) continue;
        const dx = s.tx - x, dy = s.ty - y, d = dx * dx + dy * dy;
        if (d < bd || (d === bd && s.id < best.id)) { best = s; bd = d; }
      }
      return best;
    },
    // helpers beyond the seam
    all: () => [...slots.values()],
    get: id => slots.get(id) || null,
    heldBy: actorId => (held.has(actorId) ? slots.get(held.get(actorId)) : null),
    ownerOf: id => owner.get(id) ?? null,
  };
}
