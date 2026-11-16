// Dependency-free GIF89a encoder. Fixed 6x7x6 colour cube palette (252 entries, +4 spare), LZW, per-frame delay, NETSCAPE loop.
//   encodeGif({ width, height, frames: [{ rgba: Uint8Array|Uint8ClampedArray (w*h*4), delay?: ms }], delay = 100, loop = 0 }) -> Buffer
// loop 0 = forever. Transparent pixels (alpha < 128) are composited on white.

const RL = 6, GL = 7, BL = 6;
export function palette() {
  const p = new Uint8Array(256 * 3);
  for (let r = 0; r < RL; r++) for (let g = 0; g < GL; g++) for (let b = 0; b < BL; b++) {
    const i = (r * GL + g) * BL + b;
    p[i * 3] = Math.round(r * 255 / (RL - 1)); p[i * 3 + 1] = Math.round(g * 255 / (GL - 1)); p[i * 3 + 2] = Math.round(b * 255 / (BL - 1));
  }
  return p;
}

export function indexFrame(rgba, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const r = rgba[i * 4] * a + 255 * (1 - a), g = rgba[i * 4 + 1] * a + 255 * (1 - a), b = rgba[i * 4 + 2] * a + 255 * (1 - a);
    out[i] = (Math.round(r * (RL - 1) / 255) * GL + Math.round(g * (GL - 1) / 255)) * BL + Math.round(b * (BL - 1) / 255);
  }
  return out;
}

// GIF-flavoured LZW with 8-bit min code size; returns the sub-blocked byte stream (without the min-code-size byte).
export function lzw(idx, minCode = 8) {
  const clear = 1 << minCode, eoi = clear + 1, bytes = [];
  let size = minCode + 1, next = eoi + 1, dict = new Map(), acc = 0, nb = 0;
  const emit = code => { acc |= code << nb; nb += size; while (nb >= 8) { bytes.push(acc & 255); acc >>>= 8; nb -= 8; } };
  emit(clear);
  let cur = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = cur * 256 + k, hit = dict.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    cur = k;
  }
  emit(cur); emit(eoi);
  if (nb > 0) bytes.push(acc & 255);
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) { const n = Math.min(255, bytes.length - i); out.push(n); for (let j = 0; j < n; j++) out.push(bytes[i + j]); }
  out.push(0);
  return out;
}

export function encodeGif({ width, height, frames, delay = 100, loop = 0 }) {
  if (!frames?.length) throw new Error('encodeGif: no frames');
  const b = [], w16 = v => b.push(v & 255, (v >> 8) & 255);
  b.push(...Buffer.from('GIF89a'));
  w16(width); w16(height);
  b.push(0xf7, 0, 0);                                   // global table, 256 entries, 8-bit colour
  b.push(...palette());
  b.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1); w16(loop); b.push(0);
  for (const f of frames) {
    if (f.rgba.length !== width * height * 4) throw new Error('encodeGif: frame size mismatch');
    b.push(0x21, 0xf9, 4, 0x00); w16(Math.max(1, Math.round((f.delay ?? delay) / 10))); b.push(0, 0);   // graphic control: delay in 1/100 s
    b.push(0x2c); w16(0); w16(0); w16(width); w16(height); b.push(0);
    b.push(8); for (const x of lzw(indexFrame(f.rgba, width * height))) b.push(x);
  }
  b.push(0x3b);
  return Buffer.from(b);
}
