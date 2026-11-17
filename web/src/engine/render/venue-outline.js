// The hover outline of a venue (renderer: host panel hover). Pure, no DOM.
//
//   venueOutlines(objs) -> Array<{ tx, ty, w, h }>
//     The venue-kind objects of the list (a plan's walkable decks), merged per venue into one footprint per run: objects
//     of one venue in the same column span (tx, w) whose rows touch (one ty starts where the last ends) become one rect.
//     A long pier planked in sections outlines as one pier, not as a stack of boxes.

/** @param {Iterable<{ kind: string, tx: number, ty: number, w?: number, h?: number, data?: { venue?: string } }>} objs */
export function venueOutlines(objs) {
  const cols = new Map();
  for (const o of objs || []) {
    if (!o || o.kind !== 'venue' || !Number.isFinite(o.tx) || !Number.isFinite(o.ty)) continue;
    const w = o.w || 1, h = o.h || 1, k = `${o.data?.venue ?? ''}|${o.tx}|${w}`;
    let list = cols.get(k);
    if (!list) cols.set(k, list = []);
    list.push({ tx: o.tx, ty: o.ty, w, h });
  }
  const out = [];
  for (const list of cols.values()) {
    list.sort((a, b) => a.ty - b.ty);
    let cur = null;
    for (const r of list) {
      if (cur && r.ty <= cur.ty + cur.h) { cur.h = Math.max(cur.h, r.ty + r.h - cur.ty); continue; }
      if (cur) out.push(cur);
      cur = { ...r };
    }
    if (cur) out.push(cur);
  }
  return out;
}
