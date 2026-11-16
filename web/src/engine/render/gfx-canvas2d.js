// Engine v2 Canvas2D backend (design 3.1, decision D1). Nothing outside render/ touches ctx.
// Drawing coordinates after begin() are 1x world screen px (core/coords.js toScreen); the transform maps them to
// device px using camera.js worldToCss conventions: css = (p - toScreen(cam)) * z + view/2.
import { toScreen } from '../core/coords.js';
import { alphaOf } from '../art/alpha.js';

/**
 * Device-pixel transform for a camera: device = world1x * scale + (tx, ty).
 * view = { cssW, cssH, dpr }. At integer zooms the translation is snapped to whole device px (crisp pixel art).
 */
export function worldToDevice(cam, view) {
  const dpr = view.dpr || 1, s = dpr * cam.z, c = toScreen(cam.x, cam.y);
  let tx = (view.cssW / 2 - c.sx * cam.z) * dpr, ty = (view.cssH / 2 - c.sy * cam.z) * dpr;
  if (Number.isInteger(cam.z)) { tx = Math.round(tx); ty = Math.round(ty); }
  return { scale: s, tx, ty };
}

/** A scratch canvas: OffscreenCanvas, else a DOM canvas, else null (silhouette then reports false). */
function scratchCanvas(w, h, like) {
  try { if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h); } catch { /* fall through */ }
  const doc = like?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!doc?.createElement) return null;
  const c = doc.createElement('canvas'); c.width = w; c.height = h;
  return c;
}

// ---- silhouette pixels (pure: alpha planes in, RGBA out)
const colours = new Map();
let colourCtx;
/** [r, g, b, a] (rgb 0..255, a 0..1) of a CSS colour, or null. Hex and rgb()/rgba() parse directly; anything else is
 *  normalised once through a scratch 2D context when there is one. */
export function rgbaOf(css) {
  if (typeof css !== 'string') return null;
  if (colours.has(css)) return colours.get(css);
  let v = null, m;
  const s = css.trim().toLowerCase();
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s)) && [3, 4, 6, 8].includes(m[1].length)) {
    const h = m[1].length <= 4 ? [...m[1]].map(c => c + c).join('') : m[1];
    v = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  } else if ((m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(s))) {
    const al = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    v = [+m[1], +m[2], +m[3], Math.max(0, Math.min(1, al))];
  } else {
    try {
      colourCtx ??= typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
      if (colourCtx) { colourCtx.fillStyle = '#000000'; colourCtx.fillStyle = css; const n = colourCtx.fillStyle; if (n !== css) v = rgbaOf(n); }
    } catch { v = null; }
  }
  colours.set(css, v);
  return v;
}

/**
 * Write a source rect's alpha (0..1) into `out` (a gw x gh grid whose top-left is world px (gx, gy)), combined with what
 * is there: mode 'set' stores it, mode 'keep' multiplies by (1 - alpha) (the "nothing covers it" share of a union).
 * img null, or an image that cannot be read, is an opaque box.
 */
function paintAlpha(src, out, gx, gy, gw, gh, mode) {
  const sx = Math.round(src.sx ?? 0), sy = Math.round(src.sy ?? 0), sw = Math.round(src.sw), sh = Math.round(src.sh);
  const dx = Math.round(src.dx), dy = Math.round(src.dy), pl = src.img ? alphaOf(src.img) : null;
  const x0 = Math.max(dx, gx), y0 = Math.max(dy, gy), x1 = Math.min(dx + sw, gx + gw), y1 = Math.min(dy + sh, gy + gh);
  if (x1 <= x0 || y1 <= y0) return;
  for (let Y = y0; Y < y1; Y++) {
    const row = (Y - gy) * gw - gx, iv = sy + Y - dy;
    const inRow = pl && iv >= 0 && iv < pl.h;
    for (let X = x0; X < x1; X++) {
      let a;
      if (!pl) a = 1;
      else { const iu = sx + X - dx; a = inRow && iu >= 0 && iu < pl.w ? pl.a[iv * pl.w + iu] / 255 : 0; }
      if (mode === 'set') out[row + X] = a; else out[row + X] *= 1 - a;
    }
  }
}
let gridA = new Float32Array(1024), gridB = new Float32Array(1024);
const grid = (buf, n) => (buf.length >= n ? buf : new Float32Array(Math.max(n, buf.length * 2)));

/**
 * One silhouette into RGBA `px` (row stride `stride` px) at (bx, by), size W x H = the sprite rect plus a 1 px rim ring.
 * Per world pixel: the sprite's alpha in `color` over the union of its four 1 px shifts in `rim`, times the union of the
 * clips' alpha, times o.alpha. Returns false when a colour cannot be read.
 */
export function silhouettePixels(o, W, H, px, bx, by, stride) {
  const col = rgbaOf(o.color), rim = rgbaOf(o.rim ?? 'rgba(255,255,255,0.8)');
  if (!col || !rim) return false;
  const X0 = Math.round(o.dx) - 1, Y0 = Math.round(o.dy) - 1, k = Math.min(1, o.alpha);
  // keep: the share of each pixel no clip covers (1 - union); spr: the sprite's alpha over the rect and a 1 px ring
  const keep = (gridA = grid(gridA, W * H)), PW = W + 2, PH = H + 2, spr = (gridB = grid(gridB, PW * PH));
  keep.fill(1, 0, W * H);
  for (const c of o.clips) paintAlpha(c, keep, X0, Y0, W, H, 'keep');
  spr.fill(0, 0, PW * PH);
  paintAlpha(o, spr, X0 - 1, Y0 - 1, PW, PH, 'set');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const U = 1 - keep[y * W + x];
      if (U <= 0) continue;
      const i = (y + 1) * PW + (x + 1);
      const Fa = col[3] * spr[i];
      const R = 1 - (1 - spr[i - 1]) * (1 - spr[i + 1]) * (1 - spr[i - PW]) * (1 - spr[i + PW]);
      const Ra = rim[3] * R * (1 - Fa), A = Fa + Ra;
      if (A <= 0) continue;
      const o4 = ((by + y) * stride + bx + x) * 4;
      px[o4] = Math.round((col[0] * Fa + rim[0] * Ra) / A);
      px[o4 + 1] = Math.round((col[1] * Fa + rim[1] * Ra) / A);
      px[o4 + 2] = Math.round((col[2] * Fa + rim[2] * Ra) / A);
      px[o4 + 3] = Math.round(A * U * k * 255);
    }
  }
  return true;
}

/** opts.makeCanvas(w, h) -> canvas: the offscreen mask canvas factory (tests inject a fake). */
export function createGfx(canvas, opts = {}) {
  const ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
  let view = { cssW: 0, cssH: 0, dpr: 1 }, scale = 1, tx0 = 0, ty0 = 0;
  const layers = new Map();   // name -> { c, g }: kept frames (saveLayer / drawLayer)
  let mask = null, mctx = null;   // ONE offscreen atlas canvas, reused by every silhouette batch of every frame
  const ATLAS_W = 1024;            // atlas row width (1x px) the batch packs silhouettes into
  const makeCanvas = opts.makeCanvas || ((w, h) => scratchCanvas(w, h, canvas));
  // Kept layers are canvas-sized and drawn every frame: a DOM canvas like the view's own, so the copy both ways stays
  // on the GPU with no per-frame sync (an injected makeCanvas, as in tests, is used as is).
  const makeLayer = opts.makeCanvas || ((w, h) => {
    const doc = canvas?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    if (doc?.createElement) { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; }
    return scratchCanvas(w, h, canvas);
  });
  function maskOf(w, h) {
    if (!mask) { mask = makeCanvas(w, h); mctx = mask?.getContext?.('2d', { willReadFrequently: true }) ?? null; if (!mctx) { mask = null; return null; } }
    if (mask.width < w) mask.width = w;
    if (mask.height < h) mask.height = h;
    return mctx;
  }

  const measure = (dpr) => {
    const cssW = canvas.clientWidth || canvas.width / dpr, cssH = canvas.clientHeight || canvas.height / dpr;
    return { cssW, cssH, dpr };
  };
  const smooth = () => { ctx.imageSmoothingEnabled = false; };

  // ---- x-ray silhouettes, composed on the CPU (M7 perf)
  // The shapes are worked out per 1x world pixel from the alpha planes of the sprites (art/alpha.js, read once per image)
  // and written into ONE small atlas canvas per batch, which is then blitted once per silhouette under the camera
  // transform. The GPU never composites a scratch canvas per silhouette: that cost a GPU flush each (about 0.25 ms).
  // Sprite slices and actor rects sit on whole world px, so the 1x result scales exactly like the sprites themselves.
  function silhouettes(list) {
    const res = new Array(list.length).fill(true), jobs = [];
    let x = 0, y = 0, rowH = 0, maxW = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (!o || !(o.alpha > 0) || !o.clips?.length) continue;
      const W = Math.max(1, Math.round(o.sw) + 2), H = Math.max(1, Math.round(o.sh) + 2);
      if (x && x + W > ATLAS_W) { y += rowH; x = 0; rowH = 0; }
      jobs.push({ i, o, W, H, bx: x, by: y });
      x += W; rowH = Math.max(rowH, H); maxW = Math.max(maxW, x);
    }
    if (!jobs.length) return res;
    const m = maskOf(maxW, y + rowH);
    if (!m || typeof m.createImageData !== 'function') { for (const j of jobs) res[j.i] = false; return res; }
    const im = m.createImageData(maxW, y + rowH), px = im.data, stride = maxW;
    for (const j of jobs) {
      if (!silhouettePixels(j.o, j.W, j.H, px, j.bx, j.by, stride)) res[j.i] = false;
    }
    m.putImageData(im, 0, 0);
    for (const j of jobs) {
      if (res[j.i] === false) continue;
      const o = j.o;
      ctx.drawImage(mask, j.bx, j.by, j.W, j.H, Math.round(o.dx) - 1, Math.round(o.dy) - 1, j.W, j.H);
    }
    return res;
  }

  return {
    begin(dpr = 1, cam) {
      view = measure(dpr);
      const w = Math.round(view.cssW * dpr), h = Math.round(view.cssH * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const t = worldToDevice(cam, view);
      scale = t.scale; tx0 = t.tx; ty0 = t.ty;
      ctx.setTransform(t.scale, 0, 0, t.scale, t.tx, t.ty);
      smooth();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },
    /** Fill the whole canvas (device space). color null/undefined clears to transparent. */
    clear(color) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (color == null) ctx.clearRect(0, 0, canvas.width, canvas.height);
      else { ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.restore();
    },
    image(img, sx, sy, sw, sh, dx, dy, dw, dh, alpha = 1) {
      if (alpha <= 0) return;
      const a = ctx.globalAlpha;
      if (alpha !== 1) ctx.globalAlpha = a * alpha;
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      if (alpha !== 1) ctx.globalAlpha = a;
    },
    rect(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); },
    /** points: [x0,y0,x1,y1,...], [{x,y},...] or [[x,y],...] */
    poly(points, color) {
      const p0 = points[0];
      const flat = typeof p0 === 'number', pair = !flat && Array.isArray(p0);
      const n = flat ? points.length / 2 : points.length;
      if (n < 3) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = flat ? points[2 * i] : pair ? points[i][0] : points[i].x;
        const y = flat ? points[2 * i + 1] : pair ? points[i][1] : points[i].y;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    },
    /** Filled rects in one path, one colour: rects = [x, y, w, h, x, y, w, h, ...] (1x world px). */
    rects(rects, color) {
      if (!rects?.length) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i + 3 < rects.length; i += 4) ctx.rect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
      ctx.fill();
    },
    /**
     * Keep what the canvas shows now as layer `name` (a GPU copy, no readback). drawLayer(name) puts it back over the
     * whole canvas (inside the current clip), so a view that has not moved redraws only what changes over it. Returns
     * false when there is no scratch canvas. Layers are device px: a caller keys them by camera and canvas size.
     */
    saveLayer(name = 'main') {
      const w = canvas.width, h = canvas.height;
      if (!(w > 0 && h > 0)) return false;
      let L = layers.get(name);
      if (!L || L.c.width !== w || L.c.height !== h) {
        const c = makeLayer(w, h), g2 = c?.getContext?.('2d') ?? null;
        if (!g2) { layers.delete(name); return false; }
        layers.set(name, L = { c, g: g2 });
      }
      L.g.setTransform?.(1, 0, 0, 1, 0, 0);
      L.g.globalCompositeOperation = 'copy';
      L.g.drawImage(canvas, 0, 0);
      L.g.globalCompositeOperation = 'source-over';
      return true;
    },
    drawLayer(name = 'main') {
      const L = layers.get(name);
      if (!L || L.c.width !== canvas.width || L.c.height !== canvas.height) return false;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(L.c, 0, 0);
      ctx.restore();
      return true;
    },
    /** Forget every layer (a world change, a resize): the next saveLayer makes them again. */
    dropLayers() { layers.clear(); },
    /**
     * Clip what follows to the union of `rects` ([x0, y0, x1, y1] in 1x world px), each grown to whole device px so the
     * clip edge never blends. unclip() ends it. Draws inside keep the camera transform.
     */
    clipRects(rects) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      for (const r of rects) {
        const x0 = Math.floor(r[0] * scale + tx0), y0 = Math.floor(r[1] * scale + ty0);
        const x1 = Math.ceil(r[2] * scale + tx0), y1 = Math.ceil(r[3] * scale + ty0);
        if (x1 > x0 && y1 > y0) ctx.rect(x0, y0, x1 - x0, y1 - y0);
      }
      ctx.clip();
      ctx.setTransform(scale, 0, 0, scale, tx0, ty0);
    },
    unclip() { ctx.restore(); },
    setComposite(op) { ctx.globalCompositeOperation = op; },
    /**
     * X-ray silhouette (design §3.6): the shape of a sprite as a flat `color` fill with a 1 px `rim`, clipped to the
     * union of the `clips` sprites' alpha (the slices in front), drawn at `alpha`. All rects are 1x world px:
     *   o = { img, sx, sy, sw, sh, dx, dy, color, rim, alpha, clips: [{ img, sx, sy, sw, sh, dx, dy }] }
     * img null is a box. Returns false when it cannot be drawn (no scratch canvas; the caller falls back to plain rects).
     */
    silhouette(o) { return silhouettes([o])[0]; },
    /** Many silhouettes at once (one atlas upload per call): one result per input, as silhouette(). */
    silhouettes,
    end() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },
    /** { cssW, cssH, dpr } as of the last begin() (or a fresh measure before the first). */
    size() { return view.cssW ? { ...view } : measure(view.dpr); },
  };
}
