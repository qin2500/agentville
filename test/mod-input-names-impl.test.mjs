import test from 'node:test';
import assert from 'node:assert/strict';
import { toWorldInput, shortLabel } from '../web/src/engine/mod/input.js';

const mk = extra => ({ now: 1, agents: [{ id: 'x1', project: 'p', bucket: 'building', harness: 'codex', ...(typeof extra.name === 'string' && extra.shortName === undefined ? { shortName: extra.name } : {}), ...extra }], byId: new Map(), projects: [] });
const nameOf = extra => toWorldInput(mk(extra), { salt: 's' }).input.agents[0].name;

test('short names pass through', () => assert.equal(nameOf({ name: 'Maple' }), 'Maple'));
test('first line only, whitespace collapsed', () => assert.equal(nameOf({ name: 'Fix   the\tbug\nsecond line secret' }), 'Fix the bug'));
test('a leading line break cuts everything (nothing after a break reaches a mod)', () => { assert.equal(shortLabel('\n\n  hello  world\nx'), ''); assert.equal(shortLabel('  hello  world\nx'), 'hello world'); });
test('long names truncate to 32 chars with ellipsis', () => {
  const n = nameOf({ name: 'a'.repeat(100) });
  assert.equal([...n].length, 32);
  assert.ok(n.endsWith('…'));
});
test('exactly 32 chars is kept', () => assert.equal(nameOf({ name: 'b'.repeat(32) }), 'b'.repeat(32)));
test('shortName preferred when present', () => assert.equal(nameOf({ name: 'A very long thread title used as a name for this agent', shortName: 'Birch' }), 'Birch'));
test('non-string and missing names give the neutral label, never a.name', () => { assert.equal(nameOf({ name: 42 }), 'Codex thread'); assert.equal(nameOf({}), 'Codex thread'); assert.equal(nameOf({ name: 'prompt text' , shortName: ''}), 'Codex thread'); });
