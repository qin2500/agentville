// Town plan sync is opt-in (default off): the gating helpers in web/src/plan-sync.js. Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';

const { planSyncEnabled, planSyncToggleHtml, PLAN_SYNC_KEY } = await import('../web/src/plan-sync.js');
const fakeStore = (init = {}) => ({ get: (k, d) => (k in init ? init[k] : d) });

test('off by default', () => assert.equal(planSyncEnabled(fakeStore()), false));
test('on only for a stored true', () => {
  assert.equal(planSyncEnabled(fakeStore({ [PLAN_SYNC_KEY]: true })), true);
  for (const v of [false, null, 0, 1, 'true', 'on']) assert.equal(planSyncEnabled(fakeStore({ [PLAN_SYNC_KEY]: v })), false);
});
test('the toggle is labelled, bound to data-set=plansync and checked only when on', () => {
  const off = planSyncToggleHtml(fakeStore()), on = planSyncToggleHtml(fakeStore({ [PLAN_SYNC_KEY]: true }));
  assert.match(off, /data-set="plansync"/);
  assert.match(off, /Sync town layout across windows/);
  assert.match(off, /next time/);
  assert.doesNotMatch(off, /checked/);
  assert.match(on, /checked/);
});
