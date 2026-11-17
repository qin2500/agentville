// agentville.fantasy style coherence table (design §5.4): per family, which street/people/banner values are allowed, plus
// the per-axis salts. Data only. Families are styles-pool's, in FAMILIES order:
// 0 timber, 1 mediterranean, 2 stone, 3 alpine, 4 canal, 5 thatch.

/** One salt per axis: an axis draws from rng(hash(key) ^ salt), so adding or re-rolling one never moves another. */
export const AXIS_SALT = Object.freeze({
  paving: 0x9e3779b1, pattern: 0x85ebca6b, kerb: 0xc2b2ae35, hedge: 0x27d4eb2f, lamp: 0x165667b1, tree: 0xd3a2646c,
  skin: 0xfd7046c5, apron: 0xb55a4f09, headwear: 0x1b873593, bannerShape: 0xcc9e2d51, bannerMotif: 0xe6546b64,
  accentRoof: 0x2545f491,
});

export const PAVINGS = Object.freeze(['earth', 'gravel', 'cobble', 'flagstone', 'brick', 'sett']);
export const PATTERNS = Object.freeze(['running', 'herringbone', 'fan', 'random']);
export const LAMPS = Object.freeze(['woodpost', 'ironlantern', 'brassglobe', 'stonepillar']);
export const TREES = Object.freeze(['oak', 'birch', 'apple', 'cypress', 'olive', 'pine', 'larch', 'willow']);
export const HEADWEAR = Object.freeze(['none', 'hood', 'cap', 'straw', 'kerchief', 'feather']);
export const BANNER_SHAPES = Object.freeze(['swallowtail', 'pennant', 'square']);
export const BANNER_MOTIFS = Object.freeze(['plain', 'chevron', 'stripe', 'cross']);

/** Weighted lists: [value, weight]. Picks are filtered by the family row. */
const W = (...p) => p;
export const FAMILY_RULES = Object.freeze([
  { // timber
    paving: [W('cobble', 3), W('sett', 2)], pattern: ['running', 'random', 'herringbone'], lamp: ['ironlantern'], tree: ['oak', 'birch', 'apple'],
    headwear: ['cap', 'hood', 'kerchief', 'none'], kerb: 0.8, hedge: 0.6,
    banner: { shape: [W('swallowtail', 3), W('pennant', 2), W('square', 1)], motif: [W('plain', 2), W('chevron', 2), W('stripe', 2), W('cross', 1)] },
  },
  { // mediterranean
    paving: [W('flagstone', 3), W('sett', 2)], pattern: ['fan', 'running', 'random'], lamp: ['brassglobe'], tree: ['cypress', 'olive'],
    headwear: ['straw', 'kerchief', 'none', 'feather'], kerb: 0.5, hedge: 0.3,
    banner: { shape: [W('pennant', 3), W('square', 2), W('swallowtail', 1)], motif: [W('stripe', 3), W('plain', 2), W('chevron', 1), W('cross', 1)] },
  },
  { // stone
    paving: [W('flagstone', 3), W('sett', 3)], pattern: ['running', 'random', 'herringbone'], lamp: ['stonepillar'], tree: ['pine', 'birch'],
    headwear: ['hood', 'cap', 'none'], kerb: 0.9, hedge: 0.4,
    banner: { shape: [W('swallowtail', 3), W('square', 2), W('pennant', 1)], motif: [W('cross', 3), W('chevron', 2), W('plain', 2), W('stripe', 1)] },
  },
  { // alpine
    paving: [W('gravel', 3), W('cobble', 2)], pattern: ['random', 'running', 'fan'], lamp: ['woodpost'], tree: ['pine', 'larch'],
    headwear: ['hood', 'cap', 'feather', 'none'], kerb: 0.3, hedge: 0.7,
    banner: { shape: [W('pennant', 3), W('swallowtail', 2), W('square', 1)], motif: [W('chevron', 3), W('plain', 2), W('stripe', 1), W('cross', 2)] },
  },
  { // canal
    paving: [W('brick', 1)], pattern: ['herringbone', 'running'], lamp: ['ironlantern'], tree: ['willow', 'birch'],
    headwear: ['cap', 'kerchief', 'none', 'hood'], kerb: 0.9, hedge: 0.2,
    banner: { shape: [W('square', 3), W('swallowtail', 2), W('pennant', 1)], motif: [W('stripe', 3), W('cross', 2), W('plain', 1), W('chevron', 1)] },
  },
  { // thatch
    paving: [W('earth', 3), W('gravel', 2)], pattern: ['random', 'running'], lamp: ['woodpost'], tree: ['apple', 'oak'],
    headwear: ['straw', 'kerchief', 'cap', 'none'], kerb: 0.1, hedge: 0.9,
    banner: { shape: [W('pennant', 3), W('square', 2), W('swallowtail', 1)], motif: [W('plain', 3), W('chevron', 1), W('stripe', 2), W('cross', 1)] },
  },
]);

/** Tier override (growth reads as materials): hamlet earth/gravel + woodposts, village gravel/cobble, town+ the family's own. */
export const TIER_PAVING = Object.freeze({ 0: ['earth', 'gravel'], 1: ['gravel', 'cobble'] });
export const TIER_LAMP = Object.freeze({ 0: 'woodpost' });

/** Skin tones people can wear: a project draws 3 distinct ones. */
export const SKIN_POOL = Object.freeze(['#f6d7bd', '#efc29f', '#e0a97d', '#c98f63', '#a9724b', '#8a5a3a', '#6b4430', '#fbe3cf']);

/** styles-pool paving.kind the classic painter (ground-art.js) understands, by street material. */
export const PAINTER_KIND = Object.freeze({ earth: 'earth', gravel: 'earth', cobble: 'cobble', sett: 'cobble', flagstone: 'flagstone', brick: 'brick' });

/** Reserved badge fills (engine badges.js): roofs near these hues stay below ROOF_SAT_MAX. */
export const RESERVED_HUES = Object.freeze(['#f5a623', '#e5383b', '#9b5de5', '#2f9e5b', '#3d7be0']);
export const RESERVED_HUE_DIST = 18;
export const ROOF_SAT_MAX = 0.55;
