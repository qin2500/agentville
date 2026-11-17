// Tokens (M5 P3): one sim actor per item that holds a venue berth. Pure, no DOM, no clock of its own.
// The host (world-sim) calls sync(berths, states, now) on every snapshot:
//   berths: itemId -> { venue, berth, tx, ty, face, model?, tint?, state? } (world/venue.js venueAssignments().prs);
//   states: Map itemId -> WorldInput PR state (an entry's own `state` wins).
// Rules (deterministic: items are visited in id order, every counter is per store):
//   - an entry whose state is 'merged' or 'closed' makes no token (history never arrives as a fresh token);
//   - any other entry gets the actor `token:<itemId>` (kind 'token') at its berth tile centre, created through
//     host.spawn(spec) (which runs the kind's behaviour init). Fields: item, venue, berth, tx, ty, face, model, tint,
//     berthFace, itemState, gridFree: true (the sim does not grid-check its paths), seq (creation order, from 1: oldest first);
//   - an entry that moved to another berth updates venue / berth / tx / ty / face in place (the behaviour re-places);
//   - a token whose entry is gone, or whose state became 'merged' / 'closed', departs: a.depart = { since: now,
//     seq: n } (n counts departures from 1). The kind's behaviour takes it from there and removes the actor by setting
//     `a.leaving` (the sim fades it out and drops it). A token kind with no behaviour leaves at once (host.leave);
//   - a departing token whose entry is held again returns to its berth unless its behaviour set a.depart.locked.
// view: { get(itemId) -> live token actor | null, list() -> live token actors by seq } (ctx.tokens for behaviours).
export const TOKEN_KIND = 'token';
export const tokenId = item => `token:${item}`;
const GONE = new Set(['merged', 'closed']);

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (plain(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const fin = v => (Number.isFinite(v) ? v : 0);

/**
 * @param {{ actors: Map<string, object>, spawn: (spec: object) => object, leave: (a: object) => void,
 *   hasBehaviour?: (kind: string) => boolean }} host
 */
export function createTokens(host) {
  const byItem = new Map();            // itemId -> actor id
  let made = 0, departed = 0;

  const live = item => {
    const id = byItem.get(item);
    const a = id != null ? host.actors.get(id) : null;
    if (!a || a.kind !== TOKEN_KIND) { if (id != null) byItem.delete(item); return null; }
    return a;
  };
  const place = (a, b) => {
    const v = own(b, 'venue'), berth = own(b, 'berth');
    const tx = fin(own(b, 'tx')), ty = fin(own(b, 'ty')), face = fin(own(b, 'face'));
    if (a.venue !== v || a.berth !== berth || a.tx !== tx || a.ty !== ty || a.berthFace !== face) {
      a.venue = v; a.berth = berth; a.tx = tx; a.ty = ty; a.berthFace = face;
    }
    const m = own(b, 'model'), t = own(b, 'tint');
    a.model = typeof m === 'string' ? m : a.model ?? null;
    a.tint = typeof t === 'string' ? t : a.tint ?? null;
  };

  /** @returns {{ added: string[], departed: string[] }} item ids, in id order */
  function sync(berths, states, now = 0) {
    const out = { added: [], departed: [] };
    const held = new Map();
    for (const item of Object.keys(plain(berths) ? berths : {}).sort()) {
      const b = own(berths, item);
      if (!plain(b)) continue;
      const st = own(b, 'state') ?? states?.get?.(item);
      if (GONE.has(st)) continue;
      held.set(item, { b, st });
    }
    // tokens first (departures), then new ones, both in id order
    for (const item of [...byItem.keys()].sort()) {
      const a = live(item);
      if (!a) continue;
      const h = held.get(item);
      if (h) {
        if (a.depart && !a.depart.locked) a.depart = null;
        if (!a.depart) { place(a, h.b); a.itemState = h.st ?? null; }
        continue;
      }
      if (a.depart || a.leaving != null) continue;
      a.depart = { since: now, seq: ++departed };
      out.departed.push(item);
      if (host.hasBehaviour && !host.hasBehaviour(TOKEN_KIND)) host.leave(a);
    }
    for (const [item, { b, st }] of held) {
      if (live(item) || host.actors.has(tokenId(item))) continue;
      const tx = fin(own(b, 'tx')), ty = fin(own(b, 'ty'));
      const spec = { id: tokenId(item), kind: TOKEN_KIND, item, x: tx + 0.5, y: ty + 0.5, gridFree: true, seq: ++made, depart: null, itemState: st ?? null };
      place(spec, b);
      const a = host.spawn(spec);
      byItem.set(item, a.id);
      out.added.push(item);
    }
    return out;
  }

  const view = Object.freeze({
    get: item => live(item),
    list: () => [...byItem.keys()].map(live).filter(Boolean).sort((p, q) => p.seq - q.seq),
  });
  return { sync, view };
}
