// Dock porters (M5 P3): the classic web/src/dock-walk.js policy, ported onto the engine's nav and sim.
// Crates reach the ships on foot. Who walks keeps each agent's bucket readable:
//   - a RESTING agent (indoors at home) whose PR has a ship loading is that ship's porter: from its home door to the
//     ship and back, one ship per trip, rotating when it has several;
//   - every other ship gets a townsperson walking from the bottom of the town square;
//   - at most CAP porters are out at once (one pool of CAP actors per harbour; the rest of the ships simply wait);
//   - from tier 2 a trip goes by the crate yard (PICK s to pick a crate up), then to the ship (DROP s to set it down);
//     at tier 1 the crate is carried from home;
//   - a porter whose ship sails drops its crate and heads home; one whose agent woke up (or left) is gone at once (the
//     agent itself is drawn again); with reduced motion nobody walks.
// Every leg WALKS, however long (classic dock-walk.js walks the whole trip at 20 px/s). The D4 fade rule (ctx.shouldWalk:
// <= 6 s, on screen) is for agents changing place; a porter's whole point is the walk, and a faded town-to-quay leg made
// it pop up on the quay out of nowhere. A porter only ever stands in for a RESTING agent, so stalled / error agents never
// move; with reduced motion nobody walks (released).
// Movement: legs come from ctx.nav.path and are set as a.path; the sim moves the porter (an off-screen one at the LOD
// pace, which keeps its real-time speed) and refuses an illegal path (a.stuck). Imports nothing from the engine.
//
// Where it walks to: the walkable deck tile beside the ship's middle (venues stamp piers; once they are walkable the
// porter walks out onto the pier). Until then (pier tiles still blocked water) it falls back to the nearest walkable
// tile reachable by nav, searched outward from the deck tile (the quay); a.fallback = 'quay' says so.
import { berthSide } from './ship.js';

// parity: har.porter-cap-6, har.porter-drop-and-head-home, har.porters-resting-agents, har.porter-townsperson-fallback
// parity: vil.pose-carry-crate-shuttle  (a porter with a crate sets a.carry; the renderer draws it at the chest)
export const CAP = 6;                 // porters out at once, per harbour
export const PICK = 0.9;              // s, picking a crate up in the yard
export const DROP = 1.2;              // s, setting a crate down on deck
export const REST = [5, 4];           // s at home between trips: base + up to this much more
export const SPEED = 1.25;            // tiles/s (classic 20 px/s at 16 px tiles)
const FIRST_WAIT = 6, FIRST_N = 7;    // classic: a new walker waits rnd*6 s and starts at ship rnd*7
const RETRY = 10;                     // s before trying again when there is no way there
const NEAR = 12;                      // fallback search radius, tiles
const HARBOUR = 'harbour';

const fl = ctx => ctx.FLAGS || { VISIBLE: 1, INDOORS: 8 };
const walkable = (g, x, y) => !g || (g.inBounds(x, y) && g.get('cost', x, y) < 255 && g.get('occ', x, y) === 0);
const here = a => a.warp ?? { x: a.x, y: a.y };
const hide = (a, ctx) => { a.flags = (a.flags | 0) & ~fl(ctx).VISIBLE; };
const show = (a, ctx) => { a.flags = (a.flags | 0) | fl(ctx).VISIBLE; };
const bucketOf = s => (s && typeof s === 'object' ? s.bucket : s);

/** Is this agent actor free to carry: resting, indoors at home, not on its way out? */
export function restingIndoors(ag, ctx) {
  return !!ag && ag.kind === 'agent' && ag.leaving == null && bucketOf(ag.status) === 'resting'
    && (ag.flags & fl(ctx).INDOORS) !== 0 && !!ctx.homeOf?.(ag.id);
}

/** A walkable tile at the bottom middle of the town square (or the nearest one to it); null without a square. */
function squareFoot(world) {
  const q = world?.square;
  if (!q) return null;
  return nearestWalkable(world, q.x + (q.w >> 1), q.y + q.h - 1, 6);
}
function nearestWalkable(world, tx, ty, rad, accept = () => true) {
  const g = world?.grid;
  for (let r = 0; r <= rad; r++) {
    // a ring at a time, nearest first (ties in a fixed order), so the pick is the closest tile and deterministic
    const ring = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
    ring.sort((p, q) => (p[0] * p[0] + p[1] * p[1]) - (q[0] * q[0] + q[1] * q[1]));
    for (const [dx, dy] of ring) {
      const x = tx + dx, y = ty + dy;
      if (walkable(g, x, y) && accept(x, y)) return { x: x + 0.5, y: y + 0.5, tx: x, ty: y };
    }
  }
  return null;
}

// ---- who should walk for which ship (computed once per tick and venue) ----------------------------------------------------
const WANTS = new WeakMap();
/** Map wantId -> { agentId: string|null, ships: itemId[] }, in ship order (oldest first). wantId 'agent:<id>' | 'town:<item>'. */
export function wantsOf(ctx, venue) {
  let c = WANTS.get(ctx);
  if (!c || c.tick !== ctx.tick) { c = { tick: ctx.tick, by: new Map() }; WANTS.set(ctx, c); }
  if (c.by.has(venue)) return c.by.get(venue);
  const want = new Map();
  const ships = (ctx.tokens?.list?.() ?? []).filter(s => s.venue === venue && !s.depart && s.leaving == null);
  if (ships.length) {
    // per ship, the lowest-id resting agent indoors whose PRs include it (one pass over the actors, no sort: the same pick
    // as the first match in id order, PERF M7)
    const firstFor = new Map(ships.map(s => [s.item, null]));
    for (const x of ctx.actors?.values?.() ?? []) {
      if (x.kind !== 'agent' || !Array.isArray(x.input?.prs)) continue;
      let ok = null;
      for (const item of x.input.prs) {
        if (!firstFor.has(item)) continue;
        const cur = firstFor.get(item);
        if (cur && !(x.id < cur.id)) continue;
        if (ok === null) ok = restingIndoors(x, ctx);
        if (ok) firstFor.set(item, x);
      }
    }
    for (const s of ships) {
      const ag = firstFor.get(s.item);
      const id = ag ? `agent:${ag.id}` : `town:${s.item}`;
      if (!want.has(id)) want.set(id, { agentId: ag ? ag.id : null, ships: [] });
      want.get(id).ships.push(s.item);
    }
  }
  c.by.set(venue, want);
  return want;
}

const PORTERS = new WeakMap();
/** This harbour's porter actors, listed once per tick (an idle porter used to scan every actor for them each step). */
export function portersOf(ctx, venue) {
  let c = PORTERS.get(ctx);
  // the same tick, actor store and size, and every listed porter still the store's actor for its id (a rebuild respawns
  // the ambient actors between two steps of one tick)
  if (!c || c.tick !== ctx.tick || c.actors !== ctx.actors || c.size !== (ctx.actors?.size ?? 0)
    || [...c.by.values()].some(list => list.some(o => ctx.actors.get(o.id) !== o))) {
    c = { tick: ctx.tick, actors: ctx.actors, size: ctx.actors?.size ?? 0, by: new Map() };
    for (const o of ctx.actors?.values?.() ?? []) if (o.kind === 'porter') { if (!c.by.has(o.venue)) c.by.set(o.venue, []); c.by.get(o.venue).push(o); }
    PORTERS.set(ctx, c);
  }
  return c.by.get(venue) ?? [];
}

/** Porter specs: CAP per harbour venue, idle and hidden at the bottom of the town square. */
export function spawnPorters(world, rand) {
  const out = [], foot = squareFoot(world);
  for (const v of Object.values(world?.venues || {}).filter(x => x && x.kind === HARBOUR).sort((p, q) => (p.id < q.id ? -1 : 1))) {
    const at = foot ?? nearestWalkable(world, v.tx, v.ty, NEAR);
    if (!at) continue;
    for (let i = 0; i < CAP; i++) {
      out.push({ id: `porter:${v.id}:${i}`, kind: 'porter', venue: v.id, x: at.x, y: at.y, flags: 0, speed: SPEED,
        look: { seed: Math.floor((typeof rand === 'function' ? rand(v.id, 'porter', i) : 0) * 4096) }, face: 0, anim: 'idle' });
    }
  }
  return out;
}

// ---- trip geometry --------------------------------------------------------------------------------------------------------
function originOf(a, ctx) {
  if (a.agentId != null) {
    const h = ctx.homeOf?.(a.agentId);
    if (h?.door) return { x: h.door.tx + 0.5, y: h.door.ty + 0.5 };
    if (h) { const p = nearestWalkable(ctx.world, h.tx, h.ty, 4); if (p) return p; }
  }
  return squareFoot(ctx.world) ?? { x: a.x, y: a.y };
}
const TARGETS = new WeakMap();
/** Where a porter sets the crate down for a ship: { x, y, fallback? } or null. Cached per world and berth. */
export function deckTarget(ctx, s) {
  let m = TARGETS.get(ctx.world);
  if (!m) { m = new Map(); if (ctx.world && typeof ctx.world === 'object') TARGETS.set(ctx.world, m); }
  const v = ctx.world?.venues?.[s.venue];
  const key = `${s.venue}|${s.berth}|${s.tx},${s.ty}`;
  if (m.has(key)) return m.get(key);
  let t = null;
  if (v) {
    const { deck } = berthSide(ctx.world, v, s);
    const g = ctx.world?.grid;
    const from = { x: v.tx + 0.5, y: v.ty + 0.5 };
    const reach = (x, y) => !ctx.nav?.path || !!ctx.nav.path(from, { x: x + 0.5, y: y + 0.5 }, {});
    if (walkable(g, deck.tx, deck.ty) && reach(deck.tx, deck.ty)) t = { x: deck.tx + 0.5, y: deck.ty + 0.5 };
    else {
      let tries = 0;
      const p = nearestWalkable(ctx.world, deck.tx, deck.ty, NEAR, (x, y) => tries++ < 16 && reach(x, y));
      if (p) t = { x: p.x, y: p.y, fallback: 'quay' };
    }
  }
  m.set(key, t);
  return t;
}
function yardOf(ctx, venue) {
  const v = ctx.world?.venues?.[venue];
  const y = v?.nodes?.yard;
  if (!v || (v.level | 0) < 2 || !y) return null;
  return nearestWalkable(ctx.world, y.tx, y.ty, 4);
}

/** Set one leg to (x, y): a walk along the nav path, whatever its length (see the header). False when nav has no way. */
function leg(a, ctx, to) {
  const from = here(a);
  const p = ctx.nav?.path?.(from, { x: to.x, y: to.y }, {});
  if (!p || p.length < 2) return false;
  const pts = Array.from(p);
  if (pts[pts.length - 2] !== to.x || pts[pts.length - 1] !== to.y) pts.push(to.x, to.y);
  a.path = Float32Array.from(pts);
  a.move = undefined;
  a.arrived = false; a.stuck = false;
  return true;
}
const legDone = a => !a.path && !a.fade && (a.arrived || a.stuck);

// ---- the porter -----------------------------------------------------------------------------------------------------------
function release(a, ctx) {
  a.job = null; a.agentId = null; a.ships = []; a.item = null; a.carry = false; a.cargo = null;
  a.state = 'idle'; a.path = undefined; a.move = undefined; a.fallback = undefined;
  hide(a, ctx);
}
function atBerth(a, ctx) {
  const s = a.item != null ? ctx.tokens?.get?.(a.item) : null;
  return !!s && !s.depart && s.leaving == null && s.berth === a.berth;
}
/** Head home: the crate is dropped now; the leg starts once any fade in progress has finished (a leg planned mid-fade
 *  would start from the wrong end of the fade). */
function goBack(a, ctx) {
  a.carry = false; a.cargo = null; a.state = 'back'; a.backLeg = false;
  if (a.path && !a.fade) { a.path = undefined; a.move = undefined; }   // stop where it stands
  backLeg(a, ctx);
}
function backLeg(a, ctx) {
  if (a.backLeg || a.fade || a.path) return;
  a.backLeg = true;
  if (!leg(a, ctx, a.origin)) { a.path = undefined; a.move = undefined; a.warp = { x: a.origin.x, y: a.origin.y }; a.arrived = true; }
}
function startTrip(a, ctx) {
  const item = a.ships[a.n++ % a.ships.length];
  const s = ctx.tokens?.get?.(item);
  const to = s ? deckTarget(ctx, s) : null;
  if (!to) { a.wait = RETRY; return; }
  a.origin = originOf(a, ctx);
  a.warp = { x: a.origin.x, y: a.origin.y };
  show(a, ctx);
  const yard = yardOf(ctx, a.venue);
  a.item = item; a.berth = s.berth; a.to = { x: to.x, y: to.y }; a.fallback = to.fallback;
  a.picked = !yard; a.carry = !yard; a.cargo = a.carry ? 'crate' : null;
  a.state = 'out';
  if (!leg(a, ctx, yard ?? a.to)) { a.warp = undefined; hide(a, ctx); a.state = 'home'; a.wait = RETRY; a.carry = false; a.cargo = null; a.item = null; }
}

function init(a, ctx) {
  a.speed ??= SPEED;
  a.n = 0; a.wait = 0;
  release(a, ctx);
}

function update(a, dt, ctx) {
  if (ctx.reduceMotion || ctx.motion === false) { if (a.job) release(a, ctx); return; }
  const want = wantsOf(ctx, a.venue);
  if (a.job) {
    const next = want.get(a.job);
    // an agent that woke up (or left the map) is drawn at home again: its porter is gone at once
    if (a.agentId != null && !next && !restingIndoors(ctx.actors?.get?.(a.agentId), ctx)) { release(a, ctx); return; }
    a.ships = next ? next.ships : [];
  } else {
    const taken = new Set();
    for (const o of portersOf(ctx, a.venue)) if (o.job && o !== a) taken.add(o.job);
    for (const [id, n] of want) {
      if (taken.has(id)) continue;
      a.job = id; a.agentId = n.agentId; a.ships = n.ships;
      a.n = Math.floor(ctx.rand(a.id, id, 'n') * FIRST_N);
      a.wait = ctx.rand(a.id, id, 'w') * FIRST_WAIT;
      a.state = 'home'; hide(a, ctx);
      break;
    }
    if (!a.job) return;
  }
  switch (a.state) {
    case 'home':
      a.wait -= dt;
      if (!a.ships.length) { release(a, ctx); return; }   // nothing left to carry: stays in
      if (a.wait > 0) return;
      startTrip(a, ctx);
      return;
    case 'out':
      if (!atBerth(a, ctx)) { goBack(a, ctx); return; }   // its ship sailed: drop the crate, head home
      if (!legDone(a)) return;
      if (a.stuck) { goBack(a, ctx); return; }
      if (!a.picked) { a.state = 'pick'; a.wait = PICK; a.anim = 'idle'; }
      else { a.state = 'drop'; a.wait = DROP; a.anim = 'idle'; }
      return;
    case 'pick':
      if (!atBerth(a, ctx)) { goBack(a, ctx); return; }
      if ((a.wait -= dt) > 0) return;
      a.picked = true; a.carry = true; a.cargo = 'crate'; a.state = 'out';
      if (!leg(a, ctx, a.to)) goBack(a, ctx);
      return;
    case 'drop':
      if ((a.wait -= dt) <= 0 || !atBerth(a, ctx)) goBack(a, ctx);
      return;
    case 'back':
      if (!a.backLeg) { backLeg(a, ctx); return; }
      if (a.path || a.fade) return;
      a.state = 'home'; a.item = null; a.berth = null; a.fallback = undefined;
      a.wait = REST[0] + ctx.rand(a.id, 'rest', a.n) * REST[1];
      hide(a, ctx);
      return;
    default:
      return;
  }
}

export const porter = { init, update };
export default porter;
