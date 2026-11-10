/**
 * A tiny, dependency-free raster kit for the app icon: pixel-art grids, an RGBA image with
 * compositing, box downscaling, and PNG / ICNS encoders. Everything is integer or plain float math,
 * so the same code always produces the same bytes (test/icon.test.mjs checks the committed files).
 */
import zlib from 'node:zlib'

/** '#rrggbb' or '#rrggbbaa' → [r, g, b, a] with a in 0..1. */
export function rgb(hex) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length > 6 ? parseInt(h.slice(6, 8), 16) / 255 : 1]
}
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return '#' + [0, 1, 2].map((i) => Math.round(x[i] + (y[i] - x[i]) * t).toString(16).padStart(2, '0')).join('') }

/** A pixel-art layer: one hex colour (or null) per cell. Later draws cover earlier ones. */
export class Grid {
  constructor(w, h) { this.w = w; this.h = h; this.c = new Array(w * h).fill(null) }
  get(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.c[y * this.w + x] }
  set(x, y, col) { if (col !== undefined && x >= 0 && y >= 0 && x < this.w && y < this.h) this.c[y * this.w + x] = col }
  rect(x, y, w, h, col) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, typeof col === 'function' ? col(x + i, y + j) : col) }
  /** Fill the cells whose centres fall inside the polygon. `col` may be a function (x, y) → colour. */
  poly(pts, col) {
    const ys = pts.map((p) => p[1])
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(this.h - 1, Math.ceil(Math.max(...ys))); y++) {
      for (let x = 0; x < this.w; x++) if (inside(pts, x + 0.5, y + 0.5)) this.set(x, y, typeof col === 'function' ? col(x, y) : col)
    }
  }
  /** A char-map sprite; `pal` maps characters to colours, '.' and unknown characters are skipped. */
  sprite(x, y, rows, pal) { rows.forEach((r, j) => [...r].forEach((ch, i) => { if (pal[ch]) this.set(x + i, y + j, pal[ch]) })) }
  /** Draw another grid on top of this one at (x, y). */
  over(g, x = 0, y = 0) { for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) { const v = g.get(i, j); if (v) this.set(x + i, y + j, v) } }
  /** A 1-cell outline around everything drawn (4-neighbour), in `col`. */
  outline(col, diag = false) {
    const add = []
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y)) continue
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1], ...(diag ? [[1, 1], [-1, 1], [1, -1], [-1, -1]] : [])]
      if (n.some(([dx, dy]) => this.get(x + dx, y + dy))) add.push([x, y])
    }
    for (const [x, y] of add) this.set(x, y, col)
    return this
  }
  clone() { const g = new Grid(this.w, this.h); g.c = this.c.slice(); return g }
}

function inside(pts, x, y) {
  let r = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r
  }
  return r
}

/** An RGBA image, straight (non-premultiplied) floats 0..1. */
export class Img {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Float64Array(w * h * 4) }
  /** Source-over one pixel with colour [r,g,b,a(0..1)] (r,g,b 0..255) at coverage `k`. */
  blend(x, y, c, k = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const a = c[3] * k
    if (a <= 0) return
    const i = (y * this.w + x) * 4, d = this.d, da = d[i + 3], oa = a + da * (1 - a)
    for (let n = 0; n < 3; n++) d[i + n] = oa ? (c[n] / 255 * a + d[i + n] * da * (1 - a)) / oa : 0
    d[i + 3] = oa
  }
  /** Draw a grid with each cell `cell` pixels square, top-left at (ox, oy), optionally masked. */
  grid(g, ox, oy, cell, mask = null) {
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
      const v = g.get(i, j)
      if (!v) continue
      const c = rgb(v)
      for (let y = oy + j * cell; y < oy + (j + 1) * cell; y++) for (let x = ox + i * cell; x < ox + (i + 1) * cell; x++) this.blend(x, y, c, mask ? mask(x, y) : 1)
    }
  }
  /** Draw another image on top, with an optional per-pixel alpha multiplier. */
  over(img, k = 1) {
    for (let p = 0; p < this.w * this.h; p++) {
      const s = img.d.subarray(p * 4, p * 4 + 4)
      if (s[3] > 0) this.blend(p % this.w, Math.floor(p / this.w), [s[0] * 255, s[1] * 255, s[2] * 255, s[3]], k)
    }
  }
  /** Shrink by an integer factor, averaging in premultiplied space. */
  shrink(f) {
    const o = new Img(this.w / f, this.h / f)
    for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
        const p = ((y * f + j) * this.w + x * f + i) * 4, al = this.d[p + 3]
        r += this.d[p] * al; g += this.d[p + 1] * al; b += this.d[p + 2] * al; a += al
      }
      const q = (y * o.w + x) * 4
      if (a > 0) { o.d[q] = r / a; o.d[q + 1] = g / a; o.d[q + 2] = b / a }
      o.d[q + 3] = a / (f * f)
    }
    return o
  }
  /** Nearest-neighbour enlarge by an integer factor (for crisp pixel art). */
  grow(f) {
    const o = new Img(this.w * f, this.h * f)
    for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
      const s = ((Math.floor(y / f)) * this.w + Math.floor(x / f)) * 4, q = (y * o.w + x) * 4
      for (let n = 0; n < 4; n++) o.d[q + n] = this.d[s + n]
    }
    return o
  }
  /** 8-bit RGBA bytes. */
  bytes() {
    const b = Buffer.alloc(this.w * this.h * 4)
    for (let i = 0; i < b.length; i++) b[i] = Math.max(0, Math.min(255, Math.round(this.d[i] * 255)))
    return b
  }
  png() { return encodePNG(this.w, this.h, this.bytes()) }
}

/** Coverage (0..1) of a rounded rectangle at pixel (x, y), from n×n samples. */
export function roundRectCoverage(x0, y0, w, h, r, n = 4) {
  const hit = (px, py) => {
    const cx = Math.min(Math.max(px, x0 + r), x0 + w - r), cy = Math.min(Math.max(py, y0 + r), y0 + h - r)
    return px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + h && (px - cx) ** 2 + (py - cy) ** 2 <= r * r
  }
  return (x, y) => {
    // Most pixels are well inside or outside: skip the sampling for them.
    const inCore = (x >= x0 + r && x + 1 <= x0 + w - r && y >= y0 && y + 1 <= y0 + h) || (y >= y0 + r && y + 1 <= y0 + h - r && x >= x0 && x + 1 <= x0 + w)
    if (inCore) return 1
    if (x + 1 < x0 || y + 1 < y0 || x > x0 + w || y > y0 + h) return 0
    let k = 0
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (hit(x + (i + 0.5) / n, y + (j + 0.5) / n)) k++
    return k / (n * n)
  }
}

/** A soft drop shadow for a shape given by a coverage function: separable box blur, 3 passes. */
export function shadow(w, h, cov, { dy = 0, blur = 8, color = '#000000', alpha = 0.3 } = {}) {
  let a = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = cov(x, y - dy)
  for (let pass = 0; pass < 3; pass++) {
    const t = new Float64Array(w * h)
    for (let y = 0; y < h; y++) { let s = 0; for (let x = -blur; x < w + blur; x++) { if (x + blur < w) s += a[y * w + x + blur] || 0; if (x - blur - 1 >= 0) s -= a[y * w + x - blur - 1]; if (x >= 0 && x < w) t[y * w + x] = s / (2 * blur + 1) } }
    const u = new Float64Array(w * h)
    for (let x = 0; x < w; x++) { let s = 0; for (let y = -blur; y < h + blur; y++) { if (y + blur < h) s += t[(y + blur) * w + x]; if (y - blur - 1 >= 0) s -= t[(y - blur - 1) * w + x]; if (y >= 0 && y < h) u[y * w + x] = s / (2 * blur + 1) } }
    a = u
  }
  const img = new Img(w, h), c = rgb(color)
  for (let p = 0; p < w * h; p++) img.blend(p % w, Math.floor(p / w), c, a[p] * alpha)
  return img
}

export function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The PNG-based ICNS slots macOS reads (10.7+): type → pixel size. */
export const ICNS_SLOTS = [['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024]]

/** An .icns file from { size: pngBuffer }. */
export function encodeICNS(pngs) {
  const parts = ICNS_SLOTS.map(([type, size]) => {
    const data = pngs[size], head = Buffer.alloc(8)
    head.write(type, 0, 'ascii'); head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii'); head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4)
  return Buffer.concat([head, ...parts])
}
