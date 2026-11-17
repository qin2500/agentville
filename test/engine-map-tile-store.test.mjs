// Map tile store (design §3.5): baked Map tiles persisted across sessions under a build salt + signature key.
// Spec: no backend/salt -> null; buildSalt gates dev builds; stale salts and superseded signatures are dropped; the
// byte cap evicts least recently used; a vanished blob or a failing backend degrades to "miss", never throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileStore, buildSalt, memoryBackend, idbBackend, STORE_VERSION } from '../web/src/engine/render/map-tile-store.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const encode = async e => ({ size: 100, tag: e.size });
const decode = async b => ({ width: 64, b });
const tile = (size = 64) => ({ img: { tag: 'img' }, sx: 0, sy: 0, size });
const SALT = '1.abc';

async function open(backend, extra = {}) {
  const calls = { encode: 0, decode: 0 };
  const store = createTileStore({
    backend, salt: SALT, flushMs: 0,
    encode: async e => { calls.encode++; return (extra.encode ?? encode)(e); },
    decode: async b => { calls.decode++; return (extra.decode ?? decode)(b); },
    ...extra.opts,
  });
  await store.ready;
  return { store, calls };
}
const settle = async store => { await sleep(5); await store.flush(); };

test('createTileStore is null without a backend or a salt', () => {
  assert.equal(createTileStore({ backend: null, salt: SALT }), null);
  assert.equal(createTileStore({ backend: memoryBackend(), salt: null }), null);
  assert.equal(createTileStore({ backend: memoryBackend(), salt: '' }), null);
  assert.ok(createTileStore({ backend: memoryBackend(), salt: SALT }));
});

test('buildSalt: a dev module URL persists only when asked to', () => {
  const url = 'http://localhost:5173/src/engine/render/map-tile-store.js';
  assert.equal(buildSalt({ url, scripts: [], search: '' }), null);
  assert.equal(buildSalt({ url, scripts: [], search: '?other=1' }), null);
  for (const search of ['?tilestore', '?a=1&tilestore', '?tilestore=1']) {
    const s = buildSalt({ url, scripts: [], search });
    assert.equal(typeof s, 'string', search);
    assert.ok(s.startsWith(`${STORE_VERSION}.dev`), search);
  }
});

test('buildSalt: a production salt follows the url hash and the entry scripts, and is stable', () => {
  const url = 'http://x/assets/index-AbC12345.js', scripts = ['http://x/assets/main-Zz998877.js'];
  const a = buildSalt({ url, scripts, search: '' });
  assert.equal(typeof a, 'string');
  assert.ok(a);
  assert.ok(!a.includes('dev'));
  assert.equal(buildSalt({ url, scripts: [...scripts], search: '' }), a);
  assert.notEqual(buildSalt({ url: 'http://x/assets/index-ZzZ98765.js', scripts, search: '' }), a);
  assert.notEqual(buildSalt({ url, scripts: ['http://x/assets/main-Qq112233.js'], search: '' }), a);
  assert.notEqual(buildSalt({ url, scripts: [...scripts, 'http://x/assets/extra-Aa000000.js'], search: '' }), a);
});

test('save -> has -> flush writes the backend; a new store on the same data loads it', async () => {
  const backend = memoryBackend();
  const { store, calls } = await open(backend);
  assert.equal(store.state(), 'ready');
  const key = store.keyOf(1, 2, 0.25, 'sigA');
  assert.equal(key, `${SALT}|1,2|0.25|sigA`);
  assert.equal(store.has(key), false);
  await store.save(key, tile());
  assert.equal(store.has(key), true);
  assert.equal(calls.encode, 1);
  await settle(store);
  assert.ok(backend.data.has(key));
  assert.equal(backend.data.get(key).bytes, 100);

  const { store: s2 } = await open(backend);
  assert.equal(s2.state(), 'ready');
  assert.equal(s2.has(key), true);
  const got = await s2.load(key);
  assert.equal(got.size, 64);
  assert.equal(got.img.width, 64);
  assert.equal(got.img.b, backend.data.get(key).blob);
});

test('an open-sea tile (img null) saves 0 bytes and loads without decoding', async () => {
  const backend = memoryBackend();
  const { store, calls } = await open(backend);
  const key = store.keyOf(0, 0, 0.5, 's');
  await store.save(key, { img: null, sx: 0, sy: 0, size: 64 });
  assert.equal(calls.encode, 0);
  await settle(store);
  assert.equal(backend.data.get(key).bytes, 0);
  const { store: s2, calls: c2 } = await open(backend);
  assert.deepEqual(await s2.load(key), { img: null, size: 0 });
  assert.equal(c2.decode, 0);
});

test('a new salt drops every key of the old one, and counts them stale', async () => {
  const backend = memoryBackend();
  const { store: old } = await open(backend);
  const k1 = old.keyOf(0, 0, 0.25, 'a'), k2 = old.keyOf(1, 0, 0.25, 'b');
  await old.save(k1, tile()); await old.save(k2, tile());
  await settle(old);
  assert.equal(backend.data.size, 2);

  const fresh = createTileStore({ backend, salt: '1.other', flushMs: 0, encode, decode });
  await fresh.ready;
  assert.equal(fresh.has(k1), false);
  assert.equal(fresh.has(k2), false);
  assert.equal(fresh.stats().stale, 2);
  await settle(fresh);
  assert.equal(backend.data.size, 0);
});

test('a changed signature supersedes the older tile at the same place and scale only', async () => {
  const backend = memoryBackend();
  const { store } = await open(backend);
  const a = store.keyOf(3, 4, 0.25, 'sigA'), b = store.keyOf(3, 4, 0.25, 'sigB'), other = store.keyOf(3, 4, 0.5, 'sigA');
  await store.save(a, tile());
  await store.save(other, tile());
  await settle(store);
  assert.ok(backend.data.has(a));
  await store.save(b, tile());
  assert.equal(store.has(a), false);
  assert.equal(store.has(b), true);
  assert.equal(store.has(other), true, 'a different scale at the same ix,iy is a different tile');
  await settle(store);
  assert.equal(backend.data.has(a), false);
  assert.equal(backend.data.has(b), true);
  assert.equal(backend.data.has(other), true);
});

test('past the cap the least recently used tiles go, down to 90%', async () => {
  const backend = memoryBackend();
  let t = 0;
  const { store } = await open(backend, { encode: async () => ({ size: 300 }), opts: { maxBytes: 1000, now: () => ++t } });
  const keys = [0, 1, 2, 3, 4].map(i => store.keyOf(i, 0, 0.25, 's'));
  for (const k of keys) await store.save(k, tile());
  assert.deepEqual(keys.map(k => store.has(k)), [false, false, true, true, true]);
  const s = store.stats();
  assert.ok(s.bytes <= 900, `bytes ${s.bytes}`);
  assert.equal(s.evictions, 2);
  await settle(store);
  assert.deepEqual([...backend.data.keys()].sort(), keys.slice(2).sort());
});

test('a load counts as use: a loaded old tile outlives a newer unloaded one', async () => {
  const backend = memoryBackend();
  let t = 0;
  const { store } = await open(backend, { encode: async () => ({ size: 300 }), opts: { maxBytes: 1000, now: () => ++t } });
  const [k0, k1, k2, k3] = [0, 1, 2, 3].map(i => store.keyOf(i, 0, 0.25, 's'));
  for (const k of [k0, k1, k2]) await store.save(k, tile());
  assert.equal(store.stats().evictions, 0);
  await settle(store);   // the pixels must be in the backend before a load can read them
  assert.ok(await store.load(k0));
  await store.save(k3, tile());
  assert.equal(store.has(k0), true, 'touched by the load');
  assert.equal(store.has(k1), false, 'the least recently used went');
  assert.equal(store.has(k2), true);
  assert.equal(store.has(k3), true);
  assert.equal(store.stats().evictions, 1);
});

test('a load whose data vanished underneath resolves null and drops the key', async () => {
  const backend = memoryBackend();
  const { store } = await open(backend);
  const key = store.keyOf(0, 0, 0.25, 's');
  await store.save(key, tile());
  await settle(store);
  backend.data.delete(key);
  assert.equal(store.has(key), true);
  assert.equal(await store.load(key), null);
  assert.equal(store.has(key), false);
  assert.equal(store.stats().loadFails, 1);
});

test('a backend that fails to open leaves the store off and harmless', async () => {
  const store = createTileStore({ backend: { open: async () => { throw new Error('denied'); } }, salt: SALT, flushMs: 0, encode, decode });
  await store.ready;
  assert.equal(store.state(), 'off');
  const key = store.keyOf(0, 0, 0.25, 's');
  assert.equal(store.has(key), false);
  await store.save(key, tile());
  assert.equal(store.has(key), false);
  assert.equal(await store.load(key), null);
  await store.flush();
});

test('idbBackend is null where there is no IndexedDB', () => {
  assert.equal(idbBackend('name', null), null);
});
