// Renderer (design §3, §6.3). Composes depth/slice/sprites/ground/lighting/xray/raster/gfx.
// createRenderer({ canvas, gfx, mod, deps }) -> { setWorld(world), draw(frame) -> hits }.
// `deps` overrides the module imports so tests can inject fakes. Static imports only: Vite cannot bundle computed
// dynamic imports.
// Conventions assumed of the other modules (see report): gfx.begin(dpr, cam) installs the camera transform so that all
// draws use 1x world-screen px (sx = (tx-ty)*16, sy = (tx+ty)*8 - z); slice dx,dy are in that space.
import { toScreen, toTile } from '../core/coords.js';

import * as DEPTH from './depth.js';
import * as SLICE from './slice.js';
import * as SPRITES from './sprites.js';
import * as GROUND from './ground.js';
import * as LIGHT from './lighting.js';
import * as GROUNDCACHE from './ground-cache.js';
import * as XRAY from './xray.js';
import * as HITS from './hits.js';
import { sliceIndex, mergeHits } from './hits.js';
import * as RASTER from '../art/raster.js';
import { READ } from '../art/alpha.js';
import * as GFX from './gfx-canvas2d.js';
import * as ARTVIEW from '../mod/art-view.js';
import * as ACTOR from '../sim/actor.js';
import * as ACTORART from './actor-art.js';
import * as ACCENT from './accent.js';
import * as EFFECTS from './effects.js';
import * as MARKS from './marks.js';
import * as EVFX from './event-fx.js';
import * as MAPTILES from './map-tiles.js';
import * as TILESTORE from './map-tile-store.js';
import * as ATLAS from './actor-atlas.js';
import { styleKeyFor } from '../art/style-key.js';
import * as CRAFT from './craft-art.js';
import { venueOutlines } from './venue-outline.js';
import { anchors as lampAnchors } from '../art/props/lighthouse.js';
import { hash } from '../core/rng.js';
import { CARRIER_KIND } from '../../engine-host.js';
const DEFAULTS = {
  sortKey: DEPTH.sortKey, LAYER: DEPTH.LAYER, mergeSorted: DEPTH.mergeSorted, feetKey: DEPTH.feetKey, chunkOf: DEPTH.chunkOf,
  sliceSprite: SLICE.sliceSprite, SpriteCache: SPRITES.SpriteCache, spriteKey: SPRITES.spriteKey, placeholder: SPRITES.placeholder,
  createGround: GROUND.createGround, createGroundCache: GROUNDCACHE.createGroundCache, createLighting: LIGHT.createLighting, createXray: XRAY.createXray,
  rasterize: RASTER.rasterize, loadClassicArt: RASTER.loadClassicArt, createGfx: GFX.createGfx, artView: ARTVIEW.artView, FLAGS: ACTOR.FLAGS,
  createActorArt: ACTORART.createActorArt, styleKeyFor, buildHits: HITS.buildHits,
  accentsOf: ACCENT.accentsOf, accentEdges: ACCENT.accentEdges, drawAccentEdges: ACCENT.drawAccentEdges,
  createCraftArt: CRAFT.createCraftArt, createEffects: EFFECTS.createEffects, actorOffset: EFFECTS.actorOffset, selectionMarks: MARKS.selectionMarks, drawMarks: MARKS.drawMarks, importantStars: MARKS.importantStars,
  drawEventFx: EVFX.drawEventFx, animOverrides: EVFX.animOverrides, createMapTiles: MAPTILES.createMapTiles,
  createTileStore: TILESTORE.createTileStore,
  createActorAtlas: ATLAS.createActorAtlas,
};
// parity: bld.pr-building-site
/** A PR lot is a building site while its PR is live (lots.js writes data.building); data.site is the older name. */
export const siteOf = o => (o?.data?.owner === 'pr' ? !!o.data.building : !!o?.data?.site);
// Classic props are authored at the classic 0.8 projection (raster result.classic); they are scaled 1.25x
// (nearest) once, when the sprite is made, so they sit at engine scale next to engine-scale art.
const CLASSIC_UP = 1.25;
// Rasterising inside a frame is capped at FRAME_RASTER_MS (cache.get builds plus the pump): the rest of a streaming
// view's sprites are built between frames by the host through rasterIdle(ms) (engine index.js), so a pan or zoom into
// new art never makes one long frame.
const FRAME_RASTER_MS = 2;
// A view that moved in the last MOVE_MS rasters and bakes nothing inside a frame (see draw).
const MOVE_MS = 600;
// What it has no raster for at any key is built between frames (rasterIdle, every frame of the move). An in-frame pump
// of those was tried (1 ms): one raster alone is 2-5 ms, so it put the gesture p95 from 5.4-5.8 to 7.0-7.7 ms for one
// sprite a frame out of hundreds queued.
const TRIM_MS = 500;   // how often a frame puts the sprite cache back under its cap
// Sprite cache cap (design §3.4: an LRU by bytes, 48-64 MB): the low end, the busy-row budget. An entry drawn in the
// last 2 s is never evicted, so a view whose sprites need more holds them rather than re-rastering them every frame.
export const SPRITE_CACHE_BYTES = 48 << 20;
// While the view holds still over a kept layer, how often the per-object sprite check (LRU touch, arrivals) still runs.
const CHECK_MS = 1000;
// Props whose art reads the settlement style (classic props-art STYLED, engine banner). Every other prop draws the same
// in every settlement, so its sprite key leaves the style out and one sprite serves the whole world.
const STYLED_PROPS = new Set(['stall', 'maypole', 'lamppost', 'noticeboard', 'banner']);

export const CHUNK = 16;
const HIT_KIND = { building: 'house', venue: 'dock', token: 'ship' }; // hit names unchanged, so va:dock clicks still work
const STATIC_KINDS = new Set(['building', 'prop', 'tree', 'venue', 'token', 'decal']);
const MAP_ZOOM = 0.25;
// Working out tile signatures (a world rebuild, dusk) is spread over frames: at most this long per frame.
const MAP_SIG_MS = 2;
// Waterside actors (craft-art.js) and the carrier: drawn only while flagged VISIBLE (a carrier off the map is not).
const WATERSIDE = new Set([...CRAFT.CRAFT_KINDS, CARRIER_KIND]);
const SWEEP_FROM = 0.4;   // night amount from which a lighthouse sweeps
const ck = (cx, cy) => cx + ',' + cy;
const chunkIdx = (tx, ty) => [Math.floor(tx / CHUNK), Math.floor(ty / CHUNK)];

/** Nearest-neighbour 1.25x of a classic-scale raster result; pivot, bounds and anchors scale with it. */
function upscale(r) {
  const k = CLASSIC_UP, src = r.img, w = Math.round(src.width * k), h = Math.round(src.height * k);
  let c;
  try { c = RASTER.createCanvas(w, h); } catch { return r; }
  const g = c.getContext('2d', READ);   // CPU-backed like every raster canvas: an alpha readback never flushes the GPU
  if (!g) return r;
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
  const P = p => (p && Number.isFinite(p.x) ? { x: Math.round(p.x * k), y: Math.round(p.y * k) } : p);
  const b = r.bounds;
  const bounds = b ? { x: Math.floor(b.x * k), y: Math.floor(b.y * k), w: Math.min(w, Math.ceil((b.x + b.w) * k)) - Math.floor(b.x * k), h: Math.min(h, Math.ceil((b.y + b.h) * k)) - Math.floor(b.y * k) } : b;
  const anchors = {};
  for (const [n, v] of Object.entries(r.anchors || {})) anchors[n] = Array.isArray(v) ? v.map(P) : P(v);
  return { ...r, img: c, bounds, pivot: P(r.pivot), anchors, classic: true, scaled: k };
}

export function createRenderer({ canvas, gfx, mod, deps, debug = false } = {}) {
  const D = { ...DEFAULTS, ...(deps || {}) };
  const g = gfx || D.createGfx(canvas);
  const cache = deps?.cache || new D.SpriteCache({ maxBytes: SPRITE_CACHE_BYTES, budgetMs: FRAME_RASTER_MS });
  const LAYER = D.LAYER || { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 };
  const view_ = o => (D.artView ? D.artView(o) : o);
  const F = D.FLAGS || {};
  const hasFlag = (a, f) => F[f] !== undefined && ((a.flags | 0) & F[f]) !== 0;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // the art reads each actor's project style through a getter: `styles` is reassigned by setWorld
  const actorArt = D.createActorArt ? D.createActorArt({ mod, styleOf: name => styles.get(name) ?? null }) : null;
  const craftArt = D.createCraftArt ? D.createCraftArt() : null;
  // One ground chunk cache for the renderer's lifetime: keys are content hashes (ground.js), so a rebuilt world reuses
  // every chunk whose tiles did not change. Its presence opts the ground into the budgeted path (bakes per frame, baked Map LOD).
  const groundCache = deps?.groundCache ?? D.createGroundCache?.() ?? null;
  let artFailed = false, groundPending = 0, world = null, ground = null, lighting = null, xray = null, artReady = !D.loadClassicArt || !!(deps?.rasterize && !deps?.loadClassicArt), artLoading = null;
  // Slices depend on the object's position as well as its sprite, so they cannot live on the shared SpriteEntry
  // (one entry serves every cottage with the same look). Cache them per object id, valid while the object's slice inputs
  // (sliceAt: footprint, walk, run, look) and its sprite entry are unchanged. No world-version check: a rebuilt world
  // reuses the slices of every object that did not move or change (setWorld prunes ids that are gone).
  /** @type {Map<string, { entry: object, at: string, items: object[] }>} */
  const sliceCache = new Map();
  /** @type {Map<string, {list: object[], pending: Map<string, object>, objs: object[], dirty: boolean}>} */
  let chunks = new Map(), visPending = 0; // visPending: placeholder objects in the chunks the last frame drew

  // ---- sprites
  // raster.js takes the model NAME (it looks the classic art up itself) and needs the classic art loaded first;
  // until then make() yields null and the placeholder draws.
  // Placeholders: one per footprint and height (the default placeholder() makes a canvas per call). An injected
  // placeholder (tests) is called as before.
  const phCache = D.placeholder === SPRITES.placeholder ? new Map() : null;
  function placeholderOf(o) {
    if (!phCache) return D.placeholder(view_(o));
    const k = `${o.w | 0}|${o.h | 0}|${+o.z || 0}`;
    let e = phCache.get(k);
    if (!e) { e = D.placeholder(view_(o)); phCache.set(k, e); }
    return e;
  }
  let rasterMs = 0, rasterN = 0, failedN = 0;
  // ?debug only (createRenderer({ debug: true })): what frames drew in place of real art. placeholder = slices and actors
  // drawn as a placeholder box (art that can draw but is not rastered yet; actorPlaceholder: of those, actors), failed = the placeholder of art that cannot
  // draw, flat = ground chunks drawn as one flat quad, soft = a sprite or ground chunk drawn from another cached raster
  // (the other lit variant, the object's last sprite, a ground bake at another LOD), frames = frames counted.
  const draws = { placeholder: 0, actorPlaceholder: 0, failed: 0, flat: 0, soft: 0, softGround: 0, frames: 0 };
  const failedKeys = [];
  const EMPTY = { img: null, bounds: { x: 0, y: 0, w: 0, h: 0 }, pivot: { x: 0, y: 0 }, slices: [], anchors: {}, bytes: 0, lastUsed: 0, empty: true, failed: true };
  function makeFor(obj, lit = litOf(obj)) {   // lit is fixed when the job is queued (the day may turn before it runs)
    return () => {
      if (!artReady) return null; // not cached: tried again once the art is in
      const v = view_(obj), t0 = now();
      let r = null;
      try {
        r = D.rasterize(obj.model, styleOf(obj),
          { kind: obj.kind === 'building' ? 'building' : 'prop', variant: obj.variant, w: obj.w, h: obj.h, door: obj.door, lit,
            crown: obj.crown, site: siteOf(obj), accent: accentOf(obj), dir: obj.run?.dir ?? obj.dir, len: obj.run?.len ?? obj.len, scale: 1, anim: 0, obj: v });
      } catch { r = null; }
      rasterMs += now() - t0; rasterN++;
      // A model the art cannot draw is cached as its placeholder, so it is not raster-retried every frame.
      if (!r || !r.img) {
        failedN++; if (failedKeys.length < 20) failedKeys.push(`${obj.kind}:${obj.model}`);
        // a decal with no art draws nothing (a placeholder slab would be a grey box on the ground)
        if (obj.kind === 'decal') return { ...EMPTY };
        const p = placeholderOf(obj); return { ...p, failed: true };
      }
      return r.classic === true && !deps?.rasterize ? upscale(r) : r;
    };
  }
  const keys = new Map(); // obj.id -> sprite key, per world (keys are rebuilt by setWorld)
  let styles = new Map(); // settlement name -> its style object (world.villages[].style)
  const styled = obj => obj.kind === 'building' || STYLED_PROPS.has(obj.model);
  // The art takes a style OBJECT (iso.js / props-art.js ignore a string): the mod's table entry for the key, else the
  // object's settlement style.
  // parity: style.banners-on-plazas
  // The village accent (accent.js distinctAccents) rides on the style object the art reads (banner.js, iso.js
  // style.accent) and in the sprite key, so each village's banners and trims wear its own colour.
  let accents = new Map();
  const accentOf = obj => (obj?.project != null ? accents.get(obj.project) ?? null : null);
  function styleOf(obj) {
    if (!styled(obj)) return null;
    const m = mod?.styles?.[obj.styleKey];
    const base = m && typeof m === 'object' ? m : styles.get(obj.project) ?? (deps?.rasterize ? obj.styleKey : null);
    const acc = accentOf(obj);
    return acc && base && typeof base === 'object' ? { ...base, accent: acc } : acc && !base ? { accent: acc } : base;
  }
  // The style fields building art reads (mod.rules.styleReads): a hash of only those joins the sprite key, so a sprite is
  // re-rastered exactly when something it draws changes (a neighbour-rule recolour, a tier change), never otherwise.
  const styleReads = Array.isArray(mod?.rules?.styleReads) ? mod.rules.styleReads : null;
  function styleKey(obj) {
    if (!styled(obj)) return null;
    const st = styleReads && D.styleKeyFor ? styleOf(obj) : null;
    if (st && typeof st === 'object') return `${obj.styleKey}~${D.styleKeyFor(st, styleReads)}`;
    const acc = accentOf(obj);   // spriteKey has no accent field: it rides on the style key
    return acc ? `${obj.styleKey}~${acc}` : obj.styleKey;
  }
  // parity: bld.lit-windows-night
  // Classic (world.js): every building but a PR site is drawn with its windows lit once night passes 0.5. The sprite key
  // carries `lit`, so day frames keep their day key (and look) and the lit variant is a separate cache entry.
  let dark = false;
  const litOf = obj => dark && obj.kind === 'building' && obj.data?.owner !== 'pr';
  function keyOf(obj, lit) {
    return D.spriteKey({ model: obj.model, styleKey: styleKey(obj), variant: obj.variant, w: obj.w, h: obj.h,
      door: obj.door?.face, lit, site: siteOf(obj), crown: obj.crown, anim: 0,
      dir: obj.run?.dir ?? obj.dir, len: obj.run?.len ?? obj.len });
  }
  function keyFor(obj, lit = litOf(obj)) {
    let k = keys.get(obj.id);
    if (k === undefined) keys.set(obj.id, k = {});
    return lit ? (k.l ??= keyOf(obj, true)) : (k.d ??= keyOf(obj, false));
  }
  /**
   * The cached sprite of `o` (an LRU touch), else built within `budget` (else queued: null). A sprite the cache evicted
   * while the object still holds it (its slices, sliceCache) goes back into the cache as it is: no raster, same pixels.
   */
  function lookup(o, budget, k = keyFor(o)) {
    if (cache.adopt && !cache.map?.has?.(k)) { const s = sliceCache.get(o.id); if (s && s.key === k) cache.adopt(k, s.entry); }
    return cache.get(k, makeFor(o), budget);
  }
  const usable = e => !!e && !e.failed && !e.empty && !e.placeholder;
  function spriteOf(obj, peek = false) { // -> { entry, ready }; peek: a cache lookup only (no LRU touch, never a raster)
    const k = keyFor(obj);
    const e = peek ? cache.map?.get?.(k) ?? null : lookup(obj, frameBudget, k);
    if (e) return { entry: e, ready: true };
    // Not built yet (a moving view rasters nothing): draw the nearest raster there is rather than a placeholder box.
    // The other lit variant (never flash the placeholder at dusk), then the sprite this object drew last (an older key:
    // a restyle, the other lit variant evicted since) while its slice inputs are the same. It stays pending, so the
    // real sprite replaces it as soon as it is built.
    const other = cache.map?.get?.(keyFor(obj, !litOf(obj)));
    if (usable(other)) return { entry: other, ready: false };
    const s = sliceCache.get(obj.id);
    if (s && usable(s.entry) && s.at === sliceAt(obj)) return { entry: s.entry, ready: false };
    return { entry: placeholderOf(obj), ready: false };
  }

  // ---- static chunks
  function buildChunk(c, peek = false) {
    const items = []; c.pending = new Map();
    for (const obj of c.objs) {
      const { entry, ready } = spriteOf(obj, peek);
      if (!ready) c.pending.set(obj.id, obj);
      for (const it of slicesOf(obj, entry, ready)) items.push(it);
    }
    items.sort((a, b) => a.key - b.key);
    c.list = items;
  }
  // Everything sliceSprite (and the item fields below) reads from an object, plus its look (model/variant/style: also in the
  // sprite key, so the entry check catches them; kept here so the key stands on its own).
  const sliceAt = o => `${o.tx},${o.ty},${o.w},${o.h},${o.z ?? ''},${o.kind},${o.walk ?? ''},${o.run ? `${o.run.dir},${o.run.len},${o.run.side ?? ''}` : ''},`
    + `${o.dir ?? ''},${o.len ?? ''},${o.side ?? ''},${o.model},${o.variant ?? ''},${o.styleKey ?? ''}`;
  function slicesOf(obj, entry, ready) {
    if (entry.empty) return [];
    const at = sliceAt(obj);
    const hit = ready && sliceCache.get(obj.id);
    if (hit && hit.entry === entry && hit.at === at) {
      if (hit.items[0] && hit.items[0].obj !== obj) for (const it of hit.items) it.obj = obj;   // same slices, the rebuilt world's object
      return hit.items;
    }
    const hk = HIT_KIND[obj.kind];
    // draw marks for the ?debug counters: a placeholder box (`ph`), the box of art that cannot draw, another raster (`soft`)
    const mark = entry.placeholder ? (entry.failed ? 'failed' : 'ph') : ready ? null : 'soft';
    const items = D.sliceSprite(view_(obj), entry).map(s => ({ ...s, oid: obj.id, hit: hk, obj, z: obj.z, ...(mark ? { mark } : {}) }));
    if (ready) sliceCache.set(obj.id, { entry, at, items, key: keyFor(obj) }); // placeholders are per call: never cached
    return items;
  }
  let edges = [], effects = null, worldSeq = 0;
  // the kept street view (draw): the camera of the last frame, the static slice list of the view, the layer it is kept as
  let keepOn = true;   // setKeep(false): always the full draw (debug A/B)
  let lastCamNow = null, lastMoveT = -Infinity, frameBudget = FRAME_RASTER_MS, lastTrim = -Infinity;
  let lastCamKey = null, lastCheck = -Infinity, staticSeq = 0, stat = null, layerKey = null, lastWay = 'full';
  // the last town frame's phases in ms (stats().phase; the perf harness's --trace reads them)
  const phase = { pump: 0, chunks: 0, rebuilt: 0, stat: 0, ground: 0, world: 0, rest: 0 };
  /** The ready sprite entry of a static object, or null: a cache lookup only, never a raster. */
  function entryOf(o) { const e = cache.map?.get?.(keyFor(o)) ?? cache.map?.get?.(keyFor(o, false)) ?? null; return e && !e.failed && !e.empty ? e : null; }
  // parity: bld.lit-windows-agent-home
  const agentStatus = new Map();   // home object id -> its agent's status, refilled per lit frame
  function setWorld(w) {
    keys.clear();
    styles = new Map((w?.villages || []).filter(v => v?.style && typeof v.style === 'object').map(v => [v.name, v.style]));
    for (const id of sliceCache.keys()) if (!w?.objects?.get?.(id)) sliceCache.delete(id);   // gone objects only
    if (!artReady && !artLoading) {
      artLoading = Promise.resolve().then(() => D.loadClassicArt()).then(() => { artReady = true; }, () => { artFailed = true; });
    }
    actorArt?.load?.();
    world = w; chunks = new Map(); worldSeq++;
    accents = D.accentsOf ? D.accentsOf(w) : new Map();
    edges = D.accentEdges ? D.accentEdges(w, accents) : [];
    edgesSig = MAPTILES.sigHash(JSON.stringify(edges));
    // ambient effects read sprite anchors (chimney, ridge, windows) of ready sprites only
    // an injected effects hook (tests, mods) wins over the built-in ambient effects
    if (!deps?.effects) { effects = D.createEffects ? D.createEffects({ world: w, mod, accents, edges: false, entryOf: o => entryOf(o) }) : null; D.effects = effects; }
    for (const obj of w.objects.values()) {
      if (!STATIC_KINDS.has(obj.kind)) continue;
      const [cx, cy] = D.chunkOf ? chunkIdxVia(obj) : chunkIdx(obj.tx, obj.ty);
      const k = ck(cx, cy);
      let c = chunks.get(k); if (!c) chunks.set(k, c = { cx, cy, objs: [], list: [], pending: new Map(), built: false });
      c.objs.push(obj);
    }
    // chunks are built lazily, on first visibility (draw)
    ground = D.createGround({ world: w, mod, cache: groundCache }) // ground bakes its own chunk Map (the SpriteCache is not Map-like);
    // lighting keeps no per-world state the renderer relies on (draw passes the visible objects): one per renderer, so its
    // lightmap canvases and light-list memo survive rebuilds
    // parity: night.veil-light-pools
    lighting ||= D.createLighting({ world: w, statusOf: id => agentStatus.get(String(id)), lightsFor: mod?.lightsFor });
    xray = D.createXray({ world: w });
  }
  // chunkOf's exact return shape is not fixed in COMMON.md; accept {cx,cy}, [cx,cy], or fall back to our own math.
  function chunkIdxVia(obj) {
    const r = D.chunkOf(obj.tx, obj.ty);
    if (Array.isArray(r) && r.length === 2 && r.every(Number.isInteger)) return r;
    if (r && Number.isInteger(r.cx) && Number.isInteger(r.cy)) return [r.cx, r.cy];
    return chunkIdx(obj.tx, obj.ty);
  }

  // ---- actors
  function actorItem(a, alpha) {
    const x = a.px !== undefined ? a.px + (a.x - a.px) * alpha : a.x, y = a.py !== undefined ? a.py + (a.y - a.py) * alpha : a.y;
    // feet are float tiles with the tile centre at (tx + .5, ty + .5); depth compares the cell's north corner (depth.js feetKey)
    let key;
    if (D.feetKey) key = D.feetKey(x, y, LAYER.ACTOR);
    else { const s = x + y - 1, depth = Math.floor(s), sub = Math.min(3, Math.floor((s - depth) * 4)); key = D.sortKey(depth, sub, LAYER.ACTOR, Math.round(x - y)); }
    return { key, actor: a, x, y, oid: a.id, hit: a.kind === 'agent' ? 'agent' : a.kind === 'token' ? HIT_KIND.token : null, z: 0 };
  }
  // a carrier wears the look of the agent it works for, else a townsperson look by its own seed (kept per carrier: the
  // look records are compared by reference, actor-art lookFor)
  const carrierLooks = new Map();
  function carrierLook(a) {
    let c = carrierLooks.get(a.id);
    if (!c || c.agentId !== a.agentId || c.look0 !== a.look) {
      if (carrierLooks.size > 4096) carrierLooks.clear();
      carrierLooks.set(a.id, c = { agentId: a.agentId, look0: a.look, look: a.look ?? { seed: hash(a.id) } });
    }
    return { ...a, kind: a.agentId != null ? 'agent' : 'folk', id: a.agentId ?? a.id, look: c.look };
  }
  // People and critters: the classic character sheets as engine-scale stickers (actor-art.js); carts: the engine's cart
  // prop; anything else (or before the sheets load): a small cached placeholder box.
  function actorSprite(a, x, y, hl = false) {
    if (craftArt && CRAFT.CRAFT_KINDS.has(a.kind)) { const c = craftArt.frame(a, { lit: dark, hl }); if (c) return c; }
    // a carrier wears the look of the agent it works for, else a townsperson look by its own seed
    const who = a.kind === CARRIER_KIND ? carrierLook(a) : a;
    const f = actorArt?.frame?.(who, { selected: hasFlag(a, 'SELECTED') || !!a.selected });
    if (f) return f;
    if (a.kind === 'cart' && artReady) {
      const dir = (a.face | 0) % 2 ? 'y' : 'x';
      const key = D.spriteKey({ model: 'cart', styleKey: null, variant: 0, w: 1, h: 1, dir, len: 1 });
      // an actor's sprite is never deferred, not even by a moving view's zero budget: built now, at full quality
      const e = cache.get(key, () => D.rasterize('cart', null, { kind: 'prop', variant: 0, w: 1, h: 1, dir, len: 1, scale: 1, anim: 0 }), Infinity);
      if (e) return e;
    }
    return placeholderOf({ id: a.id, kind: 'prop', model: 'actor:' + a.kind, tx: Math.floor(x), ty: Math.floor(y), w: 1, h: 1, z: 14, styleKey: '', variant: 0, walk: 'floor' });
  }

  // A carried lantern: a tiny frame and warm pane at hand height, right of the actor's feet (1x world px).
  function lantern(p) {
    const x = Math.round(p.sx) + 5, y = Math.round(p.sy) - 13;
    g.rect(x, y - 1, 3, 1, '#3a2a1a'); g.rect(x - 1, y, 5, 5, '#3a2a1a'); g.rect(x, y + 1, 3, 3, '#ffd27a');
  }

  // A crate held at the chest (a carrier's load), right in front of the actor's feet (1x world px).
  function carried(p) {
    const x = Math.round(p.sx) - 3, y = Math.round(p.sy) - 15;
    g.rect(x - 1, y - 1, 8, 7, '#2a1a0e'); g.rect(x, y, 6, 5, '#b98c4e'); g.rect(x, y + 2, 6, 1, '#7a5630'); g.rect(x + 2, y, 1, 5, '#7a5630');
  }

  // Map zoom (actor-atlas.js): an actor's frame from the atlas page of the device scale, under its frame key. People and
  // critters are keyed by actor-art frameKey (the doll composes nothing for a key the atlas has); any other actor sprite
  // (craft, carts) by its image, which its own cache keeps.
  const imgKeys = new WeakMap();
  let imgKeyN = 0;
  const imgKey = img => { let k = imgKeys.get(img); if (k === undefined) imgKeys.set(img, k = 'i|' + ++imgKeyN); return k; };
  function atlasSlot(a, x, y, hl, s) {
    const art = actorArt && !hl && a.kind !== 'cart' && !(craftArt && CRAFT.CRAFT_KINDS.has(a.kind));
    if (art) {
      const who = a.kind === CARRIER_KIND ? carrierLook(a) : a, sel = { selected: hasFlag(a, 'SELECTED') || !!a.selected };
      const k = actorArt.frameKey?.(who, sel);
      if (k) return atlas.get(k, s) ?? atlas.put(k, s, actorArt.frame(who, sel));
    }
    const e = actorSprite(a, x, y, hl);
    if (!e?.img || e.placeholder) return null;
    const k = imgKey(e.img);
    return atlas.get(k, s) ?? atlas.put(k, s, e);
  }

  /** The frame's outdoor actors in `rect` (64 px margin) as drawable items with their real sprite, back to front. */
  /** mapScale: Map zoom's device scale, to draw people and critters from the actor atlas (it.slot) */
  function actorItems(frame, rect, mapScale = 0) {
    const alpha = frame.alpha ?? 1, m = 64, items = [], list = frame.actors || [];
    const useAtlas = mapScale > 0 && atlas && !debugNoAtlas;
    // event fx: an `anim:<name>` effect swaps an actor's pose for its lifetime (a copy; the sim's actor is untouched)
    const poses = frame.fx?.length && D.animOverrides ? D.animOverrides(frame.fx, frame.t ?? 0) : null;
    // the hull under the pointer (host panel hover '<kind>:<actor id>') is drawn with its highlight outline
    const hoverHull = hoveredToken(frame.hoverPanel);
    for (let a of list) {
      if (hasFlag(a, 'INDOORS')) continue;
      if (WATERSIDE.has(a.kind) && !hasFlag(a, 'VISIBLE')) continue;
      // culled on its interpolated feet before anything else is worked out for it
      const x = a.px !== undefined ? a.px + (a.x - a.px) * alpha : a.x, y = a.py !== undefined ? a.py + (a.y - a.py) * alpha : a.y;
      const p = toScreen(x, y);
      if (p.sx < rect[0] - m || p.sx > rect[2] + m || p.sy < rect[1] - m || p.sy > rect[3] + 2 * m) continue;
      const pose = poses?.get(String(a.id));
      if (pose) a = { ...a, anim: pose.anim, frame: pose.frame };
      const it = actorItem(a, alpha);
      it.p = p;
      // the sprite actually drawn: its size and pivot are the actor's hit rect and x-ray shape
      const hl = a.kind === 'token' && hoverHull != null && hoverHull === String(a.id);
      const sl = useAtlas ? atlasSlot(a, it.x, it.y, hl, mapScale) : null;
      if (sl) {
        it.slot = sl; it.w = sl.w; it.h = sl.h; it.pivot = sl.pivot; it.head = sl.head;
        if (a.kind === 'token') it.img = actorSprite(a, it.x, it.y, hl).img;   // a hull's hit is its pixels (buildHits)
        items.push(it);
        continue;
      }
      const e = actorSprite(a, it.x, it.y, hl);
      const w = e.img?.width ?? 16, h = e.img?.height ?? 24;
      it.img = e.img; it.w = w; it.h = h; it.pivot = { x: e.pivot?.x ?? w / 2, y: e.pivot?.y ?? h };
      if (e.head) it.head = e.head;
      if (e.placeholder) it.ph = true;
      items.push(it);
    }
    return items.sort((a, b) => a.key - b.key);
  }

  // ---- actors over a kept static layer (see draw: the kept / keep ways)
  /** Where an actor item's sprite lands (1x world px), with its stalled bob, a gull's lift and a hull's bob. */
  function actorAt(it, t) {
    const a = it.actor, p = it.p;
    // parity: vil.stalled-bob
    const o = D.actorOffset && a.kind === 'agent' ? D.actorOffset(a, t) : null;
    const lift = a.kind === 'gull' ? Math.round(+a.alt || 0) : 0, bob = a.kind === 'token' || a.kind === 'tug' || a.kind === 'rowboat' ? Math.round(+a.bob || 0) : 0;
    return { x: Math.round(p.sx - it.pivot.x + (o?.dx || 0)), y: Math.round(p.sy - it.pivot.y + (o?.dy || 0) - lift + bob), lift };
  }
  function drawActor(it, frame, drawn, drawnItems) {
    const a = it.actor, p = it.p, at = it.at ?? actorAt(it, frame.t ?? 0);
    const al = hasFlag(a, 'GHOST') ? 0.5 : Number.isFinite(a.alpha) && a.alpha < 1 ? Math.max(0, a.alpha) : undefined;
    if (at.lift) g.rect(Math.round(p.sx) - 2, Math.round(p.sy), 5, 2, 'rgba(16,10,24,0.18)');   // a gull's shadow on the water
    const sl = it.slot;
    // Map zoom: the frame pre-scaled in the actor atlas, copied 1:1 at the whole device px nearest its 1x spot
    if (sl) g.image(sl.img, sl.sx, sl.sy, sl.sw, sl.sh, Math.round(at.x * slotScale) / slotScale, Math.round(at.y * slotScale) / slotScale, sl.sw / slotScale, sl.sh / slotScale, al);
    else g.image(it.img, 0, 0, it.w, it.h, at.x, at.y, it.w, it.h, al);
    if (debug && it.ph) { draws.placeholder++; draws.actorPlaceholder++; }
    if (a.kind === CARRIER_KIND && a.carry) carried(p);
    if (a.fx && a.fx.includes?.('lantern')) lantern(p);   // night walkers carry one (mods ambient); lighting.js adds its pool
    drawn.push(a); drawnItems.push(it);
  }
  /** The rect an actor item can touch (its sprite, plus the shadow, crate and lantern round its feet), 1 px margin. */
  function actorBox(it) {
    const at = it.at, sx = Math.round(it.p.sx), sy = Math.round(it.p.sy);
    return [Math.min(at.x, sx - 6) - 1, Math.min(at.y, sy - 18) - 1, Math.max(at.x + it.w, sx + 10) + 1, Math.max(at.y + it.h, sy + 3) + 1];
  }
  // column buckets (16 px) of every slice of the kept static list, for the slices under an actor's rect
  function colIndex(list) {
    const cols = new Map();
    list.forEach((it, i) => {
      const e = { it, i, r: [it.dx, it.dy, it.dx + it.sw, it.dy + it.sh], seen: 0 };
      for (let c = Math.floor(e.r[0] / 16), c1 = Math.floor((e.r[2] - 1) / 16); c <= c1; c++) { let b = cols.get(c); if (!b) cols.set(c, b = []); b.push(e); }
    });
    return cols;
  }
  let stamp = 0;
  /** The kept slices overlapping any of `rects`, in their back-to-front order. */
  function slicesIn(rects) {
    const cols = stat.cols ??= colIndex(stat.list), s = ++stamp, out = [];
    for (const r of rects) {
      for (let c = Math.floor(r[0] / 16), c1 = Math.floor((r[2] - 1) / 16); c <= c1; c++) {
        const b = cols.get(c); if (!b) continue;
        for (const e of b) if (e.seen !== s && e.r[0] < r[2] && r[0] < e.r[2] && e.r[1] < r[3] && r[1] < e.r[3]) { e.seen = s; out.push(e); }
      }
    }
    out.sort((p, q) => p.i - q.i);
    return out.map(e => e.it);
  }
  /**
   * Actors over the kept static layer: clip to the rects round them, put the kept ground back there, then draw every
   * slice under those rects and every actor, back to front. Inside the rects that is exactly the full draw; outside them
   * the kept layer already is.
   */
  function redrawActors(items, frame, drawn, drawnItems) {
    if (!items.length) return;
    const t = frame.t ?? 0, rects = [];
    for (const it of items) { it.at = actorAt(it, t); rects.push(actorBox(it)); }
    g.clipRects(rects);
    g.drawLayer('ground');
    for (const it of D.mergeSorted([slicesIn(rects), items])) {
      if (it.actor) drawActor(it, frame, drawn, drawnItems);
      else g.image(it.img, it.sx, it.sy, it.sw, it.sh, it.dx, it.dy, it.sw, it.sh);
    }
    g.unclip();
  }

  /** Visible chunk range: corners of the view mapped back to tiles, plus a 1-chunk ring (tall sprites, big footprints). */
  function chunkRange(rect) {
    const cs = [toTile(rect[0], rect[1]), toTile(rect[2], rect[1]), toTile(rect[0], rect[3]), toTile(rect[2], rect[3])];
    return { minX: Math.floor(Math.min(...cs.map(c => c.tx)) / CHUNK) - 1, maxX: Math.floor(Math.max(...cs.map(c => c.tx)) / CHUNK) + 1,
      minY: Math.floor(Math.min(...cs.map(c => c.ty)) / CHUNK) - 1, maxY: Math.floor(Math.max(...cs.map(c => c.ty)) / CHUNK) + 1 };
  }
  const SEA = () => mod?.sea?.color ?? mod?.terrain?.sea?.color ?? '#2b6f9c';

  // ---- draw
  function draw(frame) {
    if (!world) return [];
    const { cam, view } = frame, { cssW, cssH, dpr } = view, z = cam.z;
    frameStill = !!frame.still;
    dark = (frame.night ?? 0) > 0.5;
    const c0 = toScreen(cam.x, cam.y), hw = cssW / 2 / z, hh = cssH / 2 / z;
    const rect = [c0.sx - hw, c0.sy - hh, c0.sx + hw, c0.sy + hh];
    const gview = { cssW, cssH, dpr, rect, mode: frame.mode, zoom: z };
    const toCss = (x, y) => [(x - c0.sx) * z + cssW / 2, (y - c0.sy) * z + cssH / 2];
    const isMap = z <= MAP_ZOOM || frame.mode === 'map';
    g.begin(dpr, cam);
    let ph = now();
    // While the view moves (a drag, a zoom step, and MOVE_MS after), a frame rasters nothing and bakes no ground: what is
    // missing draws as placeholder / flat ground and is built between frames (rasterIdle), so a gesture frame never
    // pays for a raster. A still view keeps the small in-frame budget.
    const camNow = `${worldSeq}|${cam.x}|${cam.y}|${z}|${cssW}|${cssH}`;
    if (lastCamNow !== null && camNow !== lastCamNow) lastMoveT = ph;
    lastCamNow = camNow;
    const moving = ph - lastMoveT < MOVE_MS;
    if (isMap) return drawMap(frame, { cam, cssW, cssH, dpr, z, rect, gview, toCss, moving });
    lastMap = null;
    const lap = k => { const t = now(); phase[k] = +(t - ph).toFixed(2); ph = t; };
    phase.rebuilt = 0;
    frameBudget = moving ? 0 : (frame.budgetMs ?? FRAME_RASTER_MS);
    cache.pump?.(frameBudget);
    if (ph - lastTrim >= TRIM_MS) { lastTrim = ph; cache.trim?.(); }   // back under the cap once sprites go stale
    lap('pump');
    const camKey = `${worldSeq}|${cam.x}|${cam.y}|${z}|${cssW}|${cssH}|${dpr}`;
    const still = camKey === lastCamKey;
    noteView({ cam, cssW, cssH, rect, camKey });
    lastCamKey = camKey;
    const { minX, maxX, minY, maxY } = chunkRange(rect);
    // While the view holds still on a kept layer, the per-object sprite check (LRU touch, evicted or arrived sprites) runs
    // once a second instead of every frame: the layer already shows every static pixel.
    const t0 = now(), check = !(still && layerKey && layerKey.startsWith(camKey + '#')) || t0 - lastCheck >= CHECK_MS;
    if (check) lastCheck = t0;
    // without a check nothing static can change, so a kept view reuses last frame's chunk lists and objects as they are
    const reuse = !check && stat?.key === `${camKey}#${staticSeq}` && stat.visObjs;
    const lists = reuse ? stat.lists : [], visObjs = reuse ? stat.visObjs : [];
    if (!reuse) visPending = 0;
    // the touch throttle runs on the cache's own clock (its LRU and the 2 s rule are in that time)
    const tc = typeof cache.now === 'function' ? cache.now() : t0;
    if (!reuse) for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
      const c = chunks.get(ck(cx, cy)); if (!c) continue;
      if (!c.built) { buildChunk(c); c.built = true; c.touched = tc; c.dark = dark; staticSeq++; phase.rebuilt++; }
      else if (check) {
        // Touch every ready sprite of a drawn chunk so the cache's LRU keeps it; rebuild when the entry was evicted and
        // re-made (or is gone), and when a pending sprite arrived. The full touch runs once per CHECK_MS per chunk, also
        // while the view moves: a sprite touched in the last CHECK_MS cannot have been evicted (KEEP_MS > CHECK_MS), so a
        // pan or zoom no longer walks every object of the view each frame. Pending arrivals are checked every frame, and
        // dusk or dawn (the lit key) touches at once.
        let dirty = false;
        if (c.dark !== dark || !(tc - (c.touched ?? -Infinity) < CHECK_MS)) {
          c.touched = tc; c.dark = dark;
          for (const o of c.objs) {
            if (c.pending.has(o.id)) continue;
            const e = lookup(o, frameBudget);
            if (!e || sliceCache.get(o.id)?.entry !== e) dirty = true;
          }
        }
        // arrivals: a lookup, unless the job is no longer queued (Map zoom cancelled it): then get() asks again
        for (const o of c.pending.values()) {
          const k = keyFor(o);
          if (cache.map?.has?.(k) ? cache.get(k, makeFor(o)) : !cache.queue?.has?.(k) && cache.get(k, makeFor(o), frameBudget)) dirty = true;
        }
        if (dirty) { buildChunk(c); staticSeq++; phase.rebuilt++; }
      }
      visPending += c.pending.size;
      lists.push(c.list); for (const o of c.objs) visObjs.push(o);
    }
    // the static slices of this view, back to front, culled to the view rect: kept while the camera and every chunk list
    // are unchanged (the same array each frame, so hit lists and the x-ray's slice index are built once for it)
    lap('chunks');
    const statKey = `${camKey}#${staticSeq}`;
    if (!stat || stat.key !== statKey) {
      const all = D.mergeSorted(lists), list = [];
      for (const it of all) if (it.dx < rect[2] && it.dx + it.sw > rect[0] && it.dy < rect[3] && it.dy + it.sh > rect[1]) list.push(it);
      stat = { key: statKey, list, hits: null, index: null, cols: null };
    }
    stat.lists = lists; stat.visObjs = visObjs;
    lap('stat');

    // actors: cull by screen rect, sort once per frame
    const items = actorItems(frame, rect);

    // building fade (selected actor behind/inside): per-object alpha, computed only when someone is selected
    const selected = (frame.actors || []).filter(a => hasFlag(a, 'SELECTED') || a.selected);
    const fade = new Map();
    if (selected.length && xray?.fadeFor) {
      for (const o of visObjs) if (o.kind === 'building') { const f = xray.fadeFor(o, selected); if (f !== undefined && f < 1) fade.set(o.id, f); }
    }

    // Three ways to draw the world layer, all to the same pixels:
    //  - kept: the view and every static slice are as last frame. The kept static layer goes back up, and only the
    //    rects round the actors are redrawn (kept ground, then the slices there and the actors, back to front, clipped).
    //  - keep: the view held still for a frame: ground, then every static slice, each kept as a layer; then as kept.
    //  - full: the view is moving, a sprite is pending, a building is faded, or the gfx keeps no layers: everything,
    //    actors merged into the slices, as before.
    const canKeep = keepOn && !!(g.saveLayer && g.drawLayer && g.clipRects) && !fade.size;
    let way = 'full';
    if (canKeep && layerKey === statKey && g.drawLayer('static')) way = 'kept';
    else if (canKeep && still && !visPending) way = 'keep';
    const drawn = [], drawnItems = [];
    if (way !== 'kept') {
      g.clear(SEA());
      // moving: no fresh bake; an unbaked chunk draws from another bake (Map LOD, an older bake), and one with no bake
      // at all that was already flat last frame is baked (rescue: flat ground never outlasts a frame)
      const gr = ground.drawChunks(g, cam, moving ? { ...gview, maxBakes: 0, rescue: 1 } : gview);
      groundPending = gr?.pending | 0;
      if (debug) { draws.flat += gr?.flat | 0; draws.softGround += gr?.soft | 0; }
      // parity: style.plot-accent-edge
      if (edges.length && D.drawAccentEdges) D.drawAccentEdges(g, edges, gview);   // on the ground, under every sprite
      if (way === 'keep' && (groundPending || !g.saveLayer('ground'))) way = 'full';
    }
    lap('ground');
    let hits;
    if (way === 'full') {
      layerKey = null;
      const merged = D.mergeSorted([stat.list, items]);
      // one hit per slice and per actor (drawn sprite rect), front to back (hits.js); pick.js chooses among them
      hits = D.buildHits(merged, toCss);
      for (const it of merged) {
        if (it.actor) drawActor(it, frame, drawn, drawnItems);
        else g.image(it.img, it.sx, it.sy, it.sw, it.sh, it.dx, it.dy, it.sw, it.sh, fade.get(it.oid));
      }
      if (debug) countMarks(stat.list);
    } else {
      if (way === 'keep') {
        for (const it of stat.list) g.image(it.img, it.sx, it.sy, it.sw, it.sh, it.dx, it.dy, it.sw, it.sh);
        if (debug) countMarks(stat.list);
        layerKey = g.saveLayer('static') ? statKey : null;
      }
      redrawActors(items, frame, drawn, drawnItems);
      stat.index ??= sliceIndex(stat.list);
      stat.hits ??= D.buildHits(stat.list, toCss);
      hits = mergeHits(stat.hits, D.buildHits(items, toCss, { index: stat.index }));
    }
    if (debug) draws.frames++;
    const drawnSlices = stat.list;   // the slices drawn this frame (all of the view's), for the x-ray
    lastWay = way;
    lap('world');

    // animated building parts (windmill sails, forge glow), then the ambient effects, both over the sprites
    animParts(visObjs, frame.t ?? 0, fade);
    D.effects?.draw?.(g, cam, gview, frame);
    // world-event effects (event-fx.js): confetti, rings, scaffolds; frame.fx is the engine's list of active entries
    if (frame.fx?.length && D.drawEventFx) D.drawEventFx(g, frame.fx, frame.t ?? 0, { world, actors: frame.actors, berths: frame.berths, rect });
    if ((frame.night ?? 0) > SWEEP_FROM) sweeps(visObjs, frame.t ?? 0, frame.night);
    // light
    if ((frame.night ?? 0) > 0 && lighting) {
      lighting.setTime(frame.phase ?? frame.night);
      // one pass over the frame's actors: home object id -> status, so a home's window light is a Map lookup, not a scan
      agentStatus.clear();
      for (const a of frame.actors || []) {
        const st = a.input?.status ?? a.status?.bucket;
        if (st != null && a.home != null) agentStatus.set(String(a.home), st);
      }
      // window anchors of a drawn building sprite, as offsets from the footprint's north corner (sprite px - pivot)
      const windowsOf = o => {
        const e = lookup(o, frameBudget);
        const ws = e?.anchors?.windows;
        return Array.isArray(ws) && ws.length && e.pivot ? ws.map(w => ({ x: w.x - e.pivot.x, y: w.y - e.pivot.y })) : null;
      };
      // parity: night.veil-light-pools (a mod's extra pools: lanterns, braziers, anything not tied to an object)
      let pools = lighting.lights(visObjs, drawn, windowsOf);
      try { const extra = mod?.extraLights?.(world, frame.actors || []); if (Array.isArray(extra) && extra.length) pools = pools.concat(extra); } catch { /* a bad mod hook adds no pools */ }
      lighting.draw(g, cam, gview, pools);
    }
    // x-ray: occluded passers-by only, judged and drawn at their drawn (interpolated) sprite rect against the slices
    // actually drawn in front of them
    if (xray) {
      const occ = drawnItems.filter(it => xray.occluded(it.actor, { item: it, slices: drawnSlices }));
      if (occ.length) xray.draw(g, cam, occ, drawnSlices, { night: frame.night ?? 0 });
    }
    // the figure's top (doll frames carry `head`, the topmost opaque row; sheet frames do not): marks sit on it
    const byId = new Map((frame.actors || []).map(a => [a.id, a]));
    const headOf = id => { const a = byId.get(id), f = a ? actorArt?.frame?.(a, { selected: false }) : null; return f?.head && f.pivot ? f.pivot.y - f.head.y : null; };
    // selection marks: indoors ghost at the door, the home outline, the marker over a selected agent
    if (D.selectionMarks && D.drawMarks) {
      const marks = D.selectionMarks({ world, actors: frame.actors || [], selected: frame.selected ?? undefined, crowd: frame.crowd });
      if (D.importantStars) {
        // only the stars of the actors in the view (with the actors' margin): one off the view draws nothing anyone sees
        const r = rect, m = 64;
        marks.stars = D.importantStars({ actors: frame.actors || [] }).filter(st => { const p = toScreen(st.x, st.y); return p.sx >= r[0] - m && p.sx <= r[2] + m && p.sy >= r[1] - m && p.sy <= r[3] + 2 * m; });
      }
      D.drawMarks(g, marks, { entryOf: doorOf, frameOf: a => actorArt?.frame?.(a, { selected: true }) ?? null, headOf, now: (frame.t ?? 0) * 1000 });
    }
    // host panel hover: a hull under the pointer is drawn with its own highlight outline (above) and nothing else lights
    // up; the venue itself (a pier) outlines its walkable decks, one outline per pier rather than one per plank section
    if (frame.hoverPanel && hoveredToken(frame.hoverPanel) == null) for (const r of venueOutlines(visObjs)) outline(r, '#ffe9a8');
    // screen-space badges are drawn by the engine after g.end() (overlay/badges.js, device px); this hook stays for mods/tests
    D.badges?.draw?.(g, cam, gview, drawn, toCss);
    g.end();
    lap('rest');
    return hits;
  }

  /** ?debug: the slices of a drawn static list that are not their real sprite (see `draws`). */
  function countMarks(list) {
    for (const it of list) if (it.mark) { if (it.mark === 'ph') draws.placeholder++; else if (it.mark === 'failed') draws.failed++; else draws.soft++; }
  }

  // ---- Map zoom (z <= MAP_ZOOM): the same village, smaller (map-tiles.js). The static town (ground, accent edges, every
  // sprite slice) is drawn from cached tiles, each the full street-view draw of its rect at 1x box-filtered down to the
  // device scale; the actors (their real sprites), the ambient and event effects, the night light and the selection
  // marks are drawn over them per frame, as in the street view. Tiles are baked nearest the view centre first, between
  // frames (rasterIdle), never inside one; a tile not baked yet shows its stale bake or another
  // scale's, else the ground (Map LOD chunks) under it. The hits are the actors' only (a click at Map zoom picks a
  // neighbourhood, input-ctl villageAt). The tiled layer is kept by the gfx per camera once every tile is fresh.
  let mapKey = null, lastMap = null, edgesSig = '', tileG = null, tileCv = null;
  // canvases for the tiles: deps.createCanvas (tests), else the raster's factory
  const canvasOf = (w, h) => { try { return (D.createCanvas ?? RASTER.createCanvas)(w, h); } catch { return null; } };
  const mapTiles = D.createMapTiles ? D.createMapTiles({ createCanvas: canvasOf }) : null;
  // baked tiles kept across sessions (map-tile-store.js): null with no IndexedDB (node tests) or on a dev page
  const tileStore = mapTiles && D.createTileStore ? D.createTileStore() : null;
  // Map zoom's actor frames, pre-scaled to the device scale (actor-atlas.js); debugNoAtlas: the direct draw (A/B)
  const atlas = D.createActorAtlas ? D.createActorAtlas({ createCanvas: canvasOf }) : null;
  let slotScale = 1, debugNoAtlas = false;
  const tileSigs = new Map();   // tile key -> signature, for the current world and lit state (mapSigAt)
  let mapSigAt = null;
  function mapObjs(rect) {
    const out = [], { minX, maxX, minY, maxY } = chunkRange(rect);
    for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
      const c = chunks.get(ck(cx, cy));
      if (c) for (const o of c.objs) out.push(o);
    }
    return out;
  }
  // What an object's slices are drawn from (its slice inputs and sprite key, lit or not), per world and lit state.
  const objSigs = new Map();
  const objSig = o => { let h = objSigs.get(o.id); if (h === undefined) objSigs.set(o.id, h = MAPTILES.sigHash(`${o.id}@${sliceAt(o)}#${keyFor(o)}`)); return h; };
  const tileCam = r => { const t = toTile((r[0] + r[2]) / 2, (r[1] + r[3]) / 2); return { x: t.tx, y: t.ty, z: 1 }; };
  const TILE_VIEW = { cssW: MAPTILES.TILE, cssH: MAPTILES.TILE, dpr: 1 };
  /**
   * Signature of everything tile (ix, iy) is drawn from: the objects that reach it, its ground chunks' content keys, the
   * accent edges. Null when it is not worked out yet and `deadline` has passed (the work is spread over frames).
   */
  function tileSig(ix, iy, deadline = Infinity) {
    const at = `${worldSeq}|${dark}`;
    if (mapSigAt !== at) { tileSigs.clear(); objSigs.clear(); mapSigAt = at; }
    const k = `${ix},${iy}`;
    let s = tileSigs.get(k);
    if (s !== undefined) return s;
    if (now() > deadline) return null;
    const t0 = now(), r = MAPTILES.tileRect(ix, iy);
    let src = edgesSig + '|';
    for (const o of objsReaching(r)) src += objSig(o) + ';';
    for (const g0 of ground.chunkKeys?.(TILE_VIEW, tileCam(r)) ?? []) src += g0.key + ';';
    tileSigs.set(k, s = MAPTILES.sigHash(src));
    mb.sigMs += now() - t0;
    return s;
  }
  // How far above its footprint a static sprite can reach (1x px): the reach test that picks a tile's objects before their
  // sprites are known (the tallest art, a cathedral spire or the lighthouse, is well under it). The slices themselves
  // are then culled to the tile exactly.
  const REACH_UP = 384, REACH_SIDE = 32;
  /** The static objects whose sprite can reach rect r (footprint screen box grown by the reach). */
  function objsReaching(r) {
    const out = [], { minX, maxX, minY, maxY } = chunkRange([r[0] - REACH_SIDE, r[1], r[2] + REACH_SIDE, r[3] + REACH_UP]);
    for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
      const c = chunks.get(ck(cx, cy)); if (!c) continue;
      for (const o of c.objs) {
        const w = o.w || 1, h = o.h || 1;
        const x0 = (o.tx - o.ty - h) * 16 - REACH_SIDE, x1 = (o.tx + w - o.ty) * 16 + REACH_SIDE;
        const y0 = (o.tx + o.ty) * 8 - REACH_UP, y1 = (o.tx + w + o.ty + h) * 8 + 8;
        if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) out.push(o);
      }
    }
    return out;
  }
  /**
   * The slices of tile (ix, iy), back to front: every static object that reaches it, at its real sprite (from the slices
   * the street view keeps when they are current, else sliced here and not kept: Map zoom holds no slice list per chunk,
   * so its memory stays the sprite cache's). Null while a sprite is not built yet (each is asked for within the frame
   * budget, else queued). It runs whole once started: an abandoned gather is all waste.
   */
  function tileItems(ix, iy) {
    const r = MAPTILES.tileRect(ix, iy), items = [];
    let ready = true;
    for (const o of objsReaching(r)) {
      const k = keyFor(o);
      let e = cache.map?.get?.(k);
      const s = sliceCache.get(o.id);
      if (!e && s && s.key === k && usable(s.entry) && cache.adopt?.(k, s.entry)) e = s.entry;
      if (!e) e = lookup(o, frameBudget, k);
      if (!e) { ready = false; continue; }
      if (!ready || e.empty) continue;
      // the sprite's own rect (its pivot on the footprint's north corner, its true bounds): most objects the reach test
      // let in miss the tile, and need no slicing
      const b = e.bounds, pv = e.pivot;
      if (b && pv && o.kind !== 'decal' && !o.run && (o.walk ?? '') !== 'edge') {
        const n0 = toScreen(o.tx, o.ty), x0 = n0.sx - pv.x + b.x - 1, y0 = n0.sy - pv.y + b.y - 1;
        if (x0 >= r[2] || x0 + b.w + 2 <= r[0] || y0 >= r[3] || y0 + b.h + 2 <= r[1]) continue;
      }
      const list = s && s.entry === e && s.at === sliceAt(o) ? s.items : D.sliceSprite(view_(o), e);
      for (const it of list) if (it.dx < r[2] && it.dx + it.sw > r[0] && it.dy < r[3] && it.dy + it.sh > r[1]) items.push(it);
    }
    if (!ready) return null;
    return items.sort((p, q) => p.key - q.key);
  }
  // Map tile baking counters (stats().mapBake): tries, bakes, and where the time goes (the perf harness, ?debug)
  const mb = { drainMs: 0, maxShrink: 0, maxKeep: 0, maxDraw: 0, maxPrep: 0, maxIdle: 0, maxPump: 0, maxTile: 0, maxGather: 0, stored: 0, tries: 0, notReady: 0, groundWait: 0, baked: 0, sea: 0, derived: 0, groundMs: 0, gatherMs: 0, drawMs: 0, shrinkMs: 0, sigMs: 0 };
  /**
   * Bake tile (ix, iy) at device scale `scale`: the street-view draw of its rect (ground, accent edges, its slices back
   * to front) at 1x, box-filtered down. False when a sprite it needs is not built yet (the tile is tried again).
   */
  function bakeTile(ix, iy, scale, sig, deadline) {
    mb.tries++;
    // a fresh bake at a larger scale (a step out from 1/4 to 1/8): halve it, no redraw
    for (let k = 2; k <= 8; k *= 2) {
      const big = mapTiles.peek(ix, iy, scale * k);
      if (!big || big.sig !== sig) continue;
      const d = mapTiles.store(ix, iy, scale, sig, big.img, big.size, big.sx, big.sy);
      if (!d) break;
      keep(ix, iy, scale, sig, d);
      mb.derived++;
      return true;
    }
    const r = MAPTILES.tileRect(ix, iy), cam1 = tileCam(r);
    let t = now();
    // its ground art first, spread over idle slices (a paved tile's art is its own): the paint below is then memo hits
    const prepped = !ground.prepRect || ground.prepRect(r, deadline);
    mb.maxPrep = Math.max(mb.maxPrep, now() - t);
    if (!prepped) { mb.groundMs += now() - t; mb.groundWait++; return false; }
    t = now();
    const t00 = t, items = tileItems(ix, iy);
    mb.gatherMs += now() - t;
    mb.maxGather = Math.max(mb.maxGather, now() - t);
    if (!items) { mb.notReady++; return false; }
    t = now();
    if (!tileCv) {
      // CPU-backed like every sprite raster (READ) and the tile pages: a bake is CPU blits end to end, no GPU round trip
      tileCv = canvasOf(MAPTILES.TILE, MAPTILES.TILE);
      try { tileCv?.getContext?.('2d', { ...READ, alpha: false }); } catch { /* the gfx asks for its own */ }
      tileG = tileCv ? D.createGfx(tileCv) : null;
    }
    if (!tileG) return false;
    tileG.begin(1, cam1);
    tileG.clear(SEA());
    const tg = now();
    // the ground straight from its tile art (ground.js paintRect), else through the chunk bakes
    let land = 1;
    if (ground.paintRect) land = ground.paintRect(tileG, r);
    else { const gr = ground.drawChunks(tileG, cam1, { ...TILE_VIEW, rect: r, maxBakes: Infinity }); if (gr?.pending) { tileG.end(); mb.groundWait++; return false; } }
    mb.groundMs += now() - tg;
    if (edges.length && D.drawAccentEdges) D.drawAccentEdges(tileG, edges, { rect: r });
    for (const it of items) tileG.image(it.img, it.sx, it.sy, it.sw, it.sh, it.dx, it.dy, it.sw, it.sh);
    tileG.end();
    // open sea (no ground tile, no sprite): nothing to keep, the frame's clear colour is the tile
    if (!land && !items.length) { keep(ix, iy, scale, sig, mapTiles.store(ix, iy, scale, sig, null)); mb.sea++; return true; }
    tileCv.getContext?.('2d')?.getImageData?.(0, 0, 1, 1);   // the canvas draws lazily: run it here, so drawMs holds it
    const t2 = now(); mb.drawMs += t2 - t; mb.maxDraw = Math.max(mb.maxDraw, t2 - t);
    const ok = mapTiles.store(ix, iy, scale, sig, tileCv);
    mb.shrinkMs += now() - t2;
    if (!ok) return false;
    const tk = now();
    mb.maxShrink = Math.max(mb.maxShrink, tk - t2);
    keep(ix, iy, scale, sig, ok);
    mb.maxKeep = Math.max(mb.maxKeep, now() - tk);
    mb.baked++;
    mb.maxTile = Math.max(mb.maxTile, now() - t00);
    return true;
  }
  /** A fresh bake goes to the tile store too (encoded and written off the frame, in batches). */
  function keep(ix, iy, scale, sig, e) { if (tileStore && e) tileStore.save(tileStore.keyOf(ix, iy, scale, sig), e); }
  // Tiles read back from the store: in flight (tile key -> store key), then decoded and waiting for the next idle slice
  const loading = new Map(), loaded = [];
  /** Ask the store for tile (ix, iy) at `scale` and signature `sig`: true when it has it (the read is in flight). */
  function fromStore(ix, iy, scale, sig) {
    const k = mapTiles.keyOf(ix, iy, scale);
    if (loading.has(k)) return true;
    const sk = tileStore.keyOf(ix, iy, scale, sig);
    if (!tileStore.has(sk)) return false;
    loading.set(k, sk);
    tileStore.load(sk).then(r => { loaded.push([ix, iy, scale, sig, r]); }, () => { loaded.push([ix, iy, scale, sig, null]); });
    return true;
  }
  /** Put the decoded store reads into their atlas slots (when their signature is still current). Returns how many. */
  function drainLoaded(deadline = Infinity) {
    let n = 0;
    const t0 = now();
    while (loaded.length && (!n || now() < deadline)) {
      const [ix, iy, scale, sig, r] = loaded.shift();
      loading.delete(mapTiles.keyOf(ix, iy, scale));
      if (!r) continue;   // a failed read: the tile bakes as usual
      const cur = mapSigAt === `${worldSeq}|${dark}` ? tileSigs.get(`${ix},${iy}`) : undefined;
      if (cur === sig && mapTiles.peek(ix, iy, scale)?.sig !== sig && mapTiles.store(ix, iy, scale, sig, r.img, r.size || TILE_SIZE(scale))) { n++; mb.stored++; }
      r.img?.close?.();
    }
    mb.drainMs += now() - t0;
    return n;
  }
  const TILE_SIZE = s => mapTiles.sizeOf(s);
  /**
   * Bake the stale or missing tiles of `list` (the view's, else its ring), nearest first, for up to `ms` (at least one
   * try). A tile the store holds is read from it instead (asynchronously: drainLoaded puts it in). Returns how many
   * tiles were put in.
   */
  function bakeMap(v, ms, list = v.tiles) {
    const t0 = now(), deadline = t0 + ms;
    let n = drainLoaded(deadline), tried = 0;
    // the store opens in a few ms: until then nothing is baked that it may hold (the ground stands in meanwhile)
    if (tileStore?.state() === 'opening') return n;
    const stored = tileStore?.state() === 'ready';
    for (const { ix, iy } of list) {
      if (tried && now() >= deadline) break;
      const sig = tileSig(ix, iy, deadline), e = mapTiles.peek(ix, iy, v.scale);
      if (sig === null) break;
      if (e && e.sig === sig) continue;
      if (stored && fromStore(ix, iy, v.scale, sig)) continue;
      tried++;
      if (bakeTile(ix, iy, v.scale, sig, deadline)) n++;
    }
    return n;
  }
  // The ring: tiles within MAP_RING of the view, baked once the view is complete (idle time, prefetchIdle), so a pan
  // or a step out at Map zoom lands mostly on baked tiles.
  const MAP_RING = 2;
  function ringOf(v) {
    if (v.ring) return v.ring;
    const r = v.rect, T = MAPTILES.TILE * MAP_RING, inView = new Set(v.tiles.map(t => `${t.ix},${t.iy}`));
    return (v.ring = MAPTILES.tilesOf([r[0] - T, r[1] - T, r[2] + T, r[3] + T]).filter(t => !inView.has(`${t.ix},${t.iy}`)));
  }
  /** True while a ring tile of the last Map view is missing or stale (worked out once per view and lit state). */
  function ringLeft(v) {
    if (!v || !mapTiles) return false;
    const at = `${worldSeq}|${dark}`;
    if (v.ringDone === at) return false;
    for (const { ix, iy } of ringOf(v)) {
      const s = tileSigs.get(`${ix},${iy}`), e = mapTiles.peek(ix, iy, v.scale);
      if (mapSigAt !== at || s === undefined || !e || e.sig !== s) return true;
    }
    v.ringDone = at;
    return false;
  }
  function drawMap(frame, { cam, cssW, cssH, dpr, z, rect, gview, toCss, moving }) {
    noteView(null);     // nothing to prefetch for: the next step in from Map zoom lands wherever the pointer is
    visPending = 0;
    // a Map frame rasters no sprite: the tiles' sprites are built between frames (rasterIdle pumps the queue), so a
    // frame during the fill is never a sprite raster (one building can take longer than the whole frame budget)
    frameBudget = 0;
    const t0 = now();
    if (t0 - lastTrim >= TRIM_MS) { lastTrim = t0; cache.trim?.(); }
    let visObjs = null;
    const objs = () => (visObjs ??= mapObjs(rect));
    // the view's tiles and their pins, worked out again only when the view moves (a still map is most frames)
    const scale = z * dpr, vk = `${scale}|${rect.join(',')}`;
    if (!lastMap || lastMap.vk !== vk) {
      const tiles = MAPTILES.tilesOf(rect);
      lastMap = { scale, tiles, vk, rect };
      mapTiles?.pin(tiles.map(t => mapTiles.keyOf(t.ix, t.iy, scale)));
    }
    const { tiles } = lastMap;
    const key = `${worldSeq}|${dark}|${cam.x}|${cam.y}|${z}|${cssW}|${cssH}|${dpr}`;
    if (keepOn && key === mapKey && g.drawLayer?.()) { lastWay = 'map-kept'; }
    else if (mapTiles) {
      // tiles are baked between frames only (rasterIdle): a frame draws what is baked and stands in for the rest
      const blits = [];
      let pending = 0, bare = false;
      const sigBy = now() + MAP_SIG_MS;
      for (const { ix, iy } of tiles) {
        const sig = tileSig(ix, iy, sigBy);
        let e = mapTiles.get(ix, iy, scale);
        if (!e || sig === null || e.sig !== sig) {
          pending++;
          e = e ?? mapTiles.peek(ix, iy, scale * 2) ?? mapTiles.peek(ix, iy, scale / 2);   // a stale bake, another scale's
          if (!e) { bare = true; continue; }
        }
        blits.push([e, ix, iy]);
      }
      g.clear(SEA());
      let gp = 0;
      if (bare) {
        // under the tiles not baked at any scale yet: the ground bakes already cached, else one flat quad per chunk. It
        // bakes nothing (maxBakes 0): the tiles paint the same ground, so a stand-in bake would be the work done twice
        const gr = ground.drawChunks(g, cam, { ...gview, maxBakes: 0 });
        gp = gr?.pending | 0;
        if (debug) { draws.flat += gr?.flat | 0; draws.softGround += gr?.soft | 0; }
      }
      const T = MAPTILES.TILE;
      for (const [e, ix, iy] of blits) if (e.img) g.image(e.img, e.sx, e.sy, e.size, e.size, ix * T, iy * T, T, T);
      groundPending = pending + gp;
      // keep the layer only once every tile is fresh (a stand-in must not stick)
      mapKey = keepOn && !groundPending && g.saveLayer?.() ? key : null;
      lastWay = 'map';
    }
    // every actor from the actor atlas at the device scale. A page that fills up starts over: then the slots found
    // before it did are gone, and the frame's slots are all found again on the fresh page before any is drawn
    slotScale = z * dpr;
    const r0 = atlas?.resets;
    let items = actorItems(frame, rect, slotScale);
    if (atlas && atlas.resets !== r0) items = actorItems(frame, rect, slotScale);
    const drawn = [], drawnItems = [];
    for (const it of items) drawActor(it, frame, drawn, drawnItems);
    animParts(mapAnimObjs(), frame.t ?? 0, NO_FADE);
    D.effects?.draw?.(g, cam, gview, frame);
    if (frame.fx?.length && D.drawEventFx) D.drawEventFx(g, frame.fx, frame.t ?? 0, { world, actors: frame.actors, berths: frame.berths, rect });
    if ((frame.night ?? 0) > SWEEP_FROM) sweeps(mapAnimObjs(), frame.t ?? 0, frame.night);
    if ((frame.night ?? 0) > 0 && lighting) {
      lighting.setTime(frame.phase ?? frame.night);
      agentStatus.clear();
      for (const a of frame.actors || []) {
        const st = a.input?.status ?? a.status?.bucket;
        if (st != null && a.home != null) agentStatus.set(String(a.home), st);
      }
      // ready sprites only: Map zoom never rasters a building to find its windows
      const windowsOf = o => { const e = entryOf(o), ws = e?.anchors?.windows; return Array.isArray(ws) && ws.length && e.pivot ? ws.map(w => ({ x: w.x - e.pivot.x, y: w.y - e.pivot.y })) : null; };
      let pools = lighting.lights(objs(), drawn, windowsOf);
      try { const extra = mod?.extraLights?.(world, frame.actors || []); if (Array.isArray(extra) && extra.length) pools = pools.concat(extra); } catch { /* a bad mod hook adds no pools */ }
      lighting.draw(g, cam, gview, pools);
    }
    if (D.selectionMarks && D.drawMarks) {
      // the head height of a drawn actor is its drawn frame's; any other is looked up (a mark of an actor off the view)
      let byId = null, itemOf = null;
      const headOf = id => {
        if (!itemOf) { itemOf = new Map(); for (const it of items) { const a = it.actor; if (a.important || a.input?.important) itemOf.set(it.oid, it); } }
        const it = itemOf.get(id);
        if (it && !it.actor.selected && !hasFlag(it.actor, 'SELECTED')) return it.head ? it.pivot.y - it.head.y : null;
        byId ??= new Map((frame.actors || []).map(a => [a.id, a]));
        const a = byId.get(id), f = a ? actorArt?.frame?.(a, { selected: false }) : null; return f?.head && f.pivot ? f.pivot.y - f.head.y : null;
      };
      const marks = D.selectionMarks({ world, actors: frame.actors || [], selected: frame.selected ?? undefined, crowd: frame.crowd });
      if (D.importantStars) {
        // only the stars of the actors in the view (with the actors' margin): one off the view draws nothing anyone sees
        const r = rect, m = 64;
        marks.stars = D.importantStars({ actors: frame.actors || [] }).filter(st => { const p = toScreen(st.x, st.y); return p.sx >= r[0] - m && p.sx <= r[2] + m && p.sy >= r[1] - m && p.sy <= r[3] + 2 * m; });
      }
      D.drawMarks(g, marks, { entryOf: doorOf, frameOf: a => actorArt?.frame?.(a, { selected: true }) ?? null, headOf, now: (frame.t ?? 0) * 1000 });
    }
    D.badges?.draw?.(g, cam, gview, drawn, toCss);
    g.end();
    if (debug) draws.frames++;
    return D.buildHits(items, toCss);
  }

  // Map zoom's animated parts (windmill sails, forge glow) and lighthouse beams: their objects, found once per world
  // (the per-frame list of the view's objects is thousands long and holds a handful of them). Off-view ones draw
  // off the canvas, as the view's ring chunks did.
  const NO_FADE = new Map();
  let animAt = -1, animList = [];
  function mapAnimObjs() {
    if (animAt !== worldSeq) {
      animAt = worldSeq; animList = [];
      for (const c of chunks.values()) for (const o of c.objs) if (o.model === 'windmill' || o.model === 'smithy' || o.model === 'lighthouse') animList.push(o);
    }
    return animList;
  }

  /** The door tile of a building (centre of the door's tile), for the indoors ghost. */
  function doorOf(o) { return o?.door ? { x: o.door.tx + 0.5, y: o.door.ty + 0.5 } : null; }
  function line(p, q, color) { g.poly([[p.sx, p.sy], [q.sx, q.sy], [q.sx, q.sy + 1], [p.sx, p.sy + 1]], color); }
  /** The token actor id a host panel hover key names ('<kind>:<actor id>', the engine's resolve()), or null. */
  function hoveredToken(hp) {
    if (hp == null) return null;
    const k = String(hp), i = k.indexOf(':');
    return i > 0 && !k.startsWith('link:') ? k.slice(i + 1) : null;
  }
  function outline(o, color) {
    const P = [toScreen(o.tx, o.ty), toScreen(o.tx + (o.w || 1), o.ty), toScreen(o.tx + (o.w || 1), o.ty + (o.h || 1)), toScreen(o.tx, o.ty + (o.h || 1))];
    for (let i = 0; i < 4; i++) line(P[i], P[(i + 1) % 4], color);
  }
  // A lighthouse at night sweeps a beam round its lantern: two thin wedges of warm light, flattened to the iso ground.
  // parity: har.lighthouse-sweep
  function sweeps(objs, t, night) {
    for (const o of objs) {
      if (o.model !== 'lighthouse') continue;
      const lamp = lampAnchors().lamp, n = toScreen(o.tx + (o.w || 1) / 2, o.ty + (o.h || 1) / 2);
      const hx = n.sx + lamp[0], hy = n.sy + lamp[1], a0 = frameStill ? 0.9 : t * 0.7, L = 150, k = Math.min(1, (night - SWEEP_FROM) / 0.4);
      g.setComposite('lighter');
      for (let i = 0; i < 2; i++) {
        const a = a0 + i * Math.PI, pt = (r, q) => [hx + Math.cos(a) * r - Math.sin(a) * q, hy + (Math.sin(a) * r + Math.cos(a) * q) * 0.5];
        g.poly([[hx, hy], pt(L, -14), pt(L, 14)], `rgba(255,226,150,${(0.16 * k).toFixed(3)})`);
        g.poly([[hx, hy], pt(L * 0.7, -6), pt(L * 0.7, 6)], `rgba(255,240,190,${(0.22 * k).toFixed(3)})`);
      }
      g.setComposite('source-over');
    }
  }
  // parity: bld.look-windmill-turning-sails
  // parity: bld.look-smithy-forge-glow
  // Classic ambient.js overlay(): the windmill's four lattice sails turn round the hub anchor, the smithy's forge mouth
  // flickers at its door. Drawn per frame over the (static) building sprite, at engine scale (classic 0.8 px x 1.25).
  let frameStill = false;
  function animParts(objs, t, fade) {
    for (const o of objs) {
      if (o.kind !== 'building' || (o.model !== 'windmill' && o.model !== 'smithy') || fade.has(o.id)) continue;
      const e = entryOf(o);
      if (!e?.pivot) continue;
      const n = toScreen(o.tx, o.ty), ox = n.sx - e.pivot.x, oy = n.sy - e.pivot.y;
      if (o.model === 'windmill' && e.anchors?.hub) {
        const hx = ox + e.anchors.hub.x, hy = oy + e.anchors.hub.y, a0 = frameStill ? 0.5 : t * 0.45, L = 32, ink = '#140f1c';
        for (let i = 0; i < 4; i++) {
          const a = a0 + i * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
          const pt = (r, q) => { const u = ca * r - sa * q, w = sa * r + ca * q; return [hx + u * 0.8, hy + u * 0.4 - w]; };
          const p0 = pt(2, 0), p1 = pt(L, 0);
          g.poly([p0, p1, [p1[0], p1[1] + 2], [p0[0], p0[1] + 2]], ink);
          g.poly([pt(9, 1), pt(L, 1), pt(L, 8), pt(9, 8)], 'rgba(236,222,186,0.92)');
          g.poly([pt(9, 4), pt(L, 4), pt(L, 5), pt(9, 5)], 'rgba(122,82,48,0.9)');
        }
        g.rect(Math.round(hx) - 2, Math.round(hy) - 2, 5, 5, ink); g.rect(Math.round(hx) - 1, Math.round(hy) - 1, 3, 3, '#c98a4a');
      } else if (o.model === 'smithy') {
        const d = e.anchors?.glow ?? e.anchors?.door;
        if (!d) continue;
        const fl = frameStill ? 0.8 : 0.65 + 0.35 * Math.sin(t * 13) * Math.sin(t * 7.3 + 1);
        const gx = Math.round(ox + d.x), gy = Math.round(oy + d.y) - 5;
        g.rect(gx - 8, gy - 2, 16, 10, `rgba(255,120,30,${(0.18 * fl).toFixed(3)})`);
        g.rect(gx - 3, gy - 2, 6, 7, `rgba(255,170,60,${(0.5 * fl).toFixed(3)})`);
        g.rect(gx - 1, gy, 2, 4, `rgba(255,235,150,${(0.75 * fl).toFixed(3)})`);
      }
    }
  }

  /** Sprite streaming state (captures wait for pending = 0): chunks' placeholder objects and the cache queue. */
  function stats() {
    return { pending: visPending, way: lastWay, phase: { ...phase }, prefetch: pre ? { done: pre.done, full: pre.full, chunks: pre.todo?.length ?? null, at: pre.i } : null, artReady, artFailed, actorArt: actorArt?.ready ?? null, actorLooks: actorArt?.stats?.().looks ?? null, actorDoll: actorArt?.stats?.().doll ?? null, effects: effects?.stats?.() ?? null, rasterN, failed: failedN,
      rasterMs: Math.round(rasterMs), groundPending, mapTiles: mapTiles?.stats?.() ?? null, actorAtlas: atlas?.stats?.() ?? null, mapStore: tileStore?.stats?.() ?? null, mapBake: Object.fromEntries(Object.entries(mb).map(([k, v]) => [k, Math.round(v)])), ...(debug ? { draws: { ...draws } } : {}), keys: keys.size, failedKeys: failedKeys.slice(), sprites: { failed: failedN, failedKeys: failedKeys.slice() }, ...(cache.stats?.() || {}) };
  }
  /** Debug: false always takes the full draw (no kept layers), true (default) keeps the still view. */
  function setKeep(on) { keepOn = !!on; layerKey = null; mapKey = null; }
  /** Debug: false draws Map zoom's actors from their own frames (no actor atlas), true (default) from the atlas. */
  function setAtlas(on) { debugNoAtlas = !on; }
  /** Build queued sprites for up to `ms` outside a frame; returns how many were built (the caller redraws if any). */
  /** Between frames: the view's queued sprites, then its flat ground chunks. Returns how many were built (> 0: draw). */
  function rasterIdle(ms = 8) {
    const t0 = now();
    let n = cache.stats?.().queued ? cache.pump?.(ms) | 0 : 0;
    if (groundPending && lastMap && mapTiles) {
      // Map zoom: the view's stale or missing tiles (their sprites rastered here too, within the slice)
      const fb = frameBudget, t1 = now();
      mb.maxPump = Math.max(mb.maxPump, t1 - t0);
      // a tile's sprites are queued, not rastered inside its bake (the pump above builds them, one budgeted slice at a
      // time): a dense tile's gather is then slicing only, never a run of sprite rasters in one task
      frameBudget = 0;
      n += bakeMap(lastMap, Math.max(0, ms - (t1 - t0)));
      frameBudget = fb;
      mb.maxIdle = Math.max(mb.maxIdle, now() - t0);
      return n;
    }
    if (groundPending && lastTown && ground?.prebake) {
      const r = ground.prebake(lastTown.cam, { cssW: lastTown.cssW, cssH: lastTown.cssH }, Math.max(0, ms - (now() - t0)), { evict: true });
      n += r.baked | 0;
      if (r.baked) groundPending = Math.max(0, groundPending - r.baked);
    }
    return n;
  }

  // ---- idle prefetch: the next zoom step and the pan margin, built while the view holds still
  // When the view has drawn everything it shows (no queued or pending sprite, no flat ground chunk), idle time
  // (prefetchIdle, called by the host from requestIdleCallback) rasters the sprites and bakes the ground chunks of the
  // view one zoom step out (z / stepOut(z), centred; at least half a view of pan margin each side), nearest chunks first,
  // and builds those chunks' slice lists, so a zoom step or a pan into them is served from cache with no raster in the
  // frame. Sprites go in as prefetched cache entries (sprites.js prefetch): they never evict a sprite the view shows,
  // and prefetching stops for this view when the cache is full. A chunk built ahead of time does not touch staticSeq
  // (it is not in this view's static list, and any view that shows it has another camera key).
  let pre = null;   // { camKey, cam, cssW, cssH, todo: chunk keys nearest first, i, full, done }
  let lastTown = null;   // the last town view (rasterIdle bakes its flat ground chunks)
  function noteView(v) {
    lastTown = v;
    if (!v) { pre = null; return; }
    if (pre && pre.camKey === v.camKey) return;
    pre = { ...v, todo: null, i: 0, full: false, done: false, groundDone: false };
  }
  /** Zoom one step out from z (camera.js stepZoom): 1x steps out to 1/2 (sprites still drawn), 1/2 to Map zoom (none). */
  const stepOut = z => (z > 1 ? Math.max(1, Math.ceil(z) - 1) : z === 1 ? 0.5 : null);
  /**
   * The ground bakes ahead of a view at zoom z: [zoom, lod] pairs. The next step out at 1x (into free room only); a step
   * out to 1/2 shows more 1x chunks than the 1x cache may hold, so that view also gets Map LOD bakes (small: a soft
   * stand-in wherever a 1x chunk is missing); at 1/2, the Map zoom it steps out to.
   */
  const groundSteps = z => {
    const zo = stepOut(z) ?? z;
    return [[zo, false], ...(zo <= 0.5 ? [[zo, true]] : []), ...(z <= 0.5 ? [[MAP_ZOOM, true]] : [])];
  };
  function prefetchRect(v) {
    const zo = stepOut(v.cam.z), k = Math.max(zo ? v.cam.z / zo : 1, 1) + 1;   // + 1: half a view of pan margin each side
    const c0 = toScreen(v.cam.x, v.cam.y), hw = v.cssW / 2 / v.cam.z * k, hh = v.cssH / 2 / v.cam.z * k;
    return [c0.sx - hw, c0.sy - hh, c0.sx + hw, c0.sy + hh];
  }
  function prefetchTodo(v) {
    const { minX, maxX, minY, maxY } = chunkRange(prefetchRect(v)), cur = chunkRange(v.rect);
    const c = toTile((v.rect[0] + v.rect[2]) / 2, (v.rect[1] + v.rect[3]) / 2), mx = c.tx / CHUNK - 0.5, my = c.ty / CHUNK - 0.5;
    const out = [];
    for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
      if (cx >= cur.minX && cx <= cur.maxX && cy >= cur.minY && cy <= cur.maxY) continue;   // the view's own: drawn already
      const k = ck(cx, cy);
      if (chunks.has(k)) out.push([k, (cx - mx) ** 2 + (cy - my) ** 2]);
    }
    return out.sort((a, b) => a[1] - b[1]).map(e => e[0]);
  }
  /** True while the view has prefetch work left (the host keeps asking for idle time). */
  function wantsPrefetch() {
    if (lastMap) return artReady && !groundPending && !(cache.stats?.().queued > 0) && ringLeft(lastMap);
    return !!pre && !pre.done && artReady && !visPending && !groundPending && !(cache.stats?.().queued > 0);
  }
  /**
   * Prefetch for up to `ms` (at least one sprite). Returns { built, baked, more }. Never draws: what it builds is off
   * screen, so it needs no frame.
   */
  function prefetchIdle(ms = 6) {
    const t0 = now();
    let built = 0, baked = 0;
    if (!wantsPrefetch()) return { built, baked, more: false };
    if (lastMap) {
      // Map zoom: the view is complete; its ring next. Store reads land here too (drainLoaded): no frame needed, the
      // ring is off screen
      const fb = frameBudget;
      frameBudget = 0;   // as rasterIdle: the ring's sprites are queued, and pumped there
      baked = bakeMap(lastMap, ms, ringOf(lastMap));
      frameBudget = fb;
      return { built, baked, more: ringLeft(lastMap) || loading.size > 0 };
    }
    const v = pre;
    // ground first: a flat chunk on the way out is the plainest gap
    while (!v.groundDone) {
      const steps = groundSteps(v.cam.z), [zo, lod] = steps[v.gi | 0];
      const r = ground.prebake?.({ x: v.cam.x, y: v.cam.y, z: zo }, { cssW: v.cssW, cssH: v.cssH }, Math.max(0, ms - (now() - t0)), { lod }) ?? { more: false };
      baked += r.baked | 0;
      if (!r.more && (v.gi = (v.gi | 0) + 1) >= steps.length) v.groundDone = true;
      if (now() - t0 >= ms) return { built, baked, more: true };
    }
    v.todo ??= prefetchTodo(v);
    while (v.i < v.todo.length && !v.full) {
      const c = chunks.get(v.todo[v.i]);
      // a chunk built while an earlier view showed it, with sprites still pending (the view moved on before they were
      // built), is prefetched like an unbuilt one: skipping it left those sprites as boxes on the way back
      if (!c || (c.built && !c.pending.size)) { v.i++; continue; }
      let ready = true;
      for (const o of c.objs) {
        const k = keyFor(o);
        if (cache.map?.has?.(k)) continue;
        // a sprite the cache evicted that the object still holds goes back in (as a prefetched entry): no raster
        const s = sliceCache.get(o.id);
        if (s && s.key === k && cache.adopt?.(k, s.entry, true)) continue;
        if (built && now() - t0 >= ms) return { built, baked, more: true };
        const r = cache.prefetch ? cache.prefetch(keyFor(o), makeFor(o)) : 'full';
        if (r === 'full') { v.full = true; ready = false; break; }
        if (r === 'built') built++;
      }
      if (!ready) break;
      buildChunk(c, true);   // peek: building ahead must not mark the prefetched sprites as used
      // not ready after all: built again when it is shown. Ready: built, but never touched, so the first frame that
      // shows it touches every sprite (they stop being prefetched entries and the 2 s rule keeps them)
      if (c.pending.size) { c.built = false; c.list = []; c.pending = new Map(); }
      else { c.built = true; c.touched = undefined; }
      v.i++;
      if (now() - t0 >= ms) break;
    }
    const more = !v.full && v.i < v.todo.length;
    if (!more && v.groundDone) v.done = true;
    return { built, baked, more };
  }
  return { setWorld, draw, stats, setKeep, setAtlas, rasterIdle, prefetchIdle, wantsPrefetch, entryOf, noteSeen: ids => actorArt?.noteSeen?.(ids), accents: () => accents };
}
