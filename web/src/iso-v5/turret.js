// Corner turrets and ridge turrets (city v5). Contract: README.js. Shape from K.V.turret / turretTex / turretRoof.
//
// octagon   : an eight-sided turret, corner posts (timber, or dressed stone on heavy-stone families), small
//             leaded windows on its south and south-east faces, a flared skirt and a tall witch-hat spire.
// campanile : a square bell tower with quoins, a belfry with its bell, a cornice and a low pyramid roof.
// round     : a round tower with windows and an arrow loop, a corbelled ring at the top, a flared cone.
// A turret starting above the ground (T.z0 > 0) sits on stepped corbel courses that end in a point,
// carved timber on wood-heavy families, stone otherwise.

const SQ2 = Math.SQRT2;

// The turret roof: the family's own material (K.V.turretRoof) or the house roof, with a fitting base colour.
function roofOf(K) {
  const mat = K.V.turretRoof ?? K.st.roof, m = K.mm(mat), own = K.mm(K.st.roof);
  let base = K.V.turretRoof ? K.RB : K.dk(K.RB, 0.14); // the house's own roof: a step darker so the spire reads against it
  if (m === 'lead') base = K.mix(K.LEAD, K.RB, 0.15);
  else if (m === 'slate' && own !== 'slate') base = K.mix(K.RB, K.rgb('#4a5670'), 0.6);
  else if (m === 'thatch' && own !== 'thatch') base = K.mix(K.rgb('#d2aa5e'), K.RB, 0.1);
  else if (m === 'tile' && own !== 'tile') base = K.mix(K.RB, K.rgb('#b0603c'), 0.35);
  return { mat, base };
}

// Corbel courses under a turret that starts at z0: three steps drawing in, then a point (n-sided, so the same
// helper makes round, octagonal and square corbels; rf scales radius to the corner for a square).
function corbel(K, name, cx, cy, r, z0, n, rot, rf) {
  const wood = K.V.heavy === 'wood', dress = K.st.dressC ?? K.STONE, WD = K.st.beam ?? K.DARKWOOD;
  const room = Math.max(4, z0 - 1), sc = Math.min(1, room / (5.4 + r * 0.9));
  const mk = k => (nm, N) => {
    const sh = K.shOf(N);
    if (wood) return q => { const zi = Math.floor(q.z), c = q.col % 3 === 0 ? K.dk(WD, 0.25) : (zi + k) % 2 ? WD : K.lt(WD, 0.12); return [K.shade(c, sh), 0]; };
    return K.stoneM(K.lt(dress, 0.04 * k), sh);
  };
  let z = z0;
  const steps = [[r + 0.4, 1.8], [r - 0.7, 1.8], [r - 1.8, 1.8]];
  steps.forEach(([rr, hh], k) => {
    const h = hh * sc;
    K.prism(`${name}${k}`, cx, cy, rr * rf, rr * rf, z - h, z, n, mk(k), rot);
    z -= h;
  });
  const tip = Math.max(1.5, (r - 1.8) * 0.9 * sc + 1.5);
  K.prism(`${name}p`, cx, cy, 0.5 * rf, (r - 1.8) * rf, z - tip, z, n, mk(3), rot);
}

// Small window levels up a wall from zb to zt, hung from the top down (the part of a corner turret that stands
// clear of the house is its top): [z0, z1] pairs, ht px tall, every `step` px, none below the plinth.
function levels(zb, zt, ground, ht = 6, step = 13) {
  const out = [];
  for (let z1 = zt - 5; z1 - ht + 1 >= zb + (ground ? 7 : 3); z1 -= step) out.unshift([z1 - ht + 1, z1]);
  return out;
}

function octagon(K, cx, cy, T, R) {
  const { r, z0, zt, cone } = T, rot = Math.PI / 8, tex = K.V.turretTex ?? 'plaster', paint = K.st.paint;
  const stoneP = K.V.heavy === 'stone', post = stoneP ? K.lt(K.st.dressC ?? K.STONE, 0.12) : (K.st.beam ?? K.BEAM);
  const wins = levels(z0, zt, z0 === 0);
  const inWin = zi => wins.some(([a, b]) => zi >= a - 1 && zi <= b + 1);
  K.prism('Tw', cx, cy, r, r, z0, zt, 8, (nm, N, cols) => {
    const m = K.wm(nm, { tex, paint, cols, zb: z0, zt, foot: z0 === 0, eave: 3, shade: K.shOf(N), keep: true });
    // a corner post at each angle: the left column of each face (the right one is the next face's left)
    return q => { const zi = Math.floor(q.z); if (q.col <= 0 && zi >= z0 + (z0 === 0 ? 4 : 0) && !(nm === 'Tw1' && inWin(zi))) return [K.shade(post, K.shOf(N) * 0.6), 0]; return m(q); };
  }, rot);
  const lead = K.st.lead ?? true;
  for (const [a, b] of wins) K.fit({ face: 'Tw0', kind: 'win', c0: 1, c1: 3, z0: a, z1: b, lead, flowers: false, shutters: false, deep: true },
    { face: 'Tw1', kind: 'win', c0: 0, c1: 2, z0: a + 1, z1: b - 1, lead, flowers: false, shutters: false });
  if (z0 > 0) corbel(K, 'Tc', cx, cy, r, z0, 8, rot, 1);
  // the eaves: a moulded band, a flared skirt, then the tall spire, a ball and the vane
  K.prism('Tk', cx, cy, r + 0.6, r + 0.6, zt - 1.2, zt, 8, (nm, N) => q => [K.shade(Math.floor(q.z) === Math.floor(zt - 1) ? K.TR[3] : K.TR[1], K.shOf(N)), 0], rot);
  const { mat, base } = R, zs = zt + 1.6;
  K.prism('Tf', cx, cy, r + 2.1, r + 0.5, zt, zs, 8, K.coneMat(base, mat, zt), rot);
  K.prism('Tr', cx, cy, r + 0.5, 0, zs, zt + cone, 8, K.coneMat(base, mat, zt), rot);
  const ap = zt + cone;
  K.ball(cx, cy, ap + 0.6, 0.9, q => [K.byLight(K.ramp(K.GOLD), q.N, 0.1), 0]);
  return ap + 1.5;
}

function campanile(K, cx, cy, T, R) {
  const { r, z0, zt, cone } = T, tex = K.V.turretTex ?? 'plaster', paint = K.st.paint, qc = K.st.dressC ?? K.lt(paint, 0.12);
  const o = { tex, paint, foot: z0 === 0, corner: 'quoin', quoinC: qc, keep: true, belts: [zt - 15] };
  const cols = K.wallS('TwS', cx - r, cx + r, cy + r, z0, zt, o);
  K.wallE('TwE', cx + r, cy - r, cy + r, z0, zt, o);
  const c = cols >> 1, arch = K.st.win === 'arched', bw = Math.max(2, Math.min(3, (cols >> 1) - 2));
  for (const nm of ['TwS', 'TwE']) {
    K.fit({ face: nm, kind: 'belfry', c0: c - bw, c1: c + bw - 1, z0: zt - 13, z1: zt - 3, round: true, bell: true });
    for (const [a, b] of levels(z0, zt - 16, z0 === 0, 6, 14)) K.fit({ face: nm, kind: 'win', c0: c - 1, c1: c + 1, z0: a, z1: b, arch, lead: K.st.lead, flowers: false, shutters: false, deep: true });
  }
  if (z0 > 0) corbel(K, 'Tc', cx, cy, r, z0, 4, Math.PI / 4, SQ2);
  // the cornice, then a low pyramid roof
  const CC = K.lt(qc, 0.08), zc = zt + 1.5;
  K.box(cx - r - 0.9, cx + r + 0.9, cy - r - 0.9, cy + r + 0.9, zt, zc, K.stoneM(CC, 0), K.stoneM(CC, 0.3), K.capM(CC));
  K.prism('TwR', cx, cy, (r + 1.8) * SQ2, 0, zc, zc + cone, 4, K.coneMat(R.base, R.mat, zc), Math.PI / 4);
  const ap = zc + cone;
  K.ball(cx, cy, ap + 0.3, 0.6, q => [K.byLight(K.ramp(K.GOLD), q.N, 0.1), 0]);
  return Math.min(ap + 0.9, zt + 2.5 + cone);
}

function round(K, cx, cy, T, R) {
  const { r, z0, zt, cone } = T, tex = K.V.turretTex === 'stone' || K.V.turretTex === 'brickP' ? 'stone' : 'white', paint = K.st.paint;
  const ops = [];
  levels(z0, zt - 3, z0 === 0, 6, 13).forEach(([a, b], i) => { ops.push(K.winOp(i & 1 ? 0.12 : 0.25, a, b)); });
  if (zt - z0 > 16) ops.push(K.slitOp(0.04, z0 + 6, z0 + 11));
  K.cyl(cx, cy, r, z0, zt - 3, K.roundWall(r, paint, ops, tex));
  if (z0 > 0) corbel(K, 'Tc', cx, cy, r, z0, 12, Math.PI / 12, 1);
  // the corbelled ring: a projecting course on little brackets (dark gaps between them), a lit top band
  const rr = r + 1.2, RC = tex === 'white' ? K.lt(paint, 0.04) : paint;
  K.cyl(cx, cy, rr, zt - 3, zt, q => {
    if (q.cap) return [K.lt(RC, 0.1), 0];
    const zi = Math.floor(q.z), u = Math.floor(q.ang * 2 * Math.PI * rr + 600);
    const c = zi <= Math.floor(zt - 3) ? (u % 3 === 0 ? K.dk(K.SHADE, 0.1) : K.dk(RC, 0.12)) : zi >= Math.floor(zt - 1) ? K.lt(RC, 0.16) : RC;
    return [K.shade(c, Math.round(K.shOf(q.N) / 0.06) * 0.06), 0];
  });
  const zs = zt + 1.4;
  K.prism('Tf', cx, cy, rr + 1.3, rr - 0.4, zt, zs, 12, K.coneMat(R.base, R.mat, zt));
  K.prism('Tr', cx, cy, rr - 0.4, 0, zs, zt + cone, 12, K.coneMat(R.base, R.mat, zt));
  const ap = zt + cone;
  K.ball(cx, cy, ap + 0.6, 0.9, q => [K.byLight(K.ramp(K.GOLD), q.N, 0.1), 0]);
  return ap + 1.5;
}

/** A corner turret centred at (cx, cy): T = st.tur = { r, z0 (0 = from the ground, > 0 = corbelled out from
 * that height), zt (wall top), cone (roof height) }. Apex must stay <= T.zt + 2.5 + T.cone. Sets K.out.vane. */
export function turret(K, cx, cy, T) {
  const kind = K.V.turret ?? 'octagon', R = roofOf(K);
  const draw = kind === 'campanile' ? campanile : kind === 'round' ? round : octagon;
  const ap = Math.min(draw(K, cx, cy, T, R), T.zt + 2.5 + T.cone);
  K.out.vane = K.Q(cx, cy, ap);
}

/** A small bell turret astride the ridge of roof I (I.ridge 'EW'|'NS', I.zr, I.ym|I.xm, I.x0..x1, I.y0..y1).
 * Apex must stay <= I.zr + 24. Sets K.out.vane. */
export function ridgeTurret(K, I) {
  const ew = I.ridge !== 'NS', a = 3.5, zr = I.zr, k = I.k ?? 1;
  // on the ridge, a little off centre (away from the gable end most chimneys sit by)
  const cx = ew ? (I.xa != null && I.xb != null ? (I.xa + I.xb) / 2 : I.x0 + (I.x1 - I.x0) * 0.45) : I.xm;
  const cy = ew ? I.ym : I.y0 + (I.y1 - I.y0) * 0.45;
  const zb = zr - a * k - 1, zh = zr + 7, WD = K.st.wood ?? K.WOOD;
  // the louvred box (its foot dips into the roof on both slopes)
  const o = { tex: 'planks', paint: K.mix(WD, K.DARKWOOD, 0.35), keep: true, eave: 2 };
  const cs = K.wallS('RtS', cx - a, cx + a, cy + a, zb, zh, o);
  const ce = K.wallE('RtE', cx + a, cy - a, cy + a, zb, zh, o);
  K.fit({ face: 'RtS', kind: 'louvre', c0: 1, c1: Math.max(2, cs - 2), z0: zr + 1, z1: zh - 2 }, { face: 'RtE', kind: 'louvre', c0: 1, c1: Math.max(2, ce - 2), z0: zr + 1, z1: zh - 2 });
  // a little eave board, then the cap
  const TB = K.lt(K.st.trim ?? WD, 0.05);
  K.box(cx - a - 0.8, cx + a + 0.8, cy - a - 0.8, cy + a + 0.8, zh, zh + 1, K.flat(TB), K.flat(K.dk(TB, 0.3)), K.flat(K.lt(TB, 0.15)));
  const z1 = zh + 1, CU = K.rgb('#5f9c86'), onion = K.h2(K.st.h ?? 0, 0x0b, 7) % 3 !== 0;
  const cuM = K.coneMat(CU, 'lead', z1);
  // the cap as a stack of eight-sided frusta along a profile [radius, height above z1]
  const lathe = (nm, prof, mk = cuM) => { for (let i = 0; i < prof.length - 1; i++) K.prism(`${nm}${i}_`, cx, cy, prof[i][0], prof[i + 1][0], z1 + prof[i][1], z1 + prof[i + 1][1], 8, mk); };
  if (onion) { // a copper onion on a short dark drum, drawn up into a spike
    lathe('Rtd', [[a * 0.75, 0], [a * 0.75, 1.2]], (nm, N) => q => [K.shade(K.DARKWOOD, K.shOf(N)), 0]);
    lathe('Rto', [[a * 0.6, 1.2], [a * 1.0, 2.4], [a * 1.2, 3.4]]); // the bulb's underside
    K.ball(cx, cy, z1 + 3.4, a * 1.2, q => { const c = K.byLight(K.ramp(CU), q.N, 0.1); return [Math.floor(q.ang * 16) % 2 ? K.dk(c, 0.07) : c, 0]; });
    lathe('Rts', [[a * 0.32, 6.6], [a * 0.2, 8], [0, 11.5]]); // drawn up into a spike
  } else { // a bell cap: a flared copper skirt, a waist, a small bulb and a spike
    lathe('Rtb', [[a + 1.4, 0], [a * 0.65, 2.2], [a * 0.65, 3.4], [a * 0.85, 4.6], [a * 0.45, 6.4], [a * 0.22, 7.4], [0, 11]]);
  }
  let ap = z1 + (onion ? 11.5 : 11);
  K.ball(cx, cy, ap + 0.4, 0.7, q => [K.byLight(K.ramp(K.GOLD), q.N, 0.1), 0]);
  ap = Math.min(ap + 1.1, zr + 24);
  K.out.vane = K.Q(cx, cy, ap);
}
