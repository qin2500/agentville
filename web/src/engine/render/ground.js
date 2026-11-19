// Ground layer (design §3.3 layer 1, §3.5): 16x16-tile chunks baked lazily to bitmaps at 1x.
// Pure apart from the injected canvas factory and gfx calls. Draws in 1x world-screen px (toScreen space);
// gfx.begin(dpr, cam) is expected to have set the camera transform.
import { toScreen } from '../core/coords.js';
import { LAYOUT_GROUND } from '../core/grid.js';
import { createGroundCache } from './ground-cache.js';
import { styleKeyFor } from '../art/style-key.js';

export const CHUNK = 16;
export const MAP_LOD_ZOOM = 0.25;
const HW = 16, HH = 8;
const CHUNK_W = CHUNK * 2 * HW, CHUNK_H = CHUNK * 2 * HH;   // 512 x 256: a chunk's diamond bounding box

// Fallbacks only: the agentville.fantasy terrain classes (mod.terrain.classes[].color) win when the mod supplies them.
const TERRAIN_COL = ['#10305a', '#1d5a8c', '#d8c78a', '#5f8a3c', '#2f5a2a'];
// Engine-reserved ground codes (LAYOUT_GROUND); no mod table owns these, so the colours live here, keyed by the code.
const GROUND_EXT_COL = {
  [LAYOUT_GROUND.EDGE]: '#6e6a5a', [LAYOUT_GROUND.VENUE]: '#6b4a2a',
  [LAYOUT_GROUND.HUB]: '#e0c060', [LAYOUT_GROUND.ROUTE]: '#8a8278',
};
const UNKNOWN_COL = '#808080';

const defaultCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  throw new Error('engine: ground needs a createCanvas(w, h)');
};

/** @param {{ world: object, mod?: object, cache?: object, createCanvas?: (w:number,h:number)=>any, style?: string }} o
 *  `cache` = createGroundCache(): opts into content-hashed keys, the per-frame bake budget and baked Map LOD. Without one (or with a
 *  plain Map) the legacy behaviour holds: version-keyed chunks all baked at once, per-tile polygons at Map LOD. view = { cssW, cssH, dpr?, cam?, style? }. */
export function createGround({ world, mod = world?.mod, cache, createCanvas = defaultCanvas, style: style0 } = {}) {
  const grid = world.grid;
  const budgeted = !!cache && typeof cache.put === 'function';
  const chunks = budgeted ? cache : createGroundCache({ maxChunks: 256, bakesPerFrame: Infinity, budgetMs: Infinity });
  const legacyMap = cache instanceof Map ? cache : null;   // a caller-supplied plain Map keeps receiving legacy entries
  const mine = new Map();   // key -> [cx, cy]: keys this ground baked (so a shared cache is only cleared of our own entries)
  const hashMemo = new Map();
  const byCode = [];
  for (const t of mod?.terrain?.types || []) if (t.color) byCode[t.code] = t.color;
  const classCol = [];   // terrain-layer code -> colour, from the mod's terrain classes
  for (const c of mod?.terrain?.classes || []) if (c && typeof c.color === 'string' && Number.isInteger(c.code)) classCol[c.code] = c.color;
  const terrainCol = t => classCol[t] || TERRAIN_COL[t] || '#444';
  const styleOf = v => v?.style ?? style0 ?? world.style ?? 'default';
  // Per-settlement art: each tile inside a settlement's block is painted with that settlement's style (nb.style). `reads`
  // (mod.ground.reads, default the whole style) names the style fields the tile art draws: only those key the memo and the chunk hash.
  const tileReads = Array.isArray(mod?.ground?.reads) ? mod.ground.reads : null;
  const blocks = [];
  for (const v of world.villages || []) if (v?.block && v.style && typeof v.style === 'object') blocks.push({ x: v.block.x, y: v.block.y, x1: v.block.x + v.block.w, y1: v.block.y + v.block.h, style: v.style, key: tileReads ? styleKeyFor(v.style, tileReads) : '' });
  const blockAt = (tx, ty) => { for (const b of blocks) if (tx >= b.x && tx < b.x1 && ty >= b.y && ty < b.y1) return b; return null; };
  const versionOf = () => world.version ?? grid.version ?? 0;
  let memoVer = null;
  // content key: hash of the ground/terrain/road codes of the chunk plus a one-tile ring (neighbour-aware art), not the version
  const contentHash = (cx, cy) => {
    const v = versionOf();
    if (v !== memoVer) { hashMemo.clear(); memoVer = v; }
    const mk = cx + ',' + cy;
    let h = hashMemo.get(mk);
    if (h !== undefined) return h;
    h = 0x811c9dc5;
    for (let ty = cy * CHUNK - 1; ty <= (cy + 1) * CHUNK; ty++) {
      for (let tx = cx * CHUNK - 1; tx <= (cx + 1) * CHUNK; tx++) {
        const i = idx(tx, ty);
        const a = i < 0 ? 0xffff : grid.ground[i] | (grid.terrain[i] << 8) | ((grid.road ? grid.road[i] : 0) << 16);
        h = Math.imul(h ^ (a & 0xffff), 16777619); h = Math.imul(h ^ (a >>> 16), 16777619);
      }
    }
    // the style of every settlement block the chunk (and its ring) touches: a restyle re-bakes, an unchanged style reuses
    const x0 = cx * CHUNK - 1, x1 = (cx + 1) * CHUNK, y0 = cy * CHUNK - 1, y1 = (cy + 1) * CHUNK;
    for (const b of blocks) {
      if (b.x1 <= x0 || b.x > x1 || b.y1 <= y0 || b.y > y1) continue;
      const k = b.key || JSON.stringify(b.style);
      for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
    }
    h = (h >>> 0).toString(36);
    hashMemo.set(mk, h);
    return h;
  };
  const keyOf = (cx, cy, style, lod) => budgeted ? `${cx},${cy}|${contentHash(cx, cy)}|${style}${lod ? '|lod' : ''}` : `${cx},${cy}|${versionOf()}|${style}`;

  const idx = (tx, ty) => grid.idx ? grid.idx(tx, ty) : ((tx - grid.ox >= 0 && ty - grid.oy >= 0 && tx - grid.ox < grid.w && ty - grid.oy < grid.h) ? (ty - grid.oy) * grid.w + tx - grid.ox : -1);
  const terrainAt = (tx, ty) => { const i = idx(tx, ty); return i < 0 ? -1 : grid.terrain[i]; };
  const groundAt = (tx, ty) => { const i = idx(tx, ty); return i < 0 ? 0 : grid.ground[i]; };

  const colourAt = i => {
    const g = grid.ground[i];
    if (g >= 200) return GROUND_EXT_COL[g] || terrainCol(grid.terrain[i]);
    if (g > 0) return byCode[g] || UNKNOWN_COL;
    if (grid.road && grid.road[i] > 0) return GROUND_EXT_COL[LAYOUT_GROUND.ROUTE];
    return terrainCol(grid.terrain[i]);
  };

  /** Visible 1x screen rect of the viewport. */
  const viewRect = (cam, view) => {
    const c = toScreen(cam.x, cam.y), hw = view.cssW / 2 / cam.z, hh = view.cssH / 2 / cam.z;
    return [c.sx - hw, c.sy - hh, c.sx + hw, c.sy + hh];
  };
  // chunk (cx, cy) screen box: x from (x0-y0-16)*16, y from (x0+y0)*8
  const chunkBox = (cx, cy) => {
    const x0 = cx * CHUNK, y0 = cy * CHUNK, sx = (x0 - y0 - CHUNK) * HW, sy = (x0 + y0) * HH;
    return [sx, sy, sx + CHUNK_W, sy + CHUNK_H];
  };
  const cMin = (o, n) => Math.floor(o / CHUNK), cMax = (o, n) => Math.floor((o + n - 1) / CHUNK);

  /** Visible chunk coordinates (only those overlapping the grid), as [{ cx, cy, key }] in back-to-front (cx+cy) order. */
  function chunkKeys(view, cam = view.cam, lod = false) {
    const [vx0, vy0, vx1, vy1] = viewRect(cam, view), style = styleOf(view), out = [];
    if (!grid.w || !grid.h) return out;
    for (let cy = cMin(grid.oy), cyE = cMax(grid.oy, grid.h); cy <= cyE; cy++) {
      for (let cx = cMin(grid.ox), cxE = cMax(grid.ox, grid.w); cx <= cxE; cx++) {
        const [x0, y0, x1, y1] = chunkBox(cx, cy);
        if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
        out.push({ cx, cy, key: keyOf(cx, cy, style, lod) });
      }
    }
    return out.sort((a, b) => (a.cx + a.cy) - (b.cx + b.cy) || a.cx - b.cx);
  }

  // Pixel-exact diamond: 16 integer spans. Row r is 4r+2 px wide (r<8) then 30-4(r-8) (r>=8), centred on sx, so the two
  // tile rows meeting on any pixel row have widths summing to 32 and neighbours partition the plane (no seams, no overlap).
  const diamond = (ctx, sx, sy, col) => {
    ctx.fillStyle = col;
    for (let r = 0; r < 2 * HH; r++) {
      const half = (r < HH ? 4 * r + 2 : 4 * (2 * HH - 1 - r) + 2) / 2;
      ctx.fillRect(sx - half, sy + r, 2 * half, 1);
    }
  };

  /** The mod's tile art for tile (tx, ty) (grid index i), or null (no art: the caller paints the flat diamond). */
  function tileBmp(tx, ty, i, style, memo, render) {
    const code = grid.ground[i];
    const nb = { n: groundAt(tx, ty - 1), e: groundAt(tx + 1, ty), s: groundAt(tx, ty + 1), w: groundAt(tx - 1, ty),
      ne: groundAt(tx + 1, ty - 1), se: groundAt(tx + 1, ty + 1), sw: groundAt(tx - 1, ty + 1), nw: groundAt(tx - 1, ty - 1),
      terrain: grid.terrain[i], road: grid.road ? grid.road[i] : 0,
      tn: terrainAt(tx, ty - 1), te: terrainAt(tx + 1, ty), ts: terrainAt(tx, ty + 1), tw: terrainAt(tx - 1, ty) };
    const bk = blockAt(tx, ty);
    nb.tx = tx; nb.ty = ty;
    if (bk) nb.style = bk.style;
    // a styled tile may vary by position (nb.tx/ty), so it is memoised per tile; plain tiles share by neighbourhood
    const mk = `${code}|${nb.n},${nb.e},${nb.s},${nb.w},${nb.ne},${nb.se},${nb.sw},${nb.nw}|${nb.terrain}|${nb.tn},${nb.te},${nb.ts},${nb.tw}|${nb.road}|${tx & 7},${ty & 7}${bk ? `|${bk.key || bk.x + ',' + bk.y}|${tx},${ty}` : ''}`;
    if (memo.has(mk)) return memo.get(mk);
    const bmp = render(code, nb, style) || null;
    memo.set(mk, bmp);
    return bmp;
  }

  /** Paint chunk (cx, cy) at 1x into `cv` (a fresh 512x256 canvas unless one is passed in to be reused). */
  function bake(cx, cy, style, cv = createCanvas(CHUNK_W, CHUNK_H)) {
    const ctx = cv.getContext('2d');
    const [ox, oy] = chunkBox(cx, cy);
    const render = mod?.ground?.renderTile, memo = new Map();
    for (let ty = cy * CHUNK; ty < (cy + 1) * CHUNK; ty++) {
      for (let tx = cx * CHUNK; tx < (cx + 1) * CHUNK; tx++) {
        const i = idx(tx, ty);
        if (i < 0) continue;
        const sx = (tx - ty) * HW - ox, sy = (tx + ty) * HH - oy;   // north corner within the chunk bitmap
        const bmp = render ? tileBmp(tx, ty, i, style, memo, render) : null;
        if (bmp) ctx.drawImage(bmp, sx - HW, sy);
        else diamond(ctx, sx, sy, colourAt(i));
      }
    }
    return { img: cv, x: ox, y: oy, w: CHUNK_W, h: CHUNK_H };
  }

  /**
   * Paint the ground of 1x world-px rect [x0, y0, x1, y1] straight through `gfx` (its transform set to 1x world px): every
   * grid tile whose diamond meets the rect, from the same tile art as a chunk bake, so the pixels are the baked chunks'
   * (the art is 32x16 diamonds that partition the plane: the order does not matter). For the Map tiles (map-tiles.js):
   * no chunk is baked or cached, so painting a whole view never churns the chunk cache. Off-grid tiles are left as they are.
   */
  /**
   * Build the tile art paintRect(rect) will draw (the mod memoises it), until `deadline` (performance.now ms): true once
   * all of it is built. At least one tile is built per call, so calls spread over idle slices always finish; a Map tile
   * bake (renderer) runs this first, so its paint is memo hits and never one long task.
   */
  function prepRect(rect, deadline, style = styleOf(null)) {
    const render = mod?.ground?.renderTile;
    if (!render) return true;
    const memo = new Map(), clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const u0 = Math.floor(rect[0] / HW) - 1, u1 = Math.ceil(rect[2] / HW) + 1, v0 = Math.floor(rect[1] / HH) - 2, v1 = Math.ceil(rect[3] / HH);
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const tx = (u + v) / 2, ty = (v - u) / 2, i = idx(tx, ty);
        if (i < 0) continue;
        const sx = u * HW, sy = v * HH;
        if (sx + HW <= rect[0] || sx - HW >= rect[2] || sy + 2 * HH <= rect[1] || sy >= rect[3]) continue;
        tileBmp(tx, ty, i, style, memo, render);
        if (clock() > deadline) return false;
      }
    }
    return true;
  }

  function paintRect(gfx, rect, style = styleOf(null)) {
    const render = mod?.ground?.renderTile, memo = new Map();
    const u0 = Math.floor(rect[0] / HW) - 1, u1 = Math.ceil(rect[2] / HW) + 1, v0 = Math.floor(rect[1] / HH) - 2, v1 = Math.ceil(rect[3] / HH);
    let n = 0;
    for (let v = v0; v <= v1; v++) {
      for (let u = u0; u <= u1; u++) {
        if ((u + v) & 1) continue;
        const tx = (u + v) / 2, ty = (v - u) / 2, i = idx(tx, ty);
        if (i < 0) continue;
        const sx = u * HW, sy = v * HH;
        if (sx + HW <= rect[0] || sx - HW >= rect[2] || sy + 2 * HH <= rect[1] || sy >= rect[3]) continue;
        const bmp = render ? tileBmp(tx, ty, i, style, memo, render) : null;
        if (bmp) gfx.image(bmp, 0, 0, bmp.width ?? 2 * HW, bmp.height ?? 2 * HH, sx - HW, sy, bmp.width ?? 2 * HW, bmp.height ?? 2 * HH);
        else {
          const col = colourAt(i);
          for (let r = 0; r < 2 * HH; r++) { const half = (r < HH ? 4 * r + 2 : 4 * (2 * HH - 1 - r) + 2) / 2; gfx.rect(sx - half, sy + r, 2 * half, 1, col); }
        }
        n++;
      }
    }
    return n;
  }

  function drawMapTiles(gfx, cam, view) {
    const [vx0, vy0, vx1, vy1] = viewRect(cam, view);
    let n = 0;
    for (let ty = grid.oy; ty < grid.oy + grid.h; ty++) {
      for (let tx = grid.ox; tx < grid.ox + grid.w; tx++) {
        const sx = (tx - ty) * HW, sy = (tx + ty) * HH;
        if (sx + HW < vx0 || sx - HW > vx1 || sy + 2 * HH < vy0 || sy > vy1) continue;
        gfx.poly([[sx, sy], [sx + HW, sy + HH], [sx, sy + 2 * HH], [sx - HW, sy + HH]], colourAt(idx(tx, ty)));
        n++;
      }
    }
    return { mode: 'map', chunks: 0, tiles: n };
  }

  // Map LOD chunk: the chunk's real 1x bake (mod tile art and all) sampled down to 1/4 scale, cached like any other chunk.
  // Nearest sampling, not smoothing: chunk boxes sit on multiples of 4 px, so every LOD pixel takes exactly one 1x pixel
  // and neighbouring chunks still partition the plane (smoothing would leave half-alpha seams along every chunk edge).
  // It used to paint flat class colours instead, which disagreed with the art: the deep-sea class colour is darker than
  // the sea tile art and the clear colour, so at map zoom the grid showed as hard-edged dark slabs on the open sea.
  const LOD = 4;
  let scratch = null;   // one reused 1x canvas for the bake the LOD is sampled from
  // When the chunk's 1x bake is cached, the LOD is sampled from it (one small drawImage, no tile art): the same pixels.
  function bakeLod(cx, cy, style) {
    const w = CHUNK_W / LOD, h = CHUNK_H / LOD, cv = createCanvas(w, h), ctx = cv.getContext('2d');
    let full = budgeted ? chunks.get(keyOf(cx, cy, style, false)) : null;
    if (!full?.img || full.iw) {
      if (!scratch) scratch = createCanvas(CHUNK_W, CHUNK_H);
      scratch.getContext('2d').clearRect?.(0, 0, CHUNK_W, CHUNK_H);
      full = bake(cx, cy, style, scratch);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(full.img, 0, 0, CHUNK_W, CHUNK_H, 0, 0, w, h);
    return { img: cv, x: full.x, y: full.y, w: CHUNK_W, h: CHUNK_H, iw: w, ih: h, bytes: w * h * 4 };
  }
  const lodCheap = (cx, cy, style) => budgeted && chunks.has(keyOf(cx, cy, style, false));

  // The latest bake of each chunk position, per LOD (`${cx},${cy}|${style}|${lod}` -> key): an older bake (other content
  // hash) of a chunk still stands in for it until the new one is baked.
  const lastAt = new Map();
  const posKey = (cx, cy, style, lod) => `${cx},${cy}|${style}|${lod ? 1 : 0}`;
  function store(cx, cy, style, lod, key, c) {
    chunks.put(key, c); mine.set(key, [cx, cy]); legacyMap?.set(key, c);
    if (budgeted) lastAt.set(posKey(cx, cy, style, lod), key);
  }
  /** Any cached bake of chunk (cx, cy) other than `key`: the other LOD of the same content, then the last bake at either LOD. */
  function standIn(cx, cy, style, lod) {
    if (!budgeted) return null;
    const keys = [keyOf(cx, cy, style, !lod), lastAt.get(posKey(cx, cy, style, lod)), lastAt.get(posKey(cx, cy, style, !lod))];
    for (const k of keys) { const c = k != null && chunks.has(k) ? chunks.get(k) : null; if (c?.img) return c; }
    return null;
  }
  let flatLast = new Set();   // chunks the last drawChunks drew flat (a moving view's rescue bakes those)

  // A not-yet-baked chunk: one flat quad in the colour of its centre tile, clipped to the grid (a chunk on the grid's
  // edge only partly overlaps it; drawing its whole diamond put slabs of colour, or grey, out on the open sea).
  function flat(gfx, cx, cy) {
    const P = (tx, ty) => [(tx - ty) * HW, (tx + ty) * HH];
    const x0 = Math.max(cx * CHUNK, grid.ox), x1 = Math.min((cx + 1) * CHUNK, grid.ox + grid.w);
    const y0 = Math.max(cy * CHUNK, grid.oy), y1 = Math.min((cy + 1) * CHUNK, grid.oy + grid.h);
    if (x1 <= x0 || y1 <= y0) return;
    const i = idx((x0 + x1 - 1) >> 1, (y0 + y1 - 1) >> 1);
    gfx.poly([P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], i < 0 ? UNKNOWN_COL : colourAt(i));
  }

  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /**
   * Draw the visible ground. Returns { mode, chunks, baked, pending, flat, soft }: pending = visible chunks not drawn from
   * their own bake, of which `soft` drew another bake of the chunk scaled (the other LOD, an older bake) and `flat` one
   * flat quad (no bake of the chunk exists at all).
   * view.maxBakes caps this frame's bakes (a moving view: 0). A Map LOD chunk whose 1x bake is cached is sampled from it
   * (cheap) within the time budget whatever maxBakes says. view.rescue: up to that many chunks drawn flat by the last
   * call, with no stand-in, are baked anyway, so flat ground never outlasts a frame.
   */
  function drawChunks(gfx, cam, view) {
    const map = cam.z <= MAP_LOD_ZOOM;
    if (map && !budgeted) return drawMapTiles(gfx, cam, view);
    const style = styleOf(view), t0 = clock();
    const maxBakes = view.maxBakes ?? chunks.bakesPerFrame ?? Infinity, budgetMs = chunks.budgetMs ?? Infinity;
    let baked = 0, drawn = 0, pending = 0, flats = 0, soft = 0, rescue = view.rescue | 0, cheap = 0;
    const flatNow = new Set();
    const vis = chunkKeys(view, cam, map);
    chunks.pin?.(vis.map(c => c.key));   // this frame's chunks are never evicted to make room for each other
    for (const { cx, cy, key } of vis) {
      let c = chunks.get(key);
      if (!c) {
        const inTime = (baked + cheap) === 0 || clock() - t0 < budgetMs;
        if (map && inTime && lodCheap(cx, cy, style)) { c = bakeLod(cx, cy, style); store(cx, cy, style, true, key, c); cheap++; }
        else if (baked < maxBakes && inTime) {
          c = map ? bakeLod(cx, cy, style) : bake(cx, cy, style);
          store(cx, cy, style, map, key, c); baked++;
        } else {
          pending++;
          const s = standIn(cx, cy, style, map);
          if (s) { soft++; gfx.image(s.img, 0, 0, s.iw ?? s.w, s.ih ?? s.h, s.x, s.y, s.w, s.h); continue; }
          if (rescue > 0 && flatLast.has(key)) {
            rescue--; pending--;
            c = map ? bakeLod(cx, cy, style) : bake(cx, cy, style);
            store(cx, cy, style, map, key, c); baked++;
          } else { flats++; flatNow.add(key); flat(gfx, cx, cy); continue; }
        }
      }
      if (c.iw) gfx.image(c.img, 0, 0, c.iw, c.ih, c.x, c.y, c.w, c.h);
      else gfx.image(c.img, 0, 0, c.w, c.h, c.x, c.y, c.w, c.h);
      drawn++;
    }
    flatLast = flatNow;
    return { mode: map ? 'map' : 'chunks', chunks: drawn, baked: baked + cheap, pending, flat: flats, soft, tiles: 0 };
  }

  /**
   * Idle bake: the chunks a view at `cam` would show, for up to budgetMs (at least one chunk). Returns { baked, more }.
   * 1x chunks, unless `lod`: then the Map LOD chunks of the view (whatever its zoom: a soft stand-in for a 1x view that
   * outgrows the 1x cache, the real thing at Map zoom). Without `lod` a Map zoom view bakes nothing. Without `evict`
   * (renderer prefetchIdle: a view not shown yet) only into free cache room; with it (rasterIdle: the view on screen,
   * drawn flat where unbaked) like a frame's own bake. Chunks nearest the view centre first.
   */
  function prebake(cam, view, budgetMs = 4, { evict = false, lod = false } = {}) {
    if (!budgeted || !chunks.roomFor || (!lod && cam.z <= MAP_LOD_ZOOM)) return { baked: 0, more: false };
    const style = styleOf(view), t0 = clock();
    const c0 = toScreen(cam.x, cam.y), d2 = ({ cx, cy }) => { const b = chunkBox(cx, cy); return ((b[0] + b[2]) / 2 - c0.sx) ** 2 + ((b[1] + b[3]) / 2 - c0.sy) ** 2; };
    let baked = 0;
    const todo = chunkKeys(view, cam, lod).filter(c => !chunks.has(c.key));
    if (todo.length > 1) todo.sort((a, b) => d2(a) - d2(b));
    for (const { cx, cy, key } of todo) {
      if (!evict && !chunks.roomFor(lod)) return { baked, more: false };
      if (baked && clock() - t0 >= budgetMs) return { baked, more: true };
      const c = lod ? bakeLod(cx, cy, style) : bake(cx, cy, style);
      store(cx, cy, style, lod, key, c); baked++;
    }
    return { baked, more: false };
  }

  /** Drop baked chunks overlapping tile rect { ox, oy, w, h } (1 tile margin for neighbour-aware art); no rect drops all. */
  function invalidate(rect) {
    hashMemo.clear(); memoVer = null;
    for (const [key, [cx, cy]] of [...mine]) {
      if (rect) {
        const hit = cx * CHUNK <= rect.ox + rect.w && (cx + 1) * CHUNK - 1 >= rect.ox - 1 &&
          cy * CHUNK <= rect.oy + rect.h && (cy + 1) * CHUNK - 1 >= rect.oy - 1;
        if (!hit) continue;
      }
      chunks.delete(key); legacyMap?.delete(key); mine.delete(key);
    }
  }

  return { chunkKeys, drawChunks, prebake, paintRect, prepRect, invalidate, cache: chunks };
}
