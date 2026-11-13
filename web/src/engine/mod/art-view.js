// artView: the only object shape art/represent hooks ever see (M1e). Allow-list copy, frozen, no server ids.
const ALLOWED = ['id', 'kind', 'model', 'tx', 'ty', 'w', 'h', 'z', 'walk', 'project', 'styleKey', 'variant', 'door', 'rank', 'lot', 'crown', 'anchors', 'dir', 'len'];
const DENIED = new Set(['data', 'agentId', 'item', 'serverId']);

function cloneFrozen(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' ? undefined : v;
  if (depth > 8) return undefined;
  if (Array.isArray(v)) return Object.freeze(v.map(x => cloneFrozen(x, depth + 1)));
  const out = {};
  for (const k of Object.keys(v)) {
    if (DENIED.has(k)) continue;
    const c = cloneFrozen(v[k], depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return Object.freeze(out);
}

/** @param {object} obj a WorldObject @returns {Readonly<object>} */
export function artView(obj) {
  const out = {};
  if (obj) for (const k of ALLOWED) {
    if (obj[k] === undefined) continue;
    const c = cloneFrozen(obj[k]);
    if (c !== undefined) out[k] = c;
  }
  return Object.freeze(out);
}

/** @param {Iterable<object>} objects @returns {Readonly<object>[]} */
export const artViews = objects => Array.from(objects || [], artView);
