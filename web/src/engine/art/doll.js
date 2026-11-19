// Paper-doll actor art (M6 P1): code-drawn people built from layered parts, 4 iso facings, cached frames.
// Generic engine core: it knows nothing about any world's clothing. A mod hands it parts, anims and looks
// (mod.actors, docs/village-mods.md "actors"); this module turns (look, facing, anim, frame) into a sticker image.
//
//   createDoll({ size?: { w, h }, scale?, outline?, rim?, shadow?, parts?, anims?, createCanvas?, maxFrames?, maxBytes? })
//     -> { frame(look, facing, anim, f, { selected }) -> { img, pivot, head, w, h } | null, stats(), clear(), keyOf(look),
//          frameKey(look, facing, anim, f, { selected }) -> a key (number, else short string) of that frame (no render) | null }
//
// Pixels are drawn into a plain RGBA buffer (no canvas API), so a frame is bit-exact in every browser and in node:
//   1. the parts of the look (look.parts then look.extras), sorted by part.layer (stable), are painted into a w x h box
//      for the DRAWN facing: 0 (SE, front) or 2 (NW, back). SW (1) is SE mirrored, NE (3) is NW mirrored.
//   2. the box is scaled by `scale` (integer, nearest), padded by PAD px each side;
//   3. a 1 px ink outline (4-neighbour ring around every opaque pixel), then a 1 px light rim around that
//      (white when selected), and a soft ground shadow under the feet are added;
//   4. the buffer becomes a canvas (createCanvas + putImageData), or stays a raw { width, height, data } when there is
//      no canvas factory (tests, workers without OffscreenCanvas).
// pivot = the feet point: bottom centre of the doll box. head = the topmost opaque figure pixel row, at pivot.x.
// Frames are cached under `look key | facing | anim | frame | selected` in an LRU bounded by frame count and bytes.
//
// Part contract (PartDef). Either a painter function or pixel rows:
//   { layer: number, bob?: boolean = true, draw(g, facing, anim, f, pal) }
//   { layer: number, bob?: boolean = true, x?: 0, y?: 0, rows: string[] | { 0?: string[], 2?: string[] }, keys: { ch: colour } }
// facing is the drawn facing only: 0 (front) or 2 (back). f is the frame index inside the anim (0..frames-1).
// A colour is a palette slot name (looked up in look.palette), '#rgb', '#rrggbb', '#rrggbbaa' or [r, g, b, a?].
// In `rows`, '.' and ' ' are transparent; every other character is looked up in `keys`. Rows for facing 2 default to
// the facing 0 rows. bob: the anim's per-frame vertical offset (anims[name].bob[f]) moves the part; feet set it false.
// The painter g (doll px, origin = top-left of the w x h box, clipped to it):
//   g.w, g.h, g.facing, g.anim, g.f, g.dy (the bob in effect)
//   g.px(x, y, c)  g.rect(x, y, w, h, c)  g.rows(x, y, rows, keys)  g.erase(x, y, w, h)  g.col(c) -> [r,g,b,a]|null
// Anim contract: anims = { [name]: { frames: n >= 1, bob?: number[] } }. An unknown anim draws as 'idle' (or 1 frame).

import { READ } from './alpha.js';
export const PAD = 2;                                  // outline + rim
export const FACINGS = 4;
export const MIRROR = Object.freeze([false, true, false, true]);   // SW and NE are mirrored
export const DRAWN = Object.freeze([0, 0, 2, 2]);                  // the facing a part is asked to draw
export const MAX_FRAMES = 4096;
export const MAX_BYTES = 6 * 1024 * 1024;
const INK = [20, 15, 28, 255];
const RIM = [255, 244, 220, 140];
const RIM_SELECTED = [255, 255, 255, 255];
const SHADOW = [16, 10, 24, 115];

const colourMemo = new Map();
/** '#rgb' | '#rrggbb' | '#rrggbbaa' | [r, g, b, a?] -> [r, g, b, a] (0..255), else null. */
export function parseColour(c) {
  if (Array.isArray(c)) return c.length >= 3 && c.slice(0, 3).every(Number.isFinite)
    ? [c[0] & 255, c[1] & 255, c[2] & 255, Number.isFinite(c[3]) ? c[3] & 255 : 255] : null;
  if (typeof c !== 'string' || c[0] !== '#') return null;
  let v = colourMemo.get(c);
  if (v !== undefined) return v;
  const h = c.slice(1);
  const full = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
  v = /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)
    ? [0, 2, 4, 6].map(i => (i < full.length ? parseInt(full.slice(i, i + 2), 16) : 255)) : null;
  if (colourMemo.size < 4096) colourMemo.set(c, v);
  return v;
}

/** src-over of colour c onto buf at byte offset o. */
function blend(buf, o, c) {
  const a = c[3];
  if (!a) return;
  if (a === 255 || !buf[o + 3]) { buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = a; return; }
  const da = buf[o + 3] / 255, sa = a / 255, oa = sa + da * (1 - sa);
  for (let i = 0; i < 3; i++) buf[o + i] = Math.round((c[i] * sa + buf[o + i] * da * (1 - sa)) / oa);
  buf[o + 3] = Math.round(oa * 255);
}

/** A stable cache key for a look: parts, extras and palette (slots sorted). */
export function lookKey(look) {
  if (!look || typeof look !== 'object') return '';
  const parts = Array.isArray(look.parts) ? look.parts.map(String).join(',') : '';
  const extras = Array.isArray(look.extras) ? look.extras.map(String).join(',') : '';
  const pal = look.palette && typeof look.palette === 'object'
    ? Object.keys(look.palette).sort().map(k => `${k}=${Array.isArray(look.palette[k]) ? look.palette[k].join('.') : look.palette[k]}`).join(';') : '';
  return `${parts}|${extras}|${pal}`;
}

function painter(buf, w, h, pal, missing) {
  let dy = 0;
  const col = c => {
    if (typeof c === 'string' && c[0] !== '#') {
      const v = parseColour(pal?.[c]);
      if (!v) missing.add(`slot:${c}`);
      return v;
    }
    return parseColour(c);
  };
  const px = (x, y, c) => {
    const v = col(c);
    x |= 0; y = (y | 0) + dy;
    if (!v || x < 0 || y < 0 || x >= w || y >= h) return;
    blend(buf, (y * w + x) * 4, v);
  };
  const g = {
    w, h, facing: 0, anim: 'idle', f: 0,
    get dy() { return dy; },
    set dy(v) { dy = v | 0; },
    col,
    px,
    rect(x, y, rw, rh, c) {
      const v = col(c);
      if (!v) return;
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
        const X = (x | 0) + i, Y = (y | 0) + j + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h) blend(buf, (Y * w + X) * 4, v);
      }
    },
    rows(x, y, rows, keys) {
      if (!Array.isArray(rows)) return;
      const memo = {};
      rows.forEach((r, j) => {
        for (let i = 0; i < r.length; i++) {
          const ch = r[i];
          if (ch === '.' || ch === ' ') continue;
          const v = memo[ch] !== undefined ? memo[ch] : (memo[ch] = keys && ch in keys ? col(keys[ch]) : null);
          if (!v) { if (!keys || !(ch in keys)) missing.add(`key:${ch}`); continue; }
          const X = (x | 0) + i, Y = (y | 0) + j + dy;
          if (X >= 0 && Y >= 0 && X < w && Y < h) blend(buf, (Y * w + X) * 4, v);
        }
      });
    },
    erase(x, y, rw, rh) {
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) {
        const X = (x | 0) + i, Y = (y | 0) + j + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h) buf.fill(0, (Y * w + X) * 4, (Y * w + X) * 4 + 4);
      }
    },
  };
  return g;
}

/** Normalises (anim, f) against the anim table: { name, i, bob }. */
export function animFrame(anims, anim, f) {
  let name = typeof anim === 'string' && anims && Object.hasOwn(anims, anim) ? anim : 'idle';
  const def = anims && Object.hasOwn(anims, name) ? anims[name] : null;
  if (!def) name = 'idle';
  const n = Math.max(1, Math.floor(def?.frames) || 1);
  const i = (((f | 0) % n) + n) % n;
  const bob = Array.isArray(def?.bob) ? (def.bob[i % def.bob.length] | 0) : 0;
  return { name, i, bob };
}

export function createDoll({ size = { w: 16, h: 24 }, scale = 1, outline = INK, rim = true, shadow = true, parts = {}, anims = {},
  createCanvas = null, maxFrames = MAX_FRAMES, maxBytes = MAX_BYTES } = {}) {
  const w = Math.max(1, size?.w | 0 || 16), h = Math.max(1, size?.h | 0 || 24);
  const s = Math.max(1, Math.floor(scale) || 1);
  const W = w * s + 2 * PAD, H = h * s + 2 * PAD;
  const pivot = Object.freeze({ x: PAD + (w * s) / 2, y: PAD + h * s });
  const ink = parseColour(outline) || INK;
  const cache = new Map();   // key -> frame (insertion order = LRU order)
  let bytes = 0, renders = 0, evicted = 0;
  const keys = new WeakMap();
  const missing = new Set();

  function keyOf(look) {
    let k = keys.get(look);
    if (k === undefined) { k = lookKey(look); keys.set(look, k); }
    return k;
  }
  // short ids for look keys (a look key spells out the palette: long to hash in every frameKey lookup)
  const lookIds = new WeakMap(), idOfKey = new Map(), animIds = new Map();
  function lookId(look) {
    let n = lookIds.get(look);
    if (n === undefined) { const k = keyOf(look); n = idOfKey.get(k); if (n === undefined) idOfKey.set(k, n = idOfKey.size + 1); lookIds.set(look, n); }
    return n;
  }

  /** Paints the figure (no outline) for the drawn facing into a w x h buffer. */
  function figure(look, drawn, af) {
    const buf = new Uint8ClampedArray(w * h * 4);
    const g = painter(buf, w, h, look.palette || {}, missing);
    g.facing = drawn; g.anim = af.name; g.f = af.i;
    const ids = [...(Array.isArray(look.parts) ? look.parts : []), ...(Array.isArray(look.extras) ? look.extras : [])];
    const list = [];
    ids.forEach((id, order) => {
      const p = parts[id];
      if (!p || typeof p !== 'object') { missing.add(`part:${id}`); return; }
      list.push({ p, order });
    });
    list.sort((a, b) => (+a.p.layer || 0) - (+b.p.layer || 0) || a.order - b.order);
    for (const { p } of list) {
      g.dy = p.bob === false ? 0 : af.bob;
      if (typeof p.draw === 'function') p.draw(g, drawn, af.name, af.i, look.palette || {});
      else if (p.rows) {
        const rows = Array.isArray(p.rows) ? p.rows : (p.rows[drawn] ?? p.rows[0]);
        g.rows(p.x | 0, p.y | 0, rows, p.keys);
      }
    }
    g.dy = 0;
    return buf;
  }

  /** Scale, pad, shadow, rim, outline: the final W x H sticker buffer and its head row. */
  function compose(fig, selected) {
    const out = new Uint8ClampedArray(W * H * 4);
    const solid = new Uint8Array(W * H);   // 1 figure, 2 outline, 3 rim
    const big = new Uint8ClampedArray(W * H * 4);
    let top = H;
    for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) {
      const o = ((Math.floor(y / s)) * w + Math.floor(x / s)) * 4;
      if (!fig[o + 3]) continue;
      const X = x + PAD, Y = y + PAD, q = Y * W + X;
      big.set(fig.subarray(o, o + 4), q * 4);
      solid[q] = 1;
      if (Y < top) top = Y;
    }
    const ring = (from, mark) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const q = y * W + x;
        if (solid[q]) continue;
        if ((x > 0 && solid[q - 1] && solid[q - 1] <= from) || (x < W - 1 && solid[q + 1] && solid[q + 1] <= from)
          || (y > 0 && solid[q - W] && solid[q - W] <= from) || (y < H - 1 && solid[q + W] && solid[q + W] <= from)) solid[q] = -mark;
      }
      for (let q = 0; q < W * H; q++) if (solid[q] === (-mark & 255)) solid[q] = mark;
    };
    ring(1, 2);
    if (rim) ring(2, 3);
    if (shadow && top < H) {
      const cx = pivot.x, cy = pivot.y - 0.5, rx = Math.max(2, Math.round(w * s * 0.375)), ry = Math.max(1, 2.2 * s);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) blend(out, (y * W + x) * 4, SHADOW);
      }
    }
    const rimC = selected ? RIM_SELECTED : RIM;
    for (let q = 0; q < W * H; q++) {
      const k = solid[q];
      if (k === 3) blend(out, q * 4, rimC);
      else if (k === 2) blend(out, q * 4, ink);
      else if (k === 1) blend(out, q * 4, big.subarray(q * 4, q * 4 + 4));
    }
    return { out, top: top < H ? top : pivot.y };
  }

  function mirror(src) {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const a = (y * W + x) * 4, b = (y * W + (W - 1 - x)) * 4;
      out[b] = src[a]; out[b + 1] = src[a + 1]; out[b + 2] = src[a + 2]; out[b + 3] = src[a + 3];
    }
    return out;
  }

  function toImage(data) {
    if (typeof createCanvas === 'function') {
      try {
        const c = createCanvas(W, H), g = c?.getContext?.('2d', READ);
        if (g && typeof g.createImageData === 'function' && typeof g.putImageData === 'function') {
          const im = g.createImageData(W, H);
          im.data.set(data);
          g.putImageData(im, 0, 0);
          return c;
        }
      } catch { /* no canvas: raw below */ }
    }
    return { width: W, height: H, data };
  }

  function put(k, fr) {
    cache.set(k, fr);
    bytes += W * H * 4;
    while (cache.size > Math.max(1, maxFrames) || (bytes > maxBytes && cache.size > 1)) {
      const old = cache.keys().next().value;
      cache.delete(old); bytes -= W * H * 4; evicted++;
    }
  }

  /** The base buffer (drawn facing, not mirrored) for a key, uncached: callers cache the final frame. */
  function render(look, facing, af, selected) {
    renders++;
    const drawn = DRAWN[facing];
    const { out, top } = compose(figure(look, drawn, af), selected);
    const data = MIRROR[facing] ? mirror(out) : out;
    return Object.freeze({ img: toImage(data), pivot, head: Object.freeze({ x: pivot.x, y: top }), w: W, h: H });
  }

  /** A short key of the frame frame() returns for these arguments (equal keys: the same pixels), for callers that keep
   *  frames of their own (render/actor-atlas.js); null for no look. Renders nothing. */
  function frameKey(look, facing = 0, anim = 'idle', f = 0, { selected = false } = {}) {
    if (!look || typeof look !== 'object') return null;
    const fc = ((facing | 0) % FACINGS + FACINGS) % FACINGS;
    const af = animFrame(anims, anim, f);
    let ai = animIds.get(af.name);
    if (ai === undefined) animIds.set(af.name, ai = animIds.size);
    // a number while it fits (a Map hashes a number for free, a fresh string every lookup); else a short string
    if (ai < 64 && af.i < 256) return (((lookId(look) * 64 + ai) * 256 + af.i) * FACINGS + fc) * 2 + (selected ? 1 : 0);
    return `${lookId(look)}|${fc}|${af.name}|${af.i}|${selected ? 1 : 0}`;
  }

  function frame(look, facing = 0, anim = 'idle', f = 0, { selected = false } = {}) {
    if (!look || typeof look !== 'object') return null;
    const fc = ((facing | 0) % FACINGS + FACINGS) % FACINGS;
    const af = animFrame(anims, anim, f);
    const k = `${keyOf(look)}|${fc}|${af.name}|${af.i}|${selected ? 1 : 0}`;
    let fr = cache.get(k);
    if (fr) { cache.delete(k); cache.set(k, fr); return fr; }   // LRU touch
    fr = render(look, fc, af, !!selected);
    put(k, fr);
    return fr;
  }

  return {
    frame, frameKey, keyOf,
    size: Object.freeze({ w, h, W, H, scale: s }),
    stats: () => ({ frames: cache.size, bytes, renders, evicted, missing: [...missing].slice(0, 32) }),
    clear() { cache.clear(); bytes = 0; },
  };
}
