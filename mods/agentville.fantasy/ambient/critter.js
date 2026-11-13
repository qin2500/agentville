// Critters (design 4.4): chickens, a cat, pigeons and gulls. Behaviour module { init(a, ctx), update(a, dt, ctx) }.
// Short local wanders only (nav path <= MAX_PATH tiles), never into buildings (occ/cover/cost checked on every tile).
// The cat may sit beside a waiting agent (ctx.actors: Map id -> Actor); pigeons hop away from walkers within 1 tile.
// OWNER: B6. Pure, no DOM. ctx.rand is called as rand(...keys) (stateless) or rand() (stream); both work.
// Movement follows the engine rule (web/src/engine/sim/actor.js): set a.path, read a.arrived / a.stuck; the sim moves.
// Facing uses ctx.faceFrom (sim/actor.js) so every actor kind shares one facing convention.
export const MAX_PATH = 8;
const SPECIES = {
  chicken: { speed: 0.9, roam: 4, idle: [2, 6], walkP: 0.7, hops: false },
  cat: { speed: 1.4, roam: 6, idle: [4, 12], walkP: 0.5, hops: false },
  pigeon: { speed: 2.2, roam: 3, idle: [2, 7], walkP: 0.6, hops: true },
  gull: { speed: 1.6, roam: 4, idle: [4, 10], walkP: 0.4, hops: false },
};
const POSES = { chicken: ['idle', 'idle', 'sit'], cat: ['idle', 'sit', 'sleep'], pigeon: ['idle'], gull: ['idle'] };
const WAIT_SEE = 7, SIT_MIN = 15, SIT_MAX = 40;

/** a critter may stand here: inside the grid, free of objects, walkable, not hidden behind a building. */
export function critterOk(grid, tx, ty) {
  return !!grid && grid.inBounds(tx, ty) && grid.get('occ', tx, ty) === 0 && grid.get('cost', tx, ty) < 255 && grid.get('cover', tx, ty) === 0;
}

const draw = (ctx, a) => ctx.rand(a.id, a.n = (a.n | 0) + 1);
const between = (r, [lo, hi]) => lo + r * (hi - lo);

/** Chickens in village blocks (yards), one cat and pigeons on the square, gulls on the dock. Deterministic in rand.
 *  @returns {object[]} actor specs { id, kind:'critter', species, x, y, home:{x,y}, state:'idle', anim:'idle' } */
export function spawnCritters(world, rand) {
  const grid = world?.grid, out = [];
  if (!grid) return out;
  const R = (...k) => (rand ? rand(...k) : 0.5);
  const spots = (rect, n, key, ok = critterOk) => {
    const res = [];
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return res;
    for (let i = 0; i < n * 12 && res.length < n; i++) {
      const tx = Math.floor(rect.x + R(key, 'x', i) * rect.w), ty = Math.floor(rect.y + R(key, 'y', i) * rect.h);
      if (ok(grid, tx, ty)) res.push({ x: tx + 0.5, y: ty + 0.5 });
    }
    return res;
  };
  const add = (species, id, p) => out.push({ id, kind: 'critter', species, x: p.x, y: p.y, px: p.x, py: p.y, face: 0, anim: 'idle', state: 'idle', home: { x: p.x, y: p.y } });
  const sq = world.square;
  spots(sq, 1, 'cat').forEach(p => add('cat', 'critter:cat', p));
  spots(sq, 4, 'pigeon').forEach((p, i) => add('pigeon', `critter:pigeon:${i}`, p));
  (world.villages || []).forEach((v, vi) => {
    const b = Array.isArray(v.block) ? { x: v.block[0], y: v.block[1], w: v.block[2], h: v.block[3] } : v.block;
    spots(b, 3, `chicken${vi}`).forEach((p, i) => add('chicken', `critter:chicken:${vi}:${i}`, p));
  });
  const d = world.layoutData?.dock;   // this mod's own layout data (layout/dock.js)
  const drect = d && d.rect ? d.rect : d && d.w > 0 ? d : null;
  spots(drect, 2, 'gull').forEach((p, i) => add('gull', `critter:gull:${i}`, p));
  return out;
}

function pathOk(grid, path) {
  const n = path.length >> 1;
  if (n < 2 || n - 1 > MAX_PATH) return false;
  for (let i = 0; i < n; i++) if (!critterOk(grid, Math.floor(path[2 * i]), Math.floor(path[2 * i + 1]))) return false;
  return true;
}

function goTo(a, ctx, tx, ty) {
  const grid = ctx.world?.grid;
  if (!critterOk(grid, tx, ty) || !ctx.nav) return false;
  const path = ctx.nav.path({ x: a.x, y: a.y }, { x: tx + 0.5, y: ty + 0.5 }, { maxNodes: 200 });
  if (!path || !pathOk(grid, path)) return false;
  a.path = path; a.arrived = false; a.state = 'walk'; a.anim = 'walk';
  return true;
}

function startIdle(a, ctx) {
  const sp = SPECIES[a.species] || SPECIES.chicken;
  a.path = undefined; a.state = 'idle'; a.timer = between(draw(ctx, a), sp.idle);
  const poses = POSES[a.species] || POSES.chicken;
  a.anim = poses[Math.floor(draw(ctx, a) * poses.length) % poses.length];
}

function wanderTarget(a, ctx) {
  const sp = SPECIES[a.species] || SPECIES.chicken, h = a.home || { x: a.x, y: a.y };
  for (let i = 0; i < 6; i++) {
    const dx = Math.round((draw(ctx, a) * 2 - 1) * sp.roam), dy = Math.round((draw(ctx, a) * 2 - 1) * sp.roam);
    if (Math.abs(dx) + Math.abs(dy) < 1) continue;
    const tx = Math.floor(h.x) + dx, ty = Math.floor(h.y) + dy;
    if (Math.abs(tx + 0.5 - a.x) + Math.abs(ty + 0.5 - a.y) > MAX_PATH) continue;
    if (goTo(a, ctx, tx, ty)) return true;
  }
  return false;
}

function waitingAgent(a, ctx) {
  if (!ctx.actors) return null;
  let best = null, bd = Infinity;
  for (const o of ctx.actors.values()) {
    if (o.kind !== 'agent' || o.status?.bucket !== 'waiting') continue;
    const d = Math.abs(o.x - a.x) + Math.abs(o.y - a.y);
    if (d < bd && d <= WAIT_SEE) { best = o; bd = d; }
  }
  return best;
}

function nearWalker(a, ctx) {
  if (!ctx.actors) return null;
  for (const o of ctx.actors.values()) {
    if (o === a || o.kind === 'critter') continue;
    if (Math.hypot(o.x - a.x, o.y - a.y) < 1) return o;
  }
  return null;
}

export function init(a, ctx) {
  if (a.species === undefined) a.species = 'chicken';
  a.kind = 'critter';
  if (!a.home) a.home = { x: a.x, y: a.y };
  startIdle(a, ctx);
}

export function update(a, dt, ctx) {
  const sp = SPECIES[a.species] || SPECIES.chicken;
  if (a.state === 'sitBy') {
    a.timer -= dt;
    const w = ctx.actors?.get?.(a.sitWith);
    if (!w || w.status?.bucket !== 'waiting' || a.timer <= 0) { a.sitWith = undefined; startIdle(a, ctx); }
    return;
  }
  if (sp.hops && a.state !== 'walk') {
    const w = nearWalker(a, ctx);
    if (w) {
      const sx = Math.sign(a.x - w.x) || 1, sy = Math.sign(a.y - w.y) || 1;
      for (const [dx, dy] of [[sx * 3, 0], [0, sy * 3], [sx * 2, sy * 2], [-sx * 3, 0], [0, -sy * 3]])
        if (goTo(a, ctx, Math.floor(a.x) + dx, Math.floor(a.y) + dy)) { a.hopping = true; return; }
    }
  }
  if (a.state === 'walk') {
    if (a.path) return;                          // the sim is moving us
    if (a.arrived && a.sitTarget) {
      const w = ctx.actors?.get?.(a.sitWith);
      if (w && ctx.faceFrom) a.face = ctx.faceFrom(w.x - a.x, w.y - a.y);   // look at the agent
      a.state = 'sitBy'; a.anim = 'sit'; a.timer = between(draw(ctx, a), [SIT_MIN, SIT_MAX]); a.sitTarget = false;
      return;
    }
    a.sitTarget = false; a.hopping = false; startIdle(a, ctx);   // arrived, or the sim refused the path (a.stuck)
    return;
  }
  a.timer = (a.timer ?? 0) - dt;
  if (a.timer > 0) return;
  if (a.species === 'cat') {
    const w = waitingAgent(a, ctx);
    if (w && draw(ctx, a) < 0.6) {
      const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = opts[Math.floor(draw(ctx, a) * 4) % 4];
        if (goTo(a, ctx, Math.floor(w.x) + dx, Math.floor(w.y) + dy)) { a.sitTarget = true; a.sitWith = w.id; return; }
      }
    }
  }
  if (draw(ctx, a) < sp.walkP && wanderTarget(a, ctx)) return;
  startIdle(a, ctx);
}

export default { init, update };
