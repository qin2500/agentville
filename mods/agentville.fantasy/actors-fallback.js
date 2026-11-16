// agentville.fantasy actors, fallback data (M6 P1): the Ninja Adventure sheet names the engine's sticker fallback
// draws when this world has no doll parts yet, when the viewer picks it (?folk=ninja, va.engine2.folk = 'ninja'), or
// when the mod's actors.lookOf throws. Plain data: the engine loads `actors/<name>.png` for people and
// `animals/<name>.png` for critters from its art base. Rules (engine render/actor-art.js, classic world.js:659):
//   boss or crowned agent -> boss; sub -> subs[hash(parent) % n]; other agents -> looks[seen % n];
//   ambient folk -> looks[look.seed % n]; critters -> critters[species] (else critters[defaultCritter]).
export const ACTORS_FALLBACK = Object.freeze({
  looks: Object.freeze(['Villager2', 'Woman', 'OldMan', 'Villager4', 'Hunter', 'Princess', 'Villager3', 'Boy', 'Monk2', 'Villager5', 'OldMan3']),
  subs: Object.freeze(['NinjaBlue', 'NinjaRed', 'NinjaYellow', 'NinjaGreen', 'NinjaMasked', 'NinjaDark', 'NinjaLeaf', 'NinjaGray']),
  boss: 'Sultan2',
  critters: Object.freeze({ cat: 'Cat', chicken: 'Chicken' }),
  defaultCritter: 'chicken',
});

/** mod.actors for this world. P1: fallback only (no parts, no lookOf), so the village still draws the sheet stickers.
 *  P2 adds `anims`, `parts` and `lookOf` here (docs/village-mods.md "actors"). */
export const ACTORS = Object.freeze({ fallback: ACTORS_FALLBACK });
