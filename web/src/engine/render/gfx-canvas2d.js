// Engine v2 Canvas2D backend (design 3.1, decision D1). OWNER: R5. Nothing outside render/ touches ctx.
// Drawing coordinates after begin() are 1x world screen px (core/coords.js toScreen); the transform maps them to
// device px using camera.js worldToCss conventions: css = (p - toScreen(cam)) * z + view/2.
import { toScreen } from '../core/coords.js';

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

export function createGfx(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
  let view = { cssW: 0, cssH: 0, dpr: 1 };

  const measure = (dpr) => {
    const cssW = canvas.clientWidth || canvas.width / dpr, cssH = canvas.clientHeight || canvas.height / dpr;
    return { cssW, cssH, dpr };
  };
  const smooth = () => { ctx.imageSmoothingEnabled = false; };

  return {
    begin(dpr = 1, cam) {
      view = measure(dpr);
      const w = Math.round(view.cssW * dpr), h = Math.round(view.cssH * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const t = worldToDevice(cam, view);
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
    setComposite(op) { ctx.globalCompositeOperation = op; },
    end() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },
    /** { cssW, cssH, dpr } as of the last begin() (or a fresh measure before the first). */
    size() { return view.cssW ? { ...view } : measure(view.dpr); },
  };
}
