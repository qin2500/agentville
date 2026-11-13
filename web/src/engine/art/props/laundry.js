// Original pixel-art prop (engine scale 32x16 tile): laundry line. Seam: see PROPS.md.
// ---------- colour (5-tone ramps, shadows toward indigo, highlights toward warm yellow) ----------
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = rgb('#2a1c4a'), WARM = rgb('#fff0b0');
const dk = (c, k) => mix(c, SHADE, k), lt = (c, k) => mix(c, WARM, k);
const ramp = c => { c = typeof c === 'string' ? rgb(c) : c; return [dk(c, 0.5), dk(c, 0.25), c, lt(c, 0.2), lt(c, 0.42)]; };

// ---------- tiny pixel buffer; (0,0) of the foot point sits at (-X0, -Y0) inside it ----------
function makeBuf(x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, c = new Array(w * h).fill(null);
  const set = (x, y, col) => { x = Math.round(x) - x0; y = Math.round(y) - y0; if (x >= 0 && y >= 0 && x < w && y < h) c[y * w + x] = col; };
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? null : c[y * w + x]);
  const rect = (x, y, rw, rh, col) => { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) set(x + i, y + j, col); };
  /** 1px outline tinted by the colour it borders (never flat black). */
  const outline = () => {
    const add = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (c[y * w + x]) continue;
      const n = at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1);
      if (n) add.push([y * w + x, mix(dk(n, 0.6), SHADE, 0.35)]);
    }
    for (const [i, col] of add) c[i] = col;
  };
  const paint = (g, fx, fy) => {
    const img = g.createImageData(w, h), d = img.data;
    for (let i = 0; i < c.length; i++) if (c[i]) { d[i * 4] = Math.round(c[i][0]); d[i * 4 + 1] = Math.round(c[i][1]); d[i * 4 + 2] = Math.round(c[i][2]); d[i * 4 + 3] = 255; }
    g.putImageData(img, Math.round(fx) + x0, Math.round(fy) + y0);
  };
  return { set, at, rect, outline, paint };
}

export const name = 'laundry';
export const frames = 1;
const EXT = [-14, -38, 15, 7];
export function extent(p, style) { return EXT.slice(); }

const CLOTHS = ['#e8e0cc', '#c8503e', '#4f86c6', '#e0b43e', '#7aa05a', '#c9728a', '#f2ede0'].map(ramp);
const WOOD = ramp('#9a6a40'), ROPE = rgb('#d8c9a0');

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) >>> 0, b = makeBuf(EXT[0], EXT[1], EXT[2], EXT[3]);
  // soft ground shadow
  for (let x = -10; x <= 10; x++) { const yy = Math.round(x * 0.5); b.set(x, yy + 1, mix(rgb('#5f7a3a'), SHADE, 0.35)); }
  // two posts at world (-8,0) and (8,0): view (-8,-4) and (8,4); 30px tall
  const posts = [[-8, -4], [8, 4]], top = 30;
  for (const [px, py] of posts) {
    for (let z = 0; z < top; z++) { b.set(px, py - z, WOOD[2]); b.set(px + 1, py - z, WOOD[1]); b.set(px - 1, py - z, WOOD[3]); }
    b.rect(px - 2, py - top, 5, 1, WOOD[3]); // peg cap
    b.set(px, py + 1, WOOD[0]); b.set(px + 1, py + 1, WOOD[0]); b.set(px - 1, py + 1, WOOD[1]);
  }
  // sagging line
  const lineY = x => { const u = (x + 8) / 16; return -4 - (top - 2) + (x + 8) * 0.5 + Math.sin(u * Math.PI) * 2.4; };
  const ly = x => Math.round(lineY(x));
  for (let x = -8; x <= 8; x++) b.set(x, ly(x), ROPE);
  // cloths: [x start, width, length, colour index, shape]
  const layouts = [
    [[-6, 4, 9], [-1, 3, 6], [3, 4, 11]],
    [[-6, 3, 7], [-2, 5, 10], [4, 3, 6]],
    [[-7, 3, 11], [-3, 3, 6], [1, 3, 9], [5, 2, 5]],
    [[-6, 5, 8], [0, 2, 12], [3, 4, 7]],
  ][v % 4];
  layouts.forEach(([x0, w0, len0], i) => {
    const w = w0 + (w0 < 4 ? 1 : 0), len = Math.round(len0 * 1.6);
    const cl = CLOTHS[(v + i * 2 + (i === 0 ? 0 : 1)) % CLOTHS.length];
    for (let x = x0; x < x0 + w; x++) {
      const y0 = ly(x) + 1;
      const sway = (x - x0 === w - 1) ? 1 : 0; // lower right edge tucks in a pixel
      const l = len - sway - (((x - x0) & 1) && w > 3 && i === 1 ? 2 : 0); // ragged hem
      for (let j = 0; j < l; j++) {
        const sh = x - x0 === 0 ? 3 : x - x0 === w - 1 ? 1 : j < 2 ? 3 : 2; // lit left edge, shaded right edge
        b.set(x, y0 + j, cl[sh]);
      }
      if (len >= 9 && x - x0 === 1) b.set(x, y0 + 7, cl[1]); // fold crease
    }
    b.set(x0, ly(x0), WOOD[4]); b.set(x0 + w - 1, ly(x0 + w - 1), WOOD[4]); // pegs
  });
  b.outline();
  b.paint(g, fx, fy);
}
