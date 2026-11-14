// Engine prop art: railing (original pixel art, PA5). Seam: name, frames, extent, draw.
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

const STONE = ramp('#a39a8c'), IRON = ramp('#3d4150');
const IRONS = [ramp('#3d4150'), ramp('#4a3a36'), ramp('#2f4a44'), ramp('#52403a')];

export const name = 'railing';
export const frames = 1;
const lenOf = p => Math.max(1, (p && p.len | 0) || 1);
// Run: from the first tile's near border (s = -8) for len tiles along +x (view x = s) or +y (view x = -s).
export function extent(p, style) {
  const L = lenOf(p) * 16, a = -8 - 3, b = L - 8 + 3;
  const y0 = Math.floor(a / 2) - 16, y1 = Math.ceil(b / 2) + 4;
  return p && p.dir === 'y' ? [-b, y0, -a, y1] : [a, y0, b, y1];
}
export function draw(g, p, fx, fy, t, lit, style) {
  const v = Math.abs((p && p.v | 0) % 4), I = IRONS[v];
  const dirY = p && p.dir === 'y', L = lenOf(p) * 16;
  const c = canvasOf(...extent(p, style));
  const at = s => [dirY ? -s : s, Math.floor(s / 2)];   // view point of run position s at z = 0
  const col = (s, z0, z1, cc) => { const [x, y] = at(s); for (let z = z0; z < z1; z++) c.set(x, y - z, cc); };
  const lightSide = dirY ? I[1] : I[3];
  // low stone plinth along the whole run, 3px tall
  for (let s = -8; s <= L - 8; s++) { col(s, 0, 2, STONE[2]); col(s, 2, 3, STONE[4]); const [x, y] = at(s); c.set(x, y + 1, STONE[1]); }
  // pickets every 4 world px, rails top and mid
  for (let s = -8; s <= L - 8; s++) {
    const k = (s + 8) % 4;
    if (k === 0) col(s, 3, 10, dirY ? I[1] : I[3]);
    else if (k === 1) col(s, 3, 10, I[1]);
    col(s, 8, 9, I[2]); col(s, 5, 6, I[1]);
    col(s, 9, 10, I[3]);
  }
  // posts on tile borders (shared with neighbours): thicker with a stone cap and a tiny ball
  for (let s = -8; s <= L - 8; s += 16) {
    const [x, y] = at(s);
    for (const dx of [-1, 0, 1]) col(s + (dirY ? -dx : dx), 3, 12, dx < 0 ? STONE[3] : (dx > 0 ? STONE[1] : STONE[2]));
    for (const dx of [-1, 0, 1]) { const [qx, qy] = at(s + dx); c.set(qx, qy - 12, STONE[4]); }
    c.set(x, y - 13, STONE[3]);
  }
  c.outline();
  c.flush(g, fx, fy);
}
