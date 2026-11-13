// Validators for mod hook output (docs/village-mods.md §3.2). OWNER: MOD-1 (M1a). Pure; imports only mod/api.js.
// Mod output is untrusted: it is read through own data properties only (no getters run, nothing inherited), copied
// into fresh engine-built objects, and anything bad is dropped with a lint entry. Lints never echo mod-supplied values.
import { MOD_CODE_MAX } from './api.js';

const OWNERS = new Set(['home', 'pr']);
const RANKS = new Set(['L', 'M', 'S']);
/** Lint entries kept per call; the rest are counted in one summary entry. */
export const LINT_MAX = 32;

/** An own data property's value, or undefined (accessors and inherited properties are ignored, never invoked). */
function own(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d && 'value' in d ? d.value : undefined;
}

function asSet(s) {
  if (s instanceof Set) return s;
  if (s && typeof s[Symbol.iterator] === 'function' && typeof s !== 'string') return new Set(s);
  return new Set();
}

/** Validate a mod's `lots` hook output for one project.
 * @param {unknown} requests  what mod.hooks.lots returned
 * @param {{ projectKey: string, agents: Set<string>|Iterable<string>, prs: Set<string>|Iterable<string>, mod?: string }} opts
 *   agents: opaque ids of this project's agents; prs: this project's PR ids ('<project>#<n>').
 * @returns {{ requests: import('./api.js').LotRequest[], lint: object[] }}
 *   requests: fresh objects { item, owner, rank, agent } / { item, owner, rank, pr, building } with `item` built by the
 *   engine ('home:<agent>' / 'pr:<pr>'); any mod-supplied item or extra field is ignored. Mod order is kept; a repeated
 *   item keeps its first entry. */
export function validateLots(requests, { projectKey, agents, prs, mod } = {}) {
  const out = [], lint = [], seen = new Set();
  const A = asSet(agents), P = asSet(prs);
  const prPrefix = typeof projectKey === 'string' ? `${projectKey}#` : null;
  let dropped = 0;
  const bad = (path, reason) => {
    dropped++;
    if (lint.length < LINT_MAX) lint.push({ kind: 'mod-lots', mod: mod ?? null, hook: 'lots', project: projectKey ?? null, path, reason });
  };
  if (!Array.isArray(requests)) {
    if (requests != null) bad('', 'lots must return an array');
    return { requests: out, lint };
  }
  const n = requests.length;
  for (let i = 0; i < n; i++) {
    const r = own(requests, i);
    const at = `[${i}]`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) { bad(at, 'request is not an object'); continue; }
    const owner = own(r, 'owner'), rank = own(r, 'rank');
    if (typeof owner !== 'string' || !OWNERS.has(owner)) { bad(`${at}.owner`, "owner must be 'home' or 'pr'"); continue; }
    if (typeof rank !== 'string' || !RANKS.has(rank)) { bad(`${at}.rank`, "rank must be 'L', 'M' or 'S'"); continue; }
    let req;
    if (owner === 'home') {
      const agent = own(r, 'agent');
      if (typeof agent !== 'string' || !A.has(agent)) { bad(`${at}.agent`, 'agent is not an agent of this project'); continue; }
      req = { item: `home:${agent}`, owner, rank, agent };
    } else {
      const pr = own(r, 'pr');
      if (typeof pr !== 'string' || !P.has(pr) || (prPrefix && !pr.startsWith(prPrefix))) { bad(`${at}.pr`, 'pr is not a PR of this project'); continue; }
      req = { item: `pr:${pr}`, owner, rank, pr, building: own(r, 'building') === true };
    }
    if (seen.has(req.item)) { bad(at, 'duplicate request for the same item'); continue; }
    seen.add(req.item);
    out.push(req);
  }
  if (dropped > lint.length) lint.push({ kind: 'mod-lots', mod: mod ?? null, hook: 'lots', project: projectKey ?? null, path: '', reason: `${dropped - lint.length} more invalid requests dropped` });
  return { requests: out, lint };
}

/** A mod ground code if valid (an integer 0..MOD_CODE_MAX), else 0. Engine codes (> MOD_CODE_MAX) are not the mod's to use. */
export function validateGroundCode(code) {
  return Number.isInteger(code) && code >= 0 && code <= MOD_CODE_MAX ? code : 0;
}
