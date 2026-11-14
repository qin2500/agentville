// Family 5: thatch. Cob and warm render, thick thatch with a scalloped ridge, rustic half-timbering, low
// and cosy, a round cob tower under a thatched cone on the palace. The hook contract is at the top of timber.js.
export default {
  id: 5, name: 'thatch',
  sys: {
    walls: ['#f1e0b8', '#ecc9a6', '#f0d3c0', '#e4c08e', '#f3e6c8', '#e8bfae', '#dfc79a'], dress: '#d6bf98', rubble: '#bfae92', civic: ['#e6d0aa', '#e3c3a6'],
    roofs: ['#b8914c', '#a98544', '#c9a45e', '#9c7c46', '#b5a060'], rk: 1.15, de: 2.4, mat: { tile: 'thatch', slate: 'thatch', shingle: 'thatch' },
    civRoof: '#9a5a3c', civMat: { slate: 'tile', shingle: 'tile', thatch: 'tile' },
    shutters: ['#5a7a4a', '#7a5a3a', '#4a6a7a', '#8a5a5a', '#6a7a8a'], trim: '#efe2c4', beam: '#6e4c34', doors: ['#6a4630', '#4a6a4a', '#7a4a2a', '#3e5a6a', '#7a3e34'], chim: '#b3a088',
  },
  window: 'small',
  halfTimber: true, jetties: true, dormers: true, gable: null, barge: null, thatchRidge: true,
  balconies: false, doorPots: true, flowerRoll: true, chapelSpire: true,
  house(st, look, it, K) {
    st.shutters = (K.h >>> 18) % 2 === 1; st.flowers = true;
    if (look === 'farmhouse') { st.lower = (K.h >>> 16) % 3 ? 'white' : 'logs'; if (st.lower === 'logs') st.paint = K.rgb('#a87447'); }
    if (look === 'timber') st.front = false;
  },
  wallTex: (t0, o, st, K) => ({ tex: t0 === 'logs' || t0 === 'ashlar' ? t0 : 'white', paint: K.paint }),
  chimney(c, st, K) { c.tall = true; c.rad = (c.rad || 3) * 1.15; if (K.rgb) c.B0 = K.rgb(((K.h || 0) >>> 5) % 2 ? '#b9a086' : '#a8927a'); },
  cottage: { hip: true, front: false, quoin: null },
  palace: {
    hip: true, balcony: 'stone', wood: true, towerPaint: 'dress',
    tower(K) { // a round cob tower under a tall thatched cone
      const { st, tx, ty, tr, tz } = K;
      K.roundTower('white', st.paint);
      K.prism('TR', tx, ty, tr + 4, 0, tz - 2, tz + 26, 12, K.coneMat(K.RB, 'thatch', tz - 2));
      return tz + 26;
    },
  },
  v5: { steep: 1.22, ivy: 8, climber: 'rose', lead: true, cross: false, crown: null, heavy: 'wood', halfHip: true, gables: null, cypress: false, pergola: false, loggia: false, ridgeTurret: false, turret: 'round', turretTex: 'white', turretRoof: 'thatch', crookedChimney: true, eyebrowDormer: true, roundDoor: true, moss: 0.2, lean: 1, hoist: false, winJitter: false },
};
