// Isometric buildings (the 2.5D view), in a cozy farm-sim pixel-art style (original art, drawn in code).
//
// Each building is modelled as flat faces (walls, gable ends, roof planes, chimney, porch, steps), round
// solids (barrels, pots, bushes, a dome) and a soft ground shadow, then rasterised pixel by pixel with a
// depth buffer: every screen pixel is a ray toward the viewer, the nearest surface wins, and that
// surface's material paints the pixel. Materials work in screen space (2:1 rows, whole-pixel columns), so
// clapboards, shingle courses, mortar and window frames land on exact pixels: crisp at every integer zoom.
//
// Colour: every material is a 5-tone ramp with hue shifting: shadows lean toward indigo, highlights
// toward warm yellow. Light comes from the front left (south-west, above): south faces are lit, east
// faces in half shade, and shadows fall east. Silhouettes get a 1px dark outline tinted by what it
// outlines (never flat black); a nearer face over a farther one gets a softer line.
//
// Each look is drawn once and cached: no per-frame cost beyond one drawImage.
//
// Coordinates: x, y are world px across the footprint (x0..x1 east, y0..y1 south); z is height in view
// px. View px are isoP(x, y) with z subtracted. A pixel's ray is ground point + t·(1, 1, ISO): larger t
// is nearer the viewer.
import { ISO, hash } from './world.js';

// ---------- colour ----------
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const SHADE = rgb('#2a1c4a'), WARM = rgb('#fff0b0'), OUTLINE = rgb('#1d1233');
const dk = (c, k) => mix(c, SHADE, k), lt = (c, k) => mix(c, WARM, k); // hue-shifted: dark → indigo, light → warm yellow
const jit = (c, n) => (n > 0 ? lt(c, n) : dk(c, -n));
/** A 5-tone ramp: [deep shadow, shadow, base, light, highlight]. */
const ramp = c => [dk(c, 0.5), dk(c, 0.25), c, lt(c, 0.2), lt(c, 0.42)];
const h2 = (a, b, seed = 0) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(seed | 0, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
const L = (() => { const v = [-0.55, 0.62, 0.56], n = Math.hypot(...v); return v.map(a => a / n); })(); // toward the light

const GLASS = ramp(rgb('#3d5687')), LIT = [rgb('#c9702c'), rgb('#f0a346'), rgb('#ffcd68'), rgb('#ffe7a0'), rgb('#fff8dc')];
const GOLD = rgb('#e9b949'), STONE = rgb('#a39a8c'), SOIL = rgb('#7a5236'), LEAF = rgb('#5b9a3c'), POT = rgb('#c46a42');
const WOOD = rgb('#9a6a40'), DARKWOOD = rgb('#6a4630'), BEAM = rgb('#6b4429');
const FLOWERS = [rgb('#ec5f74'), rgb('#f5cf4f'), rgb('#ef93cc'), rgb('#fbf6ea'), rgb('#9f7ff0')];

// Painted colour schemes, picked per building from its id: wall paint, trim, shutters and door.
const PAINT = {
  honey: rgb('#cf9d61'), sage: rgb('#93b088'), butter: rgb('#e9cc84'), sky: rgb('#8eabc2'), rose: rgb('#d9a08e'),
  cream: rgb('#ecdfc2'), barn: rgb('#b75a42'), mint: rgb('#a9cdb3'), lilac: rgb('#b9a6cc'),
};
const SCHEMES = [ // [wall, trim, shutters, door]
  ['honey', '#f3e7cd', '#4f7d4a', '#7a4a2a'], ['sage', '#f3e7cd', '#a8443c', '#6b4a8a'], ['butter', '#6a4630', '#3f6f8f', '#3f6f8f'],
  ['sky', '#f6efdf', '#c7623e', '#c7623e'], ['rose', '#f6efdf', '#46705f', '#46705f'], ['cream', '#6a4630', '#8a3f3f', '#8a3f3f'],
  ['barn', '#f3e7cd', '#3d5f78', '#3d5f78'], ['mint', '#f6efdf', '#b5683a', '#7a4a2a'], ['lilac', '#f6efdf', '#557a48', '#d1a447'],
];

// The archetypes: wall height H, roof rise R, eave overhang e.
const ARCH = {
  lodge: { H: 34, R: 22, e: 4 }, twostorey: { H: 30, R: 16, e: 3 }, cottage: { H: 21, R: 15, e: 3 },
  hut: { H: 17, R: 15, e: 4 }, workshop: { H: 24, R: 14, e: 3 }, tower: { H: 30, R: 20, e: 3 },
};
const LEADS = ['houseA', 'houseB', 'houseC', 'houseD'];

// ---------- the newer looks (the growing towns): a kit of storeys, roofs, towers and fittings ----------
const CIVIC = new Set(['barn', 'windmill', 'granary', 'chapel', 'smithy', 'inn', 'guildhall', 'clocktower', 'markethall', 'cathedral', 'wall', 'walltower', 'gatehouse']);
const KIT = new Set(['farmhouse', 'timber', 'townhouse', 'manor', 'palace', ...CIVIC]);
const PLASTER = ['#efe3c6', '#ecca8e', '#e9b6a3', '#bdd2a9', '#b7cbdc', '#f2dc9e', '#f2c49d', '#d0c1e0', '#f5eee0', '#e7d2ae'].map(rgb);
const BEAMS = ['#6b4429', '#583423', '#7a3b2a', '#4d4a5e'].map(rgb);
const FARM = ['#c9a06a', '#9fb39a', '#d9c49b', '#b98a6a'].map(rgb);
const EARTHS = ['#6a3d2c', '#8a4a30', '#5a4a44'].map(rgb);
const SAND = rgb('#d3c4a4'), GREY = rgb('#b6afa4'), LIME = rgb('#f1ebdd'), REDBARN = rgb('#a5473a'), OLDWOOD = rgb('#8a6446');
const SLATE = rgb('#5a6680'), LEAD = rgb('#8893a3'), TERRA = rgb('#b9603f'), THATCH = rgb('#d2aa5e'), SHAKE = rgb('#7d5d48');
const NOFIT = [];
const GLYPH = { // 5x5 emblems for hanging signs
  mug: ['###..', '####.', '###.#', '####.', '###..'], anvil: ['#####', '.###.', '..#..', '.###.', '#####'],
  key: ['.#...', '#.###', '.#.#.', '.....', '.....'], wheat: ['#.#.#', '.###.', '..#..', '..#..', '..#..'],
};

// ---------- architectural styles (city v4): a project's houses share one, picked by world.js (it.style) ----------
// 0 timber is the original look and is never touched. The others swap materials (walls, roofs, chimneys),
// pitch and eaves, windows, and add a signature detail each (crow steps, balconies, arched windows...), but
// share the light, the outlines, the ramps and the textures, so a mixed world still reads as one place.
const SYS = [null,
  { // 1 mediterranean: whitewash and warm plaster, low terracotta roofs, arched windows, blue/green shutters
    walls: ['#f6f1e6', '#f3e6cc', '#efdcb6', '#f2e3d4', '#ecd6ae', '#f4ead2'], dress: '#e4cd9c', rubble: '#dccaa4', civic: ['#f1e8d6', '#ecdcbc'],
    roofs: ['#c8643a', '#b9573a', '#cf7646'], rk: 0.55, de: 0.5, mat: { slate: 'tile', shingle: 'tile', thatch: 'tile' },
    shutters: ['#3f73a8', '#3f8f6f', '#2f8590', '#5a86c0'], trim: '#f4ecdc', beam: '#8a5a3a', doors: ['#3f73a8', '#7a4a2a', '#3f8f6f'], chim: '#f0e9dc' },
  { // 2 stone: grey-blue fieldstone, dark slate, steep, small deep-set windows, coped gables, big chimneys
    walls: ['#a9aaa6', '#9ea5ad', '#b0aa9e', '#a3a69e'], dress: '#c4c3bc', rubble: '#a7a9a5', civic: ['#b4b4ae', '#a9adb0'],
    roofs: ['#4a5672', '#525a6c', '#465068'], rk: 1.18, de: -0.5, mat: { tile: 'slate', shingle: 'slate', thatch: 'slate' },
    shutters: ['#3f5f4a', '#6e3434', '#3c4f6e'], trim: '#e2dfd6', beam: '#4d4a5e', doors: ['#3c4f6e', '#6e3434', '#4a5a3a'], chim: '#9c9c96' },
  { // 3 alpine: white ground floor, dark timber above with a balcony, wide low roofs, carved bargeboards
    walls: ['#f5f1e8', '#f1ebdd', '#eee6d6'], wood: ['#6a4430', '#5c3c2a', '#76503a'], dress: '#efe9de', rubble: '#b3aa9a', civic: ['#f2ede2', '#ece4d4'],
    roofs: ['#5e4a3e', '#56504c', '#6a4c3a'], rk: 0.5, de: 4, mat: { tile: 'shingle', slate: 'shingle', thatch: 'shingle' },
    shutters: ['#3f7a4a', '#a8443c', '#2f6a5a'], trim: '#7a4e32', beam: '#5a3a2a', doors: ['#6a4430', '#3f7a4a', '#7a3a2e'], chim: '#d8d0c2' },
  { // 4 canal: brick, stepped gables to the street, tall white-framed sash windows, narrow and tall
    walls: ['#a9573f', '#964b3a', '#b4664a', '#8e4737'], dress: '#a5543e', rubble: '#9c5040', civic: ['#a9573f', '#9a4e3c'],
    roofs: ['#6c3a30', '#4d4b55', '#7a4434'], rk: 1.15, de: -1, mat: { shingle: 'tile', thatch: 'tile' },
    shutters: ['#2f5a3f', '#2f4a5a', '#7a2f2f'], trim: '#f7f4ec', beam: '#3f3a40', doors: ['#2f5a3f', '#2f4a5a', '#6a2f2f'], chim: '#8a4535' },
  { // 5 thatch: cob and warm render, thick thatch, rustic timber, low and cosy
    walls: ['#efdcb2', '#e9cfa2', '#f2e4c6', '#e6c89a', '#efd6b8'], dress: '#d8c49e', rubble: '#c9b89a', civic: ['#e4d2ac', '#dccaa6'],
    roofs: ['#c9a25a', '#bf9850', '#d1ad66'], rk: 1.05, de: 1.5, mat: { tile: 'thatch', slate: 'thatch', shingle: 'thatch' },
    civRoof: '#9a5a3c', civMat: { slate: 'tile', shingle: 'tile', thatch: 'tile' },
    shutters: ['#5a7a4a', '#7a5a3a', '#4a6a7a'], trim: '#e9dcc0', beam: '#8a6446', doors: ['#6a4630', '#4a6a4a', '#7a4a2a'], chim: '#b9ab92' },
];
const SMALLCIVIC = new Set(['barn', 'windmill', 'granary', 'chapel', 'smithy', 'inn']);
/** The style family an item is drawn in (0 for looks that have no styles: the older houses). it.style is
 * undefined (today's look), a family number, or a Style object from styles-pool.js ({ key, family, roof, wall, ... }). */
const famOf = it => { const s = it.style; if (!(KIT.has(it.look) || it.look === 'cottage')) return 0; const f = s && typeof s === 'object' ? s.family : s; return (((f | 0) % 6) + 6) % 6; };
const palOf = it => (it.style && typeof it.style === 'object' && (KIT.has(it.look) || (it.look === 'cottage' && famOf(it))) ? it.style : null);
/** The style part of the cache key: the pool style's key, or the family number ('' = today's look). */
const styleKey = it => { const p = palOf(it); return p ? `k${p.key}` : famOf(it) ? `f${famOf(it)}` : ''; };
const hx = c => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? rgb(c) : null);

/** Restyle a kit look's materials for family st.sty (> 0), or recolour (any family) from a pool palette. */
function styleKit(st, it, look) {
  const S = SYS[st.sty], h = st.h, P = st.pal, pick = (a, n) => rgb(a[(h >>> n) % a.length]), acc = rgb(it.village?.accent ?? '#8a7a6a');
  const big = st.civic && !SMALLCIVIC.has(look);
  // Pool colours override the family's defaults; a palette swap only changes ramps, never shapes.
  const walls = P && hx(P.wall?.base) ? [hx(P.wall.base), hx(P.wall.alt) ?? hx(P.wall.base), mix(hx(P.wall.base), hx(P.wall.alt) ?? hx(P.wall.base), 0.5)] : null;
  const wallPick = n => walls ? jit(walls[(h >>> n) % 3], (((h >>> 20) % 3) - 1) * 0.03) : pick(S.walls, n);
  const roofPick = n => P && hx(P.roof?.base) ? jit(hx(P.roof.base), (((h >>> n) % 3) - 1) * 0.04) : pick(S.roofs, n);
  if (P) { st.ridgeC = hx(P.roof?.ridge); st.win = P.window; }
  if (!S) { // the timber family from the pool: today's shapes, the pool's colours on houses
    if (P && !st.civic) {
      if (walls) st.paint = wallPick(3);
      if (hx(P.trim) && look !== 'farmhouse') st.trim = hx(P.trim);
      if (hx(P.shutter)) st.shutter = hx(P.shutter);
      if (hx(P.door)) st.doorC = mix(hx(P.door), acc, 0.3);
      if (hx(P.roof?.base)) st.roofC = roofPick(25);
    }
    return;
  }
  const R0 = st.R;
  st.SY = S; st.dressC = rgb(S.dress); st.rubbleC = rgb(S.rubble); st.wood = pick(S.wood ?? [S.beam], 5);
  st.win ??= ['', 'arched', 'small', 'square', 'tall', 'square'][st.sty];
  st.mats = big && S.civMat ? S.civMat : S.mat;
  if (st.sty !== 5) st.frame = -1; // only the thatch family keeps (rustic) half-timbering
  st.roofC = big && S.civRoof ? rgb(S.civRoof) : roofPick(25);
  if (st.civic) {
    if (!['barn', 'windmill', 'granary'].includes(look)) st.paint = pick(S.civic, 3);
    if (look === 'chapel' && st.sty === 1) st.spire = false; // a bell gable, not a spire
  } else {
    st.paint = wallPick(3); st.trim = hx(P?.trim) ?? rgb(S.trim); st.beam = rgb(S.beam);
    if (st.sty === 3 && P && hx(P.wall?.alt)) st.wood = hx(P.wall.alt).reduce((a, b) => a + b) < 360 ? hx(P.wall.alt) : st.wood;
    if (st.sty === 4) st.paint = walls ? walls[(h >>> 3) % 2] : st.paint;
    st.shutter = hx(P?.shutter) ?? mix(pick(S.shutters, 9), acc, 0.15); st.doorC = mix(hx(P?.door) ?? pick(S.doors, 7), acc, 0.4);
    st.roof = S.mat[st.roof] ?? st.roof;
    st.shutters = st.sty === 1 || st.sty === 3 || (st.sty === 5 && (h >>> 18) % 2 === 1);
    st.flowers = st.sty === 3 || st.sty === 5;
    if (look === 'farmhouse') {
      st.lower = ['', 'white', 'stoneP', 'logs', 'brickP', (h >>> 16) % 3 ? 'white' : 'logs'][st.sty];
      if (st.lower === 'logs') st.paint = st.sty === 3 ? st.wood : rgb('#a87447');
    }
    if (look === 'timber') st.front = st.sty === 3 || (st.sty === 4 && it.w <= 4);
    if (look === 'townhouse') {
      const front = st.sty === 3 || st.sty === 4 || (st.sty !== 1 && st.front), Wp = it.w * 16, Dp = it.h * 16;
      Object.assign(st, { front, R: front ? Math.round(Wp * (st.sty === 3 ? 0.75 : 0.9)) : Math.round(Dp * 0.62), e: front ? 1.5 : 2.5 });
      st.top = st.H + st.R + 24;
    }
  }
  const rk = st.civic ? 1 + (S.rk - 1) * 0.5 : S.rk;
  st.top = Math.ceil((st.top ?? st.H + R0 + 32) + Math.max(0, st.R - R0) + Math.max(0, rk - 1) * st.R * 1.2 + 8);
  st.pad = Math.max(0, Math.ceil(S.de * 0.8) + (S.de > 0 ? 1 : 0)); // deep eaves reach past the usual margin
}

/** A newer look's style: picked from look + variant (+ size), never from the id when a variant is given. */
function kitStyle(it, look, h, T) {
  const b = (n, m) => (h >>> n) % m, Wp = it.w * T, Dp = it.h * T, civic = CIVIC.has(look), sc = SCHEMES[b(9, SCHEMES.length)];
  const st = {
    kit: true, look, h, seed: h & 0xffff, pr: it.kind === 'pr', civic, hall: false, split: 99, lower: 'plaster', upper: 'plaster', porch: false,
    tone: (b(20, 5) - 2) * 0.035, props: (h >>> 22) & 0xff, paint: PLASTER[b(3, PLASTER.length)], beam: BEAMS[b(7, BEAMS.length)], frame: b(13, 4),
    trim: rgb(sc[1]), shutter: rgb(sc[2]), doorC: rgb(sc[3]), shutters: true, flowers: true, roof: ['tile', 'shingle', 'tile', 'slate'][b(15, 4)], e: 3, H: 24, R: 20,
  };
  const stone = { trim: rgb('#efe6d4') };
  switch (look) {
    case 'farmhouse': Object.assign(st, { H: 19, R: 22, e: 4, roof: 'thatch', lower: ['logs', 'clap', 'stone', 'logs', 'clap'][b(16, 5)], shutters: b(18, 2) === 1, flowers: b(19, 3) !== 0, paint: FARM[b(3, 4)] });
      if (st.lower === 'logs') st.paint = rgb('#a87447');
      if (st.lower !== 'clap') st.trim = rgb('#6a4630');
      break;
    case 'timber': Object.assign(st, { front: Wp <= 48 && b(11, 3) === 0, H: 33, R: 27 }); st.top = st.H + st.R + 30; break;
    case 'townhouse': { const n = 3, front = b(12, 4) !== 0; Object.assign(st, { n, front, H: 16 + 14 * (n - 1), R: front ? Math.round(Wp * 0.9) : Math.round(Dp * 0.62), e: front ? 1.5 : 2.5 }); st.top = st.H + st.R + 24; break; }
    case 'cottage': Object.assign(st, { H: 21, R: 15, e: 3, roof: ['shingle', 'tile', 'shingle'][b(10, 3)] }); break;
    case 'palace': Object.assign(st, { H: 51, R: 24, roof: b(15, 2) ? 'slate' : 'tile', trim: rgb('#f3e7cd'), crown: !!it.crown }); st.top = 51 + 24 + 64; break;
    case 'manor': { const three = b(11, 3) === 0; Object.assign(st, { three, H: three ? 48 : 34, R: 26, roof: b(15, 2) ? 'slate' : 'tile', trim: rgb('#f3e7cd') }); st.top = st.H + st.R + 32; break; }
    case 'barn': { const red = b(11, 3) !== 0; Object.assign(st, { red, gamb: b(12, 2) === 1, H: 22, R: 28, roof: red ? 'shingle' : 'thatch', roofC: red ? SHAKE : THATCH, trim: red ? rgb('#f1e8d6') : rgb('#5a3a26'), paint: red ? REDBARN : OLDWOOD }); st.top = 22 + 28 + 32; break; }
    case 'windmill': Object.assign(st, stone, { H: 60, R: 18, roof: 'shingle', roofC: b(11, 2) ? SHAKE : rgb('#9a4a3a'), paint: b(12, 3) ? rgb('#efe9dc') : rgb('#4f4a52') }); st.top = 98; break;
    case 'granary': Object.assign(st, { H: 25, R: 15, roof: b(11, 2) ? 'thatch' : 'tile', roofC: b(11, 2) ? THATCH : TERRA, paint: OLDWOOD, trim: rgb('#5a3a26') }); st.top = 64; break;
    case 'chapel': Object.assign(st, stone, { wash: b(11, 2) === 0, spire: b(12, 2) === 1, H: 26, R: 25, roof: b(13, 2) ? 'slate' : 'tile', roofC: b(13, 2) ? SLATE : TERRA }); st.paint = st.wash ? LIME : SAND; st.top = st.spire ? 26 + 25 + 52 : 26 + 25 + 40; break;
    case 'smithy': Object.assign(st, stone, { H: 20, R: 16, roof: 'slate', roofC: SLATE, paint: GREY }); st.top = 20 + 16 + 40; break;
    case 'inn': Object.assign(st, { H: 31, R: 24, roof: b(11, 2) ? 'tile' : 'slate', roofC: b(11, 2) ? TERRA : SLATE }); st.top = 31 + 24 + 32; break;
    case 'guildhall': Object.assign(st, stone, { H: 51, R: 26, roof: 'slate', roofC: SLATE, paint: PLASTER[[0, 1, 5, 9][b(3, 4)]] }); st.top = 51 + 26 + 50; break;
    case 'clocktower': Object.assign(st, stone, { H: 97, R: 36, roof: 'slate', roofC: b(11, 2) ? SLATE : LEAD, paint: b(12, 2) ? SAND : GREY }); st.top = 97 + 36 + 20; break;
    case 'markethall': Object.assign(st, { H: 36, R: 20, roof: 'tile', roofC: TERRA, trim: rgb('#efe6d4') }); st.top = 36 + 20 + 40; break;
    case 'cathedral': Object.assign(st, stone, { twin: b(11, 2) === 0, H: 60, R: 30, roof: 'slate', roofC: b(12, 2) ? SLATE : LEAD, paint: b(13, 2) ? SAND : rgb('#cfc8bb') }); st.top = st.twin ? 180 : 205; break;
    case 'wall': Object.assign(st, stone, { H: 30, R: 6, paint: b(11, 2) ? SAND : GREY }); st.top = 48; break;
    case 'walltower': Object.assign(st, stone, { H: 50, R: 40, roof: 'slate', roofC: b(11, 2) ? SLATE : TERRA, paint: b(12, 2) ? SAND : GREY }); st.top = 108; break;
    case 'gatehouse': Object.assign(st, stone, { H: 42, R: 30, roof: 'slate', roofC: b(11, 2) ? SLATE : TERRA, paint: b(12, 2) ? SAND : GREY }); st.top = 98; break;
  }
  st.sty = famOf(it); st.pal = palOf(it);
  if (st.sty || st.pal) styleKit(st, it, look);
  st.top ??= st.H + st.R + 32;
  return st;
}

/** What a building looks like, decided once from its id (so it never changes between visits). */
function styleOf(it, T = 16) {
  const look = it.look || 'houseH', h = it.variant != null ? h2(hash(look), it.variant + 1, 0x51ed) : hash(it.id), pr = it.kind === 'pr', cot = look === 'cottage';
  if (KIT.has(look) || (cot && famOf(it))) return kitStyle(it, look, h, T); // a styled cottage is built from the kit
  const arch = look === 'hall' ? 'lodge' : look.startsWith('tower') ? 'tower' : pr && !cot ? 'workshop'
    : LEADS.includes(look) ? (h % 5 < 3 ? 'twostorey' : 'cottage') : (h % 3 === 0 ? 'hut' : 'cottage');
  const A = ARCH[arch], sc = SCHEMES[(h >>> 5) % SCHEMES.length];
  const st = { arch, pr, hall: arch === 'lodge', H: A.H, R: A.R, e: A.e, seed: h & 0xffff, roofShape: look === 'towerDome' ? 'dome' : arch === 'tower' ? 'spire' : 'gable' };
  st.paint = PAINT[sc[0]]; st.trim = rgb(sc[1]); st.shutter = rgb(sc[2]); st.doorC = rgb(sc[3]);
  const bit = n => (h >>> n) & 1;
  if (arch === 'lodge') Object.assign(st, { lower: 'stone', upper: 'timber', split: 15, roof: 'slate', ridge: 'NS', shutters: true, flowers: true, lamp: true, chimney: true, trim: rgb('#5a3a26'), paint: rgb('#efe3c6'), doorC: rgb('#7a4a2a'), shutter: rgb('#46705f') });
  else if (arch === 'twostorey') Object.assign(st, { lower: bit(7) ? 'stone' : 'clap', upper: ['clap', 'timber', 'shingleWall'][(h >>> 8) % 3], split: 14, roof: bit(10) ? 'tile' : 'shingle', shutters: true, flowers: bit(11) === 0, lamp: bit(12) === 1, chimney: true });
  else if (arch === 'cottage') Object.assign(st, { lower: ['clap', 'clap', 'timber', 'stone', 'logs'][(h >>> 7) % 5], roof: ['shingle', 'tile', 'shingle'][(h >>> 10) % 3], shutters: bit(11) === 0, flowers: (h >>> 12) % 3 !== 0, lamp: bit(14) === 1, chimney: (h >>> 15) % 3 !== 0 });
  else if (arch === 'hut') Object.assign(st, { lower: bit(7) ? 'logs' : 'clap', roof: 'thatch', shutters: bit(8) === 1, flowers: bit(9) === 1, lamp: false, chimney: bit(10) === 1, paint: bit(7) ? rgb('#a87447') : st.paint });
  else if (arch === 'workshop') Object.assign(st, { lower: bit(7) ? 'brick' : 'stone', upper: 'clap', split: 16, roof: bit(8) ? 'slate' : 'tile', shutters: false, flowers: false, lamp: false, chimney: true, sign: true, paint: rgb('#b88a5a'), trim: rgb('#5a3a26'), doorC: rgb('#8a5a34') });
  else Object.assign(st, { lower: bit(7) ? 'stone' : 'brick', roof: bit(8) ? 'slate' : 'shingle', shutters: false, flowers: false, lamp: false, chimney: false, sign: true });
  st.upper ??= st.lower; st.split ??= 99;
  if (st.lower === 'logs') st.paint = rgb('#a87447');
  if (st.lower === 'timber') st.paint = rgb('#efe3c6');
  if (!st.ridge) {
    const W = it.w, D = it.h;
    st.ridge = W > D ? 'EW' : W < D ? 'NS' : bit(16) ? 'EW' : 'NS';
    st.hip = arch === 'cottage' && st.ridge === 'EW' && W > D && (h >>> 17) % 3 === 0;
  }
  st.porch = arch === 'lodge' || ((arch === 'cottage' || arch === 'twostorey') && (h >>> 18) % 3 === 0);
  st.tone = ((h >>> 20) % 5 - 2) * 0.035; // roof lightness wobble: neighbours differ a touch
  st.props = (h >>> 22) & 0xff;
  if (cot) { st.flowers = true; st.shutters = true; if (pr) st.sign = true; } // the village cottage: always dressed up
  return st;
}

/** A building's screen rect in view px relative to isoP(x0, y0), without drawing it: [x0, y0, x1, y1]. */
export function isoExtent(it, T) {
  const s = ISO, st = styleOf(it, T), W = it.w * T, D = it.h * T;
  const p = st.pad ?? 0;
  return [-D * s - 8 - p, -(st.top ?? st.H + st.R + 44), W * s + 8 + p, (W + D) * s / 2 + 8];
}
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const cache = new Map();

/**
 * The building for item `it` (footprint it.x, it.y, it.w, it.h in tiles, look, village accent). `lit`:
 * its windows glow (its agent is in, or it is night). Returns { img, dx, dy, windows, door, ridge,
 * chimney, box }: img is drawn at isoP(x0, y0) + [dx, dy] in view px; the points and box are in view px
 * relative to isoP(x0, y0).
 */
export function isoBuilding(it, T, lit) {
  const site = it.kind === 'pr' && it.building;
  // Style comes from look + variant (+ accent), so hundreds of townsfolk houses share a few images; an
  // item without a variant (older layouts) keeps its id-picked style.
  const k = `${it.look}|${it.w}|${it.h}|${it.village.accent}|${it.variant ?? `id:${it.id}`}|${lit ? 1 : 0}|${site ? 'site' : ''}|${it.doorX}|${styleKey(it)}|${it.look === 'palace' && it.crown ? 1 : 0}`;
  if (!cache.has(k)) { if (cache.size > 4000) cache.clear(); cache.set(k, make(it, T, lit, site)); }
  return cache.get(k);
}

function make(it, T, lit, site) {
  const s = ISO, W = it.w * T, D = it.h * T, st = styleOf(it, T);
  const H = st.H, R = st.R, e = st.e;
  const Q = (x, y, z = 0) => [(x - y) * s, (x + y) * s / 2 - z];
  const top = -(st.top ?? H + R + 44), left = Math.floor(-D * s) - 8 - (st.pad ?? 0), right = Math.ceil(W * s) + 8 + (st.pad ?? 0), bottom = Math.ceil((W + D) * s / 2) + 8;
  const w = right - left, h = bottom - top;
  const accent = rgb(it.village.accent);
  // Roofs carry the neighbourhood's accent (so a project's houses match), warmed toward an earthy tone
  // so they sit a value step below the status badges; workshops get a cooler slate of the same hue.
  let RB;
  if (st.kit) { // houses keep the neighbourhood's roof (nudged toward one of three earths so a street varies); civic buildings their own slate, lead or tile
    RB = st.roofC ? mix(st.roofC, accent, 0.08) : st.roof === 'thatch' ? mix(rgb('#d2aa5e'), accent, 0.1)
      : st.roof === 'slate' ? mix(mix(accent, rgb('#4a5670'), 0.5), SHADE, 0.05) : mix(accent, EARTHS[(st.h >>> 25) % 3], 0.2 + ((st.h >>> 27) % 3) * 0.08);
  } else {
    RB = st.pr ? mix(mix(accent, rgb('#4f5568'), 0.45), SHADE, 0.06) : mix(accent, rgb('#6a3d2c'), 0.22);
    if (st.roof === 'thatch') RB = mix(rgb('#d2aa5e'), accent, 0.1);
    if (st.roof === 'slate' && !st.pr) RB = mix(mix(accent, rgb('#4a5670'), 0.5), SHADE, 0.05);
  }
  if (st.sty) RB = mix(st.roofC, accent, st.civic ? 0.05 : 0.08);
  RB = jit(RB, st.tone);
  const TR = ramp(st.trim), DOOR = ramp(st.civic ? mix(accent, rgb('#4a2e22'), 0.45) : st.doorC), SHU = ramp(st.shutter), FOOT = ramp(STONE);
  const faces = [];
  const keyS = (x, y, z) => y * s - z, keyE = (x, y, z) => x * s - z; // Y − X/2 and Y + X/2 of a point
  // A planar face: its 3D outline, how its texture rows run (along x: 'S'; along y: 'E') and its material.
  const face = (pts, dir, mat, extra = {}) => {
    const [a, b, c] = pts, u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const key = dir === 'S' ? keyS : keyE, zs = pts.map(p => p[2]), lo = pts[zs.indexOf(Math.min(...zs))], hi = pts[zs.indexOf(Math.max(...zs))];
    const k0 = key(...lo), k1 = key(...hi);
    faces.push({ pts, n, c: n[0] * a[0] + n[1] * a[1] + n[2] * a[2], dir, mat, k0, sgn: k1 > k0 ? 1 : -1, rmax: Math.abs(k1 - k0), scr: pts.map(p => Q(...p)), ...extra });
  };
  const lightOf = N => N[0] * L[0] + N[1] * L[1] + N[2] * L[2];
  const byLight = (rp, N, bias = 0) => { const d = lightOf(N) + bias; return d > 0.62 ? rp[3] : d > 0.25 ? rp[2] : d > -0.15 ? rp[1] : rp[0]; };

  // ---------- wall textures ----------
  // A wall texture at (col, z): col is whole screen px from the wall's left end, z is height in px.
  const FOOT_H = 4;
  const P = ramp(st.paint);
  const wallTex = (tex, col, zi, cols, gable, paint = st.paint, zb = FOOT_H) => {
    switch (tex) {
      case 'clap': { // clapboard: 3-px boards, a lit top edge, a shadow line under each board's lap
        const r = ((zi - zb) % 3 + 3) % 3, row = Math.floor((zi - zb) / 3);
        let c = r === 0 ? dk(paint, 0.25) : r === 2 ? lt(paint, 0.1) : paint;
        const joint = (col + row * 11) % 17 === 0;
        if (joint && r !== 0) c = dk(paint, 0.2);
        else if (r !== 0 && h2(col, zi, st.seed) % 29 === 0) c = dk(paint, 0.12); // grain speck
        return c;
      }
      case 'shingleWall': { // cedar shakes on an upper floor: short staggered shingles
        const r = ((zi - zb) % 4 + 4) % 4, row = Math.floor((zi - zb) / 4), u = col + (row & 1) * 2;
        let c = jit(paint, ((h2(row, u >> 2, st.seed) % 5) - 2) * 0.04);
        if (r === 0) c = dk(c, 0.32); else if (u % 4 === 0) c = dk(c, 0.2); else if (r === 3) c = lt(c, 0.1);
        return c;
      }
      case 'logs': { // stacked logs with a rounded profile, log ends at the corners
        const r = ((zi - zb) % 4 + 4) % 4, base = paint;
        if (col <= 2 || col >= cols - 3) { // the crossed log ends: rings
          const end = rgb('#d7b07a');
          return r === 0 ? dk(base, 0.5) : (col === 1 || col === cols - 2) && (r === 1 || r === 2) ? dk(end, 0.25) : r === 3 ? lt(end, 0.15) : end;
        }
        let c = r === 0 ? dk(base, 0.45) : r === 1 ? dk(base, 0.12) : r === 2 ? base : lt(base, 0.18);
        if (r !== 0 && h2(col >> 1, zi, st.seed) % 23 === 0) c = dk(c, 0.15);
        return c;
      }
      case 'stone': { // fieldstone: rounded stones, each lit on its top edge, dark mortar
        const row = Math.floor((zi - zb) / 4), r = ((zi - zb) % 4 + 4) % 4, wv = 5 + (h2(row, 0, st.seed) % 3), u = col + row * 3;
        const cell = Math.floor(u / wv), cc = u - cell * wv, base = jit(rgb('#b3aa9a'), ((h2(row, cell, st.seed) % 5) - 2) * 0.05);
        if (r === 0 || cc === 0) return dk(base, 0.42);
        if (r === 3 && cc > 1) return lt(base, 0.2);
        if (cc === wv - 1 || r === 1) return dk(base, 0.12);
        return base;
      }
      case 'brick': {
        const row = Math.floor((zi - zb) / 3), r = ((zi - zb) % 3 + 3) % 3, off = (row % 2) * 3, base = jit(rgb('#b8644a'), ((h2(row, (col + off) / 6 | 0, st.seed) % 5) - 2) * 0.05);
        if (r === 0 || (col + off) % 6 === 0) return rgb('#d6c3ad');
        return r === 2 ? lt(base, 0.12) : base;
      }
      case 'brickP': { // brick in the style's colour (canal): 3-px courses, staggered joints, pale mortar
        const row = Math.floor((zi - zb) / 3), r = ((zi - zb) % 3 + 3) % 3, off = (row % 2) * 3, base = jit(paint, ((h2(row, (col + off + 600) / 6 | 0, st.seed) % 5) - 2) * 0.05);
        if (r === 0 || (col + off + 600) % 6 === 0) return mix(paint, rgb('#dccbb6'), 0.55);
        return r === 2 ? lt(base, 0.1) : base;
      }
      case 'stoneP': { // fieldstone in the style's colour (stone): rounded stones, lit tops, dark mortar
        const row = Math.floor((zi - zb) / 4), r = ((zi - zb) % 4 + 4) % 4, wv = 5 + (h2(row, 0, st.seed) % 3), u = col + row * 3 + 600;
        const cell = Math.floor(u / wv), cc = u - cell * wv, base = jit(paint, ((h2(row, cell, st.seed) % 5) - 2) * 0.06);
        if (r === 0 || cc === 0) return dk(base, 0.42);
        if (r === 3 && cc > 1) return lt(base, 0.2);
        if (cc === wv - 1 || r === 1) return dk(base, 0.12);
        return base;
      }
      case 'boards': { // board-and-batten (gable ends)
        const c = st.lower === 'logs' ? rgb('#a87447') : mix(st.paint, WOOD, 0.35);
        return col % 4 === 0 ? dk(c, 0.3) : col % 4 === 1 ? lt(c, 0.12) : c;
      }
      case 'ashlar': { // cut stone: even courses, staggered joints, a lit top arris on every block
        const row = Math.floor((zi - zb) / 5), r = ((zi - zb) % 5 + 5) % 5, u = col + (row & 1) * 5 + 600, cell = Math.floor(u / 10), cc = u - cell * 10;
        const b = jit(paint, ((h2(row, cell, st.seed) % 5) - 2) * 0.035);
        if (r === 0 || cc === 0) return dk(b, 0.3);
        if (r === 4) return lt(b, 0.14);
        if (cc === 9) return dk(b, 0.1);
        return h2(col, zi, st.seed) % 23 === 0 ? dk(b, 0.08) : b;
      }
      case 'planks': { // vertical boards: a dark seam, a lit edge, knots
        const u = col + 600, cc = u % 4;
        let c = jit(paint, ((h2(u >> 2, 0, st.seed) % 5) - 2) * 0.045);
        if (cc === 0) return dk(c, 0.38);
        if (cc === 1) c = lt(c, 0.12);
        if (h2(u, zi >> 1, st.seed) % 19 === 0) c = dk(c, 0.14);
        return c;
      }
      case 'white': { // limewash over rubble: the stones only just show through
        const k = h2(col >> 1, zi >> 1, st.seed) % 11;
        return k === 0 ? dk(paint, 0.09) : k === 1 ? lt(paint, 0.25) : (zi - zb) % 4 === 0 && h2(col >> 2, zi, st.seed) % 3 === 0 ? dk(paint, 0.05) : paint;
      }
      default: { // plaster between timber frame
        let c = paint;
        if (h2(col, zi, st.seed) % 19 === 0) c = dk(c, 0.06);
        else if (h2(col + 7, zi, st.seed) % 31 === 0) c = lt(c, 0.25);
        return c;
      }
    }
  };
  // Timber framing over plaster: rails, posts every so often and a brace in each panel.
  const timber = (col, zi, z0, z1, cols) => {
    if (zi === z0 || zi === z0 + 1 || zi >= z1 - 1) return true;
    const p = col % 12;
    if (p === 0 || p === 1) return true;
    const rel = (zi - z0) / Math.max(1, z1 - z0 - 1);
    if (cols > 20 && p > 1 && Math.abs((p - 2) / 9 - rel) < 0.09 && Math.floor(col / 12) % 2 === 0) return true;
    return false;
  };

  // ---------- fittings painted over walls ----------
  const fittings = [];
  const win = (face, cc, z0, wd = 7, ht = 8, round = false) => fittings.push({ face, kind: round ? 'round' : 'win', c0: cc - (wd >> 1), c1: cc - (wd >> 1) + wd - 1, z0, z1: z0 + ht - 1 });
  const glass = (col, zi, f) => { // panes: a diagonal sky reflection by day, warm light at night
    const dx = col - f.c0, dz = f.z1 - zi, diag = (dx + dz) % 7;
    if (lit) { const cx = (f.c0 + f.c1) / 2, cz = (f.z0 + f.z1) / 2, d = Math.abs(col - cx) / (f.c1 - f.c0 + 1) + Math.abs(zi - cz) / (f.z1 - f.z0 + 1); return [d < 0.25 ? LIT[4] : d < 0.45 ? LIT[3] : LIT[2], 1]; }
    return [diag === 2 || diag === 3 ? GLASS[4] : dz <= 1 ? GLASS[0] : dx <= 1 ? GLASS[1] : GLASS[2], 0];
  };
  const paintFitting = (f, col, zi) => {
    if (f.zb) zi -= f.zb; // a fitting on a raised floor (the granary's door)
    if (f.kind === 'round') {
      const cx = (f.c0 + f.c1) / 2, cz = (f.z0 + f.z1) / 2, d = (col - cx) ** 2 + (zi - cz) ** 2, r = (f.c1 - f.c0) / 2 + 0.5;
      if (d > r * r) return null;
      if (d > (r - 1.3) ** 2) return [TR[d > (r - 0.6) ** 2 ? 1 : 3], 0];
      if (Math.abs(col - cx) < 0.6 || Math.abs(zi - cz) < 0.6) return [TR[2], 0];
      return glass(col, zi, f);
    }
    if (f.kind === 'win') {
      const { c0, c1, z0, z1 } = f, mid = (c0 + c1) >> 1;
      if (f.arch && col >= c0 - 1 && col <= c1 + 1) { // a round-headed window: the frame follows the arch
        const r = (c1 - c0 + 1) / 2, cx = (c0 + c1) / 2, zs = z1 - r + 1;
        if (zi >= zs && zi <= z1 + 1) {
          const d = Math.hypot(col - cx, zi - zs);
          if (d > r + 0.6) return null;
          if (d > r - 0.7) return [TR[col < cx ? 3 : 1], 0];
          return col === mid ? [TR[2], 0] : glass(col, zi, f);
        }
      }
      if (zi === z1 + 1 && col >= c0 - 1 && col <= c1 + 1) return [TR[1], 0]; // lintel
      if (zi === z0 - 1 && col >= c0 - 1 && col <= c1 + 1) return [TR[3], 0]; // sill
      const flw = f.flowers ?? st.flowers, shut = f.shutters ?? st.shutters;
      if (zi === z0 - 2 && col >= c0 - 1 && col <= c1 + 1 && !flw) return [dk(TR[1], 0.2), 0]; // the sill's shadow
      if (flw && col >= c0 - 1 && col <= c1 + 1) { // a window box, flowers spilling over its lip
        if (zi === z0 - 2) { const k = h2(col, f.z0, st.seed); return [k % 3 === 0 ? dk(LEAF, 0.2) : k % 3 === 1 ? LEAF : FLOWERS[(k >>> 4) % FLOWERS.length], 0]; }
        if (zi === z0 - 3) return [col === c0 - 1 || col === c1 + 1 ? dk(WOOD, 0.3) : lt(WOOD, 0.1), 0];
        if (zi === z0 - 4) return [dk(WOOD, 0.25), 0];
      }
      if (shut && zi >= z0 && zi <= z1 && (col === c0 - 3 || col === c0 - 2 || col === c1 + 2 || col === c1 + 3)) {
        const outer = col === c0 - 3 || col === c1 + 3;
        return [outer ? SHU[1] : (zi - z0) % 2 ? SHU[2] : SHU[1], 0]; // louvred shutters
      }
      if (col < c0 || col > c1 || zi < z0 || zi > z1) return null;
      if (col === c0 || col === c1 || zi === z0 || zi === z1) return f.deep ? [col === c0 || zi === z1 ? dk(TR[1], 0.45) : TR[2], 0] : [col === c0 || zi === z1 ? TR[3] : TR[1], 0]; // frame, lit top-left (a deep reveal: in shadow)
      if (f.panes ? (col - c0) % f.panes === 0 || (z1 - zi) % 4 === 0 : col === mid || zi === ((z0 + z1) >> 1)) return [TR[2], 0]; // mullions
      return glass(col, zi, f);
    }
    if (f.kind === 'door') {
      const { c0, c1, z1, dbl, barn } = f; // the leaf is c0..c1 by 0..z1; the frame goes round it
      if (col < c0 - 1 || col > c1 + 1 || zi < 0 || zi > z1 + 1) return null;
      if (!barn && ((zi === z1 + 1 && (col <= c0 || col >= c1)) || (zi === z1 && (col === c0 - 1 || col === c1 + 1)))) return null; // a rounded head
      if (col === c0 - 1 || col === c1 + 1 || zi === z1 + 1 || (!barn && zi === z1 && (col === c0 || col === c1))) return [col === c0 - 1 || zi === z1 + 1 ? TR[3] : TR[1], 0];
      if (col === c0 || col === c1 || zi === z1) return [DOOR[0], 0]; // the reveal's shadow
      const mid = (c0 + c1) >> 1;
      if (barn) { // barn doors: a frame, an X brace on each leaf, planks between
        if (col === mid) return [DOOR[0], 0];
        const leaf0 = col < mid ? c0 + 1 : mid + 1, lw = col < mid ? mid - c0 - 2 : c1 - mid - 2, u = (col - leaf0) / Math.max(1, lw), v = (zi - 1) / Math.max(1, z1 - 2);
        if (zi === 1 || zi === z1 - 1 || col === leaf0 || col === leaf0 + lw) return [DOOR[3], 0];
        if (Math.abs(u - v) < 0.17 || Math.abs(u + v - 1) < 0.17) return [DOOR[3], 0];
        return [(col - leaf0) % 2 ? DOOR[2] : DOOR[1], 0];
      }
      if (dbl && col === mid) return [DOOR[0], 0];
      if ((dbl ? [mid - 2, mid + 2] : [c1 - 2]).includes(col) && zi === Math.round(z1 * 0.45)) return [GOLD, 0];
      if (!dbl && zi >= z1 - 4 && zi <= z1 - 3 && col >= c0 + 2 && col <= c1 - 2) return glass(col, zi, { c0: c0 + 2, c1: c1 - 2, z0: z1 - 4, z1: z1 - 3 }); // a little light
      if (zi === Math.round(z1 * 0.3) || zi === Math.round(z1 * 0.7)) return [DOOR[1], 0]; // ledges
      if (zi < 1) return [DOOR[0], 0];
      return [(col - c0) % 2 ? DOOR[2] : DOOR[3], 0];
    }
    if (f.kind === 'lamp') { // a wall lantern on a bracket
      const { c0, z0 } = f;
      if (zi === z0 + 6 && col >= c0 - 1 && col <= c0 + 1) return [dk(DARKWOOD, 0.3), 0]; // bracket arm
      if (col < c0 || col > c0 + 2 || zi < z0 || zi > z0 + 5) return null;
      if (zi === z0 + 5 || zi === z0 || col !== c0 + 1) return [zi === z0 + 5 ? dk(GOLD, 0.35) : dk(DARKWOOD, 0.4), 0];
      return [lit || f.on ? LIT[4] : rgb('#f0d08a'), lit || f.on ? 1 : 0];
    }
    if (f.kind === 'sign') { // a hanging board in the accent: a finished PR (a guild workshop)
      const { c0, z0 } = f;
      if (zi === z0 + 8 && col >= c0 - 1 && col <= c0 + 7) return [dk(DARKWOOD, 0.3), 0]; // the arm
      if (col < c0 || col > c0 + 6 || zi < z0 || zi > z0 + 7) return null;
      if (zi >= z0 + 6) return col === c0 + 1 || col === c0 + 5 ? [dk(DARKWOOD, 0.4), 0] : null; // the chains
      if (zi === z0 || zi === z0 + 5 || col === c0 || col === c0 + 6) return [dk(accent, 0.5), 0];
      if (zi === z0 + 4) return [lt(accent, 0.2), 0];
      return [(zi === z0 + 2 && col >= c0 + 2 && col <= c0 + 4) ? lt(accent, 0.7) : accent, 0];
    }
    if (f.kind === 'banner') { // a hanging banner in the accent (the lodge)
      const { c0, z0 } = f;
      if (col < c0 || col > c0 + 4 || zi < z0 || zi > z0 + 11) return null;
      if (zi === z0 + 11) return [dk(DARKWOOD, 0.3), 0];
      if (zi < z0 + 2 && (col === c0 + 2 || (zi === z0 && col !== c0 + 2))) return zi === z0 + 1 ? [dk(accent, 0.3), 0] : null; // a swallowtail
      if (col === c0 || col === c0 + 4) return [dk(accent, 0.3), 0];
      return [zi === z0 + 7 && col === c0 + 2 ? GOLD : col === c0 + 1 ? lt(accent, 0.15) : accent, 0];
    }
    return kitFitting(f, col, zi);
  };
  // A wall face's material: texture by floor, timber posts, the stone foundation, fittings, eave shadow.
  const wallMat = (name, cols, shade, opt = {}) => (q) => {
    const { col, z } = q, zi = Math.floor(z), Hw = opt.H ?? H;
    let c, g = 0;
    for (const f of fittings) if (f.face === name) { const p = paintFitting(f, col, zi); if (p) { c = p[0]; g = p[1]; break; } }
    if (!c) {
      if (opt.gable) c = wallTex(st.lower === 'logs' ? 'logs' : 'boards', col, zi, cols, true);
      else if (zi < FOOT_H) { // the stone foundation course: rounded stones, a dark base where it meets the ground
        const u = col + 600, cell = Math.floor(u / 6), cc = u - cell * 6, b = jit(FOOT[2], ((h2(cell, 0, st.seed) % 5) - 2) * 0.06);
        c = zi === 0 || cc === 0 ? FOOT[0] : zi === 3 ? (cc === 1 ? b : lt(b, 0.22)) : zi === 1 ? dk(b, 0.14) : b;
      } else {
        const upper = zi >= st.split, tex = upper ? st.upper : st.lower;
        if (tex === 'timber' && timber(col, zi, upper ? st.split : FOOT_H, upper ? Hw : Math.min(st.split, Hw), cols)) c = col % 12 === 0 ? lt(BEAM, 0.12) : BEAM; // dark oak beams
        else c = wallTex(tex, col, zi, cols);
        if (zi === st.split || zi === st.split - 1) c = zi === st.split ? TR[3] : TR[1]; // the belt course between floors
        if (zi === FOOT_H) c = dk(c, 0.18); // contact shade on the foundation
        // Corner posts (not on log walls: the log ends do that).
        if (st.lower !== 'logs' && tex !== 'stone' && tex !== 'brick' && (col <= 1 || col >= cols - 2)) c = col === 0 || col === cols - 2 ? TR[3] : TR[1];
        if ((tex === 'stone' || tex === 'brick') && (col === 0 || col === cols - 1)) c = dk(c, 0.15);
      }
    }
    if (!g && opt.awn && col >= opt.awn[0] && col <= opt.awn[1] && zi >= opt.awn[2] - 4 && zi < opt.awn[2]) c = dk(c, 0.28); // under the porch roof
    if (!g && opt.eave && zi >= Hw - 6) c = dk(c, zi >= Hw - 3 ? 0.38 : 0.24); // shadow under the eaves
    return g ? [c, g] : [dk(c, shade), 0];
  };

  // ---------- roof materials ----------
  // u: screen px along the eave; r: screen rows up from the eave; rmax: rows at the ridge.
  const roofTex = (mat, u, r, rmax, base) => {
    const seed = st.seed;
    if (mat === 'shingle') { // chunky rounded shingles: a lit lip on each course, shadowed under the next
      const C = 4, Wd = 6, course = Math.floor(r / C), rr = r - course * C, uu = Math.floor(u) + (course & 1) * 3 + 600, cell = Math.floor(uu / Wd), cc = uu - cell * Wd;
      let c = jit(base, ((h2(course, cell, seed) % 5) - 2) * 0.035);
      if (rr < 1) c = cc === 0 || cc === Wd - 1 ? dk(c, 0.42) : lt(c, 0.24);
      else if (cc === 0) c = dk(c, 0.36);
      else if (rr < 2) c = lt(c, 0.06);
      else if (rr >= 3) c = dk(c, 0.2);
      if (h2(uu, Math.floor(r), seed) % 47 === 0) c = lt(c, 0.18);
      return c;
    }
    if (mat === 'tile') { // barrel tiles: rounded channels, a bright lip on every course
      const C = 5, course = Math.floor(r / C), rr = r - course * C, uu = Math.floor(u) + 600, cc = uu % 5;
      let c = jit(base, ((h2(course, uu / 5 | 0, seed) % 5) - 2) * 0.03);
      c = cc === 0 ? dk(c, 0.34) : cc === 1 ? lt(c, 0.26) : cc === 2 ? lt(c, 0.1) : cc === 4 ? dk(c, 0.12) : c;
      if (rr < 1) c = cc === 0 ? dk(c, 0.3) : lt(c, 0.2);
      else if (rr >= 4) c = dk(c, 0.22);
      return c;
    }
    if (mat === 'slate') { // thin staggered slates, cool and varied
      const C = 3, course = Math.floor(r / C), rr = r - course * C, uu = Math.floor(u) + (course % 3) * 2 + 600, cell = Math.floor(uu / 5), cc = uu - cell * 5;
      const v = h2(course, cell, seed) % 9;
      let c = jit(base, (v - 4) * 0.025);
      if (v === 0) c = mix(c, rgb('#6f86a6'), 0.2);
      if (cc === 0) c = dk(c, 0.34); else if (rr < 1) c = lt(c, 0.2); else if (rr >= 2) c = dk(c, 0.15);
      return c;
    }
    if (mat === 'lead') { // lead sheets: standing seams with a lit edge, a soft sheen, a lap line now and then
      const uu = Math.floor(u) + 600, cc = uu % 5, course = Math.floor(r / 9);
      let c = jit(base, ((h2(uu / 5 | 0, course, seed) % 5) - 2) * 0.025);
      if (cc === 0) c = lt(c, 0.24); else if (cc === 1) c = dk(c, 0.16);
      if (Math.floor(r) % 9 === 0) c = dk(c, 0.12);
      return c;
    }
    // thatch: layered bundles, each with a ragged lit lip and a shadow under the next; straw streaks
    const C = 4, course = Math.floor(r / C), rr = r - course * C, uu = Math.floor(u) + 600 + course * 2;
    const streak = h2(uu, course, seed) % 6, gap = h2(Math.floor(uu / 3), course, seed + 9) % 4 === 0 && uu % 3 === 0;
    let c = streak === 0 ? dk(base, 0.14) : streak === 1 ? lt(base, 0.14) : base;
    if (rr < 1) c = gap ? dk(base, 0.42) : lt(base, 0.3);
    else if (rr < 2) c = gap ? dk(base, 0.2) : lt(c, 0.12);
    else if (rr >= 3) c = dk(c, 0.26);
    return c;
  };
  // A roof face: the courses, a fascia board along the eave, barge boards up the gables, a ridge cap.
  const roofMat = (shade, edge, along = 'x', opt = {}) => (q) => {
    const { row: r, rmax, P } = q, mat = mm(opt.mat ?? st.roof);
    let base = opt.base ?? RB;
    const u = along === 'x' ? P[0] * s : -P[1] * s;
    let c;
    if (edge && edge(P)) c = st.hall || opt.gild ? (edge(P, 0.6) ? dk(GOLD, 0.2) : GOLD) : st.sty === 3 ? (edge(P, 0.6) ? dk(st.wood, 0.2) : Math.floor(r) % 3 === 0 ? lt(st.wood, 0.3) : st.wood) : (edge(P, 0.6) ? TR[1] : TR[3]); // barge board (carved on the alpine family)
    else if (st.sty === 5 && mat === 'thatch' && !opt.noCap && r > rmax - 6 && rmax - r < 3 + Math.abs(((Math.floor(u) + 600) % 8) - 4) * 0.55) { // a block-cut ridge, scalloped
      const rr = rmax - r, bot = 3 + Math.abs(((Math.floor(u) + 600) % 8) - 4) * 0.55;
      c = rr < 1.2 ? lt(base, 0.14) : rr > bot - 1 ? dk(base, 0.42) : lt(base, 0.04);
    } else if (mat === 'thatch' && r < 2.5) c = r < 1 ? dk(base, 0.5) : h2(Math.floor(u), 1, st.seed) % 2 ? dk(base, 0.25) : lt(base, 0.1); // the thick, ragged eave
    else if (!opt.noCap && r > rmax - 3) { // ridge cap
      const rr = rmax - r;
      if (st.ridgeC && mat !== 'thatch') base = mix(base, st.ridgeC, 0.6);
      c = mat === 'thatch' ? (rr < 1.5 ? lt(base, 0.05) : dk(base, 0.3)) : rr < 1 ? lt(base, 0.32) : rr < 2 ? (Math.floor(u + 600) % 6 === 0 ? dk(base, 0.25) : lt(base, 0.08)) : dk(base, 0.38);
    } else c = roofTex(mat, u, r + 1, rmax, base);
    return [dk(c, shade), 0];
  };

  // ---------- solids ----------
  function box(x0, x1, y0, y1, z0, z1, mS, mE, mT) {
    face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], 'S', mS);
    face([[x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1]], 'E', mE);
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 'S', mT);
  }
  const flat = c => () => [c, 0];
  const cyl = (cx, cy, r, z0, z1, mat) => faces.push({ cyl: [cx, cy, r, z0, z1], mat });
  const ball = (cx, cy, cz, r, mat) => faces.push({ sphere: [cx, cy, cz, r], mat });
  // A barrel: staves lit by their facing, two hoops, a lid.
  const barrel = (x, y) => cyl(x, y, 2.6, 0, 7, q => {
    if (q.cap) { const d = Math.hypot(q.P[0] - x, q.P[1] - y); return [d > 1.9 ? dk(WOOD, 0.35) : h2(Math.floor(q.P[0] * 2), 0, 1) % 2 ? WOOD : lt(WOOD, 0.1), 0]; }
    const zi = Math.floor(q.z), hoop = zi === 1 || zi === 5;
    const c = byLight(ramp(hoop ? rgb('#6b6a72') : WOOD), q.N, 0.15);
    return [Math.floor(q.ang * 8) % 2 && !hoop ? dk(c, 0.1) : c, 0];
  });
  const crate = (x, y, sz = 5) => {
    const m = sh => q => { const zi = Math.floor(q.z), c = q.col <= 0 || q.col >= sz - 1 || zi <= 0 || zi >= sz - 1 ? DARKWOOD : zi % 2 ? WOOD : lt(WOOD, 0.12); return [dk(c, sh), 0]; };
    box(x, x + sz * 1.25, y, y + sz * 1.25, 0, sz, m(0), m(0.22), q => [((Math.floor(q.P[0]) + Math.floor(q.P[1])) % 3 === 0) ? dk(WOOD, 0.1) : lt(WOOD, 0.2), 0]);
  };
  const pot = (x, y, flowers) => {
    cyl(x, y, 2, 0, 3.5, q => [q.cap ? dk(SOIL, 0.3) : byLight(ramp(POT), q.N, 0.1), 0]);
    ball(x, y, 6, 3, q => { const k = h2(Math.floor(q.P[0] * 1.6), Math.floor(q.P[2] * 1.6), st.seed); if (flowers && k % 6 === 0 && lightOf(q.N) > 0) return [FLOWERS[(k >>> 5) % FLOWERS.length], 0]; return [byLight(ramp(LEAF), q.N, k % 4 === 0 ? 0.25 : 0), 0]; });
  };
  const bush = (x, y, r) => ball(x, y, r * 0.7, r, q => { const k = h2(Math.floor(q.P[0] * 1.4), Math.floor(q.P[2] * 1.4), st.seed + 3); if (k % 9 === 0 && lightOf(q.N) > 0.1) return [FLOWERS[(k >>> 5) % FLOWERS.length], 0]; return [byLight(ramp(dk(LEAF, 0.05)), q.N, k % 3 === 0 ? 0.2 : 0), 0]; });
  // The soft contact shadow and ambient occlusion round the footprint, falling east (away from the light).
  const groundShadow = (gx0 = 0, gx1 = W, gy0 = 0, gy1 = D) => face([[gx0 - 1.5, gy0 - 1.5, 0], [gx1 + 5, gy0 - 1.5, 0], [gx1 + 5, gy1 + 3.5, 0], [gx0 - 1.5, gy1 + 3.5, 0]], 'S', q => {
    const [x, y] = q.P, ex = x - gx1, sy = y - gy1;
    let a = 0;
    if (ex > 0 && y > gy0 - 1 && y < gy1 + 2) a = ex < 1.5 ? 0.42 : ex < 3.2 ? 0.28 : 0.14; // the east side, in its own shade
    if (sy > 0 && x < gx1 + 2) a = Math.max(a, sy < 1.3 ? 0.36 : sy < 2.6 ? 0.2 : 0);
    if (x < gx0 || y < gy0) a = Math.max(a, 0.18);
    return [SHADE, 0, a];
  }, { soft: true });

  // The roof's thickness: a fascia board under each eave you can see, and barge boards up each gable
  // you can see (gold on the lodge). These are what make the roof read as chunky rather than paper.
  const TH = 2;
  const mm = m => (st.mats ? st.mats[m] ?? m : m); // a family's roof material for the one a look asks for
  const board = (sh, gold) => q => { const zi = Math.floor(q.z), rr = q.row; const rp = gold ? ramp(GOLD) : TR; return [dk(rr > TH - 1.2 ? rp[3] : rp[2], sh), 0]; };
  const fasciaS = (x0, x1, y, z, sh = 0, mat = st.roof) => mm(mat) !== 'thatch' && face([[x0, y, z - TH], [x1, y, z - TH], [x1, y, z], [x0, y, z]], 'S', board(sh));
  const fasciaE = (x, y0, y1, z, sh = 0.3, mat = st.roof) => mm(mat) !== 'thatch' && face([[x, y1, z - TH], [x, y0, z - TH], [x, y0, z], [x, y1, z]], 'E', board(sh));
  // A gable rake strip in the plane x = X (dir 'E') or y = Y (dir 'S'), from eave a to ridge m to eave b.
  const rake = (dir, pts, sh, gild) => { for (let i = 0; i < pts.length - 1; i++) { const [a, b] = [pts[i], pts[i + 1]]; face([[...a.slice(0, 2), a[2] - TH], [...b.slice(0, 2), b[2] - TH], b, a], dir, board(sh, st.hall || gild)); } };
  // ---------- geometry ----------
  const out = { windows: [], door: null, ridge: null, chimney: null, finial: null };
  const colsS = Math.round(W * s), colsE = Math.round(D * s);
  if (site) buildSite();
  else if (st.kit) { /* built below, once the kit is defined */ }
  else {
    groundShadow();
    const doorU = Math.min(W - 8, Math.max(8, it.doorX ?? W / 2)), dc = Math.round(doorU * s);
    const barn = st.arch === 'workshop';
    const dh = st.hall ? 18 : barn ? 16 : st.arch === 'hut' ? 10 : 13, dw = st.hall ? 11 : barn ? 15 : 7;
    fittings.push({ face: 'S', kind: 'door', c0: dc - (dw >> 1), c1: dc - (dw >> 1) + dw - 1, z1: dh, dbl: st.hall, barn });
    out.door = Q(doorU, D, 0);
    const lampR = st.lamp || st.hall;
    if (lampR) fittings.push({ face: 'S', kind: 'lamp', c0: dc + (dw >> 1) + 3, z0: dh - 7 });
    if (st.hall) fittings.push({ face: 'S', kind: 'lamp', c0: dc - (dw >> 1) - 5, z0: dh - 7 });
    if (st.sign) fittings.push({ face: 'S', kind: 'sign', c0: dc + (dw >> 1) + 3, z0: dh - 8 });
    // Windows along each wall, spaced evenly in the stretches the door (and its lamp or sign) leave free;
    // two-storey buildings get a second row.
    const towerish = st.arch === 'tower', wd = towerish ? 5 : 7, ht = towerish ? 7 : st.arch === 'hut' ? 6 : 8, pad = st.shutters ? 6 : 4;
    const rows = towerish ? [8, 19] : st.split < 99 ? [7, st.split + 3] : [st.arch === 'hut' ? 6 : 7];
    const fill = (a, b) => { const len = b - a, n = len < wd + 2 ? 0 : Math.max(1, Math.floor((len + 4) / (wd + (st.shutters ? 6 : 0) + 7))); return Array.from({ length: n }, (_, i) => Math.round(a + len * (i + 0.5) / n)); };
    const gapL = dc - (dw >> 1) - (st.hall ? 8 : 3), gapR = dc + (dw >> 1) + (lampR || st.sign ? 11 : 3);
    for (const z0 of rows) {
      const nearDoor = z0 < dh + 3;
      const sCols = st.hall && nearDoor ? [7, colsS - 8] : nearDoor ? [...fill(pad, gapL - pad), ...fill(gapR + pad, colsS - pad)] : fill(pad, colsS - pad);
      for (const c of sCols) win('S', c, z0, wd, ht);
      for (const c of fill(pad, colsE - pad)) win('E', c, z0, wd, ht);
    }
    if (st.hall) { // banners between the upper windows
      fittings.push({ face: 'S', kind: 'banner', c0: 4, z0: st.split + 5 }, { face: 'S', kind: 'banner', c0: colsS - 9, z0: st.split + 5 });
    }
    for (const f of fittings) if (f.kind === 'win') {
      const cc = (f.c0 + f.c1) / 2, zc = (f.z0 + f.z1) / 2;
      out.windows.push(f.face === 'S' ? Q(cc / s, D, zc) : Q(W, D - cc / s, zc));
    }
    // A porch roof over the door on some houses (and the lodge): a little shed roof on two posts.
    let awn = null;
    if (st.porch) {
      const half = st.hall ? 11 : 7, x0 = doorU - half, x1 = doorU + half, zt = dh + 5, zb = dh + 2, dep = st.hall ? 7 : 6;
      awn = [Math.round(x0 * s), Math.round(x1 * s), zt];
      face([[x0, D + dep, zb], [x1, D + dep, zb], [x1, D, zt], [x0, D, zt]], 'S', roofMat(-0.06, null, 'x', { noCap: true, mat: st.roof === 'thatch' ? 'shingle' : st.roof }));
      face([[x1, D + dep, zb], [x1, D, zt], [x1, D, zb]], 'E', flat(dk(TR[1], 0.2))); // its side
      const post = px => box(px - 0.8, px + 0.8, D + dep - 1.6, D + dep, 0, zb, q => [q.col === 0 ? TR[3] : TR[2], 0], flat(TR[1]), flat(TR[3]));
      post(x0 + 1); post(x1 - 1);
    }
    // Walls.
    const eaveS = st.roofShape !== 'gable' || st.ridge === 'EW', eaveE = st.roofShape !== 'gable' || st.ridge === 'NS';
    face([[0, D, 0], [W, D, 0], [W, D, H], [0, D, H]], 'S', wallMat('S', colsS, 0, { eave: eaveS, awn }), { col0: -D * s });
    face([[W, D, 0], [W, 0, 0], [W, 0, H], [W, D, H]], 'E', wallMat('E', colsE, 0.3, { eave: eaveE }), { col0: (W - D) * s });
    // The step in front of the door, and a doormat.
    const sw = st.hall ? 8 : barn ? 9 : 5;
    const stone = (sh) => q => { const k = h2(Math.floor(q.P[0] / 3), 0, st.seed); return [dk(jit(FOOT[2], (k % 3 - 1) * 0.06), sh), 0]; };
    box(doorU - sw, doorU + sw, D, D + (st.hall ? 7 : 3), 0, 2, stone(0.05), stone(0.3), q => [Math.floor(q.P[0] * s) % 5 === 0 ? FOOT[1] : FOOT[3], 0]);
    if (st.hall) box(doorU - sw + 2, doorU + sw - 2, D, D + 3.5, 2, 4, stone(0), stone(0.28), flat(FOOT[3]));
    if (!barn) { const mw = st.hall ? 5 : 3.5, mz = st.hall ? 4 : 2; box(doorU - mw, doorU + mw, D + 0.3, D + 2.6, mz, mz + 0.5, flat(dk(accent, 0.45)), flat(dk(accent, 0.5)), q => [Math.floor(q.P[0] * s) % 2 ? dk(mix(accent, rgb('#c9a070'), 0.5), 0.2) : mix(accent, rgb('#c9a070'), 0.5), 0]); }
    props(doorU, sw);
    if (st.roofShape === 'gable') gableRoof();
    else if (st.roofShape === 'spire') { const ap = [W / 2, D / 2, H + R + 8]; pyramid(-e, W + e, -e, D + e, H - e * 0.6, ap); out.ridge = Q(...ap); }
    else dome();
  }

  // Yard dressing in front of the house: a garden patch with a picket fence, a bench, barrels and crates,
  // potted plants by the door, a mailbox, a bush. Picked from the id; kept to the front strip (never
  // further out than a villager's yard row) and a few at a time, so the villagers stay the focus.
  function props(doorU, sw) {
    const p = st.props, zL = [3, doorU - sw - 5], zR = [doorU + sw + 5, W - 3];
    const room = z => z[1] - z[0];
    const used = [];
    const pick = (need) => { for (const z of [zR, zL]) if (!used.includes(z) && room(z) >= need) { used.push(z); return z; } return null; };
    if (st.arch === 'workshop' || st.arch === 'tower') {
      const z = pick(10); if (z) { barrel(z[1] - 3, D + 4); barrel(z[1] - 8.5, D + 3.4); crate(z[1] - 6, D + 0.5); }
      const z2 = pick(8); if (z2) { crate(z2[0], D + 1); if (p & 1) crate(z2[0] + 1, D + 1, 3.5); }
      return;
    }
    if (st.hall) {
      pot(doorU - sw - 3, D + 4, true); pot(doorU + sw + 3, D + 4, true);
      bush(4, D + 3, 3.2); bush(W - 4, D + 3, 3.2);
      return;
    }
    if (!st.porch && (p & 3) !== 0) { pot(doorU - sw - 2.5, D + 3, p & 4); if (p & 8) pot(doorU + sw + 2.5, D + 3, true); }
    if ((p >>> 4) % 3 === 0) { // a garden patch with a picket fence
      const z = pick(14);
      if (z) {
        const x0 = z[0], x1 = Math.min(z[1], x0 + 20), y0 = D + 1.5, y1 = D + 7.5;
        box(x0, x1, y0, y1, 0, 0.8, flat(dk(SOIL, 0.2)), flat(dk(SOIL, 0.35)), q => {
          const row = Math.floor((q.P[1] - y0) / 2), k = h2(Math.floor(q.P[0] * s), row, st.seed);
          if ((q.P[1] - y0) % 2 < 0.9) return [dk(SOIL, 0.25), 0];
          return [k % 3 === 0 ? lt(LEAF, 0.15) : k % 3 === 1 ? LEAF : lt(SOIL, 0.1), 0];
        });
        const pk = q => [Math.floor(q.z) >= 3 ? lt(rgb('#f2ead8'), 0.1) : rgb('#e4d8bf'), 0];
        for (let x = x0; x <= x1; x += 2.6) box(x, x + 1.1, y1, y1 + 1.1, 0, 4, pk, flat(rgb('#b9ab92')), flat(rgb('#fff6e0')));
        box(x0, x1 + 1.1, y1 + 0.2, y1 + 0.9, 1.8, 2.6, flat(rgb('#d9ccb2')), flat(rgb('#b9ab92')), flat(rgb('#f2ead8')));
      }
    }
    if ((p >>> 6) % 2 === 0) { // a bench against the wall
      const z = pick(12);
      if (z) {
        const x0 = z[0] + 1, x1 = x0 + 10;
        box(x0, x1, D + 0.5, D + 3.5, 3, 4, flat(dk(WOOD, 0.15)), flat(dk(WOOD, 0.3)), q => [Math.floor(q.P[1]) % 2 ? lt(WOOD, 0.15) : WOOD, 0]);
        for (const x of [x0 + 0.5, x1 - 1.8]) box(x, x + 1.3, D + 2, D + 3.3, 0, 3, flat(DARKWOOD), flat(dk(DARKWOOD, 0.2)), flat(DARKWOOD));
      }
    }
    if ((p >>> 5) % 2 === 1) { const z = pick(8); if (z) { barrel(z[1] - 3, D + 4); if (p & 2) crate(z[1] - 9, D + 1, 4); } }
    if ((p >>> 7) === 1 && doorU + 12 < W - 2 && !used.includes(zR)) { // a mailbox by the path
      const x = doorU + 11, y = D + 6.5;
      box(x - 0.6, x + 0.6, y - 0.6, y + 0.6, 0, 6, flat(WOOD), flat(dk(WOOD, 0.3)), flat(WOOD));
      box(x - 1.6, x + 1.6, y - 2.2, y + 1.2, 6, 8.5, flat(dk(accent, 0.1)), flat(dk(accent, 0.35)), flat(lt(accent, 0.2)));
    }
    if (!used.length) { const z = pick(6); if (z) bush(z === zL ? z[0] + 3 : z[1] - 3, D + 3, 2.8); }
  }
  function pyramid(x0, x1, y0, y1, z0, ap) {
    face([[x0, y1, z0], [x1, y1, z0], ap], 'S', roofMat(-0.04, null, 'x', { noCap: true }));
    face([[x1, y1, z0], [x1, y0, z0], ap], 'E', roofMat(0.18, null, 'y', { noCap: true }));
    face([[x0, y0, z0], [x1, y0, z0], ap], 'S', roofMat(0.3, null, 'x', { noCap: true }));
    face([[x0, y0, z0], [x0, y1, z0], ap], 'E', roofMat(0.3, null, 'y', { noCap: true }));
  }
  function dome() {
    const cx = W / 2, cy = D / 2, r = Math.min(W, D) / 2 + 2, z0 = H;
    // A flat stone roof with a parapet rim, the dome sitting on it.
    face([[-1, -1, H], [W + 1, -1, H], [W + 1, D + 1, H], [-1, D + 1, H]], 'S', q => [q.P[0] < 1 || q.P[1] < 1 || q.P[0] > W - 1 || q.P[1] > D - 1 ? FOOT[1] : FOOT[3], 0]);
    const DR = ramp(RB);
    ball(cx, cy, z0, r, q => {
      const zz = q.P[2] - z0, band = Math.floor(zz / 3), rib = Math.floor((q.ang * 12) % 12);
      let c = byLight(DR, q.N, 0.1);
      if (zz < 1.2) c = DR[0]; else if (Math.floor(zz) % 3 === 0) c = dk(c, 0.2); else if (rib % 3 === 0 && band % 2) c = dk(c, 0.1);
      return [c, 0];
    });
    out.ridge = Q(cx, cy, z0 + r);
  }
  // A roof over the box: a gable (ridge east–west or north–south, by the building's style) or a hip.
  function gableRoof() {
    const ridgeEW = st.ridge === 'EW';
    const half = (ridgeEW ? D : W) / 2, k = R / half, zr = H + R, zE = H - e * k;
    if (ridgeEW) {
      const ym = D / 2;
      const barge = (P, w = 1.1) => P[0] < -e + w || P[0] > W + e - w;
      if (st.hip) {
        const xa = half, xb = W - half;
        face([[-e, D + e, zE], [W + e, D + e, zE], [xb, ym, zr], [xa, ym, zr]], 'S', roofMat(-0.04, null, 'x'));
        face([[-e, -e, zE], [W + e, -e, zE], [xb, ym, zr], [xa, ym, zr]], 'S', roofMat(0.3, null, 'x'));
        face([[W + e, D + e, zE], [W + e, -e, zE], [xb, ym, zr]], 'E', roofMat(0.18, null, 'y', { noCap: true }));
        face([[-e, D + e, zE], [-e, -e, zE], [xa, ym, zr]], 'E', roofMat(0.32, null, 'y', { noCap: true }));
        out.ridge = Q(xb, ym, zr);
        fasciaS(-e, W + e, D + e, zE); fasciaE(W + e, -e, D + e, zE);
      } else {
        face([[-e, -e, zE], [W + e, -e, zE], [W + e, ym, zr], [-e, ym, zr]], 'S', roofMat(0.3, barge, 'x'));
        face([[W, 0, H], [W, D, H], [W, ym, zr]], 'E', wallMat('EG', colsE, 0.3, { gable: true }), { col0: (W - D) * s }); // the east gable end
        face([[-e, D + e, zE], [W + e, D + e, zE], [W + e, ym, zr], [-e, ym, zr]], 'S', roofMat(-0.04, barge, 'x'));
        fasciaS(-e, W + e, D + e, zE);
        rake('E', [[W + e, D + e, zE], [W + e, ym, zr], [W + e, -e, zE]], 0.3);
        out.ridge = Q(W * 0.72, ym, zr);
        if (H < 28 && colsE > 22) fittings.push({ face: 'EG', kind: 'round', c0: Math.round(colsE / 2) - 3, c1: Math.round(colsE / 2) + 3, z0: H + 3, z1: H + 9 });
      }
      if (st.chimney) chimney(W * (st.seed % 2 ? 0.22 : 0.7), D * 0.24, zr);
    } else {
      const xm = W / 2;
      const barge = (P, w = 1.1) => P[1] < -e + w || P[1] > D + e - w;
      face([[-e, -e, zE], [-e, D + e, zE], [xm, D + e, zr], [xm, -e, zr]], 'E', roofMat(0.3, barge, 'y'));
      face([[0, D, H], [W, D, H], [xm, D, zr]], 'S', wallMat('SG', colsS, 0, { gable: true }), { col0: -D * s }); // the south gable end
      face([[W + e, -e, zE], [W + e, D + e, zE], [xm, D + e, zr], [xm, -e, zr]], 'E', roofMat(0.16, barge, 'y'));
      fasciaE(W + e, -e, D + e, zE);
      rake('S', [[-e, D + e, zE], [xm, D + e, zr], [W + e, D + e, zE]], 0);
      out.ridge = Q(xm, D * 0.7, zr);
      if (st.hall) { // a round window high in the front gable, and a cupola with a gold finial on the ridge
        fittings.push({ face: 'SG', kind: 'round', c0: Math.round(colsS / 2) - 4, c1: Math.round(colsS / 2) + 4, z0: H + 5, z1: H + 13 });
        const cy = D * 0.45, zc = zr - 2;
        const WH = ramp(rgb('#efe3c6'));
        const louvre = (sh) => q => { const zi = Math.floor(q.z); return [dk(zi > zc + 2 && zi < zc + 7 && q.col > 1 && q.col < 5 ? ((zi % 2) ? WH[0] : WH[1]) : q.col === 0 ? WH[3] : WH[2], sh), 0]; };
        box(xm - 4, xm + 4, cy - 4, cy + 4, zr - 8, zc + 9, louvre(0), louvre(0.22), flat(WH[3]));
        const ap = [xm, cy, zc + 19];
        pyramid(xm - 6, xm + 6, cy - 6, cy + 6, zc + 9, ap);
        out.finial = Q(...ap);
        out.ridge = Q(xm, cy, zc + 24);
      } else {
        if (colsS > 22) fittings.push({ face: 'SG', kind: 'round', c0: Math.round(colsS / 2) - 3, c1: Math.round(colsS / 2) + 3, z0: H + 3, z1: H + 9 });
        if (st.chimney) chimney(W * 0.24, D * (st.seed % 2 ? 0.3 : 0.72), zr);
      }
    }
  }
  function chimney(x, y, zr, zb = H - 2, B0 = null, tall = 5, rad = 3) {
    if (st.sty && !st.civic) { // the family's chimney: low and white, big and stone, brick
      B0 = st.sty === 4 ? dk(st.paint, 0.08) : rgb(st.SY.chim);
      if (st.sty === 1) tall = Math.min(tall, 3); else if (st.sty === 2) { rad += 1; tall += 2; }
    }
    const B = B0 ?? (st.pr || st.hall || st.lower === 'stone' ? rgb('#9d9486') : rgb('#a95b3e')), z1 = zr + tall;
    const bricks = sh => q => {
      const zi = Math.floor(q.z), row = Math.floor(zi / 3), u = q.col + (row % 2) * 2;
      const c = zi % 3 === 0 || u % 4 === 0 ? dk(B, 0.28) : zi % 3 === 2 ? lt(B, 0.14) : B;
      return [dk(c, sh), 0];
    };
    box(x - rad, x + rad, y - rad, y + rad, zb, z1, bricks(0), bricks(0.24), flat(B));
    box(x - rad - 1, x + rad + 1, y - rad - 1, y + rad + 1, z1, z1 + 2, flat(lt(FOOT[2], 0.05)), flat(FOOT[1]), q => [q.P[0] > x - rad + 1 && q.P[0] < x + rad - 1 && q.P[1] > y - rad + 1 && q.P[1] < y + rad - 1 ? OUTLINE : FOOT[3], 0]); // the cap
    out.chimney = Q(x, y, z1 + 3);
  }
  // A building site: a stone foundation and plank floor, framed walls to a ragged half height (all four
  // show, the roof isn't on yet), with corner posts and a roof truss drawn over the top.
  function buildSite() {
    const hw = Math.round(H * 0.45), wood = rgb('#c98a4a'), raw = rgb('#dcb47c');
    const cut = col => hw - (h2(Math.floor(col / 3), 0, st.seed) % 5);
    groundShadow();
    box(-2, W + 2, -2, D + 2, 0, 3, q => [Math.floor(q.z) < 1 ? FOOT[0] : (q.col % 5 === 0 ? FOOT[1] : FOOT[2]), 0], q => [dk(Math.floor(q.z) < 1 ? FOOT[0] : FOOT[2], 0.2), 0], q => [(Math.floor(q.P[0] + q.P[1]) % 4 === 0) ? dk(raw, 0.25) : raw, 0]);
    const studs = sh => q => { const zi = Math.floor(q.z); const c = (q.col % 4 === 0 || zi === 4) ? dk(wood, 0.2) : (zi - 4) % 3 === 0 ? dk(raw, 0.15) : raw; return [dk(c, sh), 0]; };
    const keep = (P, col) => P[2] <= 3 + cut(col); // the ragged top: what isn't built yet is see-through
    face([[0, 0, 3], [W, 0, 3], [W, 0, 3 + hw], [0, 0, 3 + hw]], 'S', studs(0.12), { col0: 0, keep });
    face([[0, 0, 3], [0, D, 3], [0, D, 3 + hw], [0, 0, 3 + hw]], 'E', studs(0.3), { col0: -D * s, keep });
    face([[0, D, 3], [W, D, 3], [W, D, 3 + hw], [0, D, 3 + hw]], 'S', studs(0), { col0: -D * s, keep });
    face([[W, D, 3], [W, 0, 3], [W, 0, 3 + hw], [W, D, 3 + hw]], 'E', studs(0.2), { col0: (W - D) * s, keep });
    out.lines = [];
    const hi = H + 4, ym = D / 2;
    for (const [x, y] of [[0, 0], [W, 0], [0, D], [W, D]]) out.lines.push([[x, y, 3], [x, y, hi]]);
    out.lines.push([[0, D, hi], [W, D, hi]], [[W, D, hi], [W, 0, hi]], [[0, 0, hi], [W, 0, hi]], [[0, 0, hi], [0, D, hi]]);
    for (const x of [0, W / 2, W]) out.lines.push([[x, 0, hi], [x, ym, hi + R]], [[x, D, hi], [x, ym, hi + R]]);
    out.lines.push([[0, ym, hi + R], [W, ym, hi + R]]);
    out.ridge = Q(W / 2, ym, hi + R);
  }

  // ======================================================================================================
  // The kit (the newer looks): named wall faces carrying fittings, storeys with jetties, roofs of every
  // kind, dormers, prisms and cones (towers, spires, the windmill), crenellations. Everything lands in the
  // same depth buffer, so pieces may simply intersect (a dormer into a roof, a tower into a nave).
  // ======================================================================================================
  const finfo = {};
  let fmap = null, nD = 0;
  const fitsOf = name => { if (!fmap) { fmap = {}; for (const f of fittings) (fmap[f.face] ||= []).push(f); } return fmap[name] || NOFIT; };
  const vb = (n, m) => (st.h >>> n) % m;
  const fpt = (name, c, z) => { const F = finfo[name]; return F.dir === 'S' ? Q(F.x0 + (c + 0.5) / s, F.Y, z) : Q(F.X, F.y1 - (c + 0.5) / s, z); };
  const dU = (lo = 8, hi = W - 8) => Math.min(hi, Math.max(lo, it.doorX ?? W / 2));
  const shOf = N => { const n = Math.hypot(N[0], N[1], N[2]) || 1, d = (N[0] * L[0] + N[1] * L[1] + N[2] * L[2]) / n; return Math.round(Math.max(-0.08, Math.min(0.42, 0.159 - 0.256 * d)) / 0.04) * 0.04; };
  const shade = (c, sh) => sh >= 0 ? dk(c, sh) : lt(c, -sh);
  const STR = ramp(lt(st.civic ? st.paint : STONE, 0.18)); // dressed stone round arches, roses and slits
  const STAIN = [lt(accent, 0.05), rgb('#3d5aa0'), rgb('#a33c3c'), rgb('#d4a23c'), rgb('#3f8a5c')];
  const IRON = rgb('#4a4652');

  // Half-timbering: a sill and a head rail, posts every P columns, and the panel figure between them.
  const frameAt = (pat, col, zi, z0, z1, P) => {
    if (zi <= z0 + 1 || zi >= z1 - 1) return 1;
    const p = ((col % P) + P) % P;
    if (p === 0) return 2;
    if (p === 1) return 1;
    const n = P - 2, x = p - 1.5, rel = (zi - z0 - 1.5) / Math.max(1, z1 - z0 - 3), panel = Math.floor(col / P);
    switch (pat) {
      case 0: { const k = panel & 1 ? 1 - rel : rel; return Math.abs(x - k * n) < 0.9 ? 1 : 0; } // a brace, alternating
      case 1: return Math.abs(x - rel * n) < 0.8 || Math.abs(x - (1 - rel) * n) < 0.8 ? 1 : 0; // St Andrew's crosses
      case 2: { const hf = n / 2; return (Math.abs(Math.abs(x - hf) - rel * hf) < 0.8 && rel > 0.08) || zi === z0 + Math.round((z1 - z0) * 0.45) ? 1 : 0; } // a rail and fans
      default: return x % 4 < 1 || zi === z0 + ((z1 - z0) >> 1) ? 1 : 0; // close studding with a mid rail
    }
  };
  // A kit wall's material: fittings first, then the plinth, half-timbering or texture, quoins or posts,
  // belt courses, the shadow under a jetty or the eaves; lit faces stay as they are, the rest shade.
  // A styled look's wall: the same storey/gable code, re-materialled for the family (planks and boards stay).
  const restyle = o => {
    const t0 = o.tex ?? 'plaster';
    if (t0 === 'planks' || t0 === 'boards' || o.keep) return o;
    let tex = t0, paint = o.paint ?? st.paint;
    if (paint === SAND) paint = st.dressC; else if (paint === GREY) paint = st.rubbleC;
    const up = (o.zb ?? 0) >= 12, house = !st.civic;
    switch (st.sty) {
      case 1: tex = t0 === 'ashlar' ? 'ashlar' : 'white'; break;
      case 2: tex = t0 === 'ashlar' || !house ? 'ashlar' : 'stoneP'; break;
      case 3: if (house && up) { tex = 'planks'; paint = st.wood; } else if (t0 !== 'logs') tex = 'white'; break;
      case 4: tex = 'brickP'; if (paint === st.dressC || paint === LIME) paint = st.paint; break;
      case 5: tex = t0 === 'logs' || t0 === 'ashlar' ? t0 : 'white'; break;
    }
    return { ...o, tex, paint, beam: o.beam ?? st.beam };
  };
  const wm = (name, o) => {
    if (st.sty) o = restyle(o);
    const sh = o.shade ?? 0, paint = o.paint ?? st.paint, cols = o.cols ?? 99, zb = o.zb ?? 0, zt = o.zt ?? 1e4, tb = zb + (o.foot ? FOOT_H : 0), P = o.P ?? 12;
    const beam = o.beam ?? st.beam ?? BEAM, BL = lt(beam, 0.16), fr = o.frame != null && o.frame >= 0 ? o.frame : -1;
    const quo = o.corner === 'quoin' ? lt(o.quoinC ?? SAND, 0.06) : null;
    return q => {
      const col = q.col, zi = Math.floor(q.z);
      let c = null, g = 0;
      for (const f of fitsOf(name)) { const p = paintFitting(f, col, zi); if (p) { c = p[0]; g = p[1]; break; } }
      if (!c) {
        if (o.foot && zi < tb) {
          const u = col + 600, cell = Math.floor(u / 6), cc = u - cell * 6, b = jit(FOOT[2], ((h2(cell, 0, st.seed) % 5) - 2) * 0.06), r = zi - zb;
          c = r <= 0 || cc === 0 ? FOOT[0] : r === 3 ? (cc === 1 ? b : lt(b, 0.22)) : r === 1 ? dk(b, 0.14) : b;
        } else {
          const k = fr >= 0 ? frameAt(fr, col, zi, tb, zt, P) : 0;
          c = k ? (k === 2 ? BL : beam) : wallTex(o.tex ?? 'plaster', col, zi, cols, false, paint, tb);
          if (o.jet && zi <= zb + 1) c = zi === zb ? (col % 5 < 2 ? lt(beam, 0.3) : dk(beam, 0.35)) : beam; // joist ends under the jetty
          else if (o.foot && zi === tb) c = dk(c, 0.18);
          if (o.belts) for (const bz of o.belts) { if (zi === bz) c = lt(paint, 0.24); else if (zi === bz - 1) c = dk(paint, 0.3); }
          if (o.corner === 'post' && (col <= 1 || col >= cols - 2)) c = col === 0 || col === cols - 2 ? TR[3] : TR[1];
          else if (quo && zi >= tb) { const blk = Math.floor((zi - tb) / 5), wq = blk & 1 ? 4 : 2, rr = (zi - tb) % 5; if (col < wq || col >= cols - wq) c = rr === 0 ? dk(quo, 0.3) : rr === 4 ? lt(quo, 0.14) : quo; }
        }
      }
      if (!g && o.under && zi >= zt - o.under) c = dk(c, zi >= zt - 2 ? 0.36 : 0.2);
      if (!g && o.eave && zi >= zt - o.eave) c = dk(c, zi >= zt - 3 ? 0.38 : 0.24);
      return g ? [c, g] : [shade(c, sh), 0];
    };
  };
  function wallS(name, x0, x1, Y, z0, z1, o = {}) {
    const cols = Math.round((x1 - x0) * s);
    finfo[name] = { dir: 'S', Y, x0, cols };
    face([[x0, Y, z0], [x1, Y, z0], [x1, Y, z1], [x0, Y, z1]], 'S', wm(name, { zb: z0, zt: z1, ...o, cols }), { col0: (x0 - Y) * s });
    return cols;
  }
  function wallE(name, X, y0, y1, z0, z1, o = {}) {
    const cols = Math.round((y1 - y0) * s);
    finfo[name] = { dir: 'E', X, y1, cols };
    face([[X, y1, z0], [X, y0, z0], [X, y0, z1], [X, y1, z1]], 'E', wm(name, { zb: z0, zt: z1, shade: 0.3, ...o, cols }), { col0: (X - y1) * s });
    return cols;
  }
  // Windows spaced evenly along a named face, leaving a gap (the door) free.
  function winRow(name, z0, o = {}) {
    if (st.sty && (o.kind ?? 'win') === 'win') { // the family's windows: arched, small and deep-set, or tall sashes
      o = { ...o };
      if (st.win === 'arched') o.arch = true;
      else if (st.win === 'small') { o.wd = (o.wd ?? 7) - 2; o.ht = (o.ht ?? 8) - 1; o.deep = true; }
      else if (st.win === 'tall') { o.ht = (o.ht ?? 8) + 2; o.panes ??= 3; }
      if (!st.civic) { o.shutters = st.shutters; o.flowers = st.flowers || (st.sty === 1 && !!o.flowers && (st.h >>> 26) % 2 === 0); }
    }
    const cols = finfo[name].cols, wd = o.wd ?? 7, ht = o.ht ?? 8, shut = o.shutters ?? false, pad = o.pad ?? (shut ? 6 : 4), step = wd + (shut ? 6 : 0) + (o.space ?? 7);
    const fill = (a, b) => { const len = b - a; if (len < wd + 2) return []; const n = Math.min(o.max ?? 99, Math.max(1, Math.floor((len + 4) / step))); return Array.from({ length: n }, (_, i) => Math.round(a + len * (i + 0.5) / n)); };
    const cs = o.at ?? (o.gap ? [...fill(pad, o.gap[0] - pad), ...fill(o.gap[1] + pad, cols - pad)] : fill(pad, cols - pad));
    for (const c of cs) fittings.push({ face: name, kind: o.kind ?? 'win', c0: c - (wd >> 1), c1: c - (wd >> 1) + wd - 1, z0, z1: z0 + ht - 1, flowers: o.flowers ?? false, shutters: shut, panes: o.panes, round: o.round, stained: o.stained, goods: o.goods, bell: o.bell, arch: o.arch, deep: o.deep });
    return cs;
  }
  const colOf = (name, x) => { const F = finfo[name]; return F.dir === 'S' ? Math.round((x - F.x0) * s) : Math.round((F.y1 - x) * s); };
  const stoneStep = sh => q => { const k = h2(Math.floor(q.P[0] / 3), Math.floor(q.P[1] / 3), st.seed); return [dk(jit(FOOT[2], (k % 3 - 1) * 0.06), sh), 0]; };
  // The front door on a named south face: the door (or a portal, a barn door), its step, mat and lamp.
  function frontDoor(name, Y, u, o = {}) {
    const dw = o.dw ?? 7, dh = o.dh ?? 13, dc = colOf(name, u), c0 = dc - (dw >> 1), c1 = c0 + dw - 1;
    fittings.push({ face: name, kind: o.kind ?? 'door', c0, c1, z0: 0, z1: dh, dbl: o.dbl, barn: o.barn, round: o.round });
    out.door = Q(u, Y, 0);
    if (o.lamp) fittings.push({ face: name, kind: 'lamp', c0: c1 + 4, z0: dh - 7 });
    if (o.lampL) fittings.push({ face: name, kind: 'lamp', c0: c0 - 6, z0: dh - 7 });
    if (o.board) fittings.push({ face: name, kind: 'board', c0: c1 + 3, z0: dh - 3, glyph: o.board });
    const sw = o.sw ?? 5, sd = o.sd ?? 3;
    if (o.step !== false) box(u - sw, u + sw, Y, Y + sd, 0, 2, stoneStep(0.05), stoneStep(0.3), q => [Math.floor(q.P[0] * s) % 5 === 0 ? FOOT[1] : FOOT[3], 0]);
    if (o.step2) box(u - sw + 2, u + sw - 2, Y, Y + sd - 1.5, 2, 4, stoneStep(0), stoneStep(0.28), flat(FOOT[3]));
    if (st.sty === 1 && !st.civic && o.step !== false) { pot(u - sw - 3, Y + 3.5, true); if (!o.lamp && !o.board) pot(u + sw + 3, Y + 3.5, true); } // potted plants by a Mediterranean door
    if (o.mat) { const mw = 3.5, mz = o.step2 ? 4 : 2; box(u - mw, u + mw, Y + 0.3, Y + 2.6, mz, mz + 0.5, flat(dk(accent, 0.45)), flat(dk(accent, 0.5)), q => [Math.floor(q.P[0] * s) % 2 ? dk(mix(accent, rgb('#c9a070'), 0.5), 0.2) : mix(accent, rgb('#c9a070'), 0.5), 0]); }
    return [c0 - (o.lampL ? 9 : 3), c1 + (o.lamp || o.board ? 12 : 3)];
  }
  // Storeys stacked over x0..x1, y0..y1. A floor with `jet` overhangs the one below to the south (and the
  // east with o.jetE). Faces are named `${name}S${i}` and `${name}E${i}`.
  function storeys(o) {
    let z = o.z0 ?? 0, j = 0, jE = 0;
    const fl = [], nm = o.name ?? '', floors = st.sty && st.sty !== 5 ? o.floors.map(F => (F.jet ? { ...F, jet: 0 } : F)) : o.floors; // only timber jetties
    floors.forEach((F, i) => {
      if (i && F.jet) { j += F.jet; if (o.jetE) jE += F.jet; }
      const next = floors[i + 1], last = i === floors.length - 1, xb = o.x1 + jE, yb = o.y1 + j;
      const m = { tex: F.tex, paint: F.paint, frame: F.frame, beam: F.beam, foot: i === 0 && !o.noFoot, jet: i > 0 && !!F.jet, under: next?.jet ? 4 : 0, belts: F.belts, corner: F.corner, quoinC: F.quoinC, P: F.P };
      const nS = `${nm}S${i}`, nE = `${nm}E${i}`;
      if (!o.noS) wallS(nS, o.x0 - (o.jetW ? j : 0), xb, yb, z, z + F.h, { ...m, eave: last && o.eaveS ? 6 : 0 });
      if (!o.noE) wallE(nE, xb, o.y0, yb, z, z + F.h, { ...m, eave: last && o.eaveE ? 6 : 0 });
      fl.push({ z, h: F.h, nS, nE });
      z += F.h;
    });
    return { fl, z, x0: o.x0 - (o.jetW ? j : 0), x1: o.x1 + jE, y1: o.y1 + j };
  }
  // A roof over x0..x1, y0..y1 from wall top zb: a gable (ridge 'EW' or 'NS'), a hip, or a gambrel (EW).
  // The visible gable end is a wall face named o.gname (default 'G'). Returns what dormers and chimneys need.
  function roof2(o) {
    const { x0, x1, y0, y1, zb } = o, mat = mm(o.mat ?? st.roof), base = o.base ?? RB, gname = o.gname ?? 'G', SY = st.sty ? st.SY : null;
    // A family's pitch and eaves (civic buildings only half as much); stone and canal gables rise as parapets.
    const rk = SY ? (st.civic ? 1 + (SY.rk - 1) * 0.5 : SY.rk) : 1, span = o.ridge === 'EW' ? y1 - y0 : x1 - x0;
    const Rr = SY ? Math.min(o.R * rk, span * 0.95) : o.R, e = SY && !st.civic ? Math.max(1, (o.e ?? 3) + SY.de) : o.e ?? 3;
    const dress = SY && (st.sty === 2 || st.sty === 4) && !o.noDress && !o.gambrel && (!st.civic || st.look === 'inn'), eg = dress ? 0.6 : e;
    const rm = (sh, edge, along, x) => roofMat(sh, edge, along, { mat, base, gild: o.gild, ...x });
    const gm = (cols, sh) => o.gable ? o.gable(gname, cols, sh) : wm(gname, { tex: 'planks', paint: mix(st.paint, WOOD, 0.5), zb, cols, shade: sh });
    if (o.ridge === 'EW') {
      const half = (y1 - y0) / 2, k = Rr / half, zr = zb + Rr, zE = zb - e * k, ym = (y0 + y1) / 2;
      const I = { ridge: 'EW', k, zr, zE, ym, eave: y1 + e, x0, x1, y0, y1, zb, e, mat, base, ridgePt: [x0 + (x1 - x0) * 0.72, ym, zr] };
      if (o.hip) {
        const mid = (x0 + x1) / 2, xa = Math.min(x0 + half, mid), xb = Math.max(x1 - half, mid);
        face([[x0 - e, y1 + e, zE], [x1 + e, y1 + e, zE], [xb, ym, zr], [xa, ym, zr]], 'S', rm(-0.04, null, 'x', { noCap: xa === xb }));
        face([[x0 - e, y0 - e, zE], [x1 + e, y0 - e, zE], [xb, ym, zr], [xa, ym, zr]], 'S', rm(0.3, null, 'x', { noCap: xa === xb }));
        face([[x1 + e, y1 + e, zE], [x1 + e, y0 - e, zE], [xb, ym, zr]], 'E', rm(0.18, null, 'y', { noCap: true }));
        face([[x0 - e, y1 + e, zE], [x0 - e, y0 - e, zE], [xa, ym, zr]], 'E', rm(0.32, null, 'y', { noCap: true }));
        fasciaS(x0 - e, x1 + e, y1 + e, zE, 0, mat); fasciaE(x1 + e, y0 - e, y1 + e, zE, 0.3, mat);
        I.ridgePt = [xb, ym, zr]; I.xa = xa; I.xb = xb;
        return I;
      }
      const barge = (P, w = 1.1) => P[0] < x0 - eg + w || P[0] > x1 + eg - w;
      let prof; // across the roof, north eave to south eave: [y, z]
      if (o.gambrel) {
        const kn = (y1 - y0) * 0.17, zk = zb + Rr * 0.6, kl = (zk - zb) / kn, zEl = zb - e * kl;
        prof = [[y0 - e, zEl], [y0 + kn, zk], [ym, zr], [y1 - kn, zk], [y1 + e, zEl]];
        I.zE = zEl;
      } else prof = [[y0 - e, zE], [ym, zr], [y1 + e, zE]];
      const top = prof.length >> 1;
      for (let i = 0; i < prof.length - 1; i++) {
        const [ya, za] = prof[i], [yb, zb2] = prof[i + 1], south = i >= top, cap = i === top - 1 || i === top;
        face([[x0 - eg, ya, za], [x1 + eg, ya, za], [x1 + eg, yb, zb2], [x0 - eg, yb, zb2]], 'S', rm(south ? (i === prof.length - 2 && prof.length > 3 ? -0.08 : -0.04) : 0.3, barge, 'x', { noCap: !cap }));
      }
      const gp = prof.map(([y, z], i) => i === 0 ? [x1, y0, zb] : i === prof.length - 1 ? [x1, y1, zb] : [x1, y, z]);
      const cols = Math.round((y1 - y0) * s);
      finfo[gname] = { dir: 'E', X: x1, y1, cols };
      face(gp, 'E', gm(cols, 0.3), { col0: (x1 - y1) * s });
      fasciaS(x0 - eg, x1 + eg, y1 + e, prof[prof.length - 1][1], 0, mat);
      rake('E', prof.slice().reverse().map(([y, z]) => [x1 + eg, y, z]), 0.3, o.gild);
      if (dress) gableDress(I, 'y');
      return I;
    }
    const half = (x1 - x0) / 2, k = Rr / half, zr = zb + Rr, zE = zb - e * k, xm = (x0 + x1) / 2;
    const I = { ridge: 'NS', k, zr, zE, xm, eave: x1 + e, x0, x1, y0, y1, zb, e, mat, base, ridgePt: [xm, y0 + (y1 - y0) * 0.7, zr] };
    if (o.hip) {
      const mid = (y0 + y1) / 2, ya = Math.min(y0 + half, mid), yb = Math.max(y1 - half, mid);
      face([[x1 + e, y1 + e, zE], [x1 + e, y0 - e, zE], [xm, ya, zr], [xm, yb, zr]], 'E', rm(0.16, null, 'y', { noCap: ya === yb }));
      face([[x0 - e, y1 + e, zE], [x0 - e, y0 - e, zE], [xm, ya, zr], [xm, yb, zr]], 'E', rm(0.32, null, 'y', { noCap: ya === yb }));
      face([[x0 - e, y1 + e, zE], [x1 + e, y1 + e, zE], [xm, yb, zr]], 'S', rm(-0.04, null, 'x', { noCap: true }));
      face([[x0 - e, y0 - e, zE], [x1 + e, y0 - e, zE], [xm, ya, zr]], 'S', rm(0.3, null, 'x', { noCap: true }));
      fasciaS(x0 - e, x1 + e, y1 + e, zE, 0, mat); fasciaE(x1 + e, y0 - e, y1 + e, zE, 0.3, mat);
      I.ridgePt = [xm, yb, zr];
      return I;
    }
    const barge = (P, w = 1.1) => P[1] < y0 - eg + w || P[1] > y1 + eg - w;
    face([[x0 - e, y0 - eg, zE], [x0 - e, y1 + eg, zE], [xm, y1 + eg, zr], [xm, y0 - eg, zr]], 'E', rm(0.3, barge, 'y'));
    const cols = Math.round((x1 - x0) * s);
    finfo[gname] = { dir: 'S', Y: y1, x0, cols };
    face([[x0, y1, zb], [x1, y1, zb], [xm, y1, zr]], 'S', gm(cols, 0), { col0: (x0 - y1) * s });
    face([[x1 + e, y0 - eg, zE], [x1 + e, y1 + eg, zE], [xm, y1 + eg, zr], [xm, y0 - eg, zr]], 'E', rm(0.16, barge, 'y'));
    fasciaE(x1 + e, y0 - eg, y1 + eg, zE, 0.3, mat);
    rake('S', [[x0 - e, y1 + eg, zE], [xm, y1 + eg, zr], [x1 + e, y1 + eg, zE]], 0, o.gild);
    if (dress) gableDress(I, 'x');
    return I;
  }
  // Stone and canal gables: a parapet rising over the roof, coped in small steps with kneelers (stone) or
  // in big crow steps with pale copings (canal). along 'y': the gable at x = I.x1; 'x': at y = I.y1.
  function gableDress(I, along) {
    const crow = st.sty === 4, paint = st.paint, tex = crow ? 'brickP' : 'ashlar', a0 = along === 'y' ? I.y0 : I.x0, a1 = along === 'y' ? I.y1 : I.x1, half = (a1 - a0) / 2, P0 = along === 'y' ? I.x1 : I.y1;
    const cap = capM(crow ? rgb('#ece6da') : lt(paint, 0.12)), mS = stoneM(paint, 0, tex), mE = stoneM(paint, 0.3, tex);
    const blk = (a, b, z0, z1) => (along === 'y' ? box(P0 - 2.6, P0 + 0.8, a, b, z0, z1, mS, mE, cap) : box(a, b, P0 - 2.6, P0 + 0.8, z0, z1, mS, mE, cap));
    const n = crow ? Math.max(2, Math.round(half / 5.5)) : Math.max(3, Math.round(half / 2.2)), sw = half / n;
    for (let i = 0; i < n; i++) {
      const zt = I.zb + (i + 1) * sw * I.k + (crow ? 1.5 : 1);
      blk(a0 + i * sw - 0.6, a0 + (i + 1) * sw, crow ? I.zb - 3 : zt - 4, zt); blk(a1 - (i + 1) * sw, a1 - i * sw + 0.6, crow ? I.zb - 3 : zt - 4, zt);
    }
    if (crow) blk(a0 + half - 1.6, a0 + half + 1.6, I.zr - 2, I.zr + 4); // the top step
    else { blk(a0 - 1, a0 + 3, I.zb - 4, I.zb + 2); blk(a1 - 3, a1 + 1, I.zb - 4, I.zb + 2); } // the kneelers
  }
  // A balcony on a south face at height z, dep deep: carved boards (alpine), iron bars or a stone balustrade.
  function balcony(x0, x1, Y, z, dep = 4, kind = 'wood') {
    const C = kind === 'iron' ? IRON : kind === 'stone' ? lt(st.dressC ?? SAND, 0.08) : st.wood ?? DARKWOOD, yf = Y + dep, hg = kind === 'iron' ? 5 : 6;
    box(x0, x1, Y, yf, z - 1.6, z, flat(dk(C, 0.05)), flat(dk(C, 0.3)), flat(lt(C, 0.12)));
    const pan = sh => q => {
      const c = q.col, zz = Math.floor(q.z - z);
      const k = kind === 'wood' ? (zz >= hg - 1 ? lt(C, 0.22) : c % 4 === 0 ? dk(C, 0.35) : c % 4 === 2 && zz >= 2 && zz <= 3 ? dk(SHADE, 0.05) : c % 4 === 1 ? lt(C, 0.1) : C) : zz >= hg - 1 ? lt(C, 0.2) : zz < 1 ? dk(C, 0.1) : C;
      return [shade(k, sh), 0];
    };
    const keep = kind === 'wood' ? undefined : (P, c) => { const zz = P[2] - z; return zz >= hg - 1.2 || zz < 1 || ((c % 3) + 3) % 3 === 0; };
    face([[x0, yf, z], [x1, yf, z], [x1, yf, z + hg], [x0, yf, z + hg]], 'S', pan(0), { col0: (x0 - yf) * s, keep });
    face([[x1, yf, z], [x1, Y, z], [x1, Y, z + hg], [x1, yf, z + hg]], 'E', pan(0.3), { col0: (x1 - yf) * s, keep });
  }
  // A gabled dormer on the roof's visible long slope (south for an EW ridge, east for NS), centred at c.
  function dormer(I, c, dw, o = {}) {
    if (st.sty === 1 || st.sty === 3) return; // low wide roofs carry no dormers
    const de = 1.4, dh = o.dh ?? 11, rr = dw * 0.5 * (o.pitch ?? 1), kk = rr / (dw / 2), name = `D${nD++}`, rmo = { mat: I.mat, base: I.base, noCap: true };
    const mo = { tex: o.tex ?? 'plaster', paint: o.paint ?? st.paint, corner: 'post', frame: -1 };
    if (I.ridge === 'EW') {
      const yf = I.y1 - 1.5, zf = I.zE + (I.eave - yf) * I.k, zt = zf + dh, xa = c - dw / 2, xb = c + dw / 2, yB = I.eave - (zt + rr - I.zE) / I.k - 2, zl = zt - de * kk;
      const cols = wallS(name, xa, xb, yf, zf - 6, zt, { ...mo, shade: 0 });
      fittings.push({ face: name, kind: 'win', c0: (cols >> 1) - 2, c1: (cols >> 1) + 2, z0: zf + 2, z1: zt - 3, flowers: false, shutters: false });
      face([[xa, yf, zt], [xb, yf, zt], [c, yf, zt + rr]], 'S', wm(name + 'g', { ...mo, corner: null, tex: 'planks', paint: mix(mo.paint, WOOD, 0.4), cols }), { col0: (xa - yf) * s });
      wallE(name + 'e', xb, yB, yf, zf - 6, zt, { ...mo, corner: null });
      face([[xb + de, yf + de, zl], [xb + de, yB, zl], [c, yB, zt + rr], [c, yf + de, zt + rr]], 'E', roofMat(0.04, null, 'y', rmo));
      face([[xa - de, yf + de, zl], [xa - de, yB, zl], [c, yB, zt + rr], [c, yf + de, zt + rr]], 'E', roofMat(0.3, null, 'y', rmo));
      rake('S', [[xa - de, yf + de, zl], [c, yf + de, zt + rr], [xb + de, yf + de, zl]], 0);
    } else {
      const xf = I.x1 - 1.5, zf = I.zE + (I.eave - xf) * I.k, zt = zf + dh, ya = c - dw / 2, yb = c + dw / 2, xB = I.eave - (zt + rr - I.zE) / I.k - 2, zl = zt - de * kk;
      const cols = wallE(name, xf, ya, yb, zf - 6, zt, { ...mo });
      fittings.push({ face: name, kind: 'win', c0: (cols >> 1) - 2, c1: (cols >> 1) + 2, z0: zf + 2, z1: zt - 3, flowers: false, shutters: false });
      face([[xf, yb, zt], [xf, ya, zt], [xf, c, zt + rr]], 'E', wm(name + 'g', { ...mo, corner: null, tex: 'planks', paint: mix(mo.paint, WOOD, 0.4), cols, shade: 0.3 }), { col0: (xf - yb) * s });
      wallS(name + 's', xB, xf, yb, zf - 6, zt, { ...mo, corner: null, shade: 0 });
      face([[xB, yb + de, zl], [xf + de, yb + de, zl], [xf + de, c, zt + rr], [xB, c, zt + rr]], 'S', roofMat(-0.04, null, 'x', rmo));
      face([[xB, ya - de, zl], [xf + de, ya - de, zl], [xf + de, c, zt + rr], [xB, c, zt + rr]], 'S', roofMat(0.3, null, 'x', rmo));
      rake('E', [[xf + de, yb + de, zl], [xf + de, c, zt + rr], [xf + de, ya - de, zl]], 0.3);
    }
  }
  // An n-sided prism or frustum (r0 at z0 to r1 at z1; r1 = 0 makes a cone or spire). Faces turned away
  // are skipped. mk(name, N, cols) gives each side's material; a side facing south has dir 'S'.
  function prism(name, cx, cy, r0, r1, z0, z1, n, mk, rot = Math.PI / n) {
    for (let i = 0; i < n; i++) {
      const a0 = rot + i * 2 * Math.PI / n, a1 = a0 + 2 * Math.PI / n, am = (a0 + a1) / 2;
      const p = (r, a, z) => [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
      const pts = r1 > 0.01 ? [p(r0, a0, z0), p(r0, a1, z0), p(r1, a1, z1), p(r1, a0, z1)] : [p(r0, a0, z0), p(r0, a1, z0), [cx, cy, z1]];
      const u = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], 0], v = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
      let N = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (N[0] * Math.cos(am) + N[1] * Math.sin(am) < 0) N = N.map(a => -a);
      if (N[0] + N[1] + N[2] * s <= 1e-6) continue; // faces away from the viewer
      const xs = pts.map(q => (q[0] - q[1]) * s), cols = Math.round(Math.max(...xs) - Math.min(...xs));
      face(pts, Math.abs(N[0]) > Math.abs(N[1]) ? 'E' : 'S', mk(`${name}${i}`, N, cols, i));
    }
  }
  // A cone or spire roof: courses by height, each facet lit by its own facing; a dark eave lip.
  const coneMat = (base, mat, z0) => (nm, N, cols, i) => { const sh = shOf(N); return q => { const zz = q.z - z0; let c = roofTex(mm(mat), q.col + i * 3, zz + 1, 99, base); if (zz < 1.2) c = dk(base, 0.42); return [shade(c, sh), 0]; }; };
  const stoneM = (paint, sh, tex = 'ashlar') => q => [shade(wallTex(tex, q.col, Math.floor(q.z), 99, false, paint, 0), sh), 0];
  const capM = paint => q => [((Math.floor(q.P[0] / 3) + Math.floor(q.P[1] / 3)) & 1) ? lt(paint, 0.16) : lt(paint, 0.06), 0];
  // Merlons along an edge: along x at y = at (thickness th to the north), or along y at x = at.
  function merlons(dir, a0, a1, at, th, z, paint, mw = 4, gap = 3, mh = 5) {
    const n = Math.max(1, Math.round((a1 - a0 + gap) / (mw + gap))), step = n > 1 ? (a1 - a0 - mw) / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      const a = n === 1 ? (a0 + a1 - mw) / 2 : a0 + i * step;
      if (dir === 'x') box(a, a + mw, at - th, at, z, z + mh, stoneM(paint, 0), stoneM(paint, 0.3), capM(paint));
      else box(at - th, at, a, a + mw, z, z + mh, stoneM(paint, 0), stoneM(paint, 0.3), capM(paint));
    }
  }
  // A round wall (cylinder): stone courses wrapped round, lit by its facing; openings by angle (0 east, 0.25 south).
  const roundWall = (r, paint, ops = [], tex = 'stone') => q => {
    if (q.cap) return [lt(paint, 0.1), 0];
    const zi = Math.floor(q.z), circ = 2 * Math.PI * r, u = q.ang * circ;
    for (const op of ops) { const du = (q.ang - op.a) * circ; if (Math.abs(du) <= op.w / 2 && zi >= op.z0 && zi <= op.z1) { const c = op.c(du, zi); if (c) return c; } }
    const row = Math.floor(zi / 4), rr = ((zi % 4) + 4) % 4, uu = u + (row & 1) * 3.5 + 600, cell = Math.floor(uu / 7), cc = uu - cell * 7;
    const b = jit(paint, ((h2(row, cell, st.seed) % 5) - 2) * 0.04);
    let c = tex === 'white' ? wallTex('white', Math.floor(u), zi, 99, false, paint, 0) : rr === 0 || cc < 0.9 ? dk(b, 0.3) : rr === 3 ? lt(b, 0.12) : b;
    return [shade(c, Math.round(shOf(q.N) / 0.06) * 0.06), 0];
  };
  const slitOp = (a, z0, z1) => ({ a, w: 3, z0, z1, c: (du, zi) => Math.abs(du) < 0.7 || (zi === ((z0 + z1) >> 1) && Math.abs(du) < 1.4) ? [dk(SHADE, 0.2), 0] : Math.abs(du) < 1.5 ? [STR[3], 0] : null });
  const winOp = (a, z0, z1) => ({ a, w: 5, z0, z1, c: (du, zi) => Math.abs(du) > 1.6 || zi === z0 || zi === z1 ? [STR[du < 0 || zi === z1 ? 3 : 1], 0] : (lit ? [LIT[3], 1] : [Math.abs(du) < 0.6 ? GLASS[1] : (zi + Math.floor(du * 2)) % 4 === 0 ? GLASS[4] : GLASS[2], 0]) });
  const hay = (x, y, w = 7) => box(x, x + w, y, y + 4.5, 0, 4, q => [((q.col + Math.floor(q.z) * 2) % 5 === 0) ? dk(THATCH, 0.25) : Math.floor(q.z) === 3 ? lt(THATCH, 0.2) : THATCH, 0], q => [dk((q.col % 4 === 0) ? dk(THATCH, 0.2) : THATCH, 0.25), 0], q => [(Math.floor(q.P[0] * 2) % 3 === 0) ? lt(THATCH, 0.1) : lt(THATCH, 0.28), 0]);
  const bell = (cx, cy, z, r) => ball(cx, cy, z, r, q => [byLight(ramp(rgb('#c9963c')), q.N, 0.1), 0]);
  // ---------- the kit's fittings (painted over kit walls; paintFitting falls through to these) ----------
  // Is (col, zi) inside an opening's arch (round or pointed head), grown by g px for its surround?
  function archIn(f, col, zi, g = 0) {
    const xl = f.c0 - g, xr = f.c1 + 1 + g, w = xr - xl, x = col + 0.5, z = zi + 0.5, top = f.z1 + 1 + g, bot = f.z0 - (f.z0 > 0 ? g : 0);
    if (x < xl || x > xr || z < bot || z > top) return false;
    if (f.round) { const r = w / 2, zs = top - r; return z <= zs || (x - xl - r) ** 2 + (z - zs) ** 2 <= r * r; }
    const zs = top - 0.866 * w;
    return z <= zs || ((x - xr) ** 2 + (z - zs) ** 2 <= w * w && (x - xl) ** 2 + (z - zs) ** 2 <= w * w);
  }
  function kitFitting(f, col, zi) {
    const k = f.kind;
    if (k === 'lancet' || k === 'arch' || k === 'portal' || k === 'gate' || k === 'belfry' || k === 'forge' || k === 'arrow') {
      const g = k === 'arch' || k === 'portal' || k === 'gate' ? 2 : 1;
      if (!archIn(f, col, zi, g)) return null;
      const mid = (f.c0 + f.c1 + 1) / 2, dz = zi - f.z0, hh = f.z1 - f.z0;
      if (!archIn(f, col, zi, 0)) return [(col + zi * 2) % 4 === 0 ? STR[1] : col + 0.5 < mid ? STR[3] : STR[2], 0]; // the dressed surround
      if (k === 'lancet' || k === 'arrow') {
        if (k === 'arrow') return [dk(SHADE, 0.15), 0];
        const lead = (col + zi) % 4 === 0 || (col - zi + 400) % 4 === 0;
        if (lit) return [lead ? dk(LIT[0], 0.35) : f.stained ? lt(STAIN[h2(col >> 1, zi >> 1, 5) % 5], 0.45) : LIT[(h2(col, zi, 3) % 2) + 2], 1];
        if (lead) return [dk(GLASS[0], 0.3), 0];
        if (f.stained) return [dk(STAIN[h2((col + 400) >> 1, zi >> 1, 3) % STAIN.length], 0.12), 0];
        return glass(col, zi, f);
      }
      if (k === 'arch') { // an arcade: the shady hall behind, crates of goods on the floor
        let c = mix(SHADE, rgb('#5a4038'), 0.45);
        if (dz < 1) c = dk(STONE, 0.1);
        else if (f.goods && dz <= 3) c = (col + dz) % 4 === 0 ? dk(WOOD, 0.3) : dz === 3 ? lt(WOOD, 0.1) : WOOD;
        else if (f.goods && dz <= 5 && col > f.c0 && col < f.c1) { const kk = h2(col >> 1, f.c0, st.seed) % 6; c = [rgb('#e0563c'), rgb('#f2c14e'), LEAF, rgb('#9c5bb5'), rgb('#ef8a3c'), lt(LEAF, 0.2)][kk]; if (dz === 5) c = lt(c, 0.2); }
        else if (dz > hh * 0.62) c = dk(c, 0.22);
        if (lit) return [mix(c, LIT[1], dz < hh * 0.6 ? 0.42 : 0.2), 1];
        return [c, 0];
      }
      if (k === 'portal') { // a great door: two leaves, iron straps, a ring handle
        if (Math.abs(col + 0.5 - mid) < 0.6) return [DOOR[0], 0];
        if (dz % 6 === 4) return [IRON, 0];
        if (dz === Math.round(hh * 0.42) && Math.abs(col + 0.5 - mid) < 2.6 && Math.abs(col + 0.5 - mid) > 1.2) return [GOLD, 0];
        return [(col - f.c0) % 2 ? DOOR[2] : DOOR[3], 0];
      }
      if (k === 'gate') { // a gate passage, the portcullis half raised
        const pass = dz < 2 ? dk(STONE, 0.25) : mix(SHADE, rgb('#3a3036'), 0.4);
        if (dz > hh * 0.45 && ((col - f.c0) % 3 === 1 || dz % 3 === 0)) return [dz % 3 === 0 && (col - f.c0) % 3 === 1 ? lt(IRON, 0.25) : IRON, 0];
        if (dz > hh * 0.45 && dz < hh * 0.45 + 2 && (col - f.c0) % 3 === 1) return [IRON, 0]; // the spikes
        return lit ? [mix(pass, LIT[0], 0.4), 1] : [pass, 0];
      }
      if (k === 'forge') { // the forge mouth: soot above, coals glowing below (always lit)
        if (dz < hh * 0.42) { const hot = h2(col, zi, st.seed) % 3; return [dz < 1 ? LIT[0] : hot === 0 ? LIT[4] : hot === 1 ? LIT[2] : rgb('#e0602c'), 1]; }
        return [dk(SHADE, 0.2 + (dz / hh) * 0.2), 0];
      }
      // belfry: a dark opening with a bell hanging in it
      const bt = f.z0 + Math.round(hh * 0.18), bh = Math.round(hh * 0.5), rel = (zi - bt) / bh;
      if (f.bell !== false && rel >= 0 && rel <= 1) {
        const half = rel < 0.15 ? (f.c1 - f.c0) * 0.42 : (f.c1 - f.c0) * (0.3 - rel * 0.15) + 0.5;
        if (Math.abs(col + 0.5 - mid) <= half) return [col + 0.5 < mid - half * 0.3 ? lt(rgb('#d9a646'), 0.25) : rel < 0.15 ? dk(rgb('#b78434'), 0.25) : rgb('#c9963c'), 0];
      }
      return [mix(SHADE, rgb('#3a3036'), 0.3), 0];
    }
    if (k === 'rose' || k === 'clock') {
      const cx = (f.c0 + f.c1 + 1) / 2, cz = (f.z0 + f.z1 + 1) / 2, r = (f.c1 - f.c0 + 1) / 2, dx = col + 0.5 - cx, dz = zi + 0.5 - cz, d = Math.hypot(dx, dz);
      if (d > r + 1.5) return null;
      if (d > r - 0.5) return [d > r + 0.5 ? STR[1] : STR[3], 0];
      if (k === 'clock') {
        if (d > r - 1.5) return [d > r - 1 ? dk(GOLD, 0.25) : GOLD, 0];
        const hand = (a, len) => { const ux = Math.sin(a), uz = Math.cos(a), t = dx * ux + dz * uz; return t > -0.4 && t < len && Math.abs(dx * uz - dz * ux) < 0.62; };
        if (d < 0.8) return [GOLD, 0];
        if (hand(-Math.PI / 3, r * 0.5) || hand(Math.PI / 3, r * 0.82)) return [rgb('#2a2230'), 0];
        const a = Math.atan2(dx, dz) / (Math.PI / 2);
        if (d > r - 2.8 && Math.abs(a - Math.round(a)) < 0.12) return [dk(rgb('#2a2230'), 0), 0];
        return lit ? [LIT[3], 1] : [d < r * 0.5 ? rgb('#f7f0dc') : rgb('#ece0c2'), 0];
      }
      const a = (Math.atan2(dz, dx) / (2 * Math.PI) + 1) % 1, n = f.petals ?? 8, sec = Math.floor(a * n), fa = (a * n) % 1, ring = r * 0.56;
      if (d < r * 0.22) return [lit ? LIT[4] : GOLD, lit ? 1 : 0];
      if (fa < 0.14 || fa > 0.86 || Math.abs(d - ring) < 0.55) return [dk(STR[1], 0.15), 0];
      const sc = STAIN[(sec + (d > ring ? 2 : 0)) % STAIN.length];
      return lit ? [lt(sc, 0.5), 1] : [d < ring ? lt(sc, 0.08) : sc, 0];
    }
    const inR = (w, hgt) => col >= f.c0 && col < f.c0 + w && zi >= f.z0 && zi < f.z0 + hgt;
    if (k === 'crest') { // a shield in the accent with a gold chevron
      if (!inR(7, 8)) return null;
      const u = col - f.c0, v = zi - f.z0, half = v >= 3 ? 3.5 : 3.5 - (3 - v) * 0.9;
      if (Math.abs(u + 0.5 - 3.5) > half) return null;
      if (Math.abs(u + 0.5 - 3.5) > half - 1 || v === 7) return [dk(GOLD, 0.2), 0];
      if (Math.abs(Math.abs(u - 3) - (v - 2)) < 0.8 && v > 2) return [GOLD, 0];
      return [u < 3 ? lt(accent, 0.12) : accent, 0];
    }
    if (k === 'slit') { // an arrow slit (a cross loop) with a dressed surround
      if (!inR(3, f.z1 - f.z0 + 1)) return null;
      const u = col - f.c0, mz = (f.z0 + f.z1) >> 1;
      if (u === 1 || (zi === mz)) return [dk(SHADE, 0.15), 0];
      return [STR[u === 0 ? 3 : 2], 0];
    }
    if (k === 'louvre') { // slatted vents (belfries of barns, cupolas)
      if (col < f.c0 || col > f.c1 || zi < f.z0 || zi > f.z1) return null;
      if (col === f.c0 || col === f.c1 || zi === f.z1) return [TR[col === f.c0 ? 3 : 1], 0];
      return [(zi - f.z0) % 2 ? dk(SHADE, 0.1) : lt(WOOD, 0.05), 0];
    }
    if (k === 'loft') { // a hayloft door with hay spilling over its sill
      if (col < f.c0 - 1 || col > f.c1 + 1 || zi < f.z0 - 2 || zi > f.z1 + 1) return null;
      if (zi < f.z0) return zi === f.z0 - 1 && h2(col, 5, st.seed) % 3 !== 0 ? [h2(col, 9, st.seed) % 2 ? THATCH : lt(THATCH, 0.25), 0] : zi === f.z0 - 2 && h2(col, 6, st.seed) % 3 === 0 ? [dk(THATCH, 0.1), 0] : null;
      if (col === f.c0 - 1 || col === f.c1 + 1 || zi === f.z1 + 1) return [TR[col === f.c0 - 1 || zi === f.z1 + 1 ? 3 : 1], 0];
      if (zi <= f.z0 + 1) return [h2(col, zi, st.seed) % 2 ? THATCH : lt(THATCH, 0.2), 0];
      const u = (col - f.c0) / Math.max(1, f.c1 - f.c0), v = (zi - f.z0) / Math.max(1, f.z1 - f.z0);
      if (Math.abs(u - v) < 0.13 || Math.abs(u + v - 1) < 0.13) return [DOOR[3], 0];
      return [(col - f.c0) % 2 ? DOOR[2] : DOOR[1], 0];
    }
    if (k === 'woodpile') { // an open woodshed: stacked log ends under a dark roof
      if (col < f.c0 || col > f.c1 || zi < f.z0 || zi > f.z1) return null;
      const lz = zi - f.z0;
      if (lz > (f.z1 - f.z0) * 0.7) return [mix(SHADE, rgb('#4a3428'), 0.5), 0];
      const row = Math.floor(lz / 3), r = lz % 3, u = col - f.c0 + (row & 1) * 2, cc = ((u % 3) + 3) % 3, end = rgb('#d7b07a');
      if (r === 0 && cc === 0) return [dk(WOOD, 0.55), 0];
      if (r === 1 && cc === 1) return [dk(end, 0.3), 0];
      return [cc === 0 || r === 0 ? dk(end, 0.18) : end, 0];
    }
    if (k === 'shop') { // a shop window: small panes in a painted frame, wares on the sill
      if (col < f.c0 - 1 || col > f.c1 + 1 || zi < f.z0 - 1 || zi > f.z1 + 1) return null;
      const SF = ramp(dk(accent, 0.2));
      if (col === f.c0 - 1 || col === f.c1 + 1 || zi === f.z0 - 1 || zi === f.z1 + 1) return [col === f.c0 - 1 || zi === f.z1 + 1 ? SF[3] : SF[1], 0];
      if ((col - f.c0) % 4 === 3 || (f.z1 - zi) % 4 === 3) return [SF[2], 0];
      if (zi <= f.z0 + 1 && !lit) { const kk = h2(col, 1, st.seed) % 4; return [[rgb('#d9a35a'), rgb('#e0563c'), rgb('#c98a4a'), rgb('#f2c14e')][kk], 0]; }
      return glass(col, zi, f);
    }
    if (k === 'board') { // a hanging signboard with a painted emblem, on an iron arm
      const { c0, z0 } = f, bw = 9, bh = 7;
      if (zi === z0 + bh + 2 && col >= c0 - 2 && col <= c0 + bw - 1) return [dk(IRON, 0.2), 0];
      if (col === c0 - 2 && zi >= z0 + bh && zi <= z0 + bh + 2) return [dk(IRON, 0.2), 0]; // the bracket's stay
      if (col < c0 || col > c0 + bw - 1 || zi < z0 || zi > z0 + bh + 1) return null;
      if (zi >= z0 + bh) return col === c0 + 1 || col === c0 + bw - 2 ? [IRON, 0] : null;
      if (col === c0 || col === c0 + bw - 1 || zi === z0 || zi === z0 + bh - 1) return [dk(accent, 0.45), 0];
      const G = GLYPH[f.glyph], gx = col - c0 - 2, gz = z0 + bh - 2 - zi;
      if (G && gz >= 0 && gz < 5 && gx >= 0 && gx < 5 && G[gz][gx] === '#') return [gz === 0 ? lt(GOLD, 0.3) : GOLD, 0];
      return [zi === z0 + bh - 2 ? lt(accent, 0.15) : accent, 0];
    }
    return null;
  }
  // ---------- the looks ----------
  function buildKit() {
    const lk = st.look;
    ({ cottage: cottageKit, palace, farmhouse, timber: timberHouse, townhouse, manor, barn, windmill, granary, chapel, smithy, inn, guildhall, clocktower, markethall, cathedral, wall, walltower, gatehouse })[lk]();
    const WINK = new Set(['win', 'round', 'lancet', 'rose', 'shop', 'arch']);
    for (const f of fittings) if (WINK.has(f.kind) && finfo[f.face]) out.windows.push(fpt(f.face, (f.c0 + f.c1) / 2, (f.z0 + f.z1) / 2));
    if (!out.ridge) out.ridge = Q(W / 2, D / 2, H + R);
  }
  const plasterGable = (fr, zb, paint = st.paint) => (nm, cols, sh) => wm(nm, { tex: 'plaster', paint, frame: fr, zb, cols, shade: sh, beam: st.beam });
  const stoneGable = (tex, paint, zb) => (nm, cols, sh) => wm(nm, { tex, paint, zb, cols, shade: sh });

  // Hamlet: a thatched farmhouse of logs, clapboard or fieldstone, often with a woodshed lean-to.
  function farmhouse() {
    const u0 = dU(), lean = W >= 40 && vb(11, 3) !== 0 ? 14 : 0, west = lean > 0 && u0 > W / 2;
    const mx0 = west ? lean : 0, mx1 = west ? W : W - lean, u = Math.min(mx1 - 8, Math.max(mx0 + 8, u0)), tex = st.lower;
    groundShadow();
    const S = storeys({ x0: mx0, x1: mx1, y0: 0, y1: D, floors: [{ h: H, tex, paint: st.paint, corner: tex === 'clap' ? 'post' : null }], eaveS: true });
    const f0 = S.fl[0];
    const gap = frontDoor(f0.nS, D, u, { dh: 12, mat: true, lamp: vb(14, 2) === 1 });
    winRow(f0.nS, 6, { gap, ht: 7, flowers: st.flowers, shutters: st.shutters });
    if (!lean || west) winRow(f0.nE, 6, { ht: 7, flowers: st.flowers, max: 2 });
    const I = roof2({ x0: mx0, x1: mx1, y0: 0, y1: D, zb: H, R, e, ridge: 'EW', mat: 'thatch', gable: (nm, cols, sh) => wm(nm, { tex: tex === 'logs' ? 'logs' : 'planks', paint: tex === 'logs' ? st.paint : mix(st.paint, WOOD, 0.3), zb: H, cols, shade: sh }) });
    if (!lean || west) { const c = finfo.G.cols >> 1; fittings.push({ face: 'G', kind: 'round', c0: c - 3, c1: c + 3, z0: H + 3, z1: H + 9 }); }
    if (lean) {
      const lx0 = west ? 0 : W - lean, lx1 = west ? lean : W, zt = H - 3, zl = 11, hiX = west ? lx1 : lx0, loX = west ? lx0 - 3 : lx1 + 3, zlo = zl - 3 * (zt - zl) / lean;
      face([[hiX, -1, zt], [hiX, D + 3, zt], [loX, D + 3, zlo], [loX, -1, zlo]], 'E', roofMat(west ? 0.3 : 0.12, null, 'y', { mat: 'thatch', base: dk(RB, 0.06), noCap: true }));
      const cols = Math.round(lean * s);
      finfo.LS = { dir: 'S', Y: D, x0: lx0, cols };
      fittings.push({ face: 'LS', kind: 'woodpile', c0: 2, c1: cols - 3, z0: 0, z1: zl + 1 });
      face([[lx0, D, 0], [lx1, D, 0], [lx1, D, west ? zt : zl], [lx0, D, west ? zl : zt]], 'S', wm('LS', { tex: 'planks', paint: OLDWOOD, cols, corner: 'post' }), { col0: (lx0 - D) * s });
      if (!west) wallE('LE', W, 0, D, 0, zl, { tex: 'planks', paint: OLDWOOD });
    }
    chimney(west ? mx1 - 7 : mx0 + 7, D * 0.36, I.zr, H - 2, rgb('#9d9486'));
    out.ridge = Q(...I.ridgePt);
    props(u, 5);
  }

  // Town: a two-storey half-timbered house, the upper floor jettied out, a steep tile roof with dormers.
  function timberHouse() {
    const front = st.front, u = dU(), fr = st.frame, low = ['plaster', 'stone', 'plaster', 'ashlar'][vb(16, 4)];
    groundShadow();
    const floors = [{ h: 16, tex: low, paint: low === 'ashlar' ? SAND : st.paint, frame: low === 'plaster' ? fr : -1, corner: low === 'ashlar' ? 'quoin' : null }, { h: 17, tex: 'plaster', frame: fr, jet: 2 }];
    const S = storeys({ x0: 0, x1: W - 2, y0: 0, y1: D - 2, floors, jetE: true, eaveS: !front, eaveE: front });
    const [f0, f1] = S.fl;
    const gap = frontDoor(f0.nS, D - 2, u, { dh: 13, mat: true, lamp: vb(14, 2) === 1, board: st.pr ? 'key' : null });
    winRow(f0.nS, 6, { gap, shutters: true });
    winRow(f1.nS, f1.z + 4, { flowers: true, shutters: vb(17, 2) === 1 });
    winRow(f0.nE, 6, { max: 3 });
    winRow(f1.nE, f1.z + 4, { flowers: vb(18, 2) === 1, max: 3 });
    if (st.sty === 3) balcony(S.x0, S.x1, finfo[f1.nS].Y, f1.z + 1, 4);
    const I = roof2({ x0: 0, x1: S.x1, y0: 0, y1: S.y1, zb: S.z, R, e: 3, ridge: front ? 'NS' : 'EW', gable: plasterGable(fr, S.z) });
    const gc = finfo.G.cols >> 1;
    if (front) {
      winRow('G', S.z + 4, { at: W >= 48 ? [gc - 7, gc + 7] : [gc], wd: 5, ht: 7 });
      fittings.push({ face: 'G', kind: 'win', c0: gc - 2, c1: gc + 2, z0: S.z + 15, z1: S.z + 19, flowers: false, shutters: false });
      dormer(I, D * 0.4, 12);
    } else {
      fittings.push({ face: 'G', kind: 'win', c0: gc - 2, c1: gc + 2, z0: S.z + 4, z1: S.z + 10, flowers: false, shutters: false });
      if (W >= 60) { dormer(I, W * 0.3, 12); dormer(I, W * 0.72, 12); } else dormer(I, W * (vb(19, 2) ? 0.36 : 0.62), 12);
    }
    chimney(front ? W * 0.3 : W * (vb(21, 2) ? 0.2 : 0.82), front ? D * 0.25 : D * 0.3, I.zr, S.z - 2, null, 5);
    out.ridge = Q(...I.ridgePt);
    props(u, 5);
  }

  // City: a tall narrow house of three or four storeys, a very steep roof; sits in terraces.
  function townhouse() {
    const n = st.n, front = st.front, shop = vb(13, 3) === 0, u = dU(6, W - 6), fr = vb(14, 5) === 4 ? -1 : st.frame;
    const lowTex = shop ? 'plaster' : ['ashlar', 'plaster', 'stone'][vb(16, 3)], jets = fr >= 0 ? Math.min(2, n - 1) * 2 : 0;
    groundShadow();
    const floors = [{ h: 16, tex: lowTex, paint: lowTex === 'ashlar' ? SAND : st.paint, corner: 'quoin', quoinC: SAND }];
    for (let i = 1; i < n; i++) floors.push({ h: 14, tex: 'plaster', frame: fr, jet: fr >= 0 && i <= 2 ? 2 : 0, corner: fr < 0 ? 'quoin' : null, belts: fr < 0 ? [floors.reduce((a, f) => a + f.h, 0) + 1] : null });
    const S = storeys({ x0: 0, x1: W, y0: 0, y1: D - jets, floors, eaveS: !front });
    const f0 = S.fl[0], cols0 = finfo[f0.nS].cols;
    const gap = frontDoor(f0.nS, D - jets, u, { dh: 13, lamp: !shop && vb(17, 2) === 1, sw: 4, board: st.pr ? 'key' : null });
    if (shop) { // a shop window under a striped awning in the accent
      const a = gap[0] > cols0 - gap[1] ? [2, gap[0] - 2] : [gap[1] + 1, cols0 - 3];
      if (a[1] - a[0] >= 8) {
        fittings.push({ face: f0.nS, kind: 'shop', c0: a[0] + 1, c1: a[1] - 1, z0: 4, z1: 11 });
        const xa = a[0] / s, xb = (a[1] + 1) / s, Y = D - jets;
        face([[xa, Y + 5, 11], [xb, Y + 5, 11], [xb, Y, 15], [xa, Y, 15]], 'S', q => { const st2 = Math.floor(q.col / 3) % 2; let c = st2 ? lt(rgb('#f6efdf'), 0.05) : accent; if (q.row < 1) c = (q.col % 3 === 1) ? dk(c, 0.3) : dk(c, 0.12); return [c, 0]; }, { col0: (xa - Y) * s });
        face([[xb, Y + 5, 11], [xb, Y, 15], [xb, Y, 11]], 'E', flat(dk(accent, 0.3)));
      }
    } else winRow(f0.nS, 6, { gap, max: 1, shutters: false, flowers: vb(18, 2) === 1 });
    S.fl.slice(1).forEach((F, i) => winRow(F.nS, F.z + 3, { max: W >= 48 ? 3 : 2, flowers: vb(19 + i, 2) === 1, shutters: W >= 48 && vb(23, 2) === 1, ht: 8 }));
    S.fl.forEach(F => winRow(F.nE, F.z + (F === f0 ? 6 : 3), { max: 3, ht: 8 }));
    if (st.sty === 3) balcony(0, W, finfo[S.fl[1].nS].Y, S.fl[1].z + 1, 3.5);
    const I = roof2({ x0: 0, x1: W, y0: 0, y1: S.y1, zb: S.z, R, e, ridge: front ? 'NS' : 'EW', mat: st.roof === 'shingle' ? 'slate' : st.roof, gable: fr >= 0 ? plasterGable(fr, S.z) : stoneGable('plaster', st.paint, S.z) });
    const gc = finfo.G.cols >> 1, Rg = I.zr - S.z; // the gable's real rise (a family may change the pitch)
    if (front) {
      winRow('G', S.z + 4, { at: W >= 48 ? [gc - 8, gc, gc + 8] : [gc - 5, gc + 5], wd: 5, ht: 8 });
      if (Rg >= 24) fittings.push({ face: 'G', kind: 'win', c0: gc - 2, c1: gc + 2, z0: S.z + Math.round(Rg * 0.5), z1: S.z + Math.round(Rg * 0.5) + 6, flowers: false, shutters: false });
      if (vb(24, 2) && Rg >= 24) fittings.push({ face: 'G', kind: 'round', c0: gc - 2, c1: gc + 2, z0: S.z + Math.round(Rg * 0.74), z1: S.z + Math.round(Rg * 0.74) + 4 });
      const xm = W / 2, zh = S.z + Math.round(Rg * 0.86); // the hoist beam at the top of the gable
      box(xm - 1, xm + 1, S.y1, S.y1 + 5, zh, zh + 2, flat(st.beam), flat(dk(st.beam, 0.3)), flat(lt(st.beam, 0.15)));
      dormer(I, D * 0.42, 11, { dh: 10 });
    } else {
      fittings.push({ face: 'G', kind: 'win', c0: gc - 2, c1: gc + 2, z0: S.z + 4, z1: S.z + 10, flowers: false, shutters: false });
      if (W >= 48) { dormer(I, W * 0.28, 11); dormer(I, W * 0.72, 11); } else dormer(I, W * 0.5, 11);
    }
    chimney(front ? W * 0.7 : W * 0.15, front ? D * 0.2 : D * 0.3, I.zr, S.z - 2, rgb('#a95b3e'), 4, 2.5);
    out.ridge = Q(...I.ridgePt);
    if (!shop && W - u > 14 && vb(25, 2)) pot(u + 9, D + 3, true);
  }

  // A grand house for the crowned agent: stone below, timber above, a porch bay, dormers, maybe a turret.
  function manor() {
    const fr = st.frame, u = dU(15, W - 15), hip = vb(13, 2) === 1, turret = vb(12, 2) === 1, by = D - 12, bx0 = u - 13, bx1 = u + 13;
    groundShadow();
    const floors = [{ h: 18, tex: 'ashlar', paint: SAND, corner: 'quoin', quoinC: lt(SAND, 0.1) }, { h: 16, tex: 'plaster', frame: fr }];
    if (st.three) floors.push({ h: 14, tex: 'plaster', frame: fr });
    const M = storeys({ x0: 0, x1: W, y0: 0, y1: by, floors, eaveS: true, eaveE: hip, name: 'M' });
    const B = storeys({ x0: bx0, x1: bx1, y0: by - 6, y1: D, floors, eaveE: true, name: 'B' });
    const bgap = [colOf('MS0', bx0) - 2, colOf('MS0', bx1) + 2];
    M.fl.forEach((F, i) => { winRow(F.nS, F.z + (i ? 4 : 6), { gap: bgap, shutters: i === 0, flowers: i === 1, ht: i ? 8 : 9 }); winRow(F.nE, F.z + (i ? 4 : 6), { flowers: i === 1, ht: i ? 8 : 9 }); });
    frontDoor(B.fl[0].nS, D, u, { dw: 11, dh: 16, dbl: true, lamp: true, lampL: true, sw: 9, sd: 5, step2: true });
    B.fl.slice(1).forEach(F => { const c = finfo[F.nS].cols >> 1; fittings.push({ face: F.nS, kind: 'win', c0: c - 4, c1: c + 4, z0: F.z + 4, z1: F.z + 11, flowers: true, shutters: false, panes: 3 }); });
    B.fl.forEach(F => winRow(F.nE, F.z + 5, { max: 1, wd: 5 }));
    if (st.sty === 3) { const F = M.fl[1], Y = finfo[F.nS].Y; balcony(0, bx0, Y, F.z + 1, 4); balcony(bx1, W, Y, F.z + 1, 4); }
    const I = roof2({ x0: 0, x1: W, y0: 0, y1: by, zb: M.z, R, e: 3, ridge: 'EW', hip, gable: plasterGable(fr, M.z) });
    const gm = st.three ? plasterGable(fr, M.z) : stoneGable('ashlar', SAND, M.z);
    roof2({ x0: bx0, x1: bx1, y0: by - 6, y1: D, zb: M.z, R: 20, e: 2.5, ridge: 'NS', gname: 'BG', gable: gm });
    const gc = finfo.BG.cols >> 1;
    fittings.push(vb(14, 2) ? { face: 'BG', kind: 'crest', c0: gc - 3, z0: M.z + 4 } : { face: 'BG', kind: 'round', c0: gc - 3, c1: gc + 3, z0: M.z + 4, z1: M.z + 10 });
    if (!hip) { const c = finfo.G.cols >> 1; fittings.push({ face: 'G', kind: 'round', c0: c - 3, c1: c + 3, z0: M.z + 4, z1: M.z + 10 }); }
    for (const x of [bx0 / 2, (bx1 + W) / 2]) if ((x < bx0 ? bx0 : W - bx1) >= 15 && !(turret && Math.abs(x - (u < W / 2 ? W - 9 : 9)) < 12)) dormer(I, x, 11);
    if (turret) { // a round corner turret with a candle-snuffer roof
      const cx = u < W / 2 ? W - 9 : 9, cy = by - 3, r = 8.5, zt = M.z + 8;
      const ops = [winOp(0.25, 7, 14), winOp(0.25, 22, 29), winOp(0.12, 38, 44)].filter(o => o.z1 < zt - 4);
      cyl(cx, cy, r, 0, zt, roundWall(r, SAND, ops));
      prism('TC', cx, cy, r + 2.5, 0, zt, zt + 28, 12, coneMat(RB, st.roof === 'slate' ? 'slate' : 'tile', zt));
      out.finial = Q(cx, cy, zt + 28);
    }
    chimney(W * 0.12, by * 0.42, I.zr, M.z - 2, rgb('#9d9486'), 7);
    chimney(W * 0.88, by * 0.42, I.zr, M.z - 2, rgb('#9d9486'), 7);
    out.ridge = Q(...I.ridgePt);
    for (const x of [4, W - 4]) if (!(turret && Math.abs(x - (u < W / 2 ? W - 9 : 9)) < 8)) bush(x, D + 3, 3.2);
    pot(u - 12, D + 3, true); pot(u + 12, D + 3, true);
  }

  // A styled cottage (the village house in a family's dress): one storey, a gable or a hip, flower boxes.
  function cottageKit() {
    const u = dU(), hip = st.sty === 1 || st.sty === 5, front = !hip && (st.sty === 3 || st.sty === 4);
    groundShadow();
    const S = storeys({ x0: 0, x1: W, y0: 0, y1: D, floors: [{ h: H, tex: 'plaster', corner: st.sty === 2 || st.sty === 4 ? 'quoin' : null, quoinC: st.sty === 4 ? rgb('#ece6da') : st.dressC }], eaveS: !front, eaveE: front || hip });
    const f0 = S.fl[0];
    const gap = frontDoor(f0.nS, D, u, { dh: 13, mat: true, lamp: vb(14, 2) === 1 });
    winRow(f0.nS, 6, { gap });
    winRow(f0.nE, 6, { max: 2 });
    const I = roof2({ x0: 0, x1: W, y0: 0, y1: D, zb: H, R, e, ridge: front ? 'NS' : 'EW', hip, gable: plasterGable(-1, H) });
    if (!hip) { const c = finfo.G.cols >> 1; fittings.push({ face: 'G', kind: front ? 'win' : 'round', c0: c - 3, c1: c + 3, z0: H + 3, z1: H + 9, flowers: false, shutters: false }); }
    chimney(W * (vb(15, 2) ? 0.25 : 0.72), D * 0.3, I.zr, H - 2, null, 5);
    out.ridge = Q(...I.ridgePt);
    props(u, 5);
  }

  // The crowned agent's palace (any of 4x4, 4x5, 5x4, 5x5, 6x5): a manor a tier above, in the family's dress.
  // A three-storey main block, a pedimented frontispiece over a columned portico with a balustraded balcony,
  // balconied windows, a corner tower in the family's shape, ridge cresting and finials, a formal garden.
  // it.crown adds the flourishes: gilded cresting, finials and pediment, a crest, a flag, lanterns lit.
  function palace() {
    const crown = st.crown, sty = st.sty, fr = st.frame, hip = sty === 1 || sty === 5;
    const pw = W >= 80 ? 14 : 11, u = dU(pw + 3, W - pw - 3), by = D - (D >= 80 ? 28 : 24), fy = D - 11;
    const tr = W >= 80 ? 9 : 7.5, east = u <= W / 2, tx = east ? W - tr - 1 : tr + 1, ty = by - 2;
    const DR = st.dressC ?? SAND, CR = crown ? GOLD : IRON;
    groundShadow();
    const floors = [{ h: 20, tex: 'ashlar', paint: SAND, corner: 'quoin', quoinC: lt(SAND, 0.1) }, { h: 17, tex: 'plaster', frame: fr, belts: [21] }, { h: 14, tex: 'plaster', frame: fr }];
    const M = storeys({ x0: 0, x1: W, y0: 2, y1: by, floors, eaveS: true, eaveE: hip, name: 'M' });
    storeys({ x0: u - pw, x1: u + pw, y0: by - 6, y1: fy, floors, eaveE: true, name: 'F' });
    // windows: the main front (round the frontispiece), the east side; first-floor windows get balconies
    const fg = [colOf('MS0', u - pw) - 2, colOf('MS0', u + pw) + 2];
    M.fl.forEach((F, i) => {
      const cs = winRow(F.nS, F.z + (i ? 4 : 6), { gap: fg, ht: i === 2 ? 7 : 9, shutters: i === 0, flowers: i === 1, pad: 5 });
      winRow(F.nE, F.z + (i ? 4 : 6), { ht: i === 2 ? 7 : 9, max: 3 });
      if (i === 1 && sty !== 3) for (const c of cs) { const x = c / s, xt = Math.abs(x - tx) < tr + 4; if (!xt) balcony(x - 4.2, x + 4.2, by, F.z + 1, 3, sty === 1 ? 'iron' : 'stone'); }
      if (i === 1 && sty === 3) { balcony(0, u - pw, by, F.z + 1, 4); balcony(u + pw, W, by, F.z + 1, 4); }
    });
    const fc = colOf('FS0', u);
    fittings.push({ face: 'FS0', kind: 'door', c0: fc - 5, c1: fc + 5, z0: 0, z1: 15, dbl: true, zb: 3 });
    fittings.push({ face: 'FS1', kind: 'win', c0: fc - 5, c1: fc + 5, z0: 27, z1: 34, panes: 3, flowers: false, shutters: false, arch: st.win === 'arched' });
    fittings.push({ face: 'FS2', kind: 'win', c0: fc - 3, c1: fc + 3, z0: 41, z1: 47, flowers: false, shutters: false, arch: st.win === 'arched' });
    winRow('FE0', 6, { max: 1, ht: 9 }); winRow('FE1', 24, { max: 1, ht: 9 }); winRow('FE2', 41, { max: 1, ht: 7 });
    out.door = Q(u, D, 0);
    // the portico: a platform and steps, columns, the balcony on top
    box(u - pw - 1, u + pw + 1, fy, D - 3, 0, 3, stoneStep(0.05), stoneStep(0.3), flat(FOOT[3]));
    box(u - pw + 2, u + pw - 2, D - 3, D - 1, 0, 2, stoneStep(0.05), stoneStep(0.3), flat(FOOT[3]));
    box(u - pw + 3, u + pw - 3, D - 1, D + 1, 0, 1, stoneStep(0.05), stoneStep(0.3), flat(FOOT[3]));
    const wood = sty === 3 || sty === 5, PC = wood ? (st.wood ?? WOOD) : lt(DR, 0.12);
    for (const k of [-1, -1 / 3, 1 / 3, 1]) {
      const x = u + k * (pw - 2.5), y = D - 5.5;
      if (wood) box(x - 1.2, x + 1.2, y - 1.2, y + 1.2, 3, 22, q => [q.col === 0 ? lt(PC, 0.2) : PC, 0], flat(dk(PC, 0.3)), flat(PC));
      else { cyl(x, y, 1.7, 3, 21, q => [byLight(ramp(PC), q.N, 0.15), 0]); box(x - 2, x + 2, y - 2, y + 2, 20, 22, flat(lt(PC, 0.1)), flat(dk(PC, 0.25)), flat(lt(PC, 0.2))); }
    }
    box(u - pw, u + pw, fy, D - 3, 22, 25, stoneM(PC, 0), stoneM(PC, 0.3), capM(PC));
    balcony(u - pw, u + pw, fy, 25, D - 3 - fy, wood ? 'wood' : sty === 1 ? 'iron' : 'stone');
    // lanterns on posts at the foot of the steps: lit (by day too) for the crown
    for (const x of [u - pw - 0.5, u + pw + 0.5]) {
      box(x - 0.6, x + 0.6, D - 2.6, D - 1.4, 0, 12, flat(IRON), flat(dk(IRON, 0.3)), flat(IRON));
      const on = crown || lit, LM = q => [on ? (Math.floor(q.z) === 13 ? LIT[4] : LIT[3]) : (Math.floor(q.z) === 13 ? GLASS[4] : GLASS[2]), on ? 1 : 0];
      box(x - 1.4, x + 1.4, D - 3.4, D - 0.6, 12, 15.5, LM, q => [on ? LIT[2] : GLASS[1], 0], flat(IRON));
      box(x - 1.8, x + 1.8, D - 3.8, D - 0.2, 15.5, 16.5, flat(IRON), flat(dk(IRON, 0.3)), flat(lt(IRON, 0.2)));
    }
    // roofs: the main block, the frontispiece's pediment (crest or oculus), cresting along the ridge
    const I = roof2({ x0: 0, x1: W, y0: 2, y1: by, zb: M.z, R, e: 3, ridge: 'EW', hip, gable: plasterGable(fr, M.z) });
    if (!hip) { const c = finfo.G.cols >> 1; fittings.push({ face: 'G', kind: 'round', c0: c - 3, c1: c + 3, z0: M.z + 4, z1: M.z + 10 }); }
    roof2({ x0: u - pw, x1: u + pw, y0: by - 6, y1: fy, zb: M.z, R: Math.round(pw * 1.25), e: 2, ridge: 'NS', gname: 'FG', gable: stoneGable('ashlar', SAND, M.z), gild: crown, noDress: true });
    const gc = finfo.FG.cols >> 1;
    fittings.push(crown ? { face: 'FG', kind: 'crest', c0: gc - 3, z0: M.z + 3 } : { face: 'FG', kind: 'round', c0: gc - 3, c1: gc + 3, z0: M.z + 3, z1: M.z + 9 });
    const xa = hip ? I.xa : 2, xb = hip ? I.xb : W - 2, CM = [flat(CR), flat(dk(CR, 0.3)), flat(lt(CR, 0.3))];
    for (let x = xa + 2, i = 0; x <= xb - 2; x += 3, i++) box(x - 0.45, x + 0.45, I.ym - 0.45, I.ym + 0.45, I.zr - 1, I.zr + (i % 2 ? 2.5 : 4), ...CM);
    for (const x of [xa, xb]) { box(x - 0.6, x + 0.6, I.ym - 0.6, I.ym + 0.6, I.zr - 1, I.zr + 6, ...CM); ball(x, I.ym, I.zr + 7, 1.4, q => [byLight(ramp(CR), q.N, 0.1), 0]); }
    const pz = M.z + Math.min(pw * 1.25 * (sty ? (st.civic ? 1 : st.SY.rk) : 1), pw * 2 * 0.95);
    box(u - 0.6, u + 0.6, fy - 0.6, fy + 0.6, pz - 1, pz + 5, ...CM); ball(u, fy, pz + 6, 1.3, q => [byLight(ramp(CR), q.N, 0.1), 0]);
    // dormers between the frontispiece and the tower, chimneys
    const tx0 = tx - tr - 2, tx1 = tx + tr + 2;
    for (const x of [(u - pw) / 2, (u + pw + W) / 2]) if (Math.abs(x - u) > pw + 7 && (x < tx0 - 6 || x > tx1 + 6) && x > 9 && x < W - 9) dormer(I, x, 10);
    chimney(east ? 9 : W - 9, 2 + (by - 2) * 0.32, I.zr, M.z - 2, rgb('#9d9486'), 6);
    chimney(u + (east ? -pw : pw) * 0.6, 2 + (by - 2) * 0.28, I.zr, M.z - 2, rgb('#9d9486'), 6);
    // the tower
    const tz = M.z + 14, TP = sty === 4 ? st.paint : DR;
    let apex;
    const sqTower = (tex, paint) => {
      wallS('TS', tx - tr, tx + tr, ty + tr, 0, tz, { tex, paint, foot: true, corner: 'quoin', quoinC: sty === 4 ? rgb('#ece6da') : lt(paint, 0.1), belts: [M.fl[1].z + 1, M.fl[2].z + 1] });
      wallE('TE', tx + tr, ty - tr, ty + tr, 0, tz, { tex, paint, foot: true, corner: 'quoin', quoinC: sty === 4 ? rgb('#ece6da') : lt(paint, 0.1), belts: [M.fl[1].z + 1, M.fl[2].z + 1] });
      const c = finfo.TS.cols >> 1;
      for (const nm of ['TS', 'TE']) fittings.push({ face: nm, kind: 'win', c0: c - 2, c1: c + 2, z0: 26, z1: 33, flowers: false, shutters: false, arch: sty === 1, deep: sty === 2 }, { face: nm, kind: 'belfry', c0: c - 3, c1: c + 3, z0: tz - 13, z1: tz - 3, round: true, bell: sty === 1 });
      box(tx - tr - 1, tx + tr + 1, ty - tr - 1, ty + tr + 1, tz, tz + 2.5, stoneM(lt(paint, 0.08), 0, sty === 4 ? 'brickP' : 'ashlar'), stoneM(lt(paint, 0.08), 0.3, sty === 4 ? 'brickP' : 'ashlar'), capM(sty === 4 ? rgb('#ece6da') : paint));
    };
    const roundTower = (tex, paint) => {
      const ops = [winOp(0.25, 8, 15), winOp(0.25, 28, 35), winOp(0.1, 44, 50), slitOp(0.4, 20, 27)];
      cyl(tx, ty, tr, 0, tz, roundWall(tr, paint, ops, tex));
    };
    if (sty === 0) { // an eight-sided stone stair tower with a tall slate spire
      prism('TW', tx, ty, tr, tr, 0, tz, 8, (nm, N, cols) => wm(nm, { tex: 'ashlar', paint: SAND, cols, shade: shOf(N), keep: true }));
      fittings.push({ face: 'TW2', kind: 'lancet', c0: 2, c1: 5, z0: 28, z1: 38 }, { face: 'TW1', kind: 'lancet', c0: 2, c1: 5, z0: 44, z1: 54 });
      prism('TK', tx, ty, tr + 1.2, tr + 1.2, tz - 3, tz, 8, (nm, N) => stoneM(lt(SAND, 0.1), shOf(N)));
      prism('TR', tx, ty, tr + 2.5, 0, tz, tz + 34, 8, coneMat(RB, 'slate', tz)); apex = [tx, ty, tz + 34];
    } else if (sty === 1) { // a square campanile: open arches, a low tiled pyramid
      sqTower('plaster', TP);
      prism('TR', tx, ty, (tr + 2.5) * 1.41, 0, tz + 2.5, tz + 12, 4, coneMat(RB, 'tile', tz + 2.5), Math.PI / 4); apex = [tx, ty, tz + 12];
    } else if (sty === 2) { // a round keep: a corbelled ring, a conical slate roof
      roundTower('stone', st.paint);
      cyl(tx, ty, tr + 1.4, tz - 4, tz, q => { if (q.cap) return [lt(st.paint, 0.1), 0]; const zi = Math.floor(q.z), u2 = q.ang * 2 * Math.PI * (tr + 1.4); return [shade(zi === tz - 4 && Math.floor(u2) % 4 < 2 ? dk(SHADE, 0.1) : zi === tz - 1 ? lt(st.paint, 0.18) : st.paint, Math.round(shOf(q.N) / 0.06) * 0.06), 0]; });
      prism('TR', tx, ty, tr + 3, 0, tz, tz + 30, 12, coneMat(RB, 'slate', tz)); apex = [tx, ty, tz + 30];
    } else if (sty === 3) { // a white tower with a copper onion dome
      sqTower('plaster', TP);
      const CU = rgb('#5f9c86'), zo = tz + 2.5;
      prism('TN', tx, ty, tr * 0.55, tr * 0.55, zo, zo + 3, 8, (nm, N) => q => [shade(DARKWOOD, shOf(N)), 0]);
      ball(tx, ty, zo + 3 + tr * 0.8, tr * 0.9, q => { const c = byLight(ramp(CU), q.N, 0.1); return [Math.floor(q.ang * 16) % 2 ? dk(c, 0.06) : c, 0]; });
      prism('TO', tx, ty, tr * 0.45, 0, zo + 3 + tr * 1.45, zo + 3 + tr * 1.45 + 9, 8, coneMat(CU, 'lead', zo + 3 + tr * 1.45)); apex = [tx, ty, zo + 12 + tr * 1.45];
    } else if (sty === 4) { // a brick tower, an open octagonal lantern, a lead spire
      sqTower('plaster', TP);
      prism('TL', tx, ty, tr * 0.7, tr * 0.7, tz + 2.5, tz + 11, 8, (nm, N) => { const sh = shOf(N); return q => { const zi = Math.floor(q.z); return [shade(zi > tz + 4 && zi < tz + 10 && q.col % 4 !== 0 ? dk(SHADE, 0.05) : rgb('#ece6da'), sh), 0]; }; });
      prism('TR', tx, ty, tr * 0.85, 0, tz + 11, tz + 34, 8, coneMat(LEAD, 'lead', tz + 11)); apex = [tx, ty, tz + 34];
    } else { // a round cob tower under a tall thatched cone
      roundTower('white', st.paint);
      prism('TR', tx, ty, tr + 4, 0, tz - 2, tz + 26, 12, coneMat(RB, 'thatch', tz - 2)); apex = [tx, ty, tz + 26];
    }
    if (crown) out.flag = Q(...apex); else out.vane = Q(...apex);
    out.ridge = Q(...I.ridgePt);
    // the formal garden either side of the frontispiece: clipped hedges, topiary cones, urns of flowers
    const HG = sh => q => { const k = h2(q.col, Math.floor(q.z), st.seed); return [dk(k % 3 === 0 ? lt(LEAF, 0.16) : k % 5 === 0 ? dk(LEAF, 0.12) : LEAF, sh + (q.z < 1 ? 0.2 : 0)), 0]; };
    const zones = [[2, u - pw - 3], [u + pw + 3, W - 2]].map(([a, b]) => (east ? (b > tx0 ? [a, Math.min(b, tx0 - 1)] : [a, b]) : (a < tx1 ? [Math.max(a, tx1 + 1), b] : [a, b])));
    zones.forEach(([a, b], i) => {
      if (b - a < 7) return;
      box(a, b, D - 4.5, D - 2, 0, 3.5, HG(0), HG(0.3), q => [h2(Math.floor(q.P[0] * s), Math.floor(q.P[1]), st.seed) % 4 ? lt(LEAF, 0.12) : lt(LEAF, 0.26), 0]);
      const x = (a + b) / 2, y = (by + D - 4.5) / 2;
      prism(`TP${i}`, x, y, 2.8, 0, 2.5, 13, 6, (nm, N) => { const sh = shOf(N); return q => [shade(h2(q.col, Math.floor(q.z), st.seed) % 4 ? LEAF : lt(LEAF, 0.18), sh), 0]; });
      cyl(x, y, 2.4, 0, 2.5, q => [q.cap ? dk(SOIL, 0.2) : byLight(ramp(POT), q.N, 0.1), 0]);
    });
    pot(u - pw + 1.5, D + 0.5, true); pot(u + pw - 1.5, D + 0.5, true);
  }

  // Hamlet: a big barn of boards, a gambrel or steep roof, the barn doors, a hayloft.
  function barn() {
    const u = dU(13, W - 13);
    groundShadow();
    const S = storeys({ x0: 0, x1: W, y0: 0, y1: D, floors: [{ h: H, tex: 'planks', paint: st.paint, corner: 'post' }], eaveS: true });
    const f0 = S.fl[0];
    const gap = frontDoor(f0.nS, D, u, { barn: true, dw: 19, dh: 17, sw: 9, step: false });
    winRow(f0.nS, 9, { gap, wd: 5, ht: 5, max: 1 });
    winRow(f0.nE, 9, { wd: 5, ht: 5, max: 2, pad: 6 });
    const I = roof2({ x0: 0, x1: W, y0: 0, y1: D, zb: H, R: st.gamb ? R : 24, e: 3, ridge: 'EW', gambrel: st.gamb, mat: st.roof, gable: (nm, cols, sh) => wm(nm, { tex: 'planks', paint: st.paint, zb: H, cols, shade: sh }) });
    const gc = finfo.G.cols >> 1;
    fittings.push({ face: 'G', kind: 'loft', c0: gc - 4, c1: gc + 4, z0: H + 3, z1: H + 12 });
    if (vb(13, 2)) { // a louvred cupola on the ridge
      const cx = W / 2, cy = D / 2, zc = I.zr - 3;
      finfo.CS = { dir: 'S', Y: cy + 4, x0: cx - 4, cols: 6 };
      fittings.push({ face: 'CS', kind: 'louvre', c0: 1, c1: 5, z0: zc + 3, z1: zc + 9 });
      box(cx - 4, cx + 4, cy - 4, cy + 4, zc - 4, zc + 11, wm('CS', { tex: 'planks', paint: st.paint, cols: 6 }), wm('CE', { tex: 'planks', paint: st.paint, cols: 6, shade: 0.3 }), flat(st.paint));
      const ap = [cx, cy, zc + 21];
      prism('CR', cx, cy, 6.5, 0, zc + 11, zc + 21, 4, coneMat(RB, st.roof, zc + 11), Math.PI / 4);
      out.finial = Q(...ap);
    }
    out.ridge = Q(...I.ridgePt);
    if (W - u > 22) { hay(W - 11, D + 1.5); if (vb(14, 2)) hay(W - 10, D + 1.2 + 0, 6), box(W - 10, W - 4, D + 1.5, D + 5.5, 4, 8, q => [((q.col + Math.floor(q.z) * 2) % 5 === 0) ? dk(THATCH, 0.25) : THATCH, 0], q => [dk(THATCH, 0.3), 0], flat(lt(THATCH, 0.25))); }
    if (u > 22) { barrel(7, D + 4); if (vb(15, 2)) crate(11, D + 1); }
  }

  // Hamlet: a smock windmill: a stone base, a tapering eight-sided boarded body, a turning cap.
  function windmill() {
    const cx = W / 2, cy = D / 2, r0 = Math.min(W, D) * 0.44, rb = r0 * 0.84, rt = r0 * 0.56, zb = 13, zt = 60;
    groundShadow(cx - r0, cx + r0, cy - r0, cy + r0);
    const base = (nm, N, cols) => wm(nm, { tex: 'stone', paint: GREY, cols, zb: 0, shade: shOf(N) });
    prism('WB', cx, cy, r0, r0, 0, zb, 8, base);
    const body = st.paint, dark = body[0] < 120;
    // the reefing stage: a plank ring round the body
    prism('WP', cx, cy, r0 + 1.5, r0 + 1.5, zb, zb + 1.5, 8, (nm, N) => { const sh = shOf(N); return q => [shade(q.col % 3 ? lt(WOOD, 0.1) : dk(WOOD, 0.2), sh), 0]; });
    face([[cx - r0 - 1.5, cy - r0 - 1.5, zb + 1.5], [cx + r0 + 1.5, cy - r0 - 1.5, zb + 1.5], [cx + r0 + 1.5, cy + r0 + 1.5, zb + 1.5], [cx - r0 - 1.5, cy + r0 + 1.5, zb + 1.5]], 'S', q => { const dx = q.P[0] - cx, dy = q.P[1] - cy; return Math.max(Math.abs(dx), Math.abs(dy)) * 0.93 + Math.min(Math.abs(dx), Math.abs(dy)) * 0.38 > r0 + 1.5 ? [0, 0, 0, 0] : [Math.floor(q.P[0] + q.P[1]) % 3 ? lt(WOOD, 0.15) : WOOD, 0]; }, { keep: P => { const dx = P[0] - cx, dy = P[1] - cy, m = Math.max(Math.abs(dx), Math.abs(dy)); return m * 0.93 + Math.min(Math.abs(dx), Math.abs(dy)) * 0.38 <= r0 + 1.6; } });
    const fS = 'WM2'; // the side facing south carries the door and the windows
    fittings.push({ face: fS, kind: 'door', c0: 2, c1: 8, z0: 0, z1: 11, zb: zb + 1.5 });
    fittings.push({ face: fS, kind: 'win', c0: 3, c1: 6, z0: 24, z1: 29, flowers: false, shutters: false }, { face: 'WM1', kind: 'win', c0: 3, c1: 6, z0: 36, z1: 41, flowers: false, shutters: false }, { face: 'WM0', kind: 'win', c0: 3, c1: 6, z0: 20, z1: 25, flowers: false, shutters: false });
    prism('WM', cx, cy, rb, rt, zb + 1.5, zt, 8, (nm, N, cols) => wm(nm, { tex: 'clap', paint: body, cols, zb: zb + 1.5, shade: shOf(N), corner: 'post' }));
    // the cap: an eight-sided ogee hood, and the windshaft poking out south for the sails
    prism('WC', cx, cy, rt + 2.5, rt * 0.75, zt, zt + 7, 8, coneMat(RB, st.roof, zt));
    prism('WK', cx, cy, rt * 0.75, 0, zt + 7, zt + 16, 8, coneMat(RB, st.roof, zt + 7));
    const hy = cy + rt + 4, hz = zt + 3;
    box(cx - 1.6, cx + 1.6, cy + rt - 2, hy, hz - 1.6, hz + 1.6, flat(dk(DARKWOOD, 0.1)), flat(dk(DARKWOOD, 0.35)), flat(WOOD));
    cyl(cx, hy + 0.6, 2.4, hz - 2.2, hz + 2.2, q => [byLight(ramp(rgb('#6b6a72')), q.N, 0.1), 0]);
    out.hub = Q(cx, hy + 1, hz);
    out.door = Q(cx, cy + rb, 0);
    out.ridge = Q(cx, cy, zt + 16);
    out.finial = Q(cx, cy, zt + 16);
    if (vb(13, 2)) { hay(cx + r0 - 2, D - 3, 6); } else { box(cx - r0 + 1, cx - r0 + 7, D - 6, D - 1, 0, 5, q => [q.col % 3 ? lt(rgb('#efe6d4'), 0.05) : rgb('#d8ccb2'), 0], flat(rgb('#c9bea6')), flat(rgb('#f4ecdc'))); } // a flour sack heap
  }

  // Hamlet: a granary up on staddle stones (the mice can't climb them), a ladder of steps to its door.
  function granary() {
    const zf = 7, x0 = 2, x1 = W - 2, y0 = 2, y1 = D - 4, u = dU(10, W - 10);
    groundShadow(x0, x1, y0, y1);
    const SM = ramp(rgb('#b9b0a2'));
    for (const fx of [0.18, 0.5, 0.82]) for (const fy of [0.18, 0.5, 0.82]) {
      const px = x0 + (x1 - x0) * fx, py = y0 + (y1 - y0) * fy;
      cyl(px, py, 1.6, 0, 5, q => [byLight(SM, q.N, 0.05), 0]);
      cyl(px, py, 3.2, 5, zf, q => [q.cap ? SM[3] : byLight(SM, q.N, 0.15), 0]);
    }
    const S = storeys({ x0, x1, y0, y1, z0: zf, floors: [{ h: H - zf, tex: 'clap', paint: st.paint, corner: 'post' }], noFoot: true, eaveS: true, eaveE: true });
    const f0 = S.fl[0];
    fittings.push({ face: f0.nS, kind: 'door', c0: colOf(f0.nS, u) - 3, c1: colOf(f0.nS, u) + 3, z0: 0, z1: 11, zb: zf + 1 });
    out.door = Q(u, y1, 0);
    for (let i = 0; i < 3; i++) box(u - 4, u + 4, y1 + i * 1.6, y1 + i * 1.6 + 1.6, 0, zf - i * 2.4, stoneStep(0.05), stoneStep(0.3), flat(FOOT[3]));
    const c = finfo[f0.nE].cols >> 1;
    fittings.push({ face: f0.nE, kind: 'louvre', c0: c - 3, c1: c + 3, z0: zf + 7, z1: zf + 12 });
    const I = roof2({ x0, x1, y0, y1, zb: H, R, e: 3, ridge: 'EW', hip: true, mat: st.roof });
    out.ridge = Q(...I.ridgePt);
    if (vb(13, 2)) hay(x1 - 7, D - 2.5, 6);
  }

  // Village: a chapel, its nave north–south, a bell-cote or a slender spire at the south gable.
  function chapel() {
    const tex = st.wash ? 'white' : 'ashlar', paint = st.paint, x0 = 2, x1 = W - 5, y1 = D - 3, u = (x0 + x1) / 2;
    groundShadow(x0, x1, 0, y1);
    const S = storeys({ x0, x1, y0: 0, y1, floors: [{ h: H, tex, paint }], eaveE: true });
    const f0 = S.fl[0];
    const cs = winRow(f0.nE, 7, { kind: 'lancet', wd: 5, ht: 13, pad: 8, space: 9 });
    for (let i = 0; i <= cs.length; i++) { // buttresses between the windows
      const c = i === 0 ? 2 : i === cs.length ? finfo[f0.nE].cols - 2 : (cs[i - 1] + cs[i]) / 2, y = y1 - c / s;
      box(x1, x1 + 3, y - 1.6, y + 1.6, 0, 16, stoneM(paint, 0, tex), stoneM(paint, 0.32, tex), flat(lt(paint, 0.1)));
      face([[x1, y - 1.6, 20], [x1, y + 1.6, 20], [x1 + 3, y + 1.6, 16], [x1 + 3, y - 1.6, 16]], 'E', flat(dk(paint, 0.12)));
    }
    frontDoor(f0.nS, y1, u, { kind: 'portal', dw: 9, dh: 16, sw: 7, sd: 3.5 });
    const dc = colOf(f0.nS, u);
    winRow(f0.nS, 8, { kind: 'lancet', wd: 3, ht: 9, at: [dc - 11, dc + 11] });
    const I = roof2({ x0, x1, y0: 0, y1, zb: H, R, e: 3, ridge: 'NS', mat: st.roof, gable: stoneGable(tex, paint, H) });
    const gc = finfo.G.cols >> 1;
    fittings.push({ face: 'G', kind: 'rose', c0: gc - 5, c1: gc + 5, z0: H + 3, z1: H + 13, petals: 6 });
    const xm = (x0 + x1) / 2;
    if (!st.spire) { // a bell-cote standing on the gable
      const zb = I.zr - 7, zt = I.zr + 11;
      finfo.BS = { dir: 'S', Y: y1, x0: xm - 5, cols: 8 };
      fittings.push({ face: 'BS', kind: 'belfry', c0: 2, c1: 5, z0: zb + 8, z1: zt - 2, round: true });
      box(xm - 5, xm + 5, y1 - 6, y1, zb, zt, wm('BS', { tex, paint, cols: 8 }), wm('BE', { tex, paint, cols: 5, shade: 0.3 }), flat(paint));
      const J = roof2({ x0: xm - 5, x1: xm + 5, y0: y1 - 6, y1, zb: zt, R: 7, e: 1.5, ridge: 'NS', mat: st.roof, gname: 'BG', gable: stoneGable(tex, paint, zt) });
      out.crosses = [Q(xm, y1, J.zr + 1)];
      out.ridge = Q(xm, y1, J.zr);
    } else { // a little lead spire (a flèche) astride the ridge
      const cy = y1 - 14, zb = I.zr - 4;
      prism('FL', xm, cy, 4.5, 4.5, zb, zb + 9, 8, (nm, N, cols) => { const sh = shOf(N); return q => [shade((q.col % 2) && Math.floor(q.z) > zb + 2 && Math.floor(q.z) < zb + 7 ? dk(SHADE, 0.1) : lt(DARKWOOD, 0.1), sh), 0]; });
      prism('FS', xm, cy, 5.5, 0, zb + 9, zb + 40, 8, coneMat(LEAD, 'lead', zb + 9));
      out.crosses = [Q(xm, cy, zb + 41)];
      out.ridge = Q(xm, cy, zb + 40);
    }
    bush(x0 + 3, D, 2.6); if (vb(14, 2)) bush(x1 - 2, D, 2.4);
  }

  // Village: a smithy: a stone forge house, an open front shed over the anvil, a big forge chimney.
  function smithy() {
    const by = D - 13, u = dU(8, W - 18), fx = u < W / 2 ? W * 0.72 : W * 0.28;
    groundShadow();
    const S = storeys({ x0: 0, x1: W, y0: 0, y1: by, floors: [{ h: H, tex: 'stone', paint: GREY }], eaveS: false, eaveE: true });
    const f0 = S.fl[0], fc = colOf(f0.nS, fx);
    frontDoor(f0.nS, by, u, { dh: 13, step: false, board: 'anvil' });
    fittings.push({ face: f0.nS, kind: 'forge', c0: fc - 5, c1: fc + 5, z0: 2, z1: 12, round: true });
    winRow(f0.nE, 8, { max: 1, wd: 5, ht: 6 });
    const I = roof2({ x0: 0, x1: W, y0: 0, y1: by, zb: H, R, e: 2.5, ridge: 'EW', mat: 'slate', gable: stoneGable('stone', GREY, H) });
    // the open shed: a lean-to on two posts, sloping toward the street
    const zh = H - 4, zl = 12, k2 = (zh - zl) / (D - by);
    face([[-2, by, zh], [W + 2, by, zh], [W + 2, D + 2, zl - 2 * k2], [-2, D + 2, zl - 2 * k2]], 'S', roofMat(-0.04, null, 'x', { mat: 'shingle', base: jit(SHAKE, st.tone), noCap: true }));
    face([[W + 2, by, zh], [W + 2, D + 2, zl - 2 * k2], [W + 2, D + 2, zl - 2 * k2 - 2], [W + 2, by, zh - 2]], 'E', flat(dk(DARKWOOD, 0.2)));
    fasciaS(-2, W + 2, D + 2, zl - 2 * k2, 0, 'shingle');
    for (const px of [1.5, W - 1.5]) box(px - 1, px + 1, D - 1, D + 1, 0, zl - 1, q => [q.col === 0 ? lt(DARKWOOD, 0.2) : DARKWOOD, 0], flat(dk(DARKWOOD, 0.3)), flat(DARKWOOD));
    // the anvil on its block, a quench tub
    const ax = fx, ay = by + 7;
    box(ax - 2, ax + 2, ay - 2, ay + 2, 0, 4, flat(lt(WOOD, 0.05)), flat(dk(WOOD, 0.3)), flat(lt(WOOD, 0.2)));
    box(ax - 4, ax + 3.5, ay - 1.5, ay + 1.5, 4, 6.5, flat(rgb('#5d5a66')), flat(dk(rgb('#5d5a66'), 0.3)), flat(rgb('#8d8a96')));
    barrel(fx < W / 2 ? fx + 8 : fx - 8, by + 5);
    chimney(fx, by * 0.55, I.zr, H - 2, rgb('#8f877b'), 10, 4);
    out.glow = Q(fx, by, 6);
    out.ridge = Q(...I.ridgePt);
  }

  // Village: an inn: stone below, a jettied timber floor, dormers, two chimneys, the sign of the tankard.
  function inn() {
    const u = dU(), fr = st.frame;
    groundShadow();
    const floors = [{ h: 16, tex: 'ashlar', paint: SAND, corner: 'quoin', quoinC: lt(SAND, 0.1) }, { h: 15, tex: 'plaster', frame: fr, jet: 2 }];
    const S = storeys({ x0: 0, x1: W - 2, y0: 0, y1: D - 2, floors, jetE: true, eaveS: true });
    const [f0, f1] = S.fl;
    const gap = frontDoor(f0.nS, D - 2, u, { dw: 9, dh: 14, dbl: true, lamp: true, board: 'mug', sw: 6, mat: true });
    winRow(f0.nS, 6, { gap, shutters: true, flowers: true });
    winRow(f1.nS, f1.z + 4, { flowers: true, shutters: true });
    winRow(f0.nE, 6, { max: 2 }); winRow(f1.nE, f1.z + 4, { flowers: true, max: 2 });
    const I = roof2({ x0: 0, x1: S.x1, y0: 0, y1: S.y1, zb: S.z, R, e: 3, ridge: 'EW', mat: st.roof, gable: plasterGable(fr, S.z) });
    const gc = finfo.G.cols >> 1;
    fittings.push({ face: 'G', kind: 'win', c0: gc - 2, c1: gc + 2, z0: S.z + 4, z1: S.z + 10, flowers: false, shutters: false });
    dormer(I, W * 0.26, 12); dormer(I, W * 0.7, 12);
    chimney(W * 0.1, D * 0.3, I.zr, S.z - 2, rgb('#a95b3e'), 5); chimney(W * 0.9, D * 0.3, I.zr, S.z - 2, rgb('#a95b3e'), 5);
    out.ridge = Q(...I.ridgePt);
    const bx = u > W / 2 ? 4 : W - 16; // a bench and barrels out front
    box(bx, bx + 10, D + 0.5, D + 3.5, 3, 4, flat(dk(WOOD, 0.15)), flat(dk(WOOD, 0.3)), q => [Math.floor(q.P[1]) % 2 ? lt(WOOD, 0.15) : WOOD, 0]);
    for (const x of [bx + 0.5, bx + 8.2]) box(x, x + 1.3, D + 2, D + 3.3, 0, 3, flat(DARKWOOD), flat(dk(DARKWOOD, 0.2)), flat(DARKWOOD));
    barrel(u > W / 2 ? u - 12 : u + 12, D + 4);
  }

  // Town: the guildhall: an arcaded stone ground floor, two jettied timber floors, a central gable with
  // the guild's crest, banners, and a lead-spired lantern on the ridge.
  function guildhall() {
    const fr = st.frame, u = dU(14, W - 14), cx = Math.min(W - 18, Math.max(18, u));
    groundShadow();
    const floors = [{ h: 20, tex: 'ashlar', paint: SAND, corner: 'quoin', quoinC: lt(SAND, 0.12) }, { h: 16, tex: 'plaster', frame: fr, jet: 2 }, { h: 15, tex: 'plaster', frame: fr, jet: 2 }];
    const S = storeys({ x0: 0, x1: W - 4, y0: 0, y1: D - 4, floors, jetE: true, eaveS: true });
    const [f0, f1, f2] = S.fl;
    const gap = frontDoor(f0.nS, D - 4, u, { kind: 'portal', dw: 11, dh: 17, sw: 8, sd: 4, step2: true, lamp: true, lampL: true });
    winRow(f0.nS, 6, { gap, kind: 'lancet', wd: 5, ht: 11, pad: 8, space: 10 });
    winRow(f0.nE, 6, { kind: 'lancet', wd: 5, ht: 11, pad: 8, space: 10 });
    const ccol = colOf(f1.nS, cx), gp = [ccol - 16, ccol + 16];
    winRow(f1.nS, f1.z + 4, { gap: gp, flowers: true, shutters: false, panes: 3, wd: 9 });
    winRow(f2.nS, f2.z + 4, { gap: gp, flowers: false, panes: 3, wd: 9 });
    winRow(f1.nE, f1.z + 4, { flowers: true, panes: 3, wd: 9 }); winRow(f2.nE, f2.z + 4, { panes: 3, wd: 9 });
    for (const F of [f1, f2]) fittings.push({ face: F.nS, kind: 'win', c0: ccol - 6, c1: ccol + 6, z0: F.z + 3, z1: F.z + 11, flowers: F === f1, shutters: false, panes: 3 });
    fittings.push({ face: f0.nS, kind: 'banner', c0: gap[0] - 9, z0: 6 }, { face: f0.nS, kind: 'banner', c0: gap[1] + 4, z0: 6 });
    const I = roof2({ x0: 0, x1: S.x1, y0: 0, y1: S.y1, zb: S.z, R, e: 3, ridge: 'EW', hip: true, mat: 'slate' });
    const J = roof2({ x0: cx - 15, x1: cx + 15, y0: D / 2 - 6, y1: S.y1, zb: S.z, R: 22, e: 2.5, ridge: 'NS', gname: 'CG', gable: plasterGable(fr, S.z) });
    const gc = finfo.CG.cols >> 1;
    fittings.push({ face: 'CG', kind: 'clock', c0: gc - 5, c1: gc + 5, z0: S.z + 4, z1: S.z + 14 });
    for (const x of [(cx - 15) / 2, (cx + 15 + S.x1) / 2]) if (x > 8 && x < S.x1 - 8 && Math.abs(x - cx) > 22) dormer(I, x, 11);
    const ly = D * 0.32, zl = I.zr - 5; // the lantern and its spire
    prism('LB', cx, ly, 5.5, 5.5, zl, zl + 11, 8, (nm, N) => { const sh = shOf(N); return q => { const zi = Math.floor(q.z); return [shade(zi > zl + 3 && zi < zl + 9 && q.col % 4 !== 0 ? dk(SHADE, 0.05) : lt(st.paint, 0.05), sh), 0]; }; });
    prism('LS', cx, ly, 7, 0, zl + 11, zl + 34, 8, coneMat(LEAD, 'lead', zl + 11));
    out.finial = Q(cx, ly, zl + 34);
    out.ridge = Q(cx, ly, zl + 34);
    chimney(W * 0.12, D * 0.35, I.zr, S.z - 2, rgb('#9d9486'), 5);
    pot(gap[0] - 2, D + 2, true); pot(gap[1] + 2, D + 2, true);
  }

  // Town: a tall clock tower: a stone shaft, string courses, clock faces, an open belfry, a slate spire.
  function clocktower() {
    const x0 = 3, x1 = W - 3, y0 = 3, y1 = D - 3, paint = st.paint, zc = 64, zb = 80, zt = 94, u = (x0 + x1) / 2;
    groundShadow(x0, x1, y0, y1);
    box(x0 - 2, x1 + 2, y0 - 2, y1 + 2, 0, 5, stoneM(paint, 0.05), stoneM(paint, 0.32), capM(paint)); // the plinth
    wallS('TS', x0, x1, y1, 5, zc, { tex: 'ashlar', paint, belts: [26, 46] });
    wallE('TE', x1, y0, y1, 5, zc, { tex: 'ashlar', paint, belts: [26, 46] });
    const c = finfo.TS.cols >> 1;
    fittings.push({ face: 'TS', kind: 'portal', c0: c - 4, c1: c + 4, z0: 5, z1: 19, round: true });
    out.door = Q(u, y1, 0);
    box(u - 5, u + 5, y1, y1 + 3, 0, 2, stoneStep(0.05), stoneStep(0.3), flat(FOOT[3]));
    fittings.push({ face: 'TS', kind: 'slit', c0: c - 1, z0: 33, z1: 40 }, { face: 'TE', kind: 'slit', c0: c - 1, z0: 33, z1: 40 }, { face: 'TE', kind: 'slit', c0: c - 1, z0: 12, z1: 19 });
    fittings.push({ face: 'TS', kind: 'lancet', c0: c - 2, c1: c + 2, z0: 50, z1: 59 }, { face: 'TE', kind: 'lancet', c0: c - 2, c1: c + 2, z0: 50, z1: 59 });
    // the clock stage, corbelled out a little
    const o = 1.5;
    wallS('KS', x0 - o, x1 + o, y1 + o, zc, zb, { tex: 'ashlar', paint: lt(paint, 0.05), belts: [zc + 1] });
    wallE('KE', x1 + o, y0 - o, y1 + o, zc, zb, { tex: 'ashlar', paint: lt(paint, 0.05), belts: [zc + 1] });
    const kc = finfo.KS.cols >> 1;
    fittings.push({ face: 'KS', kind: 'clock', c0: kc - 6, c1: kc + 6, z0: zc + 2, z1: zc + 14 }, { face: 'KE', kind: 'clock', c0: kc - 6, c1: kc + 6, z0: zc + 2, z1: zc + 14 });
    wallS('BS', x0, x1, y1, zb, zt, { tex: 'ashlar', paint });
    wallE('BE', x1, y0, y1, zb, zt, { tex: 'ashlar', paint });
    fittings.push({ face: 'BS', kind: 'belfry', c0: c - 4, c1: c + 4, z0: zb + 1, z1: zt - 2, round: true }, { face: 'BE', kind: 'belfry', c0: c - 4, c1: c + 4, z0: zb + 1, z1: zt - 2, round: true });
    box(x0 - o, x1 + o, y0 - o, y1 + o, zt, zt + 3, stoneM(lt(paint, 0.1), 0), stoneM(lt(paint, 0.1), 0.3), capM(paint)); // the cornice
    const ap = [u, (y0 + y1) / 2, zt + 3 + R];
    prism('SP', u, (y0 + y1) / 2, (x1 - x0) / 2 * 1.38, 0, zt + 3, ap[2], 4, coneMat(RB, st.roofC === LEAD ? 'lead' : 'slate', zt + 3), Math.PI / 4);
    for (const [px, py] of [[x0, y1], [x1, y1], [x1, y0]]) prism('PN', px, py, 2, 0, zt + 3, zt + 12, 4, coneMat(lt(paint, 0.05), 'slate', zt + 3), Math.PI / 4); // corner pinnacles
    out.finial = Q(...ap);
    out.ridge = Q(...ap);
  }

  // Town: the market hall: an open arcade below (goods in the shade), a timber hall above, a hipped roof.
  function markethall() {
    const fr = st.frame, u = dU();
    groundShadow();
    const floors = [{ h: 20, tex: 'ashlar', paint: SAND }, { h: 16, tex: 'plaster', frame: fr, jet: 2 }];
    const S = storeys({ x0: 0, x1: W - 2, y0: 0, y1: D - 2, floors, jetE: true, eaveS: true, eaveE: true });
    const [f0, f1] = S.fl;
    const arcade = name => { const cols = finfo[name].cols, n = Math.max(2, Math.round(cols / 15)), aw = Math.floor((cols - 4) / n) - 4; for (let i = 0; i < n; i++) { const c0 = 4 + Math.round(i * (cols - 4) / n); fittings.push({ face: name, kind: 'arch', c0, c1: c0 + aw - 1, z0: 0, z1: 15, round: true, goods: h2(i, name.length, st.seed) % 3 !== 0 }); } };
    arcade(f0.nS); arcade(f0.nE);
    out.door = Q(u, D - 2, 0);
    winRow(f1.nS, f1.z + 4, { flowers: true, panes: 3, wd: 9, space: 6 });
    winRow(f1.nE, f1.z + 4, { panes: 3, wd: 9, space: 6 });
    const I = roof2({ x0: 0, x1: S.x1, y0: 0, y1: S.y1, zb: S.z, R, e: 3, ridge: 'EW', hip: true, mat: 'tile' });
    const cx = W / 2, cy = D / 2, zc = I.zr - 3; // a little louvred lantern with a weathervane
    finfo.LS = { dir: 'S', Y: cy + 4, x0: cx - 4, cols: 6 };
    fittings.push({ face: 'LS', kind: 'louvre', c0: 1, c1: 5, z0: zc + 2, z1: zc + 8 });
    box(cx - 4, cx + 4, cy - 4, cy + 4, zc - 3, zc + 10, wm('LS', { tex: 'plaster', paint: st.paint, cols: 6, corner: 'post' }), wm('LE', { tex: 'plaster', paint: st.paint, cols: 6, shade: 0.3, corner: 'post' }), flat(st.paint));
    prism('LR', cx, cy, 6.5, 0, zc + 10, zc + 19, 4, coneMat(RB, 'tile', zc + 10), Math.PI / 4);
    out.finial = Q(cx, cy, zc + 19);
    out.ridge = Q(cx, cy, zc + 19);
    fittings.push({ face: f1.nS, kind: 'banner', c0: 3, z0: f1.z + 2 });
  }

  // City: a cathedral: a long nave with aisles and flying buttresses, a rose window over the great door,
  // and either twin towers with spires at the south front or a crossing tower with one tall spire.
  function cathedral() {
    const paint = st.paint, F = D - 5, nx0 = W * 0.27, nx1 = W * 0.73, ax0 = W * 0.07, ax1 = W * 0.9, AH = 28, NH = H, twin = st.twin;
    const lead = st.roofC === LEAD ? 'lead' : 'slate', u = W / 2, sg = stoneGable('ashlar', paint, NH);
    groundShadow(ax0, ax1, 4, F);
    const yA0 = 8, yA1 = twin ? F - 24 : F - 6;
    // aisles: low walls under lean-to roofs against the nave
    wallE('AE', ax1, yA0, yA1, 0, AH, { tex: 'ashlar', paint, foot: true, eave: 4 });
    const ac = winRow('AE', 8, { kind: 'lancet', wd: 5, ht: 14, pad: 9, space: 11, stained: true });
    wallS('AS', nx1, ax1, yA1, 0, AH, { tex: 'ashlar', paint, foot: true });
    wallS('AW', ax0, nx0, yA1, 0, AH, { tex: 'ashlar', paint, foot: true });
    for (const nm of ['AS', 'AW']) winRow(nm, 8, { kind: 'lancet', wd: 5, ht: 14, max: 1, stained: true });
    const lean = (xa, xb, sh) => face([[xa, yA0 - 2, NH - 16], [xa, yA1 + 2, NH - 16], [xb, yA1 + 2, AH - 2], [xb, yA0 - 2, AH - 2]], 'E', roofMat(sh, null, 'y', { mat: lead, base: RB, noCap: true }));
    lean(nx1, ax1 + 3, 0.14); lean(nx0, ax0 - 3, 0.3);
    for (const [xa, xb] of [[nx1, ax1], [ax0, nx0]]) face([[xa, yA1, AH], [xb, yA1, AH], [xa < u ? xa : xb, yA1, NH - 16]].map(p => p), 'S', stoneM(paint, 0.02));
    // buttresses with pinnacles, and flying buttresses up to the clerestory
    const ys = [yA0 + 2, ...ac.slice(0, -1).map((c, i) => yA1 - (c + ac[i + 1]) / 2 / s), yA1 - 2];
    for (const y of ys) {
      box(ax1, ax1 + 4, y - 2, y + 2, 0, AH + 6, stoneM(paint, 0), stoneM(paint, 0.32), capM(paint));
      prism('BP', ax1 + 2, y, 2.6, 0, AH + 6, AH + 15, 4, coneMat(lt(paint, 0.05), 'slate', AH + 6), Math.PI / 4);
      face([[ax1, y + 1, AH + 2], [ax1, y + 1, AH + 6], [nx1, y + 1, NH - 4], [nx1, y + 1, NH - 9]], 'S', stoneM(paint, 0.08));
      face([[ax1, y - 1, AH + 6], [ax1, y + 1, AH + 6], [nx1, y + 1, NH - 4], [nx1, y - 1, NH - 4]], 'S', flat(lt(paint, 0.12)));
    }
    // the nave, its clerestory and the west... south front
    const N = storeys({ x0: nx0, x1: nx1, y0: 0, y1: F, floors: [{ h: NH, tex: 'ashlar', paint, belts: [AH + 2] }], eaveE: true, name: 'N' });
    winRow('NE0', NH - 15, { kind: 'lancet', wd: 4, ht: 9, pad: 8, space: 8, stained: true });
    frontDoor('NS0', F, u, { kind: 'portal', dw: 13, dh: 22, sw: 13, sd: 5, step2: true });
    const fc = colOf('NS0', u);
    fittings.push({ face: 'NS0', kind: 'rose', c0: fc - 8, c1: fc + 8, z0: 30, z1: 46, petals: 12 });
    if (!twin) fittings.push({ face: 'NS0', kind: 'lancet', c0: fc - 16, c1: fc - 12, z0: 8, z1: 24, stained: true }, { face: 'NS0', kind: 'lancet', c0: fc + 12, c1: fc + 16, z0: 8, z1: 24, stained: true });
    const I = roof2({ x0: nx0, x1: nx1, y0: 0, y1: F, zb: NH, R, e: 2, ridge: 'NS', mat: lead, gable: sg });
    const gc = finfo.G.cols >> 1;
    fittings.push({ face: 'G', kind: 'lancet', c0: gc - 2, c1: gc + 2, z0: NH + 6, z1: NH + 17, stained: true });
    out.crosses = [Q(u, F, I.zr + 1)];
    let topPt;
    if (twin) { // twin towers at the south front, each with an octagonal spire
      const TH = 100, ty0 = F - 24, ty1 = F + 1.5;
      for (const [tx0, tx1, nm] of [[W * 0.06, W * 0.34, 'W'], [W * 0.66, W * 0.94, 'E']]) {
        wallS(`T${nm}S`, tx0, tx1, ty1, 0, TH, { tex: 'ashlar', paint, foot: true, belts: [30, 58, 80], corner: 'quoin', quoinC: lt(paint, 0.08) });
        wallE(`T${nm}E`, tx1, ty0, ty1, 0, TH, { tex: 'ashlar', paint, foot: true, belts: [30, 58, 80], corner: 'quoin', quoinC: lt(paint, 0.08) });
        const c = finfo[`T${nm}S`].cols >> 1, ce = finfo[`T${nm}E`].cols >> 1;
        fittings.push({ face: `T${nm}S`, kind: 'lancet', c0: c - 3, c1: c + 3, z0: 36, z1: 53, stained: true }, { face: `T${nm}E`, kind: 'lancet', c0: ce - 3, c1: ce + 3, z0: 36, z1: 53 });
        fittings.push({ face: `T${nm}S`, kind: 'belfry', c0: c - 6, c1: c - 2, z0: 62, z1: 77, bell: false }, { face: `T${nm}S`, kind: 'belfry', c0: c + 2, c1: c + 6, z0: 62, z1: 77, bell: false });
        fittings.push({ face: `T${nm}E`, kind: 'belfry', c0: ce - 6, c1: ce - 2, z0: 62, z1: 77, bell: false }, { face: `T${nm}E`, kind: 'belfry', c0: ce + 2, c1: ce + 6, z0: 62, z1: 77, bell: false });
        fittings.push({ face: `T${nm}S`, kind: 'clock', c0: c - 5, c1: c + 5, z0: 84, z1: 95 });
        const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;
        box(tx0 - 1, tx1 + 1, ty0 - 1, ty1 + 1, TH, TH + 3, stoneM(lt(paint, 0.08), 0), stoneM(lt(paint, 0.08), 0.3), capM(paint));
        for (const [px, py] of [[tx0, ty1], [tx1, ty1], [tx1, ty0], [tx0, ty0]]) prism('TP', px, py, 2.4, 0, TH + 3, TH + 15, 4, coneMat(lt(paint, 0.05), 'slate', TH + 3), Math.PI / 4);
        prism(`TS${nm}`, cx, cy, (tx1 - tx0) * 0.46, 0, TH + 3, TH + 60, 8, coneMat(RB, lead, TH + 3));
        out.crosses.push(Q(cx, cy, TH + 61));
        topPt = [cx, cy, TH + 60];
      }
    } else { // a transept and a crossing tower with one tall spire
      const ty0 = D * 0.3, ty1 = D * 0.56, TH = NH - 4;
      const T = storeys({ x0: 0, x1: W, y0: ty0, y1: ty1, floors: [{ h: TH, tex: 'ashlar', paint, belts: [AH + 2] }], eaveS: true, name: 'X' });
      for (const nm of ['XS0']) { const cols = finfo[nm].cols; fittings.push({ face: nm, kind: 'lancet', c0: 8, c1: 13, z0: 10, z1: 30, stained: true }, { face: nm, kind: 'lancet', c0: cols - 14, c1: cols - 9, z0: 10, z1: 30, stained: true }); }
      roof2({ x0: 0, x1: W, y0: ty0, y1: ty1, zb: TH, R: R - 2, e: 2, ridge: 'EW', mat: lead, gname: 'XG', gable: stoneGable('ashlar', paint, TH) });
      const xc = finfo.XG.cols >> 1;
      fittings.push({ face: 'XG', kind: 'rose', c0: xc - 7, c1: xc + 7, z0: TH + 2, z1: TH + 16, petals: 8 });
      fittings.push({ face: 'XE0', kind: 'portal', c0: xc - 4, c1: xc + 4, z0: 0, z1: 15 }, { face: 'XE0', kind: 'lancet', c0: xc - 3, c1: xc + 3, z0: 22, z1: 40, stained: true });
      const cx = u, cy = (ty0 + ty1) / 2, hw = (ty1 - ty0) / 2 - 2, zt0 = NH + R - 8, zt1 = NH + R + 22;
      wallS('CS', cx - hw, cx + hw, cy + hw, zt0, zt1, { tex: 'ashlar', paint, belts: [zt1 - 2] });
      wallE('CE', cx + hw, cy - hw, cy + hw, zt0, zt1, { tex: 'ashlar', paint, belts: [zt1 - 2] });
      const c = finfo.CS.cols >> 1;
      for (const nm of ['CS', 'CE']) fittings.push({ face: nm, kind: 'belfry', c0: c - 7, c1: c - 3, z0: zt1 - 18, z1: zt1 - 4, bell: false }, { face: nm, kind: 'belfry', c0: c + 3, c1: c + 7, z0: zt1 - 18, z1: zt1 - 4, bell: false });
      for (const [px, py] of [[cx - hw, cy + hw], [cx + hw, cy + hw], [cx + hw, cy - hw], [cx - hw, cy - hw]]) prism('CP', px, py, 2.6, 0, zt1, zt1 + 14, 4, coneMat(lt(paint, 0.05), 'slate', zt1), Math.PI / 4);
      prism('CX', cx, cy, hw * 1.15, 0, zt1, zt1 + 80, 8, coneMat(RB, lead, zt1));
      out.crosses.push(Q(cx, cy, zt1 + 81));
      topPt = [cx, cy, zt1 + 80];
    }
    out.ridge = Q(...topPt);
  }

  // City: a stretch of town wall, crenellated stone, any length, east–west (N x 1) or north–south (1 x N).
  function wall() {
    const paint = st.paint, ew = W >= D, th = 9, hgt = H;
    if (ew) {
      const y0 = (D - th) / 2, y1 = y0 + th;
      groundShadow(0, W, y0, y1);
      box(0, W, y0 - 1, y1 + 1, 0, 6, stoneM(dk(paint, 0.05), 0), stoneM(dk(paint, 0.05), 0.3), capM(paint)); // the battered footing
      wallS('WS', 0, W, y1, 6, hgt, { tex: 'ashlar', paint });
      wallE('WE', W, y0, y1, 6, hgt, { tex: 'ashlar', paint });
      const cols = finfo.WS.cols;
      for (let c = 14; c < cols - 6; c += 26) fittings.push({ face: 'WS', kind: 'slit', c0: c, z0: 14, z1: 21 });
      face([[0, y0, hgt], [W, y0, hgt], [W, y1, hgt], [0, y1, hgt]], 'S', capM(dk(paint, 0.05))); // the wall walk
      merlons('x', 0, W, y1, 2.2, hgt, paint); merlons('x', 0, W, y0 + 2.2, 2.2, hgt, paint);
      out.ridge = Q(W / 2, (y0 + y1) / 2, hgt + 5);
    } else {
      const x0 = (W - th) / 2, x1 = x0 + th;
      groundShadow(x0, x1, 0, D);
      box(x0 - 1, x1 + 1, 0, D, 0, 6, stoneM(dk(paint, 0.05), 0), stoneM(dk(paint, 0.05), 0.3), capM(paint));
      wallE('WE', x1, 0, D, 6, hgt, { tex: 'ashlar', paint });
      wallS('WS', x0, x1, D, 6, hgt, { tex: 'ashlar', paint });
      const cols = finfo.WE.cols;
      for (let c = 14; c < cols - 6; c += 26) fittings.push({ face: 'WE', kind: 'slit', c0: c, z0: 14, z1: 21 });
      face([[x0, 0, hgt], [x1, 0, hgt], [x1, D, hgt], [x0, D, hgt]], 'S', capM(dk(paint, 0.05)));
      merlons('y', 0, D, x1, 2.2, hgt, paint); merlons('y', 0, D, x0 + 2.2, 2.2, hgt, paint);
      out.ridge = Q((x0 + x1) / 2, D / 2, hgt + 5);
    }
  }

  // City: a round wall tower with a corbelled ring and a tall conical roof.
  function walltower() {
    const cx = W / 2, cy = D / 2, r = Math.min(W, D) / 2 - 2.5, paint = st.paint, zt = H, u = cx;
    groundShadow(cx - r, cx + r, cy - r, cy + r);
    const door = { a: 0.25, w: 8, z0: 0, z1: 13, c: (du, zi) => { const inn = Math.abs(du) < 2.6 && (zi < 10 || Math.abs(du) < 2.6 - (zi - 10) * 0.9); const fr = Math.abs(du) < 4 && (zi < 11 || Math.abs(du) < 4 - (zi - 11) * 0.9); return inn ? [(Math.floor(du + 10) % 2) ? DOOR[2] : DOOR[1], 0] : fr ? [STR[du < 0 ? 3 : 2], 0] : null; } };
    const ops = [door, slitOp(0.25, 22, 29), slitOp(0.05, 16, 23), slitOp(0.17, 34, 41), winOp(0.25, 37, 43)];
    cyl(cx, cy, r + 1.2, 0, 4, roundWall(r + 1.2, dk(paint, 0.06))); // the footing
    cyl(cx, cy, r, 4, zt, roundWall(r, paint, ops));
    out.door = Q(cx, cy + r, 0);
    // the corbelled ring: a deeper band with dark machicolation gaps
    cyl(cx, cy, r + 1.6, zt - 4, zt, q => { if (q.cap) return [lt(paint, 0.1), 0]; const zi = Math.floor(q.z), u2 = q.ang * 2 * Math.PI * (r + 1.6); return [shade(zi === zt - 4 && Math.floor(u2) % 4 < 2 ? dk(SHADE, 0.1) : zi === zt - 1 ? lt(paint, 0.18) : paint, Math.round(shOf(q.N) / 0.06) * 0.06), 0]; });
    prism('TR', cx, cy, r + 3.5, 0, zt, zt + R, 16, coneMat(RB, st.roofC === SLATE ? 'slate' : 'tile', zt));
    out.finial = Q(cx, cy, zt + R);
    out.ridge = Q(cx, cy, zt + R);
    if (u) box(cx - 4, cx + 4, cy + r, cy + r + 2.5, 0, 1.6, stoneStep(0.05), stoneStep(0.3), flat(FOOT[3]));
  }

  // City: a gatehouse: a crenellated block with an arched, portcullised passage between two round turrets.
  function gatehouse() {
    const paint = st.paint, y0 = 3, y1 = D - 3, r = 6.5, u = dU(16, W - 16), zt = H, tz = H + 10;
    groundShadow(0, W, y0, y1);
    wallS('GS', 0, W, y1, 0, zt, { tex: 'ashlar', paint, foot: true, belts: [zt - 6] });
    wallE('GE', W, y0, y1, 0, zt, { tex: 'ashlar', paint, foot: true, belts: [zt - 6] });
    const c = colOf('GS', u);
    fittings.push({ face: 'GS', kind: 'gate', c0: c - 7, c1: c + 7, z0: 0, z1: 22, round: true });
    out.door = Q(u, y1, 0);
    fittings.push({ face: 'GS', kind: 'crest', c0: c - 3, z0: 27 }, { face: 'GS', kind: 'slit', c0: c - 12, z0: 26, z1: 33 }, { face: 'GS', kind: 'slit', c0: c + 10, z0: 26, z1: 33 });
    fittings.push({ face: 'GE', kind: 'slit', c0: (finfo.GE.cols >> 1) - 1, z0: 22, z1: 29 });
    face([[0, y0, zt], [W, y0, zt], [W, y1, zt], [0, y1, zt]], 'S', capM(dk(paint, 0.05)));
    merlons('x', 0, W, y1, 2.2, zt, paint); merlons('y', y0, y1, W, 2.2, zt, paint); merlons('x', 0, W, y0 + 2.2, 2.2, zt, paint);
    for (const tx of [r, W - r]) { // the turrets on the front corners
      const ops = [slitOp(0.25, 14, 21), slitOp(0.25, 32, 39), slitOp(tx < W / 2 ? 0.4 : 0.05, 24, 31)];
      cyl(tx, y1 - r + 2, r, 0, tz, roundWall(r, paint, ops));
      cyl(tx, y1 - r + 2, r + 1.2, tz - 3, tz, q => [q.cap ? lt(paint, 0.1) : shade(Math.floor(q.z) === tz - 3 && Math.floor(q.ang * 50) % 3 === 0 ? dk(SHADE, 0.1) : paint, Math.round(shOf(q.N) / 0.06) * 0.06), 0]);
      prism('GT', tx, y1 - r + 2, r + 3, 0, tz, tz + 26, 12, coneMat(RB, st.roofC === SLATE ? 'slate' : 'tile', tz));
      out.finial = Q(tx, y1 - r + 2, tz + 26);
    }
    fittings.push({ face: 'GS', kind: 'banner', c0: c - 16, z0: 8 }, { face: 'GS', kind: 'banner', c0: c + 12, z0: 8 });
    box(u - 9, u + 9, y1, y1 + 3, 0, 1, stoneStep(0.05), stoneStep(0.3), flat(FOOT[3]));
    out.ridge = Q(W / 2, (y0 + y1) / 2, zt + 5);
  }

  if (!site && st.kit) buildKit();

  // ---------- rasterise ----------
  const N = w * h, depth = new Float32Array(N).fill(-Infinity), fid = new Int16Array(N).fill(-1);
  const d2 = 2 + s * s;
  faces.forEach((f, i) => {
    if (f.sphere || f.cyl) {
      const [cx, cy] = f.sphere || f.cyl, r = f.sphere ? f.sphere[3] : f.cyl[2];
      const zlo = f.sphere ? f.sphere[2] - r : f.cyl[3], zhi = f.sphere ? f.sphere[2] + r : f.cyl[4];
      const [X0, Y0] = Q(cx, cy, zlo), [, Y1] = Q(cx, cy, zhi);
      for (let py = Math.max(0, Math.floor(Y1 - r - top - 1)); py < Math.min(h, Math.ceil(Y0 + r - top + 1)); py++) for (let px = Math.max(0, Math.floor(X0 - r * 1.2 - left - 1)); px < Math.min(w, Math.ceil(X0 + r * 1.2 - left + 1)); px++) {
        const X = left + px + 0.5, Y = top + py + 0.5, gx = (X / s + 2 * Y / s) / 2, gy = (2 * Y / s - X / s) / 2;
        const ox = gx - cx, oy = gy - cy;
        let t = -Infinity;
        if (f.sphere) {
          const oz = -f.sphere[2], b = 2 * (ox + oy + s * oz), c = ox * ox + oy * oy + oz * oz - r * r, disc = b * b - 4 * d2 * c;
          if (disc < 0) continue;
          t = (-b + Math.sqrt(disc)) / (2 * d2);
          if (s * t < Math.max(0, f.sphere[2] - r * 0.15) && f.sphere[2] > r) continue;
          if (s * t < 0) continue;
        } else {
          const [, , , z0, z1] = f.cyl, tc = z1 / s; // the lid, then the side
          if ((ox + tc) ** 2 + (oy + tc) ** 2 <= r * r) t = tc;
          const disc = 4 * (ox + oy) ** 2 - 8 * (ox * ox + oy * oy - r * r);
          if (disc >= 0) { const ts = (-2 * (ox + oy) + Math.sqrt(disc)) / 4; if (s * ts >= z0 && s * ts <= z1 && ts > t) t = ts; }
          if (t === -Infinity) continue;
        }
        const j = py * w + px;
        if (t > depth[j]) { depth[j] = t; fid[j] = i; }
      }
      return;
    }
    const nd = f.n[0] + f.n[1] + f.n[2] * s;
    if (Math.abs(nd) < 1e-6) return;
    const xs = f.scr.map(p => p[0]), ys = f.scr.map(p => p[1]);
    const px0 = Math.max(0, Math.floor(Math.min(...xs) - left)), px1 = Math.min(w - 1, Math.ceil(Math.max(...xs) - left));
    const py0 = Math.max(0, Math.floor(Math.min(...ys) - top)), py1 = Math.min(h - 1, Math.ceil(Math.max(...ys) - top));
    f.left = Math.min(...xs);
    for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
      const X = left + px + 0.5, Y = top + py + 0.5;
      if (!inPoly(X, Y, f.scr)) continue;
      const gx = (X / s + 2 * Y / s) / 2, gy = (2 * Y / s - X / s) / 2;
      const t = (f.c - f.n[0] * gx - f.n[1] * gy) / nd;
      const j = py * w + px;
      if (t > depth[j] + 1e-4 && (!f.keep || f.keep([gx + t, gy + t, s * t], Math.floor(X - (f.col0 ?? f.left))))) { depth[j] = t; fid[j] = i; }
    }
  });
  // Paint each pixel with its surface's material.
  const col = new Uint8ClampedArray(N * 4), soft = new Uint8Array(N);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const j = py * w + px, i = fid[j];
    if (i < 0) continue;
    const f = faces[i], X = left + px + 0.5, Y = top + py + 0.5, t = depth[j];
    const gx = (X / s + 2 * Y / s) / 2, gy = (2 * Y / s - X / s) / 2, P = [gx + t, gy + t, s * t];
    // col: whole screen px from the face's left end; z: height; row: screen rows up from the face's eave.
    const q = { P, col: Math.floor(X - (f.col0 ?? f.left ?? 0)), z: P[2], row: f.sphere || f.cyl ? 0 : rowUp(f, X, Y), rmax: f.rmax };
    if (f.sphere) { const [cx, cy, cz, r] = f.sphere; q.N = [(P[0] - cx) / r, (P[1] - cy) / r, (P[2] - cz) / r]; q.ang = (Math.atan2(P[1] - cy, P[0] - cx) / (2 * Math.PI) + 1) % 1; }
    if (f.cyl) { const [cx, cy, r, , z1] = f.cyl; q.cap = P[2] >= z1 - 1e-3; q.N = q.cap ? [0, 0, 1] : [(P[0] - cx) / r, (P[1] - cy) / r, 0]; q.ang = (Math.atan2(P[1] - cy, P[0] - cx) / (2 * Math.PI) + 1) % 1; q.z = P[2]; }
    const [c, , a = 1] = f.mat(q);
    if (f.soft) { if (a <= 0) { fid[j] = -1; continue; } soft[j] = 1; }
    col[j * 4] = c[0]; col[j * 4 + 1] = c[1]; col[j * 4 + 2] = c[2]; col[j * 4 + 3] = Math.round(255 * a);
  }
  // Outline: round the silhouette (a dark tint of the colour it outlines), and a softer line wherever a
  // nearer face overlaps a farther one. Soft shadow pixels count as empty.
  const solid = j => fid[j] >= 0 && !soft[j];
  const ink = new Uint8Array(N);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const j = py * w + px;
    if (!solid(j)) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || !solid(y * w + x)) { ink[j] = 2; break; }
      const k = y * w + x;
      if (fid[k] !== fid[j] && depth[k] > depth[j] + 1.2) ink[j] = Math.max(ink[j], 1);
    }
  }
  for (let j = 0; j < N; j++) if (ink[j]) {
    const here = [col[j * 4], col[j * 4 + 1], col[j * 4 + 2]], c = ink[j] === 2 ? mix(here, OUTLINE, 0.74) : dk(here, 0.5);
    col[j * 4] = c[0]; col[j * 4 + 1] = c[1]; col[j * 4 + 2] = c[2];
  }
  const c = canvas(w, h), g = c.getContext('2d');
  g.putImageData(new ImageData(col, w, h), 0, 0);
  // Site timber: posts, beams and the truss as whole-pixel lines (outlined, then wood).
  if (out.lines) {
    const plot = (a, b, color, wd) => { const [x0, y0] = Q(...a), [x1, y1] = Q(...b), n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)))); g.fillStyle = color; for (let i = 0; i <= n; i++) g.fillRect(Math.round(x0 + (x1 - x0) * i / n - left) - (wd >> 1), Math.round(y0 + (y1 - y0) * i / n - top) - (wd >> 1), wd, wd); };
    for (const [a, b] of out.lines) plot(a, b, '#3a2418', 3);
    for (const [a, b] of out.lines) plot(a, b, '#d29454', 1);
  }
  for (const [x, y] of out.crosses || []) { const X = Math.round(x - left), Y = Math.round(y - top); g.fillStyle = '#4a2f1a'; g.fillRect(X - 1, Y - 9, 3, 10); g.fillRect(X - 3, Y - 7, 7, 3); g.fillStyle = '#e9b949'; g.fillRect(X, Y - 8, 1, 8); g.fillRect(X - 2, Y - 6, 5, 1); g.fillStyle = '#fff1bf'; g.fillRect(X, Y - 8, 1, 1); }
  if (out.finial) { const [x, y] = out.finial, X = Math.round(x - left), Y = Math.round(y - top); g.fillStyle = '#4a2f1a'; g.fillRect(X - 1, Y - 6, 3, 6); g.fillRect(X - 2, Y - 9, 5, 4); g.fillStyle = '#e9b949'; g.fillRect(X, Y - 6, 1, 5); g.fillRect(X - 1, Y - 8, 3, 2); g.fillStyle = '#fff1bf'; g.fillRect(X - 1, Y - 8, 1, 1); }
  if (out.flag) { // the crown's flag in the project accent on a gilt-knobbed pole
    const [x, y] = out.flag, X = Math.round(x - left), Y = Math.round(y - top), A = it.village.accent;
    g.fillStyle = '#2a1c2e'; g.fillRect(X - 1, Y - 20, 3, 20);
    g.fillStyle = '#e9b949'; g.fillRect(X - 1, Y - 23, 3, 3); g.fillStyle = '#fff1bf'; g.fillRect(X - 1, Y - 23, 1, 1);
    g.fillStyle = '#8a6a4a'; g.fillRect(X, Y - 20, 1, 20);
    const ac = rgb(A), css = c => `rgb(${c.map(Math.round).join(',')})`;
    for (let c = 0; c < 12; c++) {
      const yt = Y - 19 + Math.round(Math.sin(c / 2.2) * 0.9), notch = c >= 9;
      g.fillStyle = css(mix(ac, OUTLINE, 0.7)); g.fillRect(X + 1 + c, yt - 1, 1, 10);
      for (let r = 0; r < 8; r++) {
        if (notch && (r === 3 || r === 4 || (c === 11 && r >= 2 && r <= 5))) { g.clearRect(X + 1 + c, yt + r, 1, 1); continue; }
        g.fillStyle = css(r < 2 ? lt(ac, 0.22) : r >= 6 ? dk(ac, 0.28) : (c === 3 || c === 4) && r >= 3 && r <= 4 ? GOLD : ac);
        g.fillRect(X + 1 + c, yt + r, 1, 1);
      }
    }
  }
  if (out.vane) { // a plain iron weathervane
    const [x, y] = out.vane, X = Math.round(x - left), Y = Math.round(y - top);
    g.fillStyle = '#2a2430'; g.fillRect(X, Y - 9, 1, 9); g.fillRect(X - 3, Y - 7, 7, 1); g.fillRect(X + 3, Y - 8, 1, 3); g.fillRect(X - 1, Y - 10, 3, 2);
  }
  // The tight box of what was drawn (hit testing, the selection outline).
  const im = g.getImageData(0, 0, w, h).data;
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) if (im[(py * w + px) * 4 + 3]) { if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py; }
  const res = { img: c, dx: left, dy: top, windows: out.windows, door: out.door, ridge: out.ridge, chimney: out.chimney, box: [left + bx0, top + by0, bx1 - bx0 + 1, by1 - by0 + 1], style: st };
  if (out.hub) res.hub = out.hub; // the windmill's sail hub (ambient.js turns the sails)
  if (out.glow) res.glow = out.glow; // the smithy's forge mouth (ambient.js flickers it)
  return res;
}

// Screen rows up a face from its lowest edge (walls: height in px; roofs: courses up from the eave).
function rowUp(f, X, Y) {
  const key = f.dir === 'S' ? Y - X / 2 : Y + X / 2;
  return f.sgn * (key - f.k0);
}
function inPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
