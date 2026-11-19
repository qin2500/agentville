// Map tiles kept across sessions (design §3.5). A baked Map tile (map-tiles.js) is a pure function of its signature (what
// it is drawn from) and the build's art code, so it is stored on disk under that signature and read back on the next
// launch instead of being drawn again: a relaunch shows the far-zoom map as fast as the tiles decode, with no sprite
// rastered for it. Stale tiles are never read: a key names the build (`salt`), the tile, the device scale and the
// signature, so a changed tile or a new build simply misses. They are evicted too: a save drops the older tile at the
// same place and scale, a new build drops every tile of the old one when the store opens, and past `maxBytes` the least
// recently used tiles go.
//
//   createTileStore({ backend, salt, maxBytes, encode, decode, flushMs }) -> store | null (no backend or no salt)
//     ready: Promise (opened; the index of keys is in memory), state(): 'opening' | 'ready' | 'off'
//     keyOf(ix, iy, scale, sig), has(key)
//     load(key) -> Promise<{ img, size } | null>: img an ImageBitmap (close it once drawn), null for open sea
//     save(key, entry): entry = map-tiles' { img, sx, sy, size } (img null: open sea); encoded and written in batches
//     flush() -> Promise, stats()
// A backend is { open(): Promise<{ list(), get(key), write(puts, dels) }> }: idbBackend() (IndexedDB), memoryBackend()
// (tests). Encoding is PNG (lossless) by default; decode is createImageBitmap (off the main thread in Chromium).

/** Bumped when what a tile's pixels depend on changes in a way its signature does not show (the bake itself). */
export const STORE_VERSION = 1;
/** Disk cap: 64 MB. A 1/4 tile at dpr 1 (64x64 px) is ~3-12 KB as PNG, so this holds several whole worlds. */
export const STORE_MAX_BYTES = 64 << 20;
export const DB_NAME = 'va.engine2.map-tiles';

export const storeKey = (salt, ix, iy, scale, sig) => `${salt}|${ix},${iy}|${scale}|${sig}`;
const parse = k => { const p = k.split('|'); return { salt: p[0], pos: `${p[1]}|${p[2]}` }; };

const hash = (s, h = 0x811c9dc5) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };

/**
 * The build fingerprint tiles are stored under, or null (do not persist). A production build's module URLs carry content
 * hashes (vite), and the chunk that holds this module names every chunk it imports, so its URL plus the page's entry
 * scripts change with any art code. The dev server's URLs do not change with the code, so a dev page persists only when
 * asked to (`?tilestore`, the perf harness), and then under a fixed dev salt.
 */
export function buildSalt({ url = import.meta.url, scripts, search } = {}) {
  try {
    const doc = typeof document !== 'undefined' ? document : null;
    scripts ??= doc ? [...doc.scripts].map(s => s.src).filter(Boolean) : [];
    search ??= typeof location !== 'undefined' ? location.search : '';
    const path = new URL(url).pathname;
    const dev = /\/src\//.test(path) || !/[-.][\w-]{8,}\.js$/.test(path);
    if (dev && !/[?&]tilestore(=|&|$)/.test(search)) return null;
    return `${STORE_VERSION}.${dev ? 'dev' : hash([path, ...scripts.map(s => { try { return new URL(s).pathname; } catch { return s; } })].join('|'))}`;
  } catch { return null; }
}

// ---- backends
/** IndexedDB: 'meta' (key -> { bytes, used }) and 'px' (key -> Blob | null). */
export function idbBackend(name = DB_NAME, idb = typeof indexedDB !== 'undefined' ? indexedDB : null) {
  if (!idb) return null;
  const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    async open() {
      const rq = idb.open(name, 1);
      rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('meta'); db.createObjectStore('px'); };
      const db = await req2p(rq);
      db.onversionchange = () => db.close();
      return {
        async list() {
          const st = db.transaction('meta', 'readonly').objectStore('meta');
          const [keys, vals] = await Promise.all([req2p(st.getAllKeys()), req2p(st.getAll())]);
          return keys.map((key, i) => ({ key, bytes: vals[i]?.bytes | 0, used: +vals[i]?.used || 0 }));
        },
        async get(key) { return req2p(db.transaction('px', 'readonly').objectStore('px').get(key)); },
        write(puts, dels) {
          return new Promise((res, rej) => {
            const tx = db.transaction(['meta', 'px'], 'readwrite'), m = tx.objectStore('meta'), p = tx.objectStore('px');
            for (const r of puts) { m.put({ bytes: r.bytes, used: r.used }, r.key); if (r.blob !== undefined) p.put(r.blob, r.key); }
            for (const k of dels) { m.delete(k); p.delete(k); }
            tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
          });
        },
      };
    },
  };
}
/** In memory (tests, or a page with no IndexedDB that still wants the logic): the same contract. */
export function memoryBackend(data = new Map()) {
  return {
    data,
    async open() {
      return {
        async list() { return [...data].map(([key, v]) => ({ key, bytes: v.bytes, used: v.used })); },
        async get(key) { return data.get(key)?.blob; },
        async write(puts, dels) {
          for (const r of puts) { const o = data.get(r.key); data.set(r.key, { bytes: r.bytes, used: r.used, blob: r.blob !== undefined ? r.blob : o?.blob }); }
          for (const k of dels) data.delete(k);
        },
      };
    },
  };
}

// ---- codec: one tile <-> a PNG blob
const READ = { willReadFrequently: true };
export async function encodePng(e) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const c = new OffscreenCanvas(e.size, e.size), g = c.getContext('2d', READ);
  g.drawImage(e.img, e.sx | 0, e.sy | 0, e.size, e.size, 0, 0, e.size, e.size);
  return c.convertToBlob({ type: 'image/png' });
}
export function decodePng(blob) {
  return typeof createImageBitmap === 'function' ? createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }) : Promise.resolve(null);
}

export function createTileStore({ backend = idbBackend(), salt = buildSalt(), maxBytes = STORE_MAX_BYTES, encode = encodePng, decode = decodePng,
  flushMs = 400, now = () => Date.now() } = {}) {
  if (!backend || !salt) return null;
  const index = new Map();   // key -> { bytes, used }
  const at = new Map();      // `${ix},${iy}|${scale}` -> key (the tile stored there for this salt)
  let db = null, state = 'opening', bytes = 0, timer = 0, writing = null;
  const puts = new Map(), dels = new Set();
  const st = { loads: 0, loadFails: 0, saves: 0, evictions: 0, stale: 0 };
  const ready = (async () => {
    try {
      db = await backend.open();
      const list = await db.list();
      for (const r of list) {
        const p = parse(r.key);
        if (p.salt !== salt) { dels.add(r.key); st.stale++; continue; }   // another build's tiles: never read again
        index.set(r.key, { bytes: r.bytes, used: r.used });
        bytes += r.bytes;
        const old = at.get(p.pos);
        if (old && index.get(old).used > r.used) { dels.add(r.key); index.delete(r.key); bytes -= r.bytes; st.stale++; continue; }
        if (old) { dels.add(old); bytes -= index.get(old).bytes; index.delete(old); st.stale++; }
        at.set(p.pos, r.key);
      }
      state = 'ready';
      trim();
      if (dels.size) soon();
    } catch { state = 'off'; db = null; }
  })();
  function soon() { if (!timer && db) timer = setTimeout(() => { timer = 0; flush(); }, flushMs); }
  function flush() {
    if (!db || (!puts.size && !dels.size)) return writing ?? Promise.resolve();
    const p = [...puts.values()], d = [...dels];
    puts.clear(); dels.clear();
    const prev = writing ?? Promise.resolve();
    writing = prev.then(() => db.write(p, d)).catch(() => { /* a failed batch is lost: those tiles bake again */ }).then(() => { writing = null; });
    return writing;
  }
  function drop(key) {
    const e = index.get(key);
    if (!e) return;
    index.delete(key); bytes -= e.bytes; puts.delete(key); dels.add(key);
    const p = parse(key).pos;
    if (at.get(p) === key) at.delete(p);
  }
  /** Over the cap: the least recently used tiles go until 90% of it is left. */
  function trim() {
    if (bytes <= maxBytes) return;
    const by = [...index].sort((a, b) => a[1].used - b[1].used);
    for (const [k] of by) { if (bytes <= maxBytes * 0.9) break; drop(k); st.evictions++; }
    soon();
  }
  return {
    ready,
    state: () => state,
    keyOf: (ix, iy, scale, sig) => storeKey(salt, ix, iy, scale, sig),
    has: key => state === 'ready' && index.has(key),
    async load(key) {
      const e = index.get(key);
      if (!e || state !== 'ready') return null;
      try {
        const q = puts.get(key), blob = q && q.blob !== undefined ? q.blob : await db.get(key);   // not written yet: the queued blob
        if (blob === undefined) { drop(key); st.loadFails++; return null; }
        e.used = now();
        puts.set(key, { key, bytes: e.bytes, used: e.used });   // meta only: the pixels are already there
        soon();
        st.loads++;
        if (blob === null) return { img: null, size: 0 };
        const img = await decode(blob);
        if (!img) { drop(key); st.loadFails++; return null; }
        return { img, size: img.width };
      } catch { drop(key); st.loadFails++; return null; }
    },
    async save(key, entry) {
      if (state !== 'ready' || index.has(key)) return;
      const p = parse(key).pos, old = at.get(p);
      let blob = null;
      if (entry.img) { try { blob = await encode(entry); } catch { blob = undefined; } if (!blob) return; }
      if (state !== 'ready' || index.has(key)) return;
      if (old && old !== key) drop(old);   // the tile there changed: its old bake is stale
      const b = blob ? blob.size : 0, used = now();
      index.set(key, { bytes: b, used }); at.set(p, key); bytes += b; st.saves++;
      dels.delete(key); puts.set(key, { key, bytes: b, used, blob });
      trim();
      if (puts.size >= 64) flush(); else soon();
    },
    flush,
    stats: () => ({ state, entries: index.size, bytes, maxBytes, ...st }),
  };
}
