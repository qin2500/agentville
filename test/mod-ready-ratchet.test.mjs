// E2 ratchet: world words in web/src/engine/** may only go down (docs/mod-boundary.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, countWorldWords, WORLD_WORDS } from '../tools/mod-lint.mjs';

const JSON_FILE = path.join(ROOT, 'test/mod-ready-ratchet.json');
const pinned = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));

// `UPDATE_RATCHET=1 node --test test/mod-ready-ratchet.test.mjs` lowers the pins to the current counts. It never raises one.
if (process.env.UPDATE_RATCHET === '1') {
  const now = countWorldWords(ROOT);
  const next = {};
  for (const [f, n] of Object.entries(now)) {
    if (n > (pinned.files[f] ?? 0)) throw new Error(`refusing to raise the ratchet: ${f} has ${n}, pinned ${pinned.files[f] ?? 0}`);
    next[f] = n;
  }
  fs.writeFileSync(JSON_FILE, JSON.stringify({ ...pinned, files: next }, null, 2) + '\n');
  pinned.files = next;
}

test('ratchet: the word list in the json matches the lint', () => {
  assert.equal(pinned.words, WORLD_WORDS.source);
});

test('ratchet: no engine file has more world words than pinned (a file not listed is pinned at 0)', () => {
  const now = countWorldWords(ROOT);
  for (const [f, n] of Object.entries(now)) {
    assert.ok(n <= (pinned.files[f] ?? 0), `${f}: ${n} world words, max ${pinned.files[f] ?? 0}. Move the world-specific code into a mod.`);
  }
});

test('ratchet: pins are tight, so a lowered count must be written down (UPDATE_RATCHET=1)', () => {
  const now = countWorldWords(ROOT);
  for (const [f, max] of Object.entries(pinned.files)) {
    assert.ok(fs.existsSync(path.join(ROOT, f)) || max === 0, `${f} is pinned but gone: remove it from the json`);
    assert.ok((now[f] ?? 0) >= max, `${f}: now ${now[f] ?? 0}, pinned ${max}. Lower the pin.`);
  }
});
