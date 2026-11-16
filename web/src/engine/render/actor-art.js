// Actor art for the engine renderer (agents, ambient folk, critters).
// Two sources, picked once per renderer:
//   doll   the mod's paper-doll parts (mod.actors: parts + lookOf, art/doll.js): code-drawn, 4 iso facings;
//   sheet  the fallback: classic 16x16 character sheets (columns = facing down/up/left/right, rows 0-3 = walk cycle,
//          row 4 = action) as "stickers" (1px ink outline + light rim, classic world.js rimmed()), scaled 1.25x
//          nearest-neighbour to the engine's 32x16 tile. The sheet NAMES are mod data: mod.actors.fallback (the default
//          world's when the mod has none); the engine only knows the file layout `actors/<name>.png`, `animals/<name>.png`.
// The sheet fallback is used when the viewer asks for it (?folk=ninja, or localStorage va.engine2.folk = 'ninja'), when
// the mod has no actors.parts / actors.lookOf, for any actor lookOf returns null for (e.g. critters), and for the rest
// of the session once lookOf throws.
//
//   createActorArt({ mod?, styleOf?, store?, folk?, search?, base?, loadImage?, createCanvas? }) -> {
//     load() -> Promise                 loads the sheets (idempotent); sheet frames are null until they are in
//     ready: boolean, mode: 'doll'|'sheet'
//     lookOf(actor) -> string|null      sheet name for an actor (null: not drawn by the sheets, e.g. carts)
//     lookFor(actor) -> Look|null       the doll look (doll mode), cached per actor
//     frame(actor, { selected }) -> { img, pivot:{x,y}, head? } | null   pivot = the feet point in img px
//     noteSeen(ids)                     records first-seen order for a batch (snapshot order), like classic va.seen
//     stats() -> { frames, looks, mode, doll }
//   }
// mod: a ResolvedMod; undefined = the default world. styleOf(projectName) -> the settlement style object or null.
// Sheet rules (classic world.js:659): boss or crown -> fallback.boss; sub -> fallback.subs by parent; other agents ->
// fallback.looks by their first-seen ordinal (seen); folk -> fallback.looks by a.look.seed; critters -> fallback.critters.
import { hash } from '../core/rng.js';
import { createCanvas as rasterCanvas } from '../art/raster.js';
import { createDoll } from '../art/doll.js';
import { READ } from '../art/alpha.js';
import { resolveMod, DEFAULT_MOD } from '../mod/registry.js';
import { API_VERSION, DOLL_SIZE } from '../mod/api.js';

export const SCALE = 1.25;
/** Critters are small animals: drawn at this fraction of the person scale, so a cat or chicken stands at about 60% of a person. */
export const CRITTER_RATIO = 0.6;
export const SEEN_KEY = 'va.engine2.seen';
export const FOLK_KEY = 'va.engine2.folk';
export const SEEN_MAX = 3000;
const LOOK_CACHE_MAX = 4096;

/** A fallback table with every field present (lists copied, names as strings). */
export function normaliseFallback(fb) {
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []);
  const critters = fb?.critters && typeof fb.critters === 'object' ? Object.fromEntries(Object.entries(fb.critters).filter(([, v]) => typeof v === 'string' && v)) : {};
  return Object.freeze({
    looks: Object.freeze(list(fb?.looks)), subs: Object.freeze(list(fb?.subs)),
    boss: typeof fb?.boss === 'string' && fb.boss ? fb.boss : null,
    critters: Object.freeze(critters), defaultCritter: typeof fb?.defaultCritter === 'string' ? fb.defaultCritter : null,
  });
}
function defaultMod() { try { return resolveMod(DEFAULT_MOD); } catch { return null; } }
const DEFAULT_FALLBACK = normaliseFallback(defaultMod()?.actors?.fallback);
/** The default world's sheet names (kept as exports for tools and older tests). */
export const LOOKS = DEFAULT_FALLBACK.looks;
export const NINJAS = DEFAULT_FALLBACK.subs;
export const BOSS = DEFAULT_FALLBACK.boss;

// engine facing (sim/actor.js faceFrom): 0 SE (toward the viewer), 1 SW, 2 NW, 3 NE -> sheet column 0 down, 1 up, 2 left, 3 right
const COL = [0, 2, 1, 3];

const defaultBase = () => `${(typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/'}assets/ninja-adventure/`;
function defaultLoad(src) {
  return new Promise((ok, no) => {
    if (typeof Image === 'undefined') { no(new Error('no Image')); return; }
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => no(new Error(`actor sheet ${src} failed`));
    im.src = src;
  });
}
/** localStorage as a JSON store; every access guarded (private windows, node). */
export const localStore = {
  get(k, d) {
    try { const v = globalThis.localStorage?.getItem(k); if (v == null) return d; try { return JSON.parse(v); } catch { return v; } } catch { return d; }
  },
  set(k, v) { try { globalThis.localStorage?.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } },
};

/** Row of the sheet for an actor's anim + frame (classic: walk rows 0-3, hammer alternates 0/4). */
export function rowOf(a) {
  const f = a.frame | 0;
  if (a.anim === 'walk' || a.anim === 'carry') return f % 4;
  if (a.anim === 'hammer') return f % 2 ? 4 : 0;
  return 0;
}
export const colOf = a => COL[(a.face | 0) & 3] ?? 0;
const pick = (list, n) => (list.length ? list[Math.abs(n | 0) % list.length] : null);
const roleOf = a => a.input?.role ?? a.status?.role ?? a.role ?? null;
const parentOf = a => a.parent ?? a.input?.parent ?? null;

/** Sheet name for an actor under a fallback table. seen: the agent's first-seen ordinal (else hash of its id). */
export function lookOf(a, fb = DEFAULT_FALLBACK, seen = a?.seen) {
  if (!a) return null;
  if (a.kind === 'critter') return fb.critters[a.species] || fb.critters[fb.defaultCritter] || Object.values(fb.critters)[0] || null;
  if (a.kind === 'agent') {
    const role = roleOf(a);
    if (role === 'boss' || a.input?.crown) return fb.boss;
    if (role === 'sub') return pick(fb.subs, hash(parentOf(a) ?? a.id));
    return pick(fb.looks, Number.isFinite(seen) ? seen : hash(a.id));
  }
  if (a.kind === 'folk') return pick(fb.looks, Number.isFinite(a.look?.seed) ? a.look.seed : hash(a.id));
  return null;
}

/** Install-stable first-seen ordinals (port of classic va.seen, village.js:23): an id keeps its ordinal for good;
 *  the oldest ids are trimmed past `max`, and the offset keeps every remaining ordinal unchanged. */
export function createSeenOrder({ store = localStore, key = SEEN_KEY, max = SEEN_MAX } = {}) {
  const raw = store?.get?.(key, null);
  let off = Number.isInteger(raw?.off) && raw.off >= 0 ? raw.off : 0;
  const ids = Array.isArray(raw?.ids) ? raw.ids.filter(x => typeof x === 'string') : [];
  const at = new Map(ids.map((id, i) => [id, off + i]));
  const save = () => store?.set?.(key, { off, ids });
  function add(id) {
    at.set(id, off + ids.length); ids.push(id);
    if (ids.length > max) { const n = ids.length - max; for (const old of ids.splice(0, n)) at.delete(old); off += n; }
  }
  return {
    of(id) {
      if (id == null) return null;
      id = String(id);
      if (!at.has(id)) { add(id); save(); }
      return at.get(id);
    },
    note(list) {
      let changed = false;
      for (const x of Array.isArray(list) ? list : []) { if (x == null) continue; const id = String(x); if (!at.has(id)) { add(id); changed = true; } }
      if (changed) save();
    },
    get size() { return ids.length; },
  };
}

/** 'ninja' when the viewer forces the sheet fallback (?folk=ninja, or the va.engine2.folk store key), else null. */
export function folkPref({ search = globalThis.location?.search ?? '', store = localStore } = {}) {
  try { if (new URLSearchParams(search || '').get('folk') === 'ninja') return 'ninja'; } catch { /* bad search */ }
  return store?.get?.(FOLK_KEY, null) === 'ninja' ? 'ninja' : null;
}

export function createActorArt({ mod, styleOf = null, store = localStore, folk, search, seen: seenOrder,
  base = defaultBase(), loadImage = defaultLoad, createCanvas = rasterCanvas } = {}) {
  const resolved = mod === undefined ? defaultMod() : mod;
  const actors = resolved?.actors && typeof resolved.actors === 'object' ? resolved.actors : null;
  const fb = actors?.fallback ? normaliseFallback(actors.fallback) : DEFAULT_FALLBACK;
  const critterSheets = new Set(Object.values(fb.critters));
  const files = Object.fromEntries([
    ...[fb.boss, ...fb.looks, ...fb.subs].filter(Boolean).map(k => [k, `actors/${k}.png`]),
    ...[...critterSheets].map(k => [k, `animals/${k}.png`]),
  ]);
  const pref = folk !== undefined ? folk : folkPref({ search, store });
  const parts = actors?.parts && typeof actors.parts === 'object' ? actors.parts : null;
  const canDoll = pref !== 'ninja' && typeof actors?.lookOf === 'function' && parts && Object.keys(parts).length > 0;
  const doll = canDoll ? createDoll({ size: actors.size ?? DOLL_SIZE, parts, anims: actors.anims ?? {}, createCanvas }) : null;
  const seen = seenOrder ?? createSeenOrder({ store });
  const ctx = Object.freeze({ hash, api: Object.freeze({ version: API_VERSION }) });
  let broken = false;

  const IMG = {};
  const frames = new Map();
  let loading = null, ready = false;

  function load() {
    if (loading) return loading;
    loading = Promise.all(Object.entries(files).map(([k, f]) => loadImage(base + f).then(im => { IMG[k] = im; }, () => {})))
      .then(() => { ready = true; });
    return loading;
  }

  const seenOf = a => (a?.kind === 'agent' ? seen.of(a.id) : null);

  // ---- doll looks: one lookOf call per actor while its inputs stay the same
  const looks = new Map();   // actor id -> { sig, look }
  const styleIds = new WeakMap();
  let styleN = 0;
  const styleId = s => { if (!s || typeof s !== 'object') return 0; let i = styleIds.get(s); if (!i) styleIds.set(s, i = ++styleN); return i; };
  function viewOf(a, sn) {
    const status = typeof a.status === 'string' ? a.status : typeof a.input?.status === 'string' ? a.input.status : null;
    return Object.freeze({
      id: String(a.id), kind: a.kind, role: roleOf(a), parent: parentOf(a), crown: !!a.input?.crown, important: !!a.input?.important,
      project: a.project ?? a.input?.project ?? null, status, species: a.species ?? null,
      seed: Number.isFinite(a.look?.seed) ? a.look.seed : null,
      seen: a.kind === 'agent' ? sn : Number.isFinite(a.look?.seed) ? a.look.seed : null,
    });
  }
  function lookFor(a) {
    if (!doll || broken || !a) return null;
    const style = typeof styleOf === 'function' ? (styleOf(a.project ?? a.input?.project ?? null) ?? null) : null;
    const sn = seenOf(a);
    const sig = `${a.kind}|${roleOf(a)}|${parentOf(a)}|${!!a.input?.crown}|${!!a.input?.important}|${a.project ?? ''}|${a.species ?? ''}|${a.look?.seed ?? ''}|${sn}|${styleId(style)}|${a.status}`;
    const id = String(a.id);
    const hit = looks.get(id);
    if (hit && hit.sig === sig) return hit.look;
    let look = null;
    try { look = actors.lookOf(viewOf(a, sn), style, ctx); }
    catch (e) {
      broken = true; looks.clear();
      try { console.warn(`actors.lookOf threw (${e?.message ?? e}); using the sheet fallback for this session`); } catch { /* no console */ }
      return null;
    }
    if (!look || typeof look !== 'object' || !Array.isArray(look.parts)) look = null;
    looks.delete(id); looks.set(id, { sig, look });
    if (looks.size > LOOK_CACHE_MAX) looks.delete(looks.keys().next().value);
    return look;
  }

  /** Classic sticker (world.js rimmed) at 1x, with a soft ground shadow, then scaled by SCALE (nearest). */
  function sticker(look, col, row, sel, flip) {
    const im = IMG[look];
    const critter = critterSheets.has(look);
    const sx = col * 16, sy = critter ? 0 : row * 16;
    const W = 20, H = 22;                       // 16x16 frame + 2px rim each side + 2px for the shadow below the feet
    const c1 = createCanvas(W, H), g = c1.getContext('2d');
    g.imageSmoothingEnabled = false;
    const blit = (ctx2, dx, dy) => {
      if (!flip) { ctx2.drawImage(im, sx, sy, 16, 16, dx, dy, 16, 16); return; }
      ctx2.save(); ctx2.translate(dx + 16, dy); ctx2.scale(-1, 1); ctx2.drawImage(im, sx, sy, 16, 16, 0, 0, 16, 16); ctx2.restore();
    };
    const sil = (color, pad) => {
      const c = createCanvas(16 + pad * 2, 16 + pad * 2), s = c.getContext('2d');
      for (let dy = -pad; dy <= pad; dy++) for (let dx = -pad; dx <= pad; dx++) if (Math.abs(dx) + Math.abs(dy) <= pad + (pad > 1 ? 1 : 0)) blit(s, pad + dx, pad + dy);
      s.globalCompositeOperation = 'source-in'; s.fillStyle = color; s.fillRect(0, 0, c.width, c.height);
      return c;
    };
    // shadow under the feet (classic agents), then rim, ink outline and the frame
    g.fillStyle = 'rgba(16, 10, 24, 0.45)';
    g.beginPath(); g.ellipse(10, 17.5, critter ? 5 : 6, 2.2, 0, 0, Math.PI * 2); g.fill();
    if (sel) g.drawImage(sil('#ffffff', 2), 0, 0);
    else { g.globalAlpha = 0.55; g.drawImage(sil('#fff4dc', 2), 0, 0); g.globalAlpha = 1; }
    g.drawImage(sil('#140f1c', 1), 1, 1);
    blit(g, 2, 2);
    const k = critter ? SCALE * CRITTER_RATIO : SCALE;
    const w2 = Math.round(W * k), h2 = Math.round(H * k);
    const c2 = createCanvas(w2, h2), g2 = c2.getContext('2d', READ);
    g2.imageSmoothingEnabled = false;
    g2.drawImage(c1, 0, 0, W, H, 0, 0, w2, h2);
    return { img: c2, pivot: { x: Math.round(10 * k), y: Math.round(18 * k) } };   // feet: frame bottom centre
  }

  function sheetFrame(a, selected) {
    if (!ready) return null;
    const look = lookOf(a, fb, seenOf(a));
    if (!look || !IMG[look]) return null;
    let col, row, flip = false;
    if (critterSheets.has(look)) {
      col = a.anim === 'idle' || a.anim === 'sit' || a.anim === 'sleep' ? 0 : (a.frame | 0) % 2; row = 0;
      flip = (a.face | 0) === 1 || (a.face | 0) === 2;   // strips face right; SW / NW are mirrored
    } else { col = colOf(a); row = rowOf(a); }
    const k = `${look}|${col}|${row}|${flip ? 1 : 0}|${selected ? 1 : 0}`;
    let f = frames.get(k);
    if (!f) { f = sticker(look, col, row, selected, flip); frames.set(k, f); }
    return f;
  }

  function frame(a, { selected = false } = {}) {
    if (!a) return null;
    if (doll && !broken) {
      const look = lookFor(a);
      if (look) return doll.frame(look, a.face | 0, a.anim, a.frame | 0, { selected });
    }
    return sheetFrame(a, selected);
  }

  return {
    load, frame, lookFor,
    lookOf: a => lookOf(a, fb, seenOf(a)),
    noteSeen: ids => seen.note(ids),
    get ready() { return ready; },
    get mode() { return doll && !broken ? 'doll' : 'sheet'; },
    stats: () => ({
      frames: frames.size + (doll ? doll.stats().frames : 0),
      looks: Object.keys(IMG).length + (doll && !broken ? Object.keys(parts).length : 0),
      mode: doll && !broken ? 'doll' : 'sheet', doll: doll ? doll.stats() : null,
    }),
  };
}
