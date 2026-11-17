// Real classic building art (web/src/iso.js) in node, for the raster-identity tests: a stand-in DOM canvas that keeps
// the RGBA buffer make() puts and logs every other 2D call, so a raster can be fingerprinted pixel for pixel.
// Never touches the network or any real session; the world is the checked-in engine fixture.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import './ensure-mods-index.mjs';

export class RecCanvas {
  constructor(w, h) { this.width = w; this.height = h; this._buf = null; this.log = []; }
  /** Sized on first use: iso.js sets width/height after createElement. */
  get buf() { return (this._buf ||= new Uint8ClampedArray(this.width * this.height * 4)); }
  getContext() {
    const c = this, log = (...a) => c.log.push(a.map(v => (typeof v === 'number' ? +v.toFixed(4) : v)).join(','));
    const ctx = {
      fillStyle: '#000',
      putImageData(id, x, y) { log('put', x, y, id.width, id.height); for (let j = 0; j < id.height; j++) c.buf.set(id.data.subarray(j * id.width * 4, (j + 1) * id.width * 4), ((j + y) * c.width + x) * 4); },
      fillRect(x, y, w, h) { log('fill', ctx.fillStyle, x, y, w, h); },
      clearRect(x, y, w, h) { log('clear', x, y, w, h); },
      drawImage(src, x, y) {
        log('draw', x, y, src.width, src.height);
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

/** Install the stand-in document + ImageData (idempotent) and import the real iso.js. */
export async function loadIso() {
  globalThis.ImageData ??= class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  globalThis.document ??= { createElement: () => new RecCanvas(1, 1), addEventListener() {}, documentElement: { style: {}, classList: { add() {}, remove() {}, toggle() {} } } };
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  return import('../../web/src/iso.js');
}

/** Fingerprint of one isoBuilding() result: pixels, the 2D call log, the offsets, anchors and box. */
export function fingerprint(b) {
  const h = createHash('sha256');
  h.update(Buffer.from(b.img.buf.buffer, b.img.buf.byteOffset, b.img.buf.byteLength));
  h.update(JSON.stringify([b.img.width, b.img.height, b.img.log, b.dx, b.dy, b.windows, b.door, b.ridge, b.chimney, b.box, b.hub ?? null, b.glow ?? null]));
  return h.digest('hex').slice(0, 16);
}

/**
 * Every distinct building the engine would raster for a fixture world, as classic iso.js items (what raster.js
 * rasterBuilding hands isoBuilding), at most `limit` of them, in a stable order.
 */
export async function fixtureBuildings(fixture = 'six-styles', limit = 80) {
  const { buildWorld } = await import('../../web/src/engine/world/build.js');
  const { viewFromFixture } = await import('../../web/src/engine/snapshot.js');
  const { toWorldInput } = await import('../../web/src/engine/mod/input.js');
  const { default: fantasy } = await import('../../mods/agentville.fantasy/index.js');
  const fx = JSON.parse(fs.readFileSync(new URL(`../../e2e/fixtures/engine/${fixture}.json`, import.meta.url), 'utf8'));
  const { input, serverId } = toWorldInput(viewFromFixture(fx, { now: fx.now }), { seed: 7, salt: 0, features: fantasy.features });
  const world = buildWorld(input, {}, { mod: fantasy, now: fx.now, seed: 7, serverId });
  const styleOf = new Map(world.villages.map(v => [v.name, v.style && typeof v.style === 'object' ? v.style : null]));
  const seen = new Map();
  for (const o of world.objects.values()) {
    if (o.kind !== 'building') continue;
    const m = fantasy.styles?.[o.styleKey];
    const style = m && typeof m === 'object' ? m : styleOf.get(o.project) ?? undefined;
    const site = o.data?.owner === 'pr' ? !!o.data.building : !!o.data?.site;
    const it = { id: `r3:${o.model}:${o.variant | 0}`, kind: site ? 'pr' : 'building', look: o.model, w: o.w, h: o.h, x: 0, y: 0, variant: o.variant | 0,
      village: { accent: style?.accent ?? '#c46a42' }, doorX: Math.round(o.w * 16 / 2), crown: !!o.crown, building: site, style };
    const k = JSON.stringify([it.look, it.w, it.h, it.variant, it.kind, it.crown, style ?? null]);
    if (!seen.has(k)) seen.set(k, it);
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(e => e[1]);
}

// [look, w, h] as the dev art sheet draws them (web/src/dev/art-sheet.js): the classic looks with no settlement style.
const SHEET = [
  ['farmhouse', 3, 3], ['cottage', 3, 3], ['timber', 4, 3], ['townhouse', 2, 3], ['manor', 4, 4], ['hall', 4, 5],
  ['barn', 4, 3], ['windmill', 3, 3], ['granary', 2, 2], ['chapel', 3, 5], ['smithy', 3, 3], ['inn', 4, 3], ['guildhall', 5, 4], ['clocktower', 2, 2],
  ['markethall', 5, 3], ['cathedral', 6, 8], ['wall', 4, 1], ['walltower', 2, 2], ['gatehouse', 3, 2],
  ['houseA', 4, 3], ['houseH', 3, 3], ['towerWood', 2, 2], ['towerDome', 2, 2],
];
const ACC = ['#c46a42', '#4a7fb5', '#7a9a3a', '#a04a8a'];

/**
 * The golden case list: every sheet look (two variants, one a PR house, plus building sites), and up to `perLook`
 * fixture buildings per look from the busy and six-styles worlds (their settlement styles), each at the classic (S 1)
 * or engine (S 1.25) projection and day or night by turn. Stable order; each case is { name, it, lit, S }.
 */
export async function goldenCases(perLook = 2) {
  const cases = [];
  const push = (name, it) => { const n = cases.length; cases.push({ name: `${n}:${name}`, it, lit: n % 3 === 1, S: n % 2 ? 1.25 : 1 }); };
  for (const [look, w, h] of SHEET) for (const v of [0, 5]) {
    push(`sheet:${look}:${w}x${h}:v${v}`, { id: `sheet:${look}:${v}`, kind: v === 5 ? 'pr' : 'house', building: false, look, w, h, x: 0, y: 0, doorX: w * 8, variant: v, village: { accent: ACC[v % 4] } });
  }
  for (const [look, w, h] of [['cottage', 3, 3], ['timber', 4, 3], ['townhouse', 2, 3], ['manor', 4, 4]]) {
    push(`site:${look}`, { id: `site:${look}`, kind: 'pr', building: true, look, w, h, x: 0, y: 0, doorX: w * 8, variant: 1, village: { accent: ACC[1] } });
  }
  for (const fx of ['busy', 'six-styles']) {
    const per = new Map();
    for (const it of await fixtureBuildings(fx, 2000)) {
      const n = per.get(it.look) ?? 0;
      if (n >= perLook) continue;
      per.set(it.look, n + 1);
      push(`${fx}:${it.look}:${it.w}x${it.h}:v${it.variant}:${it.kind}`, it);
    }
  }
  return cases;
}
