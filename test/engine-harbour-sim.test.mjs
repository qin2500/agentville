// M5 P3: harbour tokens (one ship per PR at a berth), ship cast-off / sail-out, porters (dock-walk.js policy on nav).
// World: e2e/fixtures/engine/harbour-6.json; the four PRs the venue berths are made 'loading' (the fixture's own dock PRs
// reach the input now, so setup() makes every other loading PR merged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrom, loadFixture, fantasyMod, simMod, navMod, SEED } from './engine-support/sim-harness.mjs';

const { venueAssignments } = await import('../web/src/engine/world/venue.js');
const { EDGE } = await import('../web/src/engine/core/grid.js');
const { createTokens } = await import('../web/src/engine/sim/tokens.js');
const { CAP, PICK, DROP, deckTarget } = await import('../mods/agentville.fantasy/ambient/porter.js');
const { CAST_STAGGER, spawnHarbourLife } = await import('../mods/agentville.fantasy/ambient/ship.js');

const STEP = 0.05;
const LOAD = ['amber#1000', 'cedar#3000', 'cedar#3001', 'cedar#3002'];
const fixture = loadFixture('harbour-6.json');

function setup({ loading = LOAD, mutate, world: w0 } = {}) {
  const built = buildFrom(fixture);
  const world = w0?.(built.world) ?? built.world;
  const nav = w0 ? navMod.createNav(world) : built.nav;
  const mod = fantasyMod();
  let input = { ...built.input, prs: built.input.prs.map(p => (loading.includes(p.id) ? { ...p, state: 'loading' } : p.state === 'loading' ? { ...p, state: 'merged' } : p)) };   // the dock's own loading PRs (now in the input) sail off: only LOAD is loading
  if (mutate) input = mutate(input);
  const berths = venueAssignments(world, input, mod, { venues: {} }, {}).prs;
  const sim = simMod.createSim({ world, nav, seed: SEED, mod, serverId: built.serverId, clock: { dayLength: 60, phase0: 0.3 } });
  sim.applySnapshot(input, { berths });
  return { sim, world, nav, input, berths, mod };
}
const merge = (input, ids) => ({ ...input, prs: input.prs.map(p => (ids.includes(p.id) ? { ...p, state: 'merged' } : p)) });
const tokensOf = sim => [...sim.actors.values()].filter(a => a.kind === 'token');
const portersOf = sim => [...sim.actors.values()].filter(a => a.kind === 'porter');
const visible = a => (a.flags & 1) !== 0;
const fading = a => a.fade != null || (a.alpha != null && a.alpha < 1);

test('tokens: one per berthed PR, at its berth, deterministic; merged PRs never arrive as tokens', () => {
  const { sim, berths } = setup();
  const t = tokensOf(sim);
  assert.equal(t.length, 4);
  for (const a of t) {
    const b = berths[a.item];
    assert.equal(a.id, `token:${a.item}`);
    assert.equal(a.kind, 'token');
    assert.equal(a.model, b.model);
    assert.equal(a.berth, b.berth);
    assert.equal(a.venue, 'dock');
    assert.equal(a.gridFree, true);
    assert.equal(a.state, 'moored');
    assert.ok(Math.abs(a.x - (b.tx + 0.5)) < 1e-9 && Math.abs(a.y - (b.ty + 1.5)) < 1e-9, `${a.id} at its berth`);
  }
  assert.deepEqual(t.map(a => a.seq).sort(), [1, 2, 3, 4]);
  // fixture as is: the berths hold merged PRs only -> no ships
  const none = setup({ loading: [] });
  assert.equal(tokensOf(none.sim).length, 0);
  // same seed, same everything
  const again = setup();
  for (let i = 0; i < 200; i++) { sim.step(STEP); again.sim.step(STEP); }
  const snap = s => [...s.actors.values()].filter(a => a.kind === 'token' || a.kind === 'porter').map(a => `${a.id}|${a.x.toFixed(4)}|${a.y.toFixed(4)}|${a.state}|${a.flags}`).join('\n');
  assert.equal(snap(sim), snap(again.sim));
});

test('tokens.js: departs on removal, comes back if not locked, leaves at once without a behaviour', () => {
  const actors = new Map(), left = [];
  let hasB = true;
  const store = createTokens({
    actors, hasBehaviour: () => hasB,
    spawn: s => { const a = { ...s, flags: 1 }; actors.set(a.id, a); return a; },
    leave: a => { left.push(a.id); a.leaving = 0.3; },
  });
  const B = { a: { venue: 'v', berth: 'b0', tx: 1, ty: 2, face: 2, model: 'm' }, b: { venue: 'v', berth: 'b1', tx: 4, ty: 2, face: 2 } };
  assert.deepEqual(store.sync(B, new Map(), 0), { added: ['a', 'b'], departed: [] });
  assert.deepEqual(store.view.list().map(a => a.item), ['a', 'b']);
  assert.deepEqual(store.sync({ b: B.b }, new Map(), 5).departed, ['a']);
  assert.deepEqual(actors.get('token:a').depart, { since: 5, seq: 1 });
  store.sync(B, new Map(), 6);
  assert.equal(actors.get('token:a').depart, null, 'held again before cast-off: back at the berth');
  store.sync(B, new Map([['b', 'merged']]), 7);
  assert.equal(actors.get('token:b').depart.seq, 2, 'merged state departs too');
  hasB = false;
  store.sync({}, new Map(), 8);
  assert.deepEqual(left, ['token:a']);
});

test('[har.cast-off-stagger-sail-out] ships: cast off on merge, 6 s apart, sail straight out to the map edge and are removed', () => {
  const { sim, world, input, berths } = setup();
  for (let i = 0; i < 20; i++) sim.step(STEP);
  const t0 = sim.now;
  sim.applySnapshot(merge(input, ['cedar#3000', 'cedar#3001']), { berths });
  const a = sim.actors.get('token:cedar#3000'), b = sim.actors.get('token:cedar#3001');
  const startY = { [a.id]: a.y, [b.id]: b.y };
  const cast = {};
  const bottom = world.grid.oy + world.grid.h;
  for (let i = 0; i < 1200 && (sim.actors.has(a.id) || sim.actors.has(b.id)); i++) {
    sim.step(STEP);
    for (const s of [a, b]) {
      if (!sim.actors.has(s.id)) continue;
      if (s.state === 'sailing' && cast[s.id] == null) cast[s.id] = sim.now;
      assert.ok(s.y >= startY[s.id] - 1e-9 && s.y < bottom, `${s.id} heads seaward and stays on the map`);
    }
  }
  assert.ok(!sim.actors.has(a.id) && !sim.actors.has(b.id), 'both ships sailed off and were removed');
  assert.ok(Math.abs(a.depart.castAt - t0) < 1e-6, 'the first casts off at once');
  assert.ok(Math.abs(b.depart.castAt - a.depart.castAt - CAST_STAGGER) < 1e-6, 'the second 6 s later');
  assert.ok(cast[b.id] - cast[a.id] >= CAST_STAGGER - STEP - 1e-6);
  assert.ok(a.y > bottom - 2 && b.y > bottom - 2, 'removed at the edge');
  // the others stay moored
  assert.equal(sim.actors.get('token:amber#1000').state, 'moored');
});

test('[har.porter-cap-6] [har.porter-townsperson-fallback] [har.porter-drop-and-head-home] porters: never more than CAP out, one job each, townsfolk fallback; quay fallback while piers are water', () => {
  // 10 ships: the 4 real berths + 6 made-up berth entries on the same venue
  const { sim, input, berths } = setup();
  const more = { ...berths };
  for (let i = 0; i < 6; i++) more[`zz#${900 + i}`] = { ...berths['amber#1000'], berth: `x${i}`, tx: -1 - (i % 2) * 0, ty: 38 + 3 * (i % 2) };
  sim.applySnapshot(input, { berths: more });
  assert.equal(tokensOf(sim).length, 10);
  assert.equal(portersOf(sim).length, CAP);
  let maxOut = 0, sawDrop = 0, maxJobs = 0;
  for (let i = 0; i < 1200; i++) {
    sim.step(STEP);
    const ps = portersOf(sim);
    const out = ps.filter(visible).length;
    maxOut = Math.max(maxOut, out);
    assert.ok(out <= CAP);
    const jobs = ps.filter(p => p.job).map(p => p.job);
    assert.equal(new Set(jobs).size, jobs.length, 'one porter per job');
    maxJobs = Math.max(maxJobs, jobs.length);
    for (const p of ps) {
      if (p.job) assert.ok(p.job.startsWith('town:'), 'no resting agent owns these PRs: townsfolk carry');
      if (p.state === 'drop') {
        sawDrop++;
        assert.ok(p.fallback === undefined || p.fallback === 'quay', 'piers are decks now (deck:true): the deck tile, or the quay fallback');
        assert.ok(Math.abs(p.x - p.to.x) < 1e-6 && Math.abs(p.y - p.to.y) < 1e-6, 'drops at its target');
        assert.equal(p.carry, true);
      }
    }
  }
  assert.ok(maxOut >= 2, 'porters get out');
  assert.equal(maxJobs, CAP, 'with 10 ships waiting, all CAP porters have a ship');
  assert.ok(sawDrop > 0);
});

test('porters: walk to the deck tile when the pier is walkable (no fallback)', () => {
  const { sim, world } = setup({ world: w => {
    for (const o of w.objects.values()) if (o.model === 'pier' && o.data?.venue === 'dock')
      for (let y = o.ty; y < o.ty + o.h; y++) for (let x = o.tx; x < o.tx + o.w; x++) w.grid.set('cost', x, y, 2);
    return w;
  } });
  const nav = navMod.createNav(world);
  const ctx = { world, nav };
  for (const s of tokensOf(sim)) {
    const t = deckTarget(ctx, s);
    assert.ok(t && !t.fallback, `${s.id} has a deck target`);
    const deckX = s.tx < 0.5 ? s.tx + 1 : s.tx - 1;
    assert.deepEqual([Math.floor(t.x), Math.floor(t.y)], [deckX, s.ty + 1], 'beside the ship middle on the pier');
  }
});

test('[har.porter-drop-and-head-home] porters: head home (crate dropped) when their ship sails', () => {
  const { sim, input, berths } = setup();
  let p = null;
  for (let i = 0; i < 2000 && !p; i++) { sim.step(STEP); p = portersOf(sim).find(x => x.state === 'out' || x.state === 'drop' || x.state === 'pick') ?? null; }
  assert.ok(p, 'a porter is out');
  const item = p.item;
  sim.applySnapshot(merge(input, [item]), { berths });
  sim.step(STEP);
  assert.equal(p.state, 'back');
  assert.equal(p.carry, false);
  for (let i = 0; i < 400 && p.state === 'back'; i++) sim.step(STEP);
  assert.ok(p.state === 'home' || p.state === 'idle', 'got home');
  assert.ok(!visible(p), 'indoors again');
  assert.ok(Math.abs(p.x - p.origin.x) < 1e-6 && Math.abs(p.y - p.origin.y) < 1e-6);
});

test('[har.porters-resting-agents] porters: a resting agent carries its own PR; it vanishes at once when the agent wakes; stalled agents never carry', () => {
  const pr = 'amber#1000';
  const { sim, input, berths } = setup({ mutate: inp => ({ ...inp, agents: inp.agents.map(a => (a.project === 'amber' && a.status === 'resting' ? { ...a, prs: [pr] } : a)) }) });
  const resters = [...sim.actors.values()].filter(a => a.kind === 'agent' && a.input?.prs?.includes(pr));
  assert.ok(resters.length >= 1);
  for (let i = 0; i < 40; i++) sim.step(STEP);
  const owner = resters.filter(a => (a.flags & 8) !== 0).sort((x, y) => (x.id < y.id ? -1 : 1))[0];
  assert.ok(owner, 'the resting agent is indoors');
  let p = portersOf(sim).find(x => x.job === `agent:${owner.id}`);
  assert.ok(p, 'the resting agent is the porter of its ship');
  assert.equal(p.agentId, owner.id);
  for (let i = 0; i < 2000 && !visible(p); i++) sim.step(STEP);
  assert.ok(visible(p), 'it goes out');
  const home = sim.homeOf(owner.id);
  assert.ok(Math.abs(p.origin.x - (home.door.tx + 0.5)) < 1e-9 && Math.abs(p.origin.y - (home.door.ty + 0.5)) < 1e-9, 'from its own door');
  // wakes up -> its porter is gone at once
  const awake = { ...input, agents: input.agents.map(a => (a.id === owner.input.id ? { ...a, status: 'working', prs: [pr] } : a.project === 'amber' && a.status === 'resting' ? { ...a, prs: [pr] } : a)) };
  sim.applySnapshot(awake, { berths });
  for (let i = 0; i < 3; i++) sim.step(STEP);
  assert.ok(!portersOf(sim).some(x => x.job === `agent:${owner.id}`), 'no porter for an awake agent');
  // stalled / error agents never become porters
  const stalled = { ...input, agents: input.agents.map(a => (a.project === 'amber' && a.status === 'resting' ? { ...a, status: 'stalled', prs: [pr] } : a)) };
  sim.applySnapshot(stalled, { berths });
  for (let i = 0; i < 200; i++) {
    sim.step(STEP);
    for (const q of portersOf(sim)) if (q.agentId != null) assert.notEqual(sim.actors.get(q.agentId)?.input?.status, 'stalled');
  }
});

// does a straight move a->b enter an occupied / blocked tile or cross a blocked edge? (inv4)
function badMove(grid, x0, y0, x1, y1) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.05));
  let tx = Math.floor(x0), ty = Math.floor(y0);
  for (let i = 1; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n, nx = Math.floor(x), ny = Math.floor(y);
    if (nx === tx && ny === ty) continue;
    if (!grid.inBounds(nx, ny)) return `left grid at ${nx},${ny}`;
    if (grid.get('occ', nx, ny) !== 0 || grid.get('cost', nx, ny) >= 255) return `entered blocked tile ${nx},${ny}`;
    const dx = nx - tx, dy = ny - ty;
    const out = dx > 0 ? EDGE.E : dx < 0 ? EDGE.W : dy > 0 ? EDGE.S : dy < 0 ? EDGE.N : 0;
    const back = dx > 0 ? EDGE.W : dx < 0 ? EDGE.E : dy > 0 ? EDGE.N : EDGE.S;
    if (!(dx && dy) && out && (grid.edgeBlocked(tx, ty, out) || grid.edgeBlocked(nx, ny, back))) return `crossed blocked edge ${tx},${ty}->${nx},${ny}`;
    tx = nx; ty = ny;
  }
  return null;
}

test('inv4 harbour-6: 600 ticks (merges mid-run), porters never stand on or walk through blocked tiles; frozen agents stay put', () => {
  // at the classic pace every town-to-quay leg is over 6 s and fades; quick porters make the legs walk (on nav paths)
  const { sim, world, input, berths } = setup();
  for (const p of portersOf(sim)) p.speed = 9;
  const g = world.grid, last = new Map(), frozen = new Map();
  let walked = 0;
  for (let i = 0; i < 600; i++) {
    if (i === 250) sim.applySnapshot(merge(input, ['cedar#3001']), { berths });
    sim.step(STEP);
    for (const p of portersOf(sim)) {
      if (!visible(p) || fading(p)) { last.delete(p.id); continue; }
      const tx = Math.floor(p.x), ty = Math.floor(p.y), who = `tick ${i}: ${p.id}`;
      assert.ok(g.inBounds(tx, ty), `${who} out of bounds`);
      assert.ok(g.get('cost', tx, ty) < 255 && g.get('occ', tx, ty) === 0, `${who} on blocked tile ${tx},${ty}`);
      const q = last.get(p.id);
      if (q && (q.x !== p.x || q.y !== p.y) && p.state !== 'home') {
        const bad = badMove(g, q.x, q.y, p.x, p.y);
        assert.ok(!bad, `${who} ${bad}`);
        walked++;
      }
      last.set(p.id, { x: p.x, y: p.y });
    }
    for (const a of sim.actors.values()) {
      if (a.kind !== 'agent') continue;
      const s = a.input?.status;
      if (s !== 'stalled' && s !== 'error') continue;
      const f = frozen.get(a.id);
      if (f && !fading(a)) assert.ok(f.x === a.x && f.y === a.y, `tick ${i}: ${a.id} (${s}) moved`);
      else if (!fading(a)) frozen.set(a.id, { x: a.x, y: a.y });
    }
  }
  assert.ok(sim.actors.has('token:amber#1000'));
  assert.ok(walked > 50, `porters walked (${walked} moves checked)`);
});

test('[har.tug-escort] [har.rowboats] [har.gulls] harbour life: a tug from tier 3, rowboats and gulls at tier 4, all grid-free', () => {
  const grid = { ox: -20, oy: 0, w: 40, h: 40, inBounds: (x, y) => x >= -20 && y >= 0 && x < 20 && y < 40, get: (l, x, y) => (l === 'cost' ? (y >= 10 ? 255 : 1) : 0) };
  const v = lv => ({ grid, objects: new Map(), venues: { dock: { id: 'dock', kind: 'harbour', tx: 0, ty: 9, level: lv, rect: { x: -10, y: 8, w: 20, h: 14 }, nodes: {}, berths: [] } } });
  const r = (...k) => (k.join('|').length % 7) / 7;
  assert.deepEqual(spawnHarbourLife(v(2), r).map(s => s.kind), []);
  assert.deepEqual(spawnHarbourLife(v(3), r).map(s => s.kind), ['tug']);
  const four = spawnHarbourLife(v(4), r);
  assert.equal(four.filter(s => s.kind === 'tug').length, 1);
  assert.ok(four.filter(s => s.kind === 'rowboat').length >= 1);
  assert.equal(four.filter(s => s.kind === 'gull').length, 3);
  assert.ok(four.every(s => s.gridFree === true));
  for (const s of four.filter(x => x.kind === 'rowboat')) assert.ok(Math.floor(s.y) >= 10, 'rowboats start on water');
});

test('[har.tug-escort] [har.rowboats] [har.gulls] tug escorts a sailing ship and returns; gulls wheel; rowboats keep to the water (tier 4 harbour)', () => {
  const { sim, input, berths, world } = setup();
  // force the harbour to tier 4 and respawn the ambient life (a rebuild normally does this)
  const w4 = { ...world, venues: { ...world.venues, dock: { ...world.venues.dock, level: 4 } } };
  sim.setWorld(w4, navMod.createNav(w4));
  const tug = sim.actors.get('tug:dock:0');
  assert.ok(tug, 'tug spawned');
  const gulls = [...sim.actors.values()].filter(a => a.kind === 'gull');
  assert.equal(gulls.length, 3);
  const g0 = { x: gulls[0].x, y: gulls[0].y };
  sim.applySnapshot(merge(input, ['cedar#3002']), { berths });
  const ship = sim.actors.get('token:cedar#3002');
  let escorted = false;
  for (let i = 0; i < 1600; i++) {
    sim.step(STEP);
    if (tug.escorting === ship.id) escorted = true;
    for (const rb of [...sim.actors.values()].filter(a => a.kind === 'rowboat')) {
      const tx = Math.floor(rb.x), ty = Math.floor(rb.y);
      assert.ok(world.grid.get('cost', tx, ty) >= 255, `rowboat ${rb.id} on water`);
    }
  }
  assert.ok(escorted, 'the tug took the ship out');
  assert.ok(!sim.actors.has(ship.id));
  assert.ok(tug.state === 'idle' || tug.state === 'return');
  assert.ok(Math.hypot(gulls[0].x - g0.x, gulls[0].y - g0.y) > 0 || gulls[0].path, 'gulls move');
});

test('porter timings are the classic ones', () => {
  assert.equal(CAP, 6); assert.equal(PICK, 0.9); assert.equal(DROP, 1.2);
});
