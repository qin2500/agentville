// Townsfolk routines (design §4.3): behaviour module { init(a, ctx), update(a, dt, ctx) } + spawnTownsfolk(world, rand).
// Day schedule: home -> shop (a door) -> bench (sit) -> square (chat) -> home, dwell 20-90 s; some trips go to another
// settlement. At night most stay indoors, ~20% walk with lanterns. Vendors stand at `vend` anchors by day.
// Pure: no DOM, no module state, every random draw is the stateless ctx.rand(...keys). Exported data holds no functions.
// Movement follows the engine rule (web/src/engine/sim/actor.js): this module only sets a.path / a.warp and reads
// a.arrived / a.stuck; the world-sim moves the actor and refuses paths over blocked tiles.
import { tileIndex, onTile } from './near.js';
// parity: amb.townsfolk-walkers-by-tier, amb.night-lanterns-20pct, amb.vendors-at-stalls
export const COUNT_BY_TIER = [2, 5, 10, 18];
export const DWELL = { min: 20, max: 90 };
export const DAY_LEN_S = 480;                       // one game day in seconds of ctx.now (ms) when ctx.dayPhase is absent
export const NIGHT_WALKER_SHARE = 0.2;
export const VENDOR_SHARE = 0.15;                   // of townsfolk (at least 1 in tier >= 1) who are vendors
export const SPEED = [1.1, 1.7];                    // tiles per second
const FLAG = { VISIBLE: 1, INDOORS: 8 };            // fallback; ctx.FLAGS wins when supplied
const LANTERN_FX = Object.freeze(['lantern']);
const ROUTINE = ['shop', 'sit', 'square', 'home'];

/** Stable, well-mixed [0,1) from a string (FNV-1a + murmur finaliser): same id, same value, in every build and seed. */
export function idUnit(id) {
  let h = 2166136261;
  for (const c of String(id)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Does this townsperson carry a night lantern? ~20% by a stable hash of the id (never of seed or rebuild order). */
export const carriesLantern = id => idUnit(`${id}|lantern`) < NIGHT_WALKER_SHARE;

const flags = ctx => ctx?.FLAGS || FLAG;
const lerp = (a, b, t) => a + (b - a) * t;
const keyHome = o => o.kind === 'building' && o.door;
// Every key home of a world, in object order, plus the same per project: made once per object store, not per call
// (a 1,000-agent world has ~58k objects and ~100 settlements). A World does not change after it is built.
const HOMES = new WeakMap();
function keyHomes(world) {
  const objs = world.objects;
  let e = HOMES.get(objs);
  if (!e || e.size !== objs.size) {
    const all = [], byProject = new Map();
    for (const o of objs.values()) {
      if (!keyHome(o)) continue;
      all.push(o);
      let l = byProject.get(o.project);
      if (!l) { l = []; byProject.set(o.project, l); }
      l.push(o);
    }
    e = { size: objs.size, all, byProject };
    HOMES.set(objs, e);
  }
  return e;
}

/** Is it night? ctx.night (bool) > ctx.dayPhase (0..1) > ctx.now (ms). Night = phase in [0.75, 1) U [0, 0.1). */
export function isNight(ctx) {
  if (typeof ctx?.night === 'boolean') return ctx.night;
  const ph = typeof ctx?.dayPhase === 'number' ? ctx.dayPhase : ((ctx?.now ?? 0) / 1000 % DAY_LEN_S) / DAY_LEN_S;
  return ph >= 0.75 || ph < 0.1;
}

/** One spec per townsperson, count by settlement tier. rand(...keys) is stateless in [0,1). */
export function spawnTownsfolk(world, rand) {
  const out = [];
  for (const v of world?.villages || []) {
    const tier = Math.max(0, Math.min(3, v.tier ?? v.plan?.tier ?? 0));
    const mine = keyHomes(world).byProject.get(v.name) ?? [];
    const homes = mine.filter(o => o.lot && o.data?.owner === 'house');
    const pool = (homes.length ? homes : [...mine])
      .sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));   // order of a rebuild must not move people between homes
    if (!pool.length) continue;
    const n = COUNT_BY_TIER[tier];
    const nVend = tier >= 1 ? Math.max(1, Math.round(n * VENDOR_SHARE)) : 0;
    for (let i = 0; i < n; i++) {
      const home = pool[Math.floor(rand('folk-home', v.name, i) * pool.length)];
      out.push({
        id: `folk:${v.name}:${i}`, kind: 'folk', project: v.name, home: home.id,
        x: home.door.tx + 0.5, y: home.door.ty + 0.5,
        role: i < nVend ? 'vendor' : 'walker',
        look: { seed: Math.floor(rand('folk-look', v.name, i) * 4096) },
        speed: lerp(SPEED[0], SPEED[1], rand('folk-speed', v.name, i)),
        lantern: carriesLantern(`folk:${v.name}:${i}`),
      });
    }
  }
  return out;
}

// ---- helpers --------------------------------------------------------------------------------------------------------
const walkable = (world, x, y) => {
  if (!world.grid) return true;
  const g = world.grid, tx = Math.floor(x), ty = Math.floor(y);
  return g.inBounds(tx, ty) && g.get('cost', tx, ty) < 255 && g.get('occ', tx, ty) === 0;
};
const draw = (a, ctx, tag) => ctx.rand(a.id, tag, a.sched.n++);
const dwellFor = (a, ctx) => lerp(DWELL.min, DWELL.max, draw(a, ctx, 'dwell'));
const homeObj = (a, ctx) => ctx.world.objects.get(a.home);

function doors(ctx, filter) { return keyHomes(ctx.world).all.filter(filter); }

const here = a => a.warp ?? { x: a.x, y: a.y };
/** Follow the shared flow field of `dest` (ctx.nav.flowTo) tile by tile; null when unavailable or it does not arrive. */
function flowPath(ctx, from, x, y, dest) {
  const f = dest && ctx.nav?.flowTo?.(dest);
  if (!f || typeof f.dirAt !== 'function') return null;
  const q = ctx.world?.square;
  const inDest = (tx, ty) => dest === 'square' && q ? tx >= q.x && ty >= q.y && tx < q.x + q.w && ty < q.y + q.h : false;
  let tx = Math.floor(from.x), ty = Math.floor(from.y);
  const pts = [from.x, from.y];
  for (let n = 0; n < 200; n++) {
    if (inDest(tx, ty) && walkable(ctx.world, x, y)) { pts.push(x, y); return pts; }
    const d = f.dirAt(tx, ty);
    if (!d) return null;
    if (!d.dx && !d.dy) { pts.push(x, y); return pts; }
    tx += d.dx; ty += d.dy;
    pts.push(tx + 0.5, ty + 0.5);
  }
  return null;
}

function goTo(a, ctx, x, y, dest) {
  const from = here(a);
  const path = flowPath(ctx, from, x, y, dest) || ctx.nav?.path?.(from, { x, y }, {});
  if (!path || path.length < 2) { a.path = undefined; return false; }
  const pts = Array.from(path);
  if (pts[pts.length - 2] !== x || pts[pts.length - 1] !== y) pts.push(x, y);   // end exactly on the stop
  a.path = Float32Array.from(pts); a.state = 'walk'; a.anim = 'walk'; a.arrived = false;
  return true;
}

/** Pick the next stop's target tile; claims a slot where one exists. Returns { x, y, slot? } or null. */
function resolveStop(a, ctx, kind) {
  const w = ctx.world;
  if (kind === 'home') { const h = homeObj(a, ctx); return h?.door ? { x: h.door.tx + 0.5, y: h.door.ty + 0.5, door: true } : null; }
  if (kind === 'sit') {
    const s = ctx.slots.nearestFree(a.x, a.y, 'sit');
    return s && ctx.slots.claim(s.id, a.id) ? { x: s.tx + 0.5, y: s.ty + 0.5, slot: s } : null;
  }
  if (kind === 'vend') {
    const s = ctx.slots.nearestFree(a.x, a.y, 'vend');
    return s && ctx.slots.claim(s.id, a.id) ? { x: s.tx + 0.5, y: s.ty + 0.5, slot: s } : null;
  }
  if (kind === 'shop' || kind === 'visit') {
    const list = doors(ctx, o => o.id !== a.home && (kind === 'visit' ? o.project !== a.project : o.project === a.project));
    if (!list.length) return null;
    const o = list[Math.floor(draw(a, ctx, 'door') * list.length)];
    const s = ctx.slots.nearestFree(o.door.tx + 0.5, o.door.ty + 0.5, 'stand');
    if (s && ctx.slots.claim(s.id, a.id)) return { x: s.tx + 0.5, y: s.ty + 0.5, slot: s };
    return null;
  }
  if (kind === 'square') {
    const q = w.square;
    if (!q) return null;
    for (let k = 0; k < 6; k++) {
      const x = q.x + 0.5 + Math.floor(draw(a, ctx, 'sqx') * q.w), y = q.y + 0.5 + Math.floor(draw(a, ctx, 'sqy') * q.h);
      if (walkable(w, x, y)) return { x, y, flow: 'square' };
    }
  }
  return null;
}

function leaveSlot(a, ctx) { if (a.slot) { ctx.slots.release(a.id); a.slot = undefined; } }

function enterHome(a, ctx) {
  leaveSlot(a, ctx);
  const F = flags(ctx);
  a.path = undefined; a.state = 'home'; a.anim = 'idle'; a.flags = (a.flags | F.INDOORS) & ~F.VISIBLE; a.dwell = dwellFor(a, ctx);
}
function leaveHome(a, ctx) {
  const F = flags(ctx), h = homeObj(a, ctx);
  if (h?.door) a.warp = { x: h.door.tx + 0.5, y: h.door.ty + 0.5 };   // the sim places it at the door
  a.flags = (a.flags & ~F.INDOORS) | F.VISIBLE;
}

function nextStop(a, ctx) {
  const night = isNight(ctx);
  // a vendor already at its stall keeps the stall (and its slot) all day
  if (a.role === 'vendor' && !night && a.stop === 'vend' && a.slot) { a.dwell = dwellFor(a, ctx); a.state = 'dwell'; a.anim = 'idle'; return; }
  leaveSlot(a, ctx);
  if (night && !a.lantern) return startStop(a, ctx, 'home');
  if (a.role === 'vendor' && !night) {
    if (a.stop === 'vend') { a.dwell = dwellFor(a, ctx); a.state = 'dwell'; a.anim = 'idle'; return; }
    return startStop(a, ctx, 'vend');
  }
  if (night) { a.lantern = true; return startStop(a, ctx, draw(a, ctx, 'night') < 0.6 ? 'square' : 'home'); }
  let i = (a.sched.i = (a.sched.i + 1) % ROUTINE.length);
  let kind = ROUTINE[i];
  if (kind === 'shop' && draw(a, ctx, 'visit') < 0.2) kind = 'visit';
  startStop(a, ctx, kind);
}

function startStop(a, ctx, kind) {
  const F = flags(ctx);
  if (a.flags & F.INDOORS) leaveHome(a, ctx);
  const t = resolveStop(a, ctx, kind);
  a.stop = kind;
  const p = here(a);
  if (kind === 'home' && (!t || (p.x === t.x && p.y === t.y))) return enterHome(a, ctx);
  if (!t || (p.x === t.x && p.y === t.y)) {
    // nothing to go to: dwell a short while where we are (never on a claimed door slot) and retry
    if (t?.slot) { a.slot = t.slot; }
    else leaveSlot(a, ctx);
    a.target = kind; a.dwell = t ? dwellFor(a, ctx) : 5; a.state = 'dwell'; a.anim = 'idle'; a.path = undefined;
    a.arrived = !!t; return;
  }
  a.slot = t.slot; a.target = kind; a.dest = t;
  if (!goTo(a, ctx, t.x, t.y, t.flow)) { leaveSlot(a, ctx); a.dwell = 5; a.state = 'dwell'; a.anim = 'idle'; a.arrived = false; }
}

function arrive(a, ctx) {
  const t = a.dest;
  a.dest = undefined; a.path = undefined; a.arrived = true;
  if (a.stop === 'home') return enterHome(a, ctx);
  a.state = 'dwell';
  a.anim = a.stop === 'sit' ? 'sit' : 'idle';
  // doors are never blocked for long: shop visits are short, the slot is released on leaving
  a.dwell = a.stop === 'shop' || a.stop === 'visit' ? lerp(3, 10, draw(a, ctx, 'shopdwell')) : dwellFor(a, ctx);
  if (t?.slot) a.slot = t.slot;
}

// ---- behaviour module -----------------------------------------------------------------------------------------------
export default { init, update };
export { init, update };

function init(a, ctx) {
  a.sched = { i: Math.floor(ctx.rand(a.id, 'sched0') * ROUTINE.length), n: 0 };
  a.lantern = a.lantern ?? carriesLantern(a.id);
  a.speed ??= lerp(SPEED[0], SPEED[1], ctx.rand(a.id, 'speed'));
  a.flags = (a.flags | 0) | flags(ctx).VISIBLE;
  a.face ??= 0; a.dwell = 0; a.slot = undefined;
  // spread the crowd: each starts at a random point of its first dwell, indoors if it is night
  if (isNight(ctx) && !a.lantern) enterHome(a, ctx);
  else { a.state = 'dwell'; a.anim = 'idle'; a.dwell = ctx.rand(a.id, 'phase') * DWELL.min; }
}

// ---- carts have the right of way: never step onto a cart's tile -----------------------------------------------------
const LOOK = 0.55;                                  // tiles ahead of the actor that must be free of carts
const YIELD_MAX = 2.5;                              // s before giving up and re-planning
function cartAhead(a, ctx) {
  const p = a.path; if (!p) return false;
  let i = a.pathI ?? 0;
  if (i * 2 >= p.length) return false;
  const dx = p[i * 2] - a.x, dy = p[i * 2 + 1] - a.y, d = Math.hypot(dx, dy);
  const sx = d < 1e-6 ? a.x : a.x + dx / d * Math.min(LOOK, d), sy = d < 1e-6 ? a.y : a.y + dy / d * Math.min(LOOK, d);
  const tx = Math.floor(sx), ty = Math.floor(sy);
  if (tx === Math.floor(a.x) && ty === Math.floor(a.y)) return false;
  const ix = tileIndex(ctx);                        // the step's tile index (near.js): a bucket, not every actor
  if (ix) { const l = onTile(ix, tx, ty); for (let i = 0; i < l.length; i += 2) if (l[i].kind === 'cart') return true; return false; }
  for (const c of ctx.actors?.values?.() ?? []) if (c.kind === 'cart' && Math.floor(c.x) === tx && Math.floor(c.y) === ty) return true;
  return false;
}

function update(a, dt, ctx) {
  const night = isNight(ctx);
  // night lanterns: only the ~20% who carry one, only while it is night and they are outdoors
  a.fx = night && a.lantern && !(a.flags & flags(ctx).INDOORS) ? LANTERN_FX : undefined;
  // time of day changed under us: indoor folk come out only if allowed; outdoor non-lantern folk head home
  if (a.state === 'home') {
    if (!night || a.lantern) {
      a.dwell = (a.dwell || 0) - dt;
      if (a.dwell <= 0) nextStop(a, ctx);
    }
    return;
  }
  if (a.state === 'yield') {                              // waiting for a cart to roll past
    a._yt += dt; a.anim = 'idle';
    const p = a._rest, probe = { x: a.x, y: a.y, path: p, pathI: 0 };
    if (!cartAhead(probe, ctx)) { a.path = p; a._rest = undefined; a.arrived = false; a.state = 'walk'; a.anim = 'walk'; }
    else if (a._yt > YIELD_MAX) { a._rest = undefined; leaveSlot(a, ctx); a.dest = undefined; a.state = 'dwell'; a.anim = 'idle'; a.dwell = 0.2; }
    return;
  }
  if (night && !a.lantern && a.stop !== 'home' && a.state !== 'walk') { nextStop(a, ctx); }
  else if (night && !a.lantern && a.stop !== 'home' && a.state === 'walk') { leaveSlot(a, ctx); startStop(a, ctx, 'home'); }
  if (a.state === 'dwell') {
    a.dwell -= dt;
    if (a.dwell <= 0) nextStop(a, ctx);
    return;
  }
  if (a.state === 'walk') {
    if (a.path && a.arrived === false && cartAhead(a, ctx)) {
      a._rest = Float32Array.from(a.path.subarray((a.pathI ?? 0) * 2)); a.path = undefined; a.state = 'yield'; a._yt = 0; a.anim = 'idle';
      return;
    }
    if (a.path) return;                                   // the sim is moving us
    if (a.arrived) arrive(a, ctx);
    else { leaveSlot(a, ctx); a.dest = undefined; a.state = 'dwell'; a.anim = 'idle'; a.dwell = 3; }   // refused (a.stuck)
  }
}
