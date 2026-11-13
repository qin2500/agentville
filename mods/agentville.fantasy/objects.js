// agentville.fantasy object types: prop footprints/walk/anchors (was engine footprints.js FOOTPRINTS) and building heights
// (was plan-adapter BUILDING_Z) (village-mods.md §6.1.5). Pure data. Shape: ObjectTypeTable (api.js).
//
// The table holds NO functions (M1b): it must survive structuredClone / JSON so it can cross into a mod sandbox.
// props[kind] is an ObjectType. A city-plan prop is { kind, x, y, v, dir?, len? }. Direction-dependent kinds are
// declarative: byDir: { x: ObjectType, y: ObjectType } picks the variant by prop.dir ('y', else 'x'). walk 'edge' kinds
// (fences) carry only { walk, z }: the ENGINE derives w, h and run { dir, len, side } from prop.dir/len/x/y.
// Fields: w, h footprint in tiles; z height px; walk 'block'|'edge'|'floor'; dir (copied to object data.dir, bridges);
// anchors (offsets from the footprint's top-left: { stand?, work?, sit?, vend? } of { dx, dy, sub, face }, face 0 N, 1 E,
// 2 S, 3 W, on tiles OUTSIDE the footprint); snap 'street-edge' (the legaliser moves it to a street's edge tile);
// decal true (drawn into the ground, no footprint); kind 'tree' (the object is stored as a tree, not a prop).
// scatter: wild-land rules for the engine's scatterWild (additive to ObjectTypeTable).

const FACE = { N: 0, E: 1, S: 2, W: 3 };
const b1 = (z, extra) => ({ w: 1, h: 1, walk: 'block', z, ...extra });
const decal = () => ({ w: 1, h: 1, walk: 'floor', z: 0, decal: true });
/** A fence/hedge/railing run: the engine derives its length, direction and side from the plan prop. */
const edge = z => ({ walk: 'edge', z });

const props = {
  // trunks and shrubs: the canopy overhangs on screen, the trunk tile blocks
  tree: b1(40, { kind: 'tree' }), pine: b1(48, { kind: 'tree' }), sapling: b1(28, { kind: 'tree' }), bush: b1(10), rock: b1(8),
  // single-tile furniture
  statue: b1(34), well: b1(22), maypole: b1(60), trough: b1(8), noticeboard: b1(24), signpost: b1(26),
  cart: b1(18), woodpile: b1(12), beehive: b1(14), barrel: b1(12), crate: b1(12), haystack: b1(22),
  laundry: b1(24), scarecrow: b1(26),
  // lights and banners: the legaliser moves them to a street's edge tile
  lamp: b1(34, { snap: 'street-edge' }), lamppost: b1(40, { snap: 'street-edge' }), banner: b1(42, { snap: 'street-edge' }),
  fountain: { w: 2, h: 2, walk: 'block', z: 24, anchors: { sit: [
    { dx: 0, dy: -1, sub: 0, face: FACE.S }, { dx: 2, dy: 0, sub: 0, face: FACE.W },
    { dx: 1, dy: 2, sub: 0, face: FACE.N }, { dx: -1, dy: 1, sub: 0, face: FACE.E } ] } },
  stall: { byDir: {
    x: { w: 2, h: 1, walk: 'block', z: 28, anchors: { vend: [{ dx: 0, dy: -1, sub: 0, face: FACE.S }] } },
    y: { w: 1, h: 2, walk: 'block', z: 28, anchors: { vend: [{ dx: -1, dy: 0, sub: 0, face: FACE.E }] } } } },
  bench: { byDir: {
    x: { w: 1, h: 1, walk: 'block', z: 8, anchors: { sit: [{ dx: 0, dy: 1, sub: 0, face: FACE.N }] } },
    y: { w: 1, h: 2, walk: 'block', z: 8, anchors: { sit: [{ dx: 1, dy: 0, sub: 0, face: FACE.W }, { dx: 1, dy: 1, sub: 0, face: FACE.W }] } } } },
  fence: edge(10), hedge: edge(14), railing: edge(12),
  bridge: { byDir: { x: { w: 1, h: 1, walk: 'floor', z: 0, dir: 'x' }, y: { w: 1, h: 1, walk: 'floor', z: 0, dir: 'y' } } },
  // decals: drawn into the ground, no footprint
  flowers: decal(), flowerbox: decal(), hay: decal(), crops: decal(), clover: decal(), sunflower: decal(),
};

/** Approximate building height in px at 1x by look (feeds only the cover estimate). */
const z = n => ({ z: n });
const buildings = {
  cottage: z(28), farmhouse: z(30), timber: z(34), townhouse: z(44), manor: z(58), hall: z(56), barn: z(38), windmill: z(66),
  granary: z(34), chapel: z(62), smithy: z(34), inn: z(46), guildhall: z(62), clocktower: z(84), markethall: z(40), cathedral: z(96),
  palace: z(58),   // a crown estate: a manor a tier above (the old table had no entry and fell back to 40)
};

/** Wild-land scatter rules (scatterWild): [model, variant] lists, the dense-forest distance. trees: the LAST entry is the
 * rare "big" one; bushes: also decals/rocks. */
const scatter = {
  trees: [['pine', 0], ['tree', 0], ['pine', 0], ['tree', 1], ['tree', 2], ['tree', 3]],
  bushes: [['bush', 0], ['bush', 1], ['clover', 0], ['sunflower', 0], ['rock', 0]],
  forestDist: 5,
};

export const OBJECT_TYPES = { props, buildings, scatter };
