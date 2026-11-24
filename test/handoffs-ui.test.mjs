import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffsHTML, handoffActions, loadHandoffs, handoffAction } from '../web/src/handoffs.js';

test('rows show agents, state, note and Undo', () => {
  const html = handoffsHTML([{ id: 'h1', state: 'started', from: { name: 'A', provider: 'claude' }, to: { name: 'B', provider: 'gemini' }, notePath: '/n.md' }]);
  assert.match(html, /A \(Claude\) → B \(Gemini\)/);
  assert.match(html, /handoff-undo/);
  assert.match(html, /n\.md/);
});
test('actions by state', () => {
  assert.deepEqual(handoffActions({ state: 'failed' }).map(a => a.act), ['retry', 'dismiss']);
});
test('404 is an empty list', async () => {
  assert.deepEqual(await loadHandoffs(async () => ({ ok: false, status: 404 })), []);
  assert.deepEqual(await loadHandoffs(async () => { throw new TypeError('x'); }), []);
  await assert.rejects(handoffAction(async () => ({ ok: false, status: 404, json: async () => ({}) }), 'h', 'undo'), /not support/);
});
