import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listModDirs, renderModsIndex, writeModsIndex } from '../tools/mods-index.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(names) {
  const root = mkdtempSync(join(tmpdir(), 'mods-index-'));
  mkdirSync(join(root, 'mods'));
  for (const n of names) { mkdirSync(join(root, 'mods', n)); writeFileSync(join(root, 'mods', n, 'index.js'), 'export default {};\n'); }
  return root;
}

test('generator output for the real repo is valid, deterministic and ordered', async () => {
  const text = renderModsIndex(REPO);
  assert.equal(renderModsIndex(REPO), text);
  assert.match(text, /GENERATED/);
  const dirs = listModDirs(REPO);
  assert.ok(dirs.indexOf('agentville.base') < dirs.indexOf('agentville.fantasy'));
  assert.ok(!dirs.some(d => d.startsWith('_')));
  assert.deepEqual(dirs, [...dirs].sort());
  const file = join(REPO, 'mods/index.js');
  writeModsIndex(REPO);
  assert.equal(readFileSync(file, 'utf8'), text);
  const mods = (await import('../mods/index.js')).default;
  assert.deepEqual(mods.slice(0, 2).map(m => m.id), ['agentville.base', 'agentville.fantasy']);
});

test('mods/index.js is gitignored and not tracked', () => {
  assert.match(readFileSync(join(REPO, '.gitignore'), 'utf8'), /^\/?mods\/index\.js$/m);
  const tracked = spawnSync('git', ['ls-files', '--', 'mods/index.js'], { cwd: REPO, encoding: 'utf8' });
  if (tracked.status === 0) assert.equal(tracked.stdout.trim(), '');
});

test('skips _ and . folders, files, and folders without index.js; sorted', () => {
  const root = fixture(['zeta', 'alpha', '_template', '.hidden', 'beta']);
  try {
    mkdirSync(join(root, 'mods', 'empty'));
    writeFileSync(join(root, 'mods', 'stray.js'), '');
    assert.deepEqual(listModDirs(root), ['alpha', 'beta', 'zeta']);
    const text = renderModsIndex(root);
    assert.match(text, /GENERATED/);
    assert.ok(!text.includes('_template'));
    assert.ok(text.indexOf('./alpha/') < text.indexOf('./beta/') && text.indexOf('./beta/') < text.indexOf('./zeta/'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeModsIndex reports change, is idempotent and order-stable', () => {
  const root = fixture(['b.mod', 'a.mod']);
  try {
    assert.equal(writeModsIndex(root), true);
    const first = readFileSync(join(root, 'mods/index.js'), 'utf8');
    assert.equal(writeModsIndex(root), false);
    assert.equal(readFileSync(join(root, 'mods/index.js'), 'utf8'), first);
    assert.match(first, /export default \[mod_a_mod, mod_b_mod\];/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
