// Engine prop art: lamp (original pixel art, PA5). Seam: name, frames, extent, draw.
// ---- tiny pixel kit (local copy; coordinates are view px relative to the foot point) ----
const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = hex('#2a1c4a'), WARM = hex('#fff0b0');
const dk = (c, k) => mix(c, SHADE, k), lt = (c, k) => mix(c, WARM, k);
/** 5-tone ramp: deep shadow, shadow, base, light, highlight. */
const ramp = c => { c = typeof c === 'string' ? hex(c) : c; return [dk(c, 0.5), dk(c, 0.25), c, lt(c, 0.2), lt(c, 0.42)]; };
function canvasOf(x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, d = new Uint8ClampedArray(w * h * 4);
  return {
    w, h, d,
    set(x, y, c, a = 255) {
      x = Math.round(x) - x0; y = Math.round(y) - y0;
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
    },
    get(x, y) { x = Math.round(x) - x0; y = Math.round(y) - y0; return x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 0; },
    rect(x, y, rw, rh, c, a = 255) { for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) this.set(x + i, y + j, c, a); },
    /** 1px outline (tinted by the neighbour it touches, never flat black) around everything drawn so far. */
    outline(tint = 0.65) {
      const src = d.slice(), put = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (src[(y * w + x) * 4 + 3]) continue;
        for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + ax, ny = y + ay;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = (ny * w + nx) * 4;
          if (src[j + 3] === 255) { put.push([x, y, dk([src[j], src[j + 1], src[j + 2]], tint)]); break; }
        }
      }
      for (const [x, y, c] of put) this.set(x + x0, y + y0, c);
    },
    flush(g, fx, fy) {
      if (typeof g.createImageData === 'function' && typeof g.putImageData === 'function') {
        const img = g.createImageData(w, h);
        for (let i = 0; i < d.length; i++) img.data[i] = Math.round(d[i]);
        g.putImageData(img, fx + x0, fy + y0);
        return;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!d[i + 3]) continue;
        g.fillStyle = `rgb(${Math.round(d[i])},${Math.round(d[i + 1])},${Math.round(d[i + 2])})`;
        g.fillRect(fx + x0 + x, fy + y0 + y, 1, 1);
      }
    },
  };
}
const px = c => c.map(Math.round);

const IRON = ramp('#3a3f52'), STONE = ramp('#a39a8c');
const GLASS = ramp('#4a6290');
const LIT = [hex('#c9702c'), hex('#f0a346'), hex('#ffcd68'), hex('#ffe7a0'), hex('#fff8dc')];
const TRIMS = [ramp('#3a3f52'), ramp('#4a3a36'), ramp('#2f4a44'), ramp('#52403a')];

export const name = 'lamp';
export const frames = 1;
export function extent(p, style) { return [-30, -62, 30, 10]; }
export function draw(g, p, fx, fy, t, lit, style) {
  const v = (p && p.v | 0) % 4, I = TRIMS[v < 0 ? 0 : v];
  const c = canvasOf(...extent(p, style));
  if (lit) { // soft warm halo around the lantern (translucent, behind the art)
    for (let y = -58; y <= -14; y++) for (let x = -28; x <= 28; x++) {
      const dx = x / 28, dy = (y + 36) / 22, r = dx * dx + dy * dy;
      if (r < 1) c.set(x, y, LIT[1], Math.round(70 * (1 - r) * (1 - r)));
    }
  }
  // stone plinth (iso diamond slab, 3px tall)
  for (let y = -2; y <= 3; y++) {
    const half = Math.round(8 * (1 - Math.abs(y - 0.5) / 4.5));
    for (let x = -half; x <= half; x++) c.set(x, y, y > 0 ? STONE[1] : STONE[x < 0 ? 3 : 2]);
  }
  for (let x = -5; x <= 5; x++) c.set(x, -3 + (Math.abs(x) > 3 ? 1 : 0), STONE[4]);
  // post: 2px wide, light on the left
  for (let y = -30; y <= -3; y++) { c.set(-1, y, I[3]); c.set(0, y, I[2]); c.set(1, y, I[1]); }
  c.rect(-2, -9, 5, 2, I[2]); c.set(-2, -9, I[3]); // collar
  c.rect(-2, -20, 5, 1, I[3]);
  // curled bracket arms
  for (const s of [-1, 1]) { c.set(s * 3, -27, I[2]); c.set(s * 4, -28, I[1]); c.set(s * 3, -26, I[1]); }
  // lantern: base, glass box, cap
  c.rect(-4, -32, 9, 2, I[1]); c.set(-4, -32, I[2]);
  for (let y = -40; y <= -33; y++) for (let x = -3; x <= 3; x++) {
    let col;
    if (lit) col = (x === -3 || x === 3) ? LIT[0] : (y < -37 ? LIT[4] : (x < 0 ? LIT[3] : LIT[2]));
    else col = (x < 0) ? GLASS[3] : (x === 3 ? GLASS[0] : GLASS[1]);
    if (!lit && y === -40) col = GLASS[4];
    c.set(x, y, col);
  }
  for (const x of [-3, 3]) for (let y = -40; y <= -33; y++) c.set(x, y, lit ? LIT[0] : I[1]); // frame
  c.set(0, -37, lit ? LIT[4] : GLASS[2]); c.set(0, -36, lit ? LIT[4] : GLASS[2]);
  c.rect(-4, -42, 9, 2, I[2]); c.rect(-3, -43, 7, 1, I[3]); c.rect(-1, -45, 3, 2, I[2]); c.set(0, -46, I[3]);
  c.outline();
  c.flush(g, fx, fy);
}
