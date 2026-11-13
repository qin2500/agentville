// Dev-only sprite sheet (?artsheet, with ?mock): every building look and every procedural prop drawn in
// isolation at 3x on a neutral ground, so the art can be judged (and regression-checked) away from the
// town. tools/artpass/capture.mjs --sheet saves each page (window.artSheetPages) as a PNG.
import { isoBuilding } from '../iso.js';
import { createPropArt } from '../props-art.js';
import { ACCENT } from '../world.js';

const T = 16, Z = 3, night = new URLSearchParams(location.search).get('night') === '1';
// [look, w, h] as city-plan.js DIM places them (+ the legacy sprite-era looks world.js still knows).
const LOOKS = [
  ['farmhouse', 3, 3], ['cottage', 3, 3], ['timber', 3, 3], ['timber', 4, 3], ['townhouse', 2, 3], ['townhouse', 3, 3], ['manor', 4, 4], ['hall', 4, 5],
  ['barn', 4, 3], ['windmill', 3, 3], ['granary', 2, 2], ['chapel', 3, 5], ['smithy', 3, 3], ['inn', 4, 3], ['guildhall', 5, 4], ['clocktower', 2, 2],
  ['markethall', 5, 3], ['cathedral', 6, 8], ['wall', 4, 1], ['walltower', 2, 2], ['gatehouse', 3, 2],
  ['houseA', 4, 3], ['houseH', 3, 3], ['towerWood', 2, 2], ['towerDome', 2, 2],
];
const PROPS = ['fountain', 'well', 'stall', 'haystack', 'woodpile', 'bench', 'statue', 'noticeboard', 'signpost', 'beehive', 'trough', 'maypole', 'flowerbox', 'lamppost', 'bridge'];
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const pages = [];

function buildingPage(look, w, h, kind, variants) {
  const all = variants.map(v => {
    const it = { id: `sheet:${look}:${v}`, kind, building: false, look, w, h, x: 0, y: 0, doorX: w * 8, variant: v, village: { accent: ACCENT[v % ACCENT.length] } };
    return { v, b: isoBuilding(it, T, night) };
  });
  // Pages of at most ~1500 x 1050 px, so each can be read at full size.
  const cw = Math.max(...all.map(c => c.b.img.width)) + 16, ch = Math.max(...all.map(c => c.b.img.height)) + 22;
  const cols = Math.max(1, Math.floor(1500 / (cw * Z))), per = cols * Math.max(1, Math.floor(1050 / (ch * Z)));
  for (let p0 = 0; p0 < all.length; p0 += per) {
    const cells = all.slice(p0, p0 + per), rows = Math.ceil(cells.length / cols), cv = canvas(Math.min(cells.length, cols) * cw * Z, rows * ch * Z), g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.fillStyle = night ? '#2b3348' : '#8a8f6a'; g.fillRect(0, 0, cv.width, cv.height);
    cells.forEach((c, i) => {
      const x = (i % cols) * cw * Z, y = Math.floor(i / cols) * ch * Z, ox = x + (8 - c.b.dx) * Z, oy = y + (16 - c.b.dy) * Z; // (ox, oy): isoP(x0, y0) on the page
      // the footprint diamond, so anything drawn outside it (or floating off it) is plain to see
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.beginPath();
      for (const [a, b] of [[0, 0], [w * T, 0], [w * T, h * T], [0, h * T]]) g.lineTo(ox + (a - b) * 0.8 * Z, oy + (a + b) * 0.4 * Z);
      g.fill();
      g.drawImage(c.b.img, x + 8 * Z, y + 16 * Z, c.b.img.width * Z, c.b.img.height * Z);
      g.fillStyle = '#ff2bd6'; // anchors: ridge (flag), chimney (smoke), door
      for (const pt of [c.b.ridge, c.b.chimney, c.b.door]) if (pt) g.fillRect(ox + pt[0] * Z - 1, oy + pt[1] * Z - 1, 3, 3);
      g.fillStyle = '#fff'; g.font = '14px monospace'; g.fillText(`${look} ${w}x${h} ${kind} v${c.v}`, x + 6, y + 14);
    });
    pages.push({ name: `${look}-${w}x${h}-${kind}${night ? '-night' : ''}${all.length > per ? `-p${p0 / per}` : ''}`, canvas: cv });
  }
}

function propPage(art) {
  const all = [];
  for (const kind of PROPS) for (let v = 0; v < 4; v++) all.push({ kind, v });
  for (const dir of ['x', 'y']) for (const len of [1, 2, 4, 7]) for (const v of [0, 1]) all.push({ kind: 'fence', v, dir, len });
  for (const dir of ['x', 'y']) all.push({ kind: 'bridge', v: 0, dir });
  const cw = 124, ch = 86, cols = 4, per = 16;
  for (let p0 = 0; p0 < all.length; p0 += per) {
    const cells = all.slice(p0, p0 + per), rows = Math.ceil(cells.length / cols), cv = canvas(cols * cw * Z, rows * ch * Z), g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.fillStyle = night ? '#2b3348' : '#8a8f6a'; g.fillRect(0, 0, cv.width, cv.height);
    g.scale(Z, Z);
    cells.forEach((p, i) => {
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch, fx = x + (p.dir === 'x' && p.len > 2 ? 30 : p.dir === 'y' && p.len > 2 ? 100 : 62), fy = y + (p.kind === 'fence' ? 24 : 70);
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.beginPath(); // the prop's own tile
      for (const [a, b] of [[-8, -8], [8, -8], [8, 8], [-8, 8]]) g.lineTo(fx + (a - b) * 0.8, fy + (a + b) * 0.4);
      g.fill();
      art.draw(g, p, fx, fy, 0, night ? 1 : 0);
      g.fillStyle = '#ff2bd6'; g.fillRect(fx, fy, 1, 1);
      g.fillStyle = '#fff'; g.font = '5px monospace'; g.fillText(`${p.kind} v${p.v}${p.len ? ` ${p.dir}${p.len}` : ''}`, x + 2, y + 6);
    });
    pages.push({ name: `props${night ? '-night' : ''}-p${p0 / per}`, canvas: cv });
  }
}

const V12 = Array.from({ length: 12 }, (_, i) => i);
for (const [look, w, h] of LOOKS) {
  const big = w * h >= 16;
  buildingPage(look, w, h, ['wall', 'walltower', 'gatehouse', 'barn', 'windmill', 'granary', 'chapel', 'smithy', 'inn', 'guildhall', 'clocktower', 'markethall', 'cathedral'].includes(look) ? 'civic' : 'house', big ? V12.slice(0, 6) : V12);
}
for (const [look, w, h] of [['cottage', 3, 3], ['timber', 3, 3], ['townhouse', 2, 3], ['farmhouse', 3, 3]]) buildingPage(look, w, h, 'pr', V12.slice(0, 6));
// building sites (a live PR): the scaffold
{
  const cells = [['cottage', 3, 3], ['timber', 4, 3], ['townhouse', 2, 3], ['manor', 4, 4]].map(([look, w, h], v) => ({ v, b: isoBuilding({ id: `site:${look}`, kind: 'pr', building: true, look, w, h, x: 0, y: 0, doorX: w * 8, variant: v, village: { accent: ACCENT[v] } }, T, night) }));
  const cv = canvas(cells.reduce((n, c) => n + c.b.img.width + 16, 0) * Z, (Math.max(...cells.map(c => c.b.img.height)) + 20) * Z), g = cv.getContext('2d');
  g.imageSmoothingEnabled = false; g.fillStyle = '#6f9a44'; g.fillRect(0, 0, cv.width, cv.height);
  let x = 0; for (const c of cells) { g.drawImage(c.b.img, x + 8 * Z, 16 * Z, c.b.img.width * Z, c.b.img.height * Z); x += (c.b.img.width + 16) * Z; }
  pages.push({ name: `sites${night ? '-night' : ''}`, canvas: cv });
}
propPage(createPropArt());
window.artSheetPages = pages;
window.artSheetReady = true;
