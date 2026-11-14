// Family 4: canal. A fantasy merchant city: tall narrow brick houses gable-end to the street with crow-stepped,
// bell and neck gables, pale stone bands and window heads, dark painted timber (deep green, oxblood, black),
// small leaded cross windows, slate and dark-tile roofs, and a brick tower with an open lantern on the palace.
// Every house takes its own brick, roof slate, trim paint and window from its hash so no two neighbours match.
// The hook contract is documented at the top of timber.js.
const mixH = (a, b, k) => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * k);
// warm, varied brick: red, orange, plum-brown, dark burnt, honey; a step apart so a terrace reads as many houses
const BRICKS = ['#a4553d', '#c27a4c', '#713a34', '#93503a', '#b98a5c', '#86434a', '#a96149', '#5e3530', '#9a6a4e'];
// slate blue-greys and dark glazed tile
const SLATES = ['#474a57', '#3c4150', '#55525e', '#4f4540', '#3f4a4c', '#5b4a42'];
// window frames and timber: mostly cream, but a third of the houses wear their paint dark
const TRIMS = ['#ebe1cb', '#e6dcc4', '#ebe1cb', '#26392f', '#5a2626', '#2b2a2c', '#e2d6bc', '#2c4034'];
const DOORS = ['#24382c', '#5a2424', '#1f1d1f', '#2c4a3a', '#4a1f22', '#2a2f36'];
const WINS = ['tall', 'square', 'small', 'tall', 'small', 'square'];
export default {
  id: 4, name: 'canal',
  sys: {
    walls: ['#a4553d', '#93503a', '#b86a45', '#7f4236'], dress: '#d9ccb0', rubble: '#9c5040', civic: ['#a4553d', '#93503a', '#8c4a44'],
    roofs: ['#474a57', '#3c4150', '#5b4a42'], rk: 1.3, de: -1, mat: { shingle: 'slate', thatch: 'tile', tile: 'tile', slate: 'slate' },
    shutters: ['#26392f', '#5a2626', '#2b2a2c'], trim: '#ebe1cb', beam: '#2b2826', doors: ['#26392f', '#5a2626', '#1f1e20', '#2f4a3c'], chim: '#7f4236',
  },
  townPitch: 1.05,
  window: 'tall',
  halfTimber: false, jetties: false, dormers: true, gable: 'crow', barge: null, thatchRidge: false,
  balconies: false, doorPots: false, flowerRoll: true, chapelSpire: true,
  house(st, look, it, K) {
    const h = K.h, b = (n, m) => ((h >>> n) ^ (h >>> (n + 11))) % m;
    // brick: the project's own brick nudged toward one of the family's, so houses differ a clear step
    const own = K.walls ? K.walls[(h >>> 3) % K.walls.length] : st.paint;
    st.paint = mixH(own, K.rgb(BRICKS[b(1, BRICKS.length)]), K.walls ? 0.75 : 0.85);
    // roofs: slate and dark tile, never the project's flat brown everywhere
    if (st.roofC) st.roofC = mixH(st.roofC, K.rgb(SLATES[b(4, SLATES.length)]), 0.7);
    st.trim = K.rgb(TRIMS[b(7, TRIMS.length)]);
    st.beam = K.rgb(['#2b2826', '#26392f', '#4a2a24'][b(10, 3)]);
    st.win = WINS[b(13, WINS.length)];
    // dark painted doors and shutters: deep green, oxblood, black; shutters often match the door
    const dc = DOORS[b(25, DOORS.length)];
    st.doorC = K.rgb(dc); st.shutter = K.rgb(b(28, 3) ? dc : DOORS[b(5, DOORS.length)]);
    st.shutters = b(16, 3) === 0; st.flowers = b(18, 4) === 0;
    st.lowStone = b(20, 3) === 0; // a pale stone ground floor (read by wallTex)
    if (look === 'farmhouse') st.lower = 'brickP';
    if (look === 'timber' || look === 'townhouse') st.front = true; // gable to the street, always
    if (look === 'townhouse' && b(22, 4) === 0) { st.n = 2; st.H = 30; } // a lower neighbour breaks the terrace line
  },
  wallTex: (t0, o, st, K) => {
    if (K.house && !K.up && st.lowStone && (t0 === 'ashlar' || t0 === 'stone')) return { tex: 'ashlar', paint: st.dressC };
    return { tex: 'brickP', paint: K.paint === st.dressC || K.paint === K.LIME ? st.paint : K.paint };
  },
  chimney(c, st, K) { c.B0 = K.dk(st.paint, 0.12); c.tall += (st.h >>> 24) % 3 * 3; }, // brick, a touch darker, some tall
  cottage: { hip: false, front: true, quoin: '#d9ccb0' },
  palace: {
    hip: false, balcony: 'stone', wood: false, towerPaint: 'wall',
    tower(K) { // a brick tower, an open octagonal lantern, a tall lead spire
      const { tx, ty, tr, tz, rgb, dk, shade, shOf, SHADE, LEAD } = K;
      K.sqTower('plaster', K.TP, { quoin: '#d9ccb0', brick: true });
      K.prism('TL', tx, ty, tr * 0.7, tr * 0.7, tz + 2.5, tz + 11, 8, (nm, N) => { const sh = shOf(N); return q => { const zi = Math.floor(q.z); return [shade(zi > tz + 4 && zi < tz + 10 && q.col % 4 !== 0 ? dk(SHADE, 0.05) : rgb('#d9ccb0'), sh), 0]; }; });
      K.prism('TR', tx, ty, tr * 0.85, 0, tz + 11, tz + 38, 8, K.coneMat(LEAD, 'lead', tz + 11));
      return tz + 38;
    },
  },
  v5: { steep: 1.12, ivy: 3, climber: null, lead: true, cross: true, crown: 'stone', heavy: 'stone', halfHip: false, gables: ['crow', 'bell', 'crow', 'neck', 'crow'], cypress: false, pergola: false, loggia: false, ridgeTurret: false, turret: 'octagon', turretTex: 'brickP', turretRoof: 'lead', crookedChimney: false, eyebrowDormer: false, roundDoor: false, moss: 0.3, lean: 1, hoist: true, winJitter: true },
};
