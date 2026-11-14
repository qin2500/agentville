// MOD-READY P4: the engine knows the anim enum only; pose / cue names are mod data (represent.poses / represent.cues).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSE_ANIM, animOf, ENGINE_BEHAVIOUR, representAgent } from '../web/src/engine/sim/represent.js';
import { ANIMS, makeActor } from '../web/src/engine/sim/actor.js';
import { createSim } from '../web/src/engine/sim/world-sim.js';
import { BEHAVIOUR, POSES, CUES } from '../mods/agentville.fantasy/represent.js';

const SIM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src', 'engine', 'sim');
const FANTASY_POSES = ['saw', 'carry-crate', 'wave-at-ship', 'wave-both', 'smoke-puff', 'bob'];

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('POSE_ANIM is the identity over ANIMS', () => {
  assert.deepEqual(Object.keys(POSE_ANIM), [...ANIMS]);
  for (const a of ANIMS) assert.equal(POSE_ANIM[a], a);
});

test('a mod with custom pose names maps them to anims; unknown poses read as idle', () => {
  const mod = { represent: { poses: { flail: 'wave', dig: 'hammer', haul: 'carry', bogus: 'not-an-anim' } } };
  assert.equal(animOf('flail', mod), 'wave');
  assert.equal(animOf('dig', mod), 'hammer');
  assert.equal(animOf('haul', mod), 'carry');
  for (const a of ANIMS) assert.equal(animOf(a, mod), a, 'enum values pass through');
  assert.equal(animOf('bogus', mod), 'idle', 'a mapping to a non-anim reads as idle');
  assert.equal(animOf('nope', mod), 'idle');
  assert.equal(animOf('flail'), 'idle', 'without the mod the engine does not know the name');
  assert.equal(animOf(undefined, mod), 'idle');
  assert.equal(animOf('flail', {}), 'idle');
});

test('the fantasy poses map onto anims through the mod data only', () => {
  const mod = { represent: { poses: POSES } };
  assert.equal(animOf('saw', mod), 'hammer'); assert.equal(animOf('carry-crate', mod), 'carry');
  assert.equal(animOf('wave-both', mod), 'wave'); assert.equal(animOf('wave-at-ship', mod), 'wave');
  for (const p of FANTASY_POSES) assert.equal(animOf(p), 'idle', `${p} is unknown to the bare engine`);
  for (const v of Object.values(POSES)) assert.ok(ANIMS.includes(v));
  for (const tag of Object.keys(CUES)) assert.ok(tag in POSES, tag);
});

test('no fantasy pose name appears in sim/** (code, comments stripped)', () => {
  for (const f of walk(SIM_DIR)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const name of FANTASY_POSES) {
      assert.ok(!new RegExp(`['"\`]${name}['"\`]`).test(src), `${path.relative(SIM_DIR, f)} still names '${name}'`);
    }
  }
});

test('the default behaviour table holds no venue: place other than venue:square, and nothing named porter or dock', () => {
  for (const [k, e] of Object.entries(ENGINE_BEHAVIOUR)) {
    if (e.place.startsWith('venue:')) assert.equal(e.place, 'venue:square', k);
    assert.ok(!/porter|dock/.test(k + e.place), k);
  }
  assert.equal(ENGINE_BEHAVIOUR['resting:prs-loading'].place, 'home.forecourt');
  assert.equal(ENGINE_BEHAVIOUR['resting:prs-loading'].pose, 'idle');
  assert.ok(!('resting:porter' in ENGINE_BEHAVIOUR));
});

test('resting with PRs loading uses resting:prs-loading; a mod may give it a venue (fantasy keeps its dock porter)', () => {
  const agent = { id: 'a-1', name: 'a', status: 'resting', prs: [{ id: 'p#1', state: 'loading' }] };
  const ctx = { prs: new Map([['p#1', { id: 'p#1', state: 'loading' }]]) };
  const bare = representAgent(agent, {}, ctx);
  assert.equal(bare.key, 'resting:prs-loading'); assert.equal(bare.place, 'home.forecourt');
  const fan = representAgent(agent, { behaviour: BEHAVIOUR }, ctx);
  assert.equal(fan.key, 'resting:prs-loading'); assert.equal(fan.place, 'venue:dock'); assert.equal(fan.pose, 'carry');
  assert.ok('resting:prs-loading' in BEHAVIOUR && !('resting:porter' in BEHAVIOUR));
});

test('the actor default kind is ambient', () => {
  assert.equal(makeActor({ id: 'x' }).kind, 'ambient');
  assert.equal(makeActor({ id: 'x', kind: 'agent' }).kind, 'agent');
});

test('end to end: a sim shows only anim values while a.pose keeps the mod name', () => {
  const home = ['h1', { id: 'h1', kind: 'building', tx: 9, ty: 8, w: 1, h: 1, door: { tx: 10, ty: 10, face: 0 }, data: { owner: 'home', agentId: 'a1' } }];
  const mod = {
    behaviour: { 'stalled:prompt': { place: 'home.forecourt', pose: 'flail', idle: [], walk: false } },
    represent: { poses: { flail: 'wave' } },
  };
  const sim = createSim({ world: { version: 1, objects: new Map([home]), villages: [] }, seed: 3, mod,
    deps: { resolvePlace: () => ({ tx: 10, ty: 10 }) } });
  sim.applySnapshot({ apiVersion: 1, now: 0, seed: 1, projects: [{ key: 'p' }], prs: [], env: { night: 0, reduceMotion: false, zoom: 1 },
    agents: [{ id: 'a1', name: 'a1', project: 'p', parent: null, status: 'stalled', needs: 'plan', role: 'worker', crown: false,
      important: false, stopped: false, harness: 'claude', since: 0, lastActive: 0, prs: [] }] });
  for (let i = 0; i < 20; i++) sim.tick(0.1);
  const a = sim.actors.get('a1');
  assert.equal(a.pose, 'flail'); assert.equal(a.anim, 'wave');
  assert.ok(ANIMS.includes(a.anim));
});
