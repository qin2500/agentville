import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdapter } from '../server/providers/contract.mjs';
import { getProvider, providers, providerOfHarness, providerOfAgent, registerProvider, unregisterProvider }
  from '../server/providers/index.mjs';

const fn = () => {};
function make(over = {}) {
  const accounts = Object.fromEntries(['load', 'list', 'usage', 'cachedUsage', 'activeUsage', 'capture', 'addStart',
    'addFinish', 'addCancel', 'rename', 'remove', 'readLive', 'identify', 'activate', 'restoreLive', 'checkActive',
    'headroom'].map((k) => [k, fn]));
  const switcher = Object.fromEntries(['profile', 'status', 'switchTo', 'undo', 'lastChangeAt', 'isBusy'].map((k) => [k, fn]));
  return {
    id: 'gemini', label: 'Gemini', harness: 'gemini-cli',
    capabilities: { start: true, stop: true, resume: true, fork: false, message: true, accounts: true, usage: 'errors', handoffTarget: true },
    home: fn, available: fn, bin: fn, sessionEnv: ['X'], scan: fn, configure: fn, activity: fn, options: fn,
    startPlan: fn, resumePlan: fn, stopPlan: fn, display: fn, run: fn, accounts,
    credentials: { read: fn, write: fn, identify: fn }, switcher, isLimitText: fn, limitModel: fn, tuning: {},
    readTranscript: fn, ...over,
  };
}

test('a complete adapter passes', () => { assert.doesNotThrow(() => assertAdapter(make())); });
test('bad id, missing function, bad usage mode are all reported', () => {
  assert.throws(() => assertAdapter(make({ id: 'bogus' })), /id must be/);
  assert.throws(() => assertAdapter(make({ scan: undefined })), /scan must be a function/);
  const m = make(); m.capabilities.usage = 'x';
  assert.throws(() => assertAdapter(m), /usage/);
});
test('capabilities must agree with functions', () => {
  assert.throws(() => assertAdapter(make({ capabilities: { ...make().capabilities, fork: true } })), /needs forkPlan/);
  assert.throws(() => assertAdapter(make({ accounts: undefined })), /accounts missing/);
  const noAcc = make({ accounts: undefined, switcher: undefined });
  noAcc.capabilities.accounts = false;
  assert.doesNotThrow(() => assertAdapter(noAcc));
});
test('providerOfHarness and providerOfAgent', () => {
  assert.equal(providerOfHarness('claude-code'), 'claude');
  assert.equal(providerOfHarness('gemini-cli'), 'gemini');
  assert.equal(providerOfHarness('codex'), 'codex');
  assert.equal(providerOfHarness('opencode'), null);
  assert.equal(providerOfAgent({ provider: 'gemini', harness: 'claude-code' }), 'gemini');
  assert.equal(providerOfAgent({ harness: 'gemini-cli' }), 'gemini');
  assert.equal(providerOfAgent({ harness: 'cursor' }), null);
  assert.equal(providerOfAgent(null), null);
});
test('registry registers, looks up and tolerates absent adapters', () => {
  const had = getProvider('gemini');
  if (!had) {
    assert.equal(getProvider('gemini'), null);
    registerProvider(make());
    assert.equal(getProvider('gemini').label, 'Gemini');
    assert.ok(providers().some((p) => p.id === 'gemini'));
    unregisterProvider('gemini');
  }
  assert.equal(getProvider('nope'), null);
  assert.throws(() => registerProvider({ id: 'gemini' }), /adapter gemini/);
});
