// Decision D4: an agent walks only if the trip is <= 6 s and on screen, else it fades; stalled/error never move.
import test from 'node:test';
import assert from 'node:assert/strict';
import { present, loadFixture, makeSim, advance, agentsOf, fading, frozen, simMod, DT } from './engine-support/sim-harness.mjs';

const skip = (!present || !loadFixture('citydemo.json')) && 'sim or fixture missing';
const noShould = typeof simMod.shouldWalk !== 'function' && 'needs shouldWalk';
const todoShould = noShould ? { todo: noShould } : {};
const SPEED = 2.5;

test('WALK_MAX_S is 6', () => assert.equal(simMod.WALK_MAX_S, 6));

test('shouldWalk table', todoShould, () => {
  const sw = simMod.shouldWalk;
  assert.equal(sw(5 * SPEED, SPEED, true, 'working'), true, '5 s on screen walks');
  assert.equal(sw(6 * SPEED, SPEED, true, 'working'), true, 'exactly 6 s walks');
  assert.equal(sw(7 * SPEED, SPEED, true, 'working'), false, '7 s fades');
  assert.equal(sw(5 * SPEED, SPEED, false, 'working'), false, 'off screen fades');
  assert.equal(sw(1, SPEED, true, 'stalled'), false, 'stalled never walks');
  assert.equal(sw(1, SPEED, true, 'error'), false, 'error never walks');
  assert.equal(sw(0, SPEED, true, 'waiting'), true, 'zero-length trip walks');
  assert.equal(sw(5 * 4, 4, true, 'resting'), true, 'speed is taken into account (5 s at speed 4)');
  assert.equal(sw(7 * 4, 4, true, 'resting'), false, '7 s at speed 4 fades');
});

// Flip every non-frozen agent to a new status and watch what each one does for 20 s of sim time.
function flipRun({ onScreen = true, to = 'working', ticks = 400 } = {}) {
  const fx = loadFixture('citydemo.json');
  const { sim } = makeSim(fx, { mutate: i => ({ ...i, agents: i.agents.map(a => (a.status === 'working' ? { ...a, status: 'waiting' } : a)) }) });
  sim.setOnScreen?.(() => onScreen);
  for (let i = 0; i < 100; i++) advance(sim);
  const { input } = makeSim(fx);
  const flipped = new Set();
  const next = { ...input, agents: input.agents.map(a => { if (a.status === 'stalled' || a.status === 'error') return a; flipped.add(a.id); return { ...a, status: to }; }) };
  sim.applySnapshot(next);
  const st = new Map(agentsOf(sim).map(a => [a.id, { x: a.x, y: a.y, walked: 0, walkS: 0, maxWalkS: 0, jumped: false, walkedBeforeJump: 0, fades: 0 }]));
  for (let i = 0; i < ticks; i++) {
    advance(sim);
    for (const a of agentsOf(sim)) {
      const s = st.get(a.id); if (!s) continue;
      const d = Math.hypot(a.x - s.x, a.y - s.y);
      const jump = d > SPEED * 4 * DT + 0.01;            // faster than any walk
      if (jump) { s.jumped = true; s.walkedBeforeJump = s.jumped && !s._j ? s.walked : s.walkedBeforeJump; s._j = true; }
      else if (d > 0 && !fading(a)) { s.walked += d; s.walkS += DT; s.maxWalkS = Math.max(s.maxWalkS, s.walkS); }
      else if (d === 0) s.walkS = 0;
      if (fading(a)) s.fades++;
      s.x = a.x; s.y = a.y; s.frozen ??= false;
      if (frozen(a)) s.frozen = true;
    }
  }
  return { st, flipped };
}

test('status change: no agent walks longer than 6 s in one go', { skip }, () => {
  const { st } = flipRun();
  for (const [id, s] of st) assert.ok(s.maxWalkS <= 6 + 0.2, `${id} walked ${s.maxWalkS.toFixed(2)} s continuously`);
});

test('status change to a far destination fades instead of walking (never walks then jumps)', { skip, ...(noShould ? { todo: noShould } : {}) }, () => {
  const { st } = flipRun();
  assert.ok([...st.values()].some(s => s.jumped), 'at least one far trip faded (fixture has far destinations)');
  for (const [id, s] of st) if (s.jumped) assert.ok(s.walkedBeforeJump < 0.5, `${id} walked ${s.walkedBeforeJump.toFixed(1)} tiles and then jumped; a long trip must fade, not walk`);
});

test('off screen: status change never walks, it fades or snaps', { skip }, () => {
  const { st } = flipRun({ onScreen: false });
  for (const [id, s] of st) assert.ok(s.walked < 0.5, `${id} walked ${s.walked.toFixed(1)} tiles while off screen`);
});

test('stalled/error agents never move, even when others change status', { skip }, () => {
  const fx = loadFixture('citydemo.json');
  const { sim, input } = makeSim(fx);
  const fixed = new Set(input.agents.filter(a => a.status === 'stalled' || a.status === 'error').map(a => a.id));
  assert.ok(fixed.size > 0, 'fixture has stalled/error agents');
  for (let i = 0; i < 40; i++) advance(sim);
  const pos = new Map(agentsOf(sim).filter(a => fixed.has(a.id)).map(a => [a.id, [a.x, a.y]]));
  sim.applySnapshot({ ...input, agents: input.agents.map(a => (fixed.has(a.id) ? a : { ...a, status: 'working' })) });
  for (let i = 0; i < 300; i++) {
    advance(sim);
    for (const [id, [x, y]] of pos) { const a = sim.actors.get(id); assert.ok(a.x === x && a.y === y, `tick ${i}: ${id} moved`); }
  }
});
