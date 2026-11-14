// Engine v2 nav facade (N5, design §2.2): composes astar, roadgraph, flow and slots.
// The sibling modules are imported statically (a Vite build cannot bundle computed dynamic imports).
//
// path(from, to, opts) -> Float32Array|null of tile-centre x,y pairs (straight runs may be collapsed to their ends):
//   - both ends on free tiles in different 4-connected components -> null without searching (component labels, below)
//   - Manhattan <= 24 -> one grid A*
//   - longer -> a bounded local A* from each end to a nearby road-graph node (radius 12, a few candidates), the graph
//     route between them as the road graph's tile polyline (every step legal), lane offsets on the road part
//     (keep right, ±0.25 tile across the direction of travel; points stay inside their tile), then the last leg.
//     A side whose bounded legs all run out of nodes -> null at once (no grid fallback; the failure is cached per end
//     tile and grid stamp). No graph route (or no candidate node to try) -> one plain grid A* as the fallback.
//   opts: { roadsOnly?: cart roads only, the road polyline alone; lanes?: false to skip lane offsets; astarOpts? }
// Component labels: 8-way A* moves never cut corners, so its reachability equals 4-connectivity over free tiles with
// open edges. Labels are cached per (grid.version, cost bakes). bakeCost does not bump grid.version, so createNav wraps
// the grid instance's bakeCost to count bakes (nav-local; core/grid.js is untouched); invalidate() forces a recompute.
import { astar } from './astar.js';
import { buildRoadGraph } from './roadgraph.js';
import { flowField } from './flow.js';
import { createSlots } from './slots.js';
const SHORT_MANHATTAN = 24;
const NODE_RADIUS = 12;
const NODE_CANDIDATES = 4;
const LEG_MAX_NODES = 4000;
const LANE = 0.25;
const ROUTE_LRU = 4096;
const LEG_FAIL_LRU = 4096;
const CAPPED = Object.freeze({ capped: true });   // legTo: every candidate leg ran out of nodes
const FLOW_LRU = 8;
const DEFAULT_BUDGET = 40;   // path requests served per tick (§2.5)

const DEFAULTS = { astar, buildRoadGraph, flowField, createSlots }; // static imports (Vite cannot bundle computed imports)
function need(fn, name, file) {
  if (typeof fn !== 'function') throw new Error(`engine nav: ${name} is unavailable (nav/${file} missing or does not export it)`);
  return fn;
}

// ---- cost-bake counter per grid (nav-local)
const BAKES = new WeakMap();
function watchBakes(grid) {
  if (!grid || typeof grid !== 'object' || BAKES.has(grid)) return;
  BAKES.set(grid, 0);
  const orig = grid.bakeCost;
  if (typeof orig !== 'function') return;
  grid.bakeCost = function (...a) { BAKES.set(grid, (BAKES.get(grid) ?? 0) + 1); return orig.apply(this, a); };
}
const stamp = grid => `${grid?.version}:${BAKES.get(grid) ?? 0}`;

/** 4-connected component labels over free tiles (0 = blocked). Int32Array indexed like the grid layers. */
export function componentLabels(grid) {
  const { w, h, occ, cost, edges } = grid, n = w * h;
  const lab = new Int32Array(n), stack = new Int32Array(n);
  const free = i => occ[i] === 0 && cost[i] !== 255;
  const E = 2, S = 4, W = 8, N = 1;
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (lab[s] || !free(s)) continue;
    lab[s] = ++next;
    let top = 0; stack[top++] = s;
    while (top) {
      const i = stack[--top], x = i % w, e = edges ? edges[i] : 0;
      const tryJ = (j, out, back) => {
        if (lab[j] || !free(j) || (e & out) || (edges && (edges[j] & back))) return;
        lab[j] = next; stack[top++] = j;
      };
      if (x + 1 < w) tryJ(i + 1, E, W);
      if (x > 0) tryJ(i - 1, W, E);
      if (i + w < n) tryJ(i + w, S, N);
      if (i >= w) tryJ(i - w, N, S);
    }
  }
  return lab;
}

function concat(parts) {
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    for (let i = 0; i + 1 < p.length; i += 2) {
      const n = out.length;
      if (n && out[n - 2] === p[i] && out[n - 1] === p[i + 1]) continue;   // no duplicate joints
      out.push(p[i], p[i + 1]);
    }
  }
  return Float32Array.from(out);
}

/** Keep right: shift each point of a tile-centre polyline by LANE across its direction of travel (central difference).
 *  The shift is <= 0.25 tile, so every point stays in its tile. The two ends stay on the centres (they join the legs). */
function laneOffset(p) {
  const n = p.length / 2;
  if (n < 3) return p;
  const out = Float32Array.from(p);
  for (let k = 1; k < n - 1; k++) {
    const dx = p[2 * k + 2] - p[2 * k - 2], dy = p[2 * k + 3] - p[2 * k - 1], l = Math.hypot(dx, dy);
    if (!l) continue;
    out[2 * k] += (-dy / l) * LANE; out[2 * k + 1] += (dx / l) * LANE;   // right of travel in a y-down tile frame
  }
  return out;
}

/** @param {object} world @param {{astar?,buildRoadGraph?,flowField?,createSlots?,budget?:number}} [deps] */
export function createNav(world, deps = {}) {
  const D = { ...DEFAULTS, ...Object.fromEntries(Object.entries(deps).filter(([, v]) => v != null)) };
  const grid = world.grid;
  watchBakes(grid);
  const astar = (...a) => need(D.astar, 'astar', 'astar.js')(...a);

  let graph = null, graphStamp = null;
  const routes = new Map();   // `${na}|${nb}|${flags}` -> Float32Array|null (LRU)
  const getGraph = () => {
    const st = grid?.version;
    if (!graph || graphStamp !== st) { graph = need(D.buildRoadGraph, 'buildRoadGraph', 'roadgraph.js')(world); graphStamp = st; routes.clear(); }
    return graph;
  };
  let slots = null;
  const getSlots = () => slots ?? (slots = need(D.createSlots, 'createSlots', 'slots.js')(world));
  const tile = p => ({ x: Math.floor(p.x ?? p.tx), y: Math.floor(p.y ?? p.ty) });
  const centre = n => ({ x: Math.floor(n.x ?? n.tx) + 0.5, y: Math.floor(n.y ?? n.ty) + 0.5 });

  // ---- component labels (lazy, per stamp)
  let labels = null, labelStamp = null;
  const hasLayers = !!(grid && grid.occ && grid.cost && Number.isInteger(grid.w));
  function labelAt(x, y) {
    if (!hasLayers) return -1;
    const st = stamp(grid);
    if (labelStamp !== st) { labels = componentLabels(grid); labelStamp = st; }
    const lx = x - grid.ox, ly = y - grid.oy;
    if (lx < 0 || ly < 0 || lx >= grid.w || ly >= grid.h) return 0;
    return labels[ly * grid.w + lx];
  }
  /** false only when both ends are free tiles in different components (a blocked start can still walk off). */
  function maybeReachable(a, b) {
    const lb = labelAt(b.x, b.y);
    if (lb === -1) return true;
    if (lb === 0) return false;
    const la = labelAt(a.x, a.y);
    return la === 0 || la === lb;
  }

  const ao = o => o?.astarOpts ?? {};
  const short = (a, b, o) => astar(grid, a, b, ao(o));

  /** Nearby graph nodes joined by a bounded local A* (start side: from a; end side: to b). */
  /** { id, leg } for the first candidate node joined by a bounded A*; CAPPED when every tried candidate failed (in the
   *  same component, so the bounded search ran out of nodes); null when no candidate could be tried. */
  function legTo(g, a, roadsOnly, o, reverse) {
    const ids = candidates(g, a.x, a.y, roadsOnly);
    let tried = 0;
    for (const id of ids) {
      const c = centre(g.nodes[id]), t = tile(c);
      if (labels && labelAt(t.x, t.y) > 0 && labelAt(a.x, a.y) > 0 && labelAt(t.x, t.y) !== labelAt(a.x, a.y)) continue;
      const leg = reverse ? astar(grid, t, a, { maxNodes: LEG_MAX_NODES, ...ao(o) }) : astar(grid, a, t, { maxNodes: LEG_MAX_NODES, ...ao(o) });
      tried++;
      if (leg) return { id, leg };
    }
    return tried ? CAPPED : null;
  }
  // failed (capped) end legs by end tile, dropped when the grid stamp changes or on invalidate()
  const legFails = new Map();
  let legFailStamp = null;
  function legFailed(key) {
    const st = stamp(grid);
    if (legFailStamp !== st) { legFails.clear(); legFailStamp = st; }
    return legFails.has(key);
  }
  function failLeg(key) {
    legFails.set(key, true);
    while (legFails.size > LEG_FAIL_LRU) legFails.delete(legFails.keys().next().value);
  }
  // node buckets (BUCKET tiles square) for candidate lookups, rebuilt with the graph
  const BUCKET = 16, bucketKey = (bx, by) => bx * 0x100000 + by;   // numeric keys: bucket coords stay far below 2^20
  let buckets = null, bucketGraph = null;
  function bucketsOf(g) {
    if (bucketGraph === g) return buckets;
    bucketGraph = g; buckets = new Map();
    g.nodes.forEach((nd, i) => {
      const c = centre(nd), k = bucketKey(Math.floor(c.x / BUCKET), Math.floor(c.y / BUCKET));
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(i);
    });
    return buckets;
  }
  /** Up to NODE_CANDIDATES node ids within NODE_RADIUS (nearest first, ties by id); else the graph's nearest node. */
  function candidates(g, x, y, roadsOnly) {
    const nodes = g.nodes, near = [];
    if (!roadsOnly && Array.isArray(nodes) && nodes.length > 1) {
      const B = bucketsOf(g), r2 = NODE_RADIUS * NODE_RADIUS;
      const bx0 = Math.floor((x - NODE_RADIUS) / BUCKET), bx1 = Math.floor((x + NODE_RADIUS + 1) / BUCKET);
      const by0 = Math.floor((y - NODE_RADIUS) / BUCKET), by1 = Math.floor((y + NODE_RADIUS + 1) / BUCKET);
      for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
        const list = B.get(bucketKey(bx, by));
        if (list) for (const i of list) {
          const c = centre(nodes[i]), d = (c.x - 0.5 - x) ** 2 + (c.y - 0.5 - y) ** 2;
          if (d <= r2) near.push([d, i]);
        }
      }
    }
    if (near.length) { near.sort((p, q) => p[0] - q[0] || p[1] - q[1]); return near.slice(0, NODE_CANDIDATES).map(e => e[1]); }
    const first = g.nearestNode(x, y, roadsOnly ? { roadsOnly: true } : undefined);
    return first == null ? [] : [first];
  }
  function roadLine(g, na, nb, roadsOnly, lanes) {
    const key = `${na}|${nb}|${roadsOnly ? 1 : 0}${lanes ? 1 : 0}`;
    if (routes.has(key)) { const r = routes.get(key); routes.delete(key); routes.set(key, r); return r; }
    const ro = roadsOnly ? { roadsOnly: true } : undefined;
    const ids = na === nb ? [na] : g.route(na, nb, ro);
    let line = null;
    if (ids && ids.length) {
      if (typeof g.polyline === 'function') line = g.polyline(ids, ro);
      else { const pts = []; for (const id of ids) { const c = centre(g.nodes[id]); pts.push(c.x, c.y); } line = Float32Array.from(pts); }
      if (line && lanes) line = laneOffset(line);
    }
    routes.set(key, line);
    while (routes.size > ROUTE_LRU) routes.delete(routes.keys().next().value);
    return line;
  }

  function viaRoads(a, b, o) {
    const g = getGraph(), roadsOnly = !!o.roadsOnly, lanes = o.lanes !== false;
    if (roadsOnly) {
      const na = g.nearestNode(a.x, a.y, { roadsOnly: true }), nb = g.nearestNode(b.x, b.y, { roadsOnly: true });
      if (na == null || nb == null) return null;
      return roadLine(g, na, nb, true, lanes);
    }
    // A capped end leg means the tile sits behind a detour longer than the leg budget; the plain grid A* fallback then
    // almost always runs out of nodes too (5-9 ms on stress), so return null at once and remember the failure for that
    // tile (per world stamp; a leg depends only on its own end, so the far end is not part of the key).
    const cacheable = !o.astarOpts;
    if (cacheable && (legFailed(`s${a.x},${a.y}`) || legFailed(`e${b.x},${b.y}`))) return null;
    const s = legTo(g, a, false, o, false);
    if (s === CAPPED) { if (cacheable) failLeg(`s${a.x},${a.y}`); return null; }
    const e = s && legTo(g, b, false, o, true);
    if (e === CAPPED) { if (cacheable) failLeg(`e${b.x},${b.y}`); return null; }
    if (s && e) {
      const mid = roadLine(g, s.id, e.id, false, lanes);
      if (mid) return concat([s.leg, mid, e.leg]);
    }
    return short(a, b, o);   // no road link: plain grid A*
  }

  function path(from, to, opts = {}) {
    const a = tile(from), b = tile(to);
    if (opts.roadsOnly) return viaRoads(a, b, opts);
    if (!maybeReachable(a, b)) return null;
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= SHORT_MANHATTAN) return short(a, b, opts);
    return viaRoads(a, b, opts);
  }

  // ---- flow fields keyed by destination id, LRU of 8, dropped when the grid changes
  const flows = new Map();
  let flowStamp = stamp(grid);
  const rectCentre = r => ({ x: Math.floor((r.x ?? r.tx) + (r.w ?? 1) / 2), y: Math.floor((r.y ?? r.ty) + (r.h ?? 1) / 2) });
  function targetsFor(destId) {
    if (destId && typeof destId === 'object') return [tile(destId)];
    if (destId === 'square' && world.square) return [rectCentre(world.square)];
    const venue = typeof destId === 'string' && world.venues && Object.prototype.hasOwnProperty.call(world.venues, destId) ? world.venues[destId] : null;
    if (venue && Number.isFinite(venue.tx)) return [{ x: venue.tx, y: venue.ty }];   // world/venue.js: the site anchor
    const o = world.objects?.get?.(destId);
    if (o) return [o.door ? { x: o.door.tx, y: o.door.ty } : rectCentre(o)];
    const site = world.villages?.find?.(v => v.id === destId || v.name === destId);
    if (site?.plaza) return [rectCentre(site.plaza)];
    if (site && Number.isFinite(site.cx)) return [{ x: Math.floor(site.cx), y: Math.floor(site.cy) }];
    return null;
  }
  function flowTo(destId) {
    if (stamp(grid) !== flowStamp) { flows.clear(); flowStamp = stamp(grid); }
    const key = typeof destId === 'object' && destId ? `${destId.x ?? destId.tx},${destId.y ?? destId.ty}` : destId;
    if (flows.has(key)) { const f = flows.get(key); flows.delete(key); flows.set(key, f); return f; }
    const targets = targetsFor(destId);
    if (!targets) return null;
    const f = need(D.flowField, 'flowField', 'flow.js')(grid, targets, { maxCost: Infinity });
    flows.set(key, f);
    while (flows.size > FLOW_LRU) flows.delete(flows.keys().next().value);
    return f;
  }

  // ---- per-tick budget of path requests (§2.5: <= 40 per tick, extras wait)
  let budget = deps.budget ?? DEFAULT_BUDGET;
  let nextTicket = 1;
  const queue = [];            // { ticket, from, to, opts }
  const done = new Map();      // ticket -> path|null
  function request(from, to, opts) { const ticket = nextTicket++; queue.push({ ticket, from, to, opts }); return ticket; }
  function poll(ticket) {
    if (done.has(ticket)) { const r = done.get(ticket); done.delete(ticket); return r; }
    return queue.some(q => q.ticket === ticket) ? 'pending' : null;
  }
  function beginTick(b) {
    if (typeof b === 'number') budget = b;
    for (let served = 0; queue.length && served < budget; served++) {
      const q = queue.shift();
      done.set(q.ticket, path(q.from, q.to, q.opts));
    }
  }
  function invalidate() { labelStamp = null; graph = null; flows.clear(); routes.clear(); legFails.clear(); }

  return {
    path, flowTo, request, poll, beginTick, invalidate,
    reachable: (from, to) => maybeReachable(tile(from), tile(to)),
    get slots() { return getSlots(); }, get graph() { return getGraph(); },
  };
}

export default createNav;
