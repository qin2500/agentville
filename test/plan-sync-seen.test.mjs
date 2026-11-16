// Volatile fields in a synced town (web/src/plan-sync.js townKey): the engine and classic rewrite every shown block's
// `seen` stamp on each build, so two windows that show the same town still save different JSON. These tests drive two
// windows (two localStorages, two mirrors) against one fake server and check that `seen`-only churn
//   (a) never turns into a PUT per rebuild,
//   (b) never 409s a window into "stale" or saves a backup, and
//   (c) never raises the "Another window saved a different town" choice,
// while a real layout difference still conflicts exactly as before. Fakes only: no network, no real storage.
import test from 'node:test';
import assert from 'node:assert/strict';

const PS = await import('../web/src/plan-sync.js');
const { hydratePlan, installPlanMirror, planConflicts, REVS_KEY, BACKUP_PREFIX } = PS;

const K = 'va.engine2.world';
const CLASSIC = 'va.world9';
const fakeLs = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: k => void m.delete(k),
    key: i => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m };
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
/** One fake server (CAS per key, like server/world-plan.mjs). Each window gets its own fetch view, sharing `keys`. */
function fakeServer(keys = {}) {
  const srv = { keys, calls: [] };
  srv.fetch = (who) => async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const call = { who, method, body: opts.body && JSON.parse(opts.body) };
    srv.calls.push(call);
    if (method === 'GET') return res(200, { v: 1, keys: JSON.parse(JSON.stringify(srv.keys)) });
    const { key, value, baseRev } = call.body;
    const cur = srv.keys[key];
    if ((cur?.rev || 0) !== baseRev) { call.status = 409; return res(409, { rev: cur?.rev || 0, value: cur?.value }); }
    srv.keys[key] = { rev: baseRev + 1, value };
    call.status = 200;
    return res(200, { rev: baseRev + 1 });
  };
  srv.puts = (who) => srv.calls.filter(c => c.method === 'PUT' && (!who || c.who === who));
  return srv;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// A town as the engine saves it: blocks with x/y/w/h/tier/... and the per-build `seen`, lots with goneSince stamps.
const town = (seen, extra = {}) => ({
  v: 1, seed: 7,
  blocks: { alpha: { x: 0, y: 0, w: 8, h: 6, tier: 2, gt: 2, cap: 4, acc: 1, crowns: 1, seen }, beta: { x: 10, y: 0, w: 6, h: 6, tier: 1, gt: 1, cap: 2, acc: 0, crowns: 1, seen: seen - 5 } },
  lots: { alpha: { tier: 2, cap: 4, a: { 'pr:1': 'L1' }, h: {} } },
  ...extra,
});

/** A window: its own localStorage, hydrated against the server, then a mirror on its store.set. `rebuild(now)` is a
 * village build: it rewrites the shown blocks' `seen` (and nothing else), like world/sites.js placeBlocks + saveWorld. */
async function openWindow(srv, who, init, { clock } = {}) {
  const ls = fakeLs(init);
  const fetch = srv.fetch(who);
  const hydrated = await hydratePlan({ fetch, ls, timeoutMs: 300, ...(clock ? { now: () => clock.t } : {}) });
  let hook;
  const m = installPlanMirror({ onStoreSet: cb => { hook = cb; }, fetch, ls, debounceMs: 2, ...(clock ? { now: () => clock.t } : {}) });
  const set = (k, v) => { ls.setItem(k, JSON.stringify(v)); hook(k, v); };
  const rebuild = (now, k = K) => {
    const w = JSON.parse(ls.getItem(k));
    for (const b of Object.values(w.blocks)) if (b.seen > now - 1e9) b.seen = now; // shown blocks only
    set(k, w);
  };
  return { ls, fetch, hydrated, m, set, rebuild, who };
}

for (const key of [K, CLASSIC]) {
  test(`two windows, ${key}: seen-only rebuilds stay one town (no PUT stream, no 409 stale, no backup, no choice)`, async () => {
    const clock = { t: 1_000_000 };
    const srv = fakeServer();
    const A = await openWindow(srv, 'A', { [key]: town(1_000) }, { clock });
    await wait(10);
    assert.equal(srv.keys[key]?.rev, 1, 'A migrated its town');
    const B = await openWindow(srv, 'B', {}, { clock });
    assert.deepEqual(B.hydrated.adopted, [key]);

    // Both windows keep rebuilding the same town (same layout, a fresh `seen` each time), interleaved.
    for (let i = 1; i <= 20; i++) {
      clock.t += 60_000; // a minute apart: 20 minutes in all, well inside the seen push interval
      A.rebuild(clock.t, key); await wait(6);
      B.rebuild(clock.t + 1, key); await wait(6);
    }
    await A.m.flush(); await B.m.flush();
    const puts = srv.puts();
    const n409 = puts.filter(c => c.status === 409).length;
    assert.ok(puts.length <= 2, `(a) seen-only churn is not pushed per rebuild: ${puts.length} PUTs`);
    assert.equal(n409, 0, `(b) no 409s from seen-only churn (${n409})`);
    for (const w of [A, B]) {
      assert.ok(!w.m.stale.has(key), `(b) ${w.who} is not stale`);
      assert.equal(w.ls.getItem(BACKUP_PREFIX + key), null, `(b) ${w.who} saved no backup`);
      assert.deepEqual(planConflicts(w.ls), [], `(c) ${w.who} offers no choice`);
    }

    // (c) Reloading either window afterwards: the same town, no conflict toast.
    for (const w of [A, B]) {
      const again = await hydratePlan({ fetch: srv.fetch(w.who + '-reload'), ls: w.ls, timeoutMs: 300 });
      assert.deepEqual(again.conflicts, [], `(c) ${w.who} reload sees no conflict`);
      assert.deepEqual(planConflicts(w.ls), []);
    }
    // A third window with its own copy of the same town (never synced, other seen stamps): first contact, same town.
    const C = await openWindow(srv, 'C', { [key]: town(42) }, { clock });
    assert.deepEqual(C.hydrated.conflicts, [], '(c) first contact with a seen-only difference is the same town');
    assert.deepEqual(planConflicts(C.ls), []);
  });
}

test('seen-only changes are pushed rarely: once the push interval has passed, then quiet again', async () => {
  const clock = { t: 5_000_000 };
  const srv = fakeServer();
  const A = await openWindow(srv, 'A', { [K]: town(1_000) }, { clock });
  await wait(10);
  const base = srv.puts('A').length;
  assert.equal(base, 1, 'the migration');
  for (let i = 0; i < 5; i++) { clock.t += 1000; A.rebuild(clock.t); await wait(6); }
  assert.equal(srv.puts('A').length, base, 'inside the interval: nothing pushed');
  clock.t += PS.SEEN_PUSH_MS;
  A.rebuild(clock.t); await wait(10);
  assert.equal(srv.puts('A').length, base + 1, 'after the interval: one push carries the fresh seen');
  assert.equal(srv.keys[K].value.blocks.alpha.seen, clock.t, 'the server copy now holds the fresh seen');
  for (let i = 0; i < 5; i++) { clock.t += 1000; A.rebuild(clock.t); await wait(6); }
  assert.equal(srv.puts('A').length, base + 1, 'quiet again');
});

test('a seen-only push that loses the race to another window records the rev; it is not a conflict', async () => {
  const clock = { t: 9_000_000 };
  const srv = fakeServer();
  const A = await openWindow(srv, 'A', { [K]: town(1_000) }, { clock });
  await wait(10);
  const B = await openWindow(srv, 'B', {}, { clock });
  clock.t += PS.SEEN_PUSH_MS + 1;
  A.rebuild(clock.t); await wait(10);        // A pushes its seen (rev 2)
  // B's last push time is older than the interval (it never pushed), so it tries and gets a 409 on the same town.
  B.rebuild(clock.t + 3); await wait(10);
  const lost = srv.puts('B').filter(c => c.status === 409);
  assert.equal(lost.length, 1, 'B tried once, at the rev A had already moved past');
  assert.ok(!B.m.stale.has(K));
  assert.deepEqual(planConflicts(B.ls), []);
  assert.equal(JSON.parse(B.ls.getItem(REVS_KEY))[K].rev, srv.keys[K].rev, 'B now builds on the server rev');
  // And B stays quiet until the interval passes again.
  const n = srv.puts('B').length;
  for (let i = 0; i < 5; i++) { clock.t += 1000; B.rebuild(clock.t); await wait(6); }
  assert.equal(srv.puts('B').length, n);
});

test('a real layout change is still pushed at once, and a real difference still conflicts', async () => {
  const clock = { t: 2_000_000 };
  const srv = fakeServer();
  const A = await openWindow(srv, 'A', { [K]: town(1_000) }, { clock });
  await wait(10);
  const B = await openWindow(srv, 'B', {}, { clock });
  // A moves a block: pushed straight away, not held back like seen.
  const moved = JSON.parse(A.ls.getItem(K)); moved.blocks.beta.x = 30; moved.blocks.alpha.seen = clock.t;
  A.set(K, moved); await wait(10);
  assert.equal(srv.keys[K].value.blocks.beta.x, 30);
  // B, still on the old layout, makes a different change: a 409 with a different town -> stale + backup + choice.
  const other = JSON.parse(B.ls.getItem(K)); other.blocks.alpha.tier = 3;
  B.set(K, other); await wait(10);
  assert.ok(B.m.stale.has(K));
  assert.deepEqual(planConflicts(B.ls), [K]);
  // First contact with a different layout (not just seen) is still a conflict.
  const C = await openWindow(srv, 'C', { [K]: town(1_000, { blocks: { alpha: { x: 99, y: 0, w: 8, h: 6, tier: 2, seen: 1 } } }) }, { clock });
  assert.deepEqual(C.hydrated.conflicts, [K]);
});

test('sameTown / townKey: seen ignored; goneSince and venue low-since stamps compared by presence only', () => {
  const { sameTown, townKey } = PS;
  assert.ok(sameTown(K, town(1), town(2)));
  assert.ok(sameTown(CLASSIC, town(1), town(2)));
  assert.ok(!sameTown(K, town(1), { ...town(1), seed: 8 }));
  const a = town(1), b = town(2); b.blocks.alpha.x = 1;
  assert.ok(!sameTown(K, a, b), 'a moved block is a different town');
  const h1 = town(1), h2 = town(1), h3 = town(1);
  h1.lots.alpha.h['pr:1'] = 100; h2.lots.alpha.h['pr:1'] = 250;
  assert.ok(sameTown(K, h1, h2), 'goneSince seen by two windows a poll apart');
  assert.ok(!sameTown(K, h1, h3), 'an item held in one and not the other');
  const v1 = town(1, { venues: { 'v:dock': { kind: 'dock', level: 2, low: 10 } } }), v2 = town(1, { venues: { 'v:dock': { kind: 'dock', level: 2, low: 99 } } });
  assert.ok(sameTown(K, v1, v2));
  assert.ok(!sameTown(K, v1, town(1, { venues: { 'v:dock': { kind: 'dock', level: 2 } } })));
  assert.ok(!sameTown(K, v1, town(1, { venues: { 'v:dock': { kind: 'dock', level: 3, low: 10 } } })));
  // Only layout keys have volatile fields: the seed and first-seen order compare whole.
  assert.ok(!sameTown('va.seen', ['a', 'b'], ['b', 'a']));
  assert.ok(!sameTown('va.engine2.seed', 1, 2));
  assert.equal(townKey('va.engine2.seed', 5), '5');
  // Key order inside a block does not matter (a window that read the block back may serialise it in another order).
  assert.ok(sameTown(K, { v: 1, blocks: { a: { x: 1, y: 2, seen: 1 } }, lots: {} }, { v: 1, blocks: { a: { y: 2, x: 1, seen: 3 } }, lots: {} }));
});

test('reload: a seen-only unsynced change does not block adopting a newer real layout; same town keeps the newest seen', async () => {
  const clock = { t: 3_000_000 };
  const srv = fakeServer();
  const A = await openWindow(srv, 'A', { [K]: town(1_000) }, { clock });
  await wait(10);
  // A rebuilds (seen only, not pushed: inside the interval), closes. Meanwhile another window lays out a real change.
  clock.t += 1000; A.rebuild(clock.t); await wait(10);
  const changed = JSON.parse(JSON.stringify(srv.keys[K].value)); changed.blocks.beta.x = 40;
  srv.keys[K] = { rev: srv.keys[K].rev + 1, value: changed };
  const r = await hydratePlan({ fetch: srv.fetch('A2'), ls: A.ls, timeoutMs: 300, now: () => clock.t });
  assert.deepEqual(r.conflicts, [], 'not a conflict: this window only re-stamped seen');
  assert.deepEqual(r.adopted, [K]);
  const local = JSON.parse(A.ls.getItem(K));
  assert.equal(local.blocks.beta.x, 40, 'the newer layout');
  assert.equal(local.blocks.alpha.seen, clock.t, 'its own newer seen kept');
  // Same town with an older server seen: local keeps its newer stamps; an older local takes the server's newer ones.
  const ls2 = fakeLs({ [K]: town(10) });
  await hydratePlan({ fetch: fakeServer({ [K]: { rev: 3, value: town(500) } }).fetch('D'), ls: ls2, timeoutMs: 300 });
  assert.equal(JSON.parse(ls2.getItem(K)).blocks.alpha.seen, 500);
  assert.equal(JSON.parse(ls2.getItem(REVS_KEY))[K].rev, 3);
});

test('revs written before townKey (no `s`) still work: identical JSON is unchanged, anything else is an edit', async () => {
  const raw = JSON.stringify(town(1));
  const ls = fakeLs({ [K]: raw, [REVS_KEY]: { [K]: { rev: 2, h: PS.hash(raw) } } });
  const r = await hydratePlan({ fetch: fakeServer({ [K]: { rev: 4, value: town(1, { seed: 9 }) } }).fetch('L'), ls, timeoutMs: 300 });
  assert.deepEqual(r.adopted, [K]);
  assert.ok(JSON.parse(ls.getItem(REVS_KEY))[K].s, 'upgraded to the townKey hash');
});
