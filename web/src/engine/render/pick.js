// Picking (design §6.3): walk the front-to-back hit list from hits.js and choose what a CSS point means. Pure.
//
//   pick(hits, x, y, { alphaAt? }) -> Hit | null
//     - Each slice is its own hit area. alphaAt(hit, x, y) -> bool (optional) lets a transparent slice pixel miss,
//       so the air beside a spire or under an eave falls through to whatever is behind it.
//     - Agents win ties: an agent hit whose rect contains the point wins over the slice that would otherwise win
//       when the agent's key is at or behind that slice's key by no more than one depth row (an agent brushing a
//       wall it stands against), and an x-rayed (occluded) agent always wins.
//     - The first containing agent in front of every containing slice wins outright (it is drawn on top).
//
//   imageAlphaAt({ threshold = 16, read? }) -> alphaAt
//     Reads the slice's source pixel (hit.src: { img, sx, sy, sw, sh }) under the CSS point. `read(img, u, v)` returns
//     alpha 0..255; the default reads (and caches per image) the pixels of a canvas-like img. Any failure counts as
//     opaque, so picking degrades to the slice rect, never to a miss.
import { depthOfKey } from './hits.js';
import { alphaOf } from '../art/alpha.js';

const inRect = (r, x, y) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

export function pick(hits, x, y, { alphaAt } = {}) {
  if (!hits || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  let front = null;   // the slice that wins so far
  for (const h of hits) {
    if (!h || !h.rect || !inRect(h.rect, x, y)) continue;
    const agent = h.kind === 'agent';
    if (front) {
      if (!agent) continue;
      if (h.occluded) return h;
      if (Number.isFinite(h.key) && Number.isFinite(front.key) && h.key <= front.key && depthOfKey(front.key) - depthOfKey(h.key) <= 1) return h;
      continue;
    }
    if (agent || !h.src) return h;   // actors (and rect-only hits) are picked by their rect
    if (alphaAt) { let ok = true; try { ok = alphaAt(h, x, y) !== false; } catch { ok = true; } if (!ok) continue; }
    front = h;
  }
  return front;
}

// the alpha plane of the image, read once per image and shared with the x-ray silhouettes (art/alpha.js)
function defaultRead(img, u, v) {
  const e = alphaOf(img);
  if (!e) return 255;
  const px = Math.floor(u), py = Math.floor(v);
  if (px < 0 || py < 0 || px >= e.w || py >= e.h) return 0;
  return e.a[py * e.w + px];
}

export function imageAlphaAt({ threshold = 16, read = defaultRead } = {}) {
  return (h, x, y) => {
    const s = h.src, r = h.rect;
    if (!s || !s.img || typeof s.img !== 'object' || !(r[2] > r[0]) || !(r[3] > r[1])) return true;
    const u = s.sx + (x - r[0]) * s.sw / (r[2] - r[0]), v = s.sy + (y - r[1]) * s.sh / (r[3] - r[1]);
    let a;
    try { a = read(s.img, u, v); } catch { return true; }
    return !(Number.isFinite(a)) || a >= threshold;
  };
}
