// Family 3: alpine. White ground floor, dark timber above with a carved balcony, wide low roofs with deep
// eaves, carved barge boards, an onion-domed tower on the palace. The hook contract is at the top of timber.js.
export default {
  id: 3, name: 'alpine',
  sys: {
    walls: ['#ece4d2', '#e6dcc6', '#e2d6bd', '#eadfca'], wood: ['#4a3022', '#3e281c', '#553726', '#47301f'], dress: '#d9cfba', rubble: '#9a9080', civic: ['#e8dfca', '#e0d4b8'],
    roofs: ['#4a3b32', '#52453a', '#5a4030', '#463e3a', '#5e4a3a'], rk: 0.54, de: 4, mat: { tile: 'shingle', slate: 'shingle', thatch: 'shingle' },
    shutters: ['#3a6e48', '#a03e38', '#2c6258', '#b0803a', '#3a5a86'], trim: '#6a4228', beam: '#3e281c', doors: ['#4a3022', '#3a6e48', '#7a3028', '#2c4a6a'], chim: '#c9bfae',
  },
  window: 'square',
  halfTimber: false, jetties: true, dormers: true, gable: null, barge: 'carved', thatchRidge: false,
  balconies: true, doorPots: true, flowerRoll: true, chapelSpire: true,
  house(st, look, it, K) {
    if (K.P && K.hx(K.P.wall?.alt)) st.wood = K.hx(K.P.wall.alt).reduce((a, b) => a + b) < 360 ? K.hx(K.P.wall.alt) : st.wood;
    st.shutters = true; st.flowers = true;
    if (look === 'farmhouse') { st.lower = 'logs'; st.paint = st.wood; }
    if (look === 'timber' || look === 'townhouse') st.front = true;
  },
  townPitch: 0.85,
  wallTex: (t0, o, st, K) => (K.house && K.up ? { tex: 'planks', paint: st.wood } : { tex: t0 !== 'logs' ? 'white' : t0, paint: K.paint }),
  chimney() {},
  cottage: { hip: false, front: true, quoin: null },
  palace: {
    hip: false, balcony: 'run', wood: true, towerPaint: 'dress',
    tower(K) { // a white tower with a copper onion dome
      const { tx, ty, tr, tz, rgb, dk, shade, shOf, byLight, ramp, DARKWOOD } = K;
      K.sqTower('plaster', K.TP, {});
      const CU = rgb('#5f9c86'), zo = tz + 2.5;
      K.prism('TN', tx, ty, tr * 0.55, tr * 0.55, zo, zo + 3, 8, (nm, N) => q => [shade(DARKWOOD, shOf(N)), 0]);
      K.ball(tx, ty, zo + 3 + tr * 0.8, tr * 0.9, q => { const c = byLight(ramp(CU), q.N, 0.1); return [Math.floor(q.ang * 16) % 2 ? dk(c, 0.06) : c, 0]; });
      K.prism('TO', tx, ty, tr * 0.45, 0, zo + 3 + tr * 1.45, zo + 3 + tr * 1.45 + 9, 8, K.coneMat(CU, 'lead', zo + 3 + tr * 1.45));
      return zo + 12 + tr * 1.45;
    },
  },
  v5: { steep: 1.3, ivy: 3, climber: 'yellow?', lead: true, cross: false, crown: 'paint', heavy: 'wood', halfHip: true, gables: null, cypress: false, pergola: false, loggia: false, ridgeTurret: true, turret: 'octagon', turretTex: 'white', turretRoof: 'lead', crookedChimney: false, eyebrowDormer: false, roundDoor: false, moss: 1, lean: 0, hoist: false, winJitter: true },
};
