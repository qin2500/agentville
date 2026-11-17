// How varied do the buildings of each city look? Builds the engine fixture world, rasters every lot building with the
// real classic art (web/src/iso.js, via a stand-in canvas) and compares neighbours by sprite and by silhouette.
// Pure: no network, no sessions, deterministic. `root` can be another checkout (measure main vs a branch).
//   node tools/engine/variety-metric.mjs [--root path] [--fixture busy] [--tiers 2,3] [--seed 7] [--max 400] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

class RecCanvas {
  constructor(w, h) { this.width = w; this.height = h; this._buf = null; }
  get buf() { return (this._buf ||= new Uint8ClampedArray(this.width * this.height * 4)); }
  getContext() {
    const c = this, log = () => {};
    const ctx = {
      fillStyle: '#000',
      putImageData(id, x, y) { for (let j = 0; j < id.height; j++) c.buf.set(id.data.subarray(j * id.width * 4, (j + 1) * id.width * 4), ((j + y) * c.width + x) * 4); },
      fillRect: log, clearRect: log,
      drawImage(src, x, y) {
        for (let j = 0; j < src.height; j++) for (let i = 0; i < src.width; i++) {
          const s = (j * src.width + i) * 4; if (!src.buf[s + 3]) continue;
          for (let k = 0; k < 4; k++) c.buf[((j + y) * c.width + i + x) * 4 + k] = src.buf[s + k];
        }
      },
      getImageData(x = 0, y = 0, w = c.width, h = c.height) { return { data: c.buf, width: w, height: h }; },
    };
    return ctx;
  }
}

const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex').slice(0, 16); };
const spriteFp = b => sha(Buffer.from(b.img.buf.buffer, b.img.buf.byteOffset, b.img.buf.byteLength), JSON.stringify([b.img.width, b.img.height, b.dx, b.dy]));
function silhouetteFp(b) {
  const px = b.img.buf, n = b.img.width * b.img.height, m = Buffer.alloc(n);
  for (let i = 0; i < n; i++) m[i] = px[i * 4 + 3] > 0 ? 1 : 0;
  return sha(m, JSON.stringify([b.img.width, b.img.height]));
}

// Perceptual features: what a viewer sees at a glance. The pixel fingerprints above differ for any one-pixel change, so
// they cannot tell 'the same house again' from 'a different house'. A look-alike pair has nearly the same silhouette
// (alpha-mask IoU, aligned at the footprint's north corner) AND nearly the same roof and wall colours.
export const LOOKALIKE = Object.freeze({ iou: 0.85, colour: 20 });
function features(b) {
  const W = b.img.width, H = b.img.height, px = b.img.buf, mask = new Uint8Array(W * H);
  let top = H, bot = -1;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (px[(j * W + i) * 4 + 3] > 0) { mask[j * W + i] = 1; if (j < top) top = j; if (j > bot) bot = j; }
  // roof: the top 35% of the opaque rows; walls: the band from 55% to 85%
  const band = (f0, f1) => { const y0 = top + Math.floor((bot - top) * f0), y1 = top + Math.floor((bot - top) * f1); let r = 0, g = 0, bl = 0, n = 0;
    for (let j = y0; j <= y1; j++) for (let i = 0; i < W; i++) { const k = (j * W + i) * 4; if (px[k + 3] > 0) { r += px[k]; g += px[k + 1]; bl += px[k + 2]; n++; } }
    return n ? [r / n, g / n, bl / n] : [0, 0, 0]; };
  return { W, H, dx: b.dx, dy: b.dy, mask, height: bot - top + 1, roof: band(0, 0.35), wall: band(0.55, 0.85) };
}
function iou(a, b) {
  let inter = 0, uni = 0;
  const x0 = Math.min(a.dx, b.dx), y0 = Math.min(a.dy, b.dy), x1 = Math.max(a.dx + a.W, b.dx + b.W), y1 = Math.max(a.dy + a.H, b.dy + b.H);
  const at = (f, x, y) => { const i = x - f.dx, j = y - f.dy; return i >= 0 && j >= 0 && i < f.W && j < f.H ? f.mask[j * f.W + i] : 0; };
  for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) { const p = at(a, x, y), q = at(b, x, y); if (p || q) { uni++; if (p && q) inter++; } }
  return uni ? inter / uni : 1;
}
const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const q = (c, s = 24) => c.map(v => Math.round(v / s)).join(',');

const gap = (a0, aw, b0, bw) => Math.max(a0, b0) - Math.min(a0 + aw, b0 + bw);
const pct = (a, b) => (b ? +(100 * a / b).toFixed(1) : 0);
const mean = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0);

export async function measureVariety({ root = HERE, fixture = 'busy', seed = 7, tiers = [2, 3], maxBuildings = 400 } = {}) {
  root = path.resolve(root);
  const url = rel => pathToFileURL(path.join(root, rel)).href;
  if (!fs.existsSync(path.join(root, 'mods', 'index.js'))) {
    const { writeModsIndex } = await import(url('tools/mods-index.mjs'));
    writeModsIndex(root);
  }
  globalThis.ImageData ??= class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  globalThis.document ??= { createElement: () => new RecCanvas(1, 1), addEventListener() {}, documentElement: { style: {}, classList: { add() {}, remove() {}, toggle() {} } } };
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  const iso = await import(url('web/src/iso.js'));
  const { buildWorld } = await import(url('web/src/engine/world/build.js'));
  const { viewFromFixture } = await import(url('web/src/engine/snapshot.js'));
  const { toWorldInput } = await import(url('web/src/engine/mod/input.js'));
  const { default: fantasy } = await import(url('mods/agentville.fantasy/index.js'));
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'e2e/fixtures/engine', `${fixture}.json`), 'utf8'));
  const { input, serverId } = toWorldInput(viewFromFixture(fx, { now: fx.now }), { seed, salt: 0, features: fantasy.features });
  const world = buildWorld(input, {}, { mod: fantasy, now: fx.now, seed, serverId });

  const want = new Set(tiers);
  const vill = new Map(world.villages.map(v => [v.name, v]));
  const styleOf = new Map(world.villages.map(v => [v.name, v.style && typeof v.style === 'object' ? v.style : null]));
  const byCity = new Map();
  for (const o of world.objects.values()) {
    if (o.kind !== 'building' || !String(o.id ?? '').startsWith('lot:')) continue;
    const v = vill.get(o.project);
    if (!v || !want.has(v.tier)) continue;
    // a live PR's construction site is drawn as scaffolding on purpose (a state signal): not house art, not measured
    if (o.data?.owner === 'pr' ? !!o.data.building : !!o.data?.site) continue;
    if (!byCity.has(o.project)) byCity.set(o.project, []);
    byCity.get(o.project).push(o);
  }

  const cache = new Map();
  const T = 16;
  const rasterOf = o => {
    const m = fantasy.styles?.[o.styleKey];
    const style = m && typeof m === 'object' ? m : styleOf.get(o.project) ?? undefined;
    const site = o.data?.owner === 'pr' ? !!o.data.building : !!o.data?.site;
    const it = { id: `r3:${o.model}:${o.variant | 0}`, kind: site ? 'pr' : 'building', look: o.model, w: o.w, h: o.h, x: 0, y: 0, variant: o.variant | 0,
      village: { accent: style?.accent ?? '#c46a42' }, doorX: Math.round(o.w * T / 2), crown: !!o.crown, building: site, style };
    const k = JSON.stringify([it.look, it.w, it.h, it.variant, it.kind, it.crown, style ?? null]);
    let r = cache.get(k);
    if (!r) { const b = iso.isoBuilding(it, T, false, 1); r = { sprite: spriteFp(b), sil: silhouetteFp(b), f: features(b) }; cache.set(k, r); }
    return r;
  };

  const cities = [];
  let left = maxBuildings;
  for (const [name, list] of [...byCity.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (left <= 0) break;
    const bs = list.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, left);
    left -= bs.length;
    const rs = bs.map(rasterOf);
    let adj = 0, same = 0, sil = 0, alike = 0, iouSum = 0;
    const looks = {};
    for (let i = 0; i < bs.length; i++) {
      looks[bs[i].model] = (looks[bs[i].model] || 0) + 1;
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const near = (a.ty === b.ty && gap(a.tx, a.w, b.tx, b.w) <= 3) || (a.tx === b.tx && gap(a.ty, a.h, b.ty, b.h) <= 4);
        if (!near) continue;
        adj++;
        if (rs[i].sprite === rs[j].sprite) same++;
        if (rs[i].sil === rs[j].sil) sil++;
        const u = iou(rs[i].f, rs[j].f); iouSum += u;
        if (u >= LOOKALIKE.iou && cdist(rs[i].f.roof, rs[j].f.roof) < LOOKALIKE.colour && cdist(rs[i].f.wall, rs[j].f.wall) < LOOKALIKE.colour) {
          alike++;
          if (process.env.VARIETY_DEBUG) console.error('alike', name, a.model, a.id, a.variant, b.id, b.variant, u.toFixed(2), rs[i].f.roof.map(Math.round), rs[j].f.roof.map(Math.round), rs[i].f.wall.map(Math.round), rs[j].f.wall.map(Math.round));
        }
      }
    }
    cities.push({ name, tier: vill.get(name).tier, buildings: bs.length, adjPairs: adj, identicalPct: pct(same, adj), silhouettePct: pct(sil, adj),
      distinctSprites: new Set(rs.map(r => r.sprite)).size, distinctSilhouettes: new Set(rs.map(r => r.sil)).size, looks,
      lookalikePct: pct(alike, adj), meanIoU: adj ? +(iouSum / adj).toFixed(3) : 0,
      roofColours: new Set(rs.map(r => q(r.f.roof))).size, heights: new Set(rs.map(r => Math.round(r.f.height / 8))).size,
      _same: same, _sil: sil, _alike: alike, _iou: iouSum });
  }
  const adjT = cities.reduce((s, c) => s + c.adjPairs, 0);
  const overall = { buildings: cities.reduce((s, c) => s + c.buildings, 0), adjPairs: adjT,
    identicalPct: pct(cities.reduce((s, c) => s + c._same, 0), adjT), silhouettePct: pct(cities.reduce((s, c) => s + c._sil, 0), adjT),
    distinctSpritesPerCity: mean(cities.map(c => c.distinctSprites)), distinctSilhouettesPerCity: mean(cities.map(c => c.distinctSilhouettes)),
    lookalikePct: pct(cities.reduce((s, c) => s + c._alike, 0), adjT), meanIoU: adjT ? +(cities.reduce((s, c) => s + c._iou, 0) / adjT).toFixed(3) : 0,
    roofColoursPerCity: mean(cities.map(c => c.roofColours)), heightsPerCity: mean(cities.map(c => c.heights)) };
  for (const c of cities) { delete c._same; delete c._sil; delete c._alike; delete c._iou; }
  return { fixture, cities, overall };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
  const t0 = Date.now();
  const r = await measureVariety({ root: arg('root', HERE), fixture: arg('fixture', 'busy'), seed: +arg('seed', 7),
    tiers: String(arg('tiers', '2,3')).split(',').map(Number), maxBuildings: +arg('max', 400) });
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    const row = (...c) => console.log(String(c[0]).padEnd(18) + c.slice(1).map((v, i) => String(v).padStart(i ? 8 : 4)).join(''));
    console.log(`fixture ${r.fixture}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    row('city', 'tier', 'bldg', 'pairs', 'ident%', 'silh%', 'sprites', 'silhs', 'alike%', 'mIoU', 'roofs', 'heights');
    for (const c of r.cities) row(c.name, c.tier, c.buildings, c.adjPairs, c.identicalPct, c.silhouettePct, c.distinctSprites, c.distinctSilhouettes, c.lookalikePct, c.meanIoU, c.roofColours, c.heights);
    const o = r.overall;
    row('OVERALL', '', o.buildings, o.adjPairs, o.identicalPct, o.silhouettePct, o.distinctSpritesPerCity, o.distinctSilhouettesPerCity, o.lookalikePct, o.meanIoU, o.roofColoursPerCity, o.heightsPerCity);
  }
}
