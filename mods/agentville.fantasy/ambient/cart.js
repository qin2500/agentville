// Carts (design §4.4): a cart shuttles between a settlement and the town square (or the dock) over ROAD tiles only
// (grid `road` layer >= LANE), waits at each end, pauses 1-2 s at junctions, and parks at the square at night.
// Behaviour module shape: { init(a, ctx), update(a, dt, ctx) }, ctx = { world, nav, slots, rand(...keys), now, emit, night }.
// Movement follows the engine rule (web/src/engine/sim/actor.js): the cart sets a.path one leg at a time (legs end at
// junctions) and reads a.arrived / a.stuck; the world-sim moves it. Imports nothing from the engine (constants copied).
const LANE = 2;                       // ROAD.LANE (core/grid.js)
const CART_BY_TIER = [0, 0, 1, 2];    // max carts per town by tier (classic: carts from tier 2)
const SPEED = 1.8;                    // tiles per second
const NEAR_ROAD = 12;                 // spawn/hub snap radius to the nearest road tile

const rnd = (ctx, a, ...k) => { const v = ctx.rand ? ctx.rand(a.id, ...k) : 0.5; return typeof v === 'number' && v >= 0 && v < 1 ? v : 0.5; };
const tileOf = a => ({ tx: Math.floor(a.x), ty: Math.floor(a.y) });
const isRoad = (grid, tx, ty) => !!grid && (!grid.inBounds || grid.inBounds(tx, ty)) && grid.get('road', tx, ty) >= LANE;
const roadAt = (grid, tx, ty) => !grid || isRoad(grid, tx, ty);
/** ctx.night is a boolean (world-sim clock); a number (night amount) counts from 0.6. */
const nightOf = ctx => (typeof ctx.night === 'number' ? ctx.night >= 0.6 : !!ctx.night);

/** Nearest road tile to t within NEAR_ROAD (ring search, deterministic order); t itself when there is no grid. */
function snapToRoad(grid, t) {
  if (!grid || !t) return t;
  if (isRoad(grid, t.tx, t.ty)) return t;
  for (let r = 1; r <= NEAR_ROAD; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (isRoad(grid, t.tx + dx, t.ty + dy)) return { tx: t.tx + dx, ty: t.ty + dy };
    }
  }
  return null;
}

/** Cart specs for a world: min(CART_BY_TIER[tier], available) per settlement, each shuttling village <-> hub.
 *  Odd carts of a town go to the dock when the world has one. Both ends snap to road tiles. rand(...keys) -> [0,1). */
export function spawnCarts(world, rand) {
  const out = [];
  const grid = world?.grid;
  const sq = world?.square;
  const hub = snapToRoad(grid, sq ? { tx: sq.x + (sq.w >> 1), ty: sq.y + (sq.h >> 1) } : null);
  const d = world?.layoutData?.dock;   // this mod's own layout data (layout/dock.js)
  const dock = snapToRoad(grid, d && Number.isFinite(d.cx) && Number.isFinite(d.foot) ? { tx: d.cx, ty: d.foot } : null);
  for (const v of world?.villages || []) {
    const n = CART_BY_TIER[Math.max(0, Math.min(CART_BY_TIER.length - 1, v.tier | 0))] || 0;
    const home = snapToRoad(grid, Number.isFinite(v.cx) && Number.isFinite(v.cy) ? { tx: Math.floor(v.cx), ty: Math.floor(v.cy) } : null);
    if (!n || !home || !hub) continue;
    for (let i = 0; i < n; i++) {
      const far = i % 2 === 1 && dock ? dock : hub;
      const r = typeof rand === 'function' ? rand(v.name, 'cart', i) : 0;
      out.push({ id: `cart:${v.name}:${i}`, kind: 'cart', project: v.name, x: home.tx + 0.5, y: home.ty + 0.5, face: 0, anim: 'idle',
        state: 'wait', home: v.name, target: far === dock ? 'dock' : 'square', speed: SPEED,
        cart: { from: home, to: far, phase: r } });
    }
  }
  return out;
}

const norm = p => {
  if (!p) return null;
  const out = [];
  if (ArrayBuffer.isView(p)) { for (let i = 0; i + 1 < p.length; i += 2) out.push({ tx: Math.floor(p[i]), ty: Math.floor(p[i + 1]) }); }
  else for (const q of p) out.push(Array.isArray(q) ? { tx: q[0], ty: q[1] } : { tx: q.tx ?? Math.floor(q.x), ty: q.ty ?? Math.floor(q.y) });
  return out.length ? out : null;
};

/** Expand a sparse tile list into 4-connected unit steps that stay on road (x-first, else y-first); null if impossible. */
function densify(grid, tiles) {
  const out = [tiles[0]];
  for (let k = 1; k < tiles.length; k++) {
    const a = out[out.length - 1], b = tiles[k];
    let seg = null;
    for (const xFirst of [true, false]) {
      const s = []; let x = a.tx, y = a.ty, ok = true;
      const go = (axis) => { while (axis === 'x' ? x !== b.tx : y !== b.ty) { if (axis === 'x') x += Math.sign(b.tx - x); else y += Math.sign(b.ty - y); if (!roadAt(grid, x, y)) { ok = false; return; } s.push({ tx: x, ty: y }); } };
      if (xFirst) { go('x'); if (ok) go('y'); } else { go('y'); if (ok) go('x'); }
      if (ok) { seg = s; break; }
    }
    if (!seg) return null;
    out.push(...seg);
  }
  return out;
}

// A junction = a road tile with >= 3 road neighbours (4-connected).
function junction(grid, tx, ty) {
  if (!grid || !grid.inBounds) return false;
  let n = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (grid.inBounds(tx + dx, ty + dy) && grid.get('road', tx + dx, ty + dy) >= LANE) n++;
  return n >= 3;
}

/** Road route from a tile to a tile: the road graph's own polyline when nav exposes it, else nav.path({roadsOnly}). */
function roadRoute(ctx, from, to) {
  const g = ctx.nav?.graph;
  let p = null;
  if (g && typeof g.polyline === 'function' && typeof g.nearestNode === 'function') {
    const na = g.nearestNode(from.tx, from.ty, { roadsOnly: true }), nb = g.nearestNode(to.tx, to.ty, { roadsOnly: true });
    const ids = na == null || nb == null ? null : na === nb ? [na] : g.route(na, nb, { roadsOnly: true });
    p = ids && g.polyline(ids, { roadsOnly: true });
    if (p) p = [from, ...norm(p), to];
  } else p = norm(ctx.nav?.path?.(from, to, { roadsOnly: true }));
  if (!p || !p.length) return null;
  if (p[0].tx !== from.tx || p[0].ty !== from.ty) p.unshift(from);
  return densify(ctx.world?.grid, p);
}

/** Split a dense tile route into legs (Float32Array of tile centres), each ending at a junction or the route end. */
function legsOf(grid, tiles) {
  const legs = [];
  let cur = [];
  for (let i = 1; i < tiles.length; i++) {
    const t = tiles[i];
    cur.push(t.tx + 0.5, t.ty + 0.5);
    if (i < tiles.length - 1 && junction(grid, t.tx, t.ty)) { legs.push(Float32Array.from(cur)); cur = []; }
  }
  if (cur.length) legs.push(Float32Array.from(cur));
  return legs;
}

function wait(a, secs) { a.state = 'wait'; a.anim = 'idle'; a._t = secs; a._legs = null; a.path = undefined; }

export default {
  init(a, ctx) {
    a.kind = 'cart';
    const c = a.cart || {};
    a._leg = 0;                         // 0 = at/for the village end, 1 = at/for the far end
    a._t = 0.5 + (c.phase ?? rnd(ctx, a, 'phase')) * 3;   // staggered first departure
    a._legs = null; a._pause = 0;
    a.speed ??= SPEED;
    a.state = 'wait'; a.anim = 'idle';
  },

  update(a, dt, ctx) {
    const grid = ctx.world?.grid, c = a.cart;
    if (!c) return;
    const night = nightOf(ctx);

    if (a.state === 'wait') {
      a.anim = 'idle';
      if (night && a._leg === 1) return;   // parked at the market (far end) overnight
      a._t -= dt;
      if (a._t > 0 && !night) return;      // at night a cart still at home heads straight for the market
      const to = a._leg === 0 ? c.to : c.from;
      const tiles = roadRoute(ctx, tileOf(a), to);
      if (!tiles || tiles.length < 2) { wait(a, 4 + rnd(ctx, a, 'retry', Math.floor(ctx.now ?? 0)) * 4); return; }
      a._legs = legsOf(grid, tiles);
      a.path = a._legs.shift(); a.arrived = false; a.state = 'go'; a.anim = 'walk';
      return;
    }

    if (a.state === 'pause') {
      a._pause -= dt; a.anim = 'idle';
      if (a._pause <= 0) { a.path = a._legs.shift(); a.arrived = false; a.state = 'go'; a.anim = 'walk'; }
      return;
    }

    if (a.state !== 'go') { wait(a, 1); return; }
    if (a.path) return;                    // the sim is moving us
    if (a.stuck || !a.arrived) { wait(a, 4 + rnd(ctx, a, 'stuck', Math.floor(ctx.now ?? 0)) * 4); return; }
    if (a._legs?.length) {                 // at a junction: look both ways
      a.state = 'pause'; a._pause = 1 + rnd(ctx, a, 'junction', a._legs.length); a.anim = 'idle';
      return;
    }
    a._leg = a._leg === 0 ? 1 : 0;
    wait(a, 4 + rnd(ctx, a, 'dwell', a._leg) * 4);   // wait at the end
  },
};
