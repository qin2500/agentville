// Stable ordering: rows that jump around are hard to track. Every list breaks ties
// by a persistent first-seen rank, sections order by when an agent entered them (as this browser saw
// it), and while the user is engaged with the panel the DOM order is held and only contents update.
import { store } from './ui.js';

const KEY = 'va.rank';
const saved = store.get(KEY, null);
const ranks = new Map(Object.entries(saved?.ids || {}));
let next = saved?.next || 0;
const entered = new Map(); // id -> { bucket, at }: when this browser saw it enter its bucket
let seeded = ranks.size > 0, firstIngest = true;

// Called with every poll's agents. New agents get the next rank; the very first time, ranks are
// seeded from the current list by last activity (oldest first), so the order is deterministic.
export function observe(agents) {
  let changed = false;
  const fresh = agents.filter(a => !ranks.has(a.id));
  if (fresh.length) {
    const seed = !seeded ? [...fresh].sort((a, b) => (a.lastActivityAt || 0) - (b.lastActivityAt || 0) || (a.id < b.id ? -1 : 1)) : fresh;
    for (const a of seed) ranks.set(a.id, next++);
    seeded = changed = true;
  }
  const now = Date.now();
  for (const a of agents) {
    const e = entered.get(a.id);
    // First poll: trust the server's `since`. Later: a new agent or a bucket change enters "now",
    // so it lands at the end of its section instead of somewhere in the middle.
    if (!e) entered.set(a.id, { bucket: a.bucket, at: firstIngest ? a.since || 0 : Math.max(now, a.since || 0) });
    else if (e.bucket !== a.bucket) entered.set(a.id, { bucket: a.bucket, at: now });
  }
  firstIngest = false;
  if (changed) {
    // ponytail: grows with every agent ever seen; drop the oldest past 5000 ids.
    if (ranks.size > 5000) [...ranks.keys()].slice(0, ranks.size - 5000).forEach(k => ranks.delete(k));
    store.set(KEY, { next, ids: Object.fromEntries(ranks) });
  }
}
export const rank = a => ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER;
export const enteredAt = a => entered.get(a.id)?.at ?? a.since ?? 0;
export const byRank = (a, b) => rank(a) - rank(b);

// Reorder `parent`'s children to `nodes`. Normally exact; while `hold` is set, existing children keep
// their relative order and only new nodes are placed (right after their predecessor in `nodes`), so
// rows never jump under the user's pointer, while expanding a group still opens in place.
export function syncNodes(parent, nodes, hold) {
  let order = nodes;
  if (hold) {
    const want = new Set(nodes);
    order = [...parent.childNodes].filter(c => want.has(c));
    const have = new Set(order);
    nodes.forEach((n, i) => {
      if (have.has(n)) return;
      let j = i - 1;
      while (j >= 0 && !have.has(nodes[j])) j--;
      order.splice(j < 0 ? 0 : order.indexOf(nodes[j]) + 1, 0, n);
      have.add(n);
    });
  }
  const want = new Set(order);
  for (const c of [...parent.childNodes]) if (!want.has(c)) c.remove();
  order.forEach((n, i) => { if (parent.childNodes[i] !== n) parent.insertBefore(n, parent.childNodes[i] || null); });
}
