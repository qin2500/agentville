// MOD-READY P9 spec tests: the mod ownership boundary lint. Written from SEAMS §1 / P9, not from the implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINT = path.join(ROOT, 'tools/mod-lint.mjs');
const HAVE = fs.existsSync(LINT);
const SKIP = HAVE ? false : 'needs P9';
const lint = HAVE ? await import(LINT) : null;

function write(root, rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

/** A tiny fake repo: engine public barrel, an engine-internal file, city-plan/styles-pool, plus the given mods. */
function fixture(mods) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modlint-'));
  write(root, 'web/src/engine/mod/public.js', "export const API_VERSION = 1;\nexport const hash = (s) => s.length;\n");
  write(root, 'web/src/engine/core/internal.js', 'export const secret = 1;\n');
  write(root, 'web/src/city-plan.js', 'export const GROUND = {};\n');
  write(root, 'web/src/styles-pool.js', 'export const styleFor = () => 0;\n');
  for (const [id, files] of Object.entries(mods)) {
    for (const [rel, body] of Object.entries(files)) write(root, `mods/${id}/${rel}`, body);
  }
  return root;
}
const idxFile = (id, extra = '') => `${extra}\nexport default { id: '${id}', name: 'x', version: '1.0.0', apiVersion: 1, extends: null };\n`;
const run = (root, id) => lint.checkModImports(path.join(root, 'mods', id), { root });
const rules = (r) => r.errors.map(e => e.rule);
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

test('exports checkModImports and checkEngineImports', { skip: SKIP }, () => {
  assert.equal(typeof lint.checkModImports, 'function');
  assert.equal(typeof lint.checkEngineImports, 'function');
});

test('#agentville/mod and own-file imports pass', { skip: SKIP }, () => {
  const root = fixture({
    'my.world': {
      'index.js': idxFile('my.world', "import { hash } from '#agentville/mod';\nimport { A } from './a.js';\nimport { B } from './sub/b.js';"),
      'a.js': "import { B } from './sub/b.js';\nexport const A = 1;\n",
      'sub/b.js': "import { A } from '../a.js';\nexport const B = 2;\n",
    },
  });
  try {
    const r = run(root, 'my.world');
    assert.deepEqual(r.errors, []);
  } finally { cleanup(root); }
});

test('relative path to the resolved public.js passes', { skip: SKIP }, () => {
  const root = fixture({
    'my.world': { 'index.js': idxFile('my.world', "import { hash } from '../../web/src/engine/mod/public.js';") },
  });
  try { assert.deepEqual(run(root, 'my.world').errors, []); } finally { cleanup(root); }
});

test('engine-internal import fails (M1)', { skip: SKIP }, () => {
  const root = fixture({
    'my.world': { 'index.js': idxFile('my.world', "import { secret } from '../../web/src/engine/core/internal.js';") },
  });
  try {
    const r = run(root, 'my.world');
    assert.ok(r.errors.length >= 1);
    assert.ok(rules(r).includes('M1'), JSON.stringify(r.errors));
    assert.ok(r.errors.some(e => /internal\.js/.test(e.spec)));
  } finally { cleanup(root); }
});

test('import from another mod fails (M3)', { skip: SKIP }, () => {
  const root = fixture({
    'my.world': { 'index.js': idxFile('my.world', "import { Z } from '../other.world/z.js';") },
    'other.world': { 'index.js': idxFile('other.world'), 'z.js': 'export const Z = 1;\n' },
  });
  try {
    const r = run(root, 'my.world');
    assert.ok(rules(r).includes('M3'), JSON.stringify(r.errors));
    assert.deepEqual(run(root, 'other.world').errors, []);
  } finally { cleanup(root); }
});

test('bare, node: and URL specifiers and non-literal import() fail (M2)', { skip: SKIP }, () => {
  const cases = [
    "import fs from 'node:fs';",
    "import x from 'lodash';",
    "import y from 'https://example.com/y.js';",
    "const m = await import(name);",
  ];
  for (const c of cases) {
    const root = fixture({ 'my.world': { 'index.js': idxFile('my.world', `const name = 'a';\n${c}`) } });
    try { assert.ok(rules(run(root, 'my.world')).includes('M2'), c); } finally { cleanup(root); }
  }
});

test("fantasy's grandfathered city-plan/styles-pool imports pass only for agentville.fantasy", { skip: SKIP }, () => {
  const src = "import { GROUND } from '../../web/src/city-plan.js';\nimport { styleFor } from '../../web/src/styles-pool.js';";
  const root = fixture({
    'agentville.fantasy': { 'index.js': idxFile('agentville.fantasy', src) },
    'my.world': { 'index.js': idxFile('my.world', src) },
  });
  try {
    assert.deepEqual(run(root, 'agentville.fantasy').errors, []);
    const r = run(root, 'my.world');
    assert.ok(r.errors.length >= 2, JSON.stringify(r.errors));
    assert.ok(rules(r).every(x => x === 'M1'));
  } finally { cleanup(root); }
});

test('M4: folder name must equal mod.id; agentville. prefix reserved', { skip: SKIP }, () => {
  const root = fixture({
    'my.world': { 'index.js': idxFile('different.id') },
    'sneaky': { 'index.js': idxFile('agentville.sneaky') },
  });
  try {
    assert.ok(rules(run(root, 'my.world')).includes('M4'));
    assert.ok(rules(run(root, 'sneaky')).includes('M4'));
  } finally { cleanup(root); }
});

test('M5: nondeterministic calls fail', { skip: SKIP }, () => {
  for (const c of ['Math.random()', 'Date.now()', 'performance.now()', 'new Date()']) {
    const root = fixture({ 'my.world': { 'index.js': idxFile('my.world'), 'a.js': `export const v = ${c};\n` } });
    try { assert.ok(rules(run(root, 'my.world')).includes('M5'), c); } finally { cleanup(root); }
  }
});

test('the real mods/ tree passes', { skip: SKIP }, () => {
  const dirs = fs.readdirSync(path.join(ROOT, 'mods'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  assert.ok(dirs.includes('agentville.base') && dirs.includes('agentville.fantasy'));
  for (const id of dirs) {
    const r = lint.checkModImports(path.join(ROOT, 'mods', id), { root: ROOT });
    assert.deepEqual(r.errors, [], `${id}: ${JSON.stringify(r.errors)}`);
  }
});

test('real engine passes the engine import rule (E1)', { skip: SKIP }, () => {
  const r = lint.checkEngineImports(ROOT);
  assert.deepEqual(Array.isArray(r) ? r : r.errors, []);
});
