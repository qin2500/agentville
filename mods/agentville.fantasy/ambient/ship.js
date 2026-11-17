// Harbour vessels (M5 P3): the 'token' behaviour (one sailing ship per PR at a harbour berth; the engine's sim/tokens.js
// creates and departs them) plus the harbour's own life: a tug from tier 3, rowboats and wheeling gulls at tier 4.
// Behaviour modules { init(a, ctx), update(a, dt, ctx) }; spawnHarbourLife(world, rand) gives the tug / rowboat / gull specs.
// Pure: no DOM, every random draw is ctx.rand(...) (or the spawn rand). Imports nothing from the engine.
// Movement follows the engine rule: these only set a.path / a.warp / a.speed and read a.arrived; the sim moves them.
// Every actor here is `gridFree` (water and air are blocked tiles for walkers), so the sim does not grid-check them.
//
// Ship (token) life: moored at its berth, bobbing -> its PR merges or leaves (a.depart from the engine) -> waits its turn
// (CAST_STAGGER s after the previous ship cast off) -> backs out sideways off the pier -> sails straight out to sea, to the
// map edge -> fades out (a.leaving; the sim drops it).
export const SHIP_LEN = 3;            // tiles of a pier side a moored ship takes (venues.js SHIP)
export const CAST_STAGGER = 6;        // s between two ships casting off
export const SAIL_SPEED = 1.4;        // tiles/s out to sea
export const BACK_OFF = 1;            // tiles sideways off the pier before turning seaward
export const BOB = { period: 3.2, amp: 1 };   // a.bob in screen px, sinusoidal
export const TUG_TIER = 3, LIFE_TIER = 4;
export const ROWBOATS = 2, GULLS = 3;
const TUG_SPEED = 1.9, ROW_SPEED = 0.45, GULL_SPEED = 2.2;
// parity: har.tug-escort, har.rowboats, har.gulls  (spawnHarbourLife below; the tug takes sailing ships out)
const HARBOUR = 'harbour';
const LEAVE_S = 0.3;

const tau = Math.PI * 2;
const levelOf = (world, venue) => Math.max(0, world?.venues?.[venue]?.level | 0);
const venueOf = (ctx, a) => ctx.world?.venues?.[a.venue] ?? null;
const harbours = world => Object.values(world?.venues || {}).filter(v => v && v.kind === HARBOUR).sort((p, q) => (p.id < q.id ? -1 : 1));
const bobOf = (a, ctx) => (ctx.reduceMotion || ctx.motion === false ? 0 : Math.sin(tau * ((ctx.now || 0) / BOB.period + (a.bobPhase || 0))) * BOB.amp);
const here = a => a.warp ?? { x: a.x, y: a.y };
const setPath = (a, pts) => { a.path = Float32Array.from(pts); a.arrived = false; };

// ---- harbour geometry from the world (the venue's own pier objects; cached per world) ------------------------------------
const PIERS = new WeakMap();
/** Pier deck tiles of a venue: Set of "x,y". */
export function pierTiles(world, venueId) {
  let m = PIERS.get(world);
  if (!m) { m = new Map(); if (world && typeof world === 'object') PIERS.set(world, m); }
  if (m.has(venueId)) return m.get(venueId);
  const set = new Set();
  for (const o of world?.objects?.values?.() ?? []) {
    if (o?.model !== 'pier' || o?.data?.venue !== venueId) continue;
    for (let y = o.ty; y < o.ty + (o.h || 1); y++) for (let x = o.tx; x < o.tx + (o.w || 1); x++) set.add(`${x},${y}`);
  }
  m.set(venueId, set);
  return set;
}
/** Which side of its pier a berth lies on: -1 west of it, +1 east of it; `deck` = the pier tile beside the ship's middle. */
export function berthSide(world, venue, b) {
  const mid = b.ty + (SHIP_LEN >> 1), piers = pierTiles(world, venue?.id);
  if (piers.has(`${b.tx + 1},${mid}`)) return { side: -1, deck: { tx: b.tx + 1, ty: mid } };
  if (piers.has(`${b.tx - 1},${mid}`)) return { side: 1, deck: { tx: b.tx - 1, ty: mid } };
  const side = venue && b.tx < venue.tx ? -1 : 1;
  return { side, deck: { tx: b.tx - side, ty: mid } };
}
/** Unit step from the shore to the sea: from the venue anchor toward its rect centre, on the dominant axis (default +y). */
export function seaward(venue) {
  if (!venue?.rect) return { dx: 0, dy: 1 };
  const cx = venue.rect.x + venue.rect.w / 2 - (venue.tx + 0.5), cy = venue.rect.y + venue.rect.h / 2 - (venue.ty + 0.5);
  if (Math.abs(cx) > Math.abs(cy)) return { dx: Math.sign(cx), dy: 0 };
  return { dx: 0, dy: cy < 0 ? -1 : 1 };
}
/** The point where a course from (x, y) along `dir` leaves the map (half a tile inside the last row/column). */
function edgePoint(world, x, y, dir) {
  const g = world?.grid;
  const x0 = g?.ox ?? world?.bounds?.ox ?? -64, y0 = g?.oy ?? world?.bounds?.oy ?? -64;
  const w = g?.w ?? world?.bounds?.w ?? 128, h = g?.h ?? world?.bounds?.h ?? 128;
  if (dir.dx > 0) return { x: x0 + w - 0.5, y };
  if (dir.dx < 0) return { x: x0 + 0.5, y };
  if (dir.dy < 0) return { x, y: y0 + 0.5 };
  return { x, y: y0 + h - 0.5 };
}
/** Hull centre of a ship moored at berth b. */
export const mooring = b => ({ x: b.tx + 0.5, y: b.ty + SHIP_LEN / 2 });

// ---- the ship (token) -------------------------------------------------------------------------------------------------
function moor(a, ctx) {
  const m = mooring(a);
  a.warp = m; a.moor = { x: m.x, y: m.y, berth: a.berth, tx: a.tx, ty: a.ty };
  a.path = undefined; a.state = 'moored'; a.sailing = false; a.anim = 'idle';
  a.face = a.berthFace ?? 2;
}

/** Cast-off times for every departing ship without one, in departure order: CAST_STAGGER s apart, never before `since`. */
// parity: har.cast-off-stagger-sail-out
function scheduleCastOffs(ctx) {
  const list = [];
  let last = -Infinity;
  for (const s of ctx.actors?.values?.() ?? []) {
    if (s.kind !== 'token' || !s.depart) continue;
    if (Number.isFinite(s.depart.castAt)) last = Math.max(last, s.depart.castAt);
    else list.push(s);
  }
  list.sort((p, q) => p.depart.seq - q.depart.seq);
  for (const s of list) { s.depart.castAt = Math.max(s.depart.since ?? 0, last + CAST_STAGGER); last = s.depart.castAt; }
}

function castOff(a, ctx) {
  const v = venueOf(ctx, a), dir = seaward(v);
  const { side } = berthSide(ctx.world, v, a);
  const p = here(a);
  // back off sideways (away from the pier, across the sea direction), then straight out to the edge
  const off = dir.dy ? { x: p.x + side * BACK_OFF, y: p.y } : { x: p.x, y: p.y + side * BACK_OFF };
  const end = edgePoint(ctx.world, off.x, off.y, dir);
  a.depart.locked = true;
  a.state = 'sailing'; a.sailing = true; a.speed = SAIL_SPEED; a.escort = a.escort ?? null;
  setPath(a, [off.x, off.y, end.x, end.y]);
}

function initShip(a, ctx) {
  a.gridFree = true;
  a.bobPhase = ctx.rand(a.id, 'bob');
  a.flags = (a.flags | 0) | (ctx.FLAGS?.VISIBLE ?? 1);
  a.tier = levelOf(ctx.world, a.venue);
  moor(a, ctx);
}

function updateShip(a, dt, ctx) {
  a.bob = bobOf(a, ctx);
  a.tier = levelOf(ctx.world, a.venue);
  if (a.state === 'sailing') {
    if (a.path) return;
    if (a.arrived || a.stuck) { a.leaving = LEAVE_S; a.state = 'gone'; }
    return;
  }
  if (a.state === 'gone') return;
  if (a.depart) {
    if (a.state !== 'waiting') { a.state = 'waiting'; }
    if (!Number.isFinite(a.depart.castAt)) scheduleCastOffs(ctx);
    if ((ctx.now ?? 0) + 1e-9 >= a.depart.castAt) castOff(a, ctx);
    return;
  }
  // moored (or back at its berth after a departure was called off): follow a berth change
  if (a.state !== 'moored' || !a.moor || a.moor.berth !== a.berth || a.moor.tx !== a.tx || a.moor.ty !== a.ty) moor(a, ctx);
}

export const ship = { init: initShip, update: updateShip };
export default ship;

// ---- harbour life specs -----------------------------------------------------------------------------------------------
const isWater = (g, x, y) => !g || (g.inBounds(x, y) && g.get('cost', x, y) >= 255 && g.get('occ', x, y) === 0);
/** A water tile of the venue rect (deterministic draws), clear of piers; null after a few misses. */
function waterIn(world, v, draw, avoid = null) {
  const r = v.rect, g = world?.grid, piers = pierTiles(world, v.id);
  for (let k = 0; k < 12; k++) {
    const x = r.x + Math.floor(draw(k, 'x') * r.w), y = r.y + Math.floor(draw(k, 'y') * r.h);
    if (isWater(g, x, y) && !piers.has(`${x},${y}`) && !(avoid && avoid(x, y))) return { x: x + 0.5, y: y + 0.5 };
  }
  return null;
}
/** Is every tile a straight run a->b enters open water off the piers? */
function clearRun(world, v, a, b) {
  const g = world?.grid, piers = pierTiles(world, v.id);
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
  for (let i = 1; i <= n; i++) {
    const x = Math.floor(a.x + (b.x - a.x) * i / n), y = Math.floor(a.y + (b.y - a.y) * i / n);
    if (!isWater(g, x, y) || piers.has(`${x},${y}`)) return false;
  }
  return true;
}

/** Tug (tier >= 3), rowboats and gulls (tier 4) for every harbour venue; rand(...keys) -> [0,1). */
export function spawnHarbourLife(world, rand) {
  const out = [];
  const r = (...k) => (typeof rand === 'function' ? rand(...k) : 0.5);
  for (const v of harbours(world)) {
    const lv = levelOf(world, v.id), dir = seaward(v);
    if (lv >= TUG_TIER) {
      // the tug waits in the first water row a little east of the venue anchor (the main pier head is at the anchor)
      const home = { x: v.tx + 4.5 + dir.dx * 2, y: v.ty + 1.5 + dir.dy * 1 };
      out.push({ id: `tug:${v.id}:0`, kind: 'tug', venue: v.id, x: home.x, y: home.y, home, gridFree: true, speed: TUG_SPEED, face: 0, anim: 'idle' });
    }
    if (lv >= LIFE_TIER) {
      for (let i = 0; i < ROWBOATS; i++) {
        const p = waterIn(world, v, (k, ax) => r(v.id, 'row', i, k, ax));
        if (p) out.push({ id: `rowboat:${v.id}:${i}`, kind: 'rowboat', venue: v.id, x: p.x, y: p.y, gridFree: true, speed: ROW_SPEED, face: 0, anim: 'idle' });
      }
      for (let i = 0; i < GULLS; i++) {
        const c = { x: v.rect.x + v.rect.w * (0.3 + 0.4 * r(v.id, 'gull', i, 'cx')), y: v.rect.y + v.rect.h * (0.3 + 0.4 * r(v.id, 'gull', i, 'cy')) };
        const rad = 2.5 + 2.5 * r(v.id, 'gull', i, 'r'), ang = tau * r(v.id, 'gull', i, 'a');
        out.push({ id: `gull:${v.id}:${i}`, kind: 'gull', venue: v.id, x: c.x + Math.cos(ang) * rad, y: c.y + Math.sin(ang) * rad,
          gridFree: true, speed: GULL_SPEED, wheel: { cx: c.x, cy: c.y, r: rad, a: ang, dir: i % 2 ? -1 : 1 }, alt: 0, face: 0, anim: 'idle' });
      }
    }
  }
  return out;
}

// ---- tug: escorts each ship out once it casts off, then comes back ------------------------------------------------------
function tugUpdate(a, dt, ctx) {
  a.bob = bobOf(a, ctx);
  const ships = [...(ctx.actors?.values?.() ?? [])].filter(s => s.kind === 'token' && s.venue === a.venue);
  let s = a.escorting ? ctx.actors.get(a.escorting) : null;
  if (s && (s.state !== 'sailing' || s.leaving != null)) { s.escort = null; s = null; a.escorting = null; }
  if (!s) {
    s = ships.filter(x => x.state === 'sailing' && x.leaving == null && !x.escort).sort((p, q) => p.depart.seq - q.depart.seq)[0] ?? null;
    if (s) { s.escort = a.id; a.escorting = s.id; }
  }
  if (s) {
    // keep station a tile and a half off the ship's seaward bow
    const dir = seaward(venueOf(ctx, s));
    const t = { x: s.x + dir.dy * 1.2 + dir.dx * 1.5, y: s.y + dir.dx * 1.2 + dir.dy * 1.5 };
    a.state = 'escort';
    if (Math.hypot(t.x - a.x, t.y - a.y) > 0.15) setPath(a, [t.x, t.y]); else a.path = undefined;
    return;
  }
  const h = a.home;
  if (a.state === 'escort' || (Math.hypot(h.x - a.x, h.y - a.y) > 0.1 && !a.path)) { a.state = 'return'; setPath(a, [h.x, h.y]); return; }
  if (a.state === 'return' && !a.path) a.state = 'idle';
}
export const tug = { init: a => { a.state = 'idle'; a.escorting = null; a.gridFree = true; }, update: tugUpdate };

// ---- rowboat: paddles slowly between water spots inside the harbour -----------------------------------------------------
function rowUpdate(a, dt, ctx) {
  a.bob = bobOf(a, ctx);
  if (a.path) return;
  if (a.state === 'row') { a.state = 'rest'; a.rest = 4 + 8 * ctx.rand(a.id, 'rest', a.n | 0); a.anim = 'idle'; return; }
  if ((a.rest -= dt) > 0) return;
  const v = venueOf(ctx, a);
  if (!v?.rect) return;
  a.n = (a.n | 0) + 1;
  const p = waterIn(ctx.world, v, (k, ax) => ctx.rand(a.id, 'row', a.n, k, ax), (x, y) => Math.hypot(x + 0.5 - a.x, y + 0.5 - a.y) > 8);
  if (p && clearRun(ctx.world, v, a, p)) { a.state = 'row'; setPath(a, [p.x, p.y]); }
  else a.rest = 2;
}
export const rowboat = { init: (a, ctx) => { a.state = 'rest'; a.rest = 3 * ctx.rand(a.id, 'r0'); a.bobPhase = ctx.rand(a.id, 'bob'); a.gridFree = true; }, update: rowUpdate };

// ---- gull: wheels in a loose circle over the harbour, a twelfth of a turn per leg ------------------------------------------
function gullUpdate(a, dt, ctx) {
  const w = a.wheel;
  a.alt = 18 + 4 * Math.sin(tau * ((ctx.now || 0) / 5 + (a.bobPhase || 0)));
  if (a.path || !w) return;
  w.a += w.dir * tau / 12;
  setPath(a, [w.cx + Math.cos(w.a) * w.r, w.cy + Math.sin(w.a) * w.r]);
}
export const gull = { init: (a, ctx) => { a.state = 'wheel'; a.bobPhase = ctx.rand(a.id, 'alt'); a.gridFree = true; a.wheel = a.wheel ? { ...a.wheel } : null; }, update: gullUpdate };
