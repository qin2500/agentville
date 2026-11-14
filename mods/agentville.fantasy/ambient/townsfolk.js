// Townsfolk routines (design §4.3): behaviour module { init(a, ctx), update(a, dt, ctx) } + spawnTownsfolk(world, rand).
// Day schedule: home -> shop (a door) -> bench (sit) -> square (chat) -> home, dwell 20-90 s; some trips go to another
// settlement. At night most stay indoors, ~20% walk with lanterns. Vendors stand at `vend` anchors by day.
// Pure: no DOM, no module state, every random draw is the stateless ctx.rand(...keys). Exported data holds no functions.
// Movement follows the engine rule (web/src/engine/sim/actor.js): this module only sets a.path / a.warp and reads
// a.arrived / a.stuck; the world-sim moves the actor and refuses paths over blocked tiles.
export const COUNT_BY_TIER = [2, 5, 10, 18];
export const DWELL = { min: 20, max: 90 };
export const DAY_LEN_S = 480;                       // one game day in seconds of ctx.now (ms) when ctx.dayPhase is absent
export const NIGHT_WALKER_SHARE = 0.2;
export const VENDOR_SHARE = 0.15;                   // of townsfolk (at least 1 in tier >= 1) who are vendors
export const SPEED = [1.1, 1.7];                    // tiles per second
const FLAG = { VISIBLE: 1, INDOORS: 8 };            // fallback; ctx.FLAGS wins when supplied
const ROUTINE = ['shop', 'sit', 'square', 'home'];

const flags = ctx => ctx?.FLAGS || FLAG;
const lerp = (a, b, t) => a + (b - a) * t;
const keyHome = o => o.kind === 'building' && o.door;

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
    const homes = [...world.objects.values()].filter(o => keyHome(o) && o.project === v.name && o.lot && o.data?.owner === 'house');
    const pool = homes.length ? homes : [...world.objects.values()].filter(o => keyHome(o) && o.project === v.name);
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
        lantern: rand('folk-lantern', v.name, i) < NIGHT_WALKER_SHARE,
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

function doors(ctx, filter) { return [...ctx.world.objects.values()].filter(o => keyHome(o) && filter(o)); }

const here = a => a.warp ?? { x: a.x, y: a.y };
function goTo(a, ctx, x, y) {
  const from = here(a);
  const path = ctx.nav?.path?.(from, { x, y }, {});
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
      if (walkable(w, x, y)) return { x, y };
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
  if (!goTo(a, ctx, t.x, t.y)) { leaveSlot(a, ctx); a.dwell = 5; a.state = 'dwell'; a.anim = 'idle'; a.arrived = false; }
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
  a.lantern = a.lantern ?? false;
  a.speed ??= lerp(SPEED[0], SPEED[1], ctx.rand(a.id, 'speed'));
  a.flags = (a.flags | 0) | flags(ctx).VISIBLE;
  a.face ??= 0; a.dwell = 0; a.slot = undefined;
  // spread the crowd: each starts at a random point of its first dwell, indoors if it is night
  if (isNight(ctx) && !a.lantern) enterHome(a, ctx);
  else { a.state = 'dwell'; a.anim = 'idle'; a.dwell = ctx.rand(a.id, 'phase') * DWELL.min; }
}

function update(a, dt, ctx) {
  const night = isNight(ctx);
  // time of day changed under us: indoor folk come out only if allowed; outdoor non-lantern folk head home
  if (a.state === 'home') {
    if (!night || a.lantern) {
      a.dwell = (a.dwell || 0) - dt;
      if (a.dwell <= 0) nextStop(a, ctx);
    }
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
    if (a.path) return;                                   // the sim is moving us
    if (a.arrived) arrive(a, ctx);
    else { leaveSlot(a, ctx); a.dest = undefined; a.state = 'dwell'; a.anim = 'idle'; a.dwell = 3; }   // refused (a.stuck)
  }
}
