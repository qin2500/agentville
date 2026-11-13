// Sprite cache (design §3.4, seam R4).
//
//   new SpriteCache({ maxBytes = 56<<20, now, budgetMs = 6 })
//     get(key, make) -> SpriteEntry | null   build synchronously while this frame's budget lasts, else queue and return null
//     pump(budgetMs) -> number                build queued items within budgetMs (by the injected clock); returns builds done
//     stats() -> { entries, bytes, maxBytes, queued, hits, misses, builds, evictions }
//   spriteKey({ model, styleKey, variant, w, h, door, lit, site, crown, anim, dir, len }) -> string (order independent)
//   batchMisses(keys, render) -> Promise<Map<key, SpriteEntry>>   render = mod.sprites.render(model, variant, style, opts)
//   placeholder(obj) -> SpriteEntry   flat-shaded iso box from footprint (w, h tiles) and z (px)
//
// SpriteEntry = { img, bounds, pivot, slices: [], anchors, bytes, lastUsed }. A hit returns the SAME entry object (the
// renderer caches slices by entry identity). A make() that returns null (art not loaded) is never cached.
// LRU by bytes; an entry used in the last 2 s is never evicted.
import { createCanvas } from '../art/raster.js';

export const MAX_W = 512, MAX_H = 768, KEEP_MS = 2000, FRAME_MS = 16;

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const doorKey = d => (d == null ? null : typeof d === 'object' ? (d.face ?? d.x ?? JSON.stringify(d)) : d);
const nul = v => (v === undefined ? null : v);

/** Stable key: a JSON array in fixed field order, so it is order independent and parseable (see batchMisses). */
export function spriteKey(o = {}) {
  return JSON.stringify([nul(o.model), nul(o.styleKey), o.variant ?? 0, nul(o.w), nul(o.h), doorKey(o.door),
    !!o.lit, !!o.site, !!o.crown, o.anim ?? 0, nul(o.dir), nul(o.len)]);
}
function parseKey(key) {
  try {
    const a = JSON.parse(key);
    if (!Array.isArray(a)) return null;
    const [model, styleKey, variant, w, h, door, lit, site, crown, anim, dir, len] = a;
    return { model, styleKey, variant, w, h, door, lit, site, crown, anim, dir, len };
  } catch { return null; }
}

function toEntry(r, t) {
  const img = r.img ?? r.bitmap ?? null;
  const w = img?.width ?? 0, h = img?.height ?? 0;
  return {
    img,
    bounds: r.bounds ?? { x: 0, y: 0, w, h },
    pivot: r.pivot ?? { x: w >> 1, y: h },
    slices: r.slices ?? [],
    anchors: r.anchors ?? {},
    bytes: r.bytes ?? w * h * 4,
    lastUsed: t,
    ...(r.classic !== undefined ? { classic: r.classic } : {}),
  };
}

export class SpriteCache {
  constructor({ maxBytes = 56 << 20, now = defaultNow, budgetMs = 6 } = {}) {
    this.maxBytes = maxBytes; this.now = now; this.budgetMs = budgetMs;
    this.map = new Map(); this.queue = new Map();
    this.bytes = 0; this.spent = 0; this.winStart = -Infinity;
    this.n = { hits: 0, misses: 0, builds: 0, evictions: 0 };
  }

  _build(key, make) {
    let r = null;
    try { r = make(); } catch { r = null; }
    if (!r) return null; // not cached: next get() calls make() again
    const e = toEntry(r, this.now());
    this.map.set(key, e); this.bytes += e.bytes; this.n.builds++;
    this._evict(e);
    return e;
  }

  _evict(keep) {
    if (this.bytes <= this.maxBytes) return;
    const t = this.now();
    const cand = [...this.map.entries()].filter(([, e]) => e !== keep && t - e.lastUsed >= KEEP_MS).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, e] of cand) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k); this.bytes -= e.bytes; this.n.evictions++;
    }
  }

  get(key, make) {
    const hit = this.map.get(key);
    if (hit) { hit.lastUsed = this.now(); this.n.hits++; return hit; }
    this.n.misses++;
    const t0 = this.now();
    if (t0 - this.winStart >= FRAME_MS) { this.winStart = t0; this.spent = 0; }
    if (this.spent < this.budgetMs) {
      this.queue.delete(key);
      const e = this._build(key, make);
      this.spent += Math.max(0, this.now() - t0);
      return e;
    }
    this.queue.set(key, make);
    return null;
  }

  pump(budgetMs = this.budgetMs) {
    const t0 = this.now();
    let done = 0;
    for (const [key, make] of [...this.queue]) {
      if (this.now() - t0 >= budgetMs) break;
      this.queue.delete(key);
      if (this.map.has(key)) continue;
      if (this._build(key, make)) done++;
    }
    this.winStart = -Infinity; // a new frame window starts after the pump
    return done;
  }

  stats() {
    return { entries: this.map.size, bytes: this.bytes, maxBytes: this.maxBytes, queued: this.queue.size, ...this.n };
  }
}

const closeImg = img => { try { img?.close?.(); } catch { /* ignore */ } };

/**
 * Batch-render missed keys through mod.sprites.render(model, variant, style, opts) (sync or async). Results larger
 * than 512x768, without an image, or from a throwing render are left out of the map.
 */
export async function batchMisses(keys, render) {
  const out = new Map();
  const t = defaultNow();
  for (const key of keys || []) {
    const f = parseKey(key);
    if (!f || typeof render !== 'function') continue;
    let r;
    try {
      r = await render(f.model, f.variant, { styleKey: f.styleKey },
        { w: f.w, h: f.h, door: f.door, lit: f.lit, site: f.site, crown: f.crown, anim: f.anim, dir: f.dir, len: f.len });
    } catch { continue; }
    const img = r?.bitmap ?? r?.img;
    if (!img || !(img.width > 0) || !(img.height > 0)) continue;
    if (img.width > MAX_W || img.height > MAX_H) { closeImg(img); continue; }
    out.set(key, toEntry({ ...r, img }, t));
  }
  return out;
}

const shade = (c, k) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')).join('');

/** Flat-shaded iso box for an object: footprint (w, h tiles) and height z (px). Pivot = the footprint's north corner. */
export function placeholder(obj = {}) {
  const w = Math.max(1, obj.w | 0 || 1), h = Math.max(1, obj.h | 0 || 1);
  const z = Math.max(0, +obj.z || 0) || 12;
  const PAD = 2;
  const left = h * 16, right = w * 16; // west / east corner offsets from the north corner
  const iw = left + right + PAD * 2, ih = z + (w + h) * 8 + PAD * 2;
  const px = PAD + left, py = PAD + z; // north corner of the footprint on the ground
  const N = [px, py], E = [px + w * 16, py + w * 8], S = [px + (w - h) * 16, py + (w + h) * 8], W = [px - h * 16, py + h * 8];
  const up = p => [p[0], p[1] - z];
  const base = [150, 140, 125];
  const img = createCanvas(iw, ih);
  const ctx = img.getContext?.('2d');
  if (ctx) {
    const face = (pts, col) => { ctx.fillStyle = col; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill(); };
    face([W, S, up(S), up(W)], shade(base, 0.7));   // south-west wall
    face([S, E, up(E), up(S)], shade(base, 0.55));  // south-east wall
    face([up(N), up(E), up(S), up(W)], shade(base, 1)); // top
  }
  return {
    img, bounds: { x: PAD, y: PAD, w: left + right, h: z + (w + h) * 8 }, pivot: { x: px, y: py },
    slices: [], anchors: {}, bytes: iw * ih * 4, lastUsed: 0, placeholder: true,
  };
}
