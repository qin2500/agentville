// Alpha planes of sprite images (M7 perf). Pure apart from one canvas readback per image.
//
//   READ = { willReadFrequently: true }   context options for every canvas the engine reads back (raster bounds, alpha):
//                                         a CPU-backed canvas reads back without a GPU flush, so a readback never stalls a frame
//   alphaOf(img) -> { w, h, a: Uint8Array } | null
//     the alpha channel of a canvas-like or drawable image, read once and cached per image (WeakMap: it goes when the
//     image goes). null when the image cannot be read (callers treat that as opaque). Pick (render/pick.js) and the x-ray
//     silhouettes (render/gfx-canvas2d.js) share the cache, so one image is read back at most once.
//   setAlpha(img, rgba, w, h)            seed the cache from RGBA pixels already in hand (no readback)

export const READ = Object.freeze({ willReadFrequently: true });

const cache = new WeakMap();

function plane(rgba, w, h) {
  const a = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) a[i] = rgba[i * 4 + 3];
  return { w, h, a };
}

export function setAlpha(img, rgba, w, h) {
  if (!img || typeof img !== 'object' || !rgba || !(w > 0) || !(h > 0)) return null;
  const e = plane(rgba, w, h);
  cache.set(img, e);
  return e;
}

export function alphaOf(img) {
  if (!img || typeof img !== 'object') return null;
  let e = cache.get(img);
  if (e !== undefined) return e;
  e = null;
  try {
    const w = img.width | 0, h = img.height | 0;
    if (img.data && w && h && img.data.length >= w * h * 4) e = plane(img.data, w, h);   // a raw { width, height, data } buffer
    else if (w && h) {
      let g = typeof img.getContext === 'function' ? img.getContext('2d', READ) : null;
      if (!g && typeof OffscreenCanvas !== 'undefined') {
        const c = new OffscreenCanvas(w, h); g = c.getContext('2d', READ); g.drawImage(img, 0, 0);
      }
      if (g) e = plane(g.getImageData(0, 0, w, h).data, w, h);
    }
  } catch { e = null; }
  cache.set(img, e);
  return e;
}
