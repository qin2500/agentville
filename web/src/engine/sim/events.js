// World events (S4): a tiny queue plus a pure diff of two WorldInputs. Payloads hold only opaque ids and project keys.
export const EVENT_TYPES = Object.freeze(['merge', 'found', 'tierUp', 'arrive', 'leave']);
const KNOWN = new Set(EVENT_TYPES);

export function createEvents() {
  let queue = [];
  return {
    emit(type, payload = {}) {
      if (!KNOWN.has(type)) return false;
      queue.push({ type, ...payload });
      return true;
    },
    drain() { const out = queue; queue = []; return out; },
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const TYPE_ORDER = new Map(EVENT_TYPES.map((t, i) => [t, i]));

/**
 * Derive events from two WorldInput objects.
 * tiers = { prev: {projectKey: tier}, next: {projectKey: tier}, order?: [names low->high] }; tier is a number, or a name found in `order`.
 * No prev input (first snapshot) yields no events. Output sorted by type then id/key.
 */
export function diffInputs(prev, next, { tiers } = {}) {
  if (!prev || !next) return [];
  const out = [];
  const prevPr = new Map((prev.prs || []).map(p => [p.id, p.state]));
  for (const p of next.prs || []) {
    if (p.state === 'merged' && prevPr.has(p.id) && prevPr.get(p.id) !== 'merged') out.push({ type: 'merge', pr: p.id, project: p.project });
  }
  const prevProj = new Set((prev.projects || []).map(p => p.key));
  for (const p of next.projects || []) if (!prevProj.has(p.key)) out.push({ type: 'found', project: p.key });
  if (tiers?.prev && tiers?.next) {
    const rank = t => (typeof t === 'number' ? t : tiers.order ? tiers.order.indexOf(t) : -1);
    for (const key of Object.keys(tiers.next)) {
      if (!(key in tiers.prev)) continue;
      const a = rank(tiers.prev[key]), b = rank(tiers.next[key]);
      if (a >= 0 && b > a) out.push({ type: 'tierUp', project: key, from: tiers.prev[key], to: tiers.next[key] });
    }
  }
  const prevA = new Map((prev.agents || []).map(a => [a.id, a])), nextA = new Map((next.agents || []).map(a => [a.id, a]));
  for (const [id, a] of nextA) if (!prevA.has(id)) out.push({ type: 'arrive', agent: id, project: a.project });
  for (const [id, a] of prevA) if (!nextA.has(id)) out.push({ type: 'leave', agent: id, project: a.project });
  const idOf = e => e.pr ?? e.agent ?? e.project ?? '';
  return out.sort((x, y) => TYPE_ORDER.get(x.type) - TYPE_ORDER.get(y.type) || cmp(idOf(x), idOf(y)) || cmp(x.project ?? '', y.project ?? ''));
}
