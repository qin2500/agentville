// Engine v2 sim/behaviours/agent.js (S3): agent actors, design §4.2 and decision D4.
// Behaviour module shape: { init(a, ctx), replan(a, ctx), update(a, dt, ctx) } with the world-sim ctx
// ({ world, nav, slots, rand(...keys), now, emit, place(place, a), homeOf(agentId) -> WorldObject|null, reduceMotion, ... }).
// WHERE an agent should be comes from ctx.place(spec.place, a) (sim/represent.js resolvePlace, which also reserves the
// slot). This module decides the target point, asks the sim to move there (a.path + a.move, see sim/actor.js), and
// picks the pose, idle cues and effects. It never changes x/y itself: the world-sim movement system does, applying D4
// (walk only <= 40 tiles, on screen, motion allowed; walks > 6 s cut by a fade; stalled/error never walk).
// Stalled and error agents always fade (spec.walk is false for them), and once settled they never move or re-plan.
// Deterministic: all timers advance by dt; randomness only via ctx.rand.
import { ENGINE_BEHAVIOUR, animOf } from '../represent.js';
import { FLAGS } from '../actor.js';

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
  const indoors = indoorsOf(key, spec);
  if (!p) return null;
  let slot = null;
  if (indoors) ctx.slots?.release?.(a.id);
  else if (p.slotId != null) slot = { id: p.slotId, tx: p.tx, ty: p.ty, sub: p.sub ?? -1 };
  else if (ctx.slots && p.slotKind !== null) {     // the place resolver reserved nothing: take the nearest free slot
    const kinds = [p.slotKind || 'stand'];
    if (kinds[0] !== 'stand') kinds.push('stand');
    for (const kind of kinds) {
      for (let tries = 0; tries < 4 && !slot; tries++) {
        const s = ctx.slots.nearestFree(p.tx, p.ty, kind);
        if (!s) break;
        slot = ctx.slots.claim(s.id ?? s, a.id);
      }
      if (slot) break;
    }
  }
  const tx = slot ? slot.tx : p.tx, ty = slot ? slot.ty : p.ty;
  const f = slot ? feetOf(tx, ty, slot.sub) : (Number.isFinite(p.x) ? { x: p.x, y: p.y } : feetOf(tx, ty));
  if (slot) a.slot = { tx: slot.tx, ty: slot.ty, sub: slot.sub };
  const face = isPinned(key) ? 0 : (slot?.face ?? p.face ?? 0);
  return { x: f.x, y: f.y, tx, ty, slotId: slot?.id ?? null, indoors, face };
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
    const home = ctx.homeOf?.(a.agentId ?? a.id);
    if (home?.door) { from = feetOf(home.door.tx, home.door.ty); a.warp = from; }
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

function applyPose(a, dt, ctx) {
  const spec = a._spec;
  const key = a._bkey;
  const idle = Array.isArray(spec.idle) ? spec.idle : [];
  const ghost = ghostOf(key, spec);
  a.flags = ghost ? a.flags | GHOST : a.flags & ~GHOST;
  if (a.state === 'go') { a.cue = null; a.fx = null; return; }   // the sim shows walk (or a fade)
  if (a.state !== 'hold') { a.cue = null; return; }
  const base = ghost ? 'idle' : animOf(spec.pose, ctx.mod);
  a.pose = ghost ? 'doorstep' : spec.pose;
  const fx = idle.filter(t => isContinuous(ctx, t));
  if (key === 'stalled:error' && !fx.includes('smoke')) fx.push('smoke');
  if (key === 'working' && !fx.includes('sparks')) fx.push('sparks');
  a.fx = fx.length ? fx : null;
  if (isPinned(key) && a.face !== 0) a.face = 0;     // stalled faces the viewer
  const cues = idle.filter(t => !isContinuous(ctx, t));
  if (ctx.reduceMotion || !cues.length) { a.cue = null; a.anim = base; if (ctx.reduceMotion) a.frame = 0; return; }
  const every = spec.idleEvery || cueOf(ctx, cues[0])?.every || DEFAULT_EVERY;
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
  return `${key}|${spec.place}|${ghostOf(key, spec) ? 'out' : ''}|${pr}|${ctx.world?.version ?? ''}`;
}

/** Re-target if the place signature changed (or `force`). */
function retarget(a, ctx, force) {
  const { key, spec } = specFor(a);
  const sig = placeSig(a, key, spec, ctx);
  if (!force && sig === a._sig) { a._spec = spec; return; }
  const prevKey = a._bkey;
  a._bkey = key; a._spec = spec; a._sig = sig;
  // A settled stalled/error agent stays put when only its stalled flavour changes (attention <-> prompt <-> error):
  // same place, new pose. Anything else re-targets.
  const samePinnedPlace = isPinned(prevKey) && isPinned(key) && a.state === 'hold' && a._target;
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

/** Status/place changed (world-sim intent system): re-target without teleporting. */
export function replan(a, ctx) {
  if (a._spec == null) return init(a, ctx);
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

export default { init, replan, update };
