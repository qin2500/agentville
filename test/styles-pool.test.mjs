import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, styleFor, STYLE_DEFAULT } from '../web/src/styles-pool.js';

const HEX = /^#[0-9a-f]{6}$/i;
const WINDOWS = ['square', 'arched', 'tall', 'small'];
const PAVINGS = ['cobble', 'flagstone', 'brick', 'earth'];
const LAMPS = ['lantern', 'iron', 'post'];
const TREES = ['round', 'pine', 'pink', 'big', 'cypress', 'birch'];
const HATS = ['none', 'cap', 'straw', 'hood', 'feather', 'kerchief'];

function checkStyle(s) {
  assert.ok(Number.isInteger(s.family) && s.family >= 0 && s.family < FAMILIES.length);
  assert.equal(s.familyName, FAMILIES[s.family]);
  assert.match(s.key, /^f\d\./);
  for (const c of [s.roof.base, s.roof.ridge, s.wall.base, s.wall.alt, s.trim, s.shutter, s.door, s.paving.base, s.paving.joint, s.accent]) assert.match(c, HEX);
  assert.ok(WINDOWS.includes(s.window));
  assert.ok(PAVINGS.includes(s.paving.kind));
  assert.ok(LAMPS.includes(s.lamp));
  assert.ok(s.trees.length >= 2 && s.trees.length <= 4);
  for (const t of s.trees) assert.ok(TREES.includes(t));
  assert.ok(HATS.includes(s.folk.hat));
  assert.equal(s.folk.palettes.length, 4);
  for (const p of s.folk.palettes) { assert.equal(p.length, 3); for (const c of p) assert.match(c, HEX); }
}

test('deterministic and frozen', () => {
  const a = styleFor('alpha'), b = styleFor('alpha');
  assert.deepEqual(a, b);
  for (const s of [a, STYLE_DEFAULT]) {
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.roof) && Object.isFrozen(s.folk) && Object.isFrozen(s.folk.palettes[0]) && Object.isFrozen(s.trees));
  }
});

test('every field valid', () => {
  checkStyle(STYLE_DEFAULT);
  for (let i = 0; i < 1000; i++) checkStyle(styleFor('proj-' + i));
  for (let f = 0; f < 6; f++) for (let i = 0; i < 100; i++) checkStyle(styleFor('x' + i, { family: f }));
});

test('opts.family forces the family', () => {
  for (let f = 0; f < 6; f++) for (let i = 0; i < 30; i++) assert.equal(styleFor('p' + i, { family: f }).family, f);
});

test('all families appear over 200 keys', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(styleFor('key-' + i).family);
  assert.equal(seen.size, 6);
});

test('many distinct keys over 1000 names; key determines style', () => {
  const byKey = new Map();
  for (let i = 0; i < 1000; i++) {
    const s = styleFor('project ' + i);
    const j = JSON.stringify(s);
    if (byKey.has(s.key)) assert.equal(byKey.get(s.key), j); else byKey.set(s.key, j);
  }
  assert.ok(byKey.size > 150, 'distinct keys: ' + byKey.size);
});

test('STYLE_DEFAULT is timber', () => {
  assert.equal(STYLE_DEFAULT.family, 0);
  assert.equal(STYLE_DEFAULT.familyName, 'timber');
});
