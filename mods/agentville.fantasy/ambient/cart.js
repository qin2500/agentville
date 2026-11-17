// Carts (design §4.4): a cart shuttles between a settlement and the town square (or the dock) over ROAD tiles only
// (grid `road` layer >= LANE), waits at each end, pauses 1-2 s at junctions, and parks at the square at night.
// Behaviour module shape: { init(a, ctx), update(a, dt, ctx) }, ctx = { world, nav, slots, rand(...keys), now, emit, night }.
// Movement follows the engine rule (web/src/engine/sim/actor.js): the cart sets a.path one leg at a time (legs end at
// junctions) and reads a.arrived / a.stuck; the world-sim moves it. Imports nothing from the engine (constants copied).
import { tileIndex, onTile } from './near.js';
const LANE = 2;                       // ROAD.LANE (core/grid.js)
// parity: amb.carts-in-towns-cities
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

// ---- reserve the way (spec 2.3): never roll onto a pedestrian -------------------------------------------------------
const YIELD_MAX = 3;                               // seconds a cart waits for the way before turning back
const AHEAD = 2;                                   // cells of the path kept clear
const pedOk = p => (p.kind === 'agent' || p.kind === 'folk') && !(p.flags & 8) && !(p.flags & 16) && !p.fade && (p.alpha ?? 1) > 0.5;
/** Tiles the cart is about to enter: the next AHEAD waypoints of `pts` (x,y pairs) then of the queued legs. */
function aheadTiles(pts, from, legs) {
  const out = [];
  for (let i = from; i + 1 < pts.length && out.length < AHEAD; i += 2) out.push({ tx: Math.floor(pts[i]), ty: Math.floor(pts[i + 1]) });
  for (const l of legs || []) for (let i = 0; i + 1 < l.length && out.length < AHEAD; i += 2) out.push({ tx: Math.floor(l[i]), ty: Math.floor(l[i + 1]) });
  return out;
}
/** Is a pedestrian on a tile ahead or on the cart's own tile? (Pedestrians in turn never step onto a cart's tile:
 *  townsfolk.js yields to ctx.actors carts, so two moving parties cannot deadlock on adjacency.) */
function blockedAhead(a, ctx, tiles) {
  const cx = Math.floor(a.x), cy = Math.floor(a.y);
  const ix = tileIndex(ctx);                        // the step's tile index (near.js): only the asked tiles' buckets
  if (ix) {
    const hit = (tx, ty) => { const l = onTile(ix, tx, ty); for (let i = 0; i < l.length; i += 2) if (l[i] !== a && pedOk(l[i])) return true; return false; };
    if (hit(cx, cy)) return true;
    for (const t of tiles) if (hit(t.tx, t.ty)) return true;
    return false;
  }
  for (const p of ctx.actors?.values?.() ?? []) {
    if (p === a || !pedOk(p)) continue;
    const px = Math.floor(p.x), py = Math.floor(p.y);
    if (px === cx && py === cy) return true;
    for (const t of tiles) if (t.tx === px && t.ty === py) return true;
  }
  return false;
}

function wait(a, secs) { a.state = 'wait'; a.anim = 'idle'; a._t = secs; a._legs = null; a.path = undefined; }

export default {
  init(a, ctx) {
    a.kind = 'cart';
    const c = a.cart || {};
    a._leg = 0;                         // 0 = at/for the village end, 1 = at/for the far end
    a._t = 0.5 + (c.phase ?? rnd(ctx, a, 'phase')) * 3;   // staggered first departure
    a._legs = null; a._pause = 0; a._rest = null; a._yt = 0;
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
      if (blockedAhead(a, ctx, aheadTiles(a._legs[0] || [], 0, a._legs.slice(1)))) { wait(a, 0.5); return; }   // someone stands on the first tiles: do not roll off yet
      a.path = a._legs.shift(); a.arrived = false; a.state = 'go'; a.anim = 'walk';
      return;
    }

    if (a.state === 'yield') {             // waiting for a pedestrian to clear the road ahead
      a.anim = 'idle';
      if (!blockedAhead(a, ctx, aheadTiles(a._rest, 0, a._legs))) { a.path = a._rest; a._rest = null; a._yt = 0; a.arrived = false; a.state = 'go'; a.anim = 'walk'; return; }
      a._yt = (a._yt || 0) + dt;
      if (a._yt > YIELD_MAX) {             // a settled actor (bench sitter, chatting folk) holds the way: turn back to the other end
        a._yt = 0; a._rest = null;
        let tr = a._trail || [];
        const free = [];                                  // keep only the trail tiles before the first pedestrian-held one
        for (let i = 0; i + 1 < tr.length; i += 2) { if (blockedAhead(a, ctx, [{ tx: Math.floor(tr[i]), ty: Math.floor(tr[i + 1]) }])) break; free.push(tr[i], tr[i + 1]); }
        tr = free.length > 2 ? free : [];                 // back out along the tiles we came by, then replan from there
        if (tr.length) { a._legs = null; a.path = Float32Array.from(tr); a._back = true; a.arrived = false; a.state = 'go'; a.anim = 'walk'; }
        else wait(a, 0.5);
      }
      return;
    }

    if (a.state === 'pause') {
      a._pause -= dt; a.anim = 'idle';
      if (a._pause <= 0) { a.path = a._legs.shift(); a.arrived = false; a.state = 'go'; a.anim = 'walk'; }
      return;
    }

    if (a.state !== 'go') { wait(a, 1); return; }
    if (a.path) {                          // the sim is moving us, unless someone is in the way
      if (!a._back) {                      // remember the last tiles rolled over (newest first) for backing out of a blocked road
        const tx = Math.floor(a.x), ty = Math.floor(a.y), tr = (a._trail ||= []);
        if (!tr.length || Math.floor(tr[0]) !== tx || Math.floor(tr[1]) !== ty) { tr.unshift(tx + 0.5, ty + 0.5); if (tr.length > 8) tr.length = 8; }
      }
      const tiles = aheadTiles(a.path, (a.pathI ?? 0) * 2, a._legs);
      if (blockedAhead(a, ctx, tiles)) {
        a._rest = Float32Array.from(a.path.subarray ? a.path.subarray((a.pathI ?? 0) * 2) : Array.from(a.path).slice((a.pathI ?? 0) * 2));
        a.path = undefined; a.state = 'yield'; a.anim = 'idle';
      }
      return;
    }
    if (a._back) { a._back = false; a._trail = []; wait(a, 0.5 + rnd(ctx, a, 'back', Math.floor(ctx.now ?? 0))); return; }   // backed out: replan the same trip
    if (a.stuck || !a.arrived) { wait(a, 4 + rnd(ctx, a, 'stuck', Math.floor(ctx.now ?? 0)) * 4); return; }
    if (a._legs?.length) {                 // at a junction: look both ways
      a.state = 'pause'; a._pause = 1 + rnd(ctx, a, 'junction', a._legs.length); a.anim = 'idle';
      return;
    }
    a._leg = a._leg === 0 ? 1 : 0;
    wait(a, 4 + rnd(ctx, a, 'dwell', a._leg) * 4);   // wait at the end
  },
};
