// Tabs of one browser share one localStorage (M7 review must-fixes 1 and 2, should-fixes): web/src/plan-sync.js must
// base every PUT on the rev THIS tab synced, never on the shared va.worldplan.revs, so a tab still showing an older town
// gets a 409 and goes stale instead of pushing its town over another window's choice; nothing ever switches towns by
// itself; a plan file of another version is left alone; a 409 with nothing to choose raises no choice; and the pagehide
// flush uses fetch keepalive for small bodies. Fakes only: no network, no real storage.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createPlanTab, hydratePlan, installPlanMirror, planConflicts, useOtherPlan, keepThisPlan, REVS_KEY, DIRTY_KEY, BACKUP_PREFIX, SEEN_PUSH_MS, KEEPALIVE_MAX } =
  await import('../web/src/plan-sync.js');

const K = 'va.engine2.world';
const fakeLs = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: k => void m.delete(k),
    key: i => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m };
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
/** One CAS server like server/world-plan.mjs; srv.fetch(who) is one window's view. srv.readOnly = 'version' | 'corrupt'. */
function fakeServer(keys = {}, v = 1) {
  const srv = { keys, calls: [], readOnly: null };
  srv.fetch = who => async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const call = { who, method, opts, body: opts.body && JSON.parse(opts.body) };
    srv.calls.push(call);
    if (method === 'GET') return res(200, { v, keys: JSON.parse(JSON.stringify(srv.keys)) });
    if (srv.readOnly) return (call.status = 409, res(409, { error: 'read-only', reason: srv.readOnly }));
    const { key, value, baseRev } = call.body, cur = srv.keys[key];
    if ((cur?.rev || 0) !== baseRev) return (call.status = 409, res(409, { rev: cur?.rev || 0, value: cur ? cur.value : null }));
    srv.keys[key] = { rev: baseRev + 1, value };
    call.status = 200;
    return res(200, { rev: baseRev + 1 });
  };
  srv.puts = who => srv.calls.filter(c => c.method === 'PUT' && (!who || c.who === who));
  return srv;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const val = (ls, k) => JSON.parse(ls.getItem(k));
const revs = ls => JSON.parse(ls.getItem(REVS_KEY) || '{}');
/** One tab: hydrate on the shared ls, then its own mirror; build(v) is the engine saving its in-memory layout. */
async function openTab(srv, ls, who, { debounceMs = 5, now } = {}) {
  const h = await hydratePlan({ fetch: srv.fetch(who), ls, timeoutMs: 300, ...(now ? { now } : {}) });
  let hook;
  const choices = [];
  const m = installPlanMirror({ onStoreSet: cb => { hook = cb; }, fetch: srv.fetch(who), ls, debounceMs, tab: h.tab, onChoice: k => choices.push(k), ...(now ? { now } : {}) });
  return { h, m, choices, build: v => { ls.setItem(K, JSON.stringify(v)); hook(K, v); } };
}
const T1 = { blocks: { a: { x: 1, y: 1, seen: 1 } }, lots: {} };
const T2 = { blocks: { a: { x: 9, y: 9, seen: 1 } }, lots: {} };
const syncedT1 = () => ({ [K]: T1, [REVS_KEY]: { [K]: { rev: 1, h: 'x', s: 'x' } } });

test('two tabs, one localStorage: the tab still showing T1 gets a 409 and goes stale; T2 is never overridden', async () => {
  const srv = fakeServer({ [K]: { rev: 1, value: T1 } });
  const ls = fakeLs({ [K]: T1 });
  const tab1 = await openTab(srv, ls, 'tab1');                       // 1. tab 1 shows T1 (same: revs -> 1)
  assert.equal(revs(ls)[K].rev, 1);
  srv.keys[K] = { rev: 2, value: T2 };                               // 2. another window pushes T2
  const tab2 = await openTab(srv, ls, 'tab2');                       // 3. tab 2 adopts T2; the shared revs move to 2
  assert.deepEqual(tab2.h.adopted, [K]);
  assert.equal(revs(ls)[K].rev, 2);
  tab1.build({ ...T1, blocks: { a: { ...T1.blocks.a, seen: 5 } } }); // 4. tab 1's next build saves T1 again
  await wait(40);
  const [p] = srv.puts('tab1');
  assert.equal(p.body.baseRev, 1, "tab 1's PUT is based on the rev tab 1 synced, not the shared revs");
  assert.equal(p.status, 409);
  assert.deepEqual(srv.keys[K], { rev: 2, value: T2 }, 'the server keeps T2');
  assert.ok(tab1.m.stale.has(K), 'tab 1 is stale');
  assert.deepEqual(planConflicts(ls), [K], 'the Settings choice is offered');
  assert.deepEqual(val(ls, BACKUP_PREFIX + K), { rev: 2, value: T2 });
  // No ping-pong: tab 1 keeps building T1, tab 2 keeps building T2; nothing more is sent.
  tab1.build(T1); tab2.build(T2); tab1.build(T1);
  await wait(40);
  assert.equal(srv.puts().length, 1);
  assert.deepEqual(srv.keys[K], { rev: 2, value: T2 });
  // Nobody is switched automatically: a reload of either tab (whichever town localStorage holds) keeps it and asks.
  for (const town of [T1, T2]) {
    ls.setItem(K, JSON.stringify(town));
    const again = await hydratePlan({ fetch: srv.fetch('reload'), ls, timeoutMs: 300 });
    assert.deepEqual(again.adopted, []);
    assert.deepEqual(val(ls, K), town);
    if (town === T1) assert.deepEqual(again.conflicts, [K]);
  }
  assert.equal(srv.puts().length, 1);
});

test("a stale tab's edit is never flushed by another tab's startup (the dirty mark carries its base rev)", async () => {
  const srv = fakeServer({ [K]: { rev: 1, value: T1 } });
  const ls = fakeLs({ [K]: T1 });
  const tab1 = await openTab(srv, ls, 'tab1', { debounceMs: 10_000 }); // its push has not gone out yet
  srv.keys[K] = { rev: 2, value: T2 };
  await openTab(srv, ls, 'tab2');                                     // adopts T2, shared revs at 2
  tab1.build({ blocks: { a: { x: 1, y: 2 } }, lots: {} });            // tab 1 edits its T1: dirty, based on rev 1
  assert.deepEqual(JSON.parse(ls.getItem(DIRTY_KEY))[K], { b: 1 });
  const tab3 = await hydratePlan({ fetch: srv.fetch('tab3'), ls, timeoutMs: 300 });
  assert.deepEqual(tab3.adopted, []);
  assert.deepEqual(tab3.conflicts, [K], 'a choice, not a flush over T2');
  assert.equal(srv.puts().length, 0);
  assert.deepEqual(srv.keys[K], { rev: 2, value: T2 });
  tab1.m.stop();
});

test("another window's \"Keep this one\" is not undone by a tab that hydrated before it", async () => {
  const srv = fakeServer({ [K]: { rev: 3, value: T1 } });
  const ls = fakeLs({ [K]: T1 });
  const tab1 = await openTab(srv, ls, 'tab1');
  srv.keys[K] = { rev: 4, value: T2 };                                // window B (other browser): Keep this one -> T2
  tab1.build({ blocks: { a: { x: 1, y: 1 }, b: { x: 3, y: 3 } }, lots: {} }); // a real edit on T1
  await wait(40);
  assert.equal(srv.puts('tab1')[0].body.baseRev, 3);
  assert.deepEqual(srv.keys[K], { rev: 4, value: T2 });
  assert.ok(tab1.m.stale.has(K));
  // Window B reloads (its own localStorage, synced T2 at rev 4): no auto-adopt of T1, nothing changes.
  const lsB = fakeLs({ [K]: T2, [REVS_KEY]: { [K]: { rev: 4, h: 'x', s: 'x' } } });
  const b = await hydratePlan({ fetch: srv.fetch('B'), ls: lsB, timeoutMs: 300 });
  assert.deepEqual(val(lsB, K), T2);
  assert.deepEqual(b.adopted, []); assert.deepEqual(b.conflicts, []);
});

test('two tabs on one localStorage showing the same town: seen-only churn stays quiet and never goes stale', async () => {
  let t = 1_000_000;
  const now = () => t;
  const srv = fakeServer({ [K]: { rev: 1, value: T1 } });
  const ls = fakeLs({ [K]: T1 });
  const a = await openTab(srv, ls, 'a', { now }), b = await openTab(srv, ls, 'b', { now });
  for (let i = 0; i < 5; i++) { a.build({ ...T1, blocks: { a: { ...T1.blocks.a, seen: 10 + i } } }); b.build({ ...T1, blocks: { a: { ...T1.blocks.a, seen: 20 + i } } }); }
  await wait(40);
  assert.equal(srv.puts().length, 0, 'no PUT per rebuild');
  t += SEEN_PUSH_MS + 1;
  b.build({ ...T1, blocks: { a: { ...T1.blocks.a, seen: 99 } } });   // b's hourly seen refresh: rev 2
  await wait(40);
  assert.equal(srv.keys[K].rev, 2);
  t += SEEN_PUSH_MS + 1;
  a.build({ ...T1, blocks: { a: { ...T1.blocks.a, seen: 120 } } });  // a, still at rev 1: 409 on the same town
  await wait(40);
  assert.ok(srv.puts('a').length <= 1);
  assert.ok(!a.m.stale.has(K) && !b.m.stale.has(K));
  assert.deepEqual(planConflicts(ls), []);
  assert.equal(a.m.tab.revs.get(K).rev, srv.keys[K].rev, "a's own record catches up on the same town");
});

test('useOtherPlan / keepThisPlan move this tab\'s own record too', async () => {
  const srv = fakeServer({ [K]: { rev: 1, value: T1 } });
  const ls = fakeLs({ [K]: T1 });
  const tab1 = await openTab(srv, ls, 'tab1');
  srv.keys[K] = { rev: 2, value: T2 };
  tab1.build({ blocks: { a: { x: 1, y: 5 } }, lots: {} });
  await wait(40);
  assert.ok(tab1.m.stale.has(K));
  const r = await keepThisPlan({ fetch: srv.fetch('tab1'), ls, tab: tab1.m.tab });
  assert.deepEqual(r, { kept: [K], failed: [], moved: [] });
  assert.equal(tab1.m.tab.revs.get(K).rev, 3);
  tab1.m.resume(r.kept);
  tab1.build({ blocks: { a: { x: 1, y: 6 } }, lots: {} });
  await wait(40);
  assert.equal(srv.keys[K].rev, 4, 'the next edit goes up on the rev this tab kept');
  const ls2 = fakeLs({ [K]: T1, [BACKUP_PREFIX + K]: { rev: 7, value: T2 } });
  const tab = createPlanTab(); tab.conflicts.set(K, { rev: 7, value: T2 });
  useOtherPlan({ ls: ls2, tab });
  assert.equal(tab.revs.get(K).rev, 7);
});

test('a plan file of another version: no adopt, no migrate, and the mirror never pushes', async () => {
  const srv = fakeServer({ [K]: { rev: 5, value: T2 }, 'va.seen': { rev: 1, value: ['x'] } }, 2);
  const ls = fakeLs({ [K]: T1 });
  const before = new Map(ls._m);
  const tab = await openTab(srv, ls, 'm7');
  assert.equal(tab.h.source, 'local');
  assert.deepEqual(new Map(ls._m), before, 'nothing of the v2 file is written locally');
  tab.build({ blocks: { a: { x: 4, y: 4 } }, lots: {} });
  await tab.m.flush();
  assert.equal(srv.puts().length, 0);
  assert.equal((await hydratePlan({ fetch: fakeServer({}, null).fetch('x'), ls: fakeLs(), timeoutMs: 300 })).source, 'local', 'no or unknown version: hands off too');
});

for (const reason of ['version', 'corrupt']) {
  test(`a 409 '${reason}' (no value) raises no conflict, no backup and no choice`, async () => {
    const srv = fakeServer({}); srv.readOnly = reason;
    const ls = fakeLs({ [K]: T1 });
    const tab = await openTab(srv, ls, 'w');
    assert.deepEqual(tab.h.conflicts, [], 'no toast');
    assert.deepEqual(planConflicts(ls), [], 'no Settings choice');
    const ls2 = fakeLs(syncedT1()); const srv2 = fakeServer({ [K]: { rev: 1, value: T1 } }); srv2.readOnly = reason;
    const t2 = await openTab(srv2, ls2, 'w2');
    t2.build({ blocks: { a: { x: 7, y: 7 } }, lots: {} });
    await wait(40);
    assert.equal(srv2.puts().length, 1);
    assert.ok(t2.m.stale.has(K), 'that key stops pushing');
    assert.deepEqual(planConflicts(ls2), []);
  });
}

test('pagehide flush: keepalive for bodies that fit 64 KiB, plain fetch (left dirty if cut off) for bigger ones', async () => {
  const srv = fakeServer({});
  const ls = fakeLs();
  const tab = await openTab(srv, ls, 'w', { debounceMs: 10_000 });
  tab.build({ blocks: { a: { x: 1, y: 1 } }, lots: {} });
  await tab.m.flush({ keepalive: true });
  assert.equal(srv.puts()[0].opts.keepalive, true);
  tab.build({ blocks: { a: { x: 1, y: 2 } }, lots: {}, pad: 'x'.repeat(KEEPALIVE_MAX) });
  await tab.m.flush({ keepalive: true });
  assert.equal(srv.puts()[1].opts.keepalive, undefined);
  tab.build({ blocks: { a: { x: 1, y: 3 } }, lots: {} });
  await tab.m.flush();
  assert.equal(srv.puts()[2].opts.keepalive, undefined, 'an ordinary flush does not use keepalive');
});

// Engine Lead follow-up: the Settings note and toast belong to the tab that is out of date, and "Keep this one" pushes
// that tab's own town even when another tab wrote the shared localStorage last.
test('only the refused tab gets the choice; the up-to-date tab shows nothing and keeps saving', async () => {
  const srv = fakeServer({ [K]: { rev: 1, value: T1 } });
  const ls = fakeLs({ [K]: T1 });
  const tab1 = await openTab(srv, ls, 'tab1');
  srv.keys[K] = { rev: 2, value: T2 };
  const tab2 = await openTab(srv, ls, 'tab2');
  tab1.build({ blocks: { a: { x: 1, y: 1 }, c: { x: 5, y: 5 } }, lots: {} });
  await wait(40);
  assert.ok(tab1.m.stale.has(K));
  assert.deepEqual(planConflicts(ls, tab1.m.tab), [K], 'tab 1: the note');
  assert.deepEqual(tab1.choices, [K], 'tab 1: the toast');
  assert.deepEqual(planConflicts(ls, tab2.m.tab), [], 'tab 2 is up to date: no note');
  assert.deepEqual(tab2.choices, [], 'tab 2: no toast');
  assert.deepEqual(tab2.h.conflicts, []);
  // Tab 2 is not blocked by tab 1's backup: its own edit goes up on its own rev.
  const T2b = { blocks: { a: { x: 9, y: 9 }, d: { x: 2, y: 2 } }, lots: {} };
  tab2.build(T2b);
  await wait(40);
  assert.deepEqual(srv.keys[K], { rev: 3, value: T2b });
  assert.equal(tab1.choices.length, 1);
});

test('"Keep this one" in the refused tab pushes that tab\'s own town, not the one another tab last wrote', async () => {
  const srv = fakeServer({ [K]: { rev: 1, value: T1 } });
  const ls = fakeLs({ [K]: T1 });
  const tab1 = await openTab(srv, ls, 'tab1');
  srv.keys[K] = { rev: 2, value: T2 };
  const tab2 = await openTab(srv, ls, 'tab2');
  const mine = { blocks: { a: { x: 1, y: 1 }, c: { x: 5, y: 5 } }, lots: {} };
  tab1.build(mine);
  await wait(40);
  assert.ok(tab1.m.stale.has(K));
  const T2b = { blocks: { a: { x: 9, y: 9 }, d: { x: 2, y: 2 } }, lots: {} };
  tab2.build(T2b);                                           // tab 2 writes last (and pushes: rev 3)
  await wait(40);
  assert.deepEqual(val(ls, K), T2b);
  // The server moved (rev 3) since tab 1 was shown rev 2: Keep never overwrites that unseen; the choice is refreshed.
  const first = await keepThisPlan({ fetch: srv.fetch('tab1'), ls, tab: tab1.m.tab });
  assert.deepEqual(first, { kept: [], failed: [K], moved: [K] });
  assert.equal(srv.puts('tab1').at(-1).body.baseRev, 2, "at the backup's rev");
  assert.deepEqual(srv.keys[K], { rev: 3, value: T2b });
  assert.deepEqual(planConflicts(ls, tab1.m.tab), [K], 'the note stays up');
  assert.deepEqual(tab1.m.tab.conflicts.get(K), { rev: 3, value: T2b }, 'now offering the newer copy');
  // Shown the newer copy, the person keeps this one again: tab 1's own town goes up.
  const r = await keepThisPlan({ fetch: srv.fetch('tab1'), ls, tab: tab1.m.tab });
  assert.deepEqual(r, { kept: [K], failed: [], moved: [] });
  assert.equal(srv.puts('tab1').at(-1).body.baseRev, 3);
  assert.deepEqual(srv.keys[K], { rev: 4, value: mine }, "tab 1's own town");
  assert.deepEqual(val(ls, K), mine);
  assert.deepEqual(planConflicts(ls, tab1.m.tab), []);
  assert.equal(ls.getItem(BACKUP_PREFIX + K), null);
  tab1.m.resume(r.kept);
  const mine2 = { blocks: { a: { x: 1, y: 1 }, c: { x: 6, y: 6 } }, lots: {} };
  tab1.build(mine2);
  await wait(40);
  assert.deepEqual(srv.keys[K], { rev: 5, value: mine2 }, 'tab 1 carries on from the rev it kept');
});

test('"Use the town saved by your other window" still writes the server copy this tab was refused for', async () => {
  const srv = fakeServer({ [K]: { rev: 1, value: T1 } });
  const ls = fakeLs({ [K]: T1 });
  const tab1 = await openTab(srv, ls, 'tab1');
  srv.keys[K] = { rev: 2, value: T2 };
  tab1.build({ blocks: { a: { x: 1, y: 1 }, c: { x: 5, y: 5 } }, lots: {} });
  await wait(40);
  useOtherPlan({ ls, tab: tab1.m.tab });
  assert.deepEqual(val(ls, K), T2);
  assert.equal(revs(ls)[K].rev, 2);
  assert.deepEqual(planConflicts(ls, tab1.m.tab), []);
  assert.equal(ls.getItem(BACKUP_PREFIX + K), null);
  assert.equal(srv.puts().length, 1, 'nothing pushed');
});
