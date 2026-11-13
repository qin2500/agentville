// Deterministic hashing and random numbers (design §1.4: no Math.random in build or sim). OWNER: A2.
/** FNV-1a over the string, uint32. MUST equal classic world.js `hash` so seeds match the classic town. */
export const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

const seedOf = seed => (typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hash(seed));

// One mulberry32 output for state `a` (uint32) -> uint32.
const mix = a => {
  let t = (a + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
};

/** A seeded generator (mulberry32): () => float in [0, 1). seed: a number (taken as uint32) or a string (hashed). */
export function rng(seed) {
  let a = seedOf(seed);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One float in [0, 1) from a seed and keys: rand(seed, 'tree', tx, ty). Stateless and order-sensitive. */
export function rand(seed, ...keys) {
  let h = seedOf(seed);
  for (const k of keys) h = mix(h ^ hash(k));
  return mix(h) / 4294967296;
}
/** The only RNG a mod ever sees (village-mods.md §6.1.8): a generator seeded from (world seed, mod id, project key, stream). */
export function streamFor(seed, modId, projectKey, stream) { return rng(hash(`${seed >>> 0}|${modId}|${projectKey}|${stream}`)); }
