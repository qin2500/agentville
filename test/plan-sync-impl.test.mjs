// M7 P2 implementation tests for web/src/plan-sync.js, the ui.js onStoreSet hook and the worlds.js default flip.
// Fake fetch + fake localStorage only: no network, no real storage.
import test from 'node:test';
import assert from 'node:assert/strict';

const PS = await import('../web/src/plan-sync.js');
const { hydratePlan, installPlanMirror, planConflicts, useOtherPlan, keepThisPlan, SYNC_KEY_RE, REVS_KEY, DIRTY_KEY, BACKUP_PREFIX, hash } = PS;
const W = await import('../web/src/worlds.js');

const K = 'va.engine2.world';
const SEED = 'va.engine2.seed';
const fakeLs = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: k => void m.delete(k),
    key: i => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m };
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fakeFetch(keys = {}) {
  const f = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    f.calls.push({ url: String(url), method, body: opts.body && JSON.parse(opts.body) });
    const d = f.delay || (method === 'PUT' ? f.putDelay : 0);
    if (d) await new Promise(r => setTimeout(r, d));
    if (!f.online) throw new TypeError('offline');
    if (f.status) return res(f.status, {});
    if (method === 'GET') return res(200, f.getBody ?? { v: 1, keys: f.keys });
    const { key, value, baseRev } = JSON.parse(opts.body);
    const cur = f.keys[key];
    if ((cur?.rev || 0) !== baseRev) return res(409, { rev: cur?.rev || 0, value: cur?.value });
    f.keys[key] = { rev: baseRev + 1, value };
    return res(200, { rev: baseRev + 1 });
  };
  f.calls = []; f.online = true; f.keys = keys;
  f.puts = () => f.calls.filter(c => c.method === 'PUT');
  return f;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const val = (ls, k) => JSON.parse(ls.getItem(k));
const revs = ls => JSON.parse(ls.getItem(REVS_KEY) || '{}');
const dirty = ls => JSON.parse(ls.getItem(DIRTY_KEY) || '{}');
const backup = (ls, k) => JSON.parse(ls.getItem(BACKUP_PREFIX + k) || 'null');
const mirror = (fetch, ls, debounceMs = 5, tab) => { let hook; const m = installPlanMirror({ onStoreSet: cb => { hook = cb; }, fetch, ls, debounceMs, tab }); return { m, set: (k, v) => { ls.setItem(k, JSON.stringify(v)); hook(k, v); } }; };

test('SYNC_KEY_RE: the server allowlist, never .demo, never other settings', () => {
  for (const k of ['va.engine2.world', 'va.engine2.world.agentville.fantasy', 'va.world9', 'va.world12', 'va.engine2.seed', 'va.seen']) assert.ok(SYNC_KEY_RE.test(k), k);
  for (const k of ['va.engine2.world.agentville.fantasy.demo', 'va.world9.demo', 'va.world.mod', 'va.engine', 'va.engine2.salt', 'va.engine2.cam', 'va.worldplan.revs', 'va.engine2.world.A'])
    assert.ok(!SYNC_KEY_RE.test(k), k);
});

test('migrate: every local plan key goes up at baseRev 0, local untouched, revs recorded, dirty cleared', async () => {
  const ls = fakeLs({ [K]: { blocks: { a: 1 }, lots: {} }, 'va.world9': { blocks: {}, lots: {} }, [SEED]: 42, 'va.engine': 2 });
  const before = new Map(ls._m);
  const f = fakeFetch();
  const r = await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.equal(r.source, 'server');
  assert.deepEqual(r.migrated.sort(), [K, SEED, 'va.world9'].sort());
  assert.ok(f.puts().every(p => p.body.baseRev === 0));
  assert.ok(!f.puts().some(p => p.body.key === 'va.engine'));
  for (const k of [K, 'va.world9', SEED, 'va.engine']) assert.equal(ls.getItem(k), before.get(k), `${k} untouched`);
  assert.equal(revs(ls)[K].rev, 1);
  assert.deepEqual(dirty(ls), {});
});

test('adopt: server key missing locally is written; server newer + local unchanged since sync is adopted', async () => {
  const synced = JSON.stringify({ v: 'old' });
  const ls = fakeLs({ [K]: synced, [REVS_KEY]: { [K]: { rev: 2, h: hash(synced) } } });
  const f = fakeFetch({ [K]: { rev: 5, value: { v: 'new' } }, 'va.seen': { rev: 1, value: ['a', 'b'] } });
  const r = await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.deepEqual(r.adopted.sort(), [K, 'va.seen']);
  assert.deepEqual(val(ls, K), { v: 'new' });
  assert.deepEqual(val(ls, 'va.seen'), ['a', 'b']);
  assert.equal(revs(ls)[K].rev, 5);
  assert.equal(f.puts().length, 0);
});

test('same: equal content records the rev and pushes nothing', async () => {
  const ls = fakeLs({ [K]: { same: 1 } });
  const f = fakeFetch({ [K]: { rev: 3, value: { same: 1 } } });
  const r = await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.deepEqual([r.migrated, r.adopted, r.conflicts], [[], [], []]);
  assert.equal(revs(ls)[K].rev, 3);
  assert.equal(f.puts().length, 0);
});

test('first contact & differs: keep local, backup server copy, follower (mirror never pushes), conflicts[]', async () => {
  const ls = fakeLs({ [K]: { l: 1 } });
  const f = fakeFetch({ [K]: { rev: 4, value: { s: 1 } } });
  const r = await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.deepEqual(r.conflicts, [K]);
  assert.deepEqual(val(ls, K), { l: 1 });
  assert.deepEqual(backup(ls, K), { rev: 4, value: { s: 1 } });
  assert.deepEqual(planConflicts(ls), [K]);
  const { set } = mirror(f, ls);
  set(K, { l: 2 });
  await wait(40);
  assert.equal(f.puts().length, 0, 'follower key is not pushed');
  assert.deepEqual(f.keys[K].value, { s: 1 });
});

test('both changed since the last sync (dirty + server newer) is a conflict, not an adopt', async () => {
  const synced = JSON.stringify({ v: 1 });
  const ls = fakeLs({ [K]: { v: 'mine' }, [REVS_KEY]: { [K]: { rev: 1, h: hash(synced) } }, [DIRTY_KEY]: { [K]: 1 } });
  const f = fakeFetch({ [K]: { rev: 3, value: { v: 'theirs' } } });
  const r = await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.deepEqual(r.conflicts, [K]);
  assert.deepEqual(val(ls, K), { v: 'mine' });
});

test('dirty flush: local edited offline on an unchanged server rev is pushed at that rev', async () => {
  const synced = JSON.stringify({ v: 1 });
  const ls = fakeLs({ [K]: { v: 2 }, [REVS_KEY]: { [K]: { rev: 1, h: hash(synced) } }, [DIRTY_KEY]: { [K]: 1 } });
  const f = fakeFetch({ [K]: { rev: 1, value: { v: 1 } } });
  await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.equal(f.puts().length, 1);
  assert.equal(f.puts()[0].body.baseRev, 1);
  assert.deepEqual(f.keys[K], { rev: 2, value: { v: 2 } });
  assert.deepEqual(dirty(ls), {});
});

test('offline: network error, timeout, 404 and a bad reply never throw and never touch local', async () => {
  const init = { [K]: { l: 1 }, 'va.world9': { blocks: {}, lots: {} } };
  const down = fakeFetch(); down.online = false;
  const slow = fakeFetch(); slow.delay = 200;
  const gone = fakeFetch(); gone.status = 404;
  const html = fakeFetch(); html.getBody = '<!doctype html>';
  const cases = [[down, 'offline'], [slow, 'offline'], [gone, 'local'], [html, 'offline']];
  for (const [f, source] of cases) {
    const ls = fakeLs(init); const before = new Map(ls._m);
    const t0 = Date.now();
    const r = await hydratePlan({ fetch: f, ls, timeoutMs: 50 });
    assert.equal(r.source, source);
    assert.ok(Date.now() - t0 < 150, 'bounded by the timeout');
    assert.deepEqual(new Map(ls._m), before);
  }
  assert.equal((await hydratePlan({ fetch: undefined, ls: fakeLs() })).source, 'offline');
  assert.equal((await hydratePlan({ fetch: fakeFetch(), ls: null })).source, 'offline');
});

test('offline edits stay dirty and flush on the next hydrate', async () => {
  const ls = fakeLs();
  const f = fakeFetch(); f.online = false;
  const { set } = mirror(f, ls);
  set(K, { e: 1 });
  await wait(30);
  assert.deepEqual(dirty(ls), { [K]: { b: 0 } }, 'dirty, marked with the rev the edit was based on');
  f.online = true;
  const r = await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.deepEqual(r.migrated, [K]);
  assert.deepEqual(f.keys[K].value, { e: 1 });
  assert.deepEqual(dirty(ls), {});
});

test('no-relayout condition: empty server -> live classic and engine layouts are byte-identical after flip + hydrate', async () => {
  const classic = JSON.stringify({ blocks: { p: { x: 3, y: 4, w: 5, h: 6 } }, lots: { p: { tier: 1, cap: 4, a: {}, h: {} } } });
  const engine = JSON.stringify({ v: 1, seed: 99, blocks: { q: { x: 1, y: 2 } }, lots: {} });
  const ls = fakeLs({ 'va.world9': classic, [K]: engine, [SEED]: '99' });
  const store = { get: (k, d) => (ls.getItem(k) == null ? d : JSON.parse(ls.getItem(k))), set: (k, v) => ls.setItem(k, JSON.stringify(v)) };
  assert.equal(W.engineActive('', store), true);
  await hydratePlan({ fetch: fakeFetch(), ls, timeoutMs: 300 });
  assert.equal(ls.getItem('va.world9'), classic);
  assert.equal(ls.getItem(K), engine);
  assert.equal(ls.getItem(SEED), '99');
  assert.equal(ls.getItem('va.engine'), null, 'the flip writes no setting');
});

test('seed follows the layout: a local seed with no engine layout adopts the server seed', async () => {
  const ls = fakeLs({ [SEED]: 7 });
  const f = fakeFetch({ [K]: { rev: 2, value: { v: 1, seed: 11, blocks: {}, lots: {} } }, [SEED]: { rev: 1, value: 11 } });
  const r = await hydratePlan({ fetch: f, ls, timeoutMs: 300 });
  assert.deepEqual(r.conflicts, []);
  assert.equal(val(ls, SEED), 11);
  assert.equal(val(ls, K).seed, 11);
  // With a local layout, a different seed is a conflict alongside it (both backed up, chosen together).
  const ls2 = fakeLs({ [SEED]: 7, [K]: { v: 1, seed: 7, blocks: { a: 1 }, lots: {} } });
  const r2 = await hydratePlan({ fetch: fakeFetch({ ...f.keys }), ls: ls2, timeoutMs: 300 });
  assert.deepEqual(r2.conflicts.sort(), [K, SEED].sort());
  assert.equal(val(ls2, SEED), 7);
});

test('a pending backup: refreshed when the server moves, cleared when the server matches local', async () => {
  const ls = fakeLs({ [K]: { l: 1 }, [BACKUP_PREFIX + K]: { rev: 2, value: { s: 1 } } });
  const r = await hydratePlan({ fetch: fakeFetch({ [K]: { rev: 3, value: { s: 2 } } }), ls, timeoutMs: 300 });
  assert.deepEqual(r.conflicts, [K]);
  assert.deepEqual(backup(ls, K), { rev: 3, value: { s: 2 } });
  await hydratePlan({ fetch: fakeFetch({ [K]: { rev: 4, value: { l: 1 } } }), ls, timeoutMs: 300 });
  assert.equal(backup(ls, K), null);
  assert.equal(revs(ls)[K].rev, 4);
});

test('mirror: debounced to one PUT of the latest value; non-sync and .demo keys ignored', async () => {
  const ls = fakeLs(); const f = fakeFetch();
  const { set } = mirror(f, ls, 20);
  set('va.engine', 2); set('va.world9.demo', { x: 1 }); set('va.engine2.world.agentville.fantasy.demo', { x: 1 });
  for (let i = 0; i < 6; i++) set(K, { i });
  await wait(80);
  assert.equal(f.puts().length, 1);
  assert.deepEqual(f.keys[K], { rev: 1, value: { i: 5 } });
  assert.equal(revs(ls)[K].rev, 1);
});

test('mirror: re-saving the same layout (every rebuild) sends nothing', async () => {
  const ls = fakeLs(); const f = fakeFetch();
  const { set } = mirror(f, ls);
  set(K, { a: 1 }); await wait(30);
  set(K, { a: 1 }); set(K, { a: 1 }); await wait(30);
  assert.equal(f.puts().length, 1);
  set(K, { a: 2 }); await wait(30);
  assert.equal(f.puts().length, 2);
  assert.equal(f.puts()[1].body.baseRev, 1);
});

test('mirror 409: stale for the session, server copy backed up, local never replaced', async () => {
  const ls = fakeLs(); const f = fakeFetch({ [K]: { rev: 7, value: { other: 1 } } });
  const { m, set } = mirror(f, ls);
  set(K, { mine: 1 }); await wait(30);
  assert.ok(m.stale.has(K));
  assert.deepEqual(val(ls, K), { mine: 1 });
  assert.deepEqual(backup(ls, K), { rev: 7, value: { other: 1 } });
  const n = f.puts().length;
  set(K, { mine: 2 }); await wait(30);
  assert.equal(f.puts().length, n);
});

test('mirror 409 with the identical plan just records the rev', async () => {
  const ls = fakeLs(); const f = fakeFetch({ [K]: { rev: 3, value: { same: 1 } } });
  const { m, set } = mirror(f, ls);
  set(K, { same: 1 }); await wait(30);
  assert.ok(!m.stale.has(K));
  assert.equal(revs(ls)[K].rev, 3);
  assert.equal(backup(ls, K), null);
});

test('mirror: 404 disables the mirror; 400/413/403 stop that key only', async () => {
  const ls = fakeLs(); const f = fakeFetch(); f.status = 404;
  const { set } = mirror(f, ls);
  set(K, { a: 1 }); await wait(20);
  set('va.seen', ['x']); await wait(20);
  assert.equal(f.puts().length, 1);
  for (const code of [400, 413, 403]) {
    const g = fakeFetch(); g.status = code;
    const mm = mirror(g, fakeLs());
    mm.set(K, { a: 1 }); await wait(20);
    assert.ok(mm.m.stale.has(K), String(code));
  }
});

test('mirror waits for a migration in flight on the same key (no self-409)', async () => {
  const ls = fakeLs({ [K]: { a: 1 } }); const f = fakeFetch(); f.putDelay = 40;
  const h = hydratePlan({ fetch: f, ls, timeoutMs: 10 }); // returns before the PUT lands
  const r = await h;
  assert.deepEqual(r.migrated, [], 'the migration had not landed when hydrate returned');
  const { m, set } = mirror(f, ls, 1, r.tab); // main.js wiring: the mirror carries on this tab's own record
  set(K, { a: 2 });
  await wait(150);
  assert.ok(!m.stale.has(K));
  assert.deepEqual(f.keys[K], { rev: 2, value: { a: 2 } });
});

test('useOtherPlan adopts the backups; keepThisPlan pushes local at the backup rev', async () => {
  const ls = fakeLs({ [K]: { l: 1 }, [SEED]: 1, [BACKUP_PREFIX + K]: { rev: 4, value: { s: 1 } }, [BACKUP_PREFIX + SEED]: { rev: 2, value: 9 } });
  useOtherPlan({ ls });
  assert.deepEqual(val(ls, K), { s: 1 });
  assert.equal(val(ls, SEED), 9);
  assert.deepEqual(planConflicts(ls), []);
  assert.equal(revs(ls)[K].rev, 4);

  const ls2 = fakeLs({ [K]: { l: 1 }, [BACKUP_PREFIX + K]: { rev: 4, value: { s: 1 } } });
  const f = fakeFetch({ [K]: { rev: 4, value: { s: 1 } } });
  const r = await keepThisPlan({ fetch: f, ls: ls2 });
  assert.deepEqual(r, { kept: [K], failed: [], moved: [] });
  assert.deepEqual(f.keys[K], { rev: 5, value: { l: 1 } });
  assert.deepEqual(planConflicts(ls2), []);
  assert.deepEqual(val(ls2, K), { l: 1 });
});

test('keepThisPlan: the server moved again -> stays in conflict with a fresh backup', async () => {
  const ls = fakeLs({ [K]: { l: 1 }, [BACKUP_PREFIX + K]: { rev: 4, value: { s: 1 } } });
  const f = fakeFetch({ [K]: { rev: 6, value: { s: 3 } } });
  const r = await keepThisPlan({ fetch: f, ls });
  assert.deepEqual(r, { kept: [], failed: [K], moved: [K] });
  assert.deepEqual(backup(ls, K), { rev: 6, value: { s: 3 } });
  assert.deepEqual(val(ls, K), { l: 1 });
});

test('keepThisPlan: the server moves right before the push -> 409, fresh backup, nothing overwritten', async () => {
  const ls = fakeLs({ [K]: { l: 1 }, [BACKUP_PREFIX + K]: { rev: 4, value: { s: 1 } } });
  const f = fakeFetch({ [K]: { rev: 4, value: { s: 1 } } });           // the copy the person was shown
  const racing = async (url, opts = {}) => {
    if (opts.method === 'PUT') f.keys = { ...f.keys, [K]: { rev: 5, value: { s: 4 } } }; // another window saves first
    return f(url, opts);
  };
  const r = await keepThisPlan({ fetch: racing, ls });
  assert.deepEqual(r, { kept: [], failed: [K], moved: [K] });
  assert.equal(f.puts()[0].body.baseRev, 4, "pushed at the backup's rev");
  assert.deepEqual(f.keys[K], { rev: 5, value: { s: 4 } }, 'the newer server copy stays');
  assert.deepEqual(backup(ls, K), { rev: 5, value: { s: 4 } });
  assert.deepEqual(val(ls, K), { l: 1 });
});

test('ui.js store.set calls onStoreSet hooks after a persisted set; a throwing hook never breaks a save', async () => {
  const mem = new Map();
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  try {
    const { store, onStoreSet } = await import('../web/src/ui.js');
    const seen = [];
    const off1 = onStoreSet(() => { throw new Error('boom'); });
    const off2 = onStoreSet((k, v) => seen.push([k, v, mem.get(k)]));
    store.set('va.seen', ['a']);
    assert.deepEqual(seen, [['va.seen', ['a'], '["a"]']]);
    off1(); off2();
    store.set('va.seen', ['b']);
    assert.equal(seen.length, 1);
    globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    const after = [];
    const off3 = onStoreSet(k => after.push(k));
    store.set('va.seen', ['c']);
    assert.deepEqual(after, [], 'no hook when nothing was persisted');
    off3();
  } finally { globalThis.localStorage = prev; }
});

test('worlds.js flip: unset/2 -> new, explicit 1 -> classic, ?engine=1|2 per page; classic is an Advanced checkbox', () => {
  const st = init => ({ get: (k, d) => (k in init ? init[k] : d), set() { throw new Error('flip must not write'); } });
  assert.equal(W.storedEngine(st({})), 2);
  assert.equal(W.storedEngine(st({ 'va.engine': 2 })), 2);
  assert.equal(W.storedEngine(st({ 'va.engine': 1 })), 1);
  assert.equal(W.storedEngine(st({ 'va.engine': 'junk' })), 2);
  assert.equal(W.engineActive('', st({})), true);
  assert.equal(W.engineActive('?engine=1', st({})), false);
  assert.equal(W.engineActive('?engine=2', st({ 'va.engine': 1 })), true);
  assert.equal(W.engineActive('?engine=x', st({ 'va.engine': 1 })), false, 'an unknown ?engine falls back to the setting');
  assert.doesNotMatch(W.classicToggleHtml(st({})), /data-set="engine" checked/);
  assert.match(W.classicToggleHtml(st({ 'va.engine': 1 })), /data-set="engine" checked>Use classic village/);
});
