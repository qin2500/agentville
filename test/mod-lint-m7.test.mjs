// Mod lint M7: browser/network/storage globals are ownership hygiene violations (docs/mod-boundary.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkModImports, HOST_GLOBALS, lintAll } from '../tools/mod-lint.mjs';

function run(body, id = 'acme.world') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modlint-m7-'));
  try {
    fs.mkdirSync(path.join(root, 'web/src/engine/mod'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web/src/engine/mod/public.js'), 'export const API_VERSION = 1;\n');
    fs.mkdirSync(path.join(root, 'mods', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'mods', id, 'index.js'), `export default { id: '${id}', name: 'x', version: '1.0.0', apiVersion: 1 };\n`);
    fs.writeFileSync(path.join(root, 'mods', id, 'hooks.js'), body);
    return checkModImports(path.join(root, 'mods', id), { root }).errors.filter(e => e.rule === 'M7');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const g of ['fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage', 'indexedDB', 'document', 'window', 'navigator']) {
  test(`M7: ${g} as an identifier is an error`, () => {
    const e = run(`export const f = () => ${g}.x;\n`);
    assert.equal(e.length, 1);
    assert.equal(e[0].spec, g);
    assert.equal(e[0].file, 'mods/acme.world/hooks.js');
  });
}
test('M7: also for first-party mods', () => {
  assert.equal(run('export const f = () => window.innerWidth;\n', 'agentville.fantasy').length, 1);
});
test('M7: comments, strings and templates are ignored', () => {
  assert.deepEqual(run(`// fetch the window
/* document.cookie */
export const a = 'localStorage', b = "navigator", c = \`window\`;
`), []);
});
test('M7: property names and longer identifiers are not hits', () => {
  assert.deepEqual(run('export const a = {}; export const b = a.window + a.document; export const fetcher = 1, documents = 2;\n'), []);
});
test('M7: the regex rejects substrings', () => {
  assert.ok(!HOST_GLOBALS.test('myfetch windowSize'));
});
test('M7: the repo itself is clean', () => {
  assert.deepEqual(lintAll().errors, []);
});
