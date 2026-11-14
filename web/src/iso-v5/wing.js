// The cross wing: a front-gabled block projecting from the main front (city v5). Contract: README.js.

/** Main block S = storeys(...) result ({ fl: [{ z, h, nS, nE }], z, x0, x1, y1 }) built from `floors`.
 * side 'W' | 'E': which end of the front; ww: wing width (world px). o = { R (main roof R), gable (the main
 * roof's gable material maker), pj (how far it projects south of S.y1; >= the main roof's eave + 1) }.
 * Clear the main front's fittings behind it (K.clearFits), build the wing's storeys and windows, and roof it
 * with K.roof2({ ridge: 'NS', gname: 'WG', ... }) running back into the main roof. Returns that roof info. */
export function wing(K, S, floors, side, ww, o) {
  const st = K.st, F0 = S.fl[0];
  // How far the main block's upper floors jetty out (south, and east with jetE), read off its ground walls,
  // so the wing's jetties line up with the main block's and its top floor lands exactly on its span.
  const jS = Math.max(0, S.y1 - (K.finfo[F0.nS]?.Y ?? S.y1)), jE = Math.max(0, S.x1 - (K.finfo[F0.nE]?.X ?? S.x1));
  const x0 = side === 'E' ? S.x1 - ww : S.x0, x1 = side === 'E' ? S.x1 : S.x0 + ww;
  const y1 = S.y1 + o.pj, yb = y1 - jS, y0 = S.y1 - jS - 3; // the side wall starts just inside the main block

  // the main front behind the wing loses its windows (and anything else hung there)
  for (const F of S.fl) K.clearFits(F.nS, x0 - 2, x1 + 2);

  const W = K.storeys({ x0, x1: x1 - jE, y0, y1: yb, floors, name: 'W', jetE: jE > 0, eaveS: false, eaveE: true });
  const vb = n => (st.h >>> n) % 2 === 1;
  W.fl.forEach((F, i) => K.winRow(F.nS, F.z + (i ? 4 : 6), { max: ww >= 30 ? 2 : 1, flowers: i > 0 || vb(24), ht: i ? 8 : 9 }));
  if (W.fl.length > 1 || vb(22)) W.fl.forEach((F, i) => K.winRow(F.nE, F.z + (i ? 4 : 6), { max: 1, wd: 5, ht: 7, pad: 4 }));

  const ym = ((S.y0 ?? 0) + S.y1) / 2; // the main ridge line: the wing's back runs into the main roof there
  const I = K.roof2({ x0, x1: W.x1, y0: ym, y1: W.y1, zb: W.z, R: Math.round(o.R * 0.9), e: 2.5, ridge: 'NS', gname: 'WG', gable: o.gable, jerk: st.jerk });

  // one small leaded window high in the wing's gable, below any half-hip
  const gi = K.finfo.WG;
  if (gi) {
    const top = W.z + (I.zr - W.z) * (1 - (st.jerk ?? 0)) - 4, z0 = W.z + 3, z1 = Math.min(W.z + 10, Math.floor(top));
    const c = gi.cols >> 1;
    if (z1 - z0 >= 4) K.fit({ face: 'WG', kind: 'win', c0: c - 2, c1: c + 2, z0, z1, flowers: false, shutters: false, lead: st.lead, cross: st.cross });
  }
  return I;
}
