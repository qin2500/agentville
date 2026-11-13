// WorldObject typedef and the object store (design §1.2). Pure, no DOM.
/** @typedef {{
 *  id: string, kind: 'building'|'prop'|'tree'|'decal'|'venue'|'token', model: string,
 *  tx: number, ty: number, w: number, h: number, z: number,
 *  walk: 'block'|'edge'|'floor',
 *  run?: { dir: 'x'|'y', len: number, side: 'N'|'E'|'S'|'W' },
 *  door?: { tx: number, ty: number, face: 'S'|'E' },
 *  anchors?: { stand?: Slot[], work?: Slot[], sit?: Slot[], vend?: Slot[] },
 *  project?: string, lot?: string, rank?: 'L'|'M'|'S', crown?: boolean,
 *  styleKey: string, variant: number, data?: object,
 * }} WorldObject
 * @typedef {{ tx: number, ty: number, sub: 0|1, face: 0|1|2|3 }} Slot
 * Ids (stable geometry, independent of owner): 'lot:<proj>:<lotId>', 'civic:<proj>:<civicId>',
 * 'prop:<proj>:<kind>:<i>', 'tree:<tx>,<ty>'. Who owns it lives in data: { item: 'home:<agentId>'|'pr:<proj>#<n>'|null,
 * owner: 'home'|'pr'|'house', agentId?, pr?, building? }.
 */
export const WALK = { BLOCK: 'block', EDGE: 'edge', FLOOR: 'floor' };
// 'venue': a mod venue's static pieces (world/venue.js); 'token': a PR's marker at a venue berth.
export const KINDS = ['building', 'prop', 'tree', 'decal', 'venue', 'token'];
const SIDES = ['N', 'E', 'S', 'W'];

/** A Map<id, WorldObject> that also numbers objects 1.. (the number is what grid.occ stores).
 *  Numbers come from a monotonic counter and are never reused within the store's life, so a stale occ value
 *  can never point at a different object. set(id, obj) on a new id numbers it too; replacing an id keeps its number. */
export class ObjectStore extends Map {
  #next = 1; #num = new Map(); #byNum = [];
  constructor(entries) { super(); if (entries) for (const [k, v] of entries) this.set(k, v); }
  set(id, obj) {
    if (!this.#num.has(id)) { const n = this.#next++; this.#num.set(id, n); this.#byNum[n] = id; }
    return super.set(id, obj);
  }
  /** @returns {number} num >= 1 */ add(obj) {
    if (!obj || typeof obj.id !== 'string' || !obj.id) throw new Error('engine: ObjectStore.add needs an object with a string id');
    this.set(obj.id, obj);
    return this.#num.get(obj.id);
  }
  /** number of id, or 0 when absent */ numOf(id) { return this.#num.get(id) || 0; }
  /** object for a number, or undefined */ byNum(num) {
    const id = this.#byNum[num];
    return id === undefined ? undefined : this.get(id);
  }
  /** keeps Map semantics (returns boolean) and frees the number */
  delete(id) {
    const n = this.#num.get(id);
    if (n !== undefined) { this.#num.delete(id); this.#byNum[n] = undefined; }
    return super.delete(id);
  }
  clear() { this.#num.clear(); this.#byNum = []; super.clear(); }
}

/** footprint tiles of a walk:'block' object (or any object's w x h rect): Array<[tx, ty]> */
export function footprintTiles(obj) {
  const out = [];
  for (let y = 0; y < obj.h; y++) for (let x = 0; x < obj.w; x++) out.push([obj.tx + x, obj.ty + y]);
  return out;
}

/** tiles and sides an edge run blocks: Array<{ tx, ty, side: 'N'|'E'|'S'|'W' }>.
 *  Run along dir 'x' covers (tx+i, ty), along 'y' (tx, ty+i), for i < len. Side N = -y, E = +x, S = +y, W = -x. */
export function edgeRunTiles(obj) {
  const r = obj.run; if (!r) return [];
  const out = [];
  for (let i = 0; i < r.len; i++) out.push(r.dir === 'x' ? { tx: obj.tx + i, ty: obj.ty, side: r.side } : { tx: obj.tx, ty: obj.ty + i, side: r.side });
  return out;
}

const isInt = v => Number.isInteger(v);
/** [] when valid; else a list of human-readable problems */
export function validateObject(obj) {
  if (!obj || typeof obj !== 'object') return ['not an object'];
  const e = [];
  if (typeof obj.id !== 'string' || !obj.id) e.push('id: non-empty string required');
  if (!KINDS.includes(obj.kind)) e.push(`kind: one of ${KINDS.join('|')}`);
  if (typeof obj.model !== 'string' || !obj.model) e.push('model: non-empty string required');
  if (!isInt(obj.tx) || !isInt(obj.ty)) e.push('tx, ty: integers required');
  if (!isInt(obj.w) || !isInt(obj.h) || obj.w < 1 || obj.h < 1) e.push('w, h: integers >= 1 required');
  if (typeof obj.z !== 'number' || !Number.isFinite(obj.z) || obj.z < 0) e.push('z: finite number >= 0 required');
  if (!Object.values(WALK).includes(obj.walk)) e.push('walk: block|edge|floor');
  if (typeof obj.styleKey !== 'string') e.push('styleKey: string required');
  if (typeof obj.variant !== 'number' || !Number.isFinite(obj.variant)) e.push('variant: number required');
  if (obj.walk === WALK.EDGE) {
    const r = obj.run;
    if (!r) e.push('run: required for walk edge');
    else {
      if (r.dir !== 'x' && r.dir !== 'y') e.push('run.dir: x|y');
      if (!isInt(r.len) || r.len < 1) e.push('run.len: integer >= 1');
      if (!SIDES.includes(r.side)) e.push('run.side: N|E|S|W');
    }
  }
  if (obj.door != null) {
    const d = obj.door;
    if (!isInt(d.tx) || !isInt(d.ty)) e.push('door.tx, door.ty: integers required');
    if (d.face !== 'S' && d.face !== 'E') e.push('door.face: S|E');
  }
  return e;
}
