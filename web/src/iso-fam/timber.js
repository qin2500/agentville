// Family 0: timber. The original look (half-timbering, jetties, mixed roofs). With it.style undefined or the
// pool's timber family, iso.js keeps today's shapes; the pool only recolours houses (see styleKit in iso.js).
//
// ======================================================================================================
// THE FAMILY HOOK CONTRACT (web/src/iso-fam/*.js). One file per architectural family; iso.js imports all six
// as FAMS[id] and reads them; nothing else does. Each file default-exports ONE plain object with exactly
// these fields (same shape in every file, so each family can be edited on its own). Family files import
// nothing: colours are '#hex' strings, and everything drawn comes in through the K argument.
//
//   id            0..5, the index in styles-pool.js FAMILIES (timber, mediterranean, stone, alpine, canal, thatch)
//   name          the family name (same as FAMILIES[id])
//   sys           materials for styled kit looks, or null (timber: keep the look, pool colours only):
//                 { walls: [hex], wood?: [hex], dress, rubble, civic: [hex], roofs: [hex], rk (roof pitch
//                   factor), de (extra eave depth), mat: { tile|slate|shingle|thatch -> the family's material },
//                   civRoof?, civMat? (big civic buildings' roof colour/materials), shutters: [hex], trim, beam,
//                   doors: [hex], chim (chimney colour) }
//   window        default kit window: '' (plain) | 'arched' | 'small' (deep-set) | 'square' | 'tall' (sash)
//   halfTimber    styled walls keep their half-timber frame (else frames are dropped)
//   jetties       upper floors keep their jetty (overhang) when styled
//   dormers       roofs carry gabled dormers
//   gable         null | 'coped' (stone parapet gables with kneelers) | 'crow' (brick crow-stepped gables)
//   barge         null | 'carved' (wooden barge boards in the family wood)
//   thatchRidge   thatch roofs get a block-cut scalloped ridge
//   balconies     wooden balconies along the upper floor of timber houses, townhouses and manors
//   doorPots      potted plants either side of a styled house door
//   flowerRoll    a window row that asks for flower boxes keeps them on a coin flip (variant bit 26)
//   chapelSpire   false: the chapel gets a bell gable instead of a spire
//   house(st, look, it, K)   per-family tweaks to a styled HOUSE after the common recolour. Sets st.wood,
//                 st.paint, st.shutters, st.flowers, st.lower (farmhouse ground floor texture) and
//                 st.front (timber/townhouse: gable to the street); runs after st.shutter / st.doorC / st.roof are picked,
//                 so it may vary them too. Also runs for the palace (look 'palace'), as does chimney().
//                 K = { rgb, hx, P (pool style or null),
//                 walls (pool wall ramp or null), h (the style hash) }
//   townPitch     optional: a front-gabled townhouse's roof rise as a fraction of its width (default 0.9)
//   wallTex(t0, o, st, K) -> { tex, paint, corner?, quoinC? }   re-material a kit wall (optionally its corner
//                 treatment: corner 'quoin' | 'post' | null with quoinC rgb): t0 is the look's own texture, o the
//                 wall options ({ zb, paint, ... }), K = { house, up (an upper floor), paint, LIME }
//   chimney(c, st, K)        mutate c = { B0 (rgb colour), tall, rad } for a styled house chimney (K = { rgb, dk, h })
//   cottage       { hip, front, quoin: null | 'dress' | '#hex' }  the styled village cottage
//   palace        { hip (hipped main roof), balcony: 'iron' | 'stone' | 'run' (one long wooden balcony),
//                   wood (wooden portico posts), towerPaint: 'dress' | 'wall',
//                   tower(K) -> apex z }  draws the palace's corner tower; K = { st, tx, ty, tr, tz, TP,
//                   RB, prism, wm, cyl, ball, fit(...fittings), stoneM, coneMat, roundTower(tex, paint),
//                   sqTower(tex, paint, { quoin, arch, bell, brick }), shOf, shade, byLight, ramp, rgb, lt,
//                   dk, SAND, SHADE, DARKWOOD, LEAD }
//   v5            city v5 storybook knobs read by whimsy() in iso.js (not wired into drawing yet):
//                 { steep (roof pitch push), ivy (chance in 10 of a climber), climber: null | 'rose' |
//                   'bougainvillea' | 'yellow?' (yellow on a coin flip), lead (leaded panes), cross
//                   (cross windows), crown: null | 'stone' | 'paint' | 'brick' (window heads), heavy:
//                   'wood' | 'stone' (door frame), halfHip, gables: null | [canal gable types], cypress,
//                   pergola, loggia (oriels become loggias), ridgeTurret (turrets become ridge turrets),
//                   turret: 'octagon' | 'campanile' | 'round' (corner turret shape), turretTex: wall texture
//                   ('plaster' | 'white' | 'stone' | 'brickP'), turretRoof: null (the house's roof) | 'slate' | 'tile' |
//                   'lead' | 'thatch', crookedChimney (a leaning/kinked tall chimney), eyebrowDormer (a dormer rolled
//                   into the thatch), roundDoor (round-topped heavy door), moss (0..1 roof moss/lichen on slate and
//                   tile), lean (0..2: px of per-house lean, hash-driven), hoist (hoist beam and hook under street
//                   gable apexes), winJitter (house-front windows shift a px and a slot may be skipped, by hash) }
// ======================================================================================================
export default {
  id: 0, name: 'timber',
  sys: null,
  window: '',
  halfTimber: true, jetties: true, dormers: true, gable: null, barge: 'carved', thatchRidge: false,
  balconies: true, doorPots: false, flowerRoll: true, chapelSpire: true,
  house() {},
  wallTex: (t0, o, st, K) => ({ tex: t0, paint: K.paint }),
  chimney() {},
  cottage: { hip: false, front: false, quoin: null },
  palace: {
    hip: false, balcony: 'stone', wood: false, towerPaint: 'dress',
    tower(K) { // an eight-sided stone stair tower with a tall slate spire
      const { tx, ty, tr, tz, SAND } = K;
      K.prism('TW', tx, ty, tr, tr, 0, tz, 8, (nm, N, cols) => K.wm(nm, { tex: 'ashlar', paint: SAND, cols, shade: K.shOf(N), keep: true }));
      K.fit({ face: 'TW2', kind: 'lancet', c0: 2, c1: 5, z0: 28, z1: 38 }, { face: 'TW1', kind: 'lancet', c0: 2, c1: 5, z0: 44, z1: 54 });
      K.prism('TK', tx, ty, tr + 1.2, tr + 1.2, tz - 3, tz, 8, (nm, N) => K.stoneM(K.lt(SAND, 0.1), K.shOf(N)));
      K.prism('TR', tx, ty, tr + 2.5, 0, tz, tz + 34, 8, K.coneMat(K.RB, 'slate', tz));
      return tz + 34;
    },
  },
  v5: { steep: 1.22, ivy: 7, climber: 'rose', lead: true, cross: false, crown: 'paint', heavy: 'wood', halfHip: true, gables: null, cypress: false, pergola: false, loggia: false, ridgeTurret: false, turret: 'octagon', turretTex: 'plaster', turretRoof: null, crookedChimney: true, eyebrowDormer: false, roundDoor: false, moss: 1, lean: 1, hoist: false, winJitter: true },
};
