// Oriels (upper-floor bay windows on corbels) and ground-floor bays (city v5). Contract: README.js.

/** A box window projecting dep world px south from the wall at y = Y, centred at x = xc, wd wide, from z0 to z1
 * (z0 = 0: a ground-floor bay with a plinth; > 0: an oriel on brackets/corbel), with its own little roof (top
 * <= z1 + dep * 1.6). Name its walls `${name}S` / `${name}E` and put a window (lead/cross per K.st) on them. */
export function oriel(K, name, xc, Y, z0, z1, wd, dep) {
  const { st, s, face, box, flat, dk, lt } = K;
  const xa = xc - wd / 2, xb = xc + wd / 2, yf = Y + dep;
  const base = { tex: 'plaster', paint: st.paint, corner: 'post', frame: -1 };
  const colsS = K.wallS(`${name}S`, xa, xb, yf, z0, z1, base);
  const colsE = K.wallE(`${name}E`, xb, Y, yf, z0, z1, { ...base, shade: 0.3 });
  const mid = (cols, w) => { const c = cols >> 1; return [c - (w >> 1), c - (w >> 1) + w - 1]; };
  const wS = Math.max(3, Math.min(colsS - 4, Math.round(colsS * 0.7)));
  const [s0, s1] = mid(colsS, wS);
  const zw0 = z0 + Math.max(2, Math.round((z1 - z0) * 0.22)), zw1 = z1 - Math.max(2, Math.round((z1 - z0) * 0.15));
  K.fit({ face: `${name}S`, kind: 'win', c0: s0, c1: s1, z0: zw0, z1: zw1, lead: st.lead, cross: st.cross, flowers: z0 > 4, shutters: false });
  if (colsE >= 5) {
    const [e0, e1] = mid(colsE, Math.min(3, colsE - 2));
    K.fit({ face: `${name}E`, kind: 'win', c0: e0, c1: e1, z0: zw0, z1: zw1, lead: st.lead, cross: st.cross, flowers: false, shutters: false });
  }
  const bm = (sh = 0) => () => [dk(st.beam, sh), 0];
  if (z0 > 3) {
    // a stepped, sloping corbel under the oriel, plus a carved bracket at each front corner
    const n = Math.min(4, Math.max(2, Math.floor(z0 / 2)));
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1), d = dep * (1 - t) * 0.9, zl = z0 - (i + 1) * 2, zh = z0 - i * 2;
      const ix = wd * 0.12 * t;
      box(xa + ix, xb - ix, yf - d, yf, zl, zh, bm(0.05 + 0.04 * i), bm(0.3), bm(0));
    }
    for (const bx of [xa, xb - 2]) box(bx, bx + 2, yf - dep * 0.7, yf, z0 - 6, z0 - 2, bm(0.1), bm(0.32), bm(0));
  } else if (z0 === 0) {
    // a low stone plinth
    const st0 = K.STONE ? K.STONE : K.rgb('#8a8680');
    const pm = sh => q => [dk(Math.floor(q.z) % 3 === 0 ? dk(st0, 0.12) : st0, sh), 0];
    box(xa - 1, xb + 1, Y, yf + 1, 0, 2, pm(0), pm(0.3), q => [lt(st0, 0.12), 0]);
  }
  // a little hipped lean-to back to the wall
  const e = 1.5, h = Math.min(dep * 1.2, dep * 1.6 - 0.5), zt = z1 + h, ye = yf + e;
  const hh = h * (ye - Y) / Math.max(1, yf - Y);
  const zr = Math.min(z1 + hh, z1 + dep * 1.6), r = (zr - z1);
  face([[xa - e, ye, z1], [xb + e, ye, z1], [xb + e, Y, z1 + r], [xa - e, Y, z1 + r]], 'S', K.roofMat(-0.04, null, 'x', { noCap: true }));
  face([[xb + e, ye, z1], [xb + e, Y, z1], [xb + e, Y, z1 + r]], 'E', K.roofMat(0.18, null, 'y', { noCap: true }));
}
