// Stamps one settlement plan into the grid and legalises its props (design §1.3 step 3). Pure.
import { hash } from '../core/rng.js';
import { ROAD } from '../core/grid.js';
import { MOD_CODE_MAX } from '../mod/api.js';
import { footprintFor, originTile } from './footprints.js';

/** @typedef {{ kind: 'drop'|'nudge'|'overlap'|'covered-forecourt'|'blocked-door', id: string, project: string, reason: string, from?: [number, number], to?: [number, number] }} LintEntry */

const ROAD_BY_NUM = [ROAD.NONE, ROAD.PATH, ROAD.LANE, ROAD.STREET, ROAD.MAIN];   // TerrainType.road is the ROAD value (1..4)
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const EB = [2, 8, 4, 1];   // blocked-edge bit for each N4 step: E, W, S, N (grid.js EDGE)

/** Articulation points of the walkable-tile graph (4-connected, plus a virtual node joined to every walkable tile on
 * the plan's edge = the gates). Iterative Tarjan. @returns {Uint8Array} 1 where removing the tile cuts a tile off. */
function cutVertices(W, H, walk, eb) {
  const N = W * H, V = N, disc = new Int32Array(N + 1).fill(-1), low = new Int32Array(N + 1), cut = new Uint8Array(N);
  const gates = [];
  for (let i = 0; i < N; i++) if (walk[i] && ((i % W === 0) || (i % W === W - 1) || i < W || i >= N - W)) gates.push(i);
  const U = [V], PAR = [-1], K = [0];
  let t = 0, top = 0;
  disc[V] = low[V] = t++;
  while (top >= 0) {
    const u = U[top];
    let v = -2;
    if (u === V) { const k = K[top]; if (k < gates.length) { v = gates[k]; K[top] = k + 1; } }
    else {
      const x = u % W, y = (u / W) | 0;
      for (let k = K[top]; k < 5 && v === -2; k++) {
        K[top] = k + 1;
        if (k === 4) { if (x === 0 || y === 0 || x === W - 1 || y === H - 1) v = V; continue; }
        const a = x + N4[k][0], b = y + N4[k][1];
        if (a >= 0 && b >= 0 && a < W && b < H && walk[b * W + a] && !(eb[u] & EB[k])) v = b * W + a;
      }
    }
    if (v !== -2) {
      if (v === PAR[top]) continue;
      if (disc[v] >= 0) { if (disc[v] < low[u]) low[u] = disc[v]; continue; }
      disc[v] = low[v] = t++;
      U[++top] = v; PAR[top] = u; K[top] = 0;
    } else {
      top--;
      if (top < 0) break;
      const p = U[top];
      if (low[u] < low[p]) low[p] = low[u];
      if (p !== V && low[u] >= disc[p]) cut[p] = 1;
    }
  }
  return cut;
}

/** Number of walkable tiles reachable from the gates (4-neighbour). */
function reachable(W, H, walk, eb) {
  const seen = new Uint8Array(W * H), q = [];
  for (let i = 0; i < W * H; i++) if (walk[i] && ((i % W === 0) || (i % W === W - 1) || i < W || i >= W * H - W)) { seen[i] = 1; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const x = q[h] % W, y = (q[h] / W) | 0;
    for (const [dx, dy] of N4) { const a = x + dx, b = y + dy; if (a < 0 || b < 0 || a >= W || b >= H) continue; const j = b * W + a; if (walk[j] && !seen[j] && !(eb[q[h]] & EB[N4.findIndex(n => n[0] === dx && n[1] === dy)])) { seen[j] = 1; q.push(j); } }
  }
  return q.length;
}

/** ctx: { mod, name, index, tier, style?, cache? }; mod is a ResolvedMod (terrain tags, objects, building heights). Adds objects to
 * `objects` (ObjectStore) and stamps them. With ctx.cache (world/cache.js) and a plan placeBlocks noted, an unchanged project
 * (same plan key, origin, index, style key and mod) replays its recorded stamp instead of re-legalising its props: the
 * same objects (fresh copies), the same occ numbers, edges, grid version and lint as a fresh stamp.
 * @returns {{ objects: WorldObject[], lint: LintEntry[] }} */
export function stampPlan(grid, objects, plan, origin, ctx) {
  const cache = ctx.cache, pk = cache?.keyOfPlan?.(plan);
  if (!pk || !rectClear(grid, plan, origin)) return stampCore(grid, objects, plan, origin, ctx, null);
  const key = `stamp|${cache.modKey(ctx.mod)}|${JSON.stringify([ctx.name, ctx.index, pk, origin.x, origin.y, styleKeyOf(ctx.style)])}`;
  const e = cache.get(key);
  if (e && e.w === plan.w && e.h === plan.h) {
    stampGround(grid, plan, origin, ctx, null);
    const out = [];
    let diverged = false;
    for (const rec of e.puts) {
      const o = cloneData(rec.obj), num = objects.add(o), r = grid.stamp(o, num), ok = !(r && r.ok === false);
      if (!ok) objects.delete(o.id); else out.push(o);
      if (ok !== rec.ok) diverged = true;
    }
    if (diverged) cache.delete(key);   // cannot happen while the block's rect starts clear; never trust it again
    return { objects: out, lint: cloneData(e.lint) };
  }
  const rec = [], r = stampCore(grid, objects, plan, origin, ctx, rec);
  const OX = origin.x, OY = origin.y, inside = o => o.walk !== 'block' || (o.tx >= OX && o.ty >= OY && o.tx + o.w <= OX + plan.w && o.ty + o.h <= OY + plan.h);
  // only a project that stamps nothing outside its own rect is replayable (it then neither sees nor touches another)
  if (rec.every(p => !p.ok || inside(p.obj))) cache.set(key, { w: plan.w, h: plan.h, puts: rec.map(p => ({ obj: cloneData(p.obj), ok: p.ok })), lint: cloneData(r.lint) });
  return r;
}

const styleKeyOf = style => (style ? String(style.key ?? style.id ?? style.family ?? JSON.stringify(style)) : 'plain');
// a deep copy of plain data (objects, lint): spread keeps the key order, nested objects and arrays are copied too
const cloneData = v => {
  if (Array.isArray(v)) return v.map(cloneData);
  if (!v || typeof v !== 'object') return v;
  const o = { ...v };
  for (const k in o) { const x = o[k]; if (x && typeof x === 'object') o[k] = cloneData(x); }
  return o;
};
/** true when the plan's rect is inside the grid and no object occupies it yet (then a stamp sees only itself). */
function rectClear(grid, plan, origin) {
  const x0 = origin.x - grid.ox, y0 = origin.y - grid.oy;
  if (!Number.isInteger(x0) || !Number.isInteger(y0) || x0 < 0 || y0 < 0 || x0 + plan.w > grid.w || y0 + plan.h > grid.h) return false;
  for (let y = y0; y < y0 + plan.h; y++) for (let i = y * grid.w + x0, e = i + plan.w; i < e; i++) if (grid.occ[i] !== 0) return false;
  return true;
}
// step 1: ground, road class and the block's lot id. Returns the forged-ground lint (or pushes nothing when lint is null).
function stampGround(grid, plan, origin, ctx, lint) {
  const { w: W, h: H } = plan, OX = origin.x, OY = origin.y, mod = ctx.mod;
  const T = new Array(256).fill(null);
  for (const t of mod.terrain.types) if (t.code > 0 && t.code < 256) T[t.code] = t;
  const roadOf = c => { const t = T[c]; return !t?.tags?.includes('walk') ? 0 : ROAD_BY_NUM[t.road] || ROAD.PATH; };
  let forged = 0;   // plan ground codes in the engine-reserved range (> MOD_CODE_MAX) are dropped, so a plan cannot forge HUB/VENUE
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = OX + x, wy = OY + y, code = plan.ground[y * W + x];
    grid.set('lot', wx, wy, ctx.index);
    if (code === 0) continue;   // no ground
    if (code > MOD_CODE_MAX) { if (!forged++ && lint) lint.push({ kind: 'forged-ground', id: `plan:${ctx.name}`, project: ctx.name, reason: `plan ground code ${code} is engine-reserved (> ${MOD_CODE_MAX}); dropped`, from: [wx, wy] }); continue; }
    grid.set('ground', wx, wy, code);
    const road = roadOf(code);
    if (road) grid.set('road', wx, wy, road);
  }
}

function stampCore(grid, objects, plan, origin, ctx, rec) {
  const { w: W, h: H } = plan, OX = origin.x, OY = origin.y, proj = ctx.name;
  const mod = ctx.mod;
  if (!mod?.terrain || !mod?.objects) throw new Error('engine: stampPlan needs ctx.mod with terrain and objects tables');
  // ground classes from the mod's terrain table: tags 'walk' (walkable), 'water', and the road class written to the road layer
  const T = new Array(256).fill(null);
  for (const t of mod.terrain.types) if (t.code > 0 && t.code < 256) T[t.code] = t;
  const isWalk = c => !!T[c]?.tags?.includes('walk'), isWater = c => !!T[c]?.tags?.includes('water');
  const out = [], lint = [];
  const inPlan = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const styleKey = styleKeyOf(ctx.style);

  // 1. ground, road class and the block's lot id
  stampGround(grid, plan, origin, ctx, lint);

  const put = obj => {
    const num = objects.add(obj);
    const r = grid.stamp(obj, num);
    if (r && r.ok === false) { objects.delete(obj.id); if (rec) rec.push({ obj, ok: false }); return r; }
    if (rec) rec.push({ obj, ok: true });
    out.push(obj);
    return { ok: true, conflicts: [] };
  };
  const note = (kind, id, reason, from, to) => lint.push({ kind, id, project: proj, reason, ...(from ? { from } : {}), ...(to ? { to } : {}) });

  // 2. buildings: lots and civic landmarks (geometry independent of who lives there)
  const foot = new Uint8Array(W * H), protect = new Uint8Array(W * H);
  const building = (id, look, b, extra) => {
    const obj = { id, kind: 'building', model: look, tx: OX + b.x, ty: OY + b.y, w: b.w, h: b.h, z: mod.objects.buildings?.[look]?.z ?? 40, walk: 'block',
      project: proj, styleKey: `${look}|${styleKey}`, variant: hash(id) % 16, ...extra };
    if (b.doorX != null) {
      obj.door = { tx: OX + b.x + Math.floor(b.doorX / 16), ty: OY + b.y + b.h, face: 'S' };
      for (const [dx, dy] of [[0, 0], [1, 1], [2, 2]]) { const px = obj.door.tx - OX + dx, py = obj.door.ty - OY + dy; if (inPlan(px, py)) protect[py * W + px] = 1; }
    }
    for (let j = b.y; j < b.y + b.h; j++) for (let i = b.x; i < b.x + b.w; i++) if (inPlan(i, j)) foot[j * W + i] = 1;
    const r = put(obj);
    if (!r.ok) note('overlap', id, 'building footprint overlaps another object', [obj.tx, obj.ty]);
  };
  for (const l of plan.lots) building(`lot:${proj}:${l.id}`, l.look, l, { lot: l.id, rank: l.rank });
  for (const c of plan.civic || []) building(`civic:${proj}:${c.id}`, c.look, c, { lot: c.id });

  // 3. props, legalised
  const walk = new Uint8Array(W * H);   // walkable ground, minus tiles a blocking prop has taken
  for (let i = 0; i < W * H; i++) walk[i] = isWalk(plan.ground[i]) && !foot[i] ? 1 : 0;
  const walkable0 = walk.slice();
  let cutDirty = false, eb = new Uint8Array(W * H), cutArr = cutVertices(W, H, walk, eb), reach = reachable(W, H, walk, eb);
  const getCut = () => { if (cutDirty) { cutArr = cutVertices(W, H, walk, eb); cutDirty = false; } return cutArr; };
  const taken = new Uint8Array(W * H);  // tiles a blocking prop has taken in this plan
  const isFree = (x, y) => inPlan(x, y) && !foot[y * W + x] && !taken[y * W + x] && !isWater(plan.ground[y * W + x]);
  const openRing = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!inPlan(x + dx, y + dy) || !walk[(y + dy) * W + x + dx]) return false; return true; };
  const isEdgeTile = (x, y) => N4.some(([dx, dy]) => { const a = x + dx, b = y + dy; return inPlan(a, b) && (!walkable0[b * W + a]); });
  // would taking these tiles (all of them) keep every reachable walkable tile reachable?
  const keepsConnected = tiles => {
    const w2 = tiles.filter(([x, y]) => walk[y * W + x]);
    if (!w2.length) return true;
    if (w2.length === 1) return !getCut()[w2[0][1] * W + w2[0][0]];
    for (const [x, y] of w2) walk[y * W + x] = 0;
    const ok = reachable(W, H, walk, eb) === reach - w2.length;
    for (const [x, y] of w2) walk[y * W + x] = 1;
    return ok;
  };
  const claim = (tiles) => {
    let changed = false, ring = true;
    for (const [x, y] of tiles) {
      taken[y * W + x] = 1;
      if (walk[y * W + x]) { changed = true; if (!openRing(x, y)) ring = false; walk[y * W + x] = 0; reach--; }
    }
    if (changed && !(tiles.length === 1 && ring)) cutDirty = true;
  };
  const tilesOf = (tx, ty, fp) => { const t = []; for (let j = 0; j < fp.h; j++) for (let i = 0; i < fp.w; i++) t.push([tx + i, ty + j]); return t; };
  const nearest = (x, y, ok, rad = 3) => {
    let best = null, bd = Infinity;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const a = x + dx, b = y + dy, d = dx * dx + dy * dy;
      if (d === 0 || d >= bd || !ok(a, b)) continue;
      best = [a, b]; bd = d;
    }
    return best;
  };
  const counter = {};
  const anchorsOf = (fp, tx, ty) => {
    if (!fp.anchors) return undefined;
    const a = {};
    for (const [k, list] of Object.entries(fp.anchors)) a[k] = list.map(s => ({ tx: OX + tx + s.dx, ty: OY + ty + s.dy, sub: s.sub, face: s.face }));
    return a;
  };
  const pending = [];   // anchors are filtered once every prop is placed

  for (const p of plan.props || []) {
    const i = counter[p.kind] = (counter[p.kind] ?? -1) + 1;
    const id = `prop:${proj}:${p.kind}:${i}`;
    const fp = footprintFor(p, mod.objects);
    const variant = (p.v | 0);
    if (!fp) {   // decal
      const t = originTile(p, { walk: 'floor', w: 1, h: 1 });
      put({ id, kind: 'decal', model: p.kind, tx: OX + t.tx, ty: OY + t.ty, w: 1, h: 1, z: 0, walk: 'floor', project: proj, styleKey, variant });
      continue;
    }
    let { tx, ty } = originTile(p, fp);
    const base = { model: p.kind, w: fp.w, h: fp.h, z: fp.z, walk: fp.walk, project: proj, styleKey, variant };
    const kind = fp.kind === 'tree' ? 'tree' : 'prop';
    const light = fp.snap === 'street-edge';

    if (fp.walk === 'floor') {
      if (inPlan(tx, ty)) put({ id, kind, ...base, tx: OX + tx, ty: OY + ty, ...(fp.dir ? { data: { dir: fp.dir } } : {}) });
      continue;
    }

    if (fp.walk === 'edge') {   // a fence/hedge/railing run: clipped where it would cross a building or a forecourt
      const { dir, len, side } = fp.run;
      const opp = side === 'N' ? [0, -1] : side === 'S' ? [0, 1] : side === 'W' ? [-1, 0] : [1, 0];
      const bad = [];
      for (let k = 0; k < len; k++) {
        const x = tx + (dir === 'x' ? k : 0), y = ty + (dir === 'y' ? k : 0);
        const hit = (a, b) => inPlan(a, b) && (foot[b * W + a] || protect[b * W + a]);
        bad.push(!inPlan(x, y) || hit(x, y) || hit(x + opp[0], y + opp[1]));
      }
      // an edge may not cut a walkable tile off from the gates: try each tile's edge, keep it when reach is unchanged
      const EBIT = { N: 1, E: 2, S: 4, W: 8 }, OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
      for (let k = 0; k < len; k++) {
        if (bad[k]) continue;
        const x = tx + (dir === 'x' ? k : 0), y = ty + (dir === 'y' ? k : 0), ox = x + opp[0], oy = y + opp[1];
        const set = on => { eb[y * W + x] = on ? eb[y * W + x] | EBIT[side] : eb[y * W + x] & ~EBIT[side]; if (inPlan(ox, oy)) eb[oy * W + ox] = on ? eb[oy * W + ox] | EBIT[OPP[side]] : eb[oy * W + ox] & ~EBIT[OPP[side]]; };
        const touches = walk[y * W + x] || (inPlan(ox, oy) && walk[oy * W + ox]);
        set(true);
        if (touches && reachable(W, H, walk, eb) !== reach) { set(false); bad[k] = true; }
      }
      cutDirty = true;
      let seg = 0, k = 0;
      const clipped = bad.some(Boolean);
      while (k < len) {
        if (bad[k]) { k++; continue; }
        let e = k; while (e < len && !bad[e]) e++;
        const n = e - k, sx = tx + (dir === 'x' ? k : 0), sy = ty + (dir === 'y' ? k : 0);
        put({ id: seg ? `${id}.${seg}` : id, kind: 'prop', ...base, tx: OX + sx, ty: OY + sy, w: dir === 'x' ? n : 1, h: dir === 'y' ? n : 1,
          run: { dir, len: n, side } });
        seg++; k = e;
      }
      if (clipped) note('nudge', id, seg ? 'run clipped to avoid a building, a doorstep or a through-route' : 'run dropped: entirely inside a building or doorstep', [OX + tx, OY + ty], seg ? [OX + tx, OY + ty] : undefined);
      continue;
    }

    // walk 'block'
    const from = [OX + tx, OY + ty];
    let tiles = tilesOf(tx, ty, fp), reason = null;
    const single = tiles.length === 1;
    const onWalk = tiles.some(([x, y]) => walkable0[y * W + x]);
    if (tiles.some(([x, y]) => !inPlan(x, y))) { note('drop', id, 'outside the plot', from); continue; }
    const spotOk = (a, b) => isFree(a, b) && !protect[b * W + a] && walk[b * W + a] && !getCut()[b * W + a];
    const relocate = () => nearest(tx, ty, (a, b) => spotOk(a, b), 3) || nearest(tx, ty, (a, b) => isFree(a, b) && !protect[b * W + a] && !walkable0[b * W + a] && plan.ground[b * W + a] !== 0, 3);
    let doorstep = false;
    if (!(light && single) && tiles.some(([x, y]) => protect[y * W + x])) {
      // a doorstep or forecourt tile must stay clear: a one-tile prop steps aside, anything bigger is dropped
      const to = single && relocate();
      if (!to) { note('drop', id, 'door or forecourt tile must stay clear', from); continue; }
      [tx, ty] = to; reason = 'moved off a doorstep'; doorstep = true;
      tiles = tilesOf(tx, ty, fp);
    }
    if (tiles.some(([x, y]) => foot[x + y * W] || isWater(plan.ground[y * W + x]))) { note('overlap', id, 'overlaps a building or water', from); continue; }
    if (tiles.some(([x, y]) => taken[y * W + x])) { note('overlap', id, 'overlaps another prop', from); continue; }
    if (light && single) {
      // lamps and banners stand at a street's edge tile, never mid-street, never on a doorstep
      const onDoor = protect[ty * W + tx] === 1;
      if (onDoor || (onWalk && !(isEdgeTile(tx, ty) && !getCut()[ty * W + tx]))) {
        const to = nearest(tx, ty, (a, b) => spotOk(a, b) && isEdgeTile(a, b), 3);
        if (!to) { note('drop', id, 'no street-edge tile near the lamp', from); continue; }
        [tx, ty] = to; reason = 'lamp snapped to the street edge';
      }
    } else if (!doorstep && onWalk && !keepsConnected(tiles)) {
      if (!single) { note('drop', id, 'would cut a through-route', from); continue; }
      // the nearest non-cut walkable tile, else the nearest free open ground beside the route
      const to = nearest(tx, ty, spotOk, 3) || nearest(tx, ty, (a, b) => isFree(a, b) && !protect[b * W + a] && !walkable0[b * W + a] && plan.ground[b * W + a] !== 0, 3);
      if (!to) { note('drop', id, 'on a through-route, no free tile near', from); continue; }
      [tx, ty] = to; reason = 'moved off a through-route';
    }
    tiles = tilesOf(tx, ty, fp);
    const obj = { id, kind, ...base, tx: OX + tx, ty: OY + ty };
    const an = anchorsOf(fp, tx, ty);
    if (an) obj.anchors = an;
    if (!grid.canPlace(obj)) { note('overlap', id, 'grid footprint is not free', from); continue; }
    const r = put(obj);
    if (!r.ok) { note('overlap', id, 'grid stamp conflict', from); continue; }
    claim(tiles);
    if (reason) note('nudge', id, reason, from, [obj.tx, obj.ty]);
    if (an) pending.push(obj);
  }

  // anchors only on tiles people can stand on: walkable ground, not taken by a prop or building
  for (const o of pending) for (const k of Object.keys(o.anchors)) {
    o.anchors[k] = o.anchors[k].filter(s => { const x = s.tx - OX, y = s.ty - OY; return inPlan(x, y) && walkable0[y * W + x] && !taken[y * W + x]; });
    if (!o.anchors[k].length) delete o.anchors[k];
  }
  return { objects: out, lint };
}
