// agentville.fantasy per-project style (design §5.4, M6 P3): city4's styleFor() plus the street, people and banner axes.
// Imports styles-pool (never forks it). Every axis draws from its own salted stream, so axes vary independently and a new
// axis never moves an old one. Pure and deterministic in (key, family, tier).
import { styleFor, FAMILIES } from '../../web/src/styles-pool.js';
import {
  AXIS_SALT, FAMILY_RULES, TIER_PAVING, TIER_LAMP, SKIN_POOL, PAINTER_KIND, PAVINGS, PATTERNS, LAMPS, TREES, HEADWEAR,
  BANNER_SHAPES, BANNER_MOTIFS, RESERVED_HUES, RESERVED_HUE_DIST, ROOF_SAT_MAX,
} from './style-rules.js';

export { AXIS_SALT };

const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
/** mulberry32 stream for one axis of one project. */
export function axisRng(key, axis) {
  let a = (fnv(String(key)) ^ AXIS_SALT[axis]) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function weighted(rng, list) {
  const tot = list.reduce((s, [, w]) => s + w, 0); let r = rng() * tot;
  for (const [v, w] of list) { r -= w; if (r < 0) return v; }
  return list[list.length - 1][0];
}
const pickOf = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };

// ---- value rule: a roof near a reserved badge hue stays at or below ROOF_SAT_MAX saturation (HSV), city4's pool is not edited ----
const HEX = /^#[0-9a-f]{6}$/i;
const rgbOf = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
function hueSat(h) {
  const [r, g, b] = rgbOf(h), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const s = mx === 0 ? 0 : d / mx;
  let hue = 0;
  if (d) hue = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: hue * 60, s };
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
/** Pull a colour toward grey of the same value until its saturation is ROOF_SAT_MAX, only when it is near a reserved hue. */
export function muteNearReserved(hexc) {
  if (!HEX.test(hexc)) return hexc;
  const { h, s } = hueSat(hexc);
  if (s <= ROOF_SAT_MAX || !RESERVED_HUES.some(r => hueDist(h, hueSat(r).h) < RESERVED_HUE_DIST)) return hexc;
  const c = rgbOf(hexc).map(v => v * 255), mx = Math.max(...c), k = (ROOF_SAT_MAX - 0.005) / s;
  return '#' + c.map(v => Math.round(mx - (mx - v) * k).toString(16).padStart(2, '0')).join('');
}
const muteRoof = r => ({ base: muteNearReserved(r.base), ridge: muteNearReserved(r.ridge) });
const tierOf = (ctx, preset) => { const t = preset?.tier ?? ctx?.tier ?? ctx?.forcedTier; return Number.isFinite(t) ? Math.max(0, Math.min(3, Math.round(t))) : null; };

/**
 * StyleTuple = the city4 style object (key, family, familyName, roof{base,ridge}, wall, trim, shutter, door, window, paving{kind,base,joint},
 * lamp, trees, folk{palettes,hat}, accent) plus:
 *   tier: 0..3|null
 *   street: { paving: PAVINGS, pattern: PATTERNS, kerb: boolean, lamp: LAMPS, tree: TREES, hedge: boolean }
 *   folk:   { ...city4 folk, clothes: hex[4], skin: hex[3], apron: 0..3 (index into clothes), headwear: HEADWEAR[] (2..3, includes city4 hat) }
 *   banner: { shape: BANNER_SHAPES, motif: BANNER_MOTIFS }
 * `paving` (classic) is kept coherent with street.paving, so ground-art.js keeps painting it.
 */
export function projectStyle(key, ctx, preset) {
  const forced = ctx?.forcedStyle;
  const f = forced == null || !Number.isFinite(forced) ? preset?.family : ((Math.round(forced) % 6) + 6) % 6;
  const base = styleFor(key, f != null ? { family: f } : {});
  const R = FAMILY_RULES[base.family], tier = tierOf(ctx, preset);

  let paving = weighted(axisRng(key, 'paving'), R.paving);
  if (tier != null && TIER_PAVING[tier]) paving = pickOf(axisRng(key, 'paving'), TIER_PAVING[tier]);
  const pattern = pickOf(axisRng(key, 'pattern'), R.pattern);
  const kerb = tier != null && tier <= 1 ? false : axisRng(key, 'kerb')() < R.kerb;
  const hedge = axisRng(key, 'hedge')() < R.hedge;
  const lamp = tier != null && TIER_LAMP[tier] ? TIER_LAMP[tier] : pickOf(axisRng(key, 'lamp'), R.lamp);
  const tree = pickOf(axisRng(key, 'tree'), R.tree);

  const sr = axisRng(key, 'skin'), pool = [...SKIN_POOL], skin = [];
  for (let i = 0; i < 3; i++) skin.push(pool.splice(Math.floor(sr() * pool.length), 1)[0]);
  const apron = Math.floor(axisRng(key, 'apron')() * 4);
  const hr = axisRng(key, 'headwear'), hw = [base.folk.hat], rest = R.headwear.filter(h => h !== base.folk.hat);
  const extra = 1 + Math.floor(hr() * 2);
  for (let i = 0; i < extra && rest.length; i++) hw.push(rest.splice(Math.floor(hr() * rest.length), 1)[0]);

  const out = {
    ...base, tier,
    roof: muteRoof(base.roof),
    paving: { ...base.paving, kind: PAINTER_KIND[paving] },
    street: { paving, pattern, kerb, lamp, tree, hedge },
    folk: { ...base.folk, clothes: base.folk.palettes.map(p => p[0]), skin, apron, headwear: hw },
    banner: { shape: weighted(axisRng(key, 'bannerShape'), R.banner.shape), motif: weighted(axisRng(key, 'bannerMotif'), R.banner.motif) },
  };
  out.houses = housePalette(key, base.family, out.roof, base.wall);
  return deepFreeze(out);
}

// ---- district palette (city-variety): the houses of one project share its family, not one colour ----
/** A storybook accent roof a few houses of each family wear (verdigris copper, blue slate, plum shingle), muted below the
 *  badge-hue cap like every roof. */
export const ACCENT_ROOFS = Object.freeze([
  Object.freeze({ base: '#4f8f74', ridge: '#386a55' }), Object.freeze({ base: '#4a6a96', ridge: '#344c6e' }), Object.freeze({ base: '#86496a', ridge: '#62344e' }),
]);
const wallMemo = new Map();
/** The wall pairs a family offers (derived from styles-pool, like roofChoices). */
export function wallChoices(family) {
  let r = wallMemo.get(family);
  if (!r) {
    const seen = new Map();
    for (let i = 0; i < 96; i++) { const s = styleFor(`probe${i}`, { family }); seen.set(s.wall.base + s.wall.alt, s.wall); }
    r = [...seen.values()]; wallMemo.set(family, r);
  }
  return r;
}
/** style.houses: the roofs and walls a project's HOUSES pick from by variant (iso.js), own colours first. Civic buildings and
 *  the palace keep style.roof / style.wall. Pure in (key, family, roof). */
export function housePalette(key, family, roof, wall) {
  const own = roofChoices(family), first = own.find(r => r.base === roof.base) || roof;
  // two of the three storybook accents (a third of the houses), the rest the family's own roofs
  const skip = Math.floor(axisRng(key, 'accentRoof')() * ACCENT_ROOFS.length), accents = ACCENT_ROOFS.filter((_, i) => i !== skip).map(muteRoof);
  const rest = own.filter(r => r.base !== first.base);
  const roofs = [first, accents[0], ...rest.slice(0, 2), accents[1], ...rest.slice(2)];
  const ws = wallChoices(family), w0 = ws.find(w => w.base === wall.base && w.alt === wall.alt) || wall;
  return { roofs: roofs.map(r => ({ base: r.base, ridge: r.ridge })), walls: [w0, ...ws.filter(w => w !== w0)].map(w => ({ base: w.base, alt: w.alt })) };
}

// ---- neighbour rule ----
const roofMemo = new Map();
/** The roof colours a family offers (derived from styles-pool itself, not copied). */
export function roofChoices(family) {
  let r = roofMemo.get(family);
  if (!r) {
    const seen = new Map();
    for (let i = 0; i < 96; i++) { const s = styleFor(`probe${i}`, { family }); seen.set(s.roof.base, s.roof); }
    r = [...seen.values()].map(muteRoof); roofMemo.set(family, r);
  }
  return r;
}

/**
 * Adjacent blocks differ in roof colour and paving pattern. styles: Map|object project -> projectStyle; blocks: [{project,x,y,w,h}] tiles.
 * Greedy in project-key order (distinctPicks is injected by the host from engine render/accent.js: a mod may not import engine files), each block's own pick first, so an isolated block never changes and the
 * result depends only on the set of blocks. Never re-rolls the project style: only roof{base,ridge} and street.pattern are replaced.
 * @returns {Map<string, object>} project -> style (frozen; the same object when nothing changed)
 */
export function applyNeighbourRule(styles, blocks, distinctPicks, near = 6) {
  const get = k => (styles instanceof Map ? styles.get(k) : styles[k]);
  const has = k => !!get(k);
  const bs = blocks.filter(b => b && has(String(b.project ?? b.name)));
  const roofs = distinctPicks(bs, k => {
    const s = get(k), all = roofChoices(s.family), own = all.find(r => r.base === s.roof.base) || s.roof;
    return [own, ...all.filter(r => r.base !== own.base)].map(r => r.base);
  }, near);
  const pats = distinctPicks(bs, k => { const p = get(k).street.pattern; return [p, ...PATTERNS.filter(x => x !== p)]; }, near);
  const out = new Map();
  for (const b of bs) {
    const k = String(b.project ?? b.name), s = get(k), rb = roofs.get(k), pt = pats.get(k);
    if (rb === s.roof.base && pt === s.street.pattern) { out.set(k, s); continue; }
    const ridge = roofChoices(s.family).find(r => r.base === rb)?.ridge ?? s.roof.ridge;
    const roof = { base: rb, ridge };
    out.set(k, deepFreeze({ ...s, roof, street: { ...s.street, pattern: pt }, houses: housePalette(k, s.family, roof, s.wall) }));
  }
  return out;
}

// ---- validation ----
/** [] when the style is a valid StyleTuple; else human-readable problems. Tested over seeds 0..9999 (invariant 7). */
export function validateStyle(style) {
  const e = [];
  if (!style || typeof style !== 'object') return ['style is not an object'];
  const hex = (v, n) => { if (typeof v !== 'string' || !HEX.test(v)) e.push(`${n} is not #rrggbb: ${v}`); };
  const oneOf = (v, set, n) => { if (!set.includes(v)) e.push(`${n} not in [${set.join(',')}]: ${v}`); };
  if (typeof style.key !== 'string' || !style.key) e.push('key missing');
  if (!Number.isInteger(style.family) || style.family < 0 || style.family >= FAMILIES.length) e.push(`family out of range: ${style.family}`);
  hex(style.roof?.base, 'roof.base'); hex(style.roof?.ridge, 'roof.ridge'); hex(style.wall?.base, 'wall.base'); hex(style.trim, 'trim'); hex(style.accent, 'accent');
  const st = style.street, fo = style.folk, bn = style.banner;
  if (!st) e.push('street missing');
  else {
    oneOf(st.paving, PAVINGS, 'street.paving'); oneOf(st.pattern, PATTERNS, 'street.pattern'); oneOf(st.lamp, LAMPS, 'street.lamp'); oneOf(st.tree, TREES, 'street.tree');
    if (typeof st.kerb !== 'boolean') e.push('street.kerb not boolean');
    if (typeof st.hedge !== 'boolean') e.push('street.hedge not boolean');
    if (style.paving && style.paving.kind !== PAINTER_KIND[st.paving]) e.push(`paving.kind ${style.paving.kind} disagrees with street.paving ${st.paving}`);
    const t = style.tier;
    if (t === 0 && !['earth', 'gravel'].includes(st.paving)) e.push(`hamlet paving must be earth or gravel: ${st.paving}`);
    if (t === 0 && st.lamp !== 'woodpost') e.push(`hamlet lamp must be woodpost: ${st.lamp}`);
    if (t === 1 && !['gravel', 'cobble'].includes(st.paving)) e.push(`village paving must be gravel or cobble: ${st.paving}`);
    if (Number.isInteger(style.family) && t != null && t >= 2 && style.family >= 0 && style.family < FAMILIES.length) {
      if (!FAMILY_RULES[style.family].paving.some(([v]) => v === st.paving)) e.push(`paving ${st.paving} not allowed for family ${style.family}`);
    }
  }
  if (!fo) e.push('folk missing');
  else {
    if (!Array.isArray(fo.clothes) || fo.clothes.length !== 4) e.push('folk.clothes must be 4 colours'); else fo.clothes.forEach((c, i) => hex(c, `folk.clothes[${i}]`));
    if (!Array.isArray(fo.skin) || fo.skin.length < 1) e.push('folk.skin empty'); else { fo.skin.forEach((c, i) => hex(c, `folk.skin[${i}]`)); if (new Set(fo.skin).size !== fo.skin.length) e.push('folk.skin repeats'); }
    if (!Number.isInteger(fo.apron) || fo.apron < 0 || fo.apron > 3) e.push(`folk.apron out of range: ${fo.apron}`);
    if (!Array.isArray(fo.headwear) || !fo.headwear.length) e.push('folk.headwear empty'); else fo.headwear.forEach(h => oneOf(h, HEADWEAR, 'folk.headwear'));
  }
  if (!bn) e.push('banner missing'); else { oneOf(bn.shape, BANNER_SHAPES, 'banner.shape'); oneOf(bn.motif, BANNER_MOTIFS, 'banner.motif'); }
  // reserved hues: a roof near a badge fill stays below the saturation cap
  if (typeof style.roof?.base === 'string' && HEX.test(style.roof.base)) {
    const { h, s } = hueSat(style.roof.base);
    for (const r of RESERVED_HUES) if (hueDist(h, hueSat(r).h) < RESERVED_HUE_DIST && s > ROOF_SAT_MAX) e.push(`roof ${style.roof.base} too saturated near reserved hue ${r}`);
  }
  return e;
}
