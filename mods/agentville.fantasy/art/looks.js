// agentville.fantasy folk looks (M6 P2): lookOf(view, style, ctx) -> Look for the paper doll (art/folk-parts.js).
// Pure and deterministic: a look is a function of the actor's stable first-seen ordinal (view.seen) and its settlement
// style (style.folk palettes, style.accent as the project band), never of time or randomness.
//   workers and folk   build, skin, hair, garment, headwear, tools picked by ordinal inside style.folk
//   boss               cream robe, crown, cape in the settlement accent
//   sub                hooded ninja-style garb whose colour comes from the parent agent
//   anything else (critters, carts)  null: the engine draws the sheet fallback
import { HAIR_STYLES } from './folk-parts.js';

const HAIR_COLOURS = Object.freeze(['#3a2a20', '#6b4428', '#a8743c', '#d6b062', '#8a3f2a', '#d8d4cc', '#1f1a24']);
const NINJA = Object.freeze(['#3b5fa8', '#a8352f', '#c79a2e', '#3f7d4a', '#2c2a36', '#5f8a3a', '#6d7480', '#6a4a8a']);
const DEFAULT_FOLK = Object.freeze({
  clothes: Object.freeze(['#b75a42', '#4f7d4a', '#3f6f8f', '#d9a08e']),
  palettes: Object.freeze([['#b75a42', '#5a4636', '#e9cc84'], ['#4f7d4a', '#6a5a46', '#f3e7cd'], ['#3f6f8f', '#4a4038', '#e9cc84'], ['#d9a08e', '#6b4a3a', '#fbf6ea']]),
  skin: Object.freeze(['#f6d7bd', '#e0a97d', '#a9724b']),
  headwear: Object.freeze(['none', 'cap', 'hood']),
  apron: 1,
});
const DEFAULT_ACCENT = '#c7623e';
const HEADWEAR_OK = new Set(['hood', 'cap', 'straw', 'kerchief', 'feather']);
const GARMENT_BAG = Object.freeze(['tunic', 'tunic', 'dress', 'robe', 'tunic+apron', 'coat', 'dress+apron', 'tunic']);

const HEX = /^#[0-9a-f]{6}$/i;
const isHex = c => typeof c === 'string' && HEX.test(c);
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const toHex = v => `#${v.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
/** Darker (k < 1) or lighter (k > 1) copy of a hex colour. */
export const shade = (c, k) => toHex(rgb(c).map(x => (k <= 1 ? x * k : x + (255 - x) * (k - 1))));
const hexOr = (c, d) => (isHex(c) ? c : d);

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** Integer mix of an ordinal and a salt: independent streams per feature, stable forever. */
function mix(n, salt) {
  let x = (Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12; x = Math.imul(x, 0x297a2d39) >>> 0; x ^= x >>> 15;
  return x >>> 0;
}
const pick = (list, n) => list[n % list.length];

function folkOf(style) {
  const f = style && typeof style === 'object' ? style.folk : null;
  const palettes = Array.isArray(f?.palettes) ? f.palettes.filter(p => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(isHex)) : [];
  const clothes = Array.isArray(f?.clothes) ? f.clothes.filter(isHex) : [];
  const skin = Array.isArray(f?.skin) ? f.skin.filter(isHex) : [];
  const headwear = Array.isArray(f?.headwear) ? f.headwear.filter(h => typeof h === 'string') : [];
  return {
    palettes: palettes.length ? palettes : DEFAULT_FOLK.palettes,
    clothes: clothes.length ? clothes : (palettes.length ? palettes.map(p => p[0]) : DEFAULT_FOLK.clothes),
    skin: skin.length ? skin : DEFAULT_FOLK.skin,
    headwear: headwear.length ? headwear : DEFAULT_FOLK.headwear,
    apron: Number.isInteger(f?.apron) ? Math.abs(f.apron) : DEFAULT_FOLK.apron,
  };
}

/** The palette slots art/folk-parts.js reads. */
function palette(o) {
  const { skin, hair, cloth, trim, pants, hat, apron, cape } = o;
  return {
    skin, skinShade: shade(skin, 0.82), hair, hairShade: shade(hair, 0.72),
    cloth, clothShade: shade(cloth, 0.78), trim, pants, boots: shade(pants, 0.55),
    apron: apron ?? '#f3e7cd', apronShade: shade(apron ?? '#f3e7cd', 0.8),
    hat: hat ?? cloth, hatShade: shade(hat ?? cloth, 0.72), hatTrim: trim, plume: '#d6453d',
    cape: cape ?? cloth, capeShade: shade(cape ?? cloth, 0.7), crown: '#e8c04a',
    wood: '#b9854a', woodShade: '#7d5530', metal: '#aeb4bd', lamp: '#ffd86b', eye: '#1c1622',
  };
}

// parity: vil.boss-look-and-crown
function bossLook(n, style) {
  const accent = hexOr(style?.accent, DEFAULT_ACCENT), fo = folkOf(style);
  const skin = pick(fo.skin, mix(n, 1)), hair = pick(HAIR_COLOURS, mix(n, 2));
  return {
    parts: ['legs.1', 'robe.1', 'arms.1', 'head', 'face', `hair.${mix(n, 3) % HAIR_STYLES}`],
    extras: ['crown', 'cape.1'],
    palette: palette({ skin, hair, cloth: '#f0e4c8', trim: '#d1a447', pants: '#5a4636', cape: accent }),
  };
}

// parity: vil.subs-ninja-looks
function subLook(view, n, style) {
  const base = NINJA[fnv(String(view.parent ?? view.id)) % NINJA.length];
  const fo = folkOf(style), b = mix(n, 4) & 1;
  const pal = palette({ skin: pick(fo.skin, mix(n, 1)), hair: '#2c2a36', cloth: shade(base, 0.9), trim: shade(base, 1.45), pants: shade(base, 0.5), hat: base });
  pal.boots = shade(base, 0.35);
  return { parts: [`legs.${b}`, `tunic.${b}`, `arms.${b}`, 'head'], extras: ['ninja', 'item.hammer'], palette: pal };
}

function folkLook(n, style) {
  const fo = folkOf(style), b = mix(n, 4) & 1;
  const cloth = pick(fo.clothes, n), set = pick(fo.palettes, Math.floor(n / fo.clothes.length));
  const trim = hexOr(style?.accent, set[2]);
  const garment = pick(GARMENT_BAG, mix(n, 5)).split('+');
  const parts = [`legs.${b}`, `${garment[0]}.${b}`, `arms.${b}`, 'head', 'face', `hair.${mix(n, 6) % HAIR_STYLES}`];
  if (garment[1]) parts.push(`apron.${b}`);
  const usable = fo.headwear.filter(h => HEADWEAR_OK.has(h));
  const hw = usable.length && mix(n, 7) % 3 !== 0 ? pick(usable, mix(n, 8)) : null;
  const extras = [];
  if (hw) extras.push(hw);
  extras.push('item.hammer', mix(n, 9) & 1 ? 'item.basket' : 'item.crate');
  if (mix(n, 10) % 4 === 0) extras.push('item.lantern');
  const hat = hw === 'straw' ? '#d9b865' : hw === 'kerchief' ? pick(fo.clothes, n + 1) : set[2] !== cloth ? set[2] : shade(cloth, 0.7);
  const apronIdx = fo.apron % fo.clothes.length;
  return {
    parts, extras,
    palette: palette({
      skin: pick(fo.skin, mix(n, 1)), hair: pick(HAIR_COLOURS, mix(n, 2)), cloth, trim, pants: set[1], hat,
      apron: garment[1] ? (fo.clothes[apronIdx] !== cloth ? fo.clothes[apronIdx] : '#f3e7cd') : null,
    }),
  };
}

// parity: vil.looks-stable-by-first-seen
/** ActorsDecl.lookOf. view: ActorView; style: the settlement StyleTuple or null; ctx: { hash, api }. Null = not a person. */
export function lookOf(view, style, ctx) {
  if (!view || typeof view !== 'object') return null;
  if (view.kind !== 'agent' && view.kind !== 'folk') return null;
  const id = String(view.id ?? '');
  let n = Number.isFinite(view.seen) ? Math.abs(Math.floor(view.seen)) : (typeof ctx?.hash === 'function' ? Math.abs(Number(ctx.hash(id)) | 0) : fnv(id));
  if (!Number.isSafeInteger(n)) n = fnv(id);
  const st = style && typeof style === 'object' ? style : null;
  try {
    if (view.kind === 'agent' && (view.role === 'boss' || view.crown)) return bossLook(n, st);
    if (view.kind === 'agent' && view.role === 'sub') return subLook({ ...view, id }, n, st);
    return folkLook(n, st);
  } catch { return folkLook(n, null); }
}
