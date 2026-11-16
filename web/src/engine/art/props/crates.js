// Engine prop art: crates (a stack of plank crates, the classic 8x8 crate pattern). p: { n 1..6 (default 4), v 0..2 tint,
// z0 lift (default 6: on the quay) }. Foot = the 1x1 footprint's north corner; the stack sits on the tile's middle.
// anchors.top: the top crate's top; anchors.slots: the crate centres.
import { canvasOf, hex } from './_quay-kit.js';
import { proj } from './_wharf-kit.js';

export const name = 'crates';
export const frames = 1;
const MAP = ['.oooooo.', 'oLLLLLLo', 'oDmmmmDo', 'omDmmDmo', 'ommDDmmo', 'omDmmDmo', 'oDmmmmDo', 'oooooooo'];
const TINTS = [{ o: '#2a1a14', L: '#e0b070', m: '#b07a42', D: '#7a4f2e' }, { o: '#2a1a14', L: '#c9a27a', m: '#9a6a4a', D: '#6a4430' }, { o: '#1e2a24', L: '#a8b88a', m: '#7a8c62', D: '#56663f' }];
// rows bottom to top, as crate counts; a crate is 8 px
const ROWS = { 1: [1], 2: [2], 3: [2, 1], 4: [3, 1], 5: [3, 2], 6: [3, 2, 1] };
const nOf = p => Math.min(6, Math.max(1, (p && p.n | 0) || 4));
const zOf = p => (p && p.z0 != null ? p.z0 : 6);
const slots = p => {
  const rows = ROWS[nOf(p)], out = [];
  rows.forEach((cnt, r) => { for (let i = 0; i < cnt; i++) out.push([Math.round((i - (cnt - 1) / 2) * 8), 8 - zOf(p) - 4 - r * 7 - 0]); });
  return out;
};
export function extent(p) {
  const s = slots(p), x0 = Math.min(...s.map(c => c[0])) - 4, x1 = Math.max(...s.map(c => c[0])) + 4, y0 = Math.min(...s.map(c => c[1])) - 4;
  return [x0, y0, x1, 8 - zOf(p) + 3];
}
export function draw(g, p, fx, fy) {
  const T = TINTS[Math.abs((p && p.v | 0) % 3)], c = canvasOf(...extent(p));
  const [ex0, , ex1] = extent(p);
  c.rect(ex0 + 1, 8 - zOf(p) - 1, ex1 - ex0 - 2, 3, [24, 18, 36], 90);   // contact shade
  for (const [cx, cy] of slots(p)) MAP.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== '.') c.set(cx - 4 + i, cy - 4 + j, hex(T[ch])); }));
  c.flush(g, fx, fy);
}
export const anchors = p => { const s = slots(p); return { top: s[s.length - 1], slots: s, tile: proj(8, 8, zOf(p)).map(Math.round) }; };
