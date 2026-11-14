// Family 1: mediterranean. A storybook HILL-TOWN, not stucco suburbia: rough, sun-faded limewash in ochre, rose
// and sand (a different wash on every house), honey rubble stone breaking through on ground floors, dressed
// stone round the arched windows and heavy wooden doors, faded painted shutters, deep terracotta barrel tiles,
// and a tall campanile with an open belfry on the palace. The hook contract is documented at the top of timber.js.

// Per-house washes, mixed over the pool's wall colour so a project keeps its tint but no two houses match.
const WASH = ['#dba05e', '#d98e72', '#e3bf80', '#c9814e', '#e8cc98', '#cf8f78', '#dcae68', '#e2a878'];
// Roof tiles drift per house: sun-bleached, deep red, dark and old, a mossy olive cast.
const TILE = ['#cc6c3a', '#b4502c', '#9c4630', '#a8723e', '#c25e32'];
// Window and door surrounds in dressed stone (pale travertine to warm tufa).
const STONE = ['#d9c39a', '#cdb07f', '#e0cfaa'];
const SHUT = ['#4f7f9a', '#5f8a62', '#2f6f78', '#8a443a', '#7f9ab0', '#9a7a3a'];
const OAK = ['#5e3a22', '#6e4428', '#4e3324'];
const mx = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

export default {
  id: 1, name: 'mediterranean',
  sys: {
    walls: ['#dcb07a', '#d9a28a', '#e4c896', '#cf9466', '#e8d4ae', '#d4a68c'], dress: '#c8a676', rubble: '#b09a7c', civic: ['#e2c79c', '#d8b484', '#e0bc98'],
    roofs: ['#b85e36', '#a24f30', '#c06a3e', '#8e4a32'], rk: 0.68, de: 1.2, mat: { slate: 'tile', shingle: 'tile', thatch: 'tile' },
    shutters: ['#4f7f9a', '#5f8a62', '#2f6f78', '#8a443a', '#6f8fa8'], trim: '#d9c39a', beam: '#6a4428', wood: ['#6a4428', '#5a3a24', '#7a4c2c'],
    doors: ['#6a4026', '#5a3a24', '#7a4a2a', '#2f6f78'], chim: '#d6bc94',
  },
  window: 'arched',
  halfTimber: false, jetties: false, dormers: false, gable: null, barge: null, thatchRidge: false,
  balconies: false, doorPots: true, flowerRoll: true, chapelSpire: false,
  house(st, look, it, K) {
    const h = K.h, b = (n, m) => (h >>> n) % m;
    st.shutters = true; st.flowers = b(19, 3) === 0;
    // the wash: the pool's tint pulled toward this house's own ochre, rose or sand
    st.paint = mx(st.paint, K.rgb(WASH[b(11, WASH.length)]), 0.72);
    // the roof: a step of age per house (bleached, deep, dark, mossy)
    st.roofC = mx(st.roofC, K.rgb(TILE[b(14, TILE.length)]), 0.55);
    // dressed stone round the openings, not white trim
    st.trim = K.rgb(STONE[b(17, STONE.length)]);
    // painted shutters faded to their own shade; heavy doors mostly bare dark wood, sometimes painted
    st.shutter = mx(st.shutter, K.rgb(SHUT[b(27, SHUT.length)]), 0.5);
    st.doorC = b(29, 3) ? K.rgb(OAK[b(30, OAK.length)]) : mx(st.shutter, K.rgb('#4a3a2e'), 0.35);
    // round-headed windows mostly; some houses have small deep-set ones instead
    st.win = b(21, 3) === 0 ? 'small' : 'arched';
    if (look === 'farmhouse') st.lower = b(23, 2) ? 'white' : 'stone';
    if (look === 'timber' || look === 'townhouse') st.front = false;
  },
  // Limewash over rubble everywhere; ground floors break through to honey rubble on some houses and the
  // dressed ashlar plinths turn to rough coursed stone, so walls read as old masonry rather than siding.
  wallTex: (t0, o, st, K) => {
    const b = (n, m) => (st.h >>> n) % m;
    if (t0 === 'ashlar') return K.house && b(24, 3) ? { tex: 'stoneP', paint: K.paint } : { tex: 'ashlar', paint: K.paint };
    if (t0 === 'stone') return { tex: 'stoneP', paint: st.rubbleC };
    if (K.house && !K.up && (o.zb ?? 0) < 4 && b(26, 4) === 0) return { tex: 'stoneP', paint: mx(st.rubbleC, K.paint, 0.35) };
    // stone quoins up the corners of most washed walls (where the look hasn't chosen posts or quoins itself)
    if (!o.corner && b(28, 3)) return { tex: 'white', paint: K.paint, corner: 'quoin', quoinC: st.dressC };
    return { tex: 'white', paint: K.paint };
  },
  chimney(c, st, K) { // stubby, washed like the walls (a touch darker), never a tall brick stack
    c.tall = Math.min(c.tall, 4); c.rad = Math.max(c.rad, 3.2);
    c.B0 = K.dk(st.paint, 0.08);
  },
  cottage: { hip: true, front: false, quoin: 'dress' },
  palace: {
    hip: true, balcony: 'iron', wood: false, towerPaint: 'dress',
    tower(K) { // a campanile: a quoined shaft with a belfry, then an open lantern stage and a tiled pyramid
      const { tx, ty, tr, tz, TP, st } = K;
      K.sqTower('white', TP, { arch: true, bell: true });
      const hw = tr * 0.74, r0 = hw * Math.SQRT2, z0 = tz + 2.5, z1 = tz + 21;
      K.prism('TB', tx, ty, r0, r0, z0, z1, 4, (nm, N, cols) => {
        const c = cols >> 1;
        K.fit({ face: nm, kind: 'belfry', c0: c - 2, c1: c + 2, z0: z0 + 6, z1: z1 - 2, round: true, bell: false });
        return K.wm(nm, { tex: 'white', paint: TP, cols, zb: z0, shade: K.shOf(N), corner: 'quoin', quoinC: K.lt(st.dressC, 0.1) });
      });
      K.prism('TC', tx, ty, r0 + 1.1, r0 + 1.1, z1, z1 + 1.5, 4, (nm, N) => K.stoneM(K.lt(st.dressC, 0.08), K.shOf(N)));
      K.prism('TR', tx, ty, r0 + 2.4, 0, z1 + 1.5, z1 + 10, 4, K.coneMat(K.RB, 'tile', z1 + 1.5));
      K.ball(tx, ty, z1 + 11, 1, q => [K.byLight(K.ramp(K.lt(st.dressC, 0.1)), q.N, 0.1), 0]);
      return z1 + 12;
    },
  },
  v5: { steep: 1.15, ivy: 5, climber: 'bougainvillea', lead: false, cross: false, crown: 'stone', heavy: 'stone', halfHip: false, gables: null, cypress: true, pergola: true, loggia: true, ridgeTurret: false, turret: 'campanile', turretTex: 'white', turretRoof: 'tile', crookedChimney: false, eyebrowDormer: false, roundDoor: true, moss: 0.3, lean: 0, hoist: false, winJitter: true },
};
