// Engine v2 sim/behaviours/agent.js (S3): agent actors, design §4.2 and decision D4.
// Behaviour module shape: { init(a, ctx), replan(a, ctx), update(a, dt, ctx) } with the world-sim ctx
// ({ world, nav, slots, rand(...keys), now, emit, place(place, a), homeOf(agentId) -> WorldObject|null, reduceMotion, ... }).
// WHERE an agent should be comes from ctx.place(spec.place, a) (sim/represent.js resolvePlace, which also reserves the
// slot). This module decides the target point, asks the sim to move there (a.path + a.move, see sim/actor.js), and
// picks the pose, idle cues and effects. It never changes x/y itself: the world-sim movement system does, applying D4
// (world-sim shouldWalk: walk only if the trip takes <= 6 s, on screen, motion allowed; else fade; stalled/error never
// walk). A world rebuild re-plans every agent, but one whose slot / home / target is still there and legal keeps it.
// Stalled and error agents always fade (spec.walk is false for them), and once settled they never move or re-plan.
// Deterministic: all timers advance by dt; randomness only via ctx.rand.
import { ENGINE_BEHAVIOUR, animOf } from '../represent.js';
import { FLAGS } from '../actor.js';
import { isLegalTile, nearestLegal } from '../legal.js';

export const FADE_S = 0.3;            // = world-sim FADE_S
export const WALK_MAX_S = 6;          // = world-sim WALK_MAX_S
export const ENTER_S = 0.4;           // §2.3: "enter" fade at a door
export const WALK_SPEED = 2.5;        // tiles per second
const { INDOORS, GHOST, VISIBLE } = FLAGS;

// Idle tags: `continuous` ones are shown all the time (a.fx), the rest are timed cues. A mod adds or overrides tags in
// `mod.represent.cues: Record<tag, { continuous?, every?: [min,max], len? }>`; these are only the engine's own.
const ENGINE_CUES = { 'look-around': { every: [6, 10], len: 1.2 }, wave: { every: [4, 4], len: 1.0 }, sparks: { continuous: true }, smoke: { continuous: true } };
const cueOf = (ctx, tag) => ctx?.mod?.represent?.cues?.[tag] ?? ENGINE_CUES[tag];
const isContinuous = (ctx, tag) => !!cueOf(ctx, tag)?.continuous;
const DEFAULT_EVERY = [5, 8], DEFAULT_LEN = 1.2;

/** The behaviour key for an actor's status (§4.2 rows). */
export function behaviourKey(a) {
  const s = a.status || {};
  const b = s.bucket;
  if (b === 'error' || s.severity === 'error') return 'stalled:error';
  if (b === 'stalled') return s.prompt ? 'stalled:prompt' : 'stalled:attention';
  if (b === 'waiting') return 'waiting';
  if (b === 'resting') return (s.important || s.stopped) ? 'resting:doorstep' : 'resting';
  if (b === 'working' || b === 'building') return hasPr(a) ? 'working' : 'building';
  return 'waiting';
}
const hasPr = (a) => !!(a.pr || a.prs?.length || a.status?.pr);

/** Stalled or error: never wanders. */
export function isPinned(key) { return key.startsWith('stalled'); }

/** The ActorSpec in force: a.spec (from represent.representAgent) wins, else the engine default for the status. */
export function specFor(a) {
  const key = a.spec?.key ?? behaviourKey(a);
  const spec = a.spec?.place ? a.spec : ENGINE_BEHAVIOUR[key] ?? ENGINE_BEHAVIOUR.waiting;
  return { key, spec };
}
const ghostOf = (key, spec) => spec.ghost ?? key === 'resting:doorstep';
const indoorsOf = (key, spec) => !ghostOf(key, spec) && (spec.indoors ?? (key === 'resting' || spec.pose === 'indoors'));

// Every agent is drawn: there is no yard cap. When a home's yard has no free stand slot nearby, the agent spills onto a
// free walkable tile beside the yard (nav/slots.js claimSpill), never a door tile, and never on another actor's slot.
const SPILL_NEAR = 5;      // a free slot farther than this from the wanted spot counts as "no room": spill instead

// Sub-slot offsets inside a tile (feet position), sub 0..3.
const SUB = [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]];
const feetOf = (tx, ty, sub = -1) => (sub >= 0 && sub < 4
  ? { x: tx + SUB[sub][0], y: ty + SUB[sub][1] } : { x: tx + 0.5, y: ty + 0.5 });

function rnd(ctx, ...keys) {
  const r = ctx.rand(...keys);
  return Number.isFinite(r) ? r : 0;
}
const between = (ctx, [lo, hi], ...keys) => lo + (hi - lo) * rnd(ctx, ...keys);

/** Resolve the target: { x, y, tx, ty, slotId, indoors, face } or null (stay where you are). Holds at most one slot. */
function resolveTarget(a, key, spec, ctx) {
  const prevSpill = ctx.slots?.heldBy?.(a.id);
  const keepSpill = prevSpill && String(prevSpill.id).startsWith('spill:') ? prevSpill.id : null;   // stable across polls
  ctx.slots?.release?.(a.id);
  a.slot = undefined;
  let p = ctx.place ? ctx.place(spec.place, a) : null;
  if (!p && spec.place !== 'home.forecourt' && ctx.place) p = ctx.place('home.forecourt', a);
  if (!p) {
    const home = ctx.homeOf?.(a.agentId ?? a.id);
    const d = home?.door;
    if (d) p = { tx: d.tx, ty: d.ty, slotKind: 'stand' };
    else if (home) p = { tx: home.tx, ty: home.ty, slotKind: 'stand' };
  }
  let indoors = indoorsOf(key, spec);
  // parity: vil.resting-indoors
  if (indoors && !p) {
    // classic placeAgents: an agent indoors goes into its own home or its nearest ancestor's (sub of a sub); when none of
    // them has a house (the resting-home cap left it without one) classic does not draw it at all: it stays indoors,
    // nowhere, where it is (hidden), instead of standing about outdoors
    const h = ctx.houseOf?.(a.agentId ?? a.id);
    if (h) p = { tx: h.door?.tx ?? h.tx, ty: h.door?.ty ?? h.ty, slotKind: 'stand', objId: h.id };
    else return { x: a.x, y: a.y, tx: Math.floor(a.x), ty: Math.floor(a.y), slotId: null, indoors: true, face: a.face ?? 0, homeId: null, nowhere: true };
  }
  if (!p) {
    // no place and no home (an awake agent whose chain has no house): a legal stand spot near its village
    // centre, outdoors (agents stay visible), never the raw centre tile, which may be built over
    const v = (ctx.world?.villages || []).find(w => w.name === a.project);
    const c = v && Number.isFinite(v.cx) ? { x: v.cx, y: v.cy } : v?.origin ? { x: v.origin.x, y: v.origin.y } : { x: a.x, y: a.y };
    const q = nearestLegal(ctx.world?.grid, c.x, c.y);
    if (!q) return null;
    p = { tx: Math.floor(q.x), ty: Math.floor(q.y), slotKind: 'stand' };
    indoors = false;
  }
  let slot = null;
  if (indoors) ctx.slots?.release?.(a.id);
  else if (p.slotId != null) slot = { id: p.slotId, tx: p.tx, ty: p.ty, sub: p.sub ?? -1 };
  else if (ctx.slots && p.slotKind !== null) {     // the place resolver reserved nothing: take the nearest free slot
    const kinds = [p.slotKind || 'stand'];
    if (kinds[0] !== 'stand') kinds.push('stand');
    for (const kind of kinds) {
      for (let tries = 0; tries < 4 && !slot; tries++) {
        const s = ctx.slots.nearestFree(p.tx, p.ty, kind);
        if (!s || Math.hypot(s.tx - p.tx, s.ty - p.ty) > SPILL_NEAR) break;
        slot = ctx.slots.claim(s.id ?? s, a.id);
      }
      if (slot) break;
    }
    if (!slot && typeof ctx.slots.claimSpill === 'function') {
      if (keepSpill) slot = ctx.slots.claim(keepSpill, a.id);
      if (!slot) slot = ctx.slots.claimSpill(p.tx, p.ty, a.id);
    }
  }
  const tx = slot ? slot.tx : p.tx, ty = slot ? slot.ty : p.ty;
  const f = slot ? feetOf(tx, ty, slot.sub) : (Number.isFinite(p.x) ? { x: p.x, y: p.y } : feetOf(tx, ty));
  if (slot) a.slot = { tx: slot.tx, ty: slot.ty, sub: slot.sub };
  const face = isPinned(key) ? 0 : (slot?.face ?? p.face ?? 0);
  // the house it goes into: the place's object (a homeless sub uses its parent's house), else its own home
  const homeId = indoors ? (p.objId ?? ctx.homeOf?.(a.agentId ?? a.id)?.id ?? null) : null;
  return { x: f.x, y: f.y, tx, ty, slotId: slot?.id ?? null, indoors, face, homeId };
}

const tileLegal = (grid, x, y) => isLegalTile(grid, Math.floor(x), Math.floor(y));
/** Is the agent's current target still there and legal (after a rebuild)? Slot still held, home still standing,
 *  target tile walkable. A target-less agent is fine where it stands if its tile is legal. */
export function targetOk(a, ctx) {
  const t = a._target;
  if (!t) return a.state === 'indoors' || tileLegal(ctx.world?.grid, a.x, a.y);
  if (t.indoors) {
    // indoors nowhere (no house of its own or an ancestor's): still right while none has one
    if (t.nowhere) return !ctx.houseOf?.(a.agentId ?? a.id);
    if (t.homeId != null && typeof ctx.world?.objects?.get === 'function') return !!ctx.world.objects.get(t.homeId);
    return !!ctx.homeOf?.(a.agentId ?? a.id);
  }
  if (t.slotId != null && typeof ctx.slots?.heldBy === 'function') {
    const s = ctx.slots.heldBy(a.id);
    if (!s || s.id !== t.slotId) return false;
  }
  return tileLegal(ctx.world?.grid, t.x, t.y);
}

function settle(a) {
  const t = a._target;
  if (t) a.face = t.face;
  if (t?.indoors) {
    a.flags = (a.flags | INDOORS) & ~VISIBLE;
    a.alpha = 0;
    a.state = 'indoors';
  } else {
    a.flags = (a.flags & ~INDOORS) | VISIBLE;
    a.alpha = 1;
    a.state = 'hold';
  }
}

/** Ask the sim to move to a freshly resolved target (instant: placement jump, no walk, no fade). */
function transition(a, ctx, instant) {
  const t = a._target;
  if (!t) { a.state = 'hold'; return; }
  let from = { x: a.x, y: a.y };
  if ((a.flags & INDOORS) !== 0) {                 // leaving the house: appear at the door (the reverse of entering)
    const home = ctx.homeOf?.(a.agentId ?? a.id) ?? ctx.houseOf?.(a.agentId ?? a.id);   // a sub leaves its parent's house
    if (home?.door) { from = feetOf(home.door.tx, home.door.ty); a.warp = from; }
    // indoors nowhere (no house in its chain, never drawn) has no door to leave by: it appears at its new spot, never
    // where it was hidden (that tile may be built over since)
    else { from = { x: t.x, y: t.y }; a.warp = from; }
    a.flags = (a.flags & ~INDOORS) | VISIBLE;
    a.alpha = 1;
  }
  a.path = undefined;
  if (instant || ctx.reduceMotion || Math.hypot(t.x - from.x, t.y - from.y) < 0.05) {
    a.warp = { x: t.x, y: t.y };
    settle(a);
    if (t.indoors && !instant) beginEnter(a);
    return;
  }
  const spec = a._spec;
  const walk = spec.walk !== false && !isPinned(a._bkey);
  const p = walk && ctx.nav?.path ? ctx.nav.path(from, { x: t.x, y: t.y }, { actor: a.id }) : null;
  const pts = p && p.length >= 2 ? Array.from(p) : [];
  pts.push(t.x, t.y);                                       // finish on the exact sub-slot
  a.path = Float32Array.from(pts);
  a.move = walk ? 'walk' : 'fade';
  a.speed = typeof spec.walk === 'number' ? spec.walk : WALK_SPEED;
  a.arrived = false;
  a.state = 'go';
}

function beginEnter(a) {
  a.state = 'enter'; a._fadeT = 0; a.alpha = 1; a.flags = (a.flags & ~INDOORS) | VISIBLE;
}

// ---------------------------------------------------------------- pose, idle cues, effects

// What a (spec, behaviour key) shows while holding, worked out once per (spec, key, mod, idle list) instead of on every
// step for every agent (PERF M7 psim): ghost flag, base anim, continuous effects (a frozen list shared by every agent with
// that spec and key), timed cues and their interval. Specs are plain data and are not changed after represent().
const POSES = new WeakMap();
function poseOf(spec, key, ctx) {
  let m = POSES.get(spec);
  if (!m) { m = new Map(); POSES.set(spec, m); }
  let e = m.get(key);
  if (e && e.mod === ctx.mod && e.idle === spec.idle && e.pose === spec.pose && e.idleEvery === spec.idleEvery) return e;
  const idle = Array.isArray(spec.idle) ? spec.idle : [];
  const ghost = ghostOf(key, spec);
  const fx = idle.filter(t => isContinuous(ctx, t));
  if (key === 'stalled:error' && !fx.includes('smoke')) fx.push('smoke');
  if (key === 'working' && !fx.includes('sparks')) fx.push('sparks');
  const cues = idle.filter(t => !isContinuous(ctx, t));
  e = { mod: ctx.mod, idle: spec.idle, pose: spec.pose, idleEvery: spec.idleEvery, ghost, base: ghost ? 'idle' : animOf(spec.pose, ctx.mod),
    fx: fx.length ? Object.freeze(fx) : null, cues, every: cues.length ? spec.idleEvery || cueOf(ctx, cues[0])?.every || DEFAULT_EVERY : null };
  m.set(key, e);
  return e;
}

/** poseOf through a per-actor cache (PERF M7 asim): the same entry while the actor's spec, key and mod are the same. */
function poseFor(a, ctx) {
  const spec = a._spec, key = a._bkey, P = a._P;
  if (P !== undefined && a._Pspec === spec && a._Pkey === key && P.mod === ctx.mod && P.idle === spec.idle && P.pose === spec.pose
    && P.idleEvery === spec.idleEvery) return P;
  a._Pspec = spec; a._Pkey = key;
  return (a._P = poseOf(spec, key, ctx));
}

function applyPose(a, dt, ctx) {
  const spec = a._spec;
  const key = a._bkey;
  const P = poseFor(a, ctx);
  const ghost = P.ghost;
  a.flags = ghost ? a.flags | GHOST : a.flags & ~GHOST;
  if (a.state === 'go') { a.cue = null; a.fx = null; return; }   // the sim shows walk (or a fade)
  if (a.state !== 'hold') { a.cue = null; return; }
  const base = P.base;
  a.pose = ghost ? 'doorstep' : spec.pose;
  a.fx = P.fx;
  if (isPinned(key) && a.face !== 0) a.face = 0;     // stalled faces the viewer
  const cues = P.cues;
  if (ctx.reduceMotion || !cues.length) { a.cue = null; a.anim = base; if (ctx.reduceMotion) a.frame = 0; return; }
  const every = P.every;
  if (a._cueT > 0) {
    a._cueT -= dt;
    if (a._cueT <= 0) {                          // cue ends: back to the base pose
      if (a.cue === 'look-around') a.face = a._face0 ?? a.face;
      a.cue = null; a._cueT = 0;
      a._nextCue = between(ctx, every, a.id, 'cue', a._cueN);
    }
  } else {
    a._nextCue -= dt;
    if (a._nextCue <= 0) {
      const tag = cues[a._cueN % cues.length];
      a._cueN++;
      a.cue = tag; a._cueT = cueOf(ctx, tag)?.len ?? DEFAULT_LEN;
      if (tag === 'look-around') {               // turn the head away and back; never moves
        a._face0 = a.face;
        a.face = (a.face + (rnd(ctx, a.id, 'look', a._cueN) < 0.5 ? 1 : 3)) % 4;
      }
    }
  }
  const cueAnim = a.cue ? animOf(a.cue, ctx.mod) : 'idle';
  a.anim = cueAnim !== 'idle' ? cueAnim : base;     // overlay cues (look-around, smoke-puff) keep the base pose
}

function resetCues(a, ctx) {
  const spec = a._spec;
  const cues = (spec.idle || []).filter(t => !isContinuous(ctx, t));
  a.cue = null; a._cueT = 0; a._cueN = 0;
  a._nextCue = cues.length ? between(ctx, spec.idleEvery || cueOf(ctx, cues[0])?.every || DEFAULT_EVERY, a.id, 'cue', 0) : Infinity;
}

// ---------------------------------------------------------------- the module

function placeSig(a, key, spec, ctx) {
  const pr = a.pr ?? a.prs?.[0] ?? a.status?.pr ?? '';
  // no world.version here: it is a stamping-op counter (core/grid.js), not content; rebuilds go through targetOk
  return `${key}|${spec.place}|${ghostOf(key, spec) ? 'out' : ''}|${pr}`;
}

/** Re-target if the place signature changed (or `force`). `lost`: the old target is gone, so even a settled
 *  stalled agent must move (by a fade). */
function retarget(a, ctx, force, lost = false) {
  // the place signature reads only a.spec, a.status and a.pr / a.prs (behaviourKey, specFor, placeSig): while those are
  // the same objects as at the last check, the signature is too (PERF M7 psim: no per-step string for every agent)
  if (!force && a._sigOf && a._sigOf[0] === a.spec && a._sigOf[1] === a.status && a._sigOf[2] === a.pr && a._sigOf[3] === a.prs
    && a._sigOf[4] === a._sig && a._sigOf[5] === a._spec) return;
  const { key, spec } = specFor(a);
  const sig = placeSig(a, key, spec, ctx);
  if (!force && sig === a._sig) { a._spec = spec; a._sigOf = [a.spec, a.status, a.pr, a.prs, a._sig, a._spec]; return; }
  const prevKey = a._bkey;
  a._bkey = key; a._spec = spec; a._sig = sig;
  // A settled stalled/error agent stays put when only its stalled flavour changes (attention <-> prompt <-> error):
  // same place, new pose. Anything else re-targets.
  const samePinnedPlace = !lost && isPinned(prevKey) && isPinned(key) && a.state === 'hold' && a._target;
  if (!samePinnedPlace) {
    a._target = resolveTarget(a, key, spec, ctx);
    transition(a, ctx, false);
  }
  resetCues(a, ctx);
}

export function init(a, ctx) {
  const { key, spec } = specFor(a);
  a._bkey = key; a._spec = spec;
  a._sig = placeSig(a, key, spec, ctx);
  a.alpha = 1; a._fadeT = 0;
  a.flags = (a.flags ?? VISIBLE) | VISIBLE;
  a._target = resolveTarget(a, key, spec, ctx);
  transition(a, ctx, true);                     // first appearance: placed, no walk
  resetCues(a, ctx);
  applyPose(a, 0, ctx);
}

/** Status/place/world changed (world-sim intent system): re-target without teleporting. A still-valid target with an
 *  unchanged place signature is kept (no slot churn, no movement). */
export function replan(a, ctx) {
  if (a._spec == null) return init(a, ctx);
  if (!targetOk(a, ctx)) return retarget(a, ctx, true, true);
  retarget(a, ctx, false);
}

export function update(a, dt, ctx) {
  retarget(a, ctx, false);
  switch (a.state) {
    case 'go':
      if (a.arrived && !a.path && !a.fade) { settle(a); if (a._target?.indoors) beginEnter(a); }
      break;
    case 'enter': {
      a._fadeT += dt;
      a.anim = 'enter';
      a.alpha = Math.max(0, 1 - a._fadeT / ENTER_S);
      if (a._fadeT >= ENTER_S - 1e-9 || ctx.reduceMotion) { a.flags = (a.flags | INDOORS) & ~VISIBLE; a.alpha = 0; a.state = 'indoors'; }
      break;
    }
    default: break;                             // 'hold' / 'indoors': pinned agents never move here
  }
  if (a.state !== 'enter') applyPose(a, dt, ctx);
  if (a.state === 'indoors') { a.anim = 'idle'; a.pose = 'indoors'; a.cue = null; a.fx = null; }
}

/**
 * Exact stand-in for update(a, dt, ctx) on an agent at rest (PERF M7 asim). The world-sim calls it, instead of update and
 * the movement / slots / animation systems, for an agent whose last step left it still (no path, fade, warp or move
 * request, not leaving) and that nothing has touched since (a snapshot or a re-plan wakes it). Returns true when it
 * advanced the agent exactly as update() would have: holding or indoors with the same place signature, the pose already
 * applied, and only an idle-cue timer counting down without reaching zero. Returns false, having changed nothing, for
 * anything else (a cue starting or ending, a changed status or spec, a face to reset), and the sim runs update().
 * @returns {boolean}
 */
export function idle(a, dt, ctx) {
  const s = a._sigOf;     // retarget's fast check: the place signature inputs are the same objects
  if (s === undefined || s[0] !== a.spec || s[1] !== a.status || s[2] !== a.pr || s[3] !== a.prs || s[4] !== a._sig
    || s[5] !== a._spec) return false;
  const st = a.state;
  if (st !== 'hold' && st !== 'indoors') return false;
  const P = a._P, spec = a._spec;
  if (P === undefined || a._Pspec !== spec || a._Pkey !== a._bkey || P.mod !== ctx.mod || P.idle !== spec.idle
    || P.pose !== spec.pose || P.idleEvery !== spec.idleEvery) return false;
  if (((a.flags & GHOST) !== 0) !== P.ghost) return false;
  if (st === 'indoors') return a.cue === null && a.fx === null && a.pose === 'indoors' && a.anim === 'idle';
  // holding: applyPose would write these same values again
  if (a.fx !== P.fx || a.pose !== (P.ghost ? 'doorstep' : spec.pose) || (isPinned(a._bkey) && a.face !== 0)) return false;
  if (ctx.reduceMotion || !P.cues.length) return a.cue === null;
  if (a._cueT > 0) {
    const t = a._cueT - dt;
    if (t <= 0) return false;                  // the cue ends this step
    a._cueT = t;
    return true;
  }
  const t = a._nextCue - dt;
  if (t <= 0) return false;                    // a cue starts this step
  a._nextCue = t;
  return true;
}

export default { init, replan, update, idle };
