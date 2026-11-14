// Mod lint: folder id must match the registry's MOD_ID_RE (M4); M6 forbids `ambient` outside first-party mods.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModImports, MOD_ID_RE } from '../tools/mod-lint.mjs';
import { MOD_ID_RE as REGISTRY_RE } from '../web/src/engine/mod/registry.js';

function fixture(id, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modlint-ids-'));
  fs.mkdirSync(path.join(root, 'web/src/engine/mod'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/src/engine/mod/public.js'), 'export const API_VERSION = 1;\n');
  fs.mkdirSync(path.join(root, 'mods', id), { recursive: true });
  fs.writeFileSync(path.join(root, 'mods', id, 'index.js'), body);
  return root;
}
const run = (id, body) => {
  const root = fixture(id, body);
  try { return checkModImports(path.join(root, 'mods', id), { root }).errors.map(e => e.rule); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
};
const idx = (id, extra = '') => `export default { id: '${id}', name: 'x', version: '1.0.0', apiVersion: 1${extra} };\n`;

test('lint MOD_ID_RE equals the registry one', () => {
  assert.equal(MOD_ID_RE.source, REGISTRY_RE.source);
  assert.equal(MOD_ID_RE.flags, REGISTRY_RE.flags);
});
test('M4: a folder id the registry would reject fails the lint', () => {
  assert.ok(run('Bad_World', idx('Bad_World')).includes('M4'));
  assert.deepEqual(run('acme.world', idx('acme.world')), []);
});
test('M6: a non-first-party mod declaring ambient is an error', () => {
  assert.deepEqual(run('acme.world', idx('acme.world', ', ambient: { sky: 1 }')).filter(r => r === 'M6'), ['M6']);
});
test('M6: first-party mods may declare ambient', () => {
  assert.ok(!run('agentville.fantasy', idx('agentville.fantasy', ', ambient: { sky: 1 }')).includes('M6'));
});
