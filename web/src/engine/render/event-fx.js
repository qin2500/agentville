// Engine render: world-event effects (M6 P4). A mod's events hook turns sim events (merge, found, tierUp, ...) into
// EventSpec[]; this file validates them, keeps the active ones and draws them. Generic: it knows effect names
// (burst, ring, site:<objId>, anim:<name>) and targets (plaza:<project>, actor:<id>, pr:<id>), never what they mean.
//
// EventSpec: { kind, at: 'plaza:<p>'|'actor:<id>'|'pr:<id>', effect: 'burst'|'ring'|'site:<objId>'|'anim:<name>',
//              seconds, colors?: string[] }
// Everything drawn is a pure function of (entry, t): no Math.random, no wall clock. Particles come from a hash of the
// entry's own fields. t is the sim clock in seconds; an entry lives on [t0, t0 + seconds).
import { toScreen } from '../core/coords.js';
import { ANIMS } from '../sim/actor.js';

export const LIMITS = Object.freeze({ active: 32, perDrain: 32, seconds: 30, colors: 6, deadlineMs: 10, particles: 28, ringPoints: 28 });
export const EFFECT_TYPES = Object.freeze(['burst', 'ring', 'site', 'anim']);
const AT_TYPES = new Set(['plaza', 'actor', 'pr', 'obj']);
const ANIM_SET = new Set(ANIMS);
const DEFAULT_COLORS = Object.freeze(['#ffd23f', '#e8504a', '#4cc9f0', '#80ed99', '#f4efe4']);

const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const unit = (h, k) => (hash(`${h}:${k}`) % 10007) / 10007;   // deterministic [0, 1)
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** 'plaza:<p>' | 'actor:<id>' | 'pr:<id>' | 'obj:<objectId>' -> { type, id } or null. */
export function parseAt(at) {
  if (typeof at !== 'string') return null;
  const i = at.indexOf(':');
  if (i < 1) return null;
  const type = at.slice(0, i), id = at.slice(i + 1);
  return AT_TYPES.has(type) && id ? { type, id } : null;
}

/** 'burst' | 'ring' | 'site:<objId>' | 'anim:<name>' -> { type, arg } or null (an unknown anim name is rejected). */
export function parseEffect(effect) {
  if (typeof effect !== 'string') return null;
  const i = effect.indexOf(':'), type = i < 0 ? effect : effect.slice(0, i), arg = i < 0 ? null : effect.slice(i + 1);
  if (type === 'burst' || type === 'ring') return arg === null ? { type, arg: null } : null;
  if (type === 'site') return arg ? { type, arg } : null;
  if (type === 'anim') return arg && ANIM_SET.has(arg) ? { type, arg } : null;
  return null;
}

/** Validates one EventSpec at sim time t0 -> an fx entry, or null. Never throws. seconds is clamped to (0, 30]. */
export function normalizeSpec(spec, t0 = 0) {
  try {
    if (!spec || typeof spec !== 'object') return null;
    const at = parseAt(spec.at), fx = parseEffect(spec.effect), s = Number(spec.seconds);
    if (!at || !fx || !(s > 0) || !Number.isFinite(t0)) return null;
    const colors = (Array.isArray(spec.colors) ? spec.colors : []).filter(c => typeof c === 'string' && c.length <= 40).slice(0, LIMITS.colors);
    const kind = typeof spec.kind === 'string' ? spec.kind.slice(0, 32) : '';
    const entry = { kind, at: spec.at, ref: at, effect: spec.effect, fx, seconds: Math.min(s, LIMITS.seconds), colors: colors.length ? colors : DEFAULT_COLORS, t0 };
    entry.h = hash(`${kind}|${spec.at}|${spec.effect}|${t0}`);
    return Object.freeze(entry);
  } catch { return null; }
}

/**
 * Runs a mod's events hook under a deadline. Never throws. clock() -> ms (default performance.now / Date.now).
 * A hook that throws or overruns costs only its own output: the engine keeps going. Specs are validated one by one and
 * the rest is trimmed once the deadline has passed; at most LIMITS.perDrain specs are kept.
 * -> { specs: EventSpec[], status: 'none'|'ok'|'threw'|'overrun'|'trimmed', ms }
 */
export function runEvents(hook, diff, ctx, { clock, budgetMs = LIMITS.deadlineMs } = {}) {
  if (typeof hook !== 'function' || !diff?.length) return { specs: [], status: 'none', ms: 0 };
  const now = clock ?? (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  const t0 = now();
  let out;
  try { out = hook(diff, ctx); } catch { return { specs: [], status: 'threw', ms: now() - t0 }; }
  let ms = now() - t0;
  if (ms > budgetMs) return { specs: [], status: 'overrun', ms };
  if (!Array.isArray(out)) return { specs: [], status: 'ok', ms };
  const specs = [];
  let status = 'ok';
  for (const s of out) {
    if (specs.length >= LIMITS.perDrain || now() - t0 > budgetMs) { status = 'trimmed'; break; }
    if (normalizeSpec(s, 0)) specs.push(s);
  }
  ms = now() - t0;
  return { specs, status, ms };
}

/** The set of active effects: add(specs, t) stamps them at sim time t; prune(t) drops the expired; the newest win at the cap. */
export function createEventFx({ max = LIMITS.active } = {}) {
  let list = [];
  return {
    add(specs, t) {
      let n = 0;
      for (const s of specs || []) { const e = normalizeSpec(s, t); if (e) { list.push(e); n++; } }
      if (list.length > max) list = list.slice(list.length - max);
      return n;
    },
    prune(t) { list = list.filter(e => t < e.t0 + e.seconds); return list.length; },
    active(t) { return activeAt(list, t); },
    clear() { list = []; },
    get size() { return list.length; },
  };
}

/** Entries alive at t (t0 <= t < t0 + seconds). */
export function activeAt(list, t) { return (list || []).filter(e => t >= e.t0 && t < e.t0 + e.seconds); }

/** actor id -> { anim, frame } for the `anim:<name>` effects alive at t (the newest per actor wins). Pure of t. */
export function animOverrides(list, t) {
  const out = new Map();
  for (const e of list || []) {
    if (e.fx.type !== 'anim' || e.ref.type !== 'actor' || !(t >= e.t0 && t < e.t0 + e.seconds)) continue;
    out.set(e.ref.id, { anim: e.fx.arg, frame: Math.floor((t - e.t0) * 6) });
  }
  return out;
}

/** Where an `at` is, in tile coords: plaza (the village's plaza centre by project name), actor (its feet), pr (its berth). */
export function resolveAt(ref, { world, actors, berths } = {}) {
  if (!ref) return null;
  if (ref.type === 'plaza') {
    const v = (world?.villages || []).find(x => x.name === ref.id);
    return v ? { x: v.cx + 0.5, y: v.cy + 0.5 } : null;
  }
  if (ref.type === 'obj') {   // city cap: a world object, or a lot drawn as a green (world.greens)
    const o = world?.objects?.get?.(ref.id) ?? world?.greens?.get?.(ref.id);
    return o && Number.isFinite(o.tx) ? { x: o.tx + (o.w || 1) / 2, y: o.ty + (o.h || 1) / 2 } : null;
  }
  if (ref.type === 'actor') {
    const a = (actors || []).find(x => String(x.id) === ref.id);
    return a && Number.isFinite(a.x) ? { x: a.x, y: a.y } : null;
  }
  const b = berths?.[ref.id] ?? (berths instanceof Map ? berths.get(ref.id) : null);
  return b && Number.isFinite(b.tx) ? { x: b.tx + 0.5, y: b.ty + 0.5 } : null;
}

/** '#rgb' / '#rrggbb' + alpha -> rgba(); any other colour string is returned unchanged (no fade). */
export function withAlpha(c, a) {
  if (!HEX.test(c)) return c;
  const h = c.length === 4 ? [...c.slice(1)].map(x => x + x).join('') : c.slice(1);
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${Math.round(clamp01(a) * 100) / 100})`;
}

function line(g, p, q, color) { g.poly([[p[0], p[1]], [q[0], q[1]], [q[0], q[1] + 1], [p[0], p[1] + 1]], color); }

// Burst: confetti. Each piece flies out on its own angle and falls; the last quarter of the life fades out.
function drawBurst(g, e, t, p) {
  const tau = t - e.t0, u = tau / e.seconds, fade = clamp01((1 - u) / 0.25);
  for (let i = 0; i < LIMITS.particles; i++) {
    const ang = unit(e.h, `a${i}`) * Math.PI * 2, sp = 14 + unit(e.h, `s${i}`) * 22, lift = 18 + unit(e.h, `l${i}`) * 20;
    const life = Math.min(e.seconds, 1.4 + unit(e.h, `t${i}`) * 1.2), k = Math.min(tau, life);
    const x = p.sx + Math.cos(ang) * sp * (1 - Math.exp(-k * 2)) * 0.5, y = p.sy - 10 + Math.sin(ang) * sp * 0.25 * (1 - Math.exp(-k * 2)) - lift * k + 26 * k * k;
    if (tau > life + 0.6) continue;
    const a = tau > life ? fade * clamp01(1 - (tau - life) / 0.6) : fade;
    const sz = i % 3 === 0 ? 2 : 1;
    g.rect(Math.round(x), Math.round(y), sz + (i % 2), sz, withAlpha(e.colors[i % e.colors.length], a));
  }
}

// Ring: an expanding isometric ring (2:1) of dots that thins out as it grows.
function drawRing(g, e, t, p) {
  const u = clamp01((t - e.t0) / e.seconds), r = 6 + 34 * (1 - (1 - u) * (1 - u)), a = 1 - u;
  const col = e.colors[0];
  for (let i = 0; i < LIMITS.ringPoints; i++) {
    const ang = (i / LIMITS.ringPoints) * Math.PI * 2 + unit(e.h, `r${i}`) * 0.08;
    g.rect(Math.round(p.sx + Math.cos(ang) * r), Math.round(p.sy + Math.sin(ang) * r * 0.5), 2, 1, withAlpha(col, a));
  }
}

// Site: scaffolding round an object's footprint (poles, rails, a diagonal brace), fading in and out. The object under it
// is drawn as usual; the overlay is what reads as "being built".
function drawSite(g, e, t, o) {
  const tau = t - e.t0, a = clamp01(Math.min(tau / 0.5, (e.seconds - tau) / 0.7));
  if (a <= 0) return;
  const w = o.w || 1, h = o.h || 1, H = Math.max(18, Math.min(60, o.z || 30));
  const pole = withAlpha('#8a5a2b', a), plank = withAlpha('#c9955a', a), shade = withAlpha('#5a3a1a', a);
  const base = [toScreen(o.tx, o.ty), toScreen(o.tx + w, o.ty), toScreen(o.tx + w, o.ty + h), toScreen(o.tx, o.ty + h)].map(q => [q.sx, q.sy]);
  const top = base.map(q => [q[0], q[1] - H]);
  const sway = Math.floor(tau * 4) % 2;   // the planks bob like a working crew
  for (let i = 0; i < 4; i++) { line(g, base[i], base[(i + 1) % 4], shade); line(g, top[i], top[(i + 1) % 4], plank); }
  for (let i = 0; i < 4; i++) g.rect(Math.round(base[i][0]) - 1, Math.round(top[i][1]), 2, H, pole);
  line(g, [base[3][0], base[3][1] - sway], top[2], plank);
  line(g, [base[2][0], base[2][1]], [top[1][0], top[1][1] + sway], plank);
  g.rect(Math.round((base[2][0] + base[3][0]) / 2) - 2, Math.round(base[2][1]) - 4, 4, 4, withAlpha('#c9955a', a));
}

/**
 * drawEventFx(g, list, t, { world, actors, berths, rect? }) draws every entry alive at t over the sprites, in 1x world
 * screen px through the Gfx interface (rect / poly). An entry whose target is gone is skipped. Pure of t.
 */
export function drawEventFx(g, list, t, env = {}) {
  let n = 0;
  for (const e of list || []) {
    if (!(t >= e.t0 && t < e.t0 + e.seconds)) continue;
    const type = e.fx.type;
    if (type === 'anim') continue;   // applied to the actor's sprite by the renderer (animOverrides)
    if (type === 'site') {
      const o = env.world?.objects?.get?.(e.fx.arg);
      if (o && Number.isFinite(o.tx)) { drawSite(g, e, t, o); n++; }
      continue;
    }
    const at = resolveAt(e.ref, env);
    if (!at) continue;
    const p = toScreen(at.x, at.y);
    if (env.rect && (p.sx < env.rect[0] - 80 || p.sx > env.rect[2] + 80 || p.sy < env.rect[1] - 120 || p.sy > env.rect[3] + 80)) continue;
    if (type === 'burst') drawBurst(g, e, t, p); else drawRing(g, e, t, p);
    n++;
  }
  return n;
}
