// Original pixel-art prop (engine scale 32x16 tile): scarecrow. Seam: see PROPS.md.
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

export const name = 'scarecrow';
export const frames = 1;
const EXT = [-15, -41, 16, 6];
export function extent(p, style) { return EXT.slice(); }

const WOOD = ramp('#9a6a40'), STRAW = ramp('#dcba5a'), SACK = ramp('#d8bf8c');
const SHIRTS = ['#c8503e', '#4f86c6', '#7aa05a', '#b4604e'].map(ramp);
const PATCHES = ['#e0b43e', '#4f86c6', '#c9728a', '#efe3c6'].map(ramp);
const BANDS = ['#c8503e', '#4f86c6', '#7aa05a', '#6a4630'].map(rgb);

export function draw(g, p, fx, fy, t, lit, style) {
  const v = ((p && p.v) | 0) >>> 0, b = makeBuf(EXT[0], EXT[1], EXT[2], EXT[3]);
  const shirt = SHIRTS[v % SHIRTS.length], patch = PATCHES[(v + 1) % PATCHES.length], band = BANDS[(v + 2) % BANDS.length];
  const pants = ramp(['#5a6f8f', '#7a5236', '#6b6b4a', '#5a6f8f'][v % 4]);
  for (let x = -6; x <= 6; x++) b.set(x, Math.round(x * 0.5) + 1, mix(rgb('#5f7a3a'), SHADE, 0.35)); // ground shadow
  // main pole, 26px with the crossbar at z=20
  for (let z = 0; z < 26; z++) { b.set(0, -z, WOOD[2]); b.set(1, -z, WOOD[1]); b.set(-1, -z, WOOD[3]); }
  // trousers (two legs hanging from the tunic hem) and straw ankle tufts
  for (let z = 1; z <= 9; z++) { for (let x = -3; x <= -1; x++) b.set(x, -z, pants[x === -3 ? 3 : 2]); for (let x = 1; x <= 3; x++) b.set(x, -z, pants[x === 3 ? 1 : 2]); }
  b.set(-4, -1, STRAW[3]); b.set(-3, 0, STRAW[2]); b.set(4, -1, STRAW[2]); b.set(3, 0, STRAW[1]); b.set(-2, 0, STRAW[3]); b.set(2, 0, STRAW[1]);
  // crossbar (z 20..21, tilted along the iso x axis a little)
  for (let x = -11; x <= 11; x++) { const y = -20 + Math.round(x * 0.2); b.set(x, y, WOOD[3]); b.set(x, y - 1, WOOD[2]); }
  // sleeves (shirt colour) hanging from the bar with straw hands
  for (let x = -10; x <= 10; x++) {
    if (Math.abs(x) < 4) continue;
    const y = -20 + Math.round(x * 0.2), s = x < 0 ? 3 : 1;
    b.set(x, y + 1, shirt[s]); b.set(x, y + 2, shirt[x < 0 ? 2 : 0 + 1]);
    if (Math.abs(x) >= 9) b.set(x, y + 3, shirt[1]);
  }
  for (const sx of [-1, 1]) { const hx = sx * 11, hy = -20 + Math.round(hx * 0.2); b.set(hx, hy, STRAW[3]); b.set(hx + sx, hy + 1, STRAW[2]); b.set(hx + sx, hy + 3, STRAW[3]); b.set(hx, hy + 4, STRAW[1]); b.set(hx + sx * 2, hy + 2, STRAW[4]); }
  // tunic torso z 10..19, patched
  for (let z = 10; z <= 19; z++) for (let x = -4; x <= 4; x++) {
    const hem = z === 10 && (x & 1);
    if (hem) continue;
    let s = x <= -3 ? 3 : x >= 3 ? 1 : 2;
    b.set(x, -z, shirt[s]);
  }
  for (let x = -3; x <= 4; x++) b.set(x, -10, STRAW[x & 1 ? 2 : 3]); // straw poking out below hem
  b.rect(-3, -17, 3, 3, patch[3]); b.rect(-3, -17, 3, 1, patch[4]); b.set(-2, -16, patch[1]); // patch (stitched)
  b.rect(1, -13, 3, 2, patch[2]); b.set(1, -13, patch[1]); b.set(3, -12, patch[1]);
  b.rect(-4, -19, 9, 1, shirt[3]); // collar
  // head: burlap sack, z 21..27
  for (let y = -27; y <= -21; y++) for (let x = -3; x <= 3; x++) {
    if ((y === -27 || y === -21) && Math.abs(x) === 3) continue;
    b.set(x, y, SACK[x <= -2 ? 3 : x >= 2 ? 1 : 2]);
  }
  const ink = rgb('#3a2a3a');
  b.set(-2, -25, ink); b.set(1, -25, ink); b.set(-1, -23, ink); b.set(0, -23, ink); b.set(1, -23, ink); // eyes + stitched smile
  b.set(-2, -23, ink); b.set(2, -23, ink);
  b.set(-3, -22, SACK[0]);
  // straw hat: wide brim z 27..28, crown z 29..33, band
  for (let x = -7; x <= 7; x++) { b.set(x, -28 + (Math.abs(x) >= 6 ? 1 : 0), STRAW[x <= -2 ? 3 : x >= 3 ? 1 : 2]); b.set(x, -27 + (Math.abs(x) >= 6 ? 0 : 0), STRAW[x < 0 ? 2 : 1]); }
  for (let z = 29; z <= 32; z++) for (let x = -3; x <= 3; x++) { if (z === 32 && Math.abs(x) === 3) continue; b.set(x, -z, STRAW[x <= -2 ? 4 : x >= 2 ? 2 : 3]); }
  for (let x = -3; x <= 3; x++) b.set(x, -29, band);
  b.set(-1, -33, STRAW[3]); b.set(0, -33, STRAW[4]); b.set(1, -33, STRAW[2]);
  b.set(3, -31, STRAW[1]); b.set(-2, -30, STRAW[2]); // straw weave marks
  b.set(-7, -26, STRAW[2]); b.set(7, -26, STRAW[1]); // frayed brim ends
  b.outline();
  b.paint(g, fx, fy);
}
