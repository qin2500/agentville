// Venues: where a world's PRs go (MOD-READY P6; api.js VenueSite, VenueDef). OWNER: P6. Pure, no DOM.
// The layout names venue SITES (LayoutResult.venues: id -> { kind, rect, anchor, data? }); the mod defines venue KINDS
// (mod.venues: kind -> VenueDef). For every site whose kind has a def, buildVenues:
//   1. computes the level: def.level({ prs, states }, prev, ctx), prev = persisted.venues[id].level (same kind);
//   2. plans: def.plan({ site, level }, ctx), memoised on kind + level + site rect/anchor/data + seed;
//   3. validates: objects stay inside site.rect, nodes and berths inside the grid; the rest is dropped with lint;
//   4. stamps the objects (kind 'venue' unless the plan says 'prop'/'decal'/'tree');
//   5. sets world.venues[id] = { id, kind, tx, ty, rect, level, nodes, berths } (frozen; tx/ty = the site anchor, which
//      is where resolvePlace('venue:<id>') goes).
// Berths are assigned per poll with no rebuild (assignBerths / venueAssignments); def.assign may replace the default,
// which is stable first-free with open PRs first. Mod output is untrusted: read through own data properties only,
// copied into engine-built objects; lints never echo a mod-supplied value.
import { validateObject, WALK } from '../core/objects.js';
import { representPr } from '../sim/represent-world.js';

export const VENUE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;          // site ids double as resolvePlace 'venue:<id>' places
const NODE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const BERTH_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/i;
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/i;
const MODEL_RE = /^[a-z][a-z0-9._-]{0,31}$/;
export const LEVEL_MAX = 16;
export const MAX_OBJECTS = 256, MAX_NODES = 64, MAX_BERTHS = 256;
/** Object kinds a venue plan may stamp. */
export const VENUE_OBJECT_KINDS = Object.freeze(['venue', 'prop', 'decal', 'tree']);
/** Berth priority by PR state: open PRs first, so history never keeps a berth from a PR that is open now. */
const PRIORITY = { loading: 0, building: 1, merged: 2, closed: 3 };
const MEMO_MAX = 64;

const plainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const own = (o, k) => { if (!o || typeof o !== 'object') return undefined; const d = Object.getOwnPropertyDescriptor(o, k); return d && 'value' in d ? d.value : undefined; };
const isInt = v => Number.isInteger(v);
const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const defOf = (mod, kind) => {
  const vs = mod?.venues, d = typeof kind === 'string' && hasOwn(vs, kind) ? vs[kind] : null;
  return d && typeof d.level === 'function' && typeof d.plan === 'function' ? d : null;
};
const cleanRect = r => (r && isInt(r.x) && isInt(r.y) && isInt(r.w) && isInt(r.h) && r.w > 0 && r.h > 0 ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);
const inRect = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const inGrid = (grid, x, y) => (grid ? grid.inBounds(x, y) : true);

// ---------------------------------------------------------------- load and level

/** PR specs for a WorldInput, in berth priority order (state, then input order). Lints go to ctx.lint.
 * @returns {Array<{ id: string, state: string, spec: object }>} */
export function prSpecsOf(input, mod, ctx = {}) {
  const prs = Array.isArray(input?.prs) ? input.prs : [];
  const out = prs.map((pr, i) => ({ id: typeof pr?.id === 'string' ? pr.id : '', state: pr?.state, spec: representPr(pr, mod, ctx), i }))
    .filter(p => p.id);
  out.sort((a, b) => (PRIORITY[a.state] ?? 4) - (PRIORITY[b.state] ?? 4) || a.i - b.i);
  return out.map(({ id, state, spec }) => ({ id, state, spec }));
}

/** The load a venue kind carries: prs = every PR represented at a venue of this kind; states: the same, by state. */
export function loadOf(specs, kind) {
  const states = { building: 0, loading: 0, merged: 0, closed: 0 };
  let prs = 0;
  for (const p of specs) if (p.spec.as === 'venue' && p.spec.venue === kind) { prs++; if (p.state in states) states[p.state]++; }
  return Object.freeze({ prs, states: Object.freeze(states) });
}

function runLevel(def, load, prev, ctx, lint, id) {
  let v;
  try { v = def.level(load, prev, ctx); } catch { lint.push({ kind: 'venue-level', venue: id, reason: 'level threw; previous level kept' }); return prev ?? 0; }
  if (isInt(v) && v >= 0 && v <= LEVEL_MAX) return v;
  lint.push({ kind: 'venue-level', venue: id, reason: `level must be an integer 0..${LEVEL_MAX}; previous level kept` });
  return prev ?? 0;
}

/** prev = persisted.venues[id].level (SEAMS P6). An entry the engine wrote names its kind; one naming another kind (the
 *  layout gave the site a new kind) is not this venue's history, so prev is null. An entry without a kind is accepted. */
const prevLevel = (persisted, id, kind) => {
  const p = persisted?.venues?.[id];
  return p && (p.kind === undefined || p.kind === kind) && isInt(p.level) ? p.level : null;
};

/** A short string of every persisted venue's level for this input (the rebuild sig: a level change rebuilds).
 *  Runs only def.level, never plan. '' when there are no venues. */
export function venueSig(input, mod, persisted, ctx = {}) {
  const pv = persisted?.venues;
  if (!pv || typeof pv !== 'object') return '';
  const ids = Object.keys(pv).filter(id => VENUE_ID_RE.test(id) && defOf(mod, pv[id]?.kind)).sort();
  if (!ids.length) return '';
  const specs = prSpecsOf(input, mod, {}), lint = [];
  return ids.map(id => { const k = pv[id].kind; return `${id}:${runLevel(defOf(mod, k), loadOf(specs, k), prevLevel(persisted, id, k), ctx, lint, id)}`; }).join(',');
}

// ---------------------------------------------------------------- plan (memoised) and its validation

const MEMO = new WeakMap();
const memoOf = mod => { let m = MEMO.get(mod); if (!m) { m = new Map(); if (mod && typeof mod === 'object') MEMO.set(mod, m); } return m; };
const siteKey = (kind, level, site, seed) => {
  let data = '';
  try { data = site.data === undefined ? '' : JSON.stringify(site.data); } catch { data = '?'; }
  return JSON.stringify([kind, level, site.rect, site.anchor, data, seed]);
};

/** Shape-clean a plan result (no world checks yet). Returns frozen { objects, nodes, berths } and pushes lint. */
function cleanPlan(raw, id, lint) {
  const bad = (kind, reason) => lint.push({ kind, venue: id, reason });
  const out = { objects: [], nodes: {}, berths: [] };
  if (!plainObj(raw)) { bad('venue-plan', 'plan must return { objects, nodes, berths }'); return deepFreeze(out); }
  const objs = own(raw, 'objects'), nodes = own(raw, 'nodes'), berths = own(raw, 'berths');
  if (objs != null && !Array.isArray(objs)) bad('venue-object', 'objects must be an array');
  if (Array.isArray(objs)) {
    if (objs.length > MAX_OBJECTS) bad('venue-object', `more than ${MAX_OBJECTS} objects; the rest dropped`);
    const seen = new Set();
    for (let i = 0; i < Math.min(objs.length, MAX_OBJECTS); i++) {
      const o = own(objs, i);
      if (!plainObj(o)) { bad('venue-object', `objects[${i}] is not a plain object; dropped`); continue; }
      const kind = own(o, 'kind') ?? 'venue';
      if (!VENUE_OBJECT_KINDS.includes(kind)) { bad('venue-object', `objects[${i}].kind must be one of ${VENUE_OBJECT_KINDS.join('|')}; dropped`); continue; }
      const model = own(o, 'model');
      if (typeof model !== 'string' || !MODEL_RE.test(model)) { bad('venue-object', `objects[${i}].model must be a short lower-case name; dropped`); continue; }
      const lid = own(o, 'id'), local = typeof lid === 'string' && LOCAL_ID_RE.test(lid) ? lid : String(i);
      if (seen.has(local)) { bad('venue-object', `objects[${i}] repeats an id; dropped`); continue; }
      const walk = own(o, 'walk') ?? WALK.BLOCK, run = own(o, 'run');
      const spec = { local, kind, model, tx: own(o, 'tx'), ty: own(o, 'ty'), w: own(o, 'w') ?? 1, h: own(o, 'h') ?? 1, z: own(o, 'z') ?? 0, walk, variant: own(o, 'variant') ?? 0 };
      if (walk === WALK.EDGE && plainObj(run)) {
        spec.run = { dir: own(run, 'dir'), len: own(run, 'len'), side: own(run, 'side') };
        if (isInt(spec.run.len)) { spec.w = spec.run.dir === 'x' ? spec.run.len : 1; spec.h = spec.run.dir === 'y' ? spec.run.len : 1; }
      }
      const errs = validateObject({ ...spec, id: `v:${local}`, styleKey: '' });
      if (errs.length || spec.w > 64 || spec.h > 64) { bad('venue-object', `objects[${i}] is not a valid object (${errs.length ? errs.map(e => e.split(':')[0]).join(', ') : 'w, h: at most 64'}); dropped`); continue; }
      seen.add(local);
      out.objects.push(spec);
    }
  }
  if (nodes != null && !plainObj(nodes)) bad('venue-node', 'nodes must be a plain object');
  if (plainObj(nodes)) {
    const keys = Object.keys(nodes);
    if (keys.length > MAX_NODES) bad('venue-node', `more than ${MAX_NODES} nodes; the rest dropped`);
    for (const k of keys.slice(0, MAX_NODES)) {
      const n = own(nodes, k);
      if (!NODE_RE.test(k)) { bad('venue-node', 'a node name must be a short lower-case name; dropped'); continue; }
      if (!plainObj(n) || !isInt(own(n, 'tx')) || !isInt(own(n, 'ty'))) { bad('venue-node', `nodes.${k} must be { tx, ty } integers; dropped`); continue; }
      out.nodes[k] = { tx: n.tx, ty: n.ty };
    }
  }
  if (berths != null && !Array.isArray(berths)) bad('venue-berth', 'berths must be an array');
  if (Array.isArray(berths)) {
    if (berths.length > MAX_BERTHS) bad('venue-berth', `more than ${MAX_BERTHS} berths; the rest dropped`);
    const seen = new Set();
    for (let i = 0; i < Math.min(berths.length, MAX_BERTHS); i++) {
      const b = own(berths, i);
      if (!plainObj(b)) { bad('venue-berth', `berths[${i}] is not a plain object; dropped`); continue; }
      const bid = own(b, 'id'), face = own(b, 'face') ?? 0;
      if (typeof bid !== 'string' || !BERTH_RE.test(bid) || seen.has(bid)) { bad('venue-berth', `berths[${i}].id must be a unique short id; dropped`); continue; }
      if (!isInt(own(b, 'tx')) || !isInt(own(b, 'ty')) || ![0, 1, 2, 3].includes(face)) { bad('venue-berth', `berths[${i}] needs integer tx, ty and face 0..3; dropped`); continue; }
      seen.add(bid);
      out.berths.push({ id: bid, tx: b.tx, ty: b.ty, face });
    }
  }
  return deepFreeze(out);
}

/** def.plan through the memo. Lint of a memoised plan is replayed so every build reports the same lint. */
function planOf(def, kind, level, site, id, ctx, seed, lint) {
  const memo = memoOf(def), key = siteKey(kind, level, site, seed);
  let e = memo.get(key);
  if (!e) {
    const l = [];
    let raw;
    try { raw = def.plan(deepFreeze({ site: structuredClone(site), level }), ctx); } catch { l.push({ kind: 'venue-plan', venue: id, reason: 'plan threw; the venue has no objects, nodes or berths' }); raw = null; }
    e = { plan: raw === null && l.length ? deepFreeze({ objects: [], nodes: {}, berths: [] }) : cleanPlan(raw, '\u0000', l), lint: l };
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
    memo.set(key, e);
  }
  for (const x of e.lint) lint.push({ ...x, venue: id });
  return e.plan;
}

// ---------------------------------------------------------------- buildVenues

/**
 * @param {{ grid: import('../core/grid.js').WorldGrid, objects: import('../core/objects.js').ObjectStore, venues?: object }} world
 *   the world being built (grid and objects already stamped with the settlements); world.venues is set here
 * @param {{ venues?: Record<string, import('../mod/api.js').VenueSite> }} sites the layout result
 * @param {import('../mod/api.js').WorldInput} input
 * @param {object} mod ResolvedMod
 * @param {object} persisted mutated: persisted.venues[id] = { kind, level, assign? } (only when there is a venue)
 * @param {object} ctx ModCtx passed to def.level and def.plan
 * @param {{ seed?: number }} [opts]
 * @returns {{ venues: Record<string, object>, lint: object[] }}
 */
export function buildVenues(world, sites, input, mod, persisted, ctx = {}, { seed = 0 } = {}) {
  const venues = {}, lint = [];
  const siteMap = sites?.venues;
  world.venues = venues;
  if (!plainObj(siteMap)) return { venues, lint };
  const ids = Object.keys(siteMap).filter(id => defOf(mod, siteMap[id]?.kind));
  if (!ids.length) return { venues, lint };
  const specs = prSpecsOf(input, mod, { ...ctx, lint });
  const { grid, objects } = world;
  persisted.venues ||= {};
  for (const id of ids) {
    const site = siteMap[id], kind = site.kind, def = defOf(mod, kind);
    if (!VENUE_ID_RE.test(id)) { lint.push({ kind: 'venue-site', reason: 'a venue site id must be a short lower-case name; skipped' }); continue; }
    const rect = cleanRect(site.rect);
    if (!rect) { lint.push({ kind: 'venue-site', venue: id, reason: 'site.rect must be an integer rect; skipped' }); continue; }
    const a = site.anchor, anchor = a && isInt(a.tx) && isInt(a.ty) && inGrid(grid, a.tx, a.ty) ? { tx: a.tx, ty: a.ty }
      : { tx: rect.x + (rect.w >> 1), ty: rect.y + (rect.h >> 1) };
    const clean = { kind, rect, anchor, ...(site.data !== undefined ? { data: site.data } : {}) };
    const prev = prevLevel(persisted, id, kind);
    const level = runLevel(def, loadOf(specs, kind), prev, ctx, lint, id);
    const plan = planOf(def, kind, level, clean, id, ctx, seed, lint);

    for (const s of plan.objects) {
      const o = { id: `venue:${id}:${s.local}`, kind: s.kind, model: s.model, tx: s.tx, ty: s.ty, w: s.w, h: s.h, z: s.z, walk: s.walk,
        ...(s.run ? { run: { ...s.run } } : {}), styleKey: `venue:${kind}`, variant: s.variant, data: { venue: id } };
      if (!inRect(rect, o.tx, o.ty) || !inRect(rect, o.tx + o.w - 1, o.ty + o.h - 1)) { lint.push({ kind: 'venue-object', venue: id, reason: 'an object lies outside the venue site rect; dropped' }); continue; }
      if (!grid || !objects) continue;
      if (objects.has(o.id)) { lint.push({ kind: 'venue-object', venue: id, reason: 'an object id is already taken; dropped' }); continue; }
      const num = objects.add(o), r = grid.stamp(o, num);
      if (r && r.ok === false) { objects.delete(o.id); lint.push({ kind: 'venue-object', venue: id, reason: 'an object overlaps something already built; dropped' }); }
    }
    const nodes = {};
    for (const [k, n] of Object.entries(plan.nodes)) {
      if (inGrid(grid, n.tx, n.ty)) nodes[k] = { tx: n.tx, ty: n.ty };
      else lint.push({ kind: 'venue-node', venue: id, reason: 'a node lies outside the world; dropped' });
    }
    const berths = [];
    for (const b of plan.berths) {
      if (inGrid(grid, b.tx, b.ty)) berths.push({ ...b });
      else lint.push({ kind: 'venue-berth', venue: id, reason: 'a berth lies outside the world; dropped' });
    }
    venues[id] = deepFreeze({ id, kind, tx: anchor.tx, ty: anchor.ty, rect, level, nodes, berths });
    const p = persisted.venues[id];
    persisted.venues[id] = { kind, level, ...(p && p.kind === kind && plainObj(p.assign) ? { assign: p.assign } : {}) };
  }
  return { venues, lint };
}

// ---------------------------------------------------------------- berths (per poll, no rebuild)

/** Default assignment: stable first-free. The first `berths.length` PRs (callers pass them in priority order) get a
 *  berth; one that held a berth keeps it, the others take the first free berth in berth order. */
export function defaultAssign(prIds, berths, prev = {}) {
  const ids = prIds.slice(0, berths.length), valid = new Set(berths.map(b => b.id)), used = new Set(), out = {};
  for (const id of ids) { const b = hasOwn(prev, id) ? prev[id] : undefined; if (valid.has(b) && !used.has(b)) { out[id] = b; used.add(b); } }
  let k = 0;
  for (const id of ids) {
    if (out[id]) continue;
    while (k < berths.length && used.has(berths[k].id)) k++;
    if (k >= berths.length) break;
    out[id] = berths[k].id; used.add(berths[k].id);
  }
  return out;
}

/**
 * Which berth each PR at this venue takes.
 * @param {{ id?: string, kind: string, berths: Array<{ id: string }> }} venue a world.venues entry
 * @param {Array<{ id: string, spec: object }>|Record<string, object>} prSpecs PR specs in priority order (prSpecsOf), or
 *   a prId -> PrSpec record; only `as: 'venue'` specs naming this venue's kind count
 * @param {Record<string, string>} [prev] last assignment (prId -> berth id)
 * @param {{ mod?: object, ctx?: object, lint?: object[] }} [opts] mod: for def.assign; ctx: the ModCtx it gets
 * @returns {Record<string, string>} prId -> berth id
 */
export function assignBerths(venue, prSpecs, prev = {}, { mod = null, ctx = {}, lint = null } = {}) {
  const list = Array.isArray(prSpecs) ? prSpecs : Object.entries(prSpecs || {}).map(([id, spec]) => ({ id, spec }));
  const prIds = list.filter(p => p?.spec?.as === 'venue' && p.spec.venue === venue?.kind && typeof p.id === 'string').map(p => p.id);
  const berths = Array.isArray(venue?.berths) ? venue.berths : [];
  const prevClean = plainObj(prev) ? prev : {};
  const def = mod ? defOf(mod, venue.kind) : null;
  if (!def || typeof def.assign !== 'function') return defaultAssign(prIds, berths, prevClean);
  const bad = reason => { if (Array.isArray(lint)) lint.push({ kind: 'venue-assign', venue: venue.id ?? null, reason }); };
  let r;
  try { r = def.assign(Object.freeze([...prIds]), deepFreeze(berths.map(b => ({ ...b }))), Object.freeze({ ...prevClean }), ctx); }
  catch { bad('assign threw; default assignment used'); return defaultAssign(prIds, berths, prevClean); }
  if (!plainObj(r)) { bad('assign must return a prId -> berth id record; default assignment used'); return defaultAssign(prIds, berths, prevClean); }
  const ids = new Set(prIds), valid = new Set(berths.map(b => b.id)), used = new Set(), out = {};
  for (const k of Object.keys(r)) {
    const b = own(r, k);
    if (!ids.has(k) || !valid.has(b) || used.has(b)) { bad('an assignment names an unknown PR, an unknown berth or a taken berth; dropped'); continue; }
    out[k] = b; used.add(b);
  }
  return out;
}

/**
 * Every venue's berth assignment for this poll; persisted.venues[id].assign keeps it stable across polls and rebuilds.
 * Venues are filled in id order; a PR takes a berth at the first venue of its kind that has one free.
 * @returns {{ venues: Record<string, Record<string, string>>,
 *   prs: Record<string, { venue: string, berth: string, tx: number, ty: number, face: number, model?: string, tint?: string }> }}
 */
export function venueAssignments(world, input, mod, persisted, ctx = {}) {
  const out = { venues: {}, prs: {} };
  const vs = world?.venues;
  if (!vs || !Object.keys(vs).length) return out;
  const lint = Array.isArray(ctx.lint) ? ctx.lint : null;
  const specs = prSpecsOf(input, mod, lint ? { ...ctx, lint } : ctx);
  const taken = new Set();
  for (const id of Object.keys(vs).sort()) {
    const v = vs[id], pv = persisted?.venues?.[id];
    const a = assignBerths(v, specs.filter(p => !taken.has(p.id)), pv?.assign, { mod, ctx, lint });
    out.venues[id] = a;
    if (pv) pv.assign = { ...a };
    const byId = new Map(v.berths.map(b => [b.id, b])), specOf = new Map(specs.map(p => [p.id, p.spec]));
    for (const [pr, berth] of Object.entries(a)) {
      taken.add(pr);
      const b = byId.get(berth), s = specOf.get(pr);
      out.prs[pr] = { venue: id, berth, tx: b.tx, ty: b.ty, face: b.face, ...(s.model ? { model: s.model } : {}), ...(s.tint ? { tint: s.tint } : {}) };
    }
  }
  return out;
}
