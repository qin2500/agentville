// Engine art: the ridge flag (original pixel art, M4 P4). A swallow-tailed pennant on a slim wooden staff with a gilt
// finial; the cloth takes the village accent and ripples over 4 frames. NOT a registered prop: render/accent.js draws it
// from ridge anchors. Seam: name, frames, extent, pixels(accent, frame) -> {w, h, ox, oy, data}, draw(g, p, fx, fy, t).
// parity: style.flags-on-ridges
export const name = 'flag';
export const frames = 4;
const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const SHADE = [42, 28, 74], WARM = [255, 240, 176];
const W = 14, H = 20, OX = 3, OY = 19;   // canvas px; (OX, OY) is the staff foot (the ridge point)
const WOOD = [[110, 76, 46], [158, 112, 68]], GOLD = [[214, 168, 58], [255, 226, 130]];

/** extent about the foot point, like prop modules. */
export function extent() { return [-OX, -OY, W - OX, H - OY]; }

/** Raw RGBA of one frame. The pennant is 9 columns long, wave amplitude grows toward the free end. */
export function pixels(accent, frame = 0) {
  const base = hex(/^#[0-9a-f]{6}$/i.test(accent) ? accent : '#c8503e');
  const lo = mix(base, SHADE, 0.3), hi = mix(base, WARM, 0.3);
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; };
  for (let y = 5; y <= OY; y++) put(OX, y, y % 2 ? WOOD[0] : WOOD[1]);   // staff
  put(OX, 4, GOLD[1]); put(OX, 3, GOLD[0]);                                // finial
  const f = ((frame % frames) + frames) % frames;
  for (let k = 1; k <= 9; k++) {
    const amp = k / 9 * 1.6, off = Math.round(Math.sin((f / frames) * Math.PI * 2 - k * 0.7) * amp);
    const half = 3 - Math.floor(k / 4);                                    // taper 3 -> 1 rows either side of centre
    const top = 6 + off, h = Math.max(2, half * 2 - (k > 7 && k % 2 ? 1 : 0));
    for (let r = 0; r < h; r++) {
      if (k >= 8 && r === Math.floor(h / 2)) continue;                     // swallow-tail notch
      put(OX + k, top + r, r === 0 ? hi : r >= h - 1 ? lo : base);
    }
  }
  return { w: W, h: H, ox: OX, oy: OY, data };
}

/** prop-module compatible draw (g is a 2D context or the recording fake): fx, fy is the staff foot. */
export function draw(g, p, fx, fy, t = 0) {
  const accent = p && p.accent, fr = Math.floor(t * 6);
  const { w, h, data } = pixels(accent, fr);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (!data[i + 3]) continue;
    g.fillStyle = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
    g.fillRect(fx - OX + x, fy - OY + y, 1, 1);
  }
}
