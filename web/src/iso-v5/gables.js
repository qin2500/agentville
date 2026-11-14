// Ornamental canal gables (city v5): a parapet in front of a street gable. Contract: README.js.

const PALE = '#ece6da'; // the pale dressed stone of copings, scrolls and finials

/** A 'bell' or 'neck' gable parapet over the south gable of roof I (I.ridge 'NS': x0..x1 at y = I.y1, from
 * I.zb up to just above I.zr): brick (st.paint) with pale stone coping, scrolls at the shoulders and a finial.
 * Re-register finfo.G to the parapet face (named 'G') so gable windows land on it. Top <= I.zr + 8. */
export function fancyGable(K, I, type) {
  if (!I || I.ridge !== 'NS') return;
  const { st, s, rgb, lt, dk, mix, shOf, shade, byLight, ramp } = K;
  const bell = type !== 'neck';
  const { x0, x1, zb, zr } = I, xm = (x0 + x1) / 2, half = (x1 - x0) / 2, Rg = zr - zb, k = I.k || Rg / half;
  const Y = I.y1 + 0.8, TH = 2; // the parapet's front plane and its thickness (back to Y - TH)
  const stone = rgb(PALE), SR = ramp(stone);
  // The roof's own silhouette behind the parapet: half-width of the slope at height z. The outline must
  // always stay outside it, or the roof shows beside the parapet.
  const roofHw = z => (zr - z) / k, GAP = 1.5;

  // ---------- the outline: hw(z) on the right half, then mirrored ----------
  const hn = Math.max(5, Math.min(bell ? 6.5 : 7, Math.round(half * (bell ? 0.3 : 0.33) * 2) / 2)); // neck half-width
  const ztop = zr + (bell ? 7 : 8); // the parapet's crown (the finial rises above it)
  const ped = 3.5, zp = ztop - ped - 1.2; // neck: the pediment's height and the cornice under it
  const zt0 = bell ? ztop - hn : zp; // where the neck ends (bell: the centre of the crowning arc)
  const A = half - 1; // the curve starts just inside the shoulder ledge
  // bell: an S-curve (an ogee) from the shoulder to the neck; neck: a concave quarter-ellipse, the claw.
  const curve = u => bell ? hn + (A - hn) * (1 - u) * (1 - u) * (1 + 2 * u) : A - (A - hn) * Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
  // The curve may never come inside the roof line (by GAP). Search for the neck's foot zn (from a little
  // under the ridge upward) and the lowest shoulder zs that clears; take the first pair tall enough.
  const clears = (z0, z1) => { for (let i = 0; i <= 30; i++) { const u = i / 30; if (curve(u) < roofHw(z0 + u * (z1 - z0)) + GAP) return false; } return true; };
  let zn = Math.min(zt0 - 1, zr), zs = zn - 4, best = -1;
  for (let n1 = zr - (bell ? 1 : 3); n1 <= zt0 - 1; n1 += 0.5) {
    let s1 = zb + Math.round(Rg * 0.2);
    while (s1 < n1 - 4 && !clears(s1, n1)) s1 += 0.5;
    if (s1 >= n1 - 4) continue;
    if (n1 - s1 > best) { best = n1 - s1; zn = n1; zs = s1; }
    if (n1 - s1 >= Rg * (bell ? 0.6 : 0.42)) break;
  }
  const hw = (u, z) => Math.max(curve(u), roofHw(z) + GAP); // a last safety: never inside the roof line

  I.gab = { type: bell ? 'bell' : 'neck', zs, zn, hn, ztop }; // for callers placing gable windows: keep them inside hn - 3 above zn

  const R = [[half, zb], [half, zs - 1.6], [half + 1, zs - 1.6], [half + 1, zs], [A, zs]]; // [dx, z], bottom up
  const NC = 16;
  for (let i = 1; i <= NC; i++) { const u = i / NC, z = zs + u * (zn - zs); R.push([hw(u, z), z]); }
  if (bell) {
    R.push([hn, zt0]);
    for (let i = 1; i < 12; i++) { const a = (i / 12) * Math.PI / 2; R.push([hn * Math.cos(a), zt0 + hn * Math.sin(a)]); }
  } else {
    R.push([hn, zp], [hn + 1, zp], [hn + 1, zp + 1.2], [hn + 0.6, zp + 1.2]); // the neck, then a little cornice
  }
  const topPt = [0, ztop];
  const outline = [...R, topPt, ...R.slice().reverse().map(([d, z]) => [-d, z])]; // right half up, left half down
  const pts = outline.map(([d, z]) => [xm + d, Y, z]);

  // Copings run along every edge above the shoulder ledge (not the bottom, not the house corners below it).
  const segs = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    if (a[1] >= zs - 1.7 && b[1] >= zs - 1.7) segs.push([a[0] * s, a[1], b[0] * s, b[1]]);
  }
  const edgeDist = (x, z) => { // in screen-ish units (x scaled by s, z as is) to the nearest coped edge
    let m = 1e9;
    for (const [ax, az, bx, bz] of segs) {
      const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
      const ex = ax + t * dx - x, ez = az + t * dz - z, d = ex * ex + ez * ez;
      if (d < m) m = d;
    }
    return Math.sqrt(m);
  };

  // ---------- the parapet face, registered as G so gable windows paint onto it ----------
  const cols = Math.round((x1 - x0) * s);
  K.finfo.G = { dir: 'S', Y, x0, cols };
  const brick = K.wm('G', { tex: 'brickP', paint: st.paint, zb, cols, shade: 0 });
  const plain = K.wm('G~', { tex: 'brickP', paint: st.paint, zb, cols, shade: 0 }); // the same wall without fittings
  const mortarShadow = dk(st.paint, 0.28);
  K.face(pts, 'S', q => {
    const dx = q.P[0] - xm, z = q.z, ax = Math.abs(dx);
    if (z >= zs - 1.7) {
      const d = edgeDist(dx * s, z);
      if (d < 2.4) { const f = brick(q), p = plain(q); if (f[1] || f[0][0] !== p[0][0] || f[0][1] !== p[0][1] || f[0][2] !== p[0][2]) return f; } // a window wins
      if (d < 1.7) return [d < 0.7 ? lt(stone, 0.1) : stone, 0]; // the coping, lit on its outer arris
      if (d < 2.4) return [mortarShadow, 0]; // the shadow under the coping
    }
    if (ax > half - 0.2 && z >= zs - 1.6 && z < zs) return [z < zs - 1.0 ? dk(stone, 0.2) : stone, 0]; // the shoulder ledge
    if (z < zb + 1.6) return [z < zb + 0.6 ? dk(stone, 0.22) : mix(stone, rgb('#d8cfc0'), 0.4), 0]; // a stone string course
    if (!bell && z >= zp && z < zp + 1.2) return [z < zp + 0.5 ? dk(stone, 0.2) : stone, 0]; // the neck's cornice
    return brick(q);
  }, { col0: (x0 - Y) * s });

  // The parapet's thickness: each coped edge swept back by TH, pale stone lit by its own facing.
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    if (!(a[1] >= zs - 1.7 && b[1] >= zs - 1.7)) continue;
    const ddx = b[0] - a[0], ddz = b[1] - a[1];
    if (Math.hypot(ddx, ddz) < 1e-3) continue;
    let N = [ddz, 0, -ddx]; // perpendicular in the x-z plane, then turned outward
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2 - (zs + ztop) / 2;
    if (N[0] * mx + N[2] * mz < 0) N = N.map(v => -v);
    const sh = shOf(N), c = shade(stone, sh);
    const A3 = [xm + a[0], Y, a[1]], B3 = [xm + b[0], Y, b[1]];
    K.face([A3, B3, [B3[0], Y - TH, B3[2]], [A3[0], Y - TH, A3[2]]], Math.abs(N[0]) > Math.abs(N[2]) ? 'E' : 'S', () => [c, 0]);
  }

  // ---------- ornament: scroll volutes, knobs and the finial ----------
  // A scroll seen end-on: a pale stone ball with a spiral groove curling toward the gable's middle.
  const volute = (cx, cz, r, side) => {
    const cy = Y + 0.2;
    K.ball(cx, cy, cz, r, q => {
      const c = byLight(SR, q.N, 0.12), ex = (q.P[0] - cx) * side, ez = q.P[2] - cz, rr = Math.hypot(ex, ez) / r;
      if (q.N[1] > 0.15 && rr > 0.3) { const a = Math.atan2(ez, ex) / (2 * Math.PI); if ((((rr * 1.7 - a) % 1) + 1) % 1 < 0.3) return [dk(c, 0.3), 0]; }
      return [c, 0];
    });
  };
  const knob = (cx, cz, r) => K.ball(cx, Y - 0.4, cz, r, q => [byLight(SR, q.N, 0.12), 0]);
  for (const side of [-1, 1]) {
    const sx = xm + side * (half - 0.4);
    volute(sx, zs + 2.3, 2.4, -side); // the big scroll on the shoulder ledge, curling inward
    knob(xm + side * (half + 0.4), zs - 0.6, 0.7); // the ledge's end
    if (bell) {
      const u = 0.5, z = zs + u * (zn - zs), d = hw(u, z);
      volute(xm + side * (d + 0.4), z, 1.7, -side); // a smaller scroll where the ogee turns
      knob(xm + side * hn, zn + 0.4, 0.8); // the neck's foot
    } else {
      volute(xm + side * (hn + 0.8), zn + 1.3, 1.8, side); // the claw's tip, curling outward
      knob(xm + side * (hn + 1), zp + 1.8, 0.8); // the cornice's ends
    }
  }
  if (bell) { // a stone ball on a short drum over the arc
    K.cyl(xm, Y - 1, 0.8, ztop - 0.5, ztop + 1.8, q => [q.cap ? lt(stone, 0.12) : byLight(SR, q.N, 0.12), 0]);
    K.ball(xm, Y - 1, ztop + 3.4, 1.8, q => [byLight(SR, q.N, 0.12), 0]);
  } else { // a little obelisk on the pediment, tipped with a ball
    K.prism('GF', xm, Y - 1, 1.2, 0.35, ztop - 0.6, ztop + 4.2, 4, (nm, N) => { const sh = shOf(N); return () => [shade(stone, sh), 0]; }, 0);
    K.ball(xm, Y - 1, ztop + 5.2, 1.1, q => [byLight(SR, q.N, 0.12), 0]);
  }
}
