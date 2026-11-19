// Map zoom tiles (design §3.5). At Map zoom (z <= 1/4) the village is the same village, just smaller: every tile is the
// full town draw (ground, plot accent edges and every static sprite slice, back to front: the pixels the street view
// draws there) rendered at 1x and box-filtered down to the device scale (z * dpr), then cached. The frame draws the
// cached tiles and the actors and effects over them, so no sprite is drawn per frame at Map zoom and nothing is
// simplified.
//
// Tiles are screen-space squares of TILE x TILE 1x world px (a fixed lattice: tile (ix, iy) covers sx in
// [ix * TILE, (ix + 1) * TILE), sy likewise). Each cached tile carries the signature of what it was drawn from (its
// chunks' objects and sprite keys, its ground chunks' content keys, the accent edges), so a rebuilt world re-bakes only
// the tiles whose content changed, and a stale tile stands in for its own re-bake. Pure apart from the injected canvas
// factory: no gfx, no world knowledge (the renderer supplies the signature and the draw).
// 256: one bake (ground tile art plus a few hundred sprite slices at 1x) stays a short task even on the densest world;
// a 512 tile took 4x as long per idle slice (the 1,000-agent stress world: up to ~90 ms on a busy machine).
export const TILE = 256;

/** The tile index range [ix0, iy0, ix1, iy1] (inclusive) covering a 1x world-px rect [x0, y0, x1, y1]. */
export function tileRange(rect) {
  return [Math.floor(rect[0] / TILE), Math.floor(rect[1] / TILE), Math.floor((rect[2] - 1e-9) / TILE), Math.floor((rect[3] - 1e-9) / TILE)];
}
/** The 1x world-px rect of tile (ix, iy). */
export const tileRect = (ix, iy) => [ix * TILE, iy * TILE, (ix + 1) * TILE, (iy + 1) * TILE];

/** The tiles of `rect`, nearest its centre first: [{ ix, iy, d }]. */
export function tilesOf(rect) {
  const [ix0, iy0, ix1, iy1] = tileRange(rect), cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2, out = [];
  for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
    out.push({ ix, iy, d: ((ix + 0.5) * TILE - cx) ** 2 + ((iy + 0.5) * TILE - cy) ** 2 });
  }
  return out.sort((a, b) => a.d - b.d);
}

/**
 * The halving steps that take a TILE px square to `size` px: each step at most halves (a 2x2 box filter with bilinear
 * smoothing), the last step lands on `size` exactly. [] when size >= TILE (the 1x tile is used as it is).
 */
export function downSteps(size) {
  const out = [];
  for (let s = TILE; s > size;) { s = Math.max(size, Math.ceil(s / 2)); out.push(s); }
  return out;
}

/** FNV-1a of a string, as a short base-36 string. */
export function sigHash(s, h = 0x811c9dc5) {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const defaultCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
};

/**
 * createMapTiles({ maxBytes, createCanvas, page }) -> a bounded LRU of baked tiles, keyed by tile and device scale.
 * Tiles live in a few atlas pages (page x page px, one size of tile per page), not a canvas each: a view holds hundreds
 * of tiles, and that many separate canvases (each its own GPU texture when drawn) lost their content in Chromium (blank
 * tiles, once the whole view). Pages and scratch canvases are CPU-backed like every sprite raster (art/alpha.js READ):
 * their pixels are never dropped, and the GPU holds only an evictable uploaded copy of each page.
 *   get(ix, iy, scale) -> { img, sx, sy, size, sig } | undefined (an LRU touch; img null: open sea)
 *   peek(ix, iy, scale): the same with no touch
 *   store(ix, iy, scale, sig, src, srcSize = TILE, sx = 0, sy = 0) -> entry | null: `src` (its srcSize square at sx, sy:
 *     the 1x tile, or a bake at a larger scale) box-filtered down by halving into a slot; src null stores open sea
 *   pin(keys): this frame's tiles survive eviction; stats()
 * The byte bound is on pages (maxBytes / page bytes of them); a full set of pages evicts the least recently used tiles.
 */
export function createMapTiles({ maxBytes = 48 << 20, createCanvas = defaultCanvas, page: PAGE = 1024 } = {}) {
  const m = new Map();
  let pinned = new Set(), bakes = 0, evictions = 0, nPages = 0;
  const maxPages = Math.max(1, Math.floor(maxBytes / (PAGE * PAGE * 4)));
  const keyOf = (ix, iy, scale) => `${ix},${iy}|${scale}`;
  const sizeOf = scale => Math.max(1, Math.round(TILE * Math.min(1, scale)));
  const READ = { willReadFrequently: true };
  const classes = new Map();   // tile size -> { pages: [{ c, g, used }], free: [[page, slot]] }
  const scratch = [];          // one reused canvas per halving step size
  const classOf = size => { let c = classes.get(size); if (!c) classes.set(size, c = { pages: [], free: [] }); return c; };
  function release(e) {
    if (!e.page) return;
    const c = classes.get(e.size);
    e.page.used--;
    c.free.push([e.page, e.slot]);
    if (e.page.used === 0 && c.pages.length > 1) {   // an empty page goes back to the pool (another size may need it)
      c.pages = c.pages.filter(p => p !== e.page);
      c.free = c.free.filter(f => f[0] !== e.page);
      nPages--;
    }
  }
  function evictOne(except) {
    for (const [k, e] of m) {
      if (pinned.has(k) || k === except) continue;
      m.delete(k); release(e); evictions++;
      return true;
    }
    return false;
  }
  function alloc(size, key) {
    const c = classOf(size), per = Math.max(1, Math.floor(PAGE / size));
    for (;;) {
      if (c.free.length) { const [p, slot] = c.free.pop(); p.used++; return { page: p, slot, sx: (slot % per) * size, sy: Math.floor(slot / per) * size }; }
      if (nPages < maxPages) {
        const cv = createCanvas(per * size, per * size), g = cv?.getContext?.('2d', READ);
        if (!g) return null;
        const p = { c: cv, g, used: 0 };
        c.pages.push(p); nPages++;
        for (let i = per * per - 1; i >= 0; i--) c.free.push([p, i]);
        continue;
      }
      if (!evictOne(key)) return null;   // every tile is pinned: this one waits
    }
  }
  return {
    keyOf, sizeOf,
    get(ix, iy, scale) {
      const k = keyOf(ix, iy, scale), e = m.get(k);
      if (e) { m.delete(k); m.set(k, e); }
      return e;
    },
    peek: (ix, iy, scale) => m.get(keyOf(ix, iy, scale)),
    store(ix, iy, scale, sig, src, srcSize = TILE, sx0 = 0, sy0 = 0) {
      const k = keyOf(ix, iy, scale), old = m.get(k);
      if (old) { m.delete(k); release(old); }
      const size = sizeOf(scale);
      if (!src) { const e = { img: null, size, sig }; m.set(k, e); bakes++; return e; }   // open sea: the clear colour
      const steps = downSteps(size).filter(s => s < srcSize);
      if (srcSize < TILE && !steps.length && srcSize !== size) return null;   // never scaled up
      const at = alloc(size, k);
      if (!at) return null;
      // halving steps into the scratch canvases, the last one straight into the page slot
      let cur = src, curS = srcSize, cx = sx0, cy = sy0;
      if (!steps.length) steps.push(size);
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i], last = i === steps.length - 1;
        let g, dx = 0, dy = 0;
        if (last) { g = at.page.g; dx = at.sx; dy = at.sy; }
        else {
          const c = scratch[i]?.width === s ? scratch[i] : (scratch[i] = createCanvas(s, s));
          g = c?.getContext?.('2d', READ);
          if (!g) { release(at); return null; }
        }
        g.imageSmoothingEnabled = s !== curS;
        if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
        g.clearRect?.(dx, dy, s, s);
        g.drawImage(cur, cx, cy, curS, curS, dx, dy, s, s);
        if (!last) { cur = scratch[i]; curS = s; cx = 0; cy = 0; }
      }
      const e = { img: at.page.c, sx: at.sx, sy: at.sy, size, sig, page: at.page, slot: at.slot };
      m.set(k, e); bakes++;
      return e;
    },
    pin(keys) { pinned = new Set(keys); },
    clear() { m.clear(); classes.clear(); nPages = 0; pinned = new Set(); },
    stats: () => {
      let n = 0; for (const e of m.values()) if (e.img) n++;
      return { tiles: m.size, land: n, pages: nPages, maxPages, bytes: nPages * PAGE * PAGE * 4, maxBytes, bakes, evictions, pinned: pinned.size };
    },
  };
}
