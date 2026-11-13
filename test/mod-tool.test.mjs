import './support/ensure-mods-index.mjs';
// tools/mod.mjs: `new` into a temp dir, `check`, and the `shots --dry-run` plan. Synthetic fixtures only; no browser, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const { newMod, checkMod, shotsPlan, validateNewId } = await import('../tools/mod.mjs');

const TOOL = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'mod.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mod-tool-'));

test('new copies the template, sets id, name and extends, and leaves no placeholder behind', async () => {
  const root = tmp();
  try {
    const dest = await newMod('anna.autumn-fair', { root, extendsId: 'agentville.fantasy' });
    assert.equal(dest, path.join(root, 'mods', 'anna.autumn-fair'));
    const src = fs.readFileSync(path.join(dest, 'index.js'), 'utf8');
    assert.match(src, /id: 'anna\.autumn-fair'/);
    assert.match(src, /name: 'Autumn Fair'/);
    assert.match(src, /extends: 'agentville\.fantasy'/);
    assert.ok(!src.includes('example.template'));
    assert.ok(fs.existsSync(path.join(dest, 'README.md')));
    await assert.rejects(newMod('anna.autumn-fair', { root }), /already exists/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('new rejects bad ids and bad parents, and writes nothing', async () => {
  const root = tmp();
  try {
    for (const bad of ['', 'nodots', 'Upper.case', 'agentville.mine', 'a.b.demo', '../x.y', 'a b.c']) {
      await assert.rejects(newMod(bad, { root }), undefined, `id ${JSON.stringify(bad)}`);
    }
    await assert.rejects(newMod('anna.ok', { root, extendsId: 'someone.else' }), /--extends/);
    assert.ok(!fs.existsSync(path.join(root, 'mods')));
    await assert.rejects(validateNewId('agentville.mine'), /reserved/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the template stays a valid mod: every API hook name is present or documented', () => {
  const src = fs.readFileSync(new URL('../mods/_template/index.js', import.meta.url), 'utf8');
  for (const hook of ['growth', 'tier', 'capacity', 'lots', 'crowns', 'planSettlement', 'style', 'layout', 'scatter']) {
    assert.match(src, new RegExp(`\\b${hook}\\b`), hook);
  }
  assert.match(src, /from '#agentville\/mod'/);
  assert.ok(!/from '\.\.\//.test(src));
});

test('check passes for the template and is deterministic on a fixture subset', async () => {
  const r = await checkMod('_template', { fixtures: ['citydemo', 'harbour'] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fixtures.map(f => f.name), ['citydemo', 'harbour']);
  assert.ok(r.fixtures.every(f => /^[0-9a-f]{16}$/.test(f.sig)));
});

test('check on the base mod matches the template (same lint as its parent)', async () => {
  const t = await checkMod('_template', { fixtures: ['citydemo'] });
  const b = await checkMod('agentville.base', { fixtures: ['citydemo'] });
  assert.equal(b.ok, true);
  assert.deepEqual(t.fixtures[0].lint, b.fixtures[0].lint);   // the sig includes the mod id, so compare what the world contains
});

test('check reports an unknown mod instead of crashing', async () => {
  const r = await checkMod('nobody.nothing', { fixtures: ['citydemo'] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /no mod "nobody\.nothing"/);
});

test('the CLI exits non-zero for a failing check and prints usage for nothing', () => {
  const bad = spawnSync(process.execPath, [TOOL, 'check', 'nobody.nothing'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL nobody\.nothing/);
  const none = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage:/);
});

test('shots --dry-run prints a headless plan with world and fixture, and starts nothing', () => {
  const out = execFileSync(process.execPath, [TOOL, 'shots', 'anna.autumn', '--fixture', 'busy', '--zoom', '2', '--dry-run'], { encoding: 'utf8' });
  const plan = JSON.parse(out);
  assert.equal(plan.headless, true);
  assert.equal(plan.out, 'out/mod-shots/anna.autumn');
  assert.match(plan.query, /(^|&)world=anna\.autumn(&|$)/);
  assert.match(plan.query, /(^|&)engine=2(&|$)/);
  assert.ok(plan.steps.some(s => /focus/.test(s)));
  assert.throws(() => shotsPlan('a.b', { zoom: 7 }), /zoom/);
  assert.throws(() => shotsPlan('a.b', { fixture: 'nope' }), /fixture/);
});

test('the tool never opens a visible browser', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.match(src, /headless: true/);
  assert.ok(!/headless:\s*false|headed|channel:/.test(src));
});
