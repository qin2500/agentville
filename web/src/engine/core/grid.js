// WorldGrid: the one authoritative grid (design §1.1, R1). Pure, no DOM.
// Layers are flat typed arrays indexed i = (ty - oy) * w + (tx - ox).
import { footprintTiles, edgeRunTiles } from './objects.js';

// Terrain codes 0..15 are the mod's terrain classes (TerrainTable.classes, api.js TerrainClass); the engine names none.
export const ROAD = { NONE: 0, PATH: 1, LANE: 2, STREET: 3, MAIN: 4 };
export const EDGE = { N: 1, E: 2, S: 4, W: 8 };   // N = -y side, E = +x, S = +y, W = -x
export const COST_BLOCKED = 255;
/** The engine-reserved ground codes a layout writes. Ground codes 0..199 belong to the mod's terrain table (api.js
 *  MOD_CODE_MAX); 200..255 are the engine's. EDGE: the ring round a block; VENUE: a venue site (walkable over water);
 *  HUB: the central square; ROUTE: a road or path between them. */
export const LAYOUT_GROUND = Object.freeze({ EDGE: 200, VENUE: 201, HUB: 202, ROUTE: 203 });
/** The reserved lot codes (a settlement index >= 0 inside a block): WILD outside everything, HUB the square, VENUE a venue site. */
export const LOT = Object.freeze({ WILD: -1, HUB: -2, VENUE: -3 });

/** Road class > 0 on ground NONE (a wild path) costs this. */
export const ROAD_COST = 1;
/** Cost of the engine-reserved ground codes 200..203 (LAYOUT_GROUND). */
const ENGINE_GROUND_COST = 1;

/** Build the walk-cost rule for one TerrainTable (api.js). Terrain classes (table.classes) drive the terrain rules.
 *  Priority order, per tile:
 *  occ -> 255; water class -> 255 unless the ground type is tagged 'over-water' (LAYOUT_GROUND.VENUE always is);
 *  ground != 0 -> its table cost (engine codes 200..203 cost 1, unknown codes 255); a wild road -> ROAD_COST;
 *  inside a block (lot >= 0) -> 255; else wild land: table.wildCost on `wild` classes, 255 elsewhere (code 0 / unknown codes: 255).
 *  @returns {(terrain: number, ground: number, road: number, lot: number, occ: number) => number} */
export function makeCostFn(table) {
  if (!table || !Array.isArray(table.types)) throw new Error('engine: makeCostFn needs a TerrainTable { types, byName, wildCost }');
  const lut = new Uint8Array(256).fill(255), over = new Uint8Array(256);
  for (const t of table.types) {
    if (t.code > 0 && t.code < 200) { lut[t.code] = t.cost; if (t.tags?.includes('over-water')) over[t.code] = 1; }
  }
  for (const c of Object.values(LAYOUT_GROUND)) lut[c] = ENGINE_GROUND_COST;
  over[LAYOUT_GROUND.VENUE] = 1;
  const wild = table.wildCost ?? 3;
  const water = new Uint8Array(256), wildLand = new Uint8Array(256);
  for (const c of Array.isArray(table.classes) ? table.classes : []) {   // no classes: no water, no wild land
    if (c.water) water[c.code] = 1;
    if (c.wild) wildLand[c.code] = 1;
  }
  return (terrain, ground, road, lot, occ) => {
    if (occ !== 0) return 255;
    if (water[terrain] && !over[ground]) return 255;
    if (ground !== 0) return lut[ground];
    if (road > 0) return ROAD_COST;
    if (lot >= 0) return 255;
    return wildLand[terrain] ? wild : 255;
  };
}

const LAYERS8 = ['terrain', 'ground', 'road', 'edges', 'cost', 'cover', 'slots'];
const OUTSIDE = { terrain: 0, cost: 255, lot: -1 };
const SIDE_BIT = { N: EDGE.N, E: EDGE.E, S: EDGE.S, W: EDGE.W };
const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
const SIDE_D = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const BIT_INDEX = { 1: 0, 2: 1, 4: 2, 8: 3 };

export class WorldGrid {
  /** @param {{ ox: number, oy: number, w: number, h: number }} r tile rect */
  constructor(r) {
    const { ox = 0, oy = 0, w, h } = r || {};
    if (!Number.isInteger(ox) || !Number.isInteger(oy) || !Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0)
      throw new Error('engine: WorldGrid needs an integer { ox, oy, w, h }');
    Object.assign(this, { ox, oy, w, h, version: 0 });
    const n = w * h;
    for (const k of LAYERS8) this[k] = new Uint8Array(n);
    this.lot = new Int32Array(n).fill(-1);
    this.occ = new Int32Array(n);
    // Reference counts for edge bits set by stamp(), so overlapping runs unstamp exactly. Key: i * 4 + bit index.
    this._edgeRef = new Map();
  }
  /** index or -1 when outside */ idx(tx, ty) {
    const x = tx - this.ox, y = ty - this.oy;
    return x >= 0 && y >= 0 && x < this.w && y < this.h && Number.isInteger(x) && Number.isInteger(y) ? y * this.w + x : -1;
  }
  inBounds(tx, ty) { return this.idx(tx, ty) >= 0; }
  /** layer: a field name above; outside the grid: terrain 0, cost 255, lot -1, others 0 */ get(layer, tx, ty) {
    const i = this.idx(tx, ty);
    if (i < 0) return OUTSIDE[layer] ?? 0;
    return this[layer][i];
  }
  /** returns false when outside. Setting occ or edges bumps version. */ set(layer, tx, ty, v) {
    const i = this.idx(tx, ty);
    if (i < 0) return false;
    this[layer][i] = v;
    if (layer === 'occ' || layer === 'edges') this.version++;
    return true;
  }
  /** true when every footprint tile is inside and free (occ 0) — for walk 'block'; edges: inside only */ canPlace(obj) {
    if (obj.walk === 'edge') return edgeRunTiles(obj).every(t => this.idx(t.tx, t.ty) >= 0);
    const block = obj.walk === 'block';
    for (const [x, y] of footprintTiles(obj)) {
      const i = this.idx(x, y);
      if (i < 0 || (block && this.occ[i] !== 0)) return false;
    }
    return true;
  }
  /** block: occ = num on the footprint; edge: blocks the crossed edge on BOTH tiles; floor: nothing. Bumps version.
   *  Returns { ok, conflicts: number[] }; does not stamp on conflict. conflicts holds the distinct occ numbers in
   *  the way, and -1 when a tile is outside the grid. Re-stamping an object over its own number is not a conflict. */
  stamp(obj, num) {
    if (obj.walk === 'block') {
      const tiles = footprintTiles(obj), idx = [], conflicts = new Set();
      for (const [x, y] of tiles) {
        const i = this.idx(x, y);
        if (i < 0) conflicts.add(-1);
        else if (this.occ[i] !== 0 && this.occ[i] !== num) conflicts.add(this.occ[i]);
        else idx.push(i);
      }
      if (conflicts.size) return { ok: false, conflicts: [...conflicts].sort((a, b) => a - b) };
      for (const i of idx) this.occ[i] = num;
    } else if (obj.walk === 'edge') {
      const run = edgeRunTiles(obj);
      if (!obj.run || run.some(t => this.idx(t.tx, t.ty) < 0)) return { ok: false, conflicts: [-1] };
      for (const t of run) this.#edgeAdd(t, +1);
    }
    this.version++;
    return { ok: true, conflicts: [] };
  }
  unstamp(obj, num) {
    let cleared = 0;
    if (obj.walk === 'block') {
      for (const [x, y] of footprintTiles(obj)) {
        const i = this.idx(x, y);
        if (i >= 0 && this.occ[i] === num) { this.occ[i] = 0; cleared++; }
      }
    } else if (obj.walk === 'edge') {
      for (const t of edgeRunTiles(obj)) if (this.idx(t.tx, t.ty) >= 0) cleared += this.#edgeAdd(t, -1);
    }
    this.version++;
    return { ok: true, cleared };
  }
  // Add or remove one reference to the edge on `t.side` of tile t and its mirror on the neighbour.
  #edgeAdd(t, d) {
    const [dx, dy] = SIDE_D[t.side];
    let n = 0;
    n += this.#bitRef(this.idx(t.tx, t.ty), SIDE_BIT[t.side], d);
    n += this.#bitRef(this.idx(t.tx + dx, t.ty + dy), SIDE_BIT[OPP[t.side]], d);
    return n ? 1 : 0;
  }
  #bitRef(i, bit, d) {
    if (i < 0) return 0;
    const key = i * 4 + BIT_INDEX[bit], ref = this._edgeRef;
    let c = ref.get(key);
    if (c === undefined) c = (this.edges[i] & bit) ? 1 : 0;   // a bit set by hand counts as one owner
    if (d < 0 && c === 0) return 0;
    c += d;
    if (c > 0) { ref.set(key, c); this.edges[i] |= bit; }
    else { ref.delete(key); this.edges[i] &= ~bit; }
    return 1;
  }
  /** occ != 0 or cost == 255 (outside the grid: blocked) */ isBlocked(tx, ty) {
    const i = this.idx(tx, ty);
    return i < 0 || this.occ[i] !== 0 || this.cost[i] === COST_BLOCKED;
  }
  /** dir: an EDGE bit */ edgeBlocked(tx, ty, dir) {
    const i = this.idx(tx, ty);
    return i >= 0 && (this.edges[i] & dir) !== 0;
  }
  // Orthogonal step a -> a + (dx, dy): the target is free and the crossed edge is open (checked on both sides).
  #ortho(ax, ay, dx, dy) {
    const bx = ax + dx, by = ay + dy;
    if (this.isBlocked(bx, by)) return false;
    const out = dx > 0 ? EDGE.E : dx < 0 ? EDGE.W : dy > 0 ? EDGE.S : EDGE.N;
    const back = dx > 0 ? EDGE.W : dx < 0 ? EDGE.E : dy > 0 ? EDGE.N : EDGE.S;
    return !this.edgeBlocked(ax, ay, out) && !this.edgeBlocked(bx, by, back);
  }
  /** 8-way step between neighbours; no corner cutting past a blocked tile or edge. A diagonal step is legal only
   *  when BOTH L-shaped orthogonal routes (via (bx, ay) and via (ax, by)) are legal. The start tile is not checked. */
  canStep(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return false;
    if (dx === 0 || dy === 0) return this.#ortho(ax, ay, dx, dy);
    return this.#ortho(ax, ay, dx, 0) && this.#ortho(bx, ay, 0, dy) && this.#ortho(ax, ay, 0, dy) && this.#ortho(ax, by, dx, 0);
  }
  /** recompute cost from terrain/ground/road/lot/occ (design §1.1 cost column, see makeCostFn) for the whole grid or a
   *  tile rect { ox|x, oy|y, w, h } (clipped to the grid). `costFn` is the world's walk-cost rule, makeCostFn(mod.terrain); the grid itself knows
   *  no ground codes. */ bakeCost(rect, costFn) {
    if (typeof costFn !== 'function') throw new Error('engine: bakeCost needs a cost function (makeCostFn(mod.terrain))');
    let x0 = 0, y0 = 0, x1 = this.w, y1 = this.h;
    if (rect) {
      x0 = Math.max(0, (rect.ox ?? rect.x) - this.ox); y0 = Math.max(0, (rect.oy ?? rect.y) - this.oy);
      x1 = Math.min(this.w, (rect.ox ?? rect.x) - this.ox + rect.w); y1 = Math.min(this.h, (rect.oy ?? rect.y) - this.oy + rect.h);
    }
    const { terrain, ground, road, lot, occ, cost } = this;
    for (let y = y0; y < y1; y++) for (let x = x0, i = y * this.w + x0; x < x1; x++, i++)
      cost[i] = costFn(terrain[i], ground[i], road[i], lot[i], occ[i]);
  }
}
