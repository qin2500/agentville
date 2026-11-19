// Stamps one settlement plan into the grid and legalises its props (design §1.3 step 3). Pure.
import { hash } from '../core/rng.js';
import { ROAD } from '../core/grid.js';
import { MOD_CODE_MAX } from '../mod/api.js';
import { footprintFor, originTile } from './footprints.js';

/** @typedef {{ kind: 'drop'|'nudge'|'overlap'|'covered-forecourt'|'blocked-door', id: string, project: string, reason: string, from?: [number, number], to?: [number, number] }} LintEntry */

const ROAD_BY_NUM = [ROAD.NONE, ROAD.PATH, ROAD.LANE, ROAD.STREET, ROAD.MAIN];   // TerrainType.road is the ROAD value (1..4)
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Scratch buffers shared by the graph helpers below (none of them re-enters another, so one set serves every plan).
let SN = 0, DISC = new Int32Array(0), LOW = new Int32Array(0), STK = new Int32Array(0), PAR = new Int32Array(0), KS = new Uint8Array(0);
let QUE = new Int32Array(0), VIS = new Int32Array(0), MEM = new Int32Array(0), GEN = 0;
function scratch(N) {
  if (N + 1 <= SN) return;
  SN = Math.max(N + 1, SN * 2);
  DISC = new Int32Array(SN); LOW = new Int32Array(SN); STK = new Int32Array(SN + 1); PAR = new Int32Array(SN + 1); KS = new Uint8Array(SN + 1);
  QUE = new Int32Array(SN); VIS = new Int32Array(SN); MEM = new Int32Array(SN); GEN = 0;
}
function genRoom(k) { if (GEN + k >= 0x3fffffff) { VIS.fill(0); MEM.fill(0); GEN = 0; } }   // then ++GEN, k times at most

/** Articulation points of the walkable-tile graph (4-connected, plus a virtual node joined to every walkable tile on
 * the plan's edge = the gates). Iterative Tarjan. @returns {Uint8Array} 1 where removing the tile cuts a tile off. */
function cutVertices(W, H, walk, eb, cut = new Uint8Array(W * H)) {
  const N = W * H, V = N;
  scratch(N);
  const disc = DISC, low = LOW, U = STK, P = PAR, K = KS;
  disc.fill(-1, 0, N + 1);
  cut.fill(0);
  let t = 0, top = 0, g = 0;   // g: the next gate to try from V (gates in index order: row 0, the side columns, row H-1)
  U[0] = V; P[0] = -1; K[0] = 0;
  disc[V] = low[V] = t++;
  while (top >= 0) {
    const u = U[top];
    let v = -2;
    if (u === V) {
      while (g < N) {
        const i = g, x = i % W;
        g = (i < W || i >= N - W) ? i + 1 : (x === 0 ? (W > 1 ? i + W - 1 : i + 1) : i - x + W);
        if (walk[i]) { v = i; break; }
      }
    } else {
      const y = (u / W) | 0, x = u - y * W, e = eb[u];
      let k = K[top];
      while (k < 5) {
        const kk = k++;
        if (kk === 0) { if (x + 1 < W && walk[u + 1] && !(e & 2)) { v = u + 1; break; } }
        else if (kk === 1) { if (x > 0 && walk[u - 1] && !(e & 8)) { v = u - 1; break; } }
        else if (kk === 2) { if (y + 1 < H && walk[u + W] && !(e & 4)) { v = u + W; break; } }
        else if (kk === 3) { if (y > 0 && walk[u - W] && !(e & 1)) { v = u - W; break; } }
        else if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { v = V; break; }
      }
      K[top] = k;
    }
    if (v !== -2) {
      if (v === P[top]) continue;
      if (disc[v] >= 0) { if (disc[v] < low[u]) low[u] = disc[v]; continue; }
      disc[v] = low[v] = t++;
      U[++top] = v; P[top] = u; K[top] = 0;
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

/** Number of walkable tiles reachable from the gates (4-neighbour). With `mark`, also sets mark[i] = 1 exactly on them. */
function reachable(W, H, walk, eb, mark) {
  const N = W * H;
  scratch(N); genRoom(1);
  const q = QUE, g = ++GEN, seen = VIS;
  let n = 0;
  if (mark) mark.fill(0);
  for (let i = 0; i < N;) {
    if (walk[i]) { seen[i] = g; q[n++] = i; }
    const x = i % W;
    i = (i < W || i >= N - W) ? i + 1 : (x === 0 ? (W > 1 ? i + W - 1 : i + 1) : i - x + W);
  }
  for (let h = 0; h < n; h++) {
    const u = q[h], y = (u / W) | 0, x = u - y * W, e = eb[u];
    if (x + 1 < W && walk[u + 1] && seen[u + 1] !== g && !(e & 2)) { seen[u + 1] = g; q[n++] = u + 1; }
    if (x > 0 && walk[u - 1] && seen[u - 1] !== g && !(e & 8)) { seen[u - 1] = g; q[n++] = u - 1; }
    if (y + 1 < H && walk[u + W] && seen[u + W] !== g && !(e & 4)) { seen[u + W] = g; q[n++] = u + W; }
    if (y > 0 && walk[u - W] && seen[u - W] !== g && !(e & 1)) { seen[u - W] = g; q[n++] = u - W; }
  }
  if (mark) for (let h = 0; h < n; h++) mark[q[h]] = 1;
  return n;
}

const SEARCH_BUDGET = 192;
/** Are the member tiles mem[0..nm) (and the gates' virtual node, when hasV) all joined in the walkable graph as it is
 *  now? A bounded local search: 1 yes, 0 provably not, -1 unknown (the caller then runs the full computation).
 *  Every member must be walkable. Reaching any gate tile reaches the virtual node. */
function linked(W, H, walk, eb, mem, nm, hasV) {
  if (nm === 0 || (nm === 1 && !hasV)) return 1;
  scratch(W * H); genRoom(nm + 2);
  const q = QUE, vis = VIS, ms = MEM, gm = ++GEN;
  for (let j = 0; j < nm; j++) ms[mem[j]] = gm;
  // search 1, from mem[0]: until every member and (when hasV) a gate is found, or the budget runs out
  const g1 = ++GEN;
  let n = 1, found = 1, v1 = false, done1 = false;
  q[0] = mem[0]; vis[mem[0]] = g1;
  for (let h = 0; h < n; h++) {
    if (h >= SEARCH_BUDGET) { done1 = false; break; }
    const u = q[h], y = (u / W) | 0, x = u - y * W, e = eb[u];
    if (!v1 && (x === 0 || y === 0 || x === W - 1 || y === H - 1)) v1 = true;
    if (found === nm && (!hasV || v1)) return 1;
    if (x + 1 < W && walk[u + 1] && vis[u + 1] !== g1 && !(e & 2)) { vis[u + 1] = g1; q[n++] = u + 1; if (ms[u + 1] === gm) found++; }
    if (x > 0 && walk[u - 1] && vis[u - 1] !== g1 && !(e & 8)) { vis[u - 1] = g1; q[n++] = u - 1; if (ms[u - 1] === gm) found++; }
    if (y + 1 < H && walk[u + W] && vis[u + W] !== g1 && !(e & 4)) { vis[u + W] = g1; q[n++] = u + W; if (ms[u + W] === gm) found++; }
    if (y > 0 && walk[u - W] && vis[u - W] !== g1 && !(e & 1)) { vis[u - W] = g1; q[n++] = u - W; if (ms[u - W] === gm) found++; }
    if (h === n - 1) done1 = true;   // the queue ran dry: search 1 saw its whole component
  }
  if (found === nm && (!hasV || v1)) return 1;
  if (done1 && !v1) return 0;          // mem[0]'s component is closed, reaches no gate and misses a member or the gates
  if (hasV && !v1 && !done1) return -1;
  // each member search 1 did not see: joined when it walks into search 1's tiles, or reaches a gate while search 1 did
  for (let j = 1; j < nm; j++) {
    const s = mem[j];
    if (vis[s] === g1) continue;
    const g = ++GEN;
    let m = 1, ok = false, vj = false, closed = false;
    q[0] = s; vis[s] = g;
    for (let h = 0; h < m && !ok; h++) {
      if (h >= SEARCH_BUDGET) break;
      const u = q[h], y = (u / W) | 0, x = u - y * W, e = eb[u];
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { vj = true; if (v1) { ok = true; break; } }
      for (let k = 0; k < 4; k++) {
        let w;
        if (k === 0) { if (x + 1 >= W || (e & 2)) continue; w = u + 1; }
        else if (k === 1) { if (x <= 0 || (e & 8)) continue; w = u - 1; }
        else if (k === 2) { if (y + 1 >= H || (e & 4)) continue; w = u + W; }
        else { if (y <= 0 || (e & 1)) continue; w = u - W; }
        if (!walk[w]) continue;
        if (vis[w] === g1) { ok = true; break; }
        if (vis[w] !== g) { vis[w] = g; q[m++] = w; }
      }
      if (!ok && h === m - 1) closed = true;
    }
    if (ok) continue;
    if (closed && !vj) return 0;       // a closed component without a gate, apart from mem[0]'s: not joined
    if (closed && vj && done1) return 0;   // joined to the gates while mem[0]'s closed component is not (v1 false here)
    return -1;
  }
  return 1;
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

// per ground code: 1 walk, 2 water (from the mod's terrain tags; a later entry for a code replaces an earlier one)
function groundFlags(mod) {
  const T = new Array(256).fill(null), F = new Uint8Array(256);
  for (const t of mod.terrain.types) if (t.code > 0 && t.code < 256) T[t.code] = t;
  for (let c = 0; c < 256; c++) F[c] = (T[c]?.tags?.includes('walk') ? 1 : 0) | (T[c]?.tags?.includes('water') ? 2 : 0);
  return F;
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
  const RD = T.map((_, c) => roadOf(c));   // roadOf per code (a code outside 0..255 has none)
  let forged = 0;   // plan ground codes in the engine-reserved range (> MOD_CODE_MAX) are dropped, so a plan cannot forge HUB/VENUE
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = OX + x, wy = OY + y, code = plan.ground[y * W + x];
    grid.set('lot', wx, wy, ctx.index);
    if (code === 0) continue;   // no ground
    if (code > MOD_CODE_MAX) { if (!forged++ && lint) lint.push({ kind: 'forged-ground', id: `plan:${ctx.name}`, project: ctx.name, reason: `plan ground code ${code} is engine-reserved (> ${MOD_CODE_MAX}); dropped`, from: [wx, wy] }); continue; }
    grid.set('ground', wx, wy, code);
    const road = RD[code];
    if (road) grid.set('road', wx, wy, road);
  }
}

// A grid and object store that accept everything (the dry stamp of a nested plan touches nothing real).
const DRY_GRID = Object.freeze({ set() {}, stamp() { return { ok: true }; }, canPlace() { return true; } });
const dryObjects = () => ({ add() { return 1; }, delete() {} });
/** For a plan with plan.nest = { plan: older, dx, dy } whose props start with the older plan's props (same kind, variant
 *  and tile + offset): the older plan's props as a dry stamp of it places them (by prop id, fence segments together) and
 *  their lint. Else null (the plan is legalised on its own, as before). */
function nestedReplay(plan, origin, ctx) {
  const N = plan.nest, NP = N?.plan;
  if (!NP || !Number.isInteger(N.dx) || !Number.isInteger(N.dy) || !Array.isArray(NP.props) || !Array.isArray(plan.props)) return null;
  if (NP.props.length > plan.props.length) return null;
  for (let i = 0; i < NP.props.length; i++) {
    const a = NP.props[i], b = plan.props[i];
    if (a.kind !== b.kind || (a.v | 0) !== (b.v | 0) || a.x + N.dx !== b.x || a.y + N.dy !== b.y || a.dir !== b.dir || a.len !== b.len) return null;
  }
  const dry = stampCore(DRY_GRID, dryObjects(), NP, { x: origin.x + N.dx, y: origin.y + N.dy }, { ...ctx, cache: null }, null);
  const base = id => {   // the id without a trailing .<digits> (a fence segment's suffix)
    const s = String(id), d = s.lastIndexOf('.');
    if (d < 0 || d === s.length - 1) return s;
    for (let j = d + 1; j < s.length; j++) { const c = s.charCodeAt(j); if (c < 48 || c > 57) return s; }
    return s.slice(0, d);
  };
  const objs = new Map(), lint = new Map();
  for (const o of dry.objects) if (o.kind !== 'building') { const k = base(o.id); if (!objs.has(k)) objs.set(k, []); objs.get(k).push(o); }
  for (const l of dry.lint) { if (!String(l.id).startsWith('prop:')) continue; const k = base(l.id); if (!lint.has(k)) lint.set(k, []); lint.get(k).push(l); }
  return { n: NP.props.length, objs, lint };
}

function stampCore(grid, objects, plan, origin, ctx, rec) {
  const { w: W, h: H } = plan, OX = origin.x, OY = origin.y, proj = ctx.name;
  const mod = ctx.mod;
  if (!mod?.terrain || !mod?.objects) throw new Error('engine: stampPlan needs ctx.mod with terrain and objects tables');
  // ground classes from the mod's terrain table: tags 'walk' (walkable), 'water', and the road class written to the road layer
  const FL = groundFlags(mod);   // FL[code] & 1: walkable, & 2: water
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
  // Optional mod hook hooks.lotVariants(lots, projectKey, { w, h, nest }) -> Map<lotId, 0..63>: how each lot is DRAWN (art only;
  // footprints and positions never change). A throwing hook or a bad answer keeps hash(id) % 16.
  let lotVariant = null;
  try { const m = mod.hooks?.lotVariants?.(plan.lots, proj, { w: W, h: H, nest: plan.nest ?? null }); if (m instanceof Map) lotVariant = m; } catch { lotVariant = null; }
  const building = (id, look, b, extra) => {
    const obj = { id, kind: 'building', model: look, tx: OX + b.x, ty: OY + b.y, w: b.w, h: b.h, z: mod.objects.buildings?.[look]?.z ?? 40, walk: 'block',
      project: proj, styleKey: `${look}|${styleKey}`, variant: hash(id) % 16, ...extra };
    const lv = extra?.lot != null && id.startsWith('lot:') ? lotVariant?.get(String(extra.lot)) : undefined;
    if (Number.isInteger(lv) && lv >= 0 && lv < 64) obj.variant = lv;
    if (b.doorX != null) {
      obj.door = { tx: OX + b.x + Math.floor(b.doorX / 16), ty: OY + b.y + b.h, face: 'S' };
      for (const [dx, dy] of [[0, 0], [1, 1], [2, 2]]) { const px = obj.door.tx - OX + dx, py = obj.door.ty - OY + dy; if (inPlan(px, py)) protect[py * W + px] = 1; }
    }
    for (let j = b.y; j < b.y + b.h; j++) for (let i = b.x; i < b.x + b.w; i++) if (inPlan(i, j)) foot[j * W + i] = 1;
    const r = put(obj);
    if (!r.ok) note('overlap', id, 'building footprint overlaps another object', [obj.tx, obj.ty]);
  };
  for (const l of plan.lots) building(`lot:${proj}:${l.id}`, l.look, l, { lot: l.id, rank: l.rank });
  // parity: lots.civic-landmarks-per-tier
  for (const c of plan.civic || []) building(`civic:${proj}:${c.id}`, c.look, c, { lot: c.id });

  // 3. props, legalised
  const N = W * H;
  const walk = new Uint8Array(N);   // walkable ground, minus tiles a blocking prop has taken
  for (let i = 0; i < N; i++) walk[i] = (FL[plan.ground[i]] & 1) && !foot[i] ? 1 : 0;
  const walkable0 = walk.slice();
  const eb = new Uint8Array(N);
  // Connectivity, answered exactly but locally where it can be (see linked()), else by the full pass:
  // - rm marks the tiles reachable from the gates and trueR counts them; both hold while rmOk (local proofs keep them);
  // - reach is the plan's running count (it starts true and drops by one per walkable tile taken);
  // - cutAt(i) is what the per-plan articulation array would say: it is recomputed only when cutDirty, so between a
  //   recompute and the next change that sets cutDirty it is frozen. A one-tile take inside an open 3x3 ring with no
  //   fence edges in it cannot change the articulation points (any route through it goes round the ring), so the frozen
  //   array equals the live answer there; any other such take freezes a real array (frozen) until cutDirty is next set.
  const rm = new Uint8Array(N);
  let trueR = reachable(W, H, walk, eb, rm), rmOk = true, reach = trueR;
  let cutDirty = false, frozen = false, cutArr = null, cutVer = -1, ver = 0;
  let memVer = null, memVal = null;   // cutAt answers for graph version ver (made on first use)
  let nb = new Int32Array(64);   // member list scratch for linked()
  const isGateI = i => { const y = (i / W) | 0, x = i - y * W; return x === 0 || y === 0 || x === W - 1 || y === H - 1; };
  const fullCut = () => { cutArr = cutVertices(W, H, walk, eb, cutArr || new Uint8Array(N)); cutVer = ver; return cutArr; };
  const ensureRm = () => { if (!rmOk) { trueR = reachable(W, H, walk, eb, rm); rmOk = true; } };
  // the walkable neighbours tile i may step to, into nb from offset o; returns the new end
  const stepsFrom = (i, o) => {
    const y = (i / W) | 0, x = i - y * W, e = eb[i];
    if (x + 1 < W && walk[i + 1] && !(e & 2)) nb[o++] = i + 1;
    if (x > 0 && walk[i - 1] && !(e & 8)) nb[o++] = i - 1;
    if (y + 1 < H && walk[i + W] && !(e & 4)) nb[o++] = i + W;
    if (y > 0 && walk[i - W] && !(e & 1)) nb[o++] = i - W;
    return o;
  };
  const cutAt = i => {
    if (cutDirty) { cutDirty = false; frozen = false; }   // the array would be recomputed now, on the live graph
    if (frozen) return cutArr[i];
    if (cutVer === ver) return cutArr[i];
    if (!memVer) { memVer = new Int32Array(N).fill(-1); memVal = new Uint8Array(N); }
    if (memVer[i] === ver) return memVal[i];
    let r;
    if (!walk[i]) r = 0;
    else {
      ensureRm();
      if (!rm[i]) r = 0;
      else {
        walk[i] = 0;
        const nm = stepsFrom(i, 0), l = linked(W, H, walk, eb, nb, nm, isGateI(i));
        walk[i] = 1;
        r = l === 1 ? 0 : l === 0 ? 1 : fullCut()[i];
      }
    }
    memVer[i] = ver; memVal[i] = r;
    return r;
  };
  // the reachable count once the walkable tiles S[0..n) (already set unwalkable) are gone; -1 when not provable locally
  let SM = null, smGen = 0;
  const countWithout = (S, n) => {
    let nr = 0, hasV = false, nm = 0;
    if (!SM) SM = new Int32Array(N);
    if (nb.length < 4 * n + 8) nb = new Int32Array(4 * n + 8);
    const g = ++smGen;
    for (let j = 0; j < n; j++) SM[S[j]] = g;
    for (let j = 0; j < n; j++) {
      const s = S[j];
      if (!rm[s]) continue;
      nr++;
      if (isGateI(s)) hasV = true;
      const e = stepsFrom(s, nm);
      for (let k = nm; k < e; k++) if (SM[nb[k]] !== g) { SM[nb[k]] = g; nb[nm++] = nb[k]; }
    }
    if (!nr) return trueR;
    if (!nm && !hasV) return -1;
    return linked(W, H, walk, eb, nb, nm, hasV) === 1 ? trueR - nr : -1;
  };
  // an edge just blocked between tiles a and b (b may be outside the plan, -1): the new reachable set is rm unchanged?
  const edgeKeeps = (a, b) => b < 0 || !walk[a] || !walk[b] || !rm[a] || (nb[0] = a, nb[1] = b, linked(W, H, walk, eb, nb, 2, false) === 1);
  const taken = new Uint8Array(N);  // tiles a blocking prop has taken in this plan
  const isFree = (x, y) => inPlan(x, y) && !foot[y * W + x] && !taken[y * W + x] && !(FL[plan.ground[y * W + x]] & 2);
  const openRing = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!inPlan(x + dx, y + dy) || !walk[(y + dy) * W + x + dx]) return false; return true; };
  const ringFree = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (eb[(y + dy) * W + x + dx]) return false; return true; };
  const isEdgeTile = (x, y) => N4.some(([dx, dy]) => { const a = x + dx, b = y + dy; return inPlan(a, b) && (!walkable0[b * W + a]); });
  const KS2 = new Int32Array(64);
  // would taking these tiles (all of them) keep every reachable walkable tile reachable?
  const keepsConnected = tiles => {
    const w2 = tiles.filter(([x, y]) => walk[y * W + x]);
    if (!w2.length) return true;
    if (w2.length === 1) return !cutAt(w2[0][1] * W + w2[0][0]);
    ensureRm();
    const S = w2.length <= KS2.length ? KS2 : new Int32Array(w2.length);
    for (let j = 0; j < w2.length; j++) { const i = w2[j][1] * W + w2[j][0]; S[j] = i; walk[i] = 0; }
    let n = countWithout(S, w2.length);
    if (n < 0) n = reachable(W, H, walk, eb);
    for (let j = 0; j < w2.length; j++) walk[S[j]] = 1;
    return n === reach - w2.length;
  };
  const claim = (tiles) => {
    let changed = false, ring = true, nS = 0;
    const S = tiles.length <= KS2.length ? KS2 : new Int32Array(tiles.length);
    if (tiles.length === 1 && !cutDirty && !frozen) {   // a ring take that the frozen array must not see
      const [x, y] = tiles[0];
      if (walk[y * W + x] && openRing(x, y) && !ringFree(x, y)) { if (cutVer !== ver) fullCut(); frozen = true; }
    }
    let quiet = true;   // the live articulation points are unchanged (a one-tile take in a fence-free open ring)
    for (const [x, y] of tiles) {
      taken[y * W + x] = 1;
      if (walk[y * W + x]) { changed = true; if (!openRing(x, y)) ring = false; else if (!ringFree(x, y)) quiet = false; walk[y * W + x] = 0; reach--; S[nS++] = y * W + x; }
    }
    if (!changed) return;
    if (rmOk) { const n = countWithout(S, nS); if (n < 0) rmOk = false; else { trueR = n; for (let j = 0; j < nS; j++) rm[S[j]] = 0; } }
    if (!(tiles.length === 1 && ring)) { cutDirty = true; frozen = false; }
    if (!(tiles.length === 1 && ring && quiet)) ver++;
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

  // M6 nested growth (design decision: growth only adds): a plan that nests an older one (plan.nest = { plan, dx, dy },
  // whose props lead plan.props in the same order) places the older plan's props exactly as that plan placed them on
  // its own: a dry stamp of it decides every nudge, clip and drop, so a re-plan never moves or loses an old prop.
  const replay = nestedReplay(plan, origin, ctx);
  const setEdge = (x, y, side) => {
    const o = side === 'N' ? [0, -1] : side === 'S' ? [0, 1] : side === 'W' ? [-1, 0] : [1, 0], B = { N: 1, E: 2, S: 4, W: 8 }, R = { N: 'S', S: 'N', E: 'W', W: 'E' };
    const a = y * W + x, b = inPlan(x + o[0], y + o[1]) ? (y + o[1]) * W + x + o[0] : -1;
    eb[a] |= B[side];
    if (b >= 0) eb[b] |= B[R[side]];
    if (rmOk && !edgeKeeps(a, b)) rmOk = false;
  };
  const replayProp = id => {
    for (const l of replay.lint.get(id) || []) lint.push({ ...l });
    for (const o of replay.objs.get(id) || []) {
      const x = o.tx - OX, y = o.ty - OY;
      if (o.run) {   // a fence run segment: block its edges as the dry stamp did
        for (let k = 0; k < o.run.len; k++) setEdge(x + (o.run.dir === 'x' ? k : 0), y + (o.run.dir === 'y' ? k : 0), o.run.side);
        cutDirty = true; frozen = false; ver++;
        put(o);
        continue;
      }
      if (o.kind === 'decal' || o.walk === 'floor') { put(o); continue; }
      if (!grid.canPlace(o)) { note('overlap', o.id, 'grid footprint is not free', [o.tx, o.ty]); continue; }
      if (!put(o).ok) { note('overlap', o.id, 'grid stamp conflict', [o.tx, o.ty]); continue; }
      claim(tilesOf(x, y, o));
      if (o.anchors) pending.push(o);
    }
  };

  let pi = -1;
  for (const p of plan.props || []) {
    const i = counter[p.kind] = (counter[p.kind] ?? -1) + 1;
    const id = `prop:${proj}:${p.kind}:${i}`;
    if (replay && ++pi < replay.n) { replayProp(id); continue; }
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
        if (!touches) continue;
        let n, full = false;
        const prevR = rmOk ? trueR : -1;
        if (rmOk && edgeKeeps(y * W + x, inPlan(ox, oy) ? oy * W + ox : -1)) n = trueR;
        else { n = trueR = reachable(W, H, walk, eb, rm); rmOk = true; full = true; }
        // undone: rm still holds when the edge changed nothing (the same count means the same set: it can only shrink)
        if (n !== reach) { set(false); bad[k] = true; if (full && n !== prevR) rmOk = false; }
      }
      cutDirty = true; frozen = false; ver++;
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
    const spotOk = (a, b) => isFree(a, b) && !protect[b * W + a] && walk[b * W + a] && !cutAt(b * W + a);
    const relocate = () => nearest(tx, ty, (a, b) => spotOk(a, b), 3) || nearest(tx, ty, (a, b) => isFree(a, b) && !protect[b * W + a] && !walkable0[b * W + a] && plan.ground[b * W + a] !== 0, 3);
    let doorstep = false;
    if (!(light && single) && tiles.some(([x, y]) => protect[y * W + x])) {
      // a doorstep or forecourt tile must stay clear: a one-tile prop steps aside, anything bigger is dropped
      const to = single && relocate();
      if (!to) { note('drop', id, 'door or forecourt tile must stay clear', from); continue; }
      [tx, ty] = to; reason = 'moved off a doorstep'; doorstep = true;
      tiles = tilesOf(tx, ty, fp);
    }
    if (tiles.some(([x, y]) => foot[x + y * W] || (FL[plan.ground[y * W + x]] & 2))) { note('overlap', id, 'overlaps a building or water', from); continue; }
    if (tiles.some(([x, y]) => taken[y * W + x])) { note('overlap', id, 'overlaps another prop', from); continue; }
    if (light && single) {
      // lamps and banners stand at a street's edge tile, never mid-street, never on a doorstep
      const onDoor = protect[ty * W + tx] === 1;
      if (onDoor || (onWalk && !(isEdgeTile(tx, ty) && !cutAt(ty * W + tx)))) {
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
