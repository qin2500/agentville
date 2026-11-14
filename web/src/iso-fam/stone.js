// Family 2: stone. Grey-blue fieldstone, dark slate, steep roofs, small deep-set windows, coped gables,
// big chimneys, a round keep on the palace. The hook contract is documented at the top of timber.js.
export default {
  id: 2, name: 'stone',
  sys: {
    walls: ['#b8a47e', '#a89f8e', '#c2ad84', '#9d9686', '#b5a98f'], dress: '#d2c49e', rubble: '#968d7c', civic: ['#b0a68e', '#a29a88'],
    roofs: ['#4b5a4c', '#46505a', '#55604c', '#3f4a52'], rk: 1.3, de: -0.4, mat: { tile: 'slate', shingle: 'slate', thatch: 'slate' },
    shutters: ['#3a2e22', '#4a3626'], trim: '#d8cba8', beam: '#3a2e22', doors: ['#4a3322', '#3a2a1e', '#2f3a30'], chim: '#a8987a',
  },
  window: 'small',
  halfTimber: false, jetties: false, dormers: true, gable: 'coped', barge: null, thatchRidge: false,
  balconies: false, doorPots: false, flowerRoll: false, chapelSpire: true,
  house(st, look) {
    st.shutters = false; st.flowers = false;
    if (look === 'farmhouse') st.lower = 'stoneP';
    if (look === 'timber') st.front = false;
  },
  wallTex: (t0, o, st, K) => ({ tex: t0 === 'ashlar' || !K.house ? 'ashlar' : 'stoneP', paint: K.paint }),
  chimney(c) { c.rad += 1; c.tall += 5; }, // tall stacked stone
  cottage: { hip: false, front: false, quoin: 'dress' },
  palace: {
    hip: false, balcony: 'stone', wood: false, towerPaint: 'dress',
    tower(K) { // a round keep: a corbelled ring, a conical slate roof
      const { st, tx, ty, tr, tz, lt, dk, shade, shOf, SHADE } = K;
      K.roundTower('stone', st.paint);
      K.cyl(tx, ty, tr + 1.4, tz - 4, tz, q => { if (q.cap) return [lt(st.paint, 0.1), 0]; const zi = Math.floor(q.z), u2 = q.ang * 2 * Math.PI * (tr + 1.4); return [shade(zi === tz - 4 && Math.floor(u2) % 4 < 2 ? dk(SHADE, 0.1) : zi === tz - 1 ? lt(st.paint, 0.18) : st.paint, Math.round(shOf(q.N) / 0.06) * 0.06), 0]; });
      K.prism('TR', tx, ty, tr + 3, 0, tz, tz + 30, 12, K.coneMat(K.RB, 'slate', tz));
      return tz + 30;
    },
  },
  v5: { steep: 1.2, ivy: 8, climber: null, lead: true, cross: false, crown: 'stone', heavy: 'stone', halfHip: false, gables: null, cypress: false, pergola: false, loggia: false, ridgeTurret: false, turret: 'round', turretTex: 'stone', turretRoof: 'slate', crookedChimney: false, eyebrowDormer: false, roundDoor: true, moss: 0.3, lean: 0, hoist: false, winJitter: false },
};
