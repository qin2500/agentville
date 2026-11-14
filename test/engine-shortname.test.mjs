import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../server/classify.mjs';
import { makeView } from '../web/src/engine/snapshot.js';
import { toWorldInput, shortLabel } from '../web/src/engine/mod/input.js';

const NOW = 1_800_000_000_000;
const CANARY = 'CANARY-PROMPT-7f3a do the thing';
const fact = extra => ({ id: 'codex:t1', harness: 'codex', kind: 'session', project: 'proj', lifecycle: 'running', live: true,
  lastActivityAt: NOW - 1000, name: CANARY, title: CANARY, ...extra });
const input = extra => {
  const [a] = build([fact(extra)], {}, NOW);
  const view = makeView({ agents: [a], byId: new Map([[a.id, a]]), projects: [] }, { now: NOW });
  return { a, input: toWorldInput(view, { salt: 's' }).input };
};

test('codex thread without nickname: shortName empty, canary never reaches WorldInput', () => {
  const { a, input: wi } = input({ nickname: '' });
  assert.equal(a.shortName, '');
  assert.ok(!JSON.stringify(wi).includes('CANARY'));
  assert.equal(wi.agents[0].name, 'Codex thread');
});
test('codex nickname becomes shortName and the mod name', () => {
  const { a, input: wi } = input({ nickname: 'Birch' });
  assert.equal(a.shortName, 'Birch');
  assert.equal(wi.agents[0].name, shortLabel('Birch'));
  assert.ok(!JSON.stringify(wi).includes('CANARY'));
});
test('multi-line / long nickname is truncated per shortLabel', () => {
  const nick = `First line that is far longer than thirty-two characters\nsecond line secret`;
  const { input: wi } = input({ nickname: nick });
  assert.equal(wi.agents[0].name, shortLabel(nick));
  assert.ok([...wi.agents[0].name].length <= 32);
  assert.ok(!wi.agents[0].name.includes('secret'));
});
test('claude session: only a user-set nickname is used; a name from the aiTitle summary is not', () => {
  const c = { id: 'c1', harness: 'claude-code', name: '', title: CANARY };
  assert.equal(input(c).input.agents[0].name, 'Claude session');
  assert.equal(input({ ...c, name: 'AI-SUMMARY-9c1 of the chat' }).input.agents[0].name, 'Claude session');
  assert.ok(!JSON.stringify(input({ ...c, name: 'AI-SUMMARY-9c1 of the chat' }).input).includes('AI-SUMMARY'));
  assert.equal(input({ ...c, name: 'Oak', nickname: 'Oak' }).input.agents[0].name, 'Oak');
  assert.ok(!JSON.stringify(input(c).input).includes('CANARY'));
});
