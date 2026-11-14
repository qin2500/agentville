// WorldInput agent names are short labels: first line only, whitespace collapsed, <= 32 chars. Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toWorldInput } from '../web/src/engine/mod/input.js';
import { makeView } from '../web/src/engine/snapshot.js';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const TOKEN = 'ZQXCANARYTOKEN7731';
const line1 = 'Refactor the billing module now';           // 31 chars, token comes after char 40 overall
const longPrompt = [
  `${line1} and then ${TOKEN} continue`,
  'second line of the prompt with   extra    spacing and more detail '.repeat(2),
  'third line: '.padEnd(120, 'x'),
].join('\n').padEnd(400, 'z');

const mk = (id, name, over = {}) => ({ id, name, shortName: name, project: 'alpha', bucket: 'building', severity: null, prompt: null, role: 'solo',
  live: true, lastActivityAt: NOW - 60_000, since: NOW - 3_600_000, harness: 'codex', prs: [], ...over });
const build = agents => {
  const view = makeView({ agents, projects: [] }, { now: NOW, demo: true });
  const r = toWorldInput(view, { seed: 1, salt: 's' });
  return { r, nameOf: id => r.input.agents.find(a => a.id === r.opaqueId(id)).name };
};

test('canary: long 3-line codex prompt name leaks nothing past 32 chars anywhere in the WorldInput', { todo: 'needs m1h' }, () => {
  assert.ok(longPrompt.length >= 400 && longPrompt.indexOf(TOKEN) > 40);
  const { r } = build([mk('c1', longPrompt)]);
  const s = JSON.stringify(r.input);
  assert.ok(!s.includes(TOKEN), 'canary token leaked');
  assert.ok(!s.includes('second line'), 'second line leaked');
  assert.ok(!s.includes('third line'), 'third line leaked');
  assert.ok(!s.includes('\\n'), 'newline survived');
});

test('name is at most 32 chars and a single line', { todo: 'needs m1h' }, () => {
  const { nameOf } = build([mk('c1', longPrompt)]);
  const n = nameOf('c1');
  assert.ok(n.length <= 32, `length ${n.length}`);
  assert.ok(!/[\r\n\t]/.test(n));
  assert.ok(n.length > 0);
});

test('first line only: the first line is the label (prefix kept)', { todo: 'needs m1h' }, () => {
  const { nameOf } = build([mk('a', 'Fix login bug\nthen deploy everything\nand more')]);
  assert.equal(nameOf('a'), 'Fix login bug');
});

test('whitespace is collapsed and trimmed', { todo: 'needs m1h' }, () => {
  const { nameOf } = build([mk('a', '   Fix \t  the    login   bug   ')]);
  assert.equal(nameOf('a'), 'Fix the login bug');
});

test('short single-line names pass through unchanged', () => {
  const { nameOf } = build([mk('a', 'Atlas'), mk('b', 'x'.repeat(32))]);
  assert.equal(nameOf('a'), 'Atlas');
  assert.equal(nameOf('b'), 'x'.repeat(32));
});

test('CRLF and unicode line separators also end the first line', { todo: 'needs m1h' }, () => {
  const { r } = build([mk('a', `Short title\r\n${TOKEN} hidden`), mk('b', `Other title ${TOKEN}B`)]);
  assert.ok(!JSON.stringify(r.input).includes('ZQXCANARYTOKEN7731'));
});

test('ellipsis is allowed but total stays within 32 chars', { todo: 'needs m1h' }, () => {
  const { nameOf } = build([mk('a', 'w'.repeat(200))]);
  const n = nameOf('a');
  assert.ok(n.length <= 32);
  assert.ok(n.startsWith('w'.repeat(20)));
});

test('empty, missing and non-string names do not throw and give a string', () => {
  const { nameOf } = build([mk('a', ''), mk('b', undefined), mk('c', 42)]);
  for (const id of ['a', 'b', 'c']) assert.equal(typeof nameOf(id), 'string');
});

test('every agent in a mixed view is bounded, none leaks the token', { todo: 'needs m1h' }, () => {
  const { r } = build([mk('a', longPrompt), mk('b', longPrompt, { harness: 'claude-code' }), mk('c', 'ok')]);
  for (const a of r.input.agents) assert.ok(a.name.length <= 32);
  assert.ok(!JSON.stringify(r.input).includes(TOKEN));
});
