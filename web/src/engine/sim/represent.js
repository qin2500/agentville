// Engine v2 sim/represent.js (S5): runs the DECLARATIVE mod seams `behaviour` and `represent` (village-mods.md §3.2,
// design v2 §4.2). Pure, no DOM, no clock, no RNG.
//
//   representAgent(agent, mod, ctx?) -> ActorSpec     status -> where/how, from mod data with engine defaults
//   resolvePlace(place, actor, world, ctx?) -> Place|null   a place string -> a tile (+ a reserved slot)
//   validateBehaviour(behaviour) -> { behaviour, lint }      mod data -> clean, frozen table (cached per object)
//
// Mod data is plain: `mod.behaviour` = { [key]: { place, pose, idle[], idleEvery?, walk, look?, model? } } and
// `mod.represent` = { agent?: string | { model, look, hat } | fn, boss?: string | {...}, sub?: string | {...}, pr?: ... }.
// The only code path is `represent.agent(view, hookCtx)`; it sees a frozen allow-listed agent view with opaque ids
// only and `artView` copies of world objects, and whatever it returns is sanitised field by field.

import { ANIMS } from './actor.js';

/**
 * Pose vocabulary. The engine knows only the actor anim enum of design §4.1: `POSE_ANIM` is the identity over `ANIMS`.
 * A mod's own pose / idle-cue names are mod data, `mod.represent.poses: Record<name, anim>`; the renderer only ever
 * sees anim values, the mod's own name stays on a.pose / a.cue.
 */
export const POSE_ANIM = Object.freeze(Object.fromEntries(ANIMS.map(a => [a, a])));
const ANIM_SET = new Set(ANIMS);
/** Anim enum value for a pose/cue name: the mod's `represent.poses` first, then the anim enum itself; unknown reads as 'idle'. */
export function animOf(pose, mod) {
  const mapped = mod?.represent?.poses?.[pose];
  if (typeof mapped === 'string' && ANIM_SET.has(mapped)) return mapped;
  return ANIM_SET.has(pose) ? pose : 'idle';
}
/** True when the value is already an anim enum value. */
export const isAnim = v => ANIM_SET.has(v);

/** Behaviour keys the engine knows, with the §4.2 table as engine defaults (a mod that gives nothing gets these). */
export const ENGINE_BEHAVIOUR = Object.freeze({
  working: { place: 'pr.site', pose: 'hammer', idle: ['carry'], idleEvery: null, walk: true },          // live PR
  building: { place: 'anchor:work', pose: 'hammer', idle: [], idleEvery: null, walk: true },            // no PR
  waiting: { place: 'anchor:sit', pose: 'sit', idle: ['look-around'], idleEvery: [6, 10], walk: true },
  'stalled:attention': { place: 'home.forecourt', pose: 'idle', idle: ['wave'], idleEvery: [4, 4], walk: false },
  'stalled:prompt': { place: 'home.forecourt', pose: 'wave', idle: [], idleEvery: null, walk: false },
  'stalled:error': { place: 'home.forecourt', pose: 'idle', idle: ['smoke'], idleEvery: null, walk: false },
  resting: { place: 'home.forecourt', pose: 'sleep', idle: [], idleEvery: null, walk: false },
  'resting:doorstep': { place: 'home.forecourt', pose: 'idle', idle: [], idleEvery: null, walk: false },   // Important / stopped
  'resting:prs-loading': { place: 'home.forecourt', pose: 'idle', idle: [], idleEvery: null, walk: false },   // resting, PRs loading: neutral
  sub: { place: 'anchor:stand', pose: 'idle', idle: [], idleEvery: null, walk: true },
});
for (const v of Object.values(ENGINE_BEHAVIOUR)) { Object.freeze(v.idle); if (v.idleEvery) Object.freeze(v.idleEvery); Object.freeze(v); }

/** Lookup chains: the first key a mod defines wins; the engine default is always the chain's first key. */
const CHAINS = {
  working: ['working'],
  building: ['building', 'working'],
  waiting: ['waiting'],
  'stalled:attention': ['stalled:attention', 'stalled'],
  'stalled:prompt': ['stalled:prompt', 'stalled:attention', 'stalled'],
  'stalled:error': ['stalled:error', 'error', 'stalled'],
  resting: ['resting'],
  'resting:doorstep': ['resting:doorstep'],
  'resting:prs-loading': ['resting:prs-loading', 'resting'],
};
export const BEHAVIOUR_KEYS = Object.freeze([...new Set([...Object.values(CHAINS).flat(), 'sub'])]);

export const DEFAULT_PLACE = 'home.forecourt';
export const ANCHOR_KINDS = Object.freeze(['stand', 'work', 'sit', 'vend']);
const PLACE_RE = /^(home\.forecourt|pr\.site|anchor:(stand|work|sit|vend)|venue:[a-z][a-z0-9_-]{0,31})$/;
const NAME_RE = /^[a-z][a-z0-9._-]{0,31}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const STATUS = new Set(['working', 'waiting', 'stalled', 'error', 'resting']);
const NEEDS = new Set(['permission', 'question', 'plan', 'dialog']);
const ROLES = new Set(['boss', 'lead', 'worker', 'sub']);
const SLOT_OF = { 'home.forecourt': 'stand', 'pr.site': 'work' };
/** how far (tiles) an `anchor:<kind>` may be from home before the engine falls back to the forecourt */
export const ANCHOR_RADIUS = 12;

export const isPlace = p => typeof p === 'string' && PLACE_RE.test(p);
const isName = s => typeof s === 'string' && NAME_RE.test(s);
const plainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// ---------------------------------------------------------------- validation

/** Clean one behaviour entry against `base` (field-level fallback). Pushes lint. */
function cleanEntry(key, e, base, lint) {
  const out = {};
  if (e.place !== undefined) {
    if (isPlace(e.place)) out.place = e.place;
    else { out.place = DEFAULT_PLACE; lint.push({ kind: 'behaviour-place', key, reason: 'unknown place kind; using home.forecourt', value: String(e.place).slice(0, 40) }); }
  }
  if (e.pose !== undefined) {
    if (isName(e.pose)) out.pose = e.pose; else lint.push({ kind: 'behaviour-pose', key, reason: 'pose must be a short lower-case name' });
  }
  if (e.idle !== undefined) {
    if (Array.isArray(e.idle)) {
      const ok = e.idle.filter(isName).slice(0, 8);
      if (ok.length !== e.idle.length) lint.push({ kind: 'behaviour-idle', key, reason: 'idle entries must be short lower-case names (max 8)' });
      out.idle = ok;
    } else lint.push({ kind: 'behaviour-idle', key, reason: 'idle must be an array' });
  }
  if (e.idleEvery !== undefined) {
    const v = e.idleEvery;
    if (v === null) out.idleEvery = null;
    else if (Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n > 0 && n <= 600) && v[0] <= v[1]) out.idleEvery = [v[0], v[1]];
    else lint.push({ kind: 'behaviour-idleEvery', key, reason: 'idleEvery must be [min, max] seconds, 0 < min <= max <= 600' });
  }
  if (e.walk !== undefined) {
    if (typeof e.walk === 'boolean') out.walk = e.walk; else lint.push({ kind: 'behaviour-walk', key, reason: 'walk must be a boolean' });
  }
  if (e.look !== undefined) { if (isName(e.look)) out.look = e.look; else lint.push({ kind: 'behaviour-look', key, reason: 'look must be a short lower-case name' }); }
  if (e.model !== undefined) { if (isName(e.model)) out.model = e.model; else lint.push({ kind: 'behaviour-model', key, reason: 'model must be a short lower-case name' }); }
  const merged = { ...(base || {}), ...out };
  if (merged.idle) Object.freeze(merged.idle = [...merged.idle]);
  if (merged.idleEvery) Object.freeze(merged.idleEvery = [...merged.idleEvery]);
  return Object.freeze(merged);
}

const validated = new WeakMap();
/** Validate a mod's `behaviour` data. Unknown keys are linted and kept (harmless); non-object entries dropped.
 *  Entries are NOT merged with engine defaults here (that is per lookup chain); only their fields are cleaned.
 * @returns {{ behaviour: Readonly<Record<string, object>>, lint: object[] }} */
export function validateBehaviour(behaviour) {
  if (behaviour == null) return { behaviour: Object.freeze({}), lint: [] };
  if (typeof behaviour === 'object' && validated.has(behaviour)) return validated.get(behaviour);
  const lint = [], out = {};
  if (!plainObj(behaviour)) lint.push({ kind: 'behaviour-shape', reason: 'mod.behaviour must be a plain object of entries' });
  else for (const [key, e] of Object.entries(behaviour)) {
    if (!plainObj(e)) { lint.push({ kind: 'behaviour-entry', key, reason: 'entry must be a plain object; ignored' }); continue; }
    if (!BEHAVIOUR_KEYS.includes(key)) lint.push({ kind: 'behaviour-key', key, reason: 'unknown behaviour key; the engine never looks it up' });
    out[key] = cleanEntry(key, e, null, lint);
  }
  const r = Object.freeze({ behaviour: Object.freeze(out), lint: Object.freeze(lint) });
  if (behaviour && typeof behaviour === 'object') validated.set(behaviour, r);
  return r;
}

// ---------------------------------------------------------------- status -> key

const prList = prs => (Array.isArray(prs) ? prs : []);
const prIdOf = p => (typeof p === 'string' ? p : p && typeof p.id === 'string' ? p.id : p && p.id != null ? String(p.id) : null);
/** PR state from ctx.prs (Map id->pr|state, or WorldInput prs[]), else from the PR object itself ({ live } / { state }). */
function prStateFn(ctx) {
  const src = ctx?.prs;
  let map = null;
  if (src instanceof Map) map = src;
  else if (Array.isArray(src)) map = new Map(src.filter(p => p && p.id != null).map(p => [String(p.id), p]));
  return p => {
    const id = prIdOf(p);
    const m = map && id != null ? map.get(id) : undefined;
    const s = typeof m === 'string' ? m : m?.state;
    if (s) return s;
    if (p && typeof p === 'object') { if (p.state) return p.state; if ('live' in p) return p.live ? 'building' : 'merged'; }
    return map ? 'unknown' : 'building';      // no info at all: WorldInput agents list their current PRs
  };
}

/** Normalise a WorldInput agent ({ status, needs }) or a SnapshotView-like one ({ bucket, severity, prompt }). */
export function agentFacts(agent, ctx) {
  const a = agent || {};
  let status = STATUS.has(a.status) ? a.status : null;
  if (!status) status = a.bucket === 'building' ? 'working' : a.bucket === 'waiting' ? 'waiting' : a.bucket === 'resting' ? 'resting'
    : a.severity === 'error' ? 'error' : a.bucket === 'stalled' ? 'stalled' : 'resting';
  if (status === 'stalled' && a.severity === 'error') status = 'error';
  const needs = NEEDS.has(a.needs) ? a.needs : NEEDS.has(a.prompt) ? a.prompt : null;
  const role = ROLES.has(a.role) ? a.role : 'worker';
  const sub = a.sub === true || role === 'sub';
  const stateOf = prStateFn(ctx);
  const prs = prList(a.prs).map(p => ({ id: prIdOf(p), state: stateOf(p) })).filter(p => p.id);
  return { status, needs, role, sub, crown: !!a.crown || role === 'boss', important: !!a.important, stopped: !!a.stopped,
    livePrs: prs.filter(p => p.state === 'building').map(p => p.id), loadingPrs: prs.filter(p => p.state === 'loading').map(p => p.id) };
}

/** The §4.2 bucket key for an agent. */
export function behaviourKey(f) {
  switch (f.status) {
    case 'working': return f.livePrs.length ? 'working' : 'building';
    case 'waiting': return 'waiting';
    case 'error': return 'stalled:error';
    case 'stalled': return f.needs ? 'stalled:prompt' : 'stalled:attention';
    default:
      if (f.important || f.stopped) return 'resting:doorstep';
      return f.loadingPrs.length ? 'resting:prs-loading' : 'resting';
  }
}

function lookup(table, key) {
  const chain = CHAINS[key] || [key];
  for (const k of chain) if (table[k]) return { entry: table[k], from: k };
  return { entry: null, from: null };
}

// ---------------------------------------------------------------- represent (appearance)

const APPEAR_KEYS = ['model', 'look', 'hat', 'tint'];
function cleanAppearance(v, lint, where) {
  if (v == null) return {};
  if (typeof v === 'string') { if (isName(v)) return { model: v }; lint.push({ kind: 'represent-model', where, reason: 'model must be a short lower-case name' }); return {}; }
  if (!plainObj(v)) { lint.push({ kind: 'represent-shape', where, reason: 'must be a model name or a plain object' }); return {}; }
  const out = {};
  for (const k of APPEAR_KEYS) {
    if (v[k] === undefined) continue;
    if (v[k] === null && k !== 'model') { out[k] = null; continue; }
    if (k === 'tint' ? (typeof v[k] === 'string' && HEX_RE.test(v[k])) : isName(v[k])) out[k] = v[k];
    else lint.push({ kind: `represent-${k}`, where, reason: `${k} is not a legal value; ignored` });
  }
  return out;
}

/** Allow-listed, frozen agent view for a code hook: opaque ids only, no server ids, no text beyond the display name. */
function agentView(agent, f) {
  const a = agent || {};
  const s = v => (typeof v === 'string' ? v : null);
  return Object.freeze({
    id: s(a.id), name: s(a.name)?.slice(0, 80) ?? null, project: s(a.project), parent: s(a.parent),
    status: f.status, needs: f.needs, role: f.role, sub: f.sub, crown: f.crown, important: f.important, stopped: f.stopped,
    harness: s(a.harness), prs: Object.freeze([...f.livePrs, ...f.loadingPrs]),
  });
}

const fallbackArtView = o => {   // used only when ctx.artView is not injected (mod/art-view.js is the real one)
  const out = {};
  if (o) for (const k of ['id', 'kind', 'model', 'tx', 'ty', 'w', 'h', 'z', 'walk', 'project', 'styleKey', 'variant', 'rank', 'lot', 'crown']) if (o[k] !== undefined && typeof o[k] !== 'object') out[k] = o[k];
  if (o?.door) out.door = Object.freeze({ tx: o.door.tx, ty: o.door.ty, face: o.door.face });
  return Object.freeze(out);
};

// ---------------------------------------------------------------- representAgent

/**
 * @typedef {{
 *  key: string,                 // the §4.2 bucket key ('working', 'stalled:prompt', ...)
 *  place: string, pose: string, idle: string[], idleEvery: [number, number]|null, walk: boolean,
 *  fixed: boolean,              // stalled/error: never wanders, faces the viewer (engine-enforced, a mod cannot lift it)
 *  face: 0|null, indoors: boolean, ghost: boolean, sub: boolean,
 *  model: string, look: string|null, hat: string|null, tint: string|null,
 *  agentId: string|null, parent: string|null, prs: string[],   // opaque ids, so resolvePlace can work from the actor
 * }} ActorSpec
 */

/**
 * @param {object} agent WorldInput agent (opaque ids) or { bucket, severity, prompt, role, sub, prs, ... }
 * @param {object} mod ResolvedMod (reads mod.behaviour, mod.represent; mod.hooks.represent as a fallback for the hook)
 * @param {{ prs?: Map|Array, lint?: object[], artView?: (o) => object, homeOf?: (agentId) => string|object|null,
 *           world?: object, model?: string }} [ctx] lint: validation problems are pushed here (table lint once per array)
 * @returns {ActorSpec}
 */
export function representAgent(agent, mod, ctx = {}) {
  const lint = Array.isArray(ctx.lint) ? ctx.lint : [];
  const { behaviour: table, lint: tableLint } = validateBehaviour(mod?.behaviour);
  if (tableLint.length && !lint.includes(tableLint[0])) lint.push(...tableLint);   // once per lint array
  const f = agentFacts(agent, ctx);
  const key = behaviourKey(f);
  const { entry } = lookup(table, key);
  let spec = { ...ENGINE_BEHAVIOUR[key], ...(entry || {}) };

  if (f.sub) {   // sub-agent: the parent's yard (sub entry), pose and idles of its own bucket
    const s = table.sub || ENGINE_BEHAVIOUR.sub;
    spec = { ...spec, place: s.place, walk: spec.walk && s.walk !== false, ...(s.look ? { look: s.look } : {}), ...(s.model ? { model: s.model } : {}) };
  }

  // appearance: represent.agent / boss / sub data
  const rep = plainObj(mod?.represent) ? mod.represent : {};
  let look = { model: ctx.model || 'agent', look: null, hat: null, tint: null };
  if (spec.look) look.look = spec.look;
  if (spec.model) look.model = spec.model;
  if (typeof rep.agent !== 'function') Object.assign(look, cleanAppearance(rep.agent, lint, 'represent.agent'));
  if (f.crown && rep.boss !== undefined) Object.assign(look, cleanAppearance(rep.boss, lint, 'represent.boss'));
  if (f.sub && rep.sub !== undefined) Object.assign(look, cleanAppearance(rep.sub, lint, 'represent.sub'));

  let out = {
    key, place: spec.place, pose: spec.pose, idle: [...(spec.idle || [])], idleEvery: spec.idleEvery ? [...spec.idleEvery] : null,
    walk: !!spec.walk, ...look,
  };

  // the one code path: represent.agent(view, hookCtx) -> partial spec, sanitised
  const hook = typeof rep.agent === 'function' ? rep.agent : typeof mod?.hooks?.represent?.agent === 'function' ? mod.hooks.represent.agent : null;
  if (hook) {
    const view = ctx.artView || fallbackArtView;
    let home = null;
    try {
      const h = ctx.homeOf?.(agent?.id);
      const obj = typeof h === 'string' ? ctx.world?.objects?.get?.(h) : h;
      home = obj ? view(obj) : null;
    } catch { home = null; }
    const defaults = Object.freeze({ ...out, idle: Object.freeze([...out.idle]), idleEvery: out.idleEvery && Object.freeze([...out.idleEvery]) });
    let r;
    try { r = hook(agentView(agent, f), Object.freeze({ key, home, defaults })); }
    catch (err) { lint.push({ kind: 'represent-hook', reason: 'represent.agent threw; engine defaults used', error: String(err?.message || err).slice(0, 120) }); r = null; }
    if (r != null) {
      if (!plainObj(r)) lint.push({ kind: 'represent-hook', reason: 'represent.agent must return a plain object' });
      else {
        const c = cleanEntry(key, r, out, lint);
        out = { ...c, idle: [...c.idle], idleEvery: c.idleEvery ? [...c.idleEvery] : null };
        Object.assign(out, cleanAppearance(Object.fromEntries(APPEAR_KEYS.filter(k => k !== 'model' && r[k] !== undefined).map(k => [k, r[k]])), lint, 'represent.agent()'));
      }
    }
  }

  // engine-enforced invariants (§4.2 readability rule): stalled or error agents never wander and face the viewer
  const fixed = key.startsWith('stalled:');
  if (fixed) { out.walk = false; }
  return {
    key: out.key ?? key, place: out.place, pose: out.pose, idle: out.idle, idleEvery: out.idleEvery, walk: out.walk,
    fixed, face: fixed ? 0 : null,
    indoors: key === 'resting' && !f.sub, ghost: key === 'resting:doorstep', sub: f.sub,
    model: out.model, look: out.look ?? null, hat: out.hat ?? null, tint: out.tint ?? null,
    agentId: typeof agent?.id === 'string' ? agent.id : null, parent: typeof agent?.parent === 'string' ? agent.parent : null,
    prs: f.livePrs.length ? f.livePrs : f.loadingPrs,
  };
}

// ---------------------------------------------------------------- resolvePlace

const objOf = (world, ref) => (ref == null ? null : typeof ref === 'string' ? world?.objects?.get?.(ref) || null : ref);
/** home object of an opaque agent id: ctx.homeOf (the opaque->server mapping lives there), else a scan of data.agentId. */
function homeObject(agentId, world, ctx) {
  if (agentId == null) return null;
  if (typeof ctx?.homeOf === 'function') return objOf(world, ctx.homeOf(agentId));
  for (const o of world?.objects?.values?.() || []) if (o.data?.owner === 'home' && o.data.agentId === agentId) return o;
  return null;
}
/** the forecourt tile of a building: its door, else the tile in front of its footprint (south-west face, +y). */
function forecourtOf(o) {
  if (o.door && Number.isFinite(o.door.tx)) return { tx: o.door.tx, ty: o.door.ty };
  return { tx: o.tx + (Math.max(1, o.w) >> 1), ty: o.ty + Math.max(1, o.h) };
}
const result = (place, tx, ty, slotKind, extra = {}) => ({ tx, ty, slotKind, place, ...extra });

/** claim a slot of `kind` on object `o` (optionally on tile tx,ty) for the actor; keeps one it already holds there. */
function claimOn(slots, actorId, o, kind, tile) {
  if (!slots || typeof slots.claim !== 'function') return null;
  const prefix = `${o.id}:${kind}:`;
  const held = slots.heldBy?.(actorId);
  if (held && held.id.startsWith(prefix) && (!tile || (held.tx === tile.tx && held.ty === tile.ty))) return held;
  const cands = typeof slots.all === 'function' ? slots.all().filter(s => s.id.startsWith(prefix) && (!tile || (s.tx === tile.tx && s.ty === tile.ty)))
    : tile ? [0, 1, 2, 3].map(sub => ({ id: `${prefix}${tile.tx},${tile.ty}:${sub}` })) : [];
  for (const s of cands) { const c = slots.claim(s.id, actorId); if (c) return c; }
  return null;
}
const slotExtra = s => (s ? { sub: s.sub, slotId: s.id } : {});

function forecourt(actor, world, ctx, place) {
  const home = homeObject(actor.agentId ?? actor.id, world, ctx) ?? (actor.parent ? homeObject(actor.parent, world, ctx) : null);
  if (!home) return null;
  const t = forecourtOf(home);
  const s = claimOn(ctx?.slots, actor.id, home, 'stand', t);
  return result(place, t.tx, t.ty, 'stand', { objId: home.id, face: 0, ...slotExtra(s) });
}

function nearestAnchor(world, kind, x, y) {   // no slot registry: plain scan, no reservation
  let best = null, bd = Infinity;
  for (const o of world?.objects?.values?.() || []) for (const s of o.anchors?.[kind] || []) {
    const d = (s.tx - x) ** 2 + (s.ty - y) ** 2;
    if (d < bd) { bd = d; best = { id: `${o.id}:${kind}:${s.tx},${s.ty}:${s.sub | 0}`, tx: s.tx, ty: s.ty, sub: s.sub | 0, kind }; }
  }
  return best;
}

/**
 * Resolve a declarative place to a tile, reserving a slot when ctx.slots is given. Anything that cannot be resolved
 * falls back to the agent's home forecourt (`fallback: true`); null only when even that is unknown.
 * @param {string} place 'home.forecourt' | 'pr.site' | 'anchor:<stand|work|sit|vend>' | 'venue:<node>' (others: home.forecourt)
 * @param {{ id: string, agentId?: string, parent?: string, prs?: string[], x?: number, y?: number }} actor
 * @param {object} world World (buildWorld)
 * @param {{ homeOf?: (agentId: string) => string|object|null, prSiteOf?: (prId: string) => string|object|null,
 *           slots?: ReturnType<import('../nav/slots.js').createSlots>, radius?: number }} [ctx]
 * @returns {{ tx: number, ty: number, slotKind: 'stand'|'work'|'sit'|'vend', place: string, sub?: number, slotId?: string,
 *             objId?: string, face?: number, fallback?: boolean }|null}
 */
export function resolvePlace(place, actor, world, ctx = {}) {
  if (!actor) return null;
  const p = isPlace(place) ? place : DEFAULT_PLACE;
  const slots = ctx.slots;
  const fall = () => { const r = forecourt(actor, world, ctx, DEFAULT_PLACE); return r && p !== DEFAULT_PLACE ? { ...r, fallback: true } : r; };

  if (p === 'home.forecourt') return fall();

  if (p === 'pr.site') {
    for (const id of prList(actor.prs)) {
      let o = null;
      if (typeof ctx.prSiteOf === 'function') o = objOf(world, ctx.prSiteOf(id));
      else for (const x of world?.objects?.values?.() || []) if (x.data?.owner === 'pr' && x.data.pr === id) { o = x; break; }
      if (!o) continue;
      const s = claimOn(slots, actor.id, o, 'work');
      if (s) return result(p, s.tx, s.ty, 'work', { objId: o.id, ...slotExtra(s) });
      if (!slots) { const a = o.anchors?.work?.[0]; if (a) return result(p, a.tx, a.ty, 'work', { objId: o.id, sub: a.sub | 0 }); }
    }
    return fall();
  }

  if (p.startsWith('anchor:')) {
    const kind = p.slice(7);
    const home = homeObject(actor.agentId ?? actor.id, world, ctx) ?? (actor.parent ? homeObject(actor.parent, world, ctx) : null);
    const o = home ? forecourtOf(home) : Number.isFinite(actor.x) ? { tx: Math.round(actor.x), ty: Math.round(actor.y) } : null;
    if (!o) return null;
    const r2 = (ctx.radius ?? ANCHOR_RADIUS) ** 2, near = s => s && (s.tx - o.tx) ** 2 + (s.ty - o.ty) ** 2 <= r2;
    let s = null;
    if (slots) {
      const held = slots.heldBy?.(actor.id);
      if (held && held.kind === kind && near(held)) s = held;
      else { const c = slots.nearestFree(o.tx, o.ty, kind); if (near(c)) s = slots.claim(c.id, actor.id); }
    } else { const c = nearestAnchor(world, kind, o.tx, o.ty); if (near(c)) s = c; }
    if (s) return result(p, s.tx, s.ty, kind, slotExtra(s));
    return fall();
  }

  // venue:<node>
  const node = p.slice(6);
  let t = null;
  const v = world?.venues?.[node];
  if (v && Number.isFinite(v.tx)) t = { tx: v.tx, ty: v.ty };
  else if (node === 'square' && world?.square) { const q = world.square; t = { tx: q.x + (q.w >> 1), ty: q.y + (q.h >> 1) }; }
  if (!t) return fall();
  if (slots) {
    const held = slots.heldBy?.(actor.id);
    const c = held && held.kind === 'stand' && Math.abs(held.tx - t.tx) + Math.abs(held.ty - t.ty) <= 4 ? held : slots.nearestFree(t.tx, t.ty, 'stand');
    if (c && Math.abs(c.tx - t.tx) + Math.abs(c.ty - t.ty) <= 4) { const s = c === held ? held : slots.claim(c.id, actor.id); if (s) return result(p, s.tx, s.ty, 'stand', slotExtra(s)); }
  }
  return result(p, t.tx, t.ty, 'stand');
}

/** slot kind a place uses (for callers that pre-plan). */
export const slotKindOf = place => (isPlace(place) ? SLOT_OF[place] || (place.startsWith('anchor:') ? place.slice(7) : 'stand') : 'stand');
