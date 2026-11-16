// Parity tool: heuristics on a fixture tree, schema of docs/engine-parity.json, and drift check (in-process).
// The M4 gate itself (>= 0.90) is NOT asserted here; the lead runs `node tools/parity.mjs --gate M4`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compute, render, check, gate, scan, parseTap, parseE2e } from '../tools/parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const item = (id, o = {}) => ({ id, area: 'x', text: id, classic: [], milestone: 'M4', piece: 'P', test: null, status: 'todo', ...o });

function fixture(files, items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const doc = { v: 1, source: 's', items };
  fs.writeFileSync(path.join(dir, 'docs/engine-parity.json'), render(doc));
  return { dir, doc };
}
const statusOf = (dir, doc) => Object.fromEntries(compute(dir, doc).items.map(i => [i.id, i.status]));

test('parity: tag + real test = done, tag only = partial, nothing = missing', () => {
  const { dir, doc } = fixture({
    'web/src/engine/a.js': '// parity: a.one\n// parity: b.two, c.three\n',
    'test/a.test.mjs': "test('does a [a.one]', () => {});\ntest('proves c [c.three] too', { timeout: 5 }, () => {});\ntest('no tag [d.four]', () => {});\n",
  }, ['a.one', 'b.two', 'c.three', 'd.four', 'e.five'].map(id => item(id)));
  assert.deepEqual(statusOf(dir, doc), { 'a.one': 'done', 'b.two': 'partial', 'c.three': 'done', 'd.four': 'missing', 'e.five': 'missing' });
});

test('parity: todo and skip tests, test.todo() and unknown ids do not count as proof', () => {
  const { dir, doc } = fixture({
    'web/src/engine/a.js': '// parity: a.one, b.two, c.three, d.four\n',
    'test/a.test.mjs': [
      "test('x [a.one]', { todo: 'needs module' }, () => {});",
      "test('y [b.two]', { skip: true }, () => {});",
      "test.todo('z [c.three]');",
      "test('live [d.four] [not.an.item]', () => {});",
    ].join('\n'),
  }, ['a.one', 'b.two', 'c.three', 'd.four'].map(id => item(id)));
  assert.deepEqual(statusOf(dir, doc), { 'a.one': 'partial', 'b.two': 'partial', 'c.three': 'partial', 'd.four': 'done' });
});

test('parity: a dynamic todo option (module may exist) counts, and the t() alias is understood', () => {
  const { dir, doc } = fixture({
    'mods/m/index.js': '// parity: a.one\n',
    'test/a.test.mjs': "const TODO = false;\nt('alias [a.one]', () => {});\ntest('dyn [a.one]', { todo: TODO }, () => {});\n",
  }, [item('a.one')]);
  assert.equal(statusOf(dir, doc)['a.one'], 'done');
});

test('parity: waived and every other field survive a recompute; engine lists the tagged files', () => {
  const { dir, doc } = fixture({ 'web/src/engine/z.js': '// parity: a.one\n', 'web/src/engine/y.js': '// parity: a.one\n' },
    [item('a.one', { waived: 'owner decision', classic: ['web/src/village.js:1'], test: 'e2e/x.spec.mjs', engine: [] }), item('b.two')]);
  const [a] = compute(dir, doc).items;
  assert.equal(a.waived, 'owner decision');
  assert.deepEqual(a.classic, ['web/src/village.js:1']);
  assert.equal(a.test, 'e2e/x.spec.mjs');
  assert.deepEqual(a.engine, ['web/src/engine/y.js', 'web/src/engine/z.js']);
});

test('parity: gate counts done over milestone <= M4 minus waived, and partial counts as zero', () => {
  const doc = { items: [
    item('a', { status: 'done' }), item('b', { status: 'partial' }), item('c', { status: 'missing', waived: 'x' }),
    item('d', { status: 'done', milestone: 'M2' }), item('e', { status: 'missing', milestone: 'M5' }),
  ] };
  const g = gate(doc, 'M4');
  assert.deepEqual([g.done, g.total], [2, 3]);
  assert.ok(Math.abs(g.ratio - 2 / 3) < 1e-9);
});

test('parity: render is stable (render of a parsed render is identical)', () => {
  const doc = { v: 1, source: 's', items: [item('a', { classic: ['p:1', 'p:2'], engine: ['e.js'], waived: 'w' })] };
  assert.equal(render(JSON.parse(render(doc))), render(doc));
});

test('parity: scan only looks at the known dirs and ignores node_modules', () => {
  const { dir } = fixture({ 'node_modules/x/a.js': '// parity: a.one\n', 'docs/x.js': '// parity: a.one\n', 'web/src/engine/ok.js': '// parity: a.one\n' }, [item('a.one')]);
  assert.deepEqual([...scan(dir, ['a.one']).tags.get('a.one')], ['web/src/engine/ok.js']);
});

test('parity: docs/engine-parity.json has the schema (engine array on every item, status in the tool vocabulary)', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(root, 'docs/engine-parity.json'), 'utf8'));
  const ids = new Set();
  for (const it of doc.items) {
    assert.ok(!ids.has(it.id), `duplicate id ${it.id}`); ids.add(it.id);
    assert.ok(Array.isArray(it.engine), `${it.id}: engine must be an array`);
    assert.ok(['done', 'partial', 'missing'].includes(it.status), `${it.id}: status ${it.status}`);
    assert.match(it.milestone, /^M\d+$/);
    if ('waived' in it) assert.ok(typeof it.waived === 'string' && it.waived.length, `${it.id}: waived needs a reason`);
  }
});

test('parity: the committed docs/engine-parity.json matches the repo (run `node tools/parity.mjs --write` if this fails)', () => {
  const r = check(root);
  assert.deepEqual(r.drift.slice(0, 10), []);
});

const names = tap => parseTap(tap).passed.map(p => p.join(' > '));

test('parity tap: passed counts; todo, skip and failed do not', () => {
  const tap = ['TAP version 13', '# Subtest: a [x.one]', 'ok 1 - a [x.one]', '# Subtest: b [x.two]', 'ok 2 - b [x.two] # TODO',
    '# Subtest: c [x.three]', 'ok 3 - c [x.three] # SKIP', '# Subtest: d [x.four]', 'not ok 4 - d [x.four]', '  ---', '  error: boom', '  ...', '1..4'].join('\n');
  assert.deepEqual(names(tap), ['a [x.one]']);
});

test('parity tap: nested subtests keep the parent title and need every ancestor to pass', () => {
  const tap = [
    '# Subtest: grp [g.one]', '    # Subtest: c1', '    ok 1 - c1', '    # Subtest: c2', '    ok 2 - c2 # TODO', '    1..2', 'ok 1 - grp [g.one]',
    '# Subtest: bad [g.two]', '    # Subtest: c3', '    ok 1 - c3', '    1..1', 'not ok 2 - bad [g.two]',
    '# Subtest: deep', '    # Subtest: mid [g.three]', '        # Subtest: leaf', '        ok 1 - leaf', '        1..1', '    ok 1 - mid [g.three]', '    1..1', 'ok 3 - deep',
    '# Subtest: todoparent [g.four]', '    # Subtest: k', '    ok 1 - k', '    1..1', 'ok 4 - todoparent [g.four] # TODO',
    '1..4'].join('\n');
  assert.deepEqual(names(tap), ['grp [g.one] > c1', 'deep > mid [g.three] > leaf']);
});

test('parity tap: a describe that only has todo children proves nothing; ids come from the title path', () => {
  const tap = ['    # Subtest: c', '    ok 1 - c # TODO', '    1..1', 'ok 1 - only todo [t.one]', 'ok 2 - plain [t.two]'].join('\n');
  assert.deepEqual(names(tap), ['plain [t.two]']);
});

test('parity run proof: scan with a ran map ignores static test titles', () => {
  const { dir, doc } = fixture({ 'web/src/engine/a.js': '// parity: a.one, b.two\n', 'test/a.test.mjs': "test('x [a.one]', { todo: TODO }, () => {});\n" },
    ['a.one', 'b.two'].map(id => item(id)));
  assert.deepEqual(statusOf(dir, doc), { 'a.one': 'done', 'b.two': 'partial' });
  const ran = new Map([['b.two', new Set(['test/engine-x.test.mjs'])]]);
  assert.deepEqual(Object.fromEntries(compute(dir, doc, ran).items.map(i => [i.id, i.status])), { 'a.one': 'partial', 'b.two': 'done' });
});

test('parity e2e: only passed, non-skipped specs from a Playwright report count', () => {
  const rep = { suites: [{ title: 'w.spec.mjs', specs: [], suites: [{ title: 'world [e.one]', specs: [
    { title: 'ok', ok: true, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] },
    { title: 'skipped [e.two]', ok: true, tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] },
    { title: 'failed [e.three]', ok: false, tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }] }] }] }] };
  assert.deepEqual(parseE2e(rep).passed, [['w.spec.mjs', 'world [e.one]', 'ok']]);
});

test('parity check: a "proof": "run" JSON is checked statically (engine matches, done needs a tag)', () => {
  const { dir, doc } = fixture({ 'web/src/engine/a.js': '// parity: a.one\n' }, [item('a.one'), item('b.two')]);
  const good = { ...compute(dir, doc, new Map([['a.one', new Set(['t'])]])), proof: 'run' };
  fs.writeFileSync(path.join(dir, 'docs/engine-parity.json'), render(good));
  assert.deepEqual(check(dir).drift, []);
  good.items[1].status = 'done';
  fs.writeFileSync(path.join(dir, 'docs/engine-parity.json'), render(good));
  assert.equal(check(dir).drift[0].id, 'b.two');
});
