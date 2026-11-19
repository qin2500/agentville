import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
const ui = await import('../web/src/ui.js');
const { badgeKind, layoutBadges } = await import('../web/src/engine/overlay/badges.js');
const { copyAgentFields, AGENT_FIELDS } = await import('../web/src/engine/snapshot.js');

const notice = { message: 'Build done\nall green', title: '', at: 1700000000000, count: 2 };
const stalled = { id: 'claude-code:aaa', bucket: 'stalled', severity: 'error', notice: null };
const noted = { id: 'codex:bbb', bucket: 'stalled', severity: 'error', notice };

test('hasNotice / displayState: notice trumps, bucket untouched', () => {
  assert.equal(ui.hasNotice(noted), true);
  assert.equal(ui.hasNotice(stalled), false);
  assert.equal(ui.displayState(noted), 'notice');
  assert.equal(ui.displayState(stalled), 'stalled');
  assert.equal(noted.bucket, 'stalled');
});

test('byDisplayRank puts notice agents above stalled', () => {
  const res = { id: 'r', bucket: 'resting', notice: null }, resNote = { id: 'n', bucket: 'resting', notice };
  const out = [stalled, res, noted, resNote].sort(ui.byDisplayRank).map(a => a.id);
  assert.deepEqual(out.slice(0, 2).sort(), ['codex:bbb', 'n']);
  assert.equal(out[2], 'claude-code:aaa');
});

test('noticeLine: title, else first non-empty message line', () => {
  assert.equal(ui.noticeLine({ title: 'T', message: 'm' }), 'T');
  assert.equal(ui.noticeLine(notice), 'Build done');
  assert.equal(ui.noticeLine({ message: '\n  hi ' }), 'hi');
});

test('clearNotice posts the id and tolerates failure', async () => {
  const calls = [];
  assert.equal(await ui.clearNotice('codex:bbb', async (u, o) => { calls.push([u, o]); return { ok: true }; }), true);
  assert.equal(calls[0][0], '/api/notify/clear');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { id: 'codex:bbb' });
  assert.equal(await ui.clearNotice('x', async () => { throw new TypeError('down'); }), false);
});

test('villager badge: notice wins over every status badge', () => {
  for (const a of [{ bucket: 'stalled', severity: 'error' }, { bucket: 'stalled', prompt: 'q' }, { bucket: 'building' }, { bucket: 'resting' }]) {
    assert.equal(badgeKind({ ...a, notice }), 'note');
  }
  assert.equal(badgeKind({ bucket: 'building', notice: null }), 'build');
  const L = layoutBadges([{ id: 'a', kind: 'agent', rect: [0, 50, 16, 74] }], new Map([['a', { bucket: 'resting', notice }]]), { zoom: 1 });
  assert.equal(L[0].kind, 'note');
});

test('snapshot copies notice', () => {
  assert.ok(AGENT_FIELDS.includes('notice'));
  assert.deepEqual(copyAgentFields({ id: 'a', notice }).notice, notice);
});
