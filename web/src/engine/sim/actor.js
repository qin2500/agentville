// Engine v2 sim/actor.js (S2): the Actor record (design 4.1), its flags and path stepping. Pure, no allocation per step.

export const FLAGS = { VISIBLE: 1, SELECTED: 2, OCCLUDED: 4, INDOORS: 8, GHOST: 16 };
/** The only values `a.anim` may hold when the renderer sees it (design 4.1). Mod pose names map onto these via
 *  mod.represent.poses (sim/represent.js animOf). */
export const ANIMS = Object.freeze(['idle', 'walk', 'hammer', 'sit', 'carry', 'wave', 'cheer', 'sleep', 'enter']);

// Movement contract (one rule for every actor kind):
//   behaviours REQUEST movement by assigning a new `a.path` (Float32Array of x,y pairs, usually tile centres) and,
//   optionally, `a.move = 'walk' | 'fade' | 'snap'` and `a.speed` (tiles/s); a placement jump is `a.warp = { x, y }`.
//   ONLY the sim (world-sim movement system) changes x/y. It sets `a.arrived = false` when it accepts a path and
//   `a.arrived = true` when the actor stands at its end; `a.stuck = true` when it refused an illegal path.

/** Iso facing from a tile-space movement: 0 SE (toward viewer), 1 SW, 2 NW, 3 NE. Zero movement gives 0. */
export function faceFrom(dx, dy) {
  const sx = dx - dy, sy = dx + dy; // screen-space direction
  if (sy >= 0) return sx >= 0 ? 0 : 1;
  return sx < 0 ? 2 : 3;
}

/** Build an Actor from a partial spec. Unknown spec fields are kept. */
export function makeActor(spec = {}) {
  const x = spec.x ?? 0, y = spec.y ?? 0;
  const a = {
    kind: 'ambient', anim: 'idle', face: 0, frame: 0, state: 'idle', look: null,
    ...spec,
    id: spec.id,
    x, y, px: spec.px ?? x, py: spec.py ?? y,
    flags: spec.flags ?? FLAGS.VISIBLE,
  };
  if (a.path && a.pathI === undefined) a.pathI = 0;
  return a;
}

/**
 * Advance along a.path (x,y pairs, tile centres) from waypoint index a.pathI at `speed` tiles/s.
 * Sets px,py to the position before the step, updates x,y, face and anim ('walk' while moving).
 * Returns true when the end of the path is reached (pathI === waypoint count); false otherwise.
 */
export function stepAlongPath(a, dt, speed) {
  a.px = a.x; a.py = a.y;
  const p = a.path;
  if (!p) return false;
  const n = p.length >> 1;
  let i = a.pathI ?? 0;
  if (i >= n) { a.pathI = n; return true; }
  let left = speed * dt, moved = false;
  while (i < n) {
    const tx = p[i * 2], ty = p[i * 2 + 1];
    const dx = tx - a.x, dy = ty - a.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-9) { a.face = faceFrom(dx, dy); moved = true; }
    if (d <= left) { a.x = tx; a.y = ty; left -= d; i++; }
    else { a.x += dx / d * left; a.y += dy / d * left; left = 0; break; }
  }
  a.pathI = i;
  if (moved) a.anim = 'walk';
  return i >= n;
}

/** stepAlongPath plus the arrival bookkeeping of the movement contract: on reaching the end the path is cleared and
 *  `a.arrived` set. Returns true on arrival. */
export function moveActor(a, dt, speed) {
  const done = stepAlongPath(a, dt, speed);
  if (done) { a.path = undefined; a.pathI = 0; a.arrived = true; }
  return done;
}
