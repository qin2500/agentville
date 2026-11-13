// Renderer (design §3, §6.3). OWNER: R8. Composes depth/slice/sprites/ground/lighting/xray/raster/gfx.
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
import * as XRAY from './xray.js';
import * as RASTER from '../art/raster.js';
import * as GFX from './gfx-canvas2d.js';
import * as ARTVIEW from '../mod/art-view.js';
import * as ACTOR from '../sim/actor.js';
import * as ACTORART from './actor-art.js';
const DEFAULTS = {
  sortKey: DEPTH.sortKey, LAYER: DEPTH.LAYER, mergeSorted: DEPTH.mergeSorted, feetKey: DEPTH.feetKey, chunkOf: DEPTH.chunkOf,
  sliceSprite: SLICE.sliceSprite, SpriteCache: SPRITES.SpriteCache, spriteKey: SPRITES.spriteKey, placeholder: SPRITES.placeholder,
  createGround: GROUND.createGround, createLighting: LIGHT.createLighting, createXray: XRAY.createXray,
  rasterize: RASTER.rasterize, loadClassicArt: RASTER.loadClassicArt, createGfx: GFX.createGfx, artView: ARTVIEW.artView, FLAGS: ACTOR.FLAGS,
  createActorArt: ACTORART.createActorArt,
};
// Classic props are authored at the classic 0.8 projection (raster result.classic); they are scaled 1.25x
// (nearest) once, when the sprite is made, so they sit at engine scale next to engine-scale art.
const CLASSIC_UP = 1.25;
// While sprites are still streaming in, the renderer pumps the cache harder than the steady-state 6 ms.
const STREAM_BUDGET_MS = 14;
// Props whose art reads the settlement style (classic props-art STYLED, engine banner). Every other prop draws the same
// in every settlement, so its sprite key leaves the style out and one sprite serves the whole world.
const STYLED_PROPS = new Set(['stall', 'maypole', 'lamppost', 'noticeboard', 'banner']);

export const CHUNK = 16;
const HIT_KIND = { building: 'house', venue: 'dock', token: 'ship' }; // hit names unchanged, so va:dock clicks still work
const STATIC_KINDS = new Set(['building', 'prop', 'tree', 'venue', 'token', 'decal']);
const MAP_ZOOM = 0.25;
const ck = (cx, cy) => cx + ',' + cy;
const chunkIdx = (tx, ty) => [Math.floor(tx / CHUNK), Math.floor(ty / CHUNK)];

/** Nearest-neighbour 1.25x of a classic-scale raster result; pivot, bounds and anchors scale with it. */
function upscale(r) {
  const k = CLASSIC_UP, src = r.img, w = Math.round(src.width * k), h = Math.round(src.height * k);
  let c;
  try { c = RASTER.createCanvas(w, h); } catch { return r; }
  const g = c.getContext('2d');
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

export function createRenderer({ canvas, gfx, mod, deps } = {}) {
  const D = { ...DEFAULTS, ...(deps || {}) };
  const g = gfx || D.createGfx(canvas);
  const cache = deps?.cache || new D.SpriteCache({});
  const LAYER = D.LAYER || { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 };
  const view_ = o => (D.artView ? D.artView(o) : o);
  const F = D.FLAGS || {};
  const hasFlag = (a, f) => F[f] !== undefined && ((a.flags | 0) & F[f]) !== 0;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const actorArt = D.createActorArt ? D.createActorArt() : null;
  let world = null, ground = null, lighting = null, xray = null, artReady = !D.loadClassicArt || !!(deps?.rasterize && !deps?.loadClassicArt), artLoading = null;
  // Slices depend on the object's position as well as its sprite, so they cannot live on the shared SpriteEntry
  // (one entry serves every cottage with the same look). Cache them per object id, valid for one world version and
  // one sprite entry: a chunk rebuilt because another object's sprite arrived reuses everyone else's slices.
  /** @type {Map<string, { entry: object, at: string, items: object[] }>} */
  let sliceCache = new Map(), sliceVersion;
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
  function makeFor(obj) {
    return () => {
      if (!artReady) return null; // not cached: tried again once the art is in
      const v = view_(obj), t0 = now();
      let r = null;
      try {
        r = D.rasterize(obj.model, styleOf(obj),
          { kind: obj.kind === 'building' ? 'building' : 'prop', variant: obj.variant, w: obj.w, h: obj.h, door: obj.door, lit: false,
            crown: obj.crown, site: obj.data?.site, dir: obj.run?.dir ?? obj.dir, len: obj.run?.len ?? obj.len, scale: 1, anim: 0, obj: v });
      } catch { r = null; }
      rasterMs += now() - t0; rasterN++;
      // A model the art cannot draw is cached as its placeholder, so it is not raster-retried every frame.
      if (!r || !r.img) { failedN++; const p = placeholderOf(obj); return { ...p, failed: true }; }
      return r.classic === true && !deps?.rasterize ? upscale(r) : r;
    };
  }
  const keys = new Map(); // obj.id -> sprite key, per world (keys are rebuilt by setWorld)
  let styles = new Map(); // settlement name -> its style object (world.villages[].style)
  const styled = obj => obj.kind === 'building' || STYLED_PROPS.has(obj.model);
  // The art takes a style OBJECT (iso.js / props-art.js ignore a string): the mod's table entry for the key, else the
  // object's settlement style.
  function styleOf(obj) {
    if (!styled(obj)) return null;
    const m = mod?.styles?.[obj.styleKey];
    if (m && typeof m === 'object') return m;
    return styles.get(obj.project) ?? (deps?.rasterize ? obj.styleKey : null);
  }
  function keyFor(obj) {
    let k = keys.get(obj.id);
    if (k === undefined) {
      k = D.spriteKey({ model: obj.model, styleKey: styled(obj) ? obj.styleKey : null, variant: obj.variant, w: obj.w, h: obj.h,
        door: obj.door?.face, lit: false, site: obj.data?.site, crown: obj.crown, anim: 0,
        dir: obj.run?.dir ?? obj.dir, len: obj.run?.len ?? obj.len });
      keys.set(obj.id, k);
    }
    return k;
  }
  function spriteOf(obj) { // -> { entry, ready }
    const e = cache.get(keyFor(obj), makeFor(obj));
    return e ? { entry: e, ready: true } : { entry: placeholderOf(obj), ready: false };
  }

  // ---- static chunks
  function buildChunk(c) {
    const items = []; c.pending = new Map();
    for (const obj of c.objs) {
      const { entry, ready } = spriteOf(obj);
      if (!ready) c.pending.set(obj.id, obj);
      for (const it of slicesOf(obj, entry, ready)) items.push(it);
    }
    items.sort((a, b) => a.key - b.key);
    c.list = items;
  }
  function slicesOf(obj, entry, ready) {
    const at = obj.tx + ',' + obj.ty + ',' + obj.w + ',' + obj.h;
    const hit = ready && sliceCache.get(obj.id);
    if (hit && hit.entry === entry && hit.at === at) return hit.items;
    const hk = HIT_KIND[obj.kind];
    const items = D.sliceSprite(view_(obj), entry).map(s => ({ ...s, oid: obj.id, hit: hk, obj, z: obj.z }));
    if (ready) sliceCache.set(obj.id, { entry, at, items }); // placeholders are per call: never cached
    return items;
  }
  function setWorld(w) {
    keys.clear();
    styles = new Map((w?.villages || []).filter(v => v?.style && typeof v.style === 'object').map(v => [v.name, v.style]));
    if (w?.version === undefined || w.version !== sliceVersion) sliceCache = new Map();
    sliceVersion = w?.version;
    if (!artReady && !artLoading) {
      artLoading = Promise.resolve().then(() => D.loadClassicArt()).then(() => { artReady = true; }, () => {});
    }
    actorArt?.load?.();
    world = w; chunks = new Map();
    for (const obj of w.objects.values()) {
      if (!STATIC_KINDS.has(obj.kind)) continue;
      const [cx, cy] = D.chunkOf ? chunkIdxVia(obj) : chunkIdx(obj.tx, obj.ty);
      const k = ck(cx, cy);
      let c = chunks.get(k); if (!c) chunks.set(k, c = { cx, cy, objs: [], list: [], pending: new Map(), built: false });
      c.objs.push(obj);
    }
    // chunks are built lazily, on first visibility (draw)
    ground = D.createGround({ world: w, mod }) // ground bakes its own chunk Map (the SpriteCache is not Map-like);
    // M4: pass statusOf (home agent status -> lit windows) once the renderer receives agent statuses
    lighting = D.createLighting({ world: w });
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
    return { key, actor: a, x, y, oid: a.id, hit: a.kind === 'agent' ? 'agent' : null, z: 0 };
  }
  // People and critters: the classic villager sheets as engine-scale stickers (actor-art.js); carts: the engine's cart
  // prop; anything else (or before the sheets load): a small cached placeholder box.
  function actorSprite(a, x, y) {
    const f = actorArt?.frame?.(a, { selected: hasFlag(a, 'SELECTED') || !!a.selected });
    if (f) return f;
    if (a.kind === 'cart' && artReady) {
      const dir = (a.face | 0) % 2 ? 'y' : 'x';
      const key = D.spriteKey({ model: 'cart', styleKey: null, variant: 0, w: 1, h: 1, dir, len: 1 });
      const e = cache.get(key, () => D.rasterize('cart', null, { kind: 'prop', variant: 0, w: 1, h: 1, dir, len: 1, scale: 1, anim: 0 }));
      if (e) return e;
    }
    return placeholderOf({ id: a.id, kind: 'prop', model: 'actor:' + a.kind, tx: Math.floor(x), ty: Math.floor(y), w: 1, h: 1, z: 14, styleKey: '', variant: 0, walk: 'floor' });
  }

  // ---- draw
  function draw(frame) {
    if (!world) return [];
    const { cam, view } = frame, { cssW, cssH, dpr } = view, z = cam.z;
    const hits = [];
    cache.pump?.(frame.budgetMs ?? (visPending || cache.stats?.().queued ? STREAM_BUDGET_MS : 6));
    g.begin(dpr, cam);
    g.clear(mod?.sea?.color ?? mod?.terrain?.sea?.color ?? '#2b6f9c');

    const c0 = toScreen(cam.x, cam.y), hw = cssW / 2 / z, hh = cssH / 2 / z;
    const rect = [c0.sx - hw, c0.sy - hh, c0.sx + hw, c0.sy + hh];
    const gview = { cssW, cssH, dpr, rect, mode: frame.mode, zoom: z };
    const toCss = (x, y) => [(x - c0.sx) * z + cssW / 2, (y - c0.sy) * z + cssH / 2];
    const isMap = z <= MAP_ZOOM || frame.mode === 'map';

    ground.drawChunks(g, cam, gview);

    // visible chunk range: corners of the view mapped back to tiles, plus a 1-chunk ring (tall sprites, big footprints)
    const cs = [toTile(rect[0], rect[1]), toTile(rect[2], rect[1]), toTile(rect[0], rect[3]), toTile(rect[2], rect[3])];
    const minX = Math.floor(Math.min(...cs.map(c => c.tx)) / CHUNK) - 1, maxX = Math.floor(Math.max(...cs.map(c => c.tx)) / CHUNK) + 1;
    const minY = Math.floor(Math.min(...cs.map(c => c.ty)) / CHUNK) - 1, maxY = Math.floor(Math.max(...cs.map(c => c.ty)) / CHUNK) + 1;
    const lists = [], visObjs = []; visPending = 0;
    for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
      const c = chunks.get(ck(cx, cy)); if (!c) continue;
      if (!c.built) { buildChunk(c); c.built = true; }
      else {
        // Touch every ready sprite of a drawn chunk so the cache's LRU keeps it; rebuild when the entry was evicted and
        // re-made (or is gone), and when a pending sprite arrived.
        let dirty = false;
        for (const o of c.objs) {
          if (c.pending.has(o.id)) continue;
          const e = cache.get(keyFor(o), makeFor(o));
          if (!e || sliceCache.get(o.id)?.entry !== e) dirty = true;
        }
        for (const o of c.pending.values()) if (cache.get(keyFor(o), makeFor(o))) dirty = true;
        if (dirty) buildChunk(c);
      }
      visPending += c.pending.size;
      lists.push(c.list); for (const o of c.objs) visObjs.push(o);
    }

    // actors: cull by screen rect, sort once per frame
    const alpha = frame.alpha ?? 1, m = 64;
    const items = [];
    for (const a of frame.actors || []) {
      if (hasFlag(a, 'INDOORS')) continue;
      const it = actorItem(a, alpha), p = toScreen(it.x, it.y);
      if (p.sx < rect[0] - m || p.sx > rect[2] + m || p.sy < rect[1] - m || p.sy > rect[3] + 2 * m) continue;
      it.p = p; items.push(it);
    }
    items.sort((a, b) => a.key - b.key);
    const merged = D.mergeSorted([...lists, items]);

    // building fade (selected actor behind/inside): per-object alpha, computed only when someone is selected
    const selected = (frame.actors || []).filter(a => hasFlag(a, 'SELECTED') || a.selected);
    const fade = new Map();
    if (selected.length && xray?.fadeFor && !isMap) {
      for (const o of visObjs) if (o.kind === 'building') { const f = xray.fadeFor(o, selected); if (f !== undefined && f < 1) fade.set(o.id, f); }
    }

    const hitRect = new Map(), hitOrder = [];
    const addHit = (it, x0, y0, x1, y1) => {
      if (!it.hit) return;
      const [a0, b0] = toCss(x0, y0), [a1, b1] = toCss(x1, y1);
      let h = hitRect.get(it.oid);
      if (!h) { h = { id: it.oid, kind: it.hit, rect: [a0, b0, a1, b1], z: it.z }; hitRect.set(it.oid, h); hitOrder.push(h); }
      else { const r = h.rect; r[0] = Math.min(r[0], a0); r[1] = Math.min(r[1], b0); r[2] = Math.max(r[2], a1); r[3] = Math.max(r[3], b1); }
    };
    const drawn = []; // actors actually drawn, for x-ray
    // front-to-back hit order = reverse of draw order: walk merged backwards for hits, forwards for drawing
    for (let i = merged.length - 1; i >= 0; i--) {
      const it = merged[i];
      if (it.actor) { const p = it.p; addHit(it, p.sx - 8, p.sy - 24, p.sx + 8, p.sy); }
      else addHit(it, it.dx, it.dy, it.dx + it.sw, it.dy + it.sh);
    }
    for (const it of merged) {
      if (it.actor) {
        const a = it.actor, p = it.p;
        if (isMap) { g.rect(Math.round(p.sx) - 2, Math.round(p.sy) - 2, 4, 4, '#ffffff'); drawn.push(a); continue; }
        const e = actorSprite(a, it.x, it.y);
        const w = e.img?.width ?? 16, h = e.img?.height ?? 24, px = e.pivot?.x ?? w / 2, py = e.pivot?.y ?? h;
        const al = hasFlag(a, 'GHOST') ? 0.5 : Number.isFinite(a.alpha) && a.alpha < 1 ? Math.max(0, a.alpha) : undefined;
        g.image(e.img, 0, 0, w, h, Math.round(p.sx - px), Math.round(p.sy - py), w, h, al);
        drawn.push(a);
      } else if (isMap) {
        // Map LOD: slices are skipped; buildings get a flat footprint diamond once, from their first slice
        continue;
      } else {
        g.image(it.img, it.sx, it.sy, it.sw, it.sh, it.dx, it.dy, it.sw, it.sh, fade.get(it.oid));
      }
    }
    if (isMap) for (const o of visObjs) if (o.kind === 'building' || o.kind === 'venue') {
      const t = o.tx, u = o.ty, w = o.w, h = o.h;
      const pts = [toScreen(t, u), toScreen(t + w, u), toScreen(t + w, u + h), toScreen(t, u + h)].map(q => [q.sx, q.sy]);
      g.poly(pts, mod?.mapColor?.(view_(o)) ?? '#8a6a50');
    }

    // effects (stub): hook only
    D.effects?.draw?.(g, cam, gview, frame);
    // light
    if ((frame.night ?? 0) > 0 && lighting) {
      lighting.setTime(frame.phase ?? frame.night);
      lighting.draw(g, cam, gview, lighting.lights(visObjs, drawn));
    }
    // x-ray: occluded passers-by only
    if (xray && !isMap) {
      const occ = drawn.filter(a => xray.occluded(a, world));
      if (occ.length) xray.draw(g, cam, occ);
    }
    // screen-space badges (stub): hook only, receives CSS-space projector
    D.badges?.draw?.(g, cam, gview, drawn, toCss);
    g.end();
    return hitOrder;
  }

  /** Sprite streaming state (captures wait for pending = 0): chunks' placeholder objects and the cache queue. */
  function stats() {
    return { pending: visPending, artReady, actorArt: actorArt?.ready ?? null, rasterN, failed: failedN,
      rasterMs: Math.round(rasterMs), keys: keys.size, ...(cache.stats?.() || {}) };
  }
  return { setWorld, draw, stats };
}
