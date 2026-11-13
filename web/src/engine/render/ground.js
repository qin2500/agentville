// Ground layer (design §3.3 layer 1, §3.5): 16x16-tile chunks baked lazily to bitmaps at 1x.
// Pure apart from the injected canvas factory and gfx calls. Draws in 1x world-screen px (toScreen space);
// gfx.begin(dpr, cam) is expected to have set the camera transform.
import { toScreen } from '../core/coords.js';
import { LAYOUT_GROUND } from '../core/grid.js';

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
 *  `cache` (optional) is the shared Map-like for baked chunks; default is private. view = { cssW, cssH, dpr?, cam?, style? }. */
export function createGround({ world, mod = world?.mod, cache, createCanvas = defaultCanvas, style: style0 } = {}) {
  const grid = world.grid;
  const chunks = cache instanceof Map ? cache : new Map();
  const mine = new Set();   // keys this ground baked (so a shared cache is only cleared of our own entries)
  const byCode = [];
  for (const t of mod?.terrain?.types || []) if (t.color) byCode[t.code] = t.color;
  const classCol = [];   // terrain-layer code -> colour, from the mod's terrain classes
  for (const c of mod?.terrain?.classes || []) if (c && typeof c.color === 'string' && Number.isInteger(c.code)) classCol[c.code] = c.color;
  const terrainCol = t => classCol[t] || TERRAIN_COL[t] || '#444';
  const styleOf = v => v?.style ?? style0 ?? world.style ?? 'default';
  const versionOf = () => world.version ?? grid.version ?? 0;
  const keyOf = (cx, cy, style) => `${cx},${cy}|${versionOf()}|${style}`;

  const idx = (tx, ty) => grid.idx ? grid.idx(tx, ty) : ((tx - grid.ox >= 0 && ty - grid.oy >= 0 && tx - grid.ox < grid.w && ty - grid.oy < grid.h) ? (ty - grid.oy) * grid.w + tx - grid.ox : -1);
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
  function chunkKeys(view, cam = view.cam) {
    const [vx0, vy0, vx1, vy1] = viewRect(cam, view), style = styleOf(view), out = [];
    if (!grid.w || !grid.h) return out;
    for (let cy = cMin(grid.oy), cyE = cMax(grid.oy, grid.h); cy <= cyE; cy++) {
      for (let cx = cMin(grid.ox), cxE = cMax(grid.ox, grid.w); cx <= cxE; cx++) {
        const [x0, y0, x1, y1] = chunkBox(cx, cy);
        if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
        out.push({ cx, cy, key: keyOf(cx, cy, style) });
      }
    }
    return out.sort((a, b) => (a.cx + a.cy) - (b.cx + b.cy) || a.cx - b.cx);
  }

  const diamond = (ctx, sx, sy, col) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(sx, sy); ctx.lineTo(sx + HW, sy + HH); ctx.lineTo(sx, sy + 2 * HH); ctx.lineTo(sx - HW, sy + HH);
    ctx.closePath(); ctx.fill();
  };

  function bake(cx, cy, style) {
    const cv = createCanvas(CHUNK_W, CHUNK_H), ctx = cv.getContext('2d');
    const [ox, oy] = chunkBox(cx, cy);
    const render = mod?.ground?.renderTile, memo = new Map();
    for (let ty = cy * CHUNK; ty < (cy + 1) * CHUNK; ty++) {
      for (let tx = cx * CHUNK; tx < (cx + 1) * CHUNK; tx++) {
        const i = idx(tx, ty);
        if (i < 0) continue;
        const sx = (tx - ty) * HW - ox, sy = (tx + ty) * HH - oy;   // north corner within the chunk bitmap
        let bmp = null;
        if (render) {
          const code = grid.ground[i];
          const nb = { n: groundAt(tx, ty - 1), e: groundAt(tx + 1, ty), s: groundAt(tx, ty + 1), w: groundAt(tx - 1, ty),
            ne: groundAt(tx + 1, ty - 1), se: groundAt(tx + 1, ty + 1), sw: groundAt(tx - 1, ty + 1), nw: groundAt(tx - 1, ty - 1),
            terrain: grid.terrain[i], road: grid.road ? grid.road[i] : 0 };
          const mk = `${code}|${nb.n},${nb.e},${nb.s},${nb.w},${nb.ne},${nb.se},${nb.sw},${nb.nw}|${nb.terrain}|${nb.road}`;
          if (memo.has(mk)) bmp = memo.get(mk);
          else { bmp = render(code, nb, style) || null; memo.set(mk, bmp); }
        }
        if (bmp) ctx.drawImage(bmp, sx - HW, sy);
        else diamond(ctx, sx, sy, colourAt(i));
      }
    }
    return { img: cv, x: ox, y: oy, w: CHUNK_W, h: CHUNK_H };
  }

  function drawMap(gfx, cam, view) {
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

  /** Draw the visible ground. Returns { mode, chunks, baked }. */
  function drawChunks(gfx, cam, view) {
    if (cam.z <= MAP_LOD_ZOOM) return drawMap(gfx, cam, view);
    const style = styleOf(view);
    let baked = 0, drawn = 0;
    for (const { cx, cy, key } of chunkKeys(view, cam)) {
      let c = chunks.get(key);
      if (!c) { c = bake(cx, cy, style); chunks.set(key, c); mine.add(key); baked++; }
      gfx.image(c.img, 0, 0, c.w, c.h, c.x, c.y, c.w, c.h);
      drawn++;
    }
    return { mode: 'chunks', chunks: drawn, baked };
  }

  /** Drop baked chunks overlapping tile rect { ox, oy, w, h } (1 tile margin for neighbour-aware art); no rect drops all. */
  function invalidate(rect) {
    for (const key of [...mine]) {
      if (rect) {
        const [cc, , ] = key.split('|'), [cx, cy] = cc.split(',').map(Number);
        const hit = cx * CHUNK <= rect.ox + rect.w && (cx + 1) * CHUNK - 1 >= rect.ox - 1 &&
          cy * CHUNK <= rect.oy + rect.h && (cy + 1) * CHUNK - 1 >= rect.oy - 1;
        if (!hit) continue;
      }
      chunks.delete(key); mine.delete(key);
    }
  }

  return { chunkKeys, drawChunks, invalidate };
}
