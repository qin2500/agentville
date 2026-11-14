// Engine prop art: banner (original pixel art, PA5). Seam: name, frames, extent, draw.
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

const WOOD = ramp('#9a6a40'), CLOTH = ramp('#efe3c6');
const CLOTHS = ['#c8503e', '#3f78b0', '#5b9a3c', '#e0b43e'].map(ramp);
const STONE = ramp('#a39a8c');
const validAccent = s => s && typeof s === 'object' && typeof s.accent === 'string' && /^#[0-9a-f]{6}$/i.test(s.accent);

export const name = 'banner';
export const frames = 1;
export function extent(p, style) { return [-14, -58, 14, 8]; }
export function draw(g, p, fx, fy, t, lit, style) {
  const v = Math.abs((p && p.v | 0) % 4);
  const C = validAccent(style) ? ramp(style.accent) : CLOTHS[v];
  const c = canvasOf(...extent(p, style));
  // stone footing
  for (let y = -2; y <= 3; y++) {
    const half = Math.round(6 * (1 - Math.abs(y - 0.5) / 4.5));
    for (let x = -half; x <= half; x++) c.set(x, y, y > 0 ? STONE[1] : STONE[x < 0 ? 3 : 2]);
  }
  for (let x = -3; x <= 3; x++) c.set(x, -3, STONE[4]);
  // pole
  for (let y = -50; y <= -3; y++) { c.set(-1, y, WOOD[3]); c.set(0, y, WOOD[2]); c.set(1, y, WOOD[1]); }
  c.rect(-2, -52, 5, 2, WOOD[3]); c.set(0, -54, WOOD[4]); c.rect(-1, -53, 3, 1, WOOD[3]); // finial
  // cross bar
  c.rect(-9, -47, 19, 2, WOOD[2]); c.rect(-9, -47, 19, 1, WOOD[3]); c.set(-10, -47, WOOD[4]); c.set(10, -47, WOOD[4]);
  // cloth hanging from the bar, swallow-tailed
  const top = -45, bot = -17;
  for (let y = top; y <= bot; y++) {
    for (let x = -7; x <= 7; x++) {
      const ax = Math.abs(x);
      // swallowtail notch: a V cut from the bottom centre
      if (y >= bot - 5 && ax <= (y - (bot - 6)) && ax < 4) continue;
      let col = x < -2 ? C[3] : (x > 3 ? C[1] : C[2]);
      if (((y - top) % 9) === 4) col = x < 0 ? C[4] : C[3]; // woven band highlight
      if (x === 7) col = C[0];
      c.set(x, y, col);
    }
  }
  // emblem: small diamond in a cream tone
  for (let dy = -4; dy <= 4; dy++) { const hw = 4 - Math.abs(dy); for (let x = -hw; x <= hw; x++) c.set(x, -31 + dy, Math.abs(x) === hw ? CLOTH[1] : CLOTH[x < 0 ? 3 : 2]); }
  // hanging cords
  c.set(-7, -46, WOOD[1]); c.set(7, -46, WOOD[1]);
  c.outline();
  c.flush(g, fx, fy);
}
