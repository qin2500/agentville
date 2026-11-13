// Persisted layout (design §1.4), one per mod (village-mods.md §3.4, §6.1.6). OWNER: A3. `store` is { get(k, d), set(k, v) }
// (ui.js store or a test fake).
// Shape: { v: 1, seed, blocks: { [project]: { x, y, w, h, tier, gt, cap, acc, seen, away?, …city4: crowns, style } },
//          lots: { [project]: { tier, cap, a: { itemId: lotId }, h: { itemId: goneSince } } } }
// blocks/lots are exactly classic's (world.js, va.world8 / va.world9); unknown fields pass through untouched.
// v2 never writes a classic key.
//
// Keys come from the mod's own PersistDecl (`mod.persist`, api.js; top-only, never inherited, so a child of a mod with
// legacy keys starts on its own key). A mod reads and writes `persist.key` (demo: `persist.demoKey`), by default
// `va.engine2.world.<modId>` (demo `va.engine2.world.<modId>.demo`), so switching worlds and back never reshuffles
// either one. If that key holds no layout it tries `persist.also` (demo: `${k}.demo`), then the read-only legacy
// imports `persist.import` (demo: `${k}.demo`), then starts empty. Nothing but the mod's own key is ever written.
// A mod with no `persist` uses the per-mod default keys and imports nothing. No mod given: the registry's default mod.
// The registry also refuses a declaration that names another mod's key or a legacy key (registry.js checkPersistOwner).
//
// Seed (va.engine2.seed): stored once per install, shared by every mod (rng.js streamFor mixes in the mod id). Pure
// code draws no random numbers, so when no seed is stored it is derived as hash(`va.engine2:${now}`) from the `now`
// (ms) the caller passes, or hash('va.engine2') when none is passed (a fixed default), then stored. Settlement seeds
// are hash(project name) as in classic, independent of it.
import { hash } from '../core/rng.js';
import { resolveMod } from '../mod/registry.js';

const BASE = 'va.engine2.world';
export const SEED_KEY = 'va.engine2.seed';

/** Every key a PersistDecl names must match this (before the `.demo` the engine adds in demo mode). */
export const PERSIST_KEY_RE = /^va\.(engine2\.world(\.[a-z0-9.-]+)?|world\d+)(\.demo)?$/;
const DECL_FIELDS = ['key', 'demoKey', 'also', 'import'];

const copy = o => JSON.parse(JSON.stringify(o));
const valid = s => !!s && typeof s === 'object' && !!s.blocks && typeof s.blocks === 'object' && !!s.lots && typeof s.lots === 'object';
const seedOk = s => typeof s === 'number' && Number.isFinite(s);
const modOf = mod => (mod && typeof mod.id === 'string' && mod.id ? mod : resolveMod());
const demoOf = (k, demo) => (demo ? `${k}.demo` : k);

/** The per-mod key: `va.engine2.world.<modId>` (+ `.demo`). */
export const modKey = (modId, demo = false) => `${BASE}.${modId}${demo ? '.demo' : ''}`;
const ownKey = (id, demo) => {
  if (id === 'demo') throw new Error('persist: mod id "demo" is reserved');
  return modKey(id, demo);
};

/** Checks a PersistDecl (api.js) and returns it; throws an Error naming the bad field. null/undefined → null.
 * key/demoKey start with `va.engine2.world`; key, also and import never end in `.demo` (demo mode adds it) and
 * demoKey always does, so a live and a demo layout can never share a key. */
export function checkPersist(decl, modId = '?') {
  if (decl == null) return null;
  const bad = msg => { throw new Error(`mod ${modId}: persist ${msg}`); };
  if (typeof decl !== 'object' || Array.isArray(decl)) bad('must be an object');
  for (const f of Object.keys(decl)) if (!DECL_FIELDS.includes(f)) bad(`has unknown field ${JSON.stringify(f)} (allowed: ${DECL_FIELDS.join(', ')})`);
  const one = (field, k) => {
    if (typeof k !== 'string' || !PERSIST_KEY_RE.test(k)) bad(`${field} ${JSON.stringify(k)} does not match ${PERSIST_KEY_RE}`);
    const isDemo = k.endsWith('.demo');
    if (field === 'demoKey' ? !isDemo : isDemo) bad(`${field} ${JSON.stringify(k)} ${isDemo ? 'must not' : 'must'} end in ".demo"`);
    if ((field === 'key' || field === 'demoKey') && !k.startsWith(BASE)) bad(`${field} ${JSON.stringify(k)} must start with "${BASE}"`);
  };
  for (const f of ['key', 'demoKey']) if (decl[f] !== undefined) one(f, decl[f]);
  for (const f of ['also', 'import']) {
    if (decl[f] === undefined) continue;
    if (!Array.isArray(decl[f])) bad(`${f} must be an array of keys`);
    decl[f].forEach((k, i) => one(`${f}[${i}]`, k));
  }
  return decl;
}

/** The keys a mod uses, in read order: `write` (its own key, the only one ever written; read first), then `also`,
 * then `import`. Throws on a bad PersistDecl. */
export function persistKeys(mod, { demo = false } = {}) {
  const m = modOf(mod);
  const d = checkPersist(m.persist, m.id);
  if (!d) return { write: ownKey(m.id, demo), also: [], import: [] };
  const write = demo ? (d.demoKey ?? ownKey(m.id, true)) : (d.key ?? ownKey(m.id, false));
  return { write, also: (d.also || []).map(k => demoOf(k, demo)), import: (d.import || []).map(k => demoOf(k, demo)) };
}

/** The key a mod reads first and writes. */
export function worldKey(mod, { demo = false } = {}) { return persistKeys(mod, { demo }).write; }

/** @returns {{ v: 1, seed: number, blocks: object, lots: object }} */
export function emptyWorld(seed = 0) { return { v: 1, seed: seedOk(seed) ? seed >>> 0 : 0, blocks: {}, lots: {} }; }

/** The install's world seed: the stored one, else derived (see the header) and stored once. */
export function loadSeed(store, { now } = {}) {
  const s = store.get(SEED_KEY, null);
  if (seedOk(s)) return s >>> 0;
  const seed = hash(now == null ? 'va.engine2' : `va.engine2:${now}`);
  store.set(SEED_KEY, seed);
  return seed;
}

/** The mod's own key, else its `also` keys, else its legacy imports (a deep copy), else emptyWorld. Read-only except
 * for the seed, which it may store once. A bad PersistDecl throws before anything is read or written. */
export function loadWorld(store, { demo = false, now, mod } = {}) {
  const keys = persistKeys(mod, { demo });
  const seed = loadSeed(store, { now });
  for (const k of [keys.write, ...keys.also]) {
    const own = store.get(k, null);
    if (valid(own)) { const w = copy(own); w.v = 1; if (!seedOk(w.seed)) w.seed = seed; return w; }
  }
  return importFrom(store, keys.import, seed) || emptyWorld(seed);
}

/** Writes the layout to the mod's own key only. */
export function saveWorld(store, persisted, { demo = false, mod } = {}) {
  store.set(worldKey(mod, { demo }), persisted);
}

// The first key (already demo-suffixed) holding a classic-shaped layout → Persisted (a deep copy), or null. Read-only.
function importFrom(store, keys, seed) {
  for (const k of keys) {
    const s = store.get(k, null);
    if (!valid(s)) continue;
    const c = copy(s);
    return { ...c, v: 1, seed: seedOk(seed) ? seed >>> 0 : 0, blocks: c.blocks, lots: c.lots };
  }
  return null;
}


export const SALT_KEY = 'va.engine2.salt';

/** The install's opaque-id salt: 32 hex chars from crypto randomness, stored once. Never derived from the seed
 * (mods see the seed as input.seed, so a seed-derived salt would let them recompute opaque ids). */
export function loadSalt(store) {
  const s = store.get(SALT_KEY, null);
  if (typeof s === 'string' && /^[0-9a-f]{32}$/.test(s)) return s;
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  store.set(SALT_KEY, salt);
  return salt;
}
