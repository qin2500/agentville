// Yard dressing (city v5): cypress trees and vine pergolas. Contract: README.js.

/** A tall narrow cypress at (x, y), h high (<= 30). */
export function cypress(K, x, y, h) {
  const { prism, cyl, shOf, shade, h2, st, lt, dk, rgb } = K;
  h = Math.min(30, Math.max(14, h));
  const G = rgb('#2f6a3a');
  const trunkH = 2.5, n = 7, body = h - trunkH;
  cyl(x, y, 0.9, 0, trunkH + 1, q => [dk(rgb('#6a4630'), q.cap ? 0.3 : 0.1), 0]);
  // flame profile: radius bulges low-mid, tapers to a point
  const prof = t => 2.9 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.18 + 0.82 * t) ), 0.9) * (1 - 0.25 * t);
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const r0 = i === 0 ? prof(0.03) : prof(t0), r1 = i === n - 1 ? 0 : prof(t1);
    prism(`CY${i}`, x, y, Math.max(0.6, r0), r1, trunkH + body * t0, trunkH + body * t1 + (i < n - 1 ? 0.8 : 0), 6, (nm, N) => {
      const sh = shOf(N);
      return q => {
        const k = h2(q.col, Math.floor(q.z), st.seed + 11 + i);
        let c = k % 5 === 0 ? dk(G, 0.22) : k % 4 === 0 ? lt(G, 0.14) : G;
        return [shade(c, sh), 0];
      };
    });
  }
}

/** A vine pergola against the front wall at y = Y, x0..x1, dep deep (<= 7), about 14 high: posts, beams, a leafy
 * canopy with gaps and a few grape bunches. Must leave the door (under it) readable. */
export function pergola(K, x0, x1, Y, dep) {
  const { box, ball, face, flat, h2, st, byLight, ramp, lt, dk, rgb, WOOD, DARKWOOD, LEAF, shOf, shade } = K;
  dep = Math.min(7, dep);
  const yf = Y + dep, zb = 14;
  const wm = sh => q => [dk(q.col <= 0 ? lt(WOOD, 0.1) : WOOD, sh), 0];
  const WS = wm(0), WE = wm(0.25), WT = flat(lt(WOOD, 0.15));
  const xs = [x0 + 1];
  const span = x1 - x0, mid = span > 40 ? Math.round(span / 2) : 0;
  if (mid) xs.push(x0 + mid);
  xs.push(x1 - 1);
  for (const px of xs) box(px - 0.7, px + 0.7, yf - 1.4, yf, 0, zb, WS, WE, WT);
  // front beam along x, and side beams along y into the wall
  box(x0, x1, yf - 1.6, yf, zb, zb + 1.6, WS, WE, WT);
  for (const px of [x0 + 0.5, x1 - 0.5]) box(px - 0.7, px + 0.7, Y, yf, zb + 0.4, zb + 1.8, WS, WE, WT);
  // cross slats across the top
  const zt = zb + 1.8;
  for (let px = x0 + 3; px < x1 - 1; px += 4) box(px - 0.5, px + 0.5, Y, yf + 0.6, zt, zt + 0.9, WS, WE, WT);
  // leafy canopy with gaps
  const z = zt + 0.9;
  const keep = P => h2(Math.floor(P[0] * 1.3), Math.floor(P[1] * 1.3), st.seed + 5) % 5 !== 0;
  const leaf = q => {
    const k = h2(Math.floor(q.P[0] * 1.5), Math.floor(q.P[1] * 1.5), st.seed + 2);
    return [k % 3 === 0 ? lt(LEAF, 0.12) : k % 5 === 0 ? dk(LEAF, 0.2) : LEAF, 0];
  };
  face([[x0, Y, z], [x1, Y, z], [x1, yf + 0.6, z], [x0, yf + 0.6, z]], 'S', leaf, { col0: 0, keep: (P) => keep(P) });
  // hanging bunches of grapes under the front beam
  const GR = rgb('#7a3f9c');
  const nb = 3 + (h2(x0, Y, st.seed) % 3);
  for (let i = 0; i < nb; i++) {
    const gx = x0 + 3 + ((h2(i, 3, st.seed) % 1000) / 1000) * (span - 6);
    const gy = yf - 0.5 + (i % 2) * 0.5;
    ball(gx, gy, zb - 1, 1.1, q => [byLight(ramp(GR), q.N, 0.1), 0]);
    ball(gx + 0.4, gy, zb - 2.2, 0.8, q => [byLight(ramp(GR), q.N, 0.1), 0]);
  }
}
