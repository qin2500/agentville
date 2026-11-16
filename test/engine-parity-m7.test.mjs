// M7 parity bookkeeping (docs/engine-parity.json, tools/parity.mjs): the test.* items, the per-milestone gate floor and the
// waivers. The e2e proofs live in e2e/engine.spec.mjs (titles carry the ids) and count through a Playwright JSON report.
//
// parity: test.e2e-world-village-on-engine2
// e2e/engine.spec.mjs is world.spec and village.spec ported to ?engine=2 (selectors adapted to the engine's debug shape).
// parity: test.depth-check-replaced
// depthCheck() is gone; e2e/engine.spec.mjs checks, on the engine, that nobody stands inside a building (test/engine-inv4, engine-depth, engine-art hold the unit side).
// parity: test.townwater-zero, test.items-wet-zero
// townWater and items[].wet are exposed by web/src/engine/debug/compat.js and asserted in e2e/engine.spec.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate, gateMin } from '../tools/parity.mjs';

const doc = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/engine-parity.json'), 'utf8'));
const item = id => doc.items.find(i => i.id === id);

test('gate floor: M3-M6 keep 0.90, M7 needs every item that is not waived', () => {
  for (const m of ['M3', 'M4', 'M5', 'M6']) assert.equal(gateMin(m), 0.9, m);
  assert.equal(gateMin('M7'), 1);
});

test('gate pool leaves out waived items only', () => {
  const g = gate({ items: [{ milestone: 'M7', status: 'done' }, { milestone: 'M7', status: 'missing', waived: 'x' }, { milestone: 'M7', status: 'partial' }, { milestone: 'M8', status: 'missing' }] }, 'M7');
  assert.deepEqual([g.done, g.total], [1, 2]);
});

test('the two waivers stand, each with a reason', () => {
  assert.equal(item('vil.builders-cap-4-per-site').status, 'done');
  for (const id of ['vil.yard-cap-plus-n-more', 'lbl.crowd-tags']) assert.match(item(id).waived, /^design decision: /, id);
});
