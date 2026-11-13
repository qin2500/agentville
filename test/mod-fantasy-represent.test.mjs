import test from 'node:test';
import assert from 'node:assert/strict';
import { BEHAVIOUR, REPRESENT, POSES, CUES } from '../mods/agentville.fantasy/represent.js';

const KEYS = ['working', 'building', 'waiting', 'stalled:attention', 'stalled:prompt', 'stalled:error', 'resting', 'resting:prs-loading', 'sub'];
const PLACE = /^(home\.forecourt|pr\.site|anchor:(sit|work|stand|vend)|venue:(square|dock))$/;

function noFunctions(v, path = '') {
  assert.notEqual(typeof v, 'function', path);
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) noFunctions(x, `${path}.${k}`);
}

test('is plain data (structuredClone deep-equal, no functions)', () => {
  assert.deepEqual(structuredClone(BEHAVIOUR), BEHAVIOUR);
  noFunctions(BEHAVIOUR);
});

test('covers the §4.2 buckets', () => {
  for (const k of KEYS) assert.ok(BEHAVIOUR[k], k);
});

test('every entry has a legal place, a pose and idle[]', () => {
  for (const [k, e] of Object.entries(BEHAVIOUR)) {
    assert.match(e.place, PLACE, k);
    assert.equal(typeof e.pose, 'string', k);
    assert.ok(Array.isArray(e.idle), k);
    assert.equal(typeof e.walk, 'boolean', k);
  }
});

test('stalled and error entries never walk and stay home', () => {
  for (const k of ['stalled:attention', 'stalled:prompt', 'stalled:error']) {
    assert.equal(BEHAVIOUR[k].walk, false, k);
    assert.equal(BEHAVIOUR[k].place, 'home.forecourt', k);
  }
});

test('every fantasy pose and idle tag maps to an engine anim through its own represent.poses (renderer sees only §4.1 anims)', async () => {
  const { animOf } = await import('../web/src/engine/sim/represent.js');
  const { ANIMS } = await import('../web/src/engine/sim/actor.js');
  const mod = { represent: { poses: POSES } };
  for (const [name, anim] of Object.entries(POSES)) assert.ok(ANIMS.includes(anim), `${name} -> ${anim}`);
  for (const [k, e] of Object.entries(BEHAVIOUR)) {
    for (const name of [e.pose, ...e.idle]) {
      assert.ok(name in POSES || ANIMS.includes(name), `${k}: ${name} is neither a mod pose nor an engine anim`);
      assert.ok(ANIMS.includes(animOf(name, mod)), `${k}: ${name} -> ${animOf(name, mod)}`);
    }
  }
  for (const tag of Object.keys(CUES)) assert.ok(tag in POSES, `cue ${tag} has a pose entry`);
});

test('the fantasy mod wires behaviour, represent and ambient; the registry merges behaviour/represent as data', async () => {
  const fantasy = (await import('../mods/agentville.fantasy/index.js')).default;
  assert.equal(fantasy.behaviour, BEHAVIOUR);
  for (const [k, v] of Object.entries(REPRESENT)) assert.equal(fantasy.represent[k], v, k); // plus the mod's poses and cues
  assert.ok(fantasy.represent.poses && fantasy.represent.cues);
  for (const k of ['folk', 'cart', 'critter']) assert.equal(typeof fantasy.ambient.behaviours[k].update, 'function', k);
  assert.equal(typeof fantasy.ambient.spawn, 'function');
  const src = (await import('node:fs')).readFileSync(new URL('../web/src/engine/mod/registry.js', import.meta.url), 'utf8');
  assert.match(src, /DATA_KEYS = \[[^\]]*'behaviour'[^\]]*'represent'[^\]]*\]/);
  assert.doesNotMatch(src.match(/DATA_KEYS = \[[^\]]*\]/)[0], /ambient/, 'ambient is code, not data');
});
