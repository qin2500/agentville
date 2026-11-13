// Dock walkers: villagers physically walk all the way to the port.
// Crates reach the ships on foot: villagers walk out of town along the roads to the harbour (from
// tier 2, by way of the crate yard to pick a crate up), along the quay to their ship's pier, down the
// pier to the ship, set the crate down, and walk back. Who walks keeps each agent's bucket readable:
//   - a RESTING agent with PRs loading is the porter (the work is done; it is shipping it): from its PR
//     building (or home) to the dock and back, one ship per trip, rotating when it has several;
//   - building agents keep hammering, waiting and stalled ones stay home so their badges show; their
//     ships, and ships whose agent isn't on the map, get a townsperson walking from the town square;
//   - at most CAP walk at once (the rest of the ships simply wait); a walker whose ship sails drops
//     its crate and heads home; with reduced motion nobody walks.
// Pure bookkeeping in world px; dock-art.js draws them with the villager code. Routes are 4-way tile
// walks that keep to the roads (W.path) wherever the roads go, cached per layout.
import { T, R, SQUARE, hash, LOOKS } from './world.js';
import { folds } from './important.js';

export const CAP = 6;          // walkers out at once
const SPEED = 20;              // world px/s
const DROP = 1.2;              // s, setting a crate down on deck
const PICK = 0.9;              // s, picking a crate up in the yard
const REST = [5, 4];           // s at home between trips: base + up to this much more
const OFF_ROAD = 6, TURN = 0.6; // route costs (a road tile is 1)
const rnd = s => (hash(s) % 10000) / 10000;
const key = (x, y) => `${x},${y}`;

// ---------- routes ----------
const routes = new WeakMap();
/**
 * The tiles from `from` to `to` ([x, y] tiles), 4-way, on land and off every footprint: road tiles cost
 * 1, grass OFF_ROAD, and each turn TURN (so walkers keep to streets and don't staircase). Cached per W.
 * [] if there's no way.
 */
export function roadRoute(W, from, to) {
  let m = routes.get(W);
  if (!m) routes.set(W, (m = new Map()));
  const id = `${from}|${to}`;
  if (m.has(id)) return m.get(id);
  const [bx0, by0, bx1, by1] = W.bounds, Wd = bx1 - bx0 + 1, H = by1 - by0 + 1, N = Wd * H * 4;
  const ok = (x, y) => x >= bx0 && y >= by0 && x <= bx1 && y <= by1 && W.land.has(key(x, y)) && !W.fp.has(key(x, y));
  const idx = (x, y, d) => ((y - by0) * Wd + (x - bx0)) * 4 + d;
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let s = k; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === k) break; [heap[s], heap[k]] = [heap[k], heap[s]]; k = s; } } return top; };
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let out = [];
  if (ok(...from) && ok(...to)) {
    for (let d = 0; d < 4; d++) { dist[idx(...from, d)] = 0; push(0, idx(...from, d)); }
    while (heap.length) {
      const [dd, i] = pop();
      if (dd > dist[i]) continue;
      const cell = i >> 2, d = i & 3, x = bx0 + cell % Wd, y = by0 + Math.floor(cell / Wd);
      if (x === to[0] && y === to[1]) {
        for (let k = i; k >= 0; k = prev[k]) { const c = k >> 2; out.push([bx0 + c % Wd, by0 + Math.floor(c / Wd)]); }
        out = out.reverse().filter((p, n, a) => !n || p[0] !== a[n - 1][0] || p[1] !== a[n - 1][1]);
        break;
      }
      DIRS.forEach(([a, b], nd) => {
        const X = x + a, Y = y + b;
        if (!ok(X, Y)) return;
        const c = dd + (W.path.has(key(X, Y)) ? 1 : OFF_ROAD) + (nd === d ? 0 : TURN), j = idx(X, Y, nd);
        if (c < dist[j]) { dist[j] = c; prev[j] = i; push(c, j); }
      });
    }
  }
  m.set(id, out);
  return out;
}

/** A polyline (world px) with its running lengths; `at(s)` is the point s px along and the heading there. */
export function line(pts) {
  const p = pts.filter((q, i) => !i || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]), acc = [0];
  for (let i = 1; i < p.length; i++) acc.push(acc[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const len = acc[acc.length - 1];
  const at = s => {
    s = Math.max(0, Math.min(len, s));
    let i = 1;
    while (i < p.length - 1 && acc[i] < s) i++;
    if (p.length < 2) return { x: p[0][0], y: p[0][1], dx: 0, dy: 0 };
    const k = (s - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1);
    return { x: p[i - 1][0] + (p[i][0] - p[i - 1][0]) * k, y: p[i - 1][1] + (p[i][1] - p[i - 1][1]) * k, dx: p[i][0] - p[i - 1][0], dy: p[i][1] - p[i - 1][1] };
  };
  return { pts: p, len, at };
}

// ---------- who walks, and where they are ----------
/**
 * createWalkers() → step(env) each frame. env: { W, G (harbourGeom), agents (the placed villagers Map),
 * ships: [{ p, berth (its slot key), slot, cy (the ship's middle) }] loading at a berth (oldest first), t (s), still }.
 * Returns the walkers out of doors this frame: { id, agentId?, agent? (its agent record), href, look, x, y (world px feet),
 * z (the deck or quay it stands on), dx, dy (heading), carry, moving }.
 */
export function createWalkers() {
  const walkers = new Map(); // id → state
  let lastT = null;

  // Where a walker starts and ends a trip: an agent at its PR building's door if it has one standing,
  // else its home's door; a townsperson at the bottom of the town square.
  function originOf(W, v, p) {
    if (v) {
      const it = W.items.find(i => i.kind === 'pr' && i.village === v.home.village && String(i.pr) === String(p.id));
      const o = it || v.home;
      return { pt: [o.x * T + R[o.look][5], (o.y + o.h) * T + 10], tile: o.doorTile || [Math.floor((o.x * T + R[o.look][5]) / T), o.y + o.h] };
    }
    const x = SQUARE.x + (SQUARE.w >> 1), y = SQUARE.y + SQUARE.h - 1;
    return { pt: [(x + 0.5) * T, (y + 0.5) * T], tile: [x, y] };
  }
  // The whole trip: origin → roads → (the crate yard, where it picks its crate up; `sp` is how far along
  // that is) → along the quay → down its side of the pier to the ship's middle. Tier 1 has no yard or
  // quay: it carries the crate from home, down the jetty from its foot.
  function tripLine(W, G, origin, ship) {
    const D = W.dock, lane = ship && G.laneById.get(ship.slot.lane), C = ([x, y]) => [(x + 0.5) * T, (y + 0.5) * T];
    if (!lane) return null;
    if (G.yard) {
      const tiles = roadRoute(W, origin.tile, G.yardTile);
      if (!tiles.length) return null;
      const head = [origin.pt, ...tiles.map(C), G.yardPick];
      return { ...line([...head, [G.yardPick[0], G.QL], [lane.walk, G.QL], [lane.walk, ship.cy]]), sp: line(head).len };
    }
    const tiles = roadRoute(W, origin.tile, [D.cx, D.foot]);
    if (!tiles.length) return null;
    return { ...line([origin.pt, ...tiles.map(C), [lane.walk, D.foot * T + 8], [lane.walk, ship.cy]]), sp: 0 };
  }

  function step({ W, G, agents, ships, t, still }) {
    const dt = lastT == null ? 0 : Math.min(0.5, Math.max(0, t - lastT));
    lastT = t;
    if (still || !W.dock) { walkers.clear(); return []; }
    // Who should be walking for which ships.
    const want = new Map();
    for (const { p } of ships) {
      const v = p.agentId != null && agents?.get(p.agentId);
      const porter = v && folds(v.a) && !v.crowd && v.home; // resting, indoors at home: free to carry
      const id = porter ? `agent:${v.a.id}` : `town:${p.href}`;
      if (!want.has(id)) want.set(id, { v: porter ? v : null, ships: [] });
      want.get(id).ships.push(p);
    }
    for (const [id, w] of walkers) {
      const next = want.get(id);
      // An agent that woke up (or left the map) is drawn at home again: its walker is gone at once.
      if (w.v && !next) { const v = agents?.get(w.v.a.id); if (!v || !folds(v.a)) { walkers.delete(id); continue; } }
      w.ships = next ? next.ships : [];
      if (next?.v) w.v = next.v; // the placed villager is rebuilt every poll
    }
    for (const [id, n] of want) {
      if (walkers.has(id) || walkers.size >= CAP) continue;
      const first = n.ships[0], v = n.v;
      walkers.set(id, {
        id, v, ships: n.ships, n: Math.floor(rnd(id) * 7), state: 'home', wait: rnd(`${id}:w`) * 6, s: 0, carry: false, href: null, line: null, origin: originOf(W, v, first),
        look: v ? v.look : LOOKS[hash(first.href) % LOOKS.length],
      });
    }
    // Move everyone.
    const berthOf = new Map(ships.map(s => [s.p.href, s.berth])), shipOf = new Map(ships.map(s => [s.p.href, s]));
    const out = [];
    for (const [id, w] of walkers) {
      const atBerth = w.href != null && berthOf.get(w.href) === w.berth;
      if (w.state === 'home') {
        w.wait -= dt;
        if (!w.ships.length) { walkers.delete(id); continue; } // nothing left to carry: stays in
        if (w.wait > 0) continue;
        const p = w.ships[w.n++ % w.ships.length]; // one ship per trip, in turn
        w.origin = originOf(W, w.v, p);
        w.line = tripLine(W, G, w.origin, shipOf.get(p.href));
        if (!w.line) { w.wait = 10; continue; } // no way there (shouldn't happen): try again later
        Object.assign(w, { state: 'out', s: 0, carry: !w.line.sp, picked: !w.line.sp, href: p.href, berth: berthOf.get(p.href) });
      } else if (w.state === 'out') {
        if (!atBerth) { w.carry = false; w.state = 'back'; } // its ship sailed: drop the crate, head home
        else if (!w.picked && w.s + SPEED * dt >= w.line.sp) { w.s = w.line.sp; w.state = 'pick'; w.wait = PICK; }
        else if ((w.s += SPEED * dt) >= w.line.len) { w.s = w.line.len; w.state = 'drop'; w.wait = DROP; }
      } else if (w.state === 'pick') {
        if (!atBerth) { w.state = 'back'; }
        else if ((w.wait -= dt) <= 0) { w.picked = true; w.carry = true; w.state = 'out'; }
      } else if (w.state === 'drop') {
        if ((w.wait -= dt) <= 0 || !atBerth) { w.carry = false; w.state = 'back'; }
      } else if (w.state === 'back' && (w.s -= SPEED * dt) <= 0) {
        w.state = 'home'; w.wait = REST[0] + rnd(`${id}:${w.n}`) * REST[1]; w.href = null;
        continue;
      }
      if (w.state === 'home') continue;
      const q = w.line.at(w.s), back = w.state === 'back';
      out.push({
        id, agentId: w.v?.a.id ?? null, agent: w.v?.a ?? null, href: w.href, look: w.look, x: q.x, y: q.y, dx: back ? -q.dx : q.dx, dy: back ? -q.dy : q.dy,
        z: G.zAt(q.x, q.y), carry: w.carry, moving: w.state !== 'drop' && w.state !== 'pick',
      });
    }
    return out;
  }
  return { step, debug: () => [...walkers.values()].map(w => ({ id: w.id, state: w.state, ships: w.ships.map(p => p.href), href: w.href, s: Math.round(w.s), len: w.line ? Math.round(w.line.len) : null })) };
}
