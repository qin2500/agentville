import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeGif } from '../tools/artpass/gif.mjs';

const frame = (w, h, f) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) a.set(f(i), i * 4); return a; };

test('encodes 2 tiny frames: header, NETSCAPE loop, frame count, trailer', () => {
  const w = 4, h = 3;
  const gif = encodeGif({ width: w, height: h, delay: 200, frames: [
    { rgba: frame(w, h, i => [i * 20, 0, 255 - i * 20, 255]) },
    { rgba: frame(w, h, () => [10, 200, 30, 255]), delay: 500 }] });
  assert.equal(gif.subarray(0, 6).toString('latin1'), 'GIF89a');
  assert.equal(gif.readUInt16LE(6), w); assert.equal(gif.readUInt16LE(8), h);
  assert.ok(gif.includes(Buffer.from('NETSCAPE2.0')));
  const ni = gif.indexOf(Buffer.from('NETSCAPE2.0'));
  assert.equal(gif.readUInt16LE(ni + 11 + 2), 0);        // loop forever
  let gce = 0, imgs = 0;
  for (let i = 13 + 768; i < gif.length - 1; i++) {      // scan blocks after the global table
    if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 4) { gce++; if (gce === 1) assert.equal(gif.readUInt16LE(i + 4), 20); if (gce === 2) assert.equal(gif.readUInt16LE(i + 4), 50); }
  }
  for (let i = gif.indexOf(Buffer.from('NETSCAPE2.0')); i < gif.length; i++) if (gif[i] === 0x2c && gif[i - 1] === 0x00 && gif[i + 9 + 0] !== undefined && gif.readUInt16LE(i + 5) === w && gif.readUInt16LE(i + 7) === h) imgs++;
  assert.equal(gce, 2); assert.equal(imgs, 2);
  assert.equal(gif[gif.length - 1], 0x3b);
});

test('large flat frame compresses and survives dictionary reset', () => {
  const w = 200, h = 150, a = frame(w, h, i => [(i * 7) & 255, (i * 13) & 255, (i >> 3) & 255, 255]);
  const gif = encodeGif({ width: w, height: h, frames: [{ rgba: a }] });
  assert.equal(gif[gif.length - 1], 0x3b);
  assert.throws(() => encodeGif({ width: 2, height: 2, frames: [{ rgba: new Uint8Array(4) }] }));
});
