// The world simulation (design §4.1, §4.2 transitions, §4.5; decision D4). Pure, no DOM.
// createSim({ world, nav, seed, mod, deps?, serverId?, onScreen?, t0? }) -> { applySnapshot, tick, actors, events, ... }
//
// Systems run in a fixed order on every fixed step (STEP = 50 ms):
//   snapshot -> intent -> behaviour -> movement -> slots -> animation -> events
// `applySnapshot` diffs WorldInput agents (opaque ids) against the actor store at once (create / remove / mark
// changed); the intent system of the next step re-represents changed agents and calls the behaviour's
// `replan(a, ctx)` (or `init` when it has none).
// Results are a pure function of (seed, world, input sequence, dt sequence): every random number is
// rand(seed, actorId, tick, ...keys) and actors are visited in id order, never Map or input order.
//
// Movement (one rule, see sim/actor.js): behaviours set `a.path` (+ optional a.move / a.speed / a.warp); ONLY the
// movement system here moves actors, and it reports arrival with `a.arrived` (and a refused path with `a.stuck`).
// Every new path is checked against the grid (cost < 255, occ 0, no corner cutting): an illegal path is refused
// for ambient actors and becomes a fade for agents.
//
// Behaviour ctx: { world, nav, slots, mod, seed, dt, tick, now, motion, reduceMotion, night, dayPhase, FLAGS, actors,
//   faceFrom, rand(...keys), emit(type, payload), onScreen(x, y), homeOf(agentId) -> WorldObject|null,
//   place(place, a) -> resolvePlace(place, a, world, { slots, homeOf }), serverId,
//   shouldWalk(lenTiles, speed, onScreen, status) (the D4 rule, for behaviours that move non-agent stand-ins),
//   berths: itemId -> berth record of the last snapshot (opts.berths), tokens: { get(itemId), list() } (sim/tokens.js) }.
// Tokens (sim/tokens.js): applySnapshot(input, { berths }) keeps the berth records and syncs one 'token' actor per held
// berth; an actor with `gridFree: true` (tokens and the mod's on-water / in-air life) is not grid-checked when it moves.
//
// D4 (agents only; enforced here as the safety net, whatever a behaviour asks for), design decision:
//   - shouldWalk(): a new path walks only if pathLength / speed <= WALK_MAX_S (6 s), motion is allowed, the actor is
//     on screen and its status is not stalled / error / stopped; otherwise it fades (out at the origin, in at the end);
//   - stalled and error agents never walk: any path they get is replaced by a 0.3 s fade to its end;
//   - a walk still going after 6 s (+1 step; only possible if the speed drops mid-walk) is cut short with a fade.
// Reduced motion (input.env.reduceMotion): no walking or fading, actors snap to their targets, frame 0 only.
//
// Rebuilds (setWorld): actors are kept. Held slot ids (deterministic strings) are re-claimed in the new nav; agents
// re-plan, and the agent behaviour re-targets only those whose slot / home / target is gone or illegal. A walk whose
// remaining path became illegal turns into a fade. Ambient actors respawn fresh, but one whose id survives keeps its
// position (snapped to the nearest legal tile if its tile is now blocked).
// Slots go through sim/slot-guard.js: no two actors ever hold the same sub-slot position (tx, ty, sub).
//
// Level of detail (PERF M7 psim), off until the integrator calls setView({ zoom }) (the engine does every
// frame; a sim nobody gives a view runs every actor every step, as before). Only the mod's ambient actors are throttled;
// agents and PR tokens always run every step. Per ambient actor, at the start of each real-time step (tick()):
//   - near: zoom >= 1 and on screen -> every step, as without LOD;
//   - far:  zoom < 1 and on screen  -> movement and animation every step (it never jumps on screen); its behaviour runs
//           every step while it moves or fades (yielding, right of way) and every LOD.far steps while it stands still;
//   - off:  off screen (the integrator's onScreen, which has a margin) -> behaviour, movement and animation together every
//           LOD.off steps.
// A skipped system owes its dt to the actor; the next run gets all of it (dt + owed), so dwell timers, walks and fades
// keep their real-time pace and an actor coming back on screen resumes at once with one catch-up step. Which step an
// actor runs on is (tick + a hash of its id) mod the rate, so the work is spread over steps and the result is a pure
// function of (seed, world, input sequence, dt sequence, view sequence). step(seconds) (captures, a pinned ?t) and a
// fast-forward tick never throttle.
//
// Agents at rest (PERF M7 asim, exact: same results with it on or off, see createSim's `fastIdle`). A step that leaves an
// agent still (no path, fade, warp or move request, not leaving, its anim settled) marks it; until a snapshot or a
// re-plan wakes it, each later step offers it to the agent behaviour's `idle(a, dt, ctx)` first, which advances it
// exactly as update() would (an idle-cue timer counting down) or says no without changing anything. An agent idle()
// takes skips the behaviour, movement, slots and animation systems; only its anim clock advances, as the animation
// system would. So ~1,000 settled agents cost a timer each per step, and one whose cue starts or ends, whose status
// changes or that is given a path runs every system that step, in its id-order place.
import { rand as rand0, rng, hash } from '../core/rng.js';
import { guardSlots } from './slot-guard.js';
import { drainSync } from '../core/slices.js';
import { nearestLegal } from './legal.js';
import { createTokens, TOKEN_KIND } from './tokens.js';

export const STEP = 0.05;            // fixed timestep, seconds
export const MAX_CATCHUP = 3;        // steps per tick() before the sim fast-forwards by schedule
export const WALK_SPEED = 2.5;       // tiles per second (default; an actor's `speed` or spec.walk.speed overrides)
export const WALK_MAX_TILES = 40;    // legacy (pre-M3 rule); unused, kept for callers
export const WALK_MAX_S = 6;         // D4: a trip walks only if it takes <= 6 s, else it fades
export const FADE_S = 0.3;           // fade-out + fade-in, jump at the midpoint
export const LEAVE_S = 0.3;          // a removed agent fades out before it is dropped
export const LOD = Object.freeze({ far: 4, off: 8 });   // steps per run: zoomed out (behaviour while still) / off screen
const SNAPSHOT_STEP = 200;   // agents per applySnapshotSteps step
const NEVER_MOVE = new Set(['stalled', 'error']);
const NO_WALK = new Set(['stalled', 'error', 'stopped']);

/**
 * D4 design decision: does a trip of `lenTiles` at `speed` tiles/s walk (true) or fade (false)?
 * True only when lenTiles / speed <= WALK_MAX_S, the actor is on screen and its status bucket is not
 * stalled / error / stopped. `status` is a bucket string or a status record ({ bucket, severity, stopped }).
 * @param {number} lenTiles @param {number} speed @param {boolean} onScreen @param {string|object|null} status
 * @returns {boolean}
 */
export function shouldWalk(lenTiles, speed, onScreen, status) {
  if (!onScreen) return false;
  if (status && typeof status === 'object') {
    if (NO_WALK.has(status.bucket) || status.severity === 'error' || status.stopped) return false;
  } else if (NO_WALK.has(status)) return false;
  const len = Number(lenTiles), v = Number(speed);
  if (!(len >= 0)) return false;
  if (len === 0) return true;
  if (!(v > 0)) return false;
  return len / v <= WALK_MAX_S + 1e-9;
}
const ANIM_FPS = { idle: 2, walk: 8, hammer: 6, sit: 1, carry: 8, wave: 4, cheer: 6, sleep: 1, enter: 8 };

import { makeActor as makeActor0, stepAlongPath as step0, faceFrom, FLAGS as FLAGS0 } from './actor.js';
import { createEvents as createEvents0 } from './events.js';
import { representAgent as represent0, resolvePlace as resolvePlace0, animOf, isAnim } from './represent.js';
import agentBehaviour0 from './behaviours/agent.js';

/** A behaviour module may be a namespace ({ init, update }), a default export, or a named object. */
const asBehaviour = m => {
  const b = m && (typeof m.update === 'function' || typeof m.init === 'function') ? m : m?.default ?? m?.agent ?? m?.behaviour ?? null;
  return b && (typeof b.update === 'function' || typeof b.init === 'function') ? b : null;
};

function defaultDeps() {
  return {
    makeActor: makeActor0, stepAlongPath: step0, FLAGS: FLAGS0, createEvents: createEvents0,
    representAgent: represent0, resolvePlace: resolvePlace0, agentBehaviour: agentBehaviour0,
  };
}

/** Night window of a day phase (0..1, 0 = midnight-ish start of the cycle): [0.75, 1) U [0, 0.1). */
export const nightOf = phase => phase >= 0.75 || phase < 0.1;
export const DAY_LEN_S = 480;        // default sim clock: one game day in seconds of sim time

/** Every tile a straight segment enters after its start tile (DDA). A corner crossing needs both side tiles ok. */
function segmentOk(ok, x0, y0, x1, y1) {
  let tx = Math.floor(x0), ty = Math.floor(y0);
  const ex = Math.floor(x1), ey = Math.floor(y1);
  if (tx === ex && ty === ey) return true;
  const dx = x1 - x0, dy = y1 - y0, sx = Math.sign(dx), sy = Math.sign(dy);
  const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity;
  let tmx = dx ? (sx > 0 ? tx + 1 - x0 : x0 - tx) * tdx : Infinity;
  let tmy = dy ? (sy > 0 ? ty + 1 - y0 : y0 - ty) * tdy : Infinity;
  for (let n = Math.abs(ex - tx) + Math.abs(ey - ty) + 2; n > 0 && (tx !== ex || ty !== ey); n--) {
    if (Math.abs(tmx - tmy) < 1e-9) {
      if (!ok(tx + sx, ty) || !ok(tx, ty + sy)) return false;
      tx += sx; ty += sy; tmx += tdx; tmy += tdy;
    } else if (tmx < tmy) { tx += sx; tmx += tdx; } else { ty += sy; tmy += tdy; }
    if (!ok(tx, ty)) return false;
  }
  return ok(ex, ey);
}
/** A path is legal when every tile it enters (after the actor's own tile) is in bounds, cost < 255 and occ 0. */
export function pathLegal(grid, x, y, p) {
  if (!grid || typeof grid.get !== 'function') return true;
  const ok = (tx, ty) => (!grid.inBounds || grid.inBounds(tx, ty)) && grid.get('cost', tx, ty) < 255 && grid.get('occ', tx, ty) === 0;
  let cx = x, cy = y;
  for (let i = 0; i + 1 < p.length; i += 2) {
    if (!segmentOk(ok, cx, cy, p[i], p[i + 1])) return false;
    cx = p[i]; cy = p[i + 1];
  }
  return true;
}

/** Last point of a path (Float32Array of x,y pairs) or null. */
const pathEnd = p => (p && p.length >= 2 ? { x: p[p.length - 2], y: p[p.length - 1] } : null);
/** Polyline length in tiles from (x,y) through the path. */
function pathLength(p, x, y) {
  let len = 0, cx = x, cy = y;
  for (let i = 0; i + 1 < p.length; i += 2) { len += Math.hypot(p[i] - cx, p[i + 1] - cy); cx = p[i]; cy = p[i + 1]; }
  return len;
}

const sameList = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);
/** The fields of a WorldInput agent whose change re-plans the actor (status, place, owner). */
const intentChanged = (p, n) => p.status !== n.status || p.needs !== n.needs || p.project !== n.project || p.parent !== n.parent
  || p.role !== n.role || p.important !== n.important || p.stopped !== n.stopped || p.crown !== n.crown || !sameList(p.prs, n.prs);
const statusOf = ag => ({ bucket: ag.status, severity: ag.status === 'error' ? 'error' : null, prompt: ag.needs ?? null,
  role: ag.role, important: !!ag.important, stopped: !!ag.stopped });

/**
 * @param {{ world: object, nav?: object, seed?: number|string, mod?: object,
 *   deps?: { makeActor?, stepAlongPath?, FLAGS?, createEvents?, representAgent?, resolvePlace?, agentBehaviour? },
 *   serverId?: (opaque: string) => string|undefined, onScreen?: (x: number, y: number) => boolean, t0?: number,
 *   clock?: ((now: number) => number) | { dayLength?: number, phase0?: number } }} opts
 *   clock: the sim day clock giving ctx.dayPhase (0..1) and ctx.night (bool). A function maps sim seconds to a phase;
 *   an object runs phase0 + now / dayLength. Without it the phase follows WorldInput env.night (>= 0.5 is night).
 */
export function createSim({ world, nav = null, seed = 0, mod = null, deps = {}, serverId = id => id, onScreen = () => true, t0 = 0, clock = null,
  fastIdle = true } = {}) {
  const D = { ...defaultDeps(), ...Object.fromEntries(Object.entries(deps).filter(([, v]) => v != null)) };
  const makeActor = D.makeActor, FLAGS = D.FLAGS;
  const events = D.createEvents();
  const agentBeh = asBehaviour(D.agentBehaviour);
  /** The agent behaviour's exact rest step (see the header), or null: every agent runs every system every step. */
  const agentIdle = fastIdle !== false && typeof agentBeh?.idle === 'function' ? agentBeh.idle : null;
  const seedN = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hash(seed);

  const actors = new Map();
  let order = null;                    // cached id-sorted actor list
  const dirty = new Set();             // agent ids whose intent must be re-planned at the next step
  const agentIn = new Map();           // id -> last WorldInput agent
  const ambientIds = new Set();
  let tickN = 0, acc = 0, motion = true, baseline = false, envNight = 0;
  let projects = new Set(), prState = new Map();
  let homes = null;                    // server id -> home object (lazy, per world)
  let cur = null;                      // the actor a behaviour is currently running for (ctx.rand key)
  let slotsHeld = new Map();           // actor id -> slot it held at the end of the last slots stage
  let slotsGen = 1;                    // bumped when slotsHeld changes outside the slots stage (a._slotGen, sysSlots)
  let selected = null;                 // the one actor carrying FLAGS.SELECTED
  let viewZoom = null;                 // setView({ zoom }): null = LOD off (every actor every step)
  const lodStats = { near: 0, far: 0, off: 0, ran: 0, skipped: 0 };   // the last step's ambient classes and runs
  const live = [];                     // this step's actors in id order minus the ones LOD skips whole (lodPlan)
  const rest = [];                     // this step's agents at rest that the agent behaviour's idle() advanced (lodPlan)

  const now = () => t0 + tickN * STEP;
  const phaseAt = t => {
    if (typeof clock === 'function') { const v = Number(clock(t)); return Number.isFinite(v) ? ((v % 1) + 1) % 1 : 0; }
    if (clock && typeof clock === 'object') return ((((clock.phase0 ?? 0.3) + t / (clock.dayLength || DAY_LEN_S)) % 1) + 1) % 1;
    return envNight >= 0.5 ? 0.9 : 0.4;
  };
  const ctx = {
    world, nav, slots: guardSlots(nav?.slots ?? null), mod, seed: seedN, dt: STEP, tick: 0, now: 0, motion: true, reduceMotion: false,
    night: false, dayPhase: 0.4, FLAGS, actors, faceFrom,
    rand: (...keys) => rand0(seedN, cur?.id ?? '', tickN, ...keys),
    emit: (type, payload = {}) => events.emit(type, { tick: tickN, ...payload }),
    onScreen: (x, y) => !!onScreen(x, y),
    homeOf: agentId => homeOf(agentId),
    place: (place, a) => (D.resolvePlace ? D.resolvePlace(place, a, world, { slots: ctx.slots, homeOf }) : null),
    serverId, shouldWalk, berths: {}, tokens: null,
  };

  function homeOf(agentId) {
    if (!homes) {
      homes = new Map();
      for (const o of world?.objects?.values?.() ?? []) {
        const d = o?.data;
        if (d && d.owner === 'home' && d.agentId != null && !homes.has(String(d.agentId))) homes.set(String(d.agentId), o);
      }
    }
    const sid = serverId(agentId) ?? agentId;
    return homes.get(String(sid)) ?? null;
  }

  const sorted = () => (order ||= [...actors.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  const add = a => { actors.set(a.id, a); order = null; return a; };
  const drop = id => {
    actors.delete(id); order = null; dirty.delete(id); agentIn.delete(id); ambientIds.delete(id);
    if (slotsHeld.has(id)) { ctx.slots?.release?.(id); slotsHeld.delete(id); }
    if (selected === id) selected = null;
  };
  const behaviourOf = a => (a.kind === 'agent' ? agentBeh : asBehaviour(mod?.ambient?.behaviours?.[a.kind]));
  const run = (a, fn) => { const prev = cur; cur = a; try { return fn(); } finally { cur = prev; } };
  const syncCtx = () => {
    ctx.tick = tickN; ctx.now = now(); ctx.motion = motion; ctx.reduceMotion = !motion;
    ctx.dayPhase = phaseAt(ctx.now); ctx.night = nightOf(ctx.dayPhase);
  };
  const tokens = createTokens({
    actors,
    hasBehaviour: kind => !!asBehaviour(mod?.ambient?.behaviours?.[kind]),
    spawn(spec) {
      const a = add(makeActor({ ...spec, kind: TOKEN_KIND }));
      a.px = a.x; a.py = a.y; a.alpha ??= 1;
      syncCtx();
      run(a, () => behaviourOf(a)?.init?.(a, ctx));
      adopt(a);
      return a;
    },
    leave: a => { a.leaving = LEAVE_S; a.path = undefined; a._path = undefined; a.fade = null; },
  });
  ctx.tokens = tokens.view;

  // ---- spawning --------------------------------------------------------------------------------------------
  function villageOf(project) { return (world?.villages || []).find(v => v.name === project) || null; }
  /** Where a new agent first appears (no slot claimed); its behaviour's init then places it exactly (a.warp). */
  function spawnPoint(a, ag) {
    const p = spawnPoint0(a, ag);
    return nearestLegal(world?.grid, p.x, p.y) ?? p;      // never first appear on a blocked tile
  }
  function spawnPoint0(a, ag) {
    if (a.spec?.place != null && D.resolvePlace) {
      const p = D.resolvePlace(a.spec.place, a, world, { homeOf });
      if (p && Number.isFinite(p.tx)) return { x: p.tx, y: p.ty };
    }
    const h = homeOf(ag.id);
    if (h?.door) return { x: h.door.tx, y: h.door.ty };
    if (h) return { x: h.tx, y: h.ty };
    const v = villageOf(ag.project);
    if (v && Number.isFinite(v.cx)) return { x: v.cx, y: v.cy };
    if (v?.origin) return { x: v.origin.x, y: v.origin.y };
    return { x: 0, y: 0 };
  }
  function represent(a, ag) {
    a.spec = D.representAgent ? D.representAgent(ag, mod, { homeOf, world }) : null;
    a.status = statusOf(ag);
    a.input = ag;
    a.project = ag.project;
    a.parent = ag.parent ?? undefined;
    a.prs = Array.isArray(a.spec?.prs) ? a.spec.prs : Array.isArray(ag.prs) ? ag.prs : [];
    const h = homeOf(ag.id);
    a.home = h ? h.id : undefined;
  }
  /** Apply the movement requests a behaviour left in init (warp now; path through the guard). */
  function adopt(a) {
    applyWarp(a);
    a.path = guardNewPath(a, a.path); a._path = a.path;
  }
  function spawnAgent(ag) {
    const a = add(makeActor({ id: ag.id, kind: 'agent', agentId: ag.id, project: ag.project, x: 0, y: 0 }));
    a.alpha = 1;
    represent(a, ag);
    const p = spawnPoint(a, ag);
    a.x = a.px = p.x; a.y = a.py = p.y;
    syncCtx();
    run(a, () => agentBeh?.init?.(a, ctx));
    adopt(a);
    return a;
  }
  /** (Re)spawn the ambient actors. `keep`: id -> { x, y } of the previous ones; a surviving id keeps its spot. */
  function spawnAmbient(keep = null) {
    for (const id of ambientIds) drop(id);
    const spawn = mod?.ambient?.spawn;
    if (typeof spawn !== 'function' || !world) return;
    // seeded by the sim seed only: world.version is a stamping-op counter, not content, so it must not reshuffle life
    const stream = rng(hash(`${seedN}|ambient`));
    const r = (...keys) => (keys.length ? rand0(seedN, 'ambient', ...keys) : stream());
    const specs = spawn(world, r) || [];
    syncCtx();
    specs.forEach((s, i) => {
      if (!s || !s.kind || !asBehaviour(mod.ambient.behaviours?.[s.kind])) return;
      const id = String(s.id ?? `${s.kind}:${i}`);
      if (actors.has(id)) return;
      const a = add(makeActor({ ...s, id, kind: s.kind, x: s.x ?? s.tx ?? 0, y: s.y ?? s.ty ?? 0 }));
      a.px = a.x; a.py = a.y; a.alpha ??= 1;
      ambientIds.add(id);
      run(a, () => behaviourOf(a)?.init?.(a, ctx));
      const old = keep?.get(id);
      if (old) {
        const p = a.gridFree === true ? { x: old.x, y: old.y } : nearestLegal(world.grid, old.x, old.y);
        if (p) { a.warp = undefined; a.x = a.px = p.x; a.y = a.py = p.y; a.face = old.face ?? a.face; }
      }
      adopt(a);
    });
  }

  // ---- snapshot --------------------------------------------------------------------------------------------
  // PERF M7 (poll path): the id-sorted order of the last snapshot's agents, kept while the ids come in the same order
  // (a status flip changes records, not ids): the same order as sorting again, without the sort.
  let lastIds = null, lastPerm = null;
  function inputOrder(list) {
    const n = list.length;
    let same = !!lastIds && lastIds.length === n;
    for (let i = 0; same && i < n; i++) same = list[i]?.id === lastIds[i];
    if (!same) {
      lastIds = list.map(a => a?.id);
      lastPerm = lastIds.map((_, i) => i).sort((x, y) => { const a = lastIds[x], b = lastIds[y]; return a < b ? -1 : a > b ? 1 : x - y; });
    }
    return lastPerm.map(i => list[i]);
  }
  /** Diff the WorldInput against the actor store. Creates and removes at once; status changes re-plan next step. */
  function applySnapshot(input, opts = {}) {
    return drainSync(applySnapshotSteps(input, opts));
  }
  /** applySnapshot as a step generator (PERF M7): the same work in the same order, yielding every
   *  SNAPSHOT_STEP agents of the diff, so the sliced cold build (world/world-steps.js) can hand the thread back while a
   *  large first snapshot spawns its actors. Nothing may read or tick the sim between its steps. */
  function* applySnapshotSteps(input, opts = {}) {
    if (!input) return;
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'berths')) {
      const b = opts.berths;
      ctx.berths = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    }
    motion = !input.env?.reduceMotion;
    envNight = Number(input.env?.night) || 0;
    const seen = new Set();
    let k = 0;
    for (const ag of inputOrder(input.agents || [])) {
      if (++k % SNAPSHOT_STEP === 0) yield 'snapshot';
      if (!ag || ag.id == null || seen.has(ag.id)) continue;
      seen.add(ag.id);
      const a = actors.get(ag.id), prev = agentIn.get(ag.id);
      agentIn.set(ag.id, ag);
      if (!a) {
        spawnAgent(ag);
        if (baseline) events.emit('arrive', { tick: tickN, id: ag.id, project: ag.project });
        continue;
      }
      if (a.leaving != null) {         // came back while fading out
        a.leaving = null; a.flags &= ~FLAGS.GHOST; a.alpha = 1; dirty.add(ag.id);
      }
      a._still = false;
      if (prev === ag && a.input === ag) continue;   // the very same record (mod/input.js reuse): nothing to redo
      a.input = ag; a.status = statusOf(ag);
      if (!prev || intentChanged(prev, ag)) dirty.add(ag.id);
    }
    for (const a of sorted()) {
      if (a.kind !== 'agent' || seen.has(a.id) || a.leaving != null) continue;
      a.leaving = LEAVE_S; a.flags |= FLAGS.GHOST; a.path = undefined; a._path = undefined; a.fade = null; a._still = false;
      dirty.delete(a.id);
      if (slotsHeld.has(a.id) || a.slot) { ctx.slots?.release?.(a.id); slotsHeld.delete(a.id); a.slot = undefined; slotsGen++; }
      events.emit('leave', { tick: tickN, id: a.id, project: a.project });
    }
    // world moments from the diff (none on the first snapshot: that is the baseline, not news)
    const nextProjects = new Set((input.projects || []).map(p => p.key));
    const nextPr = new Map();
    for (const p of input.prs || []) nextPr.set(p.id, p.state);
    if (baseline) {
      // only the new projects and the PRs that just merged are sorted (the same events, in the same order, as sorting all)
      const found = [], merged = [];
      for (const k of nextProjects) if (!projects.has(k)) found.push(k);
      for (const [id, st] of nextPr) { const was = prState.get(id); if (st === 'merged' && was && was !== 'merged') merged.push(id); }
      for (const k of found.sort()) events.emit('found', { tick: tickN, project: k });
      for (const id of merged.sort((a, b) => (a < b ? -1 : 1))) events.emit('merge', { tick: tickN, pr: id, project: id.split('#')[0] });
    }
    projects = nextProjects; prState = nextPr; baseline = true;
    tokens.sync(ctx.berths, prState, now());
  }

  /**
   * Swap in a rebuilt world (and its nav). Actors are kept: held slot ids are re-claimed in the new nav (in actor id
   * order), every agent re-plans (the behaviour keeps a still-legal target), a walk whose rest became illegal fades,
   * ambient actors respawn but a surviving id keeps its (legal) position.
   */
  function setWorld(nextWorld, nextNav = nav) {
    const oldTier = new Map((world?.villages || []).map(v => [v.name, v.tier]));
    const oldSlots = ctx.slots;
    const heldIds = new Map();
    for (const a of sorted()) {
      const s = oldSlots?.heldBy?.(a.id);
      if (s && a.kind === 'agent' && a.leaving == null) heldIds.set(a.id, s.id);
    }
    const keep = new Map();
    for (const id of ambientIds) { const a = actors.get(id); if (a) keep.set(id, { x: a.x, y: a.y, face: a.face }); }
    world = nextWorld; nav = nextNav; homes = null;
    ctx.world = world; ctx.nav = nav; ctx.slots = guardSlots(nav?.slots ?? null);
    slotsHeld = new Map(); slotsGen++;
    const S = ctx.slots;
    for (const a of sorted()) {
      if (ambientIds.has(a.id)) continue;
      const id = heldIds.get(a.id);
      const got = id != null && S?.get?.(id) ? S.claim(id, a.id) : null;
      if (got && a.slot) slotsHeld.set(a.id, a.slot);
      else if (!S?.heldBy) { if (a.slot) slotsHeld.set(a.id, a.slot); }   // a registry we cannot query: trust a.slot
      else a.slot = undefined;
    }
    for (const v of world?.villages || []) {
      const t = oldTier.get(v.name);
      if (t != null && v.tier > t) events.emit('tierUp', { tick: tickN, project: v.name, from: t, to: v.tier });
    }
    for (const a of sorted()) {
      if (a.kind !== 'agent' || a.leaving != null) continue;
      dirty.add(a.id);
      if (a.path && a.path === a._path) {          // an accepted walk: its rest must still be legal
        const rest = a.path.subarray((a.pathI ?? 0) * 2);
        const end = pathEnd(a.path);
        if (!rest.length || !pathLegal(world?.grid, a.x, a.y, rest)) { startFade(a, end); a._path = undefined; }
      }
    }
    spawnAmbient(keep);
  }

  // ---- movement --------------------------------------------------------------------------------------------
  function applyWarp(a) {
    const w = a.warp;
    if (!w) return;
    a.warp = undefined;
    if (Number.isFinite(w.x) && Number.isFinite(w.y)) { a.x = a.px = w.x; a.y = a.py = w.y; }
  }
  function startFade(a, to) {
    a.fade = { t: 0, dur: FADE_S, x: to.x, y: to.y, jumped: false };
    a.path = undefined; a.pathI = 0;
  }
  function snapTo(a, to) { a.x = a.px = to.x; a.y = a.py = to.y; a.path = undefined; a.pathI = 0; a.fade = null; a.alpha = 1; a.arrived = true; }
  /** Decide walk / fade / snap / refuse for a path a behaviour just gave the actor. Returns the path to keep. */
  function guardNewPath(a, p) {
    const mode = a.move; a.move = undefined;
    a.walkT = 0; a.stuck = false;
    const end = pathEnd(p);
    if (!end) return undefined;
    a.arrived = false; a.pathI = 0;
    const isAgent = a.kind === 'agent';
    const legal = a.gridFree === true || pathLegal(world?.grid, a.x, a.y, p);
    if (!isAgent && !legal) { a.stuck = true; return undefined; }   // ambient: refused, the behaviour picks again
    if (!motion || mode === 'snap') { snapTo(a, end); return undefined; }
    if (mode === 'fade') { startFade(a, end); return undefined; }
    if (!isAgent) return p;
    const never = NEVER_MOVE.has(a.input?.status);
    const walkable = !never && legal && mode !== 'fade'
      && shouldWalk(pathLength(p, a.x, a.y), speedOf(a), ctx.onScreen(a.x, a.y), a.status ?? a.input?.status);
    if (!walkable) { startFade(a, end); return undefined; }
    return p;
  }
  const speedOf = a => a.speed ?? (typeof a.spec?.walk === 'object' ? a.spec.walk?.speed : typeof a.spec?.walk === 'number' ? a.spec.walk : null) ?? WALK_SPEED;

  // ---- systems ---------------------------------------------------------------------------------------------
  function sysIntent() {
    if (!dirty.size) return;
    for (const id of [...dirty].sort()) {
      const a = actors.get(id), ag = agentIn.get(id);
      if (!a || !ag) continue;
      a._still = false;
      represent(a, ag);
      run(a, () => (agentBeh?.replan ?? agentBeh?.init)?.(a, ctx));
    }
    dirty.clear();
  }
  function sysBehaviour(dt0) {
    for (const a of live) {
      if (a.leaving != null) continue;
      const dt = a._lodPh === undefined ? dt0 : a._bDt;
      if (dt < 0) continue;
      const b = behaviourOf(a);
      if (typeof b?.update !== 'function') continue;
      const prev = cur; cur = a;
      try { b.update(a, dt, ctx); } finally { cur = prev; }
    }
  }
  function sysMovement(dt0, fastForward) {
    for (const a of live) {
      if (a.leaving != null) continue;
      const dt = a._lodPh === undefined ? dt0 : a._mDt;
      if (dt < 0) continue;
      applyWarp(a);
      if (a.path !== a._path) { a.path = guardNewPath(a, a.path); a._path = a.path; }
      if (a.fade) {
        const f = a.fade;
        if (fastForward || !motion) { snapTo(a, f); a._path = undefined; continue; }
        f.t += dt;
        if (!f.jumped && f.t >= f.dur / 2) { a.x = a.px = f.x; a.y = a.py = f.y; f.jumped = true; }
        a.alpha = f.t >= f.dur ? 1 : Math.abs(1 - (2 * f.t) / f.dur);
        if (f.t >= f.dur) { a.fade = null; a.arrived = true; }
        continue;
      }
      if (!a.path) continue;
      const end = pathEnd(a.path);
      if (fastForward || !motion) { snapTo(a, end); a._path = undefined; continue; }
      if (a.kind === 'agent') {
        if (NEVER_MOVE.has(a.input?.status)) { startFade(a, end); a._path = undefined; continue; }   // went stalled mid-walk
        a.walkT = (a.walkT || 0) + dt;
        if (a.walkT > WALK_MAX_S + STEP + 1e-9) { startFade(a, end); a._path = undefined; continue; }
      }
      const x0 = a.x, y0 = a.y;
      const done = D.stepAlongPath(a, dt, speedOf(a));
      const dx = a.x - x0, dy = a.y - y0;
      if (dx || dy) a.face = faceFrom(dx, dy);
      if (done === true || (Math.abs(a.x - end.x) < 1e-6 && Math.abs(a.y - end.y) < 1e-6)) {
        a.x = end.x; a.y = end.y; a.path = undefined; a._path = undefined; a.pathI = 0; a.arrived = true;
      }
    }
  }
  function sysSlots() {
    const S = ctx.slots;
    for (const a of live) {
      // slotsHeld already says what a.slot says when neither changed since this actor's last slots stage
      if (a._slotGen === slotsGen && a._slotRef === a.slot) continue;
      const held = slotsHeld.get(a.id);
      if (a.slot) slotsHeld.set(a.id, a.slot);
      else if (held) { S?.release?.(a.id); slotsHeld.delete(a.id); }
      a._slotRef = a.slot; a._slotGen = slotsGen;
    }
  }
  function sysAnimation(dt0) {
    for (const a of live) {
      const dt = a._lodPh === undefined ? dt0 : a._mDt;
      if (dt < 0) continue;
      const moving = !!a.path && !a.fade;
      if (moving) a.anim = 'walk';
      else if (a.anim === 'walk') a.anim = a.spec?.pose ? animOf(a.spec.pose, mod) : 'idle';
      if (a.anim !== a._anim || a._anim === undefined) {       // a set a._anim only ever holds an enum value
        if (!isAnim(a.anim)) a.anim = animOf(a.anim, mod);    // the renderer only ever sees the §4.1 enum
        if (a.anim !== a._anim) { a._anim = a.anim; a.animT = 0; }
      }
      if (agentIdle !== null && a.kind === 'agent') {
        // still: nothing for the movement system next step, and an anim this system would leave as it is
        a._still = !moving && a.leaving == null && !a.path && !a._path && !a.fade && !a.warp && a.move === undefined && a.anim !== 'walk';
      }
      if (!motion) { a.frame = 0; continue; }
      a.animT = (a.animT || 0) + dt;
      a.frame = Math.floor(a.animT * (ANIM_FPS[a.anim] ?? 4));
    }
  }
  /** The animation system for the step's agents at rest: a settled enum anim, so only the clock and frame move. */
  function restAnimation(dt) {
    for (const a of rest) {
      if (!motion) { a.frame = 0; continue; }
      a.animT = (a.animT || 0) + dt;
      a.frame = Math.floor(a.animT * (ANIM_FPS[a.anim] ?? 4));
    }
  }
  function sysEvents(dt) {
    for (const a of sorted()) {
      if (a.leaving == null) continue;
      a.leaving -= dt;
      a.alpha = Math.max(0, a.leaving / LEAVE_S);
      if (a.leaving <= 0) drop(a.id);
    }
  }

  /** Plans this step's ambient LOD (see the header). An actor that LOD ever touched (a._lodPh set) carries its own dt
   *  for the step, a._bDt (behaviour) and a._mDt (movement + animation), < 0 = skipped (the dt is owed); every other actor
   *  uses the step dt. With LOD off an owing actor runs and pays off what it owes. Also snapshots px/py and lists the
   *  step's live actors (id order) for the systems, leaving out the ones skipped whole (one pass). */
  function lodPlan(dt, on) {
    lodStats.near = lodStats.far = lodStats.off = lodStats.ran = lodStats.skipped = 0;
    const all = sorted();
    live.length = 0; rest.length = 0;
    for (const a of all) {
      a.px = a.x; a.py = a.y;
      if (a._lodPh === undefined) {
        // an agent at rest that idle() advanced: only its anim clock is left of the step (restAnimation)
        if (a._still === true && a.leaving == null && agentIdle(a, dt, ctx)) { rest.push(a); continue; }
        if (!on || !ambientIds.has(a.id)) { live.push(a); continue; }
        a._lodPh = hash(a.id) % LOD.off; a._oweB = 0; a._oweM = 0;
      }
      let runB = true, runM = true;
      if (on) {
        if (!onScreen(a.x, a.y)) { lodStats.off++; runB = runM = (tickN + a._lodPh) % LOD.off === 0; }
        else if (viewZoom < 1) { lodStats.far++; runB = !!(a.path || a.fade) || (tickN + a._lodPh) % LOD.far === 0; }
        else lodStats.near++;
        if (runB) lodStats.ran++; else lodStats.skipped++;
      }
      if (runB) { a._bDt = dt + a._oweB; a._oweB = 0; } else { a._oweB += dt; a._bDt = -1; }
      // runB implies runM, so an actor whose movement is skipped is skipped whole: no system visits it this step
      if (runM) { a._mDt = dt + a._oweM; a._oweM = 0; live.push(a); } else { a._oweM += dt; a._mDt = -1; }
    }
  }

  function step(dt, fastForward = false, lodOn = false) {
    syncCtx();
    sysIntent();                       // (snapshot ran in applySnapshot); before lodPlan, which offers still agents to idle()
    lodPlan(dt, lodOn && !fastForward && viewZoom != null && motion);
    sysBehaviour(dt);
    sysMovement(dt, fastForward);
    sysSlots();
    sysAnimation(dt);
    restAnimation(dt);
    sysEvents(dt);
  }

  /** Advance by a frame's dt (seconds). Fixed 50 ms steps; more than MAX_CATCHUP owed fast-forwards by schedule. */
  function tick(dt) {
    if (!(dt > 0)) return 0;
    acc += dt;
    let n = Math.floor(acc / STEP + 1e-9);
    acc -= n * STEP;
    if (acc < 0) acc = 0;
    if (n > MAX_CATCHUP) {
      // one big step: movers jump to their route ends; behaviours see the whole elapsed time
      tickN += n - 1;
      step(n * STEP, true);
      tickN += 1;
      for (const a of actors.values()) { a.px = a.x; a.py = a.y; }
      return n;
    }
    for (let i = 0; i < n; i++) { step(STEP, false, true); tickN++; }
    return n;
  }

  /** Run round(seconds / STEP) fixed steps (no accumulator, no fast-forward): deterministic for a seed. */
  function stepN(seconds) {
    const n = Math.max(0, Math.round((Number(seconds) || 0) / STEP));
    for (let i = 0; i < n; i++) { step(STEP); tickN++; }
    return n;
  }
  /** Mark one actor selected (FLAGS.SELECTED); null (or an unknown id) clears the selection. */
  function select(id) {
    const prev = selected != null ? actors.get(selected) : null;
    if (prev) prev.flags &= ~FLAGS.SELECTED;
    const a = id != null ? actors.get(id) : null;
    selected = a ? a.id : null;
    if (a) a.flags |= FLAGS.SELECTED;
    return selected;
  }

  /** Render-time interpolated position. */
  const lerp = a => { const t = Math.min(1, acc / STEP); return { x: a.px + (a.x - a.px) * t, y: a.py + (a.y - a.py) * t }; };

  syncCtx();
  spawnAmbient();

  return {
    applySnapshot, applySnapshotSteps, tick, step: stepN, select, setWorld, lerp, actors, events,
    get selected() { return selected; },
    get alpha() { return Math.min(1, acc / STEP); },
    get tickCount() { return tickN; },
    get now() { return now(); },
    get motion() { return motion; },
    /** The integrator calls this every frame: fn(x, y) -> boolean in tile coords (true = on screen). */
    setOnScreen(fn) { onScreen = typeof fn === 'function' ? fn : () => true; },
    /** The integrator's camera, every frame: { zoom } turns ambient LOD on (see the header); null turns it off. */
    setView(v) { const z = Number(v?.zoom); viewZoom = v == null || !Number.isFinite(z) ? null : z; },
    /** The last step's ambient LOD classes (near / far / off) and behaviour runs vs skips, and how many agents rested
     *  (idle() advanced them, see the header), for the debug perf block. */
    get lod() { return { on: viewZoom != null, zoom: viewZoom, ...lodStats, rest: rest.length }; },
    homeOf,
  };
}
